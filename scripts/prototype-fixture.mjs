import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Temporary visual-QA input, separate from the user's seed tasks. No device or algorithm calls.
assert.equal(process.env.DB_NAME, "blade_vms_playground", "Refusing a non-project database");
const statePath = "artifacts/prototype-current/fixture.json";
const mode = process.argv[2];
assert.ok(["create", "cleanup"].includes(mode), "Use create or cleanup");
let token;
async function call(path, method = "GET", body) {
  const response = await fetch("http://127.0.0.1:3210/api/v1/" + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return result;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  token = (await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD })).token;
  assert.ok(token);
  if (mode === "create") {
    if (existsSync(statePath)) assert.equal(JSON.parse(readFileSync(statePath, "utf8")).cleaned, true, "Existing fixture must be cleaned first");
    const seedDigest = digest(await call("records/tasks/task-a1"));
    const name = "原型验收-叶片A-" + Date.now();
    const task = await call("records/tasks", "POST", {
      name, object: "风机叶片A", turbine: "WT-03", point: "P3 叶尖", direction: "径向",
      rpm: 15, blades: 3, sampleRate: 128, duration: 16, source: "demo",
      environment: "隔离原型验收样例；非真实采集，验收后删除",
      channels: [{ no: 1, type: "velocity", unit: "mm/s" }],
      samples: Array.from({ length: 2048 }, (_, i) => Number((Math.sin(i / 128 * Math.PI * 1.5) + 0.15 * Math.sin(i / 128 * Math.PI * 9)).toFixed(6))),
    });
    mkdirSync("artifacts/prototype-current", { recursive: true });
    writeFileSync(statePath, JSON.stringify({ id: task.id, name, seedDigest, createdAt: new Date().toISOString(), cleaned: false }, null, 2));
    console.log(JSON.stringify({ id: task.id, name, samples: task.samples.length }));
  } else {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.cleaned, false);
    const task = await call("records/tasks/" + encodeURIComponent(state.id));
    assert.equal(task.name, state.name);
    assert.ok(task.name.startsWith("原型验收-叶片A-"));
    const analyses = (await call("records/analyses")).filter(record => record.taskId === state.id);
    for (const record of analyses) {
      assert.ok(record.name.includes(state.name), "Unexpected record references the visual-QA task; preserve it for inspection");
      await call("records/analyses/" + encodeURIComponent(record.id), "DELETE");
    }
    await call("records/tasks/" + encodeURIComponent(state.id), "DELETE");
    assert.equal(digest(await call("records/tasks/task-a1")), state.seedDigest, "Seed task changed during QA");
    writeFileSync(statePath, JSON.stringify({ ...state, cleaned: true, cleanedAt: new Date().toISOString(), removedAnalyses: analyses.map(record => record.id), seedUnchanged: true }, null, 2));
    console.log("Removed only the visual-QA task; seed task unchanged; audit retained.");
  }
} finally {
  if (token) await call("session", "DELETE");
}
