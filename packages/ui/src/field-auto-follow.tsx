"use client";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Crosshair, Hand, Plus, RefreshCw, Route, Square, Trash2 } from "lucide-react";
import { Button, CustomSelect } from "./common";
import { FieldLaserControl } from "./field-device";
import { FieldTurntableManual } from "./field-turntable";
import { FieldCycleProgress } from "./field-cycle-progress";
import { autoFollowDefaults, planAutoFollow, type AutoFollowAnchor, type AutoFollowDraft, type AutoFollowPlan } from "./field-auto-follow-plan";
import { turntablePointMotionError, turntableReferenceSignature } from "./field-turntable-points";
import { isTurntablePort, normalizeTurntablePort } from "./field-turntable-port";
import { fieldIsActive, fieldTurntableMotionMode, validateFieldConfig, type FieldAxisFeedback, type FieldConfig, type FieldRequestOptions, type FieldStatus } from "./field-types";

const storageKey = "blade-auto-follow-draft-v1";
const numberText = (value: number | undefined | null, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作失败，请检查设备状态";
type Props = {
  config: FieldConfig; onConfig: React.Dispatch<React.SetStateAction<FieldConfig>>;
  status: FieldStatus | null; disabled: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>;
  onStatus: (status: FieldStatus) => void; onRecords: () => void; onService: () => void;
  onOperationBusy?: (busy: boolean) => void;
  onJointStart?: (config: FieldConfig) => void; onAcquisition?: () => void; onStop?: () => void;
};

type AutoFollowCollection = { collectionId: string; collectionContext: string };
const emptyCollection = (): AutoFollowCollection => ({ collectionId: "", collectionContext: "" });
export function autoFollowCollectionContext(config: FieldConfig, bladeId: string): string {
  return JSON.stringify([config.name, config.object, config.turbine, bladeId].map(value => value.trim().normalize("NFC")));
}
export function autoFollowCollection(previous: AutoFollowCollection, context: string,
  makeId = () => globalThis.crypto.randomUUID().replaceAll("-", "")): AutoFollowCollection {
  return previous.collectionContext === context && previous.collectionId.length === 32 && /^[a-f0-9]{32}$/.test(previous.collectionId)
    ? previous : { collectionId: makeId(), collectionContext: context };
}
/** Persist editable values and collection identity; never persist a device anchor. */
export function readAutoFollowDraft(raw: string | null): { draft: AutoFollowDraft; port: string } & AutoFollowCollection {
  const draft: AutoFollowDraft = { ...autoFollowDefaults, points: autoFollowDefaults.points.map(point => ({ ...point })) };
  try {
    const parsed = JSON.parse(raw || "null");
    if (!parsed || typeof parsed !== "object" || !parsed.draft || typeof parsed.draft !== "object") return { draft, port: "", ...emptyCollection() };
    for (const key of Object.keys(draft) as (keyof AutoFollowDraft)[]) {
      if (key === "points") continue;
      const value = parsed.draft[key];
      if (typeof value === typeof draft[key]) Object.assign(draft, { [key]: value });
    }
    if (Array.isArray(parsed.draft.points)) draft.points = parsed.draft.points.slice(0, 200).map((point: Record<string, unknown>) => ({
      id: typeof point?.id === "string" ? point.id : "", name: typeof point?.name === "string" ? point.name : "", radiusM: typeof point?.radiusM === "number" ? point.radiusM : NaN,
    }));
    if (typeof parsed.draft.activePointId !== "string" || !draft.points.some(point => point.id === draft.activePointId)) draft.activePointId = draft.points[0]?.id || "";
    const collection = typeof parsed.collectionId === "string" && parsed.collectionId.length === 32 && /^[a-f0-9]{32}$/.test(parsed.collectionId) && typeof parsed.collectionContext === "string"
      ? { collectionId: parsed.collectionId, collectionContext: parsed.collectionContext } : emptyCollection();
    return { draft, port: typeof parsed.port === "string" ? normalizeTurntablePort(parsed.port) : "", ...collection };
  } catch { return { draft, port: "", ...emptyCollection() }; }
}

export function autoFollowAnchorKey(draft: AutoFollowDraft, port: string): string {
  const selected = draft.points.find(point => point.id === draft.activePointId);
  return JSON.stringify([port, draft.distanceM, draft.hubHeightDeltaM, draft.direction, draft.axis1Sign, draft.axis2Sign, draft.activePointId, selected?.radiusM]);
}

function axisReadiness(value: FieldAxisFeedback | undefined, axis: number): string {
  if (!value || value.fault !== 0 || value.motor_rpm !== 0 || !Number.isInteger(value.flags) || (value.flags & 16) !== 0) return `轴${axis}未确认静止且无故障`;
  const limit = axis === 1 ? 35 : 180, guard = value.guard;
  if (!guard?.soft_enabled || !Number.isFinite(guard.minimum_deg) || !Number.isFinite(guard.maximum_deg) || guard.minimum_deg < -limit || guard.maximum_deg > limit || guard.minimum_deg >= guard.maximum_deg) return `请先在手动控制中应用轴${axis}有效软限位`;
  const angle = value.output_angle_deg;
  if (angle == null || !Number.isFinite(angle) || angle < guard.minimum_deg || angle > guard.maximum_deg) return `轴${axis}当前角度无效或超出软限位`;
  return "";
}

export function autoFollowAnchorFromStatus(status: FieldStatus, port: string, radiusM: number, pointId: string): AutoFollowAnchor {
  if (status.turntable?.port !== port) throw new Error("读取结果的串口与当前设置不一致，请重新读取");
  if (status.turntableWarning) throw new Error(status.turntableWarning);
  const axes = status.turntable.feedback?.axes;
  const signature = turntableReferenceSignature(axes);
  if (!signature) throw new Error("两轴参考位无效，请先在手动控制中建立参考位");
  for (const axis of [1, 2]) {
    const invalid = axisReadiness(axes?.[String(axis)], axis);
    if (invalid) throw new Error(invalid);
  }
  return { port, referenceSignature: signature, radiusM, pointId, axis1AngleDeg: axes!["1"].output_angle_deg!, axis2AngleDeg: axes!["2"].output_angle_deg! };
}

export function autoFollowBlockers(config: FieldConfig, status: FieldStatus | null, plan: AutoFollowPlan, anchor: AutoFollowAnchor | null, port: string): string[] {
  const errors = [...plan.errors];
  const invalid = validateFieldConfig({ ...config, turntable: undefined });
  if (invalid) errors.push(invalid);
  if (!status || status.service.state !== "ready") errors.push("采集服务尚未就绪");
  else if (!status.service.dllConfigured) errors.push("请在设备与服务中配置采集驱动");
  if (status?.deviceWarning) errors.push(status.deviceWarning);
  if (status?.turntableWarning) errors.push(status.turntableWarning);
  if (!isTurntablePort(port)) errors.push("请在安装与连接中选择转盘串口");
  if (anchor) {
    const axes = status?.turntable?.port === port ? status.turntable.feedback?.axes : undefined;
    for (const axis of [1, 2]) {
      const invalidAxis = axisReadiness(axes?.[String(axis)], axis);
      if (invalidAxis) errors.push(invalidAxis);
    }
    const invalidPoint = plan.points.map(point => turntablePointMotionError(point, axes, port)).find(Boolean);
    if (invalidPoint) errors.push(invalidPoint);
  }
  return [...new Set(errors)];
}

export function FieldTurntableWorkspace(props: Props) {
  const [mode, setMode] = useState<"manual" | "auto">("manual");
  const [autoBusy, setAutoBusy] = useState(false);
  const busyChanged = useCallback((value: boolean) => { setAutoBusy(value); props.onOperationBusy?.(value); }, [props.onOperationBusy]);
  const id = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const locked = props.disabled || autoBusy || fieldIsActive(props.status) || !!props.status?.deviceBusy || !!props.status?.turntableBusy;
  const selectMode = (next: "manual" | "auto") => { if (!locked) setMode(next); };
  return <div className="field-turntable-workspace field-servo-ui">
    <div className="field-view-tabs" data-active={mode === "manual" ? "wave" : "analysis"} role="tablist" aria-label="转盘作业方式">
      {(["manual", "auto"] as const).map((value, index) => <button key={value} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={mode === value} tabIndex={mode === value ? 0 : -1} disabled={locked} onClick={() => selectMode(value)} onKeyDown={event => {
        if (locked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
        selectMode(next ? "auto" : "manual"); tabs.current[next]?.focus();
      }}>{value === "manual" ? <Hand size={16} /> : <Route size={16} />}{value === "manual" ? "手动控制" : "自动跟随"}</button>)}
    </div>
    <div hidden={mode !== "manual"} role="tabpanel" id={`${id}-manual-panel`} aria-labelledby={`${id}-manual-tab`}><FieldLaserControl deviceIp={props.config.deviceIp} status={props.status} disabled={props.disabled || autoBusy} request={props.request} /><FieldTurntableManual status={props.status} disabled={props.disabled || autoBusy} request={props.request} onBusy={busyChanged} onStatus={props.onStatus}
      capture={props.onJointStart && props.onAcquisition && props.onStop ? { config: props.config, onConfig: props.onConfig, onStart: props.onJointStart, onWaveform: props.onAcquisition, onStop: props.onStop } : undefined} /></div>
    <div hidden={mode !== "auto"} role="tabpanel" id={`${id}-auto-panel`} aria-labelledby={`${id}-auto-tab`}><FieldAutoFollow {...props} onBusy={busyChanged} onManual={() => selectMode("manual")} /></div>
  </div>;
}

export function FieldAutoFollow({ config, onConfig, status, disabled, request, onStatus, onRecords, onService, onManual, onBusy }: Props & { onManual: () => void; onBusy?: (busy: boolean) => void }) {
  const [draft, setDraft] = useState<AutoFollowDraft>(() => readAutoFollowDraft(null).draft);
  const [port, setPort] = useState("");
  const [loaded, setLoaded] = useState(false), [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [anchor, setAnchor] = useState<AutoFollowAnchor | null>(null);
  const [pending, setPending] = useState(""), [stopping, setStopping] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const operation = useRef(0), startPending = useRef(false), collection = useRef<AutoFollowCollection>(emptyCollection());
  const generation = useRef<number | undefined>(status?.service.generation);
  const fingerprint = JSON.stringify([autoFollowAnchorKey(draft, port), config.deviceIp.trim()]);
  const lastFingerprint = useRef(fingerprint);
  const active = fieldIsActive(status), cycleRunning = !!status?.pointCycle && !["complete", "cancelled", "error"].includes(status.pointCycle.state);
  const locked = disabled || !!pending || stopping || active || cycleRunning || !!status?.deviceBusy || !!status?.turntableBusy;
  const currentPoint = draft.points.find(point => point.id === draft.activePointId);
  const motionMode = fieldTurntableMotionMode(status?.turntable, port);
  const plan = useMemo(() => planAutoFollow(draft, anchor, motionMode), [draft, anchor, motionMode]);
  const blockers = autoFollowBlockers(config, status, plan, anchor, port);
  useEffect(() => { const saved = readAutoFollowDraft(localStorage.getItem(storageKey)); setDraft(saved.draft); setPort(saved.port); collection.current = { collectionId: saved.collectionId, collectionContext: saved.collectionContext }; setLoaded(true); }, []);
  useEffect(() => { if (loaded) try { localStorage.setItem(storageKey, JSON.stringify({ draft, port, ...collection.current })); } catch { /* Optional form draft only. */ } }, [loaded, draft, port]);
  useEffect(() => { onBusy?.(!!pending || stopping); return () => onBusy?.(false); }, [pending, stopping, onBusy]);
  useEffect(() => {
    if (fingerprint !== lastFingerprint.current) { lastFingerprint.current = fingerprint; setAnchor(null); }
  }, [fingerprint]);
  useEffect(() => {
    const next = status?.service.generation;
    if (next !== undefined && generation.current !== undefined && next !== generation.current) { setAnchor(null); }
    if (next !== undefined) generation.current = next;
    if (anchor && status?.turntable?.port === port && status.turntable.feedback?.axes && turntableReferenceSignature(status.turntable.feedback.axes) !== anchor.referenceSignature) { setAnchor(null); }
  }, [status, anchor, port]);
  function edit(patch: Partial<AutoFollowDraft>) { if (locked) return; setDraft(previous => ({ ...previous, ...patch })); setError(""); setNotice(""); }
  function editConfig(key: keyof FieldConfig, value: string) { if (!locked) onConfig(previous => ({ ...previous, [key]: value })); }
  async function readAnchor() {
    if (locked || !isTurntablePort(port) || !currentPoint || !Number.isFinite(currentPoint.radiusM) || currentPoint.radiusM <= 0) return;
    const epoch = ++operation.current; setPending("probe"); setError(""); setAnchor(null);
    try { const next = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port, axis: 1 } }); if (epoch !== operation.current) return; onStatus(next); setAnchor(autoFollowAnchorFromStatus(next, port, currentPoint.radiusM, currentPoint.id)); setNotice("已记录当前位置为采集起点。"); }
    catch (cause) { if (epoch === operation.current) setError(messageOf(cause)); }
    finally { if (epoch === operation.current) setPending(""); }
  }
  async function stop() {
    if (stopping || !(startPending.current || cycleRunning || active && status?.pointCycle)) return;
    ++operation.current; setStopping(true); setError("");
    try { await request<FieldStatus>({ action: "stop" }); const next = await request<FieldStatus>({ action: "status" }); onStatus(next); setNotice("已请求停止并保存，请核对转盘和激光的返回状态。"); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setStopping(false); if (!startPending.current) setPending(""); }
  }
  async function start() {
    if (locked || blockers.length || !plan.pointCycle) return;
    const epoch = ++operation.current; startPending.current = true; setPending("start"); setError(""); setNotice("");
    try {
      const capture = { ...config, deviceIp: config.deviceIp.trim(), hostIp: config.hostIp.trim(), name: config.name.trim(), turntable: undefined };
      try { localStorage.setItem("blade-field-config-v1", JSON.stringify(capture)); } catch { /* Device addresses and task labels only. */ }
      collection.current = autoFollowCollection(collection.current, autoFollowCollectionContext(capture, draft.bladeId));
      try { localStorage.setItem(storageKey, JSON.stringify({ draft, port, ...collection.current })); } catch { /* Collection remains available for this session. */ }
      const next = await request<FieldStatus>({ action: "start", config: { ...capture, source: "device", confirmLaser: true, confirmMotion: true, pointCycle: { ...plan.pointCycle, collectionId: collection.current.collectionId } } });
      if (epoch === operation.current) onStatus(next);
    } catch (cause) { if (epoch === operation.current) setError(messageOf(cause)); }
    finally {
      startPending.current = false;
      setPending("");
    }
  }
  const numeric = (label: string, key: keyof AutoFollowDraft, min: number, max: number, step: number) => <label>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={Number.isFinite(draft[key]) ? String(draft[key]) : ""} disabled={locked} onChange={event => edit({ [key]: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>;
  return <div className="field-auto-follow field-servo-ui">
    <section className="field-card"><div className="field-section-heading"><div><h2>叶片逐点采集</h2><p>采集当前测点的圆周站位，确认叶片进入并离开后再转到下一站。</p></div><span className="field-badge">真实设备</span></div>
      <div className="field-auto-core"><label>任务名称<input aria-label="自动跟随任务名称" maxLength={120} value={config.name} disabled={locked} onChange={event => editConfig("name", event.target.value)} placeholder="本次叶片采集任务" /></label><label>目标叶片编号<input aria-label="目标叶片编号" maxLength={80} value={draft.bladeId} disabled={locked} onChange={event => edit({ bladeId: event.target.value })} /></label>{numeric("叶轮每圈时间 · s", "periodSeconds", .5, 3600, .5)}<label>圆周站位间隔<CustomSelect aria-label="圆周站位间隔" value={draft.stepDeg} disabled={locked} onChange={event => edit({ stepDeg: Number(event.target.value) })}>{[180, 120, 90, 60, 45, 30, 20, 15, 10, 5].map(value => <option key={value} value={value}>{value}° · {360 / value} 个站位</option>)}</CustomSelect></label></div>
      <div className="field-auto-points-heading"><h3>本次采集测点</h3><Button type="button" disabled={locked || draft.points.length >= 40} onClick={() => {
        const id = globalThis.crypto.randomUUID(), used = new Set(draft.points.map(point => point.name));
        let index = 1; while (used.has(`P${index}`)) index++;
        edit({ points: [...draft.points, { id, name: `P${index}`, radiusM: NaN }], activePointId: id });
      }}><Plus size={14} />添加下一测点</Button></div>
      <div className="field-auto-points" role="radiogroup" aria-label="本次采集测点">{draft.points.map((point, index) => <div className="field-auto-point" data-selected={point.id === draft.activePointId} key={point.id || index}>
        <input className="field-auto-point-choice" type="radio" name="auto-follow-point" aria-label={`选择测点${index + 1}`} checked={point.id === draft.activePointId} disabled={locked} onChange={() => edit({ activePointId: point.id })} />
        <label>测点名称<input aria-label={`测点${index + 1}名称`} value={point.name} maxLength={80} disabled={locked} onChange={event => edit({ points: draft.points.map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} /></label>
        <label>距轮毂中心 · m<input aria-label={`测点${index + 1}半径`} type="number" min={.001} max={1000} step={.01} placeholder="填写实测距离" value={Number.isFinite(point.radiusM) ? point.radiusM : ""} disabled={locked} onChange={event => edit({ points: draft.points.map((item, at) => at === index ? { ...item, radiusM: event.target.value === "" ? NaN : Number(event.target.value) } : item) })} /></label>
        <span className="field-auto-point-stations">{point.id === draft.activePointId ? `本次采集 · ${plan.stationsPerPoint} 站` : "未选中"}</span><Button type="button" variant="ghost" aria-label={`移除测点${index + 1}`} disabled={locked || draft.points.length <= 1} onClick={() => {
          const points = draft.points.filter((_, at) => at !== index);
          edit({ points, activePointId: point.id === draft.activePointId ? points[0].id : draft.activePointId });
        }}><Trash2 size={15} /></Button></div>)}</div>
      <p className="field-subtext">每次只采集选中的测点。完成后停止，再选择下一测点、重新瞄准并开始；同任务测点分别保存，修改任务信息会建立新任务。叶片编号由现场指定，RSSI 不能自动识别叶片。</p>
      <details className="field-auto-setup"><summary>测量与连接设置 <span>{anchor ? "起点已校准" : "首次使用需完成设置"}</span></summary>
        <div className="field-auto-grid">{numeric("设备至叶轮平面 · m", "distanceM", .001, 10000, .01)}{numeric("轮毂高于激光器 · m", "hubHeightDeltaM", -10000, 10000, .01)}<label><span className="field-auto-label-line">叶轮旋向<small>从激光器一侧看叶轮</small></span><CustomSelect aria-label="叶轮旋向" value={draft.direction} disabled={locked} onChange={event => edit({ direction: event.target.value as AutoFollowDraft["direction"] })}><option value="clockwise">顺时针</option><option value="counterclockwise">逆时针</option></CustomSelect></label></div>
        <p className="field-subtext">高度差可为负数。转盘到位并停稳后，等待叶片进入和离开。</p>
        <div className="field-auto-grid"><label>采集设备 IP<input aria-label="自动跟随设备 IP" value={config.deviceIp} disabled={locked} onChange={event => editConfig("deviceIp", event.target.value)} placeholder="设备 IPv4 地址" /></label><label>本机设备网卡 IP<input aria-label="自动跟随本机 IP" value={config.hostIp} disabled={locked} onChange={event => editConfig("hostIp", event.target.value)} placeholder="连接设备的网卡 IPv4 地址" /></label><label>转盘串口<input aria-label="自动跟随转盘串口" list="field-auto-ports" value={port} disabled={locked} placeholder="COM3 或 /dev/cu.…" onChange={event => { setPort(normalizeTurntablePort(event.target.value)); }} /><datalist id="field-auto-ports">{ports.map(item => <option value={item.port} key={item.port}>{item.description}</option>)}</datalist></label></div>
        <div className="field-form-actions"><Button type="button" disabled={locked} onClick={async () => { setPending("ports"); setError(""); try { const result = await request<{ ports: { port: string; description: string }[] }>({ action: "turntablePorts" }); setPorts(result.ports || []); } catch (cause) { setError(messageOf(cause)); } finally { setPending(""); } }}><RefreshCw size={14} />刷新串口</Button><Button type="button" disabled={locked} onClick={onService}>设备与服务设置</Button></div>
        <div className="field-auto-grid">{numeric("每个测点重复轮数", "cycles", 1, 100, 1)}{numeric("单站最多等待 · 圈", "waitRevolutions", 1, 10, 1)}{numeric("进入回波波动阈值 · 百分点", "rssiEnterSpread", .1, 100, .1)}{numeric("离开回波波动阈值 · 百分点", "rssiExitSpread", 0, 99.9, .1)}{numeric("进入确认时间 · ms", "rssiEnterConfirmMs", 10, 1000, 10)}{numeric("离开确认时间 · ms", "rssiConfirmMs", 10, 1000, 10)}</div>
      </details>
      <details className="field-auto-setup field-auto-turntable-setup"><summary>转盘安装设置 <span>安装或接线变化时调整</span></summary><div className="field-auto-grid"><label>俯仰轴方向<CustomSelect aria-label="俯仰轴方向" value={draft.axis1Sign} disabled={locked} onChange={event => edit({ axis1Sign: Number(event.target.value) as 1 | -1 })}><option value={1}>抬高瞄准点时角度增加</option><option value={-1}>抬高瞄准点时角度减小</option></CustomSelect></label><label>水平轴方向<CustomSelect aria-label="水平轴方向" value={draft.axis2Sign} disabled={locked} onChange={event => edit({ axis2Sign: Number(event.target.value) as 1 | -1 })}><option value={1}>向右瞄准时角度增加</option><option value={-1}>向右瞄准时角度减小</option></CustomSelect></label>{numeric("两轴换点转速上限 · rpm", "maxMoveRpm", .02, 10, .02)}</div><p className="field-subtext">轴方向将瞄准方向换算为转盘角度，首次安装核对后保存。换点转速按叶轮周期自动计算，每个轴均不超过此上限；支持双轴联动的控制器会同时定位两轴。</p></details>
    </section>
    <section className="field-card field-auto-anchor"><div className="field-section-heading"><div><h2>校准起点</h2><p>停稳叶轮，将当前测点置于6点方向并手动瞄准。</p></div><Button type="button" disabled={locked} onClick={onManual}>手动瞄准</Button></div><div className="field-auto-anchor-read"><Button type="button" disabled={locked || !isTurntablePort(port) || !currentPoint || !Number.isFinite(currentPoint.radiusM) || currentPoint.radiusM <= 0} onClick={() => void readAnchor()}><Crosshair size={15} />{pending === "probe" ? "正在读取…" : "以当前位置为起点"}</Button><span>俯仰 {numberText(anchor?.axis1AngleDeg, 3)}°</span><span>水平 {numberText(anchor?.axis2AngleDeg, 3)}°</span><span className={`field-badge ${anchor ? "green" : "amber"}`}>{anchor ? "已校准" : "待校准"}</span></div></section>
    <section className="field-card"><div className="field-section-heading"><div><h2>采集路线</h2><p>{motionMode === "dual_axis_timed" ? "已识别双轴联动 · 同时换点，到位后采集" : motionMode === "sequential" ? "已识别单轴定位 · 两轴依次换点" : "运动方式待检测 · 校准起点时自动读取"}</p></div><span className="field-badge">{numberText(plan.nominalRpm)} rpm · {draft.periodSeconds} s / 圈</span></div><div className="field-auto-metrics"><div><span>当前测点 / 圆周站位</span><strong>{currentPoint?.name || "—"} / {plan.stationsPerPoint}</strong></div><div><span>计划记录</span><strong>{Number.isFinite(plan.totalRecords) ? plan.totalRecords : "—"} 条</strong></div><div><span>自动换点速度上限（每轴）</span><strong>{plan.speedRpm && motionMode !== "unknown" ? numberText(plan.speedRpm) : "—"} rpm</strong></div><div><span>{motionMode === "dual_axis_timed" ? "最长站间运动估算" : "最长站间运动下限"}</span><strong>{plan.speedRpm && motionMode !== "unknown" ? numberText(plan.plannedMoveSeconds) : "—"} s</strong></div></div><p className="field-subtext">{motionMode === "dual_axis_timed" ? "估算已计入起停加减速，执行时会校核调整用时；另需通讯和停稳确认。" : motionMode === "sequential" ? "运动下限未计通讯、加减速与停稳确认。" : "读取设备后显示换点速度与用时。"}{plan.mayMissNextPass && motionMode !== "unknown" ? "可能赶不上下一次经过，到位后将继续等待。" : "叶轮周期用于规划速度，实际采集以回波确认进入和离开为准。"}</p>
      {plan.points.length > 0 && <details className="field-auto-route"><summary>查看 {plan.points.length} 个站位的目标角度</summary><div className="field-table-scroll"><table className="field-table"><thead><tr><th>顺序</th><th>测点</th><th>圆周角</th><th>俯仰目标</th><th>水平目标</th></tr></thead><tbody>{plan.points.map((point, index) => <tr key={point.pointId}><td>{index + 1}</td><td>{point.radialPointName}</td><td>{point.azimuthDeg}°</td><td>{numberText(point.axis1AngleDeg, 3)}°</td><td>{numberText(point.axis2AngleDeg, 3)}°</td></tr>)}</tbody></table></div></details>}
      {blockers.length > 0 && !cycleRunning && <div className="field-auto-blockers" role="status"><strong>开始前还需完成</strong><ul>{blockers.map(item => <li key={item}>{item}</li>)}</ul></div>}
      {error && <p className="field-error" role="alert">{error}</p>}{notice && <p className="field-success" role="status">{notice}</p>}
      <div className="field-auto-actions"><p className="field-auto-start-note">开始后将开启激光，并按路线自动换点。</p><Button type="button" variant="primary" disabled={locked || blockers.length > 0} onClick={() => void start()}><Route size={15} />{pending === "start" ? "正在启动…" : "开始自动采集"}</Button><Button type="button" variant="danger" disabled={stopping || !(pending === "start" || cycleRunning || active && status?.pointCycle)} onClick={() => void stop()}><Square size={13} />{stopping ? "正在停止…" : "停止并保存"}</Button><Button type="button" variant="ghost" disabled={!!pending || stopping} onClick={onRecords}>查看本机记录</Button></div>
    </section>
    {status?.pointCycle?.lastMove && <p className="field-subtext" role="status">最近换点：{status.pointCycle.lastMove.mode === "dual_axis_timed" ? "双轴联动" : "两轴依次定位"}{status.pointCycle.lastMove.plannedSeconds != null ? ` · 运动计划 ${numberText(status.pointCycle.lastMove.plannedSeconds)} s` : ""}{status.pointCycle.lastMove.actualSeconds != null ? ` · 实际 ${numberText(status.pointCycle.lastMove.actualSeconds)} s` : ""} · 停稳后采集</p>}
    <FieldCycleProgress status={status} />
  </div>;
}
