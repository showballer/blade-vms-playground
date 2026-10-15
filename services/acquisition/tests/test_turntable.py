from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.receiver import Batch
from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import MotionGuard, TurntableConfig
from blade_acquisition.turntable_driver.motor_controller import MotorStatus
from blade_acquisition.turntable_driver.motor_controller import MotorController, MotorError
from blade_acquisition.turntable_driver.protocol import Response


TOKEN = "turntable-test-token-012345678901234567890123456789"


def sample_batch() -> Batch:
    return Batch(0, 1000.0, 1700000000.0, [1, 2, 3], [0.1, 0.2, 0.3], [800, 800, 800], [80, 80, 80], [False, False, False])


class ReadyReceiver:
    def __init__(self, config):
        self.config = config

    def validate(self):
        return None

    def run(self, stop, ready, receive):
        ready(1000.0, 1700000000.0)
        receive(sample_batch())
        stop.wait(5)


@dataclass
class FakeMotor:
    limit_flags: int | None = 0
    alarm_code: int = 0
    started: bool = False
    start_calls: int = 0
    stop_calls: int = 0
    position: int = 1234
    moving_position: bool = True
    actual_rpm: float = 0.2
    renew_calls: int = 0

    def connect(self):
        return self

    def get_status(self, axis):
        rpm = round(self.actual_rpm * 50) if self.started else 0
        return MotorStatus(axis, rpm, rpm / 50, 1 if self.started else 0, self.alarm_code, self.limit_flags)

    def read_position_raw(self, axis):
        if self.started and self.moving_position:
            self.position += 10
        return self.position

    def start_continuous(self, axis, rpm, cancel=None):
        self.start_calls += 1
        self.started = True
        self.actual_rpm = rpm
        return rpm

    def start_continuous_protocol(self, axis, rpm, cancel=None):
        return self.start_continuous(axis, rpm, cancel)

    def renew_continuous(self, axis):
        self.renew_calls += 1

    def stop(self, axis):
        self.stop_calls += 1
        self.started = False

    def close(self, stop=False):
        return None


class TurntableTests(unittest.TestCase):
    def test_motor_start_continuous_sets_speed_before_start(self):
        motor = MotorController("COM6")
        calls = []
        motor.get_status = lambda axis: MotorStatus(axis, 0, 0.0, 0, 0, 0)
        def request(frame):
            command = frame[4]
            calls.append(command)
            target = 10 if command == 0x10 else 10
            return Response(1, command, 0, 0, target.to_bytes(2, "big", signed=True), frame)
        motor._request = request
        self.assertEqual(motor.start_continuous(1, 0.2), 0.2)
        self.assertEqual(calls, [0x10, 0x05])

    def test_config_rejects_extra_and_signed_direction(self):
        with self.assertRaises(ValueError):
            TurntableConfig(port="COM6", unexpected=True)
        self.assertEqual(TurntableConfig(port="COM6", direction="reverse").signed_rpm, -0.2)
        with self.assertRaises(ValueError):
            TurntableConfig(port="COM6", speedRpm=True)

    def test_driver_accepts_legacy_speed_response_without_limit_flags(self):
        motor = MotorController("COM6")
        calls = []
        def request(frame):
            command = frame[4]
            calls.append(command)
            data = {0x07: b"\x00\x00\x00\x00", 0x09: b"\x00\x00",
                    0x10: b"\x00\x0a", 0x05: b"\x00\x0a"}[command]
            return Response(1, command, 0, 0, data, frame)
        motor._request = request
        self.assertEqual(motor.start_continuous(1, 0.2), 0.2)
        self.assertEqual(calls, [0x07, 0x09, 0x10, 0x05])

    def test_driver_still_rejects_alarm_motion_and_reported_limit_flags(self):
        for rpm, alarm, flags in ((1, 0, None), (0, 1, None), (0, 0, 1), (0, 0, 2), (0, 0, 4)):
            with self.subTest(rpm=rpm, alarm=alarm, flags=flags):
                motor = MotorController("COM6")
                motor.get_status = lambda axis: MotorStatus(axis, rpm, rpm / 50, 0, alarm, flags)
                with self.assertRaises(MotorError):
                    motor.start_continuous(1, 0.2)

    def test_motion_guard_persists_uncertain_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            guard = MotionGuard(Path(directory))
            config = TurntableConfig(port="COM6")
            guard.mark(config, True, "停止未确认")
            restored = MotionGuard(Path(directory))
            self.assertTrue(restored.warning)
            self.assertEqual(restored.identity, ("COM6", 1))
            guard.mark(config, False)
            self.assertFalse(MotionGuard(Path(directory)).warning)

    def make_client(self, motor):
        self.temp = tempfile.TemporaryDirectory()
        app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), ReadyReceiver, lambda *args, **kwargs: motor)
        client = TestClient(app, base_url="http://127.0.0.1:8765", headers={"Authorization": f"Bearer {TOKEN}"})
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        self.addCleanup(self.temp.cleanup)
        return client

    def start_body(self, config=None):
        body = {"deviceIp": "192.168.104.50", "hostIp": "192.168.104.10", "name": "joint", "object": "blade",
                "turbine": "T1", "point": "P1", "confirmLaser": True, "confirmMotion": True}
        if config is not None:
            body["turntable"] = config
        return body

    def wait_state(self, client, state):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            value = client.get("/api/field/status").json()
            if value.get("turntable", {}).get("state") == state:
                return value
            time.sleep(0.01)
        self.fail(f"turntable did not reach {state}")

    def prepare(self, client, config):
        result = client.post("/api/field/turntable", json={**config, "action": "test", "testSeconds": 1, "confirmMotion": True})
        self.assertEqual(result.status_code, 200, result.text)
        self.wait_test(client)
        result = client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertTrue(result.json()["turntablePreparation"]["ready"])

    def wait_test(self, client):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status = client.get("/api/field/status").json()
            if not status["turntableBusy"]:
                return status
            time.sleep(0.01)
        self.fail("independent test did not finish")

    def test_joint_capture_starts_after_ready_and_exports_telemetry(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        config = {"port": "COM6", "axis": 1, "speedRpm": 0.2, "direction": "forward", "durationSeconds": 0}
        self.prepare(client, config)
        response = client.post("/api/field/start", json=self.start_body(config))
        self.assertEqual(response.status_code, 200, response.text)
        self.wait_state(client, "running")
        self.assertEqual(motor.start_calls, 2)
        stopped = client.post("/api/field/stop")
        self.assertEqual(stopped.status_code, 200, stopped.text)
        self.assertEqual(stopped.json()["recording"]["status"], "complete")
        recording_id = stopped.json()["recording"]["id"]
        telemetry = client.get(f"/api/field/recordings/{recording_id}/turntable-export")
        self.assertEqual(telemetry.status_code, 200)
        events = [json.loads(line) for line in telemetry.text.splitlines()]
        self.assertIn("accepted", [event["event"] for event in events])
        self.assertEqual(stopped.json()["recording"]["turntable"]["telemetry"]["file"], "turntable.jsonl")

    def test_limit_feedback_blocks_joint_start(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        config = {"port": "COM6", "axis": 1, "speedRpm": 0.2, "direction": "forward", "durationSeconds": 1}
        self.prepare(client, config)
        motor.limit_flags = 1
        response = client.post("/api/field/start", json=self.start_body({"port": "COM6", "axis": 1, "speedRpm": 0.2, "direction": "forward", "durationSeconds": 1}))
        self.assertEqual(response.status_code, 200)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status = client.get("/api/field/status").json()
            if status["state"] == "error":
                break
            time.sleep(0.01)
        self.assertEqual(motor.start_calls, 1)
        self.assertEqual(status["recording"]["status"], "error")

    def test_legacy_firmware_can_recover_run_and_save_without_limit_feedback(self):
        motor = FakeMotor(limit_flags=None)
        client = self.make_client(motor)
        guard = client.app.state.controller.motion_guard
        guard.mark(TurntableConfig(port="COM6"), True, "转盘停止尚未确认")
        recovered = client.post("/api/field/turntable", json={"action": "probe", "port": "COM6",
                                                            "axis": 1, "confirmRecovery": True})
        self.assertEqual(recovered.status_code, 200, recovered.text)
        self.assertIsNone(recovered.json()["turntableWarning"])
        self.assertIsNone(recovered.json()["turntable"]["feedback"]["limitFlags"])
        config = {"port": "COM6", "axis": 1, "speedRpm": 0.2, "direction": "forward", "durationSeconds": 0}
        self.prepare(client, config)
        self.assertEqual(client.post("/api/field/start", json=self.start_body(config)).status_code, 200)
        self.wait_state(client, "running")
        # Pass multiple telemetry polls to detect a runtime-only missing-flags rejection.
        time.sleep(0.6)
        self.assertTrue(motor.started)
        self.assertEqual(client.get("/api/field/status").json()["turntable"]["state"], "running")
        stopped = client.post("/api/field/stop")
        self.assertEqual(stopped.status_code, 200, stopped.text)
        value = stopped.json()
        self.assertEqual(value["recording"]["status"], "complete")
        self.assertIsNone(value["turntable"]["feedback"]["limitFlags"])
        events = client.get(f'/api/field/recordings/{value["recording"]["id"]}/turntable-export').text
        rows = [json.loads(line) for line in events.splitlines()]
        self.assertTrue(any(row["event"] == "status" and row["feedback"]["limitFlags"] is None for row in rows))

    def test_reported_limit_during_legacy_capture_stops_joint_task(self):
        motor = FakeMotor(limit_flags=None)
        client = self.make_client(motor)
        config = {"port": "COM6", "axis": 1, "speedRpm": 0.2, "direction": "forward", "durationSeconds": 0}
        self.prepare(client, config)
        self.assertEqual(client.post("/api/field/start", json=self.start_body(config)).status_code, 200)
        self.wait_state(client, "running")
        motor.limit_flags = 1
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status = client.get("/api/field/status").json()
            if not status["receiver"]["running"]:
                break
            time.sleep(0.01)
        self.assertFalse(status["receiver"]["running"])
        self.assertEqual(status["recording"]["status"], "error")
        self.assertGreater(motor.stop_calls, 0)

    def test_independent_test_never_opens_receiver_and_requires_matching_setup(self):
        motor = FakeMotor(limit_flags=None)
        client = self.make_client(motor)
        config = TurntableConfig(port="COM6", protocol="continuous").model_dump()
        self.assertEqual(client.post("/api/field/start", json=self.start_body(config)).status_code, 409)
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "test"}).status_code, 422)
        self.prepare(client, config)
        status = client.get("/api/field/status").json()
        self.assertIsNone(status["recording"])
        self.assertFalse(status["receiver"]["running"])
        self.assertTrue(status["turntableTest"]["passed"])
        self.assertNotEqual(status["turntableTest"]["positionDelta"], 0)
        self.assertFalse(motor.started)
        self.assertGreater(motor.renew_calls, 0)
        for changes in ({"axis": 2}, {"direction": "reverse"}, {"speedRpm": 1}, {"protocol": "legacy_speed"}, {"durationSeconds": 10}):
            self.assertEqual(client.post("/api/field/start", json=self.start_body({**config, **changes})).status_code, 409)
        changed = {**config, "durationSeconds": 10}
        self.assertEqual(client.post("/api/field/turntable", json={**changed, "action": "prepare", "confirmMotion": True}).status_code, 200)
        self.assertEqual(client.post("/api/field/start", json=self.start_body(changed)).status_code, 200)
        self.wait_state(client, "running")
        self.assertEqual(client.post("/api/field/stop").status_code, 200)

    def test_speed_feedback_without_position_change_does_not_pass(self):
        motor = FakeMotor(moving_position=False)
        client = self.make_client(motor)
        config = TurntableConfig(port="COM6").model_dump()
        with patch("blade_acquisition.service.MOTOR_STARTUP_SECONDS", 0):
            self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "test", "confirmMotion": True}).status_code, 200)
            status = self.wait_test(client)
        self.assertFalse(status["turntableTest"]["passed"])
        self.assertIn("位置变化", status["turntableTest"]["error"])
        self.assertFalse(motor.started)
        self.assertIsNone(status["recording"])
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True}).status_code, 503)

    def test_cancel_test_uses_owner_thread_and_does_not_prepare(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        config = TurntableConfig(port="COM6").model_dump()
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "test", "testSeconds": 15, "confirmMotion": True}).status_code, 200)
        self.wait_state(client, "testing")
        self.assertEqual(client.post("/api/field/start", json=self.start_body(config)).status_code, 409)
        self.assertEqual(client.post("/api/field/turntable", json={"port": "COM6", "axis": 2, "action": "stop", "confirmMotion": True}).status_code, 409)
        stopped = client.post("/api/field/turntable", json={"port": "COM6", "axis": 1, "action": "stop", "confirmMotion": True})
        self.assertEqual(stopped.status_code, 200, stopped.text)
        self.assertFalse(stopped.json()["turntableBusy"])
        self.assertFalse(stopped.json()["turntableTest"]["passed"])
        self.assertIsNone(stopped.json()["turntablePreparation"])
        self.assertFalse(motor.started)

    def test_failed_test_stop_persists_uncertainty(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        config = TurntableConfig(port="COM6").model_dump()
        def fail_stop(axis):
            raise MotorError("fixture stop timeout")
        motor.stop = fail_stop
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "test", "testSeconds": 1, "confirmMotion": True}).status_code, 200)
        status = self.wait_test(client)
        self.assertFalse(status["turntableTest"]["passed"])
        self.assertEqual(status["turntable"]["state"], "unknown")
        self.assertTrue(status["turntableWarning"])
        self.assertTrue(MotionGuard(Path(self.temp.name)).warning)

    def test_new_protocol_converts_rpm_to_degrees_and_renews_without_start_retry(self):
        motor = MotorController("COM6")
        motor.get_status = lambda axis: MotorStatus(axis, 0, 0, 0, 0, None)
        calls = []
        def request(frame):
            calls.append(frame)
            return Response(2, frame[4], 0, 0, (-10).to_bytes(2, "big", signed=True), frame)
        motor._request = request
        self.assertEqual(motor.start_continuous_protocol(2, -0.2), -0.2)
        motor.renew_continuous(2)
        self.assertEqual([frame[4] for frame in calls], [0x17, 0x18])
        self.assertEqual(int.from_bytes(calls[0][7:11], "big", signed=True), -1200)
        self.assertEqual(calls[1][5:7], b"CR")


if __name__ == "__main__":
    unittest.main()
