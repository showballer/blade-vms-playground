"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, Crosshair, LoaderCircle, Play, RotateCcw, Square, Timer } from "lucide-react";
import { Button, CustomSelect } from "./common";
import { currentRotorModel, FieldMotionTrial } from "./field-motion-trial";
import { fieldIsActive, validateFieldConfig, type FieldConfig, type FieldRequestOptions, type FieldStatus } from "./field-types";
import { isTurntablePort } from "./field-turntable-port";
import type { FieldSinglePointConfig, FieldSinglePointPreview, FieldSinglePointRequest, FieldSinglePointState, FieldSinglePointStatus } from "./field-single-point-types";

const draftKey = "blade-single-point-draft-v1";
export const singlePointDefaults: FieldSinglePointConfig = {
  bladeId: "A", pointId: "P1", pointName: "P1", materialMark: "",
  distanceM: currentRotorModel.distanceM, hubHeightDeltaM: currentRotorModel.hubHeightDeltaM, radiusM: currentRotorModel.radiusM, axis1Sign: 1, axis2Sign: 1,
  rotationDirection: currentRotorModel.rotationDirection, arcDegrees: 20, nominalPeriodSeconds: currentRotorModel.periodSeconds,
  maxOutputRpm: 0.6, maxOutputAccelerationDegS2: 10, motionRampSeconds: 0.15,
  commandLatencyMs: 100, axisStartSkewMs: 100, syncUncertaintyMs: 150,
  maxPeriodVariationPercent: 2, maxSyncAgeSeconds: 45, maxApproximationErrorMm: 2, maxPredictionErrorMm: 5,
  frontFacingConfirmed: false, motionTimingConfirmed: false,
};
const stateLabels: Record<FieldSinglePointState, string> = {
  preparing: "读取参考位并启动记录", awaiting_sync: "等待人工同步", ready: "同步估计已就绪",
  arming: "检查运动条件", scheduled: "等待预约时刻", following: "短弧运动中",
  complete: "本次已结束", cancelled: "已停止", error: "本次异常",
};
const terminal = new Set<FieldSinglePointState>(["complete", "cancelled", "error"]);
export const singlePointIsRunning = (state?: FieldSinglePointStatus | null) => Boolean(state && !terminal.has(state.state));
export function singlePointStateLabel(state?: FieldSinglePointStatus | null) {
  if (!state) return "尚未准备";
  if (state.stopConfirmed === false) return "停止未确认";
  if (state.state === "cancelled") return state.stopConfirmed === true ? "转盘已停止" : state.stopConfirmed === null ? "准备已取消（未启动跟随）" : "停止状态待核对";
  return stateLabels[state.state];
}
const numericKeys = Object.keys(singlePointDefaults).filter(key => typeof singlePointDefaults[key as keyof FieldSinglePointConfig] === "number") as (keyof FieldSinglePointConfig)[];
const confirmationKeys = ["frontFacingConfirmed", "motionTimingConfirmed"] as const;

/** Persist only editable inputs, never anchor feedback, synchronization, session or consent. */
export function singlePointDraftForStorage(config: FieldSinglePointConfig, port: string) {
  const safe = Object.fromEntries(Object.keys(singlePointDefaults).filter(key => !confirmationKeys.includes(key as typeof confirmationKeys[number])).map(key => [key, config[key as keyof FieldSinglePointConfig]]));
  return { config: safe, port };
}
export function readSinglePointDraft(raw: string | null): { config: FieldSinglePointConfig; port: string } {
  const config = { ...singlePointDefaults };
  try {
    const saved = JSON.parse(raw || "null");
    if (!saved || typeof saved !== "object" || !saved.config || typeof saved.config !== "object") return { config, port: "" };
    for (const key of Object.keys(config) as (keyof FieldSinglePointConfig)[]) {
      if (confirmationKeys.includes(key as typeof confirmationKeys[number])) continue;
      const value = saved.config[key];
      if (numericKeys.includes(key) && typeof value === "number" && Number.isFinite(value)) (config as any)[key] = value;
      else if (numericKeys.includes(key) && value === null) (config as any)[key] = NaN;
      else if (typeof config[key] === "string" && typeof value === "string" && value.length <= 120) (config as any)[key] = value;
    }
    if (![1, -1].includes(config.axis1Sign)) config.axis1Sign = 1;
    if (![1, -1].includes(config.axis2Sign)) config.axis2Sign = 1;
    if (!["clockwise", "counterclockwise"].includes(config.rotationDirection)) config.rotationDirection = "clockwise";
    return { config, port: typeof saved.port === "string" && isTurntablePort(saved.port) ? saved.port : "" };
  } catch { return { config, port: "" }; }
}
export function singlePointInputError(config: FieldSinglePointConfig): string | null {
  if (![config.bladeId, config.pointId, config.pointName, config.materialMark].every(value => typeof value === "string" && value.trim())) return "请填写目标叶片、测点及可辨认的材料标记。";
  if (numericKeys.some(key => !Number.isFinite(config[key]))) return "请填写完整的实际几何尺寸和时序参数。";
  if (config.distanceM < 0.001 || config.distanceM > 10000 || config.radiusM < 0.001 || config.radiusM > 1000) return "设备距离须在 0.001–10000 m 内，测点半径须在 0.001–1000 m 内。";
  if (config.arcDegrees < 0.1 || config.arcDegrees > 30) return "本次短弧范围须在 0.1–30° 内。";
  if (config.nominalPeriodSeconds < 0.5 || config.nominalPeriodSeconds > 3600) return "估计周期须在 0.5–3600 s 内。";
  if (config.maxOutputRpm < 0.02 || config.maxOutputRpm > 10 || config.maxOutputAccelerationDegS2 <= 0 || config.maxOutputAccelerationDegS2 > 5000 || config.motionRampSeconds < 0.001 || config.motionRampSeconds > 10) return "运动参数超限：输出轴 0.02–10 rpm，加速度大于 0 且不超过 5000 °/s²，加减速时间 0.001–10 s。";
  if ([config.commandLatencyMs, config.axisStartSkewMs, config.syncUncertaintyMs, ].some(value => value < 0 || value > 5000)) return "时序误差须在 0–5000 ms 内。";
  if (Math.abs(config.hubHeightDeltaM) > 10000 || config.maxPeriodVariationPercent <= 0 || config.maxPeriodVariationPercent > 20) return "高度差须在 ±10000 m 内，允许周期波动须大于 0 且不超过 20%。";
  if (config.maxSyncAgeSeconds <= 0 || config.maxSyncAgeSeconds > 300 || config.maxApproximationErrorMm <= 0 || config.maxApproximationErrorMm > 1000 || config.maxPredictionErrorMm <= 0 || config.maxPredictionErrorMm > 1000) return "同步有效期须在 0–300 s 内，允许误差须在 0–1000 mm 内，均不含 0。";
  return null;
}
const num = (value: number | undefined | null, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
const time = (value?: number | null) => typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toLocaleTimeString("zh-CN", { hour12: false, fractionalSecondDigits: 3 }) : "—";
const newCommandId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function RotorSketch({ config }: { config: FieldSinglePointConfig }) {
  const end = Math.PI + config.arcDegrees * Math.PI / 180, s = config.rotationDirection === "clockwise" ? 1 : -1;
  const x = 90 + s * 56 * Math.sin(end), y = 83 - 56 * Math.cos(end);
  return <svg className="single-point-rotor" viewBox="0 0 180 170" role="img" aria-label={`从激光器一侧面向叶轮，六点方向为起点，沿${config.rotationDirection === "clockwise" ? "顺时针" : "逆时针"}方向跟随 ${config.arcDegrees} 度`}>
    <circle cx="90" cy="83" r="56" className="single-point-orbit" /><path d="M90 20V146 M27 83H153" className="single-point-guide" />
    <path d={`M90 139 A56 56 0 0 ${s === 1 ? 1 : 0} ${x} ${y}`} className="single-point-arc" />
    <path d="M90 83V139" className="single-point-radius" /><circle cx="90" cy="83" r="5" className="single-point-hub" /><circle cx="90" cy="139" r="5" className="single-point-spot" />
    <circle cx={x} cy={y} r="3" className="single-point-spot" /><text x="90" y="12" textAnchor="middle">12 点</text><text x="90" y="161" textAnchor="middle">6 点 · 起点</text><text x="103" y="115">{config.pointId || "P1"}</text>
  </svg>;
}

export function FieldSinglePointPreviewCard({ preview }: { preview?: FieldSinglePointPreview | null }) {
  return <div className="single-point-preview">
    <div className="single-point-metrics"><div><span>短弧时长</span><strong>{num(preview?.durationSeconds, 3)}<small>s</small></strong></div><div><span>轨迹近似误差</span><strong>{num(preview?.maxPathErrorMm)}<small>mm</small></strong></div><div><span>预测总误差</span><strong>{num(preview?.predictionErrorMm)}<small>mm</small></strong></div></div>
    {preview ? <><div className="single-point-angle-grid">{([1, 2] as const).map(axis => <div key={axis}><span>轴 {axis}</span><strong>{num(preview.startAngles?.[`axis${axis}AngleDeg`], 3)}° <ArrowRight size={12} /> {num(preview.endAngles?.[`axis${axis}AngleDeg`], 3)}°</strong></div>)}</div>
      {!preview.anchorBound && <p className="field-subtext">尚未绑定真实两轴参考位，当前角度仅供几何检查。</p>}
      {!!preview.blockReasons?.length && <ul className="single-point-reasons" aria-label="暂不可运行的原因">{preview.blockReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      {!!preview.warnings?.length && <details><summary>查看轨迹说明</summary><ul className="single-point-notes">{preview.warnings.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
    </> : <p className="field-subtext">填写实际尺寸后检查轨迹。准备时将读取真实两轴位置，重新核对运动范围。</p>}
  </div>;
}

export function FieldSinglePoint(props: React.ComponentProps<typeof FieldSinglePointCapture>) {
  const [mode, setMode] = useState<"capture" | "trial">("capture"), [trialVisited, setTrialVisited] = useState(false);
  const [capturePending, setCapturePending] = useState(false), [trialPending, setTrialPending] = useState(false);
  const id = useId(), tabs = useRef<Partial<Record<"capture" | "trial", HTMLButtonElement>>>({});
  const locked = Boolean(props.disabled || capturePending || trialPending || fieldIsActive(props.status) || props.status?.deviceBusy || props.status?.turntableBusy || singlePointIsRunning(props.status?.singlePoint));
  function select(next: "capture" | "trial") { if (locked) return; if (next === "trial") setTrialVisited(true); setMode(next); }
  function key(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (locked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? "capture" : event.key === "End" ? "trial" : mode === "capture" ? "trial" : "capture";
    select(next); tabs.current[next]?.focus();
  }
  return <div className="field-servo-ui single-point-modes"><div className="field-view-tabs" role="tablist" aria-label="单点功能模式" data-active={mode === "trial" ? "analysis" : "wave"}>
    {(["capture", "trial"] as const).map(value => <button key={value} type="button" role="tab" id={`${id}-${value}-tab`} ref={node => { if (node) tabs.current[value] = node; }} tabIndex={mode === value ? 0 : -1} aria-selected={mode === value} aria-controls={`${id}-${value}-panel`} disabled={locked && mode !== value} onKeyDown={key} onClick={() => select(value)}>{value === "capture" ? "测点采集" : "转速试运行"}</button>)}
  </div><div role="tabpanel" id={`${id}-capture-panel`} aria-labelledby={`${id}-capture-tab`} hidden={mode !== "capture"}><FieldSinglePointCapture {...props} onBusyChange={setCapturePending} /></div><div role="tabpanel" id={`${id}-trial-panel`} aria-labelledby={`${id}-trial-tab`} hidden={mode !== "trial"}>{trialVisited && <FieldMotionTrial request={props.request} disabled={locked} onTurntable={props.onTurntable} onBusyChange={setTrialPending} />}</div></div>;
}

export function FieldSinglePointCapture({ config, onConfig, status, disabled = false, request, onStatus, onTurntable, onRecords, onBusyChange }: {
  config: FieldConfig; onConfig: React.Dispatch<React.SetStateAction<FieldConfig>>; status: FieldStatus | null; disabled?: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>; onStatus: (status: FieldStatus) => void;
  onTurntable: () => void; onRecords: () => void; onBusyChange?: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState<FieldSinglePointConfig>({ ...singlePointDefaults }), [port, setPort] = useState("");
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(""), [stopping, setStopping] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<FieldSinglePointPreview | null>(null), [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [staticConsent, setStaticConsent] = useState(false), [laserConsent, setLaserConsent] = useState(false), [motionConsent, setMotionConsent] = useState(false);
  const [markIdentity, setMarkIdentity] = useState(false), [now, setNow] = useState(Date.now());
  const mounted = useRef(true), operation = useRef(0), pendingSessionId = useRef<string | null>(null);
  const newestSnapshot = useRef<FieldSinglePointStatus | null>(null);
  const newestEnvelope = useRef<FieldStatus | null>(null), serviceGeneration = useRef<number | null>(null), serviceReset = useRef(0);
  function acceptEnvelope(next?: FieldStatus | null) {
    if (!next) return false;
    const generation = next.service.generation;
    if (typeof generation === "number" && Number.isFinite(generation)) {
      if (serviceGeneration.current !== null && generation < serviceGeneration.current) return false;
      if (serviceGeneration.current !== null && generation > serviceGeneration.current) {
        newestSnapshot.current = null; pendingSessionId.current = null; serviceReset.current += 1;
      }
      serviceGeneration.current = generation;
    }
    const incoming = next.singlePoint, previous = newestSnapshot.current;
    if (incoming) {
      if (previous?.sessionId === incoming.sessionId && (incoming.version ?? 0) < (previous.version ?? 0)) return false;
      if (previous?.sessionId !== incoming.sessionId && (incoming.updatedAt ?? 0) < (previous?.updatedAt ?? 0)) return false;
      newestSnapshot.current = incoming;
    }
    // A null snapshot in the same generation may be an earlier poll arriving
    // after prepare. Only a proven service-generation change clears authority.
    newestEnvelope.current = { ...next, singlePoint: newestSnapshot.current };
    return true;
  }
  acceptEnvelope(status);
  const currentStatus = newestEnvelope.current || status;
  const live = newestSnapshot.current, serviceResetVersion = serviceReset.current;
  const running = singlePointIsRunning(live), effective = running && live?.config ? live.config : draft;
  const captureBusy = fieldIsActive(currentStatus), locked = disabled || Boolean(busy) || stopping || running || captureBusy || Boolean(currentStatus?.turntableBusy || currentStatus?.deviceBusy);
  const activePreview = running ? live?.preview : preview;
  const phase = live?.state;
  const syncAllowed = (phase === "awaiting_sync" || phase === "ready") && !stopping && !busy && !disabled;
  const latestCount = live?.sync?.markCount ?? live?.marks?.length ?? 0;
  const due = live?.scheduledStartAt ?? live?.preview?.scheduledStartAt;
  const countdown = due ? Math.max(0, due - now / 1000) : null;
  const inputError = singlePointInputError(draft);
  useEffect(() => {
    mounted.current = true;
    try { const saved = readSinglePointDraft(localStorage.getItem(draftKey)); setDraft(saved.config); setPort(saved.port || config.turntable?.port || status?.turntable?.port || ""); } catch { /* Optional local draft. */ }
    setLoaded(true);
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(draftKey, JSON.stringify(singlePointDraftForStorage(draft, port))); } catch { /* Optional inputs do not affect raw recording. */ }
  }, [draft, port, loaded]);
  useEffect(() => { if (phase !== "scheduled" && phase !== "following") return; const timer = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer); }, [phase]);
  useEffect(() => { onBusyChange?.(Boolean(busy) || stopping); }, [busy, stopping, onBusyChange]);
  useEffect(() => { setMotionConsent(false); setMarkIdentity(false); }, [live?.sessionId]);
  useEffect(() => {
    if (!serviceResetVersion) return;
    operation.current += 1; setBusy(""); setStopping(false); setPreview(null);
    setStaticConsent(false); setLaserConsent(false); setMotionConsent(false); setMarkIdentity(false);
    setDraft(previous => ({ ...previous, frontFacingConfirmed: false, motionTimingConfirmed: false }));
    setError("采集服务已重启，上次参考位和同步已失效。请核对设备状态后重新准备。");
  }, [serviceResetVersion]);
  useEffect(() => { if (phase && terminal.has(phase)) { setStaticConsent(false); setLaserConsent(false); setMotionConsent(false); setMarkIdentity(false); } }, [phase]);
  function edit<K extends keyof FieldSinglePointConfig>(key: K, value: FieldSinglePointConfig[K]) {
    const geometry = ["distanceM", "hubHeightDeltaM", "radiusM", "axis1Sign", "axis2Sign", "rotationDirection"];
    const timing = ["nominalPeriodSeconds", "maxOutputRpm", "maxOutputAccelerationDegS2", "motionRampSeconds", "commandLatencyMs", "axisStartSkewMs", "syncUncertaintyMs"];
    setDraft(previous => ({ ...previous, [key]: value, ...(geometry.includes(key) ? { frontFacingConfirmed: false } : {}), ...(timing.includes(key) ? { motionTimingConfirmed: false } : {}) }));
    setPreview(null); setStaticConsent(false); setMotionConsent(false); setError("");
  }
  function applyCurrentModel() {
    if (locked) return;
    edit("distanceM", currentRotorModel.distanceM); edit("hubHeightDeltaM", currentRotorModel.hubHeightDeltaM); edit("radiusM", currentRotorModel.radiusM);
    edit("nominalPeriodSeconds", currentRotorModel.periodSeconds); edit("rotationDirection", currentRotorModel.rotationDirection);
    edit("maxSyncAgeSeconds", 45);
    setLaserConsent(false); setMarkIdentity(false);
  }
  async function call(action: string, fn: () => Promise<void>) {
    if (busy || stopping) return;
    const generation = ++operation.current; setBusy(action); setError("");
    try { await fn(); } catch (cause) { if (mounted.current && generation === operation.current) setError(cause instanceof Error ? cause.message : "操作失败，请检查服务状态。"); }
    finally { if (mounted.current && generation === operation.current) setBusy(""); }
  }
  async function send(payload: FieldSinglePointRequest) {
    const result = await request<FieldStatus>({ action: "singlePoint", request: payload });
    if (mounted.current && acceptEnvelope(result)) { onStatus(newestEnvelope.current!); if (result.singlePointPreview) setPreview(result.singlePointPreview); }
    return result;
  }
  async function stop() {
    const sessionId = pendingSessionId.current || live?.sessionId;
    if (stopping || !sessionId) return;
    operation.current += 1; setBusy(""); setStopping(true); setMotionConsent(false); setError("");
    try { await send({ action: "cancel", sessionId, commandId: newCommandId() }); }
    catch (cause) { if (mounted.current) setError(`停止尚未确认：${cause instanceof Error ? cause.message : "请核对设备状态"}`); }
    finally { if (mounted.current) setStopping(false); }
  }
  function numberInput(key: keyof FieldSinglePointConfig, label: string, min?: number, max?: number, step = "any") {
    const value = effective[key] as number;
    return <label key={key}>{label}<input type="number" aria-label={label} value={Number.isFinite(value) ? value : ""} min={min} max={max} step={step} onChange={event => edit(key, event.currentTarget.valueAsNumber)} /></label>;
  }
  return <div className="field-servo-ui single-point-workspace">
    <div className="single-point-overview"><div><span className="single-point-mode">真实设备 · 人工同步</span><p>设定一个材料测点，记录同一叶片过点时刻，预约执行一次短弧。</p></div><span className={`field-badge ${phase === "error" || live?.stopConfirmed === false ? "red" : running ? "amber" : ""}`}>{singlePointStateLabel(live)}</span></div>
    <ol className="single-point-steps" aria-label="单点跟随步骤">{["静止准备", "过点同步", "短弧跟随"].map((label, i) => <li key={label} aria-current={(i === 0 && (!phase || phase === "preparing") || i === 1 && ["awaiting_sync", "ready"].includes(phase || "") || i === 2 && ["arming", "scheduled", "following", "complete", "cancelled", "error"].includes(phase || "")) ? "step" : undefined}><span>{i + 1}</span>{label}</li>)}</ol>
    {(error || live?.error) && <p className="field-error" role="alert">{error || live?.error}</p>}
    <div className="single-point-layout"><div className="single-point-main">
      <section className="field-card single-point-card"><div className="field-section-heading"><div><h2>1 · 静止准备</h2><p>将目标测点置于6点方向并完成瞄准。准备会开启激光与原始记录，转盘保持静止。</p></div><Button variant="ghost" disabled={running || Boolean(busy)} onClick={onTurntable}><Crosshair size={14} />手动瞄准</Button></div>
        <div className="single-point-model-preset"><div><p>本次模型：距离 2.86 m · 高度差 1.46 m · 半径 0.31 m · 30 s / 圈 · 顺时针</p><p>仅更新几何、周期、旋向及同步有效期（45 s）；保留设备、轴向映射与其它保护参数。</p></div><Button disabled={locked} onClick={applyCurrentModel}>应用30秒模型</Button></div>
        <details className="single-point-inputs" open={!running}><summary>{running ? "查看本次准备参数" : "任务与测点设置"}</summary><fieldset disabled={locked} className="single-point-fields"><label className="single-point-span">任务名称<input aria-label="单点任务名称" value={config.name} onChange={e => onConfig(previous => ({ ...previous, name: e.target.value }))} maxLength={120} /></label><label>目标叶片<input aria-label="目标叶片" value={effective.bladeId} onChange={e => edit("bladeId", e.target.value)} maxLength={40} /></label><label>测点编号<input aria-label="测点编号" value={effective.pointId} onChange={e => edit("pointId", e.target.value)} maxLength={40} /></label><label>测点名称<input aria-label="测点名称" value={effective.pointName} onChange={e => edit("pointName", e.target.value)} maxLength={120} /></label><label className="single-point-span">材料标记<input aria-label="材料标记" value={effective.materialMark} onChange={e => edit("materialMark", e.target.value)} placeholder="可在叶片上辨认的标记或区域" maxLength={120} /></label>
          {numberInput("distanceM", "设备至叶轮平面距离 · m", 0.001, 10000)}{numberInput("hubHeightDeltaM", "轮毂高于激光出射点 · m", -10000, 10000)}{numberInput("radiusM", "轮毂中心至测点半径 · m", 0.001, 1000)}
          {numberInput("nominalPeriodSeconds", "估计每圈时间 · s", 0.5, 3600)}<label>从激光器一侧看的旋转方向<CustomSelect aria-label="从激光器一侧看的旋转方向" value={effective.rotationDirection} onChange={e => edit("rotationDirection", e.target.value as FieldSinglePointConfig["rotationDirection"])}><option value="clockwise">顺时针</option><option value="counterclockwise">逆时针</option></CustomSelect></label>{numberInput("arcDegrees", "从6点开始的短弧 · °", 0.1, 30)}
          <p className="single-point-note single-point-span">从激光器一侧面向叶轮观察；顺时针依次为6点→9点→12点→3点→6点。</p>
        </fieldset>
        <details className="single-point-advanced"><summary>设备连接与运动、误差参数</summary><fieldset disabled={locked} className="single-point-fields">
          <label>采集设备 IP<input aria-label="单点采集设备 IP" value={config.deviceIp} onChange={e => onConfig(previous => ({ ...previous, deviceIp: e.target.value }))} /></label><label>本机设备网卡 IP<input aria-label="单点本机网卡 IP" value={config.hostIp} onChange={e => onConfig(previous => ({ ...previous, hostIp: e.target.value }))} /></label><label>转盘串口<input aria-label="单点转盘串口" value={port} onChange={e => { setPort(e.target.value); setPreview(null); }} placeholder="COM3 或 /dev/cu.…" /></label>
          <div className="single-point-span"><Button disabled={locked} onClick={() => void call("ports", async () => { const result = await request<{ ports: { port: string; description: string }[] }>({ action: "turntablePorts" }); if (mounted.current) setPorts(result.ports || []); })}>刷新串口</Button>{ports.map(item => <Button key={item.port} disabled={locked} variant="ghost" onClick={() => setPort(item.port)} title={item.description}>{item.port}</Button>)}</div>
          {([1, 2] as const).map(axis => <label key={axis}>轴 {axis} 几何方向映射<CustomSelect aria-label={`轴 ${axis} 几何方向映射`} value={effective[`axis${axis}Sign`]} onChange={e => edit(`axis${axis}Sign`, Number(e.target.value) as 1 | -1)}><option value="1">正向 · +1</option><option value="-1">反向 · −1</option></CustomSelect></label>)}
          {numberInput("maxOutputRpm", "允许输出轴最高转速 · rpm", 0.02, 10)}{numberInput("maxOutputAccelerationDegS2", "允许输出轴最高加速度 · °/s²", 0.001, 5000)}{numberInput("motionRampSeconds", "已核对的加减速时间 · s", 0.001, 10)}{numberInput("commandLatencyMs", "指令延迟上界 · ms", 0, 5000)}{numberInput("axisStartSkewMs", "双轴启动时间差上界 · ms", 0, 5000)}{numberInput("syncUncertaintyMs", "人工同步误差上界 · ms", 0, 5000)}{numberInput("maxPeriodVariationPercent", "允许周期波动 · %", 0.001, 20)}{numberInput("maxSyncAgeSeconds", "同步有效期 · s", 0.001, 300)}{numberInput("maxApproximationErrorMm", "允许轨迹近似误差 · mm", 0.001, 1000)}{numberInput("maxPredictionErrorMm", "允许预测总误差 · mm", 0.001, 1000)}
          <label className="single-point-check single-point-span"><input type="checkbox" checked={effective.frontFacingConfirmed} onChange={e => edit("frontFacingConfirmed", e.target.checked)} /><span>已核对设备正对叶轮、几何尺寸、两轴方向与6点起始位置。</span></label><label className="single-point-check single-point-span"><input type="checkbox" checked={effective.motionTimingConfirmed} onChange={e => edit("motionTimingConfirmed", e.target.checked)} /><span>已实测或核对上述运动与通信时序，误差上界覆盖现场情况。</span></label>
        </fieldset></details></details>
        {running && <p className="single-point-target"><strong>{effective.bladeId} / {effective.pointName}</strong><span>{effective.materialMark}</span><span>半径 {num(effective.radiusM, 3)} m · 从6点跟随 {num(effective.arcDegrees)}°</span></p>}
        <div className="single-point-anchor" aria-label="真实参考位"><div><span>轴1 · 6点参考</span><strong>{num(live?.anchor?.axis1AngleDeg, 3)}°</strong></div><div><span>轴2 · 6点参考</span><strong>{num(live?.anchor?.axis2AngleDeg, 3)}°</strong></div><p>{live?.anchor ? "本次准备从设备读取；结束后须重新准备。" : "准备时读取真实反馈，不使用手填角度。"}</p></div>
        {!running && <><div className="single-point-consents"><label className="single-point-check"><input type="checkbox" disabled={locked} checked={staticConsent} onChange={e => setStaticConsent(e.target.checked)} /><span>叶轮已停止，选定叶片和材料点位于6点方向，光斑已对准。</span></label><label className="single-point-check"><input type="checkbox" disabled={locked} checked={laserConsent} onChange={e => setLaserConsent(e.target.checked)} /><span>光路及人员安全已确认，允许开启激光并将真实数据记录到本机。</span></label></div><div className="single-point-actions"><Button disabled={locked || Boolean(inputError)} onClick={() => void call("preview", () => send({ action: "preview", config: draft }).then(() => {}))}>检查轨迹与时间预算</Button><Button variant="primary" disabled={locked || Boolean(inputError) || !staticConsent || !laserConsent || !draft.frontFacingConfirmed || !draft.motionTimingConfirmed || currentStatus?.service.state !== "ready" || !isTurntablePort(port)} onClick={() => void call("prepare", async () => {
          const invalid = validateFieldConfig({ ...config, turntable: undefined }) || singlePointInputError(draft); if (invalid) throw new Error(invalid);
          const sessionId = newCommandId(); pendingSessionId.current = sessionId;
          try { await send({ action: "prepare", sessionId, commandId: newCommandId(), config: { ...draft }, capture: { name: config.name.trim(), deviceIp: config.deviceIp.trim(), hostIp: config.hostIp.trim(), port: port.trim(), object: config.object, turbine: config.turbine, point: draft.pointName }, confirmStaticPoint: true, confirmGeometry: true, confirmLaser: true }); }
          finally { if (pendingSessionId.current === sessionId) pendingSessionId.current = null; }
        })}>{busy === "prepare" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}准备并开始记录</Button></div></>}
      </section>
      <section className="field-card single-point-card"><div className="field-section-heading"><div><h2>2 · 目标叶片过点同步</h2><p>叶轮稳定后，每当同一目标叶片的测点经过6点方向，记录一次。连续记录至少5次。</p></div><span className="field-badge">{latestCount} / 5 次</span></div>
        <div className="single-point-metrics"><div><span>人工记录估计周期</span><strong>{num(live?.sync?.periodSeconds, 3)}<small>s</small></strong></div><div><span>估计转速</span><strong>{num(live?.sync?.rpm)}<small>rpm</small></strong></div><div><span>周期波动</span><strong>{num(live?.sync?.periodVariationPercent)}<small>%</small></strong></div></div>
        <label className="single-point-check single-point-mark-confirm"><input type="checkbox" disabled={!syncAllowed} checked={markIdentity} onChange={e => setMarkIdentity(e.target.checked)} /><span>我能根据材料标记辨认目标叶片，仅记录 {effective.bladeId || "目标叶片"} 的完整周期间隔。</span></label>
        <div className="single-point-actions"><Button className="single-point-mark" variant="primary" onKeyDown={event => { if (event.repeat) event.preventDefault(); }} disabled={!syncAllowed || !markIdentity} onClick={() => live && void call("mark", () => send({ action: "mark", sessionId: live.sessionId, commandId: newCommandId() }).then(() => {}))}><Timer size={16} />{effective.bladeId || "目标叶片"} 经过6点 · 记录一次</Button><Button variant="ghost" disabled={!syncAllowed || latestCount === 0} onClick={() => live && void call("reset", () => send({ action: "reset_sync", sessionId: live.sessionId, commandId: newCommandId() }).then(() => {}))}><RotateCcw size={14} />清除本组同步</Button></div>
        <p className="single-point-note">人工过点记录用于短时预测，不代表相位锁定或自动识别叶片。漏记、错记或转速变化后，应重新记录。</p>
        {!!live?.sync?.blockReasons?.length && <ul className="single-point-reasons">{live.sync.blockReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        {!!live?.marks?.length && <div className="single-point-marks" aria-label="本组过点记录">{live.marks.slice(-8).map(mark => <span key={mark.sequence}><b>#{mark.sequence}</b><time>{time(mark.hostTime)}</time></span>)}</div>}
      </section>
    </div><aside className="single-point-side">
      <section className="field-card single-point-card"><div className="field-section-heading"><div><h2>3 · 一次短弧</h2><p>{effective.bladeId} / {effective.pointName} · {num(effective.arcDegrees)}°</p></div><span className="field-badge amber">预测跟随</span></div><RotorSketch config={effective} /><FieldSinglePointPreviewCard preview={activePreview} />
        {running && <><label className="single-point-check single-point-motion"><input type="checkbox" aria-label="确认单次短弧运动" checked={motionConsent} disabled={!syncAllowed} onChange={e => setMotionConsent(e.target.checked)} /><span>运动空间已清空，允许两轴按已检查轨迹执行一次短弧；结束后保持停止。</span></label><Button className="single-point-arm" variant="primary" disabled={!syncAllowed || !live?.sync?.ready || !live?.preview?.ready || !motionConsent} onClick={() => live && void call("arm", () => send({ action: "arm", sessionId: live.sessionId, commandId: newCommandId(), confirmMotion: true }).then(() => {}))}><Play size={15} />预约下一次经过并跟随</Button></>}
        {due && <div className="single-point-schedule" role="status"><span>预约开始 {time(due)}</span><strong>{phase === "scheduled" ? `约 ${num(countdown, 1)} 秒后开始` : stateLabels[phase || "complete"]}</strong><small>计划跳过 {live?.skippedRevolutions ?? live?.preview?.skippedRevolutions ?? 0} 圈</small></div>}
        <p className="single-point-note">是否命中同一材料点，须结合现场光斑观察确认。波形有效不等于跟随成功。</p>
      </section>
      {live && terminal.has(live.state) && <section className="field-card single-point-card"><h2>本次记录</h2><p className="field-subtext">{live.state === "complete" ? "短弧执行已结束，命中与振幅仍待核验。" : live.state === "cancelled" ? "本次准备或运动已取消，核对激光与原始记录状态。" : "本次存在异常，请核对设备与记录。"}</p>
        <dl className="single-point-result"><div><dt>转盘停止</dt><dd>{live.stopConfirmed === true ? "已确认停稳" : live.stopConfirmed === false ? "尚未确认" : live.stopConfirmed === null ? "未启动跟随运动" : "未读取"}</dd></div><div><dt>目标端点</dt><dd>{live.endpointReached === true ? "反馈已到达" : live.endpointReached === false ? "未确认到达" : "未验证"}</dd></div><div><dt>原始样本覆盖</dt><dd>{live.captureWindow?.covered === true ? "覆盖预约时间窗" : live.captureWindow?.covered === false ? "时间窗覆盖不足" : "未验证"}</dd></div><div><dt>材料点命中 / 振幅</dt><dd>未验证</dd></div></dl>
        <p className="single-point-note">端点反馈和样本覆盖不代表材料点命中，也不代表硬件相位同步。</p>
        {live.stopConfirmed === false && <p className="field-error" role="alert">{live.pendingStopAxes?.length ? `轴 ${live.pendingStopAxes.join("、")} ` : "转盘"}停止尚未确认，请在现场核对并到转盘点位页处理。</p>}
        <div className="single-point-actions"><Button onClick={onRecords}>查看本机记录</Button>{live.stopConfirmed === false && <Button variant="danger" onClick={onTurntable}>核对转盘状态</Button>}<Button variant="ghost" disabled={Boolean(busy) || captureBusy} onClick={() => { setPreview(null); setStaticConsent(false); setLaserConsent(false); setMotionConsent(false); setMarkIdentity(false); }}>重新核对准备条件</Button></div></section>}
    </aside></div>
    {(running || busy === "prepare" || stopping) && <div className="single-point-stopbar"><div><strong>{live ? singlePointStateLabel(live) : "正在准备"}</strong><span>原始记录持续保存 · 不会自动循环</span></div><Button type="button" variant="danger" disabled={stopping} onClick={() => void stop()}>{stopping ? <LoaderCircle className="spin" size={15} /> : <Square size={14} />}停止转盘并结束记录</Button></div>}
  </div>;
}
