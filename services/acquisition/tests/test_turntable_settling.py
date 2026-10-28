"""Transient board flags, STOP receipt and real faults; no hardware I/O."""
from dataclasses import replace
import threading
import unittest
from unittest.mock import Mock, patch

from blade_acquisition.turntable import (wait_ready_snapshots, position_reached,
    PositionProgress, ManualPositionProgress, TurntableConfig)
from blade_acquisition.turntable_driver import MotorController, MotorError
from test_drive_position_test import PositionMotor, Clock


class SettlingTests(unittest.TestCase):
    def setUp(self):
        self.motor, self.clock = PositionMotor(), Clock()
        self.cancel = threading.Event()
        for target, value in (
            ('blade_acquisition.turntable.time.monotonic', self.clock.monotonic),
            ('blade_acquisition.turntable.time.sleep', self.clock.sleep),
        ):
            patched = patch(target, value)
            patched.start(); self.addCleanup(patched.stop)

    def pair(self, *, flags=3, fault=0, alarm=0, limit=0):
        pair = self.motor.snapshots()
        for value in pair:
            value['axes']['1'].update(flags=flags, fault=fault)
            value.update(alarmCode=alarm, limitFlags=limit)
        return pair

    def test_stop_pending_and_positioning_zero_speed_wait_for_two_clear_pairs(self):
        for flags in (0x13, 0x23, 0x33):
            with self.subTest(flags=flags), patch('blade_acquisition.turntable.joint_snapshots',
                    side_effect=[self.pair(flags=flags), self.pair(), self.pair()]) as reads:
                result = wait_ready_snapshots(self.motor, cancel=self.cancel, timeout_s=.2)
                self.assertEqual(reads.call_count, 3)
                self.assertEqual(result[0]['axes']['1']['flags'], 3)
                self.assertEqual(self.motor.commands, [])
                self.assertEqual(self.motor.stops, [])

    def test_regular_and_manual_position_progress_wait_but_never_complete_busy_feedback(self):
        config = TurntableConfig(port='COM3', axis=1, protocol='position', targetAngleDeg=5)
        for flag in (0x10, 0x20):
            for progress_type in (PositionProgress, ManualPositionProgress):
                with self.subTest(flag=flag, progress=progress_type):
                    initial = self.pair()[0]
                    progress = progress_type(initial, config)
                    pending = self.pair(flags=3 | flag)[0]
                    pending['limitFlags'] = 2
                    progress.check(pending, config)
                    self.assertFalse(position_reached(pending, config))
                    self.assertTrue(position_reached(initial, config))

    def test_regular_and_manual_progress_still_stop_on_real_alarm_and_limits(self):
        config = TurntableConfig(port='COM3', axis=1, protocol='position', targetAngleDeg=5)
        for progress_type in (PositionProgress, ManualPositionProgress):
            for change in (dict(alarm=6), dict(limit=1), dict(fault=8)):
                with self.subTest(progress=progress_type, change=change):
                    progress = progress_type(self.pair()[0], config)
                    with self.assertRaises(MotorError):
                        progress.check(self.pair(**change)[0], config)

    def test_pending_drive_limit_bit_is_transient_but_active_limit_and_bypass_are_not(self):
        with patch('blade_acquisition.turntable.joint_snapshots',
                   side_effect=[self.pair(limit=2), self.pair(), self.pair()]) as reads:
            wait_ready_snapshots(self.motor, timeout_s=.2)
            self.assertEqual(reads.call_count, 3)
        for limit in (1, 3, 4):
            with self.subTest(limit=limit), patch('blade_acquisition.turntable.joint_snapshots',
                    return_value=self.pair(limit=limit)) as reads:
                with self.assertRaisesRegex(MotorError, '限位'):
                    wait_ready_snapshots(self.motor)
                self.assertEqual(reads.call_count, 1)

    def test_real_fault_or_alarm_is_immediate_even_with_pending_bit(self):
        for change in (dict(fault=3), dict(fault=8), dict(alarm=6)):
            with self.subTest(change=change), patch('blade_acquisition.turntable.joint_snapshots',
                    return_value=self.pair(flags=0x13, **change)) as reads:
                with self.assertRaisesRegex(MotorError, '故障|报警'):
                    wait_ready_snapshots(self.motor)
                self.assertEqual(reads.call_count, 1)

    def test_permanent_pending_times_out_without_motion_or_reset(self):
        with patch('blade_acquisition.turntable.joint_snapshots', return_value=self.pair(flags=0x13)):
            with self.assertRaisesRegex(MotorError, '等待超时'):
                wait_ready_snapshots(self.motor, timeout_s=.05)
        self.assertEqual(self.motor.commands, [])
        self.assertEqual(self.motor.stops, [])

    def test_wait_cancellation_prevents_following_command(self):
        def read():
            self.cancel.set()
            return self.pair(flags=0x13)
        with patch('blade_acquisition.turntable.joint_snapshots', side_effect=lambda _: read()):
            with self.assertRaisesRegex(MotorError, '取消'):
                wait_ready_snapshots(self.motor, cancel=self.cancel)
        self.assertEqual(self.motor.commands, [])

    def sdk(self):
        motor = MotorController('TEST')
        motor._request = Mock()
        motor._speed = Mock(return_value=(0, 0))
        return motor

    def test_sdk_stop_ack_and_zero_rpm_do_not_override_pending_flags(self):
        for flag in (0x10, 0x20):
            motor = self.sdk()
            feedback = self.motor.get_feedback(1)
            motor.get_feedback = Mock(side_effect=[replace(feedback, flags=feedback.flags | flag),
                replace(feedback, flags=feedback.flags | flag), feedback, feedback])
            motor.stop(1, timeout=.2)
            self.assertEqual(motor._request.call_count, 1, 'send STOP only once')
            self.assertEqual(motor.get_feedback.call_count, 4)
            motor._speed.assert_not_called()

    def test_sdk_stop_pending_timeout_never_claims_success(self):
        motor = self.sdk()
        motor.get_feedback = Mock(return_value=replace(self.motor.get_feedback(1), flags=0x13))
        with self.assertRaisesRegex(MotorError, '停止确认超时'):
            motor.stop(1, timeout=.05)
        self.assertEqual(motor._request.call_count, 1)

    def test_stopping_preserves_latched_fault_for_motion_preflight(self):
        motor = self.sdk()
        motor.get_feedback = Mock(return_value=replace(self.motor.get_feedback(1), fault=8))
        motor.stop(1, timeout=.2)
        self.assertEqual(motor.get_feedback.return_value.fault, 8)
        self.assertEqual(motor._request.call_count, 1)
