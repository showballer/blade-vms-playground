"""Bounded, fail-closed disk worker for a continuous receiver.

The controller owns ``manifest`` metadata. The worker owns RecordingWriter and
publishes only storage accounting fields back to that mirror. Metadata is copied
when commands are submitted, never serialized concurrently with controller edits.
``accepted_samples`` is a receiver sequence counter, not a saved-sample claim.
Call finish()/wait() before advertising a complete record or releasing ownership.
"""
from __future__ import annotations

import copy
import math
import queue
import threading
import time
from typing import Callable

from .receiver import Batch
from .storage import RecordingWriter


class AsyncRecordingError(RuntimeError):
    pass


# These fields are computed exclusively by RecordingWriter, never overwritten by
# a possibly older controller metadata snapshot.
_ACCOUNTING = frozenset({
    "id", "samples", "chunks", "status", "error", "endedAt", "overrangeSamples",
    "missingRssiSamples", "unpairedRssiSamples", "rssiNotSampledVelocitySamples",
    "rssiMissingExpectedSamples",
    "writerDiagnostics", "storageDiagnostics",
})


class AsyncRecordingWriter:
    def __init__(self, writer: RecordingWriter, *, max_batches: int = 512, max_pending_samples: int = 500_000,
                 on_error: Callable[[Exception], None] | None = None,
                 publication_lock=None):
        if isinstance(max_batches, bool) or not isinstance(max_batches, int) or max_batches < 1:
            raise ValueError("落盘队列容量必须是正整数。")
        if isinstance(max_pending_samples, bool) or not isinstance(max_pending_samples, int) or max_pending_samples < 1:
            raise ValueError("落盘样本缓冲上限必须是正整数。")
        # Bound both command count and retained sample arrays. At 250 kHz the
        # sample budget covers two seconds of transient disk/OS jitter, not an
        # indefinitely slow disk. Include the batch currently being written.
        self._sample_capacity = max_pending_samples
        self._pending_samples = 0
        self.id, self.directory = writer.id, writer.directory
        self.manifest = copy.deepcopy(writer.manifest)
        self._writer = writer
        self._queue: queue.Queue = queue.Queue(maxsize=max_batches)
        self._lock = threading.RLock()
        # The controller takes this lock while reading/editing the manifest.
        # Keep the same lock order as submit: controller, then writer. Never
        # acquire it from inside _lock or while reporting a disk failure.
        self._publication_lock = publication_lock
        self._on_error = on_error
        self._error: Exception | None = None
        self._closing = False
        self._final_metadata: dict | None = None
        self._finish_error: str | None = None
        self._accepted_samples = int(writer.manifest["samples"])
        self._rate = writer.manifest.get("sampleRate")
        self._origin = writer.manifest.get("sampleOrigin")
        self._stride = writer.manifest.get("rssiSampleStride")
        self._diagnostics = {"queueCapacity": max_batches, "maxQueueDepth": 0,
                             "sampleCapacity": max_pending_samples, "maxPendingSamples": 0,
                             "publicationDeferrals": 0, "maxWriteMs": 0.0,
                             "maxPersistMs": 0.0}
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"recording-{self.id[:8]}", daemon=True)
        self._thread.start()

    @property
    def accepted_samples(self) -> int:
        with self._lock:
            return self._accepted_samples

    @property
    def pending(self) -> bool:
        return not self._done.is_set()

    def check(self) -> None:
        with self._lock:
            error = self._error
        if error is not None:
            raise AsyncRecordingError(f"原始数据异步落盘失败：{error}") from error

    def _fail(self, error: Exception) -> None:
        with self._lock:
            first = self._error is None
            if first:
                self._error = error
        if first and self._on_error:
            try:
                self._on_error(error)
            except Exception:
                # An observer cannot prevent error persistence or thread cleanup.
                pass

    def _metadata(self) -> dict:
        return copy.deepcopy({key: value for key, value in self.manifest.items() if key not in _ACCOUNTING})

    def _enqueue(self, command: tuple) -> None:
        self.check()
        if self._closing or self._done.is_set():
            raise AsyncRecordingError("采集记录已开始收尾，不能继续写入。")
        try:
            self._queue.put_nowait(command)
            self._diagnostics["maxQueueDepth"] = max(self._diagnostics["maxQueueDepth"], self._queue.qsize())
        except queue.Full as exc:
            raise AsyncRecordingError("原始数据落盘队列已满；已停止采集，不会忽略数据继续运行。") from exc

    def ready(self, sample_rate: float, origin: float) -> None:
        try:
            with self._lock:
                if (isinstance(sample_rate, bool) or not math.isfinite(sample_rate) or sample_rate <= 0 or
                        isinstance(origin, bool) or not math.isfinite(origin)):
                    raise ValueError("采样率或采集时间起点无效。")
                if self._rate is not None and (self._rate != sample_rate or self._origin != origin):
                    raise ValueError("采集过程中采样率或时间起点发生变化。")
                self._enqueue(("ready", sample_rate, origin, self._metadata()))
                self._rate, self._origin = sample_rate, origin
                self.manifest.update(sampleRate=sample_rate, sampleOrigin=origin)
        except Exception as exc:
            self._fail(exc)
            raise

    def _validate(self, batch: Batch) -> None:
        count, stride = len(batch.values), batch.rssi_sample_stride
        if isinstance(stride, bool) or not isinstance(stride, int) or not 1 <= stride <= 100_000:
            raise ValueError("RSSI 采样间隔无效。")
        if batch.sample_start % stride or self._stride not in (None, stride):
            raise ValueError("RSSI 采样间隔或起点在采集中发生变化。")
        if len(batch.rssi) != len(batch.rssi_raw):
            raise ValueError("RSSI 原始值与换算值数量不一致。")
        if (count != len(batch.velocity_raw) or count != len(batch.overrange) or
                batch.sample_start != self._accepted_samples):
            raise ValueError("SDK 批次样本结构或序号不连续。")
        if self._rate is None or batch.sample_rate != self._rate or batch.started_at != self._origin:
            raise ValueError("采集过程中采样率或时间起点发生变化。")

    def write(self, batch: Batch) -> None:
        """Accept one owned copy without waiting on filesystem I/O."""
        try:
            with self._lock:
                self.check()
                self._validate(batch)
                if self._pending_samples + len(batch.values) > self._sample_capacity:
                    raise AsyncRecordingError("原始数据落盘队列已满（样本缓冲达到上限）；已停止采集，不会忽略数据继续运行。")
                # Batch is frozen but its arrays are mutable. Own the data while
                # receiver buffers are recycled on subsequent SDK reads.
                owned = Batch(batch.sample_start, batch.sample_rate, batch.started_at,
                              list(batch.velocity_raw), list(batch.values), list(batch.rssi_raw),
                              list(batch.rssi), list(batch.overrange), batch.rssi_sample_stride)
                self._enqueue(("write", owned))
                self._pending_samples += len(batch.values)
                self._diagnostics["maxPendingSamples"] = max(self._diagnostics["maxPendingSamples"], self._pending_samples)
                self._accepted_samples += len(batch.values)
                if batch.values:
                    self._stride = batch.rssi_sample_stride
        except Exception as exc:
            self._fail(exc)
            raise

    submit = write

    def persist(self) -> None:
        try:
            with self._lock:
                self._enqueue(("persist", self._metadata()))
        except Exception as exc:
            self._fail(exc)
            raise

    def finish(self, error: str | None = None, *, wait: bool = True,
               timeout: float | None = None) -> dict | None:
        """Drain accepted batches then close files; no completion before fsync.

        Finish is out-of-band so even a full queue can always be closed. Error
        requests are monotonic: a later successful finish cannot hide failure.
        """
        with self._lock:
            if not self._closing:
                self._final_metadata = self._metadata()
                self._closing = True
            if error:
                self._finish_error = error
        return self.wait(timeout) if wait else None

    def wait(self, timeout: float | None = None) -> dict:
        if threading.current_thread() is self._thread:
            raise RuntimeError("落盘线程不能等待自身结束。")
        if not self._done.wait(timeout):
            raise TimeoutError("等待原始数据落盘收尾超时，记录仍未完成。")
        self._thread.join()
        self.check()
        with self._lock:
            return copy.deepcopy(self.manifest)

    def close(self) -> dict:
        return self.finish("采集记录已中止")

    def _publish(self, *, final=False) -> None:
        # Progress publication must not serialize disk throughput with receiver
        # detection/status copying under the controller lock. Skip only the
        # mirror update; every accepted batch still reaches the disk worker.
        # Final publication remains mandatory before wait() can report success.
        lock = self._publication_lock
        if lock is not None and not lock.acquire(blocking=final):
            with self._lock:
                self._diagnostics["publicationDeferrals"] += 1
            return
        try:
            with self._lock:
                self.manifest.update({key: copy.deepcopy(value) for key, value in self._writer.manifest.items()
                                      if key in _ACCOUNTING})
                for key in ("rssiSampleStride", "rssiSampleRate"):
                    if key in self._writer.manifest:
                        self.manifest[key] = self._writer.manifest[key]
        finally:
            if lock is not None:
                lock.release()

    def _run(self) -> None:
        try:
            while True:
                with self._lock:
                    finish = (self._closing or self._error is not None) and self._queue.empty()
                if finish:
                    break
                try:
                    command = self._queue.get(timeout=0.05)
                except queue.Empty:
                    continue
                try:
                    kind = command[0]
                    started = time.monotonic()
                    if kind == "ready":
                        self._writer.manifest.update(command[3])
                        self._writer.ready(command[1], command[2])
                    elif kind == "write":
                        self._writer.write(command[1])
                    else:
                        self._writer.manifest.update(command[1])
                        self._writer.persist()
                    with self._lock:
                        key = "maxWriteMs" if kind == "write" else "maxPersistMs"
                        self._diagnostics[key] = max(self._diagnostics[key], (time.monotonic() - started) * 1000)
                    self._publish()
                finally:
                    if command[0] == "write":
                        with self._lock:
                            self._pending_samples -= len(command[1].values)
                    self._queue.task_done()
        except Exception as exc:
            self._fail(exc)
        finally:
            try:
                with self._lock:
                    metadata = self._final_metadata
                    error = str(self._error) if self._error is not None else self._finish_error
                    diagnostics = copy.deepcopy(self._diagnostics)
                    diagnostics.update(acceptedSamples=self._accepted_samples,
                                       writtenSamples=self._writer.manifest["samples"])
                if metadata is not None:
                    self._writer.manifest.update(metadata)
                self._writer.manifest["writerDiagnostics"] = diagnostics
                self._writer.finish(error)
            except Exception as exc:
                self._fail(exc)
                self._writer.manifest.update(status="incomplete", error=str(exc))
                if self._writer.stream:
                    self._writer.stream.close()
                    self._writer.stream = None
            finally:
                # Release batches that cannot be written after a disk failure.
                # Their accepted count is retained, while saved count is not
                # advanced. The record and callback expose the failure.
                while True:
                    try:
                        self._queue.get_nowait()
                        self._queue.task_done()
                    except queue.Empty:
                        break
                self._publish(final=True)
                self._done.set()
