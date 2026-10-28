#!/usr/bin/env python3
"""Import blade task ZIPs into a NEW local recording store without uploading.

Usage: services/acquisition/.venv/bin/python scripts/import-blade-task-zips.py \
  --output artifacts/imported-recordings --name '叶片2合并任务' export-p*.zip

Original archives and capture identities are preserved in provenance. This makes
a logical collection; independent passes do not become a continuous measurement.
CSV exports do not include integer ADC codes. Physical velocity/RSSI samples and
quality flags are retained exactly at their original sampling rate; ADC fields
are zero placeholders and explicitly declared unavailable in importSource.
"""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import time
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services' / 'acquisition'))
import numpy as np
from blade_acquisition.storage import (HEADER, MAGIC, RECORD_DTYPE, RecordingStore,
                                       atomic_json, recording_rssi_stride)

VERSION = 'blade-task-zip-import-1'
MAX_JSON_BYTES = 1024 * 1024
MAX_CSV_BYTES = 2 * 1024 ** 3
MAX_PACKAGE_BYTES = 8 * 1024 ** 3
MAX_SAMPLES = 32_000_000
ID = re.compile(r'[a-f0-9]{32}\Z')
CSV_COLUMNS = ['time_s', 'velocity_m_s', 'RSSI_percent', 'overrange']


def sha_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def digest_identity(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:32]


def checked_members(archive):
    infos = archive.infolist()
    if len(infos) > 4096 or sum(i.file_size for i in infos) > MAX_PACKAGE_BYTES:
        raise ValueError('ZIP 展开大小或文件数量超限。')
    names = set()
    for item in infos:
        path = PurePosixPath(item.filename)
        if (item.filename in names or not item.filename or not path.parts or path.is_absolute() or
                '..' in path.parts or '\\' in item.filename or ':' in path.parts[0] or
                stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1):
            raise ValueError('ZIP 包含重复、不安全或加密文件路径。')
        names.add(item.filename)
    return names


def json_member(archive, name):
    if not isinstance(name, str) or archive.getinfo(name).file_size > MAX_JSON_BYTES:
        raise ValueError('导出元数据过大或路径无效。')
    value = json.loads(archive.read(name))
    if not isinstance(value, dict):
        raise ValueError('导出元数据必须为对象。')
    return value


def validate_manifest(task_record, manifest):
    point = manifest.get('pointCycle')
    if not isinstance(point, dict) or point.get('mode') != 'automatic_stations':
        raise ValueError('记录缺少叶片点位元数据。')
    for key in ('id',):
        if not isinstance(manifest.get(key), str) or not ID.fullmatch(manifest[key]):
            raise ValueError('记录 ID 无效。')
    for key in ('collectionId', 'sessionId'):
        if not isinstance(point.get(key), str) or not ID.fullmatch(point[key]):
            raise ValueError(f'{key} 无效。')
    for key in ('bladeId', 'radialPointId', 'radialPointName', 'stationId'):
        if not isinstance(point.get(key), str) or not point[key].strip():
            raise ValueError(f'{key} 缺失。')
    if point.get('executionMode') != 'manual_segments':
        raise ValueError('此导入器仅接受分段采集任务，不能混合其他采集模式。')
    if (manifest.get('status') != 'complete' or manifest.get('unit') != 'm/s' or
            task_record.get('dataState') != 'csv'):
        raise ValueError('仅导入已完成、具有完整 CSV 的速度记录。')
    samples, rate, origin = (manifest.get(k) for k in ('samples', 'sampleRate', 'sampleOrigin'))
    if type(samples) is not int or not 0 < samples <= MAX_SAMPLES:
        raise ValueError('原始样本数超限或无效。')
    for number in (rate, origin, manifest.get('startedAt'), manifest.get('endedAt'), point.get('radiusM'), point.get('azimuthDeg')):
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
            raise ValueError('采样率、时间或点位数值无效。')
    if rate <= 0 or point['radiusM'] <= 0 or not 0 <= point['azimuthDeg'] < 360:
        raise ValueError('采样率或点位数值超出范围。')
    recording_rssi_stride(manifest)
    top = {'recordingId': 'id', 'name': 'name', 'windFarm': 'windFarm', 'turbine': 'turbine',
           'object': 'object', 'samples': 'samples', 'sampleRate': 'sampleRate', 'status': 'status',
           'startedAt': 'startedAt', 'endedAt': 'endedAt', 'error': 'error'}
    cycle = {'bladeId': 'bladeId', 'point': 'radialPointName', 'radialPointId': 'radialPointId',
             'radiusM': 'radiusM', 'executionMode': 'executionMode', 'sessionId': 'sessionId',
             'station': 'stationIndex', 'lap': 'lapIndex', 'azimuthDeg': 'azimuthDeg',
             'completion': 'completion', 'stationCount': 'stationCount'}
    if any(task_record.get(a) != manifest.get(b) for a, b in top.items()):
        raise ValueError('任务清单与 manifest 的记录身份或采样信息不一致。')
    if any(task_record.get(a) != point.get(b) for a, b in cycle.items()):
        raise ValueError('任务清单与 manifest 的叶片点位信息不一致。')


def build_plan(paths, name):
    if not isinstance(name, str) or not name.strip() or len(name) > 180:
        raise ValueError('请提供 1～180 字的合并任务名。')
    packages, records, hashes, original_ids = [], [], set(), set()
    identity, point_packages, point_names = None, {}, {}
    for path in sorted({Path(p).resolve() for p in paths}, key=str):
        package_hash = sha_file(path)
        if package_hash in hashes:
            continue
        hashes.add(package_hash)
        with zipfile.ZipFile(path) as archive:
            names = checked_members(archive)
            task = json_member(archive, 'task.json')
            task_records = task.get('records')
            if (task.get('format') != 'blade-vms-task-export-1' or not isinstance(task_records, list) or
                    not task_records or task.get('recordCount') != len(task_records)):
                raise ValueError('不支持的任务导出格式或记录数不一致。')
            package_points, manifests = set(), set()
            for entry in task_records:
                if not isinstance(entry, dict) or entry.get('manifest') not in names or entry.get('waveform') not in names:
                    raise ValueError('任务清单中的 manifest/CSV 文件缺失。')
                if archive.getinfo(entry['waveform']).file_size > MAX_CSV_BYTES:
                    raise ValueError('CSV 文件超出导入容量。')
                manifest = json_member(archive, entry['manifest'])
                validate_manifest(entry, manifest)
                cycle = manifest['pointCycle']
                expected_task_identity = ['collection', cycle['collectionId'], manifest.get('windFarm', ''),
                                          manifest.get('turbine', ''), manifest.get('object', '')]
                if task.get('taskIdentity') is not None and task['taskIdentity'] != expected_task_identity:
                    raise ValueError('任务根信息与记录的 collection/风场/风机不一致。')
                current = tuple(manifest.get(k, '') for k in ('windFarm', 'turbine', 'object')) + (cycle['bladeId'],)
                if identity is None:
                    identity = current
                if identity != current:
                    raise ValueError('只能合并同一风场、风机、测量对象和叶片的记录。')
                radial = (cycle['radialPointId'], cycle['radialPointName'], cycle['radiusM'])
                if radial[0] in point_packages and point_packages[radial[0]] != package_hash:
                    raise ValueError('不同导出包包含同一测点，不能自动合并或覆盖。')
                if radial[1] in point_names and point_names[radial[1]] != radial:
                    raise ValueError('测点名称相同但编号或半径不一致。')
                point_names[radial[1]] = radial
                point_packages[radial[0]] = package_hash
                package_points.add(radial)
                if manifest['id'] in original_ids or entry['manifest'] in manifests:
                    raise ValueError('导出包中存在重复原始记录。')
                original_ids.add(manifest['id']); manifests.add(entry['manifest'])
                records.append({'path': path, 'packageHash': package_hash, 'entry': entry, 'manifest': manifest})
            if len(package_points) != 1:
                raise ValueError('每个导出包必须对应一个独立的径向测点。')
            archive_manifests = {n for n in names if n.endswith('/manifest.json')}
            if archive_manifests != manifests:
                raise ValueError('任务清单没有完整列出包中的记录。')
            packages.append({'file': path.name, 'sha256': package_hash, 'recordCount': len(task_records)})
    if not records:
        raise ValueError('未提供可导入的任务包。')
    collection = digest_identity(VERSION, name, sorted(hashes), identity)
    for record in records:
        record['id'] = digest_identity(VERSION, collection, record['manifest']['id'], record['packageHash'])
    return {'name': name, 'collectionId': collection, 'identity': identity, 'packages': packages, 'records': records}


def read_and_write_csv(archive, source, destination, manifest):
    """Stream bounded batches; CSV indices remain recording-local."""
    digest, expected, chunks, overrange, missing, not_sampled = hashlib.sha256(), 0, 0, 0, 0, 0
    rate, origin = manifest['sampleRate'], manifest['sampleOrigin']
    stride = recording_rssi_stride(manifest)
    with archive.open(source) as stream:
        # Reading bytes explicitly makes the preserved CSV digest exact (including CRLF).
        class Lines:
            def __iter__(self): return self
            def __next__(self):
                line = stream.readline(MAX_JSON_BYTES + 1)
                if not line: raise StopIteration
                if len(line) > MAX_JSON_BYTES:
                    raise ValueError('CSV 单行长度超过允许范围。')
                digest.update(line)
                return line.decode('utf-8-sig' if expected == 0 else 'utf-8')
        lines = iter(Lines())
        first = next(lines)
        if not first.startswith('# BladeVMS '):
            raise ValueError('CSV 缺少 BladeVMS 元数据。')
        meta = json.loads(first[len('# BladeVMS '):])
        if meta.get('format') != 'blade-vms-csv-1' or meta.get('recordingId') != manifest['id']:
            raise ValueError('CSV 格式或原始记录 ID 不一致。')
        for key in ('name','source','samples','sampleRate','unit','windFarm','turbine','object','point','pointCycle','sampleOrigin','rssiSampleStride','rssiSampleRate'):
            if meta.get(key) != manifest.get(key):
                raise ValueError(f'CSV 与 manifest 的 {key} 不一致。')
        reader = csv.reader(lines)
        if next(reader) != CSV_COLUMNS:
            raise ValueError('CSV 列定义不一致。')
        batch = []
        def write_batch(batch, first):
            nonlocal chunks
            data = np.zeros(len(batch), dtype=RECORD_DTYPE)
            data['index'] = np.arange(first, first + len(batch), dtype=np.uint64)
            data['velocity'] = [r[0] for r in batch]
            data['rssi'] = [r[1] if r[1] is not None else 0 for r in batch]
            data['flags'] = [r[2] | (2 if r[1] is not None else 0) for r in batch]
            with (destination / f'chunk-{chunks:08d}.bin').open('xb') as target:
                target.write(HEADER.pack(MAGIC, rate, origin, first)); target.write(data.tobytes())
            chunks += 1
        for row in reader:
            if len(row) != 4 or expected >= manifest['samples']:
                raise ValueError('CSV 行或样本数不一致。')
            t, velocity = float(row[0]), float(row[1])
            rssi = float(row[2]) if row[2] != '' else None
            if row[3] not in ('0','1') or not math.isfinite(t) or not math.isfinite(velocity):
                raise ValueError('CSV 速度、时间或质量标记无效。')
            if abs(t - expected/rate) > max(1e-12, 1e-5/rate):
                raise ValueError('CSV 时间轴不连续，不能猜测补样本。')
            if rssi is not None and (not math.isfinite(rssi) or not 0 <= rssi <= 100 or expected % stride):
                raise ValueError('CSV 回波值或采样位置无效。')
            flag = int(row[3]); overrange += flag
            missing += rssi is None
            not_sampled += bool(expected % stride)
            batch.append((velocity,rssi,flag)); expected += 1
            if len(batch) == 65536:
                write_batch(batch, expected-len(batch)); batch.clear()
        if batch: write_batch(batch, expected-len(batch))
    if expected != manifest['samples']:
        raise ValueError('CSV 样本不足。')
    for key, value in (('overrangeSamples',overrange), ('missingRssiSamples',missing)):
        if key in manifest and manifest[key] != value:
            raise ValueError(f'CSV 与 manifest 的 {key} 不一致。')
    return {'chunks': chunks, 'csvSha256': digest.hexdigest(), 'missingRssiSamples': missing,
            'rssiNotSampledVelocitySamples': not_sampled, 'rssiMissingExpectedSamples': missing-not_sampled}


def replace_collection(value, old, new):
    if isinstance(value, dict):
        return {k: new if k == 'collectionId' and v == old else replace_collection(v, old, new) for k,v in value.items()}
    if isinstance(value, list): return [replace_collection(v, old, new) for v in value]
    return value


def import_packages(paths, output, name):
    plan = build_plan(paths, name)
    output = Path(output).absolute()
    if output.is_symlink(): raise ValueError('输出目录不能是符号链接。')
    output.parent.mkdir(parents=True, exist_ok=True)
    # This utility deliberately does not merge into an existing live profile.
    receipt_path = output / 'import-receipt.json'
    if output.exists():
        if not receipt_path.is_file():
            raise ValueError('输出目录已存在且不是本工具创建的导入目录；请选择新目录。')
        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
        if receipt.get('collectionId') != plan['collectionId']:
            raise ValueError('输出目录已属于其他导入任务。')
        expected_ids = sorted(r['id'] for r in plan['records'])
        if sorted(receipt.get('recordingIds', [])) != expected_ids:
            raise ValueError('既有导入记录数或身份不一致。')
        for rid in expected_ids:
            target = output / rid
            if target.is_symlink() or not (target/'manifest.json').is_file():
                raise ValueError('既有导入文件缺失或不安全。')
            meta = json.loads((target/'manifest.json').read_text(encoding='utf-8'))
            if meta.get('id') != rid or meta.get('mergedTask',{}).get('collectionId') != plan['collectionId']:
                raise ValueError('既有导入记录信息不一致。')
            for filename, digest in receipt.get('fileHashes',{}).get(rid,{}).items():
                existing = target / filename
                if existing.is_symlink() or sha_file(existing) != digest:
                    raise ValueError('既有导入记录内容已变化。')
        return {**receipt, 'reused': True}
    staging = Path(tempfile.mkdtemp(prefix='.blade-task-import-', dir=output.parent))
    try:
        store = RecordingStore(staging)
        file_hashes = {}
        for record in plan['records']:
            original = record['manifest']; directory = staging/record['id']; directory.mkdir()
            with zipfile.ZipFile(record['path']) as archive:
                checked_members(archive)
                result = read_and_write_csv(archive, record['entry']['waveform'], directory, original)
            manifest = replace_collection(copy.deepcopy(original), original['pointCycle']['collectionId'], plan['collectionId'])
            manifest.update(id=record['id'], name=name, originalTaskName=name, chunks=result['chunks'],
                            sourceRecordingId=original['id'])
            manifest['importSource'] = {'type': 'blade-vms-task-zip', 'version': VERSION,
                'package': record['path'].name, 'packageSha256': record['packageHash'],
                'csvPath': record['entry']['waveform'], 'csvSha256': result['csvSha256'],
                'originalRecordingId': original['id'], 'originalName': original['name'],
                'originalCollectionId': original['pointCycle']['collectionId'], 'originalTaskName': original.get('originalTaskName'),
                'originalCaptureSessionId': original.get('captureSessionId'),
                'rawCodesAvailable': False, 'rawCodeRepresentation': 'zero-placeholders-not-exported-in-csv',
                'physicalSamplesPreserved': True, 'downsampled': False, 'autoUpload': False}
            # An imported record must never join a live desktop capture tracker.
            # Keep the original acquisition run identity in provenance only.
            manifest.pop('captureSessionId', None)
            manifest['mergedTask'] = {'version': VERSION, 'collectionId': plan['collectionId'],
                'name': name, 'kind': 'logical_group_of_independent_passes', 'continuousMeasurement': False,
                'originalCollectionId': original['pointCycle']['collectionId'],
                'originalSessionId': original['pointCycle']['sessionId']}
            atomic_json(directory/'source-export-manifest.json', original)
            atomic_json(directory/'manifest.json', manifest)
            store.update_index(manifest)
            if store.index_error: raise OSError(store.index_error)
            file_hashes[record['id']] = {p.name:sha_file(p) for p in directory.iterdir() if p.is_file()}
        receipt = {'version': VERSION, 'name': name, 'collectionId': plan['collectionId'],
            'createdAt': time.time(), 'recordingIds': [r['id'] for r in plan['records']],
            'recordCount': len(plan['records']), 'samples': sum(r['manifest']['samples'] for r in plan['records']),
            'packages': plan['packages'], 'identity': plan['identity'], 'fileHashes': file_hashes,
            'autoUpload': False, 'continuousMeasurement': False}
        atomic_json(staging/'import-receipt.json', receipt)
        # No background worker or uploader is started. The destination is a staged store.
        os.rename(staging, output)
        return {**receipt, 'reused': False}
    finally:
        if staging.exists(): shutil.rmtree(staging)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--name',required=True)
    parser.add_argument('packages',nargs='+',type=Path)
    args=parser.parse_args()
    result=import_packages(args.packages,args.output,args.name)
    print(json.dumps({k:v for k,v in result.items() if k!='fileHashes'},ensure_ascii=False,indent=2))


if __name__ == '__main__': main()
