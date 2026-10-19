"""Constant-speed order analysis and multi-point fusion for bench validation.

The angle reference is an explicit user assumption.  This module never claims
that separately recorded points are hardware synchronized or keyphasor locked.
"""
from __future__ import annotations

import math
import time
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from scipy import signal

from .analysis import MAX_SAMPLES, read_raw

VERSION = "rotation-fixed-rpm-1.1.0"
MAX_POINTS = 8
MAX_REVOLUTIONS = 200
BEAM_ROOTS = (1.875104068711961, 4.694091132974175, 7.854757438237613, 10.995540734875467)


def cantilever_shape(mode: int, positions: np.ndarray) -> np.ndarray:
    """Uniform Euler-Bernoulli clamped-free beam, unit positive tip response.

    These dimensionless spatial templates are not eigenfrequencies of the blade.
    """
    beta = BEAM_ROOTS[mode - 1]
    sigma = (np.cosh(beta) + np.cos(beta)) / (np.sinh(beta) + np.sin(beta))

    def shape(x):
        u = beta * x
        return np.cosh(u) - np.cos(u) - sigma * (np.sinh(u) - np.sin(u))

    return shape(np.asarray(positions, dtype=np.float64)) / shape(1.0)


def match_bending_modes(positions: list[float], velocity: np.ndarray, frequency: float,
                       target_order: float) -> dict:
    """Compare complex operating responses to four ideal beam templates.

    MAC is phase-aware and invariant to a common complex scale. It is a spatial
    similarity, not a probability, damage score, or experimental modal identification.
    """
    x = np.asarray(positions, dtype=np.float64)
    grid = np.linspace(0, 1, 161)
    displacement = velocity / (2j * np.pi * frequency)
    maximum = float(np.max(np.abs(displacement)))
    reference = int(np.argmax(np.abs(displacement)))
    normalized = displacement * np.exp(-1j * np.angle(displacement[reference])) / maximum if maximum > 0 else np.zeros_like(displacement)
    result = {
        "model": "uniform-cantilever-euler-bernoulli", "status": "insufficient-data",
        "message": "", "candidateMode": None, "macGap": None,
        "frequencyHz": frequency, "displacementUnit": "m", "maxDisplacementAmplitude": maximum,
        "referencePointIndex": reference, "positions": positions,
        "measuredReal": normalized.real.tolist(), "measuredImag": normalized.imag.tolist(),
        "displacementAmplitudes": np.abs(displacement).tolist(),
        "curvePositions": grid.tolist(), "candidates": [],
        "warnings": [
            "这是恒转速假设下的工作响应与理想梁振型匹配，不是固有频率、阻尼或真实模态的识别。",
            "MAC 是空间相似度（0～1），不是置信概率；高阶次不等于高阶模态。",
            "不同记录必须有共同相位参考；t=0 对齐不能证明实际同步。",
            "模板只包含均匀悬臂梁弯曲，不考虑旋转离心刚化、扭转、真实叶片截面或材料。",
            "三维叶片为示意几何；测点间仅线性插值，根部补零属于固支假设，不向最外测点之外外推。",
        ],
    }
    # Return the model library even when measurements cannot support a ranking.
    for mode in range(1, len(BEAM_ROOTS) + 1):
        result["candidates"].append({"mode": mode, "beta": BEAM_ROOTS[mode - 1],
                                     "theoryAtPoints": cantilever_shape(mode, x).tolist(),
                                     "theoryCurve": cantilever_shape(mode, grid).tolist(),
                                     "mac": None, "normalizedMse": None,
                                     "fittedReal": None, "fittedImag": None,
                                     "fittedCurveReal": None, "fittedCurveImag": None})
    if len(x) < 3 or np.count_nonzero(x > 1e-6) < 3:
        result["message"] = "至少需要 3 个不同的非根部测点才能比较候选模态；根部零响应不增加区分能力。"
        return result
    if np.min(np.diff(np.sort(x))) < 1e-6:
        result["message"] = "测点位置重复或过近，请填写真实且互不重复的 x/L。"
        return result
    if abs(target_order - round(target_order)) > 1e-8:
        result["message"] = "当前多点融合按整转同步平均，仅对整数目标阶次开放模态匹配。"
        return result
    if maximum <= 1e-15:
        result["message"] = "目标频率响应为零或过小，无法归一化和匹配。"
        return result
    energy = float(np.vdot(normalized, normalized).real)
    for candidate in result["candidates"]:
        phi = np.asarray(candidate["theoryAtPoints"])
        phi_energy = float(phi @ phi)
        projection = np.vdot(phi, normalized)
        scale = projection / phi_energy
        fitted = scale * phi
        curve = scale * np.asarray(candidate["theoryCurve"])
        candidate.update({
            "mac": float(np.clip(abs(projection) ** 2 / (phi_energy * energy), 0, 1)),
            "normalizedMse": float(np.mean(np.abs(normalized - fitted) ** 2)),
            "fittedReal": fitted.real.tolist(), "fittedImag": fitted.imag.tolist(),
            "fittedCurveReal": curve.real.tolist(), "fittedCurveImag": curve.imag.tolist(),
        })
    ranked = sorted(result["candidates"], key=lambda item: item["mac"], reverse=True)
    best, second = ranked[:2]
    gap = best["mac"] - second["mac"]
    result.update({"status": "candidate", "candidateMode": best["mode"], "macGap": gap,
                   "message": f"最接近第 {best['mode']} 阶弯曲模板（候选，不代表模态确认）。"})
    if len(x) < 5:
        result["warnings"].append("测点少于 5 个，节点可能漏测，尤其不能可靠区分高阶振型；建议沿叶展分布 5～8 点。")
    if float(np.ptp(x)) < 0.5:
        result["warnings"].append("测点覆盖不足半个叶展，局部响应可能与多种模板相似。")
    if best["mac"] < 0.8 or gap < 0.05:
        result["status"] = "ambiguous"
        result["message"] = f"匹配不明确：排序首位为第 {best['mode']} 阶模板，但相似度低或与次选过于接近。"
    return result


class RotationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    recordingIds: list[str] = Field(min_length=1, max_length=MAX_POINTS)
    rpm: float = Field(gt=0, le=100_000)
    startSeconds: float = Field(default=0, ge=0)
    endSeconds: float | None = Field(default=None, gt=0)
    pointsPerRevolution: int = Field(default=256, ge=64, le=4096, strict=True)
    maxOrder: float = Field(default=20, gt=0, le=1000)
    targetOrder: float = Field(default=1, gt=0, le=1000)
    phaseOffsetDeg: float = Field(default=0, ge=-360, le=360)
    maxRevolutions: int = Field(default=50, ge=2, le=MAX_REVOLUTIONS, strict=True)
    detrend: Literal["constant", "linear", "none"] = "constant"
    positions: list[float] = Field(default_factory=list, max_length=MAX_POINTS)
    pointNames: list[str] = Field(default_factory=list, max_length=MAX_POINTS)

    @field_validator("recordingIds")
    @classmethod
    def valid_ids(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values) or any(len(v) != 32 or any(c not in "0123456789abcdef" for c in v) for v in values):
            raise ValueError("采集记录 ID 无效或重复。")
        return values

    @field_validator("pointsPerRevolution")
    @classmethod
    def power_of_two(cls, value: int) -> int:
        if value & (value - 1):
            raise ValueError("每转采样点数必须是 2 的整数次幂。")
        return value

    @field_validator("positions")
    @classmethod
    def valid_positions(cls, values: list[float]) -> list[float]:
        if any(not 0 <= value <= 1 for value in values):
            raise ValueError("测点位置 x/L 必须在 0～1 之间。")
        return values

    @field_validator("pointNames")
    @classmethod
    def valid_names(cls, values: list[str]) -> list[str]:
        if any(not value.strip() or len(value) > 120 for value in values):
            raise ValueError("测点名称不能为空且最多 120 个字符。")
        return [value.strip() for value in values]

    @model_validator(mode="after")
    def compatible(self):
        count = len(self.recordingIds)
        if self.positions and len(self.positions) != count:
            raise ValueError("测点位置数量必须与采集记录数量一致。")
        if self.pointNames and len(self.pointNames) != count:
            raise ValueError("测点名称数量必须与采集记录数量一致。")
        if self.endSeconds is not None and self.endSeconds <= self.startSeconds:
            raise ValueError("结束时间必须大于开始时间。")
        if self.targetOrder > self.maxOrder:
            raise ValueError("融合目标阶次不能大于阶次谱上限。")
        if self.maxOrder >= self.pointsPerRevolution / 2:
            raise ValueError("阶次上限必须小于每转采样点数的一半。")
        return self


def _manifest(store, recording_id: str) -> dict:
    manifest = store._read_manifest(store.directory(recording_id))
    source_metadata = manifest.get("sourceMetadata")
    cycles = [manifest.get("pointCycle"), source_metadata.get("pointCycle") if isinstance(source_metadata, dict) else None]
    if any(cycle is not None for cycle in cycles):
        raise ValueError("自动站位记录是间断的叶片经过片段，请使用叶片有效片段分析；不能按连续整圈波形计算阶次和振型。")
    if manifest.get("status") != "complete":
        raise ValueError("多点融合只接受已停止并完整保存的记录。")
    rate, samples = manifest.get("sampleRate"), manifest.get("samples")
    if not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0 or not isinstance(samples, int) or samples < 64:
        raise ValueError("采集记录缺少有效采样率或连续样本。")
    return manifest


def _spectrum(values: np.ndarray, points_per_revolution: int, max_order: float) -> tuple[list[float], list[float], float]:
    window = np.hanning(values.size)
    amplitude = np.abs(np.fft.rfft((values - values.mean()) * window)) / max(float(window.sum()), 1.0)
    if amplitude.size > 1:
        amplitude[1:-1 if values.size % 2 == 0 else None] *= 2
    orders = np.fft.rfftfreq(values.size, d=1 / points_per_revolution)
    keep = orders <= max_order + 1e-12
    orders, amplitude = orders[keep], amplitude[keep]
    # Bound the response without selecting only peaks or changing calculation.
    stride = max(1, math.ceil(orders.size / 4000))
    return orders[::stride].tolist(), amplitude[::stride].tolist(), points_per_revolution / values.size


def calculate_rotation(store, config: RotationRequest) -> dict:
    manifests = [_manifest(store, recording_id) for recording_id in config.recordingIds]
    rotation_hz = config.rpm / 60.0
    last_times = [(item["samples"] - 1) / float(item["sampleRate"]) for item in manifests]
    common_end = min(last_times)
    if config.endSeconds is not None:
        common_end = min(common_end, config.endSeconds)
    available_revolutions = math.floor((common_end - config.startSeconds) * rotation_hz + 1e-12)
    revolutions = min(available_revolutions, config.maxRevolutions)
    if revolutions < 2:
        raise ValueError("共同时间区间不足两个完整旋转周期，请扩大区间或提高固定 RPM。")
    count = revolutions * config.pointsPerRevolution
    angular_time = config.startSeconds + np.arange(count, dtype=np.float64) / (config.pointsPerRevolution * rotation_hz)
    if count > MAX_SAMPLES:
        raise ValueError("角度重采样结果超过 800 万点，请减少转数或每转点数。")

    phase_radians = math.radians(config.phaseOffsetDeg)
    angle_degrees = (config.phaseOffsetDeg + np.arange(config.pointsPerRevolution) * 360 / config.pointsPerRevolution) % 360
    names = config.pointNames or [item.get("point") or item.get("name") or f"测点 {i + 1}" for i, item in enumerate(manifests)]
    positions = config.positions or ([i / (len(manifests) - 1) for i in range(len(manifests))] if len(manifests) > 1 else [0.0])
    spectra, averages, provenance, coefficients = [], [], [], []
    order_resolution = None

    basis = np.exp(-2j * np.pi * config.targetOrder * np.arange(config.pointsPerRevolution) / config.pointsPerRevolution)
    phase_correction = np.exp(-1j * config.targetOrder * phase_radians)
    for index, (recording_id, manifest) in enumerate(zip(config.recordingIds, manifests)):
        rate = float(manifest["sampleRate"])
        first = max(0, math.floor(config.startSeconds * rate))
        last = min(manifest["samples"], math.ceil(float(angular_time[-1]) * rate) + 2)
        if last - first < 64:
            raise ValueError(f"测点 {names[index]} 可读取的原始区间不足 64 点。")
        raw, raw_rate, trace = read_raw(store, recording_id, first, last)
        if config.detrend != "none":
            raw = signal.detrend(raw, type=config.detrend)
        source_time = np.arange(first, last, dtype=np.float64) / raw_rate
        angular = np.interp(angular_time, source_time, raw)
        revolutions_matrix = angular.reshape(revolutions, config.pointsPerRevolution)
        synchronous_average = revolutions_matrix.mean(axis=0)
        per_revolution = 2 / config.pointsPerRevolution * (revolutions_matrix @ basis) * phase_correction
        coefficients.append(per_revolution)
        order_x, order_y, resolution = _spectrum(angular, config.pointsPerRevolution, config.maxOrder)
        order_resolution = resolution
        spectra.append({"recordingId": recording_id, "name": names[index], "orders": order_x, "amplitudes": order_y})
        averages.append({"recordingId": recording_id, "name": names[index], "angleDegrees": angle_degrees.tolist(), "values": synchronous_average.tolist()})
        provenance.append({**trace, "recordingId": recording_id, "recordingName": manifest.get("name", ""),
                           "point": manifest.get("point", ""), "sourceSampleRate": raw_rate,
                           "sourceStart": first, "sourceEnd": last})

    complex_means = np.asarray([np.mean(value) for value in coefficients], dtype=np.complex128)
    reference_phase = float(np.angle(complex_means[0]))
    aligned = complex_means * np.exp(-1j * reference_phase)
    maximum = float(np.max(np.abs(aligned)))
    mode_points = []
    reference = coefficients[0]
    for index, current in enumerate(coefficients):
        numerator = abs(np.mean(reference * np.conj(current))) ** 2
        denominator = float(np.mean(abs(reference) ** 2) * np.mean(abs(current) ** 2))
        coherence = float(numerator / denominator) if denominator > 0 else None
        relative_phase = math.degrees(math.atan2(aligned[index].imag, aligned[index].real))
        mode_points.append({"recordingId": config.recordingIds[index], "name": names[index], "position": positions[index],
                            "amplitude": float(abs(complex_means[index])),
                            "normalizedAmplitude": float(abs(aligned[index]) / maximum) if maximum > 0 else 0.0,
                            "relativePhaseDeg": relative_phase, "coherence": coherence,
                            "realNormalized": float(aligned[index].real / maximum) if maximum > 0 else 0.0,
                            "imagNormalized": float(aligned[index].imag / maximum) if maximum > 0 else 0.0})

    warnings = [
        "固定 RPM、t=0 同相和相位偏移均为用户给定假设；未读取真实键相或编码器。",
        "不同记录按各自采样率插值到共同角度网格；若采集并非同时触发，相对相位和振型不能作为真实结论。",
        "阶次谱来自实际保存波形的恒转速角度重采样，不是固定演示柱高。",
    ]
    if len(manifests) == 1:
        warnings.append("当前只有一个测点，可计算阶次谱和同步平均，不能形成空间振型。")
    modal_match = match_bending_modes(positions, complex_means, config.targetOrder * rotation_hz, config.targetOrder)
    modal_match["pointNames"] = names
    return {"algorithmVersion": VERSION, "generatedAt": time.time(), "assumptionMode": "constant-rpm-model",
            "parameters": config.model_dump(), "rpm": config.rpm, "rotationHz": rotation_hz,
            "revolutions": revolutions, "durationSeconds": revolutions / rotation_hz,
            "pointsPerRevolution": config.pointsPerRevolution, "orderResolution": order_resolution,
            "unit": "m/s", "orderSpectra": spectra, "synchronousAverages": averages,
            "modeShape": {"targetOrder": config.targetOrder, "targetFrequencyHz": config.targetOrder * rotation_hz,
                          "referenceRecordingId": config.recordingIds[0], "points": mode_points},
            "modalMatch": modal_match, "provenance": provenance, "warnings": warnings}
