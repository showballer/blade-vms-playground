"""Explicit synthetic fixtures for display correctness; no SDK or real hardware."""
import hashlib
import tempfile
import unittest
from pathlib import Path

from blade_acquisition.receiver import Batch
from blade_acquisition.storage import HEADER, RECORD, RecordingStore, atomic_json
from blade_acquisition.waveform import WaveformReader, make_wave


class WaveformTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = RecordingStore(Path(self.temp.name))
        self.reader = WaveformReader(self.store)
        self.writer = self.store.create({"name": "explicit fixture"})
        self.writer.CHUNK_SAMPLES = 5000
        self.writer.ready(218750, 1700000000)
        for start in range(0, 20000, 5000):
            values = [((start + i) % 100 - 50) / 1000 for i in range(5000)]
            if start == 5000:
                values[17] = 9.25  # a one-sample spike MUST survive aggregation
            self.writer.write(Batch(start, 218750, 1700000000, [0] * 5000, values,
                                    [400] * 4999, [80.0] * 4999, [i == 17 for i in range(5000)]))
        self.writer.finish(None)

    def tearDown(self):
        self.temp.cleanup()

    def test_overview_preserves_peak_flags_missing_and_origin(self):
        wave = self.reader.read(self.writer.id)["waveform"]
        self.assertEqual(wave["representation"], "envelope")
        self.assertEqual(wave["sourceSamples"], 20000)
        self.assertLessEqual(len(wave["envelope"]), 1000)
        self.assertEqual(max(b["max"] for b in wave["envelope"]), 9.25)
        self.assertEqual(wave["overrangeCount"], 4)
        self.assertEqual(wave["missingRssiCount"], 4)
        self.assertEqual(wave["sampleOrigin"], 1700000000)
        self.assertEqual(sum(b["end"] - b["start"] for b in wave["envelope"]), 20000)

    def test_zoom_reads_every_original_sample_across_chunk_boundary(self):
        wave = self.reader.read(self.writer.id, 4990, 5025)["waveform"]
        self.assertEqual(wave["representation"], "raw")
        self.assertEqual(wave["sampleStart"], 4990)
        self.assertEqual(len(wave["values"]), 35)
        self.assertEqual(wave["values"][27], 9.25)
        self.assertIsNone(wave["rssi"][9])
        self.assertEqual(wave["sampleStride"], 1)

    def test_display_reads_never_modify_raw_files(self):
        files = self.store.chunks(self.writer.directory)
        before = [hashlib.sha256(p.read_bytes()).digest() for p in files]
        for start, end in [(0, 20000), (5016, 5019), (18000, 30000), (0, 1)]:
            self.reader.read(self.writer.id, start, end)
        self.assertEqual(before, [hashlib.sha256(p.read_bytes()).digest() for p in files])

    def test_missing_chunk_and_invalid_sample_fail_not_fake_continuity(self):
        path = self.store.chunks(self.writer.directory)[1]
        path.rename(path.with_suffix(".preserved"))
        with self.assertRaisesRegex(ValueError, "缺失|重叠"):
            self.reader.read(self.writer.id)

    def test_sample_corruption_is_reported(self):
        path = self.store.chunks(self.writer.directory)[0]
        with path.open("r+b") as stream:
            stream.seek(HEADER.size)
            stream.write(RECORD.pack(999, 0, 0.0, 0, 80.0, 2))
        with self.assertRaisesRegex(ValueError, "序号"):
            self.reader.read(self.writer.id, 0, 3)

    def test_older_manifest_origin_is_recovered_from_header(self):
        del self.writer.manifest["sampleOrigin"]
        atomic_json(self.writer.directory / "manifest.json", self.writer.manifest)
        self.assertEqual(self.reader.read(self.writer.id)["waveform"]["sampleOrigin"], 1700000000)

    def test_incomplete_record_status_and_partial_tail_are_preserved(self):
        live = self.store.create({"name": "live"})
        live.ready(1000, 1700000000)
        live.write(Batch(0, 1000, 1700000000, [0, 1], [0.0, 0.1], [0], [0.0], [False, False]))
        try:
            live.stream.write(b"partial")
            result = self.reader.read(live.id, manifest=dict(live.manifest))
            self.assertEqual(result["recording"]["status"], "incomplete")
            self.assertEqual(result["waveform"]["values"], [0.0, 0.1])
            self.assertEqual(result["waveform"]["rssi"], [0.0, None])
        finally:
            live.stream.close()
            live.stream = None

    def test_concurrent_read_is_bounded(self):
        self.reader.lock.acquire()
        try:
            with self.assertRaises(BlockingIOError):
                self.reader.read(self.writer.id)
        finally:
            self.reader.lock.release()

    def test_large_cache_merges_exact_bucket_boundaries_and_partial_edges(self):
        # Use lower cache step indirectly by a large fixture spanning >= 1M samples.
        large = self.store.create({"name": "cache fixture"})
        large.ready(218750, 1700000000)
        for start in range(0, 1_100_000, 10000):
            n = 10000
            large.write(Batch(start, 218750, 1700000000, [0] * n, [float(start)] * n,
                              [1] * n, [50.0] * n, [False] * n))
        large.finish(None)
        wave = self.reader.read(large.id, 1, 1_099_991)["waveform"]
        self.assertTrue(self.reader.cache)
        self.assertLessEqual(len(wave["envelope"]), 1000)
        self.assertEqual(wave["envelope"][0]["start"], 1)
        self.assertEqual(wave["envelope"][-1]["end"], 1_099_991)
        self.assertEqual(sum(b["end"] - b["start"] for b in wave["envelope"]), 1_099_990)
        again = self.reader.read(large.id, 1, 1_099_991)["waveform"]
        self.assertEqual(again, wave)

    def test_live_envelope_includes_last_sample_not_last_peak(self):
        rows = [(i, 5.0 if i == 0 else 0.0, None if i == 2 else 80.0, i == 3) for i in range(4375)]
        wave = make_wave(rows, 218750, 1700000000)
        self.assertEqual(wave["latest"]["velocity"], 0.0)
        self.assertEqual(wave["sourceSamples"], 4375)
        self.assertEqual(wave["rangeEnd"] / wave["sampleRate"], 0.02)
        self.assertEqual(wave["missingRssiCount"], 1)
        self.assertEqual(max(b["max"] for b in wave["envelope"]), 5.0)


if __name__ == "__main__":
    unittest.main()
