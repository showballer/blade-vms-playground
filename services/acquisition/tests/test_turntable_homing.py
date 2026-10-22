"""app(5) sensor homing and level return, no real serial/laser/network I/O."""
import struct
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable_driver import MotorController, MotorError
from blade_acquisition.turntable_driver.motor_controller import CommandRejected
from blade_acquisition.turntable_driver.protocol import (
    CMD_CONFIG_DUAL_LIMIT, CMD_READ_DUAL_LIMIT, CMD_HOME_DUAL_LIMIT, CMD_SET_ZERO, CMD_SET_REFERENCE,
    append_crc, verify_crc, build_axis1_limit_config, build_axis1_limit_home,
    CMD_READ_FEEDBACK, Response,
)
from test_vendor_v35 import RecoverySerial
from test_turntable_reference import ReferenceMotor
from test_turntable import ReadyReceiver, TOKEN
from laser_fixture import FakeLaserPanel


class HomeSerial(RecoverySerial):
    def __init__(self):
        super().__init__()
        self.pending_flags = []

    def write(self, frame):
        result = super().write(frame)
        if frame[4] == CMD_READ_DUAL_LIMIT and frame[4] not in self.reject:
            pending = self.pending_flags.pop(0) if self.pending_flags else 0
            data = struct.pack('>BBBBbBiiBB', 1, 2, 0, 0, -1, 3, -29000, 35000, 0, pending)
            payload = frame[3:5] + b'\x00' + frame[5:7] + data
            self.buffer = bytearray(append_crc(b'\xaa\x55' + bytes((len(payload) + 2,)) + payload))
        if frame[4] == CMD_HOME_DUAL_LIMIT:
            payload = frame[3:5] + b'\x00' + frame[5:7] + b'\x00\x00'
            self.buffer = bytearray(append_crc(b'\xaa\x55' + bytes((len(payload) + 2,)) + payload))
        return result


class HomingDriverTests(unittest.TestCase):
    def test_clear_pitch_reference_configures_vendor_limits_without_search_or_move(self):
        class ClearingSerial(HomeSerial):
            def write(inner, frame):
                result = super().write(frame)
                if frame[4] == CMD_CONFIG_DUAL_LIMIT:
                    inner.flags[1] &= ~1
                    inner.guard_fault[1] = 0
                return result
        serial = ClearingSerial()
        motor = MotorController('TEST', timeout=.02, serial_factory=lambda *a, **kw: serial).connect()
        try:
            with patch('blade_acquisition.turntable_driver.motor_controller.time.sleep'):
                actual = motor.clear_axis1_reference()
            self.assertIsNone(actual.output_angle_deg)
            commands = [frame[4] for frame in serial.frames]
            self.assertEqual(commands.count(CMD_CONFIG_DUAL_LIMIT), 1)
            self.assertFalse({CMD_HOME_DUAL_LIMIT, CMD_SET_ZERO, CMD_SET_REFERENCE, 0x19, 0x14, 0x32}.intersection(commands))
            self.assertTrue(serial.flags[2] & 1)
        finally:
            motor.close(stop=False)

    def test_app5_frames_and_speed_units(self):
        config = build_axis1_limit_config()
        self.assertTrue(verify_crc(config))
        self.assertEqual(config[4:7], b'\x26DL')
        self.assertEqual(struct.unpack('>BBBBbBii', config[7:-2]), (1, 2, 0, 0, -1, 3, -29000, 35000))
        for speed in (.2, .6, 1.5):
            frame = build_axis1_limit_home(speed)
            self.assertTrue(verify_crc(frame))
            self.assertEqual(frame[4:7], b'\x28DI')
            self.assertEqual(struct.unpack('>biii', frame[7:-2]), (-1, round(speed * 1000), 45000, 120000))
        for speed in (True, None, '0.6', .199, 1.501, float('nan'), float('inf')):
            with self.assertRaises(ValueError): build_axis1_limit_home(speed)

    def test_read_only_capability_and_verified_configuration(self):
        serial = HomeSerial()
        motor = MotorController('TEST', timeout=.02, serial_factory=lambda *a, **kw: serial).connect()
        try:
            self.assertEqual(motor.get_axis1_limits()['raised_deg'], 35)
            self.assertEqual([f[4] for f in serial.frames], [CMD_READ_DUAL_LIMIT])
            with patch('blade_acquisition.turntable_driver.motor_controller.time.sleep'):
                motor.configure_axis1_homing()
                motor.start_axis1_limit_homing(.6)
            self.assertEqual([f[4] for f in serial.frames].count(CMD_CONFIG_DUAL_LIMIT), 1)
            self.assertEqual([f[4] for f in serial.frames].count(CMD_HOME_DUAL_LIMIT), 1)
            self.assertNotIn(CMD_SET_ZERO, [f[4] for f in serial.frames])
            self.assertNotIn(CMD_SET_REFERENCE, [f[4] for f in serial.frames])
        finally: motor.close(stop=False)

    def test_old_firmware_rejection_does_not_fall_back_to_arbitrary_zero(self):
        serial = HomeSerial(); serial.reject[CMD_READ_DUAL_LIMIT] = 7
        motor = MotorController('TEST', timeout=.02, serial_factory=lambda *a, **kw: serial).connect()
        try:
            with self.assertRaisesRegex(MotorError, r'app\(5\)'): motor.get_axis1_limits()
            self.assertEqual([f[4] for f in serial.frames], [CMD_READ_DUAL_LIMIT])
        finally: motor.close(stop=False)

    def test_configuration_pending_flag_two_is_busy_not_corrupt_and_only_reads_are_repeated(self):
        serial = HomeSerial(); serial.pending_flags = [2, 0]
        motor = MotorController('TEST', timeout=.02, serial_factory=lambda *a, **kw: serial).connect()
        try:
            with patch('blade_acquisition.turntable_driver.motor_controller.time.sleep'):
                actual = motor.configure_axis1_homing()
            self.assertFalse(actual['pending'])
            commands = [frame[4] for frame in serial.frames]
            self.assertEqual(commands.count(CMD_CONFIG_DUAL_LIMIT), 1)
            self.assertEqual(commands.count(CMD_READ_DUAL_LIMIT), 2)
            self.assertNotIn(CMD_HOME_DUAL_LIMIT, commands)
        finally: motor.close(stop=False)

    def test_stop_during_preflight_never_sends_search_or_reference_config_after_cancel(self):
        serial = HomeSerial()
        motor = MotorController('TEST', timeout=.02, serial_factory=lambda *a, **kw: serial).connect()
        cancel = threading.Event()
        motor.stop = Mock(side_effect=lambda axis: cancel.set())
        try:
            for action in (motor.configure_axis1_homing, motor.start_axis1_limit_homing):
                cancel.clear()
                with self.assertRaises(InterruptedError): action(cancel=cancel)
            self.assertEqual(serial.frames, [])
        finally: motor.close(stop=False)


class HomingMotor(ReferenceMotor):
    def __init__(self):
        super().__init__()
        self.home_calls = []
        self.hold_home = False
        self.home_fault = False
        self.bad_home = False
        self.unsupported = False
        self.seeking = False
        self.renewals = 0
        self.busy_reads = 0
        self.at_upper_after_config = False
        self.raw_inputs = 63
        self.active_inputs = 0

    def get_axis1_limits(self):
        self.home_calls.append('read_limits')
        if self.unsupported: raise MotorError('旧固件不支持 app(5) 机械回零')
        return {'pending': False, 'enabled': True, 'raised_channel': 0, 'raised_deg': 35, 'active_high': False,
                'horizontal_channel': 2, 'horizontal_deg': -29, 'positive_is_up': False}

    def configure_axis1_homing(self, *, cancel=None):
        self.home_calls.append('configure')
        self.lost.add(1)
        self.guard_configs[1] = replace(self.get_guard_config(1), minimum_deg=-29, maximum_deg=35, soft_enabled=True)
        if self.at_upper_after_config:
            self.lost.discard(1); self.angles[1] = 35; self.faults[1] = 0; self.phase = 0
            self.pending.discard(1)
            self.origins[1] += 100

    def start_axis1_limit_homing(self, speed, *, cancel=None):
        self.home_calls.append(('search', speed))
        self.seeking = True; self.phase = 1

    def get_feedback(self, axis):
        if axis == 1 and self.seeking and self.busy_reads:
            self.busy_reads -= 1
            raise CommandRejected(Response(1, CMD_READ_FEEDBACK, 6, 0, b'', b''))
        if axis == 1 and self.seeking and not self.hold_home:
            self.phase = 8 if self.home_fault else 7
            self.faults[1] = 5 if self.home_fault else 0
            self.pending.discard(1)
            self.lost.discard(1)
            self.angles[1] = 34 if self.bad_home else 35
            self.origins[1] += 100
            self.seeking = False
        value = super().get_feedback(axis)
        if axis == 1:
            value = replace(value, raw_inputs=self.raw_inputs, active_inputs=self.active_inputs)
        if axis == 1 and self.at_upper_after_config:
            value = replace(value, raw_inputs=62, active_inputs=1)
        return value

    def move_to_angle(self, axis, target, **kwargs):
        self.home_calls.append(('move', axis, target, kwargs['speed_rpm']))
        self.angles[axis] = target

    def renew_continuous(self, axis):
        self.renewals += 1

    def stop(self, axis, **kwargs):
        self.seeking = False
        self.phase = 0
        self.pending.discard(axis)
        return super().stop(axis, **kwargs)


class HomingServiceTests(unittest.TestCase):
    def setUp(self):
        panel = patch('blade_acquisition.service.DevicePanel', FakeLaserPanel)
        panel.start(); self.addCleanup(panel.stop)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.motor = HomingMotor()
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), ReadyReceiver, lambda *a, **kw: self.motor)
        self.client = TestClient(self.app, base_url='http://127.0.0.1:8765', headers={'Authorization': f'Bearer {TOKEN}'})
        self.client.__enter__(); self.addCleanup(lambda: self.client.__exit__(None, None, None))

    def start(self, action='mechanical_home', **changes):
        return self.client.post('/api/field/turntable', json={'action': action, 'port': 'COM3', 'axis': 1,
                                                   'confirmMotion': True, **changes})

    def wait(self):
        for _ in range(300):
            status = self.client.get('/api/field/status').json()
            if not status['turntableBusy']: return status
            time.sleep(.01)
        self.fail('homing worker did not finish')

    def valid_reference(self):
        self.motor.lost.clear(); self.motor.pending.clear(); self.motor.faults[1] = 0

    def test_real_encoder_unit_change_still_stops_level_return_with_exact_evidence(self):
        self.valid_reference()
        original_read = self.motor.get_feedback
        original_move = self.motor.move_to_angle
        changed = False
        def move(*args, **kwargs):
            nonlocal changed
            original_move(*args, **kwargs)
            changed = True
        self.motor.move_to_angle = move
        self.motor.get_feedback = lambda axis: replace(original_read(axis), encoder_bits=22) if changed and axis == 1 else original_read(axis)
        self.assertEqual(self.start('horizontal_zero').status_code, 200)
        value = self.wait()['turntable']
        self.assertEqual(value['homing']['state'], 'error')
        self.assertIn('encoder_bits', value['error'])
        self.assertIn('17→22', value['error'])
        self.assertEqual(value['homing']['referenceChange']['changes'][0]['field'], 'encoder_bits')
        self.assertFalse(value['homing']['verified'])

    def test_power_cycle_homes_then_levels_without_moving_horizontal_axis(self):
        self.assertEqual(self.start().status_code, 200)
        home = self.wait()
        self.assertTrue(home['turntable']['homing']['verified'])
        self.assertEqual(home['turntable']['feedback']['axes']['1']['output_angle_deg'], 35)
        self.assertIn(('search', .6), self.motor.home_calls)
        self.assertEqual(self.motor.references, [])
        self.assertEqual(self.start('horizontal_zero').status_code, 200)
        level = self.wait()
        self.assertTrue(level['turntable']['homing']['verified'])
        self.assertIn(('move', 1, 0, .6 / 6), self.motor.home_calls)
        self.assertFalse(any(isinstance(c, tuple) and c[:2] == ('move', 2) for c in self.motor.home_calls))
        self.assertEqual(level['receiver']['running'], False)
        self.assertEqual(level['turntableWarning'], None)

    def test_valid_reference_home_also_seeks_upper_limit_instead_of_position_mode(self):
        self.valid_reference()
        origins = dict(self.motor.origins)
        self.motor.move_to_angle = Mock(side_effect=AssertionError('位置模式在实机反向，机械回零不得使用'))
        self.assertEqual(self.start(homingSpeedDegS=1.2).status_code, 200)
        self.assertTrue(self.wait()['turntable']['homing']['verified'])
        self.assertIn(('search', 1.2), self.motor.home_calls)
        self.assertIn('configure', self.motor.home_calls)
        self.assertNotEqual(self.motor.origins[1], origins[1])
        self.assertEqual(self.motor.origins[2], origins[2])
        self.motor.move_to_angle.assert_not_called()

    def test_already_at_upper_limit_does_not_rebuild_reference(self):
        self.valid_reference(); self.motor.angles[1] = 34.96
        self.motor.move_to_angle = Mock(side_effect=AssertionError('限位附近不应补发小角度定位'))
        origins = dict(self.motor.origins)
        self.assertEqual(self.start().status_code, 200)
        self.assertTrue(self.wait()['turntable']['homing']['verified'])
        self.assertNotIn('configure', self.motor.home_calls)
        self.assertEqual(self.motor.origins, origins)
        self.motor.move_to_angle.assert_not_called()

    def test_level_return_stops_on_wrong_actual_direction_without_replay(self):
        self.valid_reference(); self.motor.angles[1] = 12.38
        def wrong_direction(axis, target, **kwargs):
            self.motor.home_calls.append(('wrong_move', axis, target))
            self.motor.angles[axis] += .2
        self.motor.move_to_angle = wrong_direction
        self.assertEqual(self.start('horizontal_zero').status_code, 200)
        result = self.wait()
        self.assertEqual(result['turntable']['homing']['state'], 'error')
        self.assertIn('方向与目标相反', result['turntable']['error'])
        self.assertTrue(result['turntable']['homing']['stopConfirmed'])
        self.assertEqual(self.motor.home_calls.count(('wrong_move', 1, 0)), 1)
        self.assertEqual(self.motor.angles[2], 0)

    def test_limit_transition_busy_read_does_not_cancel_home_or_replay_motion(self):
        self.motor.busy_reads = 2
        self.assertEqual(self.start().status_code, 200)
        result = self.wait()
        self.assertTrue(result['turntable']['homing']['verified'])
        self.assertEqual(self.motor.home_calls.count(('search', .6)), 1)
        self.assertEqual(self.motor.home_calls.count('configure'), 1)

    def test_already_active_upper_limit_reference_is_confirmed_without_another_start(self):
        self.motor.at_upper_after_config = True
        self.assertEqual(self.start().status_code, 200)
        result = self.wait()
        self.assertTrue(result['turntable']['homing']['verified'])
        self.assertFalse(any(isinstance(c, tuple) for c in self.motor.home_calls))
        self.assertEqual(self.motor.references, [])

    def test_limit_start_rejection_only_succeeds_with_actual_upper_sensor_and_reference(self):
        def at_limit(speed, **kwargs):
            self.motor.at_upper_after_config = True
            self.motor.lost.discard(1); self.motor.pending.discard(1)
            self.motor.angles[1] = 35; self.motor.faults[1] = 0; self.motor.phase = 0
            raise CommandRejected(Response(1, CMD_HOME_DUAL_LIMIT, 8, 0, b'', b''))
        self.motor.start_axis1_limit_homing = Mock(side_effect=at_limit)
        self.assertEqual(self.start().status_code, 200)
        self.assertTrue(self.wait()['turntable']['homing']['verified'])
        self.motor.start_axis1_limit_homing.assert_called_once()
        self.assertEqual(self.motor.references, [])

    def test_limit_start_rejection_without_actual_reference_still_fails(self):
        self.motor.start_axis1_limit_homing = Mock(side_effect=CommandRejected(
            Response(1, CMD_HOME_DUAL_LIMIT, 8, 0, b'', b'')))
        self.assertEqual(self.start().status_code, 200)
        self.assertFalse(self.wait()['turntable']['homing']['verified'])
        self.motor.start_axis1_limit_homing.assert_called_once()
        self.assertEqual(self.motor.references, [])

    def test_persistent_busy_read_is_bounded_and_stops(self):
        self.motor.busy_reads = 1000
        with patch('blade_acquisition.turntable_homing.READ_BUSY_SECONDS', .02):
            self.assertEqual(self.start().status_code, 200)
            result = self.wait()
        self.assertEqual(result['turntable']['homing']['state'], 'error')
        self.assertTrue(result['turntable']['homing']['stopConfirmed'])
        self.assertEqual(self.motor.home_calls.count(('search', .6)), 1)

    def test_busy_start_is_never_replayed(self):
        self.motor.start_axis1_limit_homing = Mock(side_effect=CommandRejected(
            Response(1, CMD_HOME_DUAL_LIMIT, 6, 0, b'', b'')))
        self.assertEqual(self.start().status_code, 200)
        result = self.wait()
        self.assertEqual(result['turntable']['homing']['state'], 'error')
        self.motor.start_axis1_limit_homing.assert_called_once()

    def test_cancelled_unreferenced_home_can_be_recovered_without_arbitrary_zero(self):
        self.motor.faults[1] = 7
        self.assertEqual(self.start().status_code, 200)
        self.assertTrue(self.wait()['turntable']['homing']['verified'])
        self.assertEqual(self.motor.references, [])

    def test_latched_sensor_fault_with_verified_inactive_inputs_requires_full_home(self):
        self.motor.faults[1] = 1
        self.motor.pending.clear()
        self.assertEqual(self.start().status_code, 200)
        result = self.wait()
        self.assertTrue(result['turntable']['homing']['verified'])
        self.assertIn('configure', self.motor.home_calls)
        self.assertIn(('search', .6), self.motor.home_calls)
        self.assertEqual(self.motor.references, [])
        self.assertFalse(any(isinstance(c, tuple) and c[0] == 'move' for c in self.motor.home_calls))

    def test_live_limit_or_uncertain_sensor_mapping_cannot_be_cleared_by_home(self):
        original_limits = self.motor.get_axis1_limits
        for mode in ('raised_active', 'horizontal_active', 'unknown_polarity', 'pending_stop'):
            with self.subTest(mode=mode):
                self.motor.home_calls.clear()
                self.motor.faults[1] = 1
                self.motor.pending = {1} if mode == 'pending_stop' else set()
                self.motor.raw_inputs = 62 if mode == 'raised_active' else 59 if mode == 'horizontal_active' else 63
                self.motor.active_inputs = 1 if mode == 'raised_active' else 4 if mode == 'horizontal_active' else 0
                self.motor.get_axis1_limits = lambda: {**original_limits(),
                    **({'active_high': True} if mode == 'unknown_polarity' else {})}
                self.assertEqual(self.start().status_code, 200)
                self.assertEqual(self.wait()['turntable']['homing']['state'], 'error')
                self.assertFalse(any(c == 'configure' or isinstance(c, tuple) for c in self.motor.home_calls))
        self.motor.get_axis1_limits = original_limits

    def test_no_reference_level_return_pending_trajectory_and_unknown_firmware_never_move(self):
        for mode in ('no_reference', 'ready_trajectory', 'old_firmware', 'fault'):
            self.motor.home_calls.clear()
            self.motor.initial_state = 2 if mode == 'ready_trajectory' else 0
            self.motor.unsupported = mode == 'old_firmware'
            self.motor.faults[1] = 5 if mode == 'fault' else 3
            self.assertEqual(self.start('horizontal_zero' if mode == 'no_reference' else 'mechanical_home').status_code, 200)
            result = self.wait()
            self.assertEqual(result['turntable']['homing']['state'], 'error')
            self.assertFalse(any(c == 'configure' or isinstance(c, tuple) for c in self.motor.home_calls))

    def test_cancel_during_search_stops_without_starting_a_level_move(self):
        self.motor.hold_home = True
        self.assertEqual(self.start().status_code, 200)
        for _ in range(100):
            if self.motor.seeking: break
            time.sleep(.01)
        self.assertTrue(self.motor.seeking)
        rejected = self.start('horizontal_zero')
        self.assertEqual(rejected.status_code, 409)
        stopped = self.start('stop')
        self.assertEqual(stopped.status_code, 200)
        result = self.wait()
        self.assertEqual(result['turntable']['homing']['state'], 'cancelled')
        self.assertTrue(result['turntable']['homing']['stopConfirmed'])
        self.assertFalse(any(isinstance(c, tuple) and c[0] == 'move' for c in self.motor.home_calls))

    def test_failed_search_never_reports_completed_or_retries(self):
        self.motor.home_fault = True
        self.assertEqual(self.start().status_code, 200)
        result = self.wait()
        self.assertFalse(result['turntable']['homing']['verified'])
        self.assertEqual(result['turntable']['homing']['state'], 'error')
        self.assertEqual(self.motor.home_calls.count(('search', .6)), 1)

    def test_done_phase_with_wrong_angle_is_not_accepted(self):
        self.motor.bad_home = True
        self.assertEqual(self.start().status_code, 200)
        result = self.wait()
        self.assertFalse(result['turntable']['homing']['verified'])
        self.assertIn('不是+35°', result['turntable']['error'])

    def test_timeout_stops_and_does_not_resend_search(self):
        self.motor.hold_home = True
        with patch('blade_acquisition.turntable_homing.HOMING_TIMEOUT_SECONDS', .05):
            self.assertEqual(self.start().status_code, 200)
            result = self.wait()
        self.assertEqual(result['turntable']['homing']['state'], 'error')
        self.assertTrue(result['turntable']['homing']['stopConfirmed'])
        self.assertEqual(self.motor.home_calls.count(('search', .6)), 1)
        self.assertGreaterEqual(self.motor.renewals, 1)

    def test_api_rejects_wrong_axis_missing_confirmation_and_bad_units(self):
        for changes in ({'axis': 2}, {'confirmMotion': False}, {'confirmRecovery': True},
                        {'homingSpeedDegS': True}, {'homingSpeedDegS': '0.6'}, {'homingSpeedDegS': .1}, {'homingSpeedDegS': 1.51}):
            self.assertEqual(self.start(**changes).status_code, 422)
        self.assertEqual(self.motor.home_calls, [])


if __name__ == '__main__': unittest.main()
