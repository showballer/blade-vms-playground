import json
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from blade_acquisition.async_recording import AsyncRecordingError, AsyncRecordingWriter
from blade_acquisition.receiver import Batch
from blade_acquisition.storage import HEADER, RECORD, RecordingStore


def batch(start=0, count=4, stride=1):
    return Batch(start, 1000.0, 1234.5, list(range(count)), [0.25] * count,
                 [15] * ((count + stride - 1) // stride), [15.0] * ((count + stride - 1) // stride),
                 [False] * count, stride)


class AsyncRecordingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = RecordingStore(Path(self.tmp.name))
        self.active = []

    def tearDown(self):
        for writer in self.active:
            try:
                writer.finish("test cleanup", timeout=2)
            except (AsyncRecordingError, OSError):
                pass
            self.assertFalse(writer._thread.is_alive())
        self.tmp.cleanup()

    def writer(self, **kwargs):
        raw = self.store.create({"name": "continuous", "pointCycle": {"completion": None}})
        wrapped = AsyncRecordingWriter(raw, **kwargs)
        self.active.append(wrapped)
        return wrapped, raw

    def test_continuous_bytes_and_final_metadata_are_saved(self):
        wrapped, raw = self.writer()
        wrapped.ready(1000.0, 1234.5)
        for start in range(0, 40, 4):
            wrapped.write(batch(start))
        wrapped.manifest["pointCycle"]["completion"] = "confirmed_pass"
        result = wrapped.finish()
        self.assertEqual(result["samples"], 40)
        self.assertEqual(wrapped.accepted_samples, 40)
        self.assertEqual(result["status"], "complete")
        stored = json.loads((raw.directory / "manifest.json").read_text())
        self.assertEqual(stored["pointCycle"]["completion"], "confirmed_pass")
        rows = []
        for chunk in self.store.chunks(raw.directory):
            data = chunk.read_bytes()
            rows.extend(RECORD.iter_unpack(data[HEADER.size:]))
        self.assertEqual([row[0] for row in rows], list(range(40)))

    def test_writer_receives_owned_batch_and_metadata_snapshots(self):
        wrapped, raw = self.writer()
        entered, release = threading.Event(), threading.Event()
        original_ready = raw.ready

        def blocked_ready(*args):
            entered.set()
            self.assertTrue(release.wait(2))
            original_ready(*args)

        with patch.object(raw, "ready", side_effect=blocked_ready):
            wrapped.ready(1000.0, 1234.5)
            self.assertTrue(entered.wait(1))
            original = batch()
            wrapped.write(original)
            wrapped.manifest["pointCycle"]["completion"] = "queued"
            wrapped.persist()
            original.values[0] = 99
            wrapped.manifest["pointCycle"]["completion"] = "later"
            wrapped.finish(wait=False)
            self.assertEqual(wrapped.manifest["status"], "incomplete")
            self.assertEqual(wrapped.manifest["samples"], 0)
            self.assertEqual(wrapped.accepted_samples, 4)
            release.set()
            wrapped.wait(2)
        row = next(RECORD.iter_unpack(self.store.chunks(raw.directory)[0].read_bytes()[HEADER.size:]))
        self.assertEqual(row[2], 0.25)
        self.assertEqual(raw.manifest["pointCycle"]["completion"], "later")

    def test_full_queue_fails_immediately_and_drains_accepted_batches_as_error(self):
        errors = []
        wrapped, raw = self.writer(max_batches=1, on_error=errors.append)
        entered, release = threading.Event(), threading.Event()
        original_ready = raw.ready

        def blocked_ready(*args):
            entered.set()
            self.assertTrue(release.wait(2))
            original_ready(*args)

        with patch.object(raw, "ready", side_effect=blocked_ready):
            wrapped.ready(1000.0, 1234.5)
            self.assertTrue(entered.wait(1))
            wrapped.write(batch())
            with self.assertRaisesRegex(AsyncRecordingError, "队列已满"):
                wrapped.write(batch(4))
            self.assertEqual(wrapped.accepted_samples, 4)
            self.assertEqual(wrapped.manifest["samples"], 0)
            self.assertEqual(len(errors), 1)
            wrapped.finish(wait=False)
            release.set()
            with self.assertRaises(AsyncRecordingError):
                wrapped.wait(2)
        self.assertEqual(raw.manifest["samples"], 4)
        self.assertEqual(raw.manifest["status"], "error")

    def test_io_failure_notifies_once_and_never_claims_accepted_data_saved(self):
        errors = []
        wrapped, raw = self.writer(on_error=errors.append)
        with patch.object(raw, "write", side_effect=OSError("disk full")):
            wrapped.ready(1000.0, 1234.5)
            wrapped.write(batch())
            with self.assertRaisesRegex(AsyncRecordingError, "disk full"):
                wrapped.finish(timeout=2)
        self.assertEqual(wrapped.accepted_samples, 4)
        self.assertEqual(wrapped.manifest["samples"], 0)
        self.assertEqual(wrapped.manifest["status"], "error")
        self.assertEqual(len(errors), 1)
        with self.assertRaises(AsyncRecordingError):
            wrapped.write(batch(4))
        self.assertEqual(len(errors), 1)

    def test_finish_failure_never_publishes_complete(self):
        wrapped, raw = self.writer()
        wrapped.ready(1000.0, 1234.5)
        wrapped.write(batch())
        with patch.object(raw, "finish", side_effect=OSError("fsync failed")):
            with self.assertRaisesRegex(AsyncRecordingError, "fsync failed"):
                wrapped.finish(timeout=2)
        self.assertEqual(wrapped.manifest["status"], "incomplete")
        self.assertIsNone(raw.stream)

    def test_structure_rate_origin_stride_and_sequence_checks_fail_before_acceptance(self):
        bad_batches = [replace(batch(), sample_start=4), replace(batch(), sample_rate=500),
                       replace(batch(), started_at=1), replace(batch(), velocity_raw=[]),
                       replace(batch(), overrange=[]), replace(batch(), rssi_raw=[]),
                       replace(batch(), rssi_sample_stride=0)]
        for bad in bad_batches:
            with self.subTest(bad=bad):
                wrapped, raw = self.writer()
                wrapped.ready(1000.0, 1234.5)
                with self.assertRaises(ValueError):
                    wrapped.write(bad)
                self.assertEqual(wrapped.accepted_samples, 0)
                with self.assertRaises(AsyncRecordingError):
                    wrapped.finish(timeout=2)
                self.assertEqual(raw.manifest["status"], "error")

    def test_sparse_rssi_stride_preserved_and_changes_rejected(self):
        wrapped, raw = self.writer()
        wrapped.ready(1000.0, 1234.5)
        wrapped.write(batch(stride=2))
        with self.assertRaisesRegex(ValueError, "RSSI"):
            wrapped.write(batch(4, stride=1))
        with self.assertRaises(AsyncRecordingError):
            wrapped.finish(timeout=2)
        self.assertEqual(raw.manifest["samples"], 4)
        self.assertEqual(raw.manifest["rssiSampleRate"], 500)
        self.assertEqual(raw.manifest["rssiNotSampledVelocitySamples"], 2)

    def test_supplied_error_and_callback_failure_still_release_thread(self):
        wrapped, raw = self.writer(on_error=lambda exc: (_ for _ in ()).throw(RuntimeError("observer")))
        wrapped.ready(1000.0, 1234.5)
        wrapped.write(batch())
        result = wrapped.finish("receiver failed", timeout=2)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"], "receiver failed")
        wrapped, raw = self.writer(on_error=lambda exc: (_ for _ in ()).throw(RuntimeError("observer")))
        with self.assertRaises(ValueError):
            wrapped.ready(0, 1234.5)
        with self.assertRaises(AsyncRecordingError):
            wrapped.wait(2)

    def test_manifest_publication_uses_controller_lock_without_inverting_writer_lock(self):
        controller_lock = threading.RLock()
        wrapped, raw = self.writer(publication_lock=controller_lock)
        initialized = threading.Event()
        original_ready = raw.ready

        def ready(*args):
            original_ready(*args)
            initialized.set()

        with patch.object(raw, "ready", side_effect=ready):
            with controller_lock:
                wrapped.ready(1000.0, 1234.5)
                self.assertTrue(initialized.wait(1))
                # Progress publication is deferred under controller_lock.
                # Submission must still acquire its internal lock here.
                wrapped.write(batch())
                self.assertEqual(wrapped.accepted_samples, 4)
                self.assertEqual(wrapped.manifest["samples"], 0)
            result = wrapped.finish(timeout=2)
        self.assertEqual(result["samples"], 4)
        self.assertEqual(result["status"], "complete")

    def test_controller_lock_does_not_stall_disk_drain(self):
        controller_lock = threading.RLock()
        wrapped, raw = self.writer(publication_lock=controller_lock, max_batches=2)
        written = threading.Event()
        original_write = raw.write

        def write(value):
            original_write(value)
            written.set()

        with patch.object(raw, "write", side_effect=write):
            with controller_lock:
                wrapped.ready(1000.0, 1234.5)
                # More than the bounded queue capacity must reach disk even
                # when the controller cannot accept progress publication.
                for start in range(0, 160, 4):
                    written.clear()
                    wrapped.write(batch(start))
                    self.assertTrue(written.wait(1), "disk drain blocked by status publication")
                self.assertEqual(wrapped.manifest["samples"], 0)
                wrapped.finish(wait=False)
            result = wrapped.wait(2)
        self.assertEqual(result["samples"], 160)
        self.assertEqual(result["status"], "complete")
        stored = json.loads((raw.directory / "manifest.json").read_text())
        self.assertEqual(stored["samples"], 160)
        self.assertGreater(stored["writerDiagnostics"]["publicationDeferrals"], 0)

    def test_final_publication_is_not_skipped_when_controller_is_busy(self):
        controller_lock = threading.RLock()
        wrapped, raw = self.writer(publication_lock=controller_lock)
        saved = threading.Event()
        original_finish = raw.finish

        def finish(error):
            original_finish(error)
            saved.set()

        with patch.object(raw, "finish", side_effect=finish):
            with controller_lock:
                wrapped.ready(1000.0, 1234.5)
                wrapped.write(batch())
                wrapped.finish(wait=False)
                self.assertTrue(saved.wait(1))
                self.assertTrue(wrapped.pending)
                self.assertEqual(wrapped.manifest["status"], "incomplete")
            result = wrapped.wait(2)
        self.assertFalse(wrapped.pending)
        self.assertEqual(result["samples"], 4)
        self.assertEqual(result["writerDiagnostics"]["writtenSamples"], 4)
        self.assertEqual(result["status"], "complete")

    def test_error_callback_does_not_hold_writer_lock_while_waiting_for_controller(self):
        controller_lock = threading.RLock()
        callback_entered = threading.Event()

        def callback(exc):
            callback_entered.set()
            with controller_lock:
                pass

        wrapped, raw = self.writer(publication_lock=controller_lock, on_error=callback)
        wrapped.ready(1000.0, 1234.5)
        # Wait for ready without adding a disk command to a deliberately
        # locked controller. Queue.join is test-only, never a service wait.
        wrapped._queue.join()
        with patch.object(raw, "write", side_effect=OSError("disk failed")):
            with controller_lock:
                wrapped.write(batch())
                self.assertTrue(callback_entered.wait(1))
                with self.assertRaisesRegex(AsyncRecordingError, "disk failed"):
                    wrapped.check()
            with self.assertRaises(AsyncRecordingError):
                wrapped.finish(timeout=2)


if __name__ == "__main__":
    unittest.main()
