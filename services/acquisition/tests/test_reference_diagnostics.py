"""Reference-change diagnostics with fake motors only; no serial port is opened."""
import copy
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import PointCycleConfig, reference_check, reference_key, snapshot
from test_dual_axis_integration import BufferedMotor
from test_service import POINT_REFERENCE, TOKEN


class ReferenceDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.motor = BufferedMotor()
        self.controller = create_app(Settings(TOKEN, 8765, Path(self.temp.name))).state.controller
        self.cycle = PointCycleConfig(port="COM6", points=[{**POINT_REFERENCE, "name": "P1",
            "axis1AngleDeg": 5, "axis2AngleDeg": 9}])

    def tearDown(self):
        self.temp.cleanup()

    def move(self):
        return self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])

    def test_reference_helper_ignores_position_speed_and_query_times_but_keeps_every_identity_field(self):
        before_value = snapshot(self.motor, 1)
        before = reference_key(before_value)
        after = copy.deepcopy(before_value)
        after["observedAt"] += 1
        after["motorRpm"] = 30
        for axis in after["axes"].values():
            axis.update(actual_counts=100, commanded_counts=200, error_counts=100,
                        output_angle_deg=1.5, motor_rpm=30, observedAt=axis["observedAt"] + 1)
        self.assertEqual(reference_check(before, after, "moving")["changes"], [])
        for field, value in (("origin_counts", 1), ("display_mode", 2),
                             ("command_counts_per_rev", 20000), ("encoder_bits", 21)):
            current = copy.deepcopy(after)
            current["axes"]["2"][field] = value
            check = reference_check(before, current, "moving")
            self.assertEqual(len(check["changes"]), 1)
            self.assertEqual(check["changes"][0]["axis"], 2)
            self.assertEqual(check["changes"][0]["field"], field)
        current = copy.deepcopy(after)
        current["axes"]["2"]["output_angle_deg"] = None
        self.assertEqual(reference_check(before, current, "moving")["changes"][0]["field"], "valid")

    def test_transient_arrival_origin_unit_and_encoder_changes_stop_and_preserve_the_offending_sample(self):
        for field, value in (("origin_counts", 1), ("command_counts_per_rev", 20000), ("encoder_bits", 21)):
            with self.subTest(field=field):
                self.motor = BufferedMotor()
                original_feedback = self.motor.get_feedback
                transient = [False]
                def feedback(axis):
                    result = original_feedback(axis)
                    return replace(result, **{field: value}) if transient[0] and axis == 2 else result
                self.motor.get_feedback = feedback
                def wait(session, **kwargs):
                    kwargs["on_status"](self.motor.status(3))
                    self.motor.angles = {1: 5, 2: 9}
                    transient[0] = True
                    return self.motor.status(6)
                original_stop = self.motor.stop_trajectory
                def stop(**kwargs):
                    transient[0] = False  # Mimic a transient that disappears before stop readback.
                    return original_stop(**kwargs)
                self.motor.wait_trajectory = wait
                self.motor.stop_trajectory = stop
                with self.assertRaisesRegex(RuntimeError, f"轴2 .*{field}.*→{value}"):
                    self.move()
                evidence = self.controller.turntable_snapshot["lastMove"]
                failed = evidence["referenceMismatch"]
                self.assertEqual(failed["phase"], "arrival")
                self.assertEqual(failed["feedback"]["axes"]["2"][field], value)
                self.assertEqual(failed["changes"][0]["field"], field)
                stopped = self.controller.turntable_snapshot["feedback"]
                self.assertEqual(reference_key(stopped), evidence["referenceBefore"])
                self.assertNotEqual(failed["after"], evidence["referenceBefore"])
                self.assertEqual(evidence["referenceChecks"][-1]["phase"], "after_stop")
                self.assertEqual(evidence["referenceChecks"][-1]["changes"], [])
                self.assertIn("group_stop", self.motor.calls)
                self.assertTrue(self.controller.turntable_snapshot["stopConfirmed"])

    def test_preparation_and_final_arrival_reference_failures_keep_phase_and_values(self):
        for phase, attribute in (("before_start", "change_prepare_reference"), ("arrival", "change_reference")):
            with self.subTest(phase=phase):
                self.motor = BufferedMotor()
                setattr(self.motor, attribute, True)
                with self.assertRaisesRegex(RuntimeError, "轴2 .*origin_counts.*0→1"):
                    self.move()
                evidence = self.controller.turntable_snapshot["lastMove"]
                failed = evidence["referenceMismatch"]
                self.assertEqual(failed["phase"], phase)
                self.assertEqual(failed["before"]["2"]["origin_counts"], 0)
                self.assertEqual(failed["after"]["2"]["origin_counts"], 1)
                self.assertEqual(failed["feedback"]["axes"]["2"]["origin_counts"], 1)
                if phase == "before_start":
                    self.assertNotIn("start", self.motor.calls)

    def test_normal_moving_encoder_feedback_does_not_change_the_reference_or_abort(self):
        target = self.cycle.points[0]
        def wait(session, **kwargs):
            self.motor.started = True
            self.motor.angles = {1: 2.5, 2: 4.5}
            kwargs["on_status"](self.motor.status(3))
            self.motor.started = False
            self.motor.angles = {1: target.axis1AngleDeg, 2: target.axis2AngleDeg}
            return self.motor.status(6)
        self.motor.wait_trajectory = wait
        reached, axes, feedback = self.move()
        self.assertTrue(reached)
        self.assertEqual(axes, [1, 2])
        evidence = self.controller.turntable_snapshot["lastMove"]
        self.assertEqual(evidence["state"], "complete")
        self.assertNotIn("referenceMismatch", evidence)
        self.assertTrue(all(not check["changes"] for check in evidence["referenceChecks"]))
        self.assertEqual([check["phase"] for check in evidence["referenceChecks"]],
                         ["before_start", "before_start", "arrival", "arrival"])
        self.assertNotIn("group_stop", self.motor.calls)
