from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import math
from typing import Any

import numpy as np

from .geometry import SignalError


def readonly(values: Any, *, dtype: Any = float) -> np.ndarray:
    result = np.array(values, dtype=dtype, copy=True)
    if result.ndim != 1:
        raise SignalError("INVALID_ARRAY", "one-dimensional arrays required")
    result.flags.writeable = False
    return result


@dataclass(frozen=True)
class RawRecording:
    recording_id: str
    sample_rate_hz: float
    time_s: np.ndarray
    velocity_m_s: np.ndarray
    rssi_percent: np.ndarray
    overrange: np.ndarray
    manifest: dict[str, Any]
    source_hash: str
    source_name: str = ""
    parse_issues: tuple[str, ...] = ()

    def __post_init__(self):
        if not math.isfinite(self.sample_rate_hz) or self.sample_rate_hz <= 0:
            raise SignalError("INVALID_SAMPLE_RATE", "sample rate must be finite and positive")
        for key in ("time_s", "velocity_m_s", "rssi_percent", "overrange"):
            object.__setattr__(self, key, readonly(getattr(self, key)))
        lengths = {len(self.time_s), len(self.velocity_m_s), len(self.rssi_percent), len(self.overrange)}
        if len(lengths) != 1 or not len(self.time_s):
            raise SignalError("INVALID_ARRAY", "raw channels must have matching nonzero lengths")


@dataclass(frozen=True)
class RealSegment:
    recording_id: str
    pass_id: str
    segment_id: str
    source_hash: str
    source_start: int
    sample_rate_hz: float
    time_s: np.ndarray
    values_m_s: np.ndarray
    rssi_percent: np.ndarray
    kind: str = field(default="real_continuous_segment", init=False)

    def __post_init__(self):
        for key in ("time_s", "values_m_s", "rssi_percent"):
            object.__setattr__(self, key, readonly(getattr(self, key)))
        n = len(self.values_m_s)
        if n < 2 or len(self.time_s) != n or len(self.rssi_percent) != n:
            raise SignalError("INSUFFICIENT_OBSERVATION", "continuous segment requires at least two matching samples")
        if not np.all(np.isfinite(self.values_m_s)) or not np.all(np.isfinite(self.time_s)):
            raise SignalError("INVALID_ANALYSIS_INPUT", "nonfinite values are not real analysis samples")
        if not math.isfinite(self.sample_rate_hz) or self.sample_rate_hz <= 0:
            raise SignalError("INVALID_SAMPLE_RATE", "invalid sample rate")
        dt = np.diff(self.time_s)
        if not np.all(np.isclose(dt, 1/self.sample_rate_hz, rtol=1e-3, atol=1e-12)):
            raise SignalError("DATA_GAP", "analysis input is not contiguous on its declared sampling grid")
        if self.source_start < 0 or not self.source_hash:
            raise SignalError("INVALID_PROVENANCE", "source indices and hash required")

    @property
    def source_end(self) -> int:
        return self.source_start + len(self.values_m_s)

    def with_values(self, values: np.ndarray, *, lo: int = 0, hi: int | None = None) -> RealSegment:
        hi = len(self.values_m_s) if hi is None else hi
        if not (0 <= lo < hi <= len(self.values_m_s)) or len(values) != len(self.values_m_s):
            raise SignalError("INVALID_ANALYSIS_INPUT", "invalid analysis core")
        return RealSegment(self.recording_id, self.pass_id, self.segment_id, self.source_hash,
            self.source_start+lo, self.sample_rate_hz, self.time_s[lo:hi], values[lo:hi], self.rssi_percent[lo:hi])


def require_real(segment: Any) -> RealSegment:
    if not isinstance(segment, RealSegment) or segment.kind != "real_continuous_segment":
        raise SignalError("SYNTHETIC_INPUT_FORBIDDEN", "analysis accepts only provenance-bound RealSegment, never display arrays")
    return segment


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class FilterSpec:
    kind: str = "none"
    cutoffs_hz: tuple[float, ...] = ()
    order: int = 4
    edge_guard_seconds: float | None = None
    notch_q: float | None = None
    interference_verified: bool = False


@dataclass(frozen=True)
class AnalysisConfig:
    version: str = "reference-0.1.0"
    allow_upright_geometry_assumption: bool = False
    background: str = "linear"
    projection: str = "los"
    min_abs_projection: float | None = None
    max_projection_gain: float | None = None
    rotation_mode: str = "none"
    instrument_sign: int | None = None
    zero_offset_m_s: float | None = None
    filter: FilterSpec = field(default_factory=FilterSpec)
    quality_guard_seconds: float = 0.0
    rssi_min_percent: float | None = None
    rssi_rule_verified: bool = False
    rssi_alignment_verified: bool = False
    spike_mad_k: float = 6.0
    spike_sigma_floor_m_s: float | None = None
    core_window_seconds: float | None = None
    welch_window_seconds: float | None = None
    band_hz: tuple[float, float] | None = None


@dataclass(frozen=True)
class RotationReference:
    recording_id: str
    source: str
    rpm: float | np.ndarray
    time_s: np.ndarray | None = None

    def __post_init__(self):
        rpm = np.asarray(self.rpm,dtype=float)
        if rpm.ndim==0:
            object.__setattr__(self,"rpm",float(rpm))
        else:
            object.__setattr__(self,"rpm",readonly(rpm))
        if self.time_s is not None:
            object.__setattr__(self,"time_s",readonly(self.time_s))


@dataclass
class SegmentResult:
    segment: RealSegment
    layer: str
    basis: str
    layers: dict[str, np.ndarray]
    analysis_start: int
    analysis_end: int
    features: dict[str, Any]
    spectrum: dict[str, np.ndarray | Any]
    events: list[dict[str, Any]]
    status: dict[str, Any]
    parameters: dict[str, Any]
    result_id: str

    def analysis_input(self) -> RealSegment:
        if self.status.get("analysis_state")!="ready" or not self.features:
            raise SignalError("ANALYSIS_UNAVAILABLE", "no qualified real analysis core available")
        return self.segment.with_values(self.layers[self.layer], lo=self.analysis_start, hi=self.analysis_end)


@dataclass(frozen=True)
class DisplayPreview:
    values_m_s: np.ndarray
    sample_rate_hz: float
    blocks: tuple[dict[str, Any], ...]
    joins: tuple[dict[str, Any], ...]
    measured_samples: int
    synthetic_samples: int
    kind: str = field(default="discontinuous_display", init=False)
    analysis_eligible: bool = field(default=False, init=False)
