import assert from "node:assert/strict";
import { manualCaptureRoute, manualRouteDefaults, readManualRouteSettings, captureRouteBlockers, prepareCaptureRoute, prepareCaptureStartRoute, type FieldCaptureRoute } from "./field-capture-route";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import { planSegmentedFollow, segmentedDefaults } from "./field-segmented-plan";
import { turntableReferenceSignature } from "./field-turntable-points";
import type { FieldAxisFeedback, FieldBladePoint, FieldStatus } from "./field-types";
const axis = (limit: number): FieldAxisFeedback => ({ output_angle_deg: 0, motor_rpm: 0, actual_counts: 0, commanded_counts: 0, error_counts: 0,
  display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 3, fault: 0, origin_counts: 0, home_phase: 0, observedAt: 0,
  referenceAngleDeg: 0, guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const axes = { "1": axis(35), "2": axis(180) };
const status: FieldStatus = { service: { state: "ready", dllConfigured: true, generation: 1 }, state: "idle", turntable: { state: "checked", port: "COM6", motionCapability: { supported: false, mode: "sequential", protocol: null, probe: "legacy-command-unsupported", status: null }, feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0, axes } } };
const points: FieldBladePoint[] = [0, 20, 1].map((angle, index) => ({ pointId: `p${index}`, name: `M${index}`, bladeIndex: 1, bladePointIndex: 1, circleIndex: index + 1, circleStepDeg: 90,
  axis1AngleDeg: angle, axis2AngleDeg: 0, axis1RawCounts: 0, axis2RawCounts: 0, port: "COM6", referenceSignature: turntableReferenceSignature(axes), recordedAt: 0 }));
const route = manualCaptureRoute(points, "COM6", manualRouteDefaults, 1);
assert.deepEqual(captureRouteBlockers(route, status), []);
assert.deepEqual(route.cycle!.points.map(p => p.axis1AngleDeg), [0, 20, 1]);
assert.equal(route.cycle!.routeOrder, "configured"); assert.equal(route.cycle!.rssiTriggerEnabled, true);
assert.equal(route.cycle!.motionLaserPolicy, "continuous");
const workZero = { port: "COM6", generation: 1, referenceSignature: turntableReferenceSignature(axes)!, axis1AngleDeg: 2, axis2AngleDeg: -16 };
const zeroRoute = manualCaptureRoute(points, "COM6", manualRouteDefaults, 1, workZero);
assert.deepEqual(captureRouteBlockers(zeroRoute, status), []);
assert.equal(zeroRoute.cycle!.returnToOrigin!.axis1AngleDeg, 2);
assert.equal(zeroRoute.cycle!.returnToOrigin!.axis2AngleDeg, -16);
const originOutside = structuredClone(status);
originOutside.turntable!.feedback!.axes!["2"].guard.minimum_deg = -10;
assert.ok(captureRouteBlockers(zeroRoute, originOutside).some(x => x.includes("作业原点") && x.includes("软限位")));
assert.deepEqual(manualCaptureRoute(points, "COM6", { ...manualRouteDefaults, excludedIds: ["p1"] }, 1).pointNames, ["M0", "M2"]);
assert.deepEqual(manualCaptureRoute([points[2], points[0]], "COM6", manualRouteDefaults, 1).pointNames, ["M2", "M0"]);
const pointSnapshot = structuredClone(points);
const selectedStart = manualCaptureRoute(points, "COM6", { ...manualRouteDefaults, startPointId: "p1" }, 1, workZero);
assert.deepEqual(selectedStart.pointNames, ["M1", "M2", "M0"], "Clicking a saved manual station sets the next acquisition start and preserves cyclic order");
assert.deepEqual(selectedStart.cycle!.points.map(point => point.axis1AngleDeg), [20, 1, 0]);
assert.deepEqual(selectedStart.cycle!.returnToOrigin, zeroRoute.cycle!.returnToOrigin, "Selecting a station never changes the work origin");
assert.deepEqual(points, pointSnapshot, "Selecting a start does not rewrite saved point coordinates or order");
assert.deepEqual(captureRouteBlockers(selectedStart, status), []);
assert.deepEqual(manualCaptureRoute(points, "COM6", { ...manualRouteDefaults, startPointId: "missing" }, 1).pointNames, route.pointNames);
assert.deepEqual(manualCaptureRoute(points, "COM6", { ...manualRouteDefaults, excludedIds: ["p1"], startPointId: "p1" }, 1).pointNames,
  ["M0", "M2"], "An excluded start cannot reintroduce an excluded station");
assert.deepEqual(manualCaptureRoute(points, "COM6", { ...manualRouteDefaults, excludedIds: ["p1"], startPointId: "p2" }, 1).pointNames, ["M2", "M0"]);
assert.ok(captureRouteBlockers(route, { ...status, service: { ...status.service, generation: 2 } }).some(x => x.includes("重启")));
const changed = structuredClone(status); changed.turntable!.feedback!.axes!["1"].origin_counts++;
assert.ok(captureRouteBlockers(route, changed).some(x => x.includes("参考位")));
const moving = structuredClone(status); moving.turntable!.feedback!.axes!["2"].motor_rpm = .1;
assert.ok(captureRouteBlockers(route, moving).some(x => x.includes("静止")));
const narrow = structuredClone(status); narrow.turntable!.feedback!.axes!["1"].guard.maximum_deg = 10;
assert.ok(captureRouteBlockers(route, narrow).some(x => x.includes("超出当前软限位")));
for (const state of [1, 2, 3, 4, 5, 7]) {
  const controller = structuredClone(status);
  controller.turntable!.motionCapability = { supported: true, mode: "dual_axis_timed", protocol: "0x30-0x36", probe: "confirmed", status: { state, fault: state === 7 ? 7 : 0 } };
  assert.ok(captureRouteBlockers(route, controller).some(message => message.includes(state === 7 ? "轨迹存在故障" : "待启动或运行")));
}
for (const state of [0, 6, 8]) {
  const controller = structuredClone(status);
  controller.turntable!.motionCapability = { supported: true, mode: "dual_axis_timed", protocol: "0x30-0x36", probe: "confirmed", status: { state, fault: state === 8 ? 1 : 0 } };
  assert.deepEqual(captureRouteBlockers(route, controller), []);
}
for (const patch of [{ cycles: 0 }, { cycles: NaN }, { speedRpm: 0 }, { speedRpm: 11 }, { waitSeconds: Infinity }, { rssiExitSpread: 9 }, { rssiConfirmMs: 0 }]) {
  assert.equal(manualCaptureRoute(points, "COM6", { ...manualRouteDefaults, ...patch }).cycle, null);
}
assert.equal(manualCaptureRoute([], "COM6", manualRouteDefaults).cycle, null);
const missing = structuredClone(points); delete missing[0].referenceSignature;
assert.equal(manualCaptureRoute(missing, "COM6", manualRouteDefaults).cycle, null);
assert.deepEqual(readManualRouteSettings("bad json"), manualRouteDefaults);
assert.equal("enabled" in readManualRouteSettings('{"enabled":true,"excludedIds":["p1",2]}'), false);
assert.equal(readManualRouteSettings('{"startPointId":"p2"}').startPointId, "p2");
assert.equal(readManualRouteSettings('{"startPointId":42}').startPointId, undefined);
assert.equal(readManualRouteSettings('{"startPointId":"  "}').startPointId, undefined);
for (const port of ["COM3", "/dev/cu.usbserial-1140"]) {
  const next = structuredClone(status); next.turntable!.port = port;
  const route = manualCaptureRoute(points.map(point => ({ ...point, port })), port, manualRouteDefaults, 1);
  assert.deepEqual(captureRouteBlockers(route, next), []);
}
console.log("PASS manual route order, selection, reference/generation, bounded echo configuration and Mac/Windows contracts");

const plan = planAutoFollow(autoFollowDefaults, null, "unknown", "COM6");
assert.ok(plan.pointCycle);
const theoretical: FieldCaptureRoute = { kind: "auto", name: "计算点位", pointNames: plan.points.map(point => point.name), errors: [],
  referenceMode: "read_at_start", cycle: plan.pointCycle! };
const noCachedMotor: FieldStatus = { service: { state: "ready", dllConfigured: true, generation: 1 }, state: "idle" };
assert.deepEqual(captureRouteBlockers(theoretical, noCachedMotor), [], "No cached probe or optical calibration is required to request a fresh start check");
const snapshot = structuredClone(theoretical);
const prepared = prepareCaptureRoute(theoretical, status);
assert.equal(prepared.referenceMode, undefined);
assert.equal(prepared.generation, status.service.generation);
assert.deepEqual(captureRouteBlockers(prepared, status), []);
assert.ok(prepared.cycle!.points.every(point => point.port === "COM6" && point.referenceSignature === turntableReferenceSignature(axes)));
assert.deepEqual(prepared.cycle!.geometry, theoretical.cycle!.geometry, "Binding references never shifts planned geometry or target angles");
assert.deepEqual(prepared.cycle!.points.map(point => [point.axis1AngleDeg, point.axis2AngleDeg]), plan.points.map(point => [point.axis1AngleDeg, point.axis2AngleDeg]));
assert.deepEqual(theoretical, snapshot, "The confirmation snapshot is immutable");
const segment = planSegmentedFollow(autoFollowDefaults, segmentedDefaults, null, "drive_internal", "COM6");
const segmentRoute: FieldCaptureRoute = { kind: "segmented", name: "分段采集", errors: segment.errors, pointNames: [],
  referenceMode: "read_at_start", cycle: segment.pointCycle! };
assert.deepEqual(captureRouteBlockers(segmentRoute, noCachedMotor), []);
const boundSegment = prepareCaptureRoute(segmentRoute, status);
assert.equal(boundSegment.cycle!.nextWaitPoint!.referenceSignature, turntableReferenceSignature(axes));
assert.ok(boundSegment.cycle!.segmentStations!.every(point => point.referenceSignature === turntableReferenceSignature(axes)));
assert.equal(segmentRoute.cycle!.nextWaitPoint!.referenceSignature, undefined, "Reference binding cannot mutate saved geometry");
const unsafeNext = structuredClone(segmentRoute);
unsafeNext.cycle!.nextWaitPoint!.axis1AngleDeg = 40;
assert.ok(captureRouteBlockers(unsafeNext, noCachedMotor).length, "The post-capture waiting move must be range checked");
const changedNextReference = structuredClone(boundSegment);
changedNextReference.cycle!.nextWaitPoint!.referenceSignature = JSON.stringify([[123, 3, 10000, 17], [0, 3, 10000, 17]]);
assert.ok(captureRouteBlockers(changedNextReference, status).some(message => message.includes("参考")));
const skippedSegment = structuredClone(segmentRoute);
skippedSegment.cycle!.nextWaitPoint = skippedSegment.cycle!.segmentStations![2];
assert.ok(captureRouteBlockers(skippedSegment, noCachedMotor).some(message => message.includes("顺序")));
const repeatingSegment = structuredClone(segmentRoute); repeatingSegment.cycle!.cycles = 2;
assert.ok(captureRouteBlockers(repeatingSegment, noCachedMotor).length, "Every segment must require another manual start");
const manualBladePlan = planAutoFollow({ ...autoFollowDefaults, periodSeconds: 0 }, null, "sequential", "COM6");
const manualBladeRoute: FieldCaptureRoute = { kind: "auto", name: "人手转动", pointNames: manualBladePlan.points.map(point => point.name), errors: [], referenceMode: "read_at_start", cycle: manualBladePlan.pointCycle! };
assert.deepEqual(captureRouteBlockers(manualBladeRoute, noCachedMotor), []);
const manualBladePrepared = prepareCaptureRoute(manualBladeRoute, status);
assert.equal(manualBladePrepared.cycle!.nominalPeriodSeconds, 0);
assert.equal(manualBladePrepared.cycle!.speedRpm, .6);
assert.equal(manualBladePrepared.cycle!.motionLaserPolicy, "continuous");
assert.deepEqual(captureRouteBlockers(manualBladePrepared, status), []);
assert.throws(() => prepareCaptureRoute(manualBladePrepared, changed), /参考位.*变化/, "Manual blade operation never replaces an already bound reference");
const calibratedPlan = planAutoFollow(autoFollowDefaults, { port: "COM6", referenceSignature: turntableReferenceSignature(axes)!,
  radiusM: .31, pointId: "p1", axis1AngleDeg: 0, axis2AngleDeg: 0 }, "sequential", "COM6");
const calibratedRoute: FieldCaptureRoute = { kind: "auto", name: "已校准测点", pointNames: calibratedPlan.points.map(point => point.name),
  errors: [], generation: 1, cycle: calibratedPlan.pointCycle! };
assert.equal(calibratedRoute.cycle!.startAtCurrentPose, true);
assert.deepEqual(captureRouteBlockers(calibratedRoute, status), []);
assert.deepEqual(prepareCaptureRoute(calibratedRoute, status).cycle, calibratedRoute.cycle);
for (const axis of [1, 2]) {
  const drifted = structuredClone(status); drifted.turntable!.feedback!.axes![String(axis)].output_angle_deg = .501;
  assert.throws(() => prepareCaptureRoute(calibratedRoute, drifted), /首点位置已变化/);
  const near = structuredClone(status); near.turntable!.feedback!.axes![String(axis)].output_angle_deg = .5;
  assert.deepEqual(captureRouteBlockers(calibratedRoute, near), []);
}
const stillPositions = structuredClone(theoretical);
assert.equal(stillPositions.cycle!.startAtCurrentPose, false);
assert.deepEqual(prepareCaptureRoute(stillPositions, status).cycle!.points.map(point => point.axis1AngleDeg), plan.points.map(point => point.axis1AngleDeg),
  "Uncalibrated geometry retains its explicit initial move instead of being rebound to the current pose");
assert.throws(() => prepareCaptureRoute(theoretical, noCachedMotor), /两轴有效参考位/);
const noGeneration = structuredClone(status); delete noGeneration.service.generation;
assert.throws(() => prepareCaptureRoute(theoretical, noGeneration), /代际/);
const wrongPort = structuredClone(status); wrongPort.turntable!.port = "COM7";
assert.throws(() => prepareCaptureRoute(theoretical, wrongPort), /两轴有效参考位/);
const noLimits = structuredClone(status); noLimits.turntable!.feedback!.axes!["1"].guard.soft_enabled = false;
assert.throws(() => prepareCaptureRoute(theoretical, noLimits), /软限位/);
const noHorizontalLimits = structuredClone(status);
Object.assign(noHorizontalLimits.turntable!.feedback!.axes!["2"].guard, { soft_enabled: false, minimum_deg: NaN, maximum_deg: NaN });
assert.deepEqual(captureRouteBlockers(route, noHorizontalLimits), [], "Manual point capture permits an unbounded referenced horizontal axis");
assert.deepEqual(captureRouteBlockers(prepareCaptureRoute(theoretical, noHorizontalLimits), noHorizontalLimits), [], "Freshly bound automatic capture permits optional horizontal soft limits");
for (const patch of [{ output_angle_deg: null }, { output_angle_deg: 180.01 }, { motor_rpm: .01 }, { fault: 2 }, { flags: 17 }]) {
  const invalid = structuredClone(noHorizontalLimits); Object.assign(invalid.turntable!.feedback!.axes!["2"], patch);
  assert.ok(captureRouteBlockers(route, invalid).length > 0, "Optional horizontal limits cannot bypass valid reference, envelope, stillness or fault checks");
  assert.throws(() => prepareCaptureRoute(theoretical, invalid));
}
const changedHorizontalReference = structuredClone(noHorizontalLimits); changedHorizontalReference.turntable!.feedback!.axes!["2"].origin_counts++;
assert.throws(() => prepareCaptureRoute(route, changedHorizontalReference), /参考位.*变化/);
for (const [minimum_deg, maximum_deg] of [[NaN, 180], [-180, Infinity], [10, -10], [0, 0], [1, 10]]) {
  const invalid = structuredClone(status); Object.assign(invalid.turntable!.feedback!.axes!["2"].guard, { minimum_deg, maximum_deg });
  assert.ok(captureRouteBlockers(route, invalid).some(message => message.includes("软限位")));
  assert.throws(() => prepareCaptureRoute(theoretical, invalid), /软限位/);
}
const narrowHorizontal = structuredClone(status); Object.assign(narrowHorizontal.turntable!.feedback!.axes!["2"].guard, { minimum_deg: -1, maximum_deg: 1 });
assert.deepEqual(captureRouteBlockers(route, narrowHorizontal), [], "A narrow horizontal limit accepts targets within that range");
assert.throws(() => prepareCaptureRoute(theoretical, narrowHorizontal), /超出当前软限位/, "Automatic targets must fit the active actual horizontal range");
const wideHorizontal = structuredClone(status); Object.assign(wideHorizontal.turntable!.feedback!.axes!["2"].guard, { minimum_deg: -360, maximum_deg: 360 });
assert.deepEqual(captureRouteBlockers(route, wideHorizontal), []);
const outOfProductRange = structuredClone(prepared); outOfProductRange.cycle!.points[0].axis2AngleDeg = 180.01;
assert.ok(captureRouteBlockers(outOfProductRange, wideHorizontal).some(message => message.includes("±180")));
const outside = structuredClone(status); outside.turntable!.feedback!.axes!["1"].output_angle_deg = 36;
assert.throws(() => prepareCaptureRoute(theoretical, outside), /当前位置.*超出/);
const restricted = structuredClone(status); restricted.turntable!.feedback!.axes!["1"].guard.maximum_deg = 10;
assert.throws(() => prepareCaptureRoute(theoretical, restricted), /超出当前软限位/);
const unsupported = structuredClone(status); delete unsupported.turntable!.motionCapability;
assert.deepEqual(captureRouteBlockers(theoretical, unsupported), [], "Unknown cached motion capability may be resolved by the fresh probe");
assert.throws(() => prepareCaptureRoute(theoretical, unsupported), /确认控制器换点方式/);
assert.ok(captureRouteBlockers(theoretical, moving).some(message => message.includes("静止")));
assert.throws(() => prepareCaptureRoute(theoretical, moving), /静止/);
const badController = structuredClone(status);
badController.turntable!.motionCapability = { supported: true, mode: "dual_axis_timed", protocol: "0x30-0x36", probe: "confirmed", status: { state: 7, fault: 7 } };
assert.ok(captureRouteBlockers(theoretical, badController).some(message => message.includes("轨迹存在故障")));
assert.throws(() => prepareCaptureRoute(theoretical, badController), /轨迹存在故障/);
const badGeometry = structuredClone(theoretical); badGeometry.cycle!.geometry!.hubHeightDeltaM = NaN;
assert.ok(captureRouteBlockers(badGeometry, noCachedMotor).some(message => message.includes("几何")));
const outOfRange = structuredClone(theoretical); outOfRange.cycle!.points[0].axis1AngleDeg = 36;
assert.ok(captureRouteBlockers(outOfRange, noCachedMotor).some(message => message.includes("角度")));
assert.deepEqual(prepareCaptureRoute(route, status), route, "Manual and calibrated routes retain original references");
assert.throws(() => prepareCaptureRoute(route, changed), /参考位.*变化/);
assert.throws(() => prepareCaptureRoute(prepared, changed), /参考位.*变化/, "A bound auto route cannot silently rebind changed controller references");
assert.throws(() => prepareCaptureRoute({ ...route, referenceMode: "read_at_start" }, status), /不能覆盖已保存的参考位|仅适用于自动/);
for (const port of ["COM3", "/dev/cu.usbserial-1140"]) {
  const next = structuredClone(status); next.turntable!.port = port;
  next.turntable!.feedback!.axes!["2"].guard.soft_enabled = false;
  const plan = planAutoFollow(autoFollowDefaults, null, "unknown", port);
  const route: FieldCaptureRoute = { ...theoretical, cycle: plan.pointCycle! };
  assert.deepEqual(captureRouteBlockers(route, noCachedMotor), []);
  assert.ok(prepareCaptureRoute(route, next).cycle!.points.every(point => point.port === port && !!point.referenceSignature));
}
console.log("PASS theoretical routes allow a fresh probe, bind checked references once, reject bad hardware feedback and preserve calibrated/manual references");

void (async () => {
  let probes = 0;
  const probe = async () => { probes++; return structuredClone(status); };
  const existing = await prepareCaptureStartRoute(route, status, probe);
  assert.equal(existing.probed, false);
  assert.equal(probes, 0, "Pre-positioned/bound routes must not issue a duplicate renderer probe");
  await assert.rejects(prepareCaptureStartRoute(route, null, probe), /读取设备状态/);
  await assert.rejects(prepareCaptureStartRoute(route, { ...status, service: { ...status.service, generation: 2 } }, probe), /重启/);
  assert.equal(probes, 1, "A changed service is read once; a late reply from another generation cannot be used");
  const calculated = await prepareCaptureStartRoute(theoretical, noCachedMotor, probe);
  assert.equal(calculated.probed, true);
  assert.equal(probes, 2, "An unbound calculated route still reads references once");
  assert.deepEqual(calculated.route.cycle!.points.map(p => p.referenceSignature), prepared.cycle!.points.map(p => p.referenceSignature));
  const cached = await prepareCaptureStartRoute(theoretical, status, probe);
  assert.equal(cached.probed, false);
  assert.equal(probes, 2, "Existing theoretical reference identity need not be read twice before service validation");
  const missingCapability = await prepareCaptureStartRoute(theoretical, unsupported, probe);
  assert.equal(missingCapability.probed, true);
  assert.equal(probes, 3);
  const restarted = { ...status, service: { ...status.service, generation: 2 } };
  const revalidated = await prepareCaptureStartRoute(route, restarted, async () => structuredClone(restarted));
  assert.equal(revalidated.route.generation, 2);
  assert.deepEqual(revalidated.route.cycle!.points, route.cycle!.points, "A restart rechecks original signatures without rebinding coordinates");
  console.log("PASS start probes missing or pending feedback once, rejects cross-generation replies, and revalidates saved references");
})().catch(error => { console.error(error); process.exitCode = 1; });
