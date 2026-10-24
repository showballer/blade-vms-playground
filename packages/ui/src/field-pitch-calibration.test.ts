// Coordinate contracts only; never connects to the acquisition service.
import assert from "node:assert/strict";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import { readAutoFollowSurvey, surveyDraft } from "./field-auto-follow-config";
import { planSegmentedFollow, segmentedRouteAtAzimuth } from "./field-segmented-plan";
import type { FieldCaptureRoute } from "./field-capture-route";

const scale = .896932;
const origin = { port: "COM6", generation: 1, axis1AngleDeg: .009, axis2AngleDeg: 0,
  referenceSignature: "[[0,3,10000,21],[0,3,10000,21]]" };
const draft = { ...autoFollowDefaults, distanceM: 2.5, hubHeightDeltaM: .73, pitchAngleScale: scale,
  points: [{ id: "p1", name: "P1", radiusM: .16 }], activePointId: "p1", maxMoveRpm: 5 };
const plan = planAutoFollow(draft, null, "drive_internal", origin.port, origin);
assert.deepEqual(plan.errors, []);
const expected = [[11.529, 0], [14.581, -3.662], [17.585, 0], [14.581, 3.662]];
for (const [i, point] of plan.points.entries()) {
  assert.ok(Math.abs(point.axis1AngleDeg - expected[i][0]) < .0006);
  assert.ok(Math.abs(point.axis2AngleDeg - expected[i][1]) < .0006);
  assert.equal(point.radiusM, .16);
}
assert.equal(plan.pointCycle!.geometry!.pitchAngleScale, scale);
assert.equal(plan.pointCycle!.returnToOrigin!.axis1AngleDeg, .009);
assert.equal(plan.pointCycle!.returnToOrigin!.axis2AngleDeg, 0);

const { pitchAngleScale: _omittedScale, yawAngleScale: _omittedYawScale, ...legacyDraft } = draft;
const legacy = planAutoFollow(legacyDraft, null, "drive_internal", origin.port, origin);
assert.deepEqual(legacy, planAutoFollow({ ...draft, pitchAngleScale: 1 }, null, "drive_internal", origin.port, origin));
assert.deepEqual(legacy.points.map(p => p.axis2AngleDeg), plan.points.map(p => p.axis2AngleDeg));
for (const value of [0, .4999, 1.5001, NaN, Infinity, null, true, "0.9"]) {
  const bad = planAutoFollow({ ...draft, pitchAngleScale: value as number }, null, "drive_internal", origin.port, origin);
  assert.match(bad.errors.join(" "), /俯仰角校正系数/); assert.equal(bad.points.length, 0);
}

// A measured first point stays fixed; only optical angle differences are scaled.
const anchor = { port: origin.port, referenceSignature: origin.referenceSignature, radiusM: .16,
  pointId: "p1", axis1AngleDeg: 8, axis2AngleDeg: 2 };
for (const axis1Sign of [1, -1] as const) {
  const calibrated = planAutoFollow({ ...draft, axis1Sign }, anchor, "drive_internal", origin.port, origin);
  const unscaled = planAutoFollow({ ...draft, axis1Sign, pitchAngleScale: 1 }, anchor, "drive_internal", origin.port, origin);
  assert.equal(calibrated.points[0].axis1AngleDeg, 8);
  for (const [i, point] of calibrated.points.entries()) {
    assert.ok(Math.abs(point.axis1AngleDeg - (8 + scale * (unscaled.points[i].axis1AngleDeg - 8))) < 1e-6);
    assert.equal(point.axis2AngleDeg, unscaled.points[i].axis2AngleDeg);
  }
}

// Segment selection, next wait point and metadata all use the same corrected circle.
const segmented = planSegmentedFollow(draft, { pointsPerStart: 2, stepDeg: 90, startAzimuthDeg: 0 }, null, "drive_internal", origin.port, origin);
const route: FieldCaptureRoute = { kind: "segmented", name: "P1", errors: segmented.errors,
  pointNames: segmented.points.map(p => p.name), cycle: segmented.pointCycle! };
const selected = segmentedRouteAtAzimuth(route, 90).cycle!;
assert.deepEqual(selected.segmentStations!.map(p => [p.axis1AngleDeg, p.axis2AngleDeg]), plan.points.map(p => [p.axis1AngleDeg, p.axis2AngleDeg]));
assert.deepEqual(selected.points.map(p => p.azimuthDeg), [90, 180]);
assert.equal(selected.nextWaitPoint!.axis1AngleDeg, plan.points[3].axis1AngleDeg);
assert.equal(selected.geometry!.pitchAngleScale, scale);

const stored = readAutoFollowSurvey(JSON.stringify({ draft }));
assert.equal(surveyDraft(stored).pitchAngleScale, scale);
assert.equal(surveyDraft(readAutoFollowSurvey(JSON.stringify(stored))).pitchAngleScale, scale);
assert.equal(surveyDraft(readAutoFollowSurvey(JSON.stringify({ draft: legacyDraft }))).pitchAngleScale, 1);
assert.deepEqual(surveyDraft(stored).points, draft.points);

const yawScale = .950153;
const twoAxisDraft = { ...draft, yawAngleScale: yawScale };
const correctedP1 = planAutoFollow(twoAxisDraft, null, "drive_internal", origin.port, origin);
assert.deepEqual(correctedP1.errors, []);
assert.ok(Math.abs(correctedP1.points[1].axis2AngleDeg + 3.479) < .0006);
assert.deepEqual(correctedP1.points.map(p => p.axis1AngleDeg), plan.points.map(p => p.axis1AngleDeg));
assert.deepEqual(correctedP1.pointCycle!.returnToOrigin, plan.pointCycle!.returnToOrigin);
const correctedP5 = planAutoFollow({ ...twoAxisDraft, points: [{ id: "p5", name: "P5", radiusM: .72 }], activePointId: "p5" }, null, "drive_internal", origin.port, origin);
assert.deepEqual(correctedP5.errors, []);
const p5Expected = [[.215, 0], [14.067, -15.266], [27.019, 0], [14.067, 15.266]];
for (const [i, point] of correctedP5.points.entries()) {
  assert.ok(Math.abs(point.axis1AngleDeg - p5Expected[i][0]) < .0006);
  assert.ok(Math.abs(point.axis2AngleDeg - p5Expected[i][1]) < .0006);
  assert.equal(point.radiusM, .72);
}
for (const axis2Sign of [1, -1] as const) {
  const corrected = planAutoFollow({ ...twoAxisDraft, axis2Sign }, anchor, "drive_internal", origin.port, origin);
  const identity = planAutoFollow({ ...draft, axis2Sign, yawAngleScale: 1 }, anchor, "drive_internal", origin.port, origin);
  assert.equal(corrected.points[0].axis2AngleDeg, anchor.axis2AngleDeg);
  corrected.points.forEach((p, i) => assert.ok(Math.abs(p.axis2AngleDeg - (2 + yawScale * (identity.points[i].axis2AngleDeg - 2))) < 1e-6));
}
for (const value of [0, .4999, 1.5001, NaN, Infinity, null, true, "0.95"]) {
  const bad = planAutoFollow({ ...twoAxisDraft, yawAngleScale: value as number }, null, "drive_internal", origin.port, origin);
  assert.match(bad.errors.join(" "), /水平角校正系数/); assert.equal(bad.points.length, 0);
}
const yawStored = readAutoFollowSurvey(JSON.stringify({ draft: twoAxisDraft }));
assert.equal(surveyDraft(readAutoFollowSurvey(JSON.stringify(yawStored))).yawAngleScale, yawScale);
assert.equal(surveyDraft(readAutoFollowSurvey(JSON.stringify({ draft: legacyDraft }))).yawAngleScale, 1);
const yawSegment = planSegmentedFollow(twoAxisDraft, { pointsPerStart: 2, stepDeg: 90, startAzimuthDeg: 90 }, null, "drive_internal", origin.port, origin);
assert.equal(yawSegment.pointCycle!.geometry!.yawAngleScale, yawScale);
assert.equal(yawSegment.pointCycle!.points[0].axis2AngleDeg, correctedP1.points[1].axis2AngleDeg);
assert.equal(yawSegment.pointCycle!.nextWaitPoint!.axis2AngleDeg, correctedP1.points[3].axis2AngleDeg);
console.log("PASS pointing calibration: physical P1/P5 targets, legacy defaults, validation, anchors, segmented routes and persistence");
