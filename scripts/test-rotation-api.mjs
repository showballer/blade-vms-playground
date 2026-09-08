import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
const require = createRequire(import.meta.url), { generateRotationSegments, rotationCanonical, rotationWorkflow } = require("../apps/desktop/electron/rotation-data.cjs");
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
const tenant = "qa_rotation_" + Date.now(), otherTenant = tenant + "_B", password = randomBytes(18).toString("base64url"), users = [], tokens = {}, tests = [];
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
let rootToken, failure;
async function call(path, method = "GET", body, token = tokens.operator) { const res = await fetch("http://127.0.0.1:3210/api/v1/" + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); return { status: res.status, data: await res.json() }; }
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
try {
  rootToken = (await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).data.token; assert.ok(rootToken);
  const seed = (await call("records/tasks/task-a1", "GET", undefined, rootToken)).data;
  for (const role of ["operator", "colleague", "analyst", "viewer", "other"]) {
    const username = tenant + "_" + role, created = await call("users", "POST", { username, name: "QA " + role, password, tenant: role === "other" ? otherTenant : tenant, role: role === "other" ? "analyst" : role === "colleague" ? "operator" : role }, rootToken); assert.equal(created.status, 201); users.push(created.data.id);
    tokens[role] = (await call("session", "POST", { username, password }, "")).data.token;
  }
  const task = (await call("records/tasks", "POST", { name: "QA 旋转原始任务", object: "QA 叶片", turbine: "QA", point: "P1", rpm: 60, blades: 2, sampleRate: 4, duration: 99, samples: [1,-2,3,-4,5,-6,7,-8,9,-10,11], source: "import", channels: [{ no: 1, type: "velocity", unit: "mm/s" }], environment: "原始环境" })).data;
  const source = (await call("records/tasks/" + task.id)).data, config = { rpm: 60, blades: 2, source: "手动", mode: "period", start: 0, end: 2.75 }, generated = generateRotationSegments(source, config);
  const segments = generated.segments.map((s, i) => ({ ...s, keep: i === 0 || i === 2, quality: i === 1 ? "异常" : "未评价", note: i === 1 ? "人工排除" : "" }));
  const request = { name: "QA 分段", taskId: task.id, type: "cut", source: "demo", parameters: { workflow: rotationWorkflow, config, segments, sourceRevision: createHash("sha256").update(rotationCanonical(source)).digest("hex") }, result: { dataset: { rows: [[999]] } } };
  await check("未登录、访客、其他操作员及跨组用户均不能截取当前任务", async () => {
    for (const [role, status] of [["",401],["viewer",403],["colleague",404],["other",404]]) assert.equal((await call("records/analyses", "POST", request, role ? tokens[role] : "")).status, status);
  });
  let cut;
  await check("操作员可保存本人分段，服务器按原始点重建而不信任传入矩阵/来源", async () => {
    const response = await call("records/analyses", "POST", request); assert.equal(response.status, 201); cut = response.data;
    assert.deepEqual(cut.result.dataset.rows, [[1,0,0,1],[1,1,.25,-2],[3,4,1,5],[3,5,1.25,-6]]); assert.equal(cut.source, "import"); assert.equal(cut.result.dataset.metadata.excludedSamples, 7);
    assert.equal((await call("records/analyses", "POST", { ...request, name: "分析员分段" }, tokens.analyst)).status, 201);
  });
  await check("伪造边界、不合法段标注、空选择、未接入来源和小数叶片数被拒绝", async () => {
    for (const parameters of [{ ...request.parameters, segments: [{ ...segments[0], endIndex: 99 }, ...segments.slice(1)] }, { ...request.parameters, segments: segments.map(s => ({ ...s, keep: false })) }, { ...request.parameters, config: { ...config, blades: 1.2 } }, { ...request.parameters, config: { ...config, source: "键相" } }]) assert.equal((await call("records/analyses", "POST", { ...request, parameters })).status, 400);
    assert.equal((await call("records/analyses", "POST", { ...request, parameters: {} })).status, 400);
    assert.deepEqual((await call("records/tasks/" + task.id)).data, source);
  });
  await check("分析详情与五格式导出继承任务范围，其他操作员/课题组不能绕过", async () => {
    for (const role of ["colleague", "other"]) assert.equal((await call("records/analyses/" + cut.id, "GET", undefined, tokens[role])).status, 404);
    mkdirSync("artifacts/rotation-data", { recursive: true });
    for (const format of ["csv","txt","xlsx","mat","json"]) {
      const path = `export/analyses/${cut.id}?view=data&format=${format}`;
      for (const role of ["colleague", "other"]) assert.equal((await fetch("http://127.0.0.1:3210/api/v1/" + path, { headers: { Authorization: "Bearer " + tokens[role] } })).status, 404);
      const response = await fetch("http://127.0.0.1:3210/api/v1/" + path, { headers: { Authorization: "Bearer " + tokens.operator } }); assert.equal(response.status, 200); writeFileSync("artifacts/rotation-data/api-cut." + format, Buffer.from(await response.arrayBuffer()));
    }
  });
  await check("源任务后续变化阻止陈旧切片保存，旧记录矩阵与元信息仍冻结", async () => {
    assert.equal((await call("records/tasks/" + task.id, "PUT", { samples: [99, ...source.samples.slice(1)], environment: "已修改" })).status, 200);
    assert.equal((await call("records/analyses", "POST", request)).status, 409);
    assert.equal((await call("records/tasks/" + task.id, "PUT", { sampleRate: 8 })).status, 200);
    assert.equal((await call("records/analyses", "POST", request)).status, 409, "Changed sampling boundaries must report a stale task, not an invalid selection");
    const saved = (await call("records/analyses/" + cut.id)).data; assert.deepEqual(saved.result.dataset.rows, cut.result.dataset.rows); assert.equal(saved.result.dataset.metadata.task.environment, "原始环境");
  });
  await check("报告保存包含分段快照，不受后续分析或源任务修改影响", async () => {
    const report = await call("records/reports", "POST", { name: "QA 分段报告", taskId: task.id, sections: ["降噪与截取"], conclusion: "只核验分段保存", source: "import" }, tokens.analyst); assert.equal(report.status, 201);
    const snapshot = report.data.analysisSnapshots.find(a => a.id === cut.id); assert.deepEqual(snapshot.result.dataset.rows, cut.result.dataset.rows);
    assert.deepEqual((await call("records/tasks/task-a1", "GET", undefined, rootToken)).data, seed);
  });
} catch (error) { failure = error; console.error(error); }
finally {
  try { for (const group of [tenant, otherTenant]) await db.execute("DELETE FROM records WHERE tenant=?", [group]); for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant IN (?,?)", [id, tenant, otherTenant]); } if (rootToken) await call("session", "DELETE", undefined, rootToken); } finally { await db.end(); }
  mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/rotation-api-results.json", JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "Only QA groups/users removed; audit retained" }, null, 2)); if (failure) process.exitCode = 1;
}
