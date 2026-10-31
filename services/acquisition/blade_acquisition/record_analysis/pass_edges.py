"""Bounded raw context for pass-edge review; context never becomes analysis input."""
from __future__ import annotations

import numpy as np

from .plan import EDGE
from .reference.quality import extract_segments


def exit_transitions(raw, config, lo, hi):
    """Find a persistent change into the observed post-pass level.

    Immediate windows can straddle a ramp and fail both plateau tests. Compare
    stable contexts separated by a bounded transition instead. A saved exit and
    contiguous post-exit samples are required; this is statistical review, not a
    declaration of optical loss. In particular, a short candidate already wholly
    after the change must not qualify its quiet background tail as blade data.
    """
    handoff = (raw.manifest.get('pointCycle') or {}).get('handoff') or {}
    if handoff.get('passCompleteness') != 'confirmed':
        return []
    fs = raw.sample_rate_hz
    w = max(4, int(round(EDGE['windowSeconds'] * fs)))
    persist = max(2, int(np.ceil(EDGE['persistenceSeconds'] * fs / w)))
    context = int(np.ceil(EDGE['edgeProximitySeconds'] * fs / w)) * w
    a, b = max(0, lo - context), min(len(raw.time_s), hi + context)
    parts, _ = extract_segments(raw, config, explicit_window=(a, b))
    # Never borrow evidence across an invalid sample or a real clock gap.
    part = next((s for s in parts if s.source_start <= lo and s.source_end >= hi + persist * w), None)
    if part is None:
        return []
    y = part.values_m_s
    n = len(y) // w
    if n < 2 * persist:
        return []
    blocks = y[:n * w].reshape(n, w)
    med = np.median(blocks, axis=1)
    mad = np.median(abs(blocks - med[:, None]), axis=1) * 1.4826
    windows = np.lib.stride_tricks.sliding_window_view(med, persist)
    levels, spread = np.median(windows, axis=1), np.ptp(windows, axis=1)
    scatter = np.median(np.lib.stride_tricks.sliding_window_view(mad, persist), axis=1)
    changes = np.median(abs(np.diff(windows, axis=1)), axis=1)
    floor = np.finfo(float).eps * max(1., float(np.max(abs(y))))
    post = int(np.ceil((hi - part.source_start) / w))
    if post + persist > n:
        return []
    post_level, post_spread, post_noise = levels[post], spread[post], scatter[post]
    found = []
    max_gap = int(np.ceil(EDGE['transitionMaxSeconds'] * fs / w))
    for gap in range(max_gap + 1):
        size = len(levels) - persist - gap
        if size <= 0:
            break
        left = np.arange(size)
        right = left + persist + gap
        shift = abs(levels[right] - levels[left])
        noise = np.maximum(np.maximum(scatter[left], scatter[right]), floor)
        typical = np.maximum(np.maximum(changes[left], changes[right]), noise / 4)
        good = (shift > EDGE['stepSigma'] * noise) & (shift > EDGE['stepDifferenceRatio'] * typical)
        good &= (spread[left] < shift * EDGE['plateauSpreadFraction']) & (spread[right] < shift * EDGE['plateauSpreadFraction'])
        # A long smooth trend is not two plateaus just because the contexts are
        # short relative to their separation. Require locally stationary levels.
        good &= shift > EDGE['transitionSlopeRatio'] * (persist + gap) * typical
        tolerance = np.maximum(EDGE['backgroundMatchSigma'] * np.maximum(noise, post_noise), shift * EDGE['plateauSpreadFraction'])
        good &= (abs(levels[right] - post_level) < tolerance) & (abs(levels[left] - post_level) > tolerance * 2)
        good &= post_spread < tolerance
        for i, j, delta, sigma in zip(left[good], right[good], shift[good], noise[good]):
            start = part.source_start + (int(i) + persist - 1) * w
            end = part.source_start + (int(j) + 1) * w
            # Review only the exit neighborhood. Do not discover an unrelated
            # transition in arbitrary earlier data and infer a new blade pass.
            if start >= hi or end < lo - context or hi - end > context:
                continue
            if any(start < e['transitionRange'][1] and end > e['transitionRange'][0] for e in found):
                continue
            local = raw.velocity_m_s[start:end]
            cost_left = np.r_[0., np.cumsum(abs(local - levels[i]))]
            cost_right = np.r_[np.cumsum(abs(local[::-1] - levels[j]))[::-1], 0.]
            pos = start + int(np.argmin(cost_left + cost_right))
            found.append(dict(code='PASS_EXIT_CONTEXT_REVIEW', source_start=max(lo, start), source_end=hi,
                qualityState='review', excluded=False, basis='confirmed_exit+two_persistent_levels+contiguous_post_exit_context',
                side='exit', estimatedStepSample=pos, transitionRange=[start, end],
                contextRange=[part.source_start, part.source_end], postExitContextRange=[part.source_start + post*w, part.source_start + (post+persist)*w],
                levelChange_m_s=float(delta), robustNoise_m_s=float(sigma),
                beforeLevel_m_s=float(levels[i]), afterLevel_m_s=float(levels[j]),
                refinement=EDGE['stepRefinement'], ruleVersion=EDGE['version']))
    return sorted(found, key=lambda e: e['source_start'])
