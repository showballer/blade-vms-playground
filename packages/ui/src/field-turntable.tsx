"use client";
import React, { useEffect, useRef, useState } from "react";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { manualCaptureRoute, manualRouteKey, readManualRouteSettings, type FieldCaptureRoute } from "./field-capture-route";
import type { FieldPositionedStation } from "./field-route-position";
import { isTurntablePort, normalizeTurntablePort } from "./field-turntable-port";
import { loadSharedTurntablePoints, saveSharedTurntablePoints, newTurntablePointId as newPointId,
  pointReferenceSignature, turntableReferenceSignature, turntablePointMotionError, turntableAxisLimitsError } from "./field-turntable-points";
import { matchingWorkOrigin, toWorkAngle, toDeviceAngle, workAngleBounds, type FieldWorkOrigin } from "./field-turntable-origin";
import { fieldIsActive, fieldTurntableMotionMode, type FieldAxisFeedback, type FieldBladePoint, type FieldRequestOptions, type FieldStatus, type FieldTurntableConfig } from "./field-types";

export const turntableLabels: Record<string, string> = { disconnected: "未启用", checking: "检查转盘", checked: "已读取反馈", homing: "俯仰回零中", testing: "独立试转中", test_stopping: "试转结束，确认停稳", prepared: "设置完成，可开始采集", starting: "发送运动命令", awaiting_feedback: "等待速度反馈", running: "实际转动", positioning: "定位中", holding: "已到位，持续采集", stopping: "确认停稳", stopped: "已确认停止", unknown: "停止未确认", error: "转盘异常" };
const initial: FieldTurntableConfig = { port: "", axis: 1, speedRpm: 0.2, direction: "forward", durationSeconds: 0, protocol: "position" };
const axisDraftKey = "blade-turntable-axes-v1";
function axisDrafts(): Partial<Record<1 | 2, FieldTurntableConfig>> {
  try {
    const saved = JSON.parse(localStorage.getItem(axisDraftKey) || "{}");
    return Object.fromEntries(([1, 2] as const).filter(axis => saved?.[axis]?.axis === axis && saved[axis].protocol === "position").map(axis => [axis, saved[axis]]));
  } catch { return {}; }
}
export function FieldTurntableFeedback({ status }: { status: FieldStatus | null }) {
  const value = status?.turntable, feedback = value?.feedback;
  if (!value || value.state === "disconnected") return null;
  return <section className="field-card field-turntable-feedback field-servo-ui"><h2>转盘状态</h2><p>{turntableLabels[value.state] || value.state}{value.port ? ` · ${value.port}` : ""}{value.axis ? ` · 轴 ${value.axis}` : ""}</p><dl className="field-details">
    <div><dt>实际输出轴转速</dt><dd>{feedback?.outputRpm ?? "—"} rpm</dd></div>
    <div><dt>限位反馈</dt><dd>{feedback?.limitFlags == null ? "速度接口未提供，详见新版反馈" : feedback.limitFlags === 0 ? "未触发" : `保护异常 (${feedback.limitFlags})`}</dd></div>
    <div><dt>驱动器报警</dt><dd>{feedback?.alarmCode ?? "—"}</dd></div>
    <div><dt>原始位置计数</dt><dd>{feedback?.positionRaw ?? "—"}</dd></div>
    {([1, 2] as const).map(axis => <div key={axis}><dt>轴{axis}{axis === 1 ? "俯仰" : "水平"}角度（设备坐标）</dt><dd>{feedback?.axes?.[String(axis)]?.output_angle_deg == null ? "参考位无效 / 未读取" : `${feedback.axes[String(axis)].output_angle_deg}°`}</dd></div>)}
  </dl><p className="field-subtext">角度来自新版下位机参考坐标；状态为最近一次读取，按主机时间关联波形。</p>{value.error && <p className="field-error">{value.error}</p>}</section>;
}

type ManualPoint = FieldBladePoint;

export function manualAngleRecordReady(feedback: FieldAxisFeedback | undefined): boolean {
  // A latched motion fault does not invalidate a stationary angle measurement.
  return !!feedback && feedback.output_angle_deg != null && Number.isFinite(feedback.output_angle_deg) &&
    feedback.motor_rpm === 0 && (feedback.flags & 16) === 0 && [0, 7, 8].includes(feedback.home_phase);
}

function manualAngleText(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? value.toFixed(3) : "";
}

function manualAngleInRange(value: number, axis: 1 | 2): boolean {
  return Number.isFinite(value) && Math.abs(value) <= (axis === 1 ? 35 : 180);
}

export const manualPointRecallError = turntablePointMotionError;

export function manualAxisMotionError(value: FieldAxisFeedback | undefined, axis: 1 | 2, target?: number): string {
  if (!manualAngleRecordReady(value) || !Number.isInteger(value?.flags)) return `请读取轴${axis}有效角度并确认停稳`;
  if (value!.fault !== 0) return `轴${axis}故障码 ${value!.fault}，请先排除故障`;
  return turntableAxisLimitsError(value, axis, target);
}

export function FieldTurntableManual({ status, disabled, request, onBusy, onStatus, onRoute, onAcquisition, workOrigin, onPortChange, connectionPort, positionedStation }: {
  status: FieldStatus | null; disabled: boolean; request: <T>(options: FieldRequestOptions) => Promise<T>;
  onBusy?: (value: boolean) => void; onStatus?: (status: FieldStatus) => void;
  onRoute?: (route: FieldCaptureRoute) => void; onAcquisition?: () => void;
  connectionPort?: string; workOrigin?: FieldWorkOrigin | null; onPortChange?: (port: string) => void;
  positionedStation?: FieldPositionedStation;
}) {
  const banks = useRef(axisDrafts());
  const appliedPositionSequence = useRef(0);
  const [localPort, setPort] = useState(status?.turntable?.port || banks.current[1]?.port || ""), [axis, setAxis] = useState<1 | 2>(1), [target, setTarget] = useState<number | undefined>(banks.current[1]?.targetAngleDeg), [step, setStep] = useState(0.1);
  const [speedRpm, setSpeedRpm] = useState(banks.current[1]?.speedRpm ?? 0.2);
  const [durationSeconds, setDurationSeconds] = useState(banks.current[1]?.durationSeconds ?? 0);
  const [axis1RecordAngle, setAxis1RecordAngle] = useState(""), [axis2RecordAngle, setAxis2RecordAngle] = useState("");
  const [pointName, setPointName] = useState("M01"), [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [routeSettings, setRouteSettings] = useState(() => readManualRouteSettings(null));
  const recallSpeedRpm = routeSettings.speedRpm;
  const [recovery, setRecovery] = useState(false);
  const [points, setPoints] = useState<ManualPoint[]>([]), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [motionConsent, setMotionConsent] = useState(false), [error, setError] = useState("");
  const port = connectionPort || localPort;
  const feedback = status?.turntable?.port === port ? status.turntable.feedback : undefined;
  const axes = feedback?.axes;
  const axisFeedback = axes?.[String(axis)];
  const origin = matchingWorkOrigin(workOrigin, status, port);
  const targetBounds = workAngleBounds(axis, origin), oneBounds = workAngleBounds(1, origin), twoBounds = workAngleBounds(2, origin);
  const displayAngle = (absolute: number | null | undefined, forAxis: 1 | 2) => {
    const value = toWorkAngle(absolute, forAxis, origin);
    return value == null ? "—" : `${value.toFixed(3)}°`;
  };
  const recordDisplay = (absolute: string, forAxis: 1 | 2) => absolute.trim() === "" ? "" : toWorkAngle(Number(absolute), forAxis, origin) ?? "";
  const recordInput = (relative: string, forAxis: 1 | 2) => relative === "" ? "" : String(toDeviceAngle(Number(relative), forAxis, origin));
  const recordReady = manualAngleRecordReady(axisFeedback) ||
    (axis1RecordAngle.trim() !== "" && axis2RecordAngle.trim() !== "" &&
      manualAngleInRange(Number(axis1RecordAngle), 1) && manualAngleInRange(Number(axis2RecordAngle), 2));
  const axisReady = !manualAxisMotionError(axisFeedback, axis);
  const canMove = axisReady && isTurntablePort(port) && !status?.turntableWarning &&
    Number.isFinite(speedRpm) && speedRpm >= 0.02 && speedRpm <= 100 && target != null && Number.isFinite(target) &&
    !manualAxisMotionError(axisFeedback, axis, target);
  const canMoveToDeviceZero = axisReady && isTurntablePort(port) && !status?.turntableWarning &&
    Number.isFinite(speedRpm) && speedRpm >= 0.02 && speedRpm <= 100 &&
    !manualAxisMotionError(axisFeedback, axis, 0);
  const recall = status?.turntable?.port === port ? status.turntable.recall : undefined;
  const motionMode = fieldTurntableMotionMode(status?.turntable, port);
  const lastMove = status?.turntable?.port === port ? status.turntable.lastMove : undefined;
  const recalling = !!recall && !!status?.turntableBusy;
  const stopAxis = recalling ? (status?.turntable?.axis === 2 ? 2 : 1) : axis;
  const locked = disabled || busy || !!status?.turntableBusy || fieldIsActive(status);
  const positioning: FieldTurntableConfig = { ...initial, port, axis, targetAngleDeg: target, speedRpm, durationSeconds };
  const stopLocked = disabled || busy || fieldIsActive(status) || !isTurntablePort(port) ||
    !!status?.turntableBusy && (status.turntable?.port !== port || !recalling && status.turntable?.axis !== axis);
  const recallBlocked = status?.turntableWarning || ([1, 2] as const).map(item => {
    return manualAxisMotionError(axes?.[String(item)], item);
  }).filter(Boolean).join("；");
  useEffect(() => {
    setPoints(loadSharedTurntablePoints(localStorage));
    setRouteSettings(readManualRouteSettings(localStorage.getItem(manualRouteKey)));
    setLoaded(true);
  }, []);
  useEffect(() => { if (loaded) try { saveSharedTurntablePoints(localStorage, points); } catch { /* Optional local history. */ } }, [loaded, points]);
  useEffect(() => { if (loaded) try { localStorage.setItem(manualRouteKey, JSON.stringify(routeSettings)); } catch { /* Editable route only. */ } }, [loaded, routeSettings]);
  const route = manualCaptureRoute(points, port, routeSettings, status?.service.generation, origin);
  const routeKey = JSON.stringify(route);
  useEffect(() => {
    if (!loaded || locked || status?.deviceBusy || !positionedStation || positionedStation.kind !== "manual" ||
        positionedStation.sequence <= appliedPositionSequence.current) return;
    appliedPositionSequence.current = positionedStation.sequence;
    if (positionedStation.port !== port || positionedStation.generation !== status?.service.generation ||
        !route.cycle?.points.some(point => point.pointId === positionedStation.pointId)) return;
    setRouteSettings(previous => ({ ...previous, startPointId: positionedStation.pointId }));
    setError("");
  }, [loaded, locked, status?.deviceBusy, status?.service.generation, positionedStation, port, routeKey]);
  useEffect(() => { if (loaded) onRoute?.(route); }, [loaded, routeKey, onRoute]);
  useEffect(() => { onPortChange?.(port); }, [port, onPortChange]);
  const reorder = (index: number, offset: number) => setPoints(previous => {
    const next = [...previous], destination = index + offset;
    if (destination < 0 || destination >= next.length) return previous;
    [next[index], next[destination]] = [next[destination], next[index]]; return next;
  });
  useEffect(() => { setMotionConsent(false); }, [port, axis]);
  useEffect(() => { setRecovery(false); }, [port, axis]);
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false); }, [busy, onBusy]);
  useEffect(() => {
    banks.current[axis] = positioning;
    try { localStorage.setItem(axisDraftKey, JSON.stringify(banks.current)); } catch { /* Input drafts do not authorize movement. */ }
  }, [port, axis, target, speedRpm, durationSeconds]);
  const selectAxis = (next: 1 | 2) => {
    if (locked || next === axis) return;
    const draft = banks.current[next];
    setAxis(next); setTarget(draft?.targetAngleDeg); setSpeedRpm(draft?.speedRpm ?? 0.2); setDurationSeconds(draft?.durationSeconds ?? 0);
  };
  const call = async <T,>(options: FieldRequestOptions) => {
    setError(""); setBusy(true);
    try { return await request<T>(options); } catch (failure) { setError(failure instanceof Error ? failure.message : "转盘操作失败"); return undefined; } finally { setBusy(false); }
  };
  const read = async () => {
    const result = await call<FieldStatus>({ action: "turntable", request: { action: "probe", port, axis, ...(recovery ? { confirmRecovery: true } : {}) } });
    if (result) onStatus?.(result);
    const observed = result?.turntable?.port === port ? result.turntable.feedback?.axes : undefined;
    if (observed) {
      setAxis1RecordAngle(manualAngleText(observed["1"]?.output_angle_deg));
      setAxis2RecordAngle(manualAngleText(observed["2"]?.output_angle_deg));
    }
    if (result && !result.turntableWarning) setRecovery(false);
  };
  const adjust = (nextAxis: 1 | 2, direction: -1 | 1) => {
    const current = axes?.[String(nextAxis)]?.output_angle_deg;
    if (current == null) { setError(`请先读取轴${nextAxis}当前角度`); return; }
    const limit = nextAxis === 1 ? 35 : 180;
    setAxis(nextAxis); setTarget(Math.max(-limit, Math.min(limit, Number((current + direction * step).toFixed(3)))));
  };
  const move = () => {
    if (!canMove || !motionConsent) { setError("请先读取当前轴，核对目标角度和定位转速，并勾选手动运动确认"); return; }
    void call<FieldStatus>({ action: "turntable", request: { ...positioning, durationSeconds: 0, action: "manual_move", confirmMotion: true } });
  };
  const stop = () => void call<FieldStatus>({ action: "turntable", request: { action: "stop", port, axis: stopAxis, confirmMotion: true } });
  const moveToDeviceZero = async () => {
    if (!canMoveToDeviceZero) return;
    // This is the manufacturer's absolute coordinate, never the optical/work zero.
    const result = await call<FieldStatus>({ action: "turntable", request: {
      action: "manual_move", port, axis, protocol: "position", targetAngleDeg: 0,
      speedRpm, durationSeconds: 0, confirmMotion: true,
    } });
    if (result) onStatus?.(result);
  };
  const recallPoint = (point: ManualPoint) => {
    const reason = manualPointRecallError(point, axes, port) || recallBlocked;
    if (reason) { setError(reason); return; }
    void call<FieldStatus>({ action: "turntable", request: { action: "recall", port, recordedPort: point.port, axis: 1, axis1AngleDeg: point.axis1AngleDeg!, axis2AngleDeg: point.axis2AngleDeg!, referenceSignature: pointReferenceSignature(point), speedRpm: recallSpeedRpm, confirmMotion: true } });
  };
  const record = async () => {
    if (!port) { setError("请先填写转盘串口"); return; }
    // Manual point marking is a local record operation.  If both fields have
    // been filled, do not issue another motion/ready query: this lets an
    // operator record a position even when the controller cannot provide a
    // valid angle for the other axis.  Clicking “读取反馈” first still
    // refreshes both fields from the controller.
    let observed = axes;
    let one = observed?.["1"], two = observed?.["2"];
    const manualOne = axis1RecordAngle.trim() !== "" ? Number(axis1RecordAngle) : NaN;
    const manualTwo = axis2RecordAngle.trim() !== "" ? Number(axis2RecordAngle) : NaN;
    if (!Number.isFinite(manualOne) || !Number.isFinite(manualTwo)) {
      const result = await call<FieldStatus>({ action: "turntable", request: { action: "probe", port, axis } });
      if (!result) return;
      observed = result.turntable?.port === port ? result.turntable.feedback?.axes : undefined;
      one = observed?.["1"];
      two = observed?.["2"];
    }
    const oneAngle = Number.isFinite(manualOne) ? manualOne :
      Number.isFinite(one?.output_angle_deg) ? one!.output_angle_deg! : NaN;
    const twoAngle = Number.isFinite(manualTwo) ? manualTwo :
      Number.isFinite(two?.output_angle_deg) ? two!.output_angle_deg! : NaN;
    if (!manualAngleInRange(oneAngle, 1) || !manualAngleInRange(twoAngle, 2)) {
      setError("请读取反馈；若某轴没有有效角度，请在下方填写该轴当前角度后再记录"); return;
    }
    const referenceSignature = turntableReferenceSignature(observed);
    setAxis1RecordAngle(oneAngle.toFixed(3));
    setAxis2RecordAngle(twoAngle.toFixed(3));
    setPoints(previous => [...previous, { pointId: newPointId(), name: pointName.trim() || `M${String(previous.length + 1).padStart(2, "0")}`, bladeIndex: 1, bladePointIndex: 1, circleIndex: previous.length + 1, circleStepDeg: 60, recordedAt: Date.now(), axis1AngleDeg: oneAngle, axis2AngleDeg: twoAngle, axis1RawCounts: one?.actual_counts ?? null, axis2RawCounts: two?.actual_counts ?? null, port, ...(referenceSignature ? { referenceSignature, references: referenceSignature } : {}) }]);
    setPointName(`M${String(points.length + 2).padStart(2, "0")}`);
  };
  const removePoint = (index: number) => {
    setPoints(previous => previous.filter((_, current) => current !== index));
    setError("");
  };
  const exportPoints = (format: "csv" | "json") => {
    if (!points.length) { setError("当前没有点位记录"); return; }
    const payload = format === "json" ? JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), points }, null, 2) : ["点位,记录时间,轴1角度(°),轴2角度(°),轴1原始计数,轴2原始计数", ...points.map(point => [point.name, new Date(point.recordedAt).toISOString(), point.axis1AngleDeg ?? "", point.axis2AngleDeg ?? "", point.axis1RawCounts ?? "", point.axis2RawCounts ?? ""].join(","))].join("\n");
    const blob = new Blob([format === "csv" ? "\\uFEFF" + payload : payload], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `turntable-points-${new Date().toISOString().slice(0, 10)}.${format}`; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="field-card field-turntable-manual field-servo-ui"><div className="field-section-heading"><div><h2>转盘手动点位控制</h2><p>手动瞄准、点位回位与采集路线配置。单轴定位控制所选轴，记录点位回位控制两轴。</p></div><span className={`field-badge ${axisReady ? "green" : recordReady ? "amber" : ""}`}>{status?.turntableBusy ? "运动中" : axisReady ? "当前轴可操作" : recordReady ? "可记录 · 运动受限" : "待读取有效静止反馈"}</span></div>
    <div className="field-manual-layout">
      <section className="field-turntable-block field-motion-block" aria-label="连接与定位"><h3>连接与定位</h3>
<div className="field-config-grid"><label>{connectionPort ? "转盘连接" : "转盘串口"}<input disabled={locked} readOnly={!!connectionPort} aria-label="手动控制转盘串口" list="manual-turntable-ports" placeholder="COM6 或 /dev/cu.usbserial-…" value={port} onChange={event => setPort(normalizeTurntablePort(event.target.value))} /><datalist id="manual-turntable-ports">{ports.map(item => <option key={item.port} value={item.port}>{item.description}</option>)}</datalist></label><label>微调步长（°）<input disabled={locked} aria-label="手动控制微调步长" type="number" min={0.001} max={35} step={0.001} value={step} onChange={event => setStep(Math.max(0.001, Number(event.target.value) || 0.001))} /></label><label>目标角度（°）<input disabled={locked} aria-label="手动控制目标角度" type="number" min={targetBounds.min} max={targetBounds.max} step={0.001} value={toWorkAngle(target, axis, origin) ?? ""} onChange={event => setTarget(event.target.value === "" ? undefined : toDeviceAngle(Number(event.target.value), axis, origin))} /></label><label>定位转速（rpm）<input disabled={locked} aria-label="手动定位转速" type="number" min={0.02} max={100} step={0.02} value={Number.isFinite(speedRpm) ? speedRpm : ""} onChange={event => setSpeedRpm(event.currentTarget.valueAsNumber)} /></label></div>
    <div className="field-turntable-actions">{!connectionPort && <Button type="button" disabled={locked} onClick={() => void call<{ ports?: { port: string; description: string }[] }>({ action: "turntablePorts" }).then(result => { if (result?.ports) setPorts(result.ports); })}>刷新串口</Button>}<Button type="button" disabled={locked || !isTurntablePort(port)} onClick={read}>读取反馈</Button><Button type="button" variant="danger" disabled={stopLocked} onClick={stop}>{recalling ? "停止两轴回位" : "停止当前轴"}</Button>{axis === 2 && <><Button type="button" disabled={locked || !canMoveToDeviceZero} onClick={() => void moveToDeviceZero()}>水平回设备0°</Button><Button type="button" disabled={locked || !isTurntablePort(port) || !axisFeedback} onClick={() => void call<FieldStatus>({ action: "turntable", request: { action: "limits", port, axis, confirmMotion: true } })}>应用当前轴 ±180°软限位</Button></>}</div>
    <p className="field-subtext">{axis === 1 ? "俯仰轴断电后，在“转盘设置”中先“机械回零”，再“回水平 0°”；定位沿用控制板实际软限位。" : "水平轴参考在“转盘设置”中设置。回设备0°沿用上方定位转速，与顶部“回到原点”的作业坐标分开。"}</p>
    <div className="field-turntable-actions" role="group" aria-label="独立单轴微调"><Button type="button" disabled={locked} aria-pressed={axis === 1} variant={axis === 1 ? "primary" : undefined} onClick={() => selectAxis(1)}>轴1 · 俯仰</Button><Button type="button" disabled={locked} aria-pressed={axis === 2} variant={axis === 2 ? "primary" : undefined} onClick={() => selectAxis(2)}>轴2 · 水平</Button><Button type="button" disabled={locked || !axisReady} onClick={() => adjust(axis, -1)}>当前轴 −步长</Button><Button type="button" disabled={locked || !axisReady} onClick={() => adjust(axis, 1)}>当前轴 +步长</Button></div>
    <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={motionConsent} onChange={event => setMotionConsent(event.target.checked)} />允许当前选中轴移动到目标角度，另一轴保持不动</label>
<div className="field-turntable-actions"><Button type="button" variant="primary" disabled={locked || !canMove || !motionConsent} onClick={move}>移动到目标点</Button></div>
      </section>
      <section className="field-turntable-block field-feedback-block" aria-label="转盘反馈"><h3>反馈与状态</h3>
    <dl className="field-details"><div><dt>当前轴角度{origin ? "（作业坐标）" : ""}</dt><dd>{displayAngle(axisFeedback?.output_angle_deg, axis)}</dd></div><div><dt>两轴角度{origin ? "（作业坐标）" : ""}</dt><dd>轴1：{displayAngle(axes?.["1"]?.output_angle_deg, 1)}　轴2：{displayAngle(axes?.["2"]?.output_angle_deg, 2)}</dd></div><div><dt>原始计数</dt><dd>轴1：{axes?.["1"]?.actual_counts ?? "—"}　轴2：{axes?.["2"]?.actual_counts ?? "—"}</dd></div></dl>
    <dl className="field-details">
      <div><dt>换点方式</dt><dd>{motionMode === "drive_internal" ? "控制器反馈定位" : motionMode === "dual_axis_timed" ? "已识别双轴联动" : motionMode === "sequential" ? "两轴依次定位" : "待读取反馈检测"}</dd></div>
      <div><dt>操作状态</dt><dd>{status?.turntable?.port === port ? turntableLabels[status.turntable.state] || status.turntable.state : "未读取"}</dd></div>
      {([1, 2] as const).map(item => {
        const observed = axes?.[String(item)];
        return observed && <div key={item}><dt>轴{item}反馈状态</dt><dd>速度 {observed.motor_rpm} rpm · 故障码 {observed.fault} · 停止待确认 {(observed.flags & 16) ? "是" : "否"} · 标志 0x{observed.flags.toString(16).toUpperCase().padStart(4, "0")} · 软限位（设备坐标） {observed.guard.soft_enabled ? "开启" : "关闭"}（{observed.guard.minimum_deg}° ～ {observed.guard.maximum_deg}°）</dd></div>;
      })}
      {feedback && <div><dt>本次查询轴驱动器 / 限位标志</dt><dd>轴{status?.turntable?.axis} · 报警码 {feedback.alarmCode} · 限位标志 {feedback.limitFlags ?? "未提供"}</dd></div>}
    </dl>
      </section>
    </div>
    <section className="field-turntable-block field-points-block" aria-label="点位记录与回位"><div className="field-section-heading"><h3>点位记录与采集路线</h3><span className="field-badge">{points.length} 个点位</span></div>
<div className="field-config-grid"><label>记录名称<input aria-label="手动点位记录名称" value={pointName} maxLength={40} onChange={event => setPointName(event.target.value)} /></label><label>记录轴1角度（°）<input disabled={locked} aria-label="记录轴1角度" type="number" min={oneBounds.min} max={oneBounds.max} step={0.001} placeholder="读取反馈后可修改" value={recordDisplay(axis1RecordAngle, 1)} onChange={event => setAxis1RecordAngle(recordInput(event.target.value, 1))} /></label><label>记录轴2角度（°）<input disabled={locked} aria-label="记录轴2角度" type="number" min={twoBounds.min} max={twoBounds.max} step={0.001} placeholder="读取反馈后可修改" value={recordDisplay(axis2RecordAngle, 2)} onChange={event => setAxis2RecordAngle(recordInput(event.target.value, 2))} /></label></div>
<div className="field-turntable-actions field-point-actions"><Button type="button" disabled={locked || !isTurntablePort(port)} onClick={() => void record()}>读取并记录两轴角度</Button><Button type="button" disabled={locked || !points.length} onClick={() => setPoints(previous => previous.slice(0, -1))}>删除上一点</Button><Button type="button" disabled={locked || !points.length} onClick={() => setPoints([])}>清空记录</Button><Button type="button" disabled={locked || !points.length} onClick={() => exportPoints("csv")}>导出 CSV</Button><Button type="button" disabled={locked || !points.length} onClick={() => exportPoints("json")}>导出 JSON</Button></div>
    <div className="field-config-grid field-recall-speed"><label>点位移动速度<CustomSelect aria-label="点位回位速度" disabled={locked} value={recallSpeedRpm} onChange={event => { const speed = Number(event.target.value); if ([0.2, 0.5, 1, 2].includes(speed)) setRouteSettings(previous => ({ ...previous, speedRpm: speed })); }}><option value={0.2}>0.2 rpm · 1.2°/秒</option><option value={0.5}>0.5 rpm · 3°/秒</option><option value={1}>1 rpm · 6°/秒</option><option value={2}>2 rpm · 12°/秒</option></CustomSelect></label></div>
    <p className="field-subtext">此速度用于点位回位和联动采集换点，是每个轴的速度上限。手动单轴定位使用上方“定位转速”。{motionMode === "drive_internal" ? "分别下发两轴反馈定位，运动可重叠；控制器按实测位置减速到位，两轴均停稳才开始采集。" : motionMode === "dual_axis_timed" ? "两轴同时启动并按同一时长到位，系统计算加减速和运动用时。" : motionMode === "sequential" ? "先定位轴1，再定位轴2。" : "读取反馈后自动识别可用的换点方式。"}实际完成时间还包含通讯与停稳确认。</p>
    {points.length > 0 && <>
      <p className="field-subtext">点击“移动到此点”后，两轴均到位并停稳才会显示完成；可随时点击“停止两轴回位”取消。速度调整用于下一次回位。点位须与记录时的串口及参考位一致；缺少参考信息的历史点位需重新读取并标定。</p>
      <div className="field-table-scroll" role="region" aria-label="手动记录的转盘点位" tabIndex={0}><table className="field-table"><thead><tr><th>参与采集</th><th>名称</th><th>轴1角度</th><th>轴2角度</th><th>原始计数</th><th>时间</th><th>操作</th></tr></thead><tbody>{points.map((point, index) => {
        const reason = manualPointRecallError(point, axes, port);
        return <tr key={`${point.recordedAt}-${index}`}><td><input type="checkbox" aria-label={`采集点位 ${point.name}`} disabled={locked} checked={!routeSettings.excludedIds.includes(point.pointId || "")} onChange={event => setRouteSettings(previous => ({ ...previous, excludedIds: event.target.checked ? previous.excludedIds.filter(id => id !== point.pointId) : [...previous.excludedIds, point.pointId!] }))} /></td><td>{point.name}</td><td>{displayAngle(point.axis1AngleDeg, 1)}</td><td>{displayAngle(point.axis2AngleDeg, 2)}</td><td className="mono">{point.axis1RawCounts ?? "—"} / {point.axis2RawCounts ?? "—"}</td><td>{new Date(point.recordedAt).toLocaleTimeString("zh-CN", { hour12: false })}</td><td><div className="field-point-row-actions"><Button type="button" variant="ghost" disabled={locked || index === 0} aria-label={`上移点位 ${point.name}`} onClick={() => reorder(index, -1)}>上移</Button><Button type="button" variant="ghost" disabled={locked || index === points.length - 1} aria-label={`下移点位 ${point.name}`} onClick={() => reorder(index, 1)}>下移</Button><Button type="button" disabled={locked || !!reason || !!recallBlocked || !isTurntablePort(port)} title={reason || recallBlocked || `移动至 ${point.name} 的两轴记录角度`} aria-label={`移动到点位 ${point.name}，第${index + 1}条记录`} onClick={() => recallPoint(point)}>移动到此点</Button><Button type="button" variant="ghost" disabled={locked} aria-label={`删除点位 ${point.name}，第${index + 1}条记录`} title={`删除点位 ${point.name}`} onClick={() => removePoint(index)}>删除</Button></div>{reason && <small>{reason}</small>}</td></tr>;
      })}</tbody></table></div>
    </>}
    <section className="field-turntable-block field-route-settings" aria-label="手动点位联动采集配置">
      <div className="field-section-heading"><div><h3>联动采集路线</h3><p>按列表顺序执行勾选点位，确认叶片进入并离开后换点。</p></div><Button type="button" onClick={onAcquisition}>前往数据采集</Button></div>
      <p className="field-route-order">{route.pointNames.length ? `采集顺序：${route.pointNames.join(" → ")}` : "尚未选择采集点位"}</p>
      <fieldset className="field-config-grid" disabled={locked}>
        <label>循环次数<input aria-label="手动路线循环次数" type="number" min={1} max={100} value={Number.isFinite(routeSettings.cycles) ? routeSettings.cycles : ""} onChange={event => setRouteSettings(previous => ({ ...previous, cycles: event.target.valueAsNumber }))} /></label>
        <label>每点最长等待 · 秒<input aria-label="手动路线每点最长等待" type="number" min={1} max={3600} value={Number.isFinite(routeSettings.waitSeconds) ? routeSettings.waitSeconds : ""} onChange={event => setRouteSettings(previous => ({ ...previous, waitSeconds: event.target.valueAsNumber }))} /></label>
      </fieldset>
      <details className="field-route-advanced"><summary>叶片进入／离开判定</summary><fieldset className="field-config-grid" disabled={locked}>
        {([["rssiEnterSpread", "进入波动阈值 · 百分点", .1, 100], ["rssiExitSpread", "离开波动阈值 · 百分点", 0, 99.9], ["rssiEnterConfirmMs", "进入确认时间 · ms", 10, 1000], ["rssiConfirmMs", "离开确认时间 · ms", 10, 1000]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input aria-label={`手动路线${label}`} type="number" min={min} max={max} value={Number.isFinite(routeSettings[key]) ? routeSettings[key] : ""} onChange={event => setRouteSettings(previous => ({ ...previous, [key]: event.target.valueAsNumber }))} /></label>)}
      </fieldset></details>
      {route.errors.length > 0 && <p className="field-notice warning" role="status">{route.errors.join("；")}</p>}
    </section>
    {recall && <p className={recall.state === "complete" ? "field-success" : recall.state === "error" ? "field-error" : "field-notice"} role="status">点位回位：轴1 {displayAngle(recall.targets[0], 1)} / 轴2 {displayAngle(recall.targets[1], 2)} · {recall.state === "complete" ? "两轴已到达记录点" : recall.state === "cancelled" ? "已取消回位" : recall.state === "error" ? "回位失败，请核对停止状态" : status?.turntable?.motionMode === "drive_internal" ? "两轴反馈定位中" : status?.turntable?.motionMode === "dual_axis_timed" ? `两轴同步定位${lastMove?.plannedSeconds != null ? ` · 运动计划 ${lastMove.plannedSeconds.toFixed(2)} s` : ""}` : `正在处理轴${status?.turntable?.axis}，已完成 ${recall.completedAxes.length}/2 轴`}。</p>}
    </section>
    {axes?.["1"]?.output_angle_deg != null && Math.abs(axes["1"].output_angle_deg) > 35 && <p className="field-notice warning" role="alert">轴1反馈角度超出 ±35°（设备坐标），请核查真实姿态、参考位及软限位；设置参考位会改变坐标。</p>}
    {status?.turntableWarning && <><p className="field-error" role="alert">{status.turntableWarning}</p><label className="field-turntable-toggle"><input type="checkbox" aria-label="确认现场停稳后恢复读取" disabled={locked} checked={recovery} onChange={event => setRecovery(event.target.checked)} />已在现场确认转盘停稳，允许读取反馈并核查恢复</label></>}
    {(error || status?.turntable?.port === port && status.turntable.error) && <p className="field-error" role="alert">{error || status?.turntable?.error}</p>}
    <p className="field-subtext">保存点位不会启动采集。勾选并排序后，在“数据采集”开启转盘联动并开始采集；历史点位继续核对串口、参考位与实际软限位。</p>
  </section>;
}
