"use client";
import React, { useMemo, useState } from "react";
import { Button } from "./common";

export type Response3DPoint = {
  id: string;
  name: string;
  radiusM: number | null;
  normalizedAmplitude: number | null;
  displacementRmsM: number | null;
};

type LocatedPoint = Response3DPoint & { radiusM: number };
export type ResponseEnvelopeInterval = { from: LocatedPoint; to: LocatedPoint };
const finiteRadius = (r: unknown): r is number => typeof r === "number" && Number.isFinite(r) && r >= 0;
const finiteAmplitude = (a: unknown): a is number => typeof a === "number" && Number.isFinite(a) && a >= 0;
const fmt = (value: number) => Number(value.toPrecision(5)).toString();

/** Only bridge adjacent measured points. Unknown positions cannot be placed in
 * the ordering, so that case deliberately supplies point markers without a mesh. */
export function responseEnvelopeIntervals(points: Response3DPoint[]): ResponseEnvelopeInterval[] {
  if (points.some(p => !finiteRadius(p.radiusM))) return [];
  const ordered = [...points].sort((a, b) => a.radiusM! - b.radiusM!) as LocatedPoint[];
  const duplicate = new Set(ordered.filter((p, i) => ordered.some((q, j) => i !== j && Math.abs(p.radiusM - q.radiusM) < 1e-9)).map(p => p.id));
  return ordered.slice(1).flatMap((to, i) => {
    const from = ordered[i];
    return !duplicate.has(from.id) && !duplicate.has(to.id) && to.radiusM > from.radiusM &&
      finiteAmplitude(from.normalizedAmplitude) && finiteAmplitude(to.normalizedAmplitude)
      ? [{ from, to }] : [];
  });
}

/** No root constraint, no extrapolation and no interpolation across missing data. */
export function interpolateResponseEnvelope(points: Response3DPoint[], radiusM: number): number | null {
  if (!finiteRadius(radiusM)) return null;
  const exact = points.filter(p => finiteRadius(p.radiusM) && Math.abs(p.radiusM - radiusM) < 1e-9);
  if (exact.length) return exact.length === 1 && finiteAmplitude(exact[0].normalizedAmplitude) ? exact[0].normalizedAmplitude : null;
  const interval = responseEnvelopeIntervals(points).find(({ from, to }) => radiusM > from.radiusM && radiusM < to.radiusM);
  if (!interval) return null;
  const { from, to } = interval;
  const t = (radiusM - from.radiusM) / (to.radiusM - from.radiusM);
  return from.normalizedAmplitude! * (1 - t) + to.normalizedAmplitude! * t;
}

export function MeasurementResponse3D({ points, bandHz, frequencyHz }: {
  points: Response3DPoint[];
  bandHz?: readonly [number, number];
  frequencyHz?: number;
}) {
  const [yaw, setYaw] = useState(-25), [elevation, setElevation] = useState(30), [gain, setGain] = useState(.18);
  const [showNegativeReference, setShowNegativeReference] = useState(true);
  const located = useMemo(() => points.filter((p): p is LocatedPoint => finiteRadius(p.radiusM)).sort((a, b) => a.radiusM - b.radiusM), [points]);
  const intervals = useMemo(() => responseEnvelopeIntervals(points), [points]);
  const extent = Math.max(0, ...located.map(p => p.radiusM));
  const valid = located.filter(p => finiteAmplitude(p.normalizedAmplitude));
  const unknown = points.filter(p => !finiteRadius(p.radiusM));
  const duplicate = located.some((p, i) => located.some((q, j) => i !== j && Math.abs(p.radiusM - q.radiusM) < 1e-9));
  const scaleRadius = extent || 1;
  const az = yaw * Math.PI / 180, el = elevation * Math.PI / 180;
  const amplitudeExtent = Math.max(1, ...valid.map(p => p.normalizedAmplitude!));
  const rawProject = (x: number, y: number, z: number) => {
    const u = (x - .5) * Math.cos(az) - y * Math.sin(az);
    const depth = (x - .5) * Math.sin(az) + y * Math.cos(az);
    return [u, depth * Math.sin(el) - z * Math.cos(el)];
  };
  // Fit display geometry only. The metre coordinates and measured RMS values
  // are never changed by perspective, gain or the drawing extent.
  const corners = [0, 1].flatMap(x => [-.14, .14].flatMap(y => [showNegativeReference ? -gain * amplitudeExtent : 0, gain * amplitudeExtent].map(z => rawProject(x, y, z))));
  const minU = Math.min(...corners.map(p => p[0])), maxU = Math.max(...corners.map(p => p[0]));
  const minV = Math.min(...corners.map(p => p[1])), maxV = Math.max(...corners.map(p => p[1]));
  const scale = Math.min(850, 820 / Math.max(.01, maxU - minU), 280 / Math.max(.01, maxV - minV));
  const project = (radius: number, y: number, amplitude: number) => {
    const [u, v] = rawProject(radius / scaleRadius, y, amplitude * gain);
    return [500 + scale * (u - (minU + maxU) / 2), 205 + scale * (v - (minV + maxV) / 2)];
  };
  const width = (radius: number) => .075 - .035 * radius / scaleRadius;
  const polygon = (a: number, b: number, va: number, vb: number) => [
    project(a, -width(a), va), project(a, width(a), va),
    project(b, width(b), vb), project(b, -width(b), vb),
  ].map(p => p.join(",")).join(" ");
  // The negative face is only a mirrored RMS scale reference. A PSD/RMS has no
  // phase or sign, so neither face is a measured instant, peak, or motion bound.
  const mesh = (direction: 1 | -1) => intervals.flatMap(({ from, to }, index) => {
    const subdivisions = Math.max(2, Math.ceil(80 * (to.radiusM - from.radiusM) / scaleRadius));
    return Array.from({ length: subdivisions }, (_, i) => {
      const t = i / subdivisions, u = (i + 1) / subdivisions;
      const a = from.radiusM * (1 - t) + to.radiusM * t, b = from.radiusM * (1 - u) + to.radiusM * u;
      const va = from.normalizedAmplitude! * (1 - t) + to.normalizedAmplitude! * t;
      const vb = from.normalizedAmplitude! * (1 - u) + to.normalizedAmplitude! * u;
      const color = `hsl(${220 - 210 * Math.min(1, (va + vb) / 2 / amplitudeExtent)} 76% 49%)`;
      return <polygon key={`${direction}-${index}-${i}`} data-response-interval={direction === 1 ? `${from.id}:${to.id}` : undefined}
        data-reference-interval={direction === -1 ? `${from.id}:${to.id}` : undefined}
        points={polygon(a, b, direction * va, direction * vb)} fill={color} stroke={color} strokeWidth={.5} />;
    });
  });
  const origin = project(0, .13, 0), outer = project(extent, .13, 0);
  const label = bandHz ? `${fmt(bandHz[0])}–${fmt(bandHz[1])} Hz` : finiteAmplitude(frequencyHz) ? `${fmt(frequencyHz)} Hz` : "当前频带";
  return <section className="measurement-response-3d" aria-label="三维幅值分布">
    <div className="measurement-response-3d-heading"><div><h3>三维幅值分布</h3><span>{label} · {showNegativeReference ? "零位与 ±RMS 参考" : "RMS 大小"}</span></div>
      <Button type="button" variant="ghost" onClick={() => { setYaw(-25); setElevation(30); setGain(.18); }}>复位视图</Button>
    </div>
    {extent > 0 && valid.length > 0 ? <>
      <div className="measurement-response-3d-canvas">
        <div className="measurement-response-3d-projection">
          <svg viewBox="0 0 1000 420" role="img" aria-label={showNegativeReference ? "真实测点 RMS 幅值与正负尺度参考，非实测振动轨迹" : "真实测点 RMS 大小，非实测振动轨迹"}>
            <title>{(showNegativeReference ? "实测 RMS 大小保持非负；负向面为镜像参考，不是负振幅、实测极值或瞬时姿态。" : "实测 RMS 大小保持非负，不是实测极值或瞬时姿态。") + "灰色面为示意零位，没有推算相位或叶尖。"}</title>
            {showNegativeReference && <g className="measurement-response-negative" data-response-negative-reference="rms-mirror">{mesh(-1)}</g>}
            <polygon data-response-zero-plane="true" points={polygon(0, extent, 0, 0)} fill="#e7edf4" fillOpacity={.85} stroke="#72859d" strokeDasharray="5 4" />
            {mesh(1)}
            <line x1={origin[0]} y1={origin[1]} x2={outer[0]} y2={outer[1]} stroke="#93a5bc" strokeWidth="1.5" />
            {located.map(p => {
              const known = finiteAmplitude(p.normalizedAmplitude), pos = project(p.radiusM, 0, known ? p.normalizedAmplitude! : 0);
              const zero = project(p.radiusM, 0, 0), negative = project(p.radiusM, 0, known ? -p.normalizedAmplitude! : 0);
              return <g key={p.id}>
                {known && showNegativeReference && <>
                  <line x1={pos[0]} y1={pos[1]} x2={negative[0]} y2={negative[1]} stroke="#7893b3" strokeDasharray="3 4" />
                  <circle data-response-negative-point={p.id} data-reference-amplitude={-p.normalizedAmplitude!}
                    cx={negative[0]} cy={negative[1]} r={4} fill="#fff" stroke="#7893b3" strokeWidth={1.5}>
                    <title>{`${p.name} · −RMS 镜像参考，不是实测负峰值`}</title>
                  </circle>
                  <circle cx={zero[0]} cy={zero[1]} r={2.5} fill="#72859d" />
                </>}
                <circle data-response-point={p.id} data-radius-m={p.radiusM} data-amplitude={known ? p.normalizedAmplitude : "missing"}
                cx={pos[0]} cy={pos[1]} r={6} fill={known ? "#174775" : "#fff"} stroke={known ? "#fff" : "#7b8ca4"} strokeWidth={2}>
                <title>{`${p.name} · 距中心 ${fmt(p.radiusM)} m · ${known ? `归一化幅值 ${fmt(p.normalizedAmplitude!)}${finiteAmplitude(p.displacementRmsM) ? ` · 位移 RMS ${fmt(p.displacementRmsM * 1e6)} μm` : ""}` : "缺测"}`}</title>
              </circle></g>;
            })}
            <g className="measurement-response-scale-labels" aria-hidden="true">
              {(showNegativeReference ? [1, 0, -1] : [1, 0]).map(sign => {
                const pos = project(extent, -.12, sign * amplitudeExtent);
                return <text key={sign} x={Math.min(900, pos[0] + 42)} y={pos[1] + 4}>{sign === 0 ? "零位参考" : sign === 1 ? "+RMS" : "−RMS 参考"}</text>;
              })}
            </g>
          </svg>
          <div className="measurement-response-3d-labels" aria-hidden="true">{located.map(p => {
            const known = finiteAmplitude(p.normalizedAmplitude), pos = project(p.radiusM, 0, known ? p.normalizedAmplitude! : 0);
            return <span key={p.id} className={known ? "" : "missing"} style={{ left: `${pos[0] / 10}%`, top: `${pos[1] / 4.2}%` }}>{p.name}{known ? "" : " · 缺测"}</span>;
          })}</div>
        </div>
      </div>
      <div className="measurement-response-3d-axis"><span>0 = 风机中心</span><span>距中心 / m</span><span>最远测点 {fmt(extent)} m（非叶尖）</span></div>
      <div className="measurement-response-3d-legend"><span>0</span><i aria-hidden="true" /><span>{fmt(amplitudeExtent)}</span><span>归一化 RMS 大小</span><small>灰面：零位参考</small></div>
      <label className="measurement-response-reference-toggle"><input type="checkbox" checked={showNegativeReference} onChange={e => setShowNegativeReference(e.target.checked)} />显示负向尺度参考（非实测负峰值）</label>
    </> : <div className="measurement-response-3d-empty">缺少有效测点或位置，暂不能绘制三维分布。</div>}
    {unknown.length > 0 && <p className="measurement-response-3d-note">{unknown.map(p => p.name).join("、")} 的位置未知，仅显示已知测点，不做面插值。</p>}
    {duplicate && <p className="measurement-response-3d-note">存在重复半径，相关区间不做面插值。</p>}
    <details className="measurement-response-3d-settings"><summary>显示设置</summary><div>
      <label>视角 <output>{yaw}°</output><input aria-label="三维幅值水平视角" type="range" min={-65} max={65} step={1} value={yaw} onChange={e => setYaw(Number(e.target.value))} /></label>
      <label>俯仰 <output>{elevation}°</output><input aria-label="三维幅值俯仰视角" type="range" min={10} max={70} step={1} value={elevation} onChange={e => setElevation(Number(e.target.value))} /></label>
      <label>显示变形 <output>{Math.round(gain * 100)}%</output><input aria-label="三维幅值显示变形" type="range" min={.02} max={.3} step={.01} value={gain} onChange={e => setGain(Number(e.target.value))} /></label>
    </div></details>
    <p className="measurement-response-3d-note">RMS 表示振动大小，始终非负。上下参考面仅为 ±RMS 尺度，不是最大摆幅或真实运动边界；灰面不代表测得的平衡姿态。外形仅示意，测点间插值，不补根部或叶尖。</p>
  </section>;
}
