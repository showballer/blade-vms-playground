"""Handoff priority, bounded snapshot reuse and direct alarm evidence; no field I/O."""
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import struct
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import PointCycleConfig, joint_snapshots
from blade_acquisition.turntable_driver.motor_controller import MotorController
from test_dual_axis_integration import BufferedMotor
from test_drive_position_test import PositionMotor
from test_service import POINT_REFERENCE, TOKEN
from test_station_session import PacketSdk, receiver_for


class HandoffLatencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.motor = BufferedMotor()
        self.motor.drive_internal_position = True
        self.controller = create_app(Settings(TOKEN, 8765, Path(self.temp.name))).state.controller
        self.cycle = PointCycleConfig(port="COM6", points=[
            {**POINT_REFERENCE, "name": "next", "axis1AngleDeg": 14, "axis2AngleDeg": -9}])

    def test_departure_interrupts_telemetry_before_remaining_axis_queries(self):
        original = self.motor.get_feedback
        def after_first_feedback(axis):
            result = original(axis)
            self.controller.rssi_event.set()
            return result
        with patch.object(self.motor, "get_feedback", side_effect=after_first_feedback), \
             patch.object(self.motor, "get_guard_config", wraps=self.motor.get_guard_config) as guards, \
             patch.object(self.motor, "get_status", wraps=self.motor.get_status) as statuses:
            result = self.controller._cycle_hold_observations(self.motor, self.cycle, self.cycle.points[0])
        self.assertIsNone(result, "An interrupted partial pair must never become preflight evidence")
        # FakeMotor.get_feedback itself consults its in-memory guard once.
        # No independent guard transaction or axis-2 observation may follow.
        self.assertEqual([c.args[0] for c in guards.call_args_list], [1])
        self.assertEqual([c.args[0] for c in statuses.call_args_list], [1])

    def test_already_triggered_departure_does_not_start_a_telemetry_transaction(self):
        self.controller.rssi_event.set()
        with patch.object(self.motor, "get_status") as read:
            self.assertIsNone(joint_snapshots(self.motor, interrupted=self.controller.rssi_event.is_set))
        read.assert_not_called()

    def test_fresh_complete_pair_reused_without_second_full_preflight(self):
        pair = joint_snapshots(self.motor)
        with patch("blade_acquisition.service.joint_snapshots", wraps=joint_snapshots) as read, \
             patch.object(self.controller, "_execute_drive_position", return_value=(True, [1, 2], pair[0])) as execute:
            self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0], initial_snapshots=pair)
        read.assert_not_called()
        self.assertIs(execute.call_args.kwargs["initial_snapshots"], pair)

    def test_expired_pair_is_refreshed_and_new_axis_two_alarm_blocks_motion(self):
        pair = joint_snapshots(self.motor)
        for item in pair:
            item["queryStartedAt"] -= 1
        status = self.motor.get_status
        with patch.object(self.motor, "get_status", side_effect=lambda axis: replace(status(axis), alarm_code=9 if axis == 2 else 0)), \
             patch.object(self.controller, "_execute_drive_position") as execute:
            with self.assertRaisesRegex(RuntimeError, "报警"):
                self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0], initial_snapshots=pair)
        execute.assert_not_called()

    def test_buffered_legacy_path_does_not_reuse_a_native_handoff_pair(self):
        pair = joint_snapshots(self.motor)
        self.motor.drive_internal_position = False
        with patch("blade_acquisition.service.joint_snapshots", wraps=joint_snapshots) as read, \
             patch.object(self.controller, "_execute_dual_axis_move", return_value=(True, [1, 2], pair[0])):
            self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0], initial_snapshots=pair)
        read.assert_called_once_with(self.motor)

    def test_fresh_pair_still_rejects_changed_reference(self):
        pair = joint_snapshots(self.motor)
        pair[0]["axes"]["2"]["origin_counts"] += 1
        with patch.object(self.controller, "_execute_drive_position") as execute:
            with self.assertRaisesRegex(RuntimeError, "参考位"):
                self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0], initial_snapshots=pair)
        execute.assert_not_called()

    def test_fresh_direct_alarm_replaces_only_redundant_alarm_read(self):
        motor = MotorController("COM6")
        p = PositionMotor().get_axis_positions()[0]
        motor._request = Mock(return_value=SimpleNamespace(data=struct.pack(">hHB", 0, 0, 4)))
        motor.read_alarm = Mock(side_effect=AssertionError("duplicate alarm read"))
        result = motor.get_status_from_position(1, replace(p, alarm_code=17), time.monotonic_ns())
        self.assertEqual(result.alarm_code, 17, "A nonzero direct alarm cannot be hidden")
        self.assertEqual(result.limit_flags, 4, "The independently read bypass/limit flags remain authoritative")
        self.assertEqual(motor._request.call_args.args[0][4], 0x07)

    def test_departure_after_speed_reply_preempts_alarm_request_without_faulting_transport(self):
        motor = MotorController("COM6")
        interrupted = False
        def speed_reply(_):
            nonlocal interrupted
            interrupted = True
            return SimpleNamespace(data=struct.pack(">hH", 0, 0))
        motor._request = Mock(side_effect=speed_reply)
        motor.read_alarm = Mock(side_effect=AssertionError("Departure must preempt the next query"))
        self.assertIsNone(motor.get_status_interruptible(1, lambda: interrupted))
        motor._request.assert_called_once()
        self.assertFalse(motor._faulted)

    def test_cached_stale_or_moving_observation_cannot_replace_alarm_read(self):
        motor = MotorController("COM6")
        p = PositionMotor().get_axis_positions()[0]
        for observation, stamp in ((replace(p, source=1), time.monotonic_ns()),
                                   (replace(p, motor_rpm=1), time.monotonic_ns()),
                                   (replace(p, sample_age_ms=-1), time.monotonic_ns()),
                                   (replace(p, sample_age_ms=251), time.monotonic_ns()),
                                   (p, time.monotonic_ns() - 1_000_000_000)):
            with self.subTest(observation=observation), patch.object(motor, "get_status", return_value="full") as full:
                self.assertEqual(motor.get_status_from_position(1, observation, stamp), "full")
                full.assert_called_once_with(1)

    def test_continuous_laser_reads_real_state_without_repeated_on_writes_on_mac_and_windows(self):
        for library in ("DeviceCommunication.dll", "libDeviceCommunication.dylib"):
            with self.subTest(library=library):
                sdk = PacketSdk()
                receiver = receiver_for(sdk, library)
                receiver.prepare_session()
                receiver.confirm_session_laser(True)
                commands = list(sdk.laser_commands)
                receiver.confirm_session_laser(True)
                self.assertEqual(sdk.laser_commands, commands)
                sdk.laser_commands.append(0)  # Another operator really turned it off.
                receiver.confirm_session_laser(True)
                self.assertEqual(sdk.laser_commands[-2:], [0, 1])
                receiver.close_session(keep_laser_on=True)


if __name__ == "__main__":
    unittest.main()
