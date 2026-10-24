import { planAutoFollow, type AutoFollowAnchor, type AutoFollowDraft, type AutoFollowPlan } from "./field-auto-follow-plan";
import type { FieldMotionMode, FieldPointCyclePoint } from "./field-types";
import type { FieldWorkOrigin } from "./field-turntable-origin";
import type { FieldCaptureRoute } from "./field-capture-route";

export type SegmentSettings = { pointsPerStart: 1 | 2; stepDeg: number; startAzimuthDeg: number };
export const segmentedStorageKey = "blade-segmented-capture-v1";
export const segmentedPairStepDeg = 90;
export const segmentedDefaults: SegmentSettings = { pointsPerStart: 1, stepDeg: 90, startAzimuthDeg: 0 };
export function readSegmentSettings(raw: string | null, fallbackStepDeg = 90): SegmentSettings {
  const result = { ...segmentedDefaults, stepDeg: fallbackStepDeg };
  try {
    const saved = JSON.parse(raw || "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return result;
    for (const key of ["pointsPerStart", "stepDeg", "startAzimuthDeg"] as const) {
      if (Object.prototype.hasOwnProperty.call(saved, key))
        Object.assign(result, { [key]: typeof saved[key] === "number" ? saved[key] : NaN });
    }
  } catch { /* Optional settings never restore a running capture. */ }
  if (result.pointsPerStart === 2) {
    result.stepDeg = segmentedPairStepDeg;
    if (!Number.isFinite(result.startAzimuthDeg) || result.startAzimuthDeg < 0 || result.startAzimuthDeg >= 360 || result.startAzimuthDeg % segmentedPairStepDeg !== 0)
      result.startAzimuthDeg = 0;
  }
  return result;
}

export type SegmentedFollowPlan = AutoFollowPlan & {
  allPoints: FieldPointCyclePoint[];
  nextStartPoint?: FieldPointCyclePoint;
  nextStartAzimuthDeg?: number;
};

/** A manually started segment uses the same geometry and detection parameters
 * as automatic following. The remaining circle is metadata, never a controller
 * point bank: only this segment's one/two points are acquisition targets. */
export function planSegmentedFollow(draft: AutoFollowDraft, segment: SegmentSettings, anchor: AutoFollowAnchor | null,
  motionMode: FieldMotionMode | "unknown" = "unknown", port = "", opticalOrigin?: FieldWorkOrigin | null): SegmentedFollowPlan {
  const full = planAutoFollow({ ...draft, stepDeg: segment.stepDeg, cycles: 1 }, anchor, motionMode, port, opticalOrigin);
  const errors = full.errors.map(message => message.includes("最多预存16个圆周点位")
    ? "分段采集当前支持每圈2～16个点位，请将间隔设为22.5°或更大" : message);
  if (segment.pointsPerStart !== 1 && segment.pointsPerStart !== 2) errors.push("每次开始仅支持单点或两点采集");
  if (segment.pointsPerStart === 2 && segment.stepDeg !== segmentedPairStepDeg) errors.push("两点采集的圆周移动间隔固定为90°");
  const start = full.points.findIndex(point => point.azimuthDeg === segment.startAzimuthDeg);
  if (!Number.isFinite(segment.startAzimuthDeg) || segment.startAzimuthDeg < 0 || segment.startAzimuthDeg >= 360 || start < 0)
    errors.push("请选择已计算的圆周起始角度");
  const result: SegmentedFollowPlan = { ...full, errors, points: [], allPoints: full.points, pointCycle: undefined,
    stationsPerPoint: segment.pointsPerStart, totalRecords: segment.pointsPerStart };
  if (errors.length || !full.pointCycle) return result;
  result.points = Array.from({ length: segment.pointsPerStart }, (_, offset) => full.points[(start + offset) % full.points.length]);
  result.nextStartPoint = full.points[(start + segment.pointsPerStart) % full.points.length];
  result.nextStartAzimuthDeg = result.nextStartPoint.azimuthDeg;
  const { returnToOrigin: _returnToOrigin, ...cycle } = full.pointCycle;
  result.pointCycle = {
    ...cycle, points: result.points, cycles: 1, startAtCurrentPose: false,
    executionMode: "manual_segments", nextWaitPoint: result.nextStartPoint,
    segmentStepDeg: segment.stepDeg, totalStationCount: full.points.length, segmentStations: full.points,
    motionLaserPolicy: "continuous",
  };
  return result;
}

/** Select from the already calculated circle immediately, without waiting for
 * a React settings effect or changing calibration/reference coordinates. */
export function segmentedRouteAtAzimuth(route: FieldCaptureRoute, angle: number): FieldCaptureRoute {
  const cycle = route.cycle;
  if (route.kind !== "segmented" || cycle?.executionMode !== "manual_segments" || ![1, 2].includes(cycle.points.length))
    throw new Error("当前路线不是有效的分段采集路线");
  if (cycle.points.length === 2 && cycle.segmentStepDeg !== segmentedPairStepDeg)
    throw new Error("两点采集的圆周移动间隔固定为90°");
  if (!Number.isFinite(angle) || angle < 0 || angle > 360) throw new Error("请选择已计算的圆周起始角度");
  const normalized = angle === 360 ? 0 : angle;
  const stations = cycle.segmentStations || [];
  const index = stations.findIndex(point => point.azimuthDeg === normalized);
  if (index < 0) throw new Error("请选择已计算的圆周起始角度");
  const selected = structuredClone(route);
  const selectedCycle = selected.cycle!, selectedStations = selectedCycle.segmentStations!;
  selectedCycle.points = Array.from({ length: cycle.points.length }, (_, offset) => selectedStations[(index + offset) % stations.length]);
  selectedCycle.nextWaitPoint = selectedStations[(index + cycle.points.length) % stations.length];
  selectedCycle.startAtCurrentPose = false;
  selected.pointNames = selectedCycle.points.map(point => point.name);
  return selected;
}
