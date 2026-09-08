import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { datasetFile, datasetMat, datasetText, recordDataset, validateDataset, type ResultDataset } from "../packages/ui/src/result-data";
import { signalDataset } from "../packages/ui/src/signal-data";
import { heatOption, lineOption, spectrumOption } from "../packages/ui/src/charts";
import { reportContent } from "../packages/ui/src/report-data";
const tests: { name: string; result: string }[] = [];
async function check(name: string, run: () => unknown) { await run(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
const task = { id: "qa-result-task", name: "叶片原始波形", source: "import", sampleRate: 4, samples: [2, -4, 6, -8], channels: [{ no: 2, type: "velocity", unit: "mm/s" }], environment: "温度 25℃", testTime: "2026-09-07T10:00:00Z" };
const raw = recordDataset("tasks", task);
const features = signalDataset("feat", {}, task, "速度", { nfft: 4096 });
const artifact = "artifacts/result-data"; mkdirSync(artifact, { recursive: true });
async function main() {
await check("原始波形保留精确时间、负数、中文元信息与单位，不改源任务", () => {
  assert.deepEqual(raw.rows, [[0, 2], [0.25, -4], [0.5, 6], [0.75, -8]]);
  assert.equal(raw.columns[1].unit, "mm/s"); assert.equal(raw.metadata.task.raw_preserved, true); assert.equal(raw.metadata.task.samples, undefined);
  assert.equal(task.samples[1], -4);
});
await check("CSV/TXT 保留数值负号，防止文本公式执行，元信息先于数值表", () => {
  const dataset: ResultDataset = { ...raw, columns: [{ key: "value", label: "值", type: "number", unit: "" }, { key: "text", label: "文本", type: "string", unit: "" }], rows: [[-4, "  =1+1"], [2, "引号\"逗号,换行\n值"]] };
  for (const delimiter of [",", "\t"] as const) {
    const text = datasetText(dataset, delimiter); assert.ok(text.startsWith("\uFEFF")); assert.ok(text.includes('"-4"')); assert.ok(!text.includes('"\'-4"'));
    assert.ok(text.includes('"\'  =1+1"')); assert.ok(text.includes('引号""逗号,换行\n值')); assert.ok(text.includes("metadata_json"));
  }
});
await check("结果缺失/NaN/列不齐/类型不符/超限明确拒绝，不回退假数据", () => {
  for (const rows of [[], [[NaN, 1]], [[1]], [["1", 2]], Array.from({ length: 20001 }, () => [1, 2])]) assert.throws(() => validateDataset({ ...raw, rows }));
  assert.throws(() => recordDataset("analyses", { name: "旧 FFT", result: { note: "仅配置" } }), /没有结果矩阵/);
  assert.throws(() => recordDataset("tasks", { ...task, samples: [] }));
});
await check("FFT 与时频导出使用图中频率/时间/幅值，热图索引转换为轴值", () => {
  const fftOption = spectrumOption(); const fft = signalDataset("fft", fftOption, task, "速度", { nfft: 4096 });
  assert.equal(fft.rows.length, 100); assert.deepEqual(fft.rows[12], [0.6, 1.8]); assert.equal(fft.metadata.demo, true);
  const heat = heatOption(), tf = signalDataset("tf", heat, task, "速度", {});
  assert.equal(tf.rows.length, 640); assert.deepEqual(tf.rows[41], [0.1, 50, heat.series[0].data[41][2]]);
  assert.equal(tf.columns[1].unit, "Hz"); assert.equal(tf.columns[2].unit, "归一化");
});
await check("时域真实数据不因通道选择重新缩放；滤波、平均保留图中两列", () => {
  const option = lineOption([{ name: "原始", data: task.samples }], ["0", ".25", ".5", ".75"]);
  const time = signalDataset("time", option, task, "加速度", {}); assert.deepEqual(time.rows, raw.rows); assert.equal(time.columns[1].unit, "mm/s"); assert.equal(time.metadata.demo, false);
  const pair = lineOption([{ name: "前", data: [1, -2] }, { name: "后", data: [3, -4] }]);
  for (const tab of ["filter", "avg"]) assert.deepEqual(signalDataset(tab, pair, task, "速度", {}).rows, [[0, 1, 3], [0.01, -2, -4]]);
  assert.deepEqual(signalDataset("env", lineOption([{ name: "包络", data: [1, 2] }]), task, "速度", {}).rows, [[0, 1], [0.01, 2]]);
});
await check("频带百分比与特征类型/单位逐项保留，不再导出通用波形", () => {
  const band = signalDataset("band", { xAxis: { data: ["低\n0–10Hz", "中", "高"] }, series: [{ data: [{ value: 42 }, { value: 38 }, { value: 20 }] }] }, task, "速度", {});
  assert.deepEqual(band.rows, [["低 0–10Hz", 42], ["中", 38], ["高", 20]]); assert.equal(band.columns[1].unit, "%");
  assert.equal(features.rows.length, 8); assert.deepEqual(features.rows[5], ["主频", .6, "Hz"]); assert.deepEqual(features.rows[7], ["信噪比", 28, "dB"]);
});
await check("新分析与旧批处理均可读，历史参数和输入不从当前任务重建", () => {
  const analysis = { id: "qa-analysis", name: features.title, parameters: { nfft: 4096 }, result: { note: features.metadata.note, dataset: structuredClone(features) } };
  const exported = recordDataset("analyses", analysis); assert.deepEqual(exported.rows, features.rows); assert.equal(exported.metadata.analysis.id, analysis.id);
  assert.equal(exported.metadata.analysis.result.dataset, undefined);
  const legacy = recordDataset("analyses", { name: "截取", parameters: { inputMetadata: { ...task, samples: undefined } }, result: { columns: ["时间(s)", "幅值(mm/s)"], rows: [[.25, -4]] } });
  assert.equal(legacy.columns[1].unit, "mm/s"); assert.equal(legacy.metadata.inputMetadataAvailable, true);
});
await check("Excel 数值类型与超长 Unicode 元信息可无损还原，不使用公式单元格", async () => {
  const dataset = structuredClone(features); dataset.metadata.longNote = "叶片😀".repeat(9000); dataset.rows[0][0] = "=HYPERLINK(\"bad\")";
  const output = await datasetFile(dataset, "xlsx"), book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(output.bytes));
  const sheet = book.getWorksheet("结果数据")!; assert.equal(sheet.rowCount, 9); assert.equal(sheet.getCell("B2").value, 1.21); assert.equal(sheet.getCell("A2").type, ExcelJS.ValueType.String);
  const metadataSheet = book.getWorksheet("元信息")!; let metadata = "";
  metadataSheet.eachRow((row) => { if (row.getCell(1).value === "metadata_json") { assert.ok(String(row.getCell(3).value).length <= 15000); metadata += row.getCell(3).value; } });
  assert.equal(JSON.parse(metadata).metadata.longNote, dataset.metadata.longNote);
  writeFileSync(`${artifact}/features.xlsx`, output.bytes);
});
await check("MAT 数值矩阵及文本标签分离，元信息注明列索引", () => {
  const bytes = datasetMat(features), view = new DataView(bytes.buffer); let offset = 0; const matrices: Record<string, { rows: number; columns: number; values: number[] }> = {};
  while (offset < bytes.length) {
    const rows = view.getInt32(offset + 4, true), columns = view.getInt32(offset + 8, true), size = view.getInt32(offset + 16, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 20, offset + 20 + size - 1)); const start = offset + 20 + size;
    matrices[name] = { rows, columns, values: Array.from({ length: rows * columns }, (_, i) => view.getFloat64(start + 8 * i, true)) }; offset = start + rows * columns * 8;
  }
  assert.equal(matrices.values.rows, 8); assert.equal(matrices.values.columns, 1); assert.deepEqual(matrices.numeric_column_indices.values, [1]);
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(matrices.metadata_json_utf8.values)));
  assert.deepEqual(metadata.textColumns[0].values, features.rows.map((row) => row[0])); assert.equal(metadata.textColumns[1].values[5], "Hz");
  writeFileSync(`${artifact}/features.mat`, bytes); writeFileSync(`${artifact}/raw.mat`, datasetMat(raw));
});
await check("报告对新标签矩阵使用摘要，不把完整数值表塞入单元格", () => {
  const report = reportContent({ taskId: task.id, sections: ["FFT 频谱"] }, task, [{ id: "fft-result", taskId: task.id, name: "FFT", type: "fft", result: { note: "演示", dataset: { ...features, rows: Array(20000).fill(features.rows[0]) } } }]);
  assert.ok(JSON.stringify(report).length < 1500); assert.match(report[0].rows![0][2], /20000 行/);
});
for (const format of ["csv", "txt", "json"]) writeFileSync(`${artifact}/raw.${format}`, (await datasetFile(raw, format)).bytes);
writeFileSync(`${artifact}/results.json`, JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
