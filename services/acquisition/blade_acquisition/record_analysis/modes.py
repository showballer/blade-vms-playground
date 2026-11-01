"""Measurement strategies outside the frozen numerical reference implementation."""
from dataclasses import replace
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

def outdoor_ranges(raw, config, review=None):
    """A supplied segment is the candidate, not an inferred blade-pass event."""
    segments, events = extract_segments(raw, config, explicit_window=(0, len(raw.time_s)))
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
    rule = {'version':'outdoor-supplied-segment-1', 'input':'whole_supplied_segment', 'hardInvalid':'split', 'syntheticSamplesInStatistics':False}
    return {'candidateRange':[0,len(raw.time_s)], 'ranges':ranges, 'events':events, 'statistics':[],
            'rule':rule, 'reviewRevision':(review or {}).get('id'), 'version':digest([rule,review])}

def assess(raw, config, review=None):
    if raw.manifest.get('measurementMode') == 'outdoor':
        return outdoor_ranges(raw, config, review)
    from .boundaries import assess as indoor
    return indoor(raw, config, review)

def capture_key(raw):
    pc = raw.manifest.get('pointCycle') or {}
    return 'outdoor:'+digest([pc.get('collectionId'), pc.get('bladeId'), pc.get('radialPointName'), pc.get('azimuthDeg'), raw.recording_id])
