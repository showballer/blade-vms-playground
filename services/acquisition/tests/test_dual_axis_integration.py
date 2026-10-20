"""Protocol-adapter fixtures only: no serial port, device, or laser is opened."""
from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import MotionGuard, PointCycleConfig, TurntableRequest, station_move_plan, station_timing_plan
from blade_acquisition.turntable_driver import TrajectoryStatus, MotorController, MotorError, TrajectoryPoint
from blade_acquisition.turntable_driver.trajectory import AxisPosition
from test_turntable import FakeMotor
from test_automatic_stations import PassReceiver, automatic_config
from test_service import POINT_REFERENCE, START, TOKEN
from laser_fixture import FakeLaserPanel


class BufferedMotor(FakeMotor):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.points = ()
        self.fail_start = self.fail_stop = self.cancel_wait = self.change_reference = self.change_prepare_reference = False
        self.cancel = None
        self.initial_state = 0
        self.position_calls = []

    def get_axis_positions(self):
        self.position_calls.append("get")
        result = []
        for axis in (1, 2):
            guard = self.guard_configs.get(axis)
            soft = guard.soft_enabled if guard else self.soft_enabled
            result.append(AxisPosition(self.angles[axis] if self.reference_valid else None,
                round(self.angles[axis] * 500000 / 360),
                round(self.actual_rpm * 50) if self.started and axis == self.active_axis else 0,
                (1 if self.reference_valid else 0) | (2 if soft else 0), 0, 0, 0, 1))
        return tuple(result)

    def probe_axis_positions(self):
        self.position_calls.append("probe")
        return self.get_axis_positions()

    def status(self, state):
        return TrajectoryStatus(42, state, 0, len(self.points), len(self.points),
                                self.points[-1].time_s if self.points else 0,
                                self.points[-1].time_s if self.points else 0,
                                250, 250, self.angles[1], self.angles[2], 0, 0)

    def probe_trajectory(self):
        self.calls.append("probe")
        return self.status(self.initial_state)

    def get_trajectory_status(self):
        return self.status(self.initial_state)

    def prepare_trajectory(self, points, **kwargs):
        self.calls.append("prepare")
        self.points = points
        self.cancel = kwargs["cancel"]
        self.options = kwargs
        if self.change_prepare_reference:
            self.origins[2] += 1
        return self.status(2)

    def start_trajectory(self, session, **kwargs):
        self.calls.append("start")
        if self.fail_start:
            raise RuntimeError("lost start acknowledgment")
        return self.status(3)

    def wait_trajectory(self, session, **kwargs):
        self.calls.append("wait")
        kwargs["on_status"](self.status(3))
        if self.cancel_wait:
            self.cancel.set()
            raise RuntimeError("cancelled")
        self.angles = {1: self.points[-1].axis1_deg, 2: self.points[-1].axis2_deg}
        if self.change_reference:
            self.origins[2] += 1
        return self.status(6)

    def stop_trajectory(self, **kwargs):
        self.calls.append("group_stop")
        if self.fail_stop:
            raise RuntimeError("stop timeout")
        self.started = False
        return self.status(8)


class DualAxisIntegrationTests(unittest.TestCase):
    def setUp(self):
        laser_panel = patch("blade_acquisition.service.DevicePanel", FakeLaserPanel)
        laser_panel.start()
        self.addCleanup(laser_panel.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.motor = BufferedMotor()
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), PassReceiver,
                              lambda *args, **kwargs: self.motor)
        self.controller = self.app.state.controller
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()

    def tearDown(self):
        self.controller.stop_event.set()
        if self.controller.thread:
            self.controller.thread.join(5)
        if self.controller.test_thread:
            self.controller.test_thread.join(5)
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def point(self, a1=5, a2=9):
        config = PointCycleConfig(port="COM6", points=[{**POINT_REFERENCE, "name": "P1",
                                 "axis1AngleDeg": a1, "axis2AngleDeg": a2}])
        return config, config.points[0]

    def move(self):
        config, point = self.point()
        return self.controller._cycle_move_point(self.motor, config, point)

    def test_probe_reads_capability_without_any_motion_write(self):
        result = self.client.post("/api/field/turntable", json={"action": "probe", "port": "COM6"})
        self.assertEqual(result.status_code, 200, result.text)
        capability = result.json()["turntable"]["motionCapability"]
        self.assertTrue(capability["supported"])
        self.assertEqual(capability["probe"], "confirmed")
        self.assertEqual(capability["mode"], "dual_axis_timed")
        self.assertEqual(self.motor.calls, ["probe"])
        self.assertEqual(self.motor.start_calls, 0)

    def test_unreadable_capability_never_falls_back_or_writes(self):
        def timeout():
            raise RuntimeError("query timeout")
        self.motor.probe_trajectory = timeout
        with self.assertRaisesRegex(RuntimeError, "query timeout"):
            self.move()
        self.assertEqual(self.motor.calls, [])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_definitive_unsupported_command_preserves_legacy_sequential_path(self):
        self.motor.probe_trajectory = lambda: None
        reached, completed, _ = self.move()
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        self.assertEqual(self.motor.start_calls, 2)
        self.assertEqual(self.motor.calls, [])
        self.assertEqual(self.controller.turntable_snapshot["motionMode"], "sequential")

    def test_existing_buffer_is_not_replaced_by_automatic_move(self):
        self.motor.initial_state = 2
        with self.assertRaisesRegex(RuntimeError, "已有待启动"):
            self.move()
        self.assertEqual(self.motor.calls, ["probe"])

    def test_health_reports_faulted_trajectory_without_cancelling_the_buffer(self):
        self.motor.initial_state = 7
        original = self.motor.status
        self.motor.status = lambda state: replace(original(state), fault=7)
        result = self.client.post("/api/field/turntable", json={"action": "health", "port": "COM6", "axis": 1})
        self.assertEqual(result.status_code, 200, result.text)
        snapshot = result.json()["turntable"]
        self.assertEqual(snapshot["motionCapability"]["status"]["fault"], 7)
        self.assertEqual(snapshot["health"]["axes"]["2"]["alarmCode"], 0)
        self.assertEqual(self.motor.calls, ["probe"])
        self.assertEqual(self.motor.start_calls, 0)

    def test_state_is_refreshed_after_capability_was_cached(self):
        self.controller._motion_capability(self.motor)
        self.motor.initial_state = 2
        with self.assertRaisesRegex(RuntimeError, "已有待启动"):
            self.move()
        self.assertEqual(self.motor.calls, ["probe"])

    def test_one_buffer_controls_both_axes_and_persists_stop_verified_evidence(self):
        reached, completed, feedback = self.move()
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        self.assertEqual(self.motor.calls, ["probe", "prepare", "start", "wait"])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(self.motor.angles, {1: 5, 2: 9})
        evidence = self.controller.turntable_snapshot["lastMove"]
        self.assertEqual(evidence["state"], "complete")
        self.assertFalse(evidence["measurementDuringMotion"])
        self.assertEqual(evidence["status"]["state"], 6)
        self.assertEqual(self.motor.options["max_speed"], 3)
        self.assertTrue(self.motor.options["adaptive"])
        self.assertEqual(self.motor.options["cycle_ms"], 100)
        self.assertEqual(self.motor.options["max_error"], .75)
        self.assertEqual(self.motor.options["tolerance"], .1)
        self.assertEqual(evidence["waitTimeoutSeconds"], evidence["plannedSeconds"] * 4 + 35)
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_adaptive_delay_keeps_waiting_without_starting_daq_or_restarting_motion(self):
        original = self.motor.wait_trajectory
        def delayed(session, **kwargs):
            plan = self.controller.turntable_snapshot["lastMove"]
            # Past the former plan+15 timeout, but still within app(3)'s bound.
            elapsed = plan["plannedSeconds"] + 20
            self.assertGreater(kwargs["timeout"], elapsed)
            kwargs["on_status"](replace(self.motor.status(3), elapsed_s=elapsed))
            self.assertEqual(self.controller.turntable_snapshot["state"], "positioning")
            self.assertFalse(self.controller.status()["receiver"]["running"])
            self.assertEqual(self.controller.store.list(), [])
            return original(session, **kwargs)
        self.motor.wait_trajectory = delayed
        reached, completed, _ = self.move()
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        self.assertEqual(self.motor.calls.count("start"), 1)

    def test_follow_error_protection_remains_and_reports_actual_axis_error(self):
        def failed(session, **kwargs):
            kwargs["on_status"](replace(self.motor.status(5), fault=7, error1_deg=.817, error2_deg=-.003))
            raise MotorError("轨迹两轴停止确认：跟随误差超限")
        self.motor.wait_trajectory = failed
        with self.assertRaisesRegex(RuntimeError, r"俯仰轴误差 0.817°.*保护限 0.75°"):
            self.move()
        self.assertEqual(self.motor.calls.count("start"), 1)
        self.assertEqual(self.motor.calls[-1], "group_stop")
        self.assertEqual(self.motor.options["max_error"], .75)
        self.assertFalse(self.controller.status()["receiver"]["running"])
        self.assertEqual(self.controller.store.list(), [])

    def test_configured_follow_limit_is_validated_and_fault_reports_the_sent_value(self):
        for limit in (0, .499, 10.001, True, "1", None, float("inf"), float("nan")):
            with self.subTest(limit=limit):
                with self.assertRaises(ValueError):
                    TurntableRequest(port="COM6", followErrorLimitDeg=limit)
                with self.assertRaises(ValueError):
                    PointCycleConfig(port="COM6", points=[{**POINT_REFERENCE, "name": "P1",
                        "axis1AngleDeg": 5, "axis2AngleDeg": 9}], followErrorLimitDeg=limit)
        self.assertEqual(TurntableRequest(port="COM6").followErrorLimitDeg, .75)
        cycle, point = self.point()
        cycle.followErrorLimitDeg = 1.2
        def failed(session, **kwargs):
            kwargs["on_status"](replace(self.motor.status(5), fault=7, error1_deg=1.224, error2_deg=.013))
            raise MotorError("controller follow error")
        self.motor.wait_trajectory = failed
        with self.assertRaisesRegex(RuntimeError, r"1.224°.*保护限 1.2°.*清除旧轨迹"):
            self.controller._cycle_move_point(self.motor, cycle, point)
        self.assertEqual(self.motor.options["max_error"], 1.2)
        self.assertEqual(self.motor.options["tolerance"], .1)
        self.assertEqual(self.motor.calls.count("start"), 1)
        self.assertFalse(self.controller.status()["receiver"]["running"])

    def test_real_soft_bound_is_checked_before_trajectory_upload(self):
        self.motor.guard_configs[2] = replace(self.motor.get_guard_config(2), minimum_deg=-3, maximum_deg=3)
        with self.assertRaisesRegex(RuntimeError, "软限位"):
            self.move()
        self.assertEqual(self.motor.calls, [])

    def test_lost_start_ack_stops_group_and_never_falls_back_to_single_axis(self):
        self.motor.fail_start = True
        with self.assertRaisesRegex(RuntimeError, "lost start"):
            self.move()
        self.assertEqual(self.motor.calls, ["probe", "prepare", "start", "group_stop"])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_uncertain_group_stop_survives_and_requires_both_axis_recovery(self):
        self.motor.fail_start = self.motor.fail_stop = True
        with self.assertRaisesRegex(RuntimeError, "lost start"):
            self.move()
        persisted = json.loads(self.controller.motion_guard.path.read_text())
        self.assertTrue(persisted["uncertain"])
        self.assertEqual(persisted["pendingAxes"], [1, 2])
        self.assertEqual(persisted["motionMode"], "dual_axis_timed")
        # A new service process reloads the durable group marker. Old single-point
        # preparation must not overwrite it or start a receiver/serial session.
        self.controller.motion_guard = MotionGuard(Path(self.temp.name))
        from test_single_point_service import config as single_point_config
        before_calls = list(self.motor.calls)
        older = self.client.post("/api/field/single-point", json={
            "action": "prepare", "sessionId": uuid.uuid4().hex, "commandId": uuid.uuid4().hex,
            "config": single_point_config(), "capture": {"name": "guard fixture", "port": "COM6",
            "deviceIp": "192.168.106.90", "hostIp": "192.168.106.10"},
            "confirmLaser": True, "confirmStaticPoint": True, "confirmGeometry": True})
        self.assertEqual(older.status_code, 409, older.text)
        self.assertEqual(self.motor.calls, before_calls)
        self.assertEqual(json.loads(self.controller.motion_guard.path.read_text()), persisted)
        probe = self.client.post("/api/field/turntable", json={"action": "probe", "port": "COM6",
                                 "confirmRecovery": True})
        self.assertEqual(probe.status_code, 503)
        self.assertIsNotNone(self.controller.motion_guard.warning)
        self.motor.fail_stop = False
        result = self.client.post("/api/field/turntable", json={"action": "stop", "port": "COM6",
                                  "axis": 2, "confirmMotion": True})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.motor.calls[-1], "group_stop")
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_cancel_stops_both_axes_without_queueing_another_move(self):
        self.motor.cancel_wait = True
        reached, completed, _ = self.move()
        self.assertFalse(reached)
        self.assertEqual(completed, [])
        self.assertEqual(self.motor.calls[-1], "group_stop")
        self.assertEqual(self.motor.start_calls, 0)
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_changed_reference_after_done_rejects_arrival(self):
        self.motor.change_reference = True
        with self.assertRaisesRegex(RuntimeError, "参考位"):
            self.move()
        self.assertEqual(self.motor.calls[-1], "group_stop")

    def test_changed_reference_during_prepare_is_rejected_before_start(self):
        self.motor.change_prepare_reference = True
        with self.assertRaisesRegex(RuntimeError, "未启动双轴运动"):
            self.move()
        self.assertEqual(self.motor.calls, ["probe", "prepare", "group_stop"])
        self.assertEqual(self.motor.start_calls, 0)

    def test_manual_recall_shares_dual_axis_execution(self):
        result = self.client.post("/api/field/turntable", json={"action": "recall", "port": "COM6",
                                  "recordedPort": "COM6", "confirmMotion": True,
                                  "referenceSignature": POINT_REFERENCE["referenceSignature"],
                                  "axis1AngleDeg": 1, "axis2AngleDeg": 2})
        self.assertEqual(result.status_code, 200, result.text)
        self.controller.test_thread.join(5)
        recall = self.controller.status()["turntable"]["recall"]
        self.assertEqual(recall["state"], "complete")
        self.assertEqual(recall["motionMode"], "dual_axis_timed")
        self.assertEqual(recall["completedAxes"], [1, 2])
        self.assertEqual(recall["lastMove"]["state"], "complete")
        self.assertEqual(self.motor.options["max_accel"], 3)

    def test_manual_origin_return_uses_requested_speed_acceleration_and_keeps_target(self):
        for speed, acceleration, follow_limit in ((5, 30, .75), (1, 10, .5), (5, 90, 1.2), (10, 120, 10)):
            self.motor = BufferedMotor()
            result = self.client.post("/api/field/turntable", json={"action": "recall", "port": "COM6",
                "recordedPort": "COM6", "confirmMotion": True, "speedRpm": speed,
                "maxMoveAccelerationDegS2": acceleration, "followErrorLimitDeg": follow_limit,
                "referenceSignature": POINT_REFERENCE["referenceSignature"],
                "axis1AngleDeg": 5, "axis2AngleDeg": 9})
            self.assertEqual(result.status_code, 200, result.text)
            self.controller.test_thread.join(5)
            recall = self.controller.status()["turntable"]["recall"]
            self.assertEqual(recall["state"], "complete")
            self.assertEqual(self.motor.options["max_speed"], speed * 6)
            self.assertEqual(self.motor.options["max_accel"], acceleration)
            self.assertEqual(self.motor.options["max_error"], follow_limit)
            self.assertEqual(self.motor.options["tolerance"], .1)
            self.assertEqual(recall["lastMove"]["followErrorLimitDeg"], follow_limit)
            expected, evidence = station_move_plan((0, 0), (5, 9), speed, acceleration=acceleration)
            self.assertEqual(self.motor.points, expected)
            self.assertEqual(recall["lastMove"]["plannedSeconds"], evidence["plannedSeconds"])
            self.assertEqual(recall["lastMove"]["accelerationLimitDegS2"], acceleration)
            self.assertEqual(self.motor.angles, {1: 5, 2: 9})
            self.assertIsNone(self.controller.motion_guard.warning)
            self.assertEqual(self.controller.store.list(), [])

    def test_dual_recall_accepts_axis2_reference_without_soft_range(self):
        self.motor.guard_configs[2] = replace(self.motor.get_guard_config(2), soft_enabled=False,
                                             minimum_deg=0, maximum_deg=0)
        result = self.client.post("/api/field/turntable", json={"action": "recall", "port": "COM6",
                                  "recordedPort": "COM6", "confirmMotion": True,
                                  "referenceSignature": POINT_REFERENCE["referenceSignature"],
                                  "axis1AngleDeg": 1, "axis2AngleDeg": 2})
        self.assertEqual(result.status_code, 200, result.text)
        self.controller.test_thread.join(5)
        status = self.controller.status()
        self.assertEqual(status["turntable"]["recall"]["state"], "complete", status)
        self.assertEqual(self.motor.angles, {1: 1, 2: 2})
        self.assertFalse(self.motor.get_guard_config(2).soft_enabled)
        self.assertEqual(self.motor.get_feedback(2).flags, 1)
        self.assertEqual(self.motor.references, [])

    def test_dual_automatic_stations_accept_optional_axis2_soft_without_changing_guards(self):
        self.motor.guard_configs[2] = replace(self.motor.get_guard_config(2), soft_enabled=False,
                                             minimum_deg=0, maximum_deg=0)
        result = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
                                  "captureSessionId": "a" * 32, "pointCycle": automatic_config()})
        self.assertEqual(result.status_code, 200, result.text)
        self.controller.thread.join(8)
        status = self.controller.status()
        self.assertEqual(status["state"], "idle", status)
        records = self.controller.store.list()
        self.assertEqual(len(records), 4)
        self.assertTrue(all(record["pointCycle"]["completion"] == "confirmed_pass" for record in records))
        self.assertEqual(self.motor.calls.count("start"), 3)
        self.assertFalse(self.motor.get_guard_config(2).soft_enabled)
        self.assertEqual(self.motor.references, [])

    def test_calibrated_first_station_never_uploads_or_starts_a_trajectory(self):
        result = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
            "pointCycle": automatic_config(azimuths=(0,), startAtCurrentPose=True)})
        self.assertEqual(result.status_code, 200, result.text)
        self.controller.thread.join(5)
        status = self.controller.status()
        self.assertEqual(status["state"], "idle", status)
        self.assertEqual(self.motor.calls, ["probe"])
        self.assertEqual(self.motor.start_calls, 0)
        evidence = self.controller.store.list()[0]["pointCycle"]["arrivalMove"]
        self.assertFalse(evidence["motionCommanded"])
        self.assertEqual(evidence["mode"], "dual_axis_timed")

    def test_first_station_hold_rejects_pending_active_or_faulted_trajectory(self):
        for state, fault in ((1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (7, 1), (8, 13)):
            with self.subTest(state=state, fault=fault):
                self.motor = BufferedMotor()
                self.motor.initial_state = state
                original = self.motor.status
                self.motor.status = lambda observed_state: replace(original(observed_state), fault=fault)
                result = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
                    "pointCycle": automatic_config(azimuths=(0,), startAtCurrentPose=True)})
                self.assertEqual(result.status_code, 200, result.text)
                self.controller.thread.join(5)
                status = self.controller.status()
                self.assertEqual(status["state"], "error", status)
                self.assertIn("控制器轨迹", status["error"])
                self.assertEqual(self.motor.calls, ["probe"])
                self.assertEqual(self.motor.start_calls, 0)
                self.assertEqual(self.controller.store.list(), [])

    def test_first_station_rechecks_fresh_trajectory_state_before_daq_after_cached_capability(self):
        for state, fault in ((2, 0), (3, 0), (8, 13)):
            with self.subTest(state=state, fault=fault):
                self.motor = BufferedMotor()
                self.controller._motion_capability(self.motor)
                original_status = self.motor.status
                current_fault = [0]
                self.motor.status = lambda observed_state: replace(original_status(observed_state), fault=current_fault[0])
                create = self.controller.store.create
                def create_record(*args, **kwargs):
                    writer = create(*args, **kwargs)
                    self.motor.initial_state = state
                    current_fault[0] = fault
                    return writer
                starts = []
                class Receiver(PassReceiver):
                    def run(receiver, stop, ready, receive):
                        starts.append(True)
                        super(Receiver, receiver).run(stop, ready, receive)
                self.controller.receiver_factory = Receiver
                with patch.object(self.controller.store, "create", side_effect=create_record):
                    result = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
                        "pointCycle": automatic_config(azimuths=(0,), startAtCurrentPose=True)})
                    self.assertEqual(result.status_code, 200, result.text)
                    self.controller.thread.join(5)
                status = self.controller.status()
                self.assertEqual(status["state"], "error", status)
                self.assertIn("控制器轨迹", status["error"])
                self.assertEqual(starts, [])
                self.assertEqual(self.motor.calls, ["probe"])
                self.assertEqual(self.motor.start_calls, 0)
                self.assertEqual(status["pointCycle"]["completedRecords"], 0)
                self.assertTrue(all(record["status"] == "error" for record in self.controller.store.list()))

    def test_automatic_pass_boundaries_and_one_radial_point_records_are_preserved(self):
        result = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
                                  "captureSessionId": "a" * 32, "pointCycle": automatic_config()})
        self.assertEqual(result.status_code, 200, result.text)
        self.controller.thread.join(8)
        status = self.controller.status()
        self.assertEqual(status["state"], "idle", status)
        records = self.controller.store.list()
        self.assertEqual(len(records), 4)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(self.motor.calls.count("probe"), 1)
        for record in records:
            cycle = record["pointCycle"]
            self.assertEqual(cycle["motionMode"], "dual_axis_timed")
            self.assertEqual(cycle["coverageKind"], "sparse_station_passes")
            self.assertEqual(cycle["completion"], "confirmed_pass")
            self.assertFalse(cycle["arrivalMove"]["measurementDuringMotion"])
            self.assertEqual(cycle["radialPointId"], "root")
            self.assertLess(cycle["handoff"]["entryConfirmedSampleIndex"], cycle["handoff"]["exitSampleIndex"])

    def test_configured_acceleration_reaches_initial_handoff_and_origin_return(self):
        self.motor.angles = {1: 1, 2: 1}
        prepared = []
        prepare = self.motor.prepare_trajectory
        def observe(points, **kwargs):
            prepared.append((kwargs["max_accel"], kwargs["max_error"], kwargs["tolerance"]))
            return prepare(points, **kwargs)
        self.motor.prepare_trajectory = observe
        config = automatic_config(nominalPeriodSeconds=0, speedRpm=5, maxMoveRpm=5,
            maxMoveAccelerationDegS2=30, followErrorLimitDeg=1.2,
            returnToOrigin={**POINT_REFERENCE, "name": "origin", "axis1AngleDeg": 0, "axis2AngleDeg": 0})
        result = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
                                  "captureSessionId": "b" * 32, "pointCycle": config})
        self.assertEqual(result.status_code, 200, result.text)
        self.controller.thread.join(8)
        status = self.controller.status()
        self.assertEqual(status["state"], "idle", status)
        self.assertEqual(status["pointCycle"]["state"], "complete", status)
        self.assertEqual(self.motor.angles, {1: 0, 2: 0})
        self.assertEqual(prepared, [(30, 1.2, .1)] * 5, "Initial, three handoffs and normal return all use the saved values")
        self.assertEqual(status["pointCycle"]["lastMove"]["accelerationLimitDegS2"], 30)
        records = self.controller.store.list()
        self.assertEqual(len(records), 4, "Return does not create a measurement record")
        for record in records:
            self.assertEqual(record["pointCycle"]["completion"], "confirmed_pass")
            self.assertEqual(record["pointCycle"]["arrivalMove"]["accelerationLimitDegS2"], 30)
            self.assertEqual(record["pointCycle"]["arrivalMove"]["followErrorLimitDeg"], 1.2)

    def test_dynamic_station_speed_reaches_controller_and_quantized_evidence(self):
        config = PointCycleConfig(**automatic_config(azimuths=(0, 30, 180)))
        source, target = config.points[:2]
        start = (self.motor.angles[1], self.motor.angles[2])
        speed, timing = station_timing_plan(config, start, target, "dual_axis_timed", source)
        reached, completed, _ = self.controller._cycle_move_point(self.motor, config, target, source_point=source)
        self.assertTrue(reached)
        self.assertEqual(completed, [1, 2])
        self.assertAlmostEqual(self.motor.options["max_speed"], speed * 6)
        evidence = self.controller.turntable_snapshot["lastMove"]
        self.assertEqual(evidence["stationTiming"], timing)
        self.assertEqual(evidence["speedLimitRpm"], speed)
        for before, after in zip(self.motor.points, self.motor.points[1:]):
            for axis in ("axis1_deg", "axis2_deg"):
                self.assertLessEqual(abs(getattr(after, axis) - getattr(before, axis)) /
                                     (after.time_s - before.time_s), speed * 6 + 1e-9)


class OptionalHorizontalSoftDriverTests(unittest.TestCase):
    """Exercise actual SDK PREPARE/START/WAIT with in-memory serial responses."""
    def setUp(self):
        from test_buffered_trajectory import SerialFixture
        self.serial = SerialFixture()
        self.serial.flags[2] = 1
        self.motor = MotorController("TEST", timeout=.02,
            serial_factory=lambda *_args, **_kwargs: self.serial).connect()
        self.addCleanup(lambda: self.motor.close(stop=False))
        fixture = FakeMotor()
        self.guards = {1: fixture.get_guard_config(1), 2: replace(fixture.get_guard_config(2),
            soft_enabled=False, minimum_deg=0, maximum_deg=0)}
        self.motor.get_guard_config = lambda axis: self.guards[axis]
        self.points = (TrajectoryPoint(0, 10, 0), TrajectoryPoint(2, 10.2, .2))

    def test_sdk_prepare_start_and_wait_accept_axis2_flags1_with_soft_off(self):
        prepared = self.motor.prepare_trajectory(self.points, session=17)
        self.assertEqual(prepared.state, 2)
        self.assertEqual(self.motor.start_trajectory(17).state, 3)
        self.serial.finish_on_renew = True
        complete = self.motor.wait_trajectory(17, timeout=1)
        self.assertEqual(complete.state, 6)
        self.assertEqual(self.serial.angles, {1: 10.2, 2: .2})
        self.assertFalse(self.guards[2].soft_enabled)
        commands = [frame[4] for frame in self.serial.frames]
        self.assertEqual(commands.count(0x33), 1)
        self.assertFalse(any(command in (0x21, 0x22) for command in commands))

    def test_sdk_optional_axis2_soft_never_bypasses_other_preparation_checks(self):
        from test_buffered_trajectory import BEGIN
        for failure in ("axis1_soft_off", "axis2_enabled_range", "axis2_invalid_range",
                        "axis2_missing_reference", "axis2_pending", "axis2_moving", "axis2_outside_product"):
            with self.subTest(failure=failure):
                self.serial.frames.clear()
                self.serial.flags = {1: 3, 2: 1}
                self.serial.rpm[2], self.serial.angles[2] = 0, 0
                fixture = FakeMotor()
                self.guards[1] = fixture.get_guard_config(1)
                self.guards[2] = replace(fixture.get_guard_config(2), soft_enabled=False, minimum_deg=0, maximum_deg=0)
                if failure == "axis1_soft_off":
                    self.guards[1] = replace(self.guards[1], soft_enabled=False)
                elif failure == "axis2_enabled_range":
                    self.serial.flags[2] = 3
                    self.guards[2] = replace(self.guards[2], soft_enabled=True, minimum_deg=-.1, maximum_deg=.1)
                elif failure == "axis2_invalid_range":
                    self.serial.flags[2] = 3
                    self.guards[2] = replace(self.guards[2], soft_enabled=True, minimum_deg=float("nan"), maximum_deg=2)
                elif failure == "axis2_missing_reference":
                    self.serial.flags[2] = 0
                elif failure == "axis2_pending":
                    self.serial.flags[2] = 17
                elif failure == "axis2_moving":
                    self.serial.rpm[2] = 1
                elif failure == "axis2_outside_product":
                    self.serial.angles[2] = 181
                with self.assertRaises(MotorError):
                    self.motor.prepare_trajectory(self.points, session=17)
                self.assertNotIn(BEGIN, [frame[4] for frame in self.serial.frames])

    def test_sdk_start_and_final_arrival_reject_policy_or_reference_changes(self):
        self.motor.prepare_trajectory(self.points, session=17)
        self.serial.origins[2] += 1
        with self.assertRaisesRegex(MotorError, "参考位"):
            self.motor.start_trajectory(17)
        self.assertNotIn(0x33, [frame[4] for frame in self.serial.frames])
        self.serial.origins[2] -= 1
        self.serial.fault = 0  # This independent phase starts from a recovered fixture controller.
        self.motor.prepare_trajectory(self.points, session=18)
        self.motor.start_trajectory(18)
        self.serial.finish_on_renew = True
        self.guards[2] = replace(self.guards[2], soft_enabled=True, minimum_deg=-180, maximum_deg=180)
        self.serial.flags[2] = 3
        with self.assertRaisesRegex(MotorError, "保护配置"):
            self.motor.wait_trajectory(18, timeout=1)
        self.assertIn(0x35, [frame[4] for frame in self.serial.frames])


class StationPlanTests(unittest.TestCase):
    def test_quantized_two_axis_plan_stays_under_each_axis_speed_ceiling(self):
        for target, speed in (((.1, -.1), .6), ((5, 9), .6), ((-35, 180), .6),
                              ((.2, .0666667), .02), ((1, 1/3), .5)):
            points, evidence = station_move_plan((0, 0), target, speed)
            self.assertEqual(points[0].time_s, 0)
            self.assertEqual((points[-1].axis1_deg, points[-1].axis2_deg), tuple(round(x, 3) for x in target))
            self.assertEqual(points[-1].time_s, evidence["plannedSeconds"])
            for before, after in zip(points, points[1:]):
                seconds = after.time_s - before.time_s
                self.assertGreaterEqual(seconds + 1e-9, .05)
                for axis in ("axis1_deg", "axis2_deg"):
                    self.assertLessEqual(abs(getattr(after, axis) - getattr(before, axis)) / seconds, speed * 6)
            for axis in ("axis1_deg", "axis2_deg"):
                velocity, midpoint = 0.0, 0.0
                for before, after in zip(points, points[1:]):
                    speed_now = (getattr(after, axis) - getattr(before, axis)) / (after.time_s - before.time_s)
                    midpoint_now = (before.time_s + after.time_s) / 2
                    self.assertLessEqual(abs(speed_now - velocity) / (midpoint_now - midpoint), 3)
                    velocity, midpoint = speed_now, midpoint_now
                self.assertLessEqual(abs(velocity) / (points[-1].time_s - midpoint), 3)


if __name__ == "__main__":
    unittest.main()
