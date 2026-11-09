"""Versioned, paired-reference response screening and explicitly synthetic fault tests.

A local response anomaly is not a structural diagnosis. Test thresholds are
engineering verification values, not field-calibrated damage limits.
"""
import numpy as np
from .reference.geometry import SignalError

VERSION = 'paired-local-response-1'
POLICY = {'window_count_target': 24, 'overlap': .5, 'warning_rms_ratio': 1.8,
          'warning_peak_to_peak_ratio': 1.8, 'alarm_rms_ratio': 3.,
          'minimum_consecutive_windows': 3, 'threshold_source': 'engineering_test_only_not_field_calibrated'}


def _values(values):
    v = np.asarray(values, dtype=float)
    if v.ndim != 1 or len(v) < 256 or not np.all(np.isfinite(v)):
        raise SignalError('INSUFFICIENT_OBSERVATION', 'At least 256 finite contiguous samples are required')
    return v


def paired_response_screen(reference, candidate, fs):
    """Compare aligned, same-grid continuous signals; no knowledge of injected location."""
    reference, candidate = _values(reference), _values(candidate)
    if reference.shape != candidate.shape or not np.isfinite(fs) or fs <= 0:
        raise SignalError('INVALID_ANALYSIS_INPUT', 'Aligned equal-length signals and a valid sampling rate are required')
    width = max(32, len(reference)//POLICY['window_count_target'])
    hop = max(1, width//2)
    starts = list(range(0, len(reference)-width+1, hop))
    pairs = []
    for start in starts:
        a, b = reference[start:start+width], candidate[start:start+width]
        a, b = a-np.mean(a), b-np.mean(b)
        pairs.append((float(np.sqrt(np.mean(a*a))), float(np.sqrt(np.mean(b*b))), float(np.ptp(a)), float(np.ptp(b))))
    noise_floor = max(float(np.median([v[0] for v in pairs]))*.05, 1e-12)
    windows, consecutive, max_run, run_start, events = [], 0, 0, None, []
    for start, (ar, br, ap, bp) in zip(starts, pairs):
        valid = ar > noise_floor and ap > noise_floor*2
        rms_ratio, peak_ratio = (br/ar, bp/ap) if valid else (None, None)
        hit = valid and rms_ratio >= POLICY['warning_rms_ratio'] and peak_ratio >= POLICY['warning_peak_to_peak_ratio']
        windows.append({'start_sample': start, 'end_sample': start+width, 'reference_rms_m_s': ar, 'candidate_rms_m_s': br,
                        'rms_ratio': rms_ratio, 'peak_to_peak_ratio': peak_ratio, 'candidate': bool(hit), 'reference_valid': bool(valid)})
        if hit:
            if not consecutive: run_start = start
            consecutive += 1; max_run = max(max_run, consecutive)
        elif consecutive:
            if consecutive >= POLICY['minimum_consecutive_windows']:
                events.append({'start_sample': run_start, 'end_sample': windows[-2]['end_sample'], 'consecutive_windows': consecutive})
            consecutive = 0
    if consecutive >= POLICY['minimum_consecutive_windows']:
        events.append({'start_sample': run_start, 'end_sample': windows[-1]['end_sample'], 'consecutive_windows': consecutive})
    valid_windows = [w for w in windows if w['reference_valid']]
    # Severity uses only sustained events, never a lone outlier.
    event_windows = [w for w in windows if w['candidate'] and any(w['start_sample'] >= e['start_sample'] and w['end_sample'] <= e['end_sample'] for e in events)]
    max_sustained = max((w['rms_ratio'] for w in event_windows), default=0.)
    status = 'insufficient' if not valid_windows else 'alarm' if max_sustained >= POLICY['alarm_rms_ratio'] else 'warning' if events else 'normal'
    return {'status': status, 'suspectedDamage': bool(events), 'structuralDamageConfirmed': False,
            'algorithmVersion': VERSION, 'policy': dict(POLICY), 'samples': len(reference), 'sampleRateHz': fs,
            'windowSamples': width, 'hopSamples': hop, 'referenceValidWindows': len(valid_windows),
            'maxConsecutiveWindows': max_run, 'maxSustainedRmsRatio': max_sustained,
            'events': [{**e, 'start_seconds': e['start_sample']/fs, 'end_seconds': e['end_sample']/fs} for e in events],
            'windows': windows}


def inject_local_response(values):
    """Return a new test array; preserve timing, edges and source array byte-for-byte."""
    values = _values(values)
    lo, hi = round(len(values)*.35), round(len(values)*.7)
    local = values[lo:hi]
    axis = np.linspace(-1., 1., len(local))
    centered = local - np.mean(local)
    trend = np.mean(local) + axis*np.dot(axis,centered)/np.dot(axis,axis)
    residual = local-trend
    rms = float(np.sqrt(np.mean(residual*residual)))
    if rms <= 1e-12:
        raise SignalError('INSUFFICIENT_OBSERVATION', 'A zero-response source cannot support this paired fault-injection test')
    envelope = np.sin(np.linspace(0, np.pi, len(local)))**2
    # Controlled local gain plus a transient oscillatory component, not a crack physics model.
    injected = values.copy()
    injected[lo:hi] += envelope*(3.5*residual + .75*rms*np.sin(np.linspace(0,12*np.pi,len(local))))
    return injected, {'kind': 'synthetic_local_response', 'test_only': True, 'start_sample': lo, 'end_sample': hi,
                      'max_residual_gain': 4.5, 'transient_rms_scale': .75, 'model': 'local_gain_and_oscillatory_transient_not_physical_crack'}
