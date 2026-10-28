import assert from "node:assert/strict";
import test from "node:test";
import { segmentedStartPositionError, withSegmentedAutoMove } from "./field-segmented-start";
import type { FieldCaptureRoute } from "./field-capture-route";
import type { FieldPositionedStation } from "./field-route-position";
import { turntableReferenceSignature } from "./field-turntable-points";
import type { FieldAxisFeedback, FieldPointCyclePoint, FieldStatus } from "./field-types";

const port = "tcp://192.168.10.50:5000", targetKey = "blade2-p1";
const axis = (angle: number, limit: number): FieldAxisFeedback => ({
  output_angle_deg: angle, motor_rpm: 0, actual_counts: 0, commanded_counts: 0, error_counts: 0,
  display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 3, fault: 0, origin_counts: 0,
  home_phase: 0, observedAt: Date.now() / 1000, referenceAngleDeg: 0,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit },
});
const axes = { "1": axis(10, 35), "2": axis(0, 180) };
const referenceSignature = turntableReferenceSignature(axes)!;
const points: FieldPointCyclePoint[] = [0, 90, 180, 270].map((azimuthDeg, index) => ({
  pointId: "P1-" + index, name: "P1 " + azimuthDeg, azimuthDeg,
  port, referenceSignature, bladeId: "2", radialPointId: "p1", radialPointName: "P1", radiusM: .3,
  axis1AngleDeg: 10 + index, axis2AngleDeg: index,
}));
const route: FieldCaptureRoute = { kind: "segmented", name: "叶片2 P1", errors: [], pointNames: [points[0].name], generation: 1,
  cycle: { port, mode: "automatic_stations", executionMode: "manual_segments", segmentedAutoMove: true,
    points: [points[0]], nextWaitPoint: points[1], segmentStations: points, segmentStepDeg: 90, totalStationCount: 4,
    cycles: 1, dwellSeconds: 60, speedRpm: 5, rssiTriggerEnabled: true } };
const ready: FieldStatus = { service: { state: "ready", generation: 1, dllConfigured: true }, state: "idle",
  turntable: { state: "checked", port, feedback: { axes, motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0 } } };
const positioned: FieldPositionedStation = { sequence: 1, kind: "segmented", targetKey, port, generation: 1,
  pointId: points[0].pointId!, azimuthDeg: 0, axis1AngleDeg: points[0].axis1AngleDeg, axis2AngleDeg: points[0].axis2AngleDeg };
const allowed = (r: FieldCaptureRoute = route, s: FieldStatus = ready, proof?: FieldPositionedStation, key = targetKey) =>
  segmentedStartPositionError(r, s, proof, key) === "";
const completeAt = (point: FieldPointCyclePoint): FieldStatus => ({ ...structuredClone(ready), pointCycle: {
  executionMode: "manual_segments", segmentedAutoMove: true, port, state: "complete", error: null,
  cycles: 1, pointCount: 1, point: 1, cycle: 1, completedRecords: 1, totalRecords: 1, speedRpm: 5, dwellSeconds: 60,
  nextWaitPoint: point, waitingPoint: { ...point, confirmedAt: Date.now() / 1000,
    actualAngles: { "1": point.axis1AngleDeg, "2": point.axis2AngleDeg } },
} });

test("segment Start requires explicit current-target preposition and accepts its successful result", () => {
  assert.equal(allowed(), false);
  assert.equal(allowed(route, ready, positioned), true);
  assert.equal(allowed(route, ready, { ...positioned, kind: "manual" }), false);
  assert.equal(allowed(route, ready, { ...positioned, generation: 0 }), false);
  assert.equal(allowed(route, ready, { ...positioned, port: "COM9" }), false);
  assert.equal(allowed(route, ready, { ...positioned, pointId: "old-position" }), false);
  assert.equal(allowed(route, ready, { ...positioned, axis1AngleDeg: NaN }), false);
});

test("changing the blade/radial target cannot reuse another target's preposition", () => {
  const other = structuredClone(route);
  other.cycle!.points[0] = { ...other.cycle!.points[0], radialPointId: "p2", radialPointName: "P2" };
  assert.equal(allowed(other, ready, positioned, "blade2-p2"), false);
  const confirmed = completeAt({ ...points[0], radialPointId: "p2" });
  assert.equal(allowed(route, confirmed), false);
  confirmed.pointCycle!.waitingPoint = { ...confirmed.pointCycle!.waitingPoint!, bladeId: "3", radialPointId: "p1" };
  assert.equal(allowed(route, confirmed), false);
});

test("successful automatic wait arrival may authorize the following Start without another move", () => {
  assert.equal(allowed(route, completeAt(points[0])), true);
  const next = structuredClone(route), waiting = completeAt(points[1]);
  next.cycle!.points = [points[1]]; next.cycle!.nextWaitPoint = points[2];
  waiting.turntable!.feedback!.axes!["1"].output_angle_deg = points[1].axis1AngleDeg;
  waiting.turntable!.feedback!.axes!["2"].output_angle_deg = points[1].axis2AngleDeg;
  assert.equal(allowed(next, waiting), true);
  assert.equal(allowed(next, waiting, positioned), true, "current completed wait evidence supersedes the old explicit point");
});

test("auto-move off preserves the next target but does not manufacture positioning permission", () => {
  const next = structuredClone(route), status = completeAt(points[1]);
  next.cycle!.points = [points[1]]; next.cycle!.nextWaitPoint = points[2]; next.cycle!.segmentedAutoMove = false;
  status.pointCycle!.segmentedAutoMove = false; delete status.pointCycle!.waitingPoint;
  assert.equal(allowed(next, status, positioned), false);
  const confirmed = { ...positioned, sequence: 2, pointId: points[1].pointId!, azimuthDeg: 90,
    axis1AngleDeg: points[1].axis1AngleDeg, axis2AngleDeg: points[1].axis2AngleDeg };
  status.turntable!.feedback!.axes!["1"].output_angle_deg = points[1].axis1AngleDeg;
  status.turntable!.feedback!.axes!["2"].output_angle_deg = points[1].axis2AngleDeg;
  assert.equal(allowed(next, status, confirmed), true);
});

test("error or cancellation never authorizes by old wait data; a fresh explicit positioning recovers an old capture error", () => {
  for (const state of ["error", "cancelled"] as const) {
    const failed = completeAt(points[0]); failed.pointCycle!.state = state; failed.pointCycle!.error = "fixture failure";
    assert.equal(allowed(route, failed), false);
  }
  const oldError = completeAt(points[0]); oldError.state = "error"; oldError.error = "previous capture failed";
  assert.equal(allowed(route, oldError), false);
  assert.equal(allowed(route, oldError, positioned), true, "successful preposition must not leave Start permanently grey");
});

test("changed actual angle or reference invalidates proof; absent telemetry is verified by the backend at Start", () => {
  for (const change of ["pitch", "yaw", "reference"] as const) {
    const moved = structuredClone(ready);
    if (change === "pitch") moved.turntable!.feedback!.axes!["1"].output_angle_deg! += 1;
    if (change === "yaw") moved.turntable!.feedback!.axes!["2"].output_angle_deg! += 1;
    if (change === "reference") moved.turntable!.feedback!.axes!["1"].origin_counts++;
    assert.equal(allowed(route, moved, positioned), false, change);
  }
  const within = structuredClone(ready); within.turntable!.feedback!.axes!["1"].output_angle_deg! += .5;
  assert.equal(allowed(route, within, positioned), true);
  const noFeedback = { ...ready, turntable: undefined };
  assert.equal(allowed(route, noFeedback, positioned), true, "do not add a UI probe or make a recoverable telemetry gap a permanent lock");
  assert.equal(allowed(route, noFeedback), false, "missing telemetry alone cannot grant permission");
});

test("auto-move toggle changes only segment policy and preserves per-point angle cursors without mutation", () => {
  const all = { ...structuredClone(route), selectedTargetKey: targetKey, targets: [
    { key: targetKey, bladeKey: "blade2", bladeId: "2", pointId: "p1", pointName: "P1", radiusM: .3, stations: 1, cycles: 1, route: structuredClone(route) },
  ] };
  const before = structuredClone(all), off = withSegmentedAutoMove(all, false);
  assert.equal(off.cycle!.segmentedAutoMove, false); assert.equal(off.targets![0].route.cycle!.segmentedAutoMove, false);
  assert.equal(off.selectedTargetKey, all.selectedTargetKey);
  assert.deepEqual(off.cycle!.points, all.cycle!.points); assert.deepEqual(off.cycle!.nextWaitPoint, all.cycle!.nextWaitPoint);
  assert.deepEqual(all, before);
  assert.equal(withSegmentedAutoMove({ ...route, kind: "auto" }, false).cycle!.segmentedAutoMove, true);
});
