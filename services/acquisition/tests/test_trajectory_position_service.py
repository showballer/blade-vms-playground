"""Runtime 0x37 policy using in-memory motors; no physical serial connection."""
import copy
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import PointCycleConfig, TurntableConfig, snapshot
from blade_acquisition.turntable_driver.trajectory import AxisPosition
from test_dual_axis_integration import BufferedMotor
from test_service import POINT_REFERENCE, TOKEN


class TrajectoryPositionServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.motor = BufferedMotor()
        self.controller = create_app(Settings(TOKEN, 8765, Path(self.temp.name))).state.controller
        self.cycle = PointCycleConfig(port="COM6", points=[{**POINT_REFERENCE, "name": "P1",
            "axis1AngleDeg": 5, "axis2AngleDeg": 9}])
        self.configs = [TurntableConfig(port="COM6", protocol="position", axis=axis, targetAngleDeg=target)
                        for axis, target in ((1, 5), (2, 9))]

    def tearDown(self):
        self.temp.cleanup()

    def positions(self):
        return (AxisPosition(1, 1389, 10, 3, 250, 0, 0, 1),
                AxisPosition(2, 2778, 12, 3, 0, 0, 0, 0))

    def test_ages_include_transport_delay_and_only_position_fields_get_fresh_times(self):
        old = snapshot(self.motor, 1)
        query = time.time() + 1
        result = self.controller._trajectory_position_feedback(old, self.positions(), self.configs, query, query + .1)
        for axis, age, angle in (("1", .25, 1), ("2", 0, 2)):
            self.assertAlmostEqual(result["axes"][axis]["observedAt"], query - age)
            self.assertEqual(result["axes"][axis]["referenceObservedAt"], old["axes"][axis]["observedAt"])
            self.assertEqual(result["axes"][axis]["guardObservedAt"], old["axes"][axis]["observedAt"])
            self.assertEqual(result["axes"][axis]["origin_counts"], old["axes"][axis]["origin_counts"])
            self.assertEqual(result["axes"][axis]["output_angle_deg"], angle)
        self.assertEqual(result["positionSource"], "0x37")
        self.assertEqual(old["axes"]["1"]["output_angle_deg"], 0)

    def test_invalid_stale_faulted_or_out_of_range_axis_never_becomes_fresh_feedback(self):
        old = snapshot(self.motor, 1)
        for change in ({"angle_deg": None}, {"flags": 2}, {"source": 2}, {"sample_age_ms": 1001},
                       {"sample_age_ms": -1}, {"alarm_code": 1}, {"guard_fault": 2},
                       {"flags": 19}, {"flags": 1}, {"angle_deg": 36}, {"angle_deg": float("nan")}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                positions = (replace(self.positions()[0], **change), self.positions()[1])
                self.controller._trajectory_position_feedback(old, positions, self.configs, 100, 100.1)
        for delay, age in ((1.5, 0), (.2, 900)):
            with self.subTest(delay=delay, age=age), self.assertRaisesRegex(RuntimeError, "过期"):
                positions = (replace(self.positions()[0], sample_age_ms=age), self.positions()[1])
                self.controller._trajectory_position_feedback(old, positions, self.configs, 100, 100 + delay)
        with self.assertRaises(RuntimeError):
            self.controller._trajectory_position_feedback(old, self.positions(), self.configs, 100, 99)

    def test_axis2_disabled_soft_is_optional_but_enabled_actual_range_and_product_envelope_remain(self):
        old = snapshot(self.motor, 1)
        old["axes"]["2"]["guard"].update(soft_enabled=False, minimum_deg=0, maximum_deg=0)
        positions = (self.positions()[0], replace(self.positions()[1], flags=1, angle_deg=100))
        result = self.controller._trajectory_position_feedback(old, positions, self.configs, 100, 100)
        self.assertEqual(result["axes"]["2"]["output_angle_deg"], 100)
        with self.assertRaises(Exception):
            self.controller._trajectory_position_feedback(old,
                (positions[0], replace(positions[1], angle_deg=181)), self.configs, 100, 100)
        old["axes"]["2"]["guard"].update(soft_enabled=True, minimum_deg=-10, maximum_deg=10)
        with self.assertRaises(Exception):
            self.controller._trajectory_position_feedback(old,
                (positions[0], replace(positions[1], flags=3, angle_deg=11)), self.configs, 100, 100)

    def test_motion_queries_only_cached_axes_at_one_second_and_never_full_legacy_snapshot(self):
        moving = [False]
        for name in ("get_status", "get_feedback", "get_guard_config"):
            original = getattr(self.motor, name)
            def guarded(*args, original=original):
                self.assertFalse(moving[0], "do not query legacy drive registers during a buffered trajectory")
                return original(*args)
            setattr(self.motor, name, guarded)
        clock = [0.0]
        actual = []
        update = self.controller._cycle_update
        def observed(state, **extra):
            if moving[0] and "feedback" in extra:
                actual.append(copy.deepcopy(extra["feedback"]))
            return update(state, **extra)
        def wait(session, **kwargs):
            moving[0] = True
            try:
                for now, angle in ((1, 1), (1.2, 2), (2.01, 3)):
                    clock[0] = now
                    self.motor.angles = {1: angle, 2: angle + 1}
                    kwargs["on_status"](self.motor.status(3))
            finally:
                moving[0] = False
            self.motor.angles = {1: 5, 2: 9}
            return self.motor.status(6)
        self.motor.wait_trajectory = wait
        with patch("blade_acquisition.service.time.monotonic", side_effect=lambda: clock[0]), \
             patch.object(self.controller, "_cycle_update", side_effect=observed):
            result = self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])
        self.assertTrue(result[0])
        self.assertEqual(self.motor.position_calls, ["probe", "get", "get"])
        self.assertEqual([item["axes"]["1"]["output_angle_deg"] for item in actual], [1, 3])

    def test_only_explicit_unsupported_axes_uses_progress_without_refreshing_angles(self):
        moving, during_updates = [False], []
        for name in ("get_status", "get_feedback", "get_guard_config"):
            original = getattr(self.motor, name)
            def guarded(*args, original=original):
                self.assertFalse(moving[0], "unsupported 0x37 must not fall back to moving 0x20")
                return original(*args)
            setattr(self.motor, name, guarded)
        probe = []
        self.motor.probe_axis_positions = lambda: probe.append(True)
        self.motor.get_axis_positions = lambda: self.fail("unsupported capability must not be retried")
        update = self.controller._cycle_update
        def observed(state, **extra):
            if moving[0]:
                during_updates.append(extra)
            return update(state, **extra)
        def wait(session, **kwargs):
            moving[0] = True
            try:
                kwargs["on_status"](self.motor.status(3))
                kwargs["on_status"](self.motor.status(3))
            finally:
                moving[0] = False
            self.motor.angles = {1: 5, 2: 9}
            return self.motor.status(6)
        self.motor.wait_trajectory = wait
        with patch.object(self.controller, "_cycle_update", side_effect=observed):
            self.assertTrue(self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])[0])
        self.assertEqual(probe, [True])
        self.assertTrue(during_updates)
        self.assertTrue(all("feedback" not in item for item in during_updates))

    def test_axes_timeout_stops_trajectory_without_legacy_fallback(self):
        self.motor.probe_axis_positions = lambda: (_ for _ in ()).throw(RuntimeError("0x37 timeout"))
        with self.assertRaisesRegex(RuntimeError, "0x37 timeout"):
            self.controller._cycle_move_point(self.motor, self.cycle, self.cycle.points[0])
        self.assertIn("group_stop", self.motor.calls)
        self.assertEqual(self.motor.position_calls, [])
