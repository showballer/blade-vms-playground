"""Numerical/data-contract tests; no hardware, credentials or network."""
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from scipy.signal import resample_poly

from blade_acquisition.native_capture import SAMPLES, validate_capture, import_capture
from blade_acquisition.storage import RecordingStore, HEADER, MAGIC, atomic_json, recording_summary
from blade_acquisition.upload_sampling import prepare_upload
from blade_acquisition.waveform import WaveformReader, envelope_rows
from blade_acquisition.blade_passes import _range
from blade_acquisition.csv_export import stream_csv
from blade_acquisition.web_rotation import dispatch


class UploadSamplingTests(unittest.TestCase):
    def test_cached_legacy_early_pass_preserves_diagnostic_summary_without_raw_writes(self):
        manifest = self.source(n=25000)
        manifest.update(diagnosticOnly=True, validMeasurement=False)
        evidence = {"passCompleteness": "confirmed", "completenessReason": "background_and_entry_exit",
                    "sampleClock": "continuous_session_raw"}
        manifest["pointCycle"].update(completion="diagnostic_pass", recordPreparation="deferred_from_continuous_raw",
            handoff=dict(evidence), diagnosticDetection={"enabled": True, "trigger": dict(evidence)})
        source = self.store.directory(self.id) / "manifest.json"
        atomic_json(source, manifest)
        before = source.read_bytes()
        result = prepare_upload(self.store, self.id, 50000, self.cache)
        self.assertEqual(result["recording"]["pointCycle"]["passCompleteness"], "confirmed")
        cache_manifest = Path(result["directory"]) / "manifest.json"
        cached = json.loads(cache_manifest.read_text())
        for field in ("passCompleteness", "completenessReason"):
            cached["pointCycle"].pop(field, None)
        atomic_json(cache_manifest, cached)
        again = prepare_upload(self.store, self.id, 50000, self.cache)
        self.assertEqual(again["directory"], result["directory"])
        self.assertEqual(again["recording"]["pointCycle"]["passCompleteness"], "confirmed")
        self.assertEqual(again["recording"]["pointCycle"]["completion"], "diagnostic_pass")
        self.assertFalse(again["recording"]["validMeasurement"])
        self.assertEqual(source.read_bytes(), before)

    def test_continuous_session_global_clock_is_preserved_when_station_is_downsampled(self):
        manifest = self.source(n=250000)
        cycle = manifest["pointCycle"]
        cycle["bufferFence"] = {
            "sampleIndex": 9000000, "sampleRate": 250000, "rssiSampleStride": 32,
            "drainedSampleCount": 32000, "completedAt": 1800000036.0,
            "source": "sdk-buffer-drained", "evidence": {"sampleIndex": 8999999}}
        cycle["continuousSession"] = {
            "id": "b" * 32, "directory": "continuous-sessions/" + "b" * 32,
            "sampleStart": 9000000, "sampleEndExclusive": 9250000,
            "sampleRate": 250000, "sampleIndex": 9000000}
        source = self.store.directory(self.id)
        atomic_json(source / "manifest.json", manifest)
        source_bytes = (source / "manifest.json").read_bytes()
        result = prepare_upload(self.store, self.id, 50000, self.cache)
        derived = result["recording"]["pointCycle"]
        for key in ("bufferFence", "continuousSession"):
            self.assertEqual(derived[key], {**cycle[key], "sampleClock": "continuous_session_raw"})
        self.assertEqual(derived["handoff"]["entrySampleIndex"], 20000)
        self.assertEqual(result["recording"]["samples"], 50000)
        self.assertEqual((source / "manifest.json").read_bytes(), source_bytes)

    def continuous_source(self, missing_head=False):
        manifest = self.source(n=250000)
        manifest.update(diagnosticOnly=True, validMeasurement=False)
        cycle = manifest["pointCycle"]
        offset = 9000003  # Deliberately not aligned to any resampling phase.
        cycle.update(mode="automatic_stations", collectionId="c" * 32, sessionId="d" * 32,
                     bladeId="2", radialPointId="p1", radiusM=.16, azimuthDeg=90,
                     stationIndex=2, stationCount=4, lapIndex=1, identityVerified=False,
                     completion="diagnostic_pass", outcome="diagnostic", passCompleteness="confirmed",
                     continuousSession={"sampleClock": "continuous_session_raw", "sampleRate": 250000,
                                        "sampleStart": offset, "sampleEndExclusive": offset + 250000})
        handoff = cycle["handoff"]
        handoff.update({key: value + offset for key, value in handoff.items() if type(value) is int})
        handoff.update(sampleClock="continuous_session_raw", passCompleteness="confirmed")
        if missing_head:
            handoff.update(entrySampleIndex=offset - 20, entryConfirmedSampleIndex=offset - 1)
        atomic_json(self.store.directory(self.id) / "manifest.json", manifest)
        return manifest

    def test_continuous_derivative_maps_source_gates_after_offset_without_clamping(self):
        manifest = self.continuous_source()
        source_bytes = (self.store.directory(self.id) / "manifest.json").read_bytes()
        for rate in (10000, 30000, 50000, 100000):
            with self.subTest(rate=rate):
                result = prepare_upload(self.store, self.id, rate, self.cache)
                derived = result["recording"]
                self.assertEqual(derived["pointCycle"], manifest["pointCycle"])
                self.assertEqual(derived["sampling"]["sourceHandoff"], manifest["pointCycle"]["handoff"])
                self.assertTrue(derived["diagnosticOnly"])
                self.assertFalse(derived["validMeasurement"])
                self.assertEqual(_range(derived["pointCycle"], derived["samples"], manifest=derived)[1],
                                 "diagnostic_requires_opt_in")
                segment, reason, basis = _range(derived["pointCycle"], derived["samples"],
                                                manifest=derived, include_diagnostic=True)
                self.assertIsNone(reason)
                self.assertEqual(segment, (math.ceil(100001 * rate / 250000), math.ceil(200001 * rate / 250000)))
                self.assertEqual(basis["sourceOffset"], 9000003)
                self.assertEqual(basis["sourceLocalRange"], {"start": 100001, "end": 200001})
                self.assertEqual(basis["sourceSampleRate"], 250000)
                self.assertEqual(basis["sampleRate"], rate)
                # No global provenance is rewritten to fit this small waveform.
                self.assertGreater(derived["pointCycle"]["handoff"]["entrySampleIndex"], derived["samples"])
        self.assertEqual((self.store.directory(self.id) / "manifest.json").read_bytes(), source_bytes)

    def test_continuous_derivative_missing_head_is_still_excluded_after_csv_roundtrip(self):
        manifest = self.continuous_source(missing_head=True)
        result = prepare_upload(self.store, self.id, 50000, self.cache)
        derived = result["recording"]
        self.assertEqual(derived["pointCycle"]["handoff"], manifest["pointCycle"]["handoff"])
        self.assertEqual(_range(derived["pointCycle"], derived["samples"], manifest=derived, include_diagnostic=True)[1],
                         "pass_boundary_outside_recording")
        directory = Path(result["directory"])
        chunks = [(p, (p.stat().st_size - HEADER.size) // SAMPLES.itemsize) for p in sorted(directory.glob("chunk-*.bin"))]
        upload = self.root / ".upload-continuous-derived"
        upload.write_text("".join(stream_csv(derived, chunks)))
        imported = dispatch(self.root, {"action": "import", "filename": "derived.csv", "inputFile": str(upload)})["recordings"][0]
        self.assertEqual(imported["pointCycle"], manifest["pointCycle"])
        self.assertEqual(imported["sampling"], derived["sampling"])
        self.assertEqual(_range(imported["pointCycle"], imported["samples"], manifest=imported, include_diagnostic=True)[1],
                         "pass_boundary_outside_recording")

    def test_continuous_derivative_invalid_mapping_and_old_clamped_copy_are_rejected(self):
        import copy
        self.continuous_source()
        derived = prepare_upload(self.store, self.id, 50000, self.cache)["recording"]
        mutations = [
            lambda m: m["sampling"].update(version=1),
            lambda m: m["sampling"].pop("pointCycleIndexMapping"),
            lambda m: m["sampling"]["pointCycleIndexMapping"].update(sourceOffset=9000000),
            lambda m: m["sampling"]["pointCycleIndexMapping"].update(numerator=2),
            lambda m: m["sampling"]["pointCycleIndexMapping"].update(numerator=True),
            lambda m: m["sampling"].update(sourceSamples=250001),
            lambda m: m["sampling"].update(sourceSampleRate=100000),
            lambda m: m["pointCycle"]["handoff"].update(entrySampleIndex=19999),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                bad = copy.deepcopy(derived)
                mutate(bad)
                self.assertEqual(_range(bad["pointCycle"], bad["samples"], manifest=bad, include_diagnostic=True)[1],
                                 "continuous_sample_clock_mismatch")

    def test_continuous_telemetry_keeps_source_archive_sample_indices(self):
        manifest = self.continuous_source()
        source = self.store.directory(self.id)
        event = {"event": "blade_left", "hostTime": 1800000036.5, "sampleIndex": 9201004,
                 "axis1": {"angle": 13.5}}
        data = (json.dumps(event) + "\n").encode()
        (source / "turntable.jsonl").write_bytes(data)
        manifest["turntable"] = {"telemetry": {"file": "turntable.jsonl", "events": 1,
                                               "sha256": hashlib.sha256(data).hexdigest()}}
        atomic_json(source / "manifest.json", manifest)
        result = prepare_upload(self.store, self.id, 50000, self.cache)
        payload = (Path(result["directory"]) / "turntable.jsonl").read_bytes()
        self.assertEqual(json.loads(payload), event)
        self.assertEqual(result["recording"]["turntable"]["telemetry"]["sha256"], hashlib.sha256(payload).hexdigest())

    def test_sparse_rssi_cadence_is_not_misclassified_as_packet_loss(self):
        m = self.source(n=600123)
        folder = self.store.directory(self.id)
        for path in sorted(folder.glob("chunk-*.bin")):
            data = path.read_bytes()
            rows = np.frombuffer(data[HEADER.size:], dtype=SAMPLES).copy()
            actual = rows["index"] % 32 == 0
            rows["flags"] = actual.astype(np.uint8) * 2
            rows["rssi"] = np.where(actual, 80, 0)
            # A genuine missing expected RSSI reading, not an unsampled row.
            rows["flags"][rows["index"] == 320] = 0
            path.write_bytes(data[:HEADER.size] + rows.tobytes())
        m.update(rssiSampleStride=32, rssiSampleRate=250000 / 32, missingRssiSamples=1)
        atomic_json(folder / "manifest.json", m)
        for rate in (10000, 50000, 100000):
            result = prepare_upload(self.store, self.id, rate, self.cache)
            rows = self.derived_rows(Path(result["directory"]))
            self.assertTrue((rows["flags"][:int(300 * rate / 250000)] & 2).all())
            self.assertTrue((rows["flags"][int(400 * rate / 250000):] & 2).all())
            self.assertTrue((rows["flags"] & 2 == 0).any())
            self.assertLess(result["recording"]["missingRssiSamples"], 20)
            self.assertEqual(result["recording"]["sampling"]["sourceRssiSampleStride"], 32)

    def test_telemetry_keeps_angles_and_host_clock_but_maps_sample_clock(self):
        manifest = self.source(n=250000)
        source = self.store.directory(self.id)
        event = {"event": "feedback", "hostTime": 1800000000.41, "sampleIndex": 102001,
                 "receivedSamples": 102002, "axis1": {"angle": 13.5}, "entrySampleIndex": 100001}
        data = (json.dumps(event) + "\n").encode()
        (source / "turntable.jsonl").write_bytes(data)
        manifest["turntable"] = {"config": {"port": "test-no-hardware"}, "telemetry": {
            "file": "turntable.jsonl", "events": 1, "sha256": hashlib.sha256(data).hexdigest()}}
        atomic_json(source / "manifest.json", manifest)
        result = prepare_upload(self.store, self.id, 50000, self.cache)
        payload = (Path(result["directory"]) / "turntable.jsonl").read_bytes()
        mapped = json.loads(payload)
        self.assertEqual(mapped["axis1"], event["axis1"])
        self.assertEqual(mapped["hostTime"], event["hostTime"])
        self.assertEqual(mapped["sampleIndex"], 20400)
        self.assertEqual(mapped["receivedSamples"], 20401)
        self.assertEqual(result["recording"]["turntable"]["telemetry"]["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual((source / "turntable.jsonl").read_bytes(), data)

    def test_http_sampling_endpoint_auth_and_rate_validation(self):
        from fastapi.testclient import TestClient
        from blade_acquisition.service import Settings, create_app
        self.source(n=250000)
        token = "fixture-only-upload-copy-token-12345678"
        app = create_app(Settings(token, 8765, self.root))
        with TestClient(app, base_url="http://127.0.0.1:8765") as client:
            url = f"/api/field/recordings/{self.id}/upload-copy"
            self.assertEqual(client.post(url, json={"sampleRate": 50000}).status_code, 401)
            headers = {"Authorization": f"Bearer {token}"}
            response = client.post(url, json={"sampleRate": 50000}, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["recording"]["sampleRate"], 50000)
            self.assertEqual(Path(response.json()["directory"]).parent, self.cache)
            for body in [{"sampleRate": 5000}, {"sampleRate": True}, {"sampleRate": 50000, "path": "/tmp"}]:
                self.assertEqual(client.post(url, json=body, headers=headers).status_code, 422)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = RecordingStore(self.root / "recordings")
        self.id = "a" * 32
        self.cache = self.root / "upload-cache"

    def source(self, n=600123, rate=250000, flags=False):
        folder = self.store.directory(self.id); folder.mkdir()
        t = np.arange(n) / rate
        self.values = .2 * np.sin(2 * np.pi * 1000 * t) + .1 * np.sin(2 * np.pi * 60000 * t)
        rows = np.zeros(n, dtype=SAMPLES)
        rows["index"] = np.arange(n); rows["value"] = self.values
        rows["flags"] = 2; rows["rssi"] = 80
        if flags:
            rows["flags"][262142] = 3; rows["flags"][280000] = 0; rows["rssi"][290001] = 4
        chunks = 0
        for start in range(0, n, 123457):
            with (folder / f"chunk-{chunks:08d}.bin").open("wb") as out:
                out.write(HEADER.pack(MAGIC, rate, 1800000000, start)); out.write(rows[start:start + 123457].tobytes())
            chunks += 1
        handoff = {"reason": "blade_left", "entrySampleIndex": 100001, "entryConfirmedSampleIndex": 101001,
                   "exitSampleIndex": 200001, "exitConfirmedSampleIndex": 201001, "sampleIndex": 201001}
        m = {"id": self.id, "name": "P4 numerical test", "source": "polytec_ivs500", "status": "complete",
             "unit": "m/s", "sampleRate": rate, "sampleOrigin": 1800000000, "samples": n, "chunks": chunks,
             "format": "BLADEV01/<QidifB", "startedAt": 1800000000, "endedAt": 1800000000 + n / rate,
             "pointCycle": {"completion": "confirmed_pass", "outcome": "observed", "handoff": handoff},
             "unpairedRssiSamples": 0, "overrangeSamples": int(flags), "missingRssiSamples": int(flags)}
        atomic_json(folder / "manifest.json", m)
        self.original = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.iterdir()}
        return m

    def derived_rows(self, directory):
        return np.concatenate([np.frombuffer(p.read_bytes()[HEADER.size:], dtype=SAMPLES) for p in sorted(directory.glob("chunk-*.bin"))])

    def test_exact_rates_filter_seams_time_and_originals(self):
        m = self.source()
        for rate in (10000, 30000, 50000, 100000):
            with self.subTest(rate=rate):
                result = prepare_upload(self.store, self.id, rate, self.cache)
                rows = self.derived_rows(Path(result["directory"]))
                expected = resample_poly(self.values, rate // math.gcd(rate, 250000), 250000 // math.gcd(rate, 250000), window=("kaiser", 8.6))
                np.testing.assert_allclose(rows["value"], expected, rtol=0, atol=2e-14)
                np.testing.assert_array_equal(rows["index"], np.arange(len(rows)))
                derived = result["recording"]
                self.assertEqual(derived["samples"], math.ceil(m["samples"] * rate / 250000))
                self.assertEqual(derived["sampleOrigin"], m["sampleOrigin"])
                self.assertLess(abs(len(rows) / rate - m["samples"] / 250000), 1 / rate)
                self.assertIsNone(_range(derived["pointCycle"], len(rows))[1])
                for key, value in m["pointCycle"]["handoff"].items():
                    if isinstance(value, int):
                        self.assertLess(abs(value / 250000 - derived["pointCycle"]["handoff"][key] / rate), 1 / rate)
                self.assertEqual(prepare_upload(self.store, self.id, rate, self.cache), result)
        for p in self.store.directory(self.id).iterdir():
            self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(), self.original[p.name])
        # A 60 kHz tone would alias to 10 kHz at 50 kHz without low-pass filtering.
        output = self.derived_rows(Path(prepare_upload(self.store, self.id, 50000, self.cache)["directory"]))["value"][100:100100]
        t = np.arange(100, 100100) / 50000
        amplitude = lambda f: abs(np.sum(output * np.exp(-2j * np.pi * f * t))) * 2 / len(t)
        self.assertAlmostEqual(amplitude(1000), .2, delta=.001)
        self.assertLess(amplitude(10000), .0001)

    def test_quality_cloud_validation_import_and_preview(self):
        self.source(flags=True)
        result = prepare_upload(self.store, self.id, 50000, self.cache)
        directory = Path(result["directory"])
        rows = self.derived_rows(directory)
        self.assertTrue(rows["flags"][262142 // 5] & 1)
        self.assertFalse(rows["flags"][280000 // 5] & 2)
        self.assertEqual(rows["rssi"][290001 // 5], 4)
        cloud = self.root / "cloud" / self.id / "complete"
        shutil.copytree(directory, cloud)
        files = [{"name": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                 for p in cloud.iterdir() if p.name != "manifest.json"]
        atomic_json(cloud / "transfer.json", {"files": files})
        with patch.dict(os.environ, {"BLADE_CAPTURE_DATA_DIR": str(self.root / "cloud")}):
            self.assertEqual(validate_capture(str(cloud))["samples"], len(rows))
            target = RecordingStore(self.root / "analysis")
            imported = import_capture(target, str(cloud))["recording"]
            self.assertIn("降采样", imported["conversion"])
            self.assertEqual(recording_summary(imported)["sampling"]["sourceSampleRate"], 250000)
            wave = WaveformReader(target).read(imported["id"])["waveform"]
            self.assertLessEqual(len(wave["envelope"]), 1000)
            self.assertEqual(wave["rangeEnd"], len(rows))

    def test_reject_invalid_incomplete_and_do_not_upsample(self):
        self.source(n=1000, rate=1000)
        for rate in (-1, True, 9999, 100001, 10000.5):
            with self.assertRaises(ValueError): prepare_upload(self.store, self.id, rate, self.cache)
        self.assertEqual(prepare_upload(self.store, self.id, 10000, self.cache)["directory"], str(self.store.directory(self.id)))
        self.assertEqual(prepare_upload(self.store, self.id, 0, self.cache)["recording"]["sampleRate"], 1000)
        path = self.store.directory(self.id) / "manifest.json"
        m = json.loads(path.read_text()); m["status"] = "incomplete"; atomic_json(path, m)
        with self.assertRaises(BlockingIOError): prepare_upload(self.store, self.id, 50000, self.cache)

    def test_vectorized_envelope_matches_reference(self):
        self.source(flags=True)
        reader = WaveformReader(self.store)
        path = self.store.directory(self.id) / "chunk-00000002.bin"
        begin, end = 246914, 370371
        for step in (128, 1024, 524288):
            with path.open("rb") as stream:
                expected = list(envelope_rows(reader._rows(stream, begin, begin + 7, end - 3), step))
                actual = list(reader._envelopes(stream, begin, begin + 7, end - 3, step))
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
