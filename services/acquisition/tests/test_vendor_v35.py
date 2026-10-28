"""app(3) adapter contract tests. All serial traffic stays in memory."""
import struct
import unittest
from dataclasses import replace
from unittest.mock import patch

from blade_acquisition.turntable_driver import MotorController, MotorError, TrajectoryPoint
from blade_acquisition.turntable_driver.protocol import (
    CMD_CONFIG_GUARD, CMD_SET_REFERENCE, CMD_TRAJECTORY_CLEAR, CMD_TRAJECTORY_BEGIN,
    CMD_TRAJECTORY_START, CMD_SET_ZERO, CMD_RESET_ALARM, append_crc, build_set_reference,
    build_trajectory_begin, verify_crc, CMD_TRAJECTORY_STATUS, CMD_TRAJECTORY_STOP,
)
from blade_acquisition.turntable_driver.faults import get_fault_advice
from blade_acquisition.turntable_driver.trajectory import AxisPosition, business_trajectory
from test_buffered_trajectory import SerialFixture


class RecoverySerial(SerialFixture):
    def __init__(self):
        super().__init__()
        self.guard_fault = {1: 3, 2: 0}
        self.alarm = {1: 0, 2: 0}
        self.soft = {1: True, 2: False}
        self.inputs = 0
        self.ignore_clear = False

    def write(self, frame):
        result = super().write(frame)
        axis, cmd = frame[3:5]
        if cmd == self.drop:
            return result
        status = self.reject.get(cmd, 0)
        data = None
        if cmd == CMD_CONFIG_GUARD and not self.ignore_clear and not status:
            self.guard_fault[axis] = 0
        if cmd == CMD_SET_REFERENCE:
            if not status:
                self.angles[axis] = struct.unpack('>i', frame[7:11])[0] / 1000
                self.guard_fault[axis] = 0
                self.flags[axis] = (self.flags[axis] | 1) & ~0x30
                self.limit_flags[axis] = 0
            data = frame[7:11]
        if cmd == CMD_SET_ZERO and not status:
            self.angles[axis] = 25 if axis == 1 else 0
            self.guard_fault[axis] = 0
            self.flags[axis] = (self.flags[axis] | 1) & ~0x30
            self.limit_flags[axis] = 0
        if cmd == CMD_TRAJECTORY_CLEAR:
            if not status and not self.ignore_clear:
                self.state, self.fault = 0, 0
            data = struct.pack('>HBBHHIIIIiiii', self.session, self.state, self.fault,
                               self.count, self.loaded, 0, 2000, 250, 180, 10000, 0, 0, 0)
        if cmd == 0x09:
            data = struct.pack('>H', self.alarm[axis])
        if cmd == 0x20:
            data = struct.pack('>iiiHHHiHBBBBih', 0, 0, 0, 3, 10000, 17,
                round(self.angles[axis] * 1000), self.flags[axis], 0, self.inputs, 0,
                self.guard_fault[axis], self.origins[axis], self.rpm[axis])
        if cmd == 0x24:
            limit = 35000 if axis == 1 else 180000
            data = struct.pack('>BBBBbBBBiiB', 0, 1, 255, 1, -1, 1, 1,
                               self.soft[axis], -limit, limit, 0)
        if data is not None:
            payload = bytes((axis, cmd, status)) + frame[5:7] + data
            self.buffer = bytearray(append_crc(b'\xaa\x55' + bytes((len(payload) + 2,)) + payload))
        return result


class VendorV35Tests(unittest.TestCase):
    def setUp(self):
        self.serial = RecoverySerial()
        self.motor = MotorController('TEST', timeout=.02, serial_factory=lambda *a, **kw: self.serial).connect()
        sleep = patch('blade_acquisition.turntable_driver.motor_controller.time.sleep', return_value=None)
        sleep.start(); self.addCleanup(sleep.stop)
        self.addCleanup(lambda: self.motor.close(stop=False))

    def commands(self):
        return [f[4] for f in self.serial.frames]

    def test_new_frame_units_acceleration_and_adaptive_flag(self):
        frame = build_trajectory_begin(17, 2, cycle_ms=100, max_speed=30, max_accel=90, adaptive=True)
        self.assertTrue(verify_crc(frame))
        self.assertEqual(struct.unpack('>HHiiii', frame[7:-2]), (2, 0x8000 | 100, 30000, 90000, 750, 100))
        for kwargs in ({'max_speed': 61}, {'max_accel': 121}, {'cycle_ms': 49}, {'adaptive': 1}):
            with self.assertRaises(ValueError): build_trajectory_begin(17, 2, **kwargs)
        frame = build_set_reference(1, -3.25)
        self.assertEqual(frame[4:7], b'\x25RF')
        self.assertEqual(struct.unpack('>i', frame[7:11])[0], -3250)
        for angle in (True, float('nan'), 36):
            with self.assertRaises(ValueError): build_set_reference(1, angle)
        self.assertEqual(self.serial.frames, [])

    def test_clear_refuses_a_different_session_without_stopping_or_clearing_it(self):
        self.serial.state = 7
        self.serial.fault = 7
        with self.assertRaisesRegex(MotorError, '会话已变化'):
            self.motor.clear_trajectory_fault(expected_session=self.serial.session + 1)
        self.assertNotIn(CMD_TRAJECTORY_CLEAR, self.commands())
        self.assertNotIn(CMD_TRAJECTORY_STOP, self.commands())
        self.assertNotIn(CMD_TRAJECTORY_START, self.commands())

    def test_explicit_reference_never_falls_back_to_old_zero(self):
        self.assertEqual(self.motor.set_current_angle(1, 0).output_angle_deg, 0)
        self.assertNotIn(CMD_SET_ZERO, self.commands())
        self.serial.frames.clear(); self.serial.reject[CMD_SET_REFERENCE] = 7
        with self.assertRaisesRegex(MotorError, 'v3.5'): self.motor.set_current_angle(1, 0)
        self.assertEqual(self.commands().count(CMD_SET_REFERENCE), 1)
        self.assertNotIn(CMD_SET_ZERO, self.commands())

    def test_yaw_reference_repairs_fault3_pending_only_after_two_stationary_samples(self):
        self.serial.flags[2] = 0x10
        self.serial.guard_fault[2] = 3
        self.serial.limit_flags[2] = 2
        self.serial.angles[2] = 27
        pitch = self.motor.get_feedback(1)
        self.serial.frames.clear()
        result = self.motor.set_current_reference(2)
        commands = self.commands()
        write = commands.index(CMD_SET_ZERO)
        self.assertEqual(commands[:write].count(0x20), 2)
        self.assertEqual(commands[:write].count(0x07), 2)
        self.assertEqual(commands[:write].count(0x09), 2)
        self.assertEqual(commands.count(0x06), 1)
        self.assertEqual(result.output_angle_deg, 0)
        self.assertEqual(result.fault, 0)
        self.assertFalse(result.flags & 0x30)
        self.assertEqual(self.motor.get_feedback(1), pitch)
        self.assertFalse({0x05, 0x19, 0x1A, CMD_TRAJECTORY_START, CMD_RESET_ALARM}.intersection(commands))

    def test_reference_capture_does_not_bypass_positioning_other_fault_alarm_or_units(self):
        for case in ('positioning', 'fault', 'alarm', 'limit', 'units'):
            with self.subTest(case=case):
                self.serial.frames.clear()
                self.serial.flags[2], self.serial.guard_fault[2] = 0x10, 3
                self.serial.alarm[2], self.serial.limit_flags[2] = 0, 2
                if case == 'positioning': self.serial.flags[2] |= 0x20
                if case == 'fault': self.serial.guard_fault[2] = 8
                if case == 'alarm': self.serial.alarm[2] = 59
                if case == 'limit': self.serial.limit_flags[2] = 1
                actual = self.motor.get_feedback
                def feedback(axis):
                    value = actual(axis)
                    return replace(value, display_mode=0) if case == 'units' else value
                with patch.object(self.motor, 'get_feedback', side_effect=feedback):
                    with self.assertRaises(MotorError): self.motor.set_current_reference(2)
                self.assertNotIn(CMD_SET_ZERO, self.commands())
                self.assertNotIn(CMD_SET_REFERENCE, self.commands())

    def test_reference_ack_without_pending_and_fault_clear_is_not_success(self):
        self.serial.flags[2], self.serial.guard_fault[2] = 0x10, 3
        actual = self.motor.get_feedback
        def feedback(axis):
            value = actual(axis)
            return replace(value, flags=0x11, fault=3) if CMD_SET_ZERO in self.commands() else value
        with patch.object(self.motor, 'get_feedback', side_effect=feedback):
            with self.assertRaisesRegex(MotorError, '读回校验'):
                self.motor.set_current_reference(2)
        self.assertEqual(self.commands().count(CMD_SET_ZERO), 1)

    def test_adaptive_rejection_never_retries_with_protection_disabled_or_starts(self):
        self.serial.guard_fault[1] = 0
        self.serial.soft[2] = True
        self.serial.reject[CMD_TRAJECTORY_BEGIN] = 4
        points = (TrajectoryPoint(0, 10, 0), TrajectoryPoint(2, 10.2, .2))
        with self.assertRaisesRegex(MotorError, '共同减速.*未启动运动'):
            self.motor.prepare_trajectory(points, cycle_ms=100, adaptive=True)
        self.assertEqual(self.commands().count(CMD_TRAJECTORY_BEGIN), 1)
        self.assertNotIn(CMD_TRAJECTORY_START, self.commands())

    def test_clear_axis_preserves_reference_and_disabled_horizontal_soft_range(self):
        self.serial.angles[2] = 17.8; self.serial.flags[2] = 1; self.serial.guard_fault[2] = 2
        refs = dict(self.serial.origins)
        actual = self.motor.clear_guard_fault(2)
        self.assertEqual(actual.fault, 0)
        self.assertEqual(actual.output_angle_deg, 17.8)
        self.assertEqual(self.serial.origins, refs)
        writes = [f for f in self.serial.frames if f[4] == CMD_CONFIG_GUARD]
        self.assertEqual(len(writes), 1)
        # hardware on, soft off, confirmation retained, direction -1
        self.assertEqual(writes[0][5:9], b'\0\3\5\xff')
        self.assertFalse({CMD_SET_ZERO, CMD_SET_REFERENCE, CMD_TRAJECTORY_START, CMD_RESET_ALARM}.intersection(self.commands()))

    def test_execution_fault_uses_dedicated_ack_not_guard_reconfiguration(self):
        self.serial.guard_fault[1] = 8
        refs = dict(self.serial.origins)
        actual = self.motor.clear_guard_fault(1)
        self.assertEqual(actual.fault, 0)
        writes = [f for f in self.serial.frames if f[4] == CMD_CONFIG_GUARD]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][5:7], b'\0\4')
        self.assertEqual(self.serial.origins, refs)
        self.assertFalse({CMD_SET_ZERO, CMD_SET_REFERENCE, CMD_TRAJECTORY_START, CMD_RESET_ALARM}.intersection(self.commands()))

    def test_axis_recovery_refuses_bad_conditions_before_guard_write(self):
        cases = ('invalid_reference', 'moving', 'pending', 'alarm', 'range', 'limit', 'prepared', 'running')
        for case in cases:
            with self.subTest(case=case):
                self.serial.frames.clear(); self.serial.state = 0
                self.serial.flags[1] = 3; self.serial.rpm[1] = 0; self.serial.alarm[1] = 0
                self.serial.inputs = 0; self.serial.angles[1] = 10
                if case == 'invalid_reference': self.serial.flags[1] = 2
                if case == 'moving': self.serial.rpm[1] = 1
                if case == 'pending': self.serial.flags[1] = 19
                if case == 'alarm': self.serial.alarm[1] = 9
                if case == 'range': self.serial.angles[1] = 36
                if case == 'limit': self.serial.inputs = 1
                if case == 'prepared': self.serial.state = 2
                if case == 'running': self.serial.state = 3
                with patch.object(self.motor, 'stop', return_value=None):
                    with self.assertRaises(MotorError): self.motor.clear_guard_fault(1)
                self.assertNotIn(CMD_CONFIG_GUARD, self.commands())

    def test_axis_recovery_verifies_clear_and_unit_readback(self):
        self.serial.ignore_clear = True
        with self.assertRaisesRegex(MotorError, '未清除'): self.motor.clear_guard_fault(1)
        self.serial.ignore_clear = False
        self.serial.frames.clear()
        real = self.motor.get_feedback
        def changed(axis):
            value = real(axis)
            return replace(value, command_counts_per_rev=20000) if CMD_CONFIG_GUARD in self.commands() else value
        with patch.object(self.motor, 'get_feedback', side_effect=changed):
            with self.assertRaisesRegex(MotorError, '读回发生变化'): self.motor.clear_guard_fault(1)

    def test_trajectory_clear_confirms_both_stopped_and_invalidates_old_start(self):
        self.serial.session, self.serial.state, self.serial.fault = 17, 7, 7
        self.motor._trajectory_prepared = ('old',); self.motor._trajectory_session = 17
        result = self.motor.clear_trajectory_fault()
        self.assertEqual((result.state, result.fault), (0, 0))
        self.assertIsNone(self.motor._trajectory_prepared)
        self.assertIsNone(self.motor._trajectory_session)
        self.assertFalse(self.motor._trajectory_started)
        clear = next(f for f in self.serial.frames if f[4] == CMD_TRAJECTORY_CLEAR)
        self.assertEqual(struct.unpack('>H', clear[5:7])[0], 17)
        self.assertNotIn(CMD_TRAJECTORY_START, self.commands())
        self.assertNotIn(CMD_SET_ZERO, self.commands())
        self.assertNotIn(CMD_RESET_ALARM, self.commands())

    def test_clear_refuses_active_or_preloaded_and_does_not_retry_unsupported(self):
        for state in (1, 2, 3, 4):
            self.serial.state = state; self.serial.frames.clear()
            with self.assertRaises(MotorError): self.motor.clear_trajectory_fault()
            self.assertNotIn(CMD_TRAJECTORY_CLEAR, self.commands())
        self.serial.state = 7; self.serial.reject[CMD_TRAJECTORY_CLEAR] = 7
        self.serial.frames.clear()
        with self.assertRaisesRegex(MotorError, 'v3.4'): self.motor.clear_trajectory_fault()
        self.assertEqual(self.commands().count(CMD_TRAJECTORY_CLEAR), 1)
        self.assertNotIn(CMD_SET_ZERO, self.commands())

    def test_clear_is_not_successful_until_readback_is_idle(self):
        self.serial.state = 7; self.serial.ignore_clear = True
        with self.assertRaisesRegex(MotorError, '未清除'): self.motor.clear_trajectory_fault()

    def test_catalog_keeps_axis_trajectory_and_drive_domains_separate(self):
        self.assertNotEqual(get_fault_advice('guard', 7).title, get_fault_advice('trajectory', 7).title)
        self.assertIn('编码器', ' '.join(get_fault_advice('drive', 59).steps))
        self.assertIn('未识别', get_fault_advice('drive', 234).title)
        self.assertEqual(MotorError('not stopped').recovery.domain, 'sdk')

    def test_fault_report_preserves_partial_feedback_and_is_read_only(self):
        position = AxisPosition(None, 0, 0, 2, 2000, 59, 3, 2)
        with patch.object(self.motor, 'get_trajectory_status', side_effect=MotorError('unsupported')), \
                patch.object(self.motor, 'get_axis_positions', return_value=(position, position)):
            report = self.motor.get_fault_report()
        self.assertFalse(report.complete)
        self.assertEqual({i.domain for i in report.issues}, {'sdk', 'guard', 'drive', 'trajectory'})
        self.assertEqual(self.serial.frames, [])

    def test_cancel_pending_keeps_two_axis_reference_policy_angles_and_faults(self):
        self.serial.session, self.serial.state, self.serial.count, self.serial.loaded = 17, 2, 33, 33
        before = (dict(self.serial.origins), dict(self.serial.angles), dict(self.serial.guard_fault), dict(self.serial.soft))
        self.motor._trajectory_prepared = ('old',)
        result = self.motor.cancel_pending_trajectory(17)
        self.assertEqual((result.state, result.fault), (8, 1))
        self.assertEqual(before, (self.serial.origins, self.serial.angles, self.serial.guard_fault, self.serial.soft))
        self.assertIsNone(self.motor._trajectory_prepared)
        self.assertIsNone(self.motor._trajectory_session)
        writes = [f for f in self.serial.frames if f[4] not in (7, 9, 0x20, 0x24, CMD_TRAJECTORY_STATUS)]
        self.assertEqual([f[4] for f in writes], [CMD_TRAJECTORY_STOP])
        self.assertEqual(struct.unpack('>H', writes[0][5:7])[0], 17)

    def test_cancel_pending_refuses_stale_session_active_or_already_empty(self):
        self.serial.session = 17
        for state, session in ((0, 17), (1, 17), (3, 17), (4, 17), (7, 17), (2, 18)):
            self.serial.state = state; self.serial.frames.clear()
            with self.assertRaisesRegex(MotorError, '轨迹已变化'): self.motor.cancel_pending_trajectory(session)
            self.assertNotIn(CMD_TRAJECTORY_STOP, self.commands())
        self.serial.frames.clear()
        with self.assertRaises(ValueError): self.motor.cancel_pending_trajectory(True)
        self.assertEqual(self.serial.frames, [])

    def test_cancel_pending_rechecks_session_after_reading_stopped_axes(self):
        self.serial.session, self.serial.state = 17, 2
        reads = [0]
        def race(command):
            if command == CMD_TRAJECTORY_STATUS:
                reads[0] += 1
                if reads[0] == 2: self.serial.session = 18
        self.serial.on_write = race
        with self.assertRaisesRegex(MotorError, '轨迹已变化'): self.motor.cancel_pending_trajectory(17)
        self.assertNotIn(CMD_TRAJECTORY_STOP, self.commands())

    def test_cancel_pending_rejects_reference_change_and_lost_stop_reply(self):
        self.serial.session, self.serial.state = 17, 2
        def change(command):
            if command == CMD_TRAJECTORY_STOP: self.serial.origins[2] += 1
        self.serial.on_write = change
        with self.assertRaisesRegex(MotorError, '参考位'): self.motor.cancel_pending_trajectory(17)
        self.assertNotIn(CMD_SET_REFERENCE, self.commands())
        self.serial.on_write = None; self.serial.frames.clear(); self.serial.state = 2; self.serial.fault = 0
        self.serial.drop = CMD_TRAJECTORY_STOP
        with self.assertRaises(MotorError): self.motor.cancel_pending_trajectory(17)
        self.assertEqual(self.commands().count(CMD_TRAJECTORY_STOP), 1)
        self.assertNotIn(CMD_TRAJECTORY_START, self.commands())

    def test_retime_uses_supplied_limits_and_does_not_reduce_every_move_to_default_speed(self):
        points = (TrajectoryPoint(0, 0, 0), TrajectoryPoint(1, 10, 10))
        self.assertGreater(business_trajectory(points)[-1].time_s, 6)
        self.assertEqual(business_trajectory(points, max_speed=30, max_accel=90), points)
        for kwargs in ({'max_speed': True}, {'max_speed': 61}, {'max_accel': 121}):
            with self.assertRaises(ValueError): self.motor.prepare_business_trajectory(points, **kwargs)
        self.assertEqual(self.serial.frames, [])

    def test_business_prepare_uploads_the_same_custom_limits_without_motion(self):
        self.serial.angles[1] = 0
        self.serial.guard_fault[1] = 0
        position = AxisPosition(0, 0, 0, 3, 0, 0, 0, 0)
        points = (TrajectoryPoint(0, 0, 0), TrajectoryPoint(1, 10, 10))
        with patch.object(self.motor, 'get_axis_positions', return_value=(position, position)):
            self.motor.prepare_business_trajectory(points, max_speed=30, max_accel=90, cycle_ms=100)
        frame = next(f for f in self.serial.frames if f[4] == CMD_TRAJECTORY_BEGIN)
        self.assertEqual(struct.unpack('>HHiiii', frame[7:-2]), (2, 0x8000 | 100, 30000, 90000, 750, 300))
        self.assertNotIn(CMD_TRAJECTORY_START, self.commands())
        self.assertEqual(self.serial.points[-1][1], 1000)


if __name__ == '__main__': unittest.main()
