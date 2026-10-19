"use client";
import { CustomSelect } from "./custom-select";
import React, { memo, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { AudioLines, LoaderCircle } from "lucide-react";
import { Button } from "./common";
import type { FieldRecordingDetail, FieldRequestOptions, FieldWaveform } from "./field-types";

export type TimeMode = "relative" | "clock";
export type VelocityUnit = "m/s" | "mm/s";
export const hasWave = (wave?: FieldWaveform) => Boolean(wave && (wave.values.length || wave.envelope?.length));
export function waveBounds(wave: FieldWaveform): [number, number] {
  return [wave.rangeStart ?? wave.sampleStart, wave.rangeEnd ?? (wave.sampleStart + Math.max(1, wave.values.length) * (wave.sampleStride || 1))];
}
export function clampWaveRange(start: number, end: number, total: number): [number, number] {
  const width = Math.min(Math.max(1, Math.round(end - start)), Math.max(1, total));
  const from = Math.max(0, Math.min(Math.round(start), total - width));
  return [from, from + width];
}
export function formatWaveTime(sample: number, wave: FieldWaveform, mode: TimeMode): string {
  if (!wave.sampleRate) return String(Math.round(sample));
  const seconds = sample / wave.sampleRate;
  if (mode === "clock" && typeof wave.sampleOrigin === "number") {
    const date = new Date((wave.sampleOrigin + seconds) * 1000);
    return `${date.toLocaleTimeString("zh-CN", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
  }
  return (seconds * 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

export const FieldWaveChart = memo(function FieldWaveChart({ waveform, kind = "velocity", timeMode = "relative", unit = "m/s", yLimit, compact = false, onPan }: {
  waveform?: FieldWaveform; kind?: "velocity" | "rssi"; timeMode?: TimeMode; unit?: VelocityUnit;
  yLimit?: number; compact?: boolean; onPan?: (fraction: number) => void;
}) {
  const clip = useId();
  const pointer = useRef<number | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [plotWidth, setPlotWidth] = useState(850);
  useEffect(() => {
    if (!element) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.round(element.clientWidth);
        if (width > 0) setPlotWidth(previous => previous === width ? previous : width);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [element]);
  const chart = useMemo(() => {
    if (!waveform || !hasWave(waveform)) return null;
    const factor = kind === "velocity" && unit === "mm/s" ? 1000 : 1;
    const data = kind === "rssi" ? waveform.rssi : waveform.values;
    const envelope = waveform.envelope || [];
    let largest = 0, finiteCount = 0;
    const include = (value: number | null) => {
      if (typeof value === "number" && Number.isFinite(value)) { largest = Math.max(largest, Math.abs(value)); finiteCount++; }
    };
    for (const value of data) include(value);
    for (const bucket of envelope) {
      include(kind === "rssi" ? bucket.rssiMin : bucket.min);
      include(kind === "rssi" ? bucket.rssiMax : bucket.max);
    }
    if (!finiteCount) return null;
    // Reserve separate rows for time ticks and the axis title, while keeping
    // the original plotting height in both the normal and compact charts.
    const width = Math.max(260, plotWidth), height = compact ? 140 : kind === "rssi" ? 185 : 300;
    const left = 76, right = 48, top = 20, bottom = 60;
    const limit = yLimit && yLimit > 0 ? yLimit : Math.max(0.000001, largest) * 1.12;
    const minimum = kind === "rssi" ? 0 : -limit * factor;
    const maximum = kind === "rssi" ? 100 : limit * factor;
    const [start, end] = waveBounds(waveform);
    const pointX = (sample: number) => left + (sample - start) / Math.max(1, end - start) * (width - left - right);
    const pointY = (value: number) => top + (maximum - value * factor) / (maximum - minimum) * (height - top - bottom);
    let lastValid = false;
    const isolated: { sample: number; value: number }[] = [];
    const path = envelope.length ? envelope.map(bucket => {
      const lo = kind === "rssi" ? bucket.rssiMin : bucket.min, hi = kind === "rssi" ? bucket.rssiMax : bucket.max;
      if (lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi)) return "";
      const x = pointX((bucket.start + bucket.end) / 2);
      return `M${x.toFixed(2)},${pointY(lo).toFixed(2)} L${(x + 0.15).toFixed(2)},${pointY(hi).toFixed(2)}`;
    }).join(" ") : data.map((value, index) => {
      if (typeof value !== "number" || !Number.isFinite(value)) { lastValid = false; return ""; }
      const command = lastValid ? "L" : "M";
      const sample = waveform.sampleStart + index * (waveform.sampleStride || 1);
      const next = data[index + 1];
      // An isolated M command has no visible stroke. Show the actual sample
      // without interpolating across nulls (including lower-rate RSSI gaps).
      if (!lastValid && (typeof next !== "number" || !Number.isFinite(next))) isolated.push({ sample, value });
      lastValid = true;
      return `${command}${pointX(sample).toFixed(2)},${pointY(value).toFixed(2)}`;
    }).join(" ");
    return { width, height, left, right, top, bottom, minimum, maximum, pointX, pointY, path, isolated, start, end,
      clipped: kind === "velocity" && largest > limit };
  }, [waveform, kind, yLimit, unit, compact, plotWidth]);
  if (!chart || !waveform) return <div className={`field-chart-empty ${kind === "rssi" || compact ? "compact" : ""}`}><AudioLines size={28} /><strong>{kind === "rssi" ? "等待 RSSI 数据" : "等待振动数据"}</strong><span>开始采集后显示输入波形。</span></div>;
  const { width, height, left, right, top, bottom, minimum, maximum, pointY, pointX, path, start, end } = chart;
  const format = (value: number) => Math.abs(value) > 0 && Math.abs(value) < 0.001 ? value.toExponential(1) : Number(value.toPrecision(5)).toLocaleString("zh-CN");
  const endpointLabels = [start, end].map(sample => formatWaveTime(sample, waveform, timeMode));
  const labelWidth = Math.max(...endpointLabels.map(label => label.length * 7.2));
  const timeTicks = Math.max(2, Math.min(5, Math.floor((width - left - right) / Math.max(86, labelWidth + 24)) + 1));
  return <div className="field-plot" ref={setElement}><svg className={`field-wave-svg ${onPan ? "pannable" : ""}`} viewBox={`0 0 ${width} ${height}`} role="img"
    aria-label={kind === "rssi" ? "RSSI 回波强度曲线，单位百分比" : unit === "m/s" ? "CH1 振动速度曲线，单位米每秒" : "CH1 振动速度曲线，单位毫米每秒"}
    onPointerDown={event => { if (onPan) { pointer.current = event.clientX; event.currentTarget.setPointerCapture(event.pointerId); } }}
    onPointerUp={event => { if (onPan && pointer.current !== null) { const delta = (pointer.current - event.clientX) / (event.currentTarget.getBoundingClientRect().width * (width - left - right) / width); pointer.current = null; if (Math.abs(delta) > 0.003) onPan(delta); } }}
    onPointerCancel={() => { pointer.current = null; }}>
    <defs><clipPath id={clip}><rect x={left} y={top} width={width - left - right} height={height - top - bottom} /></clipPath></defs>
    {Array.from({ length: kind === "rssi" || compact ? 3 : 5 }, (_, index) => {
      const value = minimum + (maximum - minimum) * index / (kind === "rssi" || compact ? 2 : 4);
      const y = top + (maximum - value) / (maximum - minimum) * (height - top - bottom);
      return <g key={index}><line x1={left} y1={y} x2={width - right} y2={y} stroke="#e9eef5" strokeDasharray="3 3" /><text style={{ fontSize: 12 }} x={left - 9} y={y + 4} textAnchor="end">{format(value)}</text></g>;
    })}
    {Array.from({ length: timeTicks }, (_, index) => {
      const sample = start + (end - start) * index / (timeTicks - 1);
      const label = formatWaveTime(sample, waveform, timeMode), halfWidth = label.length * 3.6;
      const labelX = Math.max(halfWidth + 4, Math.min(pointX(sample), width - halfWidth - 4));
      return <g key={index}><line x1={pointX(sample)} y1={height - bottom} x2={pointX(sample)} y2={height - bottom + 4} stroke="#d9e3ef" /><text style={{ fontSize: 12 }} x={labelX} y={height - bottom + 20} textAnchor="middle">{label}</text></g>;
    })}
    <g clipPath={`url(#${clip})`}><path d={path} fill="none" stroke={kind === "rssi" ? "#17976d" : "#2d6cc0"} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      {chart.isolated.map(point => <circle key={point.sample} cx={pointX(point.sample)} cy={pointY(point.value)} r="2" fill={kind === "rssi" ? "#17976d" : "#2d6cc0"} />)}</g>
    <text style={{ fontSize: 12 }} x={left} y={top - 7}>{kind === "rssi" ? "%" : unit}</text>
    <text className="field-wave-axis-label" style={{ fontSize: 12 }} x={(left + width - right) / 2} y={height - 8} textAnchor="middle">{waveform.sampleRate ? timeMode === "clock" && waveform.sampleOrigin != null ? "本机时间" : "相对时间 / ms" : "样本序号"}</text>
  </svg>{chart.clipped && <small className="field-plot-warning">部分信号超出当前显示纵轴，请调大范围；这不等于设备超量程。</small>}</div>;
});

export type WaveScaleDraft = { draft: string; unit: VelocityUnit; editing: boolean; invalid: boolean };
export function waveScaleDraft(state: WaveScaleDraft, action:
  | { type: "sync"; scale: number; unit: VelocityUnit }
  | { type: "focus" } | { type: "edit"; draft: string } | { type: "commit"; valid: boolean }): WaveScaleDraft {
  if (action.type === "focus") return { ...state, editing: true };
  if (action.type === "edit") return { ...state, draft: action.draft, editing: true, invalid: false };
  if (action.type === "commit") return { ...state, editing: !action.valid, invalid: !action.valid };
  // Live auto-range updates must never erase an in-progress or invalid user entry.
  if (state.editing && state.unit === action.unit) return state;
  return { draft: String(Number((action.scale * (action.unit === "mm/s" ? 1000 : 1)).toPrecision(8))), unit: action.unit, editing: false, invalid: false };
}

export function FieldWaveOptions({ timeMode, onTime, unit, onUnit, scale, onScale, fit }: {
  timeMode: TimeMode; onTime: (value: TimeMode) => void; unit: VelocityUnit; onUnit: (value: VelocityUnit) => void;
  scale: number; onScale: (value: number) => void; fit?: () => void;
}) {
  const [{ draft, invalid }, dispatch] = useReducer(waveScaleDraft, { draft: "", unit, editing: false, invalid: false });
  useEffect(() => { dispatch({ type: "sync", scale, unit }); }, [scale, unit]);
  function commit() { const value = Number(draft) / (unit === "mm/s" ? 1000 : 1); const valid = draft.trim() !== "" && Number.isFinite(value) && value > 0 && value <= 1e6; dispatch({ type: "commit", valid }); if (valid) onScale(value); }
  return <div className="field-wave-options"><label>横坐标<CustomSelect aria-label="横坐标" value={timeMode} onChange={event => onTime(event.target.value as TimeMode)}><option value="relative">相对采集时间</option><option value="clock">实际时间（本机推算）</option></CustomSelect></label>
    <label>速度单位<CustomSelect aria-label="速度单位" value={unit} onChange={event => onUnit(event.target.value as VelocityUnit)}><option value="mm/s">mm/s</option><option value="m/s">m/s</option></CustomSelect></label>
    <label>固定纵轴 ±（{unit}）<input aria-label="固定纵轴范围" aria-invalid={invalid} title="回车或离开输入框生效" type="number" min={unit === "mm/s" ? 0.000001 : 0.000000001} step="any" value={draft} onFocus={() => dispatch({ type: "focus" })} onChange={event => dispatch({ type: "edit", draft: event.target.value })} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />{invalid && <small>请输入有效正数</small>}</label>
    {fit && <Button onClick={fit}>适配当前幅值</Button>}
  </div>;
}
export function waveLimit(wave?: FieldWaveform): number {
  if (!wave) return 0.5;
  let largest = 0.000001;
  for (const value of wave.values) if (Number.isFinite(value)) largest = Math.max(largest, Math.abs(value));
  for (const item of wave.envelope || []) for (const value of [item.min, item.max]) if (Number.isFinite(value)) largest = Math.max(largest, Math.abs(value));
  return largest * 1.2;
}

export function FieldRecordingViewer({ detail, load, onError }: {
  detail: FieldRecordingDetail; load: <T>(options: FieldRequestOptions) => Promise<T>; onError: (cause: unknown) => void;
}) {
  const [overview, setOverview] = useState<FieldRecordingDetail | null>(null);
  const [view, setView] = useState<FieldRecordingDetail | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [timeMode, setTimeMode] = useState<TimeMode>("clock"), [unit, setUnit] = useState<VelocityUnit>("mm/s"), [scale, setScale] = useState(0.5);
  const [from, setFrom] = useState("0"), [to, setTo] = useState("");
  const pending = useRef<Promise<unknown> | null>(null);
  const drag = useRef<{ x: number; range: [number, number]; mode: string } | null>(null);
  useEffect(() => {
    let canceled = false;
    setLoading(true); setError("");
    const timer = setTimeout(async () => {
      try {
        await pending.current?.catch(() => {});
        if (canceled) return;
        const request = load<FieldRecordingDetail>({ action: "waveform", id: detail.recording.id, ...(range ? { start: range[0], end: range[1] } : {}) });
        pending.current = request;
        const result = await request;
        if (canceled) return;
        setView(result);
        if (!range) { setOverview(result); setScale(waveLimit(result.waveform)); }
      } catch (cause) {
        if (!canceled) { setError(cause instanceof Error ? cause.message : "波形读取失败"); onError(cause); }
      } finally { if (!canceled) setLoading(false); }
    }, 180);
    return () => { canceled = true; clearTimeout(timer); };
  }, [detail.recording.id, range, revision, load, onError]);
  const total = overview?.recording.samples || detail.recording.samples;
  const rate = overview?.recording.sampleRate || detail.recording.sampleRate || 0;
  const chosen: [number, number] = range || [0, total];
  useEffect(() => { if (rate) { setFrom((chosen[0] / rate).toFixed(6)); setTo((chosen[1] / rate).toFixed(6)); } }, [chosen[0], chosen[1], rate]);
  function select(start: number, end: number) { if (total) setRange(clampWaveRange(start, end, total)); }
  function zoom(factor: number) { const center = (chosen[0] + chosen[1]) / 2, half = Math.max(1, chosen[1] - chosen[0]) * factor / 2; select(center - half, center + half); }
  function pan(fraction: number) { const shift = (chosen[1] - chosen[0]) * fraction; select(chosen[0] + shift, chosen[1] + shift); }
  const wave = view?.waveform;
  return <div className="field-full-waveform"><p className="field-subtext">完整记录 {total.toLocaleString("zh-CN")} 点 · {rate ? `${(total / rate).toFixed(3)} 秒` : "采样率未知"}。拖动概览选区或下方波形平移；缩小选区查看逐点数据。</p>
    {overview?.waveform && hasWave(overview.waveform) && <div className="field-wave-overview"><strong>全程概览 · 拖动选区两侧改变范围</strong><FieldWaveChart waveform={overview.waveform} unit={unit} compact timeMode={timeMode} />
      <div className="field-overview-track" style={{ left: 76, right: 48 }} onPointerMove={event => {
        if (!drag.current) return;
        const delta = (event.clientX - drag.current.x) / event.currentTarget.getBoundingClientRect().width * total;
        const [lo, hi] = drag.current.range;
        if (drag.current.mode === "start") select(Math.max(0, Math.min(hi - 1, lo + delta)), hi);
        else if (drag.current.mode === "end") select(lo, Math.min(total, Math.max(lo + 1, hi + delta)));
        else select(lo + delta, hi + delta);
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <div className="field-overview-selection" style={{ left: `${chosen[0] / total * 100}%`, width: `${Math.max(0.3, (chosen[1] - chosen[0]) / total * 100)}%` }}
          onPointerDown={event => { const track = event.currentTarget.parentElement!; track.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, range: chosen, mode: (event.target as HTMLElement).dataset.mode || "pan" }; }}>
          <span data-mode="start" title="拖动起点" /><span data-mode="end" title="拖动终点" /></div>
      </div></div>}
    {total > 0 && <><div className="field-wave-options"><Button onClick={() => pan(-0.8)} disabled={!overview}>← 前一段</Button><Button onClick={() => zoom(0.5)} disabled={!overview}>放大 ×2</Button><Button onClick={() => zoom(2)} disabled={!overview}>缩小 ×2</Button><Button onClick={() => pan(0.8)} disabled={!overview}>后一段 →</Button><Button onClick={() => { setRange(null); setRevision(value => value + 1); }}>显示全程 / 刷新</Button></div>
      <div className="field-range-inputs"><label>起点（秒）<input aria-label="波形起点秒" type="number" min="0" step="any" value={from} onChange={event => setFrom(event.target.value)} /></label><label>终点（秒）<input aria-label="波形终点秒" type="number" min="0" step="any" value={to} onChange={event => setTo(event.target.value)} /></label><Button disabled={!rate || !overview} onClick={() => { const start = Number(from), end = Number(to); if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > total / rate + 0.000001) { setError("请输入记录范围内、终点大于起点的有效秒数。"); return; } select(Math.floor(start * rate), Math.ceil(end * rate)); }}>查看时间段</Button></div>
      <label className="field-pan-slider">横向浏览<input aria-label="横向浏览波形" type="range" min="0" max={Math.max(0, total - (chosen[1] - chosen[0]))} step="1" value={chosen[0]} disabled={!overview || chosen[1] - chosen[0] >= total} onChange={event => { const start = Number(event.target.value); select(start, start + chosen[1] - chosen[0]); }} /></label></>}
    <FieldWaveOptions timeMode={timeMode} onTime={setTimeMode} unit={unit} onUnit={setUnit} scale={scale} onScale={setScale} fit={() => setScale(waveLimit(wave))} />
    {error && <p className="field-error" role="alert">{error}<Button onClick={() => setRevision(value => value + 1)}>重试读取</Button></p>}
    {loading ? <div className="field-wave-loading" role="status"><LoaderCircle className="spin" size={18} />正在读取原始波形；首次生成长记录概览可能需要一些时间。采集与停止控制不受此读取锁阻塞。</div> : !error && <><h3>CH1 · 振动速度</h3><FieldWaveChart waveform={wave} unit={unit} yLimit={scale} timeMode={timeMode} onPan={pan} /><h3>RSSI · 激光回波强度</h3><FieldWaveChart waveform={wave} kind="rssi" timeMode={timeMode} onPan={pan} />
      <p className="field-subtext" data-testid="wave-representation">{wave?.representation === "envelope" ? "当前为区间最小/最大值包络，保留峰值，不是平滑滤波。放大到 4,096 点以内自动显示全部原始点。" : "当前区间显示全部原始点，未做平滑或滤波。"} 选区 {wave?.sourceSamples?.toLocaleString("zh-CN") || 0} 点；超量程 {wave?.overrangeCount || 0} 点；RSSI 缺失 {wave?.missingRssiCount || 0} 点。</p></>}
    <p className="field-subtext">实际时间 = 本机 DAQ 起点 + 样本序号 ÷ 采样率，是推算时间，非设备硬件同步时钟。此处仅选择查看区间，不删除或过滤原始文件；异常/未完成标记继续保留。</p>
  </div>;
}
