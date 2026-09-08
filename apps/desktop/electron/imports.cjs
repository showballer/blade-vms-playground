const { randomUUID } = require("node:crypto");
const { stableJson } = require("./sync-data.cjs");
const { advanceImport, createImportJob, ImportError, importView, normalizeImportRequest } = require("./import-data.cjs");
function offlineImportRequest(workspace, { path, method, body }, commit) {
  const [resource, id, action, extra] = path.split("/");
  if (resource !== "imports" || extra !== undefined) return { status: 405, data: { error: "导入操作路径无效" } };
  const jobs = workspace.imports || [];
  try {
    const old = jobs.find((job) => job.id === id);
    if (id && !old) throw new ImportError("本机导入批次不存在", 404);
    if (method === "GET" && !action) return { status: 200, data: id ? importView(old) : jobs.map(importView) };
    if (method === "GET" && id && action === "pending") return { status: 200, data: old.items.filter((item) => item.state !== "completed").map((item) => item.input) };
    if (method !== "POST" || (id && action !== "item") || (!id && action)) throw new ImportError("不支持此导入操作", 405);
    if (!id) {
      const request = normalizeImportRequest(body), signature = stableJson(request), existing = jobs.find((job) => job.id === request.id);
      if (existing) {
        if (existing.requestHash !== signature) throw new ImportError("导入标识已被使用且内容不同，请新建批次", 409);
        return { status: 200, data: importView(existing) };
      }
      const job = { ...createImportJob(request), requestHash: signature };
      commit({ ...workspace, imports: [job, ...jobs] }); return { status: 201, data: importView(job) };
    }
    const transition = advanceImport(old, body?.index, randomUUID());
    if (transition.replayed) {
      if (!workspace.tasks.some((task) => task.id === old.items[body.index].taskId)) throw new ImportError("此前导入的任务已删除，不会静默重建", 409);
    } else commit({ ...workspace, tasks: [transition.task, ...workspace.tasks], imports: jobs.map((job) => job.id === id ? transition.job : job) });
    return { status: 200, data: { ...importView(transition.job), replayed: transition.replayed } };
  } catch (error) { if (error instanceof ImportError) return { status: error.status, data: { error: error.message } }; throw error; }
}
module.exports = { offlineImportRequest };
