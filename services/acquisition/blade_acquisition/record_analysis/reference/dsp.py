"""Numerical operations on real continuous segments, never display concatenations."""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import signal, stats

from .geometry import SignalError
from .models import FilterSpec, RealSegment, require_real
from .quality import runs


def features(segment: RealSegment) -> dict[str, Any]:
    y = require_real(segment).values_m_s
    mean = float(np.mean(y))
    rms = float(np.sqrt(np.mean(y*y)))
    median = float(np.median(y))
    deviation = float(np.std(y))
    max_abs = float(np.max(np.abs(y)))
    return dict(sample_count=len(y), observation_seconds=len(y)/segment.sample_rate_hz,
        source_start=segment.source_start,source_end_exclusive=segment.source_end,
        mean_m_s=mean,rms_m_s=rms,half_peak_to_peak_m_s=float(np.ptp(y)/2),
        peak_to_peak_m_s=float(np.ptp(y)),max_abs_m_s=max_abs,
        min_m_s=float(y.min()),max_m_s=float(y.max()),
        robust_sigma_m_s=float(1.4826*np.median(abs(y-median))),
        p99_abs_m_s=float(np.quantile(abs(y),.99)),
        crest_factor=None if rms == 0 else max_abs/rms,
        skewness=float(stats.skew(y,bias=False)) if len(y)>=3 and deviation>0 else None,
        kurtosis_ordinary=float(stats.kurtosis(y,fisher=False,bias=False)) if len(y)>=4 and deviation>0 else None)


def spectra(segment: RealSegment, *, welch_window_seconds: float | None = None,
            band_hz: tuple[float,float] | None = None, nfft: int | None = None) -> dict[str, Any]:
    segment = require_real(segment)
    y,fs = segment.values_m_s,segment.sample_rate_hz
    n = len(y)
    nfft = n if nfft is None else nfft
    if isinstance(nfft,bool) or not isinstance(nfft,int) or nfft < n:
        raise SignalError("INVALID_SPECTRAL_CONFIG", "FFT length must be an integer >= real sample count")
    window = signal.windows.hann(n,sym=False)
    amplitude = abs(np.fft.rfft(window*y,n=nfft))/float(window.sum())
    amplitude[1:-1 if nfft%2==0 else None] *= 2
    frequency = np.fft.rfftfreq(nfft,d=1/fs)
    if welch_window_seconds is None:
        pf,psd = signal.periodogram(y,fs,window="hann",detrend=False,scaling="density")
        window_n,method = n,"periodogram"
    else:
        if not math.isfinite(welch_window_seconds) or welch_window_seconds <= 0:
            raise SignalError("INVALID_SPECTRAL_CONFIG", "positive Welch window required")
        window_n = int(round(welch_window_seconds*fs))
        if not 2 <= window_n <= n:
            raise SignalError("INSUFFICIENT_OBSERVATION", "Welch window exceeds real segment or is too short")
        pf,psd = signal.welch(y,fs,window="hann",nperseg=window_n,noverlap=window_n//2,
            detrend=False,scaling="density",average="mean")
        method = "welch"
    result: dict[str,Any] = dict(fft_frequency_hz=frequency,fft_peak_amplitude_m_s=amplitude,
        psd_frequency_hz=pf,psd_m2_s2_per_hz=psd,psd_method=method,
        psd_window_samples=window_n,psd_window_seconds=window_n/fs,
        psd_grid_spacing_hz=float(pf[1]-pf[0]),real_observation_seconds=n/fs,
        fft_grid_spacing_hz=fs/nfft,zero_padding_samples=nfft-n,
        detrend="none_after_declared_processing",window="periodic_hann",
        amplitude_unit="m/s (peak)",psd_unit="(m/s)^2/Hz")
    if band_hz is not None:
        lo,hi = map(float,band_hz)
        if not (math.isfinite(lo) and math.isfinite(hi) and 0<=lo<hi<=fs/2):
            raise SignalError("INVALID_SPECTRAL_CONFIG", "band must satisfy 0<=lo<hi<=Nyquist")
        selected = (pf>=lo)&(pf<=hi)
        if not selected.any():
            raise SignalError("INSUFFICIENT_OBSERVATION", "no resolved frequency bin inside requested band")
        power = float(np.sum(psd[selected])*(pf[1]-pf[0]))
        result.update(band_hz=[lo,hi],band_mean_square_m2_s2=power,band_rms_m_s=math.sqrt(max(0,power)),
            band_integration="rectangular_selected_frequency_bins",
            evaluated_bin_centers_hz=[float(pf[selected][0]),float(pf[selected][-1])])
    return result


def detrend_background(values: np.ndarray, time_s: np.ndarray, method: str) -> tuple[np.ndarray,dict]:
    if method == "none":
        return np.zeros(len(values)),dict(method="none")
    if method not in ("constant","linear"):
        raise SignalError("INVALID_CONFIG", "background must be none, constant or linear")
    t = time_s - float(time_s.mean())
    if method == "constant":
        a,b = float(values.mean()),0.0
    else:
        a,b = map(float,np.linalg.lstsq(np.column_stack([np.ones(len(t)),t]),values,rcond=None)[0])
    return a+b*t,dict(method=method,intercept_m_s=a,slope_m_s2=b,
        time_origin_s=float(time_s.mean()),interpretation="empirical_background_not_uniquely_physical")


def filter_continuous(segment: RealSegment, specification: FilterSpec) -> tuple[np.ndarray,int,dict]:
    segment = require_real(segment)
    spec = specification
    y,fs = segment.values_m_s,segment.sample_rate_hz
    if spec.kind == "none":
        return y.copy(),0,dict(kind="none")
    if spec.kind not in ("lowpass","highpass","bandpass","notch"):
        raise SignalError("INVALID_FILTER_CONFIG", spec.kind)
    if isinstance(spec.order,bool) or not isinstance(spec.order,int) or not 1<=spec.order<=20:
        raise SignalError("INVALID_FILTER_CONFIG", "integer order in [1,20] required")
    cutoffs = tuple(float(x) for x in spec.cutoffs_hz)
    if not cutoffs or any(not math.isfinite(x) or not 0<x<fs/2 for x in cutoffs):
        raise SignalError("INVALID_FILTER_CONFIG", "cutoff must be inside (0,Nyquist)")
    if spec.edge_guard_seconds is None or not math.isfinite(spec.edge_guard_seconds) or spec.edge_guard_seconds<0:
        raise SignalError("FILTER_EDGE_POLICY_REQUIRED", "supply verified nonnegative edge guard seconds")
    guard = int(math.ceil(spec.edge_guard_seconds*fs))
    if len(y)-2*guard<2:
        raise SignalError("FILTER_EDGE_EXHAUSTED", "no real analysis core remains after edge exclusion")
    if spec.kind == "notch":
        if not spec.interference_verified or len(cutoffs)!=1:
            raise SignalError("NOTCH_EVIDENCE_REQUIRED", "verified single-frequency interference required")
        if spec.notch_q is None or not math.isfinite(spec.notch_q) or spec.notch_q<=0:
            raise SignalError("INVALID_FILTER_CONFIG", "positive notch Q required")
        b,a = signal.iirnotch(cutoffs[0],spec.notch_q,fs=fs)
        sos = signal.tf2sos(b,a)
    else:
        expected = 2 if spec.kind == "bandpass" else 1
        if len(cutoffs)!=expected or (expected==2 and not cutoffs[0]<cutoffs[1]):
            raise SignalError("INVALID_FILTER_CONFIG", "incorrect or unordered cutoff frequencies")
        sos = signal.butter(spec.order,cutoffs if expected==2 else cutoffs[0],btype=spec.kind,fs=fs,output="sos")
    padlen = 3*(2*len(sos)+1-min(int(np.sum(sos[:,2]==0)),int(np.sum(sos[:,5]==0))))
    if len(y)<=padlen+1:
        raise SignalError("FILTER_SEGMENT_TOO_SHORT", f"requires more than {padlen+1} real samples")
    filtered = signal.sosfiltfilt(sos,y,padlen=padlen)
    if not np.all(np.isfinite(filtered)):
        raise SignalError("FILTER_NUMERIC_FAILURE", "nonfinite filtered output")
    return filtered,guard,dict(kind=spec.kind,cutoffs_hz=cutoffs,order_per_pass=spec.order,
        passes=2,total_amplitude_response="single_pass_magnitude_squared",sos=sos.tolist(),
        padlen=padlen,edge_guard_samples_each_side=guard,edge_guard_seconds=guard/fs)


def spike_candidates(segment: RealSegment, *, k: float = 6.0,
                     sigma_floor_m_s: float | None = None) -> tuple[list[dict],list[str]]:
    """Global MAD descriptive detector. Never delete/replace velocity samples."""
    segment = require_real(segment)
    if not math.isfinite(k) or k<=0 or (sigma_floor_m_s is not None and (not math.isfinite(sigma_floor_m_s) or sigma_floor_m_s<=0)):
        raise SignalError("INVALID_CONFIG", "positive finite MAD threshold/floor required")
    y = segment.values_m_s
    center = float(np.median(y))
    sigma = float(1.4826*np.median(abs(y-center)))
    if sigma_floor_m_s is not None:
        sigma = max(sigma,sigma_floor_m_s)
    if sigma==0:
        return [],["SPIKE_SCALE_UNDEFINED"]
    events = []
    for a,b in runs(abs(y-center)>k*sigma):
        j = a+int(np.argmax(abs(y[a:b]-center)))
        rssi = float(segment.rssi_percent[j])
        events.append(dict(code="SPIKE_SUSPECT",method="global_MAD_mark_only",k=k,
            threshold_m_s=k*sigma,source_start=segment.source_start+a,source_end=segment.source_start+b,
            width_seconds=(b-a)/segment.sample_rate_hz,peak_source_index=segment.source_start+j,
            peak_time_s=float(segment.time_s[j]),peak_m_s=float(y[j]),
            peak_rssi_percent=rssi if math.isfinite(rssi) else None,
            cause="undetermined",measurement_validity="not_certified_by_RSSI"))
    return events,[]


def time_frequency(segment: RealSegment, *, window_seconds: float, overlap_fraction: float = .5) -> dict:
    segment = require_real(segment)
    if not math.isfinite(window_seconds) or not math.isfinite(overlap_fraction) or not 0<=overlap_fraction<1:
        raise SignalError("INVALID_SPECTRAL_CONFIG", "invalid STFT parameters")
    nperseg = int(round(window_seconds*segment.sample_rate_hz))
    if not 2<=nperseg<=len(segment.values_m_s):
        raise SignalError("INSUFFICIENT_OBSERVATION", "STFT window exceeds real continuous segment")
    f,t,p = signal.spectrogram(segment.values_m_s,segment.sample_rate_hz,window="hann",
        nperseg=nperseg,noverlap=int(nperseg*overlap_fraction),detrend=False,scaling="density",mode="psd")
    return dict(frequency_hz=f,time_s=t+segment.time_s[0],psd_m2_s2_per_hz=p,
        source_segment_id=segment.segment_id,window_samples=nperseg,unit="(m/s)^2/Hz")


def envelope_analysis(segment: RealSegment, *, passband_hz: tuple[float,float],
                      edge_guard_seconds: float, order: int = 4) -> dict:
    segment = require_real(segment)
    filtered,guard,parameters = filter_continuous(segment,FilterSpec("bandpass",passband_hz,order,edge_guard_seconds))
    env = abs(signal.hilbert(filtered))
    hi = len(filtered)-guard
    # Hilbert also has finite-window edge effects: guard must have been validated for this whole operation.
    core = segment.with_values(env-float(env[guard:hi].mean()),lo=guard,hi=hi)
    return dict(time_s=segment.time_s[guard:hi],envelope_m_s=env[guard:hi],
        filtered_velocity_m_s=filtered[guard:hi],spectrum=spectra(core),filter=parameters,
        envelope_spectrum_detrend="mean_removed",edge_policy="caller_verified_for_filter_and_hilbert")


def bandlimited_kinematics(segment: RealSegment, *, band_hz: tuple[float,float],
                          edge_guard_seconds: float) -> dict:
    segment = require_real(segment)
    lo,hi = band_hz
    fs = segment.sample_rate_hz
    if not (math.isfinite(lo) and math.isfinite(hi) and 0<lo<hi<fs/2):
        raise SignalError("INVALID_DERIVATION_CONFIG", "positive finite integration/derivative band below Nyquist required")
    if not math.isfinite(edge_guard_seconds) or edge_guard_seconds<0:
        raise SignalError("INVALID_DERIVATION_CONFIG", "nonnegative verified edge guard required")
    guard = int(math.ceil(edge_guard_seconds*fs))
    if len(segment.values_m_s)-2*guard<2:
        raise SignalError("FILTER_EDGE_EXHAUSTED", "no kinematics core remains")
    n = len(segment.values_m_s)
    f = np.fft.rfftfreq(n,1/fs)
    omega = 2*np.pi*f
    selected = (f>=lo)&(f<=hi)
    if not selected.any():
        raise SignalError("INSUFFICIENT_OBSERVATION", "no resolved bins in derived-quantity band")
    V = np.fft.rfft(segment.values_m_s-segment.values_m_s.mean())
    X,A = np.zeros_like(V),np.zeros_like(V)
    X[selected] = V[selected]/(1j*omega[selected])
    A[selected] = V[selected]*(1j*omega[selected])
    sl = slice(guard,n-guard)
    return dict(time_s=segment.time_s[sl],displacement_m=np.fft.irfft(X,n)[sl],
        acceleration_m_s2=np.fft.irfft(A,n)[sl],band_hz=[lo,hi],edge_guard_samples=guard,
        method="per_segment_periodic_FFT_bandlimited",absolute_displacement_available=False,
        caveat="zero-mean relative displacement; caller verifies band and finite-window edge policy")
