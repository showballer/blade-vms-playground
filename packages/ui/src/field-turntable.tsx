"use client";
import React, { useEffect, useRef, useState } from "react";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { FieldCycleProgress } from "./field-cycle-progress";
import { fieldIsActive, fieldTurntableMatches, fieldTurntableReady, type FieldAxisFeedback, type FieldBladePoint, type FieldConfig, type FieldRequestOptions, type FieldStatus, type FieldTurntableConfig } from "./field-types";

export const turntableLabels: Record<string, string> = { disconnected: "未启用", checking: "检查转盘", checked: "已读取反馈", testing: "独立试转中", test_stopping: "试转结束，确认停稳", prepared: "设置完成，可开始采集", starting: "发送运动命令", awaiting_feedback: "等待速度反馈", running: "实际转动", positioning: "定位中", holding: "已到位，持续采集", stopping: "确认停稳", stopped: "已确认停止", unknown: "停止未确认", error: "转盘异常" };
const initial: FieldTurntableConfig = { port: "", axis: 1, speedRpm: 0.2, direction: "forward", durationSeconds: 0, protocol: "position" };
const axisDraftKey = "blade-turntable-axes-v1";
// Shared by the acquisition cycle and the standalone turntable page.
const sharedPointKey = "blade-turntable-points-v2";
const newPointId = () => globalThis.crypto?.randomUUID?.() || `point-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
function loadSharedPoints(): Record<string, any>[] {
  try {
    const current = JSON.parse(localStorage.getItem(sharedPointKey) || "null");
    if (Array.isArray(current)) return current;
    return ["blade-turntable-points-v1", "blade-turntable-manual-points-v1"].flatMap(key => {
      try {
        const value = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(value) ? value : [];
      } catch { return []; }
    });
  } catch { return []; }
}
function axisDrafts(): Partial<Record<1 | 2, FieldTurntableConfig>> {
  try {
    const saved = JSON.parse(localStorage.getItem(axisDraftKey) || "{}");
    return Object.fromEntries(([1, 2] as const).filter(axis => saved?.[axis]?.axis === axis && saved[axis].protocol === "position").map(axis => [axis, saved[axis]]));
  } catch { return {}; }
}
export function FieldTurntableSetup({ config, onConfig, status, disabled, request }: {
  config: FieldConfig; onConfig: React.Dispatch<React.SetStateAction<FieldConfig>>; status: FieldStatus | null; disabled: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>;
}) {
  const [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [recovery, setRecovery] = useState(false);
  const [consent, setConsent] = useState(false), [observed, setObserved] = useState(false), [testSeconds, setTestSeconds] = useState(3);
  const [calibrationMode, setCalibrationMode] = useState(false), [manualMotionConsent, setManualMotionConsent] = useState(false), [pointName, setPointName] = useState("P01");
  const [stepDeg, setStepDeg] = useState(0.5), [points, setPoints] = useState<FieldBladePoint[]>([]), [pointsLoaded, setPointsLoaded] = useState(false);
  const [bladeIndex, setBladeIndex] = useState(1), [bladePointIndex, setBladePointIndex] = useState<1 | 2 | 3>(1);
  const [circleStepDeg, setCircleStepDeg] = useState(60), [circleIndex, setCircleIndex] = useState(1);
  const [cycleCount, setCycleCount] = useState(1), [dwellSeconds, setDwellSeconds] = useState(2), [cycleConsent, setCycleConsent] = useState(false), [cycleMotionConsent, setCycleMotionConsent] = useState(false);
  const [cycleSpeedRpm, setCycleSpeedRpm] = useState(2);
  const [rssiTriggerEnabled, setRssiTriggerEnabled] = useState(false);
  const [rssiEnterSpread, setRssiEnterSpread] = useState(8), [rssiExitSpread, setRssiExitSpread] = useState(3);
  const [rssiEnterMs, setRssiEnterMs] = useState(20), [rssiConfirmMs, setRssiConfirmMs] = useState(30);
  const [keepLaserOn, setKeepLaserOn] = useState(true);
  const value = config.turntable || initial;
  const banks = useRef<Partial<Record<1 | 2, FieldTurntableConfig>>>(axisDrafts());
  const [referenceConfirmed, setReferenceConfirmed] = useState(false);
  const positionMode = value.protocol === "position";
  const axisLimit = value.axis === 1 ? 35 : 180;
  const axes = status?.turntable?.port === value.port ? status.turntable.feedback?.axes : undefined;
  const axisFeedback = axes?.[String(value.axis)];
  const locked = disabled || busy || fieldIsActive(status) || !!status?.turntableBusy;
  const valid = /^COM[1-9][0-9]{0,3}$/.test(value.port) && value.speedRpm >= 0.02 && value.speedRpm <= 100 && value.durationSeconds >= 0 && value.durationSeconds <= 86400 && (!positionMode || value.targetAngleDeg !== undefined && Number.isFinite(value.targetAngleDeg) && Math.abs(value.targetAngleDeg) <= axisLimit);
  const current = status?.turntable?.port === value.port && status.turntable.axis === value.axis;
  const feedback = current ? status?.turntable?.feedback : undefined;
  const feedbackAxes = feedback?.axes;
  const axisReady = !!axisFeedback && axisFeedback.output_angle_deg != null && axisFeedback.motor_rpm === 0 && axisFeedback.fault === 0 && (axisFeedback.flags & 16) === 0;
  const test = status?.turntableTest;
  const tested = !!test?.passed && fieldTurntableMatches(test.config, value, false);
  const prepared = fieldTurntableReady(status, value);
  const cyclePrepared = !!status?.turntablePreparation?.ready && !status.turntableWarning && axes?.["1"]?.output_angle_deg != null &&
    axes?.["2"]?.output_angle_deg != null && !!axes?.["1"]?.guard.soft_enabled && !!axes?.["2"]?.guard.soft_enabled;
  const cycle = status?.pointCycle;
  const cyclePoints = points.filter(point => Number.isFinite(point.axis1AngleDeg) && Number.isFinite(point.axis2AngleDeg)).map(point => ({
    ...(point.pointId ? { pointId: point.pointId } : {}), name: point.name, axis1AngleDeg: point.axis1AngleDeg as number, axis2AngleDeg: point.axis2AngleDeg as number,
    ...(point.referenceSignature ? { referenceSignature: point.referenceSignature } : {}),
  }));
  useEffect(() => {
    if (!config.turntable) return;
    banks.current[value.axis] = { ...value };
    try { localStorage.setItem(axisDraftKey, JSON.stringify(banks.current)); } catch { /* Optional drafts contain no reference validity. */ }
  }, [config.turntable, value]);
  useEffect(() => {
    try {
      const saved = loadSharedPoints();
      if (Array.isArray(saved)) setPoints(saved.filter(point => point && typeof point.name === "string" && (Number.isFinite(point.axis1AngleDeg) || Number.isFinite(point.axis2AngleDeg))).map((point, index) => ({
        pointId: typeof point.pointId === "string" && point.pointId ? point.pointId : newPointId(), name: point.name, bladeIndex: Number.isInteger(point.bladeIndex) && point.bladeIndex > 0 ? point.bladeIndex : 1,
        bladePointIndex: [1, 2, 3].includes(point.bladePointIndex) ? point.bladePointIndex : 1,
        circleIndex: Number.isInteger(point.circleIndex) && point.circleIndex > 0 ? point.circleIndex : index + 1,
        circleStepDeg: Number.isFinite(point.circleStepDeg) && point.circleStepDeg > 0 ? point.circleStepDeg : 60,
        recordedAt: point.recordedAt, axis1AngleDeg: point.axis1AngleDeg, axis2AngleDeg: point.axis2AngleDeg,
        axis1RawCounts: point.axis1RawCounts, axis2RawCounts: point.axis2RawCounts, referenceSignature: typeof point.referenceSignature === "string" ? point.referenceSignature : undefined,
      })));
    } catch { /* A corrupt optional point list can be cleared from the panel. */ }
    setPointsLoaded(true);
  }, []);
  useEffect(() => {
    if (pointsLoaded) {
      try { localStorage.setItem(sharedPointKey, JSON.stringify(points)); } catch { /* Local persistence is optional. */ }
    }
  }, [points, pointsLoaded]);
  useEffect(() => { setConsent(false); setObserved(false); setReferenceConfirmed(false); }, [value.port, value.axis, value.speedRpm, value.direction, value.protocol, value.targetAngleDeg, test?.testedAt]);
  useEffect(() => { setManualMotionConsent(false); }, [value.port, value.axis, value.protocol]);
  const stopLocked = disabled || busy || fieldIsActive(status) || !/^COM[1-9][0-9]{0,3}$/.test(value.port);
  const change = (next: Partial<FieldTurntableConfig>) => onConfig(previous => ({ ...previous, turntable: { ...(previous.turntable || value), ...next } }));
  const selectAxis = (axis: 1 | 2) => {
    if (locked || axis === value.axis) return;
    banks.current[value.axis] = { ...value };
    onConfig(previous => ({ ...previous, turntable: { ...initial, ...banks.current[axis], port: value.port, axis } }));
  };
  const run = async (options: FieldRequestOptions) => {
    setError(""); setBusy(true);
    try {
      const result = await request<{ ports?: { port: string; description: string }[] }>(options);
      if (result.ports) setPorts(result.ports);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "转盘操作失败"); }
    finally { setBusy(false); }
  };
  const setStepTarget = (axis: 1 | 2, direction: -1 | 1, increment = stepDeg) => {
    const axisState = feedbackAxes?.[String(axis)];
    const currentAngle = axisState?.output_angle_deg;
    if (currentAngle == null) { setError(`请先读取轴${axis}有效角度反馈`); return; }
    const limit = axis === 1 ? 35 : 180;
    const target = Math.max(-limit, Math.min(limit, Number((currentAngle + direction * increment).toFixed(3))));
    onConfig(previous => ({ ...previous, turntable: { ...(previous.turntable || value), axis, targetAngleDeg: target } }));
    setError("");
  };
  const recordPoint = async () => {
    setError("");
    if (!/^COM[1-9][0-9]{0,3}$/.test(value.port)) { setError("请先填写有效转盘串口"); return; }
    setBusy(true);
    try {
      const result = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port: value.port, axis: value.axis } });
      const observedAxes = result.turntable?.feedback?.axes || feedbackAxes;
      const one = observedAxes?.["1"], two = observedAxes?.["2"], selected = observedAxes?.[String(value.axis)];
      if (!selected || selected.output_angle_deg == null || selected.motor_rpm !== 0 || selected.fault || (selected.flags & 16)) {
        throw new Error(`轴${value.axis}没有有效角度反馈或未停稳，未记录点位`);
      }
      const referenceValues = [1, 2].map(axis => {
        const item = observedAxes?.[String(axis)];
        return item ? [item.origin_counts, item.display_mode, item.command_counts_per_rev, item.encoder_bits] : null;
      });
      const referenceSignature = referenceValues.every(value => value) ? JSON.stringify(referenceValues) : undefined;
      const point: FieldBladePoint = { pointId: newPointId(), name: pointName.trim() || `B${bladeIndex}-P${bladePointIndex}-${circleIndex}`, bladeIndex, bladePointIndex, circleIndex, circleStepDeg, recordedAt: Date.now(), axis1AngleDeg: one?.output_angle_deg ?? null, axis2AngleDeg: two?.output_angle_deg ?? null, axis1RawCounts: one?.actual_counts ?? null, axis2RawCounts: two?.actual_counts ?? null, ...(referenceSignature ? { referenceSignature } : {}) };
      setPoints(previous => [...previous, point]);
      setCircleIndex(previous => previous + 1);
      setPointName(`B${bladeIndex}-P${bladePointIndex}-${circleIndex + 1}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "记录点位失败"); }
    finally { setBusy(false); }
  };
  const exportPoints = (format: "csv" | "json") => {
    if (!points.length) { setError("当前没有可导出的点位"); return; }
    const payload = format === "json" ? JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), points }, null, 2) : ["点位,叶片编号,叶片点位,圆周序号,圆周步长(°),记录时间,轴1角度(°),轴2角度(°),轴1原始计数,轴2原始计数", ...points.map(point => [point.name, point.bladeIndex, point.bladePointIndex, point.circleIndex, point.circleStepDeg, new Date(point.recordedAt).toISOString(), point.axis1AngleDeg, point.axis2AngleDeg, point.axis1RawCounts, point.axis2RawCounts].join(","))].join("\n");
    const blob = new Blob([format === "csv" ? "\\uFEFF" + payload : payload], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `blade-points-${new Date().toISOString().slice(0, 10)}.${format}`; link.click(); URL.revokeObjectURL(url);
  };
  const startPointCycle = () => {
    if (!cyclePrepared || !cyclePoints.length || !cycleConsent || !cycleMotionConsent) {
      setError("请先完成转盘设置、确认全部点位角度有效，并勾选激光和自动运动确认"); return;
    }
    if (rssiTriggerEnabled && rssiExitSpread >= rssiEnterSpread) {
      setError("离开波动阈值必须小于进入波动阈值"); return;
    }
    void run({ action: "start", config: {
      ...config, confirmLaser: true, confirmMotion: true,
      pointCycle: { port: value.port, points: cyclePoints, cycles: cycleCount, dwellSeconds, speedRpm: cycleSpeedRpm,
        rssiTriggerEnabled, keepLaserOnBetweenPoints: keepLaserOn, ...(rssiTriggerEnabled ? {
          rssiEnterSpread, rssiExitSpread, rssiEnterConfirmMs: rssiEnterMs, rssiConfirmMs,
          rssiSmoothingMs: 10, rssiMinimumSeconds: 0 } : {}) },
    } });
  };
  return <section className="field-turntable-setup">
    <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={!!config.turntable} onChange={event => onConfig(previous => ({ ...previous, turntable: event.target.checked ? { ...initial, ...banks.current[1], axis: 1 } : undefined }))} />联动转盘与测振仪</label>
    {config.turntable && <>
      <p className="field-subtext">两轴分别设置：轴1俯仰±35°，轴2水平±180°。先建立参考位、读取反馈并应用软限位，再定位或联合采集。单独定位不打开激光。</p>
      <fieldset disabled={locked} className="field-config-grid">
        <label>转盘串口<input required aria-label="转盘串口" list="field-turntable-ports" placeholder="例如 COM6" value={value.port} onChange={event => change({ port: event.target.value.trim().toUpperCase() })} /><datalist id="field-turntable-ports">{ports.map(port => <option key={port.port} value={port.port}>{port.description}</option>)}</datalist></label>
        <div className="field-turntable-actions" role="group" aria-label="转盘控制轴">
          <Button type="button" aria-pressed={value.axis === 1} variant={value.axis === 1 ? "primary" : undefined} onClick={() => selectAxis(1)}>轴1 · 俯仰 ±35°</Button>
          <Button type="button" aria-pressed={value.axis === 2} variant={value.axis === 2 ? "primary" : undefined} onClick={() => selectAxis(2)}>轴2 · 水平 ±180°</Button>
        </div>
        <label>控制器接口<CustomSelect aria-label="转盘控制器接口" value={value.protocol || "legacy_speed"} onChange={event => change({ protocol: event.target.value as FieldTurntableConfig["protocol"] })}><option value="position">新版反馈定位（限角运动）</option>{!positionMode && <option value={value.protocol || "legacy_speed"}>历史连续速度配置（请切换定位）</option>}</CustomSelect></label>
        <label>输出轴转速（rpm）<input required aria-label="转盘输出轴转速" type="number" min={0.02} max={100} step={0.01} value={value.speedRpm} onChange={event => change({ speedRpm: Number(event.target.value) })} /></label>
        {positionMode ? <label>目标输出轴角度（°）<input aria-label="转盘目标角度" type="number" min={-axisLimit} max={axisLimit} step={0.001} value={value.targetAngleDeg ?? ""} placeholder={`−${axisLimit} ～ +${axisLimit}`} onChange={event => change({ targetAngleDeg: event.target.value === "" ? undefined : Number(event.target.value) })} /></label> : <label>方向<CustomSelect aria-label="转盘方向" value={value.direction} onChange={event => change({ direction: event.target.value as FieldTurntableConfig["direction"] })}><option value="forward">正向</option><option value="reverse">反向</option></CustomSelect></label>}
        <label>自动停止（秒，0 为人工停止）<input required aria-label="转盘自动停止时长" type="number" min={0} max={86400} step={1} value={value.durationSeconds} onChange={event => change({ durationSeconds: Number(event.target.value) })} /></label>
      </fieldset>
      <div className="field-turntable-actions">
        <Button type="button" disabled={locked} onClick={() => void run({ action: "turntablePorts" })}>刷新串口</Button>
        <Button type="button" disabled={locked || !/^COM[1-9][0-9]{0,3}$/.test(value.port) || !!status?.turntableWarning && !recovery} onClick={() => void run({ action: "turntable", request: { action: "probe", port: value.port, axis: value.axis, confirmRecovery: recovery } })}>1. 读取转盘工况</Button>
        <Button type="button" variant="danger" disabled={stopLocked} onClick={() => void run({ action: "turntable", request: { action: "stop", port: value.port, axis: value.axis, confirmMotion: true } })}>停止试转 / 核查停稳</Button>
      </div>
      {positionMode && <div className="field-turntable-test">
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={referenceConfirmed} onChange={event => setReferenceConfirmed(event.target.checked)} />{value.axis === 1 ? "已将轴1放在 +25° 传感器参考姿态（水平为0°）" : "已确认轴2当前位置作为0°参考"}</label>
        <div className="field-turntable-actions">
          <Button type="button" disabled={locked || !referenceConfirmed || !axisFeedback || !!status?.turntableWarning} onClick={() => void run({ action: "turntable", request: { action: "reference", port: value.port, axis: value.axis, confirmMotion: true } })}>设当前轴参考位</Button>
          <Button type="button" disabled={locked || !axisFeedback || !!status?.turntableWarning} onClick={() => void run({ action: "turntable", request: { action: "limits", port: value.port, axis: value.axis, confirmMotion: true } })}>应用当前轴 ±{axisLimit}° 软限位</Button>
        </div>
        <p className="field-subtext">设置参考位会改变本轴坐标。轴1参考姿态为+25°，轴2为0°；断电后须重新读取并核查。应用软限位只更新当前轴角度范围，保留硬件输入配置。</p>
      </div>}
      <div className="field-turntable-check" aria-live="polite">
        <div className="field-section-heading"><h3>采集前转盘检查</h3><span className={`field-badge ${prepared ? "green" : tested ? "amber" : ""}`}>{prepared ? "设置已确认" : status?.turntableBusy ? "检查 / 试转中" : tested ? (positionMode ? "已到位，待确认" : "试转通过，待确认") : "待检查"}</span></div>
        <dl className="field-details">
          <div><dt>最近读取</dt><dd>{feedback?.observedAt ? new Date(feedback.observedAt * 1000).toLocaleTimeString("zh-CN") : "未读取当前轴"}{current && status?.turntable ? ` · ${turntableLabels[status.turntable.state] || status.turntable.state}` : ""}</dd></div>
          <div><dt>实际输出轴转速</dt><dd>{feedback?.outputRpm ?? "—"} rpm（设定 {value.speedRpm} rpm / {value.speedRpm * 6}°/秒）</dd></div>
          <div><dt>驱动器报警 / 运行状态码</dt><dd>{feedback ? `${feedback.alarmCode === 0 ? "无报警" : `报警 ${feedback.alarmCode}`} / ${feedback.runState ?? "—"}` : "未读取"}</dd></div>
          <div><dt>限位反馈</dt><dd>{!feedback ? "未读取" : feedback.limitFlags == null ? "速度接口未提供，详见新版反馈" : feedback.limitFlags === 0 ? "未触发" : `异常 (${feedback.limitFlags})`}</dd></div>
          <div><dt>当前轴角度 / 参考位</dt><dd>{axisFeedback?.output_angle_deg == null ? "未建立或已失效" : `${axisFeedback.output_angle_deg.toFixed(3)}°（参考姿态 ${axisFeedback.referenceAngleDeg}°）`}</dd></div>
          <div><dt>当前轴软限位</dt><dd>{axisFeedback ? `${axisFeedback.guard.soft_enabled ? "开启" : "关闭"} · ${axisFeedback.guard.minimum_deg}° ～ ${axisFeedback.guard.maximum_deg}°` : "未读取"}</dd></div>
          <div><dt>两轴最近角度</dt><dd>{([1, 2] as const).map(axis => <span key={axis}>轴{axis}：{axes?.[String(axis)]?.output_angle_deg == null ? "无有效参考" : `${axes[String(axis)].output_angle_deg}°`}　</span>)}</dd></div>
          <div><dt>原始位置 / 试转变化量</dt><dd>{feedback?.positionRaw ?? "—"} / {current && status?.turntableBusy ? status.turntable?.positionDelta ?? "—" : tested ? test?.positionDelta : "—"}</dd></div>
        </dl>
        {current && status?.turntable?.error && <p className="field-error" role="alert">{status.turntable.error}</p>}
        {test && fieldTurntableMatches(test.config, value, false) && <p className={tested ? "field-success" : "field-notice warning"}>{tested ? (positionMode ? "目标角度与连续零速反馈已验证。" : "目标转速、位置变化和停止反馈均已验证。请再确认现场转盘实际转动。") : test.cancelled ? "试转已取消，请重新试转完成检查。" : test.error || "试转未通过。"}</p>}
      </div>
      {positionMode ? <div className="field-turntable-test">
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={consent} onChange={event => setConsent(event.target.checked)} />允许当前轴移动到所填目标角度，另一轴保持不动</label>
        <Button type="button" disabled={locked || !valid || !consent || axisFeedback?.output_angle_deg == null || !axisFeedback?.guard.soft_enabled || !!status?.turntableWarning} onClick={() => void run({ action: "turntable", request: { ...value, action: "test", confirmMotion: true } })}>单独定位到目标角度</Button>
        <Button type="button" variant="primary" disabled={locked || !valid || !consent || axisFeedback?.output_angle_deg == null || !axisFeedback?.guard.soft_enabled || !!status?.turntableWarning} onClick={() => void run({ action: "turntable", request: { ...value, action: "prepare", confirmMotion: true } })}>确认定位设置，允许联合采集</Button>
        <p className="field-subtext">联合任务先启动测振仪采集，再移动当前轴；到位后持续采集至人工停止或时长结束。到位需误差≤0.1°且连续两次零速；运动中不能切换轴。距离、固定步长及两轴几何换算待提供后配置。</p>
      </div> : <div className="field-turntable-test">
        <label>达到目标速度后试转时长<CustomSelect aria-label="独立试转时长" disabled={locked} value={testSeconds} onChange={event => setTestSeconds(Number(event.target.value))}><option value={3}>3 秒</option><option value={5}>5 秒</option><option value={10}>10 秒</option></CustomSelect></label>
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={consent} onChange={event => setConsent(event.target.checked)} />允许当前轴按设定方向和转速独立试转</label>
        <Button type="button" disabled={locked || !valid || !consent || !!status?.turntableWarning || !feedback || feedback.motorRpm !== 0 || !!feedback.alarmCode || feedback.limitFlags != null && feedback.limitFlags !== 0} onClick={() => { setObserved(false); void run({ action: "turntable", request: { ...value, action: "test", testSeconds, confirmMotion: true } }); }}>2. 开始短时试转（自动停止）</Button>
        <p className="field-subtext">0.2 rpm 仅为 1.2°/秒；3 秒约 3.6°，不会转完一圈。启动等待最多 10 秒，之后按选定时长试转；可随时点击停止。请选择与已安装固件一致的接口，不会自动切换接口重发运动。请退出占用串口的控制器软件。</p>
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked || !tested} checked={observed} onChange={event => setObserved(event.target.checked)} />已观察到转盘实际转动、方向正确且停稳，采集参数已设置完成</label>
        <Button type="button" variant="primary" disabled={locked || !valid || !tested || !observed || !!status?.turntableWarning} onClick={() => void run({ action: "turntable", request: { ...value, action: "prepare", confirmMotion: true } })}>3. 确认设置，允许联合采集</Button>
        {!prepared && <p className="field-subtext">联合采集暂未放行。更改串口、轴、接口、转速或方向需重新试转；只更改采集时长需重新确认设置。</p>}
      </div>
      }
      {positionMode && <section className="field-turntable-test" aria-label="叶片点位标定">
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={calibrationMode} onChange={event => setCalibrationMode(event.target.checked)} />叶片点位标定模式</label>
        {calibrationMode && <>
          <p className="field-subtext">每片叶片按 3 个叶片点位编号记录。对选定点位可按圆周步长重复采样；60°按不重复起点的约定记录 5 个位置，闭合端点需要另行增加。每次定位完成并停稳后点击“记录当前点”。</p>
          <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={manualMotionConsent} onChange={event => setManualMotionConsent(event.target.checked)} />允许当前选中轴正向/反向微调和定位，另一轴不运动</label>
          <div className="field-config-grid">
            <label>点位名称<input aria-label="点位名称" value={pointName} maxLength={40} onChange={event => setPointName(event.target.value)} /></label>
            <label>步长（°）<input aria-label="点位步长" type="number" min={0.001} max={35} step={0.001} value={stepDeg} onChange={event => setStepDeg(Math.max(0.001, Number(event.target.value) || 0.001))} /></label>
            <label>叶片编号<input aria-label="叶片编号" type="number" min={1} max={128} step={1} value={bladeIndex} onChange={event => setBladeIndex(Math.max(1, Math.min(128, Math.trunc(Number(event.target.value) || 1))))} /></label>
            <label>叶片点位<CustomSelect aria-label="叶片点位" value={bladePointIndex} onChange={event => setBladePointIndex(Number(event.target.value) as 1 | 2 | 3)}><option value={1}>点位 1</option><option value={2}>点位 2</option><option value={3}>点位 3</option></CustomSelect></label>
            <label>圆周间隔（°）<input aria-label="圆周间隔" type="number" min={0.001} max={360} step={0.001} value={circleStepDeg} onChange={event => setCircleStepDeg(Math.max(0.001, Math.min(360, Number(event.target.value) || 0.001)))} /></label>
            <label>圆周序号<input aria-label="圆周序号" type="number" min={1} max={10000} step={1} value={circleIndex} onChange={event => setCircleIndex(Math.max(1, Math.min(10000, Math.trunc(Number(event.target.value) || 1))))} /></label>
          </div>
          <p className="field-subtext">当前圆周序号：{circleIndex}；按 {circleStepDeg}° 间隔时建议记录 {Math.max(1, Math.ceil(360 / circleStepDeg) - 1)} 个不重复位置。圆周推进使用轴2目标角度，仍受 ±180°软限位约束。</p>
          <div className="field-turntable-actions" role="group" aria-label="点位步进目标">
            <Button type="button" disabled={locked || !axisReady} onClick={() => setStepTarget(1, -1)}>轴1 −步长</Button>
            <Button type="button" disabled={locked || !axisReady} onClick={() => setStepTarget(1, 1)}>轴1 +步长</Button>
            <Button type="button" disabled={locked || !axisReady} onClick={() => setStepTarget(2, -1, circleStepDeg)}>轴2 −圆周间隔</Button>
            <Button type="button" disabled={locked || !axisReady} onClick={() => setStepTarget(2, 1, circleStepDeg)}>轴2 +圆周间隔</Button>
          </div>
          <div className="field-turntable-actions">
            <Button type="button" disabled={locked || !axisReady || !manualMotionConsent || !valid || axisFeedback?.output_angle_deg == null || !axisFeedback?.guard.soft_enabled} onClick={() => void run({ action: "turntable", request: { ...value, action: "test", confirmMotion: true } })}>定位到当前目标</Button>
            <Button type="button" variant="primary" disabled={locked || busy || !axisReady || !pointName.trim()} onClick={() => void recordPoint()}>读取并记录当前点</Button>
            <Button type="button" disabled={locked || !points.length} onClick={() => setPoints(previous => previous.slice(0, -1))}>删除上一点</Button>
            <Button type="button" disabled={locked || !points.length} onClick={() => setPoints([])}>清空点位</Button>
            <Button type="button" disabled={locked || !points.length} onClick={() => exportPoints("csv")}>导出 CSV</Button>
            <Button type="button" disabled={locked || !points.length} onClick={() => exportPoints("json")}>导出 JSON</Button>
          </div>
          {!axisReady && <p className="field-notice warning">请先读取当前选中轴的有效角度，并确认该轴零速、无故障。</p>}
          <div className="field-table-scroll" role="region" aria-label="已记录叶片点位" tabIndex={0}><table className="field-table"><thead><tr><th>叶片 / 点位</th><th>圆周序号</th><th>轴1俯仰</th><th>轴2水平</th><th>原始计数</th><th>记录时间</th></tr></thead><tbody>{points.map((point, index) => <tr key={`${point.recordedAt}-${index}`}><td>{point.name}<small>叶片 {point.bladeIndex} · 点位 {point.bladePointIndex}</small></td><td>{point.circleIndex} / {point.circleStepDeg}°</td><td>{point.axis1AngleDeg == null ? "—" : `${point.axis1AngleDeg.toFixed(3)}°`}</td><td>{point.axis2AngleDeg == null ? "—" : `${point.axis2AngleDeg.toFixed(3)}°`}</td><td className="mono">{point.axis1RawCounts ?? "—"} / {point.axis2RawCounts ?? "—"}</td><td>{new Date(point.recordedAt).toLocaleTimeString("zh-CN", { hour12: false })}</td></tr>)}</tbody></table></div>
        </>}
      </section>}
      {positionMode && <section className="field-turntable-test" aria-label="自动多点循环采集">
        <div className="field-section-heading"><div><h3>自动多点循环采集</h3><p>使用转盘点位库；每圈以首个点位为起点，按两轴最短安全移动距离规划顺序，采集完成后回到首点，每个点独立保存一条测振记录。</p></div><span className={`field-badge ${cycle?.state === "complete" ? "green" : cycle ? "amber" : ""}`}>{cycle ? `${cycle.completedRecords}/${cycle.totalRecords} 条` : "待开始"}</span></div>
        <div className="field-config-grid"><label>循环圈数<input aria-label="自动循环圈数" type="number" min={1} max={100} step={1} disabled={locked} value={cycleCount} onChange={event => setCycleCount(Math.max(1, Math.min(100, Math.trunc(Number(event.target.value) || 1))))} /></label><label>{rssiTriggerEnabled ? "每点最长等候（秒）" : "每点采集（秒）"}<input aria-label="每点采集秒数" type="number" min={1} max={3600} step={1} disabled={locked} value={dwellSeconds} onChange={event => setDwellSeconds(Math.max(1, Math.min(3600, Number(event.target.value) || 1)))} /></label><label>换点速度（rpm）<CustomSelect aria-label="自动循环换点速度" disabled={locked} value={cycleSpeedRpm} onChange={event => { const speed = Number(event.target.value); if ([0.5, 1, 2, 5, 10].includes(speed)) setCycleSpeedRpm(speed); }}><option value={0.5}>0.5 rpm</option><option value={1}>1 rpm</option><option value={2}>2 rpm</option><option value={5}>5 rpm</option><option value={10}>10 rpm</option></CustomSelect></label></div>
        <p className="field-subtext">有效点位 {cyclePoints.length} 个，预计保存 {cyclePoints.length * cycleCount} 条独立记录。两轴并行运动，{rssiTriggerEnabled ? `到位后等待叶片进入并离开，最长 ${dwellSeconds} 秒；超时停止，不强制换点` : `到位后采集 ${dwellSeconds} 秒`}；每圈结束回到首个点位。轴2按 ±180° 有效范围直达，不跨边界绕行。</p>
        <div className="field-config-grid">
          <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={rssiTriggerEnabled} onChange={event => { setRssiTriggerEnabled(event.target.checked); if (event.target.checked) setDwellSeconds(previous => Math.max(60, previous)); }} />确认叶片离开后换点</label>
          <label>进入波动阈值（百分点）<input aria-label="RSSI 进入波动阈值" type="number" min={0.1} max={100} step={0.5} disabled={locked || !rssiTriggerEnabled} value={rssiEnterSpread} onChange={event => setRssiEnterSpread(Math.max(0.1, Math.min(100, Number(event.target.value) || 8)))} /></label>
          <label>离开波动阈值（百分点）<input aria-label="RSSI 离开波动阈值" type="number" min={0} max={99.9} step={0.5} disabled={locked || !rssiTriggerEnabled} value={rssiExitSpread} onChange={event => setRssiExitSpread(Math.max(0, Math.min(99.9, Number(event.target.value) || 0)))} /></label>
          <label>进入确认（毫秒）<input aria-label="RSSI 进入确认毫秒" type="number" min={10} max={1000} step={10} disabled={locked || !rssiTriggerEnabled} value={rssiEnterMs} onChange={event => setRssiEnterMs(Math.max(10, Math.min(1000, Number(event.target.value) || 20)))} /></label>
          <label>离开确认（毫秒）<input aria-label="RSSI 离开确认毫秒" type="number" min={10} max={1000} step={10} disabled={locked || !rssiTriggerEnabled} value={rssiConfirmMs} onChange={event => setRssiConfirmMs(Math.max(10, Math.min(1000, Number(event.target.value) || 30)))} /></label>
          <label className="field-turntable-toggle"><input type="checkbox" disabled={locked || !rssiTriggerEnabled} checked={keepLaserOn} onChange={event => setKeepLaserOn(event.target.checked)} />点位之间保持激光开启</label>
        </div>
        <p className="field-subtext">按每 10 ms 回波窗的 P90－P10 判定波动：默认达到 8 个百分点持续 20 ms 确认进入；进入后降到 3 个百分点以内持续 30 ms，确认离开后才移动。</p>
        <p className="field-subtext">手动拨动测试：到位开始采集后再拨动叶片通过光斑，等待系统确认离开并自动换点。起始柱子或背景的稳定回波不会直接触发。点间激光默认保持开启，全部完成、停止或异常时关闭。</p>
        <FieldCycleProgress status={status} />
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={cycleConsent} onChange={event => setCycleConsent(event.target.checked)} />已确认测振仪、激光和现场光路安全，允许逐点开启测振采集</label>
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={cycleMotionConsent} onChange={event => setCycleMotionConsent(event.target.checked)} />允许转盘按已标定点位自动移动，轴1限 ±35°、轴2限 ±180°</label>
        <Button type="button" variant="primary" disabled={locked || !cyclePrepared || !cyclePoints.length || cyclePoints.length * cycleCount > 2000 || !cycleConsent || !cycleMotionConsent} onClick={startPointCycle}>开始自动循环采集</Button>
        {cycle && <p className={cycle.state === "error" ? "field-error" : cycle.state === "complete" ? "field-success" : "field-notice"} role="status">{cycle.state === "complete" ? `循环完成，共保存 ${cycle.completedRecords} 条记录。` : cycle.state === "cancelled" ? `循环已停止，已保存 ${cycle.completedRecords} 条完整记录。` : cycle.state === "error" ? `循环已停止：${cycle.error || "请检查转盘和测振仪状态"}` : `第 ${cycle.cycle}/${cycle.cycles} 圈 · 点位 ${cycle.point}/${cycle.pointCount} · ${cycle.currentPoint || "准备中"} · 已保存 ${cycle.completedRecords}/${cycle.totalRecords} 条`}</p>}
        {cycle?.plannedOrder?.length ? <p className="field-subtext">本次规划顺序：{cycle.plannedOrder.join(" → ")}</p> : null}
      </section>}
      {status?.turntableWarning && <><p className="field-error">{status.turntableWarning}</p><label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={recovery} onChange={event => setRecovery(event.target.checked)} />已在现场确认转盘停稳，允许读取同一轴并恢复联合任务</label></>}
      <p className="field-subtext">输出轴50:1。停止并保存将结束运动和采集；两轴反馈与波形保存在同一条本机记录。反馈使用主机查询时间，回波换点依据先进入、后离开的波动状态；尚不具备同一叶片的相位识别。</p>
      {error && <p className="field-error" role="alert">{error}</p>}
    </>}
  </section>;
}

export function FieldTurntableFeedback({ status }: { status: FieldStatus | null }) {
  const value = status?.turntable, feedback = value?.feedback;
  if (!value || value.state === "disconnected") return null;
  return <section className="field-card"><h2>转盘状态</h2><p>{turntableLabels[value.state] || value.state}{value.port ? ` · ${value.port}` : ""}{value.axis ? ` · 轴 ${value.axis}` : ""}</p><dl className="field-details">
    <div><dt>实际输出轴转速</dt><dd>{feedback?.outputRpm ?? "—"} rpm</dd></div>
    <div><dt>限位反馈</dt><dd>{feedback?.limitFlags == null ? "速度接口未提供，详见新版反馈" : feedback.limitFlags === 0 ? "未触发" : `保护异常 (${feedback.limitFlags})`}</dd></div>
    <div><dt>驱动器报警</dt><dd>{feedback?.alarmCode ?? "—"}</dd></div>
    <div><dt>原始位置计数</dt><dd>{feedback?.positionRaw ?? "—"}</dd></div>
    {([1, 2] as const).map(axis => <div key={axis}><dt>轴{axis}{axis === 1 ? "俯仰" : "水平"}角度</dt><dd>{feedback?.axes?.[String(axis)]?.output_angle_deg == null ? "参考位无效 / 未读取" : `${feedback.axes[String(axis)].output_angle_deg}°`}</dd></div>)}
  </dl><p className="field-subtext">角度来自新版下位机参考坐标；状态为最近一次读取，按主机时间关联波形。</p>{value.error && <p className="field-error">{value.error}</p>}</section>;
}

type ManualPoint = { pointId?: string; name: string; recordedAt: number; axis1AngleDeg: number | null; axis2AngleDeg: number | null; axis1RawCounts: number | null; axis2RawCounts: number | null; port?: string; references?: string };

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

function manualPointReferences(axes: Record<string, FieldAxisFeedback> | undefined): string {
  return JSON.stringify([1, 2].map(axis => {
    const value = axes?.[String(axis)];
    return value ? [value.origin_counts, value.display_mode, value.command_counts_per_rev, value.encoder_bits] : null;
  }));
}

export function manualPointRecallError(point: Pick<ManualPoint, "axis1AngleDeg" | "axis2AngleDeg" | "port" | "references">, axes: Record<string, FieldAxisFeedback> | undefined, port: string): string {
  for (const axis of [1, 2] as const) {
    const angle = axis === 1 ? point.axis1AngleDeg : point.axis2AngleDeg;
    const limit = axis === 1 ? 35 : 180;
    if (angle == null || !Number.isFinite(angle)) return `记录缺少轴${axis}有效角度`;
    if (Math.abs(angle) > limit) return `记录轴${axis}角度超出 ±${limit}°`;
    const guard = axes?.[String(axis)]?.guard;
    if (guard?.soft_enabled && (angle < guard.minimum_deg || angle > guard.maximum_deg)) return `记录轴${axis}角度超出当前软限位`;
  }
  if (point.port && point.port !== port) return "记录串口与当前串口不同";
  if (point.references && axes && point.references !== manualPointReferences(axes)) return "记录后参考位或反馈单位已变化，请重新标定此点";
  return "";
}

export function FieldTurntableManual({ status, disabled, request }: { status: FieldStatus | null; disabled: boolean; request: <T>(options: FieldRequestOptions) => Promise<T> }) {
  const [port, setPort] = useState(status?.turntable?.port || ""), [axis, setAxis] = useState<1 | 2>(1), [target, setTarget] = useState<number | undefined>(), [step, setStep] = useState(0.1);
  const [axis1RecordAngle, setAxis1RecordAngle] = useState(""), [axis2RecordAngle, setAxis2RecordAngle] = useState("");
  const [pointName, setPointName] = useState("M01"), [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [recallSpeedRpm, setRecallSpeedRpm] = useState(0.2);
  const [points, setPoints] = useState<ManualPoint[]>([]), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [motionConsent, setMotionConsent] = useState(false), [error, setError] = useState("");
  const feedback = status?.turntable?.port === port ? status.turntable.feedback : undefined;
  const axes = feedback?.axes;
  const axisFeedback = axes?.[String(axis)];
  const recordReady = manualAngleRecordReady(axisFeedback) ||
    (axis1RecordAngle.trim() !== "" && axis2RecordAngle.trim() !== "" &&
      manualAngleInRange(Number(axis1RecordAngle), 1) && manualAngleInRange(Number(axis2RecordAngle), 2));
  const axisReady = recordReady && axisFeedback?.fault === 0;
  const recall = status?.turntable?.port === port ? status.turntable.recall : undefined;
  const recalling = !!recall && !!status?.turntableBusy;
  const stopAxis = recalling ? (status?.turntable?.axis === 2 ? 2 : 1) : axis;
  const locked = disabled || busy || !!status?.turntableBusy || fieldIsActive(status);
  const stopLocked = disabled || busy || fieldIsActive(status) || !/^COM[1-9][0-9]{0,3}$/.test(port) ||
    !!status?.turntableBusy && (status.turntable?.port !== port || !recalling && status.turntable?.axis !== axis);
  const recallBlocked = status?.turntableWarning || ([1, 2] as const).map(item => {
    const value = axes?.[String(item)], limit = item === 1 ? 35 : 180;
    if (!manualAngleRecordReady(value)) return `请读取轴${item}有效角度并确认停稳`;
    if (value!.fault) return `轴${item}故障码 ${value!.fault}，请先排除故障`;
    if (!value!.guard.soft_enabled || value!.guard.minimum_deg < -limit || value!.guard.maximum_deg > limit) return `请应用轴${item} ±${limit}°软限位`;
    if (value!.output_angle_deg! < value!.guard.minimum_deg || value!.output_angle_deg! > value!.guard.maximum_deg) return `轴${item}当前位置超出软限位，请核查姿态和参考位`;
    return "";
  }).filter(Boolean).join("；");
  useEffect(() => {
    const saved = loadSharedPoints();
    setPoints(saved.filter(point => point && typeof point.name === "string").map(point => ({ ...point, pointId: typeof point.pointId === "string" && point.pointId ? point.pointId : newPointId() })) as ManualPoint[]);
    setLoaded(true);
  }, []);
  useEffect(() => { if (loaded) try { localStorage.setItem(sharedPointKey, JSON.stringify(points)); } catch { /* Optional local history. */ } }, [loaded, points]);
  useEffect(() => { setMotionConsent(false); }, [port, axis]);
  const call = async <T,>(options: FieldRequestOptions) => {
    setError(""); setBusy(true);
    try { return await request<T>(options); } catch (failure) { setError(failure instanceof Error ? failure.message : "转盘操作失败"); return undefined; } finally { setBusy(false); }
  };
  const read = async () => {
    const result = await call<FieldStatus>({ action: "turntable", request: { action: "probe", port, axis } });
    const observed = result?.turntable?.feedback?.axes;
    if (observed) {
      setAxis1RecordAngle(manualAngleText(observed["1"]?.output_angle_deg));
      setAxis2RecordAngle(manualAngleText(observed["2"]?.output_angle_deg));
    }
  };
  const adjust = (nextAxis: 1 | 2, direction: -1 | 1) => {
    const current = axes?.[String(nextAxis)]?.output_angle_deg;
    if (current == null) { setError(`请先读取轴${nextAxis}当前角度`); return; }
    const limit = nextAxis === 1 ? 35 : 180;
    setAxis(nextAxis); setTarget(Math.max(-limit, Math.min(limit, Number((current + direction * step).toFixed(3)))));
  };
  const move = () => {
    if (!port || target == null || !axisReady || !motionConsent) { setError("请先读取当前轴，确认停稳，并勾选手动运动确认"); return; }
    void call<FieldStatus>({ action: "turntable", request: { action: "manual_move", port, axis, speedRpm: 0.2, direction: "forward", durationSeconds: 0, protocol: "position", targetAngleDeg: target, confirmMotion: true } });
  };
  const stop = () => void call<FieldStatus>({ action: "turntable", request: { action: "stop", port, axis: stopAxis, confirmMotion: true } });
  const recallPoint = (point: ManualPoint) => {
    const reason = manualPointRecallError(point, axes, port) || recallBlocked;
    if (reason) { setError(reason); return; }
    void call<FieldStatus>({ action: "turntable", request: { action: "recall", port, axis: 1, axis1AngleDeg: point.axis1AngleDeg!, axis2AngleDeg: point.axis2AngleDeg!, referenceSignature: point.references, speedRpm: recallSpeedRpm, confirmMotion: true } });
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
      observed = result.turntable?.feedback?.axes;
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
    const references = one && two ? manualPointReferences(observed) : undefined;
    setAxis1RecordAngle(oneAngle.toFixed(3));
    setAxis2RecordAngle(twoAngle.toFixed(3));
    setPoints(previous => [...previous, { pointId: newPointId(), name: pointName.trim() || `M${String(previous.length + 1).padStart(2, "0")}`, recordedAt: Date.now(), axis1AngleDeg: oneAngle, axis2AngleDeg: twoAngle, axis1RawCounts: one?.actual_counts ?? null, axis2RawCounts: two?.actual_counts ?? null, port, ...(references ? { references } : {}) }]);
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
  return <section className="field-card field-turntable-setup"><div className="field-section-heading"><div><h2>转盘手动点位控制</h2><p>独立于测振仪和联合采集；手动定位控制所选轴，记录点位回位控制两轴。</p></div><span className={`field-badge ${axisReady ? "green" : recordReady ? "amber" : ""}`}>{status?.turntableBusy ? "运动中" : axisReady ? "当前轴可操作" : recordReady ? "可记录 · 运动受限" : "待读取有效静止反馈"}</span></div>
    <div className="field-config-grid"><label>转盘串口<input disabled={locked} aria-label="手动控制转盘串口" list="manual-turntable-ports" placeholder="例如 COM6" value={port} onChange={event => setPort(event.target.value.trim().toUpperCase())} /><datalist id="manual-turntable-ports">{ports.map(item => <option key={item.port} value={item.port}>{item.description}</option>)}</datalist></label><label>微调步长（°）<input aria-label="手动控制微调步长" type="number" min={0.001} max={35} step={0.001} value={step} onChange={event => setStep(Math.max(0.001, Number(event.target.value) || 0.001))} /></label><label>目标角度（°）<input aria-label="手动控制目标角度" type="number" min={axis === 1 ? -35 : -180} max={axis === 1 ? 35 : 180} step={0.001} value={target ?? ""} onChange={event => setTarget(event.target.value === "" ? undefined : Number(event.target.value))} /></label><label>记录名称<input aria-label="手动点位记录名称" value={pointName} maxLength={40} onChange={event => setPointName(event.target.value)} /></label><label>记录轴1角度（°）<input disabled={locked} aria-label="记录轴1角度" type="number" min={-35} max={35} step={0.001} placeholder="读取反馈后可修改" value={axis1RecordAngle} onChange={event => setAxis1RecordAngle(event.target.value)} /></label><label>记录轴2角度（°）<input disabled={locked} aria-label="记录轴2角度" type="number" min={-180} max={180} step={0.001} placeholder="读取反馈后可修改" value={axis2RecordAngle} onChange={event => setAxis2RecordAngle(event.target.value)} /></label></div>
    <div className="field-turntable-actions"><Button type="button" disabled={locked} onClick={() => void call<{ ports?: { port: string; description: string }[] }>({ action: "turntablePorts" }).then(result => { if (result?.ports) setPorts(result.ports); })}>刷新串口</Button><Button type="button" disabled={locked || !/^COM[1-9][0-9]{0,3}$/.test(port)} onClick={read}>读取反馈</Button><Button type="button" variant="danger" disabled={stopLocked} onClick={stop}>停止当前轴</Button><Button type="button" disabled={locked || !/^COM[1-9][0-9]{0,3}$/.test(port) || !axisFeedback} onClick={() => void call<FieldStatus>({ action: "turntable", request: { action: "reference", port, axis, confirmMotion: true } })}>设当前轴为初始位</Button><Button type="button" disabled={locked || !/^COM[1-9][0-9]{0,3}$/.test(port) || !axisFeedback} onClick={() => void call<FieldStatus>({ action: "turntable", request: { action: "limits", port, axis, confirmMotion: true } })}>应用当前轴 ±{axis === 1 ? 35 : 180}°软限位</Button></div>
    <div className="field-turntable-actions" role="group" aria-label="独立单轴微调"><Button type="button" disabled={locked} aria-pressed={axis === 1} variant={axis === 1 ? "primary" : undefined} onClick={() => setAxis(1)}>轴1 · 俯仰</Button><Button type="button" disabled={locked} aria-pressed={axis === 2} variant={axis === 2 ? "primary" : undefined} onClick={() => setAxis(2)}>轴2 · 水平</Button><Button type="button" disabled={locked || !axisReady} onClick={() => adjust(axis, -1)}>当前轴 −步长</Button><Button type="button" disabled={locked || !axisReady} onClick={() => adjust(axis, 1)}>当前轴 +步长</Button></div>
    <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={motionConsent} onChange={event => setMotionConsent(event.target.checked)} />允许当前选中轴移动到目标角度，另一轴保持不动</label>
    <div className="field-turntable-actions"><Button type="button" variant="primary" disabled={locked || !axisReady || target == null || !motionConsent} onClick={move}>移动到目标点</Button><Button type="button" disabled={locked || !/^COM[1-9][0-9]{0,3}$/.test(port)} onClick={() => void record()}>读取并记录两轴角度</Button><Button type="button" disabled={locked || !points.length} onClick={() => setPoints(previous => previous.slice(0, -1))}>删除上一点</Button><Button type="button" disabled={locked || !points.length} onClick={() => setPoints([])}>清空记录</Button><Button type="button" disabled={locked || !points.length} onClick={() => exportPoints("csv")}>导出 CSV</Button><Button type="button" disabled={locked || !points.length} onClick={() => exportPoints("json")}>导出 JSON</Button></div>
    <dl className="field-details"><div><dt>当前轴角度</dt><dd>{axisFeedback?.output_angle_deg == null ? "—" : `${axisFeedback.output_angle_deg.toFixed(3)}°`}</dd></div><div><dt>两轴角度</dt><dd>轴1：{axes?.["1"]?.output_angle_deg == null ? "—" : `${axes["1"].output_angle_deg.toFixed(3)}°`}　轴2：{axes?.["2"]?.output_angle_deg == null ? "—" : `${axes["2"].output_angle_deg.toFixed(3)}°`}</dd></div><div><dt>原始计数</dt><dd>轴1：{axes?.["1"]?.actual_counts ?? "—"}　轴2：{axes?.["2"]?.actual_counts ?? "—"}</dd></div></dl>
    <div className="field-config-grid"><label>点位回位速度<CustomSelect aria-label="点位回位速度" disabled={locked} value={recallSpeedRpm} onChange={event => { const speed = Number(event.target.value); if ([0.2, 0.5, 1, 2].includes(speed)) setRecallSpeedRpm(speed); }}><option value={0.2}>0.2 rpm · 1.2°/秒</option><option value={0.5}>0.5 rpm · 3°/秒</option><option value={1}>1 rpm · 6°/秒</option><option value={2}>2 rpm · 12°/秒</option></CustomSelect></label></div>
    <p className="field-subtext">此速度用于记录表的“移动到此点”。建议先以 0.5 rpm 验证平稳后再提高；上方手动单轴定位仍为 0.2 rpm。两轴纯运动时间约为两轴角度差绝对值之和 ÷ {Number((recallSpeedRpm * 6).toFixed(1))}，另加加减速、通讯和停稳确认时间。</p>
    {points.length > 0 && <>
      <p className="field-subtext">点击记录旁的“移动到此点”，将以所选回位速度先移动轴1，确认停稳后再移动轴2；两轴均到位后显示完成。运动中不能更改速度，下一次回位使用新选择。回位期间可点击“停止当前轴”取消整个回位。历史记录按当前参考坐标解释，重设初始位后请重新核查；新记录会校验参考位是否变化。</p>
      <div className="field-table-scroll" role="region" aria-label="手动记录的转盘点位" tabIndex={0}><table className="field-table"><thead><tr><th>名称</th><th>轴1角度</th><th>轴2角度</th><th>原始计数</th><th>时间</th><th>操作</th></tr></thead><tbody>{points.map((point, index) => {
        const reason = manualPointRecallError(point, axes, port);
        return <tr key={`${point.recordedAt}-${index}`}><td>{point.name}</td><td>{point.axis1AngleDeg == null ? "—" : `${point.axis1AngleDeg.toFixed(3)}°`}</td><td>{point.axis2AngleDeg == null ? "—" : `${point.axis2AngleDeg.toFixed(3)}°`}</td><td className="mono">{point.axis1RawCounts ?? "—"} / {point.axis2RawCounts ?? "—"}</td><td>{new Date(point.recordedAt).toLocaleTimeString("zh-CN", { hour12: false })}</td><td><Button type="button" disabled={locked || !!reason || !!recallBlocked || !/^COM[1-9][0-9]{0,3}$/.test(port)} title={reason || recallBlocked || `移动至 ${point.name} 的两轴记录角度`} aria-label={`移动到点位 ${point.name}，第${index + 1}条记录`} onClick={() => recallPoint(point)}>移动到此点</Button><Button type="button" variant="ghost" disabled={locked} aria-label={`删除点位 ${point.name}，第${index + 1}条记录`} title={`删除点位 ${point.name}`} onClick={() => removePoint(index)}>删除</Button>{reason && <small>{reason}</small>}</td></tr>;
      })}</tbody></table></div>
    </>}
    {recall && <p className={recall.state === "complete" ? "field-success" : recall.state === "error" ? "field-error" : "field-notice"} role="status">点位回位：轴1 {recall.targets[0].toFixed(3)}° / 轴2 {recall.targets[1].toFixed(3)}° · {recall.state === "complete" ? "两轴已到达记录点" : recall.state === "cancelled" ? "已取消，后续轴不再启动" : recall.state === "error" ? "回位失败，后续轴不再启动" : `正在处理轴${status?.turntable?.axis}，已完成 ${recall.completedAxes.length}/2 轴`}。</p>}
    <dl className="field-details">
      <div><dt>操作状态</dt><dd>{status?.turntable?.port === port ? turntableLabels[status.turntable.state] || status.turntable.state : "未读取"}</dd></div>
      {([1, 2] as const).map(item => {
        const observed = axes?.[String(item)];
        return observed && <div key={item}><dt>轴{item}反馈状态</dt><dd>速度 {observed.motor_rpm} rpm · 故障码 {observed.fault} · 停止待确认 {(observed.flags & 16) ? "是" : "否"} · 标志 0x{observed.flags.toString(16).toUpperCase().padStart(4, "0")} · 软限位 {observed.guard.soft_enabled ? "开启" : "关闭"}（{observed.guard.minimum_deg}° ～ {observed.guard.maximum_deg}°）</dd></div>;
      })}
      {feedback && <div><dt>本次查询轴驱动器 / 限位标志</dt><dd>轴{status?.turntable?.axis} · 报警码 {feedback.alarmCode} · 限位标志 {feedback.limitFlags ?? "未提供"}</dd></div>}
    </dl>
    {axes?.["1"]?.output_angle_deg != null && Math.abs(axes["1"].output_angle_deg) > 35 && <p className="field-notice warning" role="alert">轴1反馈角度超出 ±35°，请核查真实姿态、参考位及软限位；设置参考位会改变坐标。</p>}
    {status?.turntableWarning && <p className="field-error" role="alert">{status.turntableWarning}</p>}
    {(error || status?.turntable?.port === port && status.turntable.error) && <p className="field-error" role="alert">{error || status?.turntable?.error}</p>}
    <p className="field-subtext">此模块不启动测振仪、不要求联合采集准备。手动记录只读取当前反馈：先现场调整到位置，点击“读取反馈”，必要时修正下方两轴角度，再点击“读取并记录两轴角度”。记录不会启动运动，也不会因故障码、停稳标志或软限位状态阻止保存；历史点位回位和自动运动仍保留独立的安全检查。</p>
  </section>;
}
