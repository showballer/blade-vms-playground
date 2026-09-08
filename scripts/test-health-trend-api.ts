import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { rotationRevision } from "../packages/ui/src/rotation-data";
import { healthBaselineRevision, healthTrendRecord } from "../packages/ui/src/health-trend-data";
const origin = "http://127.0.0.1:3210/api/v1/", tenant = "qa_trend_" + Date.now(), otherTenant = tenant + "_B", password = randomBytes(18).toString("base64url");
const users: string[] = [], tokens: Record<string, string> = {}, tests: { name: string; result: string }[] = [];
async function call(path: string, method = "GET", body?: unknown, token = tokens.analyst) {
  const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  return { status: response.status, data: await response.json() };
}
async function check(name: string, fn: () => Promise<unknown>) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
  if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  let rootToken = "", failure: any;
  try {
    rootToken = (await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).data.token; assert.ok(rootToken);
    for (const role of ["admin", "analyst", "operator", "viewer", "other"]) {
      const username = tenant + "_" + role, created = await call("users", "POST", { username, password, name: "QA " + role, role: role === "other" ? "analyst" : role, tenant: role === "other" ? otherTenant : tenant }, rootToken);
      assert.equal(created.status, 201); users.push(created.data.id); tokens[role] = (await call("session", "POST", { username, password }, "")).data.token;
    }
    const object = "QA 趋势对象", baseBody = { name: "QA 健康基线", object, rms: 1, frequency: .6, modal: .61, score: 80, confidence: .8 };
    const baseId = (await call("records/baselines", "POST", baseBody)).data.id, otherBaseId = (await call("records/baselines", "POST", baseBody, tokens.other)).data.id;
    const taskBody = { name: "QA 趋势源", object, turbine: "QA", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [1,-2,3,-4], source: "import" };
    const taskId = (await call("records/tasks", "POST", taskBody, tokens.operator)).data.id;
    const task = (await call("records/tasks/" + taskId)).data, baseline = (await call("records/baselines/" + baseId)).data;
    const thresholdPath = "health/thresholds?baselineId=" + baseId, sourceRevision = await rotationRevision(task), baselineRevision = await healthBaselineRevision(baseline);
    const input = { taskId, baselineId: baseId, startDate: "2024-02-01", sourceRevision, baselineRevision, configRevision: "missing" };
    // Historical v1 fixture uses the old id derivation and stores only its original columns.
    const legacyId = "ht-" + createHash("sha256").update(JSON.stringify([users[1], tenant, taskId, baseId, input.startDate, sourceRevision, baselineRevision, "missing"])).digest("hex").slice(0, 60);
    const legacyBody = healthTrendRecord(task, baseline, { id: null, tenant, revision: "missing", status: "missing", values: null }, input);
    delete legacyBody.parameters.sampleVersion;
    legacyBody.result.dataset.columns = legacyBody.result.dataset.columns.slice(0, 5);
    legacyBody.result.dataset.rows = legacyBody.result.dataset.rows.map((r: any[]) => r.slice(0, 5)); delete legacyBody.result.dataset.metadata.sampleVersion;
    legacyBody.result.datasets.trend = structuredClone(legacyBody.result.dataset);
    await db.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'analyses',?,?,?)", [legacyId, tenant, JSON.stringify(legacyBody), users[1]]);
    let archived: any, saved: any;
    await check("归档需登录与分析员权限，跨组/跨对象/非法修订拒绝", async () => {
      assert.equal((await call("health/trends", "POST", input, "")).status, 401);
      for (const role of ["viewer", "operator"]) assert.equal((await call("health/trends", "POST", input, tokens[role])).status, 403);
      assert.equal((await call("health/trends", "POST", input, tokens.other)).status, 404);
      assert.equal((await call("health/trends", "POST", { ...input, baselineId: otherBaseId }, tokens.admin)).status, 400);
      const wrong = (await call("records/baselines", "POST", { ...baseBody, object: "other" })).data;
      assert.equal((await call("health/trends", "POST", { ...input, baselineId: wrong.id })).status, 400);
      for (const patch of [{ startDate: "2023-02-29" }, { sourceRevision: null }, { configRevision: "x" }, { baselineRevision: "" }]) assert.equal((await call("health/trends", "POST", { ...input, ...patch })).status, 400);
    });
    await check("并发同输入只创建一份归档，服务端忽略伪造矩阵/来源", async () => {
      const responses = await Promise.all([1,2,3].map(() => call("health/trends", "POST", { ...input, result: { rows: [[999]] }, source: "real" })));
      assert.deepEqual(responses.map(r => r.status).sort(), [200,200,201]); assert.equal(new Set(responses.map(r => r.data.id)).size, 1);
      archived = responses[0].data; assert.equal(archived.source, "demo"); assert.equal(archived.result.datasets.trend.rows.length, 30); assert.equal(archived.recordTenant, tenant);
      assert.notEqual(archived.id, legacyId); assert.equal(archived.result.dataset.columns.length, 10);
      assert.deepEqual(archived.result.datasets.waveform.rows, [[0,1],[.25,-2],[.5,3],[.75,-4]]); assert.equal(archived.result.dataset.metadata.thresholds.status, "missing");
    });
    await check("旧三曲线归档保留原矩阵，新版归档不复用旧 ID，不允许给缺失指标补造标记", async () => {
      const p = `health/trends/${legacyId}/annotations`, mark = { id: "old-frequency", target: "trend", series: "frequency", startIndex: 0, endIndex: 1, label: "待复核", note: "旧归档实存频率" };
      assert.equal((await call(p, "POST", { ...mark, series: "band" })).status, 400);
      assert.equal((await call(p, "POST", mark)).status, 200);
      const legacy = (await call(`export/analyses/${legacyId}?view=data&dataset=trend&format=json`)).data;
      assert.equal(legacy.columns.length, 5); assert.deepEqual(legacy.rows, legacyBody.result.dataset.rows);
    });
    await check("任务/基线/阈值陈旧修订全部拒绝，禁止通用接口伪造/覆盖/删除", async () => {
      for (const key of ["sourceRevision", "baselineRevision", "configRevision"]) assert.equal((await call("health/trends", "POST", { ...input, [key]: "0".repeat(64) })).status, 409);
      for (const method of ["PUT", "DELETE"]) assert.equal((await call("records/analyses/" + archived.id, method, method === "PUT" ? { result: {} } : undefined)).status, 405);
      assert.equal((await call("records/analyses", "POST", { name: "伪造趋势", taskId, type: "health-trend", parameters: archived.parameters, result: archived.result })).status, 400);
      assert.equal((await call("sync/tasks", "POST", { clientId: "qa-trend", localId: "local", revision: "1", task, analyses: [{ ...archived, taskId: "local" }] })).status, 400);
    });
    const annotation = { id: "a1", target: "trend", series: "frequency", startIndex: 2, endIndex: 4, label: "异常", note: "人工频率标记" }, markPath = `health/trends/${archived.id}/annotations`;
    await check("并发标记串行追加，身份时间可信，同 ID 同内容重试去重", async () => {
      const responses = await Promise.all(["a1", "a2"].map(id => call(markPath, "POST", { ...annotation, id, actor: "伪造", status: "withdrawn", time: "1900" })));
      assert.ok(responses.every(r => r.status === 200)); saved = (await call("records/analyses/" + archived.id)).data;
      assert.equal(saved.result.annotations.length, 2); assert.ok(saved.result.annotations.every((a: any) => a.actor === "QA analyst" && a.status === "active" && Date.parse(a.time) > Date.now() - 60000));
      assert.deepEqual((await call(markPath, "POST", annotation)).data.result.annotations, saved.result.annotations);
      assert.equal((await call(markPath, "POST", { ...annotation, note: "changed" })).status, 409);
      assert.equal((await call(markPath, "POST", annotation, tokens.admin)).status, 409);
      assert.deepEqual((await call("health/trends", "POST", input)).data.result.annotations, saved.result.annotations);
    });
    await check("标记与撤回继承访问范围及写权限，坏位置不能落库", async () => {
      for (const role of ["operator", "viewer"]) { assert.equal((await call(markPath, "POST", annotation, tokens[role])).status, 403); assert.equal((await call(markPath + "/a1/withdraw", "POST", { reason: "test" }, tokens[role])).status, 403); }
      assert.equal((await call(markPath, "POST", annotation, tokens.other)).status, 404);
      assert.equal((await call(markPath + "/a1/withdraw", "POST", { reason: "test" }, tokens.other)).status, 404);
      for (const patch of [{ startIndex: .5 }, { endIndex: 31 }, { label: "已剔除" }, { note: " " }, { series: "value" }]) assert.equal((await call(markPath, "POST", { ...annotation, id: "bad", ...patch })).status, 400);
      assert.equal((await call(markPath + "/none/withdraw", "POST", { reason: "test" })).status, 404);
    });
    await check("撤回保留初始记录与原因，重复撤回不改历史/矩阵", async () => {
      assert.equal((await call(markPath + "/a1/withdraw", "POST", { reason: " " })).status, 400);
      saved = (await call(markPath + "/a1/withdraw", "POST", { reason: "人工误选" })).data;
      const a = saved.result.annotations.find((a: any) => a.id === "a1"); assert.equal(a.note, annotation.note); assert.equal(a.withdrawnBy, "QA analyst"); assert.equal(a.status, "withdrawn");
      assert.deepEqual((await call(markPath + "/a1/withdraw", "POST", { reason: "人工误选" })).data.result.annotations, saved.result.annotations);
      assert.equal((await call(markPath + "/a1/withdraw", "POST", { reason: "改写" })).status, 409); assert.equal((await call(markPath, "POST", annotation)).status, 409);
      assert.deepEqual(saved.result.datasets, archived.result.datasets); assert.deepEqual((await call("records/tasks/" + taskId)).data, task); assert.deepEqual((await call("records/baselines/" + baseId)).data, baseline);
    });
    await check("列表/初始化/详情/导出一致隔离，原始值和标记进入五格式", async () => {
      mkdirSync("artifacts/health-trend-data", { recursive: true });
      for (const role of ["viewer", "operator"]) { assert.equal((await call("records/analyses/" + archived.id, "GET", undefined, tokens[role])).status, 200); assert.ok((await call("bootstrap", "GET", undefined, tokens[role])).data.analyses.some((a: any) => a.id === archived.id)); }
      assert.equal((await call("records/analyses/" + archived.id, "GET", undefined, tokens.other)).status, 404); assert.ok(!(await call("records/analyses", "GET", undefined, tokens.other)).data.some((a: any) => a.id === archived.id));
      for (const key of ["trend", "waveform"]) for (const format of ["csv", "txt", "xlsx", "mat", "json"]) {
        const response = await fetch(origin + `export/analyses/${archived.id}?view=data&dataset=${key}&format=${format}`, { headers: { Authorization: "Bearer " + tokens.viewer } }); assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer()); writeFileSync(`artifacts/health-trend-data/api-${key}.${format}`, bytes);
        if (format === "json") { const data = JSON.parse(bytes.toString()); assert.deepEqual(data.rows, saved.result.datasets[key].rows); assert.equal(data.metadata.analysis.result.annotations.length, 2); }
      }
      assert.equal((await call(`export/analyses/${archived.id}?view=data&format=json&dataset=trend`, "GET", undefined, tokens.other)).status, 404);
      assert.equal((await call(`export/analyses/${archived.id}?view=data&format=json&dataset=missing`)).status, 400);
    });
    await check("报告冻结标记，后续标记和源任务修改不回写旧归档/报告", async () => {
      const report = await call("records/reports", "POST", { name: "QA 趋势报告", taskId, sections: ["健康趋势与标记"], conclusion: "人工演示" }); assert.equal(report.status, 201, JSON.stringify(report.data));
      assert.equal((await call(markPath, "POST", { ...annotation, id: "w", target: "waveform", series: "value", startIndex: 1, endIndex: 4 })).status, 200);
      const frozen = (await call("records/reports/" + report.data.id)).data.analysisSnapshots.find((a: any) => a.id === archived.id); assert.equal(frozen.result.annotations.length, 2);
      await call("records/tasks/" + taskId, "PUT", { samples: [9,8,7,6] }, tokens.operator); assert.equal((await call("health/trends", "POST", input)).status, 409);
      assert.deepEqual((await call("records/analyses/" + archived.id)).data.result.datasets, archived.result.datasets);
      assert.equal((await call("records/baselines/" + baseId, "PUT", { rms: 2, revision: baseline.revision })).status, 200); assert.equal((await call("health/trends", "POST", { ...input, sourceRevision: await rotationRevision((await call("records/tasks/" + taskId)).data) })).status, 409);
    });
    await check("实际阈值更新引起归档冲突，新归档冻结新配置而旧归档不变", async () => {
      const before = (await call(thresholdPath)).data, values = { rms: 7, frequency: 9, band: 1.2, attentionRatio: .4, warningRatio: .7 };
      const response = await call(thresholdPath, "PUT", { revision: before.revision, values }, tokens.admin); assert.equal(response.status, 200);
      const currentInput = { ...input, sourceRevision: await rotationRevision((await call("records/tasks/" + taskId)).data), baselineRevision: await healthBaselineRevision((await call("records/baselines/" + baseId)).data) };
      assert.equal((await call("health/trends", "POST", currentInput)).status, 409); input.configRevision = response.data.revision;
      const saved = await call("health/trends", "POST", { ...currentInput, configRevision: input.configRevision }); assert.equal(saved.status, 201); assert.deepEqual(saved.data.result.dataset.metadata.thresholds.values, values);
      assert.equal((await call("records/analyses/" + archived.id)).data.result.dataset.metadata.thresholds.status, "missing");
    });
    await check("无波形归档不造数据，源基线/任务删除后历史仍独立可读", async () => {
      const emptyId = (await call("records/tasks", "POST", { ...taskBody, name: "QA 空波形", samples: [] })).data.id;
      const empty = (await call("records/tasks/" + emptyId)).data, b = (await call("records/baselines/" + baseId)).data;
      const response = await call("health/trends", "POST", { ...input, taskId: emptyId, sourceRevision: await rotationRevision(empty), baselineRevision: await healthBaselineRevision(b) }); assert.equal(response.status, 201); assert.equal(response.data.result.datasets.waveform, undefined);
      assert.equal((await call(`health/trends/${response.data.id}/annotations`, "POST", { ...annotation, target: "waveform", series: "value" })).status, 400);
      assert.equal((await call("records/baselines/" + baseId, "DELETE", { revision: b.revision, confirm: true })).status, 200); await call("records/tasks/" + taskId, "DELETE", undefined, tokens.operator);
      assert.equal((await call("records/analyses/" + archived.id, "GET", undefined, tokens.viewer)).status, 200); assert.equal((await call("records/analyses/" + archived.id, "GET", undefined, tokens.operator)).status, 404);
      assert.equal((await call(markPath, "POST", { ...annotation, id: "after-delete" })).status, 200);
    });
    await check("跨组管理员归档/标记的记录与审计落在源课题组", async () => {
      const otherTaskId = (await call("records/tasks", "POST", taskBody, tokens.other)).data.id, t = (await call("records/tasks/" + otherTaskId, "GET", undefined, tokens.other)).data, b = (await call("records/baselines/" + otherBaseId, "GET", undefined, tokens.other)).data;
      const response = await call("health/trends", "POST", { ...input, taskId: t.id, baselineId: b.id, sourceRevision: await rotationRevision(t), baselineRevision: await healthBaselineRevision(b), configRevision: "missing" }, tokens.admin); assert.equal(response.status, 201); assert.equal(response.data.recordTenant, otherTenant);
      assert.equal((await call(`health/trends/${response.data.id}/annotations`, "POST", annotation, tokens.admin)).status, 200);
      const [logs] = await db.execute<any[]>("SELECT tenant,action FROM audit_logs WHERE target=? OR target=?", [response.data.id, response.data.id + "/a1"]); assert.equal(logs.length, 2); assert.ok(logs.every(l => l.tenant === otherTenant));
      assert.equal((await call("records/analyses/" + response.data.id, "GET", undefined, tokens.analyst)).status, 404);
    });
  } catch (error) { failure = error; console.error(error); }
  finally {
    for (const group of [tenant, otherTenant]) await db.execute("DELETE FROM records WHERE tenant=?", [group]);
    for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant IN (?,?)", [id, tenant, otherTenant]); }
    if (rootToken) await call("session", "DELETE", undefined, rootToken); await db.end();
    mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/health-trend-api-results.json", JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "Only isolated QA groups/users removed; audit retained" }, null, 2));
    if (failure) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
