"""Materialize early-pass records only after the continuous archive is closed.

Construction/finish are memory-only; motion never waits for a new station file,
SDK fence, or first stationary packet. wait() runs on cycle cleanup, never on the
receiver thread, after raw fsync. The archive bookmark remains the source of truth.
"""
from __future__ import annotations

import copy
import time
import numpy as np

from .receiver import Batch
from .storage import HEADER, MAGIC, RECORD_DTYPE, RecordingWriter, recording_manifest


def copy_raw_window(raw, writer, start, end):
    """Copy a bounded, RSSI-aligned interval without changing the source archive."""
    manifest = raw.manifest
    rate, origin = manifest['sampleRate'], manifest['sampleOrigin']
    stride = manifest.get('rssiSampleStride', 1)
    if not 0 <= start < end <= manifest['samples'] or start % stride:
        raise ValueError('提前经过原始数据区间无效或尚未完整落盘')
    writer.ready(rate, origin + start / rate)
    cursor = start
    block = max(1, 65536 // stride) * stride
    for path in sorted(raw.directory.glob('chunk-*.bin')):
        with path.open('rb') as stream:
            header = stream.read(HEADER.size)
            if len(header) != HEADER.size:
                raise ValueError('连续原始记录文件头不完整')
            magic, chunk_rate, chunk_origin, first = HEADER.unpack(header)
            size, remainder = divmod(path.stat().st_size - HEADER.size, RECORD_DTYPE.itemsize)
            if (magic != MAGIC or chunk_rate != rate or chunk_origin != origin or remainder):
                raise ValueError('连续原始记录格式或时标不一致')
            if first + size <= cursor:
                continue
            if first > cursor:
                raise ValueError('提前经过原始样本不连续')
            until = min(end, first + size)
            stream.seek(HEADER.size + (cursor - first) * RECORD_DTYPE.itemsize)
            while cursor < until:
                count = min(block, until - cursor)
                data = np.fromfile(stream, dtype=RECORD_DTYPE, count=count)
                if len(data) != count or not np.array_equal(data['index'], np.arange(cursor, cursor + count)):
                    raise ValueError('提前经过原始样本缺失或索引不连续')
                if not np.all(data['flags'][::stride] & 2):
                    raise ValueError('提前经过区间缺少对应回波样本，未伪造数据')
                writer.write(Batch(cursor - start, rate, origin + start / rate,
                    data['velocityRaw'], data['velocity'], data['rssiRaw'][::stride],
                    data['rssi'][::stride], ((data['flags'] & 1) != 0).tolist(), stride))
                cursor += count
            if cursor == end:
                return
    raise ValueError('提前经过原始数据区间未完整保存')


class DeferredDiagnosticRecord:
    def __init__(self, store, metadata, raw_writer, start, end):
        self.store, self.raw_writer = store, raw_writer
        self.start, self.end = start, end
        self.manifest = recording_manifest(copy.deepcopy(metadata))
        self.id = self.manifest['id']
        self.directory = store.directory(self.id)
        self._final_metadata = None
        self._finish_error = self._error = None
        self._done = False

    @property
    def pending(self):
        return not self._done

    def check(self):
        if self._error:
            raise RuntimeError(self._error)

    def finish(self, error=None, *, wait=True, timeout=None):
        if self._final_metadata is None:
            self._final_metadata = copy.deepcopy(self.manifest)
        if error:
            self._finish_error = error
        return self.wait(timeout) if wait else None

    def wait(self, timeout=None):
        if self._done:
            self.check()
            return copy.deepcopy(self.manifest)
        if self._final_metadata is None:
            raise RuntimeError('提前经过记录尚未完成换点，不能提前发布')
        raw_error = None
        try:
            self.raw_writer.wait(timeout)
        except Exception as exc:
            if self.raw_writer.pending:
                raise  # Keep pending ownership on timeout; cleanup can retry.
            raw_error = str(exc)
        writer = None
        try:
            writer = RecordingWriter(self.store, self._final_metadata, recording_id=self.id,
                                     started_at=self.manifest['startedAt'])
            if raw_error:
                raise RuntimeError(raw_error)
            copy_raw_window(self.raw_writer, writer, self.start, self.end)
            writer.manifest['pointCycle']['recordMaterializedAt'] = time.time()
            writer.finish(self._finish_error)
            self.manifest = copy.deepcopy(writer.manifest)
        except Exception as exc:
            self._error = str(exc)
            if writer is not None:
                try:
                    writer.finish(self._error)
                finally:
                    self.manifest = copy.deepcopy(writer.manifest)
            else:
                self.manifest.update(status='error', error=self._error)
            raise
        finally:
            self._done = True
        return copy.deepcopy(self.manifest)
