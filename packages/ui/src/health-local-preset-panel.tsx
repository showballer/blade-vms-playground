"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, ArrowUpRight, Activity } from 'lucide-react';
import { api } from './api';
import { Button, Dialog, Tag } from './common';
import { Chart } from './charts';
import { localResponsePreview, type LocalHealthPreset } from './health-local-preset';

export function LocalHealthConclusion({ preset, blade, onWaveform, onDetails }: {
  preset: LocalHealthPreset; blade: any; onWaveform: () => void; onDetails: () => void;
}) {
  const damaged = preset.status === 'damage', Icon = damaged ? ShieldAlert : ShieldCheck;
  const point = blade.coverage?.points?.find((p: any) => p.pointName === preset.point);
  return <section className={`health-local-conclusion ${preset.status}`} aria-label="叶片状态结论">
    <div className="health-local-conclusion-icon"><Icon size={28} /></div>
    <div className="health-local-conclusion-main">
      <div className="health-local-conclusion-title"><h2>叶片 {blade.name} · {preset.label}</h2><Tag tone="gray">{preset.source}</Tag></div>
      <p>{preset.title}{damaged && point?.radiusM != null ? ` · 距旋转中心 ${point.radiusM} m` : ''}</p>
      <span className="hint">{damaged ? '查看 P3 的局部增强响应，并与原曲线对比。' : `已载入 ${blade.coverage?.analyzable ?? 0} 条可分析记录。`}</span>
    </div>
    <div className="health-local-conclusion-actions">
      {damaged && <Button variant="danger" onClick={onWaveform}><Activity size={16} />查看局部响应</Button>}
      <Button onClick={onDetails}>查看实测依据<ArrowUpRight size={16} /></Button>
    </div>
  </section>;
}

export function LocalHealthWaveform({ jobId, bladeCode, point, onClose }: {
  jobId: string; bladeCode: string; point: string; onClose: () => void;
}) {
  const [curves, setCurves] = useState<any[]>([]), [angle, setAngle] = useState('');
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true; const controller = new AbortController();
    setBusy(true); setError(''); setCurves([]); setAngle('');
    api<any>('measurements/processing', 'POST', { request: { action: 'waveforms', jobId } }, controller.signal)
      .then(data => {
        if (!current) return;
        const matches = (data.curves || []).filter((c: any) => String(c.object?.blade) === bladeCode && c.object?.point === point)
          .sort((a: any, b: any) => a.object.azimuth_deg - b.object.azimuth_deg);
        setCurves(matches); setAngle(matches.length ? String(matches[0].object.azimuth_deg) : '');
      }).catch(e => { if (current) setError(e.message); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; controller.abort(); };
  }, [jobId, bladeCode, point, attempt]);
  const curve = curves.find(c => String(c.object.azimuth_deg) === angle);
  const preview = useMemo(() => curve ? localResponsePreview(curve.time_s, curve.velocity_m_s) : null, [curve]);
  return <Dialog title={`叶片 ${bladeCode} · ${point} 局部响应`} wide onClose={onClose}>
    <div className="health-local-waveform-heading"><Tag tone="amber">预设局部响应</Tag><nav className="measurement-tabs" aria-label="波形角度">
      {[...new Set(curves.map(c => String(c.object.azimuth_deg)))].map(a => <button key={a} className={angle === a ? 'active' : ''} onClick={() => setAngle(a)}>{a}°</button>)}
    </nav></div>
    {error && <div role="alert">{error}<Button onClick={() => setAttempt(v => v + 1)}>重新加载</Button></div>}
    {!busy && !error && !preview && <p>此点暂无可用的连续波形，请先保存处理结果。</p>}
    <Chart label="原曲线与预设局部响应对比" loading={busy} height={360} option={{
      tooltip: { trigger: 'axis' }, legend: { top: 0, data: ['原曲线', '预设局部响应'] },
      grid: { left: 76, right: 32, top: 64, bottom: 80 },
      xAxis: { type: 'value', name: '片段时间 / ms', nameLocation: 'middle', nameGap: 28 },
      yAxis: { type: 'value', name: '速度 / mm/s' },
      dataZoom: [{ type: 'slider', bottom: 0, height: 22 }],
      series: preview ? [
        { name: '原曲线', type: 'line', showSymbol: false, lineStyle: { color: '#94a3b8', width: 1.5 }, itemStyle: { color: '#94a3b8' }, data: preview.time.map((t, i) => [(t - preview.time[0]) * 1000, curve.velocity_m_s[i] * 1000]) },
        { name: '预设局部响应', type: 'line', showSymbol: false, lineStyle: { color: '#dc4457', width: 1.5 }, itemStyle: { color: '#dc4457' }, data: preview.time.map((t, i) => [(t - preview.time[0]) * 1000, preview.values[i] * 1000]),
          markArea: { silent: true, itemStyle: { color: 'rgba(220,68,87,.08)' }, label: { show: false }, data: [[{ xAxis: (preview.start - preview.time[0]) * 1000 }, { xAxis: (preview.end - preview.time[0]) * 1000 }]] } },
      ] : [],
    }} />
    {preview && <div className="health-local-waveform-metrics"><span>局部原曲线 RMS <strong>{(preview.originalRms * 1000).toFixed(2)} mm/s</strong></span><span>局部预设 RMS <strong>{(preview.previewRms * 1000).toFixed(2)} mm/s</strong></span></div>}
    <p className="hint">红线仅在选中区间增强波动，不写回采集记录，也不作为正式损伤判定依据。</p>
  </Dialog>;
}
