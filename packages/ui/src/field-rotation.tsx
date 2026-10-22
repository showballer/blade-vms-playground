"use client";
import { CustomSelect } from "./custom-select";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Chart } from "./charts";
import { ChartLoading } from "./chart-loading";
import { Button } from "./common";
import type { FieldRecording, FieldRequestOptions } from "./field-types";
import { FieldBending, type BendingMatch } from "./field-bending";
import { hasBladePassMetadata } from "./web-blade-capture-selection";

type RotationPoint = {
  recordingId: string; name: string; position: number; amplitude: number; normalizedAmplitude: number;
  relativePhaseDeg: number; coherence: number | null; realNormalized: number; imagNormalized: number;
};
type RotationCurve = { recordingId: string; name: string; orders?: number[]; amplitudes?: number[]; angleDegrees?: number[]; values?: number[] };
export type RotationResult = {
  algorithmVersion: string; assumptionMode: string; rpm: number; rotationHz: number; revolutions: number;
  durationSeconds: number; pointsPerRevolution: number; orderResolution: number; unit: string;
  parameters: Record<string, unknown>; orderSpectra: RotationCurve[]; synchronousAverages: RotationCurve[];
  modeShape: { targetOrder: number; targetFrequencyHz: number; referenceRecordingId: string; points: RotationPoint[] };
  modalMatch?: BendingMatch;
  warnings: string[];
  sources?: { id: string; name: string; source: string; sourceFile: string; qualityCounts?: Record<string, number> }[];
};
type RotationRecording = FieldRecording & { position?: number; rpm?: number; source?: string; qualityCounts?: Record<string, number>; sourceFile?: string };
const number = (value: number | null | undefined) => value == null ? "—" : Number(value.toPrecision(6)).toString();
const baseChart = {
  animation: false, color: ["#2d6cc0", "#1fa971"], textStyle: { fontSize: 12 },
  tooltip: { trigger: "axis", confine: true },
  grid: { left: 64, right: 28, top: 54, bottom: 82 },
  dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 18, bottom: 10, left: 64, right: 28, brushSelect: false, borderColor: "#dfe7f1", textStyle: { fontSize: 11 } }],
};
const resultTabs = [["spectrum", "阶次谱与同步平均"], ["shape", "多点融合振型"], ["bending", "振型重构与模态匹配"]] as const;

export function FieldRotation({ request, onError, refreshKey = 0, preferredIds = [], canAnalyze = true, emptyText = "还没有完整保存的记录。先完成采集并停止保存，再进行恒转速分析。" }: {
  request: <T>(options: FieldRequestOptions) => Promise<T>; onError: (error: unknown) => void;
  refreshKey?: number; preferredIds?: string[]; canAnalyze?: boolean; emptyText?: string;
}) {
  const [records, setRecords] = useState<RotationRecording[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [rpm, setRpm] = useState(1200), [start, setStart] = useState(0), [end, setEnd] = useState(0);
  const [points, setPoints] = useState(256), [maxOrder, setMaxOrder] = useState(20), [targetOrder, setTargetOrder] = useState(1);
  const [phase, setPhase] = useState(0), [revolutions, setRevolutions] = useState(50), [detrend, setDetrend] = useState("constant");
  const [busy, setBusy] = useState(false), [result, setResult] = useState<RotationResult | null>(null), [activePoint, setActivePoint] = useState(0);
  const [resultTab, setResultTab] = useState("spectrum"), [loaded, setLoaded] = useState(false);
  const tabId = useId();
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const alive = useRef(true);
  async function refresh(preferImported = false) {
    try {
      const response = await request<{ recordings: RotationRecording[] }>({ action: "recordings" });
      if (!alive.current) return;
      const complete = response.recordings.filter(record => record.status === "complete" && !hasBladePassMetadata(record));
      setRecords(complete);
      setLoaded(true);
      setPositions(previous => Object.fromEntries(complete.map((record, index) => {
        const sourcePosition = record.position ?? record.simulation?.position;
        return [record.id, previous[record.id] ?? (typeof sourcePosition === "number" && Number.isFinite(sourcePosition) && sourcePosition >= 0 && sourcePosition <= 1 ? sourcePosition : complete.length > 1 ? (index + 1) / complete.length : 1)];
      })));
      setSelected(previous => (preferImported && preferredIds.length ? preferredIds : previous).filter(id => complete.some(record => record.id === id)).slice(0, 8));
      const importedRpm = preferImported && complete.filter(record => preferredIds.includes(record.id)).map(record => record.rpm ?? record.simulation?.rpm).find(value => Number.isFinite(value) && Number(value) > 0);
      if (importedRpm) setRpm(importedRpm);
    } catch (error) { if (alive.current) onError(error); }
  }
  useEffect(() => { alive.current = true; setResult(null); void refresh(true); return () => { alive.current = false; }; }, [refreshKey]);
  const chosen = selected.map(id => records.find(record => record.id === id)).filter((record): record is RotationRecording => Boolean(record));
  const active = Math.min(activePoint, Math.max(0, (result?.orderSpectra.length || 1) - 1));
  const spectrum = result?.orderSpectra[active], average = result?.synchronousAverages[active];
  const shape = useMemo(() => [...(result?.modeShape.points || [])].sort((a, b) => a.position - b.position), [result]);
  function toggle(id: string, checked: boolean) {
    setResult(null); setSelected(current => checked ? [...current, id].slice(0, 8) : current.filter(value => value !== id));
  }
  async function run(event: React.FormEvent) {
    event.preventDefault(); if (!canAnalyze) return; setBusy(true); setResult(null); setActivePoint(0); setResultTab("spectrum");
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
    <form className="rotation-setup-grid" onSubmit={run} onChange={() => setResult(null)}>
      <section className="field-card rotation-parameters">
        <div className="field-section-heading"><div><h2>分析参数</h2><p>恒定 RPM · 阶次谱、同步平均与多点振型</p></div><span className="field-badge amber">恒转速假设</span></div>
        <p className="field-notice warning">所选记录的 t=0 为共同相位参考，分析区间内 RPM 恒定；适合室内模型与功能验证，未接入真实键相。</p>
        <fieldset disabled={busy || !canAnalyze} className="field-config-grid field-rotation-config">
          <label>固定转速 RPM<input type="number" min={0.000001} max={100000} step="any" required value={rpm} onChange={event => setRpm(Number(event.target.value))} /></label>
          <label>开始时间 s<input type="number" min={0} step="any" required value={start} onChange={event => setStart(Number(event.target.value))} /></label>
          <label>结束时间 s<input type="number" min={0} step="any" value={end} onChange={event => setEnd(Number(event.target.value))} /><small>0 表示使用共同可用终点</small></label>
          <label>每转重采样点数<CustomSelect value={points} onChange={event => setPoints(Number(event.target.value))}>{[64,128,256,512,1024,2048,4096].map(value => <option key={value}>{value}</option>)}</CustomSelect></label>
          <label>阶次谱上限<input type="number" min={0.01} max={Math.max(0.01, points / 2 - 0.01)} step="any" required value={maxOrder} onChange={event => setMaxOrder(Number(event.target.value))} /></label>
          <label>融合目标阶次<input type="number" min={0.01} max={maxOrder} step="any" required value={targetOrder} onChange={event => setTargetOrder(Number(event.target.value))} /></label>
          <label>t=0 相位偏移 °<input type="number" min={-360} max={360} step="any" required value={phase} onChange={event => setPhase(Number(event.target.value))} /></label>
          <label>最多分析转数<input type="number" min={2} max={200} step={1} required value={revolutions} onChange={event => setRevolutions(Number(event.target.value))} /></label>
          <label>预处理<CustomSelect value={detrend} onChange={event => setDetrend(event.target.value)}><option value="constant">去均值</option><option value="linear">去线性趋势</option><option value="none">不去趋势</option></CustomSelect></label>
        </fieldset>
      </section>
      <section className="field-card rotation-point-picker">
        <div className="field-section-heading"><div><h2>测点选择</h2><p>选择完整记录，填写测点在叶片上的相对位置</p></div><span className="field-badge">已选 {selected.length} / 8</span></div>
        <div className="field-table-scroll field-rotation-records"><table className="field-table"><thead><tr><th>选择</th><th>记录 / 测点</th><th>样本与采样率</th><th>位置 x/L</th></tr></thead><tbody>{records.map(record => <tr key={record.id} className={selected.includes(record.id) ? "selected" : ""}>
          <td><input aria-label={`选择 ${record.name}`} type="checkbox" checked={selected.includes(record.id)} disabled={busy || (!selected.includes(record.id) && selected.length >= 8)} onChange={event => toggle(record.id, event.target.checked)} /></td>
          <td><strong>{record.name}</strong><small>{record.point || "未填写测点名"} · {record.source === "simulation" ? "模拟数据" : record.source === "polytec_ivs500" ? "设备采集" : record.source === "measured" ? "实测导入" : "离线数据"}</small>{record.qualityCounts && <small>{Object.entries(record.qualityCounts).map(([label, count]) => `${label} ${count}`).join(" · ")}</small>}</td><td>{record.samples.toLocaleString()} 点 / {record.sampleRate ? `${Number(record.sampleRate.toPrecision(7))} Hz` : "未知"}<small>{record.sampleRate ? `${(record.samples / record.sampleRate).toFixed(2)} 秒` : ""}</small></td>
          <td><input aria-label={`${record.name} x/L`} type="number" min={0} max={1} step="any" disabled={busy || !selected.includes(record.id)} value={positions[record.id] ?? 0} onChange={event => { setResult(null); setPositions(current => ({ ...current, [record.id]: Number(event.target.value) })); }} /></td>
        </tr>)}</tbody></table></div>
        {!records.length && <p className="field-notice">{loaded ? emptyText : "正在加载当前账号的数据记录…"}</p>}
        <div className="field-acquisition-actions"><p>转频 {(rpm / 60).toFixed(4)} Hz · 目标频率 {(targetOrder * rpm / 60).toFixed(4)} Hz</p><Button type="button" disabled={busy} onClick={() => void refresh()}>刷新记录</Button><Button type="submit" variant="primary" disabled={busy || selected.length < 1 || !canAnalyze}>{busy ? "正在读取并计算…" : "开始恒转速分析"}</Button></div>
      </section>
    </form>
    {busy && <ChartLoading label="正在读取测点并计算旋转分析…" />}
    {result && <>
      <section className="field-card rotation-result-summary"><div><h2>分析结果</h2><p>{result.revolutions} 个完整周期 · {result.durationSeconds.toFixed(3)} s · {result.modeShape.points.length} 个测点{result.sources?.some(source => source.source === "simulation") ? " · 含模拟数据" : ""}</p></div><Button onClick={() => { const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `rotation-${result.rpm}rpm-${result.modeShape.targetOrder}order.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>导出完整结果 JSON</Button></section>
      <div className="rotation-result-tabs" role="tablist" aria-label="旋转分析结果">{resultTabs.map(([id, label], index) => <button key={id} id={`${tabId}-${id}-tab`} ref={element => { tabButtons.current[index] = element; }} type="button" role="tab" aria-selected={resultTab === id} aria-controls={`${tabId}-${id}-panel`} tabIndex={resultTab === id ? 0 : -1} onClick={() => setResultTab(id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % resultTabs.length : event.key === "ArrowLeft" ? (index + resultTabs.length - 1) % resultTabs.length : event.key === "Home" ? 0 : event.key === "End" ? resultTabs.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); setResultTab(resultTabs[next][0]); tabButtons.current[next]?.focus(); }
      }}>{label}</button>)}</div>
      {resultTab === "spectrum" && <div className="rotation-spectrum-grid" id={`${tabId}-spectrum-panel`} role="tabpanel" aria-labelledby={`${tabId}-spectrum-tab`}>
      <section className="field-card"><div className="field-section-heading"><div><h2>实际波形阶次谱</h2><p>{result.revolutions} 转 · 阶次分辨率 {number(result.orderResolution)} · {result.algorithmVersion}</p></div><CustomSelect value={active} onChange={event => setActivePoint(Number(event.target.value))}>{result.orderSpectra.map((curve, index) => <option key={curve.recordingId} value={index}>{curve.name}</option>)}</CustomSelect></div>
        <Chart height={320} label="恒转速阶次谱" option={{ ...baseChart, xAxis: { type: "value", name: "阶次", nameLocation: "middle", nameGap: 28, axisLabel: { hideOverlap: true } }, yAxis: { type: "value", name: result.unit, scale: true }, series: [{ type: "line", showSymbol: false, data: (spectrum?.orders || []).map((order, index) => [order, spectrum?.amplitudes?.[index] || 0]) }] }} />
      </section>
      <section className="field-card"><div className="field-section-heading"><div><h2>周期同步平均</h2><p>按固定 RPM 分为 {result.revolutions} 转后，在每转 {result.pointsPerRevolution} 个角度点上求平均。</p></div></div>
        <Chart height={320} label="固定转速周期同步平均" option={{ ...baseChart, xAxis: { type: "value", name: "角度 / °", nameLocation: "middle", nameGap: 28, min: 0, max: 360, axisLabel: { hideOverlap: true } }, yAxis: { type: "value", name: result.unit, scale: true }, series: [{ type: "line", showSymbol: false, data: (average?.angleDegrees || []).map((angle, index) => [angle, average?.values?.[index] || 0]) }] }} />
      </section>
      </div>}
      {resultTab === "shape" &&
      <section className="field-card rotation-shape-card" id={`${tabId}-shape-panel`} role="tabpanel" aria-labelledby={`${tabId}-shape-tab`}><div className="field-section-heading"><div><h2>多点融合振型</h2><p>目标 {number(result.modeShape.targetOrder)} 阶 / {number(result.modeShape.targetFrequencyHz)} Hz；第一条记录为相位参考。</p></div><span className="field-badge amber">t=0 同相假设</span></div>
        <Chart height={320} label="多测点复数振型" option={{ ...baseChart, legend: { type: "scroll", top: 4, bottom: "auto", left: "center", itemWidth: 16, itemHeight: 10, itemGap: 20, textStyle: { fontSize: 12, color: "#62758e" }, data: ["同相分量", "归一化幅值"] }, xAxis: { type: "value", name: "x/L", nameLocation: "middle", nameGap: 28, min: 0, max: 1, axisLabel: { hideOverlap: true } }, yAxis: { type: "value", name: "归一化响应", min: -1.05, max: 1.05 }, series: [{ name: "同相分量", type: "line", symbolSize: 6, data: shape.map(point => [point.position, point.realNormalized]) }, { name: "归一化幅值", type: "line", symbolSize: 6, lineStyle: { type: "dashed" }, data: shape.map(point => [point.position, point.normalizedAmplitude]) }] }} />
        <div className="field-table-scroll rotation-shape-table" tabIndex={0} aria-label="多点融合测点数据"><table className="field-table"><thead><tr><th>测点</th><th>x/L</th><th>目标阶幅值</th><th>归一化幅值</th><th>相对相位 °</th><th>跨周期相干性</th></tr></thead><tbody>{shape.map(point => <tr key={point.recordingId}><td>{point.name}</td><td>{number(point.position)}</td><td>{number(point.amplitude)} {result.unit}</td><td>{number(point.normalizedAmplitude)}</td><td>{number(point.relativePhaseDeg)}</td><td>{number(point.coherence)}</td></tr>)}</tbody></table></div>
      </section>}
      {resultTab === "bending" && <div className="rotation-result-panel" id={`${tabId}-bending-panel`} role="tabpanel" aria-labelledby={`${tabId}-bending-tab`}><FieldBending data={result.modalMatch} /></div>}
      <section className="field-card"><details><summary>假设、限制与数据追溯</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>{result.sources?.map(source => <p key={source.id}>{source.name} · {source.sourceFile} · {source.source === "simulation" ? "模拟" : source.source === "measured" ? "实测导入" : "离线导入"}</p>)}</details></section>
    </>}
  </div>;
}
