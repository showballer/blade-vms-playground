"use client";
import React, { useEffect, useRef, useState } from "react";
import { Calculator, LockKeyhole, Settings } from "lucide-react";
import { Button, CustomSelect } from "./common";
import type { FieldRequestOptions, FieldStatus } from "./field-types";
import type { FieldMotionTrialConfig, FieldMotionTrialPreview } from "./field-motion-trial-types";

const key = "blade-motion-trial-geometry-v1";
/** Initial geometry supplied for this model. No feedback/reference authority is stored. */
export const currentRotorModel = { distanceM: 2.86, hubHeightDeltaM: 1.46, radiusM: 0.31, periodSeconds: 30, rotationDirection: "clockwise" as const };
export const motionTrialDefaults: FieldMotionTrialConfig = { ...currentRotorModel, axis1Sign: 1, axis2Sign: 1 };
const format = (value: number | undefined | null, digits = 3) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
export function motionTrialInputError(config: FieldMotionTrialConfig) {
  if (![config.distanceM, config.hubHeightDeltaM, config.radiusM, config.periodSeconds].every(Number.isFinite)) return "请填写完整的几何尺寸和每圈时间。";
  if (config.distanceM < .001 || config.distanceM > 10000 || config.radiusM < .001 || config.radiusM > 1000 || Math.abs(config.hubHeightDeltaM) > 10000) return "几何尺寸超出允许范围，请核对单位为米。";
  if (config.periodSeconds < .5 || config.periodSeconds > 3600) return "每圈时间须在 0.5–3600 秒内。";
  if (![1, -1].includes(config.axis1Sign) || ![1, -1].includes(config.axis2Sign)) return "请核对两轴方向映射。";
  if (!["clockwise", "counterclockwise"].includes(config.rotationDirection)) return "请选择有效的叶轮旋转方向。";
  return null;
}
export function readMotionTrialDraft(raw: string | null): FieldMotionTrialConfig {
  const draft = { ...motionTrialDefaults };
  try {
    const saved = JSON.parse(raw || "null");
    if (!saved || typeof saved !== "object") return draft;
    for (const k of ["distanceM", "hubHeightDeltaM", "radiusM", "periodSeconds"] as const) {
      if (typeof saved[k] === "number" && Number.isFinite(saved[k])) draft[k] = saved[k];
      else if (saved[k] === null) draft[k] = NaN;
    }
    for (const k of ["axis1Sign", "axis2Sign"] as const) if ([1, -1].includes(saved[k])) draft[k] = saved[k];
    if (["clockwise", "counterclockwise"].includes(saved.rotationDirection)) draft.rotationDirection = saved.rotationDirection;
  } catch { /* Optional input draft. */ }
  return draft;
}

export function FieldMotionTrialChart({ preview }: { preview: FieldMotionTrialPreview }) {
  const points = preview.trajectory.filter(p => [p.timeSeconds, p.axis1DeltaAngleDeg, p.axis2DeltaAngleDeg].every(Number.isFinite));
  if (!points.length) return <p className="field-subtext">轨迹点尚未生成。</p>;
  const lower = Math.min(0, ...points.flatMap(p => [p.axis1DeltaAngleDeg, p.axis2DeltaAngleDeg]));
  const upper = Math.max(0, ...points.flatMap(p => [p.axis1DeltaAngleDeg, p.axis2DeltaAngleDeg]));
  const padding = Math.max(.2, (upper - lower) * .1), lo = lower - padding, hi = upper + padding;
  const x = (t: number) => 58 + t / Math.max(preview.durationSeconds, .001) * 660, y = (v: number) => 224 - (v - lo) / (hi - lo) * 190;
  const polyline = (axis: 1 | 2) => points.map(p => `${x(p.timeSeconds).toFixed(2)},${y(p[axis === 1 ? "axis1DeltaAngleDeg" : "axis2DeltaAngleDeg"]).toFixed(2)}`).join(" ");
  return <div className="motion-trial-chart"><div className="motion-trial-chart-legend"><span><i />轴1 · 俯仰</span><span><i />轴2 · 水平</span></div><svg viewBox="0 0 750 270" role="img" aria-label="单圈两轴相对6点参考位的理想目标角度曲线，非实测反馈">
    <text x="58" y="18">相对6点参考位 · °</text>
    {[0, 1, 2, 3, 4].map(i => { const v = lo + (hi - lo) * i / 4; return <g key={i}><line x1="58" x2="718" y1={y(v)} y2={y(v)} className="motion-trial-chart-grid" /><text x="48" y={y(v) + 4} textAnchor="end">{format(v, 1)}</text></g>; })}
    {[0, 1, 2, 3, 4].map(i => <text key={i} x={x(preview.durationSeconds * i / 4)} y="245" textAnchor="middle">{format(preview.durationSeconds * i / 4, 2)}</text>)}
    <polyline points={polyline(1)} className="motion-trial-axis-one" /><polyline points={polyline(2)} className="motion-trial-axis-two" /><text x="718" y="266" textAnchor="end">计划时间 · s</text>
  </svg><p className="single-point-note">理想目标曲线；尚未下发指令，也没有实测运动反馈。</p></div>;
}

export function FieldMotionTrial({ request, disabled = false, onTurntable, onBusyChange }: {
  request: <T>(options: FieldRequestOptions) => Promise<T>; disabled?: boolean; onTurntable: () => void; onBusyChange?: (value: boolean) => void;
}) {
  const [config, setConfig] = useState({ ...motionTrialDefaults }), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<FieldMotionTrialPreview | null>(null), [error, setError] = useState("");
  const mounted = useRef(true), version = useRef(0);
  const invalid = motionTrialInputError(config), locked = disabled || busy;
  useEffect(() => { mounted.current = true; try { setConfig(readMotionTrialDraft(localStorage.getItem(key))); } catch {} setLoaded(true); return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (loaded) try { localStorage.setItem(key, JSON.stringify(config)); } catch {} }, [config, loaded]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  function edit<K extends keyof FieldMotionTrialConfig>(field: K, value: FieldMotionTrialConfig[K]) { version.current++; setConfig(p => ({ ...p, [field]: value })); setPreview(null); setError(""); }
  function applyCurrentModel() {
    if (locked) return;
    for (const field of Object.keys(currentRotorModel) as (keyof typeof currentRotorModel)[]) edit(field, currentRotorModel[field]);
  }
  async function calculate() {
    if (locked || invalid) return;
    const current = ++version.current; setBusy(true); setError("");
    try { const result = await request<FieldStatus>({ action: "motionTrial", request: { action: "preview", config } }); if (mounted.current && current === version.current) { if (!result.motionTrialPreview) throw new Error("服务未返回整圈轨迹，请确认客户端与采集服务版本一致。"); setPreview(result.motionTrialPreview); } }
    catch (cause) { if (mounted.current && current === version.current) setError(cause instanceof Error ? cause.message : "轨迹计算失败"); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="field-servo-ui single-point-workspace motion-trial-workspace">
    <div className="single-point-overview"><div><span className="single-point-mode">整圈轨迹 · 按设定叶轮周期</span><p>根据模型几何计算两轴需要执行的角度、速度与加速度。</p></div><span className="field-badge amber">执行接口待接通</span></div>
    <section className="field-card single-point-card"><div className="field-section-heading"><div><h2>模型与周期</h2><p>从激光器一侧面向叶轮观察；顺时针依次为6点→9点→12点→3点→6点。</p></div></div><div className="single-point-model-preset"><div><p>本次模型：距离 2.86 m · 高度差 1.46 m · 半径 0.31 m · 30 s / 圈 · 顺时针</p><p>仅更新几何、周期及旋向；保留两轴方向映射。</p></div><Button disabled={locked} onClick={applyCurrentModel}>应用30秒模型</Button></div><fieldset disabled={locked} className="single-point-fields">
      {([["distanceM", "设备至叶轮平面距离 · m", .001, 10000], ["hubHeightDeltaM", "轮毂高于激光出射点 · m", -10000, 10000], ["radiusM", "轮毂中心至测点半径 · m", .001, 1000], ["periodSeconds", "叶轮每圈时间 · s", .5, 3600]] as const).map(([field, label, min, max]) => <label key={field}>{label}<input aria-label={label} type="number" min={min} max={max} step="any" value={Number.isFinite(config[field]) ? config[field] : ""} onChange={e => edit(field, e.currentTarget.valueAsNumber)} /></label>)}
      <label>从激光器一侧看的旋转方向<CustomSelect aria-label="试运行旋转方向" value={config.rotationDirection} onChange={e => edit("rotationDirection", e.target.value as FieldMotionTrialConfig["rotationDirection"])}><option value="clockwise">顺时针</option><option value="counterclockwise">逆时针</option></CustomSelect></label>
      {([1, 2] as const).map(axis => <label key={axis}>轴 {axis} 几何方向映射<CustomSelect aria-label={`试运行轴 ${axis} 方向映射`} value={config[`axis${axis}Sign`]} onChange={e => edit(`axis${axis}Sign`, Number(e.target.value) as 1 | -1)}><option value={1}>正向 · +1</option><option value={-1}>反向 · −1</option></CustomSelect></label>)}
    </fieldset><div className="single-point-actions"><p className="single-point-note">叶轮转速 {format(60 / config.periodSeconds, 2)} rpm；转盘两轴速度由几何轨迹计算。</p><Button variant="primary" disabled={locked || Boolean(invalid)} onClick={() => void calculate()}><Calculator size={15} />{busy ? "正在计算" : "计算整圈轨迹"}</Button></div>{invalid && <p className="field-notice" role="status">{invalid}</p>}{error && <p className="field-error" role="alert">{error}</p>}</section>
    <section className="field-card single-point-card"><div className="field-section-heading"><div><h2>单圈轨迹与速度需求</h2><p>{preview?.anchorBound ? "已绑定6点参考位。" : "尚未读取现场6点参考位，当前只展示相对角度；不能据此直接下发绝对位置。"}</p></div><span className="field-badge">{preview ? `${format(preview.durationSeconds)} s / 圈 · ${format(preview.rotorRpm, 2)} rpm` : "等待计算"}</span></div>
      {preview ? <><FieldMotionTrialChart preview={preview} /><div className="field-table-scroll motion-trial-table" role="region" aria-label="整圈轨迹两轴需求，可横向滚动" tabIndex={0}><table className="field-table"><thead><tr><th>轴</th><th>相对角度范围</th><th>峰值速度</th><th>峰值输出转速</th><th>峰值加速度</th></tr></thead><tbody>{preview.axisSummaries.map(axis => <tr key={axis.axis}><td>轴 {axis.axis} · {axis.axis === 1 ? "俯仰" : "水平"}</td><td>{format(axis.minRelativeAngleDeg)}° ～ {format(axis.maxRelativeAngleDeg)}°</td><td>{format(axis.peakSpeedDegS)} °/s</td><td>{format(axis.peakSpeedRpm)} rpm</td><td>{format(axis.peakAccelerationDegS2)} °/s²</td></tr>)}</tbody></table></div><p className="single-point-note">完整轨迹需要加速进入、按周期运行及减速退出；启动和停稳的总时间不能直接记为一圈时间。</p>{!!preview.warnings?.length && <details className="single-point-advanced"><summary>轨迹计算说明</summary><ul className="single-point-notes">{preview.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>}</> : <div className="motion-trial-empty"><Calculator size={24} /><p>点击“计算整圈轨迹”查看从6点起始的完整周期曲线。</p><span>此操作只计算参数，不连接串口、不启动激光或采集。</span></div>}
    </section>
    <section className="field-card single-point-card motion-trial-execution"><div className="field-section-heading"><div><h2>真实设备执行</h2><p>当前控制协议尚未支持整圈轨迹，需接通配套控制板固件后才能按计划执行。</p></div><LockKeyhole size={18} /></div><div className="single-point-actions"><Button variant="primary" disabled title="整圈连续轨迹执行接口尚未接通">启动整圈试运行</Button><Button variant="ghost" onClick={onTurntable}><Settings size={15} />查看转盘状态与停止控制</Button></div>{!!preview?.blockReasons?.length && <ul className="single-point-reasons">{preview.blockReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}<p className="single-point-note">预览没有发送运动指令。实际指令、反馈和耗时需待执行接口接通后采集；当前没有实测执行结果。</p></section>
  </div>;
}
