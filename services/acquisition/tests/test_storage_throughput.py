"""Binary compatibility and bounded buffering regressions; no device access."""
import json
import itertools
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from blade_acquisition.async_recording import AsyncRecordingError, AsyncRecordingWriter
from blade_acquisition.storage import RECORD, RecordingStore, pack_records
from test_async_recording import batch


class StorageThroughputTests(unittest.TestCase):
    def test_persisted_timing_snapshot_matches_memory_and_index(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RecordingStore(Path(directory))
            # Force each new timing to exceed the previous value, rather than
            # relying on scheduling to expose post-publication mutation.
            ticks = itertools.accumulate(range(1, 200))
            with patch('blade_acquisition.storage.time.monotonic', side_effect=lambda: next(ticks)):
                writer = store.create({"name": "timing snapshot"})
                writer.finish(None)
            saved = json.loads((writer.directory / 'manifest.json').read_text())
            self.assertEqual(saved, writer.manifest)
            self.assertEqual(store.list()[0], writer.manifest)

    def test_bulk_encoding_matches_legacy_bytes_sparse_missing_and_surplus(self):
        for stride in (1, 2, 100):
            for rssi_count in (0, 1, 17, 105):
                with self.subTest(stride=stride, rssi_count=rssi_count):
                    b = replace(batch(200, 103, stride),
                                velocity_raw=[-2**31, 2**31-1] + list(range(101)),
                                values=[-0.0, -1.234567890123] + [i / 7 for i in range(101)],
                                rssi_raw=list(range(rssi_count)), rssi=[i / 3 for i in range(rssi_count)],
                                overrange=[i % 7 == 0 for i in range(103)])
                    expected = bytearray()
                    for i, value in enumerate(b.values):
                        j = i // stride
                        paired = i % stride == 0 and j < len(b.rssi)
                        expected.extend(RECORD.pack(b.sample_start+i, b.velocity_raw[i], value,
                                                   b.rssi_raw[j] if paired else 0,
                                                   b.rssi[j] if paired else 0,
                                                   int(b.overrange[i]) | (2 if paired else 0)))
                    packed, missing, unsampled = pack_records(b)
                    self.assertEqual(packed.tobytes(), expected)
                    self.assertEqual(missing, 103-min((103+stride-1)//stride, rssi_count))
                    self.assertEqual(unsampled, 103-(103+stride-1)//stride)

    def test_sample_budget_bounds_large_batches_even_with_spare_queue_slots(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = RecordingStore(Path(directory)).create({"name": "budget fixture"})
            entered, release = threading.Event(), threading.Event()
            original = raw.ready
            def stall(*args):
                entered.set()
                if not release.wait(3):
                    raise RuntimeError("fixture timeout")
                original(*args)
            with patch.object(raw, 'ready', side_effect=stall):
                writer = AsyncRecordingWriter(raw, max_pending_samples=10)
                try:
                    writer.ready(1000, 1234.5)
                    self.assertTrue(entered.wait(1))
                    writer.write(batch(0, 10))
                    with self.assertRaisesRegex(AsyncRecordingError, '样本缓冲'):
                        writer.write(batch(10, 1))
                finally:
                    writer.finish(wait=False)
                    release.set()
                    with self.assertRaises(AsyncRecordingError):
                        writer.wait(3)
            self.assertEqual(raw.manifest['samples'], 10)
            self.assertEqual(raw.manifest['writerDiagnostics']['acceptedSamples'], 10)
            self.assertEqual(raw.manifest['writerDiagnostics']['maxPendingSamples'], 10)
            self.assertEqual(raw.manifest['status'], 'error')

    def test_transient_backlog_over_old_32_batch_limit_drains_without_sample_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = RecordingStore(Path(directory)).create({"name": "backlog fixture"})
            entered, release = threading.Event(), threading.Event()
            original = raw.ready
            def stall(*args):
                entered.set()
                if not release.wait(3):
                    raise RuntimeError("fixture timeout")
                original(*args)
            with patch.object(raw, 'ready', side_effect=stall):
                writer = AsyncRecordingWriter(raw)
                try:
                    writer.ready(1000, 1234.5)
                    self.assertTrue(entered.wait(1))
                    for i in range(80):
                        writer.write(batch(i*1000, 1000))
                finally:
                    writer.finish(wait=False)
                    release.set()
                result = writer.wait(5)
            self.assertEqual(result['samples'], 80000)
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(result['writerDiagnostics']['maxQueueDepth'], 80)
            self.assertEqual(writer._pending_samples, 0)
