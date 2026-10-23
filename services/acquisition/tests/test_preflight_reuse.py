"""Bounded same-operation checks; fake motors only, no device/network access."""
from dataclasses import replace
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import PointCycleConfig, joint_snapshots
from test_dual_axis_integration import BufferedMotor
from test_service import POINT_REFERENCE, TOKEN


class PreflightReuseTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.controller = create_app(Settings(TOKEN, 8765, Path(folder.name))).state.controller
        self.controller.point_cycle = {}
        self.motor = BufferedMotor()
        self.motor.drive_internal_position = True
        self.cycle = PointCycleConfig(port="COM6", points=[{
            **POINT_REFERENCE, "name": "first", "axis1AngleDeg": 0, "axis2AngleDeg": 0}])
        self.point = self.cycle.points[0]
        self.controller._motion_capability(self.motor)

    def verify(self, pair):
        return self.controller._cycle_verify_initial_pose(
            self.motor, self.cycle, self.point, "worker_start", initial_snapshots=pair)

    def capture(self, pair):
        return self.controller._cycle_capture_pose(
            self.motor, self.cycle, self.point, arrived_snapshots=pair)

    def test_first_pose_and_capture_share_one_original_observation_without_renewing_age(self):
        pair = joint_snapshots(self.motor)
        timestamps = [value["queryStartedAt"] for value in pair]
        with patch("blade_acquisition.service.joint_snapshots", wraps=joint_snapshots) as full, \
             patch("blade_acquisition.service.motor_snapshot") as old, \
             patch.object(self.motor, "get_trajectory_status", wraps=self.motor.get_trajectory_status) as trajectory:
            self.assertIs(self.verify(pair), pair[0])
            self.assertIs(self.capture(pair), pair[0])
        full.assert_not_called()
        old.assert_not_called()
        trajectory.assert_called_once()
        self.assertEqual(timestamps, [value["queryStartedAt"] for value in pair])
        self.assertIs(self.motor._blade_stopped_snapshots, pair)
        self.assertTrue(self.controller.point_cycle["lastMove"]["poseChecks"][0]["snapshotReused"])

    def test_missing_or_wrong_axis_is_refreshed_instead_of_treated_as_complete_pair(self):
        pair = joint_snapshots(self.motor)
        for malformed in ((pair[0],), (pair[0], pair[0]), (pair[1], pair[0])):
            for method in (self.verify, self.capture):
                with self.subTest(pair=malformed, method=method.__name__), \
                     patch("blade_acquisition.service.joint_snapshots", wraps=joint_snapshots) as full:
                    method(malformed)
                    full.assert_called_once_with(self.motor)

    def test_future_timestamp_and_expired_pair_are_refreshed(self):
        for offset in (-1, 1):
            for method in (self.verify, self.capture):
                pair = joint_snapshots(self.motor)
                for value in pair:
                    value["queryStartedAt"] = time.time() + offset
                with self.subTest(offset=offset, method=method.__name__), \
                     patch("blade_acquisition.service.joint_snapshots", wraps=joint_snapshots) as full:
                    method(pair)
                full.assert_called_once_with(self.motor)

    def test_expired_pair_does_not_hide_reference_change(self):
        for method in (self.verify, self.capture):
            self.motor.origins[2] = 0
            pair = joint_snapshots(self.motor)
            for value in pair:
                value["queryStartedAt"] -= 1
            self.motor.origins[2] = 1
            with self.subTest(method=method.__name__), self.assertRaisesRegex(RuntimeError, "参考位"):
                method(pair)
        self.assertEqual(self.motor.start_calls, 0)

    def test_expired_pair_does_not_hide_new_axis_two_alarm(self):
        pair = joint_snapshots(self.motor)
        for value in pair:
            value["queryStartedAt"] -= 1
        get_status = self.motor.get_status
        for method in (self.verify, self.capture):
            with self.subTest(method=method.__name__), \
                 patch.object(self.motor, "get_status", side_effect=lambda axis: replace(
                     get_status(axis), alarm_code=7 if axis == 2 else 0)), \
                 self.assertRaisesRegex(RuntimeError, "报警 7"):
                method(pair)
        self.assertEqual(self.motor.start_calls, 0)

    def test_fresh_pair_still_validates_independent_axis_two_alarm(self):
        pair = joint_snapshots(self.motor)
        pair[1]["alarmCode"] = 7
        for method in (self.verify, self.capture):
            with self.subTest(method=method.__name__), self.assertRaisesRegex(RuntimeError, "报警 7"):
                method(pair)

    def test_fresh_pair_still_validates_reference_and_target(self):
        for change, error in (("reference", "参考位"), ("target", "位置已变化|角度已变化")):
            pair = joint_snapshots(self.motor)
            pair[0]["axes"]["2"]["origin_counts" if change == "reference" else "output_angle_deg"] += 1
            for method in (self.verify, self.capture):
                with self.subTest(change=change, method=method.__name__), self.assertRaisesRegex(RuntimeError, error):
                    method(pair)

    def test_expired_arrival_still_checks_pending_trajectory(self):
        pair = joint_snapshots(self.motor)
        for value in pair:
            value["queryStartedAt"] -= 1
        self.motor.initial_state = 2
        with self.assertRaisesRegex(RuntimeError, "轨迹未停稳"):
            self.capture(pair)

    def test_at_target_reuses_pair_and_never_commands_duplicate_move(self):
        pair = joint_snapshots(self.motor)
        with patch("blade_acquisition.service.joint_snapshots", wraps=joint_snapshots) as full, \
             patch.object(self.controller, "_execute_drive_position") as execute:
            reached, _, feedback = self.controller._cycle_move_point(
                self.motor, self.cycle, self.point, initial_snapshots=pair)
        self.assertTrue(reached)
        self.assertIs(feedback, pair[0])
        self.assertTrue(self.controller.point_cycle["lastMove"]["startupSnapshotReused"])
        full.assert_not_called()
        execute.assert_not_called()

    def test_duplicate_axis_pair_cannot_authorize_an_unchecked_move(self):
        pair = joint_snapshots(self.motor)
        with patch("blade_acquisition.service.joint_snapshots", wraps=joint_snapshots) as full:
            self.controller._cycle_move_point(
                self.motor, self.cycle, self.point, initial_snapshots=(pair[0], pair[0]))
        full.assert_called_once_with(self.motor)


if __name__ == "__main__":
    unittest.main()
