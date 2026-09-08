// Real Next.js UI in isolated Chromium sessions; no production user workspace.
const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), mysql = require("mysql2/promise"), { randomBytes } = require("node:crypto");
const root = path.resolve(__dirname, ".."), out = path.join(root, "artifacts/modal-ui");
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
fs.mkdirSync(out, { recursive: true }); app.setPath("userData", fs.mkdtempSync(path.join(out, "profile-"))); app.on("window-all-closed", () => {});
const origin = "http://127.0.0.1:3210", tenant = "qa_modal_ui_" + Date.now(), emptyTenant = tenant + "_empty", password = randomBytes(18).toString("base64url"), users = [], tokens = {}, tests = [];
let rootToken, db, failure, win, pendingDownload;
async function api(p, method = "GET", body, token = rootToken) { const res = await fetch(origin + "/api/v1/" + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); const data = await res.json(); if (!res.ok) throw Error(p + ": " + res.status + " " + data.error); return data; }
const js = code => win.webContents.executeJavaScript(code, true);
async function until(condition) { const start = Date.now(); while (Date.now() - start < 12000) { if (typeof condition === "string" ? await js(condition) : await condition()) return; await new Promise(r => setTimeout(r, 50)); } throw Error("UI timeout: " + condition); }
async function click(text) { await until(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true })()`); }
async function field(label, value, select = false) { await js(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(select ? "select" : "input,textarea")})].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.closest('label')?.querySelector('span')?.textContent.replaceAll('*','').trim()===${JSON.stringify(label)}); if(!el)throw Error('Missing field'); Object.getOwnPropertyDescriptor(${select ? "HTMLSelectElement" : "(el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement)"}.prototype,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(select ? "change" : "input")},{bubbles:true})); })()`); }
async function capture(name) { await js("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))"); fs.writeFileSync(path.join(out, name + ".png"), (await win.webContents.capturePage()).toPNG()); }
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function download(label, format, name) {
  await field(label + "格式", format, true);
  const target = path.join(fs.mkdtempSync(path.join(out, "download-")), name);
  let timer;
  const done = new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error("Download timeout: " + name)), 12000); pendingDownload = { target, resolve, reject }; });
  try { await click(label); await done; const bytes = fs.readFileSync(target); fs.writeFileSync(path.join(out, name), bytes); return bytes; }
  finally { clearTimeout(timer); pendingDownload = null; }
}
async function login(role) {
  if (win) win.destroy();
  win = new BrowserWindow({ show: false, width: 1366, height: 768, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: tenant + role } });
  win.webContents.session.on("will-download", (_event, item) => { const pending = pendingDownload; if (!pending) { item.cancel(); return; } item.setSavePath(pending.target); item.once("done", (_event, state) => state === "completed" ? pending.resolve() : pending.reject(Error("Download " + state))); });
  await win.loadURL(origin); await until("!!document.querySelector('.login-card')"); await field("账号", tenant + "_" + role); await field("密码", password); await click("登录"); await until("!!document.querySelector('nav.sidebar')"); await click("模态识别"); await until("!!document.querySelector('.modal-screen')");
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error("Modal UI timeout"); app.exit(1); }, 110000);
  try {
    db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    rootToken = (await api("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).token;
    for (const role of ["analyst", "operator", "viewer", "empty"]) { const username = tenant + "_" + role, created = await api("users", "POST", { username, password, name: "UI " + role, role: role === "empty" ? "viewer" : role, tenant: role === "empty" ? emptyTenant : tenant }); users.push(created.id); tokens[role] = (await api("session", "POST", { username, password }, "")).token; }
    const object = "QA UI 叶片", baseline = await api("records/baselines", "POST", { name: "UI 正常态", object, modal: .62 }, tokens.analyst);
    const taskIds = [];
    for (const name of ["任务一", "任务二"]) taskIds.push((await api("records/tasks", "POST", { name, object, turbine: "QA", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [1,-2,3,-4], source: "import", environment: "原始环境" }, tokens.operator)).id);
    const taskId = taskIds[1]; let savedId;
    await login("analyst"); await field("数据任务", taskId, true); await until("document.querySelector('select[aria-label=数据任务]').value===" + JSON.stringify(taskId));
    await check("测点可取消或重新勾选，空选择不允许保存，OMA 方法按类型切换", async () => {
      for (const point of ["P1", "P2", "P3"]) await js(`document.querySelector('input[aria-label="选择模态测点 ${point}"]').click()`);
      await until("document.querySelector('.modal-screen [role=alert]')?.textContent.includes('至少一个')");
      assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='保存演示模态结果').disabled"), true);
      for (const point of ["P1", "P3"]) await js(`document.querySelector('input[aria-label="选择模态测点 ${point}"]').click()`);
      await click("工作模态 OMA"); assert.deepEqual(await js("[...document.querySelector('select[aria-label=方法]').options].map(o=>o.value)"), ["SSI","FDD"]); await field("方法", "FDD", true); await field("阻尼法", "曲线拟合", true);
    });
    await check("切阶驱动基准对比，已存一阶基准不生成二阶假频率", async () => {
      await field("正常态基准", baseline.id, true); await click("第 2 阶");
      await until("document.querySelector('[data-testid=modal-baseline-comparison]').textContent.includes('不能比较第 2 阶')");
      await click("第 1 阶"); assert.ok(await js("document.querySelector('[data-testid=modal-baseline-comparison]').textContent.includes('0.620 Hz → 当前（演示）0.600 Hz')"));
    });
    await check("二维动画支持复位、暂停、速度和播放，不改变固定导出节点", async () => {
      await click("复位振型"); const before = await js("document.querySelector('[aria-label=模态振型动画] canvas').toDataURL()"); await js("new Promise(r=>setTimeout(r,250))");
      assert.equal(await js("document.querySelector('[aria-label=模态振型动画] canvas').toDataURL()"), before);
      await field("动画速度", "2", true); await click("播放动画"); await js("new Promise(r=>setTimeout(r,300))"); assert.notEqual(await js("document.querySelector('[aria-label=模态振型动画] canvas').toDataURL()"), before); await click("复位振型");
      await js("document.querySelector('main').scrollTop=0"); await capture("selected-1366");
    });
    await check("当前四类数据实际下载，只有 P1/P3，单位与演示标记保留", async () => {
      for (const key of ["parameters","points","shape","baseline"]) { await field("当前模态导出内容", key, true); const data = JSON.parse(await download("导出当前模态数据", "json", key + ".json")); assert.equal(data.metadata.datasetKey, key); assert.equal(data.metadata.demo, true); assert.deepEqual(data.metadata.parameters.points, ["P1","P3"]); if (key === "shape") assert.equal(data.rows.length, 6); if (key === "baseline") assert.deepEqual(data.rows.map(r=>r.slice(0,3)), [[1,.62,.6]]); }
      await field("当前模态导出内容", "points", true); await download("导出当前模态数据", "xlsx", "points.xlsx");
    });
    await check("实际保存任务二配置与所有子结果，不串到列表第一任务", async () => {
      await click("保存演示模态结果"); await until(async () => { const analyses = await api("records/analyses", "GET", undefined, tokens.analyst); savedId = analyses.find(a => a.taskId === taskId && a.type === "modal")?.id; return !!savedId; });
      const saved = await api("records/analyses/" + savedId, "GET", undefined, tokens.analyst); assert.equal(saved.parameters.config.method, "FDD"); assert.equal(saved.parameters.config.damping, "曲线拟合"); assert.deepEqual(saved.parameters.config.points, ["P1","P3"]); assert.equal(saved.result.datasets.points.metadata.task.id, taskId);
    });
    await check("服务端源数据变化拒绝陈旧界面保存，不追加假成功记录", async () => {
      await api("records/tasks/" + taskId, "PUT", { environment: "已修改" }, tokens.analyst); await api("records/baselines/" + baseline.id, "PUT", { modal: .72, revision: baseline.revision }, tokens.analyst);
      await click("保存演示模态结果"); await until("document.querySelector('.toast')?.textContent.includes('任务或正常态基准已变化')"); assert.equal((await api("records/analyses", "GET", undefined, tokens.analyst)).length, 1);
    });
    await check("重新载入后历史保留原基准与任务快照，能选择子结果导出", async () => {
      await win.loadURL(origin); await until("!!document.querySelector('nav.sidebar')"); await click("模态识别"); await field("数据任务", taskId, true); await until(`!!document.querySelector('button[aria-label="查看模态结果 ${savedId}"]')`); await js(`document.querySelector('button[aria-label="查看模态结果 ${savedId}"]').click()`); await until("!!document.querySelector('.saved-result-table')");
      await field("已保存子结果", "baseline", true); const data = JSON.parse(await download("导出数值结果", "json", "history-baseline.json")); assert.equal(data.rows[0][1], .62); assert.equal(data.metadata.task.environment, "原始环境");
      await field("已保存子结果", "shape", true); await download("导出数值结果", "mat", "history-shape.mat"); await capture("history-1366"); await click("关闭");
    });
    await check("模态历史可进入同一任务报告，报告冻结所有子结果", async () => {
      await click("生成模态报告"); await until("!!document.querySelector('select[aria-label=数据任务]')"); assert.equal(await js("document.querySelector('select[aria-label=数据任务]').value"), taskId); await click("保存报告");
      await until(async () => (await api("records/reports", "GET", undefined, tokens.analyst)).length === 1); const report = (await api("records/reports", "GET", undefined, tokens.analyst))[0]; assert.equal(report.taskId, taskId); assert.equal(report.analysisSnapshots.find(a=>a.id===savedId).result.datasets.baseline.rows[0][1], .62);
    });
    for (const role of ["operator", "viewer"]) {
      await login(role); await field("数据任务", taskId, true);
      await check(role + " 可以查看历史但不能保存模态或生成报告", async () => { for (const label of ["保存演示模态结果", "生成模态报告"]) assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}).disabled`), true); assert.ok(await js(`!!document.querySelector('button[aria-label="查看模态结果 ${savedId}"]')`)); await capture(role + "-1366"); });
    }
    await login("empty"); await check("无任务课题组显示空状态，不伪造模态结果", async () => { assert.equal(await js("!!document.querySelector('[data-testid=modal-order-1]')"), false); assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='保存演示模态结果').disabled"), true); await capture("empty-1366"); });
  } catch (error) { failure = error; console.error(error); if (win) await capture("failure").catch(() => {}); }
  finally {
    if (win) win.destroy();
    if (db) { for (const group of [tenant, emptyTenant]) await db.execute("DELETE FROM records WHERE tenant=?", [group]); for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant IN (?,?)", [id,tenant,emptyTenant]); } await db.end(); }
    if (rootToken) await api("session", "DELETE").catch(() => {}); clearTimeout(watchdog); fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, platform: process.platform, cleanup: "QA groups/users removed; audit retained" }, null, 2)); app.exit(failure ? 1 : 0);
  }
});
