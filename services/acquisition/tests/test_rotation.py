from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from blade_acquisition.receiver import Batch
from blade_acquisition.rotation import RotationRequest, calculate_rotation, cantilever_shape, match_bending_modes
from blade_acquisition.service import Settings, create_app
from blade_acquisition.storage import RecordingStore


def recording(store: RecordingStore, rate: float, amplitude: float, phase: float, point: str):
    count = int(rate * 5)
    t = np.arange(count) / rate
    values = amplitude * np.sin(2 * np.pi * 20 * t + phase)
    writer = store.create({"name": point, "point": point, "source": "simulation"})
    writer.ready(rate, 1_700_000_000)
    writer.write(Batch(0, rate, 1_700_000_000, [0] * count, values.tolist(), [100] * count, [80.0] * count, [False] * count))
    writer.finish(None)
    return writer.id


class FixedRpmRotationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = RecordingStore(Path(self.temporary.name) / "recordings")
        self.first = recording(self.store, 1000, 0.2, 0, "P1")
        self.second = recording(self.store, 800, 0.1, math.pi / 2, "P2")

    def tearDown(self):
        self.temporary.cleanup()

    def config(self, **changes):
        return RotationRequest(**{"recordingIds": [self.first], "rpm": 600, "pointsPerRevolution": 128,
                                  "maxOrder": 5, "targetOrder": 2, "maxRevolutions": 20, **changes})

    def test_known_two_order_peak_and_synchronous_average(self):
        result = calculate_rotation(self.store, self.config())
        spectrum = result["orderSpectra"][0]
        peak = int(np.argmax(spectrum["amplitudes"][1:])) + 1
        self.assertAlmostEqual(spectrum["orders"][peak], 2, delta=result["orderResolution"])
        self.assertAlmostEqual(spectrum["amplitudes"][peak], 0.2, delta=0.01)
        average = np.asarray(result["synchronousAverages"][0]["values"])
        self.assertAlmostEqual(float(np.max(average) - np.min(average)), 0.4, delta=0.01)
        self.assertEqual(result["assumptionMode"], "constant-rpm-model")
        json.dumps(result, allow_nan=False)

    def test_different_sample_rates_fuse_amplitude_and_relative_phase(self):
        result = calculate_rotation(self.store, self.config(recordingIds=[self.first, self.second], positions=[0.2, 0.8], pointNames=["P1", "P2"]))
        points = result["modeShape"]["points"]
        self.assertAlmostEqual(points[1]["normalizedAmplitude"] / points[0]["normalizedAmplitude"], 0.5, delta=0.03)
        self.assertAlmostEqual(points[1]["relativePhaseDeg"], 90, delta=2)
        self.assertGreater(points[1]["coherence"], 0.99)

    def test_invalid_assumptions_and_short_duration_are_rejected(self):
        for request in ({"recordingIds": [self.first, self.first], "rpm": 600},
                        {"recordingIds": [self.first], "rpm": 600, "pointsPerRevolution": 100},
                        {"recordingIds": [self.first], "rpm": 600, "maxOrder": 20, "targetOrder": 21}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                RotationRequest(**request)
        with self.assertRaisesRegex(ValueError, "两个完整"):
            calculate_rotation(self.store, self.config(rpm=10, endSeconds=1))

    def test_second_mode_from_raw_recordings_and_displacement_units(self):
        positions = [0.15, 0.3, 0.5, 0.7, 0.85, 1.0]
        shape = cantilever_shape(2, np.asarray(positions))
        ids = [recording(self.store, 1000, float(value * 0.2), 0.4, f"P{i}") for i, value in enumerate(shape)]
        result = calculate_rotation(self.store, self.config(recordingIds=ids, positions=positions))
        match = result["modalMatch"]
        self.assertEqual(match["candidateMode"], 2)
        self.assertEqual(match["status"], "candidate")
        self.assertGreater(match["candidates"][1]["mac"], 0.99999)
        self.assertAlmostEqual(match["maxDisplacementAmplitude"], 0.2 / (2 * math.pi * 20), delta=1e-5)
        json.dumps(result, allow_nan=False)


class BendingMatchTests(unittest.TestCase):
    positions = [0.12, 0.28, 0.45, 0.63, 0.81, 1.0]

    def test_beam_boundary_conditions_and_internal_nodes(self):
        x = np.linspace(0, 1, 1001)
        for mode in range(1, 5):
            with self.subTest(mode=mode):
                shape = cantilever_shape(mode, x)
                self.assertAlmostEqual(shape[0], 0)
                self.assertAlmostEqual(shape[-1], 1)
                self.assertLess(abs(shape[1] / .001), .08)  # clamped root slope
                self.assertEqual(int(np.count_nonzero(np.diff(np.sign(shape[1:])))), mode - 1)

    def test_each_template_is_identified_with_arbitrary_common_phase_and_scale(self):
        for mode in range(1, 5):
            for scale in (0.003 * np.exp(1.2j), -0.4j):
                velocity = cantilever_shape(mode, np.asarray(self.positions)) * scale
                result = match_bending_modes(self.positions, velocity, 20, 2)
                self.assertEqual(result["candidateMode"], mode)
                self.assertEqual(result["status"], "candidate")
                self.assertAlmostEqual(result["candidates"][mode - 1]["mac"], 1)
                self.assertLess(result["candidates"][mode - 1]["normalizedMse"], 1e-20)
                json.dumps(result, allow_nan=False)

    def test_insufficient_duplicate_root_only_zero_and_fractional_order(self):
        for positions, velocity, order in [([.2, 1], [1, 2], 2),
                                           ([0, .5, 1], [0, 1, 2], 2),
                                           ([.2, .2, 1], [1, 1, 2], 2),
                                           ([.2, .5, 1], [0, 0, 0], 2),
                                           ([.2, .5, 1], [1, 2, 3], 2.5)]:
            result = match_bending_modes(positions, np.asarray(velocity, dtype=complex), 20, order)
            self.assertEqual(result["status"], "insufficient-data")
            self.assertIsNone(result["candidateMode"])
            self.assertTrue(all(candidate["mac"] is None for candidate in result["candidates"]))
            self.assertEqual(len(result["candidates"]), 4)
            json.dumps(result, allow_nan=False)

    def test_phase_matters_and_zero_first_point_does_not_break_reference(self):
        shape = cantilever_shape(2, np.asarray(self.positions))
        phase_corrupted = shape.astype(complex)
        phase_corrupted[-1] *= 1j
        correct = match_bending_modes(self.positions, shape, 20, 2)
        corrupt = match_bending_modes(self.positions, phase_corrupted, 20, 2)
        self.assertLess(corrupt["candidates"][1]["mac"], correct["candidates"][1]["mac"] - .1)
        root = match_bending_modes([0, *self.positions], np.r_[0, shape] * 1j, 20, 2)
        self.assertEqual(root["referencePointIndex"], len(self.positions))
        self.assertEqual(root["candidateMode"], 2)

    def test_complex_response_with_low_similarity_is_ambiguous(self):
        result = match_bending_modes(self.positions, np.array([1, 1j, -1, -1j, 1, 1j]), 20, 2)
        self.assertEqual(result["status"], "ambiguous")
        self.assertIsNotNone(result["candidateMode"])


class RotationApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.token = "rotation-test-only-0123456789abcdef0123456789"
        self.app = create_app(Settings(self.token, 8765, Path(self.temporary.name)))
        self.recording_id = recording(self.app.state.controller.store, 1000, 0.2, 0, "P1")
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765", headers={"Authorization": f"Bearer {self.token}"})

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def test_rotation_endpoint_is_authenticated_and_calculates_raw_record(self):
        body = {"recordingIds": [self.recording_id], "rpm": 600, "pointsPerRevolution": 128,
                "maxOrder": 5, "targetOrder": 2, "maxRevolutions": 10}
        response = self.client.post("/api/field/rotation", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["modeShape"]["targetFrequencyHz"], 20)
        self.assertEqual(self.client.post("/api/field/rotation", json=body, headers={"Authorization": "bad"}).status_code, 401)
        self.assertEqual(self.client.post("/api/field/rotation", json={**body, "file": "x"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
