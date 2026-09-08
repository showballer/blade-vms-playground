// Verify and optionally clean exactly the test record created in the browser.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const name = process.argv[2];
assert.match(name || "", /^UI元信息验收-\d{13}$/);
const base = "http://127.0.0.1:3210/api/v1/";
const login = await fetch(base + "session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: process.env.BOOTSTRAP_PASSWORD }) });
assert.equal(login.status, 200);
const { token } = await login.json();
const headers = { Authorization: "Bearer " + token };
try {
  const tasks = await (await fetch(base + "records/tasks", { headers })).json();
  const matches = tasks.filter((t) => t.name === name); assert.equal(matches.length, 1);
  const task = matches[0];
  assert.equal(task.environment, "QA 风速 8m/s，温度 20℃");
  assert.equal(task.testTime, "2026-09-07T06:30:00.000Z");
  assert.deepEqual(task.channels, [{ no: 2, type: "velocity", unit: "mm/s" }]);
  assert.equal(task.raw_preserved, false);
  writeFileSync("artifacts/metadata-ui-results.json", JSON.stringify({ time: new Date().toISOString(), task, result: "pass" }, null, 2));
  if (process.argv.includes("--cleanup")) {
    const res = await fetch(base + "records/tasks/" + task.id, { method: "DELETE", headers });
    assert.equal(res.status, 200);
    assert.equal((await fetch(base + "records/tasks/" + task.id, { headers })).status, 404);
  }
  console.log("PASS UI 元信息、日期时区和数据库回读" + (process.argv.includes("--cleanup") ? "；仅清理该测试任务" : ""));
} finally { await fetch(base + "session", { method: "DELETE", headers }); }
