const { createHash } = require("node:crypto");
const { stableJson } = require("./sync-data.cjs");

function bundleFor(workspace, taskId) {
  const task = workspace.tasks.find((item) => item.id === taskId);
  if (!task) return null;
  // Snapshot main-process storage, never trust a renderer-supplied task body.
  const payload = JSON.parse(JSON.stringify({
    task,
    analyses: workspace.analyses.filter((item) => item.taskId === taskId)
      .sort((a, b) => a.id.localeCompare(b.id)),
  }));
  return {
    clientId: workspace.clientId,
    localId: task.id,
    revision: createHash("sha256").update(stableJson(payload)).digest("hex"),
    ...payload,
  };
}

function createSyncService({ getWorkspace, commitWorkspace, getConnection, request }) {
  async function context() {
    const connection = getConnection();
    let response;
    try { response = await request({ path: "session", method: "GET" }, connection); }
    catch { response = { status: 503, data: { error: "无法连接管理服务器，请检查服务器地址和网络后重试。" } }; }
    const current = getConnection();
    if (current.url !== connection.url || current.token !== connection.token)
      return { connection, response: { status: 409, data: { error: "服务器或登录账号已改变，请刷新回传列表。" } } };
    return { connection, response };
  }
  return async function sync(options) {
    if (!options || !["status", "upload"].includes(options.action))
      return { status: 400, data: { error: "无效回传操作" } };
    const { connection, response } = await context();
    const user = response.status === 200 ? response.data.user : null;
    if (options.action === "status") {
      const workspace = getWorkspace();
      const receipts = (workspace.syncReceipts || []).filter((r) => r.server === connection.url && r.userId === user?.id && r.tenant === user?.tenant);
      return { status: 200, data: {
        server: connection.url, user,
        connectionError: user ? null : response.data.error || "请登录管理服务器账号。",
        tasks: workspace.tasks.map((task) => {
          const bundle = bundleFor(workspace, task.id);
          const receipt = receipts.find((r) => r.localId === task.id && r.revision === bundle.revision);
          return { id: task.id, name: task.name, object: task.object, revision: bundle.revision,
            analysisCount: bundle.analyses.length, sampleCount: task.samples?.length || 0,
            updatedAt: task.updatedAt || null,
            receipt: receipt ? { taskId: receipt.taskId, importedAt: receipt.importedAt } : null };
        }),
      } };
    }
    if (!user) return response;
    if (user.role === "viewer") return { status: 403, data: { error: "访客没有回传任务的权限。" } };
    if (options.server !== connection.url || options.userId !== user.id || options.tenant !== user.tenant)
      return { status: 409, data: { error: "回传目标或账号已变化，请刷新列表后重新确认。" } };
    const bundle = bundleFor(getWorkspace(), options.taskId);
    if (!bundle) return { status: 404, data: { error: "所选本机任务不存在，请刷新列表。" } };
    if (bundle.revision !== options.revision)
      return { status: 409, data: { error: "本机任务或关联分析已修改，请刷新列表后回传新的修订。" } };
    if (bundle.analyses.length > 50)
      return { status: 400, data: { error: "一份任务最多回传 50 份关联分析，请先整理本机分析记录。" } };
    if (Buffer.byteLength(JSON.stringify(bundle)) > 2_000_000)
      return { status: 413, data: { error: "任务与分析合计超过 2 MB 回传限制，请先整理本机记录。" } };
    let result;
    try { result = await request({ path: "sync/tasks", method: "POST", body: bundle }, connection); }
    catch {
      return { status: 503, data: { error: "未收到服务器确认。任务保留在本机，可重试；同一修订不会重复创建服务器记录。" } };
    }
    if (result.status >= 400) return result;
    const receipt = { server: connection.url, userId: user.id, tenant: user.tenant,
      localId: bundle.localId, revision: bundle.revision, taskId: result.data.taskId,
      importedAt: new Date().toISOString() };
    let warning;
    try {
      const workspace = getWorkspace();
      const remaining = (workspace.syncReceipts || []).filter((r) => !(r.server === receipt.server && r.userId === receipt.userId && r.tenant === receipt.tenant && r.localId === receipt.localId && r.revision === receipt.revision));
      commitWorkspace({ ...workspace, syncReceipts: [receipt, ...remaining] });
    } catch {
      // Server already committed. Do not misreport that as a failed upload.
      warning = "服务器已确认，但本机回执写入失败。请检查磁盘；重试仍会去重。";
    }
    return { ...result, data: { ...result.data, server: receipt.server, userId: user.id, tenant: user.tenant, warning } };
  };
}
module.exports = { createSyncService, bundleFor };
