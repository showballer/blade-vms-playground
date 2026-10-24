"use client";
import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "./common";
import { isTurntablePort } from "./field-turntable-port";
import { fieldIsActive, type FieldDriveMotionProfile, type FieldDriveProfileRead, type FieldRequestOptions, type FieldStatus } from "./field-types";

const parameters = [
  { key: "accel_ms", label: "加速时间 · PA40", min: 1, max: 10000 },
  { key: "decel_ms", label: "减速时间 · PA41", min: 1, max: 10000 },
  { key: "s_curve_ms", label: "S 曲线时间 · PA42", min: 0, max: 1000 },
] as const;
type Draft = Record<keyof FieldDriveMotionProfile, string>;
type AxisState = { draft: Draft; read?: FieldDriveProfileRead; error?: string; notice?: string };
const emptyAxis = (): AxisState => ({ draft: { accel_ms: "", decel_ms: "", s_curve_ms: "" } });
export const driveProfileFastPreset = {
  speedRpm: 5,
  values: { accel_ms: 100, decel_ms: 100, s_curve_ms: 0 },
} as const;

export function checkedDriveProfile(draft: Draft): FieldDriveMotionProfile {
  const result = {} as FieldDriveMotionProfile;
  for (const parameter of parameters) {
    const raw = draft[parameter.key], value = Number(raw);
    if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isInteger(value) || value < parameter.min || value > parameter.max)
      throw new Error(`${parameter.label}须为 ${parameter.min}～${parameter.max} ms 的整数`);
    result[parameter.key] = value;
  }
  return result;
}
export function checkedDriveProfileReply(next: FieldStatus, port: string, axis: 1 | 2, operation: "read" | "write", expected?: FieldDriveMotionProfile) {
  const read = next.turntable?.motionProfile;
  if (next.turntable?.port !== port || next.turntable.error || !read || read.axis !== axis ||
      read.operation !== operation || read.verified !== true || read.temporary !== true || !Number.isFinite(read.readAt) || read.readAt <= 0)
    throw new Error("未收到当前轴的有效参数读回，请重新读取");
  for (const parameter of parameters) {
    const value = read.values?.[parameter.key];
    if (!Number.isInteger(value) || value < parameter.min || value > parameter.max || expected && value !== expected[parameter.key])
      throw new Error("驱动参数读回不一致，请重新读取");
  }
  return read;
}

export function FieldDriveProfile({ port, status, disabled, request, onStatus, onBusy, expanded, onFastPreset }: {
  port: string; status: FieldStatus | null; disabled: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>; onStatus: (status: FieldStatus) => void; onBusy: (busy: boolean) => void;
  expanded?: boolean; onFastPreset?: () => void;
}) {
  const [axes, setAxes] = useState<Record<1 | 2, AxisState>>(() => ({ 1: emptyAxis(), 2: emptyAxis() }));
  const [pending, setPending] = useState<{ axis: 1 | 2; operation: "read" | "write" } | null>(null);
  const alive = useRef(false), sequence = useRef(0), inFlight = useRef(false);
  const latest = useRef({ port, generation: status?.service.generation });
  latest.current = { port, generation: status?.service.generation };
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; onBusy(false); }; }, [onBusy]);
  useEffect(() => { sequence.current++; setAxes({ 1: emptyAxis(), 2: emptyAxis() }); }, [port, status?.service.generation]);
  const blocked = disabled || status?.service.state !== "ready" || !isTurntablePort(port) ||
    fieldIsActive(status) || !!status?.deviceBusy || !!status?.turntableBusy;
  const patchAxis = (axis: 1 | 2, patch: Partial<AxisState>) => setAxes(previous => ({ ...previous, [axis]: { ...previous[axis], ...patch } }));
  const fillFastPreset = () => {
    if (blocked || inFlight.current || !axes[1].read || !axes[2].read || !onFastPreset) return;
    const draft: Draft = { accel_ms: String(driveProfileFastPreset.values.accel_ms),
      decel_ms: String(driveProfileFastPreset.values.decel_ms), s_curve_ms: String(driveProfileFastPreset.values.s_curve_ms) };
    setAxes(previous => ({
      1: { ...previous[1], draft: { ...draft }, error: "", notice: "快速预设已填入，尚未应用到驱动器" },
      2: { ...previous[2], draft: { ...draft }, error: "", notice: "快速预设已填入，尚未应用到驱动器" },
    }));
    onFastPreset();
  };
  async function run(axis: 1 | 2, operation: "read" | "write") {
    if (blocked || inFlight.current) return;
    const selected = axes[axis], generation = status?.service.generation;
    let values: FieldDriveMotionProfile | undefined;
    if (operation === "write") {
      if (!selected.read) return;
      try { values = checkedDriveProfile(selected.draft); }
      catch (cause) { patchAxis(axis, { error: (cause as Error).message }); return; }
    }
    const token = ++sequence.current;
    inFlight.current = true; setPending({ axis, operation }); onBusy(true);
    patchAxis(axis, { error: "", notice: "" });
    try {
      const next = await request<FieldStatus>({ action: "turntable", request: {
        action: operation === "read" ? "read_motion_profile" : "set_motion_profile", port, axis,
        ...(values ? { motionProfile: values, expectedMotionProfile: selected.read!.values } : {}),
      } });
      if (!alive.current || token !== sequence.current || latest.current.port !== port ||
          latest.current.generation !== generation || next.service.generation !== generation) return;
      const read = checkedDriveProfileReply(next, port, axis, operation, values);
      patchAxis(axis, { read, draft: { accel_ms: String(read.values.accel_ms), decel_ms: String(read.values.decel_ms), s_curve_ms: String(read.values.s_curve_ms) },
        notice: operation === "write" ? "已应用并读回确认" : "已读取实际参数" });
      onStatus(next);
    } catch (cause) {
      if (alive.current && token === sequence.current) patchAxis(axis, { read: undefined, notice: "",
        error: `${cause instanceof Error ? cause.message : "驱动参数操作失败"}；请重新读取实际值。` });
    } finally {
      inFlight.current = false;
      if (alive.current) { setPending(null); onBusy(false); }
    }
  }
  return <details className="field-card field-drive-profile" open={expanded || undefined}>
    <summary>驱动器加减速设置 <span className="field-subtext">PA40 / PA41 / PA42</span></summary>
    {onFastPreset && <div className="field-drive-profile-footer">
      <span className="field-subtext">{driveProfileFastPreset.speedRpm} rpm · 100 / 100 / 0 ms</span>
      <Button type="button" disabled={blocked || !!pending || !axes[1].read || !axes[2].read}
        onClick={fillFastPreset}>填入快速预设</Button>
    </div>}
    {!isTurntablePort(port) && <p className="field-subtext">请先在下方选择转盘串口。</p>}
    <div className="field-drive-profile-axes">{([1, 2] as const).map(axis => {
      const item = axes[axis], name = axis === 1 ? "俯仰轴" : "水平轴";
      let valid = false; try { checkedDriveProfile(item.draft); valid = true; } catch { /* Blank or incomplete fields cannot be applied. */ }
      return <section key={axis} aria-label={`${name}驱动参数`} className="field-drive-profile-axis">
        <div className="field-section-heading"><h3>{name}</h3><Button type="button" disabled={blocked || !!pending} onClick={() => void run(axis, "read")} aria-label={`读取${name}驱动参数`}>
          {pending?.axis === axis && pending.operation === "read" ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}读取</Button></div>
        <div className="field-drive-profile-inputs">{parameters.map(parameter => <label key={parameter.key}><span>{parameter.label}（ms）</span>
          <input aria-label={`${name}${parameter.label}`} type="number" min={parameter.min} max={parameter.max} step={1} placeholder="先读取"
            disabled={blocked || !!pending || !item.read} value={item.draft[parameter.key]}
            onChange={event => patchAxis(axis, { draft: { ...item.draft, [parameter.key]: event.target.value }, error: "", notice: "" })} />
        </label>)}</div>
        <div className="field-drive-profile-footer"><span className="field-subtext">{item.read ? `读回 ${new Date(item.read.readAt * 1000).toLocaleTimeString("zh-CN", { hour12: false })} · ${item.read.values.accel_ms} / ${item.read.values.decel_ms} / ${item.read.values.s_curve_ms} ms` : "尚未读取当前轴"}</span>
          <Button type="button" disabled={blocked || !!pending || !item.read || !valid} onClick={() => void run(axis, "write")} aria-label={`应用${name}驱动参数`}>
            {pending?.axis === axis && pending.operation === "write" && <LoaderCircle size={14} className="spin" />}应用到{name}</Button></div>
        {item.error && <p className="field-error" role="alert">{item.error}</p>}
        {item.notice && <p className="field-subtext" role="status">{item.notice}</p>}
      </section>;
    })}</div>
  </details>;
}
