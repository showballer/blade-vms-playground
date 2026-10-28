import type { FieldCaptureRoute } from "./field-capture-route";
import type { FieldPositionedStation } from "./field-route-position";
import { FIELD_POSITION_TOLERANCE_DEG, type FieldPointCyclePoint, type FieldStatus } from "./field-types";
import { turntableReferenceSignature } from "./field-turntable-points";

const samePoint = (a: Partial<FieldPointCyclePoint> | undefined, b: FieldPointCyclePoint) =>
  !!a && !!a.pointId && a.pointId === b.pointId && a.azimuthDeg === b.azimuthDeg &&
  (["axis1AngleDeg", "axis2AngleDeg"] as const).every(key => {
    const actual = a[key], expected = b[key];
    return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-6;
  });

/** Segment Start never implicitly changes radial measurement targets. This is
 * permission from an explicit positioning operation or this run's confirmed
 * automatic wait position; the service still checks live position/reference. */
export function segmentedStartPositionError(route: FieldCaptureRoute | null | undefined, status: FieldStatus | null,
  positioned?: FieldPositionedStation, targetKey?: string): string {
  if (route?.kind !== "segmented") return "";
  const cycle = route.cycle, first = cycle?.points[0];
  const message = "请先点击“移动到预设位置”定位当前测点和角度";
  if (!cycle || !first || !status) return message;
  const controller = status.turntable?.port === cycle.port ? status.turntable : undefined;
  const axes = controller?.feedback?.axes, signature = turntableReferenceSignature(axes);
  if (signature && first.referenceSignature && signature !== first.referenceSignature) return message;
  for (const axis of [1, 2] as const) {
    const actual = axes?.[String(axis)]?.output_angle_deg;
    if (typeof actual === "number" && Number.isFinite(actual) &&
        Math.abs(actual - first[axis === 1 ? "axis1AngleDeg" : "axis2AngleDeg"]) > FIELD_POSITION_TOLERANCE_DEG + 1e-9) return message;
  }
  if (positioned?.kind === "segmented" && positioned.port === cycle.port &&
      positioned.generation === status.service.generation && positioned.targetKey === targetKey &&
      (!signature || !positioned.referenceSignature || signature === positioned.referenceSignature) && samePoint(positioned, first)) return "";
  const previous = status.pointCycle, wait = previous?.waitingPoint;
  if (status.state !== "error" && previous?.executionMode === "manual_segments" && previous.state === "complete" && previous.port === cycle.port &&
      !previous.error && wait && wait.bladeId === first.bladeId && wait.radialPointId === first.radialPointId &&
      (!signature || !wait.referenceSignature || signature === wait.referenceSignature) && samePoint(wait, first)) return "";
  return message;
}

/** Change only segment policy; preserve each point's angle cursor and targets. */
export function withSegmentedAutoMove(route: FieldCaptureRoute, value: boolean): FieldCaptureRoute {
  if (route.kind !== "segmented") return route;
  return { ...route, cycle: route.cycle ? { ...route.cycle, segmentedAutoMove: value } : null,
    ...(route.targets ? { targets: route.targets.map(target => ({ ...target, route: withSegmentedAutoMove(target.route, value) })) } : {}) };
}
