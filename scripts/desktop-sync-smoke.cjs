// Real bundled Electron UI + IPC + project DB; all records belong to a fresh QA tenant.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const mysql = require("mysql2/promise");
const root = path.resolve(__dirname, "..");
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
delete process.env.BLADE_DEV_URL;
const artifact = path.join(root, "artifacts/desktop-sync-smoke");
fs.mkdirSync(artifact, { recursive: true });
const restoring = process.env.BLADE_SYNC_RESTORE === "1";
const previous = restoring ? JSON.parse(fs.readFileSync(path.join(artifact, "results.json"), "utf8")) : null;
const profile = restoring ? previous.profile : fs.mkdtempSync(path.join(artifact, "profile-"));
if (!path.resolve(profile).startsWith(artifact + "/profile-") || path.dirname(profile) !== artifact) throw Error("Refusing a non-QA profile");
app.setPath("userData", profile);
const tenant = "qa_sync_" + Date.now(), password = randomBytes(18).toString("base64url");
const users = [], results = [], base = "http://127.0.0.1:3210/api/v1/";
let db, rootToken, operator, viewer, finalWindow;
const originalFetch = global.fetch;
async function call(p, method = "GET", body, token = rootToken) {
  const r = await originalFetch(base + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  return { status: r.status, data: await r.json() };
}
async function check(name, fn) { await fn(); results.push({ name, result: "pass" }); console.log("PASS " + name); }
async function finish(error) {
  global.fetch = originalFetch;
  clearTimeout(watchdog);
  if (error) console.error(error.message);
  try {
    if (finalWindow && !finalWindow.isDestroyed()) fs.writeFileSync(path.join(artifact, error ? "failure.png" : "native-sync.png"), (await finalWindow.webContents.capturePage()).toPNG());
    if (db) {
      await db.execute("DELETE FROM sync_imports WHERE tenant=?", [tenant]);
      await db.execute("DELETE FROM records WHERE tenant=?", [tenant]);
      for (const id of users) {
        await db.execute("DELETE FROM sessions WHERE user_id=?", [id]);
        await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [id, tenant]);
      }
      await db.end();
    }
    if (rootToken) await call("session", "DELETE");
  } catch (cleanupError) { error ||= cleanupError; console.error("QA cleanup: " + cleanupError.message); }
  fs.writeFileSync(path.join(artifact, restoring ? "results-restore.json" : "results.json"), JSON.stringify({ time: new Date().toISOString(), platform: process.platform, tenant, profile, tests: results, error: error?.message, cleanup: !error ? "QA records/users removed; audit retained" : "See output" }, null, 2));
  app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => { void finish(Error("Native sync smoke timed out")); }, 90000);
async function main() {
  if (restoring) {
    app.on("browser-window-created", (_event, win) => {
      finalWindow = win;
      win.webContents.once("did-finish-load", async () => {
        try {
          const stored = JSON.parse(fs.readFileSync(path.join(profile, "blade-offline.json"), "utf8"));
          const restored = await win.webContents.executeJavaScript("window.blade.offline({path:'bootstrap',method:'GET'})");
          await check("独立 Electron 进程冷启动恢复同一工作区标识及回传回执", () => {
            assert.equal(restored.data.clientId, stored.clientId);
            assert.equal(restored.data.syncReceipts.length, 2);
            assert.deepEqual(restored.data.syncReceipts, stored.syncReceipts);
          });
          await check("冷启动后原始本机采样及分析仍完整保留", () => {
            const task = restored.data.tasks.find((t) => t.name === previous.tenant);
            assert.deepEqual(task.samples, [1, -2, 3, -4]);
            assert.equal(restored.data.analyses.filter((a) => a.taskId === task.id).length, 1);
          });
          await finish();
        } catch (e) { await finish(e); }
      });
    });
    require(path.join(root, "apps/desktop/electron/main.cjs"));
    return;
  }
  if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project database");
  db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const login = await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD });
  assert.equal(login.status, 200); rootToken = login.data.token;
  for (const role of ["operator", "viewer"]) {
    const username = tenant + "_" + role;
    const response = await call("users", "POST", { username, name: "QA 回传 " + role, tenant, role, password });
    assert.equal(response.status, 201); users.push(response.data.id);
    if (role === "operator") operator = { ...response.data, username }; else viewer = { ...response.data, username };
  }
  app.on("browser-window-created", (_event, win) => {
    finalWindow = win;
    win.webContents.once("did-finish-load", async () => {
      const wc = win.webContents, js = (code) => wc.executeJavaScript(code, true);
      const ipc = (fn, arg) => js(`window.blade.${fn}(${JSON.stringify(arg)})`);
      const until = async (condition) => {
        const start = Date.now();
        while (Date.now() - start < 12000) { if (await js(condition)) return; await new Promise((r) => setTimeout(r, 80)); }
        throw Error("Timed out waiting for UI: " + condition);
      };
      const click = async (text) => {
        const code = `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) return false; button.click(); return true; })()`;
        await until(code);
      };
      const fill = async (label, value) => {
        await js(`(() => { const input = [...document.querySelectorAll('dialog label')].find(x => x.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input'); if (!input) throw Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      };
      let task, status, serverTaskId;
      const syncOptions = () => ({ action: "upload", taskId: task.id, revision: status.tasks.find((t) => t.id === task.id).revision, server: status.server, userId: status.user.id, tenant: status.user.tenant });
      const selectTask = () => js(`(() => { const input = [...document.querySelectorAll('dialog input[type="checkbox"]')].find(x => x.getAttribute('aria-label') === ${JSON.stringify("回传 " + tenant)}); if (!input) throw Error('Task checkbox missing'); if (!input.checked) input.click(); })()`);
      const confirmUpload = async () => { await js("document.querySelector('.sync-confirm input').click()"); await click("确认回传 1 项"); };
      try {
        await ipc("settings", "http://127.0.0.1:3210");
        await check("本机任务、分析与稳定工作区标识持久化", async () => {
          const response = await ipc("offline", { path: "records/tasks", method: "POST", body: { name: tenant, object: "QA 叶片", turbine: "QA-01", point: "P1", rpm: 15, blades: 3, sampleRate: 4, duration: 1, samples: [1, -2, 3, -4], source: "demo", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] } });
          assert.equal(response.status, 201); task = response.data;
          assert.equal((await ipc("offline", { path: "records/analyses", method: "POST", body: { name: "QA FFT", taskId: task.id, type: "fft", source: "demo", parameters: { nfft: 1024 } } })).status, 201);
          const stored = JSON.parse(fs.readFileSync(path.join(profile, "blade-offline.json"), "utf8"));
          assert.match(stored.clientId, /^[a-z0-9-]{36}$/);
          assert.ok(stored.tasks.some((t) => t.id === task.id));
        });
        await check("未登录不自动回传，离线工作区打开显式回传窗口", async () => {
          const response = await ipc("sync", { action: "status" }); assert.equal(response.data.user, null);
          const [rows] = await db.execute("SELECT id FROM records WHERE tenant=?", [tenant]); assert.equal(rows.length, 0);
          await click("离线演示工作区"); await until("!!document.querySelector('.app-shell')");
          await click("回传本机任务"); await until("!!document.querySelector('.sync-login input')");
          assert.ok(await js("document.body.innerText.includes('离线演示')"));
        });
        await check("回传窗口登录服务器，不离开本机工作区，不暴露令牌", async () => {
          await fill("服务器账号", operator.username); await fill("服务器密码", password);
          await click("登录回传账号");
          await until(`document.querySelector('.sync-target').innerText.includes(${JSON.stringify(operator.username)})`);
          await until("![...document.querySelectorAll('button')].find(b => b.textContent === '刷新回传列表').disabled");
          status = (await ipc("sync", { action: "status" })).data;
          assert.equal(status.user.tenant, tenant); assert.equal(status.user.role, "operator");
          assert.equal(status.token, undefined);
          assert.equal((await ipc("request", { path: "session", method: "GET" })).data.token, undefined);
          assert.ok(await js("document.body.innerText.includes('本机演示工作区')"));
          assert.equal(await js("!!document.querySelector('.sync-login input[type=password]')"), false);
        });
        await check("用户确认任务和目标后回传，保存真实采样与关联分析", async () => {
          await selectTask();
          assert.equal(await js("[...document.querySelectorAll('button')].find(b => b.textContent === '确认回传 1 项').disabled"), true);
          await confirmUpload();
          await until("document.querySelector('.sync-progress')?.textContent.includes('成功 1 项')");
          await until("![...document.querySelectorAll('button')].find(b => b.textContent === '刷新回传列表').disabled");
          status = (await ipc("sync", { action: "status" })).data;
          serverTaskId = status.tasks.find((t) => t.id === task.id).receipt.taskId;
          const [rows] = await db.execute("SELECT * FROM records WHERE tenant=?", [tenant]);
          assert.equal(rows.length, 2);
          const t = rows.find((r) => r.kind === "tasks"), a = rows.find((r) => r.kind === "analyses");
          const parse = (r) => typeof r.body === "string" ? JSON.parse(r.body) : r.body;
          assert.equal(t.created_by, operator.id); assert.deepEqual(parse(t).samples, task.samples);
          assert.equal(parse(a).taskId, t.id); assert.notEqual(t.id, task.id);
          assert.ok((await ipc("offline", { path: "bootstrap", method: "GET" })).data.tasks.some((t) => t.id === task.id));
        });
        await check("同一修订重复确认不重复创建，也不覆盖服务器后续编辑", async () => {
          assert.equal((await call("records/tasks/" + serverTaskId, "PUT", { note: "QA 服务端后续编辑" })).status, 200);
          await selectTask(); await confirmUpload();
          await until("document.querySelector('.sync-task-list').innerText.includes('未重复创建')");
          await until("![...document.querySelectorAll('button')].find(b => b.textContent === '刷新回传列表').disabled");
          assert.equal((await call("records/tasks/" + serverTaskId)).data.note, "QA 服务端后续编辑");
          const [rows] = await db.execute("SELECT id FROM records WHERE tenant=?", [tenant]); assert.equal(rows.length, 2);
        });
        await check("本机修改后旧确认拒绝，必须刷新修订", async () => {
          status = (await ipc("sync", { action: "status" })).data; const oldOptions = syncOptions();
          await ipc("offline", { path: "records/tasks/" + task.id, method: "PUT", body: { note: "QA 新的本地修订" } });
          assert.equal((await ipc("sync", oldOptions)).status, 409);
          await click("刷新回传列表");
          await until("document.querySelector('.sync-task-list').innerText.includes('此账号尚无当前修订回执') && ![...document.querySelectorAll('button')].find(b => b.textContent === '刷新回传列表').disabled");
        });
        await check("服务器已提交但回执丢失时保留选中，重试恢复且不重复", async () => {
          let lostAcknowledgement = false;
          global.fetch = async (url, options) => {
            const response = await originalFetch(url, options);
            if (String(url).endsWith("/api/v1/sync/tasks") && options?.method === "POST" && !lostAcknowledgement) { lostAcknowledgement = true; throw Error("QA lost acknowledgement"); }
            return response;
          };
          await selectTask(); await confirmUpload();
          await until("document.querySelector('.sync-progress')?.textContent.includes('失败 1 项')");
          await until("![...document.querySelectorAll('button')].find(b => b.textContent === '刷新回传列表').disabled");
          assert.ok(lostAcknowledgement);
          assert.ok(await js(`[...document.querySelectorAll('dialog input[type="checkbox"]')].find(x => x.getAttribute('aria-label') === ${JSON.stringify("回传 " + tenant)})?.checked`));
          global.fetch = originalFetch;
          await confirmUpload();
          await until("document.querySelector('.sync-task-list').innerText.includes('未重复创建') && document.querySelector('.sync-progress').textContent.includes('成功 1 项')");
          await until("![...document.querySelectorAll('button')].find(b => b.textContent === '刷新回传列表').disabled");
          const [rows] = await db.execute("SELECT id FROM records WHERE tenant=? AND kind='tasks'", [tenant]); assert.equal(rows.length, 2);
          const [audits] = await db.execute("SELECT id FROM audit_logs WHERE tenant=? AND action='离线任务回传'", [tenant]); assert.equal(audits.length, 2);
        });
        await check("完成状态和回传目标位于可见弹窗，表格内部滚动", async () => {
          const layout = await js("(() => { const d=document.querySelector('dialog').getBoundingClientRect(); return { width:d.width, left:d.left, right:d.right, top:d.top, bottom:d.bottom, viewport:[innerWidth,innerHeight], confirm:document.querySelector('.sync-confirm').getBoundingClientRect().bottom }; })()");
          assert.ok(layout.left >= 0 && layout.right <= layout.viewport[0]);
          assert.ok(layout.top >= 0 && layout.bottom <= layout.viewport[1]);
          assert.ok(layout.confirm <= layout.bottom);
          fs.writeFileSync(path.join(artifact, "layout.json"), JSON.stringify(layout, null, 2));
          fs.writeFileSync(path.join(artifact, "native-sync-success.png"), (await wc.capturePage()).toPNG());
        });
        await check("1366×768 桌面回传确认与按钮无需滚出弹窗查找", async () => {
          win.setContentSize(1366, 768);
          await until("innerWidth === 1366 && innerHeight === 768");
          const layout = await js("(() => { const d=document.querySelector('dialog').getBoundingClientRect(); return { bottom:d.bottom, height:d.height, confirm:document.querySelector('.sync-confirm').getBoundingClientRect().bottom, actions:document.querySelector('dialog .dialog-actions').getBoundingClientRect().bottom }; })()");
          fs.writeFileSync(path.join(artifact, "native-sync-1366.png"), (await wc.capturePage()).toPNG());
          assert.ok(layout.confirm <= layout.bottom, JSON.stringify(layout));
          assert.ok(layout.actions <= layout.bottom, JSON.stringify(layout));
        });
        await check("切换账号后回执不泄露，访客回传被拒绝", async () => {
          await ipc("request", { path: "session", method: "POST", body: { username: viewer.username, password } });
          status = (await ipc("sync", { action: "status" })).data;
          assert.equal(status.user.role, "viewer"); assert.equal(status.tasks.find((t) => t.id === task.id).receipt, null);
          assert.equal((await ipc("sync", syncOptions())).status, 403);
          await click("刷新回传列表"); await until("document.querySelector('dialog').innerText.includes('访客没有回传权限')");
          assert.equal(await js("document.querySelector('.sync-confirm input').disabled"), true);
        });
        await check("退出离线工作区同时注销回传账号", async () => {
          await click("关闭");
          await js("document.querySelector('.account-button').click()");
          await click("退出登录");
          await until("!!document.querySelector('.login-shell')");
          assert.equal((await ipc("request", { path: "session", method: "GET" })).status, 401);
          const stored = JSON.parse(fs.readFileSync(path.join(profile, "blade-settings.json"), "utf8"));
          assert.equal(stored.token, undefined);
        });
        await check("界面重新加载保留本机任务及回传回执", async () => {
          const before = JSON.parse(fs.readFileSync(path.join(profile, "blade-offline.json"), "utf8"));
          assert.equal(before.syncReceipts.length, 2);
          const clientId = before.clientId;
          await ipc("request", { path: "session", method: "DELETE" });
          wc.reload(); await new Promise((resolve) => wc.once("did-finish-load", resolve));
          const after = (await ipc("offline", { path: "bootstrap", method: "GET" })).data;
          assert.equal(after.clientId, clientId); assert.deepEqual(after.tasks.find((t) => t.id === task.id).samples, task.samples);
          assert.equal(after.syncReceipts.length, 2);
        });
        await finish();
      } catch (e) { await finish(e); }
    });
  });
  require(path.join(root, "apps/desktop/electron/main.cjs"));
}
main().catch(finish);
