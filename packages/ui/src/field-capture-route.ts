import { pointReferenceSignature, turntableAxisLimitsError, turntablePointMotionError, turntableReferenceSignature } from "./field-turntable-points";
import { isTurntablePort } from "./field-turntable-port";
import { fieldTurntableMotionMode, type FieldBladePoint, type FieldPointCycleConfig, type FieldStatus } from "./field-types";
import type { FieldWorkOrigin } from "./field-turntable-origin";

export type FieldCaptureRoute = {
  kind: "manual" | "auto"; name: string; pointNames: string[];
  cycle: FieldPointCycleConfig | null; errors: string[]; generation?: number;
  targets?: FieldAutoCaptureTarget[]; selectedTargetKey?: string;
  referenceMode?: "read_at_start";
};
export type FieldAutoCaptureTarget = {
  key: string; bladeKey: string; bladeId: string; pointId: string; pointName: string;
  radiusM: number; rootRadiusM?: number; bladeLengthM?: number; stations: number; cycles: number; route: FieldCaptureRoute;
};
export type ManualRouteSettings = {
  excludedIds: string[]; cycles: number; speedRpm: number; waitSeconds: number;
  rssiEnterSpread: number; rssiExitSpread: number; rssiEnterConfirmMs: number; rssiConfirmMs: number;
};
export const manualRouteKey = "blade-manual-capture-route-v1";
export const manualRouteDefaults: ManualRouteSettings = {
  excludedIds: [], cycles: 1, speedRpm: .2, waitSeconds: 60,
  rssiEnterSpread: 8, rssiExitSpread: 3, rssiEnterConfirmMs: 20, rssiConfirmMs: 30,
};
export function readManualRouteSettings(raw: string | null): ManualRouteSettings {
  const defaults = { ...manualRouteDefaults, excludedIds: [] as string[] };
  try {
    const saved = JSON.parse(raw || "null");
    if (!saved || typeof saved !== "object") return defaults;
    for (const key of Object.keys(defaults) as (keyof ManualRouteSettings)[]) {
      if (key === "excludedIds") defaults.excludedIds = Array.isArray(saved[key]) ? saved[key].filter((id: unknown) => typeof id === "string") : [];
      else if (typeof saved[key] === "number") defaults[key] = saved[key];
    }
  } catch { /* Optional configuration never restores a running acquisition. */ }
  return defaults;
}
export function manualCaptureRoute(points: FieldBladePoint[], port: string, settings: ManualRouteSettings, generation?: number, origin?: FieldWorkOrigin | null): FieldCaptureRoute {
  const selected = points.filter(point => !settings.excludedIds.includes(point.pointId || ""));
  const errors: string[] = [];
  if (!selected.length) errors.push("请在转盘点位保存并勾选至少一个采集点位");
  if (selected.length > 200) errors.push("每条路线最多选择200个点位");
  if (!isTurntablePort(port)) errors.push("请在转盘点位选择串口并读取反馈");
  if (!Number.isInteger(settings.cycles) || settings.cycles < 1 || settings.cycles > 100 || selected.length * settings.cycles > 2000) errors.push("循环次数须为1–100，计划记录不能超过2000条");
  if (!Number.isFinite(settings.speedRpm) || settings.speedRpm < .02 || settings.speedRpm > 10) errors.push("换点速度须在0.02–10 rpm范围内");
  if (!Number.isFinite(settings.waitSeconds) || settings.waitSeconds < 1 || settings.waitSeconds > 3600) errors.push("单点最长等待须在1–3600秒范围内");
  if (![settings.rssiEnterSpread, settings.rssiExitSpread].every(Number.isFinite) || settings.rssiEnterSpread <= 0 || settings.rssiEnterSpread > 100 || settings.rssiExitSpread < 0 || settings.rssiExitSpread >= settings.rssiEnterSpread) errors.push("回波离开阈值须小于进入阈值，范围为0–100个百分点");
  if (![settings.rssiEnterConfirmMs, settings.rssiConfirmMs].every(value => Number.isFinite(value) && value >= 10 && value <= 1000)) errors.push("进入和离开确认时间须在10–1000毫秒范围内");
  if (new Set(selected.map(point => point.pointId)).size !== selected.length) errors.push("点位编号重复，请重新记录重复点位");
  for (const point of selected) {
    if (!point.pointId || !point.name.trim() || !pointReferenceSignature(point) || point.port !== port ||
      point.axis1AngleDeg == null || !Number.isFinite(point.axis1AngleDeg) || Math.abs(point.axis1AngleDeg) > 35 ||
      point.axis2AngleDeg == null || !Number.isFinite(point.axis2AngleDeg) || Math.abs(point.axis2AngleDeg) > 180) errors.push(`${point.name}：点位角度、串口或参考位信息无效，请重新标定`);
  }
  return { kind: "manual", name: "手动点位路线", pointNames: selected.map(point => point.name), errors, generation,
    cycle: errors.length ? null : { port, mode: "legacy", routeOrder: "configured", points: selected.map(point => ({
      pointId: point.pointId, name: point.name, axis1AngleDeg: point.axis1AngleDeg!, axis2AngleDeg: point.axis2AngleDeg!, port: point.port,
      referenceSignature: pointReferenceSignature(point),
    })), returnToOrigin: { name: "作业原点", port, axis1AngleDeg: origin?.axis1AngleDeg ?? 0,
      axis2AngleDeg: origin?.axis2AngleDeg ?? 0, referenceSignature: origin?.referenceSignature || pointReferenceSignature(selected[0]) },
      cycles: settings.cycles, speedRpm: settings.speedRpm, dwellSeconds: settings.waitSeconds,
      rssiTriggerEnabled: true, rssiEnterSpread: settings.rssiEnterSpread, rssiExitSpread: settings.rssiExitSpread,
      rssiEnterConfirmMs: settings.rssiEnterConfirmMs, rssiConfirmMs: settings.rssiConfirmMs,
      rssiSmoothingMs: 10, rssiMinimumSeconds: 0, keepLaserOnBetweenPoints: true } };
}
export function captureRouteBlockers(route: FieldCaptureRoute | null, status: FieldStatus | null, motionOnly = false): string[] {
  if (!route) return ["请先到转盘点位配置采集路线"];
  const errors = [...route.errors], cycle = route.cycle;
  const readAtStart = route.referenceMode === "read_at_start";
  if (!status || status.service.state !== "ready" || status.service.error || (!motionOnly && !status.service.dllConfigured)) errors.push("采集服务或设备驱动尚未就绪");
  if (!motionOnly && status?.deviceWarning) errors.push(status.deviceWarning);
  if (status?.turntableWarning) errors.push(status.turntableWarning);
  if (!cycle) errors.push("请先完善采集测点与路线参数");
  if (!readAtStart && route.generation !== status?.service.generation) errors.push("采集服务已重启，请重新读取转盘反馈并校准路线");
  if (cycle) {
    if (cycle.startAtCurrentPose !== undefined && typeof cycle.startAtCurrentPose !== "boolean") errors.push("首个点位启动方式无效，请重新配置路线");
    if (cycle.startAtCurrentPose && cycle.mode !== "automatic_stations") errors.push("首个点位原地采集仅适用于自动跟随测点");
    const matchingController = status?.turntable?.port === cycle.port ? status.turntable : undefined;
    const trajectory = matchingController?.motionCapability?.status;
    if (trajectory && (trajectory.state === 7 || typeof trajectory.fault === "number" && trajectory.fault > 1)) errors.push("控制器轨迹存在故障，请先检查并恢复后重新读取反馈");
    else if (trajectory && [1, 2, 3, 4, 5].includes(Number(trajectory.state))) errors.push("控制器仍有待启动或运行中的轨迹，请先停止并核查");
    const axes = matchingController?.feedback?.axes;
    if (readAtStart) {
      errors.push(...theoreticalRouteErrors(route));
      for (const axis of [1, 2]) {
        const value = axes?.[String(axis)];
        if (value && (value.fault !== 0 || value.motor_rpm !== 0 || !Number.isInteger(value.flags) || (value.flags & 16))) errors.push("轴" + axis + "未确认静止且无故障");
      }
      return [...new Set(errors)];
    }
    if (!turntableReferenceSignature(axes)) errors.push("请在转盘点位读取两轴有效参考位");
    for (const axis of [1, 2] as const) {
      const value = axes?.[String(axis)];
      if (!value || value.fault !== 0 || value.motor_rpm !== 0 || !Number.isInteger(value.flags) || (value.flags & 16)) errors.push(`轴${axis}未确认静止且无故障`);
      const rangeError = turntableAxisLimitsError(value, axis);
      if (rangeError) errors.push(rangeError);
    }
    for (const point of [...cycle.points, ...(cycle.returnToOrigin ? [cycle.returnToOrigin] : [])]) {
      const error = turntablePointMotionError(point, axes, cycle.port);
      if (error) errors.push(`${point.name}：${error}`);
    }
    if (cycle.startAtCurrentPose) {
      const first = cycle.points[0];
      if (!first || ([1, 2] as const).some(axis => {
        const actual = axes?.[String(axis)]?.output_angle_deg;
        const target = axis === 1 ? first.axis1AngleDeg : first.axis2AngleDeg;
        return actual == null || !Number.isFinite(actual) || Math.abs(actual - target) > .1 + 1e-9;
      })) errors.push("已校准测点的首点位置已变化，请先移动到预设位置或重新瞄准；本次不会自动补移");
    }
    if (fieldTurntableMotionMode(status?.turntable, cycle.port) === "unknown") errors.push("请在转盘点位读取反馈，确认控制器换点方式");
  }
  return [...new Set(errors)];
}

function theoreticalRouteErrors(route: FieldCaptureRoute): string[] {
  const cycle = route.cycle;
  if (!cycle) return [];
  const errors: string[] = [];
  const points = Array.isArray(cycle.points) ? cycle.points : [];
  const finite = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  if (route.kind !== "auto" || cycle.mode !== "automatic_stations") errors.push("启动时读取参考位仅适用于自动跟随计算路线");
  if (!isTurntablePort(cycle.port)) errors.push("请选择有效的转盘串口");
  if (!points.length || points.length > 200 ||
      !Number.isInteger(cycle.cycles) || cycle.cycles < 1 || cycle.cycles > 100 || points.length * cycle.cycles > 2000) errors.push("请核对点位数量与采集轮数");
  if (!finite(cycle.speedRpm, .02, 10) || !finite(cycle.dwellSeconds, 1, 3600) ||
      !(cycle.nominalPeriodSeconds === 0 || finite(cycle.nominalPeriodSeconds, .5, 3600)) || !finite(cycle.maxMoveRpm, .02, 10) ||
      cycle.maxMoveRpm !== undefined && cycle.speedRpm > cycle.maxMoveRpm) errors.push("请核对叶轮周期、等待时间与转盘速度");
  const geometry = cycle.geometry;
  if (!geometry || !finite(geometry.distanceM, .001, 10000) || !finite(geometry.hubHeightDeltaM, -10000, 10000) ||
      !finite(geometry.anchorRadiusM, .001, 1000) || !finite(geometry.anchorAxis1AngleDeg, -35, 35) || !finite(geometry.anchorAxis2AngleDeg, -180, 180) ||
      ![1, -1].includes(geometry.axis1Sign) || ![1, -1].includes(geometry.axis2Sign) || !["clockwise", "counterclockwise"].includes(geometry.rotationDirection)) errors.push("请完善自动跟随测量几何与轴方向参数");
  if (!cycle.rssiTriggerEnabled || !finite(cycle.rssiEnterSpread, .1, 100) || !finite(cycle.rssiExitSpread, 0, 99.9) ||
      cycle.rssiEnterSpread! <= cycle.rssiExitSpread! || !finite(cycle.rssiEnterConfirmMs, 10, 1000) || !finite(cycle.rssiConfirmMs, 10, 1000)) errors.push("请核对叶片进入和离开的回波判定参数");
  const ids = new Set<string>();
  for (const point of [...points, ...(cycle.returnToOrigin ? [cycle.returnToOrigin] : [])]) {
    if (point !== cycle.returnToOrigin && (!point.pointId || ids.has(point.pointId)) || typeof point.name !== "string" || !point.name.trim() || !finite(point.axis1AngleDeg, -35, 35) || !finite(point.axis2AngleDeg, -180, 180) ||
        point.port !== undefined && point.port !== cycle.port) errors.push("计算点位角度、名称、标识或串口无效");
    ids.add(point.pointId || "");
    if (point.referenceSignature !== undefined || (point as { references?: unknown }).references !== undefined) errors.push("计算路线不能覆盖已保存的参考位，请重新配置测点");
  }
  return errors;
}

/** Bind a theoretical angle plan to freshly read hardware references, then run
 * the same complete motion checks as a manually calibrated route. No I/O. */
export function prepareCaptureRoute(route: FieldCaptureRoute, checked: FieldStatus, motionOnly = false): FieldCaptureRoute {
  const errors = captureRouteBlockers(route, checked, motionOnly);
  if (errors.length) throw new Error(errors.join("；"));
  const prepared = structuredClone(route);
  if (route.referenceMode === "read_at_start") {
    const cycle = prepared.cycle!;
    const axes = checked.turntable?.port === cycle.port ? checked.turntable.feedback?.axes : undefined;
    const signature = turntableReferenceSignature(axes);
    if (!signature) throw new Error("请读取两轴有效参考位，确认控制器参考姿态和软限位后再开始");
    if (!Number.isInteger(checked.service.generation) || checked.service.generation! < 0) throw new Error("采集服务代际信息无效，请重新读取设备状态");
    prepared.cycle = { ...cycle, points: cycle.points.map(point => ({ ...point, port: cycle.port, referenceSignature: signature })),
      ...(cycle.returnToOrigin ? { returnToOrigin: { ...cycle.returnToOrigin, port: cycle.port, referenceSignature: signature } } : {}) };
    prepared.generation = checked.service.generation;
    delete prepared.referenceMode;
  }
  const fullErrors = captureRouteBlockers(prepared, checked, motionOnly);
  if (fullErrors.length) throw new Error(fullErrors.join("；"));
  return prepared;
}

/** An existing reference binding is checked again by the service. Only read
 * here when the calculated route has no reference identity to bind yet. */
export async function prepareCaptureStartRoute(route: FieldCaptureRoute, current: FieldStatus | null,
  probe: () => Promise<FieldStatus>): Promise<{ route: FieldCaptureRoute; status: FieldStatus; probed: boolean }> {
  if (!current) throw new Error("请先读取设备状态");
  const axes = current.turntable?.port === route.cycle?.port ? current.turntable?.feedback?.axes : undefined;
  const capability = current.turntable?.port === route.cycle?.port ? current.turntable?.motionCapability : undefined;
  const probed = route.referenceMode === "read_at_start" && (!turntableReferenceSignature(axes) || !capability ||
    capability.probe === "driver-unavailable");
  const checked = probed ? await probe() : current;
  return { route: prepareCaptureRoute(route, checked), status: checked, probed };
}
