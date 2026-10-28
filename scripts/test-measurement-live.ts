import assert from "node:assert/strict";
import { captureMatchesContext, captureTaskKey, latestCapturePoints, mergeCapturePages, validPassPreview } from "../packages/ui/src/measurement-live-data";
const frame: any = {
  recording: {
    samples: 1000,
    sampleRate: 1000,
    pointCycle: {
      completion: "confirmed_pass",
      outcome: "observed",
      handoff: {
        reason: "blade_left",
        entrySampleIndex: 80,
        entryConfirmedSampleIndex: 99,
        exitSampleIndex: 200,
        exitConfirmedSampleIndex: 229,
      },
    },
  },
  waveform: {
    sampleRate: 1000,
    sampleStart: 0,
    rangeStart: 0,
    rangeEnd: 1000,
    values: [],
    envelope: [
      {
        start: 90,
        end: 110,
        min: -9,
        max: 9,
        missing: 0,
        overrange: 0,
        rssiMin: 90,
      },
      {
        start: 110,
        end: 150,
        min: -1,
        max: 2,
        missing: 0,
        overrange: 0,
        rssiMin: 80,
      },
      {
        start: 150,
        end: 190,
        min: -2,
        max: 3,
        missing: 0,
        overrange: 1,
        rssiMin: 80,
      },
      {
        start: 190,
        end: 210,
        min: -9,
        max: 9,
        missing: 0,
        overrange: 0,
        rssiMin: 80,
      },
    ],
  },
};
assert.deepEqual(validPassPreview(frame).points, [
  [0.01, -1],
  [0.05, 2],
  [0.05, null],
  [0.09, null],
]);
assert.equal(validPassPreview(frame).complete, true);
const original = structuredClone(frame);
const sparse = structuredClone(original);
sparse.waveform = { sampleRate:1000, sampleStart:101, sampleStride:1, rssiSampleStride:4, values:[1,2,3,4,5,6,7,8],
  rssi:[null,null,null,80,null,null,null,null], overrange:Array(8).fill(false) };
assert.deepEqual(validPassPreview(sparse).points.map(p=>p[1]),[1,2,3,4,5,6,7,null], "Unmeasured RSSI positions retain velocity; a missing expected RSSI is invalid");
frame.recording.diagnosticOnly = true;
assert.equal(validPassPreview(frame).points.length, 0, "Top-level diagnostic provenance must match formal analysis");
delete frame.recording.diagnosticOnly;
frame.recording.validMeasurement = false;
assert.equal(validPassPreview(frame).points.length, 0);
delete frame.recording.validMeasurement;
frame.terminalMetadataOnly = true;
assert.equal(validPassPreview(frame).points.length, 0, "A metadata-only terminal event is not a waveform");
delete frame.terminalMetadataOnly;
frame.recording.pointCycle.completion = "waiting";
assert.equal(validPassPreview(frame).points.length, 0);
const global = structuredClone(original), cycle = global.recording.pointCycle;
cycle.continuousSession = { sampleClock: "continuous_session_raw", sampleStart: 10000, sampleEndExclusive: 11000, sampleRate: 1000 };
cycle.handoff.sampleClock = "continuous_session_raw";
for (const key of ["entrySampleIndex", "entryConfirmedSampleIndex", "exitSampleIndex", "exitConfirmedSampleIndex"]) cycle.handoff[key] += 10000;
assert.deepEqual(validPassPreview(global).points, validPassPreview(original).points, "Explicit raw global gates map into a local preview");
const derivative = structuredClone(global);
derivative.recording.sampleRate = derivative.waveform.sampleRate = 200;
derivative.recording.samples = 200;
derivative.waveform.rangeEnd = 200;
for (const bin of derivative.waveform.envelope) { bin.start /= 5; bin.end /= 5; }
derivative.recording.sampling = { version: 2, kind: "anti_alias_lowpass", sourceSamples: 1000, sourceSampleRate: 1000, targetSampleRate: 200,
  pointCycleIndexMapping: { version: 1, sourceClock: "continuous_session_raw", targetClock: "recording_local", sourceOffset: 10000, numerator: 1, denominator: 5 }, sourceHandoff: structuredClone(cycle.handoff) };
assert.deepEqual(validPassPreview(derivative).points, validPassPreview(original).points, "Versioned upload mapping preserves preview time");
derivative.recording.sampling.sourceHandoff.exitSampleIndex++;
assert.equal(validPassPreview(derivative).points.length, 0, "Reject derivatives whose source gates no longer match");
delete global.recording.pointCycle.continuousSession;
assert.equal(validPassPreview(global).points.length, 0, "Never guess a global clock offset");
const mismatch = structuredClone(original); mismatch.recording.sampleRate = 200;
assert.equal(validPassPreview(mismatch).points.length, 0, "Never combine target-rate archive metadata with a source-rate live wave");

const c: any = { id: "one", ownerId: "owner", clientId: "desktop", tenant: "tenant", localId: "local", updatedAt: 10, liveState: "stopped", context: null,
  recording: { name: "first", windFarm: "F1", turbine: "T1", pointCycle: { bladeId: "2", radialPointId: "uuid", radialPointName: "p1", collectionId: "task" } } };
const objects: any[] = [{id:"p1",kind:"position",code:"P1"},{id:"t1",kind:"turbine",code:"T1"}];
assert(captureMatchesContext(c, {positionId:"p1"}, objects), "Unbound p1 follows the same canonical point code as adoption");
assert(!captureMatchesContext(c, {positionId:"missing"}, objects));
const bound = {...c, context: {farmId:"new-farm",turbineId:"new-turbine",bladeId:"new-blade",positionId:"new-point",campaignId:"new-task"}};
assert(captureMatchesContext(bound,{turbineId:"new-turbine",positionId:"new-point"},objects));
assert(!captureMatchesContext(bound,{turbineId:"t1"},objects), "Explicit binding overrides stale raw labels");
assert.equal(captureTaskKey(bound),captureTaskKey({...bound,clientId:"another-desktop"}));
const many = Array.from({length:15},(_,i)=>({...c,id:String(i),updatedAt:i,recording:{...c.recording,pointCycle:{...c.recording.pointCycle,bladeId:String(Math.floor(i/5)+1),radialPointId:"P"+(i%5+1)}}}));
assert.equal(latestCapturePoints(many).length,15,"Do not hide the second and third blades after five cards");
assert.equal(latestCapturePoints([{...c,id:"newer",updatedAt:50},{...c,id:"active",updatedAt:40,liveState:"acquiring"}])[0].id,"active");
assert.equal(mergeCapturePages([c],[{...c,context:bound.context}])[0].context?.campaignId,"new-task");
assert.equal(mergeCapturePages([{...c,uploadState:"complete",updatedAt:50}],[{...c,uploadState:"pending",updatedAt:40}])[0].uploadState,"complete");
frame.recording.pointCycle.completion = "confirmed_pass";
frame.recording.pointCycle.diagnosticOnly = true;
assert.equal(validPassPreview(frame).points.length, 0);
frame.recording.pointCycle.diagnosticOnly = false;
frame.recording.pointCycle.handoff.exitConfirmedSampleIndex = 1000;
assert.equal(validPassPreview(frame).points.length, 0);
console.log(
  "PASS live preview excludes unconfirmed, diagnostic, invalid and boundary-crossing bins",
);
