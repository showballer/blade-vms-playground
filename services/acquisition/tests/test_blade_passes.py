from __future__ import annotations

import copy
import hashlib
import json
import math
import tempfile
import tracemalloc
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from blade_acquisition.blade_passes import analyze_blade_passes
from blade_acquisition.receiver import Batch
from blade_acquisition.rotation import RotationRequest, calculate_rotation
from blade_acquisition.storage import HEADER, RECORD, RecordingStore, atomic_json


class BladePassAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = RecordingStore(Path(self.temporary.name) / "recordings")
        self.serial = 0

    def tearDown(self):
        self.temporary.cleanup()

    def recording(self, *, samples=2000, amplitude=0.2, rate=1000, start=200, end=1600,
                  radial="p1", radius=.31, azimuth=0, session=None, collection="c" * 32,
                  stride=1, rssi=None, flags=None, values=None, **meta_changes):
        self.serial += 1
        meta = {"mode": "automatic_stations", "collectionId": collection, "bladeId": "2",
                "sessionId": session or f"{self.serial:032x}", "radialPointId": radial,
                "radialPointName": radial.upper(), "radiusM": radius, "azimuthDeg": azimuth,
                "stationId": radial + "-" + str(azimuth), "stationIndex": 1, "stationCount": 4, "lapIndex": 1,
                "identitySource": "operator_assigned", "identityVerified": False,
                "coverageKind": "sparse_station_passes", "completion": "confirmed_pass", "outcome": "observed",
                # The intentionally wider legacy top-level boundary must not be used.
                "entrySampleIndex": 0, "exitSampleIndex": samples - 1,
                "handoff": {"reason": "blade_left", "entrySampleIndex": start - 20,
                            "entryConfirmedSampleIndex": start - 1, "exitSampleIndex": end,
                            "exitConfirmedSampleIndex": end + 29}, **meta_changes}
        values = (amplitude * np.sin(2 * np.pi * 50 * np.arange(samples) / rate)) if values is None else np.asarray(values)
        rssi = [80.] * math.ceil(samples / stride) if rssi is None else rssi
        writer = self.store.create({"name": "叶片测量", "point": radial, "source": "polytec_ivs500", "pointCycle": meta})
        origin = 1_700_000_000 + self.serial
        writer.ready(rate, origin)
        writer.write(Batch(0, rate, origin, [0] * samples, values.tolist(), [0] * len(rssi), rssi,
                           flags or [False] * samples, rssi_sample_stride=stride))
        writer.finish(None)
        return writer.id

    def analyze(self, *ids, **parameters):
        return analyze_blade_passes(self.store, {"recordingIds": list(ids), **parameters})

    def change(self, recording_id, change):
        directory = self.store.directory(recording_id)
        manifest = self.store._read_manifest(directory)
        change(manifest)
        atomic_json(directory / "manifest.json", manifest)

    def test_confirmed_interval_excludes_entry_wait_and_exit_tail_without_modifying_raw(self):
        rid = self.recording()
        directory = self.store.directory(rid)
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.is_file()}
        result = self.analyze(rid)
        source = result["sources"][0]
        self.assertEqual(source["candidateRange"], {"start": 200, "end": 1600})
        self.assertEqual(source["validRanges"], [{"start": 200, "end": 1600, "samples": 1400}])
        self.assertAlmostEqual(source["metrics"]["rmsVelocityMps"], .2 / math.sqrt(2), places=12)
        segment = source["segments"][0]
        spectrum = segment["spectrum"]
        maximum = int(np.argmax(spectrum["amplitudes"]))
        self.assertAlmostEqual(spectrum["frequencies"][maximum], 50)
        self.assertAlmostEqual(spectrum["amplitudes"][maximum], .2, delta=.001)
        self.assertGreaterEqual(segment["timeDomain"]["sampleIndices"][0], 200)
        self.assertGreaterEqual(segment["timeDomain"]["seconds"][0], .2)
        self.assertFalse(result["phaseAvailable"])
        self.assertNotIn("modalMatch", result)
        self.assertNotIn("relativePhaseDeg", json.dumps(result))
        after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.is_file()}
        self.assertEqual(before, after)
        json.dumps(result, allow_nan=False)

    def test_analysis_sample_rate_resamples_segments_without_changing_source_time_ranges(self):
        rid = self.recording(samples=40000, rate=20000, start=2000, end=32000)
        source = self.analyze(rid, analysisSampleRate=10000)["sources"][0]
        segment = source["segments"][0]
        self.assertEqual(source["sampleRate"], 10000)
        self.assertEqual(source["originalSampleRate"], 20000)
        self.assertEqual(source["validRanges"], [{"start": 2000, "end": 32000, "samples": 30000}])
        self.assertEqual(source["sourceValidSamples"], 30000)
        self.assertEqual(source["validSamples"], 15000)
        self.assertEqual(segment["samples"], 15000)
        self.assertEqual(segment["sourceSamples"], 30000)
        self.assertAlmostEqual(segment["durationSeconds"], 1.5)
        self.assertAlmostEqual(source["validSeconds"], 1.5)
        self.assertAlmostEqual(segment["spectrum"]["frequencies"][int(np.argmax(segment["spectrum"]["amplitudes"]))], 50)

    def test_analysis_target_does_not_upsample_lower_rate_recording(self):
        rid = self.recording(samples=4000, rate=8000, start=400, end=3200)
        source = self.analyze(rid, analysisSampleRate=10000)["sources"][0]
        self.assertEqual(source["sampleRate"], 8000)
        self.assertEqual(source["validSamples"], 2800)
        self.assertAlmostEqual(source["validSeconds"], .35)

    def test_low_rssi_and_overrange_split_segments_keep_original_time(self):
        rssi = [80.] * 2000
        rssi[600:700] = [10.] * 100
        flags = [False] * 2000
        flags[1000:1100] = [True] * 100
        rid = self.recording(rssi=rssi, flags=flags)
        result = self.analyze(rid, rssiThresholdPercent=50)
        source = result["sources"][0]
        self.assertEqual([(r["start"], r["end"]) for r in source["validRanges"]], [(200, 600), (700, 1000), (1100, 1600)])
        self.assertEqual(source["validSamples"], 1200)
        self.assertEqual(source["segments"][1]["timeDomain"]["seconds"][0], .7)
        self.assertEqual({r["reason"]: r["samples"] for r in source["exclusions"]},
                         {"outside_confirmed_pass": 600, "overrange": 100, "low_rssi": 100})

    def test_rssi_stride_does_not_treat_unsampled_positions_as_missing(self):
        rssi = [80.] * 500
        rssi[150:175] = [0.] * 25
        rid = self.recording(stride=4, rssi=rssi)
        result = self.analyze(rid, rssiThresholdPercent=30)
        source = result["sources"][0]
        self.assertEqual([(r["start"], r["end"]) for r in source["validRanges"]], [(200, 600), (700, 1600)])
        self.assertNotIn("missing_rssi", [r["reason"] for r in source["exclusions"]])
        self.assertEqual(source["provenance"]["rssiSampleStride"], 4)

    def test_missing_and_invalid_rssi_exclude_their_velocity_intervals(self):
        rid = self.recording(stride=4, rssi=[80.] * 300 + [float("nan")] * 25)
        source = self.analyze(rid)["sources"][0]
        self.assertEqual(source["validRanges"], [{"start": 200, "end": 1200, "samples": 1000}])
        reasons = {item["reason"]: item["samples"] for item in source["exclusions"]}
        self.assertEqual(reasons["invalid_rssi"], 100)
        self.assertEqual(reasons["missing_rssi"], 300)

    def test_threshold_none_does_not_invent_absolute_rssi_requirement(self):
        rid = self.recording(rssi=[0.] * 2000)
        self.assertEqual(self.analyze(rid)["coverage"]["validSamples"], 1400)
        self.assertEqual(self.analyze(rid, rssiThresholdPercent=1)["sources"][0]["reason"], "no_usable_segment")

    def test_missing_or_invalid_boundaries_excluded_without_poisoning_valid_records(self):
        valid = self.recording()
        incomplete = self.recording(completion="missing_exit", outcome="missed")
        invalid = self.recording(handoff={"reason": "blade_left", "entrySampleIndex": 2,
                                         "entryConfirmedSampleIndex": True, "exitSampleIndex": 300,
                                         "exitConfirmedSampleIndex": 330})
        result = self.analyze(valid, incomplete, invalid)
        self.assertEqual(result["coverage"]["includedRecords"], 1)
        self.assertEqual([item.get("reason") for item in result["sources"]], [None, "missing_exit", "invalid_pass_boundaries"])

    def test_short_segment_does_not_create_fake_fft(self):
        rid = self.recording(start=200, end=250)
        source = self.analyze(rid)["sources"][0]
        self.assertEqual(source["reason"], "no_usable_segment")
        self.assertEqual(source["segments"], [])
        self.assertIn({"reason": "segment_shorter_than_64_samples", "samples": 50}, source["exclusions"])

    def test_duration_weighted_rms_groups_only_same_point_and_station(self):
        first = self.recording(amplitude=.2, end=1200)  # 1000 samples
        second = self.recording(amplitude=.4, end=1700)  # 1500 samples
        tip = self.recording(amplitude=.3, radial="p2", radius=.8)
        other_azimuth = self.recording(amplitude=.6, radial="p2", radius=.8, azimuth=90)
        result = self.analyze(first, second, tip, other_azimuth)
        p1 = result["points"][0]["stations"][0]
        expected = math.sqrt(((.2 ** 2 / 2) * 1000 + (.4 ** 2 / 2) * 1500) / 2500)
        self.assertAlmostEqual(p1["metrics"]["rmsVelocityMps"], expected, places=12)
        self.assertEqual(p1["validSamples"], 2500)
        self.assertEqual([item["azimuthDeg"] for item in result["amplitudeDistributions"]], [0, 90])
        self.assertEqual([len(item["points"]) for item in result["amplitudeDistributions"]], [2, 1])

    def test_equal_duration_different_rates_have_equal_weight(self):
        first = self.recording(amplitude=.2, rate=1000, start=200, end=1200)
        second = self.recording(amplitude=.4, rate=2000, samples=3000, start=200, end=2200)
        result = self.analyze(first, second)
        station = result["points"][0]["stations"][0]
        expected = math.sqrt((.2 ** 2 + .4 ** 2) / 4)
        self.assertEqual(station["validSamples"], 3000)
        self.assertEqual(station["validSeconds"], 2)
        self.assertAlmostEqual(station["metrics"]["rmsVelocityMps"], expected, places=12)
        self.assertAlmostEqual(result["amplitudeDistributions"][0]["points"][0]["value"], expected, places=12)
        self.assertTrue(any("有效时长加权" in warning for warning in result["warnings"]))

    def test_metadata_group_or_point_conflicts_never_silently_merge(self):
        first = self.recording()
        for kwargs in ({"collection": "d" * 32}, {"bladeId": "3"}, {"radius": .4}, {"radialPointName": "changed"}):
            second = self.recording(**kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.analyze(first, second)
        for field, value in (("collectionId", None), ("sessionId", True), ("radiusM", True),
                             ("azimuthDeg", 360), ("radialPointId", ""), ("stationIndex", False)):
            rid = self.recording(**{field: value})
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.analyze(rid)

    def test_strict_parameters_and_limits_reject_before_raw_read(self):
        rid = self.recording()
        for options in ({"rssiThresholdPercent": True}, {"rssiThresholdPercent": "20"},
                        {"rssiThresholdPercent": float("nan")}, {"rssiThresholdPercent": 101},
                        {"detrend": "invalid"}, {"unknown": 1}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.analyze(rid, **options)
        with self.assertRaises(ValueError):
            self.analyze(rid, rid)
        with patch("blade_acquisition.blade_passes.MAX_SAMPLES", 1999), self.assertRaisesRegex(ValueError, "800"):
            self.analyze(rid)

    def test_corrupted_chunk_index_and_truncation_are_rejected(self):
        rid = self.recording()
        path = self.store.chunks(self.store.directory(rid))[0]
        data = bytearray(path.read_bytes())
        original = bytes(data)
        row = list(RECORD.unpack_from(data, HEADER.size + 500 * RECORD.size))
        row[0] += 1
        RECORD.pack_into(data, HEADER.size + 500 * RECORD.size, *row)
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "样本序号"):
            self.analyze(rid)
        path.write_bytes(original[:-1])
        with self.assertRaisesRegex(ValueError, "尾部"):
            self.analyze(rid)

    def test_old_rotation_cannot_bypass_guard_even_nested_csv_metadata(self):
        rid = self.recording()
        request = RotationRequest(recordingIds=[rid], rpm=600)
        with self.assertRaisesRegex(ValueError, "有效片段"):
            calculate_rotation(self.store, request)
        self.change(rid, lambda m: m.update(sourceMetadata={"pointCycle": m.pop("pointCycle")}))
        with self.assertRaisesRegex(ValueError, "有效片段"):
            calculate_rotation(self.store, request)

    def test_duplicate_native_and_csv_original_ids_or_same_pass_rejected(self):
        first = self.recording(session="a" * 32)
        second = self.recording()
        self.change(second, lambda m: m.update(sourceMetadata={"recordingId": first}))
        with self.assertRaisesRegex(ValueError, "副本"):
            self.analyze(first, second)
        third = self.recording(session="a" * 32)
        with self.assertRaisesRegex(ValueError, "重复记录"):
            self.analyze(first, third)

    def test_import_acquisition_time_is_distinct_from_store_time(self):
        rid = self.recording()
        self.change(rid, lambda m: m.update(sourceSampleOrigin=1_600_000_000))
        provenance = self.analyze(rid)["sources"][0]["provenance"]
        self.assertEqual(provenance["originalSampleOrigin"], 1_600_000_000)
        self.assertEqual(provenance["storeSampleOrigin"], 1_700_000_001)

    def test_linear_detrend_and_independent_segment_frequency_resolution(self):
        count = 2000
        values = .1 + np.arange(count) * .0001 + .2 * np.sin(2 * np.pi * 50 * np.arange(count) / 1000)
        rid = self.recording(values=values)
        source = self.analyze(rid, detrend="linear")["sources"][0]
        self.assertAlmostEqual(source["metrics"]["rmsVelocityMps"], .2 / math.sqrt(2), delta=.0001)
        self.assertAlmostEqual(source["segments"][0]["spectrum"]["frequencySpacingHz"], 1000 / 1400)

    def test_spectrum_and_response_bounds_do_not_join_independent_gaps(self):
        rid = self.recording(samples=5000, start=200, end=4500)
        with patch("blade_acquisition.blade_passes.MAX_FFT_SAMPLES", 512):
            segment = self.analyze(rid)["sources"][0]["segments"][0]
        self.assertEqual(segment["spectrum"]["samples"], 512)
        self.assertTrue(segment["spectrum"]["boundedWindow"])
        self.assertLessEqual(len(segment["timeDomain"]["values"]), 256)
        self.assertLessEqual(len(segment["spectrum"]["amplitudes"]), 512)
        flags = [i % 100 == 0 for i in range(2000)]
        rid = self.recording(flags=flags)
        with patch("blade_acquisition.blade_passes.MAX_SEGMENTS_PER_RECORD", 2), self.assertRaisesRegex(ValueError, "片段过多"):
            self.analyze(rid)

    def test_full_segment_response_stays_under_worker_output_limit(self):
        flags = [False] * 5000
        flags[2000:2100] = [True] * 100
        ids = [self.recording(samples=5000, start=200, end=4500, flags=flags) for _ in range(64)]
        result = self.analyze(*ids)
        self.assertEqual(result["coverage"]["segmentCount"], 128)
        self.assertLess(len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode()), 8 * 1024 * 1024)

    def test_high_frequency_quality_gaps_keep_boundaries_without_unbounded_python_ranges(self):
        count, start, end = 1_000_000, 200, 999_800
        rid = self.recording()
        self.change(rid, lambda manifest: manifest.update(samples=count, pointCycle={
            **manifest["pointCycle"], "handoff": {"reason": "blade_left", "entrySampleIndex": 180,
                "entryConfirmedSampleIndex": start - 1, "exitSampleIndex": end,
                "exitConfirmedSampleIndex": end + 29}}))
        values = .2 * np.sin(2 * np.pi * 50 * np.arange(count) / 1000)
        quality = np.zeros(count, dtype=np.uint8)
        quality[::2] = 2
        expected = [(10001, 10100), (500001, 500066)]
        for lo, hi in expected:
            quality[lo:hi] = 0
        valid = sum(hi - lo for lo, hi in expected)
        short = int(np.count_nonzero(quality[start:end] == 0)) - valid
        overrange = int(np.count_nonzero(quality[start:end] & 2))
        # Isolate interval selection from file decoding/fixture allocation. The
        # previous tuple-per-island implementation peaks above 60 MB here, even
        # though only two usable intervals survive. Allow room for NumPy's
        # compact temporary arrays without depending on exact allocator sizes.
        with patch("blade_acquisition.blade_passes._raw", return_value=(values, quality, {})):
            tracemalloc.start()
            try:
                result = self.analyze(rid)
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
        source = result["sources"][0]
        self.assertEqual([(item["start"], item["end"]) for item in source["validRanges"]], expected)
        self.assertEqual(result["coverage"]["segmentCount"], 2)
        self.assertEqual(source["validSamples"], valid)
        self.assertEqual({item["reason"]: item["samples"] for item in source["exclusions"]}, {
            "outside_confirmed_pass": count - (end - start), "overrange": overrange,
            "segment_shorter_than_64_samples": short})
        self.assertLess(peak, 32 * count, "Quality islands must not allocate Python tuples before filtering")

    def test_short_islands_do_not_count_toward_segment_limits_but_total_limit_still_applies(self):
        flags = [index % 2 == 0 for index in range(2000)]
        for start, end in [(401, 500), (1001, 1100)]:
            flags[start:end] = [False] * (end - start)
        first, second = self.recording(flags=flags), self.recording(flags=flags)
        with patch("blade_acquisition.blade_passes.MAX_SEGMENTS_PER_RECORD", 2), patch(
                "blade_acquisition.blade_passes.MAX_SEGMENTS_TOTAL", 4):
            result = self.analyze(first, second)
        self.assertEqual(result["coverage"]["segmentCount"], 4)
        self.assertEqual(result["coverage"]["validSamples"], 396)
        with patch("blade_acquisition.blade_passes.MAX_SEGMENTS_TOTAL", 3), self.assertRaisesRegex(ValueError, "片段过多"):
            self.analyze(first, second)

    def test_simulation_provenance_stays_visible_and_duplicate_radius_is_one_spatial_location(self):
        first = self.recording()
        second = self.recording(radial="p2", radius=.31)
        self.change(first, lambda m: m.update(source="offline", sourceFile="legacy.csv",
                                            sourceMetadata={"source": "simulation"}))
        result = self.analyze(first, second)
        self.assertTrue(result["hasSimulation"])
        self.assertTrue(result["sources"][0]["simulation"])
        self.assertEqual(result["sources"][0]["source"], "simulation")
        self.assertEqual(result["sources"][0]["provenance"]["sourceFile"], "legacy.csv")
        self.assertTrue(any("模拟数据" in item for item in result["warnings"]))
        self.assertEqual(result["coverage"]["measuredRadialLocations"], 1)
        self.assertEqual(result["amplitudeDistributions"][0]["distinctRadiusCount"], 1)


if __name__ == "__main__":
    unittest.main()
