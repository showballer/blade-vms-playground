import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { generateRotationSegments, rotationCanonical, rotationCutDataset, rotationCutRecord, rotationParameters, rotationRevision, rotationOrderDataset, rotationWorkflow } from "../packages/ui/src/rotation-data";
import { datasetFile } from "../packages/ui/src/result-data";
import { spectrumOption } from "../packages/ui/src/charts";
import { reportContent } from "../packages/ui/src/report-data";
const task = { id: "qa", name: "原始叶片", object: "叶片", turbine: "QA", point: "P1", sampleRate: 4, duration: 99, rpm: 60, blades: 2, source: "import", samples: [1, -2, 3, -4, 5, -6, 7, -8, 9, -10, 11], channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
const config = { rpm: 60, blades: 2, source: "手动", mode: "period", start: 0, end: 2.75 }, tests: { name: string; result: string }[] = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
await check("恒定手动转速生成实际采样边界，尾段不冒充完整周期", () => {
  const plan = generateRotationSegments(task, config); assert.equal(plan.segments.length, 6); assert.deepEqual(plan.segments.map(s => [s.startIndex, s.endIndex]), [[0,2],[2,4],[4,6],[6,8],[8,10],[10,11]]); assert.equal(plan.segments[5].partial, true); assert.ok(plan.segments.every(s => s.quality === "未评价"));
});
await check("非整数每周期点数无重复无遗漏，手动范围严格按原采样时刻取点", () => {
  const source = { ...task, sampleRate: 10, samples: Array.from({ length: 10 }, (_, i) => i) };
  const plan = generateRotationSegments(source, { ...config, blades: 3, end: 1 }); assert.deepEqual(plan.segments.map(s => [s.startIndex,s.endIndex]), [[0,4],[4,7],[7,10]]);
  const manual = generateRotationSegments(source, { ...config, mode: "manual", start: .11, end: .51 }); assert.equal(manual.segments[0].startIndex, 2); assert.equal(manual.segments[0].endIndex, 6);
});
await check("零转速手动可截取、周期拒绝；非法参数/无波形/过量分段均拒绝", () => {
  assert.equal(generateRotationSegments(task, { ...config, rpm: 0, mode: "manual" }).segments.length, 1);
  for (const patch of [{ rpm: 0 }, { blades: 1.5 }, { source: "键相（未接入）" }, { mode: "stable" }, { end: 99 }, { start: -1 }, { end: 0 }, { rpm: NaN }]) assert.throws(() => generateRotationSegments(task, { ...config, ...patch }));
  assert.throws(() => generateRotationSegments({ ...task, samples: [] }, config));
  assert.throws(() => generateRotationSegments({ ...task, sampleRate: 1000, samples: Array(1000).fill(1) }, { ...config, rpm: 30000, blades: 1, end: 1 }));
});
const revision = await rotationRevision(task), plan = generateRotationSegments(task, config);
const chosen = plan.segments.map((s, i) => ({ ...s, keep: i === 0 || i === 2, quality: i === 1 ? "异常" : "有效", note: i === 1 ? "人工排除冲击" : "" }));
const dataset = rotationCutDataset(task, config, chosen, revision);
await check("保留段选择实际生效，非连续区间保持绝对时间、原索引、排除原因", () => {
  assert.deepEqual(dataset.rows, [[1,0,0,1],[1,1,.25,-2],[3,4,1,5],[3,5,1.25,-6]]); assert.equal(dataset.metadata.excludedSamples, 7); assert.equal(dataset.metadata.excludedRanges[0].note, "人工排除冲击"); assert.equal(dataset.metadata.demo, false); assert.equal(task.samples.length, 11);
  assert.throws(() => rotationCutDataset(task, config, chosen.map(s => ({ ...s, keep: false })), revision));
  assert.throws(() => rotationCutDataset(task, config, [{ ...chosen[0], endIndex: 99 }, ...chosen.slice(1)], revision));
});
await check("输入修订使用 SHA256，元数据/采样变化可检测，服务端派生结果忽略伪造矩阵", async () => {
  assert.equal(revision, createHash("sha256").update(rotationCanonical(task)).digest("hex")); assert.notEqual(revision, await rotationRevision({ ...task, samples: [99, ...task.samples.slice(1)] }));
  const result = rotationCutRecord(task, { name: "结果", taskId: task.id, type: "cut", source: "demo", parameters: { workflow: rotationWorkflow, sourceRevision: revision, config, segments: chosen }, result: { dataset: { rows: [[999]] } } });
  assert.deepEqual(result.result.dataset.rows, dataset.rows); assert.equal(result.source, "import");
  const mutable = structuredClone(task), frozen = rotationCutDataset(mutable, config, chosen, revision); mutable.channels[0].unit = "changed"; mutable.samples[0] = 99; assert.equal(frozen.metadata.task.channels[0].unit, "mm/s"); assert.equal(frozen.rows[0][3], 1);
});
await check("五格式导出使用同一四列数值与完整段元信息", async () => {
  mkdirSync("artifacts/rotation-data", { recursive: true });
  for (const format of ["csv","txt","xlsx","mat","json"]) { const file = await datasetFile(dataset, format); writeFileSync("artifacts/rotation-data/cut." + format, file.bytes); assert.ok(file.bytes.length > 100); }
  assert.equal(dataset.columns[3].unit, "mm/s");
});
await check("阶次导出等于原型四根柱高，Z 改变频率关系而不声称重算幅值", () => {
  const order = rotationOrderDataset(task, { rpm: 120, blades: 4, source: "手动" }, spectrumOption(true)); assert.deepEqual(order.rows, [["1×",1,2,1.8],["fb",4,8,1.25],["2×",2,4,.8],["3×",3,6,.5]]); assert.equal(order.metadata.demo, true); assert.throws(() => rotationParameters({ rpm: 1, blades: 0, source: "手动" }));
});
await check("报告包含分段摘要与导出引用，不把逐点矩阵/大量段备注塞入单元格", () => {
  const record = rotationCutRecord(task, { name: "截取", taskId: task.id, parameters: { workflow: rotationWorkflow, sourceRevision: revision, config, segments: chosen } });
  const content = reportContent({ taskId: task.id, sections: ["降噪与截取"] }, task, [{ ...record, id: "cut-result" }]); assert.equal(content[0].rows?.length, 1); assert.match(content[0].rows![0][2], /cut-result/); assert.ok(JSON.stringify(content).length < 1600);
});
writeFileSync("artifacts/rotation-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
