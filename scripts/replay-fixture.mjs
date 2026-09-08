import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const base = "http://127.0.0.1:3210/api/v1/";
const login = await fetch(base + "session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: process.env.BOOTSTRAP_PASSWORD }) });
assert.equal(login.status, 200);
const { token } = await login.json();
const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
try {
  if (process.argv.includes("--cleanup")) {
    const expected = JSON.parse(readFileSync("artifacts/replay-fixture.json", "utf8"));
    assert.match(expected.name, /^UI回放验收-\d{13}$/);
    const row = await (await fetch(base + "records/tasks/" + expected.id, { headers })).json();
    assert.equal(row.name, expected.name);
    assert.equal((await fetch(base + "records/tasks/" + expected.id, { headers, method: "DELETE" })).status, 200);
    console.log("PASS 仅清理回放测试任务");
  } else {
    const task = { name: "UI回放验收-" + Date.now(), object: "QA 合成波形", turbine: "QA-01", point: "P1", rpm: 15, blades: 3, sampleRate: 100, duration: 6, status: "本地", source: "demo", samples: Array.from({ length: 600 }, (_, i) => ((i % 80) - 40) / 10) };
    const res = await fetch(base + "records/tasks", { method: "POST", headers, body: JSON.stringify(task) });
    assert.equal(res.status, 201);
    const row = await res.json();
    writeFileSync("artifacts/replay-fixture.json", JSON.stringify({ id: row.id, name: row.name, sampleRate: row.sampleRate, sampleCount: row.samples.length }, null, 2));
    console.log(row.name);
  }
} finally { await fetch(base + "session", { headers, method: "DELETE" }); }
