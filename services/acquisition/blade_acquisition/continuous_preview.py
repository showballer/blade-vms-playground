"""Bounded, display-only memory for points saved after continuous capture ends.

The receiver copies compact blocks, never builds a chart or touches station
files. Taking a window only retains immutable block references. Chart/FFT
preparation runs in the frame request, outside the controller/motion lock.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math

import numpy as np

from .storage import DISPLAY_LIMIT, empty_waveform
from .waveform import RAW_LIMIT, array_envelope, bucket_size, sparse_envelope

MAX_PREVIEW_SAMPLES = 250_000
MAX_PREVIEW_BLOCKS = 256


@dataclass(frozen=True)
class PreviewBlock:
    start: int
    values: np.ndarray
    rssi: np.ndarray
    overrange: np.ndarray

    @property
    def end(self):
        return self.start + len(self.values)


@dataclass(frozen=True)
class PreviewWindow:
    blocks: tuple[PreviewBlock, ...]
    start: int
    end: int
    rate: float
    raw_origin: float
    stride: int

    def frame(self, window_ms=None):
        """Return record-local indices, exactly as in the eventual station file."""
        amount = (min(MAX_PREVIEW_SAMPLES, max(1, math.ceil(self.rate * window_ms / 1000)))
                  if window_ms else DISPLAY_LIMIT)
        # Keep the FFT input independent of the requested chart window.
        first = max(self.start, self.end - max(amount, 4096))
        parts = [(block, max(first, block.start) - block.start,
                  min(self.end, block.end) - block.start) for block in self.blocks
                 if block.end > first and block.start < self.end]
        wave = empty_waveform()
        origin = self.raw_origin + self.start / self.rate
        wave.update(sampleRate=self.rate, sampleOrigin=origin, representation="raw",
                    sourceSamples=0, overrangeCount=0, missingRssiCount=0)
        if self.stride > 1:
            wave.update(rssiSampleStride=self.stride, rssiSampleRate=self.rate / self.stride)
        if not parts:
            return wave, []
        indices = np.concatenate([np.arange(b.start + a - self.start, b.start + z - self.start,
                                           dtype=np.int64) for b, a, z in parts])
        values = np.concatenate([b.values[a:z] for b, a, z in parts])
        rssi = np.concatenate([b.rssi[a:z] for b, a, z in parts])
        flags = np.concatenate([b.overrange[a:z] for b, a, z in parts])
        # At most 4096 original samples, never envelope extrema, enter FFT/STFT.
        realtime = [(int(i), float(v), float(r) if np.isfinite(r) else None, bool(f))
                    for i, v, r, f in zip(indices[-4096:], values[-4096:], rssi[-4096:], flags[-4096:])]
        indices, values, rssi, flags = (a[-amount:] for a in (indices, values, rssi, flags))
        wave.update(sampleStart=int(indices[0]), rangeStart=int(indices[0]),
                    rangeEnd=int(indices[-1]) + 1, sourceSamples=len(indices))
        if len(indices) <= RAW_LIMIT:
            wave.update(values=values.tolist(), rssi=[float(v) if np.isfinite(v) else None for v in rssi],
                        overrange=flags.tolist(), overrangeCount=int(flags.sum()),
                        missingRssiCount=int((np.isnan(rssi) & (indices % self.stride == 0)).sum()))
        else:
            envelope = sparse_envelope(array_envelope(indices, values, rssi, flags,
                                                       bucket_size(len(indices))), self.stride)
            wave.update(representation="envelope", envelope=envelope,
                        overrangeCount=sum(b["overrange"] for b in envelope),
                        missingRssiCount=sum(b["missing"] for b in envelope))
        observed = np.flatnonzero(indices % self.stride == 0)
        last = int(observed[-1]) if len(observed) else None
        wave["latest"] = {"velocity": float(values[-1]),
                          "rssi": float(rssi[last]) if last is not None and np.isfinite(rssi[last]) else None}
        if self.stride > 1:
            wave["latest"]["rssiSampleIndex"] = int(indices[last]) if last is not None else None
        return wave, realtime


class ContinuousPreviewBuffer:
    def __init__(self):
        self.blocks = deque(maxlen=MAX_PREVIEW_BLOCKS)

    def append(self, batch):
        count = len(batch.values)
        if not count:
            return
        capacity = min(MAX_PREVIEW_SAMPLES, max(1, math.ceil(batch.sample_rate)))
        offset = max(0, count - capacity)
        # Copies own the preview; SDK callers may reuse or mutate their arrays.
        values = np.array(batch.values[offset:], dtype=np.float64, copy=True)
        flags = np.array(batch.overrange[offset:], dtype=np.bool_, copy=True)
        rssi = np.full(len(values), np.nan)
        stride = batch.rssi_sample_stride
        source_first = (offset + stride - 1) // stride
        source_end = min(len(batch.rssi), (count + stride - 1) // stride)
        if source_end > source_first:
            positions = np.arange(source_first, source_end) * stride - offset
            rssi[positions] = batch.rssi[source_first:source_end]
        for value in (values, flags, rssi):
            value.setflags(write=False)
        self.blocks.append(PreviewBlock(batch.sample_start + offset, values, rssi, flags))
        first = batch.sample_start + count - capacity
        while self.blocks and self.blocks[0].end <= first:
            self.blocks.popleft()
        # Retaining one partial oldest block bounds memory to capacity + one
        # block; each block is itself <= capacity. No copy in the motion path.

    def window(self, start, end, rate, origin, stride=1):
        # A station file starts on an original RSSI sample (copy_raw_window
        # enforces the same invariant). Otherwise local index modulo stride
        # would silently shift RSSI phase. Display tails may start anywhere.
        if isinstance(stride, bool) or not isinstance(stride, int) or stride < 1 or start % stride:
            raise ValueError("预览记录起点必须对齐原始 RSSI 采样间隔")
        return PreviewWindow(tuple(b for b in self.blocks if b.end > start and b.start < end),
                             start, end, rate, origin, stride)
