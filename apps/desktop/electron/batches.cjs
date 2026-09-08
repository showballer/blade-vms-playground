const { randomUUID } = require("node:crypto");
const { stableJson } = require("./sync-data.cjs");
const { BatchError, advanceBatch, batchView, createBatchJob, normalizeBatchRequest, setBatchPaused } = require("./batch.cjs");
function offlineBatchRequest(workspace, { path, method, body }, commit) {
  const [resource, id, action, extra] = path.split("/");
  if (resource !== "batches" || extra !== undefined || !["GET", "POST"].includes(method)) return { status: 405, data: { error: "不支持此批次操作" } };
  const batches = workspace.batches || [];
  try {
    if (method === "GET" && !action) {
      const job = batches.find((job) => job.id === id);
      if (id && !job) throw new BatchError("本机批次不存在", 404);
      return { status: 200, data: id ? batchView(job) : batches.map(batchView) };
    }
    if (method !== "POST" || (id && !["step", "pause", "resume"].includes(action)) || (!id && action)) throw new BatchError("不支持此批次操作", 405);
    if (!id) {
      const request = normalizeBatchRequest(body), signature = stableJson(request);
      const existing = batches.find((job) => job.id === request.id);
      if (existing) {
        if (existing.requestHash !== signature) throw new BatchError("批次标识已使用，请重新创建批次", 409);
        return { status: 200, data: batchView(existing) };
      }
      const tasks = request.taskIds.map((id) => workspace.tasks.find((task) => task.id === id));
      if (tasks.some((task) => !task)) throw new BatchError("所选本机任务不存在", 404);
      const job = { ...createBatchJob(request, tasks), requestHash: signature };
      commit({ ...workspace, batches: [job, ...batches] });
      return { status: 201, data: batchView(job) };
    }
    let job = batches.find((job) => job.id === id);
    if (!job) throw new BatchError("本机批次不存在", 404);
    let analyses = workspace.analyses, replayed = false;
    if (action === "pause" || action === "resume") job = setBatchPaused(job, action === "pause");
    else {
      if (!body || typeof body.taskId !== "string" || typeof body.step !== "string") throw new BatchError("请选择任务和步骤");
      const oldStep = job.items.find((item) => item.taskId === body.taskId)?.steps.find((step) => step.key === body.step);
      if (oldStep?.state === "completed" && !analyses.some((analysis) => analysis.id === oldStep.analysisId)) throw new BatchError("此步骤结果已删除，请新建批次", 409);
      const result = advanceBatch(job, body.taskId, body.step, randomUUID(), workspace.tasks.some((task) => task.id === body.taskId) ? undefined : "原任务已删除，未执行此步骤");
      job = result.job; replayed = result.replayed;
      if (result.analysis) analyses = [result.analysis, ...analyses];
    }
    if (!replayed) commit({ ...workspace, analyses, batches: batches.map((old) => old.id === id ? job : old) });
    return { status: 200, data: { ...batchView(job), replayed } };
  } catch (error) {
    if (error instanceof BatchError) return { status: error.status, data: { error: error.message } };
    throw error;
  }
}
module.exports = { offlineBatchRequest };
