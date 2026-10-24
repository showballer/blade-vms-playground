import type { FieldCaptureRoute } from "./field-capture-route";
import { segmentedRouteAtAzimuth } from "./field-segmented-plan";

/** Published only after a positioning-only operation has confirmed arrival. */
export type FieldPositionedStation = {
  sequence: number; kind: "manual" | "segmented"; pointId: string;
  targetKey?: string; azimuthDeg?: number; port: string; generation?: number;
};

export function routeAtPositionedStation(route: FieldCaptureRoute, pointId: string): FieldCaptureRoute {
  if (!route.cycle || route.errors.length) throw new Error("请先完成当前点位配置");
  if (route.kind === "segmented") {
    const point = route.cycle.segmentStations?.find(item => item.pointId === pointId);
    if (!point || point.azimuthDeg == null) throw new Error("点位已变化，请重新选择");
    return segmentedRouteAtAzimuth(route, point.azimuthDeg);
  }
  if (route.kind !== "manual") throw new Error("自动跟随的轨迹图仅供查看");
  const index = route.cycle.points.findIndex(point => point.pointId === pointId);
  if (index < 0) throw new Error("点位已变化，请重新选择");
  const next = structuredClone(route), points = next.cycle!.points;
  next.cycle!.points = [...points.slice(index), ...points.slice(0, index)];
  next.cycle!.startAtCurrentPose = false;
  next.pointNames = next.cycle!.points.map(point => point.name);
  return next;
}

/** Reference readiness may be refreshed by the probe itself. Geometry, route
 * order, connection and all acquisition settings must still match the click. */
export function positioningRouteContext(route: FieldCaptureRoute | null | undefined): string {
  if (!route) return "";
  const { generation: _generation, referenceMode: _referenceMode, verifyReferenceAtStart: _verify,
    targets: _targets, selectedTargetKey: _selected, ...plan } = route;
  return JSON.stringify(plan, (key, value) => key === "referenceSignature" ? undefined : value);
}

export function replacePositionedTarget(route: FieldCaptureRoute, selected: FieldCaptureRoute, targetKey?: string): FieldCaptureRoute {
  if (!targetKey) return selected;
  return { ...selected, selectedTargetKey: targetKey,
    targets: route.targets?.map(target => target.key === targetKey ? { ...target, route: selected } : target) };
}
