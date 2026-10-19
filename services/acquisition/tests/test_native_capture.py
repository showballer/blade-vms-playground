"""Native cloud turntable recordings retain byte-identical telemetry and metadata."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from blade_acquisition.native_capture import validate_capture, import_capture
from blade_acquisition.storage import HEADER, MAGIC, RECORD, RecordingStore


class NativeTurntableCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"BLADE_CAPTURE_DATA_DIR": str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.directory = self.root / ("a" * 32) / "complete"
        self.directory.mkdir(parents=True)
        raw = HEADER.pack(MAGIC, 1000, 1700000000, 0) + RECORD.pack(0, 1000, .001, 80000, 80, 2)
        (self.directory / "chunk-00000000.bin").write_bytes(raw)
        self.manifest = {"id": "a" * 32, "name": "turntable test", "status": "complete", "source": "polytec_ivs500",
                         "unit": "m/s", "format": "BLADEV01/<QidifB", "sampleRate": 1000, "sampleOrigin": 1700000000,
                         "startedAt": 1700000000, "samples": 1, "chunks": 1, "pointCycle": {"cycle": 2, "pointIndex": 3, "actualAngles": {"1": 5, "2": 30}},
                         "turntable": {"config": {"port": "COM6"}, "preparedReferences": {"1": {"origin_counts": 123}}}}
        self.events = [{"event": "start", "hostTime": 1700000000, "elapsedSeconds": 0},
                       {"event": "status", "hostTime": 1700000001, "elapsedSeconds": 1, "receivedSamples": 1,
                        "feedback": {"axes": {"1": {"output_angle_deg": 5}, "2": {"output_angle_deg": 30}}}}]
        self.save_events(self.events)

    def save_events(self, events, raw=None):
        content = raw if raw is not None else ("\n".join(json.dumps(row) for row in events) + "\n").encode()
        (self.directory / "turntable.jsonl").write_bytes(content)
        self.manifest["turntable"]["telemetry"] = {"file": "turntable.jsonl", "events": len(events),
                                                   "sha256": hashlib.sha256(content).hexdigest()}
        self.save_manifest()

    def save_manifest(self):
        files = [{"name": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                 for p in sorted(self.directory.iterdir()) if p.name.endswith((".bin", ".jsonl"))]
        (self.directory / "manifest.json").write_text(json.dumps(self.manifest))
        (self.directory / "transfer.json").write_text(json.dumps({"recording": self.manifest, "files": files}))

    def test_validate_and_analysis_import_preserve_telemetry_and_references(self):
        self.assertEqual(validate_capture(self.directory)["turntable"], self.manifest["turntable"])
        store = RecordingStore(self.root / "analysis")
        imported = import_capture(store, self.directory)["recording"]
        self.assertEqual(imported["pointCycle"], self.manifest["pointCycle"])
        self.assertEqual(imported["sourceRecordingId"], self.manifest["id"])
        self.assertEqual(imported["turntable"], self.manifest["turntable"])
        self.assertEqual((store.directory(imported["id"]) / "turntable.jsonl").read_bytes(), (self.directory / "turntable.jsonl").read_bytes())
        self.assertEqual(import_capture(store, self.directory)["recording"]["id"], imported["id"])

    def test_cycle_angle_metadata_without_motion_log_remains_supported(self):
        del self.manifest["turntable"]["telemetry"]
        (self.directory / "turntable.jsonl").unlink()
        self.save_manifest()
        self.assertEqual(validate_capture(self.directory)["pointCycle"], self.manifest["pointCycle"])
        del self.manifest["pointCycle"]
        self.save_manifest()
        with self.assertRaises(ValueError):
            validate_capture(self.directory)

    def test_missing_undeclared_or_mismatched_telemetry_is_rejected(self):
        original = dict(self.manifest["turntable"]["telemetry"])
        for details in [None, {**original, "sha256": "0" * 64}, {**original, "events": 3}]:
            with self.subTest(details=details):
                self.manifest["turntable"]["telemetry"] = details
                self.save_manifest()
                with self.assertRaises(ValueError):
                    validate_capture(self.directory)
        self.manifest["turntable"]["telemetry"] = original
        (self.directory / "turntable.jsonl").unlink()
        self.save_manifest()
        with self.assertRaises(ValueError):
            validate_capture(self.directory)

    def test_valid_hash_does_not_allow_invalid_or_truncated_events(self):
        for raw in [b'{"event":\n', b'[]\n', b'{"event":"status","hostTime":1,"elapsedSeconds":-1}\n',
                    b'{"event":"status","hostTime":1,"elapsedSeconds":0,"value":NaN}\n',
                    json.dumps(self.events[0]).encode(), b' ' * (256 * 1024 + 1) + b'\n']:
            with self.subTest(raw=raw[:80]):
                self.save_events([{}], raw)
                with self.assertRaises(ValueError):
                    validate_capture(self.directory)

    def test_reordered_elapsed_time_and_file_tampering_are_rejected(self):
        self.save_events(list(reversed(self.events)))
        with self.assertRaises(ValueError):
            validate_capture(self.directory)
        self.save_events(self.events)
        with (self.directory / "turntable.jsonl").open("ab") as stream:
            stream.write(b'{}\n')
        with self.assertRaises(ValueError):
            validate_capture(self.directory)


if __name__ == "__main__":
    unittest.main()
