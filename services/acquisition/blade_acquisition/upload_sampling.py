"""Immutable, bounded-memory upload derivatives; acquisition files are never edited."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import shutil
import uuid
from fractions import Fraction
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

from .csv_export import prepare_export
from .native_capture import SAMPLES
from .storage import HEADER, MAGIC, RECORD, atomic_json

VERSION = 1


def sample_rate(value):
    if type(value) is not int or value != 0 and not 10_000 <= value <= 100_000:
        raise ValueError("上传采样率应为 10,000～100,000 Hz，或 0（原始采样率）。")
    return value


def remap_indices(value, up, down, total):
    """Keep host times/angles intact; map sample indices to the derivative clock."""
    if isinstance(value, list):
        return [remap_indices(item, up, down, total) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key in {"bufferFence", "continuousSession"} and isinstance(item, dict):
            # These indices describe the full-rate session archive, including
            # transit before this station. They are not indices into the local
            # station waveform, and must not be scaled or clamped to its size.
            result[key] = copy.deepcopy(item)
            result[key].setdefault("sampleClock", "continuous_session_raw")
        elif type(item) is int and item >= 0 and (key.endswith("SampleIndex") or key == "sampleIndex"):
            result[key] = min(total - 1, item * up // down)
        elif type(item) is int and item >= 0 and key in ("observedSamples", "receivedSamples"):
            result[key] = (item * up + down - 1) // down
        else:
            result[key] = remap_indices(item, up, down, total)
    return result


def prepare_upload(store, recording_id, target_rate, cache_root):
    target_rate = sample_rate(target_rate)
    manifest, chunks = prepare_export(store, recording_id)
    source = store.directory(recording_id)
    rate, count = manifest["sampleRate"], manifest["samples"]
    if not target_rate or target_rate >= rate:
        return {"directory": str(source), "recording": manifest}
    if not count:
        raise ValueError("空记录不能生成上传副本。")
    # Unpaired RSSI has a separate, nonuniform clock. Preserve it by requiring
    # the full-rate option rather than pretending it was uniformly resampled.
    if manifest.get("unpairedRssiSamples", 0):
        raise ValueError("此记录含未配对 RSSI，请选择原始采样率上传以保留完整质量证据。")
    ratio = Fraction(str(target_rate)) / Fraction(str(rate))
    up, down = ratio.numerator, ratio.denominator
    if max(up, down) > 100_000:
        raise ValueError("源采样率不能精确转换到所选采样率，请选择原始采样率上传。")
    paths = [source / "manifest.json", *(p for p, _ in chunks)]
    telemetry = source / "turntable.jsonl"
    if telemetry.exists():
        if telemetry.is_symlink():
            raise ValueError("转盘遥测文件无效。")
        paths.append(telemetry)
    stamps = [(p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in paths]
    fingerprint = hashlib.sha256(json.dumps([VERSION, target_rate, stamps]).encode()).hexdigest()
    root = Path(cache_root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or source.resolve() == root.resolve() or source.resolve() in root.resolve().parents:
        raise ValueError("上传缓存不能写入原始记录目录。")
    destination = root / f"{recording_id}-{target_rate}-{fingerprint[:16]}"
    if destination.is_symlink():
        raise ValueError("上传缓存目录无效。")
    if destination.exists():
        cached = json.loads((destination / "manifest.json").read_text("utf-8"))
        if cached.get("sampling", {}).get("sourceFingerprint") == fingerprint:
            return {"directory": str(destination), "recording": cached}
        raise ValueError("上传缓存校验失败。")
    temporary = root / (".sampling-" + uuid.uuid4().hex)
    temporary.mkdir(mode=0o700)
    total = (count * up + down - 1) // down
    # Align each block/overlap on the rational filter phase. The symmetric FIR
    # is delay compensated by resample_poly. Context prevents block seams.
    block = max(down, (262_144 // down) * down)
    expected_stride = manifest.get("rssiSampleStride", 1)
    overlap = math.ceil(max(10 * max(up, down) / up + down, expected_stride) / down) * down
    locations, offset = [], 0
    for path, size in chunks:
        locations.append((path, offset, offset + size)); offset += size

    def read(begin, end):
        parts = []
        for path, lo, hi in locations:
            left, right = max(begin, lo), min(end, hi)
            if left >= right:
                continue
            with path.open("rb") as stream:
                stream.seek(HEADER.size + (left - lo) * RECORD.size)
                data = np.frombuffer(stream.read((right - left) * RECORD.size), dtype=SAMPLES)
            if (len(data) != right - left or not np.array_equal(data["index"], np.arange(left, right)) or
                    not np.isfinite(data["value"]).all() or np.any(data["flags"] & 252) or
                    not np.isfinite(data["rssi"][data["flags"] & 2 != 0]).all()):
                raise ValueError("原始样本序号、数值或质量标记无效。")
            parts.append(data)
        return np.concatenate(parts)

    overrange = missing = written = chunk_count = 0
    try:
        for start in range(0, count, block):
            end = min(count, start + block)
            lo, hi = max(0, start - overlap), min(count, end + overlap)
            rows = read(lo, hi)
            a, b = start * up // down, (end * up + down - 1) // down
            # Packed BLADEV01 uses a 29-byte stride. Native DSP kernels require
            # an aligned contiguous float buffer, not that unaligned field view.
            values = resample_poly(np.ascontiguousarray(rows["value"]), up, down, window=("kaiser", 8.6))
            values = values[(start - lo) * up // down:(start - lo) * up // down + b - a]
            if not np.isfinite(values).all():
                raise ValueError("原始信号数值超出滤波范围，未生成上传副本。")
            output = np.zeros(b - a, dtype=SAMPLES)
            output["index"] = np.arange(a, b)
            output["value"] = values
            # RSSI is quality metadata with its own cadence. Hold each actual
            # reading only until its next expected reading, then take the bin
            # minimum. A missing expected reading invalidates that interval;
            # ordinary unsampled velocity rows are not RSSI packet loss.
            edges = np.minimum(count, np.arange(a, b + 1) * down // up) - lo
            selected = rows["index"] % expected_stride == 0
            valid = rows["flags"] & 2 != 0
            latest = np.maximum.accumulate(np.where(selected | valid, np.arange(len(rows)), -1))
            held_valid = (latest >= 0) & valid[np.maximum(latest, 0)]
            rssi = np.where(held_valid, rows["rssi"][np.maximum(latest, 0)], np.inf)
            # Every output bin contains at least one input since this only downsamples.
            mins = np.minimum.reduceat(rssi[:edges[-1]], edges[:-1])
            missing_bins = np.add.reduceat((~held_valid)[:edges[-1]], edges[:-1]) > 0
            good = np.isfinite(mins) & ~missing_bins
            output["rssi"] = np.where(good, mins, 0)
            output["flags"] = good.astype(np.uint8) * 2
            # Contaminated filter support is flagged, even when the overrange
            # sample itself falls between output samples.
            bad = np.r_[0, np.cumsum((rows["flags"] & 1 != 0), dtype=np.int64)]
            support = math.ceil(10 * max(up, down) / up)
            centers = np.arange(a, b) * down // up - lo
            affected = bad[np.minimum(len(rows), centers + support + 1)] - bad[np.maximum(0, centers - support)] > 0
            output["flags"] |= affected.astype(np.uint8)
            overrange += int(affected.sum()); missing += int((~good).sum())
            with (temporary / f"chunk-{chunk_count:08d}.bin").open("wb") as stream:
                stream.write(HEADER.pack(MAGIC, target_rate, manifest["sampleOrigin"], written))
                stream.write(output.tobytes())
            written += len(output); chunk_count += 1
        if written != total:
            raise ValueError("上传副本样本数不一致。")
        derived = copy.deepcopy(manifest)
        for key in ("pointCycle", "turntable"):
            if key in derived:
                derived[key] = remap_indices(derived[key], up, down, total)
        derived.update(sampleRate=target_rate, samples=total, chunks=chunk_count,
                       overrangeSamples=overrange, missingRssiSamples=missing, rssiSampleStride=1,
                       rssiSampleRate=target_rate, rssiNotSampledVelocitySamples=0, rssiMissingExpectedSamples=missing)
        derived["sampling"] = {"version": VERSION, "kind": "anti_alias_lowpass", "sourceSampleRate": rate,
                               "sourceSamples": count, "targetSampleRate": target_rate,
                               "sourceFingerprint": fingerprint, "sourceRecordingId": recording_id,
                               "filter": "scipy.resample_poly; Kaiser beta=8.6; zero-phase FIR",
                               "recommendedMaxFrequencyHz": target_rate * .4,
                               "rawColumns": "unavailable in derivative; zero placeholders",
                               "rssiMethod": "minimum of zero-order held RSSI in each time bin; missing expected readings stay missing",
                               "sourceRssiSampleStride": expected_stride,
                               "sourceRssiSampleRate": manifest.get("rssiSampleRate", rate / expected_stride),
                               "sourceQuality": {k: manifest.get(k, 0) for k in ("overrangeSamples", "missingRssiSamples", "unpairedRssiSamples")},
                               "sourceHandoff": manifest.get("pointCycle", {}).get("handoff")}
        if telemetry.exists():
            telemetry_hash = hashlib.sha256()
            with telemetry.open("r", encoding="utf-8") as src, (temporary / telemetry.name).open("wb") as dst:
                for line in src:
                    payload = (json.dumps(remap_indices(json.loads(line), up, down, total), ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                    dst.write(payload); telemetry_hash.update(payload)
            derived["turntable"]["telemetry"]["sha256"] = telemetry_hash.hexdigest()
        if stamps != [(p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in paths]:
            raise ValueError("生成期间原始记录发生变化，请重试。")
        atomic_json(temporary / "manifest.json", derived)
        os.rename(temporary, destination)
        return {"directory": str(destination), "recording": derived}
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
