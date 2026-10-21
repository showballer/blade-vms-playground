"""Service + actual SDK over an in-memory wire; no physical I/O or DAQ."""
import json
import tempfile
import unittest
from collections import Counter
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import (
    PointCycleConfig, joint_snapshots, joint_snapshots_from_observations,
)
from blade_acquisition.turntable_driver import MotorController, MotorError
from laser_fixture import FakeLaserPanel
from test_automatic_stations import PassReceiver
from test_buffered_trajectory import SerialFixture, BEGIN, START, STATUS
from test_service import TOKEN


class StartupObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for target, replacement in (
                ("blade_acquisition.service.DevicePanel", FakeLaserPanel),
                ("blade_acquisition.turntable_driver.motor_controller.time.sleep", lambda _: None)):
            patched = patch(target, replacement)
            patched.start()
            self.addCleanup(patched.stop)
        self.serial = SerialFixture()
        self.serial.finish_on_renew = True
        self.serial.reject[0x37] = 7  # Explicit old-firmware position-command rejection.
        self.motor = MotorController("TEST", timeout=.02, serial_factory=lambda *a, **kw: self.serial)
        # This suite exercises buffered-trajectory request counts on old
        # firmware; the native-position default is covered in its own suites.
        self.motor.drive_internal_position = False
        self.addCleanup(lambda: self.motor.close(stop=False))
        app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), PassReceiver,
                         lambda *a, **kw: self.motor)
        self.controller = app.state.controller
        self.client = TestClient(app, base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()
        self.addCleanup(lambda: self.client.__exit__(None, None, None))
        self.signature = json.dumps([[101, 3, 10000, 17], [202, 3, 10000, 17]])

    def commands(self):
        return [frame[4] for frame in self.serial.frames]

    def move(self, on_command=None):
        self.motor.connect()
        cycle = PointCycleConfig(port="COM6", speedRpm=.25, points=[{
            "name": "P1", "port": "COM6", "referenceSignature": self.signature,
            "axis1AngleDeg": 10.4, "axis2AngleDeg": 0,
        }])
        return self.controller._cycle_move_point(self.motor, cycle, cycle.points[0], on_command)

    def assert_startup_counts(self):
        commands = self.commands()
        before = commands[:commands.index(START)]
        # Three fresh pairs: service initial, SDK prepare, SDK before START.
        # Each status is two wire requests (speed and alarm).
        self.assertEqual(Counter(before), {
            0x07: 6, 0x09: 6, 0x20: 6, 0x24: 6,
            0x30: 1, 0x31: 11, 0x32: 1, 0x34: 4,
        })
        self.assertEqual(len(before), 41)
        self.assertEqual(commands.count(START), 1)

    def test_joint_views_read_each_drive_feedback_and_guard_once(self):
        self.motor.connect()
        first, second = joint_snapshots(self.motor)
        self.assertEqual(self.commands(), [0x07, 0x09, 0x20, 0x24] * 2)
        self.assertEqual((first["axis"], second["axis"]), (1, 2))
        self.assertEqual((first["outputAngleDeg"], second["outputAngleDeg"]), (10, 0))
        self.assertEqual(first["axes"], second["axes"])
        self.assertLessEqual(first["queryStartedAt"], first["axes"]["1"]["observedAt"])
        self.assertLessEqual(first["axes"]["2"]["observedAt"], first["observedAt"])
        with self.assertRaisesRegex(MotorError, "观察数据不完整"):
            joint_snapshots_from_observations(())

    def test_manual_return_uses_41_requests_and_checks_both_axes_before_capture(self):
        response = self.client.post("/api/field/turntable", json={
            "action": "recall", "port": "COM6", "recordedPort": "COM6",
            "confirmMotion": True, "referenceSignature": self.signature,
            "axis1AngleDeg": 10.4, "axis2AngleDeg": 0, "speedRpm": .25,
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.controller.test_thread.join(5)
        result = self.controller.status()["turntable"]["recall"]
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual(result["lastMove"]["startCheckSource"], "sdk_observation")
        self.assert_startup_counts()

    def test_cycle_shares_start_checks_and_only_reports_command_after_validation(self):
        called = []
        def on_command():
            called.append(len(self.serial.frames))
            self.assertNotIn(START, self.commands())
            self.assertEqual(self.commands()[-8:], [0x07, 0x09, 0x20, 0x24] * 2)
        reached, axes, _ = self.move(on_command)
        self.assertTrue(reached)
        self.assertEqual(axes, [1, 2])
        self.assertEqual(len(called), 1)
        self.assert_startup_counts()
        evidence = self.controller.turntable_snapshot["lastMove"]
        self.assertEqual(evidence["state"], "complete")
        self.assertEqual([check["phase"] for check in evidence["referenceChecks"]],
                         ["before_start", "before_start", "arrival", "arrival"])
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_reference_change_between_initial_and_prepare_prevents_start(self):
        changed = False
        def on_write(command):
            nonlocal changed
            if command == STATUS and not changed:
                changed = True
                self.serial.origins[2] += 1
        self.serial.on_write = on_write
        called = []
        with self.assertRaisesRegex(RuntimeError, "参考位|反馈计数单位"):
            self.move(lambda: called.append(True))
        self.assertNotIn(START, self.commands())
        self.assertEqual(called, [])
        evidence = self.controller.turntable_snapshot["lastMove"]
        self.assertEqual(evidence["referenceMismatch"]["phase"], "before_start")
        self.assertTrue(evidence["referenceMismatch"]["changes"])
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_axis2_drive_alarm_and_flags_are_checked_before_any_upload(self):
        original = self.motor.get_status
        for field, value in (("alarm_code", 12), ("limit_flags", 4)):
            with self.subTest(field=field):
                self.serial.frames.clear()
                self.motor.get_status = lambda axis: replace(
                    original(axis), **({field: value} if axis == 2 else {}))
                with self.assertRaises(MotorError):
                    self.move()
                self.assertNotIn(BEGIN, self.commands())
                self.assertNotIn(START, self.commands())
        self.motor.get_status = original

    def test_callback_exception_does_not_start_or_mark_arrived(self):
        def fail():
            raise RuntimeError("test callback rejected")
        with self.assertRaisesRegex(RuntimeError, "test callback rejected"):
            self.move(fail)
        self.assertNotIn(START, self.commands())
        self.assertEqual(self.controller.turntable_snapshot["lastMove"]["state"], "error")
        self.assertEqual(self.serial.angles, {1: 10, 2: 0})
        self.assertIsNone(self.controller.motion_guard.warning)


if __name__ == "__main__":
    unittest.main()
