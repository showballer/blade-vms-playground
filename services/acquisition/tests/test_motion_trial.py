"""Offline geometry/derivative checks; no device or service imports."""
from __future__ import annotations

import ast
import inspect
import json
import math
import unittest

from blade_acquisition import motion_trial
from blade_acquisition.motion_trial import MotionTrialConfig, preview_full_circle


ANCHOR = {"axis1AngleDeg": 10.037, "axis2AngleDeg": -1.162}


class FullCirclePreviewTests(unittest.TestCase):
    def test_defaults_are_supplied_geometry_not_a_calibration(self):
        value = MotionTrialConfig()
        self.assertEqual((value.distanceM, value.hubHeightDeltaM, value.radiusM, value.periodSeconds),
                         (2.86, 1.46, 0.31, 30))
        plan = preview_full_circle(value)
        self.assertFalse(plan["directionCalibrated"])
        self.assertEqual(plan["hardwareCapability"], "not_evaluated")
        self.assertFalse(plan["executionReady"])

    def test_strict_invalid_dimensions_period_directions_and_fields(self):
        cases = [{key: value} for key in ("distanceM", "hubHeightDeltaM", "radiusM", "periodSeconds")
                 for value in (True, False, "5", None, float("nan"), float("inf"), -float("inf"), 10 ** 1000)]
        cases += [{"distanceM": 0}, {"distanceM": -1}, {"radiusM": 0}, {"radiusM": -1},
                  {"periodSeconds": 0}, {"periodSeconds": 0.49}, {"periodSeconds": 3601},
                  {"hubHeightDeltaM": 10001}, {"distanceM": 10001}, {"radiusM": 1001},
                  {"rotationDirection": "CW"}, {"rotationDirection": None}, {"unknown": 1}]
        cases += [{key: value} for key in ("axis1Sign", "axis2Sign")
                  for value in (True, False, 0, 2, -2, "1", 1.0, None)]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                MotionTrialConfig(**changes)

    def test_unvalidated_models_cannot_bypass_input_checks(self):
        for changes in ({"distanceM": float("nan")}, {"periodSeconds": -1}, {"axis1Sign": True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                preview_full_circle(MotionTrialConfig.model_construct(**changes))
        for invalid in ({}, None, 1):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                preview_full_circle(invalid)

    def test_invalid_anchor_rejected_without_defaulting_missing_axis(self):
        for anchor in ([], {}, {"axis1AngleDeg": 1}, {**ANCHOR, "extra": 0},
                       {**ANCHOR, "axis1AngleDeg": True}, {**ANCHOR, "axis2AngleDeg": "1"},
                       {**ANCHOR, "axis1AngleDeg": float("nan")}, {**ANCHOR, "axis2AngleDeg": float("inf")},
                       {**ANCHOR, "axis1AngleDeg": 10 ** 1000}):
            with self.subTest(anchor=anchor), self.assertRaises(ValueError):
                preview_full_circle(MotionTrialConfig(), anchor)

    def test_closed_circle_has_monotonic_physical_time_and_exact_end_state(self):
        plan = preview_full_circle(MotionTrialConfig(), ANCHOR)
        samples = plan["trajectory"]
        self.assertEqual(len(samples), 721)
        self.assertEqual(plan["durationSeconds"], 30)
        self.assertEqual(plan["rotorRpm"], 2)
        self.assertEqual(samples[0]["timeSeconds"], 0)
        self.assertEqual(samples[-1]["timeSeconds"], 30)
        self.assertEqual(samples[0]["rotorPhaseDeg"], 180)
        self.assertEqual(samples[-1]["rotorPhaseDeg"], 540)
        self.assertEqual(plan["startAngles"], ANCHOR)
        self.assertEqual(plan["endAngles"], ANCHOR)
        self.assertTrue(all(a["timeSeconds"] < b["timeSeconds"] for a, b in zip(samples, samples[1:])))
        for key in samples[0]:
            if key not in ("timeSeconds", "rotorPhaseDeg", "phaseFromSixDeg"):
                self.assertEqual(samples[0][key], samples[-1][key], key)
        json.dumps(plan, allow_nan=False)

    def test_without_anchor_only_relative_encoder_angles_exist(self):
        plan = preview_full_circle(MotionTrialConfig())
        self.assertFalse(plan["anchorBound"])
        self.assertEqual(plan["angleReference"], "relative_to_six_oclock")
        for item in (plan["startAngles"], plan["endAngles"]):
            self.assertIsNone(item["axis1AngleDeg"])
            self.assertIsNone(item["axis2AngleDeg"])
        for value in plan["trajectory"]:
            for axis in (1, 2):
                self.assertIsNone(value[f"axis{axis}AngleDeg"])
                self.assertTrue(math.isfinite(value[f"axis{axis}DeltaAngleDeg"]))
        for axis in plan["axisSummaries"]:
            self.assertIsNone(axis["minAngleDeg"])
            self.assertIsNone(axis["maxAngleDeg"])

    def test_clock_positions_match_measured_example(self):
        plan = preview_full_circle(MotionTrialConfig(), ANCHOR)
        expected = [(10.037, -1.162, 0, 1.15), (15.04060636176, -7.34823032892, -.31, 1.46),
                    (19.88462683277, -1.162, 0, 1.77), (15.04060636176, 5.02423032892, .31, 1.46)]
        for index, values in zip((0, 180, 360, 540), expected):
            point = plan["trajectory"][index]
            for key, expected_value in zip(("axis1AngleDeg", "axis2AngleDeg", "pointXM", "pointHeightM"), values):
                self.assertAlmostEqual(point[key], expected_value, places=9)
        axis1, axis2 = plan["axisSummaries"]
        self.assertAlmostEqual(axis1["peakSpeedDegS"], 1.028814803, delta=0.00004)
        self.assertAlmostEqual(axis2["peakSpeedDegS"], 1.3006993007, places=8)
        self.assertAlmostEqual(axis1["peakAccelerationDegS2"], 0.224282199, places=8)
        self.assertAlmostEqual(axis2["peakAccelerationDegS2"], 0.269254424, delta=0.00001)

    def test_clockwise_and_counterclockwise_mirror_horizontal_only(self):
        cw = preview_full_circle(MotionTrialConfig())["trajectory"]
        ccw = preview_full_circle(MotionTrialConfig(rotationDirection="counterclockwise"))["trajectory"]
        self.assertLess(cw[180]["pointXM"], 0)
        self.assertGreater(ccw[180]["pointXM"], 0)
        for a, b in zip(cw, ccw):
            for suffix in ("DeltaAngleDeg", "VelocityDegS", "AccelerationDegS2"):
                self.assertAlmostEqual(a[f"axis1{suffix}"], b[f"axis1{suffix}"])
                self.assertAlmostEqual(a[f"axis2{suffix}"], -b[f"axis2{suffix}"])

    def test_signs_reverse_each_motor_coordinate_once(self):
        direct = preview_full_circle(MotionTrialConfig(), ANCHOR)["trajectory"]
        inverse = preview_full_circle(MotionTrialConfig(axis1Sign=-1, axis2Sign=-1), ANCHOR)["trajectory"]
        for a, b in zip(direct, inverse):
            for axis in (1, 2):
                for suffix in ("DeltaAngleDeg", "VelocityDegS", "AccelerationDegS2"):
                    self.assertAlmostEqual(a[f"axis{axis}{suffix}"], -b[f"axis{axis}{suffix}"])
                self.assertAlmostEqual(a[f"axis{axis}AngleDeg"] + b[f"axis{axis}AngleDeg"], 2 * ANCHOR[f"axis{axis}AngleDeg"])

    def test_period_scales_time_speed_and_acceleration_with_correct_units(self):
        fast = preview_full_circle(MotionTrialConfig(periodSeconds=5))
        slow = preview_full_circle(MotionTrialConfig(periodSeconds=30))
        self.assertEqual(fast["rotorRpm"], 6 * slow["rotorRpm"])
        self.assertFalse(slow["executionReady"])
        self.assertEqual(slow["hardwareCapability"], "not_evaluated")
        for a, b in zip(fast["trajectory"], slow["trajectory"]):
            self.assertAlmostEqual(6 * a["timeSeconds"], b["timeSeconds"])
            for axis in (1, 2):
                self.assertAlmostEqual(a[f"axis{axis}DeltaAngleDeg"], b[f"axis{axis}DeltaAngleDeg"])
                self.assertAlmostEqual(a[f"axis{axis}VelocityDegS"], 6 * b[f"axis{axis}VelocityDegS"])
                self.assertAlmostEqual(a[f"axis{axis}AccelerationDegS2"], 36 * b[f"axis{axis}AccelerationDegS2"])
        for item in fast["axisSummaries"]:
            self.assertAlmostEqual(item["peakSpeedDegS"], item["peakSpeedRpm"] * 6)

    def test_uniform_geometry_scaling_preserves_pointing_and_derivatives(self):
        initial = preview_full_circle(MotionTrialConfig())["trajectory"]
        scaled = preview_full_circle(MotionTrialConfig(distanceM=28.6, hubHeightDeltaM=14.6, radiusM=3.1))["trajectory"]
        for a, b in zip(initial, scaled):
            for axis in (1, 2):
                for suffix in ("DeltaAngleDeg", "VelocityDegS", "AccelerationDegS2"):
                    self.assertAlmostEqual(a[f"axis{axis}{suffix}"], b[f"axis{axis}{suffix}"])

    def test_analytic_derivatives_agree_with_central_differences(self):
        configs = (MotionTrialConfig(), MotionTrialConfig(distanceM=1.7, hubHeightDeltaM=-.4, radiusM=.7,
                                                        periodSeconds=3.3, rotationDirection="counterclockwise", axis1Sign=-1))
        for config in configs:
            plan = preview_full_circle(config)
            samples, dt = plan["trajectory"], plan["sampleIntervalSeconds"]
            for i in (1, 47, 179, 303, 469, 599, 719):
                for axis in (1, 2):
                    with self.subTest(config=config, i=i, axis=axis):
                        previous, current, following = samples[i - 1], samples[i], samples[i + 1]
                        angle_key, velocity_key = f"axis{axis}DeltaAngleDeg", f"axis{axis}VelocityDegS"
                        finite_velocity = (following[angle_key] - previous[angle_key]) / (2 * dt)
                        finite_acceleration = (following[velocity_key] - previous[velocity_key]) / (2 * dt)
                        self.assertAlmostEqual(current[velocity_key], finite_velocity, delta=.003)
                        self.assertAlmostEqual(current[f"axis{axis}AccelerationDegS2"], finite_acceleration, delta=.01)

    def test_ideal_cycle_requires_run_in_and_run_out_not_instant_start(self):
        plan = preview_full_circle(MotionTrialConfig())
        self.assertTrue(plan["requiresRunIn"])
        self.assertTrue(plan["requiresRunOut"])
        self.assertEqual(plan["start"]["axis1VelocityDegS"], 0)
        self.assertAlmostEqual(plan["start"]["axis2VelocityDegS"], -1.3006993007, places=8)
        self.assertEqual(plan["start"]["axis2VelocityDegS"], plan["end"]["axis2VelocityDegS"])
        self.assertFalse(plan["extremaAreSafetyBounds"])

    def test_valid_dimension_extremes_remain_finite_but_do_not_certify_limits(self):
        for dimensions in ((.001, -10000, 1000, .5), (10000, 10000, .001, 3600),
                           (.001, 0, 1000, 3600), (.001, .001, .001, .5)):
            with self.subTest(dimensions=dimensions):
                config = MotionTrialConfig(**dict(zip(("distanceM", "hubHeightDeltaM", "radiusM", "periodSeconds"), dimensions)))
                plan = preview_full_circle(config)
                json.dumps(plan, allow_nan=False)
                self.assertFalse(plan["executionReady"])
                self.assertFalse(plan["extremaAreSafetyBounds"])

    def test_anchor_does_not_clamp_or_certify_unsafe_hardware_coordinates(self):
        plan = preview_full_circle(MotionTrialConfig(), {"axis1AngleDeg": 35, "axis2AngleDeg": 180})
        self.assertTrue(plan["anchorBound"])
        self.assertGreater(plan["axisSummaries"][0]["maxAngleDeg"], 35)
        self.assertGreater(plan["axisSummaries"][1]["maxAngleDeg"], 180)
        self.assertFalse(plan["executionReady"])

    def test_pure_module_has_no_device_transport_file_or_clock_imports(self):
        tree = ast.parse(inspect.getsource(motion_trial))
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imports.add(node.module)
        self.assertEqual(imports, {"__future__", "math", "typing", "pydantic"})


if __name__ == "__main__":
    unittest.main()
