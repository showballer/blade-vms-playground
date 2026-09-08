const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSyncService, bundleFor } = require("../apps/desktop/electron/sync.cjs");
const { readWorkspace } = require("../apps/desktop/electron/workspace.cjs");
const { stableJson } = require("../apps/desktop/electron/sync-data.cjs");
const results = [];
async function check(name, fn) { await fn(); results.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
  await check("损坏或结构非法的本机文件不会被演示数据覆盖", () => {
    fs.mkdirSync("artifacts", { recursive: true });
    const dir = fs.mkdtempSync(path.resolve("artifacts/workspace-qa-"));
    const file = path.join(dir, "blade-offline.json"); let fresh = 0;
    const create = () => { fresh++; return { tasks: [], analyses: [] }; };
    assert.deepEqual(readWorkspace(file, create), { tasks: [], analyses: [] }); assert.equal(fresh, 1);
    for (const invalid of ["{broken", "null", "[]", '{"tasks":[]}', '{"tasks":[],"analyses":[],"clientId":"../invalid"}']) {
      fs.writeFileSync(file, invalid); assert.throws(() => readWorkspace(file, create));
      assert.equal(fs.readFileSync(file, "utf8"), invalid); assert.equal(fresh, 1);
    }
    fs.writeFileSync(file, JSON.stringify({ tasks: [], analyses: [] }));
    assert.deepEqual(readWorkspace(file, create), { tasks: [], analyses: [] }); assert.equal(fresh, 1);
  });
  let workspace = { clientId: "client-qa", tasks: [{ id: "local-qa", name: "QA", samples: [1, -2], updatedAt: "2026-09-07T00:00:00Z" }], analyses: [{ id: "analysis-qa", taskId: "local-qa", type: "fft", parameters: { b: 2, a: 1 } }] };
  let connection = { url: "http://127.0.0.1:3210", token: "qa-only" };
  let user = { id: "qa-user", role: "operator", tenant: "qa-group" };
  let uploads = 0, diskFailure = false, networkFailure = false, rotate = false;
  const service = createSyncService({ getWorkspace: () => workspace,
    commitWorkspace: (next) => { if (diskFailure) throw Error("QA disk failure"); workspace = next; },
    getConnection: () => ({ ...connection }),
    request: async ({ path, body }, captured) => {
      if (networkFailure) throw Error("QA network failure");
      if (path === "session") { if (rotate) connection = { ...connection, token: "changed" }; return { status: 200, data: { user } }; }
      uploads++; assert.equal(captured.url, "http://127.0.0.1:3210");
      assert.equal(body.task.id, "local-qa");
      return { status: 201, data: { taskId: "server-qa", analysisIds: ["server-analysis"], revision: body.revision, created: true } };
    },
  });
  const options = () => ({ action: "upload", taskId: "local-qa", revision: bundleFor(workspace, "local-qa").revision, server: connection.url, userId: user.id, tenant: user.tenant });
  await check("修订序列化不受对象键序影响，数组顺序仍有意义", () => {
    assert.equal(stableJson({ b: [1, { d: 4, c: 3 }], a: 2 }), stableJson({ a: 2, b: [1, { c: 3, d: 4 }] }));
    assert.notEqual(stableJson([1, 2]), stableJson([2, 1]));
  });
  await check("原生快照不包含服务器令牌、配置或回执，不修改本机分析排序", () => {
    workspace.settings = [{ token: "must-stay-local" }]; workspace.syncReceipts = [];
    const snapshot = bundleFor(workspace, "local-qa");
    assert.equal(JSON.stringify(snapshot).includes("must-stay-local"), false);
    snapshot.task.samples[0] = 99;
    assert.equal(workspace.tasks[0].samples[0], 1);
    assert.equal(bundleFor(workspace, "missing"), null);
  });
  await check("回传前重核账号、租户、服务器和本机修订，拒绝过期确认", async () => {
    for (const change of [{ userId: "other" }, { tenant: "other" }, { server: "http://other.invalid" }, { revision: "old" }])
      assert.equal((await service({ ...options(), ...change })).status, 409);
    assert.equal((await service({ ...options(), taskId: "missing" })).status, 404);
    assert.equal(uploads, 0);
    rotate = true;
    assert.equal((await service(options())).status, 409);
    assert.equal(uploads, 0); rotate = false;
  });
  await check("访客无法通过原生桥接上传", async () => {
    user.role = "viewer"; assert.equal((await service(options())).status, 403); user.role = "operator";
    assert.equal(uploads, 0);
  });
  await check("回执只对相同服务器账号和课题组显示，不改变修订", async () => {
    const originalRevision = options().revision;
    const response = await service(options()); assert.equal(response.status, 201);
    assert.equal(options().revision, originalRevision);
    let status = await service({ action: "status" }); assert.equal(status.data.tasks[0].receipt.taskId, "server-qa");
    user.id = "different-user"; status = await service({ action: "status" }); assert.equal(status.data.tasks[0].receipt, null); user.id = "qa-user";
    user.tenant = "different-group"; status = await service({ action: "status" }); assert.equal(status.data.tasks[0].receipt, null); user.tenant = "qa-group";
    workspace.analyses[0].parameters.nfft = 8192;
    status = await service({ action: "status" }); assert.equal(status.data.tasks[0].receipt, null);
    assert.notEqual(options().revision, originalRevision);
  });
  await check("服务器成功但本机磁盘失败时返回成功及警告，不伪报上传失败", async () => {
    diskFailure = true;
    const before = JSON.stringify(workspace);
    const response = await service(options());
    assert.equal(response.status, 201); assert.match(response.data.warning, /服务器已确认/);
    assert.equal(JSON.stringify(workspace), before); diskFailure = false;
  });
  await check("离线状态仍可列出本机任务，回传失败不修改本机数据", async () => {
    const before = JSON.stringify(workspace); networkFailure = true;
    const response = await service({ action: "status" });
    assert.equal(response.status, 200); assert.equal(response.data.user, null); assert.equal(response.data.tasks.length, 1);
    assert.equal((await service(options())).status, 503);
    assert.equal(JSON.stringify(workspace), before); networkFailure = false;
  });
  await check("原生回传拒绝超大批次与不支持操作", async () => {
    workspace.analyses = Array.from({ length: 51 }, (_, i) => ({ id: "a" + i, taskId: "local-qa" }));
    assert.equal((await service(options())).status, 400);
    assert.equal((await service({ action: "delete" })).status, 400);
  });
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync("artifacts/sync-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests: results }, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
