"""Vendor 0x37 wire observations only; no physical serial port is opened."""
import struct
import unittest

from blade_acquisition.turntable_driver import MotorController, CommunicationError
from blade_acquisition.turntable_driver.motor_controller import CommandRejected
from blade_acquisition.turntable_driver.protocol import CMD_READ_AXES, HEADER, append_crc
from blade_acquisition.turntable_driver.trajectory import decode_axes


def axes_payload(*, age=25, flags=3, source=1, alarm=0, fault=0):
    return (struct.pack(">iihHIHBB", 12501, 123456, 50, flags, age, alarm, fault, source) +
            struct.pack(">iihHIHBB", -16804, -23338, -25, 1, 12, 0, 0, 1))


class AxesSerial:
    def __init__(self):
        self.buffer = bytearray()
        self.frames = []
        self.status = 0
        self.payload = axes_payload()

    @property
    def in_waiting(self):
        return len(self.buffer)

    def reset_input_buffer(self):
        self.buffer.clear()

    def read(self, count):
        data = bytes(self.buffer[:count])
        del self.buffer[:count]
        return data

    def write(self, frame):
        self.frames.append(frame)
        body = bytes((frame[3], frame[4], self.status)) + frame[5:7] + self.payload
        self.buffer.extend(append_crc(HEADER + bytes((len(body) + 2,)) + body))
        return len(frame)

    def close(self):
        pass


class AxisPositionsTests(unittest.TestCase):
    def setUp(self):
        self.serial = AxesSerial()
        self.motor = MotorController("TEST", timeout=.02, serial_factory=lambda *_a, **_kw: self.serial).connect()
        self.addCleanup(lambda: self.motor.close(stop=False))

    def test_vendor_two_axis_wire_layout_and_individual_age(self):
        one, two = self.motor.get_axis_positions()
        self.assertEqual((one.angle_deg, one.actual_counts, one.motor_rpm, one.sample_age_ms),
                         (12.501, 123456, 50, 25))
        self.assertEqual((two.angle_deg, two.actual_counts, two.motor_rpm, two.sample_age_ms),
                         (-16.804, -23338, -25, 12))
        self.assertTrue(one.usable)
        self.assertTrue(two.usable)
        self.assertEqual([frame[4] for frame in self.serial.frames], [CMD_READ_AXES])

    def test_unknown_command_only_allows_legacy_fallback(self):
        self.serial.status = 7
        self.assertIsNone(self.motor.probe_axis_positions())
        self.assertEqual(len(self.serial.frames), 1)
        self.serial.status = 6
        with self.assertRaises(CommandRejected):
            self.motor.probe_axis_positions()
        self.assertEqual(len(self.serial.frames), 2)

    def test_corrupt_feedback_is_not_legacy_or_retried(self):
        self.serial.payload = axes_payload()[:-1]
        with self.assertRaises(CommunicationError):
            self.motor.probe_axis_positions()
        self.assertEqual(len(self.serial.frames), 1)
        with self.assertRaises(CommunicationError):
            self.motor.get_axis_positions()
        self.assertEqual(len(self.serial.frames), 1)

    def test_read_is_allowed_with_prepared_trajectory_without_motion_writes(self):
        self.motor._trajectory_session = 123
        self.assertIsNotNone(self.motor.probe_axis_positions())
        self.assertEqual([frame[4] for frame in self.serial.frames], [CMD_READ_AXES])
        self.motor._trajectory_session = None

    def test_age_validity_source_and_wire_corruption(self):
        self.assertTrue(decode_axes(axes_payload(age=1000))[0].usable)
        self.assertFalse(decode_axes(axes_payload(age=1001))[0].usable)
        self.assertIsNone(decode_axes(axes_payload(flags=2))[0].angle_deg)
        self.assertIsNone(decode_axes(axes_payload(source=2))[0].angle_deg)
        self.assertEqual(decode_axes(axes_payload(source=2))[0].actual_counts, 123456)
        with self.assertRaises(ValueError):
            decode_axes(axes_payload(source=3))
        for data in (axes_payload()[:-1], axes_payload() + b"\x00"):
            with self.assertRaises(ValueError):
                decode_axes(data)

    def test_alarm_and_guard_fault_remain_visible_to_motion_guard(self):
        one, _ = decode_axes(axes_payload(alarm=42, fault=2))
        self.assertEqual(one.alarm_code, 42)
        self.assertEqual(one.guard_fault, 2)


if __name__ == "__main__":
    unittest.main()
