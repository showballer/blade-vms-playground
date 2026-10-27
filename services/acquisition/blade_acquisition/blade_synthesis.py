"""Segment-aware experimental reconstruction from non-synchronous LDV passes.

Compressed-time waveforms are display-only and keep explicit segment gaps.
All quantitative spectra are computed independently within continuous segments.
Unknown spatial phase and signs stay unknown.
"""
from __future__ import annotations

import math
from fractions import Fraction

import numpy as np
from scipy import signal

from .blade_passes import MAX_FFT_SAMPLES, _number, _plot_curve, _time_curve, analyze_blade_passes

VERSION = "blade-synthesis-1.3.0"


def _linear_windows(values):
    # Welch supplies overlapping windows along the last axis.
    centered = values - np.mean(values, axis=-1, keepdims=True)
    time = np.arange(values.shape[-1], dtype=np.float64) - (values.shape[-1] - 1) / 2
    slope = np.sum(centered * time, axis=-1, keepdims=True) / np.sum(time * time)
    return centered - slope * time


def _jump_audit(values, start):
    differences = np.abs(np.diff(values))
    typical = float(np.percentile(differences, 99))
    threshold = max(50 * typical, 1e-6)
    indices = np.flatnonzero(differences > threshold)
    return {"method": "step-over-50-times-p99", "count": len(indices),
            "maxStepMps": float(np.max(differences)), "thresholdMps": threshold,
            "firstOriginalSampleIndices": (indices[:8] + start + 1).tolist(),
            "action": "flag_only_no_automatic_removal"}


def _config(parameters):
    if not isinstance(parameters, dict):
        raise ValueError("片段合成参数无效。")
    base = {key: value for key, value in parameters.items() if key != "synthesis"}
    options = parameters.get("synthesis", {})
    if not isinstance(options, dict) or set(options) - {"minHz", "maxHz", "minCycles", "maxCandidates"}:
        raise ValueError("振型候选参数无效。")
    result = {"minHz": options.get("minHz", 20), "maxHz": options.get("maxHz", 2000),
              "minCycles": options.get("minCycles", 3), "maxCandidates": options.get("maxCandidates", 5)}
    _number(result["minHz"], "最低频率", .1, 100000)
    _number(result["maxHz"], "最高频率", .1, 100000)
    _number(result["minCycles"], "最少周期数", 3, 20)
    if result["minHz"] >= result["maxHz"]:
        raise ValueError("最高频率必须大于最低频率。")
    if type(result["maxCandidates"]) is not int or not 1 <= result["maxCandidates"] <= 8:
        raise ValueError("候选数量必须是 1～8 的整数。")
    return base, result


def reconstruct_blade_passes(store, parameters, *, segment_sink=None):
    """Reuse validated extraction; optionally stream full-resolution data to disk.

    segment_sink receives (source, mapping, raw, processed). The arrays are valid
    only during the callback. Returned JSON contains bounded previews, not raw data.
    """
    base, config = _config(parameters)
    merged, spectra, stitched_parts = {}, [], {}

    def consume(source, start, end, raw, processed):
        point_id, rate = source["radialPointId"], source["sampleRate"]
        point = merged.setdefault(point_id, {"radialPointId": point_id,
            "radialPointName": source["radialPointName"], "radiusM": source["radiusM"],
            "samples": 0, "durationSeconds": 0., "segments": []})
        offset = point["durationSeconds"]
        mapping = {"segmentId": f"{source['recordingId']}:{start}:{end}",
                   "recordingId": source["recordingId"],
                   "sourceRecordingId": source["provenance"]["sourceRecordingId"],
                   "azimuthDeg": source["azimuthDeg"], "sessionId": source["sessionId"],
                   "originalStart": start, "originalEnd": end, "sampleRate": rate,
                   "sourceSamples": end - start, "analysisSamples": len(processed),
                   "mergedStart": point["samples"], "mergedEnd": point["samples"] + len(processed),
                   "compressedStartSeconds": offset, "compressedEndSeconds": offset + len(processed) / rate,
                   "originalStartSeconds": start / source["originalSampleRate"],
                   "originalEndSeconds": end / source["originalSampleRate"],
                   "rawSha256": source["provenance"]["rawSha256"],
                   "discontinuityAudit": _jump_audit(raw, start),
                   "timeDomain": _time_curve(processed, start, rate, source_rate=source["originalSampleRate"])}
        stitched_parts.setdefault(point_id, []).append((mapping, processed.copy(), rate))
        point["samples"] += len(processed)
        point["durationSeconds"] += len(processed) / rate
        point["segments"].append(mapping)
        plot_curve, plot_filter = _plot_curve(processed, start, rate, source_rate=source["originalSampleRate"])
        mapping["plotTimeDomain"] = plot_curve
        mapping["plotFilter"] = plot_filter
        if segment_sink is not None:
            segment_sink(source, mapping, raw, processed)
        size = min(len(processed), MAX_FFT_SAMPLES)
        frequencies, psd = signal.welch(processed, fs=rate, window="hann", nperseg=size,
            noverlap=size // 2, detrend=_linear_windows, scaling="density")
        if not np.isfinite(psd).all():
            raise ValueError("片段频谱数值超出可分析范围。")
        keep = frequencies <= config["maxHz"] + 2 * rate / size
        spectra.append({"point": point_id, "angle": source["azimuthDeg"],
                        "mapping": mapping, "frequencies": frequencies[keep], "psd": psd[keep],
                        "spacing": rate / size, "windowSeconds": size / rate,
                        "duration": len(processed) / rate, "nyquist": rate / 2})
        return {"plotTimeDomain": plot_curve, "plotFilter": plot_filter}

    result = analyze_blade_passes(store, base, segment_consumer=consume)
    points = sorted(merged.values(), key=lambda point: point["radiusM"])
    for point in points:
        parts = stitched_parts[point["radialPointId"]]
        # Resample to the lowest source rate so every joined sample has one
        # well-defined time step and no higher-rate segment is aliased.
        rate = min(part_rate for _, _, part_rate in parts)
        merged_sample_cursor = 0
        preview_seconds, preview_values = [], []
        for mapping, values, part_rate in parts:
            if part_rate != rate:
                ratio = Fraction(str(rate)) / Fraction(str(part_rate))
                values = signal.resample_poly(values, ratio.numerator, ratio.denominator)
            values = np.asarray(values, dtype=np.float64)
            mapping["mergedStart"] = merged_sample_cursor
            mapping["mergedEnd"] = merged_sample_cursor + len(values)
            mapping["analysisSamples"] = len(values)
            mapping["mergedSampleRate"] = rate
            mapping["compressedStartSeconds"] = merged_sample_cursor / rate
            mapping["compressedEndSeconds"] = (merged_sample_cursor + len(values)) / rate
            mapping["stitchOffsetMps"] = 0.
            if preview_seconds:
                preview_seconds.append(merged_sample_cursor / rate)
                preview_values.append(None)
            curve = _time_curve(values, 0, rate)
            preview_seconds.extend(merged_sample_cursor / rate + second for second in curve["seconds"])
            preview_values.extend(curve["values"])
            merged_sample_cursor += len(values)
        point["samples"] = merged_sample_cursor
        point["durationSeconds"] = merged_sample_cursor / rate
        point["independentSpectrum"] = _independent_spectrum(point, spectra, config)
        point["stitchInfo"] = {
            "segments": len(parts), "sampleRate": rate,
            "resampledSegments": sum(part_rate != rate for _, _, part_rate in parts),
            "originalSamples": merged_sample_cursor,
            "method": "compressed-time-display-with-gaps; no offset or phase correction",
        }
        point["stitchedWaveform"] = {"seconds": preview_seconds, "valuesMps": preview_values,
                                      "representation": "compressed-valid-time-with-segment-gaps"}
    synthesis = _candidates(points, spectra, config)
    synthesis.update(algorithmVersion=VERSION, parameters=config, mergedPoints=points,
        mergePlan={"pointMerge": "same radial point across selected azimuths",
                   "bladeComposition": "selected radial points ordered by radius",
                   "sourceSegments": sum(len(point["segments"]) for point in points)},
        coordinate="compressed-valid-time", measuredPhaseAvailable=False,
        assumptions=["暂按同一叶片处理；各径向点及圆周角度为分次采集。",
            "假定所选片段工况与激励可比较，激光视线投影可比较；尚未进行几何投影补偿。",
            "同一点位重复记录按时长汇总，各圆周点位等权汇总，避免重试次数主导空间曲线。",
            "合并轴仅压缩无效时间，不恢复跨片段真实时间；谱与频带能量均在各连续段独立计算。",
            "合成谱的每个窗口独立去线性趋势；展示波形预处理由用户所选 detrend 决定。",
            "候选曲线为共同频带的无符号响应幅值；没有实测空间相位，不确定节点符号。",
            "位移频带 RMS 由各频率速度 PSD 除以 (2πf)² 积分得到；合成周期采用同相假设，仅供预览。"],
        damageAssessmentAvailable=False, diagnosticOnly=result["diagnosticOnly"],
        hasDiagnostic=result["hasDiagnostic"], validMeasurement=result["validMeasurement"])
    jumps = sum(segment["discontinuityAudit"]["count"] for point in points for segment in point["segments"])
    synthesis["qualityWarnings"] = ([f"确认经过范围内仍检测到 {jumps} 个异常大单步变化（超过段内差分 P99 的 50 倍）；已标记原始位置，未自动删除。应结合回波和实物事件检查后再用于振型解释。"] if jumps else [])
    result["warnings"] = [
        "有效段按进入确认后至离开开始筛选；原始记录完整保留，合并预览另提供可追溯的压缩有效时间坐标。" if warning.startswith("有效段按进入确认后") else
        "叶片身份由操作人员指定，点位圈次与方位不是实测叶轮相位；跨角度空间响应按投影与工况可比较的实验假设合成。" if warning.startswith("叶片身份由操作人员指定") else warning
        for warning in result["warnings"]]
    result["synthesis"] = synthesis
    return result


def _independent_spectrum(point, spectra, config):
    """Average independent PSDs; no FFT ever spans a discarded interval.

    Repeated segments are weighted by duration within each angle, followed by
    equal angle weights. Resolution is limited by the observed source windows.
    """
    selected = [item for item in spectra if item["point"] == point["radialPointId"]]
    angles = {item["angle"] for item in selected}
    spacing = max(min(item["spacing"] for item in selected if item["angle"] == angle) for angle in angles)
    high = min(config["maxHz"], min(item["nyquist"] for item in selected))
    step = max(spacing, high / 8192)
    grid = np.arange(0., high + step * .01, step)
    psd, counts = _stack(selected, grid, config)[point["radialPointId"]]
    available = counts > 0
    return {"frequencies": grid[available].tolist(), "psdMps2PerHz": psd[available].tolist(),
            "stationCounts": counts[available].astype(int).tolist(),
            "frequencySpacingHz": step, "sourceFrequencySpacingsHz": sorted({item["spacing"] for item in selected}),
            "method": "independent-segment-welch", "segmentCount": len(selected),
            "unit": "(m/s)^2/Hz", "minCycles": config["minCycles"],
            "weighting": "duration-within-angle; equal-observed-angles"}


def _stack(spectra, grid, config):
    """Time-weight repeated passes, then equally weight the observed stations."""
    stations = {}
    for item in spectra:
        usable = ((grid * item["windowSeconds"] >= config["minCycles"]) &
                  (grid <= item["nyquist"]))
        values = np.interp(grid, item["frequencies"], item["psd"], left=0., right=0.)
        key = item["point"], item["angle"]
        energy, weight = stations.setdefault(key, (np.zeros_like(grid), np.zeros_like(grid)))
        energy += values * usable * item["duration"]
        weight += usable * item["duration"]
    points = {}
    for (point_id, _), (energy, weight) in stations.items():
        total, count = points.setdefault(point_id, (np.zeros_like(grid), np.zeros_like(grid)))
        total += np.divide(energy, weight, out=np.zeros_like(grid), where=weight > 0)
        count += weight > 0
    return {key: (np.divide(total, count, out=np.zeros_like(grid), where=count > 0), count)
            for key, (total, count) in points.items()}


def _band_point(point, spectra, frequency, half_width, config):
    stations = {}
    contributors = []
    for item in spectra:
        if item["point"] != point["radialPointId"]:
            continue
        # The whole band must be resolved by this original continuous window.
        if (frequency - half_width) * item["windowSeconds"] < config["minCycles"] or frequency + half_width > item["nyquist"]:
            continue
        f, psd, df = item["frequencies"], item["psd"], item["spacing"]
        widths = np.maximum(0., np.minimum(f + df / 2, frequency + half_width) -
                            np.maximum(f - df / 2, frequency - half_width))
        velocity_power = float(np.dot(psd, widths))
        displacement_psd = np.zeros_like(psd)
        np.divide(psd, (2 * np.pi * f) ** 2, out=displacement_psd, where=f > 0)
        displacement_power = float(np.dot(displacement_psd, widths))
        nearby = (f >= max(config["minHz"], frequency - 8 * half_width)) & (f <= frequency + 8 * half_width)
        in_band = widths > 0
        peak = float(np.max(psd[in_band])) if in_band.any() else 0.
        floor = float(np.median(psd[nearby])) if nearby.any() else peak
        peak_contrast = peak / max(floor, np.finfo(float).tiny)
        group = stations.setdefault(item["angle"], {"v": 0., "d": 0., "seconds": 0., "contrast": []})
        group["v"] += velocity_power * item["duration"]
        group["d"] += displacement_power * item["duration"]
        group["seconds"] += item["duration"]
        group["contrast"].append(peak_contrast)
        contributors.append({"segmentId": item["mapping"]["segmentId"], "azimuthDeg": item["angle"],
                             "windowSeconds": item["windowSeconds"], "frequencySpacingHz": df,
                             "cycles": frequency * item["windowSeconds"]})
    if not stations:
        return None
    station_values = [{"azimuthDeg": angle, "velocityRmsMps": math.sqrt(value["v"] / value["seconds"]),
                       "displacementRmsM": math.sqrt(value["d"] / value["seconds"]),
                       "validSeconds": value["seconds"]}
                      for angle, value in sorted(stations.items())]
    v = math.sqrt(math.fsum(value["velocityRmsMps"] ** 2 for value in station_values) / len(station_values))
    d = math.sqrt(math.fsum(value["displacementRmsM"] ** 2 for value in station_values) / len(station_values))
    positive = [value["displacementRmsM"] for value in station_values if value["displacementRmsM"] > 0]
    return {"radialPointId": point["radialPointId"], "radialPointName": point["radialPointName"],
            "radiusM": point["radiusM"], "velocityRmsMps": v, "displacementRmsM": d,
            "stationCount": len(stations), "stationAmplitudeRatio": max(positive) / min(positive) if positive else None,
            "peakContrast": max(max(value["contrast"]) for value in stations.values()),
            "stations": station_values, "contributors": contributors}


def _candidates(points, spectra, config):
    empty = {"status": "insufficient_evidence", "candidates": [], "bandResponses": [], "spectrum": None,
             "reason": "至少需要两个不同半径的有效测点及可解析的共同频带。"}
    if len({point["radiusM"] for point in points}) < 2 or not spectra:
        return empty
    # A shared grid no finer than the worst point's longest actual FFT window.
    spacing = max(min(item["spacing"] for item in spectra if item["point"] == point["radialPointId"]) for point in points)
    high = min(config["maxHz"], min(max(item["nyquist"] for item in spectra if item["point"] == point["radialPointId"]) for point in points))
    low = max(config["minHz"], config["minCycles"] * spacing + 1.5 * spacing)
    grid_limit = min(4096, max(128, 65536 // len(points)))
    step = max(spacing, (high - low) / grid_limit)
    grid = np.arange(math.ceil(low / step) * step, high + step * .01, step)
    if len(grid) < 5:
        return empty
    stacked = _stack(spectra, grid, config)
    psds = np.asarray([stacked[point["radialPointId"]][0] for point in points])
    floor = np.median(psds, axis=1)
    scales = np.maximum(floor, np.finfo(float).tiny)
    score = np.exp(np.mean(np.log1p(np.minimum(psds / scales[:, None], 1e12)), axis=0)) - 1
    peaks, _ = signal.find_peaks(score, prominence=max(.5, float(np.median(score)) * .5), distance=3)
    candidates = []
    for index in sorted(peaks.tolist(), key=lambda index: score[index], reverse=True):
        frequency, width = float(grid[index]), 1.5 * step
        if any(abs(frequency - item["frequencyHz"]) < 3 * step for item in candidates):
            continue
        # A decaying broadband spectrum or window-leakage ripple is not a
        # shared resonance. Require a local excess in EVERY stacked point.
        side = (np.abs(grid - frequency) > 2 * width) & (np.abs(grid - frequency) <= 8 * width)
        band = np.abs(grid - frequency) <= width
        if (frequency - 8 * width < low or frequency + 8 * width > high or
                np.count_nonzero(side) < 8 or
                np.any(np.max(psds[:, band], axis=1) < 3 * np.maximum(np.median(psds[:, side], axis=1), np.finfo(float).tiny))):
            continue
        spatial = [_band_point(point, spectra, frequency, width, config) for point in points]
        if any(point is None or point["peakContrast"] < 3 for point in spatial):
            continue
        maximum = max(point["displacementRmsM"] for point in spatial)
        if maximum <= 0:
            continue
        for point in spatial:
            point["normalizedAmplitude"] = point["displacementRmsM"] / maximum
            point["spatialPhaseDeg"] = None
        warnings = ["这是无符号频带响应候选，不能仅凭此确认为固有模态或判断损伤。"]
        if len(spatial) == 2:
            warnings.append("当前仅有两个径向测点，空间曲线约束较弱；建议补充第三个及以上测点。")
        if any(point["stationCount"] < 4 for point in spatial):
            warnings.append("部分测点的短角度片段不足三个周期，未计入此频带；角度覆盖不完整。")
        if any((point["stationAmplitudeRatio"] or 1) > 3 for point in spatial):
            warnings.append("同一测点不同角度幅值差异超过三倍，可能存在投影、激励或回波差异。")
        phase = np.linspace(0, 2 * np.pi, 65)
        candidates.append({"frequencyHz": frequency, "bandHz": [frequency - width, frequency + width],
            "frequencyGridHz": step, "consensusScore": float(score[index]),
            "kind": "unsigned_band_response_candidate", "points": spatial,
            "phaseAssumption": "in_phase_for_preview_only", "warnings": warnings,
            "cyclePreview": {"phaseRadians": phase.tolist(),
                "normalizedDisplacement": [[point["normalizedAmplitude"] * float(np.sin(value)) for value in phase] for point in spatial]}})
        if len(candidates) >= config["maxCandidates"]:
            break
    bands = []
    if not candidates:
        left = float(config["minHz"])
        while left < high and len(bands) < config["maxCandidates"]:
            right = min(left * 2, high)
            frequency, width = (left + right) / 2, (right - left) / 2
            spatial = [_band_point(point, spectra, frequency, width, config) for point in points]
            if all(point is not None for point in spatial):
                maximum = max(point["displacementRmsM"] for point in spatial)
                if maximum > 0:
                    for point in spatial:
                        point["normalizedAmplitude"] = point["displacementRmsM"] / maximum
                        point["spatialPhaseDeg"] = None
                    bands.append({"frequencyHz": frequency, "bandHz": [left, right], "frequencyGridHz": step,
                        "kind": "exploratory_band_response", "points": spatial,
                        "phaseAssumption": "in_phase_for_preview_only",
                        "warnings": ["这是预设探索频带的空间响应曲线；未检出所有测点共同支持的显著窄带峰，不是识别出的模态。",
                            "角度投影和激励尚未校正；不足三个周期的片段未纳入该频带。"]})
            left = right
    return {"status": "candidates_available" if candidates else "band_responses_only" if bands else "insufficient_evidence", "candidates": candidates,
            "bandResponses": bands,
            "reason": None if candidates else "未找到在所有径向测点均有局部谱峰支持的共同频带。",
            "spectrum": {"frequencies": grid.tolist(), "consensusScores": score.tolist(),
                "frequencyGridHz": step, "unit": "relative PSD score", "method": "independent-segment-welch",
                "points": [{"radialPointId": point["radialPointId"], "psd": psds[i].tolist(),
                            "stationCounts": stacked[point["radialPointId"]][1].astype(int).tolist()}
                           for i, point in enumerate(points)]}}
