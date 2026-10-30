"""Per-record admission for descriptive analysis, separate from health certification."""
from __future__ import annotations


def assess_record(manifest, bundle, *, reviewed=False):
    pc = manifest.get("pointCycle") or {}
    detection = pc.get("diagnosticDetection") or {}
    trigger = detection.get("trigger") or {}
    handoff = pc.get("handoff") or {}
    early = [item.get("detectedBeforeStoppedArrival") for item in (trigger, handoff)
             if isinstance(item.get("detectedBeforeStoppedArrival"), bool)]
    completeness = handoff.get("passCompleteness", trigger.get("passCompleteness"))
    reasons, warnings = [], []
    representative = bundle.get("representative")
    if not representative:
        reasons.extend(bundle.get("issues") or ["NO_ELIGIBLE_SEGMENT"])
    if True in early:
        reasons.append("PASS_DURING_MOTION")
    if completeness is not None and completeness != "confirmed":
        reasons.append("PASS_INCOMPLETE")
    if manifest.get("source") == "simulation" or manifest.get("simulation"):
        reasons.append("SIMULATION_SOURCE")
    if reviewed:
        reasons.append("MANUAL_WINDOW_REVIEW")
    if manifest.get("diagnosticOnly") is True or manifest.get("validMeasurement") is False:
        warnings.append("HISTORICAL_QUALITY_FLAGS_RETAINED")
    if not early:
        warnings.append("MOTION_EVIDENCE_UNAVAILABLE")
    if pc.get("identityVerified") is not True:
        warnings.append("TARGET_IDENTITY_UNVERIFIED")
    # Unknown RSSI and source-level diagnostic flags never erase real continuous data.
    # The numerical pipeline still enforces window bounds, source clocks and hard masks.
    eligible = bool(representative) and not reasons
    return {
        "policy_version": "per_record_v1",
        "status": "analyzable" if eligible else "review" if representative else "blocked",
        "analysis_eligible": eligible,
        "reason_codes": list(dict.fromkeys(reasons)),
        "warning_codes": list(dict.fromkeys(warnings)),
        "motion_state": "during_motion" if True in early else "after_stop" if False in early else "unknown",
        "pass_completeness": completeness,
        "continuous_segment_count": len(bundle.get("segments") or []),
        "health_conclusion_eligible": False,
        "health_reason_codes": ["HEALTH_REVIEW_NOT_PERFORMED"],
    }
