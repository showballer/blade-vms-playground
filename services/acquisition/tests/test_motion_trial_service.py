"""Planner boundary: unavailable controller support must never become actuation."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from fastapi.testclient import TestClient

from blade_acquisition.service import Settings, create_app


class MotionTrialServiceTests(unittest.TestCase):
    def test_preview_is_authenticated_and_has_no_hardware_or_recording_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            receiver = Mock(side_effect=AssertionError("DAQ must not be created"))
            motor = Mock(side_effect=AssertionError("Serial must not be opened"))
            token = "motion-trial-isolated-test-0123456789"
            app = create_app(Settings(token, 8765, Path(directory)), receiver, motor)
            with TestClient(app, base_url="http://127.0.0.1:8765") as client:
                body = {"action": "preview", "config": {"distanceM": 2.86,
                    "hubHeightDeltaM": 1.46, "radiusM": .31, "periodSeconds": 30,
                    "rotationDirection": "clockwise", "axis1Sign": 1, "axis2Sign": 1}}
                self.assertEqual(client.post("/api/field/motion-trial", json=body).status_code, 401)
                client.headers["Authorization"] = "Bearer " + token
                result = client.post("/api/field/motion-trial", json=body)
                self.assertEqual(result.status_code, 200, result.text)
                preview = result.json()["motionTrialPreview"]
                self.assertFalse(preview["executionReady"])
                self.assertFalse(preview["capability"]["supported"])
                self.assertFalse(preview["capability"]["checkedHardware"])
                self.assertFalse(preview["anchorBound"])
                self.assertEqual(preview["durationSeconds"], 30)
                self.assertEqual(preview["rotorRpm"], 2)
                self.assertIsNone(result.json()["recording"])
                for mutation in (
                    {**body, "action": "arm", "confirmMotion": True},
                    {**body, "action": "prepare", "port": "COM3"},
                    {**body, "anchor": {"axis1AngleDeg": 10, "axis2AngleDeg": 0}},
                    {**body, "config": {**body["config"], "executionReady": True}},
                ):
                    self.assertEqual(client.post("/api/field/motion-trial", json=mutation).status_code, 422)
                receiver.assert_not_called()
                motor.assert_not_called()
                self.assertEqual(app.state.controller.state, "idle")
                self.assertIsNone(app.state.controller.writer)


if __name__ == "__main__":
    unittest.main()
