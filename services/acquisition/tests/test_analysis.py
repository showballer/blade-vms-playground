"""Analytical reference signals, raw-file integrity and authenticated API checks."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from blade_acquisition.analysis import AnalysisRequest, calculate, read_raw, realtime_snapshot
from blade_acquisition.receiver import Batch
from blade_acquisition.storage import HEADER, RECORD, RecordingStore
from blade_acquisition.service import Settings, create_app


class NumericalTests(unittest.TestCase):
    rate = 2048
    n = 4096

    def result(self, values=None, **params):
        t = np.arange(self.n) / self.rate
        if values is None:
            values = 0.2 * np.sin(2 * np.pi * 32 * t)
        return calculate(values, self.rate, AnalysisRequest(end=len(values), nfft=2048, **params))

    def test_sine_amplitude_rms_peak_frequency_and_power(self):
        result = self.result()
        self.assertAlmostEqual(result["features"]["rms"], 0.2 / np.sqrt(2), places=10)
        self.assertAlmostEqual(result["features"]["peakToPeak"], 0.4, places=10)
        self.assertAlmostEqual(result["features"]["kurtosis"], 1.5, places=10)
        self.assertEqual(result["features"]["dominantHz"], 32)
        k = result["spectrum"]["x"].index(32)
        self.assertAlmostEqual(result["spectrum"]["y"][k], 0.2, places=10)
        self.assertAlmostEqual(result["features"]["totalPower"], 0.02, places=10)
        self.assertAlmostEqual(result["bands"][2]["percent"], 100, places=8)

    def test_dc_nyquist_not_doubled(self):
        result = self.result(np.ones(self.n) * 3, detrend="none", window="boxcar")
        self.assertEqual(result["features"]["mean"], 3)
        self.assertEqual(result["spectrum"]["y"][0], 3)
        self.assertIsNone(result["features"]["kurtosis"])
        result = self.result((-1.) ** np.arange(self.n), window="boxcar")
        self.assertEqual(result["spectrum"]["y"][-1], 1)

    def test_displacement_and_acceleration_match_known_sine(self):
        t = np.arange(self.n) / self.rate
        d = self.result(quantity="displacement")["features"]["rms"]
        self.assertAlmostEqual(d / (0.2 / (2 * np.pi * 32) / np.sqrt(2)), 1, delta=0.005)
        a = self.result(quantity="acceleration")["features"]["rms"]
        self.assertAlmostEqual(a / (0.2 * (2 * np.pi * 32) / np.sqrt(2)), 1, delta=0.005)

    def test_filter_suppresses_high_frequency(self):
        t = np.arange(self.n) / self.rate
        x = 0.2 * np.sin(2 * np.pi * 20 * t) + 0.2 * np.sin(2 * np.pi * 300 * t)
        result = self.result(x, filterType="lowpass", highHz=60)
        self.assertAlmostEqual(result["features"]["rms"], 0.2 / np.sqrt(2), delta=0.003)
        self.assertEqual(result["features"]["dominantHz"], 20)

    def test_am_envelope_finds_modulation(self):
        t = np.arange(self.n) / self.rate
        x = (1 + 0.3 * np.cos(2 * np.pi * 16 * t)) * np.cos(2 * np.pi * 256 * t)
        result = self.result(x)
        env = result["envelopeSpectrum"]
        self.assertEqual(env["x"][int(np.argmax(env["y"]))], 16)
        self.assertAlmostEqual(max(env["y"]), 0.3, places=8)

    def test_stft_changes_frequency_with_time(self):
        t = np.arange(self.n) / self.rate
        x = np.where(t < 1, np.sin(2 * np.pi * 32 * t), np.sin(2 * np.pi * 256 * t))
        stft = self.result(x)["stft"]
        first = stft["frequencies"][int(np.argmax(stft["amplitudes"][0]))]
        last = stft["frequencies"][int(np.argmax(stft["amplitudes"][-1]))]
        self.assertAlmostEqual(first, 32, delta=6)
        self.assertAlmostEqual(last, 256, delta=6)

    def test_empty_signal_serializes_without_nan_and_no_snr_claim(self):
        result = self.result(np.zeros(self.n))
        json.dumps(result, allow_nan=False)
        self.assertIsNone(result["features"]["dominantHz"])
        self.assertIsNone(result["features"]["snrDb"])
        self.assertIsNone(result["bands"][0]["percent"])
        self.assertIsNone(result["synchronousAverage"])

    def test_parameters_do_not_silently_clip_or_pad(self):
        for params in ({"filterType": "bandpass", "lowHz": 100, "highHz": 10},
                       {"filterType": "lowpass", "highHz": 1024},
                       {"quantity": "displacement", "detrend": "none"},
                       {"bands": [(0, 40), (30, 80)]}, {"bands": [(0, 2000)]}):
            with self.subTest(params=params), self.assertRaises(ValueError):
                self.result(**params)
        with self.assertRaises(ValueError):
            self.result(np.zeros(64))

    def test_realtime_snapshot_uses_bounded_tail_and_finds_peak(self):
        rate = 2048
        values = (0.2 * np.sin(2 * np.pi * 32 * np.arange(5000) / rate)).tolist()
        result = realtime_snapshot(values, rate, 100)
        self.assertTrue(result["available"])
        self.assertEqual(result["sampleCount"], 4096)
        self.assertEqual(result["sampleStart"], 100 + 5000 - 4096)
        self.assertEqual(result["features"]["dominantHz"], 32)
        json.dumps(result, allow_nan=False)

    def test_realtime_snapshot_waits_for_minimum_window(self):
        result = realtime_snapshot([0.0] * 63, 2048)
        self.assertFalse(result["available"])
        self.assertIsNone(result["features"]["rms"])


class RawApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.token = "analysis-test-only-0123456789abcdef0123456789"
        self.app = create_app(Settings(self.token, 8765, Path(self.temp.name)))
        self.store = self.app.state.controller.store
        self.writer = self.store.create({"name": "simulation sine", "source": "simulation"})
        self.writer.CHUNK_SAMPLES = 2048
        self.writer.ready(2048, 1700000000)
        for start in (0, 2048):
            values = (0.2 * np.sin(2 * np.pi * 32 * np.arange(start, start + 2048) / 2048)).tolist()
            self.writer.write(Batch(start, 2048, 1700000000, [0] * 2048, values, [400] * 2048, [80.] * 2048, [False] * 2048))
        self.writer.finish(None)
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765", headers={"Authorization": f"Bearer {self.token}"})

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def test_api_analyzes_originals_across_chunks_and_preserves_files(self):
        paths = self.store.chunks(self.writer.directory)
        before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
        result = self.client.post(f"/api/field/recordings/{self.writer.id}/analysis", json={"start": 512, "end": 3584, "nfft": 2048})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["sampleCount"], 3072)
        self.assertEqual(result.json()["features"]["dominantHz"], 32)
        self.assertEqual(result.json()["provenance"]["source"], "simulation")
        self.assertEqual(before, [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths])
        payload = b"".join(p.read_bytes()[HEADER.size:] for p in paths)[512 * RECORD.size:3584 * RECORD.size]
        self.assertEqual(result.json()["provenance"]["rawSha256"], hashlib.sha256(payload).hexdigest())

    def test_authentication_bounds_and_unknown_fields(self):
        url = f"/api/field/recordings/{self.writer.id}/analysis"
        self.assertEqual(self.client.post(url, json={"end": 4096}, headers={"Authorization": "bad"}).status_code, 401)
        for config in ({"end": 5000}, {"end": 4096, "file": "other"}, {"end": 4096, "nfft": 8000}):
            self.assertEqual(self.client.post(url, json=config).status_code, 422)
        self.app.state.controller  # No receiver was created or started.
        self.assertIsNone(self.app.state.controller.thread)

    def test_missing_chunks_are_not_interpolated(self):
        self.store.chunks(self.writer.directory)[0].rename(self.writer.directory / "preserved.bin")
        with self.assertRaisesRegex(ValueError, "缺失|重叠"):
            read_raw(self.store, self.writer.id, 0, 4096)

    def test_overrange_is_rejected(self):
        path = self.store.chunks(self.writer.directory)[0]
        with path.open("r+b") as stream:
            stream.seek(HEADER.size)
            stream.write(RECORD.pack(0, 0, 0.0, 400, 80., 3))
        with self.assertRaisesRegex(ValueError, "超量程"):
            read_raw(self.store, self.writer.id, 0, 4096)

    def test_corrupt_sequence_is_rejected(self):
        path = self.store.chunks(self.writer.directory)[0]
        with path.open("r+b") as stream:
            stream.seek(HEADER.size)
            stream.write(RECORD.pack(123, 0, 0.0, 400, 80., 2))
        with self.assertRaisesRegex(ValueError, "序号"):
            read_raw(self.store, self.writer.id, 0, 4096)


if __name__ == "__main__":
    unittest.main()
