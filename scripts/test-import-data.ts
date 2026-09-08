import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { advanceImport, createImportJob, csvImportRecord, decodeImportFile, importView, normalizeImportRequest, normalizeImportTask } from "../packages/ui/src/import-data";
import { datasetText, recordDataset } from "../packages/ui/src/result-data";
import adapter from "../apps/desktop/electron/imports.cjs";
const tests: { name: string; result: string }[] = [];
const input = { id: "do-not-overwrite", name: "叶片导入", object: "叶片 A", turbine: "A01", point: "叶尖", rpm: 12, blades: 3, sampleRate: 4, duration: 99, samples: [2, -4, 6, -8], source: "device", ownerId: "someone", syncOrigin: { taskId: "forged" }, importOrigin: { batchId: "forged" }, channels: [{ no: 2, type: "velocity", unit: "mm/s" }], environment: "风速 8 m/s" };
const request = { id: "qa-import", filename: "混合任务.JSON", records: [input, { ...input, name: "坏波形", samples: [1, null] }, null, { ...input, name: "另一任务", source: "demo" }] };
async function check(name: string, run: () => unknown) { await run(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
await check("导入只保留业务字段，重新分配来源身份并按点数校正时长", () => {
  const { task, warnings } = normalizeImportTask(input);
  for (const key of ["id", "ownerId", "syncOrigin", "importOrigin"]) assert.equal(task[key], undefined);
  assert.equal(task.source, "import"); assert.equal(task.duration, 1); assert.equal(task.raw_preserved, true); assert.match(warnings[0], /校正/);
  assert.equal(input.duration, 99); assert.deepEqual(task.channels, input.channels); assert.equal(task.environment, input.environment);
  assert.equal(normalizeImportTask({ ...input, source: "demo" }).task.source, "demo");
});
await check("逐条验证保留有效和非法条目，不因中间坏记录丢失后续项", () => {
  const job = createImportJob(normalizeImportRequest(request)), view = importView(job);
  assert.deepEqual(job.items.map(item=>item.state), ["pending", "invalid", "invalid", "pending"]);
  assert.equal(view.pending, 2); assert.equal(view.invalid, 2); assert.equal(view.completed, 0);
  assert.equal((view.items[0] as any).task, undefined); assert.equal((view.items[0] as any).input, undefined); assert.equal(view.items[0].sampleCount, 4);
  assert.equal(job.items[1].input !== request.records[1], true);
});
await check("无效批次、超限任务、非法元信息和结果数据集不被当成任务", () => {
  for (const records of [[], Array(51).fill(input), ["x".repeat(1500001)]]) assert.throws(()=>normalizeImportRequest({ ...request, records }));
  for (const value of [{ ...input, blades: 0 }, { ...input, sampleRate: "4" }, { ...input, duration: -1 }, { ...input, channels: [{ no: 1, type: "velocity", unit: "" }] }, { ...input, name: "" }, { ...input, result: {} }, { ...input, samples: Array(20001).fill(1) }]) assert.throws(()=>normalizeImportTask(value));
});
await check("JSON BOM/大写扩展名可解析，空数组和损坏 JSON 有明确说明", () => {
  const file = decodeImportFile("\uFEFF" + JSON.stringify(request.records), "FILE.JSON"); assert.equal(file.format, "json");
  for (const text of ["[]", "[{", ""]) assert.throws(()=>decodeImportFile(text, "a.json"));
  assert.throws(()=>decodeImportFile("1,2", "file.exe"));
});
await check("CSV 引号、表头和负数可解析；不吞掉首条坏值或缺失列", () => {
  const file = decodeImportFile('"time","value"\r\n"0","2"\r\n"0.25","-4"', "a.csv"); assert.equal(file.format, "csv");
  if (file.format !== "csv") throw Error(); assert.deepEqual(file.samples, [2, -4]); assert.deepEqual(file.times, [0, .25]);
  for (const text of ["0,\n.25,1", "0,bad\n.25,1", "time,value\n0,1\n.25", '"unclosed', "a,b,c\n1,2,3"]) assert.throws(()=>decodeImportFile(text, "a.csv"));
});
await check("CSV 时间列必须从零开始且匹配确认采样率，不静默丢弃时间", () => {
  const file = decodeImportFile("time,value\n0,2\n.25,-4", "a.csv"); if (file.format !== "csv") throw Error();
  assert.equal(csvImportRecord(file, input).duration, .5);
  assert.throws(()=>csvImportRecord(file, { ...input, sampleRate: 100 }), /采样率一致/);
  assert.throws(()=>csvImportRecord({ ...file, times: [.25, .5] }, input), /从 0 开始/);
});
await check("本系统原始波形 CSV 可读回完整元信息，FFT 数值 CSV 不冒充波形", () => {
  const raw = recordDataset("tasks", input), file = decodeImportFile(datasetText(raw, ","), "raw.csv"); if (file.format !== "csv") throw Error();
  assert.deepEqual(file.samples, input.samples); assert.equal(file.metadata.environment, input.environment); assert.deepEqual(file.metadata.channels, input.channels);
  const fft = { ...raw, columns: raw.columns.map((column, i) => i === 0 ? { ...column, key: "frequency", unit: "Hz" } : column) };
  assert.throws(()=>decodeImportFile(datasetText(fft, ","), "fft.csv"), /不是任务原始波形/);
});
await check("单项完成为不可变转换，重复调用不再返回新任务，非法条目不能执行", () => {
  const job = createImportJob(normalizeImportRequest(request)), next = advanceImport(job, 0, "new-task");
  assert.equal(job.items[0].state, "pending"); assert.equal(next.job.items[0].taskId, "new-task"); assert.equal(next.task?.importOrigin.batchId, job.id);
  assert.equal(advanceImport(next.job, 0, "duplicate").replayed, true); assert.equal(advanceImport(next.job, 0, "duplicate").task, null);
  for (const index of [1, -1, 100, .5]) assert.throws(()=>advanceImport(job, index, "bad-task"));
});
let workspace: any = { tasks: [{ id: input.id, name: "原任务", samples: [88] }], analyses: [] };
const call = (path: string, method = "GET", body?: unknown) => adapter.offlineImportRequest(workspace, { path, method, body }, (next: any) => { workspace = next; });
await check("本机导入登记与同标识重试幂等，完整状态无法通过创建请求伪造", () => {
  assert.equal(call("imports", "POST", { ...request, items: [{ state: "completed" }] }).status, 201); assert.equal(workspace.tasks.length, 1);
  assert.equal(call("imports", "POST", request).status, 200); assert.equal(workspace.imports.length, 1);
  assert.equal(call("imports", "POST", { ...request, filename: "changed.json" }).status, 409);
});
await check("本机提交和丢失确认重试不覆盖原任务，不重复创建成功条目", () => {
  assert.equal(call("imports/qa-import/item", "POST", { index: 0 }).status, 200);
  const result = call("imports/qa-import/item", "POST", { index: 0 }); assert.equal(result.data.replayed, true); assert.equal(workspace.tasks.length, 2);
  assert.deepEqual(workspace.tasks.find((task: any)=>task.id===input.id).samples, [88]); assert.equal(call("imports/qa-import/item", "POST", { index: 1 }).status, 400);
  assert.equal(call("imports/qa-import/pending").data.length, 3);
});
await check("磁盘失败不会改变内存、产生孤立任务或标记成功；修复后可继续", () => {
  const before = JSON.stringify(workspace);
  assert.throws(()=>adapter.offlineImportRequest(workspace, { path: "imports/qa-import/item", method: "POST", body: { index: 3 } }, ()=>{ throw Error("disk full"); }), /disk full/);
  assert.equal(JSON.stringify(workspace), before);
  assert.equal(call("imports/qa-import/item", "POST", { index: 3 }).data.completed, 2);
  assert.equal(call("imports/qa-import/pending").data.length, 2);
});
await check("已删除的导入任务不会被重试静默重建，路径层级和方法受限", () => {
  const id = workspace.imports[0].items[0].taskId; workspace.tasks = workspace.tasks.filter((task: any)=>task.id!==id);
  assert.equal(call("imports/qa-import/item", "POST", { index: 0 }).status, 409);
  for (const [path, method] of [["imports/qa-import", "PUT"], ["imports/qa-import/item/extra", "POST"], ["imports", "DELETE"]]) assert.equal(call(path, method, {}).status, 405);
});
mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/import-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
