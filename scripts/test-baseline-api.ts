import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { rotationRevision } from "../packages/ui/src/rotation-data";
import { healthBaselineRevision } from "../packages/ui/src/health-trend-data";
import { modalBaselineRevision, modalWorkflow } from "../packages/ui/src/modal-data";
const origin = "http://127.0.0.1:3210/api/v1/", tenant = "qa_baseline_" + Date.now(), otherTenant = tenant + "_B", password = randomBytes(18).toString("base64url"), users: string[] = [], tokens: Record<string, string> = {}, tests: { name: string; result: string }[] = [];
async function call(path: string, method = "GET", body?: unknown, token = tokens.analyst) { const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); return { status: response.status, data: await response.json() }; }
async function check(name: string, fn: () => Promise<unknown>) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
  if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME }); let rootToken = "", failure: any;
  try {
    rootToken = (await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).data.token; assert.ok(rootToken);
    for (const role of ["admin", "analyst", "operator", "viewer", "other"]) { const username = tenant + "_" + role, created = await call("users", "POST", { username, password, name: "QA " + role, role: role === "other" ? "analyst" : role, tenant: role === "other" ? otherTenant : tenant }, rootToken); assert.equal(created.status, 201); users.push(created.data.id); tokens[role] = (await call("session", "POST", { username, password }, "")).data.token; }
    const baseBody = { name: "QA 基线", object: "QA 叶片", rms: 1, frequency: .6, modal: .61, score: 80, confidence: .8, source: "demo", note: "登记演示参数" };
    let baseline: any, modal: any, trend: any;
    await check("基线登记需登录与分析员权限，保护身份/课题组/版本不可伪造", async () => {
      assert.equal((await call("records/baselines", "POST", baseBody, "")).status, 401);
      for (const role of ["operator", "viewer"]) assert.equal((await call("records/baselines", "POST", baseBody, tokens[role])).status, 403);
      const response = await call("records/baselines", "POST", { ...baseBody, version: 999, id: "forged", recordTenant: "forged", ownerId: "forged", revision: "forged" }); assert.equal(response.status, 201); baseline = response.data;
      assert.notEqual(baseline.id, "forged"); assert.equal(baseline.version, 1); assert.equal(baseline.recordTenant, tenant); assert.equal(baseline.ownerId, users[1]); assert.match(baseline.revision, /^[0-9a-f]{64}$/);
    });
    await check("完整校验拒绝非法值，但部分基线可保存且缺项不伪造", async () => {
      for (const patch of [{ name: " " }, { object: null }, { rms: 0 }, { modal: -1 }, { frequency: "1" }, { score: 101 }, { confidence: 2 }, { source: "real" }, { status: "deleted" }]) assert.equal((await call("records/baselines", "POST", { ...baseBody, ...patch })).status, 400);
      const partial = await call("records/baselines", "POST", { name: "只登记一阶频率", object: baseBody.object, modal: .62 }); assert.equal(partial.status, 201); assert.equal(partial.data.rms, undefined); assert.equal(partial.data.score, undefined); assert.equal(partial.data.source, "manual");
    });
    const basePath = "records/baselines/" + baseline.id;
    await check("列表/详情/初始化/导出范围一致，旧记录可读且读操作不改库", async () => {
      for (const role of ["viewer", "operator"]) { const read = await call(basePath, "GET", undefined, tokens[role]); assert.equal(read.status, 200); assert.equal(read.data.revision, baseline.revision); assert.ok((await call("bootstrap", "GET", undefined, tokens[role])).data.baselines.some((b: any) => b.id === baseline.id)); }
      assert.equal((await call(basePath, "GET", undefined, tokens.other)).status, 404); assert.equal((await call(`export/baselines/${baseline.id}?format=json`, "GET", undefined, tokens.other)).status, 404);
      const legacyId = randomUUID(), body = { name: "QA 旧基线", object: baseBody.object, modal: .63 }; await db.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'baselines',?,?,?)", [legacyId, tenant, JSON.stringify(body), users[1]]);
      const read = (await call("records/baselines/" + legacyId)).data; assert.match(read.revision, /^[0-9a-f]{64}$/); assert.equal(read.source, undefined); assert.equal(read.version, undefined);
      const [raw] = await db.execute<any[]>("SELECT body FROM records WHERE id=?", [legacyId]); assert.deepEqual(raw[0].body, body);
    });
    const taskId = (await call("records/tasks", "POST", { name: "QA 基线关联任务", object: baseBody.object, turbine: "QA", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [1,-2,3,-4], source: "import" }, tokens.operator)).data.id;
    const task = (await call("records/tasks/" + taskId)).data, sourceRevision = await rotationRevision(task);
    const modalRequest = { name: "QA 基线模态", taskId, type: "modal", parameters: { workflow: modalWorkflow, sourceRevision, baselineRevision: await modalBaselineRevision(baseline), config: { test: "free", method: "峰值拾取", damping: "半功率带宽", points: ["P1"], activeOrder: 1, baselineId: baseline.id } } };
    const trendRequest = { taskId, baselineId: baseline.id, sourceRevision, baselineRevision: await healthBaselineRevision(baseline), configRevision: "missing", startDate: "2024-02-01" };
    await check("新登记被模态/趋势使用，来源版本进入各自历史快照", async () => {
      const m = await call("records/analyses", "POST", modalRequest); assert.equal(m.status, 201); modal = m.data; assert.equal(modal.result.dataset.metadata.baseline.demo, true); assert.equal(modal.result.dataset.metadata.baseline.version, 1);
      const t = await call("health/trends", "POST", trendRequest); assert.equal(t.status, 201); trend = t.data; assert.equal(trend.result.dataset.metadata.baseline.note, baseBody.note);
    });
    await check("缺修订/越权修改拒绝，并发同版本编辑仅一次成功", async () => {
      assert.equal((await call(basePath, "PUT", { name: "无版本" })).status, 409);
      for (const role of ["operator", "viewer"]) assert.equal((await call(basePath, "PUT", { modal: .7, revision: baseline.revision }, tokens[role])).status, 403);
      assert.equal((await call(basePath, "PUT", { modal: .7, revision: baseline.revision }, tokens.other)).status, 404);
      const responses = await Promise.all([.7,.8].map(modal => call(basePath, "PUT", { modal, revision: baseline.revision }))); assert.deepEqual(responses.map(r => r.status).sort(), [200,409]); baseline = (await call(basePath)).data; assert.equal(baseline.version, 2);
      assert.equal((await call("records/analyses", "POST", modalRequest)).status, 409); assert.equal((await call("health/trends", "POST", trendRequest)).status, 409);
    });
    await check("不变编辑不增长版本，明确清空指标不补默认值，旧快照未变化", async () => {
      const same = await call(basePath, "PUT", { modal: baseline.modal, revision: baseline.revision }); assert.equal(same.status, 200); assert.equal(same.data.revision, baseline.revision); assert.equal(same.data.version, 2);
      const clear = await call(basePath, "PUT", { rms: null, revision: baseline.revision }); assert.equal(clear.status, 200); baseline = clear.data; assert.equal(baseline.rms, undefined); assert.equal(baseline.modal, same.data.modal);
      assert.deepEqual((await call("records/analyses/" + modal.id)).data.result, modal.result); assert.deepEqual((await call("records/analyses/" + trend.id)).data.result, trend.result);
    });
    await check("停用基线在新模态/趋势使用中拒绝，不删除或改写历史", async () => {
      const disabled = await call(basePath, "PUT", { status: "disabled", rms: 1, revision: baseline.revision }); assert.equal(disabled.status, 200); baseline = disabled.data;
      assert.equal((await call("records/analyses", "POST", { ...modalRequest, parameters: { ...modalRequest.parameters, baselineRevision: await modalBaselineRevision(baseline) } })).status, 400);
      assert.equal((await call("health/trends", "POST", { ...trendRequest, baselineRevision: await healthBaselineRevision(baseline) })).status, 400);
      assert.deepEqual((await call("records/analyses/" + modal.id)).data.result, modal.result);
    });
    await check("管理员跨组维护保留目标组归属，审计写入目标组，复制新增归当前组", async () => {
      const other = (await call("records/baselines", "POST", baseBody, tokens.other)).data;
      const edited = await call("records/baselines/" + other.id, "PUT", { name: "管理员改名", revision: other.revision, recordTenant: tenant, ownerId: users[0] }, tokens.admin); assert.equal(edited.status, 200); assert.equal(edited.data.recordTenant, otherTenant); assert.equal(edited.data.ownerId, users[4]);
      const [logs] = await db.execute<any[]>("SELECT tenant FROM audit_logs WHERE target=?", [other.id]); assert.ok(logs.length >= 2 && logs.every(l => l.tenant === otherTenant));
      const copied = await call("records/baselines", "POST", { ...edited.data, name: "当前组副本" }, tokens.admin); assert.equal(copied.status, 201); assert.equal(copied.data.recordTenant, tenant); assert.equal(copied.data.version, 1); assert.notEqual(copied.data.id, other.id);
    });
    await check("删除需当前版本和明确确认；删除后趋势/模态/报告快照仍可读", async () => {
      const report = await call("records/reports", "POST", { name: "QA 基线报告", taskId, sections: ["模态参数", "健康趋势与标记"] }); assert.equal(report.status, 201);
      assert.equal((await call(basePath, "DELETE", { revision: baseline.revision })).status, 400); assert.equal((await call(basePath, "DELETE", { confirm: true })).status, 409); assert.equal((await call(basePath, "DELETE", { confirm: true, revision: "0".repeat(64) })).status, 409);
      for (const role of ["operator", "viewer"]) assert.equal((await call(basePath, "DELETE", { confirm: true, revision: baseline.revision }, tokens[role])).status, 403);
      assert.equal((await call(basePath, "DELETE", { confirm: true, revision: baseline.revision })).status, 200); assert.equal((await call(basePath)).status, 404);
      assert.deepEqual((await call("records/analyses/" + modal.id)).data.result, modal.result); assert.deepEqual((await call("records/analyses/" + trend.id)).data.result, trend.result);
      assert.equal((await call("records/reports/" + report.data.id)).data.analysisSnapshots.length, 2);
    });
  } catch (error) { failure = error; console.error(error); }
  finally {
    for (const group of [tenant, otherTenant]) await db.execute("DELETE FROM records WHERE tenant=?", [group]);
    for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant IN (?,?)", [id, tenant, otherTenant]); }
    if (rootToken) await call("session", "DELETE", undefined, rootToken); await db.end(); mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/baseline-api-results.json", JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "Only isolated QA groups/users removed; audit retained" }, null, 2)); if (failure) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
