"""Simulation, provenance, pacing and export checks without any hardware access."""
from __future__ import annotations

import csv
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
from fastapi.testclient import TestClient

from blade_acquisition.analysis import read_raw, realtime_snapshot
from blade_acquisition.csv_export import prepare_export, stream_csv
from blade_acquisition.service import Settings, create_app
from blade_acquisition.simulation import SimulationConfig, SimulationReceiver, fixture, simulation_catalog
from blade_acquisition.storage import RECORD, HEADER, RecordingStore

TOKEN = "simulation-tests-only-0123456789abcdef0123456789"


class SimulationNumericalTests(unittest.TestCase):
    def test_fixture_preserves_source_identity_rates_values_and_units(self):
        catalog = simulation_catalog()
        self.assertEqual(catalog["sourceSha256"], "80ec5277f3ae28bf8ec76175c5d172e1ed586d97a0750610d7aca856a571cc50")
        self.assertEqual(catalog["unit"], "m/s")
        for entry, rate, samples in zip(catalog["points"], (1000, 833.3333333333333, 1250), (10000, 8333, 12500)):
            self.assertAlmostEqual(entry["sampleRate"], rate)
            self.assertEqual(entry["samples"], samples)
        # Representative source cells J105/K105 remain numerically unchanged
        # outside the disclosed short bridge at each loop boundary.
        for point in fixture()["points"]:
            receiver = SimulationReceiver(SimulationConfig(point=point["id"]))
            value = receiver.batch(100, 1, 1700000000)
            self.assertEqual(value.values[0], point["velocity"][100])
            self.assertEqual(value.rssi[0], point["rssi"][100])

    def test_wrap_is_contiguous_repeatable_and_has_no_abrupt_seam(self):
        for point in ("P1", "P2", "P3"):
            receiver = SimulationReceiver(SimulationConfig(point=point))
            length = len(receiver.velocity)
            batch = receiver.batch(length - 20, 40, 1700000000)
            np.testing.assert_array_equal(batch.values[20:], receiver.velocity[:20])
            np.testing.assert_array_equal(batch.values[:20], receiver.velocity[-20:])
            self.assertEqual(batch.sample_start, length - 20)
            self.assertEqual(batch.started_at, 1700000000)
            # Bridge derivatives around the boundary vary smoothly; the wrap
            # itself is no larger than its immediate neighbouring increments.
            steps = np.abs(np.diff(batch.values))
            self.assertLessEqual(steps[19], max(steps[18], steps[20]) * 1.1 + 1e-12)
            self.assertEqual(receiver.batch(length, 100, 1).values, receiver.batch(0, 100, 1).values)

    def test_injected_scenarios_change_measurable_features_and_are_labelled(self):
        baseline = SimulationReceiver(SimulationConfig())
        base = baseline.batch(0, 5000, 1)
        base_rms = np.sqrt(np.mean(np.square(base.values)))
        for scenario in ("imbalance", "impact", "low_return"):
            receiver = SimulationReceiver(SimulationConfig(scenario=scenario))
            batch = receiver.batch(0, 5000, 1)
            self.assertTrue(receiver.provenance()["injected"])
            self.assertEqual(batch, receiver.batch(0, 5000, 1))
            if scenario == "imbalance":
                self.assertGreater(np.sqrt(np.mean(np.square(batch.values))), base_rms * 1.6)
            elif scenario == "impact":
                self.assertGreater(np.max(np.abs(batch.values)), np.max(np.abs(base.values)) * 1.2)
            else:
                self.assertLess(max(batch.rssi), 13)
                self.assertEqual(batch.values, base.values)
        self.assertFalse(baseline.provenance()["injected"])

    def test_pacing_uses_source_rate_and_stop_wakes_wait_without_processes(self):
        for point in ("P1", "P2", "P3"):
            receiver = SimulationReceiver(SimulationConfig(point=point))
            stop, batches, ready = threading.Event(), [], []
            def receive(batch):
                batches.append(batch)
                if len(batches) == 4:
                    stop.set()
            started = time.monotonic()
            thread = threading.Thread(target=receiver.run, args=(stop, lambda *args: ready.append(args), receive))
            thread.start()
            thread.join(2)
            self.assertFalse(thread.is_alive())
            elapsed = time.monotonic() - started
            duration = sum(len(b.values) for b in batches) / receiver.sample_rate
            self.assertGreaterEqual(elapsed + 0.005, duration)
            self.assertLess(elapsed, duration + 0.5)
            self.assertEqual(len(ready), 1)
            self.assertEqual([b.sample_start for b in batches], [i * len(batches[0].values) for i in range(4)])
            self.assertEqual(len({b.started_at for b in batches}), 1)
        receiver, stop = SimulationReceiver(SimulationConfig()), threading.Event()
        thread = threading.Thread(target=receiver.run, args=(stop, lambda *_: None, lambda _: None))
        thread.start()
        stop.set()
        thread.join(0.2)
        self.assertFalse(thread.is_alive())

    def test_stft_tracks_frequency_change_on_raw_samples_and_uses_fixed_reference(self):
        rate, size = 2048, 4096
        t = np.arange(size) / rate
        values = np.where(t < 1, 0.2 * np.sin(2 * np.pi * 32 * t), 0.2 * np.sin(2 * np.pi * 128 * t))
        result = realtime_snapshot(values, rate, sample_start=8192)
        spec = result["spectrogram"]
        db = np.asarray(spec["db"])
        self.assertEqual(db.shape, (len(spec["frequencies"]), len(spec["times"])))
        dominant = np.asarray(spec["frequencies"])[np.argmax(db, axis=0)]
        np.testing.assert_allclose(dominant[:5], 32)
        np.testing.assert_allclose(dominant[-5:], 128)
        self.assertAlmostEqual(float(db.max()), 20 * np.log10(0.2), places=3)
        self.assertGreaterEqual(spec["times"][0], 4)
        self.assertLessEqual(spec["times"][-1], 6)
        self.assertLessEqual(len(result["timeDomain"]["values"]), 1000)
        self.assertAlmostEqual(max(result["timeDomain"]["values"]), 0.2)
        json.dumps(result, allow_nan=False)


class SimulationApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.hardware = Mock(side_effect=AssertionError("Simulation must never instantiate hardware"))
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), self.hardware)
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765", headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def start(self, point="P1", scenario="baseline"):
        response = self.client.post("/api/field/start", json={"source": "simulation", "name": "模拟调试", "simulation": {"point": point, "scenario": scenario}})
        self.assertEqual(response.status_code, 200, response.text)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            frame = self.client.get("/api/field/frame").json()
            if frame["recording"]["samples"] >= 100:
                return frame
            time.sleep(0.02)
        self.fail("No simulated samples arrived")

    def test_explicit_source_validation_authentication_and_no_hardware_fallback(self):
        self.assertEqual(self.client.get("/api/field/simulation", headers={"Authorization": ""}).status_code, 401)
        self.assertEqual(len(self.client.get("/api/field/simulation").json()["points"]), 3)
        for body in ({"name": "not explicit"}, {"source": "other", "name": "bad"},
                     {"source": "simulation", "name": "bad", "simulation": {"point": "P9"}},
                     {"source": "simulation", "name": "bad", "simulation": {"scenario": "damaged"}},
                     {"source": "simulation", "name": "bad", "simulation": {"path": "/tmp/arbitrary"}}):
            self.assertEqual(self.client.post("/api/field/start", json=body).status_code, 422)
        self.hardware.assert_not_called()

    def test_capture_export_restart_and_provenance_survive_roundtrip(self):
        first_id = None
        for point, expected_rate in (("P2", 833.3333333333333), ("P3", 1250)):
            frame = self.start(point, "imbalance")
            recording = frame["recording"]
            self.assertNotEqual(recording["id"], first_id)
            self.assertEqual(frame["receiver"]["source"], "simulation")
            self.assertIsNone(frame["receiver"]["dataPort"])
            self.assertEqual(frame["waveform"]["source"], "simulation")
            self.assertEqual(frame["realtime"]["recordingId"], recording["id"])
            self.assertEqual(recording["unit"], "m/s")
            self.assertAlmostEqual(recording["sampleRate"], expected_rate)
            route = f'/api/field/recordings/{recording["id"]}/export'
            self.assertEqual(self.client.get(route).status_code, 409)
            self.assertEqual(self.client.get(route, headers={"Authorization": ""}).status_code, 401)
            stopped = self.client.post("/api/field/stop").json()
            self.assertFalse(stopped["receiver"]["running"])
            self.assertEqual(stopped["recording"]["status"], "complete")
            response = self.client.get(route)
            self.assertEqual(response.status_code, 200)
            lines = response.text.splitlines()
            metadata = json.loads(lines[0].removeprefix("# BladeVMS "))
            self.assertEqual(metadata["source"], "simulation")
            self.assertEqual(metadata["simulation"]["scenario"], "imbalance")
            self.assertEqual(metadata["simulation"]["sourceFile"], "rotation_from_static.xlsx")
            self.assertEqual(metadata["samples"], stopped["recording"]["samples"])
            csv_rows = list(csv.DictReader(lines[1:]))
            self.assertEqual(len(csv_rows), metadata["samples"])
            self.assertEqual(float(csv_rows[0]["time_s"]), 0)
            values, rate, provenance = read_raw(self.app.state.controller.store, recording["id"], 0, metadata["samples"])
            np.testing.assert_array_equal(values, [float(row["velocity_m_s"]) for row in csv_rows])
            self.assertEqual(provenance["simulation"]["scenario"], "imbalance")
            old = self.client.get(f'/api/field/recordings/{recording["id"]}/waveform').json()
            self.assertEqual(old["waveform"]["source"], "simulation")
            self.assertEqual(old["waveform"]["simulation"]["point"], point)
            first_id = recording["id"]
        self.hardware.assert_not_called()

    def test_cache_reuses_identical_window_but_never_previous_recording(self):
        frame = self.start()
        self.client.post("/api/field/stop")
        controller = self.app.state.controller
        with patch.object(controller, "_realtime_result", wraps=controller._realtime_result) as calculate:
            first = controller.frame()["realtime"]
            second = controller.frame()["realtime"]
            self.assertEqual(first["computedAt"], second["computedAt"])
            self.assertLessEqual(calculate.call_count, 1)
        another = self.start()
        self.assertNotEqual(another["realtime"]["recordingId"], frame["recording"]["id"])

    def test_corrupt_export_is_rejected_before_streaming(self):
        frame = self.start()
        self.client.post("/api/field/stop")
        directory = self.app.state.controller.store.directory(frame["recording"]["id"])
        chunk = next(directory.glob("*.bin"))
        with chunk.open("ab") as stream:
            stream.write(b"x")
        response = self.client.get(f'/api/field/recordings/{frame["recording"]["id"]}/export')
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
