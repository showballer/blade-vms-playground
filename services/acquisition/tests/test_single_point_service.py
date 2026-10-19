"""Service/state-machine acceptance using fake transports only; no device I/O."""
from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.receiver import Batch
from blade_acquisition.service import Settings, create_app
from blade_acquisition.single_point import estimate_manual_sync, preview_plan
from blade_acquisition.turntable import MotionGuard, TurntableConfig, start_motor
from blade_acquisition.single_point_runner import MotionDeadline
from blade_acquisition.turntable_driver.motor_controller import MotionAccepted, MotorController
from test_turntable import FakeMotor

TOKEN = "single-point-tests-no-real-devices-0123456789"


def config(**changes):
    value = dict(bladeId="A", pointId="P1", pointName="根部标记", materialMark="蓝色标记",
                 distanceM=5, hubHeightDeltaM=0.1, radiusM=0.1, arcDegrees=30,
                 nominalPeriodSeconds=0.5, motionRampSeconds=0.004,
                 maxOutputRpm=10, maxOutputAccelerationDegS2=5000,
                 commandLatencyMs=20, axisStartSkewMs=20, syncUncertaintyMs=1,
                 maxApproximationErrorMm=20, maxPredictionErrorMm=100,
                 frontFacingConfirmed=True, motionTimingConfirmed=True)
    value.update(changes)
    return value


class ContinuousReceiver:
    starts = 0

    def __init__(self, options):
        self.options = options

    def validate(self):
        pass

    def run(self, stop, ready, receive):
        type(self).starts += 1
        origin = time.time()
        ready(1000.0, origin)
        count = 0
        while not stop.is_set():
            wanted = max(count + 1, int((time.time() - origin) * 1000))
            size = wanted - count
            receive(Batch(count, 1000.0, origin, [1] * size, [0.1] * size,
                          [800] * size, [80] * size, [False] * size))
            count += size
            stop.wait(0.01)


class RecordingMotor(FakeMotor):
    def __init__(self):
        super().__init__()
        self.commands = []
        self.fail_stop = False
        self.disconnect = False
        self.command_delay = {}
        self.never_reach = False
        self.operations = []

    def move_to_angle(self, axis, target, speed_rpm, cancel=None):
        self.commands.append((axis, target, speed_rpm))
        if self.command_delay.get(axis):
            time.sleep(self.command_delay[axis])
        if self.never_reach:
            return MotionAccepted(axis, target - self.angles[axis], speed_rpm)
        return super().move_to_angle(axis, target, speed_rpm, cancel)

    def get_status(self, axis):
        self.operations.append(("status", axis))
        if self.disconnect:
            raise OSError("fake disconnected")
        return super().get_status(axis)

    def stop(self, axis, wait=True):
        self.operations.append(("stop", axis, wait))
        if self.fail_stop:
            raise OSError("fake stop unconfirmed")
        return super().stop(axis)


class SinglePointServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.motor = RecordingMotor()
        ContinuousReceiver.starts = 0
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), ContinuousReceiver,
                              lambda *args, **kwargs: self.motor)
        self.controller = self.app.state.controller
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()
        self.session = uuid.uuid4().hex

    def tearDown(self):
        self.motor.fail_stop = False
        self.motor.disconnect = False
        self.controller.stop_event.set()
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def post(self, action, **values):
        data = {"action": action, "sessionId": self.session, "commandId": uuid.uuid4().hex, **values}
        return self.client.post("/api/field/single-point", json=data)

    def prepare_data(self, **values):
        return {"action": "prepare", "sessionId": self.session, "commandId": uuid.uuid4().hex,
                "config": config(), "capture": {"name": "真实单点测试", "deviceIp": "192.168.106.90",
                                                "hostIp": "192.168.106.10", "port": "COM6"},
                "confirmLaser": True, "confirmStaticPoint": True, "confirmGeometry": True, **values}

    def wait_state(self, expected, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.controller.status()["singlePoint"]
            if value and value["state"] in expected:
                return value
            time.sleep(0.01)
        self.fail(f"state did not reach {expected}: {self.controller.status()['singlePoint']}")

    def prepare(self, **values):
        data = self.prepare_data(**values)
        response = self.client.post("/api/field/single-point", json=data)
        self.assertEqual(response.status_code, 200, response.text)
        self.wait_state({"awaiting_sync"})
        return data

    def seed_sync(self):
        # Fake fixture supplies four past server times; production API never
        # accepts any timestamp. The fifth mark still uses its receive time.
        runner = self.controller.single_point_runner
        with self.controller.lock:
            now = runner.now()
            runner.marks = [now - 2, now - 1.5, now - 1, now - 0.5]
        response = self.post("mark")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["singlePoint"]

    def test_preview_is_pure_and_reports_unbound_anchor(self):
        response = self.post("preview", config=config())
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["singlePointPreview"]["ready"])
        self.assertEqual(ContinuousReceiver.starts, 0)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertIsNone(self.controller.writer)

    def test_preparation_is_real_continuous_daq_without_motion(self):
        self.prepare()
        state = self.controller.status()
        self.assertEqual(ContinuousReceiver.starts, 1)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(state["recording"]["source"], "polytec_ivs500")
        self.assertIsNone(state["recording"]["simulation"])
        self.assertFalse(state["singlePoint"]["phaseLocked"])
        self.assertEqual(state["singlePoint"]["quality"], "manual_unverified")
        self.assertEqual(self.post("cancel").status_code, 200)
        self.wait_state({"cancelled"})
        saved = self.controller.writer.manifest
        self.assertEqual(saved["status"], "complete")
        self.assertGreater(saved["samples"], 0)
        self.assertEqual(saved["turntable"]["singlePoint"]["state"], "cancelled")
        self.assertTrue(saved["turntable"]["telemetry"]["sha256"])

    def test_confirmation_and_no_simulation_or_client_timestamp(self):
        for field in ("confirmLaser", "confirmStaticPoint", "confirmGeometry"):
            data = self.prepare_data(**{field: False})
            self.assertEqual(self.client.post("/api/field/single-point", json=data).status_code, 422)
        data = self.prepare_data()
        data["capture"]["source"] = "simulation"
        self.assertEqual(self.client.post("/api/field/single-point", json=data).status_code, 422)
        self.prepare()
        self.assertEqual(self.post("mark", markedAt=1234).status_code, 422)
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 409)
        self.assertEqual(self.motor.start_calls, 0)

    def test_prepare_replay_and_command_replay_are_idempotent(self):
        data = self.prepare()
        self.assertEqual(self.client.post("/api/field/single-point", json=data).status_code, 200)
        self.assertEqual(ContinuousReceiver.starts, 1)
        command = uuid.uuid4().hex
        self.assertEqual(self.post("mark", commandId=command).status_code, 200)
        self.assertEqual(self.post("mark", commandId=command).status_code, 200)
        self.assertEqual(len(self.controller.single_point_runner.marks), 1)
        self.assertEqual(self.post("reset_sync", commandId=command).status_code, 409)
        self.assertEqual(self.post("reset_sync").status_code, 200)
        self.assertEqual(len(self.controller.single_point_runner.marks), 0)

    def test_cancel_before_delayed_prepare_never_starts_device(self):
        data = self.prepare_data()
        self.assertEqual(self.post("cancel").status_code, 200)
        self.assertEqual(self.client.post("/api/field/single-point", json=data).status_code, 409)
        self.assertEqual(ContinuousReceiver.starts, 0)
        self.assertEqual(self.motor.start_calls, 0)

    def test_cancel_has_priority_when_idempotency_cache_is_full(self):
        self.prepare()
        runner = self.controller.single_point_runner
        with self.controller.lock:
            runner.commands.update({f"filled-command-{index}": str(index) for index in range(513)})
        self.assertEqual(self.post("mark").status_code, 409)
        self.assertEqual(self.post("cancel").status_code, 200)
        self.wait_state({"cancelled"})
        self.assertTrue(self.controller.stop_event.is_set())
        self.assertEqual(self.motor.commands, [])

    def test_stale_session_cannot_cancel_new_task_or_reprepare_old(self):
        old_data = self.prepare()
        self.post("cancel")
        self.wait_state({"cancelled"})
        old_session = self.session
        self.session = uuid.uuid4().hex
        self.prepare()
        self.assertEqual(self.post("cancel", sessionId=old_session).status_code, 200)
        self.assertFalse(self.controller.stop_event.is_set())
        self.assertEqual(self.post("mark", sessionId=old_session).status_code, 409)
        self.assertEqual(self.client.post("/api/field/single-point", json=old_data).status_code, 409)

    def test_exclusive_ownership_rejects_other_capture_device_and_motor(self):
        self.prepare()
        requests = [("/api/field/start", {"source": "simulation", "name": "collision"}),
                    ("/api/field/device", {"deviceIp": "192.168.106.90", "action": "read"}),
                    ("/api/field/turntable", {"port": "COM6", "action": "probe"}),
                    ("/api/field/rssi-calibration", {"deviceIp": "192.168.106.90", "hostIp": "192.168.106.10",
                                                    "state": "background", "confirmLaser": True})]
        for path, body in requests:
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, json=body).status_code, 409)
        self.assertEqual(ContinuousReceiver.starts, 1)

    def test_one_short_arc_then_stop_preserves_single_record_and_one_command_per_axis(self):
        self.prepare()
        sync = self.seed_sync()
        self.assertTrue(sync["sync"]["ready"], sync["sync"])
        response = self.post("arm", confirmMotion=True)
        self.assertEqual(response.status_code, 200, response.text)
        done = self.wait_state({"complete", "error"})
        self.assertEqual(done["state"], "complete", done["error"])
        self.assertEqual(ContinuousReceiver.starts, 1)
        self.assertGreater(len(self.motor.commands), 0)
        self.assertEqual(len({command[0] for command in self.motor.commands}), len(self.motor.commands))
        self.assertTrue(done["stopConfirmed"])
        self.assertFalse(done["identityConfirmed"])
        self.assertEqual(self.controller.writer.manifest["status"], "complete")
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 409)

    def test_expired_sync_and_changed_reference_never_move(self):
        self.prepare()
        self.seed_sync()
        runner = self.controller.single_point_runner
        with self.controller.lock:
            runner.marks = [value - 40 for value in runner.marks]
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 409)
        with self.controller.lock:
            runner.marks = [value + 40 for value in runner.marks]
        self.motor.origins[2] = 99
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
        done = self.wait_state({"error"})
        self.assertIn("参考", done["error"])
        self.assertEqual(self.motor.start_calls, 0)

    def test_disconnect_stops_capture_and_does_not_retry_motion(self):
        self.prepare()
        self.motor.disconnect = True
        done = self.wait_state({"error"})
        self.assertIn("disconnected", done["error"])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(ContinuousReceiver.starts, 1)

    def test_dual_axis_uncertain_stop_requires_both_recoveries(self):
        self.prepare()
        self.seed_sync()
        self.motor.fail_stop = True
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
        done = self.wait_state({"error"})
        self.assertEqual(done["pendingStopAxes"], [1, 2])
        restored = MotionGuard(Path(self.temp.name))
        self.assertIsNotNone(restored.warning)
        self.assertEqual(restored.identity, ("COM6", 1))
        self.motor.fail_stop = False
        self.assertEqual(self.client.post("/api/field/turntable", json={"port": "COM6", "axis": 1,
                                                                      "action": "stop", "confirmMotion": True}).status_code, 200)
        self.assertIsNotNone(self.controller.motion_guard.warning)
        self.assertEqual(self.controller.motion_guard.identity, ("COM6", 2))
        self.assertEqual(self.client.post("/api/field/turntable", json={"port": "COM6", "axis": 2,
                                                                      "action": "stop", "confirmMotion": True}).status_code, 200)
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_actual_narrow_soft_limit_blocks_target_before_motion(self):
        from dataclasses import replace
        self.prepare()
        self.seed_sync()
        self.motor.guard_configs[2] = replace(self.motor.get_guard_config(2), minimum_deg=-0.1, maximum_deg=0.1)
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
        done = self.wait_state({"error"})
        self.assertIn("软限位", done["error"])
        self.assertEqual(self.motor.commands, [])

    def test_slow_first_command_is_failure_and_second_is_not_dispatched(self):
        self.prepare()
        self.seed_sync()
        self.motor.command_delay[1] = 0.04
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
        done = self.wait_state({"error"})
        self.assertTrue("延迟预算" in done["error"] or "发送时限" in done["error"])
        self.assertEqual([item[0] for item in self.motor.commands], [1])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertTrue(done["stopConfirmed"])

    def test_second_axis_slow_reply_is_not_reported_as_complete(self):
        self.prepare()
        self.seed_sync()
        self.motor.command_delay[2] = 0.04
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
        done = self.wait_state({"error"})
        self.assertEqual([item[0] for item in self.motor.commands], [1, 2])
        self.assertTrue(done["stopConfirmed"])
        operations = self.motor.operations
        first_stop = next(i for i, operation in enumerate(operations) if operation[0] == "stop")
        self.assertEqual(operations[first_stop:first_stop + 2], [("stop", 1, False), ("stop", 2, False)])

    def test_slow_guard_persistence_never_sends_a_late_move(self):
        self.prepare()
        self.seed_sync()
        original = self.controller._persist_pending_axes
        def slow_write(port, axes):
            time.sleep(0.04)
            original(port, axes)
        with patch.object(self.controller, "_persist_pending_axes", side_effect=slow_write):
            self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
            done = self.wait_state({"error"})
        self.assertIn("写盘后超过", done["error"])
        self.assertEqual(self.motor.commands, [])
        self.assertEqual(self.motor.start_calls, 0)

    def test_driver_slow_feedback_or_alarm_read_checks_deadline_before_wire_move(self):
        for slow_step in ("feedback", "alarm"):
            with self.subTest(slow_step=slow_step):
                motor = MotorController("COM6")
                sent = []
                def feedback(axis):
                    if slow_step == "feedback":
                        time.sleep(0.02)
                    return self.motor.get_feedback(axis)
                def alarm(axis):
                    if slow_step == "alarm":
                        time.sleep(0.02)
                    return 0
                motor.get_feedback = feedback
                motor.read_alarm = alarm
                motor._request = lambda packet: sent.append(packet)
                motion = TurntableConfig(port="COM6", axis=1, protocol="position", targetAngleDeg=0.1)
                deadline = MotionDeadline(threading.Event(), time.monotonic, time.monotonic() + 0.005)
                self.assertIsNone(start_motor(motor, motion, deadline, prechecked_position=True))
                self.assertEqual(sent, [])

    def test_never_reached_endpoint_is_not_a_completed_trial(self):
        # This tests endpoint rejection, not dispatch jitter. Keep the fake
        # timing budget independent of host fsync/scheduler load in the full
        # suite; separate tests above exercise strict late-command guards.
        self.prepare(config=config(commandLatencyMs=200, axisStartSkewMs=200,
                                   maxPredictionErrorMm=600))
        self.seed_sync()
        self.motor.never_reach = True
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
        done = self.wait_state({"error"})
        self.assertIn("endpointReached", done, done.get("error"))
        self.assertFalse(done["endpointReached"])
        self.assertTrue(done["stopConfirmed"])
        self.assertIn("未在预测终点", done["error"])

    def test_cancel_scheduled_task_prevents_motion(self):
        self.prepare()
        self.seed_sync()
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
        self.wait_state({"scheduled"})
        self.post("cancel")
        done = self.wait_state({"cancelled"})
        self.assertEqual(self.motor.commands, [])
        self.assertFalse(done["identityConfirmed"])

    def test_ready_without_samples_cannot_arm(self):
        class EmptyReceiver(ContinuousReceiver):
            def run(self, stop, ready, receive):
                ready(1000.0, time.time())
                stop.wait(30)
        self.controller.receiver_factory = EmptyReceiver
        self.prepare()
        self.seed_sync()
        response = self.post("arm", confirmMotion=True)
        self.assertEqual(response.status_code, 409)
        self.assertIn("样本", response.text)
        self.wait_state({"error"})
        self.assertEqual(self.motor.commands, [])

    def test_initial_samples_then_stream_stalls_is_not_completed(self):
        class StalledReceiver(ContinuousReceiver):
            def run(self, stop, ready, receive):
                origin = time.time()
                ready(1000.0, origin)
                receive(Batch(0, 1000.0, origin, [1], [0.1], [800], [80], [False]))
                stop.wait(30)
        self.controller.receiver_factory = StalledReceiver
        self.prepare()
        self.seed_sync()
        self.assertEqual(self.post("arm", confirmMotion=True).status_code, 200)
        done = self.wait_state({"error"})
        self.assertIn("500毫秒", done["error"])

    def test_receiver_normal_early_exit_is_an_error(self):
        class EarlyExitReceiver(ContinuousReceiver):
            def run(self, stop, ready, receive):
                origin = time.time()
                ready(1000.0, origin)
                receive(Batch(0, 1000.0, origin, [1], [0.1], [800], [80], [False]))
                stop.wait(0.05)
        self.controller.receiver_factory = EarlyExitReceiver
        self.prepare()
        done = self.wait_state({"error"})
        self.assertIn("采集已意外退出", done["error"])
        self.assertEqual(self.motor.commands, [])


if __name__ == "__main__":
    unittest.main()
