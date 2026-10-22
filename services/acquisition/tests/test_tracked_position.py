"""Real SDK wire contract for LightCheck(1) targets; no hardware or network I/O."""
import struct
import threading
import unittest
from unittest.mock import patch, Mock

from blade_acquisition.turntable_driver import MotorController, MotorError
from blade_acquisition.turntable_driver.motor_controller import CommandRejected, CommunicationError
from blade_acquisition.turntable_driver.protocol import (
    CMD_MOVE_OUTPUT_RELATIVE, CMD_MOVE_OUTPUT_TRACKED, CMD_STOP, POINT_TRACK_KEY,
    CMD_SET_ZERO, CMD_SET_REFERENCE, append_crc, verify_crc, build_move_output_tracked,
)
from blade_acquisition.turntable_driver.faults import get_fault_advice
from test_vendor_v35 import RecoverySerial


class TargetSerial(RecoverySerial):
    def __init__(self):
        super().__init__()
        self.guard_fault = {1: 0, 2: 0}
        self.bad_ack = False

    def write(self, frame):
        written = super().write(frame)
        if frame[4] == 0x37 and self.drop != frame[4]:
            data = b''.join(struct.pack('>iihHIHBB', round(self.angles[axis]*1000), 0,
                    self.rpm[axis], self.flags[axis], 1, self.alarm[axis], self.guard_fault[axis], 0)
                    for axis in (1,2))
            payload = frame[3:5] + bytes((self.reject.get(frame[4],0),)) + frame[5:7] + data
            self.buffer = bytearray(append_crc(b'\xaa\x55' + bytes((len(payload)+2,)) + payload))
        if frame[4] == CMD_MOVE_OUTPUT_TRACKED and self.drop != frame[4]:
            angle = struct.unpack(">i", frame[9:13])[0] + int(self.bad_ack)
            payload = (frame[3:5] + bytes((self.reject.get(frame[4], 0),)) +
                       frame[5:7] + struct.pack(">i", angle))
            self.buffer = bytearray(append_crc(b"\xaa\x55" + bytes((len(payload) + 2,)) + payload))
        return written


class TrackedPositionTests(unittest.TestCase):
    def test_cached_feedback_reads_real_pa95_instead_of_treating_sentinel_as_unit_change(self):
        from blade_acquisition.turntable_driver.protocol import Response
        for actual_bits in (21, 22, 65535):
            motor = MotorController('TEST')
            payload = struct.pack('>iiiHHHiHBBBBih', 50,0,0,3,10000,65535,10000,7,63,0,0,0,0,25)
            motor._request = Mock(side_effect=[Response(1,0x20,0,0,payload,b''),
                Response(1,0x02,0,95,struct.pack('>H',actual_bits),b'')])
            if actual_bits == 65535:
                with self.assertRaisesRegex(MotorError, '真实编码器位数 PA95 无效'):
                    motor.get_feedback(1)
            else:
                self.assertEqual(motor.get_feedback(1).encoder_bits, actual_bits)
            frames=[call.args[0] for call in motor._request.call_args_list]
            self.assertEqual([f[4] for f in frames], [0x20,0x02])
            self.assertEqual(frames[1][5:7], b'\0\x5f')

    def setUp(self):
        self.serial = TargetSerial()
        self.motor = MotorController("TEST", timeout=.02, serial_factory=lambda *a, **kw: self.serial).connect()
        self.addCleanup(lambda: self.motor.close(stop=False))
        sleep = patch("blade_acquisition.turntable_driver.motor_controller.time.sleep", return_value=None)
        sleep.start()
        self.addCleanup(sleep.stop)

    def commands(self):
        return [frame[4] for frame in self.serial.frames]

    def test_read_timeout_identifies_request_without_claiming_unknown_motion(self):
        self.serial.drop = 0x20
        with self.assertRaises(CommunicationError) as caught:
            self.motor.get_feedback(2)
        message = str(caught.exception)
        self.assertIn('轴2', message)
        self.assertIn('0x20', message)
        self.assertIn('本次读数不可用', message)
        self.assertNotIn('执行结果未知', message)
        self.assertEqual(self.commands(), [0x20])
        self.assertTrue(self.motor._faulted, 'A late reply still requires a new connection')

    def test_frame_keeps_physical_angle_sign_and_requires_new_key(self):
        for axis in (1, 2):
            for angle in (2, -.2, 10, -10):
                frame = build_move_output_tracked(axis, .6, angle)
                self.assertTrue(verify_crc(frame))
                self.assertEqual(frame[:5], b"\xaa\x55\x0c" + bytes((axis, 0x19)))
                self.assertEqual(struct.unpack(">HHi", frame[5:13]), (POINT_TRACK_KEY, 60, round(angle * 1000)))

    def test_coordinate_recall_and_prechecked_capture_use_tracked_not_legacy(self):
        # Actual pitch encoder sign belongs to the firmware. The SDK sends the
        # signed physical difference from its freshly read output angle.
        for target, expected in ((12, 2000), (9.8, -200)):
            self.serial.frames.clear()
            accepted = self.motor.move_to_angle_prechecked(1, target, speed_rpm=.1)
            self.assertAlmostEqual(accepted.output_angle_deg, expected / 1000)
            frames = [f for f in self.serial.frames if f[4] == CMD_MOVE_OUTPUT_TRACKED]
            self.assertEqual(len(frames), 1)
            self.assertEqual(struct.unpack(">i", frames[0][9:13])[0], expected)
            self.assertNotIn(CMD_MOVE_OUTPUT_RELATIVE, self.commands())
            self.assertNotIn(CMD_SET_ZERO, self.commands())
            self.assertNotIn(CMD_SET_REFERENCE, self.commands())

    def test_joint_capture_verifies_reference_before_sending_one_tracked_target(self):
        accepted = self.motor.move_to_angle_verified(
            2, -2, speed_rpm=5, cancel=threading.Event(),
            reference=[202, 3, 10000, 17], start_angle=0)
        self.assertEqual(accepted.output_angle_deg, -2)
        self.assertEqual(self.commands().count(CMD_MOVE_OUTPUT_TRACKED), 1)
        self.assertNotIn(CMD_STOP, self.commands())
        self.assertNotIn(CMD_MOVE_OUTPUT_RELATIVE, self.commands())

    def test_manual_recall_does_not_duplicate_stop_handshakes(self):
        self.motor.move_to_angle(1, 12, speed_rpm=.1)
        self.assertEqual(self.commands().count(CMD_STOP), 1)
        self.assertEqual(self.commands().count(CMD_MOVE_OUTPUT_TRACKED), 1)

    def grouped(self, **extra):
        args = dict(targets=(12, -2), speed_rpm=5, cancel=threading.Event(),
                    references=[[101, 3, 10000, 17], [202, 3, 10000, 17]], start_angles=(10, 0))
        args.update(extra)
        return self.motor.move_axes_to_angles_verified(**args)

    def test_joint_targets_reuse_one_fresh_joint_alarm_read_and_keep_axis_checks(self):
        self.grouped()
        # Each reference is read immediately before its target. No duplicate
        # per-axis alarm/STOP queries occur between the two protected writes.
        self.assertEqual(self.commands(), [0x37, 0x20, 0x19, 0x20, 0x19])

    def test_stationary_axis_inside_arrival_tolerance_does_not_block_other_axis(self):
        for drift in (-.5, -.1, -.04, 0, .04, .1, .5):
            with self.subTest(drift=drift):
                self.serial.frames.clear()
                observed = []
                accepted = self.grouped(targets=(12, drift),
                                        observe=lambda phase, **info: observed.append((phase, info)))
                self.assertEqual(self.commands(), [0x37, 0x20, 0x19])
                self.assertEqual(accepted[1].output_angle_deg, 0)
                self.assertTrue(any(phase == 'axis_already_at_target' and info['axis'] == 2
                                    for phase, info in observed))

    def test_axis_outside_arrival_tolerance_still_receives_target(self):
        self.grouped(targets=(12, .501))
        self.assertEqual(self.commands(), [0x37, 0x20, 0x19, 0x20, 0x19])

    def test_repeated_joint_position_at_same_point_never_sends_relative_motion(self):
        for _ in range(2):
            self.serial.frames.clear()
            accepted = self.grouped(targets=(10.5, -.5))
            self.assertEqual(self.commands(), [0x37])
            self.assertEqual([a.output_angle_deg for a in accepted], [0, 0])

    def test_joint_alarm_or_reference_failure_never_starts_a_target(self):
        from blade_acquisition.turntable_driver.trajectory import AxisPosition
        with patch.object(self.motor, 'get_axis_positions', return_value=(
                AxisPosition(10,0,0,3,1,0,0,0), AxisPosition(0,0,0,1,1,9,0,0))):
            with self.assertRaisesRegex(MotorError, '报警'):
                self.grouped()
        self.assertNotIn(CMD_MOVE_OUTPUT_TRACKED, self.commands())

    def test_joint_second_axis_reference_change_prevents_its_motion(self):
        def observed(phase, **info):
            if phase == 'command_accepted' and info['axis'] == 1:
                self.serial.origins[2] += 100
        with self.assertRaisesRegex(MotorError, '轴2下发前参考'):
            self.grouped(observe=observed)
        self.assertEqual(self.commands().count(CMD_MOVE_OUTPUT_TRACKED), 1)

    def test_joint_cancel_and_ambiguous_reply_never_replay_targets(self):
        cancel = threading.Event()
        def observed(phase, **info):
            if phase == 'command_accepted':
                cancel.set()
        self.assertIsNone(self.grouped(cancel=cancel, observe=observed))
        self.assertEqual(self.commands().count(CMD_MOVE_OUTPUT_TRACKED), 1)
        self.serial.frames.clear()
        self.serial.bad_ack = True
        with self.assertRaises(CommunicationError):
            self.grouped()
        self.assertEqual(self.commands().count(CMD_MOVE_OUTPUT_TRACKED), 1)

    def test_new_firmware_required_without_falling_back_or_replaying(self):
        self.serial.reject[CMD_MOVE_OUTPUT_TRACKED] = 7
        with self.assertRaisesRegex(CommandRejected, "LightCheck.*未退回旧定位"):
            self.motor.move_relative(1, 2, stop_before=False)
        self.assertEqual(self.commands().count(CMD_MOVE_OUTPUT_TRACKED), 1)
        self.assertNotIn(CMD_MOVE_OUTPUT_RELATIVE, self.commands())

    def test_ack_loss_or_mismatch_never_replays_a_motion(self):
        for drop in (False, True):
            with self.subTest(drop=drop):
                self.serial.frames.clear()
                self.motor._faulted = False
                self.serial.bad_ack = not drop
                self.serial.drop = CMD_MOVE_OUTPUT_TRACKED if drop else None
                with self.assertRaises(CommunicationError):
                    self.motor.move_relative(1, -.2, stop_before=False)
                self.assertEqual(self.commands().count(CMD_MOVE_OUTPUT_TRACKED), 1)
                with self.assertRaises(CommunicationError):
                    self.motor.move_relative(1, -.2, stop_before=False)
                self.assertEqual(self.commands().count(CMD_MOVE_OUTPUT_TRACKED), 1)

    def test_cancellation_and_drive_alarm_prevent_target(self):
        cancel = threading.Event()
        cancel.set()
        self.assertIsNone(self.motor.move_relative(1, 2, cancel=cancel, stop_before=False))
        self.assertNotIn(CMD_MOVE_OUTPUT_TRACKED, self.commands())
        self.serial.alarm[1] = 16
        with self.assertRaises(MotorError):
            self.motor.move_relative(1, 2, stop_before=False)
        self.assertNotIn(CMD_MOVE_OUTPUT_TRACKED, self.commands())

    def test_execution_latch_has_preserve_reference_recovery_advice(self):
        advice = get_fault_advice("guard", 8, motor_id=1)
        self.assertEqual(advice.title, "定位执行异常")
        self.assertIn("clear_guard_fault", advice.apis)
        self.assertNotIn("set_current_angle", advice.apis)


if __name__ == "__main__":
    unittest.main()
