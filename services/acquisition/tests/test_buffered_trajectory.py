"""Protocol and cancellation tests; all transport is in-memory, no physical I/O."""
import struct
import threading
import unittest
from unittest.mock import patch

from blade_acquisition.turntable_driver import MotorController, MotorError, CommunicationError, TrajectoryPoint
from blade_acquisition.turntable_driver.protocol import (
    HEADER, append_crc, verify_crc, build_trajectory_begin, build_trajectory_point,
    CMD_TRAJECTORY_BEGIN as BEGIN, CMD_TRAJECTORY_POINT as POINT,
    CMD_TRAJECTORY_SEAL as SEAL, CMD_TRAJECTORY_START as START,
    CMD_TRAJECTORY_STATUS as STATUS, CMD_TRAJECTORY_STOP as STOP,
    CMD_TRAJECTORY_KEEPALIVE as RENEW,
)
from blade_acquisition.turntable_driver.trajectory import decode_status


class SerialFixture:
    def __init__(self):
        self.buffer = bytearray()
        self.frames = []
        self.state, self.session, self.count, self.loaded, self.fault = 0, 0, 0, 0, 0
        self.points = []
        self.angles = {1: 10.0, 2: 0.0}
        self.flags = {1: 3, 2: 3}
        self.origins = {1: 101, 2: 202}
        self.rpm = {1: 0, 2: 0}
        self.reject = {}
        self.drop = None
        self.on_write = None
        self.finish_on_renew = False
        self.bad_status = False

    @property
    def in_waiting(self):
        return len(self.buffer)

    def reset_input_buffer(self):
        self.buffer.clear()

    def read(self, count):
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def close(self):
        pass

    def write(self, frame):
        self.frames.append(frame)
        axis, command = frame[3:5]
        parameter = struct.unpack(">H", frame[5:7])[0]
        if command == BEGIN:
            self.session, self.state, self.loaded, self.points = parameter, 1, 0, []
            self.count = struct.unpack(">H", frame[7:9])[0]
        elif command == POINT:
            self.loaded += 1
            self.points.append(struct.unpack(">HIii", frame[7:-2]))
        elif command == SEAL:
            self.state = 2
        elif command == START:
            self.state = 3
        elif command == STOP:
            self.state, self.fault = 8, 1
            self.rpm = {1: 0, 2: 0}
        elif command == RENEW and self.finish_on_renew:
            self.state = 6
            self.angles = {1: self.points[-1][2] / 1000, 2: self.points[-1][3] / 1000}
        if self.on_write:
            self.on_write(command)
        if self.drop == command:
            return len(frame)
        status = self.reject.get(command, 0)
        if BEGIN <= command <= RENEW:
            data = struct.pack(">HBBHHIIIIiiii", self.session, self.state, self.fault,
                               self.count, self.loaded, 0, 2000, 250, 180,
                               round(self.angles[1] * 1000), round(self.angles[2] * 1000), 0, 0)
            if self.bad_status:
                data = data[:-1]
        elif command == 0x07:
            data = struct.pack(">hHB", self.rpm[axis], 0, 0)
        elif command == 0x09:
            data = b"\0\0"
        elif command == 0x20:
            data = struct.pack(">iiiHHHiHBBBBih", 0, 0, 0, 3, 10000, 17,
                               round(self.angles[axis] * 1000), self.flags[axis], 0, 0, 0, 0,
                               self.origins[axis], self.rpm[axis])
        elif command == 0x24:
            limit = 35000 if axis == 1 else 180000
            data = struct.pack(">BBBBbBBBiiB", 255, 255, 255, 1, 0, 0, 1, 1, -limit, limit, 0)
        else:
            data = b""
        payload = bytes((axis, command, status)) + struct.pack(">H", parameter) + data
        self.buffer.extend(append_crc(HEADER + bytes((len(payload) + 2,)) + payload))
        return len(frame)


class BufferedTrajectoryTests(unittest.TestCase):
    def setUp(self):
        self.serial = SerialFixture()
        self.motor = MotorController("TEST", timeout=0.02, serial_factory=lambda *_a, **_kw: self.serial).connect()
        self.sleep = patch("blade_acquisition.turntable_driver.motor_controller.time.sleep", return_value=None)
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
        self.addCleanup(lambda: self.motor.close(stop=False))
        self.points = (TrajectoryPoint(0, 10, 0), TrajectoryPoint(2, 10.2, 0.2))

    def commands(self):
        return [f[4] for f in self.serial.frames]

    def prepare(self, **kwargs):
        return self.motor.prepare_trajectory(self.points, session=17, **kwargs)

    def test_wire_format_crc_units_and_constraints(self):
        frame = build_trajectory_begin(17, 2)
        self.assertTrue(verify_crc(frame))
        self.assertEqual(struct.unpack(">HHiiii", frame[7:-2]), (2, 250, 3600, 3000, 750, 100))
        point = build_trajectory_point(17, 1, 500, 10.125, -0.5)
        self.assertEqual(struct.unpack(">HIii", point[7:-2]), (1, 500, 10125, -500))
        for kwargs in ({"cycle_ms": 20}, {"max_speed": True}, {"tolerance": 0.8}):
            with self.assertRaises(ValueError):
                build_trajectory_begin(17, 2, **kwargs)

    def test_invalid_input_is_rejected_before_any_io(self):
        for points in ((), (TrajectoryPoint(0, 36, 0), TrajectoryPoint(2, 0, 0)),
                       (TrajectoryPoint(0, 0, 0), TrajectoryPoint(0.1, 0, 0)),
                       (TrajectoryPoint(False, 0, 0), TrajectoryPoint(2, 0, 0))):
            with self.assertRaises(ValueError):
                self.motor.prepare_trajectory(points)
        with self.assertRaises(ValueError):
            self.motor.prepare_trajectory(self.points, max_speed=0.05)
        self.assertEqual(self.commands(), [])

    def test_probe_only_unknown_command_means_unsupported(self):
        self.serial.reject[STATUS] = 7
        self.assertIsNone(self.motor.probe_trajectory())
        self.assertEqual(self.commands(), [STATUS])
        self.serial.reject[STATUS] = 6
        with self.assertRaises(MotorError):
            self.motor.probe_trajectory()
        self.assertEqual(self.commands(), [STATUS, STATUS])

    def test_probe_timeout_remains_unknown(self):
        self.serial.drop = STATUS
        with self.assertRaises(CommunicationError):
            self.motor.probe_trajectory()
        self.assertEqual(self.commands(), [STATUS])

    def test_bad_status_is_uncertain_not_unsupported(self):
        self.serial.bad_status = True
        with self.assertRaises(CommunicationError):
            self.motor.probe_trajectory()
        self.assertTrue(self.motor._faulted)

    def test_prepare_uploads_without_motion_or_stopping_other_task(self):
        result = self.prepare()
        self.assertEqual((result.session, result.state, result.uploaded_count), (17, 2, 2))
        self.assertNotIn(START, self.commands())
        self.assertNotIn(0x06, self.commands())
        self.assertNotIn(STOP, self.commands())
        self.assertEqual(self.commands().count(POINT), 2)

    def test_active_task_is_not_overridden(self):
        self.serial.state, self.serial.session = 3, 91
        with self.assertRaises(MotorError):
            self.prepare()
        self.assertEqual(self.commands(), [STATUS])

    def test_invalid_reference_or_disabled_soft_guard_never_uploads(self):
        for flags in (0, 1, 3 | 16):
            self.serial.flags[2] = flags
            with self.assertRaises(MotorError):
                self.prepare()
        self.assertNotIn(BEGIN, self.commands())

    def test_start_rechecks_reference_and_cancels_buffer(self):
        self.prepare()
        self.serial.origins[2] += 1
        with self.assertRaisesRegex(MotorError, "参考位"):
            self.motor.start_trajectory(17)
        self.assertNotIn(START, self.commands())
        self.assertIn(STOP, self.commands())

    def test_start_requires_first_pose_and_never_autopositions(self):
        self.prepare()
        self.serial.angles[1] += 0.2
        with self.assertRaises(MotorError):
            self.motor.start_trajectory(17)
        self.assertNotIn(START, self.commands())
        self.assertNotIn(0x14, self.commands())

    def test_cancel_during_upload_cannot_late_start(self):
        cancel = threading.Event()
        self.serial.on_write = lambda cmd: cancel.set() if cmd == POINT else None
        with self.assertRaisesRegex(MotorError, "取消"):
            self.prepare(cancel=cancel)
        self.assertNotIn(SEAL, self.commands())
        self.assertIn(STOP, self.commands())
        with self.assertRaises(MotorError):
            self.motor.start_trajectory(17)
        self.assertNotIn(START, self.commands())

    def test_cancel_in_seal_reply_cannot_late_start(self):
        cancel = threading.Event()
        self.serial.on_write = lambda cmd: cancel.set() if cmd == SEAL else None
        with self.assertRaises(MotorError):
            self.prepare(cancel=cancel)
        with self.assertRaises(MotorError):
            self.motor.start_trajectory(17)
        self.assertNotIn(START, self.commands())
        self.assertIn(STOP, self.commands())

    def test_wrong_upload_session_cancels_without_retry(self):
        def mismatch(command):
            if command == POINT:
                self.serial.session += 1
        self.serial.on_write = mismatch
        with self.assertRaisesRegex(MotorError, "上传应答"):
            self.prepare()
        self.assertEqual(self.commands().count(POINT), 1)
        self.assertNotIn(SEAL, self.commands())
        self.assertNotIn(START, self.commands())
        self.assertIn(STOP, self.commands())

    def test_close_after_uncertain_start_sends_group_stop(self):
        self.prepare()
        self.serial.drop = START
        with self.assertRaises(CommunicationError):
            self.motor.start_trajectory(17)
        previous = len(self.commands())
        with self.assertRaises(CommunicationError):
            self.motor.close()
        self.assertEqual(self.commands()[previous], STOP)

    def test_cancel_after_start_reply_stops_both_without_retry(self):
        self.prepare()
        cancel = threading.Event()
        self.serial.on_write = lambda cmd: cancel.set() if cmd == START else None
        with self.assertRaises(MotorError):
            self.motor.start_trajectory(17, cancel=cancel)
        self.assertEqual(self.commands().count(START), 1)
        self.assertIn(STOP, self.commands())

    def test_lost_start_reply_stops_best_effort_no_replay(self):
        self.prepare()
        self.serial.drop = START
        with self.assertRaises(CommunicationError):
            self.motor.start_trajectory(17)
        self.assertEqual(self.commands().count(START), 1)
        self.assertIn(STOP, self.commands())
        self.assertEqual(self.commands()[-2:], [0x06, 0x06])
        self.assertTrue(self.motor._faulted)

    def test_single_axis_stop_owns_entire_prepared_group(self):
        self.prepare()
        self.motor.stop(2)
        self.assertIn(STOP, self.commands())
        self.assertIsNone(self.motor._trajectory_session)
        with self.assertRaises(MotorError):
            self.motor.start_trajectory(17)
        self.assertNotIn(START, self.commands())

    def test_wait_renews_and_returns_only_verified_done(self):
        self.prepare()
        self.motor.start_trajectory(17)
        self.serial.finish_on_renew = True
        statuses = []
        result = self.motor.wait_trajectory(17, on_status=statuses.append)
        self.assertEqual(result.state, 6)
        self.assertIn(RENEW, self.commands())
        self.assertEqual(len(statuses), 1)
        self.assertIsNone(self.motor._trajectory_session)
        with self.assertRaises(MotorError):
            self.motor.renew_trajectory(17)
        with self.assertRaises(MotorError):
            self.motor.start_trajectory(17)

    def test_cancelled_firmware_is_not_completion(self):
        self.prepare()
        self.motor.start_trajectory(17)
        self.serial.state = 8
        with self.assertRaises(MotorError):
            self.motor.wait_trajectory(17)
        self.assertIn(STOP, self.commands())

    def test_completion_racing_heartbeat_is_resolved_by_status_not_replay(self):
        self.prepare()
        self.motor.start_trajectory(17)
        self.serial.finish_on_renew = True
        self.serial.reject[RENEW] = 6
        result = self.motor.wait_trajectory(17)
        self.assertEqual(result.state, 6)
        self.assertEqual(self.commands().count(RENEW), 1)
        self.assertEqual(self.commands().count(START), 1)

    def test_busy_heartbeat_while_still_running_is_a_failure(self):
        self.prepare()
        self.motor.start_trajectory(17)
        self.serial.reject[RENEW] = 6
        with self.assertRaises(MotorError):
            self.motor.wait_trajectory(17)
        self.assertEqual(self.commands().count(RENEW), 1)
        self.assertIn(STOP, self.commands())

    def test_stop_pending_is_not_confirmed_zero_speed(self):
        self.prepare()
        self.serial.flags[2] |= 16
        with self.assertRaisesRegex(MotorError, "停止确认超时"):
            self.motor.stop_trajectory(timeout=0.01)
        self.assertEqual(self.motor._trajectory_session, 17)
        self.assertIsNone(self.motor._trajectory_prepared)

    def test_cancel_during_wait_stops_group_and_does_not_renew(self):
        self.prepare()
        self.motor.start_trajectory(17)
        cancel = threading.Event()
        cancel.set()
        with self.assertRaisesRegex(MotorError, "取消"):
            self.motor.wait_trajectory(17, cancel=cancel)
        self.assertIn(STOP, self.commands())
        self.assertNotIn(RENEW, self.commands())

    def test_done_with_wrong_endpoint_does_not_claim_completion(self):
        self.prepare()
        self.motor.start_trajectory(17)
        self.serial.state = 6
        with self.assertRaisesRegex(MotorError, "未到"):
            self.motor.wait_trajectory(17)
        self.assertIn(STOP, self.commands())

    def test_wait_timeout_stops_group(self):
        self.prepare()
        self.motor.start_trajectory(17)
        with self.assertRaisesRegex(MotorError, "等待超时"):
            self.motor.wait_trajectory(17, timeout=0.01)
        self.assertIn(STOP, self.commands())

    def test_failure_after_upload_begins_never_falls_back_to_legacy(self):
        self.serial.reject[POINT] = 7
        with self.assertRaises(MotorError):
            self.prepare()
        self.assertIn(BEGIN, self.commands())
        self.assertIn(STOP, self.commands())
        self.assertNotIn(0x14, self.commands())
        self.assertNotIn(START, self.commands())

    def test_done_requires_actual_zero_speed(self):
        self.prepare()
        self.motor.start_trajectory(17)
        self.serial.finish_on_renew = True
        self.serial.rpm[2] = 1
        with self.assertRaisesRegex(MotorError, "未停稳"):
            self.motor.wait_trajectory(17)
        self.assertIn(STOP, self.commands())

    def test_legacy_velocity_cannot_mix_with_prepared_trajectory(self):
        self.prepare()
        with self.assertRaises(MotorError):
            self.motor.start_continuous(1, 0.2)
        self.assertNotIn(0x10, self.commands())

    def test_status_rejects_invalid_fields(self):
        raw = struct.pack(">HBBHHIIIIiiii", 17, 9, 0, 2, 2, 0, 2000, 0, 0, 0, 0, 0, 0)
        with self.assertRaises(ValueError):
            decode_status(raw)


if __name__ == "__main__":
    unittest.main()
