import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dampingMethods, modalBaselineCanonical, modalBaselineRevision, modalConfig, modalMethods, modalRecord, modalResult, modalWorkflow } from "../packages/ui/src/modal-data";
import { rotationRevision } from "../packages/ui/src/rotation-data";
import { datasetFile, recordDataset, validateDataset } from "../packages/ui/src/result-data";
import { reportContent } from "../packages/ui/src/report-data";
const task = { id: "qa-modal", name: "原始任务", object: "叶片", recordTenant: "qa", sampleRate: 4, samples: [1,-2,3,-4], environment: "原始环境", source: "import", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
const config = { test: "free", method: "峰值拾取", damping: "半功率带宽", points: ["P1", "P3"], activeOrder: 2, baselineId: "prototype" };
const tests: { name: string; result: string }[] = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
  await check("自由/工作模态方法分别校验，阻尼法与阶次/测点非法值拒绝", () => {
    for (const [test, methods] of Object.entries(modalMethods)) for (const method of methods) for (const damping of dampingMethods) assert.equal(modalConfig({ ...config, test, method, damping }).method, method);
    for (const patch of [{ points: [] }, { points: ["P1", "P1"] }, { points: ["P9"] }, { activeOrder: 0 }, { activeOrder: 1.5 }, { test: "free", method: "SSI" }, { test: "oma", method: "ERA" }, { damping: "unknown" }, { baselineId: "" }]) assert.throws(() => modalConfig({ ...config, ...patch }));
  });
  const result = modalResult(task, config);
  await check("勾选点决定曲线列与三阶节点行，不冒充同步通道数据", () => {
    assert.deepEqual(result.datasets.points.columns.map(c => c.key), ["frequency", "P1", "P3"]);
    assert.deepEqual(result.datasets.points.rows[0], [.2, .4, .3]); assert.equal(result.datasets.shape.rows.length, 6);
    assert.deepEqual(result.datasets.shape.rows.map(row => row[1]), ["P1 叶根", "P3 叶尖", "P1 叶根", "P3 叶尖", "P1 叶根", "P3 叶尖"]);
    assert.ok(result.note.includes("不代表该任务具有三通道")); assert.deepEqual(modalConfig({ ...config, points: ["P3", "P1"] }).points, ["P1", "P3"]);
    assert.equal(modalResult(task, { ...config, points: ["P2"] }).datasets.shape.rows.length, 3);
  });
  await check("参数表/基准对比使用相同固有频率与真实百分比运算", () => {
    assert.deepEqual(result.dataset.rows.map(r => r[1]), [.6, 1.8, 3.5]);
    assert.deepEqual(result.datasets.baseline.rows.map(r => r[2]), [.6, 1.8, 3.5]);
    assert.equal(result.datasets.baseline.rows[0][3], Number(((.6-.61)/.61*100).toFixed(8)));
  });
  const baseline = { id: "baseline", name: "已存基线", object: "叶片", recordTenant: "qa", modal: .62 };
  await check("已存一阶基准不补造其他阶次，跨对象/课题组和缺值拒绝", () => {
    assert.equal(modalResult(task, { ...config, baselineId: baseline.id }, baseline).datasets.baseline.rows.length, 1);
    for (const patch of [{ object: "另一个对象" }, { recordTenant: "other" }, { modal: 0 }, { modal: NaN }, { modal: Number.MIN_VALUE }, { id: "wrong" }]) assert.throws(() => modalResult(task, { ...config, baselineId: baseline.id }, { ...baseline, ...patch }));
    assert.throws(() => modalResult(task, { ...config, baselineId: baseline.id }));
  });
  await check("任务/参数/基准快照独立，不随源对象或其他子结果变动", () => {
    const mutable = structuredClone(task), b = structuredClone(baseline), c = structuredClone(config);
    const frozen = modalResult(mutable, { ...c, baselineId: b.id }, b); mutable.channels[0].unit = "changed"; b.modal = 9; c.points.push("P2");
    assert.equal(frozen.datasets.points.metadata.task.channels[0].unit, "mm/s"); assert.equal(frozen.datasets.baseline.rows[0][1], .62);
    frozen.dataset.metadata.task.environment = "changed"; assert.equal(frozen.datasets.shape.metadata.task.environment, "原始环境");
  });
  const sourceRevision = await rotationRevision(task), baselineRevision = await modalBaselineRevision();
  const record = { ...modalRecord(task, { name: "模态记录", parameters: { workflow: modalWorkflow, config, sourceRevision, baselineRevision }, source: "real", result: { rows: [[999]] } }), id: "qa-result" };
  await check("派生记录忽略伪造矩阵/来源，四类结果导出不互相回退或重复嵌套", async () => {
    assert.equal(record.source, "demo"); assert.equal(record.result.dataset.rows[0][1], .6);
    assert.equal(baselineRevision, createHash("sha256").update(modalBaselineCanonical()).digest("hex"));
    assert.notEqual(await modalBaselineRevision(baseline), await modalBaselineRevision({ ...baseline, modal: .7 }));
    for (const key of Object.keys(result.datasets)) { const dataset = recordDataset("analyses", record, key); validateDataset(dataset); assert.equal(dataset.metadata.analysis.result.datasets, undefined); }
    assert.throws(() => recordDataset("analyses", record, "missing")); assert.throws(() => recordDataset("analyses", record, "__proto__")); assert.throws(() => recordDataset("tasks", task, "shape"));
    assert.throws(() => recordDataset("analyses", { result: { frequencies: [.6] } }, "parameters"));
  });
  await check("四类结果分别生成五格式文件，保留点名、Hz/%与演示边界", async () => {
    mkdirSync("artifacts/modal-data", { recursive: true });
    for (const key of Object.keys(result.datasets)) for (const format of ["csv", "txt", "xlsx", "mat", "json"]) { const file = await datasetFile(recordDataset("analyses", record, key), format); writeFileSync(`artifacts/modal-data/${key}.${format}`, file.bytes); assert.ok(file.bytes.length > 100); }
  });
  await check("报告包含实际保存的三阶频率/阻尼与子结果引用", () => {
    const content = reportContent({ taskId: task.id, sections: ["模态参数"] }, task, [record]);
    assert.ok(JSON.stringify(content).includes("第 2 阶 1.8 Hz / 阻尼比 1.8%")); assert.ok(JSON.stringify(content).includes("qa-result")); assert.ok(JSON.stringify(content).length < 2200);
  });
  writeFileSync("artifacts/modal-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
