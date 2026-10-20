"""Idle drive-profile API tests; never opens hardware."""
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable_driver import MotorError
from blade_acquisition.turntable_driver.motor_controller import MotionProfile, MotorController
from blade_acquisition.turntable_driver.protocol import build_motion_profile
from test_dual_axis_integration import BufferedMotor
from test_turntable import ReadyReceiver, TOKEN
from laser_fixture import FakeLaserPanel

VALUES = {"accel_ms": 100, "decel_ms": 100, "s_curve_ms": 0}
BEFORE = {"accel_ms": 1500, "decel_ms": 1500, "s_curve_ms": 100}


class ProfileMotor(BufferedMotor):
    def __init__(self):
        super().__init__()
        self.profiles = {1: MotionProfile(**BEFORE), 2: MotionProfile(500, 600, 50)}
        self.reads, self.writes = [], []
        self.fail_write = self.mismatch = self.change_profile_reference = False
        self.move_after_write = False

    def get_motion_profile(self, axis):
        self.reads.append(axis)
        return self.profiles[axis]

    def set_motion_profile(self, axis, **values):
        self.writes.append((axis, values))
        self.profiles[axis] = MotionProfile(**values)
        if self.fail_write:
            raise MotorError("lost parameter acknowledgement")
        if self.change_profile_reference:
            self.origins[axis] += 1
        if self.move_after_write:
            self.started = True
        return MotionProfile(999, 100, 0) if self.mismatch else self.profiles[axis]


class DriveProfileTests(unittest.TestCase):
    def setUp(self):
        panel = patch("blade_acquisition.service.DevicePanel", FakeLaserPanel)
        panel.start(); self.addCleanup(panel.stop)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.motor = ProfileMotor()
        self.connections = []
        def factory(port, **kwargs):
            self.connections.append(port)
            return self.motor
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), ReadyReceiver, factory)
        self.controller = self.app.state.controller
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765", headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__(); self.addCleanup(lambda: self.client.__exit__(None, None, None))

    def call(self, action="set_motion_profile", **changes):
        body = {"action": action, "port": "COM6", "axis": 1}
        if action == "set_motion_profile":
            body.update(motionProfile=VALUES, expectedMotionProfile=BEFORE)
        return self.client.post("/api/field/turntable", json={**body, **changes})

    def test_read_each_axis_is_read_only_and_works_on_mac_port(self):
        for axis, port in ((1, "COM6"), (2, "/dev/cu.usbserial-110")):
            reply = self.call("read_motion_profile", axis=axis, port=port)
            self.assertEqual(reply.status_code, 200, reply.text)
            data = reply.json()
            profile = data["turntable"]["motionProfile"]
            self.assertEqual(profile["axis"], axis)
            self.assertEqual(profile["values"], self.motor.profiles[axis].__dict__)
            self.assertEqual(profile["operation"], "read")
            self.assertTrue(profile["verified"])
            self.assertFalse(data["turntableBusy"])
        self.assertEqual(self.motor.writes, [])
        self.assertEqual(self.motor.stop_calls, 0)
        self.assertEqual(self.motor.start_calls, 0)

    def test_write_only_selected_axis_and_preserve_references(self):
        before_origins, other = dict(self.motor.origins), self.motor.profiles[2]
        reply = self.call()
        self.assertEqual(reply.status_code, 200, reply.text)
        read = reply.json()["turntable"]["motionProfile"]
        self.assertEqual(read["values"], VALUES)
        self.assertEqual(read["operation"], "write")
        self.assertTrue(read["temporary"])
        self.assertEqual(self.motor.writes, [(1, VALUES)])
        self.assertEqual(self.motor.profiles[2], other)
        self.assertEqual(self.motor.origins, before_origins)
        self.assertFalse(self.motor.references)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertFalse(reply.json()["turntableBusy"])

    def test_reject_bad_values_before_serial_access(self):
        for changes in (
            {"motionProfile": None}, {"expectedMotionProfile": None}, {"axis": 3},
            {"confirmMotion": True}, {"confirmRecovery": True},
            *({"motionProfile": {**VALUES, key: value}} for key, value in (
                ("accel_ms", 0), ("accel_ms", 10001), ("decel_ms", -1), ("decel_ms", 10001),
                ("s_curve_ms", -1), ("s_curve_ms", 1001), ("accel_ms", True), ("accel_ms", "100"),
                ("accel_ms", 1.5))),
            {"motionProfile": {**VALUES, "extra": 1}},
        ):
            with self.subTest(changes=changes):
                self.assertEqual(self.call(**changes).status_code, 422)
        self.assertEqual(self.call("read_motion_profile", motionProfile=VALUES).status_code, 422)
        self.assertEqual(self.connections, [])

    def test_range_edges_match_vendor_protocol(self):
        for values in ({"accel_ms": 1, "decel_ms": 1, "s_curve_ms": 0},
                       {"accel_ms": 10000, "decel_ms": 10000, "s_curve_ms": 1000}):
            expected = self.motor.profiles[1].__dict__
            reply = self.call(motionProfile=values, expectedMotionProfile=expected)
            self.assertEqual(reply.status_code, 200, reply.text)
            build_motion_profile(1, **values)

    def test_stale_profile_is_not_overwritten(self):
        self.motor.profiles[1] = MotionProfile(200, 100, 0)
        reply = self.call()
        self.assertEqual(reply.status_code, 409)
        self.assertIn("已变化", reply.text)
        self.assertEqual(self.motor.writes, [])

    def test_pending_or_running_trajectory_blocks_write(self):
        for state in (1, 2, 3, 4, 5, 7):
            self.motor.initial_state = state
            with self.subTest(state=state):
                self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.motor.writes, [])

    def test_moving_or_alarm_blocks_write(self):
        self.motor.started = True
        self.assertEqual(self.call().status_code, 503)
        self.motor.started = False
        self.motor.alarm_code = 59
        self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.motor.writes, [])

    def test_busy_does_not_open_port_or_clear_existing_state(self):
        self.controller.turntable_busy = True
        old_snapshot = self.controller.turntable_snapshot
        self.assertEqual(self.call().status_code, 409)
        self.assertTrue(self.controller.turntable_busy)
        self.assertIs(self.controller.turntable_snapshot, old_snapshot)
        self.assertFalse(self.connections)
        self.controller.turntable_busy = False
        self.assertTrue(self.controller.operation_lock.acquire(blocking=False))
        try:
            self.assertEqual(self.call().status_code, 409)
            self.assertFalse(self.connections)
        finally:
            self.controller.operation_lock.release()

    def test_unknown_write_is_not_retried_or_claimed_successful(self):
        self.motor.fail_write = True
        reply = self.call()
        self.assertEqual(reply.status_code, 503)
        self.assertIn("未确认", reply.text)
        self.assertEqual(len(self.motor.writes), 1)
        self.assertNotIn("motionProfile", self.controller.turntable_snapshot)
        self.assertFalse(self.controller.turntable_busy)
        # The device might have accepted the lost ACK; reread shows actual values.
        self.assertEqual(self.call("read_motion_profile").json()["turntable"]["motionProfile"]["values"], VALUES)

    def test_mismatch_and_changed_reference_fail_verification(self):
        for option in ("mismatch", "change_profile_reference", "move_after_write"):
            setattr(self.motor, option, True)
            expected = self.motor.profiles[1].__dict__
            with self.subTest(option=option):
                self.assertEqual(self.call(expectedMotionProfile=expected).status_code, 503)
                self.assertNotIn("motionProfile", self.controller.turntable_snapshot)
            setattr(self.motor, option, False)
            self.motor.started = False

    def test_sdk_stops_selected_axis_sends_once_and_reads_back(self):
        motor = MotorController("COM6")
        calls = []
        motor.stop = lambda axis: calls.append(("stop", axis))
        motor._request = lambda frame: calls.append(("write", frame))
        motor.get_motion_profile = lambda axis: (calls.append(("read", axis)) or MotionProfile(**VALUES))
        self.assertEqual(motor.set_motion_profile(2, **VALUES), MotionProfile(**VALUES))
        self.assertEqual(calls, [("stop", 2), ("write", build_motion_profile(2, **VALUES)), ("read", 2)])
        motor.get_motion_profile = lambda axis: MotionProfile(999, 999, 0)
        with self.assertRaises(MotorError):
            motor.set_motion_profile(2, **VALUES)


if __name__ == "__main__":
    unittest.main()
