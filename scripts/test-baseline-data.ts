import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { baselineHealthIssue, baselineModalUsable, baselineRecordCanonical, baselineValues } from "../packages/ui/src/baseline-data";
import { healthBaselineRevision, healthTrendDataset } from "../packages/ui/src/health-trend-data";
import { modalBaselineRevision, modalResult } from "../packages/ui/src/modal-data";
const tests: { name: string; result: string }[] = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
  const full = { id: "baseline", name: "健康基线", object: "叶片", rms: 1, frequency: .6, modal: .61, score: 80, confidence: .8, recordTenant: "qa" };
  await check("名称对象与数值校验，空指标不填默认值，保护字段不接收", () => {
    const b = baselineValues({ name: " 基线 ", object: " 叶片 ", modal: .6, id: "forged", version: 99, revision: "forged", recordTenant: "other" });
    assert.deepEqual(b, { name: "基线", object: "叶片", modal: .6, source: "manual", status: "active" });
    for (const patch of [{ name: " " }, { object: "x".repeat(201) }, { modal: 0 }, { rms: "1" }, { frequency: NaN }, { score: 101 }, { confidence: -1 }, { source: "measured" }, { status: "x" }, { note: "x".repeat(2001) }]) assert.throws(() => baselineValues({ ...full, ...patch }));
  });
  await check("部分编辑保留原字段，明确清空指标保持缺失，旧来源不被默认写入", () => {
    const b = baselineValues({ modal: .7, rms: null, note: " 登记说明 " }, full); assert.equal(b.modal, .7); assert.equal(b.frequency, .6); assert.equal(b.rms, undefined); assert.equal(b.source, undefined); assert.equal(b.note, "登记说明");
    assert.equal(full.rms, 1); assert.equal(baselineValues({ name: "空记录", object: "叶片" }).modal, undefined);
  });
  await check("健康面板与模态基准分别判断用途，停用不可选且边界零分合法", () => {
    const partial = { name: "模态基线", object: "叶片", modal: .6 }; assert.equal(baselineModalUsable(partial), true); assert.ok(baselineHealthIssue(partial));
    assert.equal(baselineHealthIssue({ ...full, score: 0, confidence: 0 }), ""); assert.ok(baselineHealthIssue({ ...full, status: "disabled" })); assert.equal(baselineModalUsable({ ...full, status: "disabled" }), false);
  });
  await check("登记版本/来源/停用状态进入分析修订，读取权限元信息不影响登记修订", async () => {
    assert.equal(baselineRecordCanonical(full), baselineRecordCanonical({ ...full, ownerId: "other", updatedAt: "later", revision: "server" }));
    for (const patch of [{ version: 2 }, { source: "demo" }, { status: "disabled" }, { note: "来源说明" }]) { assert.notEqual(await healthBaselineRevision(full), await healthBaselineRevision({ ...full, ...patch })); assert.notEqual(await modalBaselineRevision(full), await modalBaselineRevision({ ...full, ...patch })); }
  });
  await check("新趋势/模态拒绝停用基线，演示登记的历史来源不伪装实测", () => {
    const task = { id: "task", name: "任务", object: "叶片", recordTenant: "qa" }, config = { test: "free", method: "峰值拾取", damping: "半功率带宽", points: ["P1"], activeOrder: 1, baselineId: full.id };
    assert.throws(() => healthTrendDataset(task, { ...full, status: "disabled" }, { id: null, tenant: "qa", status: "missing", revision: "missing", values: null }, "2024-01-01"));
    assert.throws(() => modalResult(task, config, { ...full, status: "disabled" }));
    const result = modalResult(task, config, { ...full, source: "demo", note: "手工样例", version: 2 }); assert.equal(result.dataset.metadata.baseline.demo, true); assert.equal(result.dataset.metadata.baseline.version, 2); assert.equal(result.dataset.metadata.baseline.registrationNote, "手工样例");
  });
  mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/baseline-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
