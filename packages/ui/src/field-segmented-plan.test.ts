import assert from "node:assert/strict";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import { planSegmentedFollow, readSegmentSettings, segmentedDefaults, segmentedRouteAtAzimuth, type SegmentSettings } from "./field-segmented-plan";
import type { FieldCaptureRoute } from "./field-capture-route";

const draft = { ...autoFollowDefaults, distanceM: 2.5, hubHeightDeltaM: .73, periodSeconds: 5,
  maxMoveRpm: 5, maxMoveAccelerationDegS2: 30, rssiExitSpread: 4,
  points: [{ id: "p3", name: "P3", radiusM: .44 }], activePointId: "p3", cycles: 3 };
const port = "tcp://192.168.10.50:5000";
const full = planAutoFollow({ ...draft, cycles: 1 }, null, "drive_internal", port);
assert.deepEqual(full.errors, []);

for (const pointsPerStart of [1, 2] as const) for (const stepDeg of pointsPerStart === 2 ? [90] : [90, 120, 180, 60, 45, 30, 22.5]) {
  const count = 360 / stepDeg;
  for (let start = 0; start < count; start++) {
    const planned = planSegmentedFollow(draft, { pointsPerStart, stepDeg, startAzimuthDeg: start * stepDeg }, null, "drive_internal", port);
    assert.deepEqual(planned.errors, []);
    assert.equal(planned.points.length, pointsPerStart);
    assert.equal(planned.totalRecords, pointsPerStart, "A manual click cannot inherit automatic mode's repeat count");
    assert.equal(planned.allPoints.length, count);
    assert.deepEqual(planned.points.map(point => point.azimuthDeg),
      Array.from({ length: pointsPerStart }, (_, offset) => ((start + offset) % count) * stepDeg));
    assert.equal(planned.nextStartAzimuthDeg, ((start + pointsPerStart) % count) * stepDeg);
    assert.equal(planned.pointCycle!.nextWaitPoint, planned.nextStartPoint);
    assert.equal(planned.pointCycle!.returnToOrigin, undefined, "Completion moves to the next waiting point, not the work origin");
    assert.equal(planned.pointCycle!.executionMode, "manual_segments");
    assert.equal(planned.pointCycle!.mode, "automatic_stations", "Existing point ownership/archive remains compatible");
    assert.equal(planned.pointCycle!.cycles, 1);
    assert.equal(planned.pointCycle!.motionLaserPolicy, "continuous");
    assert.equal(planned.pointCycle!.totalStationCount, count);
    assert.equal(planned.pointCycle!.segmentStations, planned.allPoints);
    assert.equal(planned.pointCycle!.rssiEnterConfirmMs, 20);
    assert.equal(planned.pointCycle!.rssiConfirmMs, 30);
    assert.equal(planned.pointCycle!.rssiExitSpread, 4);
    assert.equal(planned.pointCycle!.speedRpm, 5);
  }
}
const selected = planSegmentedFollow(draft, { pointsPerStart: 1, stepDeg: 90, startAzimuthDeg: 180 }, null, "drive_internal", port);
assert.deepEqual(selected.allPoints, full.points, "Manual segmentation never changes geometric coordinates");
assert.deepEqual(selected.points[0], full.points[2]);
assert.equal(selected.points[0].radialPointId, "p3");
assert.equal(selected.nextStartPoint!.azimuthDeg, 270);

const signature = JSON.stringify([[0, 1, 10000, 17], [0, 1, 10000, 17]]);
const origin = { port, generation: 1, referenceSignature: signature, axis1AngleDeg: .267, axis2AngleDeg: .234 };
const corrected = planSegmentedFollow(draft, segmentedDefaults, null, "drive_internal", port, origin);
assert.deepEqual(corrected.errors, []);
for (let i = 0; i < full.points.length; i++) {
  assert.ok(Math.abs(corrected.allPoints[i].axis1AngleDeg - full.points[i].axis1AngleDeg - .267) < 1e-6);
  assert.ok(Math.abs(corrected.allPoints[i].axis2AngleDeg - full.points[i].axis2AngleDeg - .234) < 1e-6);
  assert.equal(corrected.allPoints[i].referenceSignature, signature);
}
assert.equal(corrected.nextStartPoint!.referenceSignature, signature);
const initialRoute: FieldCaptureRoute = { kind: "segmented", name: "test", pointNames: corrected.points.map(point => point.name),
  errors: [], cycle: corrected.pointCycle!, generation: 1 };
const at270 = segmentedRouteAtAzimuth(initialRoute, 270);
assert.equal(at270.cycle!.points[0].azimuthDeg, 270);
assert.equal(at270.cycle!.nextWaitPoint!.azimuthDeg, 0);
assert.equal(at270.cycle!.points[0].referenceSignature, signature);
assert.equal(at270.generation, 1);
assert.equal(initialRoute.cycle!.points[0].azimuthDeg, 0, "Immediate positioning selection never mutates saved route");
assert.equal(segmentedRouteAtAzimuth(at270, 360).cycle!.points[0].azimuthDeg, 0);
assert.throws(() => segmentedRouteAtAzimuth(initialRoute, 45), /已计算/);
assert.throws(() => segmentedRouteAtAzimuth(initialRoute, NaN), /已计算/);
assert.throws(() => segmentedRouteAtAzimuth({ ...initialRoute, kind: "auto" }, 0), /分段采集/);
const anchored = planSegmentedFollow(draft, { ...segmentedDefaults, startAzimuthDeg: 90 }, {
  port, referenceSignature: signature, radiusM: .44, pointId: "p3", axis1AngleDeg: 5, axis2AngleDeg: 1,
}, "drive_internal", port);
assert.deepEqual(anchored.errors, []);
assert.equal(anchored.origin, "calibrated");
assert.equal(anchored.pointCycle!.startAtCurrentPose, false, "Calibration at 0 degrees must not lock starts selected at another angle");

for (const patch of [{ pointsPerStart: 0 }, { pointsPerStart: 3 }, { startAzimuthDeg: 45 }, { startAzimuthDeg: NaN },
  { startAzimuthDeg: 360 }, { stepDeg: 0 }, { stepDeg: 70 }, ...[22.5, 30, 45, 60, 120, 180].map(stepDeg => ({ pointsPerStart: 2, stepDeg }))]) {
  const rejected = planSegmentedFollow(draft, { ...segmentedDefaults, ...patch } as SegmentSettings, null, "drive_internal", port);
  assert.ok(rejected.errors.length, JSON.stringify(patch));
  assert.equal(rejected.pointCycle, undefined);
}
assert.deepEqual(readSegmentSettings(null, 120), { ...segmentedDefaults, stepDeg: 120 });
assert.deepEqual(readSegmentSettings("broken", 120), { ...segmentedDefaults, stepDeg: 120 });
assert.equal(readSegmentSettings('{"stepDeg":90,"startAzimuthDeg":270,"pointsPerStart":2}').startAzimuthDeg, 270);
assert.deepEqual(readSegmentSettings('{"stepDeg":120,"startAzimuthDeg":120,"pointsPerStart":2}'), { pointsPerStart: 2, stepDeg: 90, startAzimuthDeg: 0, autoMove: true });
assert.deepEqual(readSegmentSettings('{"stepDeg":120,"startAzimuthDeg":120,"pointsPerStart":1}'), { pointsPerStart: 1, stepDeg: 120, startAzimuthDeg: 120, autoMove: true });
assert.throws(() => segmentedRouteAtAzimuth({ ...initialRoute, cycle: { ...initialRoute.cycle!, points: corrected.allPoints.slice(0, 2), segmentStepDeg: 120 } }, 0), /固定为90/);
assert.ok(Number.isNaN(readSegmentSettings('{"stepDeg":"bad"}').stepDeg), "Malformed saved motion settings must not silently become a new route");
assert.equal(readSegmentSettings('{"autoMove":false}').autoMove, false);
assert.equal(readSegmentSettings('{"autoMove":"false"}').autoMove, true);
assert.equal(planSegmentedFollow(draft, { ...segmentedDefaults, autoMove: false }, null, "drive_internal", port).pointCycle!.segmentedAutoMove, false);
assert.equal(segmentedRouteAtAzimuth({ ...initialRoute, cycle: { ...initialRoute.cycle!, segmentedAutoMove: false } }, 90).cycle!.segmentedAutoMove, false);
console.log("PASS segmented geometry, manual start boundaries, wraparound, wait pose, shared origin and invalid configuration");
