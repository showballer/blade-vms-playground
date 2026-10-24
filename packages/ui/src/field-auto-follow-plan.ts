import type { FieldMotionMode, FieldPointCycleConfig, FieldPointCyclePoint } from "./field-types";
import { isTurntablePort } from "./field-turntable-port";
import { pointReferenceSignature } from "./field-turntable-points";
import type { FieldWorkOrigin } from "./field-turntable-origin";

export type AutoFollowDraft = {
  // Zero means the operator rotates the real blade; no nominal phase is inferred.
  diagnosticDetectBeforeSettled?: boolean; diagnosticAngleWindowDeg?: number;
  bladeId: string; periodSeconds: number; stepDeg: number;
  points: { id: string; name: string; radiusM: number }[]; activePointId: string;
  distanceM: number; hubHeightDeltaM: number;
  direction: "clockwise" | "counterclockwise"; axis1Sign: 1 | -1; axis2Sign: 1 | -1;
  maxMoveRpm: number; maxMoveAccelerationDegS2: number; followErrorLimitDeg: number; cycles: number; waitRevolutions: number;
  rssiEnterSpread: number; rssiExitSpread: number; rssiEnterConfirmMs: number; rssiConfirmMs: number;
};
export type AutoFollowAnchor = {
  port: string; referenceSignature: string; radiusM: number; pointId: string;
  axis1AngleDeg: number; axis2AngleDeg: number;
};
export const autoFollowDefaults: AutoFollowDraft = {
  diagnosticDetectBeforeSettled: false, diagnosticAngleWindowDeg: 0,
  bladeId: "2", periodSeconds: 30, stepDeg: 90,
  points: [{ id: "p1", name: "P1", radiusM: 0.31 }], activePointId: "p1",
  distanceM: 2.86, hubHeightDeltaM: 1.46, direction: "clockwise", axis1Sign: 1, axis2Sign: 1,
  maxMoveRpm: 0.6, maxMoveAccelerationDegS2: 3, followErrorLimitDeg: .75, cycles: 1, waitRevolutions: 2,
  rssiEnterSpread: 8, rssiExitSpread: 3, rssiEnterConfirmMs: 20, rssiConfirmMs: 30,
};
export const manualBladeRotationWaitSeconds = 60;
export type AutoFollowPlan = {
  errors: string[]; points: FieldPointCyclePoint[]; pointCycle?: FieldPointCycleConfig;
  origin: "theoretical" | "work_zero" | "calibrated";
  nominalRpm: number; stationsPerPoint: number; totalRecords: number;
  speedRpm: number; requiredRpm: number; maxTravelLowerBoundSeconds: number;
  motionMode: FieldMotionMode | "unknown"; plannedMoveSeconds: number;
  intervalSeconds: number; mayMissNextPass: boolean;
  manualRotation: boolean;
};
const finite = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
const round = (value: number) => Number(value.toFixed(6));

/** Ideal pointing angles; six o'clock is zero phase, clockwise is from laser to rotor. */
export function stationOpticalAngles(distanceM: number, heightM: number, radiusM: number, azimuthDeg: number,
  direction: AutoFollowDraft["direction"]) {
  const phase = azimuthDeg * Math.PI / 180;
  const x = (direction === "clockwise" ? -1 : 1) * radiusM * Math.sin(phase);
  const y = heightM - radiusM * Math.cos(phase);
  return { pitch: Math.atan2(y, Math.hypot(distanceM, x)) * 180 / Math.PI,
    yaw: Math.atan2(x, distanceM) * 180 / Math.PI };
}

/** Planning has no I/O and cannot establish reference validity, identity or arrival timing. */
export function planAutoFollow(draft: AutoFollowDraft, anchor: AutoFollowAnchor | null,
  motionMode: FieldMotionMode | "unknown" = "unknown", port = "", opticalOrigin?: FieldWorkOrigin | null): AutoFollowPlan {
  const errors: string[] = [];
  const count = 360 / draft.stepDeg;
  const manualRotation = draft.periodSeconds === 0;
  if (!draft.bladeId.trim() || draft.bladeId.trim().length > 80) errors.push("请填写叶片编号（最多80字）");
  if (!manualRotation && !finite(draft.periodSeconds, 0.5, 3600)) errors.push("每圈时间填0表示人手转动，或填写0.5～3600秒");
  if (!finite(draft.stepDeg, 5, 180) || !Number.isInteger(count)) errors.push("圆周间隔须能整分360°，范围5～180°");
  if (Number.isInteger(count) && count > 16) errors.push("每个测点最多预存16个圆周点位，请将间隔设为22.5°或更大");
  if (!finite(draft.distanceM, 0.001, 10000) || !finite(draft.hubHeightDeltaM, -10000, 10000)) errors.push("请检查安装距离和高度差");
  if (![1, -1].includes(draft.axis1Sign) || ![1, -1].includes(draft.axis2Sign) || !["clockwise", "counterclockwise"].includes(draft.direction)) errors.push("请确认旋向和转盘轴方向");
  if (!finite(draft.maxMoveRpm, 0.02, 10)) errors.push("换点速度上限应为0.02～10 rpm");
  if (!finite(draft.maxMoveAccelerationDegS2, 0.1, 120)) errors.push("换点加速度上限应为0.1～120 °/s²");
  if (!finite(draft.diagnosticAngleWindowDeg ?? 0, 0, 10)) errors.push("未停稳判定角度范围应为0～10°，0表示不限制");
  if (!finite(draft.followErrorLimitDeg, .5, 10)) errors.push("运动中跟随误差上限应为0.5～10°，不能设为0关闭；到位容差为0.5°");
  if (!Number.isInteger(draft.cycles) || !finite(draft.cycles, 1, 100)) errors.push("重复采样圈数应为1～100");
  if (!manualRotation && (!finite(draft.waitRevolutions, 1, 10) || draft.waitRevolutions * draft.periodSeconds > 3600)) errors.push("单站等待时间应为1～10个周期且不超过3600秒");
  if (!finite(draft.rssiEnterSpread, 0.1, 100) || !finite(draft.rssiExitSpread, 0, 99.9) || draft.rssiExitSpread >= draft.rssiEnterSpread) errors.push("进入阈值必须大于离开阈值");
  if (!finite(draft.rssiEnterConfirmMs, 10, 1000) || !finite(draft.rssiConfirmMs, 10, 1000)) errors.push("回波确认时间应为10～1000毫秒");
  const selected = draft.points.filter(point => point.id === draft.activePointId);
  const radial = selected.length === 1 ? selected[0] : undefined;
  if (!radial) errors.push("请选择本次采集测点");
  else {
    if (!radial.id || radial.id.length > 80) errors.push("当前测点编号无效");
    if (!radial.name.trim() || radial.name.trim().length > 80 || !finite(radial.radiusM, 0.001, 1000)) errors.push("请填写当前测点名称和有效半径");
  }
  if (count > 200 || count * draft.cycles > 2000) errors.push("每轮最多200个点位、每次任务最多2000条记录");
  const base = anchor ? null : opticalOrigin;
  const result: AutoFollowPlan = { errors, points: [], origin: anchor ? "calibrated" : base ? "work_zero" : "theoretical", nominalRpm: manualRotation ? 0 : 60 / draft.periodSeconds,
    stationsPerPoint: Number.isInteger(count) ? count : 0, totalRecords: radial ? count * draft.cycles : 0,
    speedRpm: 0, requiredRpm: 0, maxTravelLowerBoundSeconds: 0, motionMode, plannedMoveSeconds: 0,
    intervalSeconds: draft.periodSeconds * draft.stepDeg / 360, mayMissNextPass: false, manualRotation };
  if (errors.length || !radial) return result;
  if (anchor && (!isTurntablePort(anchor.port) || !pointReferenceSignature(anchor) ||
      !finite(anchor.radiusM, 0.001, 1000) || !finite(anchor.axis1AngleDeg, -35, 35) || !finite(anchor.axis2AngleDeg, -180, 180))) {
    errors.push("当前测点校准信息无效，请重新校准起点"); return result;
  }
  if (anchor && (anchor.pointId !== radial.id || Math.abs(anchor.radiusM - radial.radiusM) > 1e-9)) { errors.push("当前测点已变化，请重新校准起点"); return result; }
  if (opticalOrigin && (!isTurntablePort(opticalOrigin.port) || port && opticalOrigin.port !== port ||
      anchor && opticalOrigin.port !== anchor.port || !pointReferenceSignature(opticalOrigin) ||
      !Number.isSafeInteger(opticalOrigin.generation) || opticalOrigin.generation < 0 ||
      !finite(opticalOrigin.axis1AngleDeg, -35, 35) || !finite(opticalOrigin.axis2AngleDeg, -180, 180))) {
    errors.push("共用光学零点无效或与当前串口不匹配，请重新设置归零"); return result;
  }
  const capturePort = anchor?.port || base?.port || port;
  if (!anchor && !isTurntablePort(capturePort)) errors.push("请选择有效的转盘串口");
  const origin = stationOpticalAngles(draft.distanceM, draft.hubHeightDeltaM, anchor?.radiusM ?? radial.radiusM, 0, draft.direction);
  const originAxis1 = anchor?.axis1AngleDeg ?? (base?.axis1AngleDeg ?? 0) + draft.axis1Sign * origin.pitch;
  const originAxis2 = anchor?.axis2AngleDeg ?? (base?.axis2AngleDeg ?? 0);
  for (let station = 0; station < count; station++) {
    const azimuthDeg = station * draft.stepDeg;
    const optical = stationOpticalAngles(draft.distanceM, draft.hubHeightDeltaM, radial.radiusM, azimuthDeg, draft.direction);
    const axis1AngleDeg = round(anchor ? originAxis1 + draft.axis1Sign * (optical.pitch - origin.pitch)
      : (base?.axis1AngleDeg ?? 0) + draft.axis1Sign * optical.pitch);
    const axis2AngleDeg = round(anchor ? originAxis2 + draft.axis2Sign * (optical.yaw - origin.yaw)
      : (base?.axis2AngleDeg ?? 0) + draft.axis2Sign * optical.yaw);
    if (!finite(axis1AngleDeg, -35, 35) || !finite(axis2AngleDeg, -180, 180)) errors.push(`${radial.name} ${azimuthDeg}°目标超出机械角度范围`);
    result.points.push({ pointId: `${radial.id}-s${station + 1}`, name: `${radial.name.trim()} · ${azimuthDeg}°`,
      port: capturePort, ...(anchor || base ? { referenceSignature: (anchor || base)!.referenceSignature } : {}), axis1AngleDeg, axis2AngleDeg,
      bladeId: draft.bladeId.trim(), radialPointId: radial.id, radialPointName: radial.name.trim(), radiusM: radial.radiusM, azimuthDeg });
  }
  // The controller's confirmed timed mode uses a rest-to-rest cubic profile.
  // Unknown capability keeps the conservative sequential budget until the device is read.
  let maxTravel = 0;
  for (let i = 0; i < result.points.length; i++) {
    const from = result.points[i], to = result.points[(i + 1) % result.points.length];
    const one = Math.abs(to.axis1AngleDeg - from.axis1AngleDeg), two = Math.abs(to.axis2AngleDeg - from.axis2AngleDeg);
    maxTravel = Math.max(maxTravel, (motionMode === "dual_axis_timed" || motionMode === "drive_internal") ? Math.max(one, two) : one + two);
  }
  if (!manualRotation) {
    const needed = maxTravel * (motionMode === "dual_axis_timed" ? 1.5 * 1.05 : 1) / (6 * result.intervalSeconds * 0.5);
    result.requiredRpm = Math.max(0.02, Math.ceil((needed - 1e-10) / 0.02) * 0.02);
  }
  const ceiling = draft.maxMoveRpm;
  const cap = Math.floor((ceiling + 1e-10) / 0.02) * 0.02;
  result.speedRpm = round(manualRotation || motionMode === "drive_internal" ? cap : Math.min(cap, result.requiredRpm));
  result.maxTravelLowerBoundSeconds = maxTravel / (6 * result.speedRpm);
  // s(u)=3u²−2u³: peak speed=1.5Δ/T; peak acceleration=6Δ/T².
  // Baseline estimate only: backend checks wire-quantized points and may extend duration.
  // Use the same configured acceleration cap as the backend, plus its timing margin.
  const acceleration = Math.floor((draft.maxMoveAccelerationDegS2 + 1e-10) * 1000) / 1000;
  result.plannedMoveSeconds = motionMode === "dual_axis_timed"
    ? Math.ceil(Math.max(1, 1.5 * maxTravel / (6 * result.speedRpm), Math.sqrt(6 * maxTravel / acceleration)) * 1.05 * 1000) / 1000
    : result.maxTravelLowerBoundSeconds;
  result.mayMissNextPass = !manualRotation && result.plannedMoveSeconds > result.intervalSeconds * 0.5 + 1e-9;
  if (!errors.length) result.pointCycle = {
    mode: "automatic_stations", port: capturePort, points: result.points,
    startAtCurrentPose: !!anchor,
    returnToOrigin: { name: "作业原点", port: capturePort,
      axis1AngleDeg: opticalOrigin?.axis1AngleDeg ?? 0, axis2AngleDeg: opticalOrigin?.axis2AngleDeg ?? 0,
      ...(opticalOrigin || anchor ? { referenceSignature: (opticalOrigin || anchor)!.referenceSignature } : {}) },
    nominalPeriodSeconds: draft.periodSeconds, maxMoveRpm: manualRotation ? result.speedRpm : draft.maxMoveRpm,
    maxMoveAccelerationDegS2: draft.maxMoveAccelerationDegS2,
    followErrorLimitDeg: draft.followErrorLimitDeg,
    geometry: { distanceM: draft.distanceM, hubHeightDeltaM: draft.hubHeightDeltaM,
      rotationDirection: draft.direction, axis1Sign: draft.axis1Sign, axis2Sign: draft.axis2Sign,
      anchorRadiusM: anchor?.radiusM ?? radial.radiusM, anchorAxis1AngleDeg: originAxis1, anchorAxis2AngleDeg: originAxis2 },
    cycles: draft.cycles, dwellSeconds: manualRotation ? manualBladeRotationWaitSeconds : Math.max(1, draft.periodSeconds * draft.waitRevolutions), speedRpm: result.speedRpm,
    rssiTriggerEnabled: true, rssiSmoothingMs: 10, rssiMinimumSeconds: 0,
    rssiEnterSpread: draft.rssiEnterSpread, rssiExitSpread: draft.rssiExitSpread,
    rssiEnterConfirmMs: draft.rssiEnterConfirmMs, rssiConfirmMs: draft.rssiConfirmMs,
    motionLaserPolicy: "continuous",
    diagnosticDetectBeforeSettled: draft.diagnosticDetectBeforeSettled === true,
    diagnosticAngleWindowDeg: draft.diagnosticAngleWindowDeg ?? 0,
  };
  return result;
}
