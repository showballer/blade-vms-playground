"""Offline native-SDK lifecycle fixtures. Never opens a socket, serial port or DLL."""
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from blade_acquisition.receiver import PolytecReceiver, ReceiverConfig, VELOCITY, RSSI, TIMEOUT
from blade_acquisition.service import Settings, StartRequest, create_app
from blade_acquisition.turntable import PointCycleConfig, snapshot
from test_automatic_stations import automatic_config
from test_dual_axis_integration import BufferedMotor
from test_service import START, TOKEN
from test_vfx_receiver import VfxSdk


class PacketSdk(VfxSdk):
    """SDK ring-buffer semantics using supplied raw packets, including stale data."""
    def __init__(self, packets=None, rate=1000):
        super().__init__()
        self.base_rate = self.velocity_rate = rate
        pulse = [260] * 70 + [100, 420] * 30 + [260] * 50
        self.packets = packets or [[(i, raw, 0) for i, raw in enumerate(pulse)]] * 4
        self.station = -1
        self.offset = 0
        self.active = False
        self.opens = self.control_opens = 0
        self.incoming = []
        self.before_read = None
        self.before_open = None

    def PolyOpenUdpEthernetCommunication(self, pointer, *args):
        self.control_opens += 1
        if self.before_open:
            self.before_open()
        return super().PolyOpenUdpEthernetCommunication(pointer, *args)

    def PolyOpenDataAcquisition(self, *args):
        self.opens += 1
        return super().PolyOpenDataAcquisition(*args)

    def PolyStartDataAcquisition(self, *args):
        assert not self.active, 'double StartDAQ'
        self.active = True
        self.incoming.clear()  # vendor StartAcquisition clears the ring buffer
        self.station += 1
        self.offset = 0
        return super().PolyStartDataAcquisition(*args)

    def PolyStopDataAcquisition(self, *args):
        self.active = False
        return super().PolyStopDataAcquisition(*args)

    def PolyReadData(self, _, count, timeout):
        assert self.active, 'reading during movement'
        if self.before_read:
            self.before_read()
        data = self.packets[self.station]
        if self.offset == len(data):
            time.sleep(.001)
            return TIMEOUT
        self.incoming = data[self.offset:self.offset + count]
        self.offset += len(self.incoming)
        return 0

    def PolyExtractedSampleCount(self, _, channel, __, pointer):
        pointer._obj.value = len(self.incoming)
        return 0

    def PolyGetInt32Data(self, _, channel, __, values, count):
        for i in range(count):
            values[i] = self.incoming[i][0 if channel == VELOCITY else 1]
        return 0

    def PolyGetOverrange(self, _, __, ___, flags, count):
        for i in range(count):
            flags[i] = self.incoming[i][2] & 1
        return 0


def receiver_for(sdk, platform_path='fixture.dylib'):
    receiver = PolytecReceiver(ReceiverConfig(START['deviceIp'], START['hostIp'], platform_path))
    receiver.validate = lambda: None
    receiver._load_api = lambda: sdk
    return receiver


class StationSessionTests(unittest.TestCase):
    def test_ordered_saved_points_ignore_partial_arrival_on_mac_and_windows(self):
        # Arrive during a blade, then observe background and one full pass.
        pulse = [100, 420] * 30 + [260] * 80 + [100, 420] * 30 + [260] * 50
        for filename in ('DeviceCommunication.dll', 'libDeviceCommunication.dylib'):
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as folder:
                sdk = PacketSdk([[(i, raw, 0) for i, raw in enumerate(pulse)]])
                receiver = receiver_for(sdk, filename)
                motor = BufferedMotor()
                motor.drive_internal_position = True
                controller = create_app(Settings(TOKEN, 8765, Path(folder)), lambda _: receiver,
                                        lambda *a, **kw: motor).state.controller
                config = automatic_config(azimuths=(0,), mode='legacy', geometry=None,
                                          routeOrder='configured', rssiExitSpread=4)
                controller.start(StartRequest(**START, confirmMotion=True, pointCycle=config))
                controller.thread.join(5)
                self.assertFalse(controller.thread.is_alive())
                self.assertEqual(controller.status()['pointCycle']['state'], 'complete', controller.status().get('error'))
                record = json.loads(next((Path(folder)/'recordings').glob('*/manifest.json')).read_text())
                pc = record['pointCycle']
                self.assertTrue(pc['rssiDetector']['requireBackground'])
                self.assertTrue(pc['rssiDetector']['exitRequiresBaselineReturn'])
                self.assertEqual(pc['handoff']['entrySampleIndex'], 140)
                self.assertEqual(pc['handoff']['sampleIndex'], 229)
                self.assertGreaterEqual(pc['handoff']['partialPassesIgnored'], 1)

    def test_unordered_legacy_route_keeps_its_existing_detector_contract(self):
        pulse = [100, 420] * 30 + [260] * 50
        with tempfile.TemporaryDirectory() as folder:
            sdk = PacketSdk([[(i, raw, 0) for i, raw in enumerate(pulse)]])
            receiver = receiver_for(sdk)
            motor = BufferedMotor()
            motor.drive_internal_position = True
            controller = create_app(Settings(TOKEN, 8765, Path(folder)), lambda _: receiver,
                                    lambda *a, **kw: motor).state.controller
            config = automatic_config(azimuths=(0,), mode='legacy', geometry=None)
            controller.start(StartRequest(**START, confirmMotion=True, pointCycle=config))
            controller.thread.join(5)
            self.assertFalse(controller.thread.is_alive())
            self.assertEqual(controller.status()['pointCycle']['state'], 'complete', controller.status().get('error'))
            record = json.loads(next((Path(folder)/'recordings').glob('*/manifest.json')).read_text())
            self.assertFalse(record['pointCycle']['rssiDetector']['requireBackground'])
            self.assertEqual(record['pointCycle']['handoff']['entrySampleIndex'], 0)
            self.assertEqual(record['pointCycle']['handoff']['sampleIndex'], 89)

    def test_mac_and_windows_reuse_transport_reset_indices_and_drop_moving_buffer(self):
        for filename in ('DeviceCommunication.dll', 'libDeviceCommunication.dylib'):
            with self.subTest(filename=filename):
                sdk = PacketSdk()
                receiver = receiver_for(sdk, filename)
                receiver.reuse_session = True
                receiver.prepare_session()
                self.assertEqual(sdk.laser_commands, [])
                self.assertNotIn('start', sdk.events)
                for point in range(4):
                    sdk.incoming = [(999999, 511, 0)] * 20  # previous/moving data
                    stop = threading.Event()
                    batches = []
                    def receive(batch):
                        batches.append(batch)
                        stop.set()
                    receiver.run(stop, lambda *_: None, receive, keep_laser_on=True)
                    self.assertFalse(sdk.active)
                    self.assertEqual(batches[0].sample_start, 0)
                    self.assertEqual(batches[0].velocity_raw, [row[0] for row in sdk.packets[point][:len(batches[0].values)]])
                    self.assertEqual(sdk.closed, [])
                receiver.close_session(keep_laser_on=True)
                self.assertEqual(sdk.opens, 1)
                self.assertEqual(sdk.control_opens, 1)
                self.assertEqual(sdk.events.count('start'), 4)
                self.assertEqual(sdk.events.count('stop'), 5)  # initial stop + each station
                self.assertEqual(sdk.closed, ['acquisition', 'communication'])
                self.assertNotIn(0, sdk.laser_commands)

    def test_changed_sample_units_abort_before_new_start(self):
        sdk = PacketSdk()
        receiver = receiver_for(sdk)
        receiver.reuse_session = True
        receiver.prepare_session()
        sdk.velocity_rate = 2000
        with self.assertRaisesRegex(RuntimeError, '采样率或速度量程已变化'):
            receiver.run(threading.Event(), lambda *_: None, lambda _: None, keep_laser_on=True)
        self.assertEqual(sdk.events.count('start'), 0)
        self.assertEqual(sdk.closed, ['acquisition', 'communication'])

    def test_stop_failure_cannot_retain_session(self):
        sdk = PacketSdk()
        receiver = receiver_for(sdk)
        receiver.reuse_session = True
        receiver.prepare_session()
        stop = threading.Event()
        with patch.object(sdk, 'PolyStopDataAcquisition', return_value=5):
            with self.assertRaisesRegex(RuntimeError, 'Stop acquisition'):
                receiver.run(stop, lambda *_: None, lambda _: stop.set(), keep_laser_on=True)
        self.assertIsNone(receiver.api)
        self.assertEqual(sdk.laser_commands[-1], 0)

    def test_cancel_preparation_never_starts_or_lights_laser(self):
        sdk = PacketSdk()
        receiver = receiver_for(sdk)
        cancel = threading.Event()
        sdk.before_open = cancel.set
        receiver.prepare_session(cancel.is_set)
        receiver.close_session(keep_laser_on=True)
        self.assertEqual(sdk.events.count('start'), 0)
        self.assertEqual(sdk.laser_commands, [])

    def test_full_cycle_waits_for_data_and_never_captures_moving_samples(self):
        with tempfile.TemporaryDirectory() as folder:
            sdk = PacketSdk()
            receiver = receiver_for(sdk)
            motor = BufferedMotor()
            motor.drive_internal_position = True
            connected = threading.Event()
            original_connect = motor.connect
            def connect():
                connected.set()
                return original_connect()
            motor.connect = connect
            sdk.before_open = lambda: self.assertTrue(connected.wait(1), 'SDK setup did not overlap motor checks')
            controller = create_app(Settings(TOKEN, 8765, Path(folder)), lambda _: receiver,
                                    lambda *a, **kw: motor).state.controller
            moves = []
            def move(motor, **kw):
                self.assertFalse(sdk.active)
                self.assertIsNone(controller.rssi_handoff)
                moves.append(kw['targets'])
                sdk.incoming = [(999999, 511, 0)] * 100
                kw['observe']({'phase': 'command_sending', 'axis': 1})
                motor.angles.update(dict(zip((1, 2), kw['targets'])))
                return {'feedback': snapshot(motor, 1), 'stopConfirmed': True,
                        'state': 'complete', 'mode': 'drive_internal', 'motionCommanded': True}
            first_read_phases = []
            def before_read():
                if sdk.offset == 0:
                    first_read_phases.append(controller.point_cycle['processPhase'])
            sdk.before_read = before_read
            with patch('blade_acquisition.drive_position.execute_drive_position', side_effect=move):
                controller.start(StartRequest(**START, clientRequestedAt=time.time(), confirmMotion=True,
                                              pointCycle=automatic_config()))
                controller.thread.join(5)
                self.assertFalse(controller.thread.is_alive())
            self.assertEqual(controller.status()['pointCycle']['state'], 'complete', controller.status().get('error'))
            self.assertEqual(len(moves), 3)  # first point is already at target
            self.assertEqual(sdk.opens, 1)
            self.assertEqual(first_read_phases, ['waiting_samples'] * 4)
            records = sorted((Path(folder)/'recordings').glob('*/manifest.json'))
            self.assertEqual(len(records), 4)
            for path in records:
                record = json.loads(path.read_text())
                pc = record['pointCycle']
                self.assertEqual(record['status'], 'complete')
                self.assertEqual(pc['acquisitionSessionMode'], 'reused_handle')
                self.assertGreaterEqual(pc['firstSampleAt'], pc['daqStartedAt'])
                self.assertTrue(pc['handoff']['receiverSessionReused'])
                self.assertIn('receiverPausedAt', pc['handoff'])
                self.assertNotIn('receiverClosedAt', pc['handoff'])
                self.assertTrue(any(e['phase'] == 'start_requested' for e in pc['startupEvents']))
            self.assertIsNone(controller.cycle_receiver)
            self.assertEqual(sdk.closed, ['acquisition', 'communication'])

    def test_failed_handoff_closes_retained_owner_and_never_starts_next_point(self):
        with tempfile.TemporaryDirectory() as folder:
            sdk = PacketSdk()
            receiver = receiver_for(sdk)
            motor = BufferedMotor()
            motor.drive_internal_position = True
            controller = create_app(Settings(TOKEN, 8765, Path(folder)), lambda _: receiver,
                                    lambda *a, **kw: motor).state.controller
            with patch('blade_acquisition.drive_position.execute_drive_position', side_effect=RuntimeError('fixture move rejected')):
                controller.start(StartRequest(**START, confirmMotion=True, pointCycle=automatic_config()))
                controller.thread.join(3)
            self.assertFalse(controller.thread.is_alive())
            self.assertEqual(controller.status()['pointCycle']['state'], 'error')
            self.assertEqual(sdk.events.count('start'), 1)
            self.assertEqual(sdk.closed, ['acquisition', 'communication'])
            self.assertIsNone(controller.cycle_receiver)

    def test_cancel_slow_prepare_retains_ownership_until_native_call_returns(self):
        with tempfile.TemporaryDirectory() as folder:
            sdk = PacketSdk()
            receiver = receiver_for(sdk)
            controller = create_app(Settings(TOKEN, 8765, Path(folder))).state.controller
            entered, release = threading.Event(), threading.Event()
            def blocked_open():
                entered.set()
                self.assertTrue(release.wait(2))
            sdk.before_open = blocked_open
            controller.point_cycle = {'state': 'checking'}
            controller._prepare_cycle_receiver(receiver)
            self.assertTrue(entered.wait(1))
            controller.stop_event.set()
            with self.assertRaisesRegex(RuntimeError, '准备已停止'):
                controller._await_cycle_receiver()
            self.assertTrue(controller.status()['receiver']['running'])
            self.assertEqual(sdk.closed, [])
            release.set()
            controller.cycle_prepare_thread.join(2)
            self.assertFalse(controller.cycle_prepare_thread.is_alive())
            self.assertIsNone(controller.cycle_receiver)
            self.assertFalse(controller.status()['receiver']['running'])
            self.assertEqual(sdk.events.count('start'), 0)
            self.assertEqual(sdk.laser_commands, [])
            self.assertEqual(sdk.closed, ['acquisition', 'communication'])

    def test_arrival_snapshot_reuse_expires_and_reference_mismatch_still_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            controller = create_app(Settings(TOKEN, 8765, Path(folder))).state.controller
            motor = BufferedMotor()
            cycle = PointCycleConfig(**automatic_config())
            feedback = snapshot(motor, 1)
            with patch('blade_acquisition.service.motor_snapshot', wraps=lambda m, a: snapshot(m, a)) as read:
                controller._cycle_capture_pose(motor, cycle, cycle.points[0], arrived_feedback=feedback)
                read.assert_not_called()
                feedback['queryStartedAt'] -= 1
                controller._cycle_capture_pose(motor, cycle, cycle.points[0], arrived_feedback=feedback)
                self.assertEqual(read.call_count, 1)
            feedback = snapshot(motor, 1)
            feedback['axes']['1']['origin_counts'] += 1
            with self.assertRaisesRegex(RuntimeError, '参考位'):
                controller._cycle_capture_pose(motor, cycle, cycle.points[0], arrived_feedback=feedback)


if __name__ == '__main__':
    unittest.main()
