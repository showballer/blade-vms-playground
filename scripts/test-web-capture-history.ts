/** Read-only retry policy; no server, database, credentials or hardware. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCaptureHistory } from "../packages/ui/src/web-capture-history";

test("a busy account recovers after bounded exponential waits", async () => {
  let calls = 0;
  const delays: number[] = [];
  const waveform = { values: [0.1, -0.2, 0.3] };
  const result = await readCaptureHistory(async () => {
    if (++calls < 3) throw Object.assign(new Error("Worker busy"), { status: 429 });
    return waveform;
  }, { wait: async milliseconds => { delays.push(milliseconds); } });
  assert.strictEqual(result, waveform);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test("authentication, missing records, invalid requests and server failures never retry", async () => {
  for (const status of [400, 401, 403, 404, 409, 500, 503, undefined]) {
    let calls = 0;
    const failure = Object.assign(new Error("Read failed"), { status });
    await assert.rejects(readCaptureHistory(async () => { calls++; throw failure; }, {
      wait: async () => { assert.fail("Only 429 may wait and retry"); },
    }), error => error === failure);
    assert.equal(calls, 1);
  }
});

test("persistent contention stops after three retries and preserves the error", async () => {
  let calls = 0;
  const delays: number[] = [], failure = Object.assign(new Error("Worker still busy"), { status: 429 });
  await assert.rejects(readCaptureHistory(async () => { calls++; throw failure; }, {
    wait: async milliseconds => { delays.push(milliseconds); },
  }), error => error === failure);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(delays.reduce((sum, value) => sum + value, 0), 7000);
});

test("leaving the selected record while waiting prevents another request", async () => {
  let calls = 0, active = true;
  const failure = Object.assign(new Error("Worker busy"), { status: 429 });
  await assert.rejects(readCaptureHistory(async () => { calls++; throw failure; }, {
    active: () => active,
    wait: async () => { active = false; },
  }), error => error === failure);
  assert.equal(calls, 1);
});
