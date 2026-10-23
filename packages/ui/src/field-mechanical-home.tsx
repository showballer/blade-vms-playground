"use client";
import React, { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Crosshair, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { Button } from "./common";
import { isTurntablePort } from "./field-turntable-port";
import { fieldIsActive, fieldCanRequestTurntableRecovery, type FieldRequestOptions, type FieldStatus, type FieldTurntableHomingAction } from "./field-types";

const phases: Record<string, string> = { checking: "检查转盘", configuring_limits: "配置限位参考", seeking_limit: "寻找机械限位",
  positioning: "正在定位", stopping: "确认停止", complete: "已完成", cancelled: "已停止", error: "未完成" };
const angle = (value: number | null | undefined) => value != null && Number.isFinite(value) ? `${value.toFixed(3)}°` : "未读取";

export function FieldMechanicalHome({ port, status, disabled, request, onStatus, onBusy }: {
  port: string; status: FieldStatus | null; disabled: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>; onStatus: (status: FieldStatus) => void; onBusy: (busy: boolean) => void;
}) {
  const [speed, setSpeed] = useState("0.6"), [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const live = useRef({ port, generation: status?.service.generation }), alive = useRef(false), inFlight = useRef(false);
  live.current = { port, generation: status?.service.generation };
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusy(false); }; }, [onBusy]);
  useEffect(() => { setError(""); setNotice(""); }, [port, status?.service.generation]);
  const turntable = status?.turntable?.port === port ? status.turntable : undefined;
  const homing = turntable?.homing, running = homing?.state === "running" && !!status?.turntableBusy;
  const unavailable = disabled || status?.service.state !== "ready" || !isTurntablePort(port) || fieldIsActive(status) || !!status?.deviceBusy;
  const speedValid = speed.trim() !== "" && Number.isFinite(Number(speed)) && Number(speed) >= .2 && Number(speed) <= 1.5;
  const blocked = unavailable || pending || !!status?.turntableBusy || !speedValid;
  const yaw = turntable?.feedback?.axes?.["2"];
  const referenceBlocked = unavailable || pending || !!status?.turntableBusy || !yaw || yaw.motor_rpm !== 0 ||
    !!(yaw.flags & 16) || ![0, 3].includes(yaw.fault) || ![0, 7, 8].includes(yaw.home_phase);
  const clearReferenceBlocked = unavailable || pending || !fieldCanRequestTurntableRecovery(status, port);
  async function run(action: FieldTurntableHomingAction | "stop" | "reference" | "clear_axis1_reference") {
    if (inFlight.current || (action === "stop" ? unavailable || !running : action === "reference" ? referenceBlocked : action === "clear_axis1_reference" ? clearReferenceBlocked : blocked)) return;
    const selected = port, generation = status?.service.generation;
    inFlight.current = true; setPending(true); setError(""); setNotice(""); onBusy(true);
    try {
      const next = await request<FieldStatus>({ action: "turntable", request: { action, port: selected, axis: action === "reference" ? 2 : 1,
        ...(action === "clear_axis1_reference" ? { confirmRecovery: true } : { confirmMotion: true }),
        ...(action !== "stop" && action !== "reference" && action !== "clear_axis1_reference" ? { homingSpeedDegS: Number(speed) } : {}) } });
      if (!alive.current || live.current.port !== selected || live.current.generation !== generation || next.service.generation !== generation) return;
      if (next.turntable?.port !== selected || action !== "stop" && action !== "reference" && action !== "clear_axis1_reference" && next.turntable.homing?.action !== action)
        throw new Error("未收到回零操作状态，请重新检查转盘");
      if (action === "clear_axis1_reference") {
        const actual = next.turntable?.feedback?.axes?.["1"];
        if (next.turntable?.recovery?.action !== action || !next.turntable.recovery.verified || !actual ||
            actual.flags & 1 || actual.flags & 16 || actual.output_angle_deg != null || actual.motor_rpm !== 0)
          throw new Error("俯仰轴参考未确认清除，请重新检查");
        setNotice("俯仰轴参考已清除，水平轴参考保留。请机械回零后再回水平0°；旧作业原点和已校准点位需重新核验。");
      }
      if (action === "reference") {
        const actual = next.turntable?.feedback?.axes?.["2"];
        if (!actual || !(actual.flags & 1) || actual.flags & 16 || actual.fault || actual.motor_rpm ||
            actual.output_angle_deg == null || !Number.isFinite(actual.output_angle_deg) || Math.abs(actual.output_angle_deg) > .05)
          throw new Error("水平轴零点尚未读回确认，请重新检查");
        setNotice("水平轴当前位置已设为设备0°，未执行旋转。原作业零点和点位将按新参考重新核验。");
      }
      onStatus(next);
    } catch (cause) {
      if (alive.current && live.current.port === selected && live.current.generation === generation)
        setError(cause instanceof Error ? cause.message : "回零操作失败");
    } finally {
      inFlight.current = false;
      if (alive.current) { setPending(false); onBusy(false); }
    }
  }
  return <section className="field-work-origin field-mechanical-home" aria-label="转盘参考设置">
    <div className="field-work-origin-row">
      <div className="field-work-origin-actions">
        <strong>俯仰轴参考</strong>
        <Button type="button" variant="outline" disabled={blocked} title="向上寻找 DI0 上限位，建立俯仰轴 +35° 参考；不修改水平轴参考" onClick={() => void run("mechanical_home")}>
          <RotateCcw size={15} />机械回零</Button>
        <Button type="button" variant="outline" disabled={blocked} title="使用有效参考，将俯仰轴移到真实水平0°" onClick={() => void run("horizontal_zero")}>
          <CornerDownLeft size={15} />回水平 0°</Button>
        <Button type="button" variant="outline" disabled={clearReferenceBlocked} title="对应 app 的“清除电机1参考”：先取消待执行轨迹并停稳两轴；清除俯仰坐标和旧轨迹，不移动，不修改水平轴参考" onClick={() => void run("clear_axis1_reference")}>
          清除俯仰轴参考</Button>
        {running && <Button type="button" variant="danger" disabled={unavailable || pending} onClick={() => void run("stop")}><Square size={14} />停止回零</Button>}
        <label className="field-mechanical-home-speed">回零速度 · °/s <input aria-label="回零速度 · °/s" type="number" min="0.2" max="1.5" step="0.1" value={speed}
          disabled={unavailable || pending || !!status?.turntableBusy} onChange={event => setSpeed(event.target.value)} /></label>
      </div>
      {homing && <span className="field-badge" role="status">{(running || pending) && <LoaderCircle size={14} className="spin" />}
        {phases[homing.phase] || "读取回零状态"}{homing.verified ? ` · 俯仰 ${homing.targetAngleDeg}°` : ""}</span>}
    </div>
    <div className="field-work-origin-row"><div className="field-work-origin-actions">
      <strong>水平轴参考</strong>
      <Button type="button" variant="outline" disabled={referenceBlocked} title="将当前左右朝向确认为水平轴设备0°；不移动转盘，也不修改俯仰轴参考" onClick={() => void run("reference")}>
        <Crosshair size={15} />确认水平轴为 0°</Button>
      <span className="field-subtext">角度 {angle(yaw?.output_angle_deg)} · 只设参考，不转动</span>
    </div></div>
    <p className="field-subtext">机械回零向上寻找 +35° 限位；回水平 0° 后对准风机中线，再用“设置归零”建立作业原点。</p>
    <p className="field-subtext">清除俯仰轴参考用于重新建立设备角度，之后须机械回零；日常采集无需清除。</p>
    {homing && <p className="field-subtext">设备坐标：俯仰 {angle(turntable?.feedback?.axes?.["1"]?.output_angle_deg)} · 水平 {angle(turntable?.feedback?.axes?.["2"]?.output_angle_deg)}</p>}
    {!isTurntablePort(port) && <p className="field-subtext">请先配置转盘连接。</p>}
    {!speedValid && <p className="field-error" role="alert">回零速度范围为 0.2～1.5 °/s。</p>}
    {(error || homing && turntable?.error) && <p className="field-error" role="alert">{error || turntable?.error}</p>}
    {notice && <p className="field-success" role="status">{notice}</p>}
  </section>;
}
