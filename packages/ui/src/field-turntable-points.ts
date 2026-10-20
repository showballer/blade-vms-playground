import type { FieldAxisFeedback, FieldBladePoint } from "./field-types";
import { isTurntablePort, normalizeTurntablePort } from "./field-turntable-port";

export const sharedTurntablePointKey = "blade-turntable-points-v2";
export const newTurntablePointId = () => globalThis.crypto?.randomUUID?.() || `point-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
type PointStorage = Pick<Storage, "getItem" | "setItem">;
type PointReference = { port?: string; references?: string; referenceSignature?: string };

function signature(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 512) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(axis =>
      Array.isArray(axis) && axis.length === 4 && axis.every(Number.isSafeInteger))) return JSON.stringify(parsed);
  } catch { /* Invalid legacy metadata must not become trusted current metadata. */ }
  return undefined;
}

export function pointReferenceSignature(point: PointReference): string | undefined {
  const current = signature(point.referenceSignature), legacy = signature(point.references);
  if (point.referenceSignature !== undefined && !current || point.references !== undefined && !legacy) return undefined;
  if (current && legacy && current !== legacy) return undefined;
  return current || legacy;
}

export function turntableReferenceSignature(axes: Record<string, FieldAxisFeedback> | undefined): string | undefined {
  const values = [1, 2].map(axis => {
    const item = axes?.[String(axis)];
    return item && item.output_angle_deg != null && Number.isFinite(item.output_angle_deg)
      ? [item.origin_counts, item.display_mode, item.command_counts_per_rev, item.encoder_bits] : null;
  });
  return signature(JSON.stringify(values));
}

/** Axis 2 may have no controller soft limits; the product angle envelope still applies. */
export function turntableAxisLimitsError(value: FieldAxisFeedback | undefined, axis: 1 | 2, target?: number): string {
  const limit = axis === 1 ? 35 : 180, guard = value?.guard;
  const enabled = guard?.soft_enabled;
  if (enabled !== true && !(axis === 2 && enabled === false)) return `请应用轴${axis}有效软限位`;
  if (enabled && (!Number.isFinite(guard!.minimum_deg) || !Number.isFinite(guard!.maximum_deg) ||
      guard!.minimum_deg >= guard!.maximum_deg || axis === 1 && (guard!.minimum_deg < -35 || guard!.maximum_deg > 35))) return `请应用轴${axis}有效软限位`;
  const current = value?.output_angle_deg;
  if (current == null || !Number.isFinite(current)) return `轴${axis}当前位置无效，请读取有效参考位`;
  if (Math.abs(current) > limit) return `轴${axis}当前位置超出 ±${limit}°范围`;
  if (enabled && (current < guard!.minimum_deg || current > guard!.maximum_deg)) return `轴${axis}当前位置超出软限位，请核查姿态和参考位`;
  if (target !== undefined) {
    if (!Number.isFinite(target) || Math.abs(target) > limit) return `轴${axis}目标角度超出 ±${limit}°范围`;
    if (enabled && (target < guard!.minimum_deg || target > guard!.maximum_deg)) return `记录轴${axis}角度超出当前软限位`;
  }
  return "";
}

export function normalizeSharedTurntablePoints(raw: unknown): FieldBladePoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(point => point && typeof point === "object" && !Array.isArray(point) && typeof point.name === "string").map((point, index) => {
    const referenceSignature = pointReferenceSignature(point);
    return {
      // Preserve both pages' metadata, including older fields not used here.
      ...point,
      pointId: typeof point.pointId === "string" && point.pointId ? point.pointId : newTurntablePointId(),
      bladeIndex: Number.isInteger(point.bladeIndex) && point.bladeIndex > 0 ? point.bladeIndex : 1,
      bladePointIndex: [1, 2, 3].includes(point.bladePointIndex) ? point.bladePointIndex : 1,
      circleIndex: Number.isInteger(point.circleIndex) && point.circleIndex > 0 ? point.circleIndex : index + 1,
      circleStepDeg: Number.isFinite(point.circleStepDeg) && point.circleStepDeg > 0 ? point.circleStepDeg : 60,
      axis1AngleDeg: Number.isFinite(point.axis1AngleDeg) ? point.axis1AngleDeg : null,
      axis2AngleDeg: Number.isFinite(point.axis2AngleDeg) ? point.axis2AngleDeg : null,
      ...(typeof point.port === "string" ? { port: normalizeTurntablePort(point.port) } : {}),
      // Keep the legacy alias for old local data consumers; never resolve conflicts silently.
      ...(referenceSignature ? { referenceSignature, references: referenceSignature } : {}),
    } as FieldBladePoint;
  });
}

export function loadSharedTurntablePoints(storage: PointStorage): FieldBladePoint[] {
  try {
    const current: unknown = JSON.parse(storage.getItem(sharedTurntablePointKey) || "null");
    if (Array.isArray(current)) return normalizeSharedTurntablePoints(current);
    return normalizeSharedTurntablePoints(["blade-turntable-points-v1", "blade-turntable-manual-points-v1"].flatMap(key => {
      try { const value: unknown = JSON.parse(storage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; }
      catch { return []; }
    }));
  } catch { return []; }
}

export function saveSharedTurntablePoints(storage: PointStorage, points: FieldBladePoint[]) {
  storage.setItem(sharedTurntablePointKey, JSON.stringify(normalizeSharedTurntablePoints(points)));
}

export function turntablePointMotionError(point: Pick<FieldBladePoint, "axis1AngleDeg" | "axis2AngleDeg" | "port" | "references" | "referenceSignature">,
  axes: Record<string, FieldAxisFeedback> | undefined, port: string): string {
  for (const axis of [1, 2] as const) {
    const angle = axis === 1 ? point.axis1AngleDeg : point.axis2AngleDeg;
    const limit = axis === 1 ? 35 : 180;
    if (angle == null || !Number.isFinite(angle)) return `记录缺少轴${axis}有效角度`;
    if (Math.abs(angle) > limit) return `记录轴${axis}角度超出 ±${limit}°`;
  }
  if (point.port && point.port !== port) return "记录串口与当前串口不同，请切换至记录串口或重新标定此点";
  const recorded = pointReferenceSignature(point);
  if (!recorded) return "点位缺少有效参考位信息或旧签名冲突，请重新读取并标定此点";
  if (!point.port || !isTurntablePort(point.port)) return "历史点位缺少有效串口信息，请重新读取并标定此点";
  const current = turntableReferenceSignature(axes);
  if (!current) return "请读取两轴有效参考位反馈后再执行点位运动";
  if (recorded !== current) return "记录后参考位或反馈单位已变化，请重新标定此点";
  for (const axis of [1, 2] as const) {
    const error = turntableAxisLimitsError(axes?.[String(axis)], axis, (axis === 1 ? point.axis1AngleDeg : point.axis2AngleDeg)!);
    if (error) return error;
  }
  return "";
}
