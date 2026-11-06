"use client";
import React, { useRef, useState } from 'react';
import { Button, Card } from './common';
import { modalCsv, modalMappedInput, modalUnits } from './modal-input';
import type { FieldRequestOptions } from './field-types';
type Props = { request: <T>(v: FieldRequestOptions) => Promise<T>; method: string; onSaved: (dataset: any) => void };
export function FieldModalImport({ request, method, onSaved }: Props) {
  const file = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<any>(null), [name, setName] = useState(''), [calibration, setCalibration] = useState('');
  const [clock, setClock] = useState(''), [release, setRelease] = useState(''), [ambient, setAmbient] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const channelsFor = (columns: string[], time: number) => columns.flatMap((v, i) => i === time ? [] : [{ id: 'ch' + i, column: i, pointId: v, quantity: method === 'frf' && i === (time === 0 ? 1 : 0) ? 'force' : 'velocity', direction: '', scale: 1 }]);
  async function read(input?: File) {
    if (!input) return;
    setError(''); setDraft(null);
    try {
      if (input.size > 20 * 1024 * 1024) throw Error('单份文件上限 20 MiB');
      const text = await input.text(); setName(input.name.replace(/\.(csv|json)$/i, ''));
      if (/\.json$/i.test(input.name)) {
        const json = JSON.parse(text);
        if (json.schemaVersion !== 'modal-input-1') throw Error('JSON 需为 modal-input-1，保留原始来源和通道元数据');
        setDraft({ json });
      } else {
        const parsed = modalCsv(text); setDraft({ ...parsed, timeIndex: 0, channels: channelsFor(parsed.columns, 0) });
      }
    } catch (e) { setError((e as Error).message); }
  }
  async function save() {
    setBusy(true); setError('');
    try {
      if (!name.trim()) throw Error('请填写批次名称');
      const dataset = modalMappedInput(draft, { synchronization: clock.trim() ? 'common_sample_clock' : undefined, clockSource: clock.trim(), excitationRemoved: !!release.trim(), excitationRemovalSource: release.trim(), ambientExcitationAssumption: !!ambient.trim(), excitationAssumptionSource: ambient.trim() }, calibration);
      const saved = await request<any>({ action: 'formalModal', request: { operation: 'import', parameters: { name: name.trim(), dataset } } });
      setDraft(null); onSaved(saved);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function template() {
    const header = method === 'frf' ? 'time_s,force_N,P1_velocity_m_s' : method === 'ssi_cov' ? 'time_s,P1_velocity_m_s,P2_velocity_m_s,P3_velocity_m_s,P4_velocity_m_s,P5_velocity_m_s' : 'time_s,P1_velocity_m_s';
    const url = URL.createObjectURL(new Blob(['\uFEFF' + header + '\n'], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = '模态采集_' + method + '_通道模板.csv'; a.click(); URL.revokeObjectURL(url);
  }
  const update = (i: number, patch: any) => setDraft({ ...draft, channels: draft.channels.map((c: any, j: number) => j === i ? { ...c, ...patch } : c) });
  return <Card title="同步采集数据接入">
    <p>按所选试验方式记录连续数据，同步通道放在同一行。时间以秒计，通道值换算为 SI 单位；仅在确认共享采样时钟后填写同步依据。衰减法文件应从激励撤除后开始。</p>
    <div className="field-modal-capture-actions"><Button disabled={busy} onClick={() => file.current?.click()}>导入采集文件 CSV / JSON</Button><Button onClick={template}>下载通道模板</Button><input ref={file} type="file" accept=".csv,.json" hidden onChange={e => { void read(e.target.files?.[0]); e.target.value = ''; }} /></div>
    {draft && <><div className="field-modal-capture-fields"><label>批次名称<input value={name} onChange={e => setName(e.target.value)} /></label>
      {draft.json ? <p>按文件内的时间、通道、标定和来源信息保存，服务端将校验输入。</p> : <>
        <label>时间列 · 秒<select value={draft.timeIndex} onChange={e => { const t = Number(e.target.value); setDraft({ ...draft, timeIndex: t, channels: channelsFor(draft.columns, t) }); }}>{draft.columns.map((c: string, i: number) => <option key={i} value={i}>{c}</option>)}</select></label>
        <label>标定依据<input value={calibration} onChange={e => setCalibration(e.target.value)} placeholder="仪器标定记录、量程及单位" /></label>
        <label>同步时钟依据 · FRF / SSI<input value={clock} onChange={e => setClock(e.target.value)} placeholder="共享时钟、硬件同步方式和记录编号" /></label>
        <label>激励撤除记录 · 自由衰减<input value={release} onChange={e => setRelease(e.target.value)} placeholder="释放时刻、边界条件与截取依据" /></label>
        <label>环境激励与平稳性依据 · SSI<input value={ambient} onChange={e => setAmbient(e.target.value)} /></label>
      </>}
    </div>
    {!draft.json && <><p>{draft.rows.length.toLocaleString()} 个连续样本 · {draft.channels.length} 个通道；单位系数示例：mm/s → m/s 填 0.001。</p>
      {draft.channels.map((c: any, i: number) => <div className="field-modal-capture-fields" key={c.id}>
        <label>{draft.columns[c.column]} · 测点<input value={c.pointId} onChange={e => update(i, { pointId: e.target.value })} /></label>
        <label>物理量与目标单位<select value={c.quantity} onChange={e => update(i, { quantity: e.target.value })}>{Object.entries(modalUnits).map(([q, unit]) => <option key={q} value={q}>{q} · {unit}</option>)}</select></label>
        <label>测量方向<input value={c.direction} onChange={e => update(i, { direction: e.target.value })} placeholder="如 axial / flapwise" /></label>
        <label>原值乘以系数 → SI<input type="number" min="0" step="any" value={c.scale} onChange={e => update(i, { scale: Number(e.target.value) })} /></label>
      </div>)}
    </>}
    <div className="field-modal-capture-actions"><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? '正在校验保存' : '校验并保存批次'}</Button><Button disabled={busy} onClick={() => setDraft(null)}>取消</Button></div></>}
    {error && <p role="alert" className="field-error">{error}</p>}
  </Card>;
}
