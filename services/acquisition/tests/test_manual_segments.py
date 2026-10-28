"""Manual segment lifecycle with in-memory SDK/motors only, never field devices."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from blade_acquisition.continuous_session import ContinuousCaptureSession
from blade_acquisition.receiver import PolytecReceiver, ReceiverConfig
from blade_acquisition.service import Settings, StartRequest, create_app
from blade_acquisition.storage import RecordingWriter, recording_summary
from blade_acquisition.turntable import PointCycleConfig, TurntableRequest, joint_snapshots
from test_automatic_stations import automatic_config, PassReceiver
from test_continuous_cycle import CycleSdk, full_pass
from test_dual_axis_integration import BufferedMotor
from test_service import START, TOKEN, POINT_REFERENCE
from laser_fixture import FakeLaserPanel


def segmented_config(count=1, start=0, step=90, **overrides):
    config = automatic_config(azimuths=tuple(index * step for index in range(round(360 / step))),
                              routeOrder='configured', rssiExitSpread=4, collectionId='f' * 32)
    ring = config['points']
    config.update(executionMode='manual_segments', segmentStations=copy.deepcopy(ring),
                  segmentStepDeg=step, totalStationCount=len(ring),
                  points=[copy.deepcopy(ring[(start + i) % len(ring)]) for i in range(count)],
                  nextWaitPoint=copy.deepcopy(ring[(start + count) % len(ring)]), cycles=1)
    return {**config, **overrides}


class ManualSegmentConfigTests(unittest.TestCase):
    def test_automatic_waiting_move_defaults_to_legacy_behavior_and_requires_boolean(self):
        self.assertTrue(PointCycleConfig(**segmented_config()).segmentedAutoMove)
        self.assertFalse(PointCycleConfig(**segmented_config(segmentedAutoMove=False)).segmentedAutoMove)
        for invalid in (0, 1, 'false', 'true', None):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                PointCycleConfig(**segmented_config(segmentedAutoMove=invalid))

    def test_two_points_require_90_degrees_but_single_point_keeps_all_intervals(self):
        for step in (180, 120, 60, 45, 30, 22.5):
            with self.subTest(step=step):
                with self.assertRaisesRegex(ValueError, "两点采集的圆周移动间隔固定为90"):
                    PointCycleConfig(**segmented_config(2, step=step))
                single = PointCycleConfig(**segmented_config(1, step=step))
                self.assertEqual(single.segmentStepDeg, step)
                self.assertEqual(len(single.points), 1)
        self.assertEqual(len(PointCycleConfig(**segmented_config(2)).points), 2)

    def test_segment_shape_and_full_ring_are_strict_before_hardware(self):
        valid = segmented_config(2, 3)
        value = PointCycleConfig(**valid)
        self.assertEqual([p.azimuthDeg for p in value.points], [270, 0])
        self.assertEqual(value.nextWaitPoint.azimuthDeg, 90)
        variations = [dict(points=valid['segmentStations'][:3]), dict(cycles=2),
            dict(totalStationCount=3), dict(segmentStepDeg=60), dict(segmentStepDeg=True),
            dict(nextWaitPoint=None), dict(segmentStations=None), dict(returnToOrigin=valid['points'][0]),
            dict(motionLaserPolicy='off_during_motion'), dict(nextWaitPoint=valid['points'][0]),
            dict(points=[valid['segmentStations'][0], valid['segmentStations'][2]]),
            dict(segmentStations=[valid['segmentStations'][0]] * 4),
            dict(segmentStations=[*valid['segmentStations'][:3], {**valid['segmentStations'][3], 'port':'COM8'}]),
            dict(nextWaitPoint={**valid['nextWaitPoint'], 'axis1AngleDeg': 8})]
        for override in variations:
            with self.subTest(override=override), self.assertRaises(ValueError):
                PointCycleConfig(**{**valid, **override})
        with self.assertRaises(ValueError):
            PointCycleConfig(**{**valid, 'executionMode':'continuous'})

    def test_direct_recall_rejects_upload_or_nonrecall(self):
        recall = dict(action='recall', port='COM6', recordedPort='COM6',
                      referenceSignature=POINT_REFERENCE['referenceSignature'],
                      axis1AngleDeg=0, axis2AngleDeg=0, directPositionOnly=True)
        self.assertTrue(TurntableRequest(**recall).directPositionOnly)
        for override in (dict(action='probe'), dict(preloadPoints=[(0,0)]), dict(directPositionOnly=1)):
            with self.subTest(override=override), self.assertRaises(ValueError):
                TurntableRequest(**{**recall, **override})


class ManualSegmentLifecycleTests(unittest.TestCase):
    def run_segment(self, filename, *, count=1, start=0, fail_wait=False, repeat=False, no_pass=False,
                    cancel=False, stop_failure=False, disk_failure=False, auto_move=None, hold_start=False, initial_offset=0):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        sdk = CycleSdk()
        stop_failure_armed = False
        if stop_failure:
            real_stop = sdk.PolyStopDataAcquisition
            sdk.PolyStopDataAcquisition = lambda *args: 5 if stop_failure_armed else real_stop(*args)
        receiver = PolytecReceiver(ReceiverConfig(START['deviceIp'], START['hostIp'], filename,
                                                  read_batch=50, timeout_ms=100))
        receiver.validate = lambda: None
        receiver._load_api = lambda: sdk
        receiver.supports_continuous_session = True
        motor = BufferedMotor()
        motor.drive_internal_position = True
        motor.point_position_protocol = '0x19'
        # A reused adapter must never accidentally dispatch a previous bank.
        motor._blade_preloaded_route = {'stale':True}
        first = segmented_config(count, start)['points'][0]
        motor.angles.update({1:first['axis1AngleDeg'] + initial_offset, 2:first['axis2AngleDeg']})
        controller = create_app(Settings(TOKEN, 8765, root), lambda _:receiver,
                                lambda *a, **k: motor).state.controller
        self.assertEqual(controller.status()['pointCycleExecutionModes'], ['continuous', 'manual_segments'])
        self.addCleanup(lambda: (controller.stop_event.set(),
                                controller.thread.join(5) if controller.thread else None))
        moves, gate_counts, sessions = [], [], []
        real_gate = ContinuousCaptureSession.gate
        def gate(session, callback, sample_index):
            nonlocal stop_failure_armed
            result = real_gate(session, callback, sample_index)
            gate_counts.append(sample_index)
            stop_failure_armed = True
            sdk.feed([260]*200 if no_pass or cancel else full_pass())
            if cancel:
                controller.stop_event.set()
            return result
        def move(device, **kwargs):
            self.assertIsNone(getattr(device, '_blade_preloaded_route', None))
            self.assertIsNone(kwargs.get('point_index'))
            current = controller.status()['pointCycle']
            waiting = current.get('movingToWaitPoint', False)
            moves.append({'targets':kwargs['targets'], 'daqActive':sdk.active, 'waiting':waiting})
            if waiting:
                self.assertFalse(sdk.active, 'next segment positioning started before real StopDAQ')
                self.assertIsNone(controller.continuous_capture)
                self.assertIsNone(controller.rssi_handoff)
                self.assertIsNone(controller.capture_thread)
                self.assertEqual(controller.laser_observation['state'], 'on')
                if fail_wait:
                    raise RuntimeError('fixture waiting-point move failed')
            else:
                self.assertTrue(sdk.active, 'the two stations within one segment keep their continuous DAQ')
                self.assertFalse(controller.continuous_capture.gate_is_open)
            kwargs['observe']({'phase':'command_sending', 'axis':1})
            device.angles.update(dict(zip((1,2),kwargs['targets'])))
            snapshots = joint_snapshots(device)
            kwargs['on_stopped'](snapshots)
            return {'feedback':snapshots[0], 'stopConfirmed':True, 'state':'complete',
                    'mode':'drive_internal', 'motionCommanded':True}
        real_finish = RecordingWriter.finish
        def finish(writer, error):
            if disk_failure and writer.manifest.get('kind') == 'continuous_raw_session':
                raise OSError('fixture raw archive fsync failed')
            return real_finish(writer, error)
        with patch.object(ContinuousCaptureSession, 'gate', gate), \
             patch('blade_acquisition.service.DevicePanel', FakeLaserPanel), \
             patch.object(RecordingWriter, 'finish', finish), \
             patch.object(controller, '_prepare_preloaded_points') as preload, \
             patch('blade_acquisition.drive_position.execute_drive_position', side_effect=move):
            for index in range(2 if repeat else 1):
                # The second manual start begins at the waiting pose reached by
                # the first segment. No duplicate positioning command is allowed.
                sdk.submitted = 0
                config = segmented_config(count, (start + count*index) % 4)
                if auto_move is not None:
                    config['segmentedAutoMove'] = auto_move
                config['startAtCurrentPose'] = hold_start
                controller.start(StartRequest(**START, confirmMotion=True, pointCycle=config))
                controller.thread.join(5)
                self.assertFalse(controller.thread.is_alive(), controller.status())
                sessions.append(controller.status()['pointCycle']['sessionId'])
                if fail_wait or no_pass or cancel or stop_failure or disk_failure or initial_offset:
                    break
                self.assertEqual(controller.status()['pointCycle']['state'], 'complete', controller.status())
            preload.assert_not_called()
        records = [json.loads(p.read_text()) for p in (root/'recordings').glob('*/manifest.json')]
        return controller, sdk, motor, records, moves, gate_counts, sessions

    def test_single_and_two_point_segments_on_mac_and_windows_stop_then_wait(self):
        for filename in ('fixture.dylib', 'fixture.dll'):
            for count in (1,2):
                with self.subTest(filename=filename, count=count):
                    controller,sdk,motor,records,moves,gates,_ = self.run_segment(filename, count=count)
                    pc = controller.status()['pointCycle']
                    self.assertEqual(pc['completedRecords'], count)
                    self.assertEqual(len(gates), count, 'waiting point never opens a detector')
                    self.assertEqual(len(moves), count, 'already at first point must not move again')
                    self.assertEqual([m['daqActive'] for m in moves], [True]*(count-1)+[False])
                    self.assertEqual(pc['waitingPoint']['azimuthDeg'], count*90)
                    self.assertEqual(len(pc['plannedStations']), 4)
                    self.assertEqual(pc['totalRecords'], count)
                    self.assertEqual(sdk.events.count('start'), 1)
                    self.assertGreaterEqual(sdk.events.count('stop'), 1)
                    self.assertNotIn('start', motor.calls, 'no buffered trajectory start')
                    for record in records:
                        meta = record['pointCycle']
                        self.assertEqual(record['status'],'complete')
                        self.assertEqual(meta['completion'],'confirmed_pass')
                        self.assertEqual(meta['stationCount'],4)
                        self.assertEqual(meta['coverageKind'],'manual_segment_passes')
                        self.assertEqual(len(meta['plannedStations']),4)
                        summary = recording_summary(record)['pointCycle']
                        for key in ('executionMode','segmentStepDeg','totalStationCount','segmentStationIds','nextWaitPoint'):
                            self.assertEqual(summary[key],meta[key])
                    phases = [event['phase'] for event in pc['processEvents']]
                    self.assertLess(phases.index('segment_daq_stopped'), phases.index('moving_next_segment'))
                    self.assertFalse(sdk.active)
                    self.assertEqual(controller.laser_observation['state'],'on')

    def test_repeated_manual_starts_wrap_circle_without_duplicate_move_or_duplicate_record(self):
        controller,sdk,_,records,moves,gates,sessions = self.run_segment('fixture.dll', count=2, start=2, repeat=True)
        self.assertEqual(len(set(sessions)),2)
        self.assertEqual(len(records),4)
        self.assertEqual(sorted(r['pointCycle']['stationIndex'] for r in records),[1,2,3,4])
        self.assertEqual(len(moves),4)
        self.assertEqual(len(gates),4)
        self.assertEqual(controller.status()['pointCycle']['waitingPoint']['azimuthDeg'],180)
        self.assertEqual(sdk.events.count('start'),2)

    def test_disabling_auto_move_keeps_next_cursor_without_motion_or_false_arrival(self):
        for filename in ('fixture.dylib', 'fixture.dll'):
            for count in (1, 2):
                with self.subTest(filename=filename, count=count):
                    controller,sdk,motor,records,moves,gates,_ = self.run_segment(filename, count=count, auto_move=False)
                    pc = controller.status()['pointCycle']
                    self.assertEqual(pc['state'], 'complete')
                    self.assertFalse(pc['segmentedAutoMove'])
                    self.assertIsNone(pc['waitingPoint'], 'a planned next angle is not hardware arrival evidence')
                    self.assertFalse(pc['movingToWaitPoint'])
                    self.assertEqual(pc['nextWaitPoint']['azimuthDeg'], count * 90)
                    self.assertEqual(len(moves), count - 1, 'only the two-point segment interior moves automatically')
                    self.assertTrue(all(move['daqActive'] and not move['waiting'] for move in moves))
                    last = segmented_config(count)['points'][-1]
                    self.assertEqual(motor.angles, {1: last['axis1AngleDeg'], 2: last['axis2AngleDeg']})
                    self.assertEqual(len(gates), count)
                    self.assertFalse(sdk.active)
                    self.assertEqual(controller.laser_observation['state'], 'on')
                    phases = [event['phase'] for event in pc['processEvents']]
                    self.assertIn('waiting_manual_position', phases)
                    self.assertNotIn('moving_next_segment', phases)
                    for record in records:
                        self.assertEqual(record['status'], 'complete')
                        self.assertFalse(record['pointCycle']['segmentedAutoMove'])
                        self.assertFalse(recording_summary(record)['pointCycle']['segmentedAutoMove'])

    def test_explicitly_positioned_segment_starts_without_replaying_first_move(self):
        for filename in ('fixture.dylib', 'fixture.dll'):
            for count in (1, 2):
                with self.subTest(filename=filename, count=count):
                    controller,sdk,_,records,moves,gates,_ = self.run_segment(filename, count=count, auto_move=False, hold_start=True)
                    self.assertEqual(controller.status()['pointCycle']['state'], 'complete')
                    self.assertEqual(len(moves), count - 1)
                    self.assertEqual(len(gates), count)
                    self.assertEqual(len(records), count)
                    self.assertFalse(sdk.active)

    def test_position_changed_after_preposition_is_rejected_without_a_corrective_move(self):
        for filename in ('fixture.dylib', 'fixture.dll'):
            with self.subTest(filename=filename):
                controller,_,_,records,moves,gates,_ = self.run_segment(filename, auto_move=False, hold_start=True, initial_offset=2)
                pc = controller.status()['pointCycle']
                self.assertEqual(pc['state'], 'error')
                self.assertIn('移动到预设位置', pc['error'])
                self.assertEqual(moves, [])
                self.assertEqual(gates, [])
                self.assertEqual(records, [])

    def test_waiting_move_failure_preserves_captured_record_and_never_reports_ready(self):
        controller,_,_,records,moves,gates,_ = self.run_segment('fixture.dylib', fail_wait=True)
        pc = controller.status()['pointCycle']
        self.assertEqual(pc['state'],'error')
        self.assertIsNone(pc['waitingPoint'])
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]['status'],'complete')
        self.assertEqual(len(moves),1)
        self.assertEqual(len(gates),1)

    def test_no_blade_or_cancel_does_not_advance_to_waiting_point(self):
        for change, expected in ((dict(no_pass=True),'error'), (dict(cancel=True),'cancelled')):
            with self.subTest(change=change):
                controller,_,_,_,moves,gates,_ = self.run_segment('fixture.dylib', **change)
                pc = controller.status()['pointCycle']
                self.assertEqual(pc['state'],expected)
                self.assertIsNone(pc['waitingPoint'])
                self.assertEqual(moves,[])
                self.assertEqual(len(gates),1)

    def test_failed_daq_stop_or_disk_flush_never_moves_to_waiting_point(self):
        for change in (dict(stop_failure=True), dict(disk_failure=True)):
            with self.subTest(change=change):
                controller,_,_,_,moves,gates,_ = self.run_segment('fixture.dll', **change)
                pc = controller.status()['pointCycle']
                self.assertEqual(pc['state'],'error')
                self.assertIsNone(pc['waitingPoint'])
                self.assertEqual(moves,[])
                self.assertEqual(len(gates),1)

    def test_direct_recall_never_inherits_an_indexed_bank_or_starts_daq(self):
        with tempfile.TemporaryDirectory() as folder:
            motor = BufferedMotor()
            motor.drive_internal_position = True
            motor._blade_preloaded_route = {'stale':True}
            receiver_factory = Mock(side_effect=AssertionError('preposition must not start DAQ'))
            controller = create_app(Settings(TOKEN,8765,Path(folder)),receiver_factory,
                                    lambda *a,**k:motor).state.controller
            def move(device, **kwargs):
                self.assertIsNone(device._blade_preloaded_route)
                device.angles.update(dict(zip((1,2),kwargs['targets'])))
                snapshots = joint_snapshots(device)
                return {'feedback':snapshots[0],'stopConfirmed':True,'state':'complete','mode':'drive_internal'}
            with patch.object(controller,'_prepare_preloaded_points') as preload, \
                 patch('blade_acquisition.drive_position.execute_drive_position',side_effect=move) as direct:
                controller.turntable_operation(TurntableRequest(action='recall',port='COM6',recordedPort='COM6',
                    referenceSignature=POINT_REFERENCE['referenceSignature'], axis1AngleDeg=2,axis2AngleDeg=-3,
                    confirmMotion=True,directPositionOnly=True))
                controller.test_thread.join(3)
            self.assertFalse(controller.test_thread.is_alive())
            self.assertEqual(controller.status()['turntable']['recall']['state'],'complete')
            direct.assert_called_once()
            preload.assert_not_called()
            receiver_factory.assert_not_called()
            self.assertEqual(controller.store.list(),[])

    def test_no_direct_controller_capability_never_uploads_or_moves(self):
        with tempfile.TemporaryDirectory() as folder:
            motor = BufferedMotor()
            controller = create_app(Settings(TOKEN,8765,Path(folder)),PassReceiver,
                                    lambda *a,**k:motor).state.controller
            with patch('blade_acquisition.service.DevicePanel',FakeLaserPanel), \
                 patch.object(controller,'_prepare_preloaded_points') as preload:
                controller.start(StartRequest(**START,confirmMotion=True,pointCycle=segmented_config()))
                controller.thread.join(3)
            self.assertFalse(controller.thread.is_alive())
            self.assertEqual(controller.status()['pointCycle']['state'],'error')
            self.assertIn('直接双轴',controller.status()['error'])
            preload.assert_not_called()
            self.assertNotIn('start',motor.calls)
            self.assertEqual(controller.store.list(),[])


if __name__ == '__main__':
    unittest.main()
