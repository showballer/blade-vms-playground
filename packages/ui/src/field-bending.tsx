"use client";
import React, { useEffect, useMemo, useState } from "react";
import { Chart } from "./charts";
import { Button } from "./common";

export type BendingCandidate = {
  mode: number; beta: number; mac: number | null; normalizedMse: number | null;
  theoryAtPoints: number[]; theoryCurve: number[];
  fittedReal: number[] | null; fittedImag: number[] | null;
  fittedCurveReal: number[] | null; fittedCurveImag: number[] | null;
};
export type BendingMatch = {
  model: string; status: "insufficient-data" | "candidate" | "ambiguous"; message: string;
  candidateMode: number | null; macGap: number | null; frequencyHz: number;
  displacementUnit: string; maxDisplacementAmplitude: number; referencePointIndex: number;
  positions: number[]; measuredReal: number[]; measuredImag: number[]; displacementAmplitudes: number[];
  pointNames?: string[];
  curvePositions: number[]; candidates: BendingCandidate[]; warnings: string[];
};
type SpatialPoint = { x: number; real: number; imag: number };
const fmt = (v: number | null | undefined) => v == null ? "—" : Number(v.toPrecision(5)).toString();

// No extrapolation past the outermost measurement. The added root is a model assumption.
export function interpolateResponse(points: SpatialPoint[], x: number): SpatialPoint | null {
  if (!points.length || x < points[0].x || x > points[points.length - 1].x) return null;
  if (x === points[0].x) return { ...points[0], x };
  const right = points.findIndex(p => p.x >= x);
  if (right < 1) return null;
  const a = points[right - 1], b = points[right], span = b.x - a.x;
  if (span <= 0) return null;
  const t = (x - a.x) / span;
  return { x, real: a.real * (1 - t) + b.real * t, imag: a.imag * (1 - t) + b.imag * t };
}

export function BladeBendingView({ data, candidate }: { data: BendingMatch; candidate: BendingCandidate }) {
  const [source, setSource] = useState("measured"), [playing, setPlaying] = useState(false);
  const [phase, setPhase] = useState(0), [speed, setSpeed] = useState(0.5), [gain, setGain] = useState(0.15);
  const [yaw, setYaw] = useState(-25), [elevation, setElevation] = useState(30);
  const measurable = data.status !== "insufficient-data";
  const theory = source === "theory" || !measurable;
  useEffect(() => { setPlaying(false); setPhase(0); }, [data, candidate.mode]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0, previous = 0;
    const tick = (now: number) => {
      if (previous && !document.hidden) setPhase(value => (value + Math.min(now - previous, 80) * speed * 0.36) % 360);
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed]);
  const points = useMemo(() => {
    if (theory) return data.curvePositions.map((x, i) => ({ x, real: candidate.theoryCurve[i], imag: 0 }));
    const measured = data.positions.map((x, i) => ({ x, real: data.measuredReal[i], imag: data.measuredImag[i] })).sort((a, b) => a.x - b.x);
    return measured[0]?.x > 0 ? [{ x: 0, real: 0, imag: 0 }, ...measured] : measured;
  }, [data, candidate, theory]);
  const radians = phase * Math.PI / 180, az = yaw * Math.PI / 180, el = elevation * Math.PI / 180;
  const viewScale = Math.min(680, 125 / (0.5 * Math.abs(Math.sin(az)) * Math.sin(el) + 0.085 * Math.abs(Math.cos(az)) * Math.sin(el) + gain * Math.cos(el)));
  const valueAt = (x: number) => {
    const p = interpolateResponse(points, x);
    return p ? p.real * Math.cos(radians) - p.imag * Math.sin(radians) : null;
  };
  const project = (x: number, y: number, z: number) => {
    const u = (x - 0.5) * Math.cos(az) - y * Math.sin(az);
    const depth = (x - 0.5) * Math.sin(az) + y * Math.cos(az);
    return [450 + viewScale * u, 180 + viewScale * (depth * Math.sin(el) - z * Math.cos(el))];
  };
  const polygon = (a: number, b: number, va: number, vb: number) => {
    const width = (x: number) => 0.085 - 0.055 * x;
    return [project(a, -width(a), va * gain), project(a, width(a), va * gain), project(b, width(b), vb * gain), project(b, -width(b), vb * gain)].map(p => p.join(",")).join(" ");
  };
  const mesh = Array.from({ length: 80 }, (_, i) => {
    const a = i / 80, b = (i + 1) / 80, va = valueAt(a), vb = valueAt(b);
    if (va == null || vb == null) return null;
    const mean = Math.max(-1, Math.min(1, (va + vb) / 2));
    const color = `hsl(${mean < 0 ? 215 : 12} 72% ${94 - Math.abs(mean) * 49}%)`;
    return <polygon key={i} points={polygon(a, b, va, vb)} fill={color} stroke={color} strokeWidth={0.6} />;
  });
  return <div className="field-bending-view">
    <div className="field-bending-toolbar">
      <label>变形来源<select value={theory ? "theory" : "measured"} onChange={e => { setSource(e.target.value); setPlaying(false); }}>
        <option value="measured" disabled={!measurable}>测点复响应（线性插值）</option><option value="theory">第 {candidate.mode} 阶理论模板</option>
      </select></label>
      <Button onClick={() => setPlaying(value => !value)}>{playing ? "暂停动画" : "播放动画"}</Button>
      <Button onClick={() => { setPlaying(false); setPhase(0); }}>复位相位</Button>
      <span>{theory ? "理论模型预览 · 非实测" : "工作响应重构 · 假设共同相位"}</span>
    </div>
    <svg className="field-bending-svg" viewBox="0 0 900 360" role="img" aria-label={theory ? "悬臂梁理论振型三维示意" : "测点响应三维变形示意"}>
      <title>示意叶片：颜色代表当前相位下的归一化位移，灰色为未变形参考或无测量覆盖区域</title>
      <polygon points={polygon(0, 1, 0, 0)} fill="#e6ebf2" stroke="#9caec4" strokeDasharray="5 4" />
      {mesh}
      {!theory && data.positions.map((x, i) => {
        const v = valueAt(x) ?? 0, p = project(x, 0, v * gain);
        const name = data.pointNames?.[i] ?? `P${i + 1}`;
        return <g key={i}><circle cx={p[0]} cy={p[1]} r={4} fill="#153959" stroke="white"><title>{`${name} · x/L=${x} · 位移幅值 ${fmt(data.displacementAmplitudes[i] * 1e6)} μm`}</title></circle><text x={p[0]} y={p[1] - 10} textAnchor="middle">{name.length > 12 ? `${name.slice(0, 12)}…` : name}</text></g>;
      })}
      <text x={32} y={30}>根部固支 · 单方向弯曲 · 非真实叶片几何</text>
      <text x={32} y={326}>x/L：0（根）→ 1（尖）　相位 {phase.toFixed(0)}°　显示频率 {speed} Hz</text>
    </svg>
    <div className="field-bending-legend"><span>−1</span><i /><span>+1　归一化瞬时位移</span></div>
    <div className="field-bending-controls">
      <label>相位 {phase.toFixed(0)}°<input aria-label="动画相位" type="range" min={0} max={360} value={phase} onChange={e => { setPlaying(false); setPhase(Number(e.target.value)); }} /></label>
      <label>播放速度 {speed} Hz<input aria-label="动画速度" type="range" min={0.1} max={2} step={0.1} value={speed} onChange={e => setSpeed(Number(e.target.value))} /></label>
      <label>归一化显示变形 {Math.round(gain * 100)}% L<input aria-label="归一化显示变形" type="range" min={0.02} max={0.3} step={0.01} value={gain} onChange={e => setGain(Number(e.target.value))} /></label>
      <label>视角 {yaw}°<input aria-label="叶片水平视角" type="range" min={-60} max={60} value={yaw} onChange={e => setYaw(Number(e.target.value))} /></label>
      <label>俯仰 {elevation}°<input aria-label="叶片俯仰视角" type="range" min={10} max={70} value={elevation} onChange={e => setElevation(Number(e.target.value))} /></label>
    </div>
    <p className="field-notice">动画默认暂停，播放为慢速示意，不是实际振动频率。显示变形是归一化幅度占叶展的比例，不是物理放大倍数；灰色未覆盖区不补造响应，不包含扭转。</p>
  </div>;
}

export function FieldBending({ data }: { data?: BendingMatch }) {
  const [mode, setMode] = useState(1);
  useEffect(() => setMode(data?.candidateMode ?? 1), [data]);
  if (!data) return <section className="field-card"><h2>振型模板匹配</h2><p className="field-notice warning">当前采集服务未返回模态匹配结果，请更新 Python 采集服务后重新分析。</p></section>;
  const candidate = data.candidates.find(item => item.mode === mode) ?? data.candidates[0];
  if (!candidate) return null;
  const measured = data.positions.map((x, i) => [x, data.measuredReal[i]]).sort((a, b) => a[0] - b[0]);
  const imaginary = data.positions.map((x, i) => [x, data.measuredImag[i]]).sort((a, b) => a[0] - b[0]);
  const theory = candidate.fittedCurveReal ?? candidate.theoryCurve;
  return <section className="field-card field-bending-card">
    <div className="field-section-heading"><div><h2>振型重构与候选模态匹配</h2><p>均匀悬臂梁前四阶弯曲 · 模板匹配不是模态确认</p></div><span className="field-badge amber">模型验证</span></div>
    <p className="field-notice warning" role="status">{data.message}</p>
    <div className="analysis-features">
      <div>目标响应频率<strong>{fmt(data.frequencyHz)} Hz</strong></div>
      <div>最大测点位移幅值<strong>{fmt(data.maxDisplacementAmplitude * 1e6)} μm</strong></div>
      <div>首选与次选 MAC 差<strong>{fmt(data.macGap)}</strong></div>
      <div>归一化相位参考<strong>{data.pointNames?.[data.referencePointIndex] ?? `P${data.referencePointIndex + 1}`}（最大响应点）</strong></div>
    </div>
    <div className="field-table-scroll"><table className="field-table field-bending-scores"><thead><tr><th>弯曲模板（非转频阶次）</th><th>MAC 相似度 ↑</th><th>归一化复数 MSE ↓</th><th>查看</th></tr></thead>
      <tbody>{data.candidates.map(item => <tr key={item.mode} className={item.mode === candidate.mode ? "selected" : ""}><td>第 {item.mode} 阶{data.candidateMode === item.mode ? " · 排序首位" : ""}</td><td>{fmt(item.mac)}</td><td>{fmt(item.normalizedMse)}</td><td><Button aria-pressed={item.mode === candidate.mode} onClick={() => setMode(item.mode)}>查看第 {item.mode} 阶</Button></td></tr>)}</tbody>
    </table></div>
    <BladeBendingView data={data} candidate={candidate} />
    <h3>测点响应与第 {candidate.mode} 阶模板对比</h3>
    <Chart height={320} label="测点复响应与理论振型对比" option={{ animation: false, tooltip: { trigger: "axis" }, legend: { data: ["测点实部", "测点虚部", "理论实部", "理论虚部"] }, grid: { left: 65, right: 25, top: 48, bottom: 45 }, xAxis: { type: "value", name: "x/L", min: 0, max: 1 }, yAxis: { type: "value", name: "归一化响应" }, series: [
      { name: "测点实部", type: "line", data: measured, symbolSize: 7 },
      { name: "测点虚部", type: "line", data: imaginary, symbol: "diamond", symbolSize: 6 },
      { name: "理论实部", type: "line", showSymbol: false, lineStyle: { type: "dashed" }, data: data.curvePositions.map((x, i) => [x, theory[i]]) },
      { name: "理论虚部", type: "line", showSymbol: false, lineStyle: { type: "dotted" }, data: data.curvePositions.map((x, i) => [x, candidate.fittedCurveImag?.[i] ?? 0]) },
    ] }} />
    <p className="field-notice">{candidate.mac == null ? "数据不足：当前理论曲线为单位叶尖模板，未执行拟合。" : "理论曲线用同一组测点做复数最小二乘缩放；MAC 保留相位信息，不对幅值取绝对值后匹配。MSE 是归一化复数残差均方，不是位移单位误差。"}</p>
    <details><summary>计算依据与使用限制</summary><ul>{data.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>
  </section>;
}
