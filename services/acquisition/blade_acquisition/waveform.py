"""Display-only, bounded waveform reads. Never edits or filters the raw recording.

Wide views use interval min/max envelopes, NOT evenly spaced pseudo-samples.
Small views return every original sample. Completed-chunk summaries are an LRU
memory cache; old BLADEV01 recordings work without migration or new files.
"""
from __future__ import annotations

import math
import os
import threading
from collections import OrderedDict

from .storage import HEADER, MAGIC, RECORD, empty_waveform

RAW_LIMIT = 4096
MAX_BUCKETS = 1000
CACHE_STEP = 1024


def summarize(rows):
    """Rows are (sample index, velocity m/s, optional RSSI %, overrange)."""
    rows = list(rows)
    if not rows:
        return None
    rssi = [row[2] for row in rows if row[2] is not None]
    return {"start": rows[0][0], "end": rows[-1][0] + 1,
            "min": min(row[1] for row in rows), "max": max(row[1] for row in rows),
            "rssiMin": min(rssi) if rssi else None, "rssiMax": max(rssi) if rssi else None,
            "missing": len(rows) - len(rssi), "overrange": sum(bool(row[3]) for row in rows)}


def merge(left, right):
    if left is None:
        return dict(right)
    if left["end"] != right["start"]:
        raise ValueError("显示区间样本不连续，请检查原始文件。")
    for low, high in (("min", "max"), ("rssiMin", "rssiMax")):
        valid = [value for value in (left[low], right[low]) if value is not None]
        left[low] = min(valid) if valid else None
        valid = [value for value in (left[high], right[high]) if value is not None]
        left[high] = max(valid) if valid else None
    left["end"] = right["end"]
    left["missing"] += right["missing"]
    left["overrange"] += right["overrange"]
    return left


def bucket_size(length):
    # Absolute, power-of-two boundaries permit exact merging of cached blocks.
    return 1 << max(0, math.ceil(math.log2(max(1, math.ceil(length / (MAX_BUCKETS - 1))))))


def envelope_rows(rows, step):
    bucket, current = [], None
    for row in rows:
        key = row[0] // step
        if current is not None and key != current:
            yield summarize(bucket)
            bucket = []
        current = key
        bucket.append(row)
    if bucket:
        yield summarize(bucket)


def make_wave(rows, rate, origin, start=None, end=None):
    rows = list(rows)
    wave = empty_waveform()
    wave.update(sampleRate=rate, sampleOrigin=origin, representation="raw",
                sourceSamples=len(rows), overrangeCount=sum(row[3] for row in rows),
                missingRssiCount=sum(row[2] is None for row in rows))
    if not rows:
        return wave
    wave.update(sampleStart=rows[0][0], rangeStart=rows[0][0] if start is None else start,
                rangeEnd=rows[-1][0] + 1 if end is None else end)
    if len(rows) <= RAW_LIMIT:
        wave.update(values=[row[1] for row in rows], rssi=[row[2] for row in rows],
                    overrange=[row[3] for row in rows])
    else:
        wave.update(representation="envelope", envelope=list(envelope_rows(rows, bucket_size(len(rows)))))
    # Instantaneous indicators are actual last samples, never an envelope extremum.
    wave["latest"] = {"velocity": rows[-1][1], "rssi": rows[-1][2]}
    return wave


class WaveformReader:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.cache = OrderedDict()

    def _rows(self, stream, header_start, begin, end):
        stream.seek(HEADER.size + (begin - header_start) * RECORD.size)
        expected = begin
        while expected < end:
            amount = min(8192, end - expected)
            payload = stream.read(amount * RECORD.size)
            if len(payload) != amount * RECORD.size:
                raise ValueError("原始分块在读取期间被截断。")
            for row in RECORD.iter_unpack(payload):
                if row[0] != expected or not math.isfinite(row[2]) or (row[5] & 2 and not math.isfinite(row[4])):
                    raise ValueError("原始样本序号或数值无效，未伪造补点。")
                yield (row[0], row[2], row[4] if row[5] & 2 else None, bool(row[5] & 1))
                expected += 1

    def read(self, recording_id, start=0, end=None, manifest=None):
        # No acquisition/controller lock is held during file I/O or aggregation.
        # Prevent overlapping expensive requests from exhausting memory/threads.
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError("另一段波形正在读取，请稍后重试。")
        try:
            return self._read(recording_id, start, end, manifest)
        finally:
            self.lock.release()

    def _read(self, recording_id, start, end, manifest):
        directory = self.store.directory(recording_id)
        try:
            manifest = manifest or self.store._read_manifest(directory)
        except FileNotFoundError as exc:
            raise KeyError("采集记录不存在。") from exc
        total = manifest["samples"]
        end = total if end is None else min(total, end)
        start = min(start, end)
        rate, origin = manifest.get("sampleRate"), manifest.get("sampleOrigin")
        if total and (not rate or not math.isfinite(rate) or rate <= 0):
            raise ValueError("记录采样率无效。")
        wave = make_wave([], rate, origin)
        wave.update(rangeStart=start, rangeEnd=end, sampleStart=start, sourceSamples=end - start)
        if start == end:
            return {"recording": manifest, "waveform": wave}
        step = bucket_size(end - start)
        raw, aggregates = [], []
        covered = start
        for path in self.store.chunks(directory):
            # A live .part may be finalized between listing and open. Retry only
            # the same chunk's final name; never silently skip a missing chunk.
            try:
                stream = path.open("rb")
            except FileNotFoundError:
                if not path.name.endswith(".part"):
                    raise
                path = path.with_suffix("")
                stream = path.open("rb")
            with stream:
                stat = os.fstat(stream.fileno())
                header = stream.read(HEADER.size)
                if len(header) != HEADER.size:
                    raise ValueError("原始分块头不完整。")
                magic, chunk_rate, chunk_origin, chunk_start = HEADER.unpack(header)
                chunk_end = chunk_start + max(0, stat.st_size - HEADER.size) // RECORD.size
                if magic != MAGIC or chunk_rate != rate or not math.isfinite(chunk_origin):
                    raise ValueError("原始分块头与记录信息不一致。")
                if origin is None:  # Older metadata may omit it; the raw header is authoritative.
                    origin = chunk_origin
                    wave["sampleOrigin"] = origin
                if origin != chunk_origin:
                    raise ValueError("原始分块的时间起点不一致。")
                begin, finish = max(start, chunk_start), min(end, chunk_end)
                if begin >= finish:
                    continue
                if begin != covered:
                    raise ValueError("原始分块缺失或重叠，未伪造连续波形。")
                covered = finish
                if end - start <= RAW_LIMIT:
                    raw.extend(self._rows(stream, chunk_start, begin, finish))
                    continue
                if step >= CACHE_STEP and not path.name.endswith(".part"):
                    key = (str(path), stat.st_size, stat.st_mtime_ns)
                    blocks = self.cache.get(key)
                    if blocks is None:
                        blocks = list(envelope_rows(self._rows(stream, chunk_start, chunk_start, chunk_end), CACHE_STEP))
                        self.cache[key] = blocks
                        if len(self.cache) > 64:
                            self.cache.popitem(last=False)
                    self.cache.move_to_end(key)
                    pieces = []
                    for block in blocks:
                        lo, hi = max(begin, block["start"]), min(finish, block["end"])
                        if lo >= hi:
                            continue
                        pieces.append(block if lo == block["start"] and hi == block["end"] else
                                      summarize(self._rows(stream, chunk_start, lo, hi)))
                else:
                    pieces = envelope_rows(self._rows(stream, chunk_start, begin, finish), step)
                for piece in pieces:
                    if aggregates and aggregates[-1]["start"] // step == piece["start"] // step:
                        merge(aggregates[-1], piece)
                    else:
                        aggregates.append(dict(piece))
            if covered == end:
                break
        if covered != end:
            raise ValueError("记录标记的样本数超过可读取原始数据，请检查记录完整性。")
        if raw:
            wave = make_wave(raw, rate, origin, start, end)
        else:
            wave.update(representation="envelope", envelope=aggregates,
                        overrangeCount=sum(item["overrange"] for item in aggregates),
                        missingRssiCount=sum(item["missing"] for item in aggregates))
        return {"recording": manifest, "waveform": wave}
