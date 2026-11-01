"""Read-only source-package acceptance, isolated from device/user recordings.

Usage: PYTHONPATH=services/acquisition python scripts/validate-outdoor-segments.py SOURCE OUTPUT
"""
import hashlib
import json
from pathlib import Path
import sys
import time

import numpy as np
from blade_acquisition.record_analysis.adapter import load_raw
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.record_analysis.outdoor_import import parse
from blade_acquisition.record_analysis.packages import create, verify

source, output = (Path(v).resolve() for v in sys.argv[1:3])
assert not output.exists(), 'Use a fresh acceptance directory'
output.mkdir(parents=True)
before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
manager = RecordAnalysisManager(output / 'desktop')
try:
    staged = manager.handle({'action': 'import_stage', 'selectedPath': str(source)})
    assert len(staged['files']) == 12 and all(not f.get('error') for f in staged['files'])
    task = manager.handle({'action': 'import_commit', 'token': staged['token'], 'name': source.name,
                           'windFarm': 'wf1', 'turbine': '1309', 'pointName': 'P1',
                           'files': [{k: f[k] for k in ('fileId', 'bladeId', 'azimuthDeg')} for f in staged['files']]})
    for rid in task['recordingIds']:
        raw = load_raw(manager.recordings, rid)
        head, values, _ = parse((source / raw.manifest['importSource']['fileName']).read_bytes(), rid)
        np.testing.assert_array_equal(raw.velocity_m_s, values[:, 3])
        np.testing.assert_array_equal(raw.rssi_percent, values[:, 4])
        assert raw.manifest['sampleOrigin'] == 0 and raw.manifest['startedAt'] is None
    job = manager.start({'taskId': task['taskId'], 'recordingIds': task['recordingIds'],
                         'workspace': {'purpose': 'synthesis', 'algorithmOptions': {'targetBandMode': 'preview'}}})
    deadline = time.monotonic() + 120
    while manager.status(job['jobId'])['status'] in ('queued', 'running'):
        assert time.monotonic() < deadline
        time.sleep(.05)
    assert manager.status(job['jobId'])['status'] == 'complete', manager.status(job['jobId'])
    report = manager.result({'jobId': job['jobId']})
    assert report['coverage']['analyzableCount'] == 12 and len(report['aggregates']) == 3
    previews = []
    for blade in ('1', '2', '3'):
        records = [r for r in report['records'] if r['object']['blade'] == blade]
        ids = [r['representative'] for r in records]
        preview = manager.preview({'jobId': job['jobId'], 'resultIds': ids, 'automatic': True, 'expectedAzimuths': [0, 90, 180, 270]})
        assert len(preview['joins']) == 3
        assert len([b for b in preview['blocks'] if b['kind'] == 'measured_processed']) == 4
        assert len([b for b in preview['series'] if b['kind']=='synthetic_display_transition']) == 3
        assert all(np.isfinite(b['values_m_s']).all() for b in preview['series'])
        previews.append(preview)
    package = create(manager, job['jobId'])
    verified = verify(output / 'server', Path(package['path']), task['recordingIds'])
    assert verified['verifiedArrays'] == 12
    assert verified['report']['coverage'] == report['coverage']
    assert before == {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False))
    (output / 'previews.json').write_text(json.dumps(previews, ensure_ascii=False))
    summary = {'passed': True, 'source': str(source), 'recordings': str(manager.recordings), 'task': task,
               'package': package, 'verifiedArrays': verified['verifiedArrays'], 'coverage': report['coverage'],
               'sourceFilesUnchanged': len(before), 'rawNumericColumnsUnchanged': True}
    (output / 'acceptance.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps({'passed': True, 'angles': 12, 'blades': 3, 'verifiedArrays': verified['verifiedArrays']}))
finally:
    manager.close()
