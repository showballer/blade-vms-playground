"""Analyze separated, stationary blade passes without inventing phase continuity.

The saved raw recording is immutable. All ranges are half-open original velocity
sample indices. A route lap and a station azimuth are not a measured rotor phase.
"""
from __future__ import annotations

import hashlib
import math
import re

import numpy as np

from .analysis import DTYPE
from .storage import HEADER, MAGIC, RECORD, recording_rssi_stride

VERSION = "blade-passes-1.0.0"
MAX_RECORDS = 64
MAX_SAMPLES = 8_000_000  # Per record AND across the selection, before allocation.
MAX_SEGMENTS_PER_RECORD = 64
MAX_SEGMENTS_TOTAL = 128
MAX_FFT_SAMPLES = 262_144
MAX_CURVE_POINTS = 256
MAX_SPECTRUM_POINTS = 512
MIN_SEGMENT_SAMPLES = 64
ID = re.compile(r"[a-f0-9]{32}\Z")
REASONS = {1: "nonfinite_velocity", 2: "overrange", 4: "missing_rssi",
           8: "invalid_rssi", 16: "low_rssi"}


def _number(value, label, low=None, high=None):
    try:
        valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f"{label}必须是有限数字。")
    if low is not None and value < low or high is not None and value > high:
        raise ValueError(f"{label}超出允许范围。")
    return value


def _integer(value, label, low=0, high=MAX_SAMPLES):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{label}必须是范围内的整数。")
    return value


def _text(value, label, maximum=120):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or value != value.strip():
        raise ValueError(f"{label}缺失或无效。")
    return value


def _id(value, label):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError(f"{label}缺失或无效（需 32 位小写编号）。")
    return value


def _parameters(parameters):
    if not isinstance(parameters, dict) or set(parameters) - {"recordingIds", "detrend", "rssiThresholdPercent"}:
        raise ValueError("叶片有效片段分析参数无效。")
    ids = parameters.get("recordingIds")
    if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_RECORDS:
        raise ValueError("请选择 1～64 条采集记录。")
    for recording_id in ids:
        _id(recording_id, "采集记录编号")
    if len(set(ids)) != len(ids):
        raise ValueError("采集记录不能重复。")
    detrend = parameters.get("detrend", "constant")
    if detrend not in ("constant", "linear", "none"):
        raise ValueError("去趋势方式无效。")
    threshold = parameters.get("rssiThresholdPercent")
    if threshold is not None:
        _number(threshold, "RSSI 阈值", 0, 100)
    return {"recordingIds": ids, "detrend": detrend, "rssiThresholdPercent": threshold}


def _identity(manifest):
    meta = manifest.get("pointCycle")
    if not isinstance(meta, dict) or meta.get("mode") != "automatic_stations":
        raise ValueError("记录缺少自动点位点位信息；请同步完整原始记录或导入带点位元数据的文件。")
    identity = {
        "collectionId": _id(meta.get("collectionId"), "叶片采集任务编号"),
        "bladeId": _text(meta.get("bladeId"), "叶片编号", 80),
        "sessionId": _id(meta.get("sessionId"), "本次采集编号"),
        "radialPointId": _text(meta.get("radialPointId"), "径向测点编号", 80),
        "radialPointName": _text(meta.get("radialPointName"), "径向测点名称"),
        "radiusM": _number(meta.get("radiusM"), "测点半径", 0, 1000),
        "azimuthDeg": _number(meta.get("azimuthDeg"), "点位方位", 0, 360),
        "stationId": _text(meta.get("stationId"), "点位编号"),
        "lapIndex": _integer(meta.get("lapIndex"), "点位轮次", 1, 100),
        "stationIndex": _integer(meta.get("stationIndex"), "点位序号", 1, 200),
        "stationCount": _integer(meta.get("stationCount"), "点位数量", 1, 200),
    }
    if identity["radiusM"] <= 0 or identity["azimuthDeg"] >= 360:
        raise ValueError("测点半径或点位方位无效。")
    if identity["stationIndex"] > identity["stationCount"]:
        raise ValueError("点位序号超出当前测点点位数量。")
    if "pointId" in meta and meta["pointId"] != identity["stationId"]:
        raise ValueError("点位编号与点位编号不一致。")
    if "identityVerified" in meta and type(meta["identityVerified"]) is not bool:
        raise ValueError("叶片身份标记无效。")
    if "identitySource" in meta:
        _text(meta["identitySource"], "叶片身份来源", 80)
    return identity, meta


def _range(meta, samples):
    if meta.get("completion") != "confirmed_pass" or meta.get("outcome") != "observed":
        completion = meta.get("completion")
        return None, completion if completion in ("missing_entry", "missing_exit", "signal_gap", "cancelled", "device_error") else "unconfirmed_pass"
    handoff = meta.get("handoff")
    if not isinstance(handoff, dict) or handoff.get("reason") != "blade_left":
        return None, "missing_pass_boundaries"
    try:
        entry = _integer(handoff.get("entrySampleIndex"), "进入起点", high=samples - 1)
        confirmed = _integer(handoff.get("entryConfirmedSampleIndex"), "进入确认末点", high=samples - 1)
        end = _integer(handoff.get("exitSampleIndex"), "离开起点", high=samples - 1)
        exit_confirmed = _integer(handoff.get("exitConfirmedSampleIndex"), "离开确认末点", high=samples - 1)
        if not entry <= confirmed < end <= exit_confirmed:
            raise ValueError("进入离开边界次序无效。")
    except ValueError:
        return None, "invalid_pass_boundaries"
    return (confirmed + 1, end), None


def _raw(store, recording_id, manifest, threshold):
    """Read in bounded chunks, keeping quality flags aligned to original indices."""
    count = _integer(manifest.get("samples"), "原始样本数", 1)
    rate = _number(manifest.get("sampleRate"), "原始采样率", 0)
    origin = _number(manifest.get("sampleOrigin"), "原始时间起点")
    if rate <= 0:
        raise ValueError("原始采样率必须大于零。")
    stride = recording_rssi_stride(manifest)
    values = np.empty(count, dtype=np.float64)
    quality = np.zeros(count, dtype=np.uint8)
    rssi_quality = np.full((count + stride - 1) // stride, 4, dtype=np.uint8)
    digest, velocity_digest, expected = hashlib.sha256(), hashlib.sha256(), 0
    paths = store.chunks(store.directory(recording_id))
    for path in paths:
        if path.suffix == ".part":
            raise ValueError("原始记录包含未关闭分块。")
        with path.open("rb") as stream:
            header = stream.read(HEADER.size)
            if len(header) != HEADER.size:
                raise ValueError("原始分块头不完整。")
            magic, chunk_rate, chunk_origin, start = HEADER.unpack(header)
            if magic != MAGIC or chunk_rate != rate or chunk_origin != origin or start != expected:
                raise ValueError("原始分块时间、采样率或样本起点不一致。")
            available, trailing = divmod(path.stat().st_size - HEADER.size, RECORD.size)
            if trailing or available <= 0 or expected + available > count:
                raise ValueError("原始分块尾部或样本数无效。")
            while available:
                amount = min(65536, available)
                payload = stream.read(amount * RECORD.size)
                if len(payload) != amount * RECORD.size:
                    raise ValueError("原始分块被截断。")
                rows = np.frombuffer(payload, dtype=DTYPE)
                indices = np.arange(expected, expected + amount, dtype=np.uint64)
                if not np.array_equal(rows["index"], indices) or np.any(rows["flags"] & np.uint8(252)):
                    raise ValueError("原始样本序号或标记无效。")
                present = (rows["flags"] & 2) != 0
                scheduled = indices % stride == 0
                if np.any(present & ~scheduled):
                    raise ValueError("RSSI 原始采样位置不符合采样间隔。")
                lo, hi = expected, expected + amount
                values[lo:hi] = rows["value"]
                quality[lo:hi] = (~np.isfinite(rows["value"])).astype(np.uint8) | ((rows["flags"] & 1) << 1)
                slots = (indices[scheduled] // stride).astype(np.int64)
                signal_values, signal_present = rows["rssi"][scheduled], present[scheduled]
                invalid = ~np.isfinite(signal_values) | (signal_values < 0) | (signal_values > 100)
                flags = np.where(~signal_present, 4, np.where(invalid, 8, 0)).astype(np.uint8)
                if threshold is not None:
                    flags |= np.where(signal_present & ~invalid & (signal_values < threshold), 16, 0).astype(np.uint8)
                rssi_quality[slots] = flags
                digest.update(payload)
                velocity_digest.update(rows["value"].tobytes())
                expected = hi
                available -= amount
            if stream.read(1):
                raise ValueError("原始分块在读取期间发生变化。")
    if expected != count:
        raise ValueError("原始数据缺失，不能构造有效片段。")
    # One real RSSI observation governs its velocity-sample interval; unsampled
    # positions are never mislabelled as a missing independent RSSI observation.
    for start in range(0, count, 65536):
        end = min(start + 65536, count)
        quality[start:end] |= rssi_quality[np.arange(start, end) // stride]
    return values, quality, {"rawSha256": digest.hexdigest(), "velocitySha256": velocity_digest.hexdigest(),
                            "originalSampleOrigin": manifest.get("sourceSampleOrigin", origin),
                            "storeSampleOrigin": origin,
                            "timeReference": "original acquisition host time; not a common phase reference",
                            "timestampBasis": manifest.get("timestampBasis"),
                            "rssiSampleStride": stride, "rssiSampleRate": rate / stride}


def _preprocess(values, detrend):
    result = values.copy()
    if detrend != "none":
        result -= np.mean(result)
    if detrend == "linear":
        count, middle = len(result), (len(result) - 1) / 2
        # Avoid a full second time vector and large least-squares design matrix.
        numerator = 0.0
        for start in range(0, count, 65536):
            end = min(count, start + 65536)
            numerator += float(np.dot(np.arange(start, end) - middle, result[start:end]))
        slope = numerator / (count * (count * count - 1) / 12)
        for start in range(0, count, 65536):
            end = min(count, start + 65536)
            result[start:end] -= (np.arange(start, end) - middle) * slope
    if not np.isfinite(result).all():
        raise ValueError("原始数值超出可分析范围。")
    return result


def _statistics(values):
    energy = float(np.dot(values, values))
    low, high = float(np.min(values)), float(np.max(values))
    if not all(math.isfinite(item) for item in (energy, low, high, high - low)):
        raise ValueError("原始数值超出可分析范围。")
    return {"samples": len(values), "energy": energy, "low": low, "high": high}


def _merge_statistics(items):
    try:
        energy = math.fsum(item["energy"] for item in items)
    except OverflowError as error:
        raise ValueError("汇总数值超出可分析范围。") from error
    return {"samples": sum(item["samples"] for item in items), "energy": energy,
            "low": min(item["low"] for item in items), "high": max(item["high"] for item in items)}


def _metrics(stats):
    result = {"rmsVelocityMps": math.sqrt(stats["energy"] / stats["samples"]),
              "peakVelocityMps": max(abs(stats["low"]), abs(stats["high"])),
              "peakToPeakVelocityMps": stats["high"] - stats["low"]}
    if not all(math.isfinite(value) for value in result.values()):
        raise ValueError("汇总数值超出可分析范围。")
    return result


def _time_curve(values, start, rate):
    if len(values) <= MAX_CURVE_POINTS:
        indices = np.arange(len(values))
    else:
        bucket = math.ceil(len(values) / (MAX_CURVE_POINTS // 2))
        selected = []
        for lo in range(0, len(values), bucket):
            hi = min(lo + bucket, len(values))
            selected.extend(sorted({lo + int(np.argmin(values[lo:hi])), lo + int(np.argmax(values[lo:hi]))}))
        indices = np.asarray(selected)
    original = indices + start
    return {"sampleIndices": original.tolist(), "seconds": (original / rate).tolist(),
            "values": values[indices].tolist(), "representation": "original-index-minmax"}


def _plot_curve(values, start, rate):
    """Create a bounded display preview with anomalous-step buckets blanked."""
    differences = np.abs(np.diff(values))
    typical = float(np.percentile(differences, 99))
    threshold = max(50 * typical, 1e-6)
    bad_edges = differences > threshold
    bad_samples = np.zeros(len(values), dtype=bool)
    bad_samples[:-1] |= bad_edges
    bad_samples[1:] |= bad_edges
    bucket_size = max(1, math.ceil(len(values) / (MAX_CURVE_POINTS // 2)))
    indices, plotted = [], []
    hidden_samples = hidden_buckets = 0
    for lo in range(0, len(values), bucket_size):
        hi = min(len(values), lo + bucket_size)
        if bad_samples[lo:hi].any():
            hidden_samples += hi - lo
            hidden_buckets += 1
            indices.append(lo + (hi - lo - 1) // 2)
            plotted.append(None)
            continue
        section = values[lo:hi]
        selected = sorted({lo + int(np.argmin(section)), lo + int(np.argmax(section))})
        indices.extend(selected)
        plotted.extend(float(values[index]) for index in selected)
    original = np.asarray(indices, dtype=np.int64) + start
    return ({"sampleIndices": original.tolist(), "seconds": (original / rate).tolist(),
             "values": plotted, "representation": "minmax-with-anomaly-gaps"},
            {"method": "step-over-50-times-p99", "thresholdMps": threshold,
             "flaggedSteps": int(np.count_nonzero(bad_edges)), "hiddenSamples": hidden_samples,
             "hiddenTimeBuckets": hidden_buckets, "plottedSamples": len(values) - hidden_samples,
             "effect": "plot-only; source-samples-metrics-and-spectra-unchanged"})


def _spectrum(values, start, rate):
    size = min(len(values), MAX_FFT_SAMPLES)
    offset = (len(values) - size) // 2
    selected = values[offset:offset + size]
    window = np.hanning(size)
    amplitude = np.abs(np.fft.rfft(selected * window)) / float(window.sum())
    amplitude[1:-1 if size % 2 == 0 else None] *= 2
    if not np.isfinite(amplitude).all():
        raise ValueError("频谱计算数值超出范围。")
    indices = np.arange(len(amplitude))
    if len(indices) > MAX_SPECTRUM_POINTS:
        bucket = math.ceil(len(indices) / MAX_SPECTRUM_POINTS)
        indices = np.asarray([lo + int(np.argmax(amplitude[lo:lo + bucket]))
                              for lo in range(0, len(amplitude), bucket)])
    return {"frequencies": (indices * rate / size).tolist(), "amplitudes": amplitude[indices].tolist(),
            "frequencySpacingHz": rate / size, "start": start + offset, "end": start + offset + size,
            "samples": size, "window": "hann", "representation": "peak-buckets",
            "boundedWindow": size != len(values)}


def analyze_blade_passes(store, parameters, *, segment_consumer=None) -> dict:
    config = _parameters(parameters)
    manifests, definitions, stations, original_ids, pass_ids = [], {}, {}, set(), set()
    collection, blade, total = None, None, 0
    for recording_id in config["recordingIds"]:
        manifest = store._read_manifest(store.directory(recording_id))
        identity, meta = _identity(manifest)
        if "name" in manifest:
            _text(manifest["name"], "记录名称", 180)
        if "timestampBasis" in manifest:
            _text(manifest["timestampBasis"], "时间依据", 1000)
        if collection is None:
            collection, blade = identity["collectionId"], identity["bladeId"]
        elif (collection, blade) != (identity["collectionId"], identity["bladeId"]):
            raise ValueError("请选择同一采集任务、同一叶片的数据，不能混合其他叶片或任务。")
        point_key = identity["radialPointId"]
        definition = (identity["radialPointName"], identity["radiusM"])
        if point_key in definitions and definitions[point_key] != definition:
            raise ValueError("同一径向测点编号对应了不同名称或半径，请先校正点位归属。")
        definitions[point_key] = definition
        source_metadata = manifest.get("sourceMetadata")
        original_id = manifest.get("sourceRecordingId") or (source_metadata.get("recordingId") if isinstance(source_metadata, dict) else None)
        if original_id is None and not manifest.get("cloudCaptureId"):
            original_id = recording_id
        if original_id is not None:
            _id(original_id, "原始采集记录编号")
            if original_id in original_ids:
                raise ValueError("所选数据包含同一原始记录的同步或导入副本，请去重后再分析。")
            original_ids.add(original_id)
        for key in ("sampleOrigin", "sourceSampleOrigin"):
            if manifest.get(key) is not None:
                _number(manifest[key], "记录时间起点")
        if manifest.get("sampleRate") is not None and _number(manifest["sampleRate"], "原始采样率", 0) <= 0:
            raise ValueError("原始采样率必须大于零。")
        station_key = identity["sessionId"], identity["stationId"]
        station_definition = point_key, identity["radiusM"], identity["azimuthDeg"], identity["stationIndex"], identity["stationCount"]
        if station_key in stations and stations[station_key] != station_definition:
            raise ValueError("同一采集批次的点位身份不一致。")
        stations[station_key] = station_definition
        pass_key = identity["sessionId"], identity["radialPointId"], identity["stationIndex"], identity["lapIndex"]
        if pass_key in pass_ids:
            raise ValueError("同一采集批次、轮次与点位出现重复记录，请去重后再分析。")
        pass_ids.add(pass_key)
        total += _integer(manifest.get("samples"), "原始样本数", 0)
        if total > MAX_SAMPLES:
            raise ValueError("一次分析合计最多 800 万个原始样本，请减少所选记录。")
        manifests.append((recording_id, manifest, identity, meta))

    sources, aggregates, segment_count = [], {}, 0
    for recording_id, manifest, identity, meta in manifests:
        original_metadata = manifest.get("sourceMetadata")
        original_metadata = original_metadata if isinstance(original_metadata, dict) else {}
        simulation = (manifest.get("source") == "simulation" or original_metadata.get("source") == "simulation" or
                      bool(manifest.get("simulation")) or bool(original_metadata.get("simulation")))
        source_kind = "simulation" if simulation else manifest.get("source", "offline")
        if source_kind not in ("simulation", "polytec_ivs500", "device", "measured", "offline"):
            source_kind = "offline"
        source = {"recordingId": recording_id, "name": manifest.get("name", ""), **identity,
                  "source": source_kind, "simulation": simulation,
                  "sampleRate": manifest.get("sampleRate"), "sampleOrigin": manifest.get("sourceSampleOrigin", manifest.get("sampleOrigin")),
                  "status": "excluded", "candidateRange": None, "validRanges": [], "exclusions": [],
                  "validSamples": 0, "validSeconds": 0, "metrics": None, "segments": [],
                  "provenance": {"selection": "confirmed-entry-to-exit-start", "rangeConvention": "[start,end)",
                                 "detrend": config["detrend"], "identitySource": meta.get("identitySource"),
                                 "identityVerified": meta.get("identityVerified", False),
                                 "source": source_kind,
                                 "sourceFile": str(manifest.get("sourceFile") or "")[:255],
                                 "sourceRecordingId": manifest.get("sourceRecordingId") or original_metadata.get("recordingId") or
                                                      (None if manifest.get("cloudCaptureId") else recording_id),
                                 "coverageKind": "sparse_station_passes"}}
        sources.append(source)
        if manifest.get("status") != "complete":
            source["reason"] = "recording_not_complete"
            continue
        if manifest.get("unit") != "m/s" or manifest.get("format") != "BLADEV01/<QidifB":
            raise ValueError("有效片段分析仅接受完整原始速度记录（m/s）。")
        candidate, reason = _range(meta, manifest["samples"])
        if candidate is None:
            source["reason"] = reason
            continue
        lo, hi = candidate
        source["candidateRange"] = {"start": lo, "end": hi}
        values, quality, provenance = _raw(store, recording_id, manifest, config["rssiThresholdPercent"])
        source["provenance"].update(provenance)
        source["exclusions"] = [{"reason": "outside_confirmed_pass", "samples": len(values) - (hi - lo)}]
        for bit, reason in REASONS.items():
            count = int(np.count_nonzero(quality[lo:hi] & bit))
            if count:
                source["exclusions"].append({"reason": reason, "samples": count})
        good = quality[lo:hi] == 0
        edges = np.diff(np.r_[False, good, False].astype(np.int8))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        lengths = ends - starts
        usable = lengths >= MIN_SEGMENT_SAMPLES
        short = int(lengths[~usable].sum(dtype=np.int64))
        if short:
            source["exclusions"].append({"reason": "segment_shorter_than_64_samples", "samples": short})
        count = int(np.count_nonzero(usable))
        if count > MAX_SEGMENTS_PER_RECORD or segment_count + count > MAX_SEGMENTS_TOTAL:
            raise ValueError("有效片段过多（单记录最多 64 段、合计 128 段），请减少记录或重新采集。")
        # Filter in compact arrays before creating any Python tuples. A noisy
        # eight-million-sample record can contain millions of unusable islands;
        # only the bounded, accepted ranges may become Python objects.
        ranges = list(zip((starts[usable] + lo).tolist(), (ends[usable] + lo).tolist()))
        del good, edges, starts, ends, lengths, usable
        segment_count += len(ranges)
        if not ranges:
            source["reason"] = "no_usable_segment"
            continue
        stats = []
        rate = manifest["sampleRate"]
        for start, end in ranges:
            processed = _preprocess(values[start:end], config["detrend"])
            plot_data = None
            if segment_consumer is not None:
                plot_data = segment_consumer(source, start, end, values[start:end], processed)
            item = _statistics(processed)
            stats.append(item)
            source["validRanges"].append({"start": start, "end": end, "samples": end - start})
            segment = {"start": start, "end": end, "samples": end - start,
                                       "durationSeconds": (end - start) / rate, "metrics": _metrics(item),
                                       "timeDomain": _time_curve(processed, start, rate),
                                       "spectrum": _spectrum(processed, start, rate)}
            plot_curve, plot_filter = _plot_curve(processed, start, rate)
            segment["plotTimeDomain"] = plot_curve
            segment["plotFilter"] = plot_filter
            if isinstance(plot_data, dict) and "plotTimeDomain" in plot_data:
                segment["plotTimeDomain"] = plot_data["plotTimeDomain"]
                segment["plotFilter"] = plot_data["plotFilter"]
            source["segments"].append(segment)
        merged = _merge_statistics(stats)
        source.update(status="included", validSamples=merged["samples"],
                      validSeconds=merged["samples"] / rate, metrics=_metrics(merged))
        key = identity["radialPointId"], identity["azimuthDeg"]
        group = aggregates.setdefault(key, {"statistics": [], "recordingIds": [], "validSeconds": 0,
                                            "energySeconds": []})
        group["statistics"].append(merged)
        group["recordingIds"].append(recording_id)
        group["validSeconds"] += source["validSeconds"]
        group["energySeconds"].append(merged["energy"] / rate)

    points, distributions = [], {}
    for radial_id, (name, radius) in sorted(definitions.items(), key=lambda item: item[1][1]):
        point = {"radialPointId": radial_id, "radialPointName": name, "radiusM": radius, "stations": []}
        for (point_id, azimuth), group in sorted(aggregates.items(), key=lambda item: item[0][1]):
            if point_id != radial_id:
                continue
            stats = _merge_statistics(group["statistics"])
            metrics = _metrics(stats)
            # Cross-record sampling rates can differ. Weight physical signal
            # energy by time, so a higher-rate batch does not count more often.
            metrics["rmsVelocityMps"] = math.sqrt(math.fsum(group["energySeconds"]) / group["validSeconds"])
            point["stations"].append({"azimuthDeg": azimuth, "recordingIds": group["recordingIds"],
                                      "validSamples": stats["samples"], "validSeconds": group["validSeconds"], "metrics": metrics})
            distributions.setdefault(azimuth, []).append({"radialPointId": radial_id, "radialPointName": name,
                                                         "radiusM": radius, "value": metrics["rmsVelocityMps"],
                                                         "validSamples": stats["samples"], "recordingIds": group["recordingIds"]})
        points.append(point)
    included = sum(source["status"] == "included" for source in sources)
    has_simulation = any(source["simulation"] for source in sources)
    return {"algorithmVersion": VERSION, "parameters": config, "collectionId": collection, "bladeId": blade,
            "phaseAvailable": False, "hasSimulation": has_simulation,
            "modeShapeUnavailableReason": "分次采集缺少共同相位参考；目前仅提供同点位的速度幅值分布，不能形成带相位的真实振型或模态匹配。",
            "coverage": {"selectedRecords": len(sources), "includedRecords": included,
                         "excludedRecords": len(sources) - included, "rawSamples": total,
                         "validSamples": sum(source["validSamples"] for source in sources),
                         "validSeconds": sum(source["validSeconds"] for source in sources), "segmentCount": segment_count,
                         "measuredRadialLocations": len({point["radiusM"] for point in points if point["stations"]})},
            "sources": sources, "points": points,
            "amplitudeDistributions": [{"azimuthDeg": azimuth, "metric": "rmsVelocityMps", "unit": "m/s", "points": values,
                                        "distinctRadiusCount": len({item["radiusM"] for item in values})}
                                       for azimuth, values in sorted(distributions.items())],
            "warnings": ["有效段按进入确认后至离开开始筛选；原始记录完整保留，间隙未拼接、未补零。",
                         "RMS、峰值和峰峰值均为所选去趋势处理后的速度指标（m/s），不是位移振幅。",
                         "同测点、同点位的跨批次 RMS 按有效时长加权，采样率较高的记录不会获得额外权重。",
                         "RSSI 阈值只作用于真实 RSSI 采样对应的区间；默认不另设绝对强度阈值。",
                         "各连续段独立计算频谱；长段频谱使用中部最多 262144 点，实际频率分辨率由该窗口时长决定。",
                         "叶片身份由操作人员指定，点位圈次与方位不是实测叶轮相位；不同方位不合成同一条空间曲线。",
                         "当前指标为激光视线方向速度；即使同一点位，姿态投影与跨批次工况变化也尚未补偿。"] +
                        (["所选记录含模拟数据；相关结果不能作为真实设备测量结论。"] if has_simulation else [])}
