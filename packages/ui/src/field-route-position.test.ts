import assert from "node:assert/strict";
import { routeAtPositionedStation, replacePositionedTarget, positioningRouteContext } from "./field-route-position";
import type { FieldCaptureRoute } from "./field-capture-route";

const points = [0, 90, 180, 270].map((angle, i) => ({ pointId: `p${i}`, name: `${angle}°`, azimuthDeg: angle,
  axis1AngleDeg: i, axis2AngleDeg: i * 2, referenceSignature: "reference" }));
const segmented: FieldCaptureRoute = { kind: "segmented", name: "P4", pointNames: ["0°", "90°"], errors: [],
  cycle: { port: "COM3", points: points.slice(0, 2), segmentStations: points, nextWaitPoint: points[2],
    executionMode: "manual_segments", segmentStepDeg: 90, totalStationCount: 4, cycles: 1, speedRpm: 1, dwellSeconds: 60 } };
for (let i = 0; i < 4; i++) {
  const next = routeAtPositionedStation(segmented, `p${i}`);
  assert.deepEqual(next.cycle!.points.map(p => p.azimuthDeg), [i * 90, ((i + 1) % 4) * 90]);
  assert.equal(next.cycle!.nextWaitPoint!.azimuthDeg, ((i + 2) % 4) * 90);
  assert.deepEqual(next.cycle!.segmentStations, points);
}
const single = structuredClone(segmented); single.cycle!.points = [points[0]];
assert.equal(routeAtPositionedStation(single, "p3").cycle!.nextWaitPoint!.azimuthDeg, 0);
assert.deepEqual(segmented.cycle!.points, points.slice(0, 2), "planning must not mutate saved route before arrival");
const manual: FieldCaptureRoute = { ...segmented, kind: "manual", cycle: { ...segmented.cycle!, mode: "legacy", executionMode: "continuous", points } };
assert.deepEqual(routeAtPositionedStation(manual, "p2").cycle!.points.map(p => p.pointId), ["p2", "p3", "p0", "p1"]);
assert.throws(() => routeAtPositionedStation({ ...segmented, kind: "auto" }, "p1"), /仅供查看/);
assert.throws(() => routeAtPositionedStation(segmented, "unknown"), /点位已变化/);
const refreshed = structuredClone(segmented); refreshed.generation = 2; refreshed.verifyReferenceAtStart = true;
refreshed.cycle!.points.forEach(p => { p.referenceSignature = "new verified reference"; });
assert.equal(positioningRouteContext(segmented), positioningRouteContext(refreshed));
refreshed.cycle!.points[0].axis1AngleDeg += 1;
assert.notEqual(positioningRouteContext(segmented), positioningRouteContext(refreshed), "geometry edits invalidate late arrival result");
const a = { key: "a", bladeKey: "b", bladeId: "2", pointId: "p4", pointName: "P4", radiusM: .58, stations: 2, cycles: 1, route: segmented };
const b = { ...a, key: "b", pointId: "p5" };
const selected = routeAtPositionedStation(segmented, "p2");
const all = replacePositionedTarget({ ...segmented, targets: [a, b], selectedTargetKey: "b" }, selected, "a");
assert.equal(all.selectedTargetKey, "a");
assert.deepEqual(all.targets![0].route.cycle!.points, selected.cycle!.points);
assert.equal(all.targets![1], b, "other radial point cursors must not change");
console.log("PASS route positioning: segment wrapping, manual ordering, readonly auto, stale context and target isolation");
