import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldAutoCaptureList } from "./field-auto-capture-list";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import { captureRouteBlockers, captureRouteRequestBlockers, prepareCaptureStartRoute, type FieldCaptureRoute } from "./field-capture-route";
import { moveToCapturePreset, presetPositionRequestError } from "./field-preset-position";
import { readSavedWorkOrigins, workOriginForPlanning } from "./field-turntable-origin";
import { turntableReferenceSignature } from "./field-turntable-points";
import type { FieldAxisFeedback, FieldRequestOptions, FieldStatus } from "./field-types";

const port = "tcp://192.168.10.50:5000";
const axis = (limit: number): FieldAxisFeedback => ({ output_angle_deg: 0, motor_rpm: 0, actual_counts: 0, commanded_counts: 0,
  error_counts: 0, display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 3, fault: 0, origin_counts: 0,
  home_phase: 0, observedAt: Date.now() / 1000, referenceAngleDeg: 0,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const axes = { "1": axis(35), "2": axis(180) };
const stored = { port, generation: 1, referenceSignature: turntableReferenceSignature(axes)!, axis1AngleDeg: 1.212, axis2AngleDeg: .015 };
const saved = readSavedWorkOrigins(JSON.stringify({ version: 1, work: stored, optical: stored })).optical!;
const plan = planAutoFollow({ ...autoFollowDefaults, distanceM: 3, hubHeightDeltaM: .73, stepDeg: 180 }, null, "unknown", port, workOriginForPlanning(saved, port));
const route: FieldCaptureRoute = { kind: "auto", name: "叶片2 P1", pointNames: plan.points.map(point => point.name), errors: [],
  generation: 1, verifyReferenceAtStart: true, cycle: plan.pointCycle! };
const idle: FieldStatus = { state: "idle", service: { state: "ready", dllConfigured: true, generation: 2 },
  laserStatus: { deviceIp: "192.168.106.90", state: "unknown", readAt: null, source: "unavailable", busy: false } };
const checked: FieldStatus = { ...idle, turntable: { state: "checked", port,
  motionCapability: { supported: false, mode: "sequential", protocol: null, probe: "legacy-command-unsupported", status: null },
  feedback: { outputRpm: 0, motorRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0, axes } } };

test("saved origin with absent feedback keeps the same absolute targets available for an explicit probe", () => {
  assert.equal(saved.verificationRequired, true);
  assert.ok(plan.pointCycle);
  assert.equal(plan.pointCycle!.returnToOrigin!.axis1AngleDeg, 1.212);
  assert.equal(plan.pointCycle!.returnToOrigin!.axis2AngleDeg, .015);
  assert.deepEqual(captureRouteRequestBlockers(route, idle), []);
  assert.equal(presetPositionRequestError(route, idle), "");
  assert.ok(captureRouteBlockers(route, idle).length, "Missing feedback does not authorize motion");
  assert.equal(workOriginForPlanning(saved, "COM9"), null, "Saved origins cannot cross device connections");
});

test("one fresh probe revalidates the old signature after restart without changing coordinates", async () => {
  let probes = 0;
  const result = await prepareCaptureStartRoute(route, idle, async () => { probes++; return structuredClone(checked); });
  assert.equal(probes, 1); assert.equal(result.probed, true);
  assert.equal(result.route.generation, 2);
  assert.deepEqual(result.route.cycle, route.cycle);
  assert.equal(result.route.verifyReferenceAtStart, undefined);
  assert.equal(route.generation, 1, "A request never mutates the saved draft");
  assert.deepEqual(captureRouteBlockers(result.route, checked), []);
});

test("a cached running/fault trajectory is read again once; an actually active trajectory still blocks", async () => {
  const stale = structuredClone(checked), bound = { ...route, generation: 2, verifyReferenceAtStart: undefined };
  stale.turntable!.motionCapability = { supported: true, mode: "dual_axis_timed", probe: "confirmed", protocol: "0x30-0x36", status: { state: 3, fault: 0 } };
  let probes = 0;
  const result = await prepareCaptureStartRoute(bound, stale, async () => { probes++; return checked; });
  assert.equal(probes, 1); assert.equal(result.probed, true);
  await assert.rejects(prepareCaptureStartRoute(bound, stale, async () => stale), /轨迹/);
});

test("fresh reference changes, axis faults, limits and communication errors never permit capture", async () => {
  for (const kind of ["reference", "fault", "limit", "generation"]) {
    const bad = structuredClone(checked);
    if (kind === "reference") bad.turntable!.feedback!.axes!["1"].origin_counts++;
    if (kind === "fault") bad.turntable!.feedback!.axes!["2"].fault = 8;
    if (kind === "limit") bad.turntable!.feedback!.axes!["1"].guard.maximum_deg = 1;
    if (kind === "generation") bad.service.generation = 3;
    await assert.rejects(prepareCaptureStartRoute(route, idle, async () => bad), /参考位|静止|软限位|重启/);
  }
  await assert.rejects(prepareCaptureStartRoute(route, idle, async () => { throw Error("fixture timeout"); }), /timeout/);
});

test("pre-positioning reads before moving and a rejected reference never dispatches recall", async () => {
  for (const changed of [false, true]) {
    const fresh = structuredClone(checked), first = route.cycle!.points[0];
    fresh.turntable!.feedback!.axes!["1"].output_angle_deg = first.axis1AngleDeg;
    fresh.turntable!.feedback!.axes!["2"].output_angle_deg = first.axis2AngleDeg;
    if (changed) fresh.turntable!.feedback!.axes!["1"].origin_counts++;
    const calls: FieldRequestOptions[] = [];
    const run = moveToCapturePreset(route, idle, async <T,>(options: FieldRequestOptions) => {
      calls.push(options); assert.equal(options.action, "turntable");
      assert.equal(options.request.action, "probe", "No motion for an already reached or rejected target");
      return structuredClone(fresh) as T;
    }, { signal: new AbortController().signal, current: () => true, onStatus: () => {} });
    if (changed) await assert.rejects(run, /参考位/);
    else assert.equal(await run, "complete");
    assert.equal(calls.length, 1);
  }
});

const render = (status: FieldStatus) => renderToStaticMarkup(<FieldAutoCaptureList
  targets={[{ key: "b2-p1", bladeKey: "b2", bladeId: "2", pointId: "p1", pointName: "P1", radiusM: .31, stations: 2, cycles: 1, route }]}
  config={{ name: "风机任务", deviceIp: "192.168.106.90", hostIp: "192.168.106.10", object: "", turbine: "", point: "" }}
  status={status} busy="" pollError="" onSelect={() => {}} onStart={() => {}} onPosition={() => {}} onConfigureAll={() => {}} onStop={() => {}} />);

test("both actions are clickable with a pending origin and unknown laser badge; SDK failure explains capture-only disable", () => {
  const html = render(idle);
  for (const label of ["移动到预设位置：叶片 2 测点 P1", "开始采集叶片 2 测点 P1"]) {
    const button = [...html.matchAll(/<button\b[^>]*>/g)].find(match => match[0].includes(label))?.[0];
    assert.ok(button); assert.doesNotMatch(button!, /disabled/);
  }
  const noSdk = render({ ...idle, service: { ...idle.service, dllConfigured: false } });
  assert.match(noSdk, /尚未配置测振仪 SDK/);
  assert.match(noSdk, /role="status"/);
  const start = [...noSdk.matchAll(/<button\b[^>]*>/g)].find(match => match[0].includes("开始采集叶片"))![0];
  assert.match(start, /disabled/);
  const position = [...noSdk.matchAll(/<button\b[^>]*>/g)].find(match => match[0].includes("移动到预设位置："))![0];
  assert.doesNotMatch(position, /disabled/, "Laser SDK is not required for positioning-only");
});
