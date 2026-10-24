"""End-to-end service/SDK fixtures for continuous point cycles; never hardware."""
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from blade_acquisition.async_recording import AsyncRecordingWriter
from blade_acquisition.continuous_session import ContinuousCaptureSession
from blade_acquisition.receiver import PolytecReceiver, ReceiverConfig, VELOCITY
from blade_acquisition.service import Settings, StartRequest, create_app
from blade_acquisition.storage import HEADER, RECORD, RecordingWriter
from blade_acquisition.turntable import joint_snapshots
from test_automatic_stations import automatic_config, PassReceiver
from test_continuous_receiver import ContinuousSdk
from test_dual_axis_integration import BufferedMotor
from test_service import START, TOKEN
from laser_fixture import FakeLaserPanel


class CycleSdk(ContinuousSdk):
    """A single monotonically numbered stream with independently chosen RSSI."""
    def __init__(self):
        super().__init__()
        self.submitted = 0

    def feed(self, rssi):
        rows = [(self.submitted + i, value) for i, value in enumerate(rssi)]
        self.submitted += len(rows)
        self.add(rows)

    def PolyGetInt32Data(self, _, channel, __, values, count):
        for index in range(count):
            values[index] = self.incoming[index][0 if channel == VELOCITY else 1]
        return 0


def full_pass():
    # 100 ms background, a 60 ms blade, then 40 ms stable background.
    return [260] * 100 + [100, 420] * 30 + [260] * 40


def stored_rows(path):
    result = []
    for chunk in sorted(path.parent.glob('chunk-*.bin')):
        result.extend(RECORD.iter_unpack(chunk.read_bytes()[HEADER.size:]))
    return result


class ContinuousCycleTests(unittest.TestCase):
    def wait_for(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.002)
        self.fail('fixture condition did not complete before deadline')

    def run_cycle(self, filename, *, fail_move=False, fail_next_fence=False,
                  cancel_at_second=False, late_disk_error=False, dark_motion=False, early_detection=False,
                  live_fences=False, azimuths=(0, 90), early_pose_fault=False, cancel_early=False,
                  fail_early_copy=False):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        sdk = CycleSdk()
        receiver = PolytecReceiver(ReceiverConfig(START['deviceIp'], START['hostIp'], filename,
                                                   read_batch=50, timeout_ms=100))
        receiver.validate = lambda: None
        receiver._load_api = lambda: sdk
        receiver.supports_continuous_session = True
        motor = BufferedMotor()
        motor.drive_internal_position = True
        controller = create_app(Settings(TOKEN, 8765, root), lambda _: receiver,
                                lambda *args, **kwargs: motor).state.controller
        self.addCleanup(lambda: (controller.stop_event.set(), sdk.release_normal_read.set(),
                                controller.thread.join(5) if controller.thread else None))
        gates, moves, feeder_errors, movement_ranges = [], [], [], []
        condition = threading.Condition()
        disk_release = threading.Event()
        disk_failed = threading.Event()
        self.addCleanup(disk_release.set)
        actual_gate = ContinuousCaptureSession.gate

        actual_fence = receiver.fence_active_samples
        fence_checks = []
        def live_fence():
            # Emulate a receiver already handling a live batch. It needs the
            # same lock as ContinuousCaptureSession._receive before it can
            # acknowledge any queued fence request.
            acquired = threading.Event()
            def receiver_lock_probe():
                with controller.lock:
                    acquired.set()
            worker = threading.Thread(target=receiver_lock_probe, daemon=True)
            worker.start()
            available = acquired.wait(.5)
            self.assertTrue(available, 'fence caller holds the receiver/controller lock')
            worker.join(1)
            sdk.feed([260] * 50)
            boundary = actual_fence()
            self.assertGreaterEqual(controller.continuous_capture.global_samples, sdk.submitted)
            fence_checks.append(boundary['sampleIndex'])
            return boundary
        if live_fences:
            receiver.fence_active_samples = live_fence

        def gate(session, callback, sample_index):
            # Synchronize the test producer after the real admission operation;
            # this changes neither the gate nor detector behavior.
            result = actual_gate(session, callback, sample_index)
            if dark_motion:
                self.assertEqual(controller.laser_observation['state'], 'on')
            with condition:
                gates.append(sample_index)
                condition.notify_all()
            return result

        def wait_gate(number):
            with condition:
                if not condition.wait_for(lambda: len(gates) >= number or controller.stop_event.is_set(), 4):
                    raise AssertionError(f'point {number} was never admitted')
            return len(gates) >= number

        def feed():
            try:
                if not wait_gate(1):
                    return
                sdk.feed(full_pass())
                if fail_move or fail_next_fence or early_detection:
                    # An early pass is supplied only DURING movement below.
                    # No new gate/quiet packet is provided to unblock recording.
                    return
                if not wait_gate(2):
                    return
                # A transit pass and already queued data must not complete P2.
                time.sleep(.03)
                self.assertTrue(controller.thread.is_alive())
                # Saving is asynchronous: entry into point 2 must not wait for
                # point 1's fsync, nor claim pending files already completed.
                self.assertLessEqual(controller.point_cycle['completedRecords'], 1)
                self.assertEqual(controller.cycle_writers[0].manifest['pointCycle']['completion'], 'confirmed_pass')
                self.assertNotEqual(controller.writer.manifest['pointCycle'].get('completion'), 'confirmed_pass')
                self.assertEqual(len(moves), 1)
                if cancel_at_second:
                    sdk.feed([260] * 100)
                    session = controller.continuous_capture
                    self.wait_for(lambda: session.global_samples >= sdk.submitted)
                    controller.stop()
                elif late_disk_error:
                    disk_release.set()
                    self.assertTrue(disk_failed.wait(3))
                else:
                    sdk.feed(full_pass())
            except Exception as exc:
                feeder_errors.append(exc)
                controller.stop_event.set()

        def move(device, **kwargs):
            self.assertTrue(sdk.active, 'point handoff must not stop DAQ')
            if early_detection and moves:
                self.assertFalse(controller.writer.directory.exists(),
                                 'deferred station creation must not block the next command')
                self.assertEqual(len(list((root/'recordings').glob('*/manifest.json'))), 1)
            if dark_motion:
                self.assertEqual(controller.laser_observation['state'], 'off')
                self.assertFalse(controller.continuous_capture.gate_is_open)
            self.assertEqual(sdk.events.count('start'), 1)
            moves.append(kwargs['targets'])
            kwargs['observe']({'phase': 'command_sending', 'axis': 1})
            if early_detection:
                # Both axes far from their targets: the diagnostic mode must
                # now admit a transit pass, but never overlap motor commands.
                kwargs['observe']({'phase': 'position_sample', 'feedbackReadings': [
                    {'output_angle_deg': angle - 10, 'motor_rpm': 30, 'fault': 0}
                    for angle in kwargs['targets']]})
            start = sdk.submitted
            sdk.feed(full_pass())  # An entire distracting blade during motion.
            movement_ranges.append((start, sdk.submitted))
            session = controller.continuous_capture
            self.wait_for(lambda: session.global_samples >= sdk.submitted)
            self.assertEqual(len(gates), 1, 'movement data unexpectedly opened another point')
            if early_detection:
                probe = controller.early_detection
                kwargs['observe']({'phase': 'position_sample', 'feedbackReadings': [
                    {'output_angle_deg': angle, 'motor_rpm': 30, 'fault': 0}
                    for angle in kwargs['targets']]})
                self.assertTrue(probe.active)
                self.assertIsNotNone(probe.detector.trigger, 'diagnostic mode must admit the far transit pass')
                self.assertTrue(probe.detector.trigger['detectedBeforeStoppedArrival'])
                self.assertEqual(controller.point_cycle['currentPoint'],
                                 controller.early_detection.point.name)
                self.assertEqual(len(gates), 1)
            if fail_move:
                raise RuntimeError('fixture native movement rejected')
            if fail_next_fence:
                sdk.PolyAvailableSamples = None
            device.angles.update(dict(zip((1, 2), kwargs['targets'])))
            pair = joint_snapshots(device)
            if kwargs.get('on_stopped'):
                kwargs['on_stopped'](pair)
            return {'feedback': pair[0], 'stopConfirmed': True, 'state': 'complete',
                    'mode': 'drive_internal', 'motionCommanded': True}

        original_finish = RecordingWriter.finish
        def finish(writer, error):
            if (late_disk_error and writer.manifest.get('pointCycle', {}).get('pointIndex') == 1
                    and error is None and not disk_failed.is_set()):
                if not disk_release.wait(3):
                    raise AssertionError('next point was blocked on previous point disk flush')
                disk_failed.set()
                raise OSError('fixture late station fsync failure')
            return original_finish(writer, error)

        original_pose = controller._cycle_capture_pose
        def capture_pose(device, cycle, point, **kwargs):
            if moves and early_detection:
                self.assertIsNotNone(controller.early_detection.detector.trigger)
                if early_pose_fault:
                    raise RuntimeError('fixture stopped reference changed')
                if cancel_early:
                    controller.stop_event.set()
            return original_pose(device, cycle, point, **kwargs)

        from blade_acquisition.deferred_diagnostic import copy_raw_window
        def copy_window(*args):
            if fail_early_copy:
                raise OSError('fixture deferred copy disk failure')
            return copy_raw_window(*args)

        feeder = threading.Thread(target=feed)
        with patch.object(ContinuousCaptureSession, 'gate', gate), \
             patch('blade_acquisition.service.DevicePanel', FakeLaserPanel), \
             patch.object(controller, '_cycle_capture_pose', side_effect=capture_pose), \
             patch('blade_acquisition.deferred_diagnostic.copy_raw_window', side_effect=copy_window), \
             patch.object(RecordingWriter, 'finish', finish), \
             patch('blade_acquisition.drive_position.execute_drive_position', side_effect=move):
            feeder.start()
            controller.start(StartRequest(**START, confirmMotion=True, pointCycle=automatic_config(
                azimuths=azimuths, routeOrder='configured', dwellSeconds=2, rssiExitSpread=4,
                motionLaserPolicy='off_during_motion' if dark_motion else 'continuous',
                diagnosticDetectBeforeSettled=early_detection)))
            controller.thread.join(8)
            self.assertFalse(controller.thread.is_alive(), controller.status())
            feeder.join(5)
            self.assertFalse(feeder.is_alive())
        self.assertEqual(feeder_errors, [])
        if live_fences:
            self.assertGreaterEqual(len(fence_checks), 3, 'must exercise startup and moving-point fences')
        records = sorted((root / 'recordings').glob('*/manifest.json'),
                         key=lambda p: json.loads(p.read_text())['pointCycle']['pointIndex'])
        raw = list((root / 'continuous-sessions').glob('*/manifest.json'))
        return controller, sdk, records, raw, gates, moves, movement_ranges

    def test_early_detection_remembers_unsettled_pass_on_mac_and_windows(self):
        for filename in ('fixture.dll', 'fixture.dylib'):
            with self.subTest(filename=filename):
                controller, sdk, paths, raw, gates, moves, transit = self.run_cycle(filename, early_detection=True)
                self.assertEqual(controller.status()['pointCycle']['state'], 'complete')
                self.assertEqual(len(moves), 1)
                self.assertEqual(sdk.events.count('start'), 1)
                self.assertEqual(len(paths), 2)
                second = json.loads(paths[1].read_text())
                self.assertEqual(second['name'], START['name'])
                self.assertEqual(second['originalTaskName'], START['name'])
                self.assertTrue(second['diagnosticOnly'])
                self.assertFalse(second['validMeasurement'])
                pc = second['pointCycle']
                self.assertEqual(pc['completion'], 'diagnostic_pass')
                self.assertNotIn('entrySampleIndex', pc)
                self.assertTrue(pc['diagnosticDetection']['trigger']['detectedBeforeStoppedArrival'])
                self.assertLess(pc['handoff']['detectedAt'], pc['diagnosticDetection']['stopConfirmedAt'])
                self.assertEqual(pc['handoff']['sampleClock'], 'continuous_session_raw')
                self.assertTrue(pc['handoff']['recordPreparationDeferred'])
                self.assertEqual(len(gates), 1, 'no new stationary gate for a remembered early pass')
                self.assertEqual(second['samples'], pc['continuousSession']['sampleEndExclusive'] -
                                 pc['continuousSession']['sampleStart'])
                self.assertGreater(second['samples'], 20)

    def test_three_early_stations_handoff_without_new_packet_or_record_setup_on_both_platforms(self):
        for filename in ('fixture.dll', 'fixture.dylib'):
            with self.subTest(filename=filename):
                controller, sdk, paths, raw, gates, moves, _ = self.run_cycle(
                    filename, early_detection=True, live_fences=True, azimuths=(0, 120, 240))
                self.assertEqual(controller.status()['pointCycle']['state'], 'complete')
                self.assertEqual(len(moves), 2)
                self.assertEqual(len(gates), 1)
                raw_manifest = json.loads(raw[0].read_text())
                self.assertEqual(raw_manifest['samples'], sdk.submitted)
                self.assertEqual(len(raw_manifest['diagnosticBookmarks']), 2)
                raw_rows = stored_rows(raw[0])
                records = [json.loads(p.read_text()) for p in paths]
                third_command = records[1]['pointCycle']['handoff']['motionCommandAt']
                for manifest, path in zip(records[1:], paths[1:]):
                    pc = manifest['pointCycle']
                    self.assertGreater(pc['recordMaterializedAt'], third_command)
                    self.assertFalse(manifest['validMeasurement'])
                    self.assertEqual(manifest['status'], 'complete')
                    link = pc['continuousSession']
                    actual = stored_rows(path)
                    expected = raw_rows[link['sampleStart']:link['sampleEndExclusive']]
                    self.assertEqual([r[1:] for r in actual], [r[1:] for r in expected])
                    self.assertEqual([r[0] for r in actual], list(range(len(actual))))
                first_early = records[1]['pointCycle']
                self.assertLess(first_early['handoff']['detectedAt'],
                                first_early['diagnosticDetection']['stopConfirmedAt'])
                self.assertGreaterEqual(third_command, first_early['diagnosticDetection']['stopConfirmedAt'])

    def test_early_pass_never_bypasses_fault_or_cancellation(self):
        for filename in ('fixture.dll', 'fixture.dylib'):
            for failure in ('early_pose_fault', 'cancel_early'):
                with self.subTest(filename=filename, failure=failure):
                    controller, sdk, paths, raw, gates, moves, _ = self.run_cycle(
                        filename, early_detection=True, azimuths=(0, 120, 240), **{failure: True})
                    self.assertIn(controller.status()['pointCycle']['state'], ('error', 'cancelled'))
                    self.assertEqual(len(moves), 1, 'must not command third point after fault/cancel')
                    self.assertEqual(len(gates), 1)
                    manifest = json.loads(raw[0].read_text())
                    self.assertEqual(manifest['samples'], sdk.submitted)
                    self.assertEqual(manifest['status'], 'error')

    def test_deferred_copy_error_is_reported_with_raw_and_bookmarks_retained(self):
        for filename in ('fixture.dll', 'fixture.dylib'):
            with self.subTest(filename=filename):
                controller, sdk, paths, raw, gates, moves, _ = self.run_cycle(
                    filename, early_detection=True, azimuths=(0, 120, 240), fail_early_copy=True)
                self.assertEqual(controller.status()['pointCycle']['state'], 'error')
                self.assertIn('deferred copy disk failure', controller.status()['error'])
                self.assertEqual(len(moves), 2)
                manifest = json.loads(raw[0].read_text())
                self.assertEqual(manifest['samples'], sdk.submitted)
                self.assertEqual(len(manifest['diagnosticBookmarks']), 2)
                self.assertEqual(controller.status()['pointCycle']['completedRecords'], 1)
                self.assertEqual([json.loads(p.read_text())['status'] for p in paths],
                                 ['complete', 'error', 'error'])

    def test_live_receiver_can_acknowledge_early_detection_fences_on_both_platforms(self):
        for filename in ('fixture.dll', 'fixture.dylib'):
            with self.subTest(filename=filename):
                controller, sdk, records, raw, _, moves, _ = self.run_cycle(
                    filename, early_detection=True, live_fences=True)
                self.assertEqual(controller.status()['pointCycle']['state'], 'complete')
                self.assertEqual(len(moves), 1)
                self.assertEqual(len(records), 2)
                manifest = json.loads(raw[0].read_text())
                self.assertEqual(manifest['status'], 'complete')
                self.assertEqual(manifest['samples'], sdk.submitted)

    def test_dark_motion_switches_only_outside_gate_without_daq_restart(self):
        for filename in ('fixture.dll', 'fixture.dylib'):
            with self.subTest(filename=filename):
                controller, sdk, paths, raw, gates, moves, transit = self.run_cycle(filename, dark_motion=True)
                self.assertEqual(controller.status()['pointCycle']['state'], 'complete')
                self.assertEqual(sdk.events.count('start'), 1)
                self.assertEqual(len(moves), 1)
                for path in paths:
                    pc = json.loads(path.read_text())['pointCycle']
                    self.assertEqual(pc['laserPolicy'], 'off_during_motion')
                    self.assertFalse(any(a <= row[1] < b for row in stored_rows(path) for a,b in transit))
                move = json.loads(paths[0].read_text())['pointCycle']['handoff']['completedMove']
                self.assertEqual(move['laserOffBeforeMotion']['state'], 'off')
                self.assertEqual(move['laserOnAfterArrival']['state'], 'on')
                self.assertGreaterEqual(move['laserOnAfterArrival']['confirmedAt'], move['motionArrivedAt'])

    def test_one_daq_across_two_points_preserves_transit_without_retrigger_on_mac_and_windows(self):
        for filename in ('libDeviceCommunication.dylib', 'DeviceCommunication.dll'):
            with self.subTest(filename=filename):
                controller, sdk, paths, raw, gates, moves, transit = self.run_cycle(filename)
                state = controller.status()
                self.assertEqual(state['pointCycle']['state'], 'complete', state.get('error'))
                self.assertEqual(sdk.events.count('start'), 1)
                self.assertEqual(sdk.events.count('stop'), 2)  # initial setup and final stop
                self.assertEqual(len(moves), 1)  # P1 already aimed; only P1->P2
                self.assertEqual(len(gates), 2)
                self.assertEqual(len(paths), 2)
                self.assertEqual(len(raw), 1)
                raw_manifest = json.loads(raw[0].read_text())
                self.assertEqual(raw_manifest['kind'], 'continuous_raw_session')
                self.assertEqual(raw_manifest['status'], 'complete')
                rows = stored_rows(raw[0])
                self.assertEqual([row[0] for row in rows], list(range(sdk.submitted)))
                self.assertEqual([row[1] for row in rows], list(range(sdk.submitted)))
                self.assertEqual(raw_manifest['samples'], sdk.submitted)
                for path in paths:
                    record = json.loads(path.read_text())
                    pc = record['pointCycle']
                    self.assertEqual(record['status'], 'complete')
                    self.assertEqual(pc['completion'], 'confirmed_pass')
                    self.assertEqual(pc['acquisitionSessionMode'], 'continuous_daq')
                    self.assertFalse(pc['rssiDetector']['requireBackground'])
                    self.assertTrue(pc['rssiDetector']['requireStableEntryMean'])
                    self.assertEqual(pc['rssiDetector']['entryEvidenceMode'], 'arrival_guard')
                    self.assertTrue(pc['rssiDetector']['entryEvidenceAffectsMotion'])
                    self.assertEqual(pc['handoff']['entryEvidenceMode'], 'arrival_guard')
                    self.assertIsNotNone(pc['handoff']['entryEvidence'])
                    self.assertEqual(pc['handoff']['detectorVersion'], 8)
                    span = pc['continuousSession']
                    self.assertEqual(span['id'], raw_manifest['id'])
                    self.assertEqual(span['sampleEndExclusive'] - span['sampleStart'], record['samples'])
                    self.assertGreaterEqual(span['sampleStart'], pc['bufferFence']['sampleIndex'])
                    point_rows = stored_rows(path)
                    self.assertEqual([row[1] for row in point_rows],
                                     list(range(span['sampleStart'], span['sampleEndExclusive'])))
                    self.assertFalse(any(a <= row[1] < b for row in point_rows for a, b in transit))
                self.assertFalse(sdk.active)
                self.assertIsNone(controller.continuous_capture)

    def test_failed_move_preserves_raw_and_cannot_admit_next_point(self):
        controller, sdk, paths, raw, gates, moves, _ = self.run_cycle('fixture.dylib', fail_move=True)
        self.assertEqual(controller.status()['pointCycle']['state'], 'error')
        self.assertIn('fixture native movement rejected', controller.status()['error'])
        self.assertEqual(len(moves), 1)
        self.assertEqual(len(gates), 1)
        self.assertEqual(sdk.events.count('start'), 1)
        self.assertFalse(sdk.active)
        self.assertEqual(len(raw), 1)
        self.assertNotEqual(json.loads(raw[0].read_text())['status'], 'complete')
        self.assertEqual(len(stored_rows(raw[0])), sdk.submitted)
        self.assertLessEqual(len(paths), 1)

    def test_failed_cache_fence_cannot_admit_next_point(self):
        controller, sdk, paths, raw, gates, moves, _ = self.run_cycle('fixture.dll', fail_next_fence=True)
        self.assertEqual(controller.status()['pointCycle']['state'], 'error')
        self.assertIn('缓存边界确认', controller.status()['error'])
        self.assertEqual(len(moves), 1)
        self.assertEqual(len(gates), 1)
        self.assertEqual(sdk.events.count('start'), 1)
        self.assertFalse(sdk.active)
        self.assertEqual(len(raw), 1)
        self.assertNotEqual(json.loads(raw[0].read_text())['status'], 'complete')
        self.assertTrue(all(json.loads(path.read_text())['pointCycle']['pointIndex'] == 1 or
                            json.loads(path.read_text())['status'] != 'complete' for path in paths))


    def test_user_stop_closes_one_daq_and_preserves_partial_station(self):
        controller, sdk, paths, raw, gates, moves, _ = self.run_cycle('fixture.dylib', cancel_at_second=True)
        self.assertEqual(controller.status()['pointCycle']['state'], 'cancelled')
        self.assertEqual(len(moves), 1)
        self.assertEqual(len(gates), 2)
        self.assertEqual(sdk.events.count('start'), 1)
        self.assertFalse(sdk.active)
        self.assertIsNone(controller.continuous_capture)
        self.assertEqual(len(raw), 1)
        self.assertNotEqual(json.loads(raw[0].read_text())['status'], 'complete')
        self.assertEqual([row[1] for row in stored_rows(raw[0])], list(range(sdk.submitted)))
        point_two = next(json.loads(path.read_text()) for path in paths
                         if json.loads(path.read_text())['pointCycle']['pointIndex'] == 2)
        self.assertNotEqual(point_two['status'], 'complete')
        self.assertNotEqual(point_two['pointCycle'].get('completion'), 'confirmed_pass')

    def test_late_station_disk_failure_aborts_active_next_point_without_false_completion(self):
        controller, sdk, paths, raw, gates, moves, _ = self.run_cycle('fixture.dll', late_disk_error=True)
        self.assertEqual(controller.status()['pointCycle']['state'], 'error')
        self.assertIn('fixture late station fsync failure', controller.status()['error'])
        self.assertEqual(len(moves), 1)
        self.assertEqual(len(gates), 2)
        self.assertEqual(sdk.events.count('start'), 1)
        self.assertFalse(sdk.active)
        self.assertEqual(controller.status()['pointCycle']['completedRecords'], 0)
        self.assertTrue(all(json.loads(path.read_text())['status'] != 'complete' for path in paths))
        self.assertNotEqual(json.loads(raw[0].read_text())['status'], 'complete')


    def test_pending_disk_owner_blocks_start_after_receiver_thread_exits(self):
        for owner in ('station', 'raw_session'):
            with self.subTest(owner=owner), tempfile.TemporaryDirectory() as folder:
                controller = create_app(Settings(TOKEN, 8765, Path(folder))).state.controller
                raw = controller.store.create({'name': 'pending flush', 'phases': []})
                writer = AsyncRecordingWriter(raw, publication_lock=controller.lock)
                entered, release = threading.Event(), threading.Event()
                original_finish = raw.finish
                def blocked_finish(error):
                    entered.set()
                    if not release.wait(3):
                        raise AssertionError('fixture finish was not released')
                    return original_finish(error)
                if owner == 'station':
                    controller.cycle_writers = [writer]
                else:
                    # A stopped receiver can still own an unfinished raw file.
                    # Do not start this session: this test has no SDK calls.
                    controller.continuous_capture = ContinuousCaptureSession(
                        None, writer, controller.lock, controller.stop_event, controller._cycle_io_failed)
                with patch.object(raw, 'finish', side_effect=blocked_finish):
                    try:
                        writer.ready(1000.0, 1700000000.0)
                        writer.finish(wait=False)
                        self.assertTrue(entered.wait(2))
                        self.assertIsNone(controller.capture_thread)
                        self.assertIsNone(controller.thread)
                        self.assertTrue(controller.status()['receiver']['running'])
                        with self.assertRaises(HTTPException) as raised:
                            controller.start(StartRequest(**START))
                        self.assertEqual(raised.exception.status_code, 409)
                        self.assertIn('正在收尾', raised.exception.detail)
                    finally:
                        release.set()
                        writer.wait(3)
                controller._finish_continuous_cycle()
                self.assertFalse(controller.status()['receiver']['running'])
                self.assertIsNone(controller.continuous_capture)

    def test_failed_finished_session_is_released_before_next_legacy_cycle(self):
        controller, _, _, _, _, _, _ = self.run_cycle('fixture.dylib', late_disk_error=True)
        self.assertEqual(controller.status()['pointCycle']['state'], 'error')
        self.assertIsNone(controller.continuous_capture)
        self.assertIsNone(controller.capture_thread)
        self.assertFalse(controller.status()['receiver']['running'])
        self.assertTrue(all(not writer.pending for writer in controller.cycle_writers))
        controller.receiver_factory = PassReceiver
        # Last successful move reached the second point before the disk error;
        # the next older-adapter task uses that same point, without any motion.
        with patch('blade_acquisition.service.DevicePanel', FakeLaserPanel), \
             patch.object(controller, '_execute_drive_position', side_effect=AssertionError('duplicate move')):
            controller.start(StartRequest(**START, confirmMotion=True, pointCycle=automatic_config(
                azimuths=(90,), routeOrder='configured', dwellSeconds=2, rssiExitSpread=4)))
            controller.thread.join(4)
        self.assertFalse(controller.thread.is_alive())
        self.assertEqual(controller.status()['pointCycle']['state'], 'complete', controller.status().get('error'))
        self.assertIsNone(controller.continuous_capture)
        self.assertEqual(controller.cycle_writers, [])
        self.assertEqual(controller.status()['recording']['pointCycle']['acquisitionSessionMode'], 'per_station')


if __name__ == '__main__':
    unittest.main()
