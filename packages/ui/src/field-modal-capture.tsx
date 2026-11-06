"use client";
import React, { useEffect, useRef, useState } from 'react';
import { Activity, Play, Square } from 'lucide-react';
import { Button, Card } from './common';
import { Chart } from './charts';
import { modalCaptureDefaults, modalCapturePlanError, type ModalCaptureMethod, type ModalCapturePlan } from './modal-capture-plan';
import type { FieldRequestOptions } from './field-types';
type Props = { method: ModalCaptureMethod; request: <T>(v: FieldRequestOptions) => Promise<T>; onSaved: (dataset: any) => void; onActive: (active: boolean) => void };
const stateNames: Record<string, string> = { idle: '等待采集', connecting: '正在连接设备', acquiring: '正在同步采集', stopping: '正在停止', saving: '正在保存批次', complete: '采集已保存', error: '采集失败' };
const isActive = (state?: string) => ['connecting', 'acquiring', 'stopping', 'saving'].includes(state || '');
const quantities = { velocity: '振动速度 · m/s', displacement: '位移 · m', acceleration: '加速度 · m/s²' };
export function FieldModalCapture({ method, request, onSaved, onActive }: Props) {
  const storageKey = 'blade.modal.capture.' + method;
  const [plan, setPlan] = useState<ModalCapturePlan>(() => {
    const defaults = modalCaptureDefaults(method);
    try { const value = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (value?.method === method && Array.isArray(value.channels)) return { ...defaults, ...value, conditionsConfirmed: false }; } catch { /* optional local draft */ }
    return defaults;
  });
  const [status, setStatus] = useState<any>(null), [pending, setPending] = useState(false), [error, setError] = useState('');
  const completed = useRef(''), generation = useRef(0), mutation = useRef(0), lastState = useRef('idle');
  const callbacks = useRef({ onSaved, onActive }); callbacks.current = { onSaved, onActive };
  const active = isActive(status?.state), locked = active || pending;
  function accept(data: any) {
    lastState.current = data.state; setStatus(data); callbacks.current.onActive(isActive(data.state));
    if (data.state === 'complete' && data.dataset && completed.current !== data.id) { completed.current = data.id; callbacks.current.onSaved(data.dataset); }
  }
  useEffect(() => {
    let stale = false, timer: ReturnType<typeof setTimeout>;
    const token = ++generation.current;
    async function poll() {
      const epoch = mutation.current;
      try { const data = await request<any>({ action: 'formalModal', request: { operation: 'capture-status' } }); if (!stale && token === generation.current && epoch === mutation.current) accept(data); }
      catch (e) { if (!stale) setError((e as Error).message); }
      if (!stale) timer = setTimeout(poll, 1000);
    }
    void poll(); return () => { stale = true; clearTimeout(timer); };
  }, [request]);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify({ ...plan, conditionsConfirmed: false })); } catch { /* raw data uses service storage */ } }, [plan, storageKey]);
  async function start() {
    const invalid = modalCapturePlanError(plan); if (invalid) { setError(invalid); return; }
    setPending(true); callbacks.current.onActive(true); setError(''); ++mutation.current;
    try { const data = await request<any>({ action: 'formalModal', request: { operation: 'capture-start', parameters: plan } }); ++mutation.current; accept(data); }
    catch (e) { setError((e as Error).message); } finally { ++mutation.current; setPending(false); callbacks.current.onActive(isActive(lastState.current)); }
  }
  async function stop() {
    setPending(true); callbacks.current.onActive(true); setError(''); ++mutation.current;
    try { const data = await request<any>({ action: 'formalModal', request: { operation: 'capture-stop', parameters: { sessionId: status.id } } }); ++mutation.current; accept(data); }
    catch (e) { setError((e as Error).message); } finally { ++mutation.current; setPending(false); callbacks.current.onActive(isActive(lastState.current)); }
  }
  const updateChannel = (i: number, patch: any) => setPlan(p => ({ ...p, channels: p.channels.map((c, j) => i === j ? { ...c, ...patch } : c) }));
  const quantity = plan.channels.find(c => c.quantity !== 'force')?.quantity || 'velocity';
  const shownPlan = active ? status.plan : plan;
  const liveChannels = status?.plan?.channels || plan.channels;
  const option = { animation: false, tooltip: { trigger: 'axis' }, legend: { top: 0 }, grid: { left: 65, right: 65, top: 40, bottom: 42 },
    xAxis: { type: 'value', name: '采集时间 / s', nameLocation: 'middle', nameGap: 26 },
    yAxis: [{ type: 'value', name: quantities[quantity as keyof typeof quantities]?.split(' · ')[1] || '响应' }, { type: 'value', name: '力 / N', show: status?.plan?.method === 'frf', splitLine: { show: false } }],
    series: liveChannels.map((c: any, i: number) => ({ name: c.pointId + ' · ' + c.hardwareChannel, type: 'line', showSymbol: false, yAxisIndex: c.quantity === 'force' ? 1 : 0, data: (status?.preview || []).map((r: any) => [r.time_s, r.values[i]]) })) };
  return <Card title={method === 'frf' ? 'FRF 同步采集配置' : 'SSI-COV 多测点同步采集配置'}>
    <div className="field-modal-flow"><span><b>1</b>配置试验</span><span><b>2</b>核对通道</span><span><b>3</b>开始采集</span><span><b>4</b>停止并保存</span></div>
    <fieldset disabled={locked} className="field-modal-capture-fieldset">
      <div className="field-modal-capture-fields">
        <label>试验任务<input value={plan.name} maxLength={120} onChange={e => setPlan({ ...plan, name: e.target.value })} /></label>
        <label>同步采集设备编号<input value={plan.deviceId} maxLength={120} onChange={e => setPlan({ ...plan, deviceId: e.target.value })} placeholder="填写设备对应的编号或名称" /></label>
        <label>风场<input value={plan.context.windFarm} onChange={e => setPlan({ ...plan, context: { ...plan.context, windFarm: e.target.value } })} /></label>
        <label>风机<input value={plan.context.turbine} onChange={e => setPlan({ ...plan, context: { ...plan.context, turbine: e.target.value } })} /></label>
        <label>叶片<select value={plan.context.blade} onChange={e => setPlan({ ...plan, context: { ...plan.context, blade: e.target.value } })}>{['1','2','3'].map(v => <option key={v} value={v}>叶片{v}</option>)}</select></label>
        <label>采样率 · Hz<input type="number" min={10} max={20000} value={plan.sampleRateHz} onChange={e => setPlan({ ...plan, sampleRateHz: Number(e.target.value) })} /></label>
        <label>采集时长 · 秒<input type="number" min={1} max={7200} value={plan.durationSeconds} onChange={e => setPlan({ ...plan, durationSeconds: Number(e.target.value) })} /></label>
        <label>响应物理量<select value={quantity} onChange={e => setPlan({ ...plan, channels: plan.channels.map(c => c.quantity === 'force' ? c : { ...c, quantity: e.target.value, scaleToSI: 1, calibrationSource: '' }) })}>{Object.entries(quantities).map(([q, text]) => <option key={q} value={q}>{text}</option>)}</select></label>
        {method === 'ssi_cov' && <label>同步测点数<select value={plan.channels.length} onChange={e => { const n = Number(e.target.value); setPlan({ ...plan, channels: Array.from({ length: n }, (_, i) => plan.channels[i] || { id: 'ch' + i, hardwareChannel: 'AI' + i, pointId: 'P' + (i + 1), quantity, direction: 'flapwise', calibrationSource: '', scaleToSI: 1 }) }); }}>{Array.from({ length: 15 }, (_, i) => i + 2).map(v => <option key={v} value={v}>{v} 个测点</option>)}</select></label>}
        <label>激励方式<input value={plan.excitation} maxLength={500} onChange={e => setPlan({ ...plan, excitation: e.target.value })} /></label>
        <label>叶片与支撑条件<input value={plan.boundary} maxLength={500} onChange={e => setPlan({ ...plan, boundary: e.target.value })} /></label>
      </div>
      <div className="field-modal-channel-table"><table><thead><tr><th>用途</th><th>硬件通道</th><th>测点</th><th>方向</th><th>标定依据</th><th>原值→SI倍率</th></tr></thead><tbody>{plan.channels.map((c, i) => <tr key={c.id}><td>{c.quantity === 'force' ? '激励力 · N' : '响应'}</td><td><input aria-label={`通道${i + 1}硬件通道`} value={c.hardwareChannel} onChange={e => updateChannel(i, { hardwareChannel: e.target.value })} /></td><td><input aria-label={`通道${i + 1}测点`} value={c.pointId} onChange={e => updateChannel(i, { pointId: e.target.value })} /></td><td><input aria-label={`通道${i + 1}方向`} value={c.direction} onChange={e => updateChannel(i, { direction: e.target.value })} /></td><td><input aria-label={`通道${i + 1}标定依据`} value={c.calibrationSource} placeholder="仪器标定记录或系数来源" onChange={e => updateChannel(i, { calibrationSource: e.target.value })} /></td><td><input aria-label={`通道${i + 1}换算系数`} type="number" min={0} step="any" value={c.scaleToSI} onChange={e => updateChannel(i, { scaleToSI: Number(e.target.value) })} /></td></tr>)}</tbody></table></div>
      <p className="muted">例如：原始单位为 mm/s 时，换算为 m/s 的倍率填 0.001。同步时钟和实际采样率由设备连接后确认。</p>
      <label className="field-modal-confirm"><input type="checkbox" checked={plan.conditionsConfirmed} onChange={e => setPlan({ ...plan, conditionsConfirmed: e.target.checked })} />已核对试验条件、通道连接、方向和标定信息</label>
    </fieldset>
    <p className="field-modal-instructions">{method === 'frf' ? '操作顺序：连接力传感器及响应传感器 → 点击开始采集 → 启动激振并同步记录力与响应 → 到时自动保存，或手动停止并保存。采用足够长的连续宽带激励有利于当前半功率算法解析低频峰宽；短时锤击需另外核对记录时长和频率分辨率。' : '操作顺序：固定各测点传感器并连接同一采样时钟 → 点击开始采集 → 在近似平稳的环境激励下持续记录 → 到时自动保存，或手动停止并保存。各点必须同时采集，不能依次扫描。'}</p>
    <div className="field-modal-capture-actions"><Button variant="primary" disabled={locked} onClick={() => void start()}><Play size={15} />{pending && !active ? '正在连接' : '开始同步采集'}</Button><Button disabled={!active || pending || status?.state === 'saving'} onClick={() => void stop()}><Square size={14} />停止并保存</Button><span role="status">{stateNames[status?.state] || '正在检查设备'} · {status?.capabilities?.deviceState || ''}</span></div>
    {status?.capabilities?.message && !active && <p className="muted">{status.capabilities.message}</p>}
    {(error || status?.error) && <p role="alert" className="field-error">{error || status.error}</p>}
    {status?.id && <div className="field-modal-live"><div className="field-modal-batch-meta"><span><Activity size={13} /> {status.plan?.name}</span><span>{status.samples?.toLocaleString()} 个同步样本 / 通道</span><span>{((status.samples || 0) / (status.plan?.sampleRateHz || 1)).toFixed(1)} / {status.plan?.durationSeconds} 秒</span></div><progress aria-label="模态采集进度" value={status.samples || 0} max={status.plan?.targetSamples || shownPlan.sampleRateHz * shownPlan.durationSeconds} />{status.preview?.length > 0 && <Chart option={option} height={260} label="模态采集实时同步通道" />}{status.state === 'complete' && <p role="status">已保存批次“{status.dataset?.name}”，在“模态识别”的数据批次中选择后查看分析图表。</p>}</div>}
  </Card>;
}
