import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { signalChoices, signalInput, signalRevision, signalRecord, signalWaveDataset, signalWaveOption, signalWorkflow, validateSignalTimeFrequencyParameters } from "../packages/ui/src/signal-input";
import { generateRotationSegments, rotationCutDataset, rotationRevision } from "../packages/ui/src/rotation-data";
import { datasetFile } from "../packages/ui/src/result-data";
const task = { id: "signal-qa", name: "QA 信号", object: "叶片", turbine: "QA", point: "P1", sampleRate: 4, duration: 2, rpm: 60, blades: 2, source: "import", samples: [1, -2, 3, -4, 5, -6, 7, -8], channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
const tests: { name: string; result: string }[] = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
  const config = { rpm: 60, blades: 2, source: "手动", mode: "period", start: 0, end: 2 };
  const segments = generateRotationSegments(task, config).segments.map((s, i) => ({ ...s, keep: i !== 1 }));
  const cut = { id: "cut-qa", taskId: task.id, type: "cut", name: "历史截取", result: { dataset: rotationCutDataset(task, config, segments, await rotationRevision(task)) } };
  const segment = signalInput({ kind: "analyses", id: cut.id, segmentId: "4:6" }, cut);
  await check("已保存段单独选择，保留源索引、原时间、单位和人工标注", () => {
    assert.deepEqual(segment.rows, [[4,1,5],[5,1.25,-6]]); assert.equal(segment.unit, "mm/s");
    const choices = signalChoices([task], [cut]); assert.equal(choices.length, 4); assert.ok(!choices.some(c => c.ref.segmentId === "2:4"));
    assert.throws(() => signalInput({ kind: "analyses", id: cut.id, segmentId: "2:4" }, cut));
    assert.throws(() => signalInput({ kind: "analyses", id: cut.id, segmentId: "4:6" }, { ...cut, result: { dataset: { ...cut.result.dataset, rows: [] } } }));
  });
  const raw = signalInput({ kind: "tasks", id: task.id }, task);
  const other = { ...task, id: "signal-qa-2", point: "P2", sampleRate: 2, samples: [10,20,30] };
  const second = signalInput({ kind: "tasks", id: other.id }, other);
  await check("不同采样率按各自时间绘制，不按序号误对齐也不插值补点", () => {
    const data = signalWaveDataset([segment, second], "source", true), chart = signalWaveOption(data);
    assert.deepEqual(chart.series[0].data, [[1,5],[1.25,-6]]); assert.deepEqual(chart.series[1].data, [[0,10],[.5,20],[1,30]]);
    assert.equal(chart.xAxis.type, "value"); assert.equal(data.rows.length, 5); assert.deepEqual(data.rows[2], [2,0,0,0,10]);
  });
  await check("起点归零仅改变显示时间，源时间与源索引同时保留用于导出", () => {
    const data = signalWaveDataset([segment, second], "relative", true);
    assert.deepEqual(data.rows[0], [1,4,1,0,5]); assert.deepEqual(data.rows[1], [1,5,1.25,.25,-6]); assert.match(data.metadata.note, /不代表同一采集时刻/);
    assert.deepEqual(signalWaveOption(data).series[0].data, [[0,5],[.25,-6]]);
  });
  await check("空波形、不同单位/对象、重复/单个/过多输入及超量点数明确拒绝", () => {
    assert.throws(() => signalInput(raw.ref, { ...task, samples: [] }));
    for (const inputs of [[], [raw], [raw,raw], [raw,{ ...second, unit: "mm" }], [raw,{ ...second, task: { ...second.task, object: "其他" } }], [raw,{ ...second, rows: Array(20000).fill([0,0,1]) }]]) assert.throws(() => signalWaveDataset(inputs, "source", true));
    assert.throws(() => signalWaveDataset([raw,second], "auto-sync", true));
    assert.equal(signalChoices([{ ...task, samples: undefined }], [])[0].input, undefined);
  });
  await check("修订覆盖矩阵与元信息，历史分段不受当前任务变化影响", async () => {
    assert.equal(await signalRevision(segment), createHash("sha256").update(segment.canonical).digest("hex"));
    const changed = { ...task, samples: Array(8).fill(99), sampleRate: 8 };
    assert.notEqual(await signalRevision(raw), await signalRevision(signalInput(raw.ref, changed)));
    const selected = signalChoices([changed], [cut]).find(c => c.ref.segmentId === "4:6")!.input!;
    assert.deepEqual(selected.rows, segment.rows); assert.equal(selected.task.sampleRate, 4);
  });
  const refs = await Promise.all([segment,second].map(async input => ({ ...input.ref, revision: await signalRevision(input) })));
  const request = { name: "对比", taskId: task.id, type: "time", source: "demo", parameters: { workflow: signalWorkflow, inputs: refs, compare: true, alignment: "relative" }, result: { dataset: { rows: [[999]] } } };
  const saved = signalRecord(request, [segment,second]);
  await check("保存派生原始矩阵而不接受伪造幅值/来源，快照不可变", () => {
    assert.deepEqual(saved.result.dataset.rows[0], [1,4,1,0,5]); assert.equal(saved.source, "import");
    assert.throws(() => signalRecord({ ...request, taskId: "wrong" }, [segment,second]));
    assert.throws(() => signalRecord({ ...request, parameters: { ...request.parameters, inputs: refs.map(r => ({ ...r, revision: "bad" })) } }, [segment,second]));
    const mutable = structuredClone(task), input = signalInput(raw.ref, mutable); mutable.channels[0].unit = "changed"; assert.equal(input.unit, "mm/s"); assert.equal(input.task.channels[0].unit, "mm/s");
  });
  await check("演示标签强制标记未计算，输入来源随配置保存而非冒充分析结果", async () => {
    const base = signalWaveDataset([raw], "source");
    const record = signalRecord({ ...request, type: "fft", parameters: { ...request.parameters, compare: false, inputs: [{ ...raw.ref, revision: await signalRevision(raw) }] }, result: { dataset: base } }, [raw]);
    assert.equal(record.source, "demo"); assert.equal(record.result.dataset.metadata.demo, true); assert.equal(record.result.dataset.metadata.inputs[0].source, "import"); assert.match(record.result.note, /未根据/);
    assert.throws(() => signalRecord({ ...request, type: "fft" }, [segment,second]));
  });
  await check("STFT 窗长和百分比重叠率拒绝无效值，保留旧记录缺失参数", () => {
    for (const overlapPercent of [-1,100,Infinity,NaN,"50",null]) assert.throws(() => validateSignalTimeFrequencyParameters({ windowLength: 1024, overlapPercent }));
    for (const windowLength of [0,15,16.5,65537,"1024",null]) assert.throws(() => validateSignalTimeFrequencyParameters({ windowLength, overlapPercent: 50 }));
    for (const overlapPercent of [0,50,75,99.9]) validateSignalTimeFrequencyParameters({ windowLength: 1024, overlapPercent });
    validateSignalTimeFrequencyParameters({});
  });
  await check("STFT 保存及导出冻结重叠率，不补算矩阵或回填历史默认值", async () => {
    const p = { workflow: signalWorkflow, inputs: [{ ...raw.ref, revision: await signalRevision(raw) }], compare: false, alignment: "source", windowLength: 1024, overlapPercent: 75 };
    const req = { name: "时频演示", taskId: task.id, type: "tf", parameters: p, result: { dataset: signalWaveDataset([raw], "source") } };
    const record = signalRecord(req, [raw]); p.overlapPercent = 25;
    assert.equal(record.parameters.overlapPercent, 75); assert.equal(record.result.dataset.metadata.parameters.overlapPercent, 75);
    const file = await datasetFile(record.result.dataset, "json");
    assert.equal(JSON.parse(new TextDecoder().decode(file.bytes)).metadata.parameters.overlapPercent, 75);
    assert.throws(() => signalRecord({ ...req, parameters: { ...p, overlapPercent: 100 } }, [raw]));
    const { overlapPercent, ...legacyParameters } = p;
    assert.equal(signalRecord({ ...req, parameters: legacyParameters }, [raw]).parameters.overlapPercent, undefined);
  });
  await check("五格式导出完整长表和每项来源，没有用空值填齐不同长度", async () => {
    mkdirSync("artifacts/signal-data", { recursive: true });
    for (const format of ["csv","txt","xlsx","mat","json"]) writeFileSync("artifacts/signal-data/core-compare." + format, (await datasetFile(saved.result.dataset, format)).bytes);
    assert.equal(saved.result.dataset.rows.length, 5); assert.equal(saved.result.dataset.metadata.inputs.length, 2);
  });
  writeFileSync("artifacts/signal-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
