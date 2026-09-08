import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { addTrendAnnotation, healthBaselineRevision, healthTrendColumns, healthTrendDataset, healthTrendRecord, trendStartDate, withdrawTrendAnnotation } from "../packages/ui/src/health-trend-data";
import { datasetFile, recordDataset } from "../packages/ui/src/result-data";
import { reportContent } from "../packages/ui/src/report-data";
const task = { id: "qa-trend", name: "原始波形", object: "叶片", recordTenant: "qa", sampleRate: 4, samples: [1,-2,3,-4], source: "import", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
const baseline = { id: "baseline", name: "基线", object: "叶片", recordTenant: "qa", rms: 1, frequency: .6, modal: .61 };
const config = { id: null, tenant: "qa", revision: "missing", status: "missing" as const, values: null }, actor = { id: "reviewer", name: "分析员" }, time = "2026-09-08T01:00:00.000Z";
const input = { startDate: "2024-02-01", sourceRevision: "a".repeat(64), baselineRevision: "b".repeat(64), configRevision: "missing" };
const annotation = { id: "a1", target: "trend", series: "frequency", startIndex: 2, endIndex: 4, label: "异常", note: "  人工频率标记  " };
const tests: { name: string; result: string }[] = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
  mkdirSync("artifacts/health-trend-data", { recursive: true });
  await check("日期边界、闰年与跨月正确，非法或过界日期拒绝", () => {
    for (const date of ["1900-01-01", "2024-02-29", "2099-12-02"]) assert.equal(trendStartDate(date).date, date);
    for (const date of ["1900-02-29", "2023-02-29", "2024-04-31", "2024-2-01", "2099-12-03", null, ""]) assert.throws(() => trendStartDate(date));
    const data = healthTrendDataset(task, baseline, config, input.startDate); assert.equal(data.rows[28][1], "2024-02-29"); assert.equal(data.rows[29][1], "2024-03-01");
  });
  await check("固定演示曲线与百分比单位，组/对象/坏基线/坏配置校验", () => {
    const data = healthTrendDataset(task, baseline, config, input.startDate); assert.equal(data.rows[29][2], Number((29 * .85 + Math.sin(29 * .7) * 2).toFixed(8))); assert.ok(data.metadata.demo); assert.equal(data.columns[2].unit, "%");
    for (const patch of [{ object: "other" }, { recordTenant: "other" }, { rms: 0 }, { modal: NaN }]) assert.throws(() => healthTrendDataset(task, { ...baseline, ...patch }, config, input.startDate));
    assert.throws(() => healthTrendDataset(task, baseline, { ...config, status: "invalid" }, input.startDate));
  });
  const record = { ...healthTrendRecord(task, baseline, config, input, time), id: "archive" };
  await check("八指标归档、分组与旧三指标兼容，按列键读取，缺失曲线不能标记", () => {
    const current = record.result.dataset;
    assert.deepEqual(current.columns.map((c: any) => c.key), ["index", "date", "amplitude", "frequency", "modal", "band", "peak", "peakToPeak", "mainAmplitude", "damping"]);
    assert.equal(healthTrendColumns(current, "overview").length, 4); assert.equal(healthTrendColumns(current, "amplitudes").length, 4); assert.equal(healthTrendColumns(current, "modal").length, 2);
    const legacy = structuredClone(record);
    for (const d of [legacy.result.dataset, legacy.result.datasets.trend]) { d.columns = d.columns.slice(0, 5); d.rows = d.rows.map((r: any[]) => r.slice(0, 5)); delete d.metadata.sampleVersion; }
    assert.deepEqual(healthTrendColumns(legacy.result.dataset).map(c => c.key), ["amplitude", "frequency", "modal"]);
    assert.throws(() => addTrendAnnotation(legacy, { ...annotation, series: "band" }, actor, time));
    assert.equal(addTrendAnnotation(legacy, annotation, actor, time).changed, true);
    const order = [1, 9, 5, 3, 2, 0, 4, 8, 6, 7];
    const reordered = { ...current, columns: order.map(i => current.columns[i]), rows: current.rows.map((r: any[]) => order.map(i => r[i])) };
    const band = healthTrendColumns(reordered).find(c => c.key === "band")!;
    assert.equal(band.columnIndex, 2); assert.deepEqual(reordered.rows.map((r: any[]) => r[band.columnIndex]), current.rows.map((r: any[]) => r[5]));
    assert.equal(recordDataset("analyses", legacy, "trend").columns.length, 5);
  });
  await check("归档冻结构与原波形；无采样点不补造，非法数值拒绝", () => {
    const t = structuredClone(task), b = structuredClone(baseline), c = structuredClone(config);
    const frozen = healthTrendRecord(t, b, c, input, time); t.samples[0] = 100; b.name = "变更"; c.revision = "changed";
    assert.deepEqual(frozen.result.datasets.waveform.rows, [[0,1],[.25,-2],[.5,3],[.75,-4]]); assert.equal(frozen.result.dataset.metadata.baseline.name, "基线"); assert.equal(frozen.result.dataset.metadata.thresholds.revision, "missing");
    assert.equal(healthTrendRecord({ ...task, samples: [] }, baseline, config, input).result.datasets.waveform, undefined);
    assert.throws(() => healthTrendRecord({ ...task, samples: [NaN] }, baseline, config, input));
  });
  await check("基线修订只跟踪领域数据，不受列表权限元信息影响", async () => {
    assert.equal(await healthBaselineRevision(baseline), await healthBaselineRevision({ ...baseline, updatedAt: "later", ownerId: "user" }));
    assert.notEqual(await healthBaselineRevision(baseline), await healthBaselineRevision({ ...baseline, frequency: .7 }));
  });
  let saved = addTrendAnnotation(record, { ...annotation, actor: "伪造", status: "withdrawn", time: "1900" }, actor, time).record;
  await check("人工标记身份/时间可信，重试去重但同 ID 改内容/换人拒绝", () => {
    const a = saved.result.annotations[0]; assert.equal(a.actor, actor.name); assert.equal(a.time, time); assert.equal(a.status, "active"); assert.equal(a.note, "人工频率标记");
    assert.equal(addTrendAnnotation(saved, annotation, actor, "later").changed, false);
    assert.throws(() => addTrendAnnotation(saved, { ...annotation, note: "changed" }, actor, time)); assert.throws(() => addTrendAnnotation(saved, annotation, { ...actor, id: "other" }, time));
  });
  await check("索引、曲线、类别、空说明、缺失波形及 200 条历史上限校验", () => {
    for (const patch of [{ startIndex: -1 }, { startIndex: .5 }, { endIndex: 31 }, { endIndex: 2 }, { series: "x" }, { target: "x" }, { label: "已剔除" }, { note: " " }, { note: "x".repeat(1001) }, { id: "../bad" }]) assert.throws(() => addTrendAnnotation(record, { ...annotation, ...patch }, actor, time));
    const empty = healthTrendRecord({ ...task, samples: [] }, baseline, config, input); assert.throws(() => addTrendAnnotation(empty, { ...annotation, target: "waveform", series: "value" }, actor, time));
    let full = record as Record<string, any>; for (let i = 0; i < 200; i++) full = addTrendAnnotation(full, { ...annotation, id: "mark" + i }, actor, time).record;
    assert.throws(() => addTrendAnnotation(full, { ...annotation, id: "new" }, actor, time));
  });
  await check("波形标记与撤回不改变矩阵，历史不可覆写或复活", () => {
    saved = addTrendAnnotation(saved, { ...annotation, id: "w", target: "waveform", series: "value", startIndex: 1, endIndex: 4 }, actor, time).record;
    assert.throws(() => withdrawTrendAnnotation(saved, "w", " ", actor, time));
    saved = withdrawTrendAnnotation(saved, "w", "人工误选", actor, "2026-09-08T02:00:00.000Z").record;
    assert.equal(saved.result.annotations[1].actor, actor.name); assert.equal(saved.result.annotations[1].time, time); assert.equal(saved.result.annotations[1].withdrawalReason, "人工误选");
    assert.equal(withdrawTrendAnnotation(saved, "w", "人工误选", actor, "later").changed, false);
    assert.throws(() => withdrawTrendAnnotation(saved, "w", "修改历史", actor, time)); assert.throws(() => addTrendAnnotation(saved, { ...annotation, id: "w" }, actor, time));
    assert.deepEqual(saved.result.datasets, record.result.datasets); assert.deepEqual(saved.result.dataset, record.result.dataset);
  });
  await check("趋势/波形五格式包含标记元信息，报告摘要引用冻结记录", async () => {
    for (const key of ["trend", "waveform"]) {
      const data = recordDataset("analyses", saved, key); assert.equal(data.metadata.analysis.result.annotations.length, 2);
      for (const format of ["csv", "txt", "xlsx", "mat", "json"]) { const file = await datasetFile(data, format); writeFileSync(`artifacts/health-trend-data/${key}.${format}`, file.bytes); assert.ok(file.bytes.length > 200); }
    }
    const content = reportContent({ taskId: task.id, sections: ["健康趋势与标记"] }, task, [saved]); const text = JSON.stringify(content); assert.ok(text.includes("1 条有效、1 条已撤回")); assert.ok(text.includes("archive")); assert.ok(text.length < 1000);
  });
  writeFileSync("artifacts/health-trend-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
