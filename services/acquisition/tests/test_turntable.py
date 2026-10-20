from __future__ import annotations

import json
import struct
import tempfile
import threading
import time
import unittest
from dataclasses import dataclass, field, replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.receiver import Batch
from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import MotionGuard, TurntableConfig, PositionProgress, snapshot, position_reached, require_stop_confirmed, require_manual_position_ready
from blade_acquisition.turntable_driver.motor_controller import MotorStatus
from blade_acquisition.turntable_driver.motor_controller import MotorController, MotorError, PositionFeedback, GuardConfig, MotionAccepted
from blade_acquisition.turntable_driver.protocol import Response
from laser_fixture import FakeLaserPanel


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
    active_axis: int = 1
    reference_valid: bool = True
    soft_enabled: bool = True
    angles: dict = field(default_factory=lambda: {1: 0.0, 2: 0.0})
    guard_configs: dict = field(default_factory=dict)
    references: list = field(default_factory=list)
    origins: dict = field(default_factory=lambda: {1: 0, 2: 0})
    stopped_axes: list = field(default_factory=list)

    def get_feedback(self, axis):
        position = self.read_position_raw(axis) if axis == self.active_axis else 0
        rpm = round(self.actual_rpm * 50) if self.started and axis == self.active_axis else 0
        return PositionFeedback(position, position, 0, 3, 10000, 17,
                                self.angles[axis] if self.reference_valid else None,
                                (1 if self.reference_valid else 0) | (2 if self.get_guard_config(axis).soft_enabled else 0),
                                0, 0, 0, 0, self.origins[axis], rpm)

    def get_guard_config(self, axis):
        limit = 35 if axis == 1 else 180
        return self.guard_configs.get(axis, GuardConfig(None, None, None, True, 0, False, True,
                                                        self.soft_enabled, -limit, limit, False))

    def set_current_reference(self, axis):
        self.references.append(axis)
        self.reference_valid = True
        self.angles[axis] = 25.0 if axis == 1 else 0.0
        return self.get_feedback(axis)

    def set_soft_range(self, axis, lo, hi):
        self.guard_configs[axis] = replace(self.get_guard_config(axis), minimum_deg=lo, maximum_deg=hi)

    def set_guard_policy(self, axis, *, hardware, soft, **kwargs):
        self.guard_configs[axis] = replace(self.get_guard_config(axis), hardware_enabled=hardware, soft_enabled=soft)

    def move_to_angle(self, axis, target, speed_rpm, cancel=None):
        if cancel and cancel.is_set():
            return None
        self.start_calls += 1
        self.active_axis = axis
        delta = target - self.angles[axis]
        self.angles[axis] = target
        return MotionAccepted(axis, delta, speed_rpm)

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
        self.active_axis = axis
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
        self.stopped_axes.append(axis)
        self.started = False

    def close(self, stop=False):
        return None


class Axis2InvalidReferenceMotor(FakeMotor):
    """Fixture for standalone axis-1 point marking: the idle axis has no reference."""
    def get_feedback(self, axis):
        original = self.reference_valid
        if axis == 2:
            self.reference_valid = False
        try:
            return super().get_feedback(axis)
        finally:
            self.reference_valid = original


class Axis2StopPendingMotor(FakeMotor):
    """A stale stop-pending bit on the unselected axis must not block stop."""
    def get_feedback(self, axis):
        feedback = super().get_feedback(axis)
        return replace(feedback, flags=feedback.flags | 16) if axis == 2 else feedback


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
        laser_panel = patch("blade_acquisition.service.DevicePanel", FakeLaserPanel)
        laser_panel.start()
        self.addCleanup(laser_panel.stop)
        self.temp = tempfile.TemporaryDirectory()
        app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), ReadyReceiver, lambda *args, **kwargs: motor)
        client = TestClient(app, base_url="http://127.0.0.1:8765", headers={"Authorization": f"Bearer {TOKEN}"})
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        self.addCleanup(self.temp.cleanup)
        return client

    def test_health_reads_both_drive_alarms_and_faults_without_motion_or_reset(self):
        motor = FakeMotor()
        get_status, get_feedback = motor.get_status, motor.get_feedback
        reads = []
        def status(axis):
            reads.append(axis)
            return replace(get_status(axis), alarm_code=12 if axis == 2 else 0)
        def feedback(axis):
            value = get_feedback(axis)
            return replace(value, output_angle_deg=None, fault=3, flags=18) if axis == 1 else value
        motor.get_status, motor.get_feedback = status, feedback
        client = self.make_client(motor)
        result = client.post("/api/field/turntable", json={"action": "health", "port": "COM6", "axis": 1})
        self.assertEqual(result.status_code, 200, result.text)
        snapshot = result.json()["turntable"]
        self.assertEqual(reads, [1, 2])
        self.assertTrue(snapshot["health"]["readOnly"])
        self.assertEqual(snapshot["health"]["axes"]["1"]["alarmCode"], 0)
        self.assertEqual(snapshot["health"]["axes"]["2"]["alarmCode"], 12)
        self.assertEqual(snapshot["feedback"]["axes"]["1"]["fault"], 3)
        self.assertEqual(motor.start_calls, 0)
        self.assertEqual(motor.stop_calls, 0)
        self.assertEqual(client.get("/api/field/recordings").json()["recordings"], [])
        rejected = client.post("/api/field/turntable", json={"action": "health", "port": "COM6", "axis": 1, "confirmRecovery": True})
        self.assertEqual(rejected.status_code, 422)

    def test_mac_port_probe_uses_exact_path_and_preserves_motion_guards(self):
        motor = FakeMotor(reference_valid=False, soft_enabled=False)
        client = self.make_client(motor)
        port = "/dev/cu.SLAB_USBtoUART"
        with patch("blade_acquisition.service.list_turntable_ports", return_value=[{"port": port, "description": "USB UART"}]):
            self.assertEqual(client.get("/api/field/turntable/ports").json()["ports"][0]["port"], port)
        response = client.post("/api/field/turntable", json={"port": port, "axis": 1, "action": "probe"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["turntable"]["port"], port)
        self.assertEqual(motor.start_calls, 0)
        move = client.post("/api/field/turntable", json={"port": port, "axis": 1, "action": "manual_move", "protocol": "position",
            "targetAngleDeg": 0, "speedRpm": 0.2, "confirmMotion": True})
        self.assertEqual(move.status_code, 200, move.text)
        checked = self.wait_test(client)
        self.assertEqual(checked["turntable"]["state"], "error")
        self.assertIn("参考", checked["turntable"]["error"])
        self.assertEqual(motor.start_calls, 0)

    def test_synchronous_turntable_responses_follow_close_busy_clear_and_lock_release(self):
        for action in ("probe", "prepare", "reference", "limits", "stop"):
            with self.subTest(action=action):
                motor = FakeMotor()
                client = self.make_client(motor)
                controller = client.app.state.controller
                events, status_calls = [], []
                def close(stop=False):
                    self.assertFalse(stop)
                    events.append("closed")
                motor.close = close
                original_status = controller.status
                def observed_status():
                    available = controller.operation_lock.acquire(blocking=False)
                    if available:
                        controller.operation_lock.release()
                    status_calls.append((bool(events), controller.turntable_busy, available))
                    return original_status()
                controller.status = observed_status
                body = {"port": "COM6", "axis": 1, "action": action}
                if action != "probe":
                    body["confirmMotion"] = True
                if action == "prepare":
                    body.update(protocol="position", targetAngleDeg=10)
                response = client.post("/api/field/turntable", json=body)
                self.assertEqual(response.status_code, 200, response.text)
                result = response.json()
                self.assertFalse(result["turntableBusy"])
                self.assertEqual(events, ["closed"])
                self.assertEqual(status_calls[-1], (True, False, True))
                self.assertEqual(motor.start_calls, 0)
                if action == "probe":
                    self.assertEqual(result["turntable"]["state"], "checked")
                    self.assertEqual(motor.references, [])
                    self.assertEqual(motor.guard_configs, {})
                    self.assertEqual(motor.stop_calls, 0)
                elif action == "prepare":
                    self.assertTrue(result["turntablePreparation"]["ready"])

    def test_asynchronous_turntable_handoffs_return_busy_until_worker_finishes(self):
        for action in ("test", "manual_move", "recall"):
            with self.subTest(action=action):
                motor = FakeMotor()
                entered, release = threading.Event(), threading.Event()
                def connect():
                    entered.set()
                    if not release.wait(3):
                        raise RuntimeError("fixture coordinator not released")
                    return motor
                motor.connect = connect
                client = self.make_client(motor)
                controller = client.app.state.controller
                body = {"port": "COM6", "axis": 1, "action": action, "confirmMotion": True}
                if action == "manual_move":
                    body.update(protocol="position", targetAngleDeg=10)
                elif action == "recall":
                    body.update(recordedPort="COM6", referenceSignature="[[0,3,10000,17],[0,3,10000,17]]",
                                axis1AngleDeg=10, axis2AngleDeg=2)
                try:
                    response = client.post("/api/field/turntable", json=body)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertTrue(response.json()["turntableBusy"])
                    self.assertTrue(entered.wait(1))
                    self.assertFalse(controller.operation_lock.acquire(blocking=False))
                    self.assertEqual(motor.start_calls, 0)
                finally:
                    controller.test_stop.set()
                    release.set()
                    if controller.test_thread:
                        controller.test_thread.join(3)
                self.assertFalse(controller.turntable_busy)
                self.assertTrue(controller.operation_lock.acquire(blocking=False))
                controller.operation_lock.release()
                self.assertEqual(motor.start_calls, 0)

    def test_synchronous_probe_error_is_not_masked_and_still_releases_owner(self):
        motor = FakeMotor()
        closed = []
        motor.close = lambda stop=False: closed.append(stop)
        def fail_probe():
            raise RuntimeError("fixture original capability failure")
        motor.probe_trajectory = fail_probe
        client = self.make_client(motor)
        controller = client.app.state.controller
        response = client.post("/api/field/turntable", json={"port": "COM6", "axis": 1, "action": "probe"})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("fixture original capability failure", response.json()["detail"])
        self.assertEqual(closed, [False])
        self.assertFalse(controller.turntable_busy)
        self.assertTrue(controller.operation_lock.acquire(blocking=False))
        controller.operation_lock.release()
        self.assertEqual(controller.turntable_snapshot["state"], "error")
        self.assertEqual(motor.start_calls, 0)
        self.assertEqual(motor.references, [])
        self.assertEqual(motor.guard_configs, {})

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

    def test_joint_capture_starts_after_stopped_arrival_and_exports_telemetry(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        config = self.position_config()
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True}).status_code, 200)
        response = client.post("/api/field/start", json=self.start_body(config))
        self.assertEqual(response.status_code, 200, response.text)
        self.wait_state(client, "holding")
        self.assertEqual(motor.start_calls, 1)
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
        config = self.position_config()
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True}).status_code, 200)
        motor.limit_flags = 1
        response = client.post("/api/field/start", json=self.start_body(config))
        self.assertEqual(response.status_code, 200)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status = client.get("/api/field/status").json()
            if status["state"] == "error":
                break
            time.sleep(0.01)
        self.assertEqual(motor.start_calls, 0)
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
        config = self.position_config()
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True}).status_code, 200)
        self.assertEqual(client.post("/api/field/start", json=self.start_body(config)).status_code, 200)
        self.wait_state(client, "holding")
        # Pass multiple telemetry polls to detect a runtime-only missing-flags rejection.
        time.sleep(0.6)
        self.assertFalse(motor.started)
        self.assertEqual(client.get("/api/field/status").json()["turntable"]["state"], "holding")
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
        config = self.position_config()
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True}).status_code, 200)
        self.assertEqual(client.post("/api/field/start", json=self.start_body(config)).status_code, 200)
        self.wait_state(client, "holding")
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
        blocked = client.post("/api/field/start", json=self.start_body(changed))
        self.assertEqual(blocked.status_code, 409)
        self.assertIn("定位停稳", blocked.json()["detail"])
        self.assertIsNone(client.get("/api/field/status").json()["recording"])
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

    def position_config(self, axis=2, target=-15):
        return {"port": "COM6", "axis": axis, "speedRpm": 0.2, "direction": "forward",
                "durationSeconds": 0, "protocol": "position", "targetAngleDeg": target}

    def test_feedback_34_bytes_preserves_units_and_invalid_reference(self):
        motor = MotorController("COM6")
        for flags, expected in ((0, None), (1, -12.345)):
            payload = struct.pack(">iiiHHHiHBBBBih", -123, 456, 579, 3, 10000, 17,
                                  -12345, flags, 2, 4, 0, 0, -400, -10)
            motor._request = lambda frame: Response(2, 0x20, 0, 0, payload, frame)
            feedback = motor.get_feedback(2)
            self.assertEqual(feedback.output_angle_deg, expected)
            self.assertEqual((feedback.actual_counts, feedback.origin_counts, feedback.motor_rpm), (-123, -400, -10))
            self.assertEqual(feedback.counts_per_motor_rev, 10000)
        payload = struct.pack(">iiiHHHiHBBBBih", 0, 0, 0, 0, 10000, 17, 0, 1, 0, 0, 0, 0, 0, 0)
        self.assertIsNone(motor.get_feedback(2).output_angle_deg)
        motor._request = lambda frame: Response(1, 0x20, 0, 0, b"short", frame)
        with self.assertRaises(MotorError):
            motor.get_feedback(1)

    def test_out_of_bounds_and_invalid_reference_never_send_move(self):
        motor = MotorController("COM6")
        calls = []
        motor._request = lambda frame: calls.append(frame)
        for axis, angle in ((1, 35.001), (1, -35.001), (2, 180.001), (2, -180.001)):
            with self.assertRaises(ValueError):
                motor.move_to_angle(axis, angle)
        self.assertEqual(calls, [])
        motor.stop = lambda axis: None
        motor.get_feedback = lambda axis: FakeMotor(reference_valid=False).get_feedback(axis)
        with self.assertRaises(MotorError):
            motor.move_to_angle(1, 10)
        self.assertEqual(calls, [])

    def test_reference_and_soft_limits_are_axis_specific_and_invalidate_preparation(self):
        motor = FakeMotor(soft_enabled=False)
        client = self.make_client(motor)
        for axis, expected in ((1, 25), (2, 0)):
            response = client.post("/api/field/turntable", json={"port": "COM6", "axis": axis,
                                   "action": "reference", "confirmMotion": True})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["turntable"]["feedback"]["outputAngleDeg"], expected)
            self.assertIsNone(response.json()["turntablePreparation"])
        self.assertEqual(motor.references, [1, 2])
        config = self.position_config(axis=1)
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True}).status_code, 503)
        motor.guard_configs[2] = replace(motor.get_guard_config(2), minimum_deg=-90, maximum_deg=90)
        response = client.post("/api/field/turntable", json={"port": "COM6", "axis": 2, "action": "limits", "confirmMotion": True})
        self.assertEqual(response.status_code, 200, response.text)
        guard = motor.get_guard_config(2)
        self.assertEqual((guard.minimum_deg, guard.maximum_deg, guard.soft_enabled, guard.hardware_enabled), (-180, 180, True, True))
        self.assertFalse(motor.get_guard_config(1).soft_enabled)

    def test_invalid_reference_blocks_position_preparation_and_test(self):
        motor = FakeMotor(reference_valid=False)
        client = self.make_client(motor)
        config = self.position_config()
        prepared = client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True})
        self.assertEqual(prepared.status_code, 503)
        self.assertEqual(client.post("/api/field/turntable", json={**config, "action": "test", "confirmMotion": True}).status_code, 200)
        self.assertFalse(self.wait_test(client)["turntableTest"]["passed"])
        self.assertEqual(motor.start_calls, 0)

    def test_manual_position_controls_only_selected_axis_and_stops_at_target(self):
        motor = Axis2InvalidReferenceMotor()
        client = self.make_client(motor)
        config = self.position_config(axis=1, target=10)
        response = client.post("/api/field/turntable", json={**config, "action": "manual_move", "confirmMotion": True})
        self.assertEqual(response.status_code, 200, response.text)
        status = self.wait_test(client)
        self.assertFalse(status["turntableBusy"])
        self.assertTrue(status["turntableTest"]["passed"])
        self.assertEqual(status["turntable"]["state"], "stopped")
        self.assertEqual(motor.start_calls, 1)
        self.assertEqual(motor.stopped_axes, [1])
        self.assertIsNone(status["turntablePreparation"])

    def test_manual_horizontal_position_accepts_reference_without_soft_range(self):
        motor = FakeMotor()
        # Stale range values do not become active bounds when the policy is off.
        motor.guard_configs[2] = replace(motor.get_guard_config(2), soft_enabled=False, minimum_deg=0, maximum_deg=0)
        client = self.make_client(motor)
        config = self.position_config(axis=2, target=12)
        response = client.post("/api/field/turntable", json={**config, "action": "manual_move", "confirmMotion": True})
        self.assertEqual(response.status_code, 200, response.text)
        status = self.wait_test(client)
        self.assertTrue(status["turntableTest"]["passed"], status)
        self.assertEqual(motor.angles[2], 12)
        self.assertEqual(motor.start_calls, 1)
        self.assertEqual(status["turntable"]["feedback"]["axes"]["2"]["flags"], 1)
        self.assertFalse(motor.get_guard_config(2).soft_enabled)
        self.assertEqual(motor.references, [])

    def test_horizontal_optional_soft_policy_keeps_reference_fault_and_coordinate_guards(self):
        for failure in ("reference", "reference_flag", "alarm", "pending", "moving", "outside_product", "enabled_bounds", "invalid_bounds"):
            with self.subTest(failure=failure):
                motor = FakeMotor()
                motor.guard_configs[2] = replace(motor.get_guard_config(2), soft_enabled=False, minimum_deg=0, maximum_deg=0)
                if failure == "reference":
                    motor.reference_valid = False
                elif failure == "reference_flag":
                    original = motor.get_feedback
                    motor.get_feedback = lambda axis: replace(original(axis), flags=0) if axis == 2 else original(axis)
                elif failure == "alarm":
                    motor.alarm_code = 2
                elif failure == "pending":
                    original = motor.get_feedback
                    motor.get_feedback = lambda axis: replace(original(axis), flags=17) if axis == 2 else original(axis)
                elif failure == "moving":
                    motor.started, motor.active_axis = True, 2
                elif failure == "outside_product":
                    motor.angles[2] = 181
                elif failure == "enabled_bounds":
                    motor.guard_configs[2] = replace(motor.get_guard_config(2), soft_enabled=True, minimum_deg=-2, maximum_deg=2)
                elif failure == "invalid_bounds":
                    motor.guard_configs[2] = replace(motor.get_guard_config(2), soft_enabled=True, minimum_deg=0, maximum_deg=0)
                value = snapshot(motor, 2)
                with self.assertRaises(MotorError):
                    require_manual_position_ready(value, TurntableConfig(**self.position_config(axis=2, target=12)))
                self.assertEqual(motor.start_calls, 0)

    def test_manual_pitch_still_requires_soft_range(self):
        motor = FakeMotor(soft_enabled=False)
        with self.assertRaisesRegex(MotorError, "软限位"):
            require_manual_position_ready(snapshot(motor, 1), TurntableConfig(**self.position_config(axis=1, target=12)))

    def test_stop_confirmation_does_not_require_other_axis_feedback(self):
        motor = Axis2InvalidReferenceMotor()
        value = snapshot(motor, 1)
        require_stop_confirmed(value, TurntableConfig(port="COM6", axis=1))

    def recall_body(self, **changes):
        return {"action": "recall", "port": "COM6", "recordedPort": "COM6",
                "referenceSignature": "[[0,3,10000,17],[0,3,10000,17]]", "axis": 1, "axis1AngleDeg": 25.935,
                "axis2AngleDeg": -6.994, "speedRpm": 0.2, "confirmMotion": True, **changes}

    def test_recall_moves_both_axes_in_order_and_verifies_both_targets(self):
        motor = FakeMotor()
        moves = []
        original = motor.move_to_angle
        def move(axis, target, speed_rpm, cancel=None):
            if axis == 2:
                self.assertEqual(motor.stopped_axes, [1])
            moves.append((axis, target, speed_rpm))
            return original(axis, target, speed_rpm, cancel)
        motor.move_to_angle = move
        client = self.make_client(motor)
        response = client.post("/api/field/turntable", json=self.recall_body(speedRpm=2))
        self.assertEqual(response.status_code, 200, response.text)
        status = self.wait_test(client)
        self.assertEqual(moves, [(1, 25.935, 2), (2, -6.994, 2)])
        self.assertEqual(motor.stopped_axes, [1, 2])
        self.assertEqual(status["turntable"]["recall"]["state"], "complete")
        self.assertEqual(status["turntable"]["recall"]["completedAxes"], [1, 2])
        self.assertTrue(status["turntableTest"]["passed"])
        self.assertIsNone(status["turntableWarning"])
        self.assertIsNone(status["turntablePreparation"])
        for axis, target in (("1", 25.935), ("2", -6.994)):
            self.assertEqual(status["turntable"]["feedback"]["axes"][axis]["output_angle_deg"], target)

    def test_recall_rejects_invalid_or_missing_targets_and_confirmation_before_motion(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        for changes in ({"axis1AngleDeg": 36.7}, {"axis2AngleDeg": -180.001}, {"axis2AngleDeg": None},
                        {"axis1AngleDeg": True}, {"confirmMotion": False}, {"referenceSignature": "broken"},
                        {"referenceSignature": None}, {"recordedPort": None}, {"recordedPort": "COM7"},
                        *({"maxMoveAccelerationDegS2": value} for value in (0, .099, 120.001, True, "30", None))):
            response = client.post("/api/field/turntable", json=self.recall_body(**changes))
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(motor.start_calls, 0)

    def test_recall_checks_enabled_axis2_soft_limit_before_axis1_moves(self):
        motor = FakeMotor()
        motor.guard_configs[2] = replace(motor.get_guard_config(2), minimum_deg=-2, maximum_deg=2)
        client = self.make_client(motor)
        client.post("/api/field/turntable", json=self.recall_body())
        status = self.wait_test(client)
        self.assertEqual(motor.start_calls, 0)
        self.assertEqual(status["turntable"]["recall"]["state"], "error")
        self.assertIn("软限位", status["turntable"]["error"])

    def test_legacy_recall_accepts_axis2_without_soft_and_preserves_policy(self):
        motor = FakeMotor()
        motor.guard_configs[2] = replace(motor.get_guard_config(2), soft_enabled=False, minimum_deg=0, maximum_deg=0)
        client = self.make_client(motor)
        response = client.post("/api/field/turntable", json=self.recall_body())
        self.assertEqual(response.status_code, 200, response.text)
        status = self.wait_test(client)
        self.assertEqual(status["turntable"]["recall"]["state"], "complete", status)
        self.assertEqual(status["turntable"]["recall"]["completedAxes"], [1, 2])
        self.assertEqual(motor.start_calls, 2)
        self.assertFalse(motor.get_guard_config(2).soft_enabled)
        self.assertEqual(motor.references, [])

    def test_recall_rejects_changed_recorded_reference_before_motion(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        signature = json.dumps([[0, 3, 10000, 17], [999, 3, 10000, 17]])
        client.post("/api/field/turntable", json=self.recall_body(referenceSignature=signature))
        status = self.wait_test(client)
        self.assertEqual(motor.start_calls, 0)
        self.assertIn("记录后参考位", status["turntable"]["error"])

    def test_recall_first_axis_stop_drift_prevents_second_axis(self):
        motor = FakeMotor()
        original = motor.stop
        def stop(axis):
            original(axis)
            if axis == 1:
                motor.angles[1] += 0.5
        motor.stop = stop
        client = self.make_client(motor)
        client.post("/api/field/turntable", json=self.recall_body())
        status = self.wait_test(client)
        self.assertEqual(motor.start_calls, 1)
        self.assertEqual(status["turntable"]["recall"]["state"], "error")
        self.assertIn("停止后角度偏离目标", status["turntable"]["error"])

    def test_recall_stop_accepts_either_axis_and_never_starts_next_axis(self):
        motor = FakeMotor()
        entered = threading.Event()
        def move(axis, target, speed_rpm, cancel=None):
            motor.start_calls += 1
            entered.set()
            cancel.wait(3)
            return None
        motor.move_to_angle = move
        client = self.make_client(motor)
        client.post("/api/field/turntable", json=self.recall_body())
        self.assertTrue(entered.wait(2))
        duplicate = client.post("/api/field/turntable", json=self.recall_body())
        self.assertEqual(duplicate.status_code, 409)
        response = client.post("/api/field/turntable", json={"port": "COM6", "axis": 2, "action": "stop", "confirmMotion": True})
        self.assertEqual(response.status_code, 200, response.text)
        status = response.json()
        self.assertEqual(motor.start_calls, 1)
        self.assertEqual(motor.stopped_axes, [1])
        self.assertEqual(status["turntable"]["recall"]["state"], "cancelled")
        self.assertFalse(status["turntableTest"]["passed"])
        self.assertIsNone(status["turntableWarning"])

    def test_recall_latched_fault_prevents_all_motion(self):
        motor = FakeMotor()
        original = motor.get_feedback
        motor.get_feedback = lambda axis: replace(original(axis), fault=2) if axis == 1 else original(axis)
        client = self.make_client(motor)
        client.post("/api/field/turntable", json=self.recall_body())
        status = self.wait_test(client)
        self.assertEqual(motor.start_calls, 0)
        self.assertEqual(status["turntable"]["recall"]["state"], "error")

    def test_stop_clears_recovery_guard_when_only_other_axis_reports_stop_pending(self):
        motor = Axis2StopPendingMotor()
        client = self.make_client(motor)
        guard = client.app.state.controller.motion_guard
        guard.mark(TurntableConfig(port="COM6", axis=1), True, "转盘停止尚未确认")
        response = client.post("/api/field/turntable", json={"port": "COM6", "axis": 1,
                                      "action": "stop", "confirmMotion": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["turntableWarning"])
        self.assertEqual(motor.stopped_axes, [1])

    def test_stop_confirmation_rejects_stop_pending_on_selected_axis(self):
        motor = Axis2StopPendingMotor()
        value = snapshot(motor, 2)
        with self.assertRaises(MotorError):
            require_stop_confirmed(value, TurntableConfig(port="COM6", axis=2))

    def test_stop_failure_preserves_feedback_and_recovery_warning(self):
        motor = Axis2StopPendingMotor()
        client = self.make_client(motor)
        response = client.post("/api/field/turntable", json={"port": "COM6", "axis": 2,
                                      "action": "stop", "confirmMotion": True})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("轴2", response.json()["detail"])
        self.assertIn("0x0013", response.json()["detail"])
        status = client.get("/api/field/status").json()
        self.assertTrue(status["turntableWarning"])
        self.assertFalse(status["turntable"]["stopConfirmed"])
        self.assertEqual(status["turntable"]["feedback"]["axes"]["2"]["flags"], 19)
        self.assertEqual(motor.stopped_axes, [2])

    def test_stationary_fault_is_visible_after_stop_and_still_blocks_motion(self):
        motor = FakeMotor(alarm_code=3, limit_flags=1)
        get_feedback = motor.get_feedback
        motor.get_feedback = lambda axis: replace(get_feedback(axis), fault=7) if axis == 1 else get_feedback(axis)
        client = self.make_client(motor)
        response = client.post("/api/field/turntable", json={"port": "COM6", "axis": 1,
                                      "action": "stop", "confirmMotion": True})
        self.assertEqual(response.status_code, 200, response.text)
        status = response.json()
        self.assertEqual(status["turntable"]["state"], "stopped")
        self.assertTrue(status["turntable"]["stopConfirmed"])
        self.assertIsNone(status["turntableWarning"])
        feedback = status["turntable"]["feedback"]
        self.assertEqual(feedback["axes"]["1"]["fault"], 7)
        self.assertEqual(feedback["alarmCode"], 3)
        self.assertEqual(feedback["limitFlags"], 1)
        with self.assertRaises(MotorError):
            require_manual_position_ready(feedback, TurntableConfig(**self.position_config(axis=1)))

    def test_stop_timeout_leaves_motion_uncertain_and_never_starts(self):
        motor = FakeMotor()
        def timeout(axis):
            raise MotorError("fixture stop timeout")
        motor.stop = timeout
        client = self.make_client(motor)
        response = client.post("/api/field/turntable", json={"port": "COM6", "axis": 1,
                                      "action": "stop", "confirmMotion": True})
        self.assertEqual(response.status_code, 503)
        status = client.get("/api/field/status").json()
        self.assertFalse(status["turntable"]["stopConfirmed"])
        self.assertTrue(status["turntableWarning"])
        self.assertTrue(MotionGuard(Path(self.temp.name)).warning)
        self.assertEqual(motor.start_calls, 0)

    def test_position_joint_holds_and_records_both_axes_with_actual_angles(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        config = self.position_config()
        prepared = client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True})
        self.assertEqual(prepared.status_code, 200, prepared.text)
        changed = {**config, "targetAngleDeg": -16}
        self.assertEqual(client.post("/api/field/start", json=self.start_body(changed)).status_code, 409)
        self.assertEqual(client.post("/api/field/start", json=self.start_body(config)).status_code, 200)
        self.wait_state(client, "holding")
        for action in ("reference", "limits", "probe"):
            denied = client.post("/api/field/turntable", json={"port": "COM6", "axis": 1, "action": action, "confirmMotion": True})
            self.assertEqual(denied.status_code, 409)
        stopped = client.post("/api/field/stop")
        self.assertEqual(stopped.status_code, 200, stopped.text)
        value = stopped.json()
        self.assertEqual(value["recording"]["status"], "complete")
        self.assertEqual(motor.stopped_axes, [2])
        rows = client.get(f'/api/field/recordings/{value["recording"]["id"]}/turntable-export').text.splitlines()
        reached = next(json.loads(row) for row in rows if json.loads(row)["event"] == "position_reached")
        self.assertEqual(reached["feedback"]["axes"]["2"]["output_angle_deg"], -15)
        self.assertEqual(reached["feedback"]["axes"]["1"]["output_angle_deg"], 0)
        self.assertIn("receivedSamples", reached)
        self.assertIn("not hardware synchronized", value["recording"]["turntable"]["telemetry"]["timestampBasis"])

    def test_reference_changed_after_preparation_never_starts_motion(self):
        motor = FakeMotor()
        client = self.make_client(motor)
        config = self.position_config()
        prepared = client.post("/api/field/turntable", json={**config, "action": "prepare", "confirmMotion": True})
        self.assertEqual(prepared.status_code, 200)
        motor.origins[2] += 100
        self.assertEqual(client.post("/api/field/start", json=self.start_body(config)).status_code, 200)
        self.wait_state(client, "error")
        self.assertEqual(motor.start_calls, 0)
        value = client.get("/api/field/status").json()
        self.assertIn("参考位", value["recording"]["error"])

    def test_position_progress_detects_stall_and_allows_long_hold(self):
        motor = FakeMotor()
        config = TurntableConfig(**self.position_config())
        feedback = snapshot(motor, 2)
        with patch("blade_acquisition.turntable.time.monotonic", return_value=0):
            progress = PositionProgress(feedback, config)
        with patch("blade_acquisition.turntable.time.monotonic", return_value=11):
            with self.assertRaises(MotorError):
                progress.check(feedback, config)
        motor.angles[2] = config.targetAngleDeg
        at_target = snapshot(motor, 2)
        with patch("blade_acquisition.turntable.time.monotonic", return_value=10000):
            progress.check(at_target, config)
        self.assertTrue(position_reached(at_target, config))
        motor.angles[1] = 0.2
        with self.assertRaises(MotorError):
            progress.check(snapshot(motor, 2), config)
        motor.angles[1] = 0
        motor.origins[2] = 1
        with self.assertRaises(MotorError):
            progress.check(snapshot(motor, 2), config)

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
