/** Isolated HTTP fixtures for manual browser / document-render QA. No browser automation. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import mysql from "mysql2/promise";
import { rotationRevision } from "../packages/ui/src/rotation-data";
import { healthBaselineRevision } from "../packages/ui/src/health-trend-data";
import { modalBaselineRevision } from "../packages/ui/src/modal-data";
import { reportSections } from "../packages/ui/src/report-data";

const dir = "artifacts/report-wide", statePath = dir + "/private-state.json";
const origin = "http://127.0.0.1:3210/api/v1/";
async function api(path: string, method = "GET", body?: unknown, token = "") {
  const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function main() {
  assert.equal(process.env.DB_NAME, "blade_vms_playground");
  mkdirSync(dir, { recursive: true });
  const mode = process.argv[2] || "prepare";
  if (mode === "cleanup") {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.match(state.tenant, /^qa_report_wide_\d+$/);
    const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    try {
      await db.execute("DELETE FROM records WHERE tenant=?", [state.tenant]);
      for (const id of state.users) {
        await db.execute("DELETE FROM sessions WHERE user_id=?", [id]);
        await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [id, state.tenant]);
      }
    } finally { await db.end(); }
    unlinkSync(statePath);
    console.log("Removed only this fixture tenant's records, users and sessions; audit retained.");
    return;
  }
  if (mode === "export") {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const response = await fetch(origin + "export/reports/" + state.reportId + "?format=docx", { headers: { Authorization: "Bearer " + state.token } });
    assert.equal(response.status, 200);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 2).toString(), "PK");
    writeFileSync(dir + "/" + (process.argv[3] || "before") + ".docx", buffer);
    console.log("Exported real product Word report, bytes=" + buffer.length);
    return;
  }
  assert.equal(mode, "prepare");
  assert.ok(!existsSync(statePath), "An existing QA fixture must be cleaned before preparing another.");
  const tenant = "qa_report_wide_" + Date.now(), password = randomBytes(20).toString("base64url");
  const root = await api("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD });
  const state: any = { tenant, users: [] };
  // State is ignored by Git, mode 0600, and removed by the exact-scope cleanup command.
  const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  save();
  try {
    const username = tenant + "_analyst";
    const user = await api("users", "POST", { username, password, name: "宽表报告验收", tenant, role: "analyst" }, root.token);
    state.users.push(user.id); save();
    state.token = (await api("session", "POST", { username, password })).token; save();
    const call = (path: string, method = "GET", body?: unknown) => api(path, method, body, state.token);
    const task = await call("records/tasks", "POST", { name: "宽表验收叶片任务", object: "QA 叶片宽表", turbine: "QA-WIDE", point: "P1", sampleRate: 100, duration: 3, rpm: 15, blades: 3, samples: Array.from({ length: 300 }, (_, i) => Number(Math.sin(i / 12).toFixed(6))), source: "demo", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] });
    const storedTask = await call("records/tasks/" + task.id);
    const sourceRevision = await rotationRevision(storedTask);
    const wide = { schema: "blade-vms/dataset-v1", title: "32 列已保存矩阵", columns: [{ key: "index", label: "样本索引", unit: "0-based", type: "number" }, ...Array.from({ length: 31 }, (_, i) => ({ key: "v" + (i + 1), label: "测点" + (i + 1) + "幅值", unit: "mm/s", type: "number" }))], rows: Array.from({ length: 12 }, (_, i) => [i, ...Array.from({ length: 31 }, (_, j) => Number(((i + 1) * (j + 1) / 17).toFixed(8)))]), metadata: { type: "fft", source: "demo", demo: true, note: "仅验证宽表排版，样例矩阵不是实测或算法结果。" } };
    await call("records/analyses", "POST", { name: "32 列宽表验收", taskId: task.id, type: "fft", parameters: { nfft: 4096, note: "长参数分页验证。".repeat(20) }, result: { dataset: wide }, source: "demo" });
    for (const type of ["filter", "env", "damage"]) await call("records/analyses", "POST", { name: "完整章节 " + type, taskId: task.id, type, parameters: { method: "演示" }, result: { note: "此记录仅验证章节内容；未运行算法。" }, source: "demo" });
    await call("records/analyses", "POST", { name: "三阶模态参数", taskId: task.id, type: "modal", source: "demo", parameters: { workflow: "modal-preview-v1", sourceRevision, baselineRevision: await modalBaselineRevision(), config: { test: "free", method: "峰值拾取", damping: "半功率带宽", points: ["P1", "P2", "P3"], activeOrder: 1, baselineId: "prototype" } } });
    const createdBase = await call("records/baselines", "POST", { name: "宽表健康基线", object: storedTask.object, rms: 1, frequency: .6, modal: .61, score: 80, confidence: .8 });
    const baseline = await call("records/baselines/" + createdBase.id);
    for (const startDate of ["2026-06-01", "2026-07-01"]) {
      const trend = await call("health/trends", "POST", { taskId: task.id, baselineId: baseline.id, startDate, sourceRevision, baselineRevision: await healthBaselineRevision(baseline), configRevision: "missing" });
      await call("health/trends/" + trend.id + "/annotations", "POST", { id: "wide-mark", target: "trend", series: "damping", startIndex: 2, endIndex: 4, label: "异常", note: "人工复核样例，不改变原始矩阵。" });
    }
    const report = await call("records/reports", "POST", { name: "QA 宽表与十章节报告", taskId: task.id, sections: reportSections, organization: "宽表报告验收", reportNumber: "QA-WIDE-001", conclusion: "仅验证界面与导出可读性，不构成真实检测结论。", source: "demo" });
    state.reportId = report.id; save();
    writeFileSync(dir + "/expected.json", JSON.stringify({ tenant, report }, null, 2));
    console.log(JSON.stringify({ reportId: report.id, name: report.name, analyses: report.analysisSnapshots.length, sections: report.sections.length }));
  } finally { await api("session", "DELETE", undefined, root.token); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
