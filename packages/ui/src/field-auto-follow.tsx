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
import { fieldIsActive, validateFieldConfig, type FieldAxisFeedback, type FieldConfig, type FieldRequestOptions, type FieldStatus } from "./field-types";

const storageKey = "blade-auto-follow-draft-v1";
const numberText = (value: number | undefined | null, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作失败，请检查设备状态";
type Props = {
  config: FieldConfig; onConfig: React.Dispatch<React.SetStateAction<FieldConfig>>;
  status: FieldStatus | null; disabled: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>;
  onStatus: (status: FieldStatus) => void; onRecords: () => void; onService: () => void;
  onOperationBusy?: (busy: boolean) => void;
};

/** Only editable values survive a restart; no anchor or safety acknowledgement is stored. */
export function readAutoFollowDraft(raw: string | null): { draft: AutoFollowDraft; port: string } {
  const draft: AutoFollowDraft = { ...autoFollowDefaults, points: autoFollowDefaults.points.map(point => ({ ...point })) };
  try {
    const parsed = JSON.parse(raw || "null");
    if (!parsed || typeof parsed !== "object" || !parsed.draft || typeof parsed.draft !== "object") return { draft, port: "" };
    for (const key of Object.keys(draft) as (keyof AutoFollowDraft)[]) {
      if (key === "points") continue;
      const value = parsed.draft[key];
      if (typeof value === typeof draft[key]) Object.assign(draft, { [key]: value });
    }
    if (Array.isArray(parsed.draft.points)) draft.points = parsed.draft.points.slice(0, 200).map((point: Record<string, unknown>) => ({
      id: typeof point?.id === "string" ? point.id : "", name: typeof point?.name === "string" ? point.name : "", radiusM: typeof point?.radiusM === "number" ? point.radiusM : NaN,
    }));
    return { draft, port: typeof parsed.port === "string" ? normalizeTurntablePort(parsed.port) : "" };
  } catch { return { draft, port: "" }; }
}

export function autoFollowAnchorKey(draft: AutoFollowDraft, port: string): string {
  return JSON.stringify([port, draft.distanceM, draft.hubHeightDeltaM, draft.direction, draft.axis1Sign, draft.axis2Sign, draft.points[0]?.id, draft.points[0]?.radiusM]);
}

function axisReadiness(value: FieldAxisFeedback | undefined, axis: number): string {
  if (!value || value.fault !== 0 || value.motor_rpm !== 0 || !Number.isInteger(value.flags) || (value.flags & 16) !== 0) return `轴${axis}未确认静止且无故障`;
  const limit = axis === 1 ? 35 : 180, guard = value.guard;
  if (!guard?.soft_enabled || !Number.isFinite(guard.minimum_deg) || !Number.isFinite(guard.maximum_deg) || guard.minimum_deg < -limit || guard.maximum_deg > limit || guard.minimum_deg >= guard.maximum_deg) return `请先在手动控制中应用轴${axis}有效软限位`;
  const angle = value.output_angle_deg;
  if (angle == null || !Number.isFinite(angle) || angle < guard.minimum_deg || angle > guard.maximum_deg) return `轴${axis}当前角度无效或超出软限位`;
  return "";
}

export function autoFollowAnchorFromStatus(status: FieldStatus, port: string, radiusM: number): AutoFollowAnchor {
  if (status.turntable?.port !== port) throw new Error("读取结果的串口与当前设置不一致，请重新读取");
  if (status.turntableWarning) throw new Error(status.turntableWarning);
  const axes = status.turntable.feedback?.axes;
  const signature = turntableReferenceSignature(axes);
  if (!signature) throw new Error("两轴参考位无效，请先在手动控制中建立参考位");
  for (const axis of [1, 2]) {
    const invalid = axisReadiness(axes?.[String(axis)], axis);
    if (invalid) throw new Error(invalid);
  }
  return { port, referenceSignature: signature, radiusM, axis1AngleDeg: axes!["1"].output_angle_deg!, axis2AngleDeg: axes!["2"].output_angle_deg! };
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
    <div hidden={mode !== "manual"} role="tabpanel" id={`${id}-manual-panel`} aria-labelledby={`${id}-manual-tab`}><FieldLaserControl deviceIp={props.config.deviceIp} status={props.status} disabled={props.disabled || autoBusy} request={props.request} /><FieldTurntableManual status={props.status} disabled={props.disabled || autoBusy} request={props.request} /></div>
    <div hidden={mode !== "auto"} role="tabpanel" id={`${id}-auto-panel`} aria-labelledby={`${id}-auto-tab`}><FieldAutoFollow {...props} onBusy={busyChanged} onManual={() => selectMode("manual")} /></div>
  </div>;
}

export function FieldAutoFollow({ config, onConfig, status, disabled, request, onStatus, onRecords, onService, onManual, onBusy }: Props & { onManual: () => void; onBusy?: (busy: boolean) => void }) {
  const [draft, setDraft] = useState<AutoFollowDraft>(() => readAutoFollowDraft(null).draft);
  const [port, setPort] = useState("");
  const [loaded, setLoaded] = useState(false), [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [anchor, setAnchor] = useState<AutoFollowAnchor | null>(null);
  const [aligned, setAligned] = useState(false), [signsConfirmed, setSignsConfirmed] = useState(false);
  const [laserConsent, setLaserConsent] = useState(false), [motionConsent, setMotionConsent] = useState(false);
  const [pending, setPending] = useState(""), [stopping, setStopping] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const operation = useRef(0), startPending = useRef(false);
  const generation = useRef<number | undefined>(status?.service.generation);
  const fingerprint = autoFollowAnchorKey(draft, port);
  const lastFingerprint = useRef(fingerprint);
  const active = fieldIsActive(status), cycleRunning = !!status?.pointCycle && !["complete", "cancelled", "error"].includes(status.pointCycle.state);
  const locked = disabled || !!pending || stopping || active || cycleRunning || !!status?.deviceBusy || !!status?.turntableBusy;
  const plan = useMemo(() => planAutoFollow(draft, anchor), [draft, anchor]);
  const blockers = autoFollowBlockers(config, status, plan, anchor, port);
  const resetConsent = () => { setLaserConsent(false); setMotionConsent(false); };
  useEffect(() => { const saved = readAutoFollowDraft(localStorage.getItem(storageKey)); setDraft(saved.draft); setPort(saved.port); setLoaded(true); }, []);
  useEffect(() => { if (loaded) try { localStorage.setItem(storageKey, JSON.stringify({ draft, port })); } catch { /* Optional form draft only. */ } }, [loaded, draft, port]);
  useEffect(() => { onBusy?.(!!pending || stopping); return () => onBusy?.(false); }, [pending, stopping, onBusy]);
  useEffect(() => {
    if (fingerprint !== lastFingerprint.current) { lastFingerprint.current = fingerprint; setAnchor(null); setAligned(false); setSignsConfirmed(false); resetConsent(); }
  }, [fingerprint]);
  useEffect(() => { resetConsent(); }, [config.deviceIp, config.hostIp, config.name]);
  useEffect(() => {
    const next = status?.service.generation;
    if (next !== undefined && generation.current !== undefined && next !== generation.current) { setAnchor(null); setAligned(false); setSignsConfirmed(false); resetConsent(); }
    if (next !== undefined) generation.current = next;
    if (anchor && status?.turntable?.port === port && status.turntable.feedback?.axes && turntableReferenceSignature(status.turntable.feedback.axes) !== anchor.referenceSignature) { setAnchor(null); setAligned(false); setSignsConfirmed(false); resetConsent(); }
  }, [status, anchor, port]);
  function edit(patch: Partial<AutoFollowDraft>) { if (locked) return; setDraft(previous => ({ ...previous, ...patch })); resetConsent(); setError(""); setNotice(""); }
  function editConfig(key: keyof FieldConfig, value: string) { if (!locked) onConfig(previous => ({ ...previous, [key]: value })); }
  async function readAnchor() {
    if (locked || !aligned || !isTurntablePort(port)) return;
    const epoch = ++operation.current; setPending("probe"); setError(""); setAnchor(null); resetConsent();
    try { const next = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port, axis: 1 } }); if (epoch !== operation.current) return; onStatus(next); setAnchor(autoFollowAnchorFromStatus(next, port, draft.points[0]?.radiusM)); setNotice("已记录首测点的6点方向瞄准参考。"); }
    catch (cause) { if (epoch === operation.current) setError(messageOf(cause)); }
    finally { if (epoch === operation.current) setPending(""); }
  }
  async function stop() {
    if (stopping || !(startPending.current || cycleRunning || active && status?.pointCycle)) return;
    ++operation.current; setStopping(true); setError(""); resetConsent();
    try { await request<FieldStatus>({ action: "stop" }); const next = await request<FieldStatus>({ action: "status" }); onStatus(next); setNotice("已请求停止并保存，请核对转盘和激光的返回状态。"); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setStopping(false); if (!startPending.current) setPending(""); }
  }
  async function start() {
    if (locked || blockers.length || !plan.pointCycle || !signsConfirmed || !laserConsent || !motionConsent) return;
    const epoch = ++operation.current; startPending.current = true; setPending("start"); setError(""); setNotice("");
    try {
      const capture = { ...config, deviceIp: config.deviceIp.trim(), hostIp: config.hostIp.trim(), name: config.name.trim(), turntable: undefined };
      try { localStorage.setItem("blade-field-config-v1", JSON.stringify(capture)); } catch { /* Device addresses and task labels only. */ }
      const next = await request<FieldStatus>({ action: "start", config: { ...capture, source: "device", confirmLaser: true, confirmMotion: true, pointCycle: plan.pointCycle } });
      if (epoch === operation.current) onStatus(next);
    } catch (cause) { if (epoch === operation.current) setError(messageOf(cause)); }
    finally {
      startPending.current = false;
      setPending(""); resetConsent();
    }
  }
  const numeric = (label: string, key: keyof AutoFollowDraft, min: number, max: number, step: number) => <label>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={Number.isFinite(draft[key]) ? String(draft[key]) : ""} disabled={locked} onChange={event => edit({ [key]: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>;
  return <div className="field-auto-follow field-servo-ui">
    <section className="field-card"><div className="field-section-heading"><div><h2>叶片逐点采集</h2><p>按测点和圆周站位顺序采集，确认叶片进入并离开后再换点。</p></div><span className="field-badge">真实设备</span></div>
      <div className="field-auto-core"><label>任务名称<input aria-label="自动跟随任务名称" maxLength={120} value={config.name} disabled={locked} onChange={event => editConfig("name", event.target.value)} placeholder="本次叶片采集任务" /></label><label>目标叶片编号<input aria-label="目标叶片编号" maxLength={80} value={draft.bladeId} disabled={locked} onChange={event => edit({ bladeId: event.target.value })} /></label>{numeric("叶轮每圈时间 · s", "periodSeconds", .5, 3600, .5)}<label>圆周站位间隔<CustomSelect aria-label="圆周站位间隔" value={draft.stepDeg} disabled={locked} onChange={event => edit({ stepDeg: Number(event.target.value) })}>{[180, 120, 90, 60, 45, 30, 20, 15, 10, 5].map(value => <option key={value} value={value}>{value}° · {360 / value} 个站位</option>)}</CustomSelect></label></div>
      <div className="field-auto-points-heading"><h3>叶根到叶尖测点</h3><Button type="button" disabled={locked || draft.points.length >= 40} onClick={() => edit({ points: [...draft.points, { id: globalThis.crypto?.randomUUID?.() || `p-${Date.now()}`, name: `P${draft.points.length + 1}`, radiusM: .31 }] })}><Plus size={14} />添加测点</Button></div>
      <div className="field-auto-points">{draft.points.map((point, index) => <div className="field-auto-point" key={point.id || index}><span className="field-auto-point-index">{index + 1}</span><label>测点名称<input aria-label={`测点${index + 1}名称`} value={point.name} maxLength={80} disabled={locked} onChange={event => edit({ points: draft.points.map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} /></label><label>距轮毂中心 · m<input aria-label={`测点${index + 1}半径`} type="number" min={.001} max={1000} step={.01} value={Number.isFinite(point.radiusM) ? point.radiusM : ""} disabled={locked} onChange={event => edit({ points: draft.points.map((item, at) => at === index ? { ...item, radiusM: event.target.value === "" ? NaN : Number(event.target.value) } : item) })} /></label><span className="field-auto-point-stations">{plan.stationsPerPoint} 个圆周站位</span><Button type="button" variant="ghost" aria-label={`移除测点${index + 1}`} disabled={locked || draft.points.length <= 1} onClick={() => edit({ points: draft.points.filter((_, at) => at !== index) })}><Trash2 size={15} /></Button></div>)}</div>
      <p className="field-subtext">按列表顺序完成每个测点的圆周站位。叶片编号由现场指定，RSSI 只能判断有无回波，不能自动识别叶片。</p>
      <details className="field-auto-setup"><summary>安装、连接与采集条件 <span>{anchor ? "已读取瞄准参考" : "首次使用需完成设置"}</span></summary>
        <div className="field-auto-grid">{numeric("设备至叶轮平面 · m", "distanceM", .001, 10000, .01)}{numeric("轮毂高于激光器 · m", "hubHeightDeltaM", -10000, 10000, .01)}<label>叶轮旋向<CustomSelect aria-label="叶轮旋向" value={draft.direction} disabled={locked} onChange={event => edit({ direction: event.target.value as AutoFollowDraft["direction"] })}><option value="clockwise">顺时针 · 6→9→12→3</option><option value="counterclockwise">逆时针 · 6→3→12→9</option></CustomSelect></label><label>俯仰轴方向<CustomSelect aria-label="俯仰轴方向" value={draft.axis1Sign} disabled={locked} onChange={event => edit({ axis1Sign: Number(event.target.value) as 1 | -1 })}><option value={1}>抬高瞄准点时角度增加</option><option value={-1}>抬高瞄准点时角度减小</option></CustomSelect></label><label>水平轴方向<CustomSelect aria-label="水平轴方向" value={draft.axis2Sign} disabled={locked} onChange={event => edit({ axis2Sign: Number(event.target.value) as 1 | -1 })}><option value={1}>向右瞄准时角度增加</option><option value={-1}>向右瞄准时角度减小</option></CustomSelect></label>{numeric("换点速度上限 · rpm", "maxMoveRpm", .02, 10, .02)}</div>
        <p className="field-subtext">方向均从激光器一侧看叶轮；高度差可为负数。两轴按顺序移动，到位后等待叶片经过。</p>
        <div className="field-auto-grid"><label>采集设备 IP<input aria-label="自动跟随设备 IP" value={config.deviceIp} disabled={locked} onChange={event => editConfig("deviceIp", event.target.value)} placeholder="设备 IPv4 地址" /></label><label>本机设备网卡 IP<input aria-label="自动跟随本机 IP" value={config.hostIp} disabled={locked} onChange={event => editConfig("hostIp", event.target.value)} placeholder="连接设备的网卡 IPv4 地址" /></label><label>转盘串口<input aria-label="自动跟随转盘串口" list="field-auto-ports" value={port} disabled={locked} placeholder="COM3 或 /dev/cu.…" onChange={event => { setPort(normalizeTurntablePort(event.target.value)); resetConsent(); }} /><datalist id="field-auto-ports">{ports.map(item => <option value={item.port} key={item.port}>{item.description}</option>)}</datalist></label></div>
        <div className="field-form-actions"><Button type="button" disabled={locked} onClick={async () => { setPending("ports"); setError(""); try { const result = await request<{ ports: { port: string; description: string }[] }>({ action: "turntablePorts" }); setPorts(result.ports || []); } catch (cause) { setError(messageOf(cause)); } finally { setPending(""); } }}><RefreshCw size={14} />刷新串口</Button><Button type="button" disabled={locked} onClick={onService}>设备与服务设置</Button></div>
        <div className="field-auto-grid">{numeric("每个测点重复轮数", "cycles", 1, 100, 1)}{numeric("单站最多等待 · 圈", "waitRevolutions", 1, 10, 1)}{numeric("进入回波波动阈值 · 百分点", "rssiEnterSpread", .1, 100, .1)}{numeric("离开回波波动阈值 · 百分点", "rssiExitSpread", 0, 99.9, .1)}{numeric("进入确认时间 · ms", "rssiEnterConfirmMs", 10, 1000, 10)}{numeric("离开确认时间 · ms", "rssiConfirmMs", 10, 1000, 10)}</div>
      </details>
    </section>
    <section className="field-card field-auto-anchor"><div className="field-section-heading"><div><h2>首测点瞄准参考</h2><p>停转叶轮，将 {draft.bladeId || "目标"} 号叶片的 {draft.points[0]?.name || "首测点"} 放到6点方向，在手动控制中完成激光瞄准。</p></div><Button type="button" disabled={locked} onClick={onManual}>手动瞄准与校准</Button></div><label className="field-auto-check"><input type="checkbox" checked={aligned} disabled={locked} onChange={event => { setAligned(event.target.checked); if (!event.target.checked) setAnchor(null); resetConsent(); }} />叶轮和转盘已停止，首测点在6点方向且激光已瞄准</label><div className="field-auto-anchor-read"><Button type="button" disabled={locked || !aligned || !isTurntablePort(port) || !draft.points[0]} onClick={() => void readAnchor()}><Crosshair size={15} />{pending === "probe" ? "正在读取…" : "读取两轴瞄准参考"}</Button><span>俯仰 {numberText(anchor?.axis1AngleDeg, 3)}°</span><span>水平 {numberText(anchor?.axis2AngleDeg, 3)}°</span><span className={`field-badge ${anchor ? "green" : "amber"}`}>{anchor ? "已绑定当前参考位" : "待读取"}</span></div><label className="field-auto-check"><input type="checkbox" checked={signsConfirmed} disabled={locked || !anchor} onChange={event => { setSignsConfirmed(event.target.checked); resetConsent(); }} />已在手动控制中核对俯仰、水平轴方向与现场一致</label></section>
    <section className="field-card"><div className="field-section-heading"><h2>采集路线</h2><span className="field-badge">{numberText(plan.nominalRpm)} rpm · {draft.periodSeconds} s / 圈</span></div><div className="field-auto-metrics"><div><span>测点 / 每点站位</span><strong>{draft.points.length} / {plan.stationsPerPoint}</strong></div><div><span>计划记录</span><strong>{Number.isFinite(plan.totalRecords) ? plan.totalRecords : "—"} 条</strong></div><div><span>换点指令速度</span><strong>{plan.speedRpm ? numberText(plan.speedRpm) : "—"} rpm</strong></div><div><span>最短换点用时</span><strong>{plan.speedRpm ? numberText(plan.maxTravelLowerBoundSeconds) : "—"} s</strong></div></div><p className="field-subtext">最短换点用时未计通讯、加减速与稳定等待。{plan.mayMissNextPass ? "当前速度上限可能错过下一次经过，将在到位后等待后续叶片经过。" : "叶轮周期用于规划换点速度，不作为叶片到达的确认信号。"}</p>
      {plan.points.length > 0 && <details className="field-auto-route"><summary>查看 {plan.points.length} 个站位的目标角度</summary><div className="field-table-scroll"><table className="field-table"><thead><tr><th>顺序</th><th>测点</th><th>圆周角</th><th>俯仰目标</th><th>水平目标</th></tr></thead><tbody>{plan.points.map((point, index) => <tr key={point.pointId}><td>{index + 1}</td><td>{point.radialPointName}</td><td>{point.azimuthDeg}°</td><td>{numberText(point.axis1AngleDeg, 3)}°</td><td>{numberText(point.axis2AngleDeg, 3)}°</td></tr>)}</tbody></table></div></details>}
      {blockers.length > 0 && !cycleRunning && <div className="field-auto-blockers" role="status"><strong>开始前还需完成</strong><ul>{blockers.map(item => <li key={item}>{item}</li>)}</ul></div>}
      <div className="field-auto-confirmations"><label className="field-auto-check"><input type="checkbox" checked={laserConsent} disabled={locked} onChange={event => setLaserConsent(event.target.checked)} />光路与人员安全已确认，允许采集期间开启激光</label><label className="field-auto-check"><input type="checkbox" checked={motionConsent} disabled={locked} onChange={event => setMotionConsent(event.target.checked)} />已核对站位路线、两轴运动范围与周围空间，允许自动换点</label></div>
      {error && <p className="field-error" role="alert">{error}</p>}{notice && <p className="field-success" role="status">{notice}</p>}
      <div className="field-auto-actions"><Button type="button" variant="primary" disabled={locked || blockers.length > 0 || !signsConfirmed || !laserConsent || !motionConsent} onClick={() => void start()}><Route size={15} />{pending === "start" ? "正在启动…" : "开始自动跟随"}</Button><Button type="button" variant="danger" disabled={stopping || !(pending === "start" || cycleRunning || active && status?.pointCycle)} onClick={() => void stop()}><Square size={13} />{stopping ? "正在停止…" : "停止并保存"}</Button><Button type="button" variant="ghost" disabled={!!pending || stopping} onClick={onRecords}>查看本机记录</Button></div>
    </section>
    <FieldCycleProgress status={status} />
  </div>;
}
