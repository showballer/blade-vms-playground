const assert = require("node:assert/strict");
const fs = require("node:fs");
const { advanceBatch, batchView, createBatchJob, defaultBatchConfig, normalizeBatchRequest, setBatchPaused } = require("../apps/desktop/electron/batch.cjs");
const { offlineBatchRequest } = require("../apps/desktop/electron/batches.cjs");
const clone = (value) => structuredClone(value), results = [];
const task = { id: "qa-input", name: "QA 叶片", sampleRate: 4, samples: [2, -4, 6, -8], object: "QA", turbine: "QA-01", point: "P1", rpm: 12, blades: 3, duration: 1, channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
const config = clone(defaultBatchConfig); config.cut.start = 0.25; config.cut.end = 0.75;
const request = { id: "qa-batch", name: "QA 批次", taskIds: [task.id], config };
async function check(name, fn) { await fn(); results.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
  await check("批次拒绝空任务、重复任务、空步骤与非法参数", () => {
    for (const body of [{ ...request, taskIds: [] }, { ...request, taskIds: [task.id, task.id] }, { ...request, config: {} }, { ...request, config: { ...config, cut: { enabled: true, start: 1, end: 0 } } }, { ...request, config: { ...config, fft: { enabled: true, nfft: 1000, window: "Hann" } } }, { ...request, config: { ...config, features: { enabled: true, names: ["RMS", "RMS"] } } }]) assert.throws(() => normalizeBatchRequest(body));
  });
  let job = createBatchJob(normalizeBatchRequest(request), [task]);
  await check("创建时保存独立输入快照，公开视图不返回采样快照或幂等摘要", () => {
    const source = clone(task), created = createBatchJob(normalizeBatchRequest(request), [source]); source.samples[0] = 99;
    assert.equal(created.items[0].input.samples[0], 2);
    const view = batchView({ ...created, requestHash: "private" });
    assert.equal(view.items[0].input, undefined); assert.equal(view.requestHash, undefined); assert.equal(view.items[0].sampleCount, 4);
    assert.equal(view.status, "paused");
  });
  await check("暂停和前置步骤由状态机强制检查，不可跳过", () => {
    assert.throws(() => advanceBatch(job, task.id, "denoise", "id"), /暂停/);
    job = setBatchPaused(job, false);
    assert.throws(() => advanceBatch(job, task.id, "fft", "id"), /前置/);
    assert.throws(() => advanceBatch(job, task.id, "unknown", "id"), /未知/);
  });
  await check("降噪占位明确注明未执行，原始幅值保持不变", () => {
    const next = advanceBatch(job, task.id, "denoise", "analysis-denoise"); job = next.job;
    assert.match(next.analysis.result.note, /未执行真实降噪/);
    assert.equal(next.analysis.source, "demo");
    assert.deepEqual(next.analysis.result.rows.map((row) => row[1]), task.samples);
    assert.deepEqual(task.samples, [2, -4, 6, -8]);
  });
  await check("截取采用半开采样区间，保留绝对时间和精确幅值", () => {
    const next = advanceBatch(job, task.id, "cut", "analysis-cut"); job = next.job;
    assert.deepEqual(next.analysis.result.rows, [[0.25, -4], [0.5, 6]]);
    assert.deepEqual(next.analysis.parameters.sourceRange, { startIndex: 1, endExclusive: 3 });
    assert.equal(next.analysis.parameters.inputMetadata.samples, undefined);
    assert.deepEqual(job.items[0].input.samples, task.samples);
  });
  await check("FFT 与特征演示标识和配置随结果保存，未被称为真实计算", () => {
    let next = advanceBatch(job, task.id, "fft", "analysis-fft"); job = next.job;
    assert.match(next.analysis.result.note, /不是所选波形的频谱/); assert.equal(next.analysis.parameters.settings.nfft, 4096);
    next = advanceBatch(job, task.id, "features", "analysis-features"); job = next.job;
    assert.match(next.analysis.result.note, /不是所选波形的计算结果/); assert.equal(next.analysis.result.rows.length, 3);
    assert.equal(batchView(job).completed, 4); assert.equal(batchView(job).status, "completed");
  });
  await check("已完成步骤重试不创建第二份结果且不增加尝试次数", () => {
    const again = advanceBatch(job, task.id, "fft", "another-analysis-id");
    assert.equal(again.replayed, true); assert.equal(again.analysis, null);
    assert.equal(again.job.items[0].steps[2].analysisId, "analysis-fft"); assert.equal(again.job.items[0].steps[2].attempts, 1);
  });
  await check("无波形与越界截取形成可追溯失败，不标为完成", () => {
    let bad = createBatchJob(normalizeBatchRequest(request), [{ ...task, samples: [] }]);
    let next = advanceBatch(setBatchPaused(bad, false), task.id, "denoise", "never-created");
    assert.equal(next.analysis, null); assert.equal(batchView(next.job).failed, 1); assert.equal(batchView(next.job).completed, 0);
    bad = createBatchJob(normalizeBatchRequest({ ...request, config: { ...config, denoise: { ...config.denoise, enabled: false }, cut: { enabled: true, start: 0, end: 2 } } }), [task]);
    next = advanceBatch(setBatchPaused(bad, false), task.id, "cut", "never-created");
    assert.match(next.job.items[0].steps[0].error, /超出/); assert.equal(next.analysis, null);
  });
  await check("本机创建/步骤原子写入；磁盘失败不改变内存或产生孤立分析", () => {
    let workspace = { tasks: [clone(task)], analyses: [] };
    const call = (path, body, method = "POST", diskFailure = false) => offlineBatchRequest(workspace, { path, body, method }, (next) => { if (diskFailure) throw Error("disk failure"); workspace = next; });
    assert.equal(call("batches", request).status, 201); assert.equal(call("batches", request).status, 200); assert.equal(workspace.batches.length, 1);
    assert.equal(call("batches", { ...request, name: "changed" }).status, 409);
    call("batches/qa-batch/resume", {});
    const before = JSON.stringify(workspace);
    assert.throws(() => call("batches/qa-batch/step", { taskId: task.id, step: "denoise" }, "POST", true), /disk failure/);
    assert.equal(JSON.stringify(workspace), before);
    assert.equal(call("batches/qa-batch/step", { taskId: task.id, step: "denoise" }).data.completed, 1);
    assert.equal(workspace.analyses.length, 1);
    assert.equal(call("batches/qa-batch/step", { taskId: task.id, step: "denoise" }).data.replayed, true);
    assert.equal(workspace.analyses.length, 1);
    workspace.analyses = [];
    assert.equal(call("batches/qa-batch/step", { taskId: task.id, step: "denoise" }).status, 409);
  });
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync("artifacts/batch-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests: results }, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
