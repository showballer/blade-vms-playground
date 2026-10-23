"""One SDK acquisition with explicit, sample-index fenced stationary windows.

All original batches reach the full-session archive. A controller admits a new
station only after motion/arrival validation and an SDK cache fence. Closing the
gate and dispatching motion share the controller lock, so transit data cannot
trigger another move even if it is delivered late.
"""
from __future__ import annotations

import copy
import math
import threading
from typing import Callable

from .async_recording import AsyncRecordingWriter
from .receiver import Batch


class ContinuousCaptureSession:
    def __init__(self, receiver, raw_writer: AsyncRecordingWriter, lock,
                 abort: threading.Event, on_error: Callable[[Exception], None]):
        self.receiver = receiver
        self.raw_writer = raw_writer
        self.lock = lock
        self.abort = abort
        self.on_error = on_error
        self.stop = threading.Event()
        self.done = threading.Event()
        self.ready = threading.Event()
        self.errors: list[str] = []
        self.rate: float | None = None
        self.origin: float | None = None
        self.thread = threading.Thread(target=self._run, name="blade-continuous-receiver", daemon=True)
        self._started = False
        self._next_global = 0
        self._stride: int | None = None
        self._callback: Callable[[Batch, int], None] | None = None
        self._fence = 0
        self._station_first: int | None = None
        self._station_next = 0

    @property
    def global_samples(self) -> int:
        with self.lock:
            return self._next_global

    def start(self):
        with self.lock:
            if self._started:
                raise RuntimeError("连续采集任务不能重复启动。")
            self.check()
            if self.abort.is_set() or self.stop.is_set():
                raise RuntimeError("连续采集已取消，未启动接收。")
            self._started = True
            self.thread.start()
        return self

    def check(self) -> None:
        with self.lock:
            if self.errors:
                raise RuntimeError(self.errors[-1])
        self.raw_writer.check()

    def gate(self, callback: Callable[[Batch, int], None], sample_index: int) -> None:
        """Admit only new, RSSI-aligned samples at or after an SDK fence."""
        with self.lock:
            self.check()
            if (not callable(callback) or isinstance(sample_index, bool) or
                    not isinstance(sample_index, int) or sample_index < 0):
                raise ValueError("点位采集边界或回调无效。")
            if not self.ready.is_set() or self.done.is_set() or self.stop.is_set() or self.abort.is_set():
                raise RuntimeError("连续采集尚未就绪或已结束，未开启点位判定。")
            if self._callback is not None:
                raise RuntimeError("上一点位采集边界尚未关闭，不能重复开启。")
            self._callback = callback
            self._fence = sample_index
            self._station_first = None
            self._station_next = 0

    def ungate(self) -> int:
        with self.lock:
            self._callback = None
            self._station_first = None
            self._station_next = 0
            return self._next_global

    def _failed(self, exc: Exception) -> None:
        with self.lock:
            self.errors.append(str(exc))
            self._callback = None
            self.abort.set()
            self.stop.set()
        try:
            self.on_error(exc)
        except Exception:
            # Reporting cannot obstruct SDK cleanup or done notification.
            pass

    def _ready(self, rate: float, origin: float) -> None:
        with self.lock:
            if self.ready.is_set():
                raise RuntimeError("连续采集在任务中重复初始化了采样时间。")
            if (isinstance(rate, bool) or not math.isfinite(rate) or rate <= 0 or
                    isinstance(origin, bool) or not math.isfinite(origin)):
                raise ValueError("连续采集采样率或时间起点无效。")
            self.raw_writer.manifest["deviceSettings"] = copy.deepcopy(getattr(self.receiver, "device_settings", None))
            self.raw_writer.manifest["velocityRangeMps"] = getattr(self.receiver, "velocity_range_mps", None)
            acquisition = copy.deepcopy(getattr(self.receiver, "acquisition_metadata", None))
            if acquisition is not None:
                self.raw_writer.manifest["acquisition"] = acquisition
                if "rssiSampleStride" in acquisition:
                    self.raw_writer.manifest["rssiSampleStride"] = acquisition["rssiSampleStride"]
                    self._stride = acquisition["rssiSampleStride"]
                if "rssiSampleRate" in acquisition:
                    self.raw_writer.manifest["rssiSampleRate"] = acquisition["rssiSampleRate"]
            self.raw_writer.ready(rate, origin)
            self.rate, self.origin = rate, origin
            self.ready.set()

    def _receive(self, batch: Batch) -> None:
        with self.lock:
            self.raw_writer.check()
            if not self.ready.is_set():
                raise RuntimeError("连续采集收到样本时尚未确认采样率。")
            if batch.sample_start != self._next_global:
                raise ValueError("连续采集全任务样本序号不连续。")
            if batch.sample_rate != self.rate or batch.started_at != self.origin:
                raise ValueError("连续采集采样率或时间起点发生变化。")
            stride = batch.rssi_sample_stride
            if (isinstance(stride, bool) or not isinstance(stride, int) or not 1 <= stride <= 100_000 or
                    batch.sample_start % stride or self._stride not in (None, stride)):
                raise ValueError("连续采集 RSSI 时标发生变化。")
            # The writer additionally validates channel lengths and owns its
            # queued copy before station detection can mutate any arrays.
            self.raw_writer.write(batch)
            count = len(batch.values)
            self._next_global += count
            if count:
                self._stride = stride
            callback = self._callback
            if (callback is None or not count or self.stop.is_set() or self.abort.is_set()):
                return
            # Round up, never admit a pre-arrival sample or fabricate RSSI by
            # shifting sparse observations onto a different velocity sample.
            first = max(batch.sample_start, self._fence)
            first = ((first + stride - 1) // stride) * stride
            offset = first - batch.sample_start
            if offset >= count:
                return
            if self._station_first is None:
                self._station_first = first
                self._station_next = first
            if first != self._station_next:
                raise ValueError("当前点位样本序号不连续，已暂停叶片判定。")
            local = Batch(first - self._station_first, batch.sample_rate,
                          batch.started_at + self._station_first / batch.sample_rate,
                          batch.velocity_raw[offset:], batch.values[offset:],
                          batch.rssi_raw[offset // stride:], batch.rssi[offset // stride:],
                          batch.overrange[offset:], stride)
            self._station_next = batch.sample_start + count
            callback(local, first)

    def _run(self) -> None:
        try:
            kwargs = ({"keep_laser_on": True, "abort": self.abort}
                      if getattr(self.receiver, "supports_laser_persistence", False) else {})
            self.receiver.run(self.stop, self._ready, self._receive, **kwargs)
            if not self.stop.is_set() and not self.abort.is_set():
                raise RuntimeError("连续接收意外结束，采集任务已停止。")
            self.raw_writer.check()
        except Exception as exc:
            self._failed(exc)
        finally:
            with self.lock:
                self._callback = None
            self.done.set()

    def stop_and_wait(self, timeout: float = 20) -> None:
        """Stop admission before SDK shutdown; retain ownership on timeout."""
        with self.lock:
            self.ungate()
            self.stop.set()
            started = self._started
        if not started:
            self.done.set()
            return
        if threading.current_thread() is self.thread:
            raise RuntimeError("接收线程不能等待自身结束。")
        self.thread.join(timeout)
        if self.thread.is_alive():
            raise TimeoutError("连续采集线程尚未退出，保留设备所有权，不能启动下一任务。")
        self.check()
