"""Verify portable test samples, hashes and algorithm outputs without a database."""
import hashlib
import json
from pathlib import Path
import numpy as np
from blade_acquisition.record_analysis.anomaly import inject_local_response, paired_response_screen

def equivalent(actual, expected):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys()
        for key in expected:equivalent(actual[key], expected[key])
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for a,b in zip(actual,expected):equivalent(a,b)
    elif isinstance(expected, float):
        # Stored JSON crosses JS serialization and platform reduction backends.
        np.testing.assert_allclose(actual,expected,rtol=1e-12,atol=1e-14)
    else:assert actual == expected


root=Path(__file__).resolve().parents[1]/'data/health-validation/20261109'
manifest=json.loads((root/'manifest.json').read_text(encoding='utf8'))
assert manifest['test_only'] is True
for file in manifest['files']:
    blob=(root/file['name']).read_bytes()
    assert len(blob)==file['bytes']
    assert hashlib.sha256(blob).hexdigest()==file['sha256'],file['name']
fixture=json.loads((root/'result.json').read_text(encoding='utf8'))
assert fixture['test_only'] is True and fixture['result']['structuralDamageConfirmed'] is False
with np.load(root/'paired-waveforms.npz',allow_pickle=False) as arrays:
    for index,item in enumerate(fixture['result']['items']):
        assert item['available']
        reference=arrays[f'reference_{index}'];candidate=arrays[f'test_{index}'];time=arrays[f'time_{index}']
        assert len(time)==len(reference)==len(candidate)==item['sourceRange'][1]-item['sourceRange'][0]
        assert np.allclose(np.diff(time),1/item['sampleRateHz'],rtol=1e-3,atol=1e-12)
        regenerated,injection=inject_local_response(reference)
        np.testing.assert_array_equal(candidate,regenerated)
        assert item['injection']==injection
        detected=paired_response_screen(reference,candidate,item['sampleRateHz'])
        control=paired_response_screen(reference,reference,item['sampleRateHz'])
        equivalent(detected,item['detection']);equivalent(control,item['control'])
        assert detected['suspectedDamage'] and control['status']=='normal'
        print(f"PASS {item['object']['azimuth_deg']} degrees: {len(time)} samples, test alarm, unchanged paired control")
print('PASS portable health-validation fixture: hashes, full waveforms, deterministic injection and screening results')
