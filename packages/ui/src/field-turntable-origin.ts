import { fieldIsActive, type FieldAxisFeedback, type FieldStatus } from "./field-types";
import { isTurntablePort } from "./field-turntable-port";
import { pointReferenceSignature, turntableAxisLimitsError, turntableReferenceSignature } from "./field-turntable-points";

/** A session-local display/target offset. It never changes the controller's reference or stored absolute points. */
export type FieldWorkOrigin = {
  port: string; referenceSignature: string; generation: number;
  axis1AngleDeg: number; axis2AngleDeg: number;
  verificationRequired?: boolean;
};
export const workOriginStorageKey = "blade-turntable-work-origins-v1";
type StopStatus = NonNullable<FieldStatus["turntable"]> & { stopConfirmed?: boolean };
const validGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const limitFor = (axis: 1 | 2) => axis === 1 ? 35 : 180;
const normalized = (value: number) => {
  if (!Number.isFinite(value)) return value;
  const result = Number(value.toPrecision(12));
  return Object.is(result, -0) ? 0 : result;
};
const offsetFor = (axis: 1 | 2, origin?: FieldWorkOrigin | null) => origin ? axis === 1 ? origin.axis1AngleDeg : origin.axis2AngleDeg : 0;

function referenced(value: FieldAxisFeedback | undefined): value is FieldAxisFeedback {
  return !!value && Number.isSafeInteger(value.flags) && value.flags >= 0 && value.flags <= 65535 && !!(value.flags & 1) &&
    value.output_angle_deg !== null && Number.isFinite(value.output_angle_deg) && value.display_mode === 3 &&
    Number.isSafeInteger(value.command_counts_per_rev) && value.command_counts_per_rev > 0;
}

function stopUnknown(status: FieldStatus): boolean {
  const turntable = status.turntable as StopStatus | undefined;
  const axes = turntable?.feedback?.axes;
  return !!status.turntableWarning || !!turntable?.error || turntable?.state === "unknown" ||
    (turntable?.stopConfirmed === false && !status.turntableBusy && !fieldIsActive(status)) ||
    !!axes && [1, 2].some(axis => !!(axes[String(axis)]?.flags & 16)) ||
    turntable?.feedback?.limitFlags != null && turntable.feedback.limitFlags !== 0;
}

function originValid(origin: FieldWorkOrigin): boolean {
  return isTurntablePort(origin.port) && validGeneration(origin.generation) &&
    !!pointReferenceSignature(origin) && Number.isFinite(origin.axis1AngleDeg) && Math.abs(origin.axis1AngleDeg) <= 35 &&
    Number.isFinite(origin.axis2AngleDeg) && Math.abs(origin.axis2AngleDeg) <= 180;
}

/** A saved offset may build a plan while feedback is absent. It grants no
 * motion permission: its original reference signature must pass a fresh probe. */
export function workOriginForPlanning(origin: FieldWorkOrigin | null | undefined, port: string): FieldWorkOrigin | null {
  return origin && originValid(origin) && origin.port === port ? origin : null;
}

/** Saved coordinates survive page/app reloads. A stored
 * origin is only a candidate until the current reference checks accept it. */
export function readSavedWorkOrigins(raw: string | null): { work: FieldWorkOrigin | null; optical: FieldWorkOrigin | null } {
  try {
    const saved = JSON.parse(raw || "null");
    const read = (value: unknown) => value && typeof value === "object" && originValid(value as FieldWorkOrigin)
      ? { ...value as FieldWorkOrigin, verificationRequired: true } : null;
    if (saved?.version === 1) return { work: read(saved.work), optical: read(saved.optical) };
  } catch { /* No invalid saved value becomes a motion target. */ }
  return { work: null, optical: null };
}

/** Re-check the saved target against a NEW stopped probe, without redefining it
 * from the current pose or writing a hardware reference. */
export function revalidateWorkOrigin(origin: FieldWorkOrigin, status: FieldStatus, port: string): FieldWorkOrigin {
  if (!originValid(origin) || origin.port !== port) throw new Error("保存的作业原点与当前串口不一致");
  const checked = createWorkOrigin(status, port);
  if (checked.referenceSignature !== origin.referenceSignature) throw new Error("两轴参考位或计数单位已变化，不能使用保存的作业原点");
  return { ...origin, generation: checked.generation, verificationRequired: false };
}

/** Recover the origin lost by older renderers only from an explicitly computed
 * (not point-calibrated) live session. Its recorded anchor includes the original
 * work offset; current angles must never be substituted for that offset. */
export function recoverCalculatedWorkOrigin(status: FieldStatus | null): FieldWorkOrigin | null {
  if (!status || fieldIsActive(status) || !validGeneration(status.service.generation)) return null;
  const record = status.recording as unknown as { pointCycle?: { sessionId?: string; referenceSignature?: string };
    turntable?: { config?: { mode?: string; startAtCurrentPose?: boolean; port?: string; geometry?: {
      distanceM: number; hubHeightDeltaM: number; anchorRadiusM: number; anchorAxis1AngleDeg: number; anchorAxis2AngleDeg: number; axis1Sign: number } } } } | undefined;
  const config = record?.turntable?.config, geometry = config?.geometry;
  if (config?.mode !== "automatic_stations" || config.startAtCurrentPose !== false || !geometry ||
      !record?.pointCycle?.sessionId || record.pointCycle.sessionId !== status.pointCycle?.sessionId ||
      ![geometry.distanceM, geometry.hubHeightDeltaM, geometry.anchorRadiusM, geometry.anchorAxis1AngleDeg, geometry.anchorAxis2AngleDeg].every(Number.isFinite) ||
      geometry.distanceM <= 0 || geometry.anchorRadiusM <= 0 || ![1, -1].includes(geometry.axis1Sign)) return null;
  const origin = { port: config.port!, generation: status.service.generation, referenceSignature: record.pointCycle.referenceSignature!,
    axis1AngleDeg: normalized(geometry.anchorAxis1AngleDeg - geometry.axis1Sign *
      Math.atan2(geometry.hubHeightDeltaM - geometry.anchorRadiusM, geometry.distanceM) * 180 / Math.PI),
    axis2AngleDeg: geometry.anchorAxis2AngleDeg };
  return originValid(origin) && matchingWorkOrigin(origin, status, origin.port) ? origin : null;
}

/** Call only with the result of a new read-only probe, never a remembered polling snapshot. */
export function createWorkOrigin(status: FieldStatus, port: string): FieldWorkOrigin {
  if (!isTurntablePort(port) || status.turntable?.port !== port) throw new Error("转盘串口无效或读取结果不匹配，请重新读取");
  if (status.service.state !== "ready" || !validGeneration(status.service.generation)) throw new Error("采集服务或代际信息无效，请重新读取");
  if (fieldIsActive(status) || status.deviceBusy || status.turntableBusy) throw new Error("采集或转盘任务尚未结束，请停稳后设置作业零点");
  if (status.deviceWarning || status.turntableWarning || status.turntable.error) throw new Error("设备状态尚未确认，请先处理设备提示");
  if (status.turntable.state !== "checked" || stopUnknown(status)) throw new Error("两轴停止状态未确认，请重新读取反馈");
  const trajectory = status.turntable.motionCapability?.status;
  if (trajectory?.state === 2 && trajectory.fault === 0)
    throw new Error("控制器保留待执行轨迹，请在“转盘状态”中点击“取消待执行轨迹”后重试");
  if (trajectory?.state === 7 && trajectory.fault === 7)
    throw new Error("上次定位触发跟随误差保护，请先清除旧轨迹。原点坐标已保留，无需重新设置归零");
  if (trajectory && (!Number.isInteger(trajectory.state) || ![0, 6, 8].includes(Number(trajectory.state)) ||
      !Number.isInteger(trajectory.fault) || ![0, 1].includes(Number(trajectory.fault)))) throw new Error("控制器轨迹仍待执行、运行或存在故障，请先停止并核查");
  const feedback = status.turntable.feedback;
  if (!feedback || feedback.motorRpm !== 0 || feedback.outputRpm !== 0 || feedback.alarmCode !== 0 ||
      feedback.limitFlags != null && feedback.limitFlags !== 0)
    throw new Error("转盘仍在运动、报警或停止状态未知，不能设置作业零点");
  const axes = feedback.axes;
  for (const axis of [1, 2] as const) {
    const value = axes?.[String(axis)];
    if (!referenced(value)) throw new Error(`轴${axis}缺少有效参考位或反馈单位，请先读取真实参考`);
    if (value.motor_rpm !== 0 || value.fault !== 0 || value.flags & 16 || ![0, 7, 8].includes(value.home_phase))
      throw new Error(`轴${axis}未确认静止、故障已清除且回零结束`);
    if (value.guard?.soft_enabled && !(value.flags & 2)) throw new Error(`轴${axis}软限位反馈无效`);
    const invalid = turntableAxisLimitsError(value, axis);
    if (invalid) throw new Error(invalid);
  }
  const signature = turntableReferenceSignature(axes);
  if (!signature) throw new Error("两轴参考位签名无效，请重新读取");
  return { port, generation: status.service.generation, referenceSignature: signature,
    axis1AngleDeg: axes!["1"].output_angle_deg!, axis2AngleDeg: axes!["2"].output_angle_deg! };
}

/** Normal motion does not discard a display origin; reference loss or an unknown stop does. */
export function matchingWorkOrigin(origin: FieldWorkOrigin | null | undefined, status: FieldStatus | null, port: string): FieldWorkOrigin | null {
  if (!origin || origin.verificationRequired || !status || !originValid(origin) || !isTurntablePort(port) || origin.port !== port || status.turntable?.port !== port ||
      status.service.state !== "ready" || !validGeneration(status.service.generation) || origin.generation !== status.service.generation || stopUnknown(status)) return null;
  const axes = status.turntable.feedback?.axes;
  if (![1, 2].every(axis => referenced(axes?.[String(axis)])) || turntableReferenceSignature(axes) !== origin.referenceSignature) return null;
  return origin;
}

export function toWorkAngle(value: number | null | undefined, axis: 1 | 2, origin?: FieldWorkOrigin | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const result = value - offsetFor(axis, origin);
  return Number.isFinite(result) ? normalized(result) : null;
}

export function toDeviceAngle(relative: number, axis: 1 | 2, origin?: FieldWorkOrigin | null): number {
  return normalized(relative + offsetFor(axis, origin));
}

/** Product envelope only; enabled controller soft limits must still be checked in absolute coordinates. */
export function workAngleBounds(axis: 1 | 2, origin?: FieldWorkOrigin | null): { min: number; max: number } {
  const limit = limitFor(axis), offset = offsetFor(axis, origin);
  return { min: normalized(-limit - offset), max: normalized(limit - offset) };
}
