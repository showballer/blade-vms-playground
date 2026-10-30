"""Plot-only reduction. Numerical routines always use complete real segment arrays."""
from __future__ import annotations
import hashlib
import json
import numpy as np
from scipy.signal import find_peaks
from .reference.cli import json_safe

PLOT_LIMIT = 2000


def plot_indices(*arrays, limit=PLOT_LIMIT):
    n=len(arrays[0]) if arrays else 0
    if n<=limit: return np.arange(n,dtype=int)
    bins=max(1,(limit-2)//(2*len(arrays)+2)); edges=np.linspace(0,n,bins+1,dtype=int)
    selected={0,n-1}
    for lo,hi in zip(edges,edges[1:]):
        selected.update((int(lo),int(hi-1)))
        for a in arrays:
            part=np.asarray(a)[lo:hi]; good=np.flatnonzero(np.isfinite(part))
            if len(good):
                selected.add(int(lo+good[np.argmin(part[good])]))
                selected.add(int(lo+good[np.argmax(part[good])]))
    return np.array(sorted(selected),dtype=int)


def raw_plot(raw):
    indices=plot_indices(raw.velocity_m_s,raw.rssi_percent,raw.overrange)
    return json_safe(dict(time_s=raw.time_s[indices],velocity_m_s=raw.velocity_m_s[indices],
        rssi_percent=raw.rssi_percent[indices],overrange=raw.overrange[indices],source_indices=indices,
        samples=len(raw.time_s),sample_rate_hz=raw.sample_rate_hz,
        display_only=True,reduction="bucket_min_max_preserving_source_indices",analysis_eligible=False),include_arrays=True)


def spectrum_plot(spectrum):
    result={k:v for k,v in spectrum.items() if not isinstance(v,np.ndarray)}
    for x,y in (("fft_frequency_hz","fft_peak_amplitude_m_s"),("psd_frequency_hz","psd_m2_s2_per_hz")):
        if x not in spectrum or y not in spectrum: continue
        indices=plot_indices(spectrum[y]);result[x]=spectrum[x][indices];result[y]=spectrum[y][indices]
    if "fft_peak_amplitude_m_s" in spectrum:
        y=spectrum["fft_peak_amplitude_m_s"];f=spectrum["fft_frequency_hz"]
        peaks,_=find_peaks(y)
        peaks=sorted(peaks,key=lambda i:float(y[i]),reverse=True)[:12]
        result["peaks"]=[dict(frequency_hz=float(f[i]),peak_amplitude_m_s=float(y[i]),source_bin=int(i),
                              interpretation="response_peak_not_natural_frequency") for i in peaks]
    return json_safe(result,include_arrays=True)


def segment_summary(result):
    value=json_safe(result)
    value["pass_id"]=result.segment.pass_id
    value["source_hash"]=result.segment.source_hash
    value["sample_rate_hz"]=result.segment.sample_rate_hz
    value["spectrum"]=spectrum_plot(result.spectrum)
    value["events_total"]=len(result.events)
    value["events"]=value["events"][:1000]
    value["analysis_eligible"]=result.status.get("analysis_state")=="ready"
    if result.features and result.features.get("kurtosis_ordinary") is not None:
        value["features"]["kurtosis_excess"]=result.features["kurtosis_ordinary"]-3
    return value


def segment_plot(result):
    value=segment_summary(result)
    indices=plot_indices(*result.layers.values())
    value.update(json_safe(dict(time_s=result.segment.time_s[indices],rssi_percent=result.segment.rssi_percent[indices],
        source_indices=result.segment.source_start+indices,layers={k:v[indices] for k,v in result.layers.items()},
        display_only=True,reduction="bucket_min_max_preserving_source_indices"),include_arrays=True))
    return value


def comparison_key(group):
    return hashlib.sha256(json.dumps({k:group.get(k) for k in
        ("wind_farm","turbine","blade","point","layer","basis","result_set","radius_from_hub_m","config","geometryComparisonKey")},
        sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()


def aggregate_plot(group):
    out=dict(group)
    p=out.get("cross_azimuth_psd")
    if p is not None:
        i=plot_indices(p["psd_m2_s2_per_hz"])
        out["cross_azimuth_psd"]={"frequency_hz":p["frequency_hz"][i],"psd_m2_s2_per_hz":p["psd_m2_s2_per_hz"][i],"display_only":True}
    out["comparison_key"]=comparison_key(group)
    return json_safe(out,include_arrays=True)
