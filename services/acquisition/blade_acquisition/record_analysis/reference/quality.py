from __future__ import annotations

import math
import numpy as np

from .geometry import SignalError
from .models import AnalysisConfig, RawRecording, RealSegment


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    boundaries = np.flatnonzero(np.diff(np.r_[False, np.asarray(mask, dtype=bool), False]))
    return [(int(a), int(b)) for a,b in boundaries.reshape(-1,2)]


def candidate_window(recording: RawRecording) -> tuple[int,int]:
    pc = recording.manifest.get("pointCycle") or {}
    handoff, clock = pc.get("handoff") or {}, pc.get("continuousSession") or {}
    if not handoff.get("sampleClock") or not clock.get("sampleClock"):
        raise SignalError("CLOCK_REFERENCE_MISSING", "both event and CSV clock identifiers are required")
    if handoff["sampleClock"] != clock["sampleClock"]:
        raise SignalError("CLOCK_REFERENCE_MISMATCH", "handoff and CSV use different clocks")
    keys = (handoff.get("entryConfirmedSampleIndex"), handoff.get("exitSampleIndex"), clock.get("sampleStart"))
    if any(v is None or isinstance(v,bool) or not math.isfinite(float(v)) or float(v)!=int(v) for v in keys):
        raise SignalError("PASS_EVENT_MISSING", "integer confirmed entry, exit and sampleStart required")
    start, end = int(keys[0])-int(keys[2]), int(keys[1])-int(keys[2])
    if not (0 <= start < end <= len(recording.velocity_m_s)):
        raise SignalError("PASS_BOUNDARY_OUTSIDE_RECORDING", f"[{start},{end}) outside [0,{len(recording.velocity_m_s)})")
    return start,end


def extract_segments(recording: RawRecording, config: AnalysisConfig, *,
                     explicit_window: tuple[int,int] | None = None) -> tuple[list[RealSegment],list[dict]]:
    """An explicit window is a separate diagnostic/review input, never a silent clamp."""
    if explicit_window is None:
        start,end = candidate_window(recording)
        source = "confirmed_entry_to_exit"
    else:
        start,end = explicit_window
        if any(isinstance(x,bool) or not isinstance(x,(int,np.integer)) for x in (start,end)):
            raise SignalError("INVALID_ANALYSIS_WINDOW", "integer indices required")
        if not (0 <= start < end <= len(recording.velocity_m_s)):
            raise SignalError("PASS_BOUNDARY_OUTSIDE_RECORDING", "explicit window outside recording")
        source = "explicit_review_window"
    if not math.isfinite(config.quality_guard_seconds) or config.quality_guard_seconds < 0:
        raise SignalError("INVALID_CONFIG", "quality guard must be nonnegative")
    n = end-start
    v = recording.velocity_m_s[start:end]
    t = recording.time_s[start:end]
    over = recording.overrange[start:end]
    bad = ~np.isfinite(v) | ~np.isfinite(t) | ~np.isfinite(over) | (over != 0)
    events: list[dict] = []
    for a,b in runs(bad):
        events.append(dict(code="HARD_INVALID",source_start=start+a,source_end=start+b))
    if config.rssi_min_percent is not None:
        if not (config.rssi_rule_verified and config.rssi_alignment_verified):
            raise SignalError("RSSI_RULE_UNCALIBRATED", "hard RSSI gating requires verified rule and time alignment")
        if not math.isfinite(config.rssi_min_percent) or not 0 <= config.rssi_min_percent <= 100:
            raise SignalError("INVALID_CONFIG", "RSSI threshold outside [0,100]")
        s = recording.rssi_percent[start:end]
        optical_bad = ~np.isfinite(s) | (s < config.rssi_min_percent)
        bad |= optical_bad
        for a,b in runs(optical_bad):
            events.append(dict(code="RSSI_RULE_INVALID",source_start=start+a,source_end=start+b))
    else:
        suspect = np.isfinite(recording.rssi_percent[start:end]) & (recording.rssi_percent[start:end] <= 0)
        for a,b in runs(suspect):
            events.append(dict(code="RSSI_ZERO_SUSPECT",source_start=start+a,source_end=start+b))
    guard = int(math.ceil(config.quality_guard_seconds*recording.sample_rate_hz))
    if guard:
        for a,b in runs(bad.copy()):
            bad[max(0,a-guard):min(n,b+guard)] = True
    # A timestamp discontinuity is a boundary; it cannot be hidden inside one RealSegment.
    breaks = np.flatnonzero(~np.isclose(np.diff(t),1/recording.sample_rate_hz,rtol=1e-3,atol=1e-12))+1
    boundaries = sorted({0,n,*map(int,breaks)})
    for i in breaks:
        events.append(dict(code="DATA_GAP",source_start=start+int(i),source_end=start+int(i)))
    pass_id = f"{recording.recording_id}:pass:{start}:{end}:{source}"
    segments = []
    for lo,hi in zip(boundaries,boundaries[1:]):
        for a,b in runs(~bad[lo:hi]):
            a,b = a+lo,b+lo
            if b-a < 2:
                continue
            sid = f"{pass_id}:segment:{start+a}:{start+b}"
            segments.append(RealSegment(recording.recording_id,pass_id,sid,recording.source_hash,start+a,
                recording.sample_rate_hz,t[a:b],v[a:b],recording.rssi_percent[start+a:start+b]))
    return segments,events
