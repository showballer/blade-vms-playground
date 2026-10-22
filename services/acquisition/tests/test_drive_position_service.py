"""Diagnostic point-cycle routing/cleanup with fake serial owners only."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from dataclasses import replace

from fastapi import HTTPException

from blade_acquisition.drive_position import DrivePositionError
from blade_acquisition.service import Settings, StartRequest, create_app
from blade_acquisition.turntable import PointCycleConfig, TurntableRequest, snapshot, station_timing_plan
from laser_fixture import FakeLaserPanel
from test_automatic_stations import PassReceiver, automatic_config
from test_dual_axis_integration import BufferedMotor
from test_service import POINT_REFERENCE, START, TOKEN


class DrivePositionServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.motor = BufferedMotor()
        self.factory = Mock(return_value=self.motor)
        self.controller = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), PassReceiver,
                                     self.factory).state.controller
        self.cycle = PointCycleConfig(port="COM6", diagnosticDrivePosition=True, points=[
            {**POINT_REFERENCE, "name": "P4", "axis1AngleDeg": 5, "axis2AngleDeg": -9}])
        self.start = StartRequest(**START, confirmMotion=True, pointCycle=automatic_config(
            diagnosticDrivePosition=True))

    def success(self, motor, **kwargs):
        pending = json.loads(self.controller.motion_guard.path.read_text())
        self.assertEqual(pending["pendingAxes"], [1, 2])
        self.assertEqual(pending["motionMode"], "drive_internal")
        kwargs["observe"]({"phase": "command_sending", "axis": 1})
        kwargs["observe"]({"phase": "command_sending", "axis": 2})
        motor.angles.update(dict(zip((1, 2), kwargs["targets"])))
        return {"feedback": snapshot(motor, 1), "stopConfirmed": True,
                "state": "complete", "mode": "drive_internal", "motionCommanded": True}

    def test_cycle_api_gate_rejects_without_constructing_hardware_owner(self):
        with patch.dict("os.environ", {"BLADE_TURNTABLE_DRIVE_POSITION_TEST": ""}):
            with self.assertRaises(HTTPException) as caught:
                self.controller.start(self.start)
        self.assertEqual(caught.exception.status_code, 422)
        self.factory.assert_not_called()
        self.assertFalse(self.controller.motion_guard.path.exists())

    def test_default_cycle_keeps_buffered_route_even_when_environment_enabled(self):
        cycle = self.cycle.model_copy(update={"diagnosticDrivePosition": False})
        with patch.dict("os.environ", {"BLADE_TURNTABLE_DRIVE_POSITION_TEST": "1"}), \
             patch("blade_acquisition.drive_position.execute_drive_position") as native:
            reached, completed, _ = self.controller._cycle_move_point(self.motor, cycle, cycle.points[0])
        native.assert_not_called()
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        self.assertIn("start", self.motor.calls)

    def test_normal_cycle_uses_native_without_diagnostic_flag_or_environment(self):
        self.motor.drive_internal_position = True
        cycle = self.cycle.model_copy(update={"diagnosticDrivePosition": False})
        with patch.dict("os.environ", {"BLADE_TURNTABLE_DRIVE_POSITION_TEST": ""}), \
             patch("blade_acquisition.drive_position.execute_drive_position", side_effect=self.success) as native:
            reached, completed, _ = self.controller._cycle_move_point(self.motor, cycle, cycle.points[0])
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        native.assert_called_once()
        self.assertIsNotNone(native.call_args.kwargs["initial_snapshots"])
        self.assertNotIn("start", self.motor.calls)

    def test_native_uses_configured_ceiling_and_only_claims_a_lower_bound(self):
        cycle = PointCycleConfig(**automatic_config(speedRpm=4.1, maxMoveRpm=5,
            nominalPeriodSeconds=5))
        point = cycle.points[1]
        speed, timing = station_timing_plan(cycle, (5, 0), point, "drive_internal", cycle.points[0])
        self.assertEqual(speed, 5)
        self.assertTrue(timing["estimateIsLowerBound"])
        self.assertEqual(timing["nominalIntervalSeconds"], 1.25)
        self.assertNotIn("mayMissNextPass", timing)

    def test_native_cycle_has_single_handoff_callback_and_no_buffered_start_or_stop(self):
        callback = Mock()
        with patch("blade_acquisition.drive_position.execute_drive_position", side_effect=self.success):
            reached, completed, _ = self.controller._cycle_move_point(
                self.motor, self.cycle, self.cycle.points[0], callback)
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        callback.assert_called_once()
        self.assertIsNone(self.controller.motion_guard.warning)
        self.assertNotIn("start", self.motor.calls)
        self.assertNotIn("group_stop", self.motor.calls)
        self.assertEqual(self.motor.stopped_axes, [])

    def test_prepositioned_point_reads_both_drives_but_never_sends_motion(self):
        self.motor.angles.update({1: 5, 2: -9})
        callback = Mock()
        with patch("blade_acquisition.drive_position.execute_drive_position") as native, \
             patch.object(self.motor, "get_status", wraps=self.motor.get_status) as drive_status:
            reached, completed, _ = self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0], callback)
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        self.assertEqual([call.args[0] for call in drive_status.call_args_list], [1, 2])
        native.assert_not_called()
        callback.assert_not_called()
        self.assertNotIn("prepare", self.motor.calls)
        self.assertNotIn("start", self.motor.calls)
        self.assertEqual(self.motor.stopped_axes, [])
        self.assertFalse(self.controller.motion_guard.path.exists())
        self.assertFalse(self.controller.turntable_snapshot["lastMove"]["motionCommanded"])

    def test_prepositioned_point_does_not_bypass_axis_two_alarm_or_pending_trajectory(self):
        self.motor.angles.update({1: 5, 2: -9})
        original_status = self.motor.get_status
        with patch.object(self.motor, "get_status", side_effect=lambda axis: replace(
                original_status(axis), alarm_code=9 if axis == 2 else 0)), \
             patch("blade_acquisition.drive_position.execute_drive_position") as native:
            with self.assertRaisesRegex(RuntimeError, "报警"):
                self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])
            native.assert_not_called()
        self.motor.initial_state = 2
        with patch("blade_acquisition.drive_position.execute_drive_position") as native:
            with self.assertRaisesRegex(RuntimeError, "轨迹"):
                self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])
            native.assert_not_called()

    def test_prepositioned_point_reference_change_is_rejected_and_pose_drift_moves_again(self):
        self.motor.angles.update({1: 5, 2: -9})
        self.motor.origins[2] += 1
        with patch("blade_acquisition.drive_position.execute_drive_position") as native:
            with self.assertRaisesRegex(RuntimeError, "参考位"):
                self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])
            native.assert_not_called()
        self.motor.origins[2] -= 1
        self.motor.angles[2] += .501
        with patch("blade_acquisition.drive_position.execute_drive_position", side_effect=self.success) as native:
            self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])
            native.assert_called_once()

    def test_native_confirmed_failure_clears_both_pending_without_extra_stop(self):
        def fail(motor, **kwargs):
            raise DrivePositionError("diagnostic failed", {
                "stopConfirmed": True, "motionCommanded": True,
                "feedback": snapshot(motor, 1), "state": "error"})
        with patch("blade_acquisition.drive_position.execute_drive_position", side_effect=fail):
            with self.assertRaisesRegex(DrivePositionError, "diagnostic failed"):
                self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])
        self.assertIsNone(self.controller.motion_guard.warning)
        self.assertEqual(self.controller._pending_turntable_axes("COM6"), [])
        self.assertNotIn("group_stop", self.motor.calls)
        self.assertEqual(self.motor.stopped_axes, [])

    def test_native_unknown_stop_keeps_persisted_group_for_axis_by_axis_recovery(self):
        def fail(motor, **kwargs):
            raise DrivePositionError("lost response", {
                "stopConfirmed": False, "motionCommanded": True,
                "feedback": snapshot(motor, 1), "state": "error"})
        with patch("blade_acquisition.drive_position.execute_drive_position", side_effect=fail):
            with self.assertRaises(DrivePositionError):
                self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])
        self.assertEqual(self.controller._pending_turntable_axes("COM6"), [1, 2])
        self.assertEqual(self.controller._pending_motion_mode("COM6"), "drive_internal")
        for axis, pending in ((1, [2]), (2, [])):
            self.controller.turntable_operation(TurntableRequest(
                action="stop", port="COM6", axis=axis, confirmMotion=True))
            self.assertEqual(self.controller._pending_turntable_axes("COM6"), pending)
        self.assertNotIn("group_stop", self.motor.calls)
        self.assertEqual(self.motor.stopped_axes, [1, 2])
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_cancelled_native_hop_with_confirmed_stop_returns_not_reached(self):
        def cancelled(motor, **kwargs):
            self.controller.stop_event.set()
            raise DrivePositionError("cancelled", {
                "stopConfirmed": True, "feedback": snapshot(motor, 1),
                "motionCommanded": True, "state": "error"})
        with patch("blade_acquisition.drive_position.execute_drive_position", side_effect=cancelled):
            reached, completed, _ = self.controller._cycle_move_point(
                self.motor, self.cycle, self.cycle.points[0])
        self.assertFalse(reached)
        self.assertEqual(completed, [])
        self.assertIsNone(self.controller.motion_guard.warning)
        self.assertNotIn("group_stop", self.motor.calls)

    def test_full_fake_cycle_records_and_handoffs_keep_native_evidence(self):
        self.motor.drive_internal_position = True
        self.start.pointCycle.diagnosticDrivePosition = False
        with patch.dict("os.environ", {"BLADE_TURNTABLE_DRIVE_POSITION_TEST": "1"}), \
             patch("blade_acquisition.service.DevicePanel", FakeLaserPanel), \
             patch("blade_acquisition.drive_position.execute_drive_position",
                   side_effect=self.success) as native:
            self.controller.start(self.start)
            self.controller.thread.join(5)
            self.assertFalse(self.controller.thread.is_alive())
        status = self.controller.status()
        self.assertEqual(status["pointCycle"]["state"], "complete", status["pointCycle"])
        self.assertEqual(status["pointCycle"]["completedRecords"], 4)
        self.assertEqual(native.call_count, 3, "Already at the first point: capture directly, move only for the other three")
        self.assertNotIn("group_stop", self.motor.calls)
        self.assertNotIn("start", self.motor.calls)
        self.assertIsNone(self.controller.motion_guard.warning)
        manifests = list(Path(self.temp.name).glob("recordings/*/manifest.json"))
        self.assertEqual(len(manifests), 4)
        first = min((json.loads(path.read_text()) for path in manifests), key=lambda record: record["pointCycle"]["pointIndex"])
        self.assertFalse(first["pointCycle"]["arrivalMove"]["motionCommanded"])
        for path in manifests:
            record = json.loads(path.read_text())
            self.assertEqual(record["status"], "complete")
            self.assertEqual(record["pointCycle"]["motionMode"], "drive_internal")
            handoff = record["pointCycle"].get("handoff", {})
            if "completedMove" in handoff:
                self.assertEqual(handoff["completedMove"]["mode"], "drive_internal")
                self.assertTrue(handoff["completedMove"]["stopConfirmed"])

    def test_full_cycle_failed_handoff_does_not_attempt_buffered_stop_or_more_points(self):
        calls = []
        def run(motor, **kwargs):
            calls.append(copy.deepcopy(kwargs["targets"]))
            if len(calls) == 1:
                return self.success(motor, **kwargs)
            raise DrivePositionError("second hop failed", {
                "stopConfirmed": False, "motionCommanded": True,
                "feedback": snapshot(motor, 1), "state": "error"})
        with patch.dict("os.environ", {"BLADE_TURNTABLE_DRIVE_POSITION_TEST": "1"}), \
             patch("blade_acquisition.service.DevicePanel", FakeLaserPanel), \
             patch("blade_acquisition.drive_position.execute_drive_position", side_effect=run):
            self.controller.start(self.start)
            self.controller.thread.join(5)
            self.assertFalse(self.controller.thread.is_alive())
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.controller.status()["pointCycle"]["state"], "error")
        self.assertEqual(self.controller._pending_turntable_axes("COM6"), [1, 2])
        self.assertNotIn("group_stop", self.motor.calls)
        self.assertEqual(self.motor.stopped_axes, [])


if __name__ == "__main__":
    unittest.main()
