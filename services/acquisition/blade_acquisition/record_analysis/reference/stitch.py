"""Bidirectional local AR extension with quintic blend and Hermite end caps.

The output is a DisplayPreview, deliberately rejected by analysis APIs.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from fractions import Fraction
import math

import numpy as np
from scipy.interpolate import CubicHermiteSpline, CubicSpline
from scipy.signal import resample_poly

from .geometry import SignalError
from .models import DisplayPreview, SegmentResult, readonly


@dataclass(frozen=True)
class JoinConfig:
    duration_seconds: float
    context_seconds: float
    cap_seconds: float
    model_sample_rate_hz: float
    ar_order: int = 12
    ridge_relative: float = .003
    max_pole_radius: float = .995
    prediction_decay_seconds: float = .012
    amplitude_guard_factor: float = 3.0
    slope_guard_factor: float = 3.0


def _extend(context: np.ndarray, count: int, fs: float, cfg: JoinConfig) -> tuple[np.ndarray,dict]:
    ratio = Fraction(str(cfg.model_sample_rate_hz))/Fraction(str(fs))
    ratio = ratio.limit_denominator(10000)
    model_fs = fs*ratio.numerator/ratio.denominator
    if not math.isclose(model_fs,cfg.model_sample_rate_hz,rel_tol=1e-9,abs_tol=1e-9):
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "model sampling ratio cannot be represented accurately")
    reduced = resample_poly(context,ratio.numerator,ratio.denominator,padtype="line")
    p = cfg.ar_order
    if not isinstance(p,int) or isinstance(p,bool) or p<1 or len(reduced)<2*p+3:
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "AR context too short for configured order")
    center = float(reduced[-max(2,len(reduced)//3):].mean())
    scale = float(np.std(reduced-center))
    if not math.isfinite(scale) or scale<=np.finfo(float).eps*max(1,float(abs(reduced).max())):
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "context has insufficient variation for an AR model")
    x = (reduced-center)/scale
    X = np.array([x[j-p:j][::-1] for j in range(p,len(x))])
    target = x[p:]
    gram = X.T@X
    ridge = cfg.ridge_relative*float(np.trace(gram))/p
    if ridge<=0 or not math.isfinite(ridge):
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "invalid ridge scale")
    normal = gram+ridge*np.eye(p)
    try:
        coefficient = np.linalg.solve(normal,X.T@target)
    except np.linalg.LinAlgError as exc:
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "singular AR fit") from exc
    roots = np.roots(np.r_[1.,-coefficient])
    for j,root in enumerate(roots):
        if abs(root)>cfg.max_pole_radius:
            roots[j] = root/abs(root)*cfg.max_pole_radius
    coefficient = -np.poly(roots)[1:].real
    history = list(x[-p:])
    prediction = []
    prediction_n = int(math.ceil(count/fs*model_fs))+4
    bound = max(float(abs(x).max())*cfg.amplitude_guard_factor,cfg.amplitude_guard_factor)
    for j in range(prediction_n):
        z = float(np.dot(coefficient,np.asarray(history[-p:][::-1])))
        z = float(np.clip(z,-bound,bound))
        history.append(z)
        prediction.append(center+scale*z*math.exp(-(j+1)/(model_fs*cfg.prediction_decay_seconds)))
    knots = np.arange(prediction_n+1)/model_fs
    spline = CubicSpline(knots,np.r_[context[-1],prediction])
    values = spline(np.arange(count+1)/fs)
    return values,dict(actual_model_fs_hz=model_fs,model_context_samples=len(reduced),ar_order=p,
        actual_ridge=ridge,normal_matrix_condition=float(np.linalg.cond(normal)),
        max_stabilized_pole_radius=float(abs(roots).max()),context_mean_m_s=center,context_scale_m_s=scale)


def join_arrays(left: np.ndarray, right: np.ndarray, fs: float, config: JoinConfig) -> tuple[np.ndarray,dict]:
    """Display-only helper. No measured value is modified or returned as a prediction."""
    cfg = config
    scalars = [cfg.duration_seconds,cfg.context_seconds,cfg.cap_seconds,cfg.model_sample_rate_hz,
        cfg.ridge_relative,cfg.prediction_decay_seconds,cfg.amplitude_guard_factor,cfg.slope_guard_factor,fs]
    if any(not math.isfinite(x) or x<=0 for x in scalars) or not 0<cfg.max_pole_radius<1:
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "positive finite join parameters and pole radius in (0,1) required")
    if cfg.model_sample_rate_hz>fs:
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "model sampling rate cannot exceed source rate")
    L,R = np.asarray(left,dtype=float),np.asarray(right,dtype=float)
    if L.ndim!=1 or R.ndim!=1 or not np.all(np.isfinite(L)) or not np.all(np.isfinite(R)):
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "finite one-dimensional contexts required")
    context_n = int(round(cfg.context_seconds*fs))
    M = int(round(cfg.duration_seconds*fs))
    cap = int(round(cfg.cap_seconds*fs))
    if context_n<3 or min(len(L),len(R))<context_n or M<4 or cap<2 or 2*cap>=M+1:
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "context, bridge or cap is too short/overlapping")
    t = np.arange(M+2)/fs
    T = float(t[-1])
    F,forward_info = _extend(L[-context_n:],M+1,fs,cfg)
    backward,backward_info = _extend(R[:context_n][::-1],M+1,fs,cfg)
    B = backward[::-1]
    u = t/T
    weight = 6*u**5-15*u**4+10*u**3
    y = (1-weight)*F+weight*B
    d0,d1 = float((L[-1]-L[-2])*fs),float((R[1]-R[0])*fs)
    gradient = np.gradient(y,1/fs)
    y[:cap+1] = CubicHermiteSpline([0,t[cap]],[L[-1],y[cap]],[d0,gradient[cap]])(t[:cap+1])
    y[-cap-1:] = CubicHermiteSpline([t[-cap-1],T],[y[-cap-1],R[0]],[gradient[-cap-1],d1])(t[-cap-1:])
    y[0],y[-1] = L[-1],R[0]
    y[1],y[-2] = 2*L[-1]-L[-2],2*R[0]-R[1]
    context = np.r_[L[-context_n:],R[:context_n]]
    amplitude_limit = cfg.amplitude_guard_factor*max(float(abs(context).max()),np.finfo(float).eps)
    derivative_limit = cfg.slope_guard_factor*max(float(abs(np.diff(L[-context_n:])).max()*fs),
        float(abs(np.diff(R[:context_n])).max()*fs),np.finfo(float).eps)
    if not np.all(np.isfinite(y)) or float(abs(y).max())>amplitude_limit or float(abs(np.diff(y)).max()*fs)>derivative_limit:
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "synthesized bridge exceeds configured amplitude/slope guard")
    return readonly(y[1:-1]),dict(config=asdict(cfg),synthetic_samples=M,duration_seconds=M/fs,
        endpoint_to_endpoint_seconds=T,endpoint_policy="exact_discrete_increment",
        left_increment_residual_m_s=float((y[1]-y[0])-(L[-1]-L[-2])),
        right_increment_residual_m_s=float((y[-1]-y[-2])-(R[1]-R[0])),
        amplitude_limit_m_s=amplitude_limit,slope_limit_m_s2=derivative_limit,
        forward_model=forward_info,backward_model=backward_info,
        interpretation="synthetic_display_only_no_measured_phase_recovery")


def build_point_preview(results: list[SegmentResult], *, expected_azimuths: tuple[float,...],
                        config: JoinConfig) -> DisplayPreview:
    """Only explicitly selected representatives of one point, one per expected station."""
    if len(results)<2 or len(results)!=len(expected_azimuths) or len(set(expected_azimuths))!=len(expected_azimuths):
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "all explicitly requested adjacent stations must be present once")
    if not all(isinstance(r,SegmentResult) for r in results):
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "processed real segment results required")
    objects = [r.parameters.get("object",{}) for r in results]
    keys = [tuple(o.get(k) for k in ("wind_farm","turbine","blade","point")) for o in objects]
    if any(any(v in (None,"") for v in key) for key in keys) or len(set(keys))!=1:
        raise SignalError("AGGREGATION_BASIS_MISMATCH", "different or incomplete target identity")
    radius = objects[0].get("radius_from_hub_m")
    for obj in objects[1:]:
        other = obj.get("radius_from_hub_m")
        if (radius is None) != (other is None) or (radius is not None and not math.isclose(radius,other,rel_tol=1e-9,abs_tol=1e-9)):
            raise SignalError("AGGREGATION_BASIS_MISMATCH", "same point label has different or missing station radii")
    lookup = {}
    for result,obj in zip(results,objects):
        angle = obj.get("azimuth_deg")
        if angle in lookup:
            raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "select exactly one representative per azimuth")
        lookup[angle] = result
    if set(lookup)!=set(expected_azimuths):
        raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "missing requested azimuth; never bridge over a missing station")
    ordered = [lookup[angle] for angle in expected_azimuths]
    first = ordered[0]
    for result in ordered:
        if result.status["analysis_state"]!="ready" or not result.features:
            raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "analysis core unavailable")
        if (result.layer,result.basis,result.segment.sample_rate_hz,result.parameters["config"],
                result.parameters.get("result_set")) != (first.layer,first.basis,first.segment.sample_rate_hz,
                first.parameters["config"],first.parameters.get("result_set")):
            raise SignalError("AGGREGATION_BASIS_MISMATCH", "mixed layers/bases/rates/profiles/result sets")
    fs = first.segment.sample_rate_hz
    pieces,blocks,joins = [],[],[]
    cursor,measured,synthetic = 0,0,0
    for i,result in enumerate(ordered):
        real = result.analysis_input()
        y = real.values_m_s
        pieces.append(y)
        blocks.append(dict(kind="measured_processed",display_start_sample=cursor,samples=len(y),
            segment_id=real.segment_id,result_id=result.result_id,azimuth_deg=expected_azimuths[i],
            recording_id=real.recording_id,source_start=real.source_start,source_end=real.source_end,
            source_time_start_s=float(real.time_s[0]),source_time_last_s=float(real.time_s[-1]),layer=result.layer,basis=result.basis))
        cursor += len(y)
        measured += len(y)
        if i<len(ordered)-1:
            next_real = ordered[i+1].analysis_input()
            bridge,info = join_arrays(y,next_real.values_m_s,fs,config)
            join_id = f"join:{result.result_id}:{ordered[i+1].result_id}"
            pieces.append(bridge)
            info.update(join_id=join_id,left_result_id=result.result_id,right_result_id=ordered[i+1].result_id,
                display_start_sample=cursor,actual_source_gap_seconds=None,
                actual_source_gap_reason="per-record relative time is not an absolute clock mapping")
            joins.append(info)
            blocks.append(dict(kind="synthetic_display_transition",join_id=join_id,
                display_start_sample=cursor,samples=len(bridge),analysis_eligible=False,
                source_start=None,source_end=None,source_time_start_s=None))
            cursor += len(bridge)
            synthetic += len(bridge)
    return DisplayPreview(readonly(np.concatenate(pieces)),fs,tuple(blocks),tuple(joins),measured,synthetic)
