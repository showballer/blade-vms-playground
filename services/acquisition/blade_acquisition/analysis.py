"""Numerical analysis of contiguous BLADEV01 samples; never a display preview."""
from __future__ import annotations

import hashlib
import math
import time
from typing import Literal

import numpy as np
import scipy
from scipy import signal, integrate
from pydantic import BaseModel, ConfigDict, Field

from .storage import HEADER, MAGIC, RECORD

VERSION = "signal-1.0.0"
MAX_SAMPLES = 8_000_000
DTYPE = np.dtype([("index", "<u8"), ("raw", "<i4"), ("value", "<f8"),
                  ("rssiRaw", "<i4"), ("rssi", "<f4"), ("flags", "u1")])
assert DTYPE.itemsize == RECORD.size


def realtime_snapshot(values, rate: float, sample_start: int = 0, max_fft: int = 4096) -> dict:
    """Calculate bounded, causal-preview metrics without touching persisted data."""
    x = np.asarray(values, dtype=np.float64)
    n = int(x.size)
    base = {"available": False, "sampleRate": rate if math.isfinite(rate) and rate > 0 else None,
            "sampleStart": sample_start, "sampleCount": n, "windowSamples": 0,
            "features": {"mean": None, "rms": None, "peak": None, "peakToPeak": None, "dominantHz": None},
            "spectrum": {"frequencies": [], "amplitudes": []},
            "warnings": ["实时结果使用最近窗口；停止采集后请使用完整记录进行离线分析。"]}
    if n < 64 or not math.isfinite(rate) or rate <= 0 or not np.isfinite(x).all():
        return base
    size = 1 << (min(n, max_fft).bit_length() - 1)
    x = x[-size:]
    window = np.hanning(size)
    # Remove the local DC component for peak finding; retain the raw mean/RMS below.
    amplitude = np.abs(np.fft.rfft((x - x.mean()) * window)) / max(float(window.sum()), 1.0)
    if size > 1:
        amplitude[1:-1 if size % 2 == 0 else None] *= 2
    frequencies = np.fft.rfftfreq(size, 1 / rate)
    index = int(np.argmax(amplitude[1:]) + 1) if amplitude.size > 1 else 0
    base.update(available=True, sampleStart=sample_start + n - size, sampleCount=size,
                windowSamples=size,
                features={"mean": float(x.mean()), "rms": float(np.sqrt(np.mean(x ** 2))),
                          "peak": float(np.max(np.abs(x))), "peakToPeak": float(np.ptp(x)),
                          "dominantHz": float(frequencies[index]) if amplitude[index] > 1e-14 else None},
                spectrum={"frequencies": frequencies.tolist(), "amplitudes": amplitude.tolist()},
                frequencySpacingHz=float(rate / size))
    return base


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    start: int = Field(default=0, ge=0, le=2**53 - 1, strict=True)
    end: int = Field(ge=1, le=2**53 - 1, strict=True)
    quantity: Literal["velocity", "displacement", "acceleration"] = "velocity"
    detrend: Literal["constant", "linear", "none"] = "constant"
    filterType: Literal["none", "lowpass", "highpass", "bandpass"] = "none"
    lowHz: float = Field(default=1, gt=0)
    highHz: float = Field(default=100, gt=0)
    order: int = Field(default=4, ge=1, le=10, strict=True)
    window: Literal["hann", "boxcar", "hamming"] = "hann"
    nfft: int = Field(default=4096, ge=64, le=262144, strict=True)
    stftSize: int = Field(default=1024, ge=64, le=4096, strict=True)
    bands: list[tuple[float, float]] = Field(default=[(0, 10), (10, 30), (30, 80)], min_length=1, max_length=12)


def read_raw(store, recording_id, start, end):
    directory = store.directory(recording_id)
    manifest = store._read_manifest(directory)
    if manifest.get("status") != "complete":
        raise ValueError("请先停止并完整保存记录，再执行分析。")
    if not 0 <= start < end <= manifest["samples"] or not 64 <= end - start <= MAX_SAMPLES:
        raise ValueError("分析区间须在记录内，包含 64～8000000 个连续原始样本。")
    rate = manifest.get("sampleRate")
    if not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0:
        raise ValueError("记录采样率无效。")
    values = np.empty(end - start, dtype=np.float64)
    covered, origin = start, manifest.get("sampleOrigin")
    overrange = missing = 0
    digest = hashlib.sha256()
    for path in store.chunks(directory):
        with path.open("rb") as stream:
            header = stream.read(HEADER.size)
            if len(header) != HEADER.size:
                raise ValueError("原始分块头不完整。")
            magic, chunk_rate, chunk_origin, first = HEADER.unpack(header)
            if magic != MAGIC or chunk_rate != rate or not math.isfinite(chunk_origin):
                raise ValueError("原始分块采样率或时间头无效。")
            if origin is None:
                origin = chunk_origin
            if origin != chunk_origin:
                raise ValueError("原始分块时间起点不一致。")
            size = path.stat().st_size - HEADER.size
            if size % RECORD.size:
                raise ValueError("原始分块尾部不完整。")
            lo, hi = max(first, start), min(first + size // RECORD.size, end)
            if lo >= hi:
                continue
            if lo != covered:
                raise ValueError("原始分块缺失或重叠，不能拼接分析。")
            stream.seek(HEADER.size + (lo - first) * RECORD.size)
            while lo < hi:
                finish = min(hi, lo + 65536)
                payload = stream.read((finish - lo) * RECORD.size)
                if len(payload) != (finish - lo) * RECORD.size:
                    raise ValueError("原始分块被截断。")
                rows = np.frombuffer(payload, dtype=DTYPE)
                if not np.array_equal(rows["index"], np.arange(lo, finish, dtype=np.uint64)):
                    raise ValueError("原始样本序号不连续。")
                if not np.isfinite(rows["value"]).all():
                    raise ValueError("原始速度包含非有限值。")
                values[lo - start:finish - start] = rows["value"]
                overrange += int(np.count_nonzero(rows["flags"] & 1))
                missing += int(np.count_nonzero((rows["flags"] & 2) == 0))
                digest.update(payload)
                lo = finish
            covered = hi
        if covered == end:
            break
    if covered != end:
        raise ValueError("区间原始数据缺失。")
    if overrange:
        raise ValueError(f"区间含 {overrange} 个超量程样本，请选择未超量程的连续区间。")
    return values, rate, {"recordingId": recording_id, "recordingName": manifest.get("name", recording_id),
                          "source": manifest.get("source", "polytec_ivs500"), "sampleOrigin": origin,
                          "rawSha256": digest.hexdigest(), "missingRssiSamples": missing,
                          "overrangeSamples": overrange, "dataLossAssessment": "unverified"}


def spectrum(x, rate, window):
    n = len(x)
    w = signal.get_window(window, n, fftbins=True)
    amplitude = np.abs(np.fft.rfft(x * w)) / np.sum(w)
    amplitude[1: -1 if n % 2 == 0 else None] *= 2
    frequencies, psd = signal.periodogram(x, rate, window=w, detrend=False, scaling="density")
    return frequencies, amplitude, psd


def curve(x, y, limit=1800):
    """Min/max render reduction after computation; includes extrema and x coordinates."""
    if len(y) <= limit:
        return {"x": x.tolist(), "y": y.tolist(), "representation": "full"}
    indices = []
    for a, b in zip(np.linspace(0, len(y), limit // 2 + 1, dtype=int)[:-1],
                    np.linspace(0, len(y), limit // 2 + 1, dtype=int)[1:]):
        indices.extend(sorted({a + int(np.argmin(y[a:b])), a + int(np.argmax(y[a:b]))}))
    return {"x": x[indices].tolist(), "y": y[indices].tolist(), "representation": "minmax-display"}


def calculate(values, rate, config: AnalysisRequest, provenance=None):
    x = np.asarray(values, dtype=np.float64)
    n = len(x)
    if x.ndim != 1 or n < 64 or n > MAX_SAMPLES or not np.isfinite(x).all() or not math.isfinite(rate) or rate <= 0:
        raise ValueError("需要有限数值、有效采样率和 64～8000000 个连续样本。")
    if config.end - config.start != n:
        raise ValueError("请求区间与样本数量不一致。")
    if config.nfft > n or config.stftSize > n:
        raise ValueError("FFT 点数和 STFT 窗长不能大于选定样本数。")
    nyquist = rate / 2
    for low, high in config.bands:
        if not 0 <= low < high <= nyquist:
            raise ValueError("频带须满足 0 ≤ 下限 < 上限 ≤ 奈奎斯特频率。")
    ordered = sorted(config.bands)
    if any(a[1] > b[0] for a, b in zip(ordered, ordered[1:])):
        raise ValueError("频带不能重叠。")
    warnings = ["连续性校验针对本地保存文件，不能据此证明设备 UDP 无丢包。"]
    prepared = x.copy() if config.detrend == "none" else signal.detrend(x, type=config.detrend)
    filtered = prepared.copy()
    if config.filterType != "none":
        if config.filterType == "bandpass":
            if not 0 < config.lowHz < config.highHz < nyquist:
                raise ValueError("带通截止频率须满足 0 < low < high < fs/2。")
            cutoff = [config.lowHz, config.highHz]
        else:
            cutoff = config.lowHz if config.filterType == "highpass" else config.highHz
            if not 0 < cutoff < nyquist:
                raise ValueError("截止频率须在 0 与 fs/2 之间。")
        sos = signal.butter(config.order, cutoff, btype=config.filterType, fs=rate, output="sos")
        filtered = signal.sosfiltfilt(sos, prepared)
        warnings.append("滤波采用离线双向 Butterworth SOS；零相位、幅频响应为单向响应的平方，端点有边界效应。")
    unit = "m/s"
    analyzed = filtered
    if config.quantity == "displacement":
        if config.detrend == "none":
            raise ValueError("计算位移必须先去均值或线性趋势，以控制积分漂移。")
        analyzed = integrate.cumulative_trapezoid(filtered, dx=1 / rate, initial=0)
        analyzed = signal.detrend(analyzed, type="linear")
        unit = "m"
        warnings.append("计算位移：梯形积分后去线性漂移，不含绝对位置和真实直流位移；低频与端点需谨慎解释。")
    elif config.quantity == "acceleration":
        analyzed = np.gradient(filtered, 1 / rate, edge_order=2)
        unit = "m/s²"
        warnings.append("计算加速度：中心差分，端点用单边差分；会放大高频噪声，建议先低通/带通。")
    if not np.isfinite(analyzed).all():
        raise ValueError("处理结果溢出，请检查数值和参数。")
    centered = analyzed - analyzed.mean()
    variance = float(np.mean(centered ** 2))
    # FFT uses an explicit first-N window; features/PSD use the entire requested interval.
    freq, amplitude, _ = spectrum(analyzed[:config.nfft], rate, config.window)
    non_dc = int(np.argmax(amplitude[1:])) + 1
    peak = float(freq[non_dc]) if float(amplitude[non_dc]) > 1e-14 else None
    f_psd, psd = signal.welch(analyzed, rate, window=config.window, nperseg=config.nfft,
                             noverlap=config.nfft // 2, detrend=False, scaling="density")
    df = rate / config.nfft
    total_power = float(psd.sum() * df)
    energies = []
    for low, high in config.bands:
        mask = (f_psd >= low) & ((f_psd <= high) if high == nyquist else (f_psd < high))
        power = float(psd[mask].sum() * df)
        energies.append({"lowHz": low, "highHz": high, "power": power,
                         "percent": power / total_power * 100 if total_power > 0 else None})
        if not mask.any():
            warnings.append(f"频带 {low:g}–{high:g} Hz 无频率栅格点，请增加 FFT 点数/记录长度。")
    # STFT limits only returned columns, not the samples or window calculation.
    step = max(config.stftSize // 2, math.ceil((n - config.stftSize + 1) / 128))
    offsets = list(range(0, n - config.stftSize + 1, step))
    w = signal.get_window(config.window, config.stftSize)
    tile = np.asarray([analyzed[i:i + config.stftSize] * w for i in offsets])
    z = abs(np.fft.rfft(tile, axis=1)) / w.sum()
    z[:, 1: -1 if config.stftSize % 2 == 0 else None] *= 2
    groups = np.array_split(np.arange(z.shape[1]), min(128, z.shape[1]))
    stft_f = np.fft.rfftfreq(config.stftSize, 1 / rate)
    stft = {"times": [(config.start + i + config.stftSize / 2) / rate for i in offsets],
            "frequencies": [float(stft_f[g].mean()) for g in groups],
            "amplitudes": np.stack([z[:, g].max(axis=1) for g in groups], axis=1).tolist(),
            "hopSamples": step, "windowSamples": config.stftSize,
            "frequencyReduction": "max amplitude per displayed frequency group"}
    envelope = abs(signal.hilbert(analyzed))
    envelope -= envelope.mean()
    ef, ea, _ = spectrum(envelope[:config.nfft], rate, config.window)
    warnings.append("包络谱先对整个处理区间做 Hilbert 变换并去包络均值，再取首 NFFT 点；故障解读需要合适解调频带。")
    if n > config.nfft:
        warnings.append("FFT/包络谱展示区间起点的首 NFFT 点；特征值和 Welch 频带功率使用整个选定区间。")
    if step > config.stftSize:
        warnings.append("STFT 为限制显示量，时间窗之间存在间隔，不用于完整瞬态检出。")
    time_axis = (np.arange(n) + config.start) / rate
    return {"algorithmVersion": VERSION, "libraries": {"numpy": np.__version__, "scipy": scipy.__version__},
            "generatedAt": time.time(), "provenance": provenance or {"source": "simulation"},
            "parameters": config.model_dump(), "sampleRate": rate, "sampleCount": n, "durationSeconds": n / rate,
            "unit": unit, "frequencySpacingHz": df, "fftDurationSeconds": config.nfft / rate,
            "features": {"mean": float(analyzed.mean()), "rms": float(np.sqrt(np.mean(analyzed ** 2))),
                         "peak": float(np.max(abs(analyzed))), "peakToPeak": float(np.ptp(analyzed)),
                         "kurtosis": float(np.mean(centered ** 4) / variance ** 2) if variance > 0 else None,
                         "dominantHz": peak, "totalPower": total_power, "snrDb": None},
            "waveform": curve(time_axis, analyzed), "rawVelocity": curve(time_axis, x),
            "filteredVelocity": curve(time_axis, filtered), "spectrum": curve(freq, amplitude),
            "envelopeSpectrum": curve(ef, ea), "bands": energies, "stft": stft,
            "synchronousAverage": None, "warnings": warnings + ["信噪比未计算：缺少明确噪声参考。同步平均未计算：缺少周期/键相参考。"]}
