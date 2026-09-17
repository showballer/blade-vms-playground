"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "./charts";
import { Button } from "./common";
import type { FieldRecording, FieldRequestOptions } from "./field-types";
import { FieldBending, type BendingMatch } from "./field-bending";

type RotationPoint = {
  recordingId: string; name: string; position: number; amplitude: number; normalizedAmplitude: number;
  relativePhaseDeg: number; coherence: number | null; realNormalized: number; imagNormalized: number;
};
type RotationCurve = { recordingId: string; name: string; orders?: number[]; amplitudes?: number[]; angleDegrees?: number[]; values?: number[] };
type RotationResult = {
  algorithmVersion: string; assumptionMode: string; rpm: number; rotationHz: number; revolutions: number;
  durationSeconds: number; pointsPerRevolution: number; orderResolution: number; unit: string;
  parameters: Record<string, unknown>; orderSpectra: RotationCurve[]; synchronousAverages: RotationCurve[];
  modeShape: { targetOrder: number; targetFrequencyHz: number; referenceRecordingId: string; points: RotationPoint[] };
  modalMatch?: BendingMatch;
  warnings: string[];
};
const number = (value: number | null | undefined) => value == null ? "—" : Number(value.toPrecision(6)).toString();
const baseChart = { animation: false, tooltip: { trigger: "axis" }, grid: { left: 72, right: 28, top: 45, bottom: 70 }, dataZoom: [{ type: "inside" }, { type: "slider", bottom: 5 }] };

export function FieldRotation({ request, onError }: { request: <T>(options: FieldRequestOptions) => Promise<T>; onError: (error: unknown) => void }) {
  const [records, setRecords] = useState<FieldRecording[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [rpm, setRpm] = useState(1200), [start, setStart] = useState(0), [end, setEnd] = useState(0);
  const [points, setPoints] = useState(256), [maxOrder, setMaxOrder] = useState(20), [targetOrder, setTargetOrder] = useState(1);
  const [phase, setPhase] = useState(0), [revolutions, setRevolutions] = useState(50), [detrend, setDetrend] = useState("constant");
  const [busy, setBusy] = useState(false), [result, setResult] = useState<RotationResult | null>(null), [activePoint, setActivePoint] = useState(0);
  const alive = useRef(true);
  async function refresh() {
    try {
      const response = await request<{ recordings: FieldRecording[] }>({ action: "recordings" });
      if (!alive.current) return;
      const complete = response.recordings.filter(record => record.status === "complete");
      setRecords(complete);
      setPositions(previous => Object.fromEntries(complete.map((record, index) => [record.id, previous[record.id] ?? (complete.length > 1 ? index / (complete.length - 1) : 0)])));
    } catch (error) { if (alive.current) onError(error); }
  }
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, []);
  const chosen = records.filter(record => selected.includes(record.id));
  const active = Math.min(activePoint, Math.max(0, (result?.orderSpectra.length || 1) - 1));
  const spectrum = result?.orderSpectra[active], average = result?.synchronousAverages[active];
  const shape = useMemo(() => [...(result?.modeShape.points || [])].sort((a, b) => a.position - b.position), [result]);
  function toggle(id: string, checked: boolean) {
    setResult(null); setSelected(current => checked ? [...current, id].slice(0, 8) : current.filter(value => value !== id));
  }
  async function run(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setResult(null); setActivePoint(0);
    try {
      const response = await request<RotationResult>({ action: "rotation", parameters: {
        recordingIds: chosen.map(record => record.id), pointNames: chosen.map(record => record.point || record.name),
        positions: chosen.map(record => positions[record.id] ?? 0), rpm, startSeconds: start,
        ...(end > 0 ? { endSeconds: end } : {}), pointsPerRevolution: points, maxOrder, targetOrder,
        phaseOffsetDeg: phase, maxRevolutions: revolutions, detrend,
      } });
      if (alive.current) setResult(response);
    } catch (error) { if (alive.current) onError(error); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="analysis-layout field-rotation-layout">
    <section className="field-card"><div className="field-section-heading"><div><h2>恒定 RPM 台架分析</h2><p>从已保存原始速度计算角度域阶次谱、周期同步平均和多测点复数振型。</p></div><span className="field-badge amber">模型假设模式</span></div>
      <p className="field-notice warning">本模式把所选记录的 t=0 当作共同相位参考，RPM 在分析区间内恒定。适合室内模型和功能验证，不代表已接入真实键相。</p>
      <form onSubmit={run} onChange={() => setResult(null)}>
        <fieldset disabled={busy} className="field-config-grid field-rotation-config">
          <label>固定转速 RPM<input type="number" min={0.000001} max={100000} step="any" required value={rpm} onChange={event => setRpm(Number(event.target.value))} /></label>
          <label>开始时间 s<input type="number" min={0} step="any" required value={start} onChange={event => setStart(Number(event.target.value))} /></label>
          <label>结束时间 s<input type="number" min={0} step="any" value={end} onChange={event => setEnd(Number(event.target.value))} /><small>0 表示使用共同可用终点</small></label>
          <label>每转重采样点数<select value={points} onChange={event => setPoints(Number(event.target.value))}>{[64,128,256,512,1024,2048,4096].map(value => <option key={value}>{value}</option>)}</select></label>
          <label>阶次谱上限<input type="number" min={0.01} max={Math.max(0.01, points / 2 - 0.01)} step="any" required value={maxOrder} onChange={event => setMaxOrder(Number(event.target.value))} /></label>
          <label>融合目标阶次<input type="number" min={0.01} max={maxOrder} step="any" required value={targetOrder} onChange={event => setTargetOrder(Number(event.target.value))} /></label>
          <label>t=0 相位偏移 °<input type="number" min={-360} max={360} step="any" required value={phase} onChange={event => setPhase(Number(event.target.value))} /></label>
          <label>最多分析转数<input type="number" min={2} max={200} step={1} required value={revolutions} onChange={event => setRevolutions(Number(event.target.value))} /></label>
          <label>预处理<select value={detrend} onChange={event => setDetrend(event.target.value)}><option value="constant">去均值</option><option value="linear">去线性趋势</option><option value="none">不去趋势</option></select></label>
        </fieldset>
        <div className="field-table-scroll field-rotation-records"><table className="field-table"><thead><tr><th>选择</th><th>记录 / 测点</th><th>样本与采样率</th><th>位置 x/L</th></tr></thead><tbody>{records.map(record => <tr key={record.id} className={selected.includes(record.id) ? "selected" : ""}>
          <td><input aria-label={`选择 ${record.name}`} type="checkbox" checked={selected.includes(record.id)} disabled={busy || (!selected.includes(record.id) && selected.length >= 8)} onChange={event => toggle(record.id, event.target.checked)} /></td>
          <td><strong>{record.name}</strong><small>{record.point || "未填写测点名"}</small></td><td>{record.samples} 点 / {record.sampleRate ? `${record.sampleRate} Hz` : "未知"}</td>
          <td><input aria-label={`${record.name} x/L`} type="number" min={0} max={1} step="any" disabled={busy || !selected.includes(record.id)} value={positions[record.id] ?? 0} onChange={event => { setResult(null); setPositions(current => ({ ...current, [record.id]: Number(event.target.value) })); }} /></td>
        </tr>)}</tbody></table></div>
        {!records.length && <p className="field-notice">还没有完整保存的记录。先完成采集并停止保存，再进行恒转速分析。</p>}
        <div className="field-acquisition-actions"><p>转频 {(rpm / 60).toFixed(4)} Hz · 目标频率 {(targetOrder * rpm / 60).toFixed(4)} Hz · 已选 {selected.length} 个测点</p><Button type="button" disabled={busy} onClick={() => void refresh()}>刷新记录</Button><Button type="submit" variant="primary" disabled={busy || selected.length < 1}>{busy ? "正在读取并计算…" : "开始恒转速分析"}</Button></div>
      </form>
    </section>
    {result && <>
      <section className="field-card"><div className="field-section-heading"><div><h2>实际波形阶次谱</h2><p>{result.revolutions} 转 · 阶次分辨率 {number(result.orderResolution)} · {result.algorithmVersion}</p></div><select value={active} onChange={event => setActivePoint(Number(event.target.value))}>{result.orderSpectra.map((curve, index) => <option key={curve.recordingId} value={index}>{curve.name}</option>)}</select></div>
        <Chart height={350} label="恒转速阶次谱" option={{ ...baseChart, xAxis: { type: "value", name: "阶次" }, yAxis: { type: "value", name: result.unit, scale: true }, series: [{ type: "line", showSymbol: false, data: (spectrum?.orders || []).map((order, index) => [order, spectrum?.amplitudes?.[index] || 0]) }] }} />
      </section>
      <section className="field-card"><div className="field-section-heading"><div><h2>周期同步平均</h2><p>按固定 RPM 分为 {result.revolutions} 转后，在每转 {result.pointsPerRevolution} 个角度点上求平均。</p></div></div>
        <Chart height={320} label="固定转速周期同步平均" option={{ ...baseChart, xAxis: { type: "value", name: "角度/°", min: 0, max: 360 }, yAxis: { type: "value", name: result.unit, scale: true }, series: [{ type: "line", showSymbol: false, data: (average?.angleDegrees || []).map((angle, index) => [angle, average?.values?.[index] || 0]) }] }} />
      </section>
      <section className="field-card"><div className="field-section-heading"><div><h2>多点融合振型</h2><p>目标 {number(result.modeShape.targetOrder)} 阶 / {number(result.modeShape.targetFrequencyHz)} Hz；第一条记录为相位参考。</p></div><span className="field-badge amber">t=0 同相假设</span></div>
        <Chart height={320} label="多测点复数振型" option={{ ...baseChart, legend: { data: ["同相分量", "归一化幅值"] }, xAxis: { type: "value", name: "x/L", min: 0, max: 1 }, yAxis: { type: "value", name: "归一化响应", min: -1.05, max: 1.05 }, series: [{ name: "同相分量", type: "line", data: shape.map(point => [point.position, point.realNormalized]) }, { name: "归一化幅值", type: "line", lineStyle: { type: "dashed" }, data: shape.map(point => [point.position, point.normalizedAmplitude]) }] }} />
        <div className="field-table-scroll"><table className="field-table"><thead><tr><th>测点</th><th>x/L</th><th>目标阶幅值</th><th>归一化幅值</th><th>相对相位 °</th><th>跨周期相干性</th></tr></thead><tbody>{shape.map(point => <tr key={point.recordingId}><td>{point.name}</td><td>{number(point.position)}</td><td>{number(point.amplitude)} {result.unit}</td><td>{number(point.normalizedAmplitude)}</td><td>{number(point.relativePhaseDeg)}</td><td>{number(point.coherence)}</td></tr>)}</tbody></table></div>
        <div className="field-form-actions"><Button onClick={() => { const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `rotation-${result.rpm}rpm-${result.modeShape.targetOrder}order.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>导出结果 JSON</Button></div>
        <details><summary>假设、限制与数据追溯</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
      </section>
      <FieldBending data={result.modalMatch} />
    </>}
  </div>;
}
