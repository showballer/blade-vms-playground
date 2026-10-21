#!/usr/bin/env python3
"""Read-only recorded-data regression. Uses a fake SDK; never loads vendor code.

Example:
 services/acquisition/.venv/bin/python scripts/replay-station-session.py \
   --recordings '/path/to/field-data/recordings' --date 2026-10-20 --hour 21 \
   --output artifacts/station-session-replay-20261021
"""
import argparse
import collections
import ctypes
import datetime
import hashlib
import json
import socket
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'services/acquisition'), str(ROOT/'services/acquisition/tests')]
from blade_acquisition.storage import HEADER, RECORD
from blade_acquisition.rssi_handoff import RssiHandoff
from test_station_session import PacketSdk, receiver_for


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load_samples(m, chunks, before):
    samples = []
    for chunk in chunks:
        before[chunk] = digest(chunk)
        with chunk.open('rb') as stream:
            magic, rate, origin, start = HEADER.unpack(stream.read(HEADER.size))
            assert magic == b'BLADEV01' and rate == m['sampleRate'] and start == len(samples)
            for index, raw_v, value, raw_r, rssi, flags in RECORD.iter_unpack(stream.read()):
                assert index == len(samples) and flags & 2
                samples.append((raw_v, raw_r, flags))
    assert len(samples) == m['samples']
    return samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recordings', type=Path, required=True)
    parser.add_argument('--date', type=datetime.date.fromisoformat, required=True)
    parser.add_argument('--hour', type=int, default=21)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = args.recordings.resolve()
    output = args.output.resolve()
    if output == source or source in output.parents:
        raise ValueError('Output must be outside the original recordings directory')
    selected, skipped, before = [], [], {}
    for path in source.glob('*/manifest.json'):
        m = json.loads(path.read_text())
        when = datetime.datetime.fromtimestamp(m['startedAt'], datetime.timezone(datetime.timedelta(hours=8)))
        if when.date() != args.date or when.hour < args.hour or not m.get('pointCycle'):
            continue
        if m['status'] != 'complete':
            skipped.append({'id': m['id'], 'status': m['status'], 'error': m.get('error')})
            continue
        before[path] = digest(path)
        chunks = sorted(path.parent.glob('chunk-*.bin'))
        selected.append((m, chunks))
    selected.sort(key=lambda item: item[0]['startedAt'])
    groups = collections.defaultdict(list)
    for m, samples in selected:
        groups[m['pointCycle']['sessionId']].append((m, samples))
    results, lifecycle = [], []
    # An accidental future regression cannot turn this script into hardware IO.
    with patch.object(ctypes, 'CDLL', side_effect=AssertionError('Offline test cannot load a DLL')), \
         patch.object(socket, 'socket', side_effect=AssertionError('Offline test cannot open a socket')):
        for session, paths in groups.items():
            group = [(m, load_samples(m, chunks, before)) for m, chunks in paths]
            sdk = PacketSdk([samples for m, samples in group], int(group[0][0]['sampleRate']))
            headroom = group[0][0]['acquisition']['headroomDigitalOut']
            def read_float(*arguments):
                arguments[-1]._obj.value = headroom
                return 0
            sdk.PolySendGetFloat = read_float
            receiver = receiver_for(sdk)
            receiver.reuse_session = True
            receiver.prepare_session()
            try:
                for m, original in group:
                    assert m['sampleRate'] == sdk.velocity_rate
                    assert m['acquisition']['headroomDigitalOut'] == headroom
                    sdk.incoming = [(987654321, 511, 0)] * 5000  # stale/movement buffer
                    gate = RssiHandoff(SimpleNamespace(**m['turntable']['config']), 0)
                    stop = threading.Event()
                    consumed = 0
                    def receive(batch):
                        nonlocal consumed
                        assert batch.sample_start == consumed
                        expected = original[consumed:consumed+len(batch.values)]
                        assert batch.velocity_raw == [row[0] for row in expected]
                        assert batch.rssi_raw == [row[1] for row in expected]
                        assert batch.overrange == [bool(row[2] & 1) for row in expected]
                        consumed += len(batch.values)
                        gate.feed(batch)
                        if gate.trigger:
                            stop.set()
                        elif consumed == len(original):
                            raise AssertionError(f"No exit trigger for saved complete record {m['id']}")
                    receiver.run(stop, lambda *_: None, receive, keep_laser_on=True)
                    expected = m['pointCycle']['handoff']
                    assert gate.trigger is not None and gate.trigger['sampleIndex'] == expected['sampleIndex'], m['id']
                    assert gate.trigger['entrySampleIndex'] == expected['entrySampleIndex'], m['id']
                    assert gate.status['signalGapCount'] == 0
                    assert not sdk.active
                    results.append({'id': m['id'], 'task': m['name'], 'point': m['pointCycle']['radialPointName'],
                                    'azimuth': m['pointCycle']['azimuthDeg'], 'sourceSamples': len(original),
                                    'consumedSamples': consumed, 'entrySampleIndex': gate.trigger['entrySampleIndex'],
                                    'exitTriggerSampleIndex': gate.trigger['sampleIndex'], 'matches': True,
                                    'sampleIndicesRestartAtZero': True, 'movingBufferExcluded': True})
            finally:
                receiver.close_session(keep_laser_on=True)
            assert sdk.opens == 1 and sdk.events.count('start') == len(group)
            lifecycle.append({'session': session, 'points': len(group), 'daqOpens': sdk.opens,
                              'stationStarts': sdk.events.count('start'), 'stationStops': sdk.events.count('stop') - 1,
                              'daqCloses': sdk.closed.count('acquisition')})
    unchanged = all(digest(path) == checksum for path, checksum in before.items())
    assert unchanged
    report = {'mode': 'offline raw replay with SDK fixture; not measured hardware latency',
              'date': str(args.date), 'afterHour': args.hour, 'recordsPassed': len(results),
              'sourceSamples': sum(r['sourceSamples'] for r in results), 'sessions': len(groups),
              'oldDaqOpens': len(results), 'newDaqOpens': sum(r['daqOpens'] for r in lifecycle),
              'inputFilesSha256Unchanged': unchanged, 'inputFiles': len(before),
              'skipped': skipped, 'lifecycle': lifecycle, 'records': results}
    output.mkdir(parents=True, exist_ok=True)
    (output/'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ('records', 'lifecycle')}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
