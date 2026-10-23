import { captureRouteBlockers, prepareCaptureRoute, type FieldCaptureRoute } from "./field-capture-route";
import { turntableReferenceSignature } from "./field-turntable-points";
import { FIELD_POSITION_TOLERANCE_DEG, fieldIsActive, type FieldRequestOptions, type FieldStatus } from "./field-types";

// Explicit positioning may move a calibrated first point. It does not alter
// calibration, the saved route, or the subsequent capture's initial-pose policy.
function positioningRoute(route: FieldCaptureRoute): FieldCaptureRoute {
  return { ...route, cycle: route.cycle ? { ...route.cycle, startAtCurrentPose: false } : null };
}
export function presetPositionError(route: FieldCaptureRoute | null, status: FieldStatus | null): string {
  if (fieldIsActive(status) || status?.turntableBusy || status?.deviceBusy) return "请等待当前任务结束";
  return captureRouteBlockers(route ? positioningRoute(route) : null, status, true)[0] || "";
}

type Request = <T>(options: FieldRequestOptions) => Promise<T>;
type Options = {
  signal: AbortSignal;
  current: () => boolean;
  onStatus: (status: FieldStatus) => void;
  wait?: () => Promise<void>;
};
/** Recall owns the serial port; this coordinator never starts a receiver or
 * changes the laser, origin, reference, or stored point configuration. */
export async function moveToCapturePreset(route: FieldCaptureRoute, initial: FieldStatus, request: Request, options: Options): Promise<"complete" | "cancelled"> {
  const invalid = presetPositionError(route, initial);
  if (invalid) throw new Error(invalid);
  const port = route.cycle!.port, generation = initial.service.generation;
  let started = false, last = initial;
  const accept = (next: FieldStatus) => {
    last = next;
    if (!options.current() || next.service.generation !== generation || next.service.state !== "ready" || next.turntable?.port !== port) {
      throw new Error("服务或串口已变化，预定位结果未确认，请重新读取状态");
    }
    options.onStatus(next);
  };
  const probe = () => request<FieldStatus>({ action: "turntable", request: { action: "probe", port, axis: 1 } });
  const stop = async () => {
    if (!options.current() || last.service.generation !== generation || fieldIsActive(last)) throw new Error("连接或任务已变化，停止状态未确认");
    accept(await request<FieldStatus>({ action: "turntable", request: { action: "stop", port, axis: 1, confirmMotion: true } }));
    accept(await probe());
    const axes = last.turntable?.feedback?.axes;
    if (last.turntableBusy || last.turntableWarning || !axes || [1, 2].some(axis => !axes[String(axis)] ||
      axes[String(axis)].motor_rpm !== 0 || (axes[String(axis)].flags & 16))) throw new Error("两轴停止状态未确认，请重新读取反馈");
    started = false;
  };
  try {
    if (options.signal.aborted) return "cancelled";
    accept(await probe());
    if (options.signal.aborted) return "cancelled";
    const prepared = prepareCaptureRoute(positioningRoute(route), last, true), cycle = prepared.cycle!, first = cycle.points[0];
    if (!first?.referenceSignature) throw new Error("预设位置缺少有效参考位，请重新读取转盘");
    const target = [first.axis1AngleDeg, first.axis2AngleDeg];
    const initialAxes = last.turntable?.feedback?.axes;
    // Repeated positioning and capture use the same absolute target. A fresh
    // stopped pose is sufficient; never replay a recall just because a button
    // was clicked again or rely on a previous success notification.
    if (turntableReferenceSignature(initialAxes) === first.referenceSignature && target.every((value, i) => {
      const axis = initialAxes?.[String(i + 1)];
      return axis?.output_angle_deg != null && Number.isFinite(axis.output_angle_deg) &&
        axis.motor_rpm === 0 && axis.fault === 0 && !!(axis.flags & 1) && !(axis.flags & 16) &&
        Math.abs(axis.output_angle_deg - value) <= FIELD_POSITION_TOLERANCE_DEG + 1e-9;
    })) return "complete";
    started = true; // A lost reply can still mean the controller accepted motion.
    accept(await request<FieldStatus>({ action: "turntable", request: {
      action: "recall", port, recordedPort: first.port || port, axis: 1,
      axis1AngleDeg: target[0], axis2AngleDeg: target[1], referenceSignature: first.referenceSignature,
      speedRpm: cycle.maxMoveRpm ?? cycle.speedRpm, maxMoveAccelerationDegS2: cycle.maxMoveAccelerationDegS2,
      followErrorLimitDeg: cycle.followErrorLimitDeg, confirmMotion: true,
    } }));
    const deadline = Date.now() + 660_000; // Backend motion deadlines stop earlier.
    while (true) {
      if (options.signal.aborted) { await stop(); return "cancelled"; }
      const controller = last.turntable!;
      if (fieldIsActive(last) || controller.error || (!last.turntableBusy && last.turntableWarning) ||
          controller.recall?.state === "error") throw new Error(controller.error || last.turntableWarning || "预定位未完成");
      if (!controller.recall || controller.recall.targets.some((value, i) => Math.abs(value - target[i]) > 1e-9)) throw new Error("预定位任务已变化，请重新读取状态");
      if (!last.turntableBusy && controller.recall.state === "cancelled") {
        await stop(); return "cancelled";
      }
      if (!last.turntableBusy && controller.recall.state === "complete") {
        accept(await probe());
        if (options.signal.aborted) { await stop(); return "cancelled"; }
        const axes = last.turntable!.feedback?.axes;
        const invalid = presetPositionError(prepared, last);
        if (invalid) throw new Error(invalid);
        if (turntableReferenceSignature(axes) !== first.referenceSignature || target.some((value, i) => {
          const actual = axes?.[String(i + 1)]?.output_angle_deg;
          return actual == null || !Number.isFinite(actual) || Math.abs(actual - value) > FIELD_POSITION_TOLERANCE_DEG + 1e-9;
        })) throw new Error("预设位置到位未确认，请核对角度与参考位");
        started = false;
        return "complete";
      }
      if (Date.now() > deadline) throw new Error("预定位超时");
      await (options.wait?.() ?? new Promise(resolve => setTimeout(resolve, 200)));
      accept(await request<FieldStatus>({ action: "status" }));
    }
  } catch (cause) {
    let message = cause instanceof Error ? cause.message : "预定位失败";
    if (started) {
      try { await stop(); }
      catch (failure) { message += `；${failure instanceof Error ? failure.message : "停止未确认"}`; }
    }
    throw new Error(message);
  }
}
