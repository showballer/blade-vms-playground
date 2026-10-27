"""Validate the mapping from a continuous archive clock to a saved waveform."""
from __future__ import annotations

import math
from fractions import Fraction


def continuous_sample_window(cycle, manifest, samples):
    """Return source offset/count and the exact source-to-waveform rate ratio.

    Derivatives retain source gates verbatim. Only the explicit versioned mapping
    emitted by the upload writer permits interpreting them against another rate.
    Old derivatives with silently rescaled/clamped gates remain invalid.
    """
    link = cycle.get("continuousSession")
    if not isinstance(link, dict) or link.get("sampleClock") != "continuous_session_raw":
        raise ValueError("连续采集记录缺少原始样本时钟映射。")
    start, end = link.get("sampleStart"), link.get("sampleEndExclusive")
    if any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in (start, end)) or end <= start:
        raise ValueError("连续采集样本窗口无效。")
    source_rate, target_rate = link.get("sampleRate"), manifest.get("sampleRate")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or
           not math.isfinite(value) or value <= 0 for value in (source_rate, target_rate)):
        raise ValueError("连续采集采样率无效。")
    count = end - start
    if count == samples and source_rate == target_rate:
        return start, count, 1, 1
    sampling = manifest.get("sampling")
    if not isinstance(sampling, dict):
        raise ValueError("连续采集样本窗口或采样率与原始记录不一致。")
    ratio = Fraction(str(target_rate)) / Fraction(str(source_rate))
    up, down = ratio.numerator, ratio.denominator
    expected = {"version": 1, "sourceClock": "continuous_session_raw", "targetClock": "recording_local",
                "sourceOffset": start, "numerator": up, "denominator": down}
    mapping = sampling.get("pointCycleIndexMapping")
    if (sampling.get("version") != 2 or sampling.get("kind") != "anti_alias_lowpass" or
            not isinstance(mapping, dict) or mapping != expected or
            any(type(mapping.get(key)) is not int for key in ("version", "sourceOffset", "numerator", "denominator")) or
            target_rate >= source_rate or
            type(sampling.get("sourceSamples")) is not int or sampling["sourceSamples"] != count or
            sampling.get("sourceSampleRate") != source_rate or sampling.get("targetSampleRate") != target_rate or
            (count * up + down - 1) // down != samples or
            sampling.get("sourceHandoff") != cycle.get("handoff")):
        raise ValueError("连续采集降采样副本缺少一致的原始时钟映射。")
    return start, count, up, down
