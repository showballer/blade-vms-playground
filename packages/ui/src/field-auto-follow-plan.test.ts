import assert from "node:assert/strict";
import { autoFollowDefaults, manualBladeRotationWaitSeconds, planAutoFollow, stationOpticalAngles, type AutoFollowAnchor } from "./field-auto-follow-plan";

const signature = JSON.stringify([[0, 1, 10000, 17], [0, 1, 10000, 17]]);
const anchor: AutoFollowAnchor = { port: "COM3", referenceSignature: signature, radiusM: 0.31, pointId: "p1", axis1AngleDeg: 10, axis2AngleDeg: 0 };
const draft = () => structuredClone(autoFollowDefaults);
const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const model = planAutoFollow(draft(), anchor);
assert.deepEqual(model.errors, []);
assert.equal(model.origin, "calibrated");
assert.equal(model.nominalRpm, 2);
assert.equal(model.points.length, 4);
assert.deepEqual(model.points.map(p => p.azimuthDeg), [0, 90, 180, 270]);
for (const stepDeg of [180, 90, 60, 45, 30, 22.5]) {
  const planned = planAutoFollow({ ...draft(), stepDeg }, anchor);
  assert.deepEqual(planned.errors, []);
  assert.equal(planned.points.length, 360 / stepDeg);
  assert.equal(new Set(planned.points.map(point => point.pointId)).size, 360 / stepDeg);
  assert.equal(planned.points.at(-1)!.azimuthDeg, 360 - stepDeg, "No duplicate closing point consumes bank capacity");
}
for (const stepDeg of [20, 15, 10, 5]) {
  const planned = planAutoFollow({ ...draft(), stepDeg }, anchor);
  assert.match(planned.errors.join(" "), /最多预存16/);
  assert.equal(planned.points.length, 0, "Excess points must not be silently truncated");
}
near(model.points[0].axis1AngleDeg, 10);
near(model.points[0].axis2AngleDeg, 0);
assert.ok(model.points[1].axis2AngleDeg < 0, "Clockwise from laser side travels left from six o'clock");
near(model.points[2].axis1AngleDeg, 19.8476268);
assert.ok(model.points[3].axis2AngleDeg > 0);
assert.equal(model.pointCycle?.mode, "automatic_stations");
assert.equal(model.pointCycle?.startAtCurrentPose, true);
assert.equal(model.pointCycle?.rssiTriggerEnabled, true);
assert.equal(model.pointCycle?.keepLaserOnBetweenPoints, true);
assert.equal(model.pointCycle?.dwellSeconds, 60);
assert.equal(model.pointCycle?.speedRpm, model.speedRpm);
assert.equal(model.pointCycle?.followErrorLimitDeg, .75);
const adjustedProtection = planAutoFollow({ ...draft(), followErrorLimitDeg: 1.5 }, anchor, "dual_axis_timed");
assert.equal(adjustedProtection.pointCycle?.followErrorLimitDeg, 1.5);
assert.deepEqual(adjustedProtection.points, model.points, "Following-error protection must not move targets");
for (const value of [0, -.1, .499, 10.001, NaN, Infinity, true, "1.5", null]) {
  assert.match(planAutoFollow({ ...draft(), followErrorLimitDeg: value as number }, anchor).errors.join(" "), /跟随误差上限/);
}
for (const value of [.5, 10]) assert.equal(planAutoFollow({ ...draft(), followErrorLimitDeg: value }, anchor).pointCycle?.followErrorLimitDeg, value);
assert.ok(model.speedRpm <= 0.6);
near(model.speedRpm / 0.02, Math.round(model.speedRpm / 0.02));
const reverse = planAutoFollow({ ...draft(), direction: "counterclockwise" }, anchor);
near(reverse.points[1].axis2AngleDeg, -model.points[1].axis2AngleDeg);
near(reverse.points[1].axis1AngleDeg, model.points[1].axis1AngleDeg);
const flipped = planAutoFollow({ ...draft(), axis1Sign: -1, axis2Sign: -1 }, anchor);
near(flipped.points[2].axis1AngleDeg, 20 - model.points[2].axis1AngleDeg);
near(flipped.points[1].axis2AngleDeg, -model.points[1].axis2AngleDeg);
const multiple = planAutoFollow({ ...draft(), cycles: 2, points: [...draft().points, { id: "p2", name: "叶尖", radiusM: 0.5 }] }, anchor);
assert.equal(multiple.points.length, 4);
assert.equal(multiple.totalRecords, 8);
assert.deepEqual(multiple.points.map(p => p.radialPointId), ["p1", "p1", "p1", "p1"]);
assert.equal(new Set(multiple.points.map(p => p.pointId)).size, 4);
const selectedSecond = { ...draft(), activePointId: "p2", points: [...draft().points, { id: "p2", name: "叶尖", radiusM: .5 }] };
assert.ok(planAutoFollow(selectedSecond, anchor).errors.length, "Selecting another point requires a new anchor");
const second = planAutoFollow(selectedSecond, { ...anchor, pointId: "p2", radiusM: .5 });
assert.equal(second.points.length, 4);
assert.ok(second.points.every(point => point.radialPointId === "p2" && point.radiusM === .5));
near(second.points[0].axis1AngleDeg, 10);
const unfinishedOther = planAutoFollow({ ...draft(), points: [...draft().points, { id: "p2", name: "", radiusM: NaN }] }, anchor);
assert.deepEqual(unfinishedOther.errors, []);
assert.equal(unfinishedOther.totalRecords, 4);
const sameRadiusOther = { ...draft(), activePointId: "p2", points: [...draft().points, { id: "p2", name: "P2", radiusM: .31 }] };
assert.ok(planAutoFollow(sameRadiusOther, anchor).errors.length, "Same-radius point still needs its own calibration");
const slower = planAutoFollow({ ...draft(), periodSeconds: 60 }, anchor);
assert.deepEqual(slower.points, model.points);
assert.ok(slower.requiredRpm < model.requiredRpm);
const faster = planAutoFollow({ ...draft(), periodSeconds: 5 }, anchor);
assert.equal(faster.mayMissNextPass, true);
assert.equal(faster.speedRpm, 0.6, "Never increase speed cap to claim next-pass arrival");
const capped = planAutoFollow({ ...draft(), maxMoveRpm: 0.231 }, anchor);
assert.equal(capped.speedRpm, 0.22, "Quantization must not exceed cap");
const maxTravel = Math.max(...model.points.map((p, i) => {
  const q = model.points[(i + 1) % model.points.length];
  return Math.abs(p.axis1AngleDeg - q.axis1AngleDeg) + Math.abs(p.axis2AngleDeg - q.axis2AngleDeg);
}));
near(model.maxTravelLowerBoundSeconds, maxTravel / (6 * model.speedRpm));
const dual = planAutoFollow(draft(), anchor, "dual_axis_timed");
assert.equal(dual.motionMode, "dual_axis_timed");
assert.deepEqual(dual.points, model.points, "Controller capability does not change calibrated station targets");
const jointDelta = Math.max(...dual.points.map((p, i) => {
  const q = dual.points[(i + 1) % dual.points.length];
  return Math.max(Math.abs(p.axis1AngleDeg - q.axis1AngleDeg), Math.abs(p.axis2AngleDeg - q.axis2AngleDeg));
}));
const cubicSeconds = Math.ceil(Math.max(1, 1.5 * jointDelta / (6 * dual.speedRpm), Math.sqrt(2 * jointDelta)) * 1.05 * 1000) / 1000;
near(dual.plannedMoveSeconds, cubicSeconds);
assert.ok(dual.plannedMoveSeconds > jointDelta / (6 * dual.speedRpm), "Parallel motion must include acceleration, not only max(delta)/speed");
assert.ok(1.5 * jointDelta / dual.plannedMoveSeconds <= 6 * dual.speedRpm);
assert.ok(6 * jointDelta / dual.plannedMoveSeconds ** 2 <= 3);
const accelerationLimited = planAutoFollow({ ...draft(), periodSeconds: 5, maxMoveRpm: 10 }, anchor, "dual_axis_timed");
assert.ok(accelerationLimited.speedRpm < 10);
assert.equal(accelerationLimited.mayMissNextPass, true, "More speed cannot remove the acceleration-limited time floor");
const quicker = planAutoFollow({ ...draft(), periodSeconds: 0, maxMoveRpm: 5, maxMoveAccelerationDegS2: 30 }, anchor, "dual_axis_timed");
const gentler = planAutoFollow({ ...draft(), periodSeconds: 0, maxMoveRpm: 5, maxMoveAccelerationDegS2: 3 }, anchor, "dual_axis_timed");
assert.deepEqual(quicker.errors, []);
assert.equal(quicker.pointCycle!.maxMoveAccelerationDegS2, 30);
assert.ok(quicker.plannedMoveSeconds < gentler.plannedMoveSeconds / 2, "Acceleration must change the actual preview, not just its speed label");
assert.deepEqual(quicker.points, gentler.points, "Acceleration never changes point coordinates or their references");
assert.deepEqual(quicker.pointCycle!.returnToOrigin, gentler.pointCycle!.returnToOrigin);
for (const value of [NaN, Infinity, 0, -.1, .099, 120.001, true, "30", null]) {
  assert.ok(planAutoFollow({ ...draft(), maxMoveAccelerationDegS2: value as number }, anchor).errors.length);
}
const dualCapped = planAutoFollow({ ...draft(), maxMoveRpm: .231 }, anchor, "dual_axis_timed");
assert.equal(dualCapped.speedRpm, .22);
for (const mode of ["unknown", "sequential", "dual_axis_timed"] as const) {
  const manual = planAutoFollow({ ...draft(), periodSeconds: 0, waitRevolutions: NaN, cycles: 2 }, anchor, mode);
  assert.deepEqual(manual.errors, []);
  assert.equal(manual.manualRotation, true);
  assert.equal(manual.nominalRpm, 0); assert.equal(manual.intervalSeconds, 0); assert.equal(manual.requiredRpm, 0);
  assert.equal(manual.mayMissNextPass, false, "Without a nominal period there is no next-pass timing claim");
  assert.ok(Number.isFinite(manual.plannedMoveSeconds) && manual.plannedMoveSeconds > 0);
  assert.equal(manual.pointCycle!.nominalPeriodSeconds, 0);
  assert.equal(manual.pointCycle!.dwellSeconds, manualBladeRotationWaitSeconds);
  assert.equal(manual.pointCycle!.cycles, 2); assert.equal(manual.totalRecords, 8);
  assert.equal(manual.pointCycle!.speedRpm, .6); assert.equal(manual.pointCycle!.maxMoveRpm, .6);
  assert.equal(manual.pointCycle!.rssiTriggerEnabled, true); assert.equal(manual.pointCycle!.keepLaserOnBetweenPoints, true);
  assert.deepEqual(manual.points, model.points, "Manual blade movement does not alter pointing geometry or reference signatures");
  for (const [configured, expected] of [[10, 10], [1, 1], [.6, .6], [.51, .5], [.231, .22], [.02, .02]]) {
    const capped = planAutoFollow({ ...draft(), periodSeconds: 0, maxMoveRpm: configured }, anchor, mode);
    assert.deepEqual(capped.errors, []); assert.equal(capped.speedRpm, expected);
    assert.equal(capped.pointCycle!.maxMoveRpm, expected);
    assert.ok(capped.speedRpm <= configured);
    if (mode === "dual_axis_timed") {
      assert.ok(1.5 * jointDelta / capped.plannedMoveSeconds <= 6 * capped.speedRpm);
      assert.ok(6 * jointDelta / capped.plannedMoveSeconds ** 2 <= 3, "Manual operation preserves the acceleration ceiling");
    }
  }
}
assert.equal(model.manualRotation, false);
assert.ok(planAutoFollow({ ...draft(), periodSeconds: 0, maxMoveRpm: .019 }, anchor).errors.length);
assert.ok(planAutoFollow({ ...draft(), periodSeconds: 0, points: [{ id: "p1", name: "P1", radiusM: 0 }] }, anchor).errors.length);
for (const periodSeconds of [-1, .1, .49, 3601, Infinity, NaN]) assert.ok(planAutoFollow({ ...draft(), periodSeconds }, anchor).errors.length);
assert.equal(planAutoFollow(draft(), anchor).motionMode, "unknown", "Unprobed controller must not claim dual-axis support");
for (const invalid of [
  { stepDeg: 0 }, { stepDeg: 70 }, { periodSeconds: NaN }, { points: [] }, { distanceM: 0 }, { maxMoveRpm: 0 },
  { cycles: 1.5 }, { rssiExitSpread: 9 }, { rssiConfirmMs: 0 }, { waitRevolutions: 0 },
  { points: [{ id: "p", name: "P", radiusM: 0.31 }, { id: "p", name: "P2", radiusM: 0.5 }] },
  { stepDeg: 5, cycles: 100 }, { activePointId: "missing" },
]) {
  const value = planAutoFollow({ ...draft(), ...invalid }, anchor);
  assert.ok(value.errors.length); assert.equal(value.pointCycle, undefined);
}
for (const invalidAnchor of [null, { ...anchor, referenceSignature: "[]" }, { ...anchor, port: "" },
  { ...anchor, radiusM: 0.5 }, { ...anchor, axis1AngleDeg: NaN }, { ...anchor, axis1AngleDeg: 30 }]) {
  const value = planAutoFollow(draft(), invalidAnchor);
  assert.ok(value.errors.length); assert.equal(value.pointCycle, undefined);
}
near(stationOpticalAngles(2.86, 1.46, 0.31, 360, "clockwise").pitch,
  stationOpticalAngles(2.86, 1.46, 0.31, 0, "clockwise").pitch);

// Theoretical routes are absolute pointing templates. They carry a selected
// serial port but cannot invent the controller's reference signature.
const theoretical = planAutoFollow(draft(), null, "dual_axis_timed", "COM3");
assert.equal(theoretical.origin, "theoretical"); assert.deepEqual(theoretical.errors, []);
assert.ok(theoretical.pointCycle); assert.equal(theoretical.pointCycle.port, "COM3");
assert.equal(theoretical.pointCycle.mode, "automatic_stations");
assert.equal(theoretical.pointCycle.startAtCurrentPose, false);
assert.ok(theoretical.points.every(point => point.port === "COM3" && !("referenceSignature" in point)));
assert.deepEqual(theoretical.points.map(point => point.azimuthDeg), [0, 90, 180, 270]);
const degrees = (radians: number) => radians * 180 / Math.PI;
near(theoretical.points[0].axis1AngleDeg, degrees(Math.atan2(1.46 - .31, 2.86)));
near(theoretical.points[0].axis2AngleDeg, 0);
near(theoretical.points[1].axis1AngleDeg, degrees(Math.atan2(1.46, Math.hypot(2.86, .31))));
near(theoretical.points[1].axis2AngleDeg, -degrees(Math.atan2(.31, 2.86)));
near(theoretical.points[2].axis1AngleDeg, degrees(Math.atan2(1.46 + .31, 2.86)));
near(theoretical.points[3].axis2AngleDeg, degrees(Math.atan2(.31, 2.86)));
near(theoretical.pointCycle.geometry!.anchorAxis1AngleDeg, degrees(Math.atan2(1.46 - .31, 2.86)));
assert.equal(theoretical.pointCycle.geometry!.anchorAxis2AngleDeg, 0);
assert.equal(theoretical.pointCycle.geometry!.anchorRadiusM, .31);
assert.equal(theoretical.speedRpm, dual.speedRpm, "Applying an optical correction does not change station-to-station travel");
near(theoretical.plannedMoveSeconds, dual.plannedMoveSeconds, .001);

for (const port of ["", "com3", "COM0", "COM3 ", "/dev/tty.usbserial"]) {
  const preview = planAutoFollow(draft(), null, "unknown", port);
  assert.equal(preview.origin, "theoretical"); assert.equal(preview.points.length, 4);
  assert.equal(preview.pointCycle, undefined); assert.deepEqual(preview.errors, ["请选择有效的转盘串口"]);
  assert.ok(!preview.errors.some(message => message.includes("校准")));
}
const macTemplate = planAutoFollow(draft(), null, "sequential", "/dev/cu.usbserial-1140");
assert.deepEqual(macTemplate.errors, []); assert.equal(macTemplate.pointCycle!.port, "/dev/cu.usbserial-1140");
assert.ok(macTemplate.points.every(point => point.port === "/dev/cu.usbserial-1140" && !("referenceSignature" in point)));

const horizontalOrigin = planAutoFollow({ ...draft(), hubHeightDeltaM: .31 }, null, "unknown", "COM4");
assert.deepEqual(horizontalOrigin.errors, []); near(horizontalOrigin.points[0].axis1AngleDeg, 0);
assert.equal(horizontalOrigin.pointCycle!.geometry!.anchorAxis1AngleDeg, 0);
const belowLaser = planAutoFollow({ ...draft(), hubHeightDeltaM: -.3 }, null, "unknown", "COM4");
assert.deepEqual(belowLaser.errors, []); assert.ok(belowLaser.points[0].axis1AngleDeg < 0);
near(belowLaser.points[0].axis1AngleDeg, degrees(Math.atan2(-.3 - .31, 2.86)));
for (const direction of ["clockwise", "counterclockwise"] as const) for (const axis1Sign of [-1, 1] as const) for (const axis2Sign of [-1, 1] as const) {
  const changed = planAutoFollow({ ...draft(), direction, axis1Sign, axis2Sign }, null, "unknown", "COM3");
  assert.deepEqual(changed.errors, []);
  for (let index = 0; index < theoretical.points.length; index++) {
    near(changed.points[index].axis1AngleDeg, axis1Sign * theoretical.points[index].axis1AngleDeg);
    near(changed.points[index].axis2AngleDeg, axis2Sign * (direction === "clockwise" ? 1 : -1) * theoretical.points[index].axis2AngleDeg);
  }
  near(changed.pointCycle!.geometry!.anchorAxis1AngleDeg, axis1Sign * theoretical.pointCycle.geometry!.anchorAxis1AngleDeg);
  assert.equal(changed.pointCycle!.geometry!.anchorAxis2AngleDeg, 0);
}

const theoreticalSecond = planAutoFollow(selectedSecond, null, "dual_axis_timed", "COM3");
assert.deepEqual(theoreticalSecond.errors, []); assert.equal(theoreticalSecond.points.length, 4);
assert.ok(theoreticalSecond.points.every(point => point.radialPointId === "p2" && point.radiusM === .5));
near(theoreticalSecond.points[0].axis1AngleDeg, degrees(Math.atan2(1.46 - .5, 2.86)));
assert.notEqual(theoreticalSecond.points[0].axis1AngleDeg, theoretical.points[0].axis1AngleDeg);
assert.equal(theoreticalSecond.pointCycle!.geometry!.anchorRadiusM, .5);

const optical = stationOpticalAngles(2.86, 1.46, .31, 0, "clockwise");
const correctedAnchor = { ...anchor, axis1AngleDeg: optical.pitch + 1, axis2AngleDeg: 2 };
const corrected = planAutoFollow(draft(), correctedAnchor, "dual_axis_timed", "COM99");
assert.equal(corrected.origin, "calibrated"); assert.deepEqual(corrected.errors, []);
assert.equal(corrected.pointCycle!.port, "COM3", "The fourth argument only applies to uncalibrated templates");
for (let index = 0; index < theoretical.points.length; index++) {
  near(corrected.points[index].axis1AngleDeg, theoretical.points[index].axis1AngleDeg + 1, 1e-6);
  near(corrected.points[index].axis2AngleDeg, theoretical.points[index].axis2AngleDeg + 2, 1e-6);
  assert.equal(corrected.points[index].referenceSignature, signature);
}
for (const invalidAnchor of [{ ...anchor, referenceSignature: "[]" }, { ...anchor, port: "" }, { ...anchor, radiusM: .5 }, { ...anchor, axis1AngleDeg: NaN }, { ...anchor, pointId: "other" }]) {
  const rejected = planAutoFollow(draft(), invalidAnchor, "dual_axis_timed", "COM3");
  assert.equal(rejected.origin, "calibrated"); assert.ok(rejected.errors.length);
  assert.equal(rejected.pointCycle, undefined); assert.equal(rejected.points.length, 0, "A supplied invalid calibration never falls back to a theoretical route");
}
const outside = planAutoFollow({ ...draft(), distanceM: .001 }, null, "dual_axis_timed", "COM3");
assert.equal(outside.origin, "theoretical"); assert.equal(outside.points.length, 4);
assert.ok(outside.errors.some(message => message.includes("超出机械角度范围"))); assert.equal(outside.pointCycle, undefined);
// A horizontal beam facing the rotor defines a shared optical zero, not a P1
// calibration. The first station must preserve that zero's controller yaw.
const fieldDraft = { ...draft(), distanceM: 3.3, hubHeightDeltaM: .85,
  points: [{ id: "p1", name: "P1", radiusM: .078 }], activePointId: "p1" };
const commonZero = { port: "COM3", generation: 3, referenceSignature: signature, axis1AngleDeg: 0, axis2AngleDeg: -16.195 };
const withZero = planAutoFollow(fieldDraft, null, "dual_axis_timed", "COM3", commonZero);
const withoutZero = planAutoFollow(fieldDraft, null, "dual_axis_timed", "COM3");
assert.deepEqual(withZero.errors, []); assert.equal(withZero.origin, "work_zero");
assert.equal(withZero.pointCycle!.returnToOrigin!.axis1AngleDeg, commonZero.axis1AngleDeg);
assert.equal(withZero.pointCycle!.returnToOrigin!.axis2AngleDeg, commonZero.axis2AngleDeg);
assert.equal(withZero.pointCycle!.returnToOrigin!.referenceSignature, signature);
assert.equal(withZero.pointCycle!.startAtCurrentPose, false, "An uncalibrated point still needs initial positioning");
near(withZero.points[0].axis1AngleDeg, 13.16694965);
near(withZero.points[0].axis2AngleDeg, -16.195, 1e-9);
assert.equal(withZero.pointCycle!.geometry!.anchorAxis2AngleDeg, commonZero.axis2AngleDeg);
for (let index = 0; index < withoutZero.points.length; index++) {
  near(withZero.points[index].axis1AngleDeg, withoutZero.points[index].axis1AngleDeg);
  near(withZero.points[index].axis2AngleDeg, withoutZero.points[index].axis2AngleDeg + commonZero.axis2AngleDeg);
  assert.equal(withZero.points[index].referenceSignature, signature);
}
const raisedBase = planAutoFollow(fieldDraft, null, "dual_axis_timed", "COM3", { ...commonZero, axis1AngleDeg: 2 });
for (let index = 0; index < withZero.points.length; index++) near(raisedBase.points[index].axis1AngleDeg, withZero.points[index].axis1AngleDeg + 2);
const otherRadius = planAutoFollow({ ...fieldDraft, activePointId: "p2", points: [{ id: "p2", name: "P2", radiusM: .234 }] }, null, "dual_axis_timed", "COM3", commonZero);
assert.deepEqual(otherRadius.errors, []); assert.notEqual(otherRadius.points[0].axis1AngleDeg, withZero.points[0].axis1AngleDeg);
near(otherRadius.points[0].axis2AngleDeg, commonZero.axis2AngleDeg);
for (const axis1Sign of [-1, 1] as const) for (const axis2Sign of [-1, 1] as const) {
  const value = planAutoFollow({ ...fieldDraft, axis1Sign, axis2Sign }, null, "dual_axis_timed", "COM3", commonZero);
  assert.deepEqual(value.errors, []);
  for (let index = 0; index < value.points.length; index++) {
    near(value.points[index].axis1AngleDeg, axis1Sign * withoutZero.points[index].axis1AngleDeg);
    near(value.points[index].axis2AngleDeg, commonZero.axis2AngleDeg + axis2Sign * withoutZero.points[index].axis2AngleDeg);
  }
}
const manualAnchor = { ...anchor, radiusM: .078, axis1AngleDeg: -.428, axis2AngleDeg: -16.195 };
const pointCalibrated = planAutoFollow(fieldDraft, manualAnchor, "dual_axis_timed", "COM3", commonZero);
assert.equal(pointCalibrated.pointCycle!.returnToOrigin!.axis1AngleDeg, commonZero.axis1AngleDeg, "Calibration cannot replace the shared work zero");
assert.equal(pointCalibrated.pointCycle!.returnToOrigin!.axis2AngleDeg, commonZero.axis2AngleDeg);
assert.deepEqual(pointCalibrated.errors, []); assert.equal(pointCalibrated.origin, "calibrated");
near(pointCalibrated.points[0].axis1AngleDeg, manualAnchor.axis1AngleDeg);
near(pointCalibrated.points[0].axis2AngleDeg, manualAnchor.axis2AngleDeg);
assert.equal(pointCalibrated.pointCycle!.startAtCurrentPose, true);
assert.deepEqual(pointCalibrated.points, planAutoFollow(fieldDraft, manualAnchor, "dual_axis_timed", "COM3").points,
  "Per-point calibration takes precedence over the shared optical zero without double-offsetting");
for (const patch of [{ port: "COM4" }, { referenceSignature: "[]" }, { generation: NaN }, { axis1AngleDeg: NaN }, { axis2AngleDeg: Infinity }]) {
  const invalid = planAutoFollow(fieldDraft, null, "dual_axis_timed", "COM3", { ...commonZero, ...patch });
  assert.ok(invalid.errors.length); assert.equal(invalid.pointCycle, undefined);
}
const outsideZero = planAutoFollow(fieldDraft, null, "dual_axis_timed", "COM3", { ...commonZero, axis1AngleDeg: 30 });
assert.ok(outsideZero.errors.some(message => message.includes("超出机械角度范围"))); assert.equal(outsideZero.pointCycle, undefined);
console.log("Automatic follow geometry, shared optical zero, per-point calibration, grouping, sequential and cubic dual-axis timing, and invalid-input checks passed");

const nativePlan = planAutoFollow({ ...fieldDraft, periodSeconds: 5, maxMoveRpm: 5 }, null, "drive_internal", "COM3", commonZero);
assert.deepEqual(nativePlan.errors, []);
assert.equal(nativePlan.speedRpm, 5, "Native stopped point hops use the configured ceiling, not a retimed trajectory speed");
assert.equal(nativePlan.plannedMoveSeconds, nativePlan.maxTravelLowerBoundSeconds);
assert.equal(nativePlan.pointCycle!.speedRpm, 5);
assert.deepEqual(nativePlan.points, withZero.points);
