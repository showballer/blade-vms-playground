import assert from "node:assert/strict";
import { validPassPreview } from "../packages/ui/src/measurement-live-data";
const frame: any = {
  recording: {
    samples: 1000,
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
frame.recording.pointCycle.completion = "waiting";
assert.equal(validPassPreview(frame).points.length, 0);
frame.recording.pointCycle.completion = "confirmed_pass";
frame.recording.pointCycle.diagnosticOnly = true;
assert.equal(validPassPreview(frame).points.length, 0);
frame.recording.pointCycle.diagnosticOnly = false;
frame.recording.pointCycle.handoff.exitConfirmedSampleIndex = 1000;
assert.equal(validPassPreview(frame).points.length, 0);
console.log(
  "PASS live preview excludes unconfirmed, diagnostic, invalid and boundary-crossing bins",
);
