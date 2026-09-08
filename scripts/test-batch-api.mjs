import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import batch from "../apps/desktop/electron/batch.cjs";
const base = "http://127.0.0.1:3210/api/v1/", tenant = "qa_batch_" + Date.now(), password = randomBytes(18).toString("base64url");
const users = [], tokens = {}, tests = [];
let rootToken, failure;
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing a non-project database");
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
async function call(path, method = "GET", body, token = tokens.operator) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, data: await response.json() };
}
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
const input = { name: tenant + " 输入", object: "QA 叶片", turbine: "QA-01", point: "P1", sampleRate: 4, rpm: 12, blades: 3, duration: 1, samples: [2, -4, 6, -8], source: "import", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
try {
  const login = await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, ""); assert.equal(login.status, 200); rootToken = login.data.token;
  for (const label of ["operator", "peer", "viewer", "admin"]) {
    const username = tenant + "_" + label, role = label === "peer" ? "operator" : label;
    const created = await call("users", "POST", { username, role, name: "QA " + label, tenant, password }, rootToken); assert.equal(created.status, 201); users.push(created.data.id);
    const session = await call("session", "POST", { username, password }, ""); assert.equal(session.status, 200); tokens[label] = session.data.token;
  }
  const task = await call("records/tasks", "POST", input); assert.equal(task.status, 201);
  const other = await call("records/tasks", "POST", { ...input, name: tenant + " 同组他人任务" }, tokens.peer); assert.equal(other.status, 201);
  const config = structuredClone(batch.defaultBatchConfig); config.cut.start = 0.25; config.cut.end = 0.75;
  const request = { id: randomUUID(), name: tenant + " 批次", taskIds: [task.data.id], config };
  await check("批次拒绝非法配置和访客写入", async () => {
    assert.equal((await call("batches", "POST", request, tokens.viewer)).status, 403);
    assert.equal((await call("batches", "POST", { ...request, taskIds: [] })).status, 400);
    assert.equal((await call("batches", "POST", { ...request, config: { ...config, fft: { ...config.fft, nfft: 7 } } })).status, 400);
  });
  await check("混入不可见任务时整个批次拒绝，不部分写入", async () => {
    assert.equal((await call("batches", "POST", { ...request, taskIds: [task.data.id, other.data.id] })).status, 404);
    assert.equal((await call("batches")).data.length, 0);
    const [rows] = await db.execute("SELECT id FROM records WHERE tenant=? AND kind='batches'", [tenant]); assert.equal(rows.length, 0);
  });
  await check("并发创建同一批次只保存一次，同标识不同参数明确冲突", async () => {
    const responses = await Promise.all(Array.from({ length: 3 }, () => call("batches", "POST", request)));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal((await call("batches")).data.length, 1);
    assert.equal((await call("batches", "POST", { ...request, name: "冲突名称" })).status, 409);
  });
  await check("批次按创建人隔离，列表/详情/导出/初始化不泄露输入快照", async () => {
    const view = (await call("batches/" + request.id)).data;
    assert.equal(view.items[0].sampleCount, 4); assert.equal(view.items[0].input, undefined); assert.equal(view.requestHash, undefined);
    for (const path of ["batches/" + request.id, "records/batches/" + request.id, "export/batches/" + request.id + "?format=json"])
      assert.equal((await call(path, "GET", undefined, tokens.peer)).status, 404);
    assert.equal((await call("bootstrap", "GET", undefined, tokens.peer)).data.batches.length, 0);
    assert.equal((await call("batches", "GET", undefined, tokens.viewer)).data.length, 0);
  });
  await check("禁止通过通用记录接口伪造批次完成状态", async () => {
    assert.equal((await call("records/batches/" + request.id, "PUT", { status: "completed" })).status, 405);
    assert.equal((await call("records/batches", "POST", { name: "伪造批次" })).status, 405);
    assert.equal((await call("batches/" + request.id + "/step", "POST", { taskId: task.data.id, step: "denoise" })).status, 409);
  });
  const step = (key) => call(`batches/${request.id}/step`, "POST", { taskId: task.data.id, step: key });
  await call(`batches/${request.id}/resume`, "POST", {});
  await check("步骤不能跳过前置步骤或引用批次之外任务", async () => {
    assert.equal((await step("fft")).status, 409);
    assert.equal((await call(`batches/${request.id}/step`, "POST", { taskId: other.data.id, step: "denoise" })).status, 404);
  });
  await check("并发执行一步只生成一份分析，重试返回原步骤状态", async () => {
    const responses = await Promise.all(Array.from({ length: 3 }, () => step("denoise")));
    for (const r of responses) assert.equal(r.status, 200);
    assert.equal(responses.filter((r) => !r.data.replayed).length, 1);
    const [rows] = await db.execute("SELECT id FROM records WHERE tenant=? AND kind='analyses'", [tenant]); assert.equal(rows.length, 1);
    assert.equal(responses[0].data.items[0].steps[0].attempts, 1);
  });
  let cutId;
  await check("源任务后续修改不改变批次输入，截取保留绝对时间与原始幅值", async () => {
    const changed = await call("records/tasks/" + task.data.id, "PUT", { samples: [10, 20, 30, 40] }); assert.equal(changed.status, 200);
    const response = await step("cut"); assert.equal(response.status, 200);
    cutId = response.data.items[0].steps.find((s) => s.key === "cut").analysisId;
    const analysis = (await call("records/analyses/" + cutId)).data;
    assert.deepEqual(analysis.result.rows, [[0.25, -4], [0.5, 6]]); assert.deepEqual(analysis.parameters.sourceRange, { startIndex: 1, endExclusive: 3 });
    assert.equal(analysis.parameters.inputMetadata.name, input.name);
    assert.deepEqual((await call("records/tasks/" + task.data.id)).data.samples, [10, 20, 30, 40]);
  });
  await check("暂停状态持久化，恢复后跳过已完成步骤并补齐结果", async () => {
    await call(`batches/${request.id}/pause`, "POST", {}); assert.equal((await step("fft")).status, 409);
    assert.equal((await call("batches/" + request.id)).data.completed, 2);
    await call(`batches/${request.id}/resume`, "POST", {});
    assert.equal((await step("fft")).data.completed, 3);
    const completed = await step("features"); assert.equal(completed.data.status, "completed"); assert.equal(completed.data.completed, 4);
    const [rows] = await db.execute("SELECT id FROM records WHERE tenant=? AND kind='analyses'", [tenant]); assert.equal(rows.length, 4);
    for (const entry of completed.data.items[0].steps) {
      const analysis = (await call("records/analyses/" + entry.analysisId)).data;
      assert.equal(analysis.source, "demo"); assert.equal(analysis.parameters.batchId, request.id); assert.equal(analysis.result.demo, true);
    }
  });
  await check("批处理结果可按权限导出，包含完整参数和输入元信息", async () => {
    const response = await call(`export/analyses/${cutId}?format=json`); assert.equal(response.status, 200);
    assert.deepEqual(response.data[0].result.rows, [[0.25, -4], [0.5, 6]]);
    assert.equal(response.data[0].parameters.inputMetadata.channels[0].unit, "mm/s");
    assert.equal((await call(`export/analyses/${cutId}?format=json`, "GET", undefined, tokens.peer)).status, 404);
  });
  await check("批处理数值结果五格式与冻结输入一致，访客可读但操作员不能跨本人任务导出", async () => {
    mkdirSync("artifacts/result-data", { recursive: true });
    for (const format of ["csv", "txt", "xlsx", "mat", "json"]) {
      const path = `export/analyses/${cutId}?view=data&format=${format}`;
      const response = await fetch(base + path, { headers: { Authorization: "Bearer " + tokens.viewer } }); assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Disposition"), new RegExp(`\\.${format}`));
      const bytes = Buffer.from(await response.arrayBuffer()); writeFileSync(`artifacts/result-data/api-cut.${format}`, bytes);
      if (format === "json") { const data = JSON.parse(bytes); assert.deepEqual(data.rows, [[.25, -4], [.5, 6]]); assert.equal(data.metadata.analysis.parameters.inputMetadata.channels[0].unit, "mm/s"); }
      if (format === "csv" || format === "txt") { const text = bytes.toString("utf8"); assert.ok(text.includes('"-4"')); assert.ok(!text.includes('"\'-4"')); assert.ok(text.includes("sourceRange")); }
      if (format === "xlsx") { const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes); const sheet = book.getWorksheet("结果数据"); assert.equal(sheet.getCell("A2").value, .25); assert.equal(sheet.getCell("B2").value, -4); assert.equal(sheet.rowCount, 3); }
      assert.equal((await call(path, "GET", undefined, tokens.peer)).status, 404);
    }
  });
  await check("任务数值接口读取当前原始波形，历史批次导出不随其修改", async () => {
    const response = await call(`export/tasks/${task.data.id}?view=data&format=json`); assert.equal(response.status, 200);
    assert.deepEqual(response.data.rows, [[0, 10], [.25, 20], [.5, 30], [.75, 40]]);
    assert.equal(response.data.metadata.task.id, task.data.id); assert.equal(response.data.columns[1].unit, "mm/s");
    const historical = await call(`export/analyses/${cutId}?view=data&format=json`); assert.deepEqual(historical.data.rows, [[.25, -4], [.5, 6]]);
  });
  await check("仅说明的旧分析及非法数值导出请求明确拒绝，不合成结果", async () => {
    const old = await call("records/analyses", "POST", { name: tenant + " 仅参数", taskId: task.data.id, type: "fft", parameters: { nfft: 4096 }, result: { note: "未保存矩阵" }, source: "demo" }); assert.equal(old.status, 201);
    const response = await call(`export/analyses/${old.data.id}?view=data&format=mat`); assert.equal(response.status, 400); assert.match(response.data.error, /没有结果矩阵/);
    for (const path of ["export/analyses?view=data&format=csv", `export/analyses/${cutId}?view=data&format=docx`, `export/analyses/${cutId}?view=data&format=exe`]) assert.equal((await call(path)).status, 400);
    assert.equal((await call(`export/analyses/${old.data.id}?format=json`)).status, 200);
  });
  await check("报告导出包含批处理截取和 FFT 摘要，不把全部矩阵挤入单元格", async () => {
    const report = await call("records/reports", "POST", { name: tenant + " 批处理报告", taskId: task.data.id, sections: ["降噪与截取", "FFT 频谱"], source: "demo" }, tokens.admin);
    assert.equal(report.status, 201);
    const response = await fetch(base + `export/reports/${report.data.id}?format=docx`, { headers: { Authorization: "Bearer " + tokens.admin } }); assert.equal(response.status, 200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer()), xml = await zip.file("word/document.xml").async("string");
    assert.ok(xml.includes("结果 2 行")); assert.ok(xml.includes(cutId)); assert.ok(xml.includes("FFT 接口未接入"));
    assert.ok(xml.length < 100000);
  });
  await check("业务备份恢复包含批次快照和结果，不触碰其他组", async () => {
    const original = (await call("records/tasks/task-a1", "GET", undefined, rootToken)).data;
    const backup = await call("backups", "POST", {}, tokens.admin); assert.equal(backup.status, 201);
    assert.equal((await call("records/analyses/" + cutId, "DELETE")).status, 200);
    assert.equal((await step("cut")).status, 409);
    const restored = await call("backups/restore", "POST", { id: backup.data.id, confirm: "恢复业务数据" }, tokens.admin); assert.equal(restored.status, 200);
    assert.equal((await call("batches/" + request.id)).data.completed, 4);
    assert.deepEqual((await call("records/analyses/" + cutId)).data.result.rows, [[0.25, -4], [0.5, 6]]);
    assert.equal((await step("cut")).data.replayed, true);
    assert.deepEqual((await call("records/tasks/task-a1", "GET", undefined, rootToken)).data, original);
  });
  await check("无波形任务记录失败原因，不生成占位成功分析", async () => {
    const emptyTask = await call("records/tasks", "POST", { ...input, samples: [], name: tenant + " 空波形" });
    const badRequest = { ...request, id: randomUUID(), taskIds: [emptyTask.data.id] };
    await call("batches", "POST", badRequest); await call(`batches/${badRequest.id}/resume`, "POST", {});
    const bad = await call(`batches/${badRequest.id}/step`, "POST", { taskId: emptyTask.data.id, step: "denoise" });
    assert.equal(bad.status, 200); assert.equal(bad.data.failed, 1); assert.equal(bad.data.completed, 0); assert.match(bad.data.items[0].steps[0].error, /没有有效波形/);
  });
} catch (e) { failure = e; console.error(e); }
finally {
  try {
    await db.execute("DELETE FROM records WHERE tenant=?", [tenant]);
    for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [id, tenant]); }
    if (rootToken) await call("session", "DELETE", undefined, rootToken);
  } finally { await db.end(); }
  mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/batch-api-results.json", JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "QA tenant records/users removed; audit retained" }, null, 2));
  console.log(`${tests.length} batch API checks passed; QA data cleaned.`); if (failure) process.exitCode = 1;
}
