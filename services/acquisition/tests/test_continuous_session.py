import queue
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path

from blade_acquisition.async_recording import AsyncRecordingWriter
from blade_acquisition.continuous_session import ContinuousCaptureSession
from blade_acquisition.receiver import Batch
from blade_acquisition.storage import HEADER, RECORD, RecordingStore


def batch(start=0, count=4, stride=2):
    return Batch(start, 1000.0, 100.0, list(range(start, start + count)), [float(i) for i in range(start, start + count)],
                 [10] * ((count + stride - 1) // stride), [10.0] * ((count + stride - 1) // stride),
                 [False] * count, stride)


class QueueReceiver:
    supports_laser_persistence = True
    device_settings = {"sampleRate": 1000}
    velocity_range_mps = 0.2
    acquisition_metadata = {"rssiSampleStride": 2, "rssiSampleRate": 500}

    def __init__(self):
        self.commands = queue.Queue()
        self.runs = 0
        self.kwargs = None

    def run(self, stop, ready, receive, **kwargs):
        self.runs += 1
        self.kwargs = kwargs
        ready(1000.0, 100.0)
        while not stop.is_set():
            try:
                value, processed = self.commands.get(timeout=0.01)
            except queue.Empty:
                continue
            try:
                if isinstance(value, Exception):
                    raise value
                if value == "end":
                    return
                receive(value)
            finally:
                processed.set()

    def push(self, value):
        event = threading.Event()
        self.commands.put((value, event))
        if not event.wait(2):
            raise TimeoutError("test receiver did not process batch")


class ContinuousCaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = RecordingStore(Path(self.tmp.name))
        self.raw = AsyncRecordingWriter(self.store.create({"name": "raw archive"}))
        self.receiver = QueueReceiver()
        self.abort = threading.Event()
        self.errors = []
        self.lock = threading.RLock()
        self.session = ContinuousCaptureSession(self.receiver, self.raw, self.lock, self.abort, self.errors.append)

    def tearDown(self):
        try:
            self.session.stop_and_wait(2)
        except RuntimeError:
            pass
        try:
            self.raw.finish("cleanup", timeout=2)
        except RuntimeError:
            pass
        self.assertFalse(self.session.thread.is_alive())
        self.assertFalse(self.raw._thread.is_alive())
        self.tmp.cleanup()

    def start(self):
        self.session.start()
        self.assertTrue(self.session.ready.wait(2))

    def test_one_sdk_run_keeps_transit_raw_and_resets_station_indices(self):
        self.start()
        first, second = [], []
        self.receiver.push(batch(0))
        self.session.gate(lambda value, global_start: first.append((value, global_start)), 4)
        self.receiver.push(batch(4))
        self.receiver.push(batch(8))
        self.assertEqual(self.session.ungate(), 12)
        self.receiver.push(batch(12))
        self.session.gate(lambda value, global_start: second.append((value, global_start)), 16)
        self.receiver.push(batch(16))
        self.session.stop_and_wait(2)
        self.assertEqual(self.receiver.runs, 1)
        self.assertTrue(self.receiver.kwargs["keep_laser_on"])
        self.assertIs(self.receiver.kwargs["abort"], self.abort)
        self.assertEqual([value.sample_start for value, _ in first], [0, 4])
        self.assertEqual([index for _, index in first], [4, 8])
        self.assertEqual(first[0][0].started_at, 100.004)
        self.assertEqual(second[0][0].sample_start, 0)
        self.assertEqual(second[0][0].started_at, 100.016)
        self.assertEqual(self.raw.accepted_samples, 20)
        self.assertEqual(self.raw.manifest["status"], "incomplete")
        self.raw.finish()
        rows = []
        for chunk in self.store.chunks(self.raw.directory):
            rows.extend(RECORD.iter_unpack(chunk.read_bytes()[HEADER.size:]))
        self.assertEqual([value[0] for value in rows], list(range(20)))

    def test_fence_excludes_old_complete_batches_and_stride_aligns_partial_batch(self):
        self.start()
        received = []
        self.session.gate(lambda value, index: received.append((value, index)), 5)
        self.receiver.push(batch(0))
        self.assertFalse(received)
        self.receiver.push(batch(4))
        self.receiver.push(batch(8))
        self.assertEqual([index for _, index in received], [6, 8])
        self.assertEqual([value.sample_start for value, _ in received], [0, 2])
        self.assertEqual(received[0][0].values, [6.0, 7.0])
        self.assertEqual(received[0][0].rssi, [10.0])
        self.assertEqual(received[0][0].started_at, 100.006)
        self.assertEqual(self.raw.accepted_samples, 12)

    def test_trigger_can_close_gate_under_same_lock_before_later_samples(self):
        self.start()
        received = []

        def callback(value, index):
            received.append(index)
            self.session.ungate()

        self.session.gate(callback, 0)
        self.receiver.push(batch(0))
        self.receiver.push(batch(4))
        self.assertEqual(received, [0])
        self.assertEqual(self.session.global_samples, 8)

    def test_ready_does_not_claim_samples_and_saves_device_metadata(self):
        self.start()
        self.assertEqual(self.raw.accepted_samples, 0)
        self.assertEqual(self.session.global_samples, 0)
        self.assertEqual(self.session.rate, 1000)
        self.assertEqual(self.session.origin, 100)
        self.assertEqual(self.raw.manifest["velocityRangeMps"], 0.2)
        self.assertEqual(self.raw.manifest["acquisition"]["rssiSampleStride"], 2)
        self.receiver.device_settings = {"changed": True}
        self.assertEqual(self.raw.manifest["deviceSettings"], {"sampleRate": 1000})

    def test_sample_gap_aborts_and_never_gates_corrupt_batch(self):
        self.start()
        received = []
        self.session.gate(lambda value, index: received.append(index), 0)
        self.receiver.push(batch(4))
        self.assertTrue(self.session.done.wait(2))
        self.assertTrue(self.abort.is_set())
        self.assertTrue(self.errors)
        self.assertFalse(received)
        self.assertEqual(self.raw.accepted_samples, 0)
        with self.assertRaisesRegex(RuntimeError, "不连续"):
            self.session.check()

    def test_receiver_error_aborts_and_ungates(self):
        self.start()
        self.session.gate(lambda value, index: None, 0)
        self.receiver.push(RuntimeError("device disconnected"))
        self.assertTrue(self.session.done.wait(2))
        self.assertTrue(self.abort.is_set())
        self.assertEqual(self.session.errors, ["device disconnected"])
        with self.assertRaisesRegex(RuntimeError, "device disconnected"):
            self.session.gate(lambda value, index: None, 0)

    def test_unexpected_sdk_return_is_failure(self):
        self.start()
        self.receiver.push("end")
        self.assertTrue(self.session.done.wait(2))
        self.assertTrue(self.abort.is_set())
        self.assertIn("意外结束", self.session.errors[0])

    def test_start_and_gate_cannot_be_repeated(self):
        with self.assertRaisesRegex(RuntimeError, "尚未就绪"):
            self.session.gate(lambda value, index: None, 0)
        self.start()
        with self.assertRaisesRegex(RuntimeError, "重复启动"):
            self.session.start()
        self.session.gate(lambda value, index: None, 0)
        with self.assertRaisesRegex(RuntimeError, "尚未关闭"):
            self.session.gate(lambda value, index: None, 4)

    def test_origin_change_fails_without_reinitializing_station(self):
        self.start()
        self.receiver.push(replace(batch(), started_at=101))
        self.assertTrue(self.session.done.wait(2))
        self.assertIn("时间起点", self.session.errors[-1])
        self.assertEqual(self.raw.accepted_samples, 0)

    def test_stop_timeout_retains_live_owner_until_sdk_returns(self):
        entered, release = threading.Event(), threading.Event()

        def stuck(stop, ready, receive, **kwargs):
            ready(1000.0, 100.0)
            entered.set()
            release.wait(2)

        self.receiver.run = stuck
        self.start()
        self.assertTrue(entered.wait(1))
        owner = self.session.thread
        try:
            with self.assertRaisesRegex(TimeoutError, "保留设备所有权"):
                self.session.stop_and_wait(0.01)
            self.assertIs(self.session.thread, owner)
            self.assertTrue(owner.is_alive())
            self.assertFalse(self.session.done.is_set())
        finally:
            release.set()
        self.session.stop_and_wait(2)
        self.assertTrue(self.session.done.is_set())


if __name__ == "__main__":
    unittest.main()
