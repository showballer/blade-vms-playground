"""Relative vibration displacement from independent measured velocity cores."""
import numpy as np
from .reference.dsp import bandlimited_kinematics
from .reference.geometry import SignalError

VERSION = "relative-displacement-1"

def displacement_amplitude(real, band):
    # No display bridges or resampled chart arrays may enter this calculation.
    axis = np.linspace(-1., 1., len(real.values_m_s))
    centered = real.values_m_s - np.mean(real.values_m_s)
    clean = real.with_values(centered - axis * (np.sum(axis*centered)/np.sum(axis*axis)))
    guard_seconds = len(clean.time_s) / clean.sample_rate_hz * .05
    result = bandlimited_kinematics(clean, band_hz=tuple(band), edge_guard_seconds=guard_seconds)
    x = result["displacement_m"]
    return {"half_peak_to_peak_m": float(np.ptp(x)/2), "rms_m": float(np.sqrt(np.mean(x*x))),
        "sourceHash": real.source_hash, "recordingId": real.recording_id,
        "sourceRange": [real.source_start, real.source_end], "samples": len(real.time_s),
        "sampleRateHz": real.sample_rate_hz, "edgeGuardSamples": result["edge_guard_samples"],
        "evaluatedRange": [real.source_start+result["edge_guard_samples"],real.source_end-result["edge_guard_samples"]]}

def summarize_displacement(results, outdoor):
    domains = {}
    for r in results:
        o=r.parameters["object"]
        domain=(o["wind_farm"],o["turbine"],o["blade"],r.layer,r.basis)
        domains.setdefault(domain,[]).append(r)
    points=[]
    for domain, records in domains.items():
        cores=[r.analysis_input() for r in records]
        lo=max(c.sample_rate_hz/len(c.time_s) for c in cores)
        hi=min(.45*c.sample_rate_hz for c in cores)
        groups={}
        for r,core in zip(records,cores):
            o=r.parameters["object"];key=(o["point"],o["radius_from_hub_m"],r.parameters.get("geometryComparisonKey"))
            g=groups.setdefault(key,{"object":o,"layer":r.layer,"basis":r.basis,"band_hz":[lo,hi],"azimuths":{},"excluded":[]})
            try:
                if not 0<lo<hi: raise SignalError("INSUFFICIENT_OBSERVATION","No common resolvable integration band")
                item={"resultId":r.result_id,**displacement_amplitude(core,(lo,hi))}
                g["azimuths"].setdefault(o["azimuth_deg"],[]).append(item)
            except (SignalError,ValueError,TypeError) as exc:
                g["excluded"].append({"resultId":r.result_id,"message":str(exc)})
        common=set.intersection(*(set(g["azimuths"]) for g in groups.values())) if groups else set()
        for g in groups.values():
            participating=set(g["azimuths"]) if outdoor else common
            angles=[{"azimuth_deg":a,"mean_half_peak_to_peak_m":float(np.mean([v["half_peak_to_peak_m"] for v in captures])),"records":captures}
                for a,captures in sorted(g.pop("azimuths").items()) if a in participating]
            points.append({**g,"azimuth_results":angles,"azimuth_count":len(angles),
                "mean_half_peak_to_peak_m":float(np.mean([a["mean_half_peak_to_peak_m"] for a in angles])) if angles else None,
                "weighting":"equal_capture_then_equal_azimuth" if outdoor else "equal_capture_then_equal_common_azimuth"})
    return {"available":any(p["azimuth_results"] for p in points),"kind":"point_displacement","points":points,
        "algorithmVersion":VERSION,"unit":"m","absolute_displacement_available":False,
        "policy":{"baseline":"linear detrend per continuous velocity core","integration":"X(f)=V(f)/(j*2*pi*f); DC excluded",
            "band":"common max(fs/N) to min(0.45*fs) across the selected blade/layer/direction; incompatible geometry groups remain separate",
            "edges":"discard first and last 5% of each continuous core","amplitude":"(max(x)-min(x))/2",
            "limitation":"bandlimited relative vibration displacement, not absolute blade deflection; frequencies below 1/T unresolved"}}
