import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
const base = "http://127.0.0.1:3210/api/v1/", tenant = "qa_import_" + Date.now(), password = randomBytes(18).toString("base64url"), users = [], tokens = {}, tests = [];
let rootToken, failure;
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing a non-project database");
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
async function call(path, method = "GET", body, token = tokens.operator) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, data: await response.json() };
}
async function check(name, run) { await run(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
const input = { id: "task-a1", name: tenant + " 任务", object: "QA 叶片", turbine: "QA01", point: "叶尖", rpm: 12, blades: 3, sampleRate: 4, duration: 90, samples: [2, -4, 6, -8], channels: [{ no: 2, type: "velocity", unit: "mm/s" }], source: "device", ownerId: "forged", importOrigin: { filename: "forged" }, syncOrigin: { server: "forged" }, environment: "导入环境" };
const request = { id: randomUUID(), filename: "QA混合导入.json", records: [input, { ...input, name: "坏记录", samples: [1, null] }, { ...input, name: tenant + " 后续任务", source: "demo" }] };
try {
  const login = await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, ""); assert.equal(login.status, 200); rootToken = login.data.token;
  const seedBefore = (await call("records/tasks/task-a1", "GET", undefined, rootToken)).data;
  for (const role of ["operator", "analyst", "viewer", "admin"]) {
    const username = tenant + "_" + role, created = await call("users", "POST", { username, role, name: "QA " + role, tenant, password }, rootToken); assert.equal(created.status, 201); users.push(created.data.id);
    const session = await call("session", "POST", { username, password }, ""); assert.equal(session.status, 200); tokens[role] = session.data.token;
  }
  await check("导入接口需要登录，访客不能创建，非法批次不写入", async () => {
    assert.equal((await call("imports", "POST", request, "")).status, 401);
    assert.equal((await call("imports", "POST", request, tokens.viewer)).status, 403);
    for (const records of [[], Array(51).fill(input)]) assert.equal((await call("imports", "POST", { ...request, records })).status, 400);
    assert.equal((await call("imports")).data.length, 0);
  });
  await check("并发登记幂等，先保存逐项校验结果而不立即创建任务", async () => {
    const responses = await Promise.all([call("imports", "POST", request), call("imports", "POST", request), call("imports", "POST", request)]);
    assert.deepEqual(responses.map(r=>r.status).sort(), [200, 200, 201]);
    assert.equal(responses[0].data.pending, 2); assert.equal(responses[0].data.invalid, 1); assert.equal(responses[0].data.completed, 0);
    const [rows] = await db.execute("SELECT id FROM records WHERE tenant=? AND kind='tasks'", [tenant]); assert.equal(rows.length, 0);
  });
  await check("导入记录、原文件待处理项与导出均限本人，管理员也不能接管他人批次", async () => {
    for (const role of ["analyst", "viewer", "admin"]) {
      for (const path of [`imports/${request.id}`, `imports/${request.id}/pending`, `records/imports/${request.id}`, `export/imports/${request.id}?format=json`]) assert.equal((await call(path, "GET", undefined, tokens[role])).status, 404);
      assert.equal((await call("imports", "GET", undefined, tokens[role])).data.length, 0);
      assert.equal((await call("bootstrap", "GET", undefined, tokens[role])).data.imports.length, 0);
    }
    const view = (await call(`imports/${request.id}`)).data; assert.equal(view.items[0].input, undefined); assert.equal(view.items[0].task, undefined); assert.equal(view.requestHash, undefined);
  });
  await check("同标识不同内容冲突，通用接口不能伪造导入完成状态", async () => {
    assert.equal((await call("imports", "POST", { ...request, filename: "changed.json" })).status, 409);
    assert.equal((await call(`records/imports/${request.id}`, "PUT", { completed: 3 })).status, 405);
    assert.equal((await call("records/imports", "POST", request)).status, 405);
    assert.equal((await call(`imports/${request.id}/item/extra`, "POST", { index: 0 })).status, 405);
  });
  let taskId;
  await check("并发导入同一项只创建一份任务并原子记录成功，响应丢失可重试", async () => {
    const results = await Promise.all(Array.from({ length: 3 }, ()=>call(`imports/${request.id}/item`, "POST", { index: 0 })));
    for (const result of results) assert.equal(result.status, 200);
    assert.equal(results.filter(r=>!r.data.replayed).length, 1); taskId = results[0].data.items[0].taskId;
    assert.ok(results.every(r=>r.data.items[0].taskId===taskId));
    const [rows] = await db.execute("SELECT id FROM records WHERE tenant=? AND kind='tasks'", [tenant]); assert.equal(rows.length, 1);
  });
  await check("文件中已有 ID/账号/回传来源不能覆盖原任务，业务元信息保留", async () => {
    assert.notEqual(taskId, input.id); const task = (await call("records/tasks/" + taskId)).data;
    assert.equal(task.source, "import"); assert.equal(task.duration, 1); assert.deepEqual(task.samples, input.samples); assert.equal(task.raw_preserved, true);
    assert.equal(task.environment, input.environment); assert.deepEqual(task.channels, input.channels); assert.equal(task.syncOrigin, undefined);
    assert.equal(task.importOrigin.batchId, request.id); assert.equal(task.importOrigin.itemIndex, 0); assert.notEqual(task.ownerId, input.ownerId);
    assert.deepEqual((await call("records/tasks/task-a1", "GET", undefined, rootToken)).data, seedBefore);
  });
  await check("失败项有明确原因且后续有效项可独立导入，不出现部分成功假提示", async () => {
    const invalid = await call(`imports/${request.id}/item`, "POST", { index: 1 }); assert.equal(invalid.status, 400); assert.match(invalid.data.error, /有限数值/);
    const success = await call(`imports/${request.id}/item`, "POST", { index: 2 }); assert.equal(success.status, 200); assert.equal(success.data.completed, 2); assert.equal(success.data.invalid, 1); assert.equal(success.data.pending, 0);
    assert.equal((await call("records/tasks/" + success.data.items[2].taskId)).data.source, "demo");
  });
  await check("未导入项导出只包含失败原记录，可修正后另建批次", async () => {
    const response = await call(`imports/${request.id}/pending`); assert.equal(response.status, 200); assert.equal(response.data.length, 1); assert.deepEqual(response.data[0].samples, [1, null]);
    const fixedRequest = { id: randomUUID(), filename: "修正.json", records: response.data.map(record=>({ ...record, samples: [1, 2] })) };
    assert.equal((await call("imports", "POST", fixedRequest)).status, 201);
    assert.equal((await call(`imports/${fixedRequest.id}/item`, "POST", { index: 0 })).data.completed, 1);
    assert.equal((await call(`imports/${request.id}`)).data.completed, 2);
  });
  await check("任务后续编辑不被重试覆盖，导入来源不能被 PUT 伪造", async () => {
    const before = (await call("records/tasks/" + taskId)).data;
    const changed = await call("records/tasks/" + taskId, "PUT", { samples: [9, 9], name: "后续编辑", importOrigin: { batchId: "forged" } }); assert.equal(changed.status, 200);
    assert.deepEqual(changed.data.importOrigin, before.importOrigin);
    assert.equal((await call(`imports/${request.id}/item`, "POST", { index: 0 })).data.replayed, true);
    assert.deepEqual((await call("records/tasks/" + taskId)).data.samples, [9, 9]);
  });
  await check("备份恢复包含导入状态与任务，删除后的重试拒绝静默重建", async () => {
    const backup = await call("backups", "POST", {}, tokens.admin); assert.equal(backup.status, 201);
    assert.equal((await call("records/tasks/" + taskId, "DELETE")).status, 200);
    assert.equal((await call(`imports/${request.id}/item`, "POST", { index: 0 })).status, 409);
    assert.equal((await call("backups/restore", "POST", { id: backup.data.id, confirm: "恢复业务数据" }, tokens.admin)).status, 200);
    assert.equal((await call(`imports/${request.id}`)).data.completed, 2); assert.equal((await call(`imports/${request.id}/item`, "POST", { index: 0 })).data.replayed, true);
    assert.deepEqual((await call("records/tasks/task-a1", "GET", undefined, rootToken)).data, seedBefore);
  });
} catch (error) { failure = error; console.error(error); }
finally {
  try {
    await db.execute("DELETE FROM records WHERE tenant=?", [tenant]);
    for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [id, tenant]); }
    if (rootToken) await call("session", "DELETE", undefined, rootToken);
  } finally { await db.end(); }
  mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/import-api-results.json", JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "QA tenant users/records removed; audit preserved" }, null, 2));
  console.log(`${tests.length} import API checks passed; QA data cleaned.`); if (failure) process.exitCode = 1;
}
