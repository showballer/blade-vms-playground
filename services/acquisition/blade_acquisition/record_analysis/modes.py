"""Measurement strategies outside the frozen numerical reference implementation."""
from dataclasses import replace
import math
from .plan import digest
from .reference.geometry import SignalError
from .reference.quality import extract_segments

MODES = ('indoor', 'outdoor')

def selected(value):
    if value not in MODES:
        raise SignalError('INVALID_MEASUREMENT_MODE', '请选择室内模型或户外测量')
    return value

def with_mode(raw, mode):
    return replace(raw, manifest={**raw.manifest, 'measurementMode': selected(mode)})

def outdoor_candidate(raw):
    """Remove only exporter-declared context, never infer validity from amplitude.

    Older outdoor packages without this explicit segmentation contract keep
    their complete supplied segment. The event remains statistical evidence,
    not an encoder-verified blade identity or a health qualification.
    """
    n = len(raw.time_s)
    header = (raw.manifest.get('importSource') or {}).get('originalHeader') or {}
    segmentation = header.get('segmentation') or {}
    if segmentation.get('method') != 'negative_velocity_excursion_with_local_baseline':
        return (0, n), []
    context = segmentation.get('boundaryContextSeconds')
    if context is None:
        return (0, n), []
    start, end = header.get('sourceSampleStart'), header.get('sourceSampleEndExclusive')
    fs = raw.sample_rate_hz
    valid = (not isinstance(context, bool) and isinstance(context, (int, float))
             and math.isfinite(context) and context >= 0
             and type(start) is int and type(end) is int and end-start == n
             and header.get('sampleRate') == fs)
    pad = round(context*fs) if valid else 0
    valid = valid and 0 <= pad < n-pad
    peak = segmentation.get('eventPeakTimeSeconds')
    if peak is not None:
        valid = (valid and not isinstance(peak, bool) and isinstance(peak, (int, float))
                 and math.isfinite(peak) and start+pad <= peak*fs < end-pad)
    if not valid:
        raise SignalError('OUTDOOR_CONTEXT_INVALID', '户外分段的背景长度或来源时钟不一致，请复核原始清单')
    events = [{'code':'OUTDOOR_BACKGROUND_CONTEXT', 'source_start':a, 'source_end':b,
               'excluded':True, 'basis':'exporter_declared_boundary_context',
               'contextSeconds':context, 'boundaryConfirmedByDevice':segmentation.get('boundaryConfirmedByDevice') is True}
              for a,b in ((0,pad),(n-pad,n)) if a<b]
    return (pad,n-pad), events

def outdoor_ranges(raw, config, review=None):
    candidate, context_events = outdoor_candidate(raw)
    segments, events = extract_segments(raw, config, explicit_window=candidate)
    events = context_events + events
    ranges = [{'start':s.source_start, 'end':s.source_end, 'state':'auto_pass'} for s in segments]
    for item in (review or {}).get('intervals', []):
        revised = []
        for r in ranges:
            cuts = sorted({r['start'], r['end'], max(r['start'], min(r['end'], item['start'])), max(r['start'], min(r['end'], item['end']))})
            for a, b in zip(cuts, cuts[1:]):
                if a < b:
                    state = ('reviewed_pass' if item['decision']=='include' else 'excluded') if item['start']<=a and b<=item['end'] else r['state']
                    revised.append({'start':a, 'end':b, 'state':state})
        ranges = revised
    rule = {'version':'outdoor-supplied-segment-2', 'input':'declared_event_without_context' if context_events else 'whole_supplied_segment', 'hardInvalid':'split', 'syntheticSamplesInStatistics':False}
    return {'candidateRange':list(candidate), 'ranges':ranges, 'events':events, 'statistics':[],
            'rule':rule, 'reviewRevision':(review or {}).get('id'), 'version':digest([rule,review])}

def assess(raw, config, review=None):
    if raw.manifest.get('measurementMode') == 'outdoor':
        return outdoor_ranges(raw, config, review)
    from .boundaries import assess as indoor
    return indoor(raw, config, review)

def capture_key(raw):
    pc = raw.manifest.get('pointCycle') or {}
    return 'outdoor:'+digest([pc.get('collectionId'), pc.get('bladeId'), pc.get('radialPointName'), pc.get('azimuthDeg'), raw.recording_id])
