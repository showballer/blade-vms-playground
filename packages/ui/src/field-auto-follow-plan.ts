import type { FieldPointCycleConfig, FieldPointCyclePoint } from "./field-types";
import { isTurntablePort } from "./field-turntable-port";
import { pointReferenceSignature } from "./field-turntable-points";

export type AutoFollowDraft = {
  bladeId: string; periodSeconds: number; stepDeg: number;
  points: { id: string; name: string; radiusM: number }[];
  distanceM: number; hubHeightDeltaM: number;
  direction: "clockwise" | "counterclockwise"; axis1Sign: 1 | -1; axis2Sign: 1 | -1;
  maxMoveRpm: number; cycles: number; waitRevolutions: number;
  rssiEnterSpread: number; rssiExitSpread: number; rssiEnterConfirmMs: number; rssiConfirmMs: number;
};
export type AutoFollowAnchor = {
  port: string; referenceSignature: string; radiusM: number;
  axis1AngleDeg: number; axis2AngleDeg: number;
};
export const autoFollowDefaults: AutoFollowDraft = {
  bladeId: "2", periodSeconds: 30, stepDeg: 90,
  points: [{ id: "p1", name: "P1", radiusM: 0.31 }],
  distanceM: 2.86, hubHeightDeltaM: 1.46, direction: "clockwise", axis1Sign: 1, axis2Sign: 1,
  maxMoveRpm: 0.6, cycles: 1, waitRevolutions: 2,
  rssiEnterSpread: 8, rssiExitSpread: 3, rssiEnterConfirmMs: 20, rssiConfirmMs: 30,
};
export type AutoFollowPlan = {
  errors: string[]; points: FieldPointCyclePoint[]; pointCycle?: FieldPointCycleConfig;
  nominalRpm: number; stationsPerPoint: number; totalRecords: number;
  speedRpm: number; requiredRpm: number; maxTravelLowerBoundSeconds: number;
  intervalSeconds: number; mayMissNextPass: boolean;
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
export function planAutoFollow(draft: AutoFollowDraft, anchor: AutoFollowAnchor | null): AutoFollowPlan {
  const errors: string[] = [];
  const count = 360 / draft.stepDeg;
  if (!draft.bladeId.trim() || draft.bladeId.trim().length > 80) errors.push("请填写叶片编号（最多80字）");
  if (!finite(draft.periodSeconds, 0.5, 3600)) errors.push("每圈时间应为0.5～3600秒");
  if (!finite(draft.stepDeg, 5, 180) || !Number.isInteger(count)) errors.push("圆周间隔须能整分360°，范围5～180°");
  if (!finite(draft.distanceM, 0.001, 10000) || !finite(draft.hubHeightDeltaM, -10000, 10000)) errors.push("请检查安装距离和高度差");
  if (![1, -1].includes(draft.axis1Sign) || ![1, -1].includes(draft.axis2Sign) || !["clockwise", "counterclockwise"].includes(draft.direction)) errors.push("请确认旋向和转盘轴方向");
  if (!finite(draft.maxMoveRpm, 0.02, 10)) errors.push("换点速度上限应为0.02～10 rpm");
  if (!Number.isInteger(draft.cycles) || !finite(draft.cycles, 1, 100)) errors.push("重复采样圈数应为1～100");
  if (!finite(draft.waitRevolutions, 1, 10) || draft.waitRevolutions * draft.periodSeconds > 3600) errors.push("单站等待时间应为1～10个周期且不超过3600秒");
  if (!finite(draft.rssiEnterSpread, 0.1, 100) || !finite(draft.rssiExitSpread, 0, 99.9) || draft.rssiExitSpread >= draft.rssiEnterSpread) errors.push("进入阈值必须大于离开阈值");
  if (!finite(draft.rssiEnterConfirmMs, 10, 1000) || !finite(draft.rssiConfirmMs, 10, 1000)) errors.push("回波确认时间应为10～1000毫秒");
  const ids = new Set<string>();
  if (!draft.points.length) errors.push("请至少添加一个叶片测点");
  for (const point of draft.points) {
    if (!point.id || ids.has(point.id) || point.id.length > 80) errors.push("测点编号须唯一且不超过80字");
    ids.add(point.id);
    if (!point.name.trim() || point.name.trim().length > 80 || !finite(point.radiusM, 0.001, 1000)) errors.push("每个测点须填写名称和有效半径");
  }
  if (count * draft.points.length > 200 || count * draft.points.length * draft.cycles > 2000) errors.push("每轮最多200个站位、每次任务最多2000条记录");
  const result: AutoFollowPlan = { errors, points: [], nominalRpm: 60 / draft.periodSeconds,
    stationsPerPoint: Number.isInteger(count) ? count : 0, totalRecords: count * draft.points.length * draft.cycles,
    speedRpm: 0, requiredRpm: 0, maxTravelLowerBoundSeconds: 0,
    intervalSeconds: draft.periodSeconds * draft.stepDeg / 360, mayMissNextPass: false };
  if (errors.length) return result;
  if (!anchor || !isTurntablePort(anchor.port) || !pointReferenceSignature(anchor) ||
      !finite(anchor.radiusM, 0.001, 1000) || !finite(anchor.axis1AngleDeg, -35, 35) || !finite(anchor.axis2AngleDeg, -180, 180)) {
    errors.push("请先将首个测点置于6点方向，完成瞄准后读取两轴参考"); return result;
  }
  if (Math.abs(anchor.radiusM - draft.points[0].radiusM) > 1e-9) { errors.push("首测点半径已变化，请重新读取瞄准参考"); return result; }
  const origin = stationOpticalAngles(draft.distanceM, draft.hubHeightDeltaM, anchor.radiusM, 0, draft.direction);
  for (const radial of draft.points) for (let station = 0; station < count; station++) {
    const azimuthDeg = station * draft.stepDeg;
    const optical = stationOpticalAngles(draft.distanceM, draft.hubHeightDeltaM, radial.radiusM, azimuthDeg, draft.direction);
    const axis1AngleDeg = round(anchor.axis1AngleDeg + draft.axis1Sign * (optical.pitch - origin.pitch));
    const axis2AngleDeg = round(anchor.axis2AngleDeg + draft.axis2Sign * (optical.yaw - origin.yaw));
    if (!finite(axis1AngleDeg, -35, 35) || !finite(axis2AngleDeg, -180, 180)) errors.push(`${radial.name} ${azimuthDeg}°目标超出机械角度范围`);
    result.points.push({ pointId: `${radial.id}-s${station + 1}`, name: `${radial.name.trim()} · ${azimuthDeg}°`,
      port: anchor.port, referenceSignature: anchor.referenceSignature, axis1AngleDeg, axis2AngleDeg,
      bladeId: draft.bladeId.trim(), radialPointId: radial.id, radialPointName: radial.name.trim(), radiusM: radial.radiusM, azimuthDeg });
  }
  // Sequential-axis motion uses the SUM of angular travel. This excludes acceleration,
  // feedback round trips and DAQ startup, and therefore is explicitly only a lower bound.
  let maxTravel = 0;
  for (let i = 0; i < result.points.length; i++) {
    const from = result.points[i], to = result.points[(i + 1) % result.points.length];
    maxTravel = Math.max(maxTravel, Math.abs(to.axis1AngleDeg - from.axis1AngleDeg) + Math.abs(to.axis2AngleDeg - from.axis2AngleDeg));
  }
  const needed = maxTravel / (6 * result.intervalSeconds * 0.5);
  result.requiredRpm = Math.max(0.02, Math.ceil((needed - 1e-10) / 0.02) * 0.02);
  const cap = Math.floor((draft.maxMoveRpm + 1e-10) / 0.02) * 0.02;
  result.speedRpm = round(Math.min(cap, result.requiredRpm));
  result.maxTravelLowerBoundSeconds = maxTravel / (6 * result.speedRpm);
  result.mayMissNextPass = result.requiredRpm > result.speedRpm + 1e-9;
  if (!errors.length) result.pointCycle = {
    mode: "automatic_stations", port: anchor.port, points: result.points,
    nominalPeriodSeconds: draft.periodSeconds, maxMoveRpm: draft.maxMoveRpm,
    geometry: { distanceM: draft.distanceM, hubHeightDeltaM: draft.hubHeightDeltaM,
      rotationDirection: draft.direction, axis1Sign: draft.axis1Sign, axis2Sign: draft.axis2Sign,
      anchorRadiusM: anchor.radiusM, anchorAxis1AngleDeg: anchor.axis1AngleDeg, anchorAxis2AngleDeg: anchor.axis2AngleDeg },
    cycles: draft.cycles, dwellSeconds: Math.max(1, draft.periodSeconds * draft.waitRevolutions), speedRpm: result.speedRpm,
    rssiTriggerEnabled: true, rssiSmoothingMs: 10, rssiMinimumSeconds: 0,
    rssiEnterSpread: draft.rssiEnterSpread, rssiExitSpread: draft.rssiExitSpread,
    rssiEnterConfirmMs: draft.rssiEnterConfirmMs, rssiConfirmMs: draft.rssiConfirmMs,
    keepLaserOnBetweenPoints: true,
  };
  return result;
}
