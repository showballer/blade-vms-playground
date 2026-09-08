import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { signalInput, signalWorkflow } from "../packages/ui/src/signal-input";
import { generateRotationSegments, rotationCanonical, rotationWorkflow } from "../packages/ui/src/rotation-data";
async function main() {
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
const tenant = "qa_signal_" + Date.now(), otherTenant = tenant + "_B", password = randomBytes(18).toString("base64url"), users: string[] = [], tokens: Record<string, string> = {}, tests: any[] = [];
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
let rootToken = "", failure: any;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function call(path: string, method = "GET", body?: any, token = tokens.operator) {
  const res = await fetch("http://127.0.0.1:3210/api/v1/" + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); return { status: res.status, data: await res.json() };
}
async function check(name: string, fn: () => Promise<unknown>) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
function ref(kind: "tasks" | "analyses", record: any, segmentId?: string) { const r = { kind, id: record.id, ...(segmentId ? { segmentId } : {}) }; return { ...r, revision: hash(signalInput(r, record).canonical) }; }
const request = (taskId: string, inputs: any[], compare = false) => ({ name: "QA 信号结果", taskId, type: "time", parameters: { workflow: signalWorkflow, inputs, compare, alignment: "relative" }, source: "demo", result: { dataset: { rows: [[999]] } } });
try {
  rootToken = (await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).data.token; assert.ok(rootToken);
  const seed = (await call("records/tasks/task-a1", "GET", undefined, rootToken)).data;
  for (const role of ["operator", "colleague", "analyst", "viewer", "other"]) {
    const username = tenant + "_" + role, created = await call("users", "POST", { username, name: "QA " + role, password, tenant: role === "other" ? otherTenant : tenant, role: role === "other" ? "analyst" : role === "colleague" ? "operator" : role }, rootToken); assert.equal(created.status, 201); users.push(created.data.id); tokens[role] = (await call("session", "POST", { username, password }, "")).data.token;
  }
  const base = { name: "QA 原始", object: "QA 叶片", turbine: "QA", point: "P1", rpm: 60, blades: 2, sampleRate: 4, duration: 2, samples: [1,-2,3,-4,5,-6,7,-8], source: "import", environment: "原始环境", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
  const task = (await call("records/tasks", "POST", base)).data;
  const second = (await call("records/tasks", "POST", { ...base, name: "QA P2", point: "P2", sampleRate: 2, samples: [10,20,30] })).data;
  const colleague = (await call("records/tasks", "POST", { ...base, name: "QA 同事", point: "P3" }, tokens.colleague)).data;
  const foreign = (await call("records/tasks", "POST", { ...base, name: "QA 他组" }, tokens.other)).data;
  const config = { rpm: 60, blades: 2, source: "手动", mode: "period", start: 0, end: 2 }, segments = generateRotationSegments(task, config).segments.map((s,i) => ({ ...s, keep: i !== 1 }));
  const cutBody = { name: "QA 历史截取", taskId: task.id, type: "cut", parameters: { workflow: rotationWorkflow, config, segments, sourceRevision: hash(rotationCanonical(task)) } };
  const cutRes = await call("records/analyses", "POST", cutBody); assert.equal(cutRes.status, 201); const cut = cutRes.data, cutRef = ref("analyses", cut, "4:6");
  const single = request(task.id, [cutRef]), compare = request(task.id, [cutRef, ref("tasks",second)], true);
  await check("未登录、访客、同组其他操作员和跨组用户不能保存此输入", async () => {
    for (const [role, status] of [["",401],["viewer",403],["colleague",404],["other",404]] as const) assert.equal((await call("records/analyses", "POST", single, role ? tokens[role] : "")).status, status);
  });
  let saved: any;
  await check("分段快照由服务器原始矩阵派生，保留原任务时间而非从零拼接", async () => {
    const res = await call("records/analyses", "POST", single); assert.equal(res.status, 201); saved = res.data;
    assert.deepEqual(saved.result.dataset.rows, [[1,5],[1.25,-6]]); assert.equal(saved.source, "import"); assert.equal(saved.result.dataset.metadata.inputs[0].ref.revision, cutRef.revision);
  });
  let compared: any;
  await check("多输入不同采样率保存长表，源时间和显示时间同时冻结", async () => {
    const res = await call("records/analyses", "POST", compare); assert.equal(res.status, 201); compared = res.data;
    assert.deepEqual(compared.result.dataset.rows, [[1,4,1,0,5],[1,5,1.25,.25,-6],[2,0,0,0,10],[2,1,.5,.5,20],[2,2,1,1,30]]); assert.equal(compared.operatorRestricted, false);
  });
  await check("空/重复/排除段/未知引用和缺修订被拒绝，跨组管理员也不能混合", async () => {
    for (const inputs of [[],[cutRef,cutRef],[{ ...cutRef, segmentId: "2:4" }],[{ ...cutRef, id: "missing" }],[{ ...cutRef, revision: undefined }]]) assert.ok([400,404].includes((await call("records/analyses", "POST", { ...single, parameters: { ...single.parameters, inputs } })).status));
    assert.equal((await call("records/analyses", "POST", request(task.id, [ref("tasks",task),ref("tasks",foreign)], true), rootToken)).status, 400);
    const changed = (await call("records/tasks/" + second.id, "PUT", { channels: [{ no: 1, type: "displacement", unit: "mm" }] })).data;
    assert.equal((await call("records/analyses", "POST", request(task.id, [cutRef,ref("tasks",changed)], true))).status, 400);
    assert.equal((await call("records/tasks/" + second.id, "PUT", { channels: base.channels })).status, 200);
  });
  await check("源任务变化阻止陈旧整波形，但历史分段仍使用旧采样率与幅值", async () => {
    const rawRequest = request(task.id, [ref("tasks",task)]);
    assert.equal((await call("records/tasks/" + task.id, "PUT", { samples: Array(8).fill(99), environment: "已修改" })).status, 200);
    assert.equal((await call("records/analyses", "POST", rawRequest)).status, 409);
    const again = await call("records/analyses", "POST", single); assert.equal(again.status, 201); assert.deepEqual(again.data.result.dataset.rows, saved.result.dataset.rows); assert.equal(again.data.result.dataset.metadata.task.environment, "原始环境");
  });
  await check("跨任务所有者的分析及报告不向首任务操作员泄露其他人的波形", async () => {
    const res = await call("records/analyses", "POST", request(task.id, [cutRef,ref("tasks",colleague)], true), tokens.analyst); assert.equal(res.status, 201); assert.equal(res.data.operatorRestricted, true);
    assert.equal((await call("records/analyses/" + res.data.id)).status, 404); assert.ok(!(await call("bootstrap")).data.analyses.some((a: any) => a.id === res.data.id));
    assert.equal((await fetch(`http://127.0.0.1:3210/api/v1/export/analyses/${res.data.id}?view=data&format=json`, { headers: { Authorization: "Bearer " + tokens.operator } })).status, 404);
    const report = await call("records/reports", "POST", { name: "QA 对比报告", taskId: task.id, sections: ["FFT 频谱"], conclusion: "QA" }, tokens.analyst); assert.equal(report.status, 201); assert.equal(report.data.operatorRestricted, true);
    assert.equal((await call("records/reports/" + report.data.id)).status, 404); assert.equal((await call("records/reports/" + report.data.id, "GET", undefined, tokens.viewer)).status, 200);
  });
  await check("已保存快照不能经通用 PUT 改写，输入截取变更返回修订冲突", async () => {
    assert.equal((await call("records/analyses/" + saved.id, "PUT", { parameters: {}, source: "demo" })).status, 405);
    const current = (await call("records/tasks/" + task.id)).data;
    assert.equal((await call("records/analyses/" + cut.id, "PUT", { ...cutBody, parameters: { ...cutBody.parameters, sourceRevision: hash(rotationCanonical(current)) } })).status, 200);
    assert.equal((await call("records/analyses", "POST", single)).status, 409);
    assert.deepEqual((await call("records/analyses/" + saved.id)).data.result.dataset.rows, [[1,5],[1.25,-6]]);
  });
  await check("STFT 重叠率在 API 校验并随结果导出，旧参数缺失不回填", async () => {
    const current = (await call("records/tasks/" + task.id)).data;
    const tf = { ...request(task.id, [ref("tasks", current)]), type: "tf", result: { dataset: saved.result.dataset } };
    tf.parameters = { ...tf.parameters, windowLength: 1024, overlapPercent: 75 } as any;
    const res = await call("records/analyses", "POST", tf); assert.equal(res.status, 201); assert.equal(res.data.parameters.overlapPercent, 75);
    for (const overlapPercent of [-1,100,null,"50"]) assert.equal((await call("records/analyses", "POST", { ...tf, parameters: { ...tf.parameters, overlapPercent } })).status, 400);
    const exported = await fetch(`http://127.0.0.1:3210/api/v1/export/analyses/${res.data.id}?view=data&format=json`, { headers: { Authorization: "Bearer " + tokens.operator } });
    assert.equal(exported.status, 200); assert.equal((await exported.json()).metadata.parameters.overlapPercent, 75);
    const { overlapPercent, ...legacy } = tf.parameters as any;
    const old = await call("records/analyses", "POST", { ...tf, parameters: legacy }); assert.equal(old.status, 201); assert.equal(old.data.parameters.overlapPercent, undefined);
  });
  await check("历史对比五格式导出冻结矩阵与来源，不读取新任务补算", async () => {
    mkdirSync("artifacts/signal-data", { recursive: true });
    for (const format of ["csv","txt","xlsx","mat","json"]) {
      const response = await fetch(`http://127.0.0.1:3210/api/v1/export/analyses/${compared.id}?view=data&format=${format}`, { headers: { Authorization: "Bearer " + tokens.operator } }); assert.equal(response.status, 200); writeFileSync("artifacts/signal-data/api-compare." + format, Buffer.from(await response.arrayBuffer()));
    }
    assert.deepEqual((await call("records/tasks/task-a1", "GET", undefined, rootToken)).data, seed);
  });
} catch (e) { failure = e; console.error(e); }
finally {
  try { for (const group of [tenant,otherTenant]) await db.execute("DELETE FROM records WHERE tenant=?", [group]); for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant IN (?,?)", [id,tenant,otherTenant]); } if (rootToken) await call("session", "DELETE", undefined, rootToken); } finally { await db.end(); }
  mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/signal-api-results.json", JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "Only QA groups/users; audit retained" }, null, 2)); if (failure) process.exitCode = 1;
}
}
main().catch(e => { console.error(e); process.exitCode = 1; });
