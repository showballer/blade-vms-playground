import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
const require = createRequire(import.meta.url), { modalWorkflow, modalBaselineCanonical } = require("../apps/desktop/electron/modal-data.cjs"), { rotationCanonical } = require("../apps/desktop/electron/rotation-data.cjs");
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
const tenant = "qa_modal_" + Date.now(), otherTenant = tenant + "_B", password = randomBytes(18).toString("base64url"), users = [], tokens = {}, tests = [];
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
let rootToken, failure;
const hash = value => createHash("sha256").update(value).digest("hex");
async function call(path, method = "GET", body, token = tokens.analyst) { const res = await fetch("http://127.0.0.1:3210/api/v1/" + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); return { status: res.status, data: await res.json() }; }
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
try {
  rootToken = (await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).data.token; assert.ok(rootToken);
  const seed = (await call("records/tasks/task-a1", "GET", undefined, rootToken)).data;
  for (const role of ["analyst", "operator", "viewer", "other"]) {
    const username = tenant + "_" + role, created = await call("users", "POST", { username, name: "QA " + role, password, tenant: role === "other" ? otherTenant : tenant, role: role === "other" ? "analyst" : role }, rootToken); assert.equal(created.status, 201); users.push(created.data.id);
    tokens[role] = (await call("session", "POST", { username, password }, "")).data.token;
  }
  const taskId = (await call("records/tasks", "POST", { name: "QA 模态原始任务", object: "QA 叶片", turbine: "QA", point: "P1", rpm: 60, blades: 2, sampleRate: 4, duration: 1, samples: [1,-2,3,-4], source: "import", environment: "原始环境" }, tokens.operator)).data.id;
  const task = (await call("records/tasks/" + taskId)).data;
  const config = { test: "oma", method: "FDD", damping: "曲线拟合", points: ["P1", "P3"], activeOrder: 2, baselineId: "prototype" };
  const request = { name: "QA 模态演示", taskId, type: "modal", source: "real", parameters: { workflow: modalWorkflow, config, sourceRevision: hash(rotationCanonical(task)), baselineRevision: hash(modalBaselineCanonical()) }, result: { dataset: { rows: [[999]] } } };
  const baseline = (await call("records/baselines", "POST", { name: "QA 正常态", object: task.object, modal: .62 })).data;
  const wrongBaseline = (await call("records/baselines", "POST", { name: "QA 异对象", object: "另一个对象", modal: .7 })).data;
  const otherBaseline = (await call("records/baselines", "POST", { name: "QA 跨组同对象", object: task.object, modal: .8 }, tokens.other)).data;
  const withBaseline = b => ({ ...request, parameters: { ...request.parameters, config: { ...config, baselineId: b.id }, baselineRevision: hash(modalBaselineCanonical(b)) } });
  await check("未登录、操作员和访客不能保存模态，跨组任务也不可读取", async () => {
    for (const [token, status] of [["",401],[tokens.operator,403],[tokens.viewer,403],[tokens.other,404]]) assert.equal((await call("records/analyses", "POST", request, token)).status, status);
  });
  await check("非法方法/阻尼/测点/阶次及缺失修订拒绝，不产生分析", async () => {
    for (const patch of [{ method: "ERA" }, { damping: "invalid" }, { points: [] }, { points: ["P1","P1"] }, { points: ["P9"] }, { activeOrder: 4 }]) assert.equal((await call("records/analyses", "POST", { ...request, parameters: { ...request.parameters, config: { ...config, ...patch } } })).status, 400);
    assert.equal((await call("records/analyses", "POST", { ...request, parameters: {} })).status, 400);
    assert.equal((await call("records/analyses", "POST", { ...request, parameters: { ...request.parameters, baselineRevision: "bad" } })).status, 400);
    assert.equal((await call("records/analyses")).data.length, 0);
  });
  let saved;
  await check("服务器派生四类演示结果，测点选择生效且忽略伪造矩阵/来源", async () => {
    const response = await call("records/analyses", "POST", request); assert.equal(response.status, 201); saved = response.data;
    assert.equal(saved.source, "demo"); assert.deepEqual(saved.result.dataset.rows[1], [2,1.8,1.8,"二阶弯曲"]);
    assert.deepEqual(saved.result.datasets.points.columns.map(c => c.key), ["frequency","P1","P3"]); assert.equal(saved.result.datasets.shape.rows.length, 6);
    assert.deepEqual((await call("records/tasks/" + taskId)).data, task);
  });
  await check("基准必须同组同对象；已有基线只比较已存的一阶频率", async () => {
    assert.equal((await call("records/analyses", "POST", withBaseline(wrongBaseline))).status, 400);
    assert.equal((await call("records/analyses", "POST", withBaseline(otherBaseline))).status, 404);
    assert.equal((await call("records/analyses", "POST", withBaseline(otherBaseline), rootToken)).status, 400);
    const response = await call("records/analyses", "POST", withBaseline(baseline)); assert.equal(response.status, 201); assert.deepEqual(response.data.result.datasets.baseline.rows.map(r => r.slice(0,3)), [[1,.62,.6]]);
  });
  await check("四类五格式导出继承权限，非法子结果不回退且元信息不递归膨胀", async () => {
    mkdirSync("artifacts/modal-data", { recursive: true });
    for (const key of ["parameters","points","shape","baseline"]) for (const format of ["json","csv","txt","xlsx","mat"]) {
      const url = `http://127.0.0.1:3210/api/v1/export/analyses/${saved.id}?view=data&dataset=${key}&format=${format}`;
      assert.equal((await fetch(url, { headers: { Authorization: "Bearer " + tokens.other } })).status, 404);
      const response = await fetch(url, { headers: { Authorization: "Bearer " + tokens.viewer } }); assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()); writeFileSync(`artifacts/modal-data/api-${key}.${format}`, bytes);
      if (format === "json") { const data = JSON.parse(bytes); assert.equal(data.metadata.datasetKey, key); assert.equal(data.metadata.analysis.result.datasets, undefined); assert.equal(data.metadata.demo, true); }
    }
    for (const key of ["missing", "__proto__"]) assert.equal((await call(`export/analyses/${saved.id}?view=data&dataset=${key}`)).status, 400);
    assert.equal((await call(`export/tasks/${taskId}?view=data&dataset=shape`)).status, 400);
  });
  await check("源基线/任务修订变化拒绝旧保存，历史子结果不被重算", async () => {
    assert.equal((await call("records/baselines/" + baseline.id, "PUT", { modal: .72, revision: baseline.revision })).status, 200);
    assert.equal((await call("records/analyses", "POST", withBaseline(baseline))).status, 409);
    assert.equal((await call("records/tasks/" + taskId, "PUT", { environment: "已修改", samples: [99,-2,3,-4] })).status, 200);
    assert.equal((await call("records/analyses", "POST", request)).status, 409);
    const history = (await call("records/analyses/" + saved.id)).data;
    assert.deepEqual(history.result.datasets, saved.result.datasets); assert.equal(history.result.dataset.metadata.task.environment, "原始环境");
  });
  await check("报告冻结全部模态子结果，包含频率阻尼摘要，种子任务未改变", async () => {
    const report = await call("records/reports", "POST", { name: "QA 模态报告", taskId, sections: ["模态参数"], conclusion: "演示流程验证", source: "demo" }); assert.equal(report.status, 201);
    assert.deepEqual(report.data.analysisSnapshots.find(a => a.id === saved.id).result.datasets, saved.result.datasets);
    assert.deepEqual((await call("records/tasks/task-a1", "GET", undefined, rootToken)).data, seed);
  });
} catch (error) { failure = error; console.error(error); }
finally {
  try { for (const group of [tenant, otherTenant]) await db.execute("DELETE FROM records WHERE tenant=?", [group]); for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant IN (?,?)", [id,tenant,otherTenant]); } if (rootToken) await call("session", "DELETE", undefined, rootToken); } finally { await db.end(); }
  mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/modal-api-results.json", JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "Only QA groups/users removed; audit retained" }, null, 2)); if (failure) process.exitCode = 1;
}
