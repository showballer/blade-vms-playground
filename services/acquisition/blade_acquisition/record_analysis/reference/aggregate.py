"""Two-level equal-weight descriptive point statistics; no time-array concatenation."""
from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

import numpy as np

from .geometry import SignalError


def aggregate_points(bundles: list[dict[str,Any]]) -> list[dict]:
    groups: dict[tuple,list] = defaultdict(list)
    seen: dict[tuple,str] = {}
    for bundle in bundles:
        representative = next((s for s in bundle["segments"] if s.result_id==bundle["representative"]),None)
        if representative is None:
            continue
        o = representative.parameters["object"]
        object_key = tuple(o.get(k) for k in ("wind_farm","turbine","blade","point"))
        if any(v in (None,"") for v in object_key):
            raise SignalError("TARGET_IDENTITY_UNVERIFIED", "aggregate object keys missing")
        angle = o.get("azimuth_deg")
        if angle is None:
            raise SignalError("TARGET_IDENTITY_UNVERIFIED", "aggregate azimuth missing")
        capture = representative.parameters["capture_key"]
        duplicate_key = (*object_key,capture)
        if duplicate_key in seen:
            if seen[duplicate_key]==representative.result_id:
                continue
            raise SignalError("DUPLICATE_CAPTURE_REQUIRES_SELECTION", "select one revision/export of the same acquisition")
        seen[duplicate_key] = representative.result_id
        # Distinct bases/configurations/quality scopes are distinct groups, never one mixed curve.
        comparison = (representative.layer,representative.basis,representative.parameters["result_set"],
            json.dumps(representative.parameters["config"],sort_keys=True),o.get("radius_from_hub_m"))
        groups[(*object_key,*comparison)].append((angle,representative))
    output = []
    for key,items in groups.items():
        by_angle: dict[float,list] = defaultdict(list)
        for angle,result in items:
            by_angle[angle].append(result)
        angle_results = []
        psd_by_angle = []
        common_frequency = None
        psd_comparable = True
        for angle in sorted(by_angle):
            results = by_angle[angle]
            amps = [r.features["half_peak_to_peak_m_s"] for r in results]
            rmss = [r.features["rms_m_s"] for r in results]
            angle_results.append(dict(azimuth_deg=angle,pass_count=len(results),
                mean_half_peak_to_peak_m_s=float(np.mean(amps)),mean_segment_rms_m_s=float(np.mean(rmss)),
                repeat_amplitude_sample_std_m_s=float(np.std(amps,ddof=1)) if len(amps)>=2 else None,
                result_ids=[r.result_id for r in results],
                durations_seconds=[r.features["observation_seconds"] for r in results]))
            spectra = [r.spectrum for r in results]
            if any(not s for s in spectra):
                psd_comparable = False
                continue
            frequencies = [s["psd_frequency_hz"] for s in spectra]
            if common_frequency is None:
                common_frequency = frequencies[0]
            if any(not np.array_equal(f,common_frequency) for f in frequencies):
                psd_comparable = False
                continue
            psd_by_angle.append(np.mean([s["psd_m2_s2_per_hz"] for s in spectra],axis=0))
        output.append(dict(wind_farm=key[0],turbine=key[1],blade=key[2],point=key[3],
            layer=key[4],basis=key[5],result_set=key[6],azimuth_count=len(angle_results),
            radius_from_hub_m=key[8],
            config=json.loads(key[7]),
            mean_half_peak_to_peak_m_s=float(np.mean([r["mean_half_peak_to_peak_m_s"] for r in angle_results])),
            mean_segment_rms_m_s=float(np.mean([r["mean_segment_rms_m_s"] for r in angle_results])),
            azimuth_results=angle_results,comparison_interpretation="descriptive_equal_azimuth_weight_not_phase_synchronous",
            cross_azimuth_psd=dict(frequency_hz=common_frequency,
                psd_m2_s2_per_hz=np.mean(psd_by_angle,axis=0)) if psd_comparable and len(psd_by_angle)==len(angle_results) else None,
            psd_reason=None if psd_comparable and len(psd_by_angle)==len(angle_results) else "SPECTRAL_PROFILE_MISMATCH"))
    return output
