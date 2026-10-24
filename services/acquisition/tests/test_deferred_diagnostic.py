"""Deferred early-pass records: real disk fixtures, no hardware access."""
import json
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from blade_acquisition.async_recording import AsyncRecordingWriter
from blade_acquisition.deferred_diagnostic import DeferredDiagnosticRecord
from blade_acquisition.storage import HEADER, RECORD, RecordingStore
from test_async_recording import batch


def rows(directory):
    return [r for p in sorted(directory.glob('chunk-*.bin'))
            for r in RECORD.iter_unpack(p.read_bytes()[HEADER.size:])]


class DeferredDiagnosticTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.store = RecordingStore(root / 'recordings')
        self.raw = RecordingStore(root / 'continuous-sessions').create({'name': 'raw'})
        self.raw.CHUNK_SAMPLES = 6
        self.async_raw = AsyncRecordingWriter(self.raw)
        self.addCleanup(lambda: self.async_raw.finish('fixture cleanup', timeout=2))
        self.async_raw.ready(1000, 1234.5)

    def record(self, start=3, end=16):
        return DeferredDiagnosticRecord(self.store, {'name': 'early', 'diagnosticOnly': True,
            'validMeasurement': False, 'pointCycle': {'completion': 'diagnostic_pass',
                'continuousSession': {'id': self.raw.id, 'sampleStart': start, 'sampleEndExclusive': end}}},
            self.async_raw, start, end)

    def write_raw(self):
        for i in range(0, 18, 6):
            self.async_raw.write(replace(batch(i, 6, 3),
                values=[-i-.25]*6, overrange=[True, False, True, False, False, False]))

    def test_no_station_io_before_raw_finish_and_lossless_cross_chunk_copy(self):
        self.write_raw()
        record = self.record()
        record.finish(wait=False)
        self.assertEqual(self.store.list(), [])
        with self.assertRaises(TimeoutError):
            record.wait(.01)
        self.assertTrue(record.pending)
        self.assertFalse(record.directory.exists())
        self.async_raw.finish(timeout=2)
        result = record.wait(2)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['samples'], 13)
        self.assertFalse(result['validMeasurement'])
        self.assertEqual(result['sampleOrigin'], 1234.503)
        actual, expected = rows(record.directory), rows(self.raw.directory)[3:16]
        self.assertEqual([r[0] for r in actual], list(range(13)))
        self.assertEqual([r[1:] for r in actual], [r[1:] for r in expected])
        self.assertEqual(result['overrangeSamples'], sum(r[-1] & 1 for r in expected))
        self.assertEqual(json.loads((record.directory/'manifest.json').read_text()), result)
        self.assertEqual(record.wait(2), result)
        self.assertEqual(len(self.store.list()), 1)

    def test_cancellation_retains_raw_window_but_never_reports_success(self):
        self.write_raw()
        record = self.record()
        record.finish('operator stopped', wait=False)
        self.async_raw.finish('operator stopped', timeout=2)
        result = record.wait(2)
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['samples'], 13)
        self.assertEqual(result['error'], 'operator stopped')

    def test_failed_materialization_keeps_source_and_marks_record_error(self):
        self.write_raw()
        record = self.record()
        record.finish(wait=False)
        self.async_raw.finish(timeout=2)
        with patch('blade_acquisition.deferred_diagnostic.copy_raw_window', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                record.wait(2)
        self.assertFalse(record.pending)
        self.assertEqual(record.manifest['status'], 'error')
        self.assertEqual(len(rows(self.raw.directory)), 18)
        with self.assertRaisesRegex(RuntimeError, 'disk full'):
            record.wait(2)

    def test_invalid_or_missing_raw_interval_never_fabricates_samples(self):
        self.write_raw()
        self.async_raw.finish(timeout=2)
        for start, end in ((2, 16), (3, 30)):
            record = self.record(start, end)
            record.finish(wait=False)
            with self.assertRaisesRegex(ValueError, '区间无效'):
                record.wait(2)
            self.assertEqual(record.manifest['status'], 'error')
            self.assertEqual(record.manifest['samples'], 0)

    def test_corrupt_raw_index_is_rejected_without_changing_archive(self):
        self.write_raw()
        self.async_raw.finish(timeout=2)
        path = sorted(self.raw.directory.glob('chunk-*.bin'))[1]
        payload = bytearray(path.read_bytes())
        payload[HEADER.size:HEADER.size+8] = (999).to_bytes(8, 'little')
        path.write_bytes(payload)
        record = self.record()
        record.finish(wait=False)
        with self.assertRaisesRegex(ValueError, '索引不连续'):
            record.wait(2)
        self.assertEqual(path.read_bytes(), payload)
        self.assertEqual(record.manifest['status'], 'error')
