"""Rebuild the three approved tasks from versioned archives, never a user's profile."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
from types import SimpleNamespace
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/acquisition'))
from blade_acquisition.record_analysis.outdoor_import import stage, commit
from blade_acquisition.record_analysis.adapter import catalog as recording_catalog, load_raw


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def identity(value):
    return hashlib.sha256(value.encode()).hexdigest()[:32]


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) + '\n', encoding='utf-8')


def prepare(output):
    if output.exists():
        raise ValueError('Use a fresh output directory; existing data is never overwritten')
    catalog = json.loads((ROOT / 'data/task-catalog/20261110/manifest.json').read_text(encoding='utf-8'))
    # Check all committed inputs before doing any conversion.
    for task in catalog['tasks']:
        for archive in task['archives']:
            path = ROOT / archive['path']
            assert path.stat().st_size == archive['bytes'] and sha(path) == archive['sha256'], path
    config_path = ROOT / catalog['windAndHuadeConfig']['path']
    assert sha(config_path) == catalog['windAndHuadeConfig']['sha256']
    output.mkdir(parents=True)
    summaries = []
    for task in catalog['tasks']:
        key = identity('blade-preinstalled-task-v1:' + task['name'])
        folder = output / key
        manager = SimpleNamespace(root=folder / 'imports-work', recordings=folder / 'recordings')
        paths = [ROOT / item['path'] for item in task['archives']]
        with zipfile.ZipFile(paths[0]) as archive:
            native = any(name.endswith('/chunk-00000000.bin') for name in archive.namelist())
        if native:
            for path in paths:
                with zipfile.ZipFile(path) as archive:
                    for entry in archive.infolist():
                        if entry.is_dir():
                            continue
                        assert re.fullmatch(r'[a-f0-9]{32}/(manifest\.json|chunk-\d{8}\.bin|split-source\.csv\.gz)', entry.filename)
                        assert entry.file_size <= 256 * 1024 * 1024
                        assert (entry.external_attr >> 16) & 0o170000 != 0o120000
                        target = manager.recordings / entry.filename
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with archive.open(entry) as source, target.open('xb') as dest:
                            shutil.copyfileobj(source, dest)
        else:
            manager.root.mkdir(parents=True)
            staged = stage(manager, [str(p) for p in paths])
            assert len(staged['files']) == task['records'] and all(not f.get('error') for f in staged['files'])
            mappings = []
            for f in staged['files']:
                mapping = {k: f[k] for k in ('fileId', 'bladeId', 'azimuthDeg', 'pointName')}
                mapping['radiusM'] = [7.05, 21.15, 35.25, 49.35, 63.45][int(mapping['pointName'][1:]) - 1]
                mappings.append(mapping)
            commit(manager, {'token': staged['token'], 'name': task['name'], 'windFarm': task['farm'],
                             'turbine': task['turbineCode'], 'files': mappings})
        slots = set()
        for directory in list(manager.recordings.iterdir()):
            path = directory / 'manifest.json'
            manifest = json.loads(path.read_text(encoding='utf-8'))
            point = manifest['pointCycle']
            slot = (point['bladeId'], point['radialPointName'], point['azimuthDeg'])
            assert slot not in slots
            slots.add(slot)
            # Stable identifiers across CI rebuilds prevent duplicate imports.
            # Existing native archive identifiers remain intact.
            if not native:
                rid = identity(key + ':' + manifest['importSource']['sha256'])
                manifest['id'] = rid
                manifest['importedAt'] = 0
                manifest['importSource']['importId'] = key
                point['collectionId'] = key
                destination = directory.with_name(rid)
                directory.rename(destination)
                directory = destination
            if not re.fullmatch(r'[a-f0-9]{32}', point.get('collectionId', '')):
                manifest['originalCollectionId'] = point.get('collectionId')
                point['collectionId'] = key
            # Older native exports omit format; the bundler also verifies every
            # BLADEV01 binary header, sample rate, origin and sample count.
            manifest.setdefault('format', 'BLADEV01/<QidifB')
            manifest.update(name=task['name'], windFarm=task['farm'], turbine=task['turbineCode'])
            write(directory / 'manifest.json', manifest)
        assert slots == {(str(b), f'P{p}', a) for b in range(1, 4) for p in range(1, 6) for a in (0, 90, 180, 270)}
        verified = recording_catalog(manager.recordings)
        assert not verified['errors'] and len(verified['tasks']) == 1
        assert len(verified['tasks'][0]['records']) == 60
        for blade in ('1', '2', '3'):
            record = next(r for r in verified['tasks'][0]['records'] if r['bladeId'] == blade)
            assert len(load_raw(manager.recordings, record['id']).velocity_m_s) > 0
        shutil.rmtree(manager.root, ignore_errors=True)
        summaries.append({'directory': key, 'taskName': task['name'], 'recordCount': len(slots)})
        print(f"Prepared {task['turbineCode']}: {len(slots)} recordings", flush=True)
    # Wind observations are companion files; not copied into accounts/settings
    # and not automatically uploaded to or substituted into a Web database.
    companion = output / 'reference-data'
    companion.mkdir()
    config = json.loads(config_path.read_text(encoding='utf-8'))
    write(companion / 'wind-datasets.json', {'schema': 'blade-bundled-wind-datasets-v1', 'datasets': config['datasets']})
    shutil.copyfile(ROOT / catalog['reference']['path'], companion / 'wuchuan-reference.json')
    write(output / 'tasks.json', summaries)


if __name__ == '__main__':
    prepare(Path(sys.argv[1]).resolve())
