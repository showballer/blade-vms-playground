"""Check bundled synthetic inputs against desktop provenance and recompute estimators."""
from pathlib import Path
import hashlib,json,sys

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'services/acquisition'))
from blade_acquisition.record_analysis.modal_engine import compute

folder=root/'data/modal-samples/20261106'
manifest=json.loads((folder/'manifest.json').read_text())
preview=json.loads((root/'packages/ui/src/modal-preview-data.ts').read_text().split(' = ',1)[1].rstrip().rstrip(';'))
for item in manifest['datasets']:
    path=folder/item['input'];method=item['method'];bundle=json.loads(path.read_text());data=bundle['dataset']
    assert bundle['synthetic'] is True and data['sourceKind']=='numerical_validation_only'
    assert hashlib.sha256(path.read_bytes()).hexdigest()==item['inputFileSha256']==preview[method]['inputSha256']
    assert len(data['time_s'])==item['samplesPerChannel']==preview[method]['originalSamples']
    assert len(data['channels'])==item['channels']
    result=compute(data,method)
    saved=preview[method]['result']
    targets=[m for m in saved['modes'] if m.get('demoModelMatch','').startswith('匹配')]
    assert targets
    for expected in targets:
        found=min(result['modes'],key=lambda m:abs(m['naturalFrequencyHz']-expected['naturalFrequencyHz']))
        assert abs(found['naturalFrequencyHz']/expected['naturalFrequencyHz']-1)<.03
        assert abs(found['dampingRatio']/expected['dampingRatio']-1)<.3
    print(f"PASS {method}: {len(data['time_s'])} samples/channel, {len(data['channels'])} channels, input hash and modal parameters verified")
