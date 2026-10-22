from __future__ import annotations

import hashlib
import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from blade_acquisition.blade_synthesis import reconstruct_blade_passes
from blade_acquisition.receiver import Batch
from blade_acquisition.storage import RecordingStore
from blade_acquisition.web_rotation import dispatch


class BladeSynthesisTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = RecordingStore(self.root / "recordings")
        self.serial = 0

    def recording(self, point, amplitude=1., frequency=80., phase=0., rate=4096, length=8192,
                  angle=0, rssi=None, values=None):
        self.serial += 1
        t = np.arange(length) / rate
        x = amplitude * np.sin(2 * np.pi * frequency * t + phase) + .2 + .03 * t if values is None else np.asarray(values)
        start, end = 100, length - 100
        meta = {"mode": "automatic_stations", "collectionId": "c" * 32, "bladeId": "blade",
                "sessionId": f"{self.serial:032x}", "radialPointId": f"p{point}",
                "radialPointName": f"P{point}", "radiusM": point * .1, "azimuthDeg": angle,
                "stationId": f"p{point}-{angle}", "stationIndex": 1, "stationCount": 4, "lapIndex": 1,
                "completion": "confirmed_pass", "outcome": "observed", "identityVerified": False,
                "handoff": {"reason": "blade_left", "entrySampleIndex": 50,
                            "entryConfirmedSampleIndex": start - 1, "exitSampleIndex": end,
                            "exitConfirmedSampleIndex": end + 29}}
        writer = self.store.create({"name": "test", "pointCycle": meta, "source": "polytec_ivs500"})
        writer.ready(rate, 1700000000 + self.serial)
        writer.write(Batch(0, rate, 1700000000 + self.serial, [0] * length, x.tolist(),
                           [0] * length, rssi or [80.] * length, [False] * length))
        writer.finish(None)
        return writer.id

    def analyze(self, ids, **extra):
        return reconstruct_blade_passes(self.store, {"recordingIds": ids, "detrend": "linear",
                                                     "synthesis": {"minHz": 20, "maxHz": 300}, **extra})

    def test_known_shape_recovered_despite_unknown_pass_phase_and_drift(self):
        amplitudes = [.2, .5, .8, 1.]
        ids = [self.recording(i + 1, amplitude=amp, phase=i * 1.17) for i, amp in enumerate(amplitudes)]
        result = self.analyze(ids)
        synth = result["synthesis"]
        self.assertEqual(synth["status"], "candidates_available")
        candidate = min(synth["candidates"], key=lambda c: abs(c["frequencyHz"] - 80))
        self.assertAlmostEqual(candidate["frequencyHz"], 80., delta=candidate["frequencyGridHz"])
        np.testing.assert_allclose([p["normalizedAmplitude"] for p in candidate["points"]], amplitudes, atol=.005)
        np.testing.assert_allclose([p["displacementRmsM"] for p in candidate["points"]],
                                   np.array(amplitudes) / (2 * np.pi * 80 * math.sqrt(2)), rtol=.02)
        self.assertTrue(all(p["spatialPhaseDeg"] is None for p in candidate["points"]))
        self.assertFalse(result["phaseAvailable"])
        self.assertFalse(synth["damageAssessmentAvailable"])
        json.dumps(result, allow_nan=False)

    def test_merge_mapping_and_quality_hole_preserve_raw_and_sample_order(self):
        rssi = [80.] * 8192
        rssi[1000:1100] = [0.] * 100
        ids = [self.recording(1, rssi=rssi), self.recording(1, angle=90, rate=2048)]
        before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in self.root.rglob("*") if path.is_file()}
        saved = []

        def sink(source, mapping, raw, processed):
            saved.append((dict(mapping), raw.copy(), processed.copy()))

        result = reconstruct_blade_passes(self.store, {"recordingIds": ids, "rssiThresholdPercent": 50}, segment_sink=sink)
        point = result["synthesis"]["mergedPoints"][0]
        self.assertEqual(point["samples"], 450 + 3496 + 7992)
        self.assertEqual(len(point["segments"]), 3)
        self.assertEqual([(s["originalStart"], s["originalEnd"]) for s in point["segments"]], [(100, 1000), (1100, 8092), (100, 8092)])
        self.assertEqual(point["segments"][1]["mergedStart"], 450)
        self.assertEqual(point["segments"][1]["mergedSampleRate"], 2048)
        self.assertEqual(point["segments"][2]["compressedStartSeconds"], (7992 - 100) / 4096)
        self.assertAlmostEqual(point["durationSeconds"], (7992 - 100) / 4096 + 7992 / 2048)
        self.assertEqual(sum(len(raw) for _, raw, _ in saved), 2 * (8192 - 200) - 100)
        after = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)

    def test_stitched_fft_uses_joined_point_with_boundary_offset_correction(self):
        first = self.recording(1, frequency=80, phase=0, angle=0, rate=4096)
        second = self.recording(1, frequency=80, phase=1.2, angle=90, rate=2048)
        result = self.analyze([first, second])["synthesis"]["mergedPoints"][0]
        spectrum = result["stitchedSpectrum"]
        self.assertEqual(spectrum["method"], "joined-segments-offset-aligned-hann-periodogram")
        self.assertEqual(result["stitchInfo"]["segments"], 2)
        self.assertEqual(result["stitchInfo"]["resampledSegments"], 1)
        self.assertEqual(spectrum["samples"], result["stitchInfo"]["originalSamples"])
        self.assertGreaterEqual(len(spectrum["frequencies"]), 2)
        peak = int(np.argmax(spectrum["amplitudesMps"]))
        self.assertAlmostEqual(spectrum["frequencies"][peak], 80, delta=spectrum["frequencySpacingHz"] * 2)
        self.assertTrue(all(math.isfinite(value) for value in spectrum["amplitudesMps"]))
        self.assertEqual(len(result["stitchedWaveform"]["seconds"]), len(result["stitchedWaveform"]["valuesMps"]))
        json.dumps(result, allow_nan=False)

    def test_stitched_indices_and_fft_follow_configured_analysis_rate(self):
        rid = self.recording(1, rate=20000, length=40000, frequency=80)
        point = self.analyze([rid], analysisSampleRate=10000)["synthesis"]["mergedPoints"][0]
        segment = point["segments"][0]
        self.assertEqual(segment["sampleRate"], 10000)
        self.assertEqual(segment["sourceSamples"], segment["originalEnd"] - segment["originalStart"])
        self.assertEqual(segment["analysisSamples"], segment["mergedEnd"] - segment["mergedStart"])
        self.assertEqual(point["samples"], segment["analysisSamples"])
        self.assertAlmostEqual(point["durationSeconds"], segment["compressedEndSeconds"])
        self.assertAlmostEqual(point["stitchedSpectrum"]["sampleRate"], 10000)

    def test_station_weight_does_not_count_retries_as_extra_angles(self):
        ids = []
        for point in range(1, 5):
            ids.extend([self.recording(point, amplitude=1., angle=0) for _ in range(3)])
            ids.append(self.recording(point, amplitude=3., angle=90))
        result = self.analyze(ids)
        candidate = min(result["synthesis"]["candidates"], key=lambda c: abs(c["frequencyHz"] - 80))
        for point in candidate["points"]:
            self.assertEqual(point["stationCount"], 2)
            np.testing.assert_allclose(point["velocityRmsMps"], math.sqrt((1 ** 2 + 3 ** 2) / 4), rtol=.02)

    def test_distinct_tones_do_not_become_a_common_mode(self):
        result = self.analyze([self.recording(point, frequency=40 + 50 * point) for point in range(1, 5)])
        self.assertEqual(result["synthesis"]["candidates"], [])
        self.assertTrue(result["synthesis"]["bandResponses"])
        self.assertEqual(result["synthesis"]["status"], "band_responses_only")

    def test_short_segments_cannot_manufacture_low_frequency_resolution(self):
        ids = [self.recording(point, length=400, rate=10000, frequency=20) for point in range(1, 5)]
        result = self.analyze(ids, synthesis={"minHz": 1, "maxHz": 30})
        self.assertEqual(result["synthesis"]["candidates"], [])
        self.assertEqual(result["synthesis"]["bandResponses"], [])
        self.assertEqual(result["coverage"]["validSamples"], 800)

    def test_zero_signal_and_single_point_do_not_create_shape(self):
        one = self.recording(1)
        self.assertEqual(self.analyze([one])["synthesis"]["status"], "insufficient_evidence")
        ids = [self.recording(point, values=np.zeros(8192)) for point in range(1, 5)]
        result = self.analyze(ids)
        self.assertEqual(result["synthesis"]["candidates"], [])
        self.assertEqual(result["synthesis"]["bandResponses"], [])
        json.dumps(result, allow_nan=False)

    def test_broadband_transient_is_not_a_shared_resonance(self):
        values = np.exp(-np.arange(8192) / 100)
        result = self.analyze([self.recording(point, values=values * point) for point in range(1, 5)])
        self.assertEqual(result["synthesis"]["candidates"], [])

    def test_internal_step_is_flagged_without_deleting_or_normalizing_samples(self):
        values = np.zeros(8192)
        values[4000:] = .1
        rid = self.recording(1, values=values)
        result = self.analyze([rid])
        segment = result["synthesis"]["mergedPoints"][0]["segments"][0]
        self.assertEqual(segment["discontinuityAudit"]["count"], 1)
        self.assertEqual(segment["discontinuityAudit"]["firstOriginalSampleIndices"], [4000])
        self.assertAlmostEqual(segment["discontinuityAudit"]["maxStepMps"], .1)
        self.assertEqual(segment["plotFilter"]["flaggedSteps"], 1)
        self.assertGreaterEqual(segment["plotFilter"]["hiddenTimeBuckets"], 1)
        self.assertIn(None, segment["plotTimeDomain"]["values"])
        self.assertLessEqual(len(segment["plotTimeDomain"]["values"]), 256)
        self.assertNotIn(None, segment["timeDomain"]["values"])
        self.assertEqual(segment["plotFilter"]["effect"], "plot-only; source-samples-metrics-and-spectra-unchanged")
        self.assertEqual(result["coverage"]["validSamples"], 7992)
        self.assertTrue(result["synthesis"]["qualityWarnings"])

    def test_options_validation_and_existing_worker_dispatch(self):
        rid = self.recording(1)
        for option in ({"minHz": True}, {"minHz": 200, "maxHz": 100}, {"maxCandidates": 10},
                       {"unknown": 0}, {"minCycles": 2}, {"maxHz": float("nan")}):
            with self.subTest(option=option), self.assertRaises(ValueError):
                self.analyze([rid], synthesis=option)
        result = dispatch(self.root, {"action": "blade-passes", "parameters": {"recordingIds": [rid], "synthesis": {}}})
        self.assertIn("synthesis", result)
        old_result = dispatch(self.root, {"action": "blade-passes", "parameters": {"recordingIds": [rid]}})
        self.assertNotIn("synthesis", old_result)


if __name__ == "__main__":
    unittest.main()
