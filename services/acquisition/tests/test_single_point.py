"""Offline math and input validation only; never imports device/service code."""
from __future__ import annotations

import math
import unittest

from blade_acquisition.single_point import (
    SinglePointConfig, estimate_manual_sync, preview_plan, schedule_follow,
)


def config(**changes):
    values = dict(materialMark="A叶片蓝色标记", distanceM=5, hubHeightDeltaM=0.1,
                  radiusM=0.1, arcDegrees=30, nominalPeriodSeconds=5, motionRampSeconds=0.01,
                  maxOutputRpm=10, maxOutputAccelerationDegS2=5000,
                  syncUncertaintyMs=0.1, commandLatencyMs=0.1, axisStartSkewMs=0.1,
                  maxApproximationErrorMm=20, maxPredictionErrorMm=30,
                  frontFacingConfirmed=True, motionTimingConfirmed=True)
    values.update(changes)
    return SinglePointConfig(**values)


ANCHOR = {"axis1AngleDeg": 10.0, "axis2AngleDeg": -2.0}


class SinglePointPlanningTests(unittest.TestCase):
    def test_default_period_and_sync_age_match_thirty_second_model(self):
        value = SinglePointConfig(materialMark="A/P1", distanceM=2.86, hubHeightDeltaM=1.46, radiusM=.31)
        self.assertEqual(value.nominalPeriodSeconds, 30)
        self.assertEqual(value.maxSyncAgeSeconds, 45)

    def test_no_fabricated_geometry_defaults(self):
        with self.assertRaises(ValueError):
            SinglePointConfig(materialMark="A/P1")

    def test_strict_finite_config_and_single_point_scope(self):
        for changes in ({"distanceM": True}, {"axis1Sign": True}, {"radiusM": float("nan")},
                        {"hubHeightDeltaM": float("inf")}, {"arcDegrees": 31},
                        {"arcDegrees": 0}, {"radiusM": 0}, {"frontFacingConfirmed": 1},
                        {"materialMark": " "}, {"unknown": 1}, {"points": [1, 2]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                config(**changes)

    def test_five_same_blade_marks_estimate_twelve_rpm_not_lock(self):
        value = estimate_manual_sync([100, 105, 110, 115, 120], config())
        self.assertTrue(value["ready"])
        self.assertEqual(value["periodSeconds"], 5)
        self.assertEqual(value["rpm"], 12)
        self.assertEqual(value["periodVariationPercent"], 0)
        self.assertFalse(value["phaseLocked"])
        self.assertFalse(value["identityConfirmed"])

    def test_fewer_than_five_marks_cannot_arm(self):
        for marks in ([], [100], [100, 105, 110, 115]):
            with self.subTest(marks=marks):
                value = estimate_manual_sync(marks, config())
                self.assertFalse(value["ready"])
                self.assertFalse(preview_plan(config(), ANCHOR, value)["ready"])

    def test_reject_wrong_clock_duplicate_backward_and_nonfinite_marks(self):
        for marks in ([1, 2, 2], [3, 2], [-1, 4], [True], [float("nan")], list(range(11))):
            with self.subTest(marks=marks), self.assertRaises(ValueError):
                estimate_manual_sync(marks, config())

    def test_every_blade_marks_not_silently_mod_three(self):
        marks = [100 + index * 5 / 3 for index in range(5)]
        value = estimate_manual_sync(marks, config())
        self.assertFalse(value["ready"])
        self.assertTrue(any("同一叶片" in reason for reason in value["blockReasons"]))

    def test_unstable_period_is_blocked(self):
        value = estimate_manual_sync([100, 105, 110.5, 115.5, 120.5], config())
        self.assertFalse(value["ready"])
        self.assertAlmostEqual(value["periodVariationPercent"], 10)

    def test_six_oclock_anchor_and_front_geometry(self):
        c = config()
        sync = estimate_manual_sync([100, 105, 110, 115, 120], c)
        plan = preview_plan(c, ANCHOR, sync)
        self.assertTrue(plan["ready"], plan["blockReasons"])
        self.assertEqual(plan["startAngles"], ANCHOR)
        self.assertAlmostEqual(plan["durationSeconds"], 5 * 30 / 360)
        x, y = -0.05, 0.1 - 0.1 * math.cos(math.pi / 6)
        expected1 = 10 + math.degrees(math.atan2(y, math.hypot(5, x)))
        expected2 = -2 + math.degrees(math.atan2(x, 5))
        self.assertAlmostEqual(plan["endAngles"]["axis1AngleDeg"], expected1)
        self.assertAlmostEqual(plan["endAngles"]["axis2AngleDeg"], expected2)
        self.assertEqual(plan["motionModel"], "position_chord_approximation")
        self.assertFalse(plan["phaseLocked"])
        self.assertFalse(plan["identityConfirmed"])
        self.assertEqual(len(plan["axisMoves"]), 2)

    def test_direction_and_axis_sign_are_applied_once(self):
        cw = preview_plan(config(), ANCHOR)
        ccw = preview_plan(config(rotationDirection="counterclockwise"), ANCHOR)
        inverse = preview_plan(config(axis1Sign=-1, axis2Sign=-1), ANCHOR)
        self.assertAlmostEqual(cw["endAngles"]["axis1AngleDeg"], ccw["endAngles"]["axis1AngleDeg"])
        self.assertAlmostEqual(cw["endAngles"]["axis2AngleDeg"] + ccw["endAngles"]["axis2AngleDeg"], -4)
        self.assertAlmostEqual(cw["endAngles"]["axis1AngleDeg"] + inverse["endAngles"]["axis1AngleDeg"], 20)
        self.assertAlmostEqual(cw["endAngles"]["axis2AngleDeg"] + inverse["endAngles"]["axis2AngleDeg"], -4)

    def test_unbound_or_unconfirmed_geometry_never_ready(self):
        sync = estimate_manual_sync([100, 105, 110, 115, 120], config())
        self.assertFalse(preview_plan(config(), None, sync)["ready"])
        self.assertFalse(preview_plan(config(frontFacingConfirmed=False), ANCHOR, sync)["ready"])
        self.assertFalse(preview_plan(config(motionTimingConfirmed=False), ANCHOR, sync)["ready"])

    def test_trajectory_limit_rejects_without_clamping(self):
        plan = preview_plan(config(), {"axis1AngleDeg": 35, "axis2AngleDeg": -180})
        self.assertFalse(plan["ready"])
        self.assertGreater(plan["endAngles"]["axis1AngleDeg"], 35)
        self.assertLess(plan["endAngles"]["axis2AngleDeg"], -180)
        self.assertTrue(any("轴1轨迹超出" in reason for reason in plan["blockReasons"]))
        self.assertTrue(any("轴2轨迹超出" in reason for reason in plan["blockReasons"]))

    def test_short_duration_cannot_hide_ramp_or_speed_violation(self):
        c = config(arcDegrees=10, motionRampSeconds=0.1, maxOutputRpm=0.02,
                   maxOutputAccelerationDegS2=0.1)
        sync = estimate_manual_sync([100, 105, 110, 115, 120], c)
        plan = preview_plan(c, ANCHOR, sync)
        self.assertFalse(plan["ready"])
        self.assertTrue(any("加速和减速" in reason for reason in plan["blockReasons"]))
        self.assertTrue(any("转速" in reason for reason in plan["blockReasons"]))
        self.assertTrue(any("加速度" in reason for reason in plan["blockReasons"]))

    def test_start_from_rest_shape_error_is_not_linear_chord_only(self):
        low = preview_plan(config(motionRampSeconds=0.005), ANCHOR)
        high = preview_plan(config(motionRampSeconds=0.1), ANCHOR)
        self.assertGreater(high["maxPathErrorMm"], low["maxPathErrorMm"])
        constrained = preview_plan(config(maxApproximationErrorMm=0.000001), ANCHOR)
        self.assertTrue(any("定位近似轨迹偏差" in reason for reason in constrained["blockReasons"]))

    def test_full_error_budget_includes_manual_timing_skew_and_period_drift(self):
        c = config(syncUncertaintyMs=150, commandLatencyMs=100, axisStartSkewMs=80,
                   maxPredictionErrorMm=1)
        sync = estimate_manual_sync([100, 105, 110.1, 115.1, 120.1], c)
        one = preview_plan(c, ANCHOR, sync, prediction_revolutions=1)
        three = preview_plan(c, ANCHOR, sync, prediction_revolutions=3)
        budget = one["errorBudget"]
        speed = 1000 * 0.1 * 2 * math.pi / 5
        self.assertAlmostEqual(budget["manualSyncMm"], speed * 0.15)
        self.assertAlmostEqual(budget["commandTimingMm"], speed * 0.1)
        self.assertAlmostEqual(budget["axisStartSkewMm"], speed * 0.08)
        self.assertGreater(three["predictionErrorMm"], one["predictionErrorMm"])
        self.assertFalse(one["ready"])
        self.assertAlmostEqual(budget["totalMm"], sum(value for key, value in budget.items() if key != "totalMm"))

    def test_schedules_same_blade_next_revolution_and_skips_late_dispatch(self):
        c = config(commandLatencyMs=100)
        sync = estimate_manual_sync([100, 105, 110, 115, 120], c)
        plan = schedule_follow(c, ANCHOR, sync, 121)
        self.assertTrue(plan["ready"], plan["blockReasons"])
        self.assertEqual(plan["scheduledStartAt"], 125)
        self.assertAlmostEqual(plan["dispatchAt"], 124.9)
        late = schedule_follow(c, ANCHOR, sync, 124.95)
        self.assertEqual(late["scheduledStartAt"], 130)
        self.assertEqual(late["skippedRevolutions"], 1)
        self.assertEqual((late["scheduledStartAt"] - sync["lastMarkAt"]) % 5, 0)

    def test_ready_time_is_budgeted_and_both_arm_and_target_expiry_checked(self):
        c = config(maxSyncAgeSeconds=6)
        sync = estimate_manual_sync([100, 105, 110, 115, 120], c)
        expired_target = schedule_follow(c, ANCHOR, sync, 121, ready_in_seconds=5)
        expired_arm = schedule_follow(c, ANCHOR, sync, 140)
        self.assertFalse(expired_target["ready"])
        self.assertEqual(expired_target["scheduledStartAt"], 130)
        self.assertFalse(expired_arm["ready"])
        self.assertTrue(any("过期" in reason for reason in expired_target["blockReasons"]))

    def test_whole_arc_must_fit_inside_sync_validity_not_only_start(self):
        c = config(maxSyncAgeSeconds=5.1)
        sync = estimate_manual_sync([100, 105, 110, 115, 120], c)
        plan = schedule_follow(c, ANCHOR, sync, 121)
        self.assertEqual(plan["scheduledStartAt"], 125)
        self.assertGreater(plan["scheduledEndAt"] - 120, 5.1)
        self.assertFalse(plan["ready"])
        self.assertTrue(any("过期" in reason for reason in plan["blockReasons"]))

    def test_thirty_second_next_pass_fits_but_missed_or_stale_passes_do_not(self):
        c = config(nominalPeriodSeconds=30, arcDegrees=20)
        sync = estimate_manual_sync([0, 30, 60, 90, 120], c)
        next_pass = schedule_follow(c, ANCHOR, sync, 121)
        self.assertTrue(next_pass["ready"], next_pass["blockReasons"])
        self.assertEqual(next_pass["scheduledStartAt"], 150)
        self.assertAlmostEqual(next_pass["scheduledEndAt"], 151 + 2 / 3)
        self.assertEqual(next_pass["skippedRevolutions"], 0)
        for now in (150, 166, 211):
            with self.subTest(now=now):
                expired = schedule_follow(c, ANCHOR, sync, now)
                self.assertFalse(expired["ready"])
                self.assertTrue(any("过期" in reason for reason in expired["blockReasons"]))
                self.assertGreaterEqual(expired["scheduledStartAt"], 180)

    def test_thirty_second_sync_must_cover_the_whole_follow_window(self):
        c = config(nominalPeriodSeconds=30, arcDegrees=20, maxSyncAgeSeconds=31.5)
        sync = estimate_manual_sync([0, 30, 60, 90, 120], c)
        plan = schedule_follow(c, ANCHOR, sync, 121)
        self.assertLess(plan["scheduledStartAt"] - 120, c.maxSyncAgeSeconds)
        self.assertGreater(plan["scheduledEndAt"] - 120, c.maxSyncAgeSeconds)
        self.assertFalse(plan["ready"])
        self.assertTrue(any("过期" in reason for reason in plan["blockReasons"]))

    def test_thirty_second_model_passes_motion_limits_but_preserves_pointing_error_guards(self):
        c = SinglePointConfig(
            materialMark="叶片2/P1", distanceM=2.86, hubHeightDeltaM=1.46, radiusM=.31,
            arcDegrees=20, maxOutputRpm=.6, maxOutputAccelerationDegS2=10, motionRampSeconds=.15,
            commandLatencyMs=100, axisStartSkewMs=100, syncUncertaintyMs=150,
            maxPeriodVariationPercent=2, maxApproximationErrorMm=2, maxPredictionErrorMm=5,
            frontFacingConfirmed=True, motionTimingConfirmed=True,
        )
        sync = estimate_manual_sync([0, 30, 60, 90, 120], c)
        plan = schedule_follow(c, ANCHOR, sync, 121)
        self.assertAlmostEqual(plan["durationSeconds"], 5 / 3)
        self.assertEqual([move["speedRpm"] for move in plan["axisMoves"]], [.04, .24])
        for move in plan["axisMoves"]:
            self.assertLess(move["speedRpm"], c.maxOutputRpm)
            self.assertLess(move["requiredPeakAccelerationDegS2"], c.maxOutputAccelerationDegS2)
        self.assertGreater(plan["maxPathErrorMm"], c.maxApproximationErrorMm)
        self.assertGreater(plan["predictionErrorMm"], c.maxPredictionErrorMm)
        self.assertFalse(plan["ready"])
        self.assertEqual(plan["blockReasons"], ["定位近似轨迹偏差超过允许值，不能按该短弧试跟",
                                                "人工同步、周期波动和运动时序的总预测误差超过测点允许值"])

    def test_future_clock_mark_and_invalid_ready_time_blocked(self):
        c = config()
        sync = estimate_manual_sync([100, 105, 110, 115, 120], c)
        self.assertFalse(schedule_follow(c, ANCHOR, sync, 119)["ready"])
        for now, ready in ((True, 0), (1, -1), (float("inf"), 0), (1, float("nan"))):
            with self.subTest(now=now, ready=ready), self.assertRaises(ValueError):
                schedule_follow(c, ANCHOR, sync, now, ready)

    def test_missing_sync_has_no_schedule(self):
        plan = schedule_follow(config(), ANCHOR, None, 120)
        self.assertFalse(plan["ready"])
        self.assertIsNone(plan["dispatchAt"])


if __name__ == "__main__":
    unittest.main()
