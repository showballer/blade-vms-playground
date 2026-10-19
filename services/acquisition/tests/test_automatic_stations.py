"""Explicit fake hardware fixtures: no device connection or synthesized production fallback."""
from __future__ import annotations

import copy
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import PointCycleConfig, PointCycleGeometry
from test_service import POINT_REFERENCE, START, TOKEN
from test_turntable import FakeMotor
from test_rssi_handoff import batch, blade_values


GEOMETRY = dict(distanceM=8, hubHeightDeltaM=0, rotationDirection="clockwise",
                axis1Sign=1, axis2Sign=1, anchorRadiusM=.5,
                anchorAxis1AngleDeg=0, anchorAxis2AngleDeg=0)


def automatic_config(*, radial_points=(('root', .5),), azimuths=(0, 90, 180, 270), **extra):
    geometry = PointCycleGeometry(**GEOMETRY)
    points = []
    for radial, radius in radial_points:
        for index, azimuth in enumerate(azimuths, 1):
            a1, a2 = geometry.angles(radius, azimuth)
            points.append({**POINT_REFERENCE, "pointId": f"{radial}-s{index}",
                           "name": f"{radial}-{azimuth}", "bladeId": "A", "radialPointId": radial,
                           "radialPointName": radial, "radiusM": radius, "azimuthDeg": azimuth,
                           "axis1AngleDeg": round(a1, 6), "axis2AngleDeg": round(a2, 6)})
    return {"port": "COM6", "mode": "automatic_stations", "geometry": GEOMETRY,
            "nominalPeriodSeconds": 30, "maxMoveRpm": .6, "speedRpm": .6,
            "dwellSeconds": 1, "rssiTriggerEnabled": True, "points": points, **extra}


class PassReceiver:
    """A stable background, one confirmed echo pass, then stable background."""
    def __init__(self, config):
        pass

    def validate(self):
        pass

    def run(self, stop, ready, receive):
        ready(1000, 1700000000)
        receive(batch([62] * 100 + blade_values(50) + [53] * 50))
        stop.wait(5)


class AutomaticConfigTests(unittest.TestCase):
    def test_geometry_zero_is_actual_six_oclock_and_clockwise_is_left(self):
        geometry = PointCycleGeometry(**GEOMETRY)
        self.assertEqual(geometry.angles(.5, 0), (0, 0))
        self.assertLess(geometry.angles(.5, 90)[1], 0)
        self.assertGreater(geometry.angles(.5, 180)[0], 0)
        opposite = PointCycleGeometry(**{**GEOMETRY, "rotationDirection": "counterclockwise"})
        self.assertGreater(opposite.angles(.5, 90)[1], 0)

    def test_auto_requires_rssi_geometry_unique_consistent_points_and_bounded_speed(self):
        baseline = automatic_config()
        variations = [dict(rssiTriggerEnabled=False), dict(geometry=None), dict(speedRpm=.62),
                      dict(speedRpm=.231, maxMoveRpm=.231),
                      dict(nominalPeriodSeconds=True), dict(mode="unknown")]
        for change in variations:
            with self.subTest(change=change), self.assertRaises(ValueError):
                PointCycleConfig(**{**baseline, **change})
        for field, value in (("axis1AngleDeg", 1), ("bladeId", " "), ("radiusM", True),
                             ("azimuthDeg", 360), ("radialPointId", None)):
            config = copy.deepcopy(baseline)
            config["points"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                PointCycleConfig(**config)
        config = copy.deepcopy(baseline)
        config["points"][1]["pointId"] = config["points"][0]["pointId"]
        with self.assertRaises(ValueError):
            PointCycleConfig(**config)


class AutomaticStationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.motor = FakeMotor()
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temporary.name)), PassReceiver,
                              lambda *args, **kwargs: self.motor)
        self.controller = self.app.state.controller
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()

    def tearDown(self):
        self.controller.stop_event.set()
        if self.controller.thread:
            self.controller.thread.join(5)
        self.client.__exit__(None, None, None)
        self.temporary.cleanup()

    def run_cycle(self, config):
        response = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
                                  "captureSessionId": "a" * 32, "pointCycle": config})
        self.assertEqual(response.status_code, 200, response.text)
        self.controller.thread.join(8)
        self.assertFalse(self.controller.thread.is_alive())
        return self.controller.status()

    def test_configured_order_radial_laps_session_identity_and_no_final_return(self):
        config = automatic_config(radial_points=(("root", .5), ("tip", .8)), cycles=2)
        # A nearest-route optimizer must never be called for an automatic run.
        with patch.object(self.controller, "_plan_point_order", side_effect=AssertionError("reordered")):
            status = self.run_cycle(config)
        self.assertEqual(status["state"], "idle", status)
        records = sorted(self.controller.store.list(), key=lambda r: r["startedAt"])
        self.assertEqual(len(records), 16)
        plan = status["pointCycle"]["plannedStations"]
        expected = [p["pointId"] for p in config["points"]] * 2
        self.assertEqual([r["pointCycle"]["pointId"] for r in records], expected)
        sessions = {r["pointCycle"]["sessionId"] for r in records}
        self.assertEqual(len(sessions), 1)
        for index, record in enumerate(records):
            cycle = record["pointCycle"]
            self.assertEqual(cycle["plannedStations"], plan)
            self.assertEqual(cycle["lapIndex"], index // 8 + 1)
            self.assertEqual(cycle["stationIndex"], index % 4 + 1)
            self.assertEqual(cycle["stationCount"], 4)
            self.assertEqual(cycle["completion"], "confirmed_pass")
            self.assertEqual(cycle["outcome"], "observed")
            self.assertEqual(cycle["identitySource"], "operator_assigned")
            self.assertFalse(cycle["identityVerified"])
            self.assertEqual(cycle["coverageKind"], "sparse_station_passes")
            self.assertNotIn("sessionState", cycle)  # completed manifests never get retroactive updates
            self.assertEqual(record["captureSessionId"], "a" * 32)
            self.assertGreater(cycle["observedSamples"], 0)
            self.assertLess(cycle["entrySampleIndex"], cycle["exitSampleIndex"])
        self.assertAlmostEqual(self.motor.angles[1], config["points"][-1]["axis1AngleDeg"])
        self.assertAlmostEqual(self.motor.angles[2], config["points"][-1]["axis2AngleDeg"])
        completed_manifest = copy.deepcopy(self.controller.writer.manifest)
        self.controller._cycle_update("ready", currentPoint="later station")
        self.controller._cycle_process("later_event")
        self.assertEqual(self.controller.writer.manifest, completed_manifest)
        first_bytes = {r["id"]: (self.controller.store.directory(r["id"]) / "manifest.json").read_bytes()
                       for r in records}
        second = self.run_cycle(automatic_config(azimuths=(0,)))
        self.assertNotIn(second["pointCycle"]["sessionId"], sessions)
        for recording_id, original in first_bytes.items():
            self.assertEqual((self.controller.store.directory(recording_id) / "manifest.json").read_bytes(), original)

    def test_axes_wait_for_real_feedback_arrival_in_sequence_in_all_modes(self):
        calls = []

        class MovingMotor(FakeMotor):
            pending = None
            feedback_polls = 0

            def move_to_angle(self, axis, target, speed_rpm, cancel=None):
                if self.pending is not None:
                    raise AssertionError("concurrent axes")
                calls.append(("command", axis))
                old = self.angles[axis]
                accepted = super().move_to_angle(axis, target, speed_rpm, cancel)
                self.angles[axis] = old
                self.pending = (axis, target)
                self.feedback_polls = 0
                return accepted

            def get_feedback(self, axis):
                result = super().get_feedback(axis)
                if self.pending and self.pending[0] == axis:
                    self.feedback_polls += 1
                    if self.feedback_polls >= 2:
                        self.angles[axis] = self.pending[1]
                        self.pending = None
                        calls.append(("arrived", axis))
                        result = super().get_feedback(axis)
                    else:
                        result = replace(result, motor_rpm=1)
                return result

        self.motor = MovingMotor()
        legacy = PointCycleConfig(port="COM6", points=[{**POINT_REFERENCE, "name": "p",
                                  "axis1AngleDeg": 5, "axis2AngleDeg": 9}])
        reached, completed, _ = self.controller._cycle_move_point(self.motor, legacy, legacy.points[0])
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        self.assertEqual(calls, [("command", 1), ("arrived", 1), ("command", 2), ("arrived", 2)])

    def test_timeout_requires_entry_and_exit_and_never_moves_to_next_station(self):
        for echo, completion in (([62] * 200, "missing_entry"), (blade_values(200), "missing_exit")):
            class Receiver(PassReceiver):
                def run(self, stop, ready, receive):
                    ready(1000, 1700000000)
                    receive(batch(echo))
                    stop.wait(5)
            self.controller.receiver_factory = Receiver
            before = self.motor.start_calls
            status = self.run_cycle(automatic_config())
            self.assertEqual(status["pointCycle"]["state"], "error", status)
            self.assertIn("未自动换点", status["error"])
            self.assertEqual(self.motor.start_calls, before)
            self.assertEqual(status["recording"]["pointCycle"]["completion"], completion)

    def test_missing_rssi_cannot_be_hidden_by_later_valid_pass_in_same_batch(self):
        class Receiver(PassReceiver):
            def run(self, stop, ready, receive):
                ready(1000, 1700000000)
                receive(batch([float("nan")] * 10 + blade_values(50) + [53] * 50))
                stop.wait(5)
        self.controller.receiver_factory = Receiver
        status = self.run_cycle(automatic_config())
        self.assertEqual(status["pointCycle"]["state"], "error", status)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(status["recording"]["pointCycle"]["completion"], "signal_gap")

    def test_simulation_and_missing_motion_confirmation_rejected_before_hardware(self):
        for change in ({"source": "simulation"}, {"confirmMotion": False}):
            response = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
                                      "pointCycle": automatic_config(), **change})
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.motor.start_calls, 0)


if __name__ == "__main__":
    unittest.main()
