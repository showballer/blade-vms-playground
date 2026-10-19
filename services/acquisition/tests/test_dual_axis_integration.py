"""Protocol-adapter fixtures only: no serial port, device, or laser is opened."""
from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import MotionGuard, PointCycleConfig, station_move_plan
from blade_acquisition.turntable_driver import TrajectoryStatus
from test_turntable import FakeMotor
from test_automatic_stations import PassReceiver, automatic_config
from test_service import POINT_REFERENCE, START, TOKEN


class BufferedMotor(FakeMotor):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.points = ()
        self.fail_start = self.fail_stop = self.cancel_wait = self.change_reference = self.change_prepare_reference = False
        self.cancel = None
        self.initial_state = 0

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
        self.assertIsNone(self.controller.motion_guard.warning)

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
