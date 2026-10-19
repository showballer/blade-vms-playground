import assert from "node:assert/strict";
import { autoFollowDefaults, planAutoFollow, stationOpticalAngles, type AutoFollowAnchor } from "./field-auto-follow-plan";

const signature = JSON.stringify([[0, 1, 10000, 17], [0, 1, 10000, 17]]);
const anchor: AutoFollowAnchor = { port: "COM3", referenceSignature: signature, radiusM: 0.31, pointId: "p1", axis1AngleDeg: 10, axis2AngleDeg: 0 };
const draft = () => structuredClone(autoFollowDefaults);
const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const model = planAutoFollow(draft(), anchor);
assert.deepEqual(model.errors, []);
assert.equal(model.nominalRpm, 2);
assert.equal(model.points.length, 4);
assert.deepEqual(model.points.map(p => p.azimuthDeg), [0, 90, 180, 270]);
near(model.points[0].axis1AngleDeg, 10);
near(model.points[0].axis2AngleDeg, 0);
assert.ok(model.points[1].axis2AngleDeg < 0, "Clockwise from laser side travels left from six o'clock");
near(model.points[2].axis1AngleDeg, 19.8476268);
assert.ok(model.points[3].axis2AngleDeg > 0);
assert.equal(model.pointCycle?.mode, "automatic_stations");
assert.equal(model.pointCycle?.rssiTriggerEnabled, true);
assert.equal(model.pointCycle?.dwellSeconds, 60);
assert.equal(model.pointCycle?.speedRpm, model.speedRpm);
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
const dualCapped = planAutoFollow({ ...draft(), maxMoveRpm: .231 }, anchor, "dual_axis_timed");
assert.equal(dualCapped.speedRpm, .22);
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
console.log("Automatic follow geometry, grouping, sequential and cubic dual-axis timing, and invalid-input checks passed");
