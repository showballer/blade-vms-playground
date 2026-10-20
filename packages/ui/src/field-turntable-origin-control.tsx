"use client";
import React, { useEffect, useRef, useState } from "react";
import { Crosshair, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { Button } from "./common";
import { isTurntablePort } from "./field-turntable-port";
import { createWorkOrigin, matchingWorkOrigin, revalidateWorkOrigin, toWorkAngle, type FieldWorkOrigin } from "./field-turntable-origin";
import { turntablePointMotionError, turntableReferenceSignature } from "./field-turntable-points";
import { fieldIsActive, type FieldRequestOptions, type FieldStatus } from "./field-types";
import { autoFollowDefaults } from "./field-auto-follow-plan";

export type FieldOriginReturnMotion = { speedRpm: number; maxMoveAccelerationDegS2: number; followErrorLimitDeg?: number };
export function checkedOriginReturnMotion(value: FieldOriginReturnMotion): FieldOriginReturnMotion {
  const followErrorLimitDeg = value.followErrorLimitDeg === undefined ? autoFollowDefaults.followErrorLimitDeg : value.followErrorLimitDeg;
  if (typeof value.speedRpm !== "number" || !Number.isFinite(value.speedRpm) || value.speedRpm < .02 || value.speedRpm > 10 ||
      typeof value.maxMoveAccelerationDegS2 !== "number" || !Number.isFinite(value.maxMoveAccelerationDegS2) ||
      value.maxMoveAccelerationDegS2 < .1 || value.maxMoveAccelerationDegS2 > 120)
    throw new Error("请检查自动跟随的换点转速（0.02～10 rpm）和加速度（0.1～120 °/s²）");
  if (typeof followErrorLimitDeg !== "number" || !Number.isFinite(followErrorLimitDeg) ||
      followErrorLimitDeg < .5 || followErrorLimitDeg > 10)
    throw new Error("运动中跟随误差上限应为0.5～10°，不能设为0关闭；到位精度仍为0.1°");
  return { speedRpm: Number((Math.floor((value.speedRpm + 1e-10) / .02) * .02).toFixed(6)),
    maxMoveAccelerationDegS2: Math.floor((value.maxMoveAccelerationDegS2 + 1e-10) * 1000) / 1000,
    followErrorLimitDeg: Math.floor((followErrorLimitDeg + 1e-10) * 1000) / 1000 };
}

type Props = {
  port: string; status: FieldStatus | null; disabled: boolean; origin: FieldWorkOrigin | null; opticalOrigin?: FieldWorkOrigin | null; opticalOriginRequired?: boolean;
  deviceIp?: string;
  returnMotion?: FieldOriginReturnMotion;
  request: <T>(options: FieldRequestOptions) => Promise<T>;
  onOrigin: (origin: FieldWorkOrigin | null) => void;
  onVerifiedOrigin?: (origin: FieldWorkOrigin) => void;
  onStatus: (status: FieldStatus) => void; onBusy: (busy: boolean) => void;
};
const angleText = (angle: number | null) => angle == null ? "—" : `${angle.toFixed(3)}°`;
type ReturnChoice = { origin: FieldWorkOrigin; motion: FieldOriginReturnMotion };
type ReturnRun = ReturnChoice & { token: number; port: string; generation: number; deviceIp: string; started: boolean; cancelled: boolean; stop?: Promise<FieldStatus> };

export function originReturnTargetError(origin: FieldWorkOrigin | null | undefined, status: FieldStatus, port: string): string {
  if (!origin || !matchingWorkOrigin(origin, status, port)) return "公共光学零点已失效，请重新设置归零";
  try { createWorkOrigin(status, port); } catch (cause) { return cause instanceof Error ? cause.message : "两轴状态尚未确认"; }
  return turntablePointMotionError({ port: origin.port, referenceSignature: origin.referenceSignature,
    axis1AngleDeg: origin.axis1AngleDeg, axis2AngleDeg: origin.axis2AngleDeg }, status.turntable?.feedback?.axes, port);
}

export function originReturnArrivalError(origin: FieldWorkOrigin, status: FieldStatus, port: string): string {
  const invalid = originReturnTargetError(origin, status, port);
  if (invalid) return invalid;
  const axes = status.turntable!.feedback!.axes!;
  for (const axis of [1, 2] as const) {
    const target = axis === 1 ? origin.axis1AngleDeg : origin.axis2AngleDeg;
    if (Math.abs(axes[String(axis)].output_angle_deg! - target) > .1 + 1e-9) return `轴${axis}距原点超过0.1°，尚未确认到位`;
  }
  return "";
}

export function originStopError(status: FieldStatus, port: string, generation: number): string {
  const controller = status.turntable, feedback = controller?.feedback, axes = feedback?.axes;
  if (status.service.state !== "ready" || status.service.generation !== generation || controller?.port !== port || controller.state !== "checked") return "连接或新读回无效，停止尚未确认";
  if (fieldIsActive(status) || status.deviceBusy || status.turntableBusy || status.turntableWarning || controller.error ||
      !feedback || feedback.motorRpm !== 0 || feedback.outputRpm !== 0 || feedback.alarmCode !== 0 || feedback.limitFlags != null && feedback.limitFlags !== 0) return "两轴停止状态尚未确认";
  for (const axis of [1, 2]) {
    const value = axes?.[String(axis)];
    if (!value || value.motor_rpm !== 0 || value.fault !== 0 || !Number.isInteger(value.flags) || value.flags < 0 || value.flags > 65535 || value.flags & 16) return `轴${axis}停止或故障状态尚未确认`;
  }
  // A stopped drive may need its reference/limits repaired. Do not require
  // motion readiness merely to release the controls for that repair.
  return "";
}

/** A recovery offer is not motion permission: the click must obtain a new
 * health read and the backend must match the exact stopped session. */
export function originTrajectoryRecoverySession(status: FieldStatus | null, port: string): number | null {
  if (!status || status.turntable?.port !== port || fieldIsActive(status) ||
      status.turntableBusy || status.deviceBusy) return null;
  const value = status.turntable.motionCapability?.status;
  return value && [5, 7].includes(Number(value.state)) && value.fault === 7 &&
    Number.isInteger(value.session) && Number(value.session) >= 1 && Number(value.session) <= 65535
    ? Number(value.session) : null;
}

function feedbackAuthority(status: FieldStatus | null, port: string): string {
  const turntable = status?.turntable?.port === port ? status.turntable : undefined;
  const feedback = turntable?.feedback, axes = feedback?.axes, trajectory = turntable?.motionCapability?.status;
  // Query timestamps and the server's own probe-busy flag may change during this
  // read. Reference, position, fault and protection changes must not be overwritten
  // by an older result. A poll of the same fresh result is still acceptable.
  return JSON.stringify([status?.service.state, status?.state, status?.receiver?.running, status?.deviceBusy, status?.pointCycle?.state,
    status?.turntableWarning, status?.deviceWarning,
    turntable?.error, turntableReferenceSignature(axes), feedback?.alarmCode, feedback?.limitFlags,
    trajectory?.state, trajectory?.fault, [1, 2].map(axis => {
      const value = axes?.[String(axis)];
      return value && [value.output_angle_deg, value.motor_rpm, value.flags, value.fault, value.home_phase, value.guard];
    })]);
}

/** Setting zero only reads the shared optical basis. Returning uses the existing
 * guarded recall/stop actions and never rewrites controller references or limits. */
export function FieldTurntableOriginControl({ port, status, disabled, origin, opticalOrigin, opticalOriginRequired = false, deviceIp = "", returnMotion, request, onOrigin, onVerifiedOrigin, onStatus, onBusy }: Props) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [returnPhase, setReturnPhase] = useState<"checking" | "moving" | "stopping" | "unconfirmed" | null>(null), [returnNotice, setReturnNotice] = useState("");
  const returnRun = useRef<ReturnRun | null>(null);
  const operation = useRef(0), inFlight = useRef(false), alive = useRef(false);
  const authority = feedbackAuthority(status, port);
  const latest = useRef({ port, generation: status?.service.generation, disabled, authority, status, deviceIp: deviceIp.trim() });
  latest.current = { port, generation: status?.service.generation, disabled, authority, status, deviceIp: deviceIp.trim() };
  const current = matchingWorkOrigin(origin, status, port);
  const optical = matchingWorkOrigin(opticalOrigin, status, port);
  const saved = opticalOrigin || origin;
  const returnCandidate = saved?.port === port ? saved : null;
  const recoverySession = originTrajectoryRecoverySession(status, port);
  let motion: FieldOriginReturnMotion | null = null, motionError = "";
  try { motion = checkedOriginReturnMotion(returnMotion ?? { speedRpm: autoFollowDefaults.maxMoveRpm,
    maxMoveAccelerationDegS2: autoFollowDefaults.maxMoveAccelerationDegS2, followErrorLimitDeg: autoFollowDefaults.followErrorLimitDeg }); }
  catch (cause) { motionError = cause instanceof Error ? cause.message : "回原点运动参数无效"; }
  const missingOpticalOrigin = opticalOriginRequired && !optical && !current;
  const axes = status?.turntable?.port === port ? status.turntable.feedback?.axes : undefined;
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++; onBusy(false); }; }, [onBusy]);
  useEffect(() => { operation.current++; setError(""); setReturnNotice(""); }, [port, status?.service.generation, deviceIp]);

  async function setZero() {
    if (disabled || inFlight.current || !isTurntablePort(port)) return;
    const token = ++operation.current, requestedPort = port, generation = status?.service.generation, initialAuthority = authority;
    inFlight.current = true; setPending(true); setError(""); setReturnNotice(""); onBusy(true);
    try {
      const next = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port: requestedPort, axis: 1 } });
      if (!alive.current || token !== operation.current || latest.current.port !== requestedPort ||
          latest.current.generation !== generation || latest.current.disabled) return;
      if (latest.current.authority !== initialAuthority && latest.current.authority !== feedbackAuthority(next, requestedPort)) return;
      if (next.service.generation !== generation) throw new Error("采集服务已变化，请重新读取后设置归零");
      const workOrigin = createWorkOrigin(next, requestedPort);
      onStatus(next); onOrigin(workOrigin);
    } catch (cause) {
      if (alive.current && token === operation.current) setError(cause instanceof Error ? cause.message : "设置归零失败，请重新读取反馈");
    } finally {
      inFlight.current = false;
      if (alive.current) { setPending(false); onBusy(false); }
    }
  }

  async function clearFailedOriginTrajectory() {
    if (disabled || inFlight.current || recoverySession === null || returnPhase) return;
    const token = ++operation.current, requestedPort = port, generation = status?.service.generation;
    const expected = recoverySession;
    inFlight.current = true; setPending(true); setError(""); setReturnNotice(""); onBusy(true);
    const currentRequest = () => alive.current && token === operation.current &&
      latest.current.port === requestedPort && latest.current.generation === generation &&
      !fieldIsActive(latest.current.status);
    try {
      const checked = await request<FieldStatus>({ action: "turntable",
        request: { action: "health", port: requestedPort, axis: 1 } });
      if (!currentRequest() || checked.service.generation !== generation) throw new Error("连接已变化，请重新检查");
      onStatus(checked);
      if (originTrajectoryRecoverySession(checked, requestedPort) !== expected)
        throw new Error("故障轨迹已变化，请重新检查；未清除其他任务");
      if (checked.turntable?.health?.readOnly !== true || checked.turntable.health.referenceChangedDuringRead)
        throw new Error("未取得完整的转盘状态，请重新检查");
      const invalid = originStopError(checked, requestedPort, generation!);
      if (invalid) throw new Error(invalid);
      const cleared = await request<FieldStatus>({ action: "turntable", request: {
        action: "clear_trajectory_fault", port: requestedPort, axis: 1,
        confirmRecovery: true, expectedTrajectorySession: expected } });
      if (!currentRequest() || cleared.service.generation !== generation || cleared.turntable?.port !== requestedPort)
        throw new Error("连接已变化，清除结果尚未确认，请重新检查");
      onStatus(cleared);
      if (cleared.turntable.recovery?.action !== "clear_trajectory_fault" || !cleared.turntable.recovery.verified ||
          cleared.turntable.motionCapability?.status?.state !== 0 || cleared.turntable.motionCapability.status.fault !== 0 ||
          turntableReferenceSignature(cleared.turntable.feedback?.axes) !== turntableReferenceSignature(checked.turntable.feedback?.axes))
        throw new Error("旧轨迹或参考位尚未核验，请重新检查");
      const stopped = originStopError(cleared, requestedPort, generation!);
      if (stopped) throw new Error(stopped);
      setReturnNotice("旧轨迹已清除，原点坐标和参考位已保留。请检查运动参数后再点击“回到原点”。");
    } catch (cause) {
      if (currentRequest()) setError(cause instanceof Error ? cause.message : "清除旧轨迹失败");
    } finally {
      inFlight.current = false;
      if (alive.current) { setPending(false); onBusy(false); }
    }
  }

  const transportCurrent = (run: ReturnRun) => alive.current && returnRun.current === run &&
    latest.current.port === run.port && latest.current.generation === run.generation &&
    latest.current.deviceIp === run.deviceIp && latest.current.status?.service.state === "ready";
  const runCurrent = (run: ReturnRun) => transportCurrent(run) && run.token === operation.current;
  async function retryStopReturn(run: ReturnRun) {
    if (inFlight.current || !transportCurrent(run) || fieldIsActive(latest.current.status)) return;
    inFlight.current = true; setReturnPhase("stopping"); setError("");
    let verified = false;
    try {
      const stopped = await request<FieldStatus>({ action: "turntable", request: { action: "stop", port: run.port, axis: 1, confirmMotion: true } });
      if (!transportCurrent(run) || stopped.service.generation !== run.generation || stopped.turntable?.port !== run.port) throw new Error("连接已变化，停止结果未确认");
      onStatus(stopped);
      const checked = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port: run.port, axis: 1 } });
      if (!transportCurrent(run) || checked.service.generation !== run.generation || checked.turntable?.port !== run.port) throw new Error("连接已变化，停止结果未确认");
      const invalid = originStopError(checked, run.port, run.generation);
      if (invalid) throw new Error(invalid);
      onStatus(checked);
      verified = true; setReturnNotice("已停止回原点，两轴已确认停稳。");
    } catch (cause) { if (alive.current) setError(`停止未确认：${cause instanceof Error ? cause.message : "请现场核查"}`); }
    finally {
      inFlight.current = false;
      if (verified) { returnRun.current = null; if (alive.current) { setReturnPhase(null); onBusy(false); } }
      else if (alive.current) setReturnPhase("unconfirmed");
    }
  }
  function stopReturn() {
    const run = returnRun.current;
    if (run && returnPhase === "unconfirmed") { void retryStopReturn(run); return; }
    if (!run || run.cancelled) return;
    run.cancelled = true; setReturnPhase("stopping");
    if (run.started && transportCurrent(run)) {
      run.stop = request<FieldStatus>({ action: "turntable", request: { action: "stop", port: run.port, axis: 1, confirmMotion: true } });
      // The return owner awaits and reports this promise; avoid an unhandled
      // rejection while its concurrent read-only status request is pending.
      void run.stop.catch(() => {});
    }
  }

  async function returnToOrigin() {
    if (disabled || inFlight.current || !returnCandidate || !motion ||
        !Number.isSafeInteger(status?.service.generation)) return;
    const initialAuthority = authority;
    const run: ReturnRun = { token: ++operation.current, port, generation: status!.service.generation!, deviceIp: deviceIp.trim(),
      origin: { ...returnCandidate }, motion: { ...motion }, started: false, cancelled: false };
    returnRun.current = run; inFlight.current = true; setReturnPhase("checking"); setError(""); setReturnNotice(""); onBusy(true);
    let stopUnconfirmed = false;
    const apply = (next: FieldStatus) => {
      if (!runCurrent(run) || next.service.generation !== run.generation || next.turntable?.port !== run.port) throw new Error("服务或串口已变化，无法确认回原点结果，请现场核查停止状态");
      const latestAxes = latest.current.status?.turntable?.port === run.port ? latest.current.status.turntable.feedback?.axes : undefined;
      if (latestAxes && turntableReferenceSignature(latestAxes) !== run.origin.referenceSignature) throw new Error("参考位已变化，无法应用旧的回原点结果，请重新归零");
      onStatus(next);
    };
    const applyStopped = (next: FieldStatus) => {
      if (!transportCurrent(run) || next.service.generation !== run.generation || next.turntable?.port !== run.port) throw new Error("连接已变化，停止结果未确认，请现场核查");
      onStatus(next);
    };
    try {
      const checked = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port: run.port, axis: 1 } });
      if (!runCurrent(run)) throw new Error("服务或串口已变化，已取消回原点，请现场核查状态");
      if (run.cancelled) { setReturnNotice("已取消回原点，未发送运动指令。"); return; }
      if (latest.current.authority !== initialAuthority && latest.current.authority !== feedbackAuthority(checked, run.port)) throw new Error("读取期间转盘反馈已变化，已取消回原点，请重新读取");
      // Surface the freshly read fault so recovery is available beside the
      // origin controls even when validation refuses the new return command.
      apply(checked);
      run.origin = revalidateWorkOrigin(run.origin, checked, run.port);
      const invalid = originReturnTargetError(run.origin, checked, run.port);
      if (invalid) throw new Error(invalid);
      if (fieldIsActive(latest.current.status) || latest.current.status?.deviceBusy) throw new Error("设备已被其他任务接管，已取消回原点");
      onVerifiedOrigin?.(run.origin);
      run.started = true; setReturnPhase("moving");
      const started = await request<FieldStatus>({ action: "turntable", request: { action: "recall", port: run.port, recordedPort: run.origin.port, axis: 1,
        axis1AngleDeg: run.origin.axis1AngleDeg, axis2AngleDeg: run.origin.axis2AngleDeg, referenceSignature: run.origin.referenceSignature,
        speedRpm: run.motion.speedRpm, maxMoveAccelerationDegS2: run.motion.maxMoveAccelerationDegS2,
        followErrorLimitDeg: run.motion.followErrorLimitDeg, confirmMotion: true } });
      apply(started);
      while (runCurrent(run)) {
        if (run.cancelled) {
          if (!run.stop) throw new Error("服务或串口已变化，无法确认停止，请现场核查");
          applyStopped(await run.stop);
          const stopped = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port: run.port, axis: 1 } });
          applyStopped(stopped);
          const invalid = originStopError(stopped, run.port, run.generation);
          if (invalid) throw new Error(invalid);
          setReturnNotice("已停止回原点，两轴已确认停稳。"); return;
        }
        const next = await request<FieldStatus>({ action: "status" });
        apply(next);
        const controller = next.turntable!, axes = controller.feedback?.axes;
        if ((!next.turntableBusy && next.turntableWarning) || controller.error || controller.recall?.state === "error" || fieldIsActive(next)) throw new Error(next.turntableWarning || controller.error || "回原点未完成，请核查设备状态");
        if (axes && turntableReferenceSignature(axes) !== run.origin.referenceSignature) throw new Error("回位期间参考位已变化，请重新归零");
        if (axes && [1, 2].some(axis => axes[String(axis)]?.fault !== 0)) throw new Error("回原点检测到轴故障，请核查设备");
        if (controller.recall?.state === "cancelled" && !next.turntableBusy) throw new Error("回原点已被停止，尚未确认返回原点");
        const moving = axes && [1, 2].some(axis => axes[String(axis)]?.motor_rpm !== 0 || (axes[String(axis)]?.flags & 16) !== 0);
        if (!next.turntableBusy && !moving && controller.recall?.state === "complete") {
          const final = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port: run.port, axis: 1 } });
          apply(final);
          if (run.cancelled) continue;
          const arrival = originReturnArrivalError(run.origin, final, run.port);
          if (arrival) throw new Error(arrival);
          setReturnNotice("已回到公共光学原点，两轴已停稳（误差不超过0.1°）。"); return;
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
      }
      throw new Error("服务或串口已变化，无法确认回原点结果，请现场核查停止状态");
    } catch (cause) {
      let message = cause instanceof Error ? cause.message : "回到原点失败";
      if (run.started) {
        stopUnconfirmed = true;
        if (transportCurrent(run) && !fieldIsActive(latest.current.status)) {
          try {
            setReturnPhase("stopping");
            if (!run.stop) run.stop = request<FieldStatus>({ action: "turntable", request: { action: "stop", port: run.port, axis: 1, confirmMotion: true } });
            applyStopped(await run.stop);
            const checked = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port: run.port, axis: 1 } });
            applyStopped(checked);
            const invalid = originStopError(checked, run.port, run.generation);
            if (invalid) throw new Error(invalid);
            stopUnconfirmed = false;
          } catch (failure) { message += `；停止未确认：${failure instanceof Error ? failure.message : "请现场核查"}`; }
        } else message += "；停止状态未确认，请现场核查";
      }
      if (alive.current) setError(message);
    } finally {
      inFlight.current = false;
      if (!stopUnconfirmed && returnRun.current === run) returnRun.current = null;
      if (alive.current) {
        if (stopUnconfirmed) setReturnPhase("unconfirmed");
        else { setReturnPhase(null); onBusy(false); }
      }
    }
  }

  return <section className="field-work-origin field-servo-ui" aria-label="作业坐标原点">
    <div className="field-work-origin-row">
      <div className="field-work-origin-actions">
        <Button type="button" variant="outline" aria-label="设置归零" disabled={disabled || pending || !!returnPhase || !isTurntablePort(port)}
          title={isTurntablePort(port) ? "将激光水平、正对叶轮的姿态设为公共光学零点，不移动转盘" : "请先选择转盘串口"} onClick={() => void setZero()}>
          {pending ? <LoaderCircle size={15} className="spin" /> : <Crosshair size={15} />}设置归零
        </Button>
        <Button type="button" aria-label="回到原点" disabled={disabled || pending || !!returnPhase || !returnCandidate || !motion}
          title={!returnCandidate ? "尚无此串口保存的作业原点" : motionError || `按当前设置返回：转速上限 ${motion!.speedRpm} rpm，加速度上限 ${motion!.maxMoveAccelerationDegS2} °/s²`}
          onClick={() => void returnToOrigin()}><RotateCcw size={14} />回到原点</Button>
        {returnPhase && <Button type="button" variant="danger" aria-label="停止回原点" disabled={returnPhase === "stopping" || returnPhase === "unconfirmed" && (!returnRun.current || !transportCurrent(returnRun.current) || fieldIsActive(status))} onClick={stopReturn}><Square size={14} />{returnPhase === "stopping" ? "正在停止…" : returnPhase === "unconfirmed" ? "重试停止" : "停止回原点"}</Button>}
        {current && <Button type="button" variant="ghost" disabled={disabled || pending || !!returnPhase} onClick={() => { onOrigin(null); setError(""); }}><RotateCcw size={14} />恢复设备坐标</Button>}
        <span className={`field-badge ${current || optical ? "green" : returnCandidate || missingOpticalOrigin ? "amber" : ""}`}>{current ? "作业零点已设置" : optical ? "设备坐标 · 光学零点已保留" : returnCandidate ? "作业原点已保存 · 待核验" : missingOpticalOrigin ? "公共光学零点待重设" : "设备坐标"}</span>
      </div>
      <div className="field-work-origin-angles" aria-label="当前作业角度">
        <span>俯仰 <output aria-label="作业俯仰角">{angleText(toWorkAngle(axes?.["1"]?.output_angle_deg, 1, current))}</output></span>
        <span>水平 <output aria-label="作业水平角">{angleText(toWorkAngle(axes?.["2"]?.output_angle_deg, 2, current))}</output></span>
      </div>
    </div>
    <p className="field-subtext">{current || optical ? "公共光学零点已设置。未校准测点先按尺寸定位，已校准测点沿用其首个点位；恢复设备坐标仅切换角度显示。" : returnCandidate ? "已保留原点坐标；回到原点前会重新读取并核验两轴参考位，无需在当前位置重新归零。" : missingOpticalOrigin ? "请重新将激光调至水平并正对叶轮中线，再设置归零；未单独校准的测点暂不能开始。" : "先将激光调至水平并正对叶轮中线，再设置归零。所有测点共用，归零不会校准某个测点，也不会移动转盘。"}</p>
    {returnCandidate && <p className="field-subtext" aria-label="保存的原点坐标">保存的原点（设备坐标）：俯仰 {angleText(returnCandidate.axis1AngleDeg)} · 水平 {angleText(returnCandidate.axis2AngleDeg)}</p>}
    {returnCandidate && motion && <p className="field-subtext" aria-label="回原点运动参数">回原点沿用自动跟随设置：转速上限 {motion.speedRpm} rpm · 加速度上限 {motion.maxMoveAccelerationDegS2} °/s² · 运动中误差上限 {motion.followErrorLimitDeg}°。到位精度仍为0.1°，修改后下次点击生效。</p>}
    {recoverySession !== null && <div className="field-notice warning" role="status">
      <span>上次轨迹触发跟随误差保护。原点坐标已保留，先清除旧轨迹后再定位。</span>{" "}
      <Button type="button" variant="outline" disabled={disabled || pending || !!returnPhase}
        onClick={() => void clearFailedOriginTrajectory()}>清除旧轨迹</Button>
    </div>}
    {motionError && <p className="field-error" role="alert">{motionError}</p>}
    {returnPhase && <p className="field-notice" role="status">{returnPhase === "checking" ? "正在检查两轴参考位与运动范围…" : returnPhase === "stopping" ? "正在停止回原点并核查停稳…" : returnPhase === "unconfirmed" ? "停止尚未确认，请现场核查；连接可用后可重试停止。" : "正在返回公共光学原点，请等待两轴停稳。"}</p>}
    {returnNotice && <p className="field-success" role="status">{returnNotice}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
