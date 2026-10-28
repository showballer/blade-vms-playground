"use client";
import React, { useEffect, useRef, useState } from "react";
import { Activity, LoaderCircle, RefreshCw } from "lucide-react";
import { Button, Dialog } from "./common";
import { FieldMechanicalHome } from "./field-mechanical-home";
import { FieldTurntableConnection } from "./field-turntable-connection";
import { isTurntablePort } from "./field-turntable-port";
import { fieldIsActive, fieldCanRequestTurntableRecovery, type FieldRequestOptions, type FieldStatus, type FieldTurntableRecoveryAction } from "./field-types";

// Vendor app(3) keeps axis protection, drive alarms and trajectory faults separate.
const axisFaults = ["无", "输入触发／无法退出", "超行程预算", "反馈单位变化／计数不连续", "超时／心跳丢失", "驱动通信异常", "驱动器报警", "人工取消", "定位执行异常"];
const trajectoryStates = ["空闲", "上传中", "已校验待启动", "轨迹运行", "终点收敛", "两轴停止确认", "完成", "故障", "已取消"];
const trajectoryFaults = ["无", "人工停止", "参考／保护无效", "范围／制动余量不足", "限位触发", "驱动通信故障", "驱动器报警", "跟随误差超限", "调度超过1秒", "3秒心跳丢失", "未停在起点", "轨迹数据错误", "终点收敛超时", "路径推进超时"];
const codeText = (names: string[], value: unknown) => typeof value === "number" && Number.isInteger(value)
  ? `${names[value] ?? "未知代码"}（${value}）` : "未读取";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export function turntableHealthReport(status: FieldStatus | null, port: string) {
  const controller = port && status?.turntable?.port === port ? status.turntable : undefined;
  const health = controller?.health, trajectory = controller?.motionCapability?.status;
  const problems: string[] = [], unknown: string[] = [];
  let moving = fieldIsActive(status) || !!status?.turntableBusy, waiting = false;
  if (!isTurntablePort(port)) unknown.push("请先配置转盘连接并读取反馈。");
  if (status?.service.state !== "ready") unknown.push("本机采集服务尚未就绪。");
  if (!controller) unknown.push("尚未读取所选串口的反馈。");
  if (controller?.error) problems.push(controller.error);
  if (status?.turntableWarning) problems.push(status.turntableWarning);
  if (health?.referenceChangedDuringRead) unknown.push("读取期间两轴参考发生变化，请重新检查。");
  if (!health?.readOnly || !finite(health.readAt) || health.readAt <= 0) unknown.push("尚无完整的双轴检查结果。");
  const axes = ([1, 2] as const).map(axis => {
    const name = axis === 1 ? "俯仰轴" : "水平轴", value = controller?.feedback?.axes?.[String(axis)];
    const drive = health?.axes?.[String(axis)];
    const profile = health?.motionProfiles?.[String(axis)];
    const milliseconds = (value: unknown) => finite(value) ? `${value} ms` : "未读取";
    const reference = !!value && Number.isInteger(value.flags) && !!(value.flags & 1) && finite(value.output_angle_deg);
    const pending = !!value && Number.isInteger(value.flags) && !!(value.flags & 16);
    if (!value) unknown.push(`${name}反馈缺失。`);
    else {
      if (!Number.isInteger(value.fault) || value.fault < 0) unknown.push(`${name}故障码无效。`);
      else if (value.fault !== 0) problems.push(`${name}：${codeText(axisFaults, value.fault)}`);
      if (!reference) problems.push(`${name}角度参考失效，不能据当前位置自动定位。`);
      if (pending) problems.push(`${name}停机待确认，零转速不能代替停止确认。`);
      if (!finite(value.motor_rpm)) unknown.push(`${name}转速未读取。`);
      else moving ||= value.motor_rpm !== 0;
      if (!Number.isInteger(value.home_phase) || value.home_phase < 0 || value.home_phase > 8) unknown.push(`${name}回零阶段无效。`);
      else moving ||= ![0, 7, 8].includes(value.home_phase);
      if (axis === 1 && !value.guard?.soft_enabled) problems.push("俯仰轴软范围未启用。");
      if (value.guard?.soft_enabled && reference &&
          (!finite(value.guard.minimum_deg) || !finite(value.guard.maximum_deg) || value.guard.minimum_deg >= value.guard.maximum_deg ||
           value.output_angle_deg! < value.guard.minimum_deg || value.output_angle_deg! > value.guard.maximum_deg))
        problems.push(`${name}当前位置或软范围无效。`);
    }
    if (!drive || !Number.isInteger(drive.alarmCode) || drive.alarmCode! < 0) unknown.push(`${name}驱动器报警码未读取。`);
    else if (drive.alarmCode !== 0) problems.push(`${name}驱动器报警：${drive.alarmCode}`);
    if (drive?.limitFlags != null && (!Number.isInteger(drive.limitFlags) || drive.limitFlags < 0)) unknown.push(`${name}限位状态无效。`);
    else if (drive?.limitFlags != null && drive.limitFlags !== 0) problems.push(`${name}限位／停止状态异常（${drive.limitFlags}）。`);
    return { axis, name, angle: reference ? `${value!.output_angle_deg!.toFixed(3)}°` : "无有效角度",
      rpm: finite(value?.motor_rpm) ? `${value.motor_rpm} rpm` : "未读取", reference: reference ? "有效" : "无效／未读取",
      stop: !value || !finite(value.motor_rpm) ? "未读取" : pending ? "停机待确认" : value.motor_rpm !== 0 ? "运动中" : "反馈零速",
      fault: codeText(axisFaults, value?.fault), alarm: drive?.alarmCode != null ? String(drive.alarmCode) : "未读取",
      profile: { acceleration: milliseconds(profile?.accel_ms), deceleration: milliseconds(profile?.decel_ms),
        smoothing: milliseconds(profile?.s_curve_ms), unavailable: profile?.unavailable } };
  });
  const capability = controller?.motionCapability;
  if (capability?.supported && capability.probe === "confirmed") {
    const state = trajectory?.state, fault = trajectory?.fault;
    if (!Number.isInteger(state) || !Number.isInteger(fault) || !finite(state) || !finite(fault)) unknown.push("轨迹状态或故障码未读取。");
    else {
      if (state === 7 || fault > 1) problems.push(`双轴轨迹：${codeText(trajectoryFaults, fault)}`);
      else if ([3, 4, 5].includes(state)) moving = true;
      else if ([1, 2].includes(state)) waiting = true;
      else if (![0, 6, 8].includes(state) || fault < 0) unknown.push("控制器返回了未知轨迹状态。");
    }
  } else if (!(capability?.supported === false && capability.probe === "legacy-command-unsupported")) unknown.push("尚未确认控制器轨迹接口。");
  const tone = problems.length ? "red" : moving ? "blue" : waiting ? "amber" : unknown.length ? "neutral" : "green";
  const label = problems.length ? "存在异常" : moving ? "任务或运动进行中" : waiting ? "有待执行轨迹" : unknown.length ? "尚不能确认" : "本次检查未发现异常";
  return { tone, label, axes, problems, unknown, readAt: health?.readAt,
    trajectoryState: capability?.supported === false && capability.probe === "legacy-command-unsupported" ? "旧控制器：逐轴模式" : codeText(trajectoryStates, trajectory?.state),
    trajectoryFault: codeText(trajectoryFaults, trajectory?.fault),
    errors: [trajectory?.error1_deg, trajectory?.error2_deg].map(value => finite(value) ? `${value.toFixed(3)}°` : "未读取") };
}

type Props = { settings?: React.ReactNode; settingsBusy?: boolean; port: string; status: FieldStatus | null; disabled?: boolean; pollUnavailable?: boolean;
  onConnectionChange?: (endpoint: string) => void;
  request: <T>(options: FieldRequestOptions) => Promise<T>; onStatus: (status: FieldStatus) => void; onBusy: (busy: boolean) => void };
export function turntableRecoveryOptions(status: FieldStatus | null, port: string, readFailed = false) {
  const controller = status?.turntable?.port === port ? status.turntable : undefined;
  const health = controller?.health, state = controller?.motionCapability?.status?.state;
  const positions = [1, 2].map(axis => controller?.feedback?.axes?.[String(axis)]);
  const stopped = health?.readOnly === true && !health.referenceChangedDuringRead && positions.every(p =>
    p && p.motor_rpm === 0 && [0, 7, 8].includes(p.home_phase));
  const supported = controller?.motionCapability?.probe === "confirmed";
  const terminal = supported && typeof state === "number" && [0, 6, 7, 8].includes(state);
  const session = controller?.motionCapability?.status?.session;
  const retry = fieldCanRequestTurntableRecovery(status, port) && Boolean(readFailed || controller?.error ||
    !health?.readOnly || health.referenceChangedDuringRead);
  return { retry, cancelPending: !!stopped && supported && state === 2 && controller?.motionCapability?.status?.fault === 0 && finite(session) && Number.isInteger(session) && session >= 1 && session <= 65535,
    trajectory: !!stopped && supported && typeof state === "number" && [5, 6, 7, 8].includes(state),
    axes: ([1, 2] as const).map(axis => {
      const value = positions[axis - 1], drive = health?.axes[String(axis)];
      // Older replies omit the extended drive flags (stored explicitly as null).
      // The axis feedback still has its own stop-pending flag; missing drive
      // data (undefined) is not equivalent to this supported legacy response.
      const settled = !!stopped && !!value && !(value.flags & 16) &&
        (drive?.limitFlags === 0 || drive?.limitFlags === null);
      const reference = !!value && !!(value.flags & 1) && finite(value.output_angle_deg);
      const inRange = reference && (!value.guard.soft_enabled ||
        value.output_angle_deg! >= value.guard.minimum_deg && value.output_angle_deg! <= value.guard.maximum_deg);
      return { axis, guard: settled && terminal && reference && inRange && drive?.alarmCode === 0 && value!.fault > 0,
        execution: settled && terminal && reference && drive?.alarmCode === 0 && value!.fault === 8,
        alarm: settled && (terminal || controller?.motionCapability?.probe === "legacy-command-unsupported") &&
          finite(drive?.alarmCode) && drive.alarmCode > 0 };
    }) };
}
export function FieldTurntableHealth({ port, status, disabled = false, pollUnavailable = false, request, onStatus, onBusy, onConnectionChange, settings, settingsBusy = false }: Props) {
  const [open, setOpen] = useState(false), [checking, setChecking] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [homingPending, setHomingPending] = useState(false);
  const [connectionPending, setConnectionPending] = useState(false);
  const alive = useRef(false), sequence = useRef(0), inFlight = useRef(false);
  const latest = useRef({ port, status, disabled, pollUnavailable }); latest.current = { port, status, disabled, pollUnavailable };
  const report = turntableHealthReport(status, port);
  const recovery = turntableRecoveryOptions(status, port, !!error);
  const blocked = disabled || homingPending || connectionPending || pollUnavailable || status?.service.state !== "ready" || !isTurntablePort(port) ||
    fieldIsActive(status) || !!status?.turntableBusy || !!status?.deviceBusy;
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; onBusy(false); }; }, [onBusy]);
  useEffect(() => { onBusy(checking || homingPending || connectionPending); }, [checking, homingPending, connectionPending, onBusy]);
  useEffect(() => { sequence.current++; setError(""); setNotice(""); }, [port, status?.service.generation]);
  async function inspect(action: "health" | FieldTurntableRecoveryAction = "health", axis: 1 | 2 = 1) {
    if (blocked || inFlight.current) return;
    const pendingSession = status?.turntable?.motionCapability?.status?.session;
    if (action === "cancel_trajectory" && (!recovery.cancelPending || !finite(pendingSession))) return;
    const token = ++sequence.current, selectedPort = port, generation = status?.service.generation;
    inFlight.current = true; setChecking(true); setError(""); setNotice("");
    try {
      const next = await request<FieldStatus>({ action: "turntable", request: { action, port: selectedPort, axis,
        ...(action === "cancel_trajectory" && finite(pendingSession) ? { expectedTrajectorySession: pendingSession } : {}),
        ...(action !== "health" ? { confirmRecovery: true } : {}) } });
      const live = latest.current;
      if (!alive.current || token !== sequence.current || live.port !== selectedPort || live.status?.service.generation !== generation ||
          next.service.generation !== generation || live.pollUnavailable || fieldIsActive(live.status)) return;
      if (next.turntable?.port !== selectedPort || next.turntable.health?.readOnly !== true) throw new Error("未收到完整的转盘检查结果，请完全重启客户端后再试。");
      if (action !== "health" && (next.turntable.recovery?.verified !== true || next.turntable.recovery.action !== action || next.turntable.recovery.axis !== axis))
        throw new Error("未收到恢复操作的有效读回，请重新检查。");
      onStatus(next);
      if (action !== "health") setNotice(action === "cancel_trajectory" ? "待执行轨迹已取消，未修改作业原点和参考位。" : "本项恢复已读回确认，请检查其余状态。采集任务不会自动续跑。");
    } catch (cause) {
      if (alive.current && token === sequence.current) setError(cause instanceof Error ? cause.message : "转盘检查失败");
    } finally {
      inFlight.current = false;
      if (alive.current) setChecking(false);
    }
  }
  const close = () => { if (settingsBusy) return; setOpen(false); sequence.current++; };
  return <div className="field-servo-ui field-health-control">
    <Button type="button" aria-label="打开转盘设置" disabled={checking || homingPending || connectionPending} onClick={() => { setOpen(true); void inspect(); }}>
      <Activity size={15} />配置与检查{report.tone === "red" && <span className="field-health-alert-dot" aria-label="存在转盘异常" />}
    </Button>
    {open && <Dialog title="转盘设置" onClose={close} wide><div className="field-turntable-health field-servo-ui" role="region" aria-label="转盘设置详情" tabIndex={0}>
      <div className="field-health-heading"><div><span className={`field-badge ${pollUnavailable ? "" : error ? "amber" : report.tone === "neutral" ? "" : report.tone}`}>{pollUnavailable ? "状态连接不可用" : error ? "本次检查失败" : checking ? "正在读取…" : report.label}</span><p className="field-subtext">{port || "未选择串口"} · {finite(report.readAt) ? `上次完整检查 ${new Date(report.readAt * 1000).toLocaleTimeString("zh-CN", { hour12: false })}` : "尚无完整检查"}</p></div>
        <Button type="button" disabled={checking || blocked} onClick={() => void inspect()} aria-label="重新检查转盘状态">{checking ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}重新检查</Button></div>
      {error && <p className="field-error" role="alert">{error}。下方保留的反馈不代表本次读取成功。</p>}
      {pollUnavailable && <p className="field-notice warning">服务状态连接不可用，已有反馈不能证明设备当前状态。</p>}
      {!checking && blocked && <p className="field-subtext">{!port ? "先配置转盘连接。" : fieldIsActive(status) || status?.turntableBusy || status?.deviceBusy ? "任务正在使用设备，下方显示已有反馈，不额外占用设备连接。" : "服务尚未就绪或有其他设备操作，暂不能重新读取。"}</p>}
      {onConnectionChange && <FieldTurntableConnection port={port} status={status} disabled={disabled || pollUnavailable || checking || homingPending}
        request={request} onStatus={onStatus} onBusy={setConnectionPending} onConnectionChange={onConnectionChange} />}
      <FieldMechanicalHome port={port} status={status} disabled={disabled || pollUnavailable || checking || connectionPending}
        request={request} onStatus={onStatus} onBusy={setHomingPending} />
      {settings}
      <div className="field-health-axes">{report.axes.map(axis => <section className="field-health-axis" key={axis.axis}><h3>{axis.name}</h3><dl>
        <div><dt>当前角度</dt><dd>{axis.angle}</dd></div><div><dt>电机转速</dt><dd>{axis.rpm}</dd></div>
        <div><dt>角度参考</dt><dd>{axis.reference}</dd></div><div><dt>停止反馈</dt><dd>{axis.stop}</dd></div>
        <div><dt>轴故障</dt><dd>{axis.fault}</dd></div><div><dt>驱动器报警码</dt><dd>{axis.alarm}</dd></div>
        <div><dt>驱动加速 PA40</dt><dd>{axis.profile.acceleration}</dd></div>
        <div><dt>驱动减速 PA41</dt><dd>{axis.profile.deceleration}</dd></div>
        <div><dt>驱动平滑 PA42</dt><dd>{axis.profile.smoothing}</dd></div>
        {axis.profile.unavailable && <div><dt>驱动参数</dt><dd>{axis.profile.unavailable}</dd></div>}
      </dl><div className="field-health-recovery-actions">
        {axis.axis === 1 && <Button type="button" disabled={checking || blocked || !recovery.retry && !recovery.axes[0].execution}
          title="对应 app 的执行故障确认，保留角度参考与双限位配置，不启动旧任务" onClick={() => void inspect("clear_guard_fault", 1)}>清除执行故障</Button>}
        {(axis.axis === 2 || !!status?.turntable?.feedback?.axes?.["1"]?.fault && status.turntable.feedback.axes["1"].fault !== 8) &&
          <Button type="button" disabled={checking || blocked || !recovery.retry && !recovery.axes[axis.axis - 1].guard} onClick={() => void inspect("clear_guard_fault", axis.axis)}>清除{axis.name}故障</Button>}
        <Button type="button" disabled={checking || blocked || !recovery.retry && !recovery.axes[axis.axis - 1].alarm} onClick={() => void inspect("reset_alarm", axis.axis)}>复位驱动报警</Button>
      </div></section>)}</div>
      <p className="field-subtext">PA40／PA41是驱动器加减速时间常数，PA42是平滑时间，均为实际读值。内部定位使用这组参数；轨迹模式另有换点加速度 °/s² 设置。检查不会修改参数。</p>
      <section className="field-health-trajectory"><h3>双轴轨迹</h3><dl><div><dt>轨迹状态</dt><dd>{report.trajectoryState}</dd></div><div><dt>轨迹故障</dt><dd>{report.trajectoryFault}</dd></div>
        <div><dt>轨迹快照误差（俯仰／水平）</dt><dd>{report.errors.join(" / ")}</dd></div></dl>
        <div className="field-health-recovery-actions"><Button type="button" disabled={checking || blocked || !!error || !recovery.cancelPending} onClick={() => void inspect("cancel_trajectory")}>取消待执行轨迹</Button>
          <Button type="button" disabled={checking || blocked || !recovery.retry && !recovery.trajectory} onClick={() => void inspect("clear_trajectory_fault")}>清除旧轨迹</Button></div></section>
      {recovery.retry && <p className="field-subtext">上次操作异常不会锁住恢复入口。点击后重新读取设备状态，符合条件才执行；不会自动恢复采集或运动。</p>}
      {notice && <p className="field-notice" role="status">{notice}</p>}
      {!!status?.turntable?.health?.issues?.length && status.turntable.port === port && <div className="field-health-issues"><h3>处理建议</h3>{status.turntable.health.issues.map((issue, index) =>
        <div key={`${issue.domain}-${issue.code}-${issue.motor_id}-${index}`}><strong>{issue.motor_id ? `${issue.motor_id === 1 ? "俯仰轴" : "水平轴"} · ` : ""}{issue.title}</strong><ul>{issue.steps.map((step, i) => <li key={i}>{step}</li>)}</ul></div>)}</div>}
      {(report.problems.length > 0 || report.unknown.length > 0) && <div className="field-health-issues"><h3>需要处理或核实</h3><ul>{[...new Set([...report.problems, ...report.unknown])].map(text => <li key={text}>{text}</li>)}</ul></div>}
      <p className="field-subtext">取消待执行轨迹只撤销预载，不修改作业原点或参考位。重新检查只读状态；排除原因并停稳后，再点击对应恢复按钮。参考失效需先按真实姿态重新建立参考。独立清除轨迹需要配套 v3.4 或更新固件。</p>
    </div></Dialog>}
  </div>;
}
