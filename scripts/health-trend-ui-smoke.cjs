// Real Web UI with isolated project accounts, browser storage and actual downloads.
const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), mysql = require("mysql2/promise"), { randomBytes } = require("node:crypto");
const root = path.resolve(__dirname, ".."), out = path.join(root, "artifacts/health-trend-ui");
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
fs.mkdirSync(out, { recursive: true }); app.setPath("userData", fs.mkdtempSync(path.join(out, "profile-"))); app.on("window-all-closed", () => {});
const origin = "http://127.0.0.1:3210", tenant = "qa_trend_ui_" + Date.now(), password = randomBytes(18).toString("base64url"), users = [], tokens = {}, tests = [];
let rootToken, db, failure, win, pendingDownload;
async function api(p, method = "GET", body, token = rootToken) { const res = await fetch(origin + "/api/v1/" + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); const data = await res.json(); if (!res.ok) throw Error(p + ": " + res.status + " " + data.error); return data; }
const js = code => win.webContents.executeJavaScript(code, true);
async function until(condition) { const start = Date.now(); while (Date.now() - start < 15000) { if (typeof condition === "string" ? await js(condition) : await condition()) return; await new Promise(r => setTimeout(r, 50)); } throw Error("UI timeout: " + condition); }
async function click(text) { await until(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true })()`); }
async function field(label, value, select = false) { await js(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(select ? "select" : "input,textarea")})].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.closest('label')?.querySelector('span')?.textContent.replaceAll('*','').trim()===${JSON.stringify(label)}); if(!el)throw Error('Missing field: '+${JSON.stringify(label)}); Object.getOwnPropertyDescriptor(${select ? "HTMLSelectElement" : "(el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement)"}.prototype,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(select ? "change" : "input")},{bubbles:true})); })()`); }
async function capture(name) { await js("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))"); fs.writeFileSync(path.join(out, name + ".png"), (await win.webContents.capturePage()).toPNG()); }
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function download(label, format, name) {
  await field(label + "格式", format, true); const target = path.join(fs.mkdtempSync(path.join(out, "download-")), name); let timer;
  const done = new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error("Download timeout: " + name)), 15000); pendingDownload = { target, resolve, reject }; });
  try { await click(label); await done; const bytes = fs.readFileSync(target); fs.writeFileSync(path.join(out, name), bytes); return bytes; } finally { clearTimeout(timer); pendingDownload = null; }
}
async function login(role) {
  if (win) win.destroy();
  win = new BrowserWindow({ show: false, width: 1366, height: 768, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: tenant + role } });
  win.webContents.session.on("will-download", (_event, item) => { const pending = pendingDownload; if (!pending) { item.cancel(); return; } item.setSavePath(pending.target); item.once("done", (_event, state) => state === "completed" ? pending.resolve() : pending.reject(Error("Download " + state))); });
  await win.loadURL(origin); await until("!!document.querySelector('.login-card')"); await field("账号", tenant + "_" + role); await field("密码", password); await click("登录"); await until("!!document.querySelector('.health-trends')");
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error("Trend UI timeout"); app.exit(1); }, 150000);
  try {
    db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    rootToken = (await api("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).token;
    for (const role of ["analyst", "operator", "viewer"]) { const username = tenant + "_" + role, created = await api("users", "POST", { username, password, name: "UI " + role, role, tenant }); users.push(created.id); tokens[role] = (await api("session", "POST", { username, password }, "")).token; }
    const object = "QA UI 趋势对象", baseline = await api("records/baselines", "POST", { name: "UI 原始基线", object, rms: 1, frequency: .6, modal: .61, score: 80, confidence: .8 }, tokens.analyst);
    const taskIds = [];
    for (const name of ["趋势原始任务一", "趋势原始任务二"]) taskIds.push((await api("records/tasks", "POST", { name, object, turbine: "QA", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [1,-2,3,-4], source: "import" }, tokens.operator)).id);
    const taskId = taskIds[1]; let savedId, markId, waveId, legacyId;
    await login("analyst"); await field("关联任务", taskId, true);
    await check("日期与任务选择影响归档来源，未配置阈值不伪装已判定", async () => {
      await field("展示起日", "2024-02-01"); await until("!!document.querySelector('[aria-label=健康趋势与人工标记] canvas')");
      await download("导出演示趋势", "json", "preview.json"); await click("归档当前演示趋势"); await until("!!document.querySelector('[data-testid=health-trend-snapshot]')");
      savedId = await js("document.querySelector('select[aria-label=趋势记录]').value"); assert.ok(savedId);
      const a = await api("records/analyses/" + savedId, "GET", undefined, tokens.analyst); assert.equal(a.taskId, taskId); assert.equal(a.result.dataset.rows[28][1], "2024-02-29"); assert.equal(a.result.dataset.metadata.thresholds.status, "missing");
      assert.equal(a.result.dataset.columns.length, 10);
      legacyId = tenant + "_legacy";
      const old = structuredClone(a); old.name = "QA 旧三曲线趋势"; delete old.parameters.sampleVersion;
      for (const d of [old.result.dataset, old.result.datasets.trend]) { d.columns = d.columns.slice(0, 5); d.rows = d.rows.map(r => r.slice(0, 5)); delete d.metadata.sampleVersion; }
      await db.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'analyses',?,?,?)", [legacyId, tenant, JSON.stringify(old), users[0]]);
      await capture("archive-1366");
    });
    await check("默认四曲线含频带，幅值/模态分组切换，旧归档没有新增指标且不能为其标记", async () => {
      assert.ok(await js("document.querySelector('[data-testid=health-trend-columns]').textContent.includes('频带能量')"));
      await field("趋势指标组", "amplitudes", true); for (const label of ["峰值", "峰峰值", "主频幅值"]) assert.ok(await js(`document.querySelector('[data-testid=health-trend-columns]').textContent.includes(${JSON.stringify(label)})`));
      await js("document.querySelector('.health-trends').scrollIntoView({block:'start'})"); await capture("amplitude-curves-1366");
      await field("趋势指标组", "modal", true); assert.ok(await js("document.querySelector('[data-testid=health-trend-columns]').textContent.includes('阻尼比')")); await capture("modal-curves-1366");
      await click("刷新趋势记录"); await until(`!!document.querySelector('select[aria-label=趋势记录] option[value="${legacyId}"]') && !document.querySelector('select[aria-label=趋势记录]').disabled`); await field("趋势记录", legacyId, true); await until("document.querySelector('.health-trends').textContent.includes('旧归档仅有 3 项趋势')");
      await click("添加人工信号标记"); const keys = await js("[...document.querySelector('dialog select').options].map(o=>o.value).filter(Boolean)"); assert.deepEqual(keys, ["amplitude", "frequency", "modal"]); await click("取消");
      const old = JSON.parse(await download("导出归档数值", "json", "legacy-trend.json")); assert.equal(old.columns.length, 5);
      await field("趋势指标组", "overview", true); await capture("legacy-three-curves-1366");
      await field("趋势记录", savedId, true); await until("document.querySelector('select[aria-label=趋势记录]').value===" + JSON.stringify(savedId) + " && !document.querySelector('.health-trends').textContent.includes('旧归档仅有 3 项趋势')");
    });
    await check("真实表单添加趋势信号标记，显示服务端身份且不覆盖告警复核", async () => {
      await click("添加人工信号标记"); await field("标记曲线", "band", true); await field("起始索引（含，从 0 开始）", 2); await field("结束索引（不含）", 5); await field("标记说明（不修改原始数值）", "UI 频带能量变化待复核"); await click("保存"); await until("!document.querySelector('dialog[open]') && document.querySelectorAll('[data-testid^=health-annotation-]').length===1");
      const a = await api("records/analyses/" + savedId, "GET", undefined, tokens.analyst); markId = a.result.annotations[0].id; assert.equal(a.result.annotations[0].actor, "UI analyst"); assert.equal(a.result.annotations[0].series, "band");
      await js("document.querySelector('.health-trends').scrollIntoView({block:'start'})"); await capture("trend-mark-1366");
    });
    await check("波形快照回放、定位和区间标记保留原始幅值", async () => {
      await field("归档视图", "waveform", true); await click("播放归档波形"); await until("document.querySelector('[data-testid=health-trend-cursor]')?.textContent.startsWith('3 / 3')");
      assert.ok(await js("[...document.querySelectorAll('button')].some(b=>b.textContent==='播放归档波形')")); await click("复位回放");
      await click("添加人工信号标记"); await field("起始索引（含，从 0 开始）", 1); await field("结束索引（不含）", 3); await field("标记类别", "异常", true); await field("标记说明（不修改原始数值）", "UI 波形区间标记"); await click("保存"); await until("!document.querySelector('dialog[open]') && document.querySelectorAll('[data-testid^=health-annotation-]').length===2");
      const a = await api("records/analyses/" + savedId, "GET", undefined, tokens.analyst); waveId = a.result.annotations.find(x => x.target === "waveform").id;
      assert.deepEqual(a.result.datasets.waveform.rows, [[0,1],[.25,-2],[.5,3],[.75,-4]]);
      await field("归档视图", "trend", true); await js(`document.querySelector('[data-testid="health-annotation-${waveId}"] .text-link').click()`); await until("document.querySelector('[data-testid=health-trend-cursor]')?.textContent.startsWith('1 / 3')");
      await js("document.querySelector('.health-trends [role=img]').scrollIntoView({block:'start'})"); await capture("waveform-mark-1366");
    });
    await check("趋势和归档波形真实五格式下载，JSON 包含对应矩阵和标记", async () => {
      for (const key of ["trend", "waveform"]) { await field("归档视图", key, true); for (const format of ["csv", "txt", "xlsx", "mat", "json"]) {
        const bytes = await download("导出归档数值", format, `ui-${key}.${format}`); if (format === "json") { const d = JSON.parse(bytes); assert.equal(d.rows.length, key === "trend" ? 30 : 4); assert.equal(d.metadata.analysis.result.annotations.length, 2); }
      } }
    });
    await check("重新加载历史仍含标记，源任务/基线修改不会改变快照", async () => {
      await api("records/tasks/" + taskId, "PUT", { samples: [9,8,7,6] }, tokens.operator); await api("records/baselines/" + baseline.id, "PUT", { name: "UI 已改基线", revision: baseline.revision }, tokens.analyst);
      await win.reload(); await until("!!document.querySelector('.health-trends')"); await field("关联任务", taskId, true); await field("趋势记录", savedId, true); await until("!!document.querySelector('[data-testid=health-trend-snapshot]')");
      assert.ok(await js("document.querySelector('[data-testid=health-trend-snapshot]').textContent.includes('UI 原始基线')")); assert.equal(await js("document.querySelectorAll('[data-testid^=health-annotation-]').length"), 2);
      await field("归档视图", "waveform", true); const json = JSON.parse(await download("导出归档数值", "json", "frozen-waveform.json")); assert.deepEqual(json.rows, [[0,1],[.25,-2],[.5,3],[.75,-4]]);
    });
    await check("无采样点任务只归档趋势，界面与成功提示不声称已保存波形", async () => {
      const empty = await api("records/tasks", "POST", { name: "UI 无波形任务", object, turbine: "QA", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [], source: "import" }, tokens.operator);
      await click("刷新趋势记录"); await until(`!!document.querySelector('select[aria-label=关联任务] option[value="${empty.id}"]')`); await field("关联任务", empty.id, true); await until("!document.querySelector('[data-testid=health-trend-snapshot]')"); await click("归档当前演示趋势"); await until("!!document.querySelector('[data-testid=health-trend-snapshot]') && document.body.textContent.includes('未创建波形快照')");
      assert.equal(await js("document.querySelector('select[aria-label=归档视图]').options.length"), 1); assert.equal(await js("!!document.querySelector('[aria-label=归档回放位置]')"), false);
      await field("关联任务", taskId, true); await field("趋势记录", savedId, true); await until("!!document.querySelector('[data-testid=health-trend-snapshot]')");
    });
    await check("撤回保留原因与初始标记，报告跳转不串任务", async () => {
      await js(`document.querySelector('button[aria-label="撤回信号标记 ${markId}"]').click()`); await field("撤回原因（保留原标记历史）", "UI 核对后撤回"); await click("保存"); await until("!document.querySelector('dialog[open]')");
      assert.ok(await js(`document.querySelector('[data-testid="health-annotation-${markId}"]').textContent.includes('UI 核对后撤回')`)); await capture("withdrawn-1366");
      await click("生成关联任务报告"); await until("!!document.querySelector('select[aria-label=数据任务]')"); assert.equal(await js("document.querySelector('select[aria-label=数据任务]').value"), taskId);
      assert.ok(await js("document.body.textContent.includes('健康趋势与标记')"));
    });
    for (const role of ["operator", "viewer"]) await check(role + " 可读归档，但不能归档、标记或撤回", async () => {
      await login(role); await field("关联任务", taskId, true); assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='归档当前演示趋势').disabled"), true);
      await field("趋势记录", savedId, true); await until("!!document.querySelector('[data-testid=health-trend-snapshot]')"); assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='添加人工信号标记').disabled"), true);
      assert.equal(await js(`document.querySelector('button[aria-label="撤回信号标记 ${waveId}"]').disabled`), true);
    });
    await check("基线/源任务删除后访客仍可独立打开历史，不显示虚构健康度", async () => {
      await api("records/baselines/" + baseline.id, "DELETE", { revision: (await api("records/baselines/" + baseline.id, "GET", undefined, tokens.analyst)).revision, confirm: true }, tokens.analyst); await api("records/tasks/" + taskId, "DELETE", undefined, tokens.operator);
      await win.reload(); await until("document.querySelector('.empty')?.textContent.includes('暂无有效健康基线')"); await field("趋势记录", savedId, true); await until("!!document.querySelector('[data-testid=health-trend-snapshot]')"); assert.equal(await js("!!document.querySelector('[data-testid=health-overall-grade]')"), false); assert.equal(await js("document.querySelectorAll('[data-testid^=health-annotation-]').length"), 2); await capture("no-source-history-1366");
    });
  } catch (error) { failure = error; console.error(error); if (win) await capture("failure").catch(() => {}); }
  finally {
    if (win) win.destroy();
    if (db) { await db.execute("DELETE FROM records WHERE tenant=?", [tenant]); for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [id, tenant]); } await db.end(); }
    if (rootToken) await api("session", "DELETE").catch(() => {}); clearTimeout(watchdog);
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "Only isolated QA group/users removed; audit retained", platform: process.platform }, null, 2)); app.exit(failure ? 1 : 0);
  }
});
