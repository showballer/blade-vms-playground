#!/usr/bin/env python3
"""Extract confirmed blade-pass windows and compare them with legacy P3 data."""
import csv
import json
import math
import statistics
from pathlib import Path


BASE = Path('/Users/jingbo/pro/内工大')
NEW = BASE / '1024-16-13-P3 [未停稳判定测试]-叶片10222016-叶片数据'
REF = BASE / '三点数据' / '3叶中'
OUT = BASE / '1024-16-13-P3_叶片通过振动对比分析'
FS = 250_000.0


def read_new(path):
    with path.open(encoding='utf-8') as f:
        meta = json.loads(f.readline()[len('# BladeVMS '):])
        rows = csv.DictReader(f)
        return meta, list(rows)


def read_reference(path):
    lines = path.read_bytes().decode('gb18030', errors='replace').splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith('#EndHeader')) + 1
    vals = []
    for line in lines[start:]:
        if not line or line.startswith('#'):
            continue
        parts = line.split(',')
        try:
            vals.append(float(parts[2]))
        except (ValueError, IndexError):
            continue
    return vals


def stats(values):
    if not values:
        return {'n': 0}
    rms = math.sqrt(sum(v * v for v in values) / len(values))
    mean = statistics.mean(values)
    return {'n': len(values), 'mean': mean, 'rms': rms,
            'ac_rms': math.sqrt(sum((v - mean) ** 2 for v in values) / len(values)),
            'min': min(values), 'max': max(values),
            'p2p': max(values) - min(values),
            'clip_pct': 100 * sum(abs(v) >= 219.9 for v in values) / len(values)}


def lowpass_biquad(values, cutoff, sample_rate, q):
    omega = 2 * math.pi * cutoff / sample_rate
    alpha = math.sin(omega) / (2 * q)
    c = math.cos(omega)
    a0 = 1 + alpha
    b0, b1, b2 = (1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0
    a1, a2 = -2 * c / a0, (1 - alpha) / a0
    out, z1, z2 = [], 0.0, 0.0
    for x in values:
        y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        out.append(y)
    return out


def common_band_velocity(values):
    # Two Butterworth sections followed by reverse filtering for zero phase.
    filtered = lowpass_biquad(values, 450, FS, 0.5411961)
    filtered = lowpass_biquad(filtered, 450, FS, 1.306563)
    filtered.reverse()
    filtered = lowpass_biquad(filtered, 450, FS, 0.5411961)
    filtered = lowpass_biquad(filtered, 450, FS, 1.306563)
    filtered.reverse()
    return filtered


def fmt(x, digits=3):
    return '' if x is None else f'{x:.{digits}f}'


def main():
    OUT.mkdir(exist_ok=True)
    source_root = NEW / '数据/叶片_10222016/测点_P3/分段采集'
    segments, joined_velocity, joined_acc = [], [], []
    for manifest_path in sorted(source_root.glob('点位*/批次*/manifest.json')):
        m = json.loads(manifest_path.read_text())
        pc = m['pointCycle']
        c = pc['continuousSession']
        h = pc['handoff']
        point = pc['stationIndex']
        csv_path = manifest_path.parent / 'waveform.csv'
        meta, rows = read_new(csv_path)
        local_entry = h['entryConfirmedSampleIndex'] + 1 - c['sampleStart']
        local_exit = h['exitSampleIndex'] - c['sampleStart']
        valid = 0 <= local_entry < local_exit <= len(rows)
        info = {'point': point, 'angle': pc['azimuthDeg'], 'source': str(csv_path),
                'sample_start': c['sampleStart'], 'sample_end_exclusive': c['sampleEndExclusive'],
                'entry_confirmed_raw': h['entryConfirmedSampleIndex'], 'exit_raw': h['exitSampleIndex'],
                'local_start': local_entry, 'local_end_exclusive': local_exit,
                'samples_saved': len(rows), 'extractable': valid}
        if valid:
            selected = rows[local_entry:local_exit]
            full_t = [float(r['time_s']) for r in selected]
            full_v = [float(r['velocity_m_s']) for r in selected]
            rssi = [float(r['RSSI_percent']) for r in selected]
            filtered = common_band_velocity(full_v)
            # Align all excerpts to the same 1 kHz grid using their raw sample index.
            stride = round(FS / 1000)
            first = next((i for i in range(len(filtered)) if (c['sampleStart'] + local_entry + i) % stride == 0), None)
            ids = list(range(first, len(filtered), stride)) if first is not None else []
            t = [full_t[i] for i in ids]
            v = [filtered[i] for i in ids]
            rssi = [rssi[i] for i in ids]
            a = [0.0] * len(v)
            for i in range(1, len(v) - 1):
                a[i] = (v[i + 1] - v[i - 1]) / 0.002
            if len(v) > 1:
                a[0] = (v[1] - v[0]) / 0.001
                a[-1] = (v[-1] - v[-2]) / 0.001
            info['duration_s'] = (len(ids) - 1) / 1000 if len(ids) > 1 else 0
            info['velocity'] = stats(v)
            info['acceleration_derived'] = stats(a)
            info['rssi_min'] = min(rssi)
            info['rssi_max'] = max(rssi)
            joined_velocity.extend(v)
            joined_acc.extend(a)
            out_csv = OUT / f'P3_角度{int(pc["azimuthDeg"])}_通过片段.csv'
            with out_csv.open('w', newline='', encoding='utf-8-sig') as f:
                w = csv.writer(f)
                w.writerow(['segment_time_s', 'velocity_m_s', 'acceleration_derived_m_s2', 'RSSI_percent', 'source_sample_index'])
                for j, (tt, vv, aa, rr, raw_i) in enumerate(zip(t, v, a, rssi, ids)):
                    w.writerow([f'{j/1000:.9f}', f'{vv:.12g}', f'{aa:.9g}', f'{rr:.7g}', c['sampleStart'] + local_entry + raw_i])
        segments.append(info)

    refs = []
    for path in sorted(REF.glob('*.CSV')):
        x = read_reference(path)
        s = stats(x)
        refs.append({'file': path.name, **s})

    with (OUT / '片段来源与指标.csv').open('w', newline='', encoding='utf-8-sig') as f:
        fields = ['point', 'angle', 'extractable', 'samples_saved', 'sample_start', 'sample_end_exclusive',
                  'entry_confirmed_raw', 'exit_raw', 'local_start', 'local_end_exclusive', 'duration_s',
                  'velocity_rms_m_s', 'derived_acc_rms_m_s2', 'derived_acc_p2p_m_s2', 'rssi_min', 'rssi_max', 'source']
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for s in segments:
            w.writerow({**{k: s.get(k) for k in fields},
                        'velocity_rms_m_s': s.get('velocity', {}).get('rms'),
                        'derived_acc_rms_m_s2': s.get('acceleration_derived', {}).get('ac_rms'),
                        'derived_acc_p2p_m_s2': s.get('acceleration_derived', {}).get('p2p')})
    with (OUT / '三点数据_3叶中指标.csv').open('w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['file', 'n', 'mean', 'rms', 'ac_rms', 'min', 'max', 'p2p', 'clip_pct'])
        w.writeheader()
        w.writerows(refs)

    report = [
        '# P3 叶片通过振动数据对比', '',
        '## 处理方法',
        '- 新数据按 `pointCycle.continuousSession.sampleStart` 映射连续采集时钟，裁剪范围为 `[entryConfirmedSampleIndex + 1, exitSampleIndex)`。',
        '- 按角度顺序拼接可恢复片段；各片段之间存在人工换点停顿，拼接结果只表示叶片通过波形集合，不代表连续整圈。',
        '- 新数据速度单位为 m/s。先对速度作 450 Hz 低通，再按 1 kHz 抽取并差分为加速度；参考数据为 1 kHz 加速度，原始量程 ±220 m/s²。',
        '', '## 提取结果', '', '| 角度 | 提取 | 点数 | 时长(ms) | 加速度 AC RMS (m/s²) | 加速度峰峰值 (m/s²) |', '|---:|---:|---:|---:|---:|---:|'
    ]
    for s in segments:
        a = s.get('acceleration_derived', {})
        report.append(f"| {s['angle']:.0f}° | {'是' if s['extractable'] else '否'} | {a.get('n', 0)} | {s.get('duration_s', 0)*1000:.2f} | {fmt(a.get('ac_rms'))} | {fmt(a.get('p2p'))} |")
    report += ['', '## 参考数据（3叶中）', '', '| 文件 | 样本 | AC RMS (m/s²) | 峰峰值 (m/s²) | 削顶比例 (%) |', '|---|---:|---:|---:|---:|']
    for s in refs:
        report.append(f"| {s['file']} | {s['n']} | {fmt(s['ac_rms'])} | {fmt(s['p2p'])} | {fmt(s['clip_pct'], 4)} |")
    report += ['', '## 结论与限制',
        '- 90°记录在保存波形中的连续采样区间晚于已确认的进入/离开边界，二者无重叠，因此该段无法从现存 waveform.csv 恢复，未做插值或补造。',
        '- `3叶中` 六个文件各为 60,000 点、1 kHz；它们覆盖约 60 s，而新数据仅保留若干 50–90 ms 的叶片通过片段。工况与时间未同步，整体 RMS 不能作为严格同工况差值。',
        '- 新数据在 450 Hz 低通后对齐到 1 kHz 采样，以便和参考数据采用共同可分析频带；加速度差分与短窗口边缘滤波仍会带来误差。',
        '- 参考信号有样本触及 ±220 m/s² 的量程边界，峰值、峰峰值和 RMS 可能受削顶压低。新数据标记为 `diagnosticOnly=true`、`validMeasurement=false`，结论仅作诊断对照。',
        '', '输出片段文件按角度命名；`片段来源与指标.csv` 含原始连续样本索引。']
    (OUT / '分析报告.md').write_text('\n'.join(report), encoding='utf-8')

    # Joined collection-order waveform with source-boundary labels.
    with (OUT / '可提取叶片通过速度拼接.csv').open('w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['joined_time_s', 'velocity_m_s', 'acceleration_derived_m_s2', 'segment_angle_deg', 'source_sample_index'])
        offset = 0.0
        for s in segments:
            if not s['extractable']:
                continue
            p = OUT / f"P3_角度{int(s['angle'])}_通过片段.csv"
            with p.open(encoding='utf-8-sig') as sf:
                rr = csv.DictReader(sf)
                rows = list(rr)
            for r in rows:
                w.writerow([f"{offset+float(r['segment_time_s']):.9f}", r['velocity_m_s'], r['acceleration_derived_m_s2'], s['angle'], r['source_sample_index']])
            if rows:
                offset += float(rows[-1]['segment_time_s']) + 0.001
    print(OUT)


if __name__ == '__main__':
    main()
