"use client";
import React, { useEffect, useRef, useState } from "react";
import { Chart } from "./charts";
import { Button } from "./common";
import type { FieldRecording, FieldRequestOptions } from "./field-types";

type Curve = { x: number[]; y: number[]; representation: string };
export type AnalysisResult = {
  algorithmVersion: string; generatedAt: number;
  provenance: { source: string; recordingId: string; recordingName: string; rawSha256: string };
  parameters: { start: number; end: number; quantity: string; nfft: number };
  sampleRate: number; sampleCount: number; durationSeconds: number; unit: string;
  frequencySpacingHz: number; fftDurationSeconds: number;
  features: Record<string, number | null>;
  waveform: Curve; rawVelocity: Curve; filteredVelocity: Curve; spectrum: Curve; envelopeSpectrum: Curve;
  bands: { lowHz: number; highHz: number; power: number; percent: number | null }[];
  stft: { times: number[]; frequencies: number[]; amplitudes: number[][]; hopSamples: number; windowSamples: number };
  warnings: string[];
};
const tabs = ["时域波形", "FFT频谱", "时频分析", "滤波降噪", "包络谱", "频带能量", "平均波形", "特征值"];
const format = (v: number | null | undefined) => v == null ? "未计算" : Number(v.toPrecision(6)).toString();
const names: Record<string, string> = { mean: "均值", rms: "RMS", peak: "绝对峰值", peakToPeak: "峰峰值", kurtosis: "峭度（非超额）", dominantHz: "主频", totalPower: "Welch 总功率", snrDb: "信噪比" };

export function AnalysisCharts({ result, tab }: { result: AnalysisResult; tab: string }) {
  if (tab === "平均波形") return <p className="field-notice">整周期同步平均需要可靠的周期和相位参考。当前记录没有键相，本版不计算同步平均。</p>;
  if (tab === "特征值") return <Features result={result} />;
  const base = { animation: false, tooltip: { trigger: "axis" }, grid: { left: 85, right: 35, top: 45, bottom: 80 }, dataZoom: [{ type: "inside" }, { type: "slider", bottom: 5 }] };
  if (tab === "时频分析") {
    const stft = result.stft;
    const cells = stft.amplitudes.flatMap((row, i) => row.map((v, j) => [i, j, v]));
    const maximum = cells.reduce((m, c) => Math.max(m, c[2]), 0) || 1;
    return <><p>窗长 {stft.windowSamples} 点；步进 {stft.hopSamples} 点；颜色为幅值 / {result.unit}。频率分组显示最大幅值。</p><Chart height={380} label="STFT 时频幅值" option={{ ...base, tooltip: { trigger: "item" }, grid: { left: 85, right: 110, top: 35, bottom: 85 }, xAxis: { type: "category", name: "时间/s", data: stft.times.map(t => format(t)) }, yAxis: { type: "category", name: "频率/Hz", data: stft.frequencies.map(f => format(f)) }, visualMap: { min: 0, max: maximum, calculable: true, right: 0 }, series: [{ type: "heatmap", data: cells }] }} /></>;
  }
  if (tab === "频带能量") return <><Chart height={340} label="频带功率占总功率百分比" option={{ ...base, xAxis: { type: "category", data: result.bands.map(b => `${b.lowHz}–${b.highHz} Hz`) }, yAxis: { type: "value", name: "%" }, series: [{ type: "bar", data: result.bands.map(b => b.percent) }] }} /><p>各频带占整个 0～fs/2 的 Welch 总功率比例；未覆盖的频带使占比之和小于100%。</p><div className="field-table-scroll"><table className="field-table"><thead><tr><th>频带 Hz</th><th>功率 ({result.unit})²</th><th>占比 %</th></tr></thead><tbody>{result.bands.map((b, i) => <tr key={i}><td>{b.lowHz}–{b.highHz}</td><td>{format(b.power)}</td><td>{format(b.percent)}</td></tr>)}</tbody></table></div></>;
  const frequency = tab === "FFT频谱" || tab === "包络谱";
  const curves = tab === "滤波降噪" ? [{ name: "原始速度", curve: result.rawVelocity }, { name: "预处理后速度", curve: result.filteredVelocity }] : [{ name: tab, curve: tab === "FFT频谱" ? result.spectrum : tab === "包络谱" ? result.envelopeSpectrum : result.waveform }];
  const unit = tab === "滤波降噪" ? "m/s" : result.unit;
  return <Chart height={360} label={`${tab} ${unit}`} option={{ ...base, legend: { data: curves.map(c => c.name) }, xAxis: { type: "value", name: frequency ? "频率/Hz" : "时间/s" }, yAxis: { type: "value", name: unit, scale: true }, series: curves.map(({ name, curve }) => ({ name, type: "line", showSymbol: false, data: curve.x.map((x, i) => [x, curve.y[i]]) })) }} />;
}

function Features({ result }: { result: AnalysisResult }) {
  return <dl className="field-details analysis-features">{Object.entries(names).map(([key, name]) => <div key={key}><dt>{name}</dt><dd>{format(result.features[key])} {result.features[key] == null ? "" : key === "dominantHz" ? "Hz" : key === "kurtosis" ? "" : key === "snrDb" ? "dB" : key === "totalPower" ? `(${result.unit})²` : result.unit}</dd></div>)}</dl>;
}

export function FieldAnalysis({ request, onError }: { request: <T>(options: FieldRequestOptions) => Promise<T>; onError: (e: unknown) => void }) {
  const [records, setRecords] = useState<FieldRecording[]>([]), [id, setId] = useState("");
  const [start, setStart] = useState(0), [end, setEnd] = useState(0);
  const [quantity, setQuantity] = useState("velocity"), [detrend, setDetrend] = useState("constant");
  const [filterType, setFilter] = useState("none"), [low, setLow] = useState(1), [high, setHigh] = useState(100), [order, setOrder] = useState(4);
  const [window, setWindow] = useState("hann"), [nfft, setNfft] = useState(4096), [stftSize, setStftSize] = useState(1024);
  const [bands, setBands] = useState("0-10,10-30,30-80"), [tab, setTab] = useState(tabs[0]);
  const [busy, setBusy] = useState(false), [result, setResult] = useState<AnalysisResult | null>(null);
  const alive = useRef(true);
  async function refresh() {
    try { const response = await request<{ recordings: FieldRecording[] }>({ action: "recordings" }); if (alive.current) setRecords(response.recordings.filter(r => r.status === "complete")); }
    catch (e) { if (alive.current) onError(e); }
  }
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, []);
  const record = records.find(r => r.id === id);
  async function run(event: React.FormEvent) {
    event.preventDefault(); setResult(null); setBusy(true);
    try {
      const parsedBands = bands.split(",").map(item => { const pair = item.trim().split("-").map(Number); if (pair.length !== 2 || pair.some(v => !Number.isFinite(v))) throw Error("频带格式示例：0-10,10-30,30-80"); return pair; });
      const response = await request<AnalysisResult>({ action: "analysis", id, parameters: { start, end, quantity, detrend, filterType, lowHz: low, highHz: high, order, window, nfft, stftSize, bands: parsedBands } });
      if (alive.current) setResult(response);
    } catch (e) { if (alive.current) onError(e); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="analysis-layout"><section className="field-card"><div className="field-section-heading"><div><h2>原始记录分析</h2><p>从已完成记录读取连续原始速度。修改参数后请重新计算。</p></div><Button disabled={busy} onClick={() => void refresh()}>刷新记录</Button></div>
    <form onSubmit={run} onChange={() => setResult(null)}><fieldset disabled={busy} className="field-config-grid">
      <label>数据记录<select value={id} required onChange={e => { setId(e.target.value); const r = records.find(r => r.id === e.target.value); const size = Math.min(r?.samples || 0, 8000000); setStart(0); setEnd(size); if (size >= 64) { setNfft(2 ** Math.floor(Math.log2(Math.min(size, 262144)))); setStftSize(Math.min(1024, 2 ** Math.floor(Math.log2(size)))); } }}>{<option value="">选择已完成记录</option>}{records.map(r => <option value={r.id} key={r.id}>{r.name} · {r.samples}点</option>)}</select></label>
      <label>分析物理量<select value={quantity} onChange={e => setQuantity(e.target.value)}><option value="velocity">速度 m/s</option><option value="displacement">计算位移 m</option><option value="acceleration">计算加速度 m/s²</option></select></label>
      <label>起始样本（含）<input type="number" required min={0} step={1} value={start} onChange={e => setStart(Number(e.target.value))} /></label>
      <label>结束样本（不含）<input type="number" required min={start + 64} max={Math.min(record?.samples || 0, start + 8000000)} step={1} value={end} onChange={e => setEnd(Number(e.target.value))} /></label>
      <label>去趋势<select value={detrend} onChange={e => setDetrend(e.target.value)}><option value="constant">去均值</option><option value="linear">去线性趋势</option><option value="none">不去趋势</option></select></label>
      <label>Butterworth 离线零相位滤波<select value={filterType} onChange={e => setFilter(e.target.value)}><option value="none">不滤波</option><option value="lowpass">低通</option><option value="highpass">高通</option><option value="bandpass">带通</option></select></label>
      <label>高通/带通下限 Hz<input type="number" min={0.000001} step="any" required value={low} onChange={e => setLow(Number(e.target.value))} /></label>
      <label>低通/带通上限 Hz<input type="number" min={0.000001} step="any" required value={high} onChange={e => setHigh(Number(e.target.value))} /></label>
      <label>单向滤波阶数<input type="number" min={1} max={10} required value={order} onChange={e => setOrder(Number(e.target.value))} /></label>
      <label>窗函数<select value={window} onChange={e => setWindow(e.target.value)}><option value="hann">Hann 汉宁</option><option value="hamming">Hamming 海明</option><option value="boxcar">矩形</option></select></label>
      <label>FFT 点数<input type="number" min={64} max={262144} required step={1} value={nfft} onChange={e => setNfft(Number(e.target.value))} /></label>
      <label>STFT 窗长<input type="number" min={64} max={4096} required step={1} value={stftSize} onChange={e => setStftSize(Number(e.target.value))} /></label>
      <label>频带 Hz（英文逗号分隔）<input value={bands} required onChange={e => setBands(e.target.value)} /></label>
    </fieldset><p>{record?.sampleRate ? `采样率 ${record.sampleRate} Hz；选区 ${(Math.max(0, end - start) / record.sampleRate).toFixed(3)} s；FFT 栅格 ${(record.sampleRate / nfft).toPrecision(4)} Hz。` : "先选择已完整保存的记录。"}</p><Button type="submit" variant="primary" disabled={busy || !id}>{busy ? "正在读取原始数据并计算…" : "开始分析"}</Button></form>
    <p className="field-inline-help">本版支持离线 Butterworth IIR。暂不提供 FIR、自动去毛刺、同步平均或损伤诊断。最多分析800万点；不会修改原始文件。</p>
  </section>
  {result && <section className="field-card"><div className="field-section-heading"><div><h2>{result.provenance.recordingName} · 分析结果</h2><p>来源 {result.provenance.source} · {result.algorithmVersion} · {result.sampleCount}点 · {result.unit}</p></div><Button onClick={() => { const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `analysis-${result.provenance.recordingId}-${result.parameters.start}-${result.parameters.end}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>导出结果 JSON</Button></div>
    <p>FFT 首 {result.parameters.nfft} 点 / {format(result.fftDurationSeconds)} s，频率栅格 {format(result.frequencySpacingHz)} Hz；谱峰幅值已校正窗增益。</p>
    <div className="field-form-actions" role="tablist" aria-label="信号处理类型">{tabs.map(t => <Button role="tab" aria-selected={t === tab} key={t} variant={t === tab ? "primary" : "ghost"} onClick={() => setTab(t)}>{t}</Button>)}</div>
    <AnalysisCharts result={result} tab={tab} /><Features result={result} />
    <details><summary>计算条件、质量说明与追溯</summary><ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul><p style={{ overflowWrap: "anywhere" }}>原始区间 SHA-256：{result.provenance.rawSha256}</p></details>
  </section>}
  </div>;
}
