from __future__ import annotations

from dataclasses import asdict
import json
import math
from typing import Any, Mapping

import numpy as np

from .dsp import detrend_background, features, filter_continuous, spectra, spike_candidates
from .geometry import SignalError, fixed_station_geometry, read_measurement_inputs
from .models import AnalysisConfig, RawRecording, RealSegment, RotationReference, SegmentResult, digest, readonly
from .quality import extract_segments


def _rotation_model(recording: RawRecording, segment: RealSegment, geometry, config: AnalysisConfig,
                    reference: RotationReference | None) -> tuple[np.ndarray | None,bool,dict]:
    mode = config.rotation_mode
    if mode not in ("none","model_only","apply_constant","apply_synchronized"):
        raise SignalError("INVALID_CONFIG", "unknown rotation mode")
    if mode == "none":
        return None,False,dict(state="not_requested")
    if reference is None:
        raise SignalError("RPM_REFERENCE_MISSING", "rotor reference must be supplied independently of turntable settings")
    if reference.recording_id != recording.recording_id:
        raise SignalError("RPM_REFERENCE_RECORD_MISMATCH", "reference is not bound to this recording")
    if geometry is None:
        raise SignalError("GEOMETRY_MISSING", "rotation model requires station geometry")
    if config.instrument_sign not in (-1,1):
        raise SignalError("SIGN_CALIBRATION_MISSING", "model sign cannot be selected by matching measured means")
    allowed = {"synchronized_tach","measured_record_mean","manual_estimate","controller_setpoint"}
    if reference.source not in allowed:
        raise SignalError("RPM_REFERENCE_INVALID", "unknown rotor speed source")
    rpm = np.asarray(reference.rpm,dtype=float)
    if not np.all(np.isfinite(rpm)) or rpm.ndim>1:
        raise SignalError("RPM_REFERENCE_INVALID", "finite signed RPM required")
    if rpm.ndim==0:
        if mode=="apply_synchronized" or reference.source=="synchronized_tach":
            raise SignalError("RPM_NOT_SYNCHRONIZED", "synchronized mode requires per-sample times and RPM")
        values = np.full(len(segment.values_m_s),float(rpm))
    else:
        if reference.time_s is None or len(rpm)!=len(recording.time_s):
            raise SignalError("RPM_NOT_SYNCHRONIZED", "aligned full-record RPM/time arrays required")
        times = np.asarray(reference.time_s,dtype=float)
        if times.shape!=recording.time_s.shape or not np.allclose(times,recording.time_s,rtol=0,atol=1e-9):
            raise SignalError("RPM_NOT_SYNCHRONIZED", "reference timestamps differ; align/calibrate before calling")
        values = rpm[segment.source_start:segment.source_end]
    if mode=="apply_constant" and (rpm.ndim!=0 or reference.source!="measured_record_mean"):
        raise SignalError("RPM_NOT_MEASURED_RECORD_MEAN", "constant application requires a measured record-bound scalar")
    if mode=="apply_synchronized" and reference.source!="synchronized_tach":
        raise SignalError("RPM_NOT_SYNCHRONIZED", "actual synchronized tach reference required")
    model = values*(2*np.pi/60)*geometry.rotational_los_per_rad_s_m
    return model,mode.startswith("apply_"),dict(state={"model_only":"model_only","apply_constant":"applied_constant_approx",
        "apply_synchronized":"applied_synchronized"}[mode],source=reference.source,signed_rpm_min=float(values.min()),
        signed_rpm_max=float(values.max()),fixed_station=True)


def _process_segment(recording: RawRecording, segment: RealSegment, geometry,
                     config: AnalysisConfig, reference: RotationReference | None, resolved_inputs) -> SegmentResult:
    if config.instrument_sign not in (None,-1,1):
        raise SignalError("INVALID_CONFIG", "instrument sign must be -1, +1 or unknown")
    if config.projection not in ("los","axial_equivalent"):
        raise SignalError("INVALID_CONFIG", "unknown projection target")
    layers = {"raw_los": segment.values_m_s.copy()}
    issues: list[str] = []
    y = segment.values_m_s.copy()
    if config.zero_offset_m_s is not None:
        if not math.isfinite(config.zero_offset_m_s):
            raise SignalError("INVALID_CONFIG", "finite verified zero offset required")
        y -= config.zero_offset_m_s
    if config.instrument_sign is not None:
        y *= config.instrument_sign
    if config.instrument_sign is not None or config.zero_offset_m_s is not None:
        layers["calibrated_los"] = y.copy()
    try:
        model,applied,rotation = _rotation_model(recording,segment,geometry,config,reference)
    except SignalError as exc:
        model,applied = None,False
        rotation = dict(state="blocked",reason_code=exc.code,message=str(exc))
        issues.append(exc.code)
    if model is not None:
        layers["nominal_rotation_model"] = model
    if applied:
        y -= model
        layers["rotation_compensated_los"] = y.copy()
    background,background_parameters = detrend_background(y,segment.time_s,config.background)
    layers["estimated_extra_background"] = background
    y -= background
    layer,basis = "los_residual","los"
    layers[layer] = y.copy()
    if model is not None and config.background!="none" and np.allclose(model,model[0],rtol=0,atol=1e-12):
        issues.append("BACKGROUND_NOT_UNIQUE")
    projection = dict(state="not_requested")
    if config.projection=="axial_equivalent":
        try:
            if geometry is None:
                raise SignalError("GEOMETRY_MISSING", "axial equivalent requires runtime station geometry")
            limit,minabs = config.max_projection_gain,config.min_abs_projection
            if limit is None or minabs is None:
                raise SignalError("PROJECTION_LIMITS_UNCONFIGURED", "explicit gain and projection limits required")
            if not (math.isfinite(limit) and limit>=1 and math.isfinite(minabs) and 0<minabs<=1):
                raise SignalError("INVALID_CONFIG", "invalid projection limits")
            ka = geometry.axial_projection
            if abs(ka)<minabs or geometry.gain is None or geometry.gain>limit:
                raise SignalError("PROJECTION_ILL_CONDITIONED", "station projection exceeds configured limits")
            y /= ka
            layer,basis = "axial_equivalent_residual","axial_equivalent"
            layers[layer] = y.copy()
            projection = dict(state="applied_under_dominant_direction_assumption",gain=geometry.gain,
                other_directions_independently_separated=False,geometry_assumptions=list(geometry.assumptions))
        except SignalError as exc:
            issues.append(exc.code)
            projection = dict(state="blocked",reason_code=exc.code,message=str(exc))
    # Detect before purpose filtering so filtering cannot silently hide quality candidates.
    events,spike_issues = spike_candidates(segment.with_values(y),k=config.spike_mad_k,
        sigma_floor_m_s=config.spike_sigma_floor_m_s)
    issues.extend(spike_issues)
    status = dict(analysis_state="ready",issues=issues,rotation=rotation,projection=projection,
        waveform_interpretation="residual_includes_unseparated_motion_and_measurement_error")
    guard = 0
    feature_result: dict[str,Any] = {}
    spectrum_result: dict[str,Any] = {}
    filter_parameters: dict = {"kind": "none"}
    try:
        filtered,guard,filter_parameters = filter_continuous(segment.with_values(y),config.filter)
        if config.filter.kind!="none":
            layers["removed_by_filter"] = y-filtered
            layer = "filtered_residual"
            layers[layer] = filtered
        core = segment.with_values(filtered,lo=guard,hi=len(filtered)-guard)
        feature_result = features(core)
        try:
            spectrum_result = spectra(core,welch_window_seconds=config.welch_window_seconds,band_hz=config.band_hz)
        except SignalError as exc:
            status["spectrum_state"] = "blocked"
            status["issues"].append(exc.code)
            status["spectrum_message"] = str(exc)
        else:
            status["spectrum_state"] = "ready"
    except SignalError as exc:
        status["analysis_state"] = "blocked"
        status["issues"].append(exc.code)
        status["analysis_message"] = str(exc)
        guard = 0
    parameters = dict(config=asdict(config),background=background_parameters,filter=filter_parameters,
        rotation_reference_source=reference.source if reference else None,
        geometry=geometry.snapshot() if geometry is not None else None)
    pc = recording.manifest.get("pointCycle") or {}
    clock = pc.get("continuousSession") or {}
    parameters["measurement_inputs"] = resolved_inputs.snapshot()
    parameters["object"] = dict(wind_farm=recording.manifest.get("windFarm"),
        turbine=recording.manifest.get("turbine"),blade=pc.get("bladeId"),point=pc.get("radialPointName"),
        azimuth_deg=resolved_inputs.azimuth_deg,radius_from_hub_m=resolved_inputs.radius_from_hub_m)
    parameters["capture_key"] = recording.manifest.get("physicalCaptureId") or (
        f"{clock['id']}:{clock['sampleStart']}:{clock['sampleEndExclusive']}"
        if all(k in clock for k in ("id","sampleStart","sampleEndExclusive")) else recording.recording_id)
    parameters["result_set"] = "unreviewed_source_flags_passed" if _source_quality(recording)["source_flags_allow_formal_review"] else "diagnostic"
    if reference is not None:
        parameters["rotation_reference_fingerprint"] = dict(recording_id=reference.recording_id,source=reference.source,
            rpm_sha256=digest(np.asarray(reference.rpm,dtype="<f8").tobytes()),
            time_sha256=digest(np.asarray(reference.time_s,dtype="<f8").tobytes()) if reference.time_s is not None else None)
    for key in layers:
        layers[key] = readonly(layers[key])
    rid = digest(json.dumps(dict(source=segment.source_hash,segment=segment.segment_id,
        source_start=segment.source_start,source_end=segment.source_end,parameters=parameters),
        sort_keys=True,ensure_ascii=False,allow_nan=False).encode())
    return SegmentResult(segment,layer,basis,layers,guard,len(y)-guard,feature_result,spectrum_result,
        events,status,parameters,rid)


def analyze_recording(recording: RawRecording, measurement_inputs: Mapping[str,Any] | None = None,
                      config: AnalysisConfig | None = None, *, rotation_reference: RotationReference | None = None,
                      explicit_window: tuple[int,int] | None = None) -> dict[str,Any]:
    """Main import API. Missing geometry does not prevent LOS diagnostics.

    All returned dimensions come from this record/form input; no turbine-height/length constants.
    """
    config = config or AnalysisConfig()
    issues = list(recording.parse_issues)
    inputs = read_measurement_inputs(recording.manifest,measurement_inputs)
    try:
        geometry = fixed_station_geometry(inputs,allow_upright_assumption=config.allow_upright_geometry_assumption)
    except SignalError as exc:
        geometry = None
        issues.append(exc.code)
    try:
        segments,quality_events = extract_segments(recording,config,explicit_window=explicit_window)
    except SignalError as exc:
        return dict(recording_id=recording.recording_id,source_hash=recording.source_hash,
            measurement_inputs=inputs.snapshot(),geometry=geometry.snapshot() if geometry else None,
            issues=issues+[exc.code],message=str(exc),segments=[],quality_events=[],representative=None,
            source_quality=_source_quality(recording),status="blocked")
    results = []
    for segment in segments:
        try:
            if config.core_window_seconds is not None:
                if not math.isfinite(config.core_window_seconds) or config.core_window_seconds<=0:
                    raise SignalError("INVALID_CONFIG", "positive real core window duration required")
                count = int(round(config.core_window_seconds*segment.sample_rate_hz))
                if not 2<=count<=len(segment.values_m_s):
                    raise SignalError("INSUFFICIENT_OBSERVATION", "requested real core window exceeds continuous segment")
                lo = (len(segment.values_m_s)-count)//2
                segment = segment.with_values(segment.values_m_s,lo=lo,hi=lo+count)
            results.append(_process_segment(recording,segment,geometry,config,rotation_reference,inputs))
        except SignalError as exc:
            issues.append(exc.code)
            quality_events.append(dict(code=exc.code,message=str(exc),segment_id=segment.segment_id))
    eligible = [r for r in results if r.status["analysis_state"]=="ready" and r.features]
    representative = min(eligible,key=lambda r:(-r.features["sample_count"],r.segment.source_start)) if eligible else None
    return dict(recording_id=recording.recording_id,source_hash=recording.source_hash,
        measurement_inputs=inputs.snapshot(),geometry=geometry.snapshot() if geometry else None,
        issues=issues,segments=results,quality_events=quality_events,
        representative=representative.result_id if representative else None,
        source_quality=_source_quality(recording),status="ready" if eligible else "blocked")


def _source_quality(recording: RawRecording) -> dict:
    m,pc = recording.manifest,recording.manifest.get("pointCycle") or {}
    return dict(diagnostic_only=m.get("diagnosticOnly"),valid_measurement=m.get("validMeasurement"),
        identity_verified=pc.get("identityVerified"),data_loss_assessment=m.get("dataLossAssessment"),
        source_flags_allow_formal_review=m.get("diagnosticOnly") is False and m.get("validMeasurement") is True
            and pc.get("identityVerified") is True and not recording.parse_issues,
        formal_quality_certified_by_library=False)
