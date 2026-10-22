"""Explicit fake hardware fixtures: no device connection or synthesized production fallback."""
from __future__ import annotations

import copy
import math
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import PointCycleConfig, PointCycleGeometry, station_timing_plan, station_move_plan
from test_service import POINT_REFERENCE, START, TOKEN
from test_turntable import FakeMotor
from test_rssi_handoff import batch, blade_values
from laser_fixture import FakeLaserPanel


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


def absolute_geometry_config(*, axis1_sign=1, axis2_sign=1, pitch_offset=0, yaw_offset=0,
                             reference_signature=POINT_REFERENCE["referenceSignature"]):
    """An independently calculated route in the fixture's physical zero frame.

    No current motor angle or laser spot is used to construct these targets.
    Offsets represent an optional measured installation correction, not a new
    protocol: the same existing geometry/point schema must accept both cases.
    """
    distance, height, radius = 2.86, 1.46, .31
    anchor_pitch = axis1_sign * math.degrees(math.atan2(height - radius, distance))
    geometry = dict(distanceM=distance, hubHeightDeltaM=height, rotationDirection="clockwise",
                    axis1Sign=axis1_sign, axis2Sign=axis2_sign, anchorRadiusM=radius,
                    anchorAxis1AngleDeg=anchor_pitch + pitch_offset, anchorAxis2AngleDeg=yaw_offset)
    points = []
    for index, azimuth in enumerate((0, 90, 180, 270), 1):
        phase = math.radians(azimuth)
        x, y = -radius * math.sin(phase), height - radius * math.cos(phase)
        points.append({**POINT_REFERENCE, "referenceSignature": reference_signature,
                       "pointId": f"p1-s{index}", "name": f"P1-{azimuth}",
                       "bladeId": "A", "radialPointId": "p1", "radialPointName": "P1",
                       "radiusM": radius, "azimuthDeg": azimuth,
                       "axis1AngleDeg": round(axis1_sign * math.degrees(math.atan2(y, math.hypot(distance, x))) + pitch_offset, 6),
                       "axis2AngleDeg": round(axis2_sign * math.degrees(math.atan2(x, distance)) + yaw_offset, 6)})
    return automatic_config(geometry=geometry, points=points, collectionId="e" * 32)


class PassReceiver:
    """A stable background, one confirmed echo pass, then stable background."""
    def __init__(self, config):
        pass

    def validate(self):
        pass

    def run(self, stop, ready, receive):
        ready(1000, 1700000000)
        receive(batch([62] * 100 + blade_values(50) + [62] * 50))
        stop.wait(5)


class AutomaticConfigTests(unittest.TestCase):
    def test_move_acceleration_is_validated_and_old_configs_keep_the_original_default(self):
        self.assertEqual(PointCycleConfig(**automatic_config()).maxMoveAccelerationDegS2, 3)
        for value in (True, "30", None, 0, -.1, .099, 120.001, math.nan, math.inf):
            with self.subTest(value=value), self.assertRaises(ValueError):
                PointCycleConfig(**automatic_config(maxMoveAccelerationDegS2=value))

    def test_station_timing_and_wire_points_use_the_configured_acceleration(self):
        for period in (0, 5):
            durations = []
            for acceleration in (3, 30, 120):
                config = PointCycleConfig(**automatic_config(nominalPeriodSeconds=period,
                    speedRpm=5, maxMoveRpm=5, maxMoveAccelerationDegS2=acceleration))
                source, target = config.points[:2]
                start = (source.axis1AngleDeg, source.axis2AngleDeg)
                speed, timing = station_timing_plan(config, start, target, "dual_axis_timed", source)
                points, evidence = station_move_plan(start, (target.axis1AngleDeg, target.axis2AngleDeg),
                                                     speed, acceleration=config.maxMoveAccelerationDegS2)
                self.assertEqual(timing["plannedMoveSeconds"], evidence["plannedSeconds"])
                self.assertEqual(evidence["accelerationLimitDegS2"], acceleration)
                durations.append(evidence["plannedSeconds"])
                for field in ("axis1_deg", "axis2_deg"):
                    velocity, midpoint = 0., 0.
                    for before, after in zip(points, points[1:]):
                        dt = after.time_s - before.time_s
                        next_velocity = (getattr(after, field) - getattr(before, field)) / dt
                        next_midpoint = (after.time_s + before.time_s) / 2
                        self.assertLessEqual(abs(next_velocity), 6 * speed + 1e-8)
                        self.assertLessEqual(abs(next_velocity - velocity) / (next_midpoint - midpoint), acceleration + 1e-8)
                        velocity, midpoint = next_velocity, next_midpoint
                    self.assertLessEqual(abs(velocity) / (points[-1].time_s - midpoint), acceleration + 1e-8)
            self.assertLess(durations[1], durations[0])

    def test_acceleration_is_rounded_down_to_the_controller_header_precision(self):
        for acceleration in (.1009, 3.14159, 119.9999):
            _, evidence = station_move_plan((0, 0), (5, -9), 5, acceleration=acceleration)
            effective = math.floor(acceleration * 1000) / 1000
            self.assertEqual(evidence["accelerationLimitDegS2"], effective)
            self.assertLessEqual(effective, acceleration)

    def test_zero_period_operator_mode_uses_safe_speed_caps_without_phase_budget(self):
        for requested, ceiling, expected in ((.6, .6, .6), (1, 1, 1), (2, 2, 2), (10, 10, 10), (.22, .6, .22), (.38, .39, .38)):
            config = PointCycleConfig(**automatic_config(nominalPeriodSeconds=0, speedRpm=requested, maxMoveRpm=ceiling))
            source, target = config.points[0], config.points[1]
            for mode in ("sequential", "dual_axis_timed"):
                for previous in (None, source, config.points[-1]):
                    speed, evidence = station_timing_plan(config, (0, 0), target, mode, previous)
                    self.assertEqual(speed, expected)
                    self.assertEqual(evidence["timingBasis"], "manual_blade_pass")
                    self.assertEqual(evidence["nominalPeriodSeconds"], 0)
                    self.assertNotIn("moveBudgetSeconds", evidence)
                    self.assertNotIn("nominalIntervalSeconds", evidence)
                    self.assertFalse(evidence["identityVerified"])
        # A low API request cannot be raised just because its maxMoveRpm is higher.
        low = PointCycleConfig(**automatic_config(nominalPeriodSeconds=0, speedRpm=.1, maxMoveRpm=.6))
        self.assertEqual(station_timing_plan(low, (0, 0), low.points[1], "sequential", low.points[0])[0], .1)

    def test_period_zero_is_explicit_and_invalid_small_negative_boolean_or_nonfinite_periods_are_rejected(self):
        self.assertEqual(PointCycleConfig(**automatic_config(nominalPeriodSeconds=0)).nominalPeriodSeconds, 0)
        for period in (-1, .1, True, float("nan"), float("inf")):
            with self.subTest(period=period), self.assertRaises(ValueError):
                PointCycleConfig(**automatic_config(nominalPeriodSeconds=period))

    def test_start_at_current_pose_is_strict_optional_and_only_automatic(self):
        self.assertFalse(PointCycleConfig(**automatic_config()).startAtCurrentPose)
        self.assertTrue(PointCycleConfig(**automatic_config(startAtCurrentPose=True)).startAtCurrentPose)
        for value in (1, 0, "true", "false", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                PointCycleConfig(**automatic_config(startAtCurrentPose=value))
        with self.assertRaisesRegex(ValueError, "仅适用"):
            PointCycleConfig(**automatic_config(mode="legacy", collectionId=None, startAtCurrentPose=True))
        self.assertFalse(PointCycleConfig(**automatic_config(mode="legacy", collectionId=None,
            startAtCurrentPose=False)).startAtCurrentPose)

    def test_existing_geometry_accepts_absolute_zero_frame_and_optional_measured_correction(self):
        for axis1_sign, axis2_sign in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            for pitch_offset, yaw_offset in ((0, 0), (1.25, -2.0)):
                with self.subTest(signs=(axis1_sign, axis2_sign), offset=(pitch_offset, yaw_offset)):
                    config = PointCycleConfig(**absolute_geometry_config(
                        axis1_sign=axis1_sign, axis2_sign=axis2_sign,
                        pitch_offset=pitch_offset, yaw_offset=yaw_offset))
                    expected_pitch = axis1_sign * math.degrees(math.atan2(1.46 - .31, 2.86)) + pitch_offset
                    self.assertAlmostEqual(config.points[0].axis1AngleDeg, expected_pitch, places=5)
                    self.assertAlmostEqual(config.points[0].axis2AngleDeg, yaw_offset, places=5)
                    self.assertNotEqual(config.points[0].axis1AngleDeg, 0)
                    self.assertEqual(config.geometry.anchorRadiusM, .31)

    def test_each_handoff_speed_uses_period_azimuth_gap_and_actual_axis_travel(self):
        config = PointCycleConfig(**automatic_config(azimuths=(0, 30, 180)))
        source, near, far = config.points
        # Equal output travel but a six-times longer rotor interval needs less speed.
        start = (near.axis1AngleDeg - .4, near.axis2AngleDeg)
        short_speed, short = station_timing_plan(config, start, near, "sequential", source)
        long_target = near.model_copy(update={"azimuthDeg": 180})
        long_speed, long = station_timing_plan(config, start, long_target, "sequential", source)
        self.assertGreater(short_speed, long_speed)
        self.assertEqual(short["nominalIntervalSeconds"], 2.5)
        self.assertEqual(long["nominalIntervalSeconds"], 15)
        self.assertEqual(short["moveBudgetSeconds"], 1.25)
        for speed in (short_speed, long_speed):
            self.assertLessEqual(speed, config.speedRpm)
            self.assertAlmostEqual(speed / .02, round(speed / .02))
        faster = config.model_copy(update={"nominalPeriodSeconds": 5})
        speed, timing = station_timing_plan(faster, start, near, "sequential", source)
        self.assertGreater(speed, short_speed)
        self.assertEqual(timing["nominalPeriodSeconds"], 5)

    def test_timing_caps_speed_marks_missed_budget_and_handles_closing_leg(self):
        config = PointCycleConfig(**automatic_config(nominalPeriodSeconds=.5, speedRpm=.1))
        source, target = config.points[-1], config.points[0]
        for mode in ("sequential", "dual_axis_timed"):
            speed, timing = station_timing_plan(config,
                (source.axis1AngleDeg, source.axis2AngleDeg), target, mode, source)
            self.assertEqual(speed, .1)
            self.assertEqual(timing["azimuthGapDeg"], 90)
            self.assertTrue(timing["mayMissNextPass"])
            self.assertFalse(timing["identityVerified"])
        same_speed, same = station_timing_plan(config,
            (target.axis1AngleDeg, target.axis2AngleDeg), target, "sequential", target)
        self.assertEqual(same_speed, .02)
        self.assertEqual(same["azimuthGapDeg"], 360)
        self.assertEqual(same["nominalIntervalSeconds"], .5)

    def test_initial_positioning_and_legacy_multi_group_keep_their_ceiling(self):
        config = PointCycleConfig(**automatic_config(radial_points=(("root", .5), ("tip", .8))))
        first, other = config.points[0], config.points[4]
        for source in (None, other):
            self.assertEqual(station_timing_plan(config, (0, 0), first, "dual_axis_timed", source),
                             (config.speedRpm, None))
        legacy = config.model_copy(update={"mode": "legacy"})
        self.assertEqual(station_timing_plan(legacy, (0, 0), config.points[1], "sequential", first),
                         (config.speedRpm, None))

    def test_collection_id_is_optional_strict_and_does_not_replace_run_identity(self):
        self.assertIsNone(PointCycleConfig(**automatic_config()).collectionId)
        self.assertEqual(PointCycleConfig(**automatic_config(collectionId="c" * 32)).collectionId, "c" * 32)
        for value in ("", "C" * 32, "c" * 32 + "\n", True, 12, "../record"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                PointCycleConfig(**automatic_config(collectionId=value))
        with self.assertRaises(ValueError):
            PointCycleConfig(**automatic_config(mode="legacy", collectionId="c" * 32))

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
        laser_panel = patch("blade_acquisition.service.DevicePanel", FakeLaserPanel)
        laser_panel.start()
        self.addCleanup(laser_panel.stop)
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

    def test_operator_driven_zero_period_keeps_real_rssi_boundaries_laps_and_archive_identity(self):
        result = self.run_cycle(automatic_config(nominalPeriodSeconds=0, cycles=2))
        self.assertEqual(result["state"], "idle", result)
        records = self.controller.store.list()
        self.assertEqual(len(records), 8)
        self.assertEqual({record["pointCycle"]["lapIndex"] for record in records}, {1, 2})
        for record in records:
            meta = record["pointCycle"]
            self.assertEqual(meta["nominalPeriodSeconds"], 0)
            self.assertEqual(meta["completion"], "confirmed_pass")
            self.assertLess(meta["entrySampleIndex"], meta["exitSampleIndex"])
            self.assertEqual(meta["arrivalMove"]["stationTiming"]["timingBasis"], "manual_blade_pass")

    def test_calibrated_first_station_waits_without_motion_and_rechecks_before_daq(self):
        config = absolute_geometry_config(pitch_offset=1.25, yaw_offset=-6)
        config["points"] = config["points"][:1]
        config["startAtCurrentPose"] = True
        first = config["points"][0]
        self.motor.angles = {1: first["axis1AngleDeg"], 2: first["axis2AngleDeg"]}
        class Receiver(PassReceiver):
            def run(receiver, stop, ready, receive):
                self.assertEqual(self.motor.start_calls, 0)
                super(Receiver, receiver).run(stop, ready, receive)
        self.controller.receiver_factory = Receiver
        with patch.object(self.controller, "_cycle_move_point", side_effect=AssertionError("initial movement forbidden")):
            result = self.run_cycle(config)
        self.assertEqual(result["state"], "idle", result)
        self.assertEqual(self.motor.start_calls, 0)
        records = self.controller.store.list()
        self.assertEqual(len(records), 1)
        meta = records[0]["pointCycle"]
        self.assertEqual(meta["firstStationMode"], "hold_current_pose")
        self.assertEqual(meta["completion"], "confirmed_pass")
        evidence = meta["arrivalMove"]
        self.assertFalse(evidence["motionCommanded"])
        self.assertEqual(evidence["state"], "initial_pose_verified")
        self.assertEqual(evidence["plannedSeconds"], 0)
        self.assertEqual(evidence["targets"], [first["axis1AngleDeg"], -6])
        self.assertEqual([item["phase"] for item in evidence["poseChecks"]], ["worker_start", "before_daq"])
        self.assertLess(meta["handoff"]["entryConfirmedSampleIndex"], meta["handoff"]["exitSampleIndex"])

    def test_first_pose_changes_between_frontend_check_worker_and_daq_never_cause_reposition(self):
        for phase in ("before_worker", "during_worker", "before_daq"):
            with self.subTest(phase=phase):
                self.motor = FakeMotor()
                starts = []
                class Receiver(PassReceiver):
                    def run(receiver, stop, ready, receive):
                        starts.append(True)
                        super(Receiver, receiver).run(stop, ready, receive)
                self.controller.receiver_factory = Receiver
                if phase == "before_worker":
                    self.motor.angles[2] = .501
                original = self.controller._cycle_verify_initial_pose
                def verify(motor, cycle, point, step):
                    if phase == "during_worker" and step == "worker_start":
                        motor.angles[1] = .501
                    return original(motor, cycle, point, step)
                create = self.controller.store.create
                def create_record(*args, **kwargs):
                    writer = create(*args, **kwargs)
                    if phase == "before_daq":
                        self.motor.angles[2] = .501
                    return writer
                with patch.object(self.controller, "_cycle_verify_initial_pose", side_effect=verify), \
                     patch.object(self.controller.store, "create", side_effect=create_record), \
                     patch.object(self.controller, "_cycle_move_point", side_effect=AssertionError("must not correct first aim")):
                    result = self.run_cycle(automatic_config(azimuths=(0,), startAtCurrentPose=True))
                self.assertEqual(result["state"], "error", result)
                self.assertIn("首个点位瞄准位置已变化", result["error"])
                self.assertEqual(self.motor.start_calls, 0)
                self.assertEqual(starts, [])
                self.assertEqual(result["pointCycle"]["completedRecords"], 0)
                self.assertTrue(all(record["status"] == "error" for record in self.controller.store.list()))

    def test_first_pose_reference_change_before_daq_is_rejected_without_motion(self):
        create = self.controller.store.create
        def create_record(*args, **kwargs):
            writer = create(*args, **kwargs)
            self.motor.origins[2] += 1
            return writer
        with patch.object(self.controller.store, "create", side_effect=create_record):
            result = self.run_cycle(automatic_config(azimuths=(0,), startAtCurrentPose=True))
        self.assertEqual(result["state"], "error", result)
        self.assertIn("首个点位参考位", result["error"])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(result["pointCycle"]["completedRecords"], 0)

    def test_first_station_moves_only_after_rssi_exit_and_later_lap_returns_normally(self):
        capture_count = []
        class Receiver(PassReceiver):
            def run(receiver, stop, ready, receive):
                capture_count.append(self.motor.start_calls)
                super(Receiver, receiver).run(stop, ready, receive)
        self.controller.receiver_factory = Receiver
        result = self.run_cycle(automatic_config(azimuths=(0, 90), cycles=2, startAtCurrentPose=True))
        self.assertEqual(result["state"], "idle", result)
        self.assertEqual(len(capture_count), 4)
        self.assertEqual(capture_count[0], 0)
        self.assertTrue(all(count > 0 for count in capture_count[1:]))
        records = sorted(self.controller.store.list(), key=lambda record: record["startedAt"])
        self.assertEqual([record["pointCycle"]["lapIndex"] for record in records], [1, 1, 2, 2])
        self.assertFalse(records[0]["pointCycle"]["arrivalMove"]["motionCommanded"])
        self.assertNotIn("motionCommanded", records[2]["pointCycle"]["arrivalMove"])
        self.assertTrue(all(record["pointCycle"]["completion"] == "confirmed_pass" for record in records))

    def test_first_station_hold_requires_confirmed_entry_and_exit_before_any_motion(self):
        class StaticReceiver(PassReceiver):
            def run(receiver, stop, ready, receive):
                ready(1000, 1700000000)
                receive(batch([62] * 200))
                stop.wait(5)
        self.controller.receiver_factory = StaticReceiver
        result = self.run_cycle(automatic_config(azimuths=(0, 90), startAtCurrentPose=True))
        self.assertEqual(result["state"], "error", result)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(result["recording"]["pointCycle"]["completion"], "missing_entry")

    def test_absolute_geometry_positions_from_live_pose_before_receiving_and_preserves_rssi_archive(self):
        events = []
        self.motor.angles = {1: 12.0, 2: 8.0}  # Deliberately not the first optical target.
        self.motor.origins = {1: 137, 2: -29}  # Bound after a fresh read, not a fabricated zero signature.
        signature = "[[137,3,10000,17],[-29,3,10000,17]]"
        config = absolute_geometry_config(reference_signature=signature)
        original_move = self.motor.move_to_angle
        def move(axis, target, speed_rpm, cancel=None):
            events.append(("move", axis, target))
            return original_move(axis, target, speed_rpm, cancel)
        self.motor.move_to_angle = move
        motor = self.motor
        class Receiver(PassReceiver):
            def run(self, stop, ready, receive):
                events.append(("receiver_ready", dict(motor.angles)))
                super().run(stop, ready, receive)
        self.controller.receiver_factory = Receiver
        result = self.run_cycle(config)
        self.assertEqual(result["state"], "idle", result)
        first = config["points"][0]
        self.assertEqual(events[:2], [("move", 1, first["axis1AngleDeg"]),
                                     ("move", 2, first["axis2AngleDeg"])])
        self.assertEqual(events[2], ("receiver_ready", {1: first["axis1AngleDeg"], 2: first["axis2AngleDeg"]}))
        self.assertEqual(self.motor.references, [])  # Template binding never establishes/reset references.
        records = sorted(self.controller.store.list(), key=lambda item: item["startedAt"])
        self.assertEqual(len(records), 4)
        self.assertEqual([record["pointCycle"]["azimuthDeg"] for record in records], [0, 90, 180, 270])
        for record, point in zip(records, config["points"]):
            meta = record["pointCycle"]
            self.assertEqual(record["status"], "complete")
            self.assertEqual(meta["referenceSignature"], signature)
            self.assertEqual(meta["collectionId"], "e" * 32)
            self.assertEqual(meta["actualAngles"], {"1": point["axis1AngleDeg"], "2": point["axis2AngleDeg"]})
            self.assertEqual(meta["completion"], "confirmed_pass")
            self.assertEqual(meta["handoff"]["reason"], "blade_left")
            self.assertLess(meta["handoff"]["entryConfirmedSampleIndex"], meta["handoff"]["exitSampleIndex"])
            self.assertEqual(meta["handoff"]["stationarySamples"], record["samples"])
        self.assertEqual(records[0]["pointCycle"]["arrivalMove"]["targets"],
                         [first["axis1AngleDeg"], first["axis2AngleDeg"]])

    def test_absolute_geometry_keeps_reference_motion_fault_and_full_route_limit_checks(self):
        for failure in ("changed_reference", "future_station_softlimit", "missing_reference",
                        "softlimit_disabled", "driver_alarm", "already_moving"):
            with self.subTest(failure=failure):
                self.motor = FakeMotor(angles={1: 12.0, 2: 8.0})
                if failure == "changed_reference":
                    self.motor.origins[2] = 123
                elif failure == "future_station_softlimit":
                    # First pitch is inside 25°, but a later station exceeds it:
                    # reject the entire route before moving the otherwise legal first leg.
                    self.motor.guard_configs[1] = replace(self.motor.get_guard_config(1), maximum_deg=25)
                elif failure == "missing_reference":
                    self.motor.reference_valid = False
                elif failure == "softlimit_disabled":
                    self.motor.soft_enabled = False
                elif failure == "driver_alarm":
                    self.motor.alarm_code = 2
                elif failure == "already_moving":
                    self.motor.started = True
                result = self.run_cycle(absolute_geometry_config())
                self.assertEqual(result["state"], "error", result)
                self.assertEqual(self.motor.start_calls, 0)
                self.assertEqual(self.motor.references, [])
                self.assertEqual(self.controller.store.list(), [])

    def test_manual_radial_runs_share_task_but_keep_separate_sessions_plans_and_files(self):
        collection_id = "c" * 32
        first = self.run_cycle(automatic_config(collectionId=collection_id))
        original = self.controller.store.list()
        original_files = {r["id"]: (self.controller.store.directory(r["id"]) / "manifest.json").read_bytes()
                          for r in original}
        second = self.run_cycle(automatic_config(radial_points=(("tip", .8),), collectionId=collection_id))
        self.assertEqual(first["pointCycle"]["collectionId"], collection_id)
        self.assertEqual(second["pointCycle"]["collectionId"], collection_id)
        self.assertNotEqual(first["pointCycle"]["sessionId"], second["pointCycle"]["sessionId"])
        records = self.controller.store.list()
        self.assertEqual(len(records), 8)
        for record in records:
            meta = record["pointCycle"]
            self.assertEqual(meta["collectionId"], collection_id)
            self.assertEqual(len(meta["plannedStations"]), 4)
            self.assertTrue(all(p["radialPointId"] == meta["radialPointId"] for p in meta["plannedStations"]))
            self.assertEqual(meta["stationCount"], 4)
            self.assertEqual(meta["sessionId"], (first if meta["radialPointId"] == "root" else second)["pointCycle"]["sessionId"])
        for record_id, data in original_files.items():
            self.assertEqual((self.controller.store.directory(record_id) / "manifest.json").read_bytes(), data)

    def test_each_selected_blade_point_archives_two_rounds_and_keeps_other_blades_separate(self):
        collection = "d" * 32
        first = self.run_cycle(automatic_config(collectionId=collection, cycles=2, azimuths=(0, 30, 180)))
        first_records = self.controller.store.list()
        first_bytes = {r["id"]: (self.controller.store.directory(r["id"]) / "manifest.json").read_bytes()
                       for r in first_records}
        second_config = automatic_config(collectionId=collection, radial_points=(("root", .5),), azimuths=(0, 90))
        for point in second_config["points"]:
            point["bladeId"] = "B"
        second = self.run_cycle(second_config)
        self.assertEqual((first["state"], second["state"]), ("idle", "idle"))
        self.assertEqual(first["pointCycle"]["completedRecords"], 6)
        self.assertEqual(second["pointCycle"]["completedRecords"], 2)
        records = self.controller.store.list()
        self.assertEqual(len(records), 8)
        by_blade = {blade: [r for r in records if r["pointCycle"]["bladeId"] == blade] for blade in ("A", "B")}
        self.assertEqual([len(by_blade[b]) for b in ("A", "B")], [6, 2])
        for blade, blade_records in by_blade.items():
            for record in blade_records:
                meta = record["pointCycle"]
                self.assertEqual(meta["collectionId"], collection)
                self.assertEqual(record["turbine"], START["turbine"])
                self.assertEqual(meta["radialPointId"], "root")
                self.assertTrue(all(p["bladeId"] == blade for p in meta["plannedStations"]))
                self.assertEqual(meta["completion"], "confirmed_pass")
                self.assertLess(meta["entrySampleIndex"], meta["exitSampleIndex"])
                self.assertEqual(meta["handoff"]["stationarySamples"], record["samples"])
        self.assertNotEqual(first["pointCycle"]["sessionId"], second["pointCycle"]["sessionId"])
        self.assertEqual({r["pointCycle"]["lapIndex"] for r in by_blade["A"]}, {1, 2})
        timings = [r["pointCycle"]["arrivalMove"].get("stationTiming") for r in by_blade["A"]]
        self.assertTrue(any(t and t["azimuthGapDeg"] == 30 for t in timings))
        self.assertTrue(any(t and t["azimuthGapDeg"] == 150 for t in timings))
        for record_id, content in first_bytes.items():
            self.assertEqual((self.controller.store.directory(record_id) / "manifest.json").read_bytes(), content)

    def test_sequential_motor_commands_use_calculated_segment_speed(self):
        speeds = []
        original = self.motor.move_to_angle
        def command(axis, target, speed_rpm, cancel=None):
            speeds.append(speed_rpm)
            return original(axis, target, speed_rpm, cancel)
        self.motor.move_to_angle = command
        config = PointCycleConfig(**automatic_config(azimuths=(0, 30, 180)))
        source, target = config.points[:2]
        start = (self.motor.angles[1], self.motor.angles[2])
        expected, timing = station_timing_plan(config, start, target, "sequential", source)
        reached, _, _ = self.controller._cycle_move_point(self.motor, config, target, source_point=source)
        self.assertTrue(reached)
        self.assertTrue(speeds)
        self.assertTrue(all(speed == expected for speed in speeds))
        last_move = self.controller.turntable_snapshot["lastMove"]
        self.assertEqual(last_move["speedLimitRpm"], expected)
        self.assertEqual(last_move["stationTiming"], timing)
        self.assertLessEqual(last_move["speedLimitRpm"], config.speedRpm)

    def test_capture_at_prepositioned_point_repeatedly_remains_read_only(self):
        config = PointCycleConfig(**automatic_config(followErrorLimitDeg=2.4))
        point = config.points[0]
        self.motor.angles = {1: point.axis1AngleDeg + .5, 2: point.axis2AngleDeg - .5}
        with patch.object(self.controller, "_execute_drive_position", side_effect=AssertionError("duplicate positioning")), \
             patch.object(self.controller, "_execute_dual_axis_move", side_effect=AssertionError("duplicate trajectory")):
            for _ in range(2):
                reached, completed, _ = self.controller._cycle_move_point(self.motor, config, point)
                self.assertTrue(reached)
                self.assertEqual(completed, [1, 2])
                self.assertFalse(self.controller.turntable_snapshot["lastMove"]["motionCommanded"])
        self.assertEqual(self.motor.start_calls, 0)

    def test_native_capture_threads_configured_motion_error_limit(self):
        config = PointCycleConfig(**automatic_config(followErrorLimitDeg=2.4))
        self.motor.angles[1] = -2
        self.motor._blade_motion_capability = {"supported": True, "mode": "dual_axis_timed", "pointMode": "drive_internal"}
        with patch.object(self.controller, "_execute_drive_position", return_value=(True, [1, 2], {})) as move:
            self.controller._cycle_move_point(self.motor, config, config.points[0])
        self.assertEqual(move.call_args.kwargs["follow_error_limit"], 2.4)

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
        for echo, completion in (([62] * 200, "missing_entry"), ([62] * 100 + blade_values(200), "missing_exit")):
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
