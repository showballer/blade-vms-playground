import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
const base = "http://127.0.0.1:3210/api/v1/", tenant = "qa_health_" + Date.now(), otherTenant = tenant + "_B", password = randomBytes(18).toString("base64url"), users = [], tokens = {}, tests = [];
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
let rootToken, failure;
async function call(path, method = "GET", body, token = tokens.analyst) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: res.status, data: await res.json() };
}
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
const values = { rms: 7, frequency: 9, band: 1.2, attentionRatio: .4, warningRatio: .7 };
try {
  rootToken = (await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).data.token; assert.ok(rootToken);
  const seedBefore = (await call("records/settings/thresholds", "GET", undefined, rootToken)).data;
  for (const role of ["admin", "analyst", "operator", "viewer", "other"]) {
    const username = tenant + "_" + role, group = role === "other" ? otherTenant : tenant;
    const created = await call("users", "POST", { username, role: role === "other" ? "analyst" : role, name: "QA " + role, tenant: group, password }, rootToken); assert.equal(created.status, 201); users.push(created.data.id);
    tokens[role] = (await call("session", "POST", { username, password }, "")).data.token; assert.ok(tokens[role]);
  }
  const baselineBody = { name: "QA 基线", object: "QA 同名对象", rms: 1, frequency: .6, modal: .61, score: 80, confidence: .8 };
  const baseline = (await call("records/baselines", "POST", baselineBody)).data, otherBaseline = (await call("records/baselines", "POST", baselineBody, tokens.other)).data;
  assert.ok(baseline.id); assert.ok(otherBaseline.id);
  const path = "health/thresholds?baselineId=" + baseline.id, otherPath = "health/thresholds?baselineId=" + otherBaseline.id;
  await check("配置子路由需要登录，不会被公开健康检查吞掉", async () => {
    assert.equal((await call(path, "GET", undefined, "")).status, 401);
    assert.equal((await call("health", "GET", undefined, "")).status, 200);
    assert.equal((await call(path + "/extra")).status, 404);
  });
  await check("无配置明确 missing，同名对象不继承其他组或全局默认", async () => {
    const res = await call(path); assert.equal(res.status, 200); assert.equal(res.data.status, "missing"); assert.equal(res.data.values, null); assert.equal(res.data.tenant, tenant);
    assert.equal((await call(otherPath)).status, 404); assert.equal((await call(path, "GET", undefined, tokens.other)).status, 404);
  });
  await check("仅管理员可保存，校验不递增比例，创建时必须提交版本", async () => {
    for (const role of ["analyst", "operator", "viewer"]) assert.equal((await call(path, "PUT", { revision: "missing", values }, tokens[role])).status, 403);
    assert.equal((await call(path, "PUT", { values }, tokens.admin)).status, 409);
    assert.equal((await call(path, "PUT", { revision: "missing", values: { ...values, attentionRatio: .9 } }, tokens.admin)).status, 400);
    assert.equal((await call(path, "PUT", { revision: "missing", values }, tokens.admin)).status, 200);
  });
  await check("三种非管理员读到实际阈值，但系统设置与模型仍禁止读取", async () => {
    for (const role of ["analyst", "operator", "viewer"]) {
      const result = (await call(path, "GET", undefined, tokens[role])).data; assert.deepEqual(result.values, values); assert.equal(result.status, "configured");
      assert.deepEqual(Object.keys(result).sort(), ["id", "revision", "status", "tenant", "values"]);
      assert.equal((await call("records/settings", "GET", undefined, tokens[role])).status, 403);
      const boot = (await call("bootstrap", "GET", undefined, tokens[role])).data; assert.deepEqual(boot.settings, []); assert.deepEqual(boot.models, []);
    }
  });
  await check("并发更新同版本仅一次成功，其余明确冲突而不静默覆盖", async () => {
    const config = (await call(path)).data;
    const responses = await Promise.all([8, 10].map(rms => call(path, "PUT", { revision: config.revision, values: { ...values, rms } }, tokens.admin)));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  });
  await check("扩展阈值按组保存及清空，通用设置编辑也不能丢失或绕过校验", async () => {
    let c = (await call(path)).data;
    const extended = { ...c.values, peak: 4, peakToPeak: 7, mainAmplitude: 1 };
    const set = await call(path, "PUT", { revision: c.revision, values: extended }, tokens.admin); assert.equal(set.status, 200); assert.deepEqual(set.data.values, extended);
    for (const role of ["analyst", "operator", "viewer"]) assert.deepEqual((await call(path, "GET", undefined, tokens[role])).data.values, extended);
    assert.equal((await call("records/settings/" + c.id, "PUT", { name: "更名保留阈值" }, tokens.admin)).status, 200);
    assert.deepEqual((await call(path)).data.values, extended);
    for (const value of [0, -1, "2"]) assert.equal((await call("records/settings/" + c.id, "PUT", { peak: value }, tokens.admin)).status, 400);
    c = (await call(path)).data;
    assert.equal((await call(path, "PUT", { revision: c.revision, values: { ...extended, peakToPeak: -1 } }, tokens.admin)).status, 400);
    const cleared = await call(path, "PUT", { revision: c.revision, values: { ...extended, peak: null, peakToPeak: null, mainAmplitude: null } }, tokens.admin);
    assert.equal(cleared.status, 200); assert.deepEqual(cleared.data.values, { rms: extended.rms, frequency: extended.frequency, band: extended.band, attentionRatio: extended.attentionRatio, warningRatio: extended.warningRatio });
  });
  await check("管理员按所选基线配置目标组，而非覆盖自身组或种子配置", async () => {
    const before = (await call(path)).data;
    assert.equal((await call(otherPath, "PUT", { revision: "missing", values: { ...values, rms: 99 } }, tokens.admin)).status, 200);
    assert.equal((await call(otherPath, "GET", undefined, tokens.other)).data.values.rms, 99);
    assert.deepEqual((await call(path)).data, before); assert.deepEqual((await call("records/settings/thresholds", "GET", undefined, rootToken)).data, seedBefore);
  });
  const task = (await call("records/tasks", "POST", { name: "QA 任务", object: baselineBody.object, turbine: "QA", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [1, 2, 3, 4], source: "demo" }, tokens.operator)).data;
  const alert = (await call("records/alerts", "POST", { name: "QA 告警", object: baselineBody.object, taskId: task.id, metric: "RMS", value: 2, threshold: 1, level: "报警", status: "待复核", reviewer: "伪造", source: "demo" })).data; assert.ok(alert.id); assert.equal(alert.reviewer, undefined);
  const alertPath = "records/alerts/" + alert.id;
  await check("操作员、访客及其他组不能复核；缺少意见也不能改变状态", async () => {
    for (const role of ["operator", "viewer"]) assert.equal((await call(alertPath, "PUT", { status: "已确认", reviewNote: "检查" }, tokens[role])).status, 403);
    assert.equal((await call(alertPath, "PUT", { status: "已确认", reviewNote: "检查" }, tokens.other)).status, 404);
    assert.equal((await call(alertPath, "PUT", { status: "已关闭" })).status, 400);
  });
  await check("复核人和时间由服务端赋值，重复请求不增加历史", async () => {
    const patch = { status: "已确认", reviewNote: "检查完成", reviewer: "伪造", reviewerId: "root", reviewedAt: "1900", reviewHistory: [] };
    const response = await call(alertPath, "PUT", patch); assert.equal(response.status, 200); assert.equal(response.data.reviewer, "QA analyst"); assert.equal(response.data.reviewHistory.length, 1); assert.ok(Date.parse(response.data.reviewedAt) > Date.now() - 60000);
    const repeated = await call(alertPath, "PUT", patch); assert.equal(repeated.data.reviewHistory.length, 1); assert.equal(repeated.data.reviewedAt, response.data.reviewedAt);
  });
  await check("并发复核串行留痕，两条处置记录均保留且不可清空", async () => {
    const results = await Promise.all(["检查 A", "检查 B"].map(reviewNote => call(alertPath, "PUT", { status: "已关闭", reviewNote, reviewHistory: [] })));
    assert.ok(results.every(r => r.status === 200));
    const item = (await call(alertPath)).data; assert.equal(item.reviewHistory.length, 3); assert.deepEqual(item.reviewHistory.slice(1).map(x => x.note).sort(), ["检查 A", "检查 B"]);
    const edited = await call(alertPath, "PUT", { name: "改标题", reviewer: "伪造", reviewHistory: [] }); assert.deepEqual(edited.data.reviewHistory, item.reviewHistory);
  });
  await check("任务归属元信息权威，阈值/复核审计存在于目标组", async () => {
    const result = (await call("records/tasks/" + task.id)).data; assert.equal(result.recordTenant, tenant);
    const [logs] = await db.execute("SELECT action FROM audit_logs WHERE tenant=?", [tenant]); assert.ok(logs.some(l => l.action === "设置健康监测阈值")); assert.ok(logs.some(l => l.action === "更新 / 复核 alerts"));
  });
  await check("旧配置与损坏配置显式区分，不能退回默认阈值", async () => {
    const config = (await call(path)).data;
    await db.execute("UPDATE records SET body=JSON_REMOVE(body,'$.attentionRatio') WHERE id=? AND tenant=?", [config.id, tenant]);
    const legacy = (await call(path)).data; assert.equal(legacy.status, "legacy"); assert.equal(legacy.values.rms, config.values.rms); assert.equal(legacy.values.attentionRatio, .525);
    await db.execute("UPDATE records SET body=JSON_REMOVE(body,'$.rms') WHERE id=? AND tenant=?", [config.id, tenant]);
    const invalid = (await call(path)).data; assert.equal(invalid.status, "invalid"); assert.equal(invalid.values, null);
    assert.equal((await call(path, "PUT", { revision: invalid.revision, values }, tokens.admin)).status, 200);
    assert.equal((await call("records/settings/" + config.id, "PUT", { attentionRatio: .9 }, tokens.admin)).status, 400);
  });
} catch (error) { failure = error; console.error(error); }
finally {
  try {
    for (const group of [tenant, otherTenant]) await db.execute("DELETE FROM records WHERE tenant=?", [group]);
    for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant IN (?,?)", [id, tenant, otherTenant]); }
    if (rootToken) await call("session", "DELETE", undefined, rootToken);
  } finally { await db.end(); }
  mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/health-api-results.json", JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "Only isolated QA groups/users removed; audit retained" }, null, 2));
  if (failure) process.exitCode = 1;
}
