import assert from "node:assert/strict";
import { moveToCapturePreset, presetPositionError } from "./field-preset-position";
import { captureRouteBlockers, type FieldCaptureRoute } from "./field-capture-route";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import { turntableReferenceSignature } from "./field-turntable-points";
import type { FieldAxisFeedback, FieldRequestOptions, FieldStatus } from "./field-types";

const axis = (limit: number): FieldAxisFeedback => ({ output_angle_deg: 0, motor_rpm: 0, actual_counts: 0, commanded_counts: 0,
  error_counts: 0, display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 3, fault: 0,
  origin_counts: 0, home_phase: 0, observedAt: 1, referenceAngleDeg: 0,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const axes = { "1": axis(35), "2": axis(180) };
const ready: FieldStatus = { service: { state: "ready", dllConfigured: false, generation: 1 }, state: "idle",
  turntable: { state: "checked", port: "COM6", motionCapability: { supported: false, mode: "sequential",
    protocol: null, probe: "legacy-command-unsupported", status: null },
    feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0, axes } } };
const route: FieldCaptureRoute = { kind: "manual", name: "route", errors: [], pointNames: ["first", "second"], generation: 1,
  cycle: { port: "COM6", mode: "legacy", routeOrder: "configured", speedRpm: .6, dwellSeconds: 60, cycles: 1,
    points: [5, 1].map(angle => ({ name: String(angle), axis1AngleDeg: angle, axis2AngleDeg: -2,
      port: "COM6", referenceSignature: turntableReferenceSignature(axes) })) } };
async function run(patch: {
  route?: FieldCaptureRoute; port?: string; abortAt?: string; drift?: boolean; referenceChanged?: boolean;
  generationChanged?: boolean; lostReply?: boolean; fault?: boolean;
  alreadyAtTarget?: boolean;
} = {}) {
  const plan = structuredClone(patch.route || route), initial = structuredClone(ready);
  const port = patch.port || "COM6";
  initial.turntable!.port = plan.cycle!.port = port;
  for (const point of plan.cycle!.points) point.port = port;
  if (patch.alreadyAtTarget) {
    initial.turntable!.feedback!.axes!["1"].output_angle_deg = plan.cycle!.points[0].axis1AngleDeg + .5;
    initial.turntable!.feedback!.axes!["2"].output_angle_deg = plan.cycle!.points[0].axis2AngleDeg - .5;
  }
  const calls: FieldRequestOptions[] = [], abort = new AbortController();
  const resultStatuses: FieldStatus[] = [];
  let state = structuredClone(initial), recalls = 0, stops = 0;
  const request = async <T,>(action: FieldRequestOptions): Promise<T> => {
    calls.push(structuredClone(action));
    assert.ok(action.action === "status" || action.action === "turntable", "Never invokes start, laser, record or configuration writes");
    if (action.action === "turntable") {
      if (action.request.action === "recall") {
        recalls++; state.turntableBusy = true;
        state.turntable!.recall = { state: "moving", targets: [action.request.axis1AngleDeg!, action.request.axis2AngleDeg!], completedAxes: [] };
        if (patch.lostReply) throw new Error("response lost");
      }
      if (action.request.action === "stop") {
        stops++; state.turntableBusy = false;
        state.turntable!.error = undefined;
        state.turntable!.recall!.state = "cancelled";
        for (const value of Object.values(state.turntable!.feedback!.axes!)) value.fault = 0;
      }
      if (patch.abortAt === action.request.action) abort.abort();
      if (action.request.action === "probe" && recalls && !stops && patch.drift) state.turntable!.feedback!.axes!["2"].output_angle_deg! += .6;
    } else {
      state.turntableBusy = false;
      state.turntable!.recall!.state = "complete";
      for (const [i, angle] of state.turntable!.recall!.targets.entries()) state.turntable!.feedback!.axes![String(i + 1)].output_angle_deg = angle;
      if (patch.referenceChanged) state.turntable!.feedback!.axes!["1"].origin_counts++;
      if (patch.generationChanged) state.service.generation = 2;
      if (patch.fault) state.turntable!.feedback!.axes!["2"].fault = 7;
    }
    return structuredClone(state) as T;
  };
  let outcome = "", error = "";
  try { outcome = await moveToCapturePreset(plan, initial, request, {
    signal: abort.signal, current: () => true, onStatus: next => resultStatuses.push(next), wait: async () => {},
  }); } catch (cause) { error = (cause as Error).message; }
  return { outcome, error, calls, resultStatuses, plan, recalls, stops };
}

async function main() {
  const repeated = await run({ alreadyAtTarget: true });
  assert.equal(repeated.outcome, "complete", repeated.error);
  assert.equal(repeated.recalls, 0, "A fresh stopped pose at the absolute preset never starts another positioning job");
  assert.equal(repeated.stops, 0);
  assert.deepEqual(repeated.calls.map(call => call.action === "turntable" ? call.request.action : call.action), ["probe"]);
  for (const port of ["COM6", "/dev/cu.usbserial-110"]) {
    const result = await run({ port });
    assert.equal(result.outcome, "complete", result.error);
    assert.equal(result.stops, 0);
    assert.equal(result.recalls, 1);
    const action = result.calls.find(call => call.action === "turntable" && call.request.action === "recall");
    assert.ok(action?.action === "turntable");
    assert.equal(action.request.port, port);
    assert.equal(action.request.axis1AngleDeg, 5, "Uses configured first point, not nearest point");
    assert.equal(action.request.speedRpm, .6);
    assert.equal(result.calls.at(-1)?.action, "turntable", "Fresh probe confirms final arrival");
  }
  const calibrated = structuredClone(route);
  calibrated.kind = "auto"; calibrated.cycle!.mode = "automatic_stations"; calibrated.cycle!.startAtCurrentPose = true;
  calibrated.cycle!.maxMoveRpm = 5;
  assert.ok(captureRouteBlockers(calibrated, { ...ready, service: { ...ready.service, dllConfigured: true } }).some(s => s.includes("首点位置")));
  assert.equal(presetPositionError(calibrated, ready), "");
  const result = await run({ route: calibrated });
  assert.equal(result.outcome, "complete", result.error);
  assert.equal(calibrated.cycle!.startAtCurrentPose, true, "Does not change the saved calibration or start policy");
  const recall = result.calls.find(call => call.action === "turntable" && call.request.action === "recall");
  assert.ok(recall?.action === "turntable"); assert.equal(recall.request.speedRpm, 5);

  const plan = planAutoFollow(autoFollowDefaults, null, "unknown", "COM6");
  const theoretical = await run({ route: { kind: "auto", name: "calculated", pointNames: [], errors: [], referenceMode: "read_at_start", cycle: plan.pointCycle! } });
  assert.equal(theoretical.outcome, "complete", theoretical.error);
  const calculatedRecall = theoretical.calls.find(call => call.action === "turntable" && call.request.action === "recall");
  assert.ok(calculatedRecall?.action === "turntable");
  assert.equal(calculatedRecall.request.referenceSignature, turntableReferenceSignature(axes), "Calculated route binds fresh hardware reference");
  for (const patch of [{ abortAt: "probe" }, { abortAt: "recall" }]) {
    const cancelled = await run(patch);
    assert.equal(cancelled.outcome, "cancelled", cancelled.error);
    assert.equal(cancelled.recalls, patch.abortAt === "probe" ? 0 : 1);
    assert.equal(cancelled.stops, patch.abortAt === "probe" ? 0 : 1);
  }
  for (const patch of [{ drift: true }, { referenceChanged: true }, { lostReply: true }, { fault: true }]) {
    const failed = await run(patch);
    assert.ok(failed.error, JSON.stringify(patch));
    assert.equal(failed.stops, 1, "Uncertain movement is stopped before reporting failure");
    assert.notEqual(failed.outcome, "complete");
  }
  const changed = await run({ generationChanged: true });
  assert.match(changed.error, /连接或任务已变化/);
  assert.equal(changed.stops, 0, "Never sends an old task's stop to a replacement service");
  for (const patch of [{ turntableBusy: true }, { deviceBusy: true }, { state: "acquiring" as const }]) assert.ok(presetPositionError(route, { ...ready, ...patch }));
  console.log("PASS preset motion only, fresh arrival, Mac/Windows, configured and calculated targets, cancellation, changed reference, drift and uncertain replies");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
