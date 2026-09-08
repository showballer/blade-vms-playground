// Real baseline maintenance UI, isolated users/data/browser storage only.
const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), mysql = require("mysql2/promise"), { randomBytes } = require("node:crypto");
const root = path.resolve(__dirname, ".."), out = path.join(root, "artifacts/baseline-ui");
process.loadEnvFile(path.join(root, "apps/web/.env.local")); if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
fs.mkdirSync(out, { recursive: true }); app.setPath("userData", fs.mkdtempSync(path.join(out, "profile-"))); app.on("window-all-closed", () => {});
const origin = "http://127.0.0.1:3210", tenant = "qa_baseline_ui_" + Date.now(), password = randomBytes(18).toString("base64url"), users = [], tokens = {}, tests = [];
let rootToken, db, failure, win;
async function api(p, method = "GET", body, token = rootToken) { const res = await fetch(origin + "/api/v1/" + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); const data = await res.json(); if (!res.ok) throw Error(p + ": " + res.status + " " + data.error); return data; }
const js = code => win.webContents.executeJavaScript(code, true);
async function until(condition) { const start = Date.now(); while (Date.now() - start < 12000) { if (typeof condition === "string" ? await js(condition) : await condition()) return; await new Promise(r => setTimeout(r, 50)); } throw Error("UI timeout: " + condition); }
async function click(text) { await until(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true })()`); }
async function field(label, value, select = false) { await js(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(select ? "select" : "input,textarea")})].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.closest('label')?.querySelector('span')?.textContent.replaceAll('*','').trim()===${JSON.stringify(label)}); if(!el)throw Error('Missing field: '+${JSON.stringify(label)}); Object.getOwnPropertyDescriptor(${select ? "HTMLSelectElement" : "(el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement)"}.prototype,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(select ? "change" : "input")},{bubbles:true})); })()`); }
async function capture(name) { await js("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))"); fs.writeFileSync(path.join(out, name + ".png"), (await win.webContents.capturePage()).toPNG()); }
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function rowAction(id, action) { await until(`(() => { const b=document.querySelector('button[aria-label="${action} ${id}"]'); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true; })()`); }
async function useBaseline(id) { await until(`(() => { const row=document.querySelector('[data-testid="baseline-${id}"]'); const b=row && [...row.querySelectorAll('button')].find(b=>b.textContent==='使用此基线'); if(!b||b.disabled)return false; b.click(); return true; })()`); await until("!document.querySelector('dialog[open]')"); }
async function login(role) {
  if (win) win.destroy(); win = new BrowserWindow({ show: false, width: 1366, height: 768, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: tenant + role + Date.now() } });
  await win.loadURL(origin); await until("!!document.querySelector('.login-card')"); await field("账号", tenant + "_" + role); await field("密码", password); await click("登录"); await until("!!document.querySelector('nav.sidebar')");
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error("Baseline UI timeout"); app.exit(1); }, 140000);
  try {
    db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME }); rootToken = (await api("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).token;
    for (const role of ["analyst", "operator", "viewer"]) { const username = tenant + "_" + role, created = await api("users", "POST", { username, password, name: "UI " + role, role, tenant }); users.push(created.id); tokens[role] = (await api("session", "POST", { username, password }, "")).token; }
    const object = "UI 基线对象", task = await api("records/tasks", "POST", { name: "UI 基线关联任务", object, turbine: "QA", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [1,-2,3,-4], source: "import" }, tokens.operator);
    let partialId, fullId, oldModal, oldTrend;
    await login("analyst");
    await check("空组可进入基线管理；只登记模态频率不会补造健康指标", async () => {
      await until("document.querySelector('.empty')?.textContent.includes('暂无有效健康基线')"); await click("基线管理"); await click("登记新基线"); await field("基线名称", "UI 模态专用基线"); await field("基线测试对象", object); await field("一阶模态频率（Hz）", .62); await click("保存基线"); await until("!document.querySelector('[data-testid=baseline-editor]')");
      const items = await api("records/baselines", "GET", undefined, tokens.analyst); assert.equal(items.length, 1); partialId = items[0].id; assert.equal(items[0].rms, undefined); assert.equal(items[0].score, undefined);
      assert.ok(await js("document.querySelector('dialog').textContent.includes('缺少有效的 RMS')")); await capture("partial-1366"); await click("关闭基线管理"); assert.equal(await js("!!document.querySelector('[data-testid=health-overall-grade]')"), false);
    });
    await check("模态页能选部分基线；非法数值被拒绝，输入表单保留", async () => {
      await click("模态识别"); await field("数据任务", task.id, true); await click("基线管理"); await useBaseline(partialId); assert.equal(await js("document.querySelector('select[aria-label=正常态基准]').value"), partialId);
      await click("基线管理"); await rowAction(partialId, "编辑基线"); await field("一阶模态频率（Hz）", 0); await click("保存基线"); await until("document.querySelector('dialog [role=alert]')?.textContent.includes('有限正数')"); assert.equal(await js("document.querySelector('input[aria-label=\"一阶模态频率（Hz）\"]').value"), "0"); await click("返回基线列表");
    });
    await check("复制基线另建完整登记，来源与健康演示字段明确保存", async () => {
      await rowAction(partialId, "复制基线"); await field("基线名称", "UI 完整健康基线"); await field("基线 RMS（mm/s）", 1); await field("基线主频（Hz）", .6); await field("健康度（仅演示显示，0～100）", 80); await field("置信度（仅演示显示，0～1）", .8); await field("基线来源", "demo", true); await field("基线来源与说明", "UI 手工登记原型样例"); await capture("editor-1366"); await click("保存基线"); await until("!document.querySelector('[data-testid=baseline-editor]')");
      const items = await api("records/baselines", "GET", undefined, tokens.analyst); assert.equal(items.length, 2); fullId = items.find(b => b.name === "UI 完整健康基线").id; assert.notEqual(fullId, partialId); assert.equal(items.find(b => b.id === partialId).rms, undefined);
      await useBaseline(fullId); await click("保存演示模态结果"); await until(async () => (await api("records/analyses", "GET", undefined, tokens.analyst)).length === 1); oldModal = (await api("records/analyses", "GET", undefined, tokens.analyst))[0];
      await click("健康监测"); await click("基线管理"); await useBaseline(fullId); await until("!!document.querySelector('[data-testid=health-overall-grade]')");
    });
    await check("并发编辑显示冲突且保留表单，刷新后明确重新编辑才保存", async () => {
      await click("基线管理"); await rowAction(fullId, "编辑基线"); const current = await api("records/baselines/" + fullId, "GET", undefined, tokens.analyst); await api("records/baselines/" + fullId, "PUT", { note: "另一个窗口已编辑", revision: current.revision }, tokens.analyst);
      await field("基线 RMS（mm/s）", 2); await click("保存基线"); await until("document.querySelector('dialog [role=alert]')?.textContent.includes('其他操作更新')"); assert.equal(await js("document.querySelector('input[aria-label=\"基线 RMS（mm/s）\"]').value"), "2"); assert.equal((await api("records/baselines/" + fullId, "GET", undefined, tokens.analyst)).rms, 1); await capture("conflict-1366");
      await click("返回基线列表"); await click("刷新基线列表"); await rowAction(fullId, "编辑基线"); await field("基线 RMS（mm/s）", 2); await click("保存基线"); await until("!document.querySelector('[data-testid=baseline-editor]')"); await useBaseline(fullId); assert.equal((await api("records/baselines/" + fullId, "GET", undefined, tokens.analyst)).rms, 2);
      await click("归档当前演示趋势"); await until("!!document.querySelector('[data-testid=health-trend-snapshot]')"); oldTrend = (await api("records/analyses", "GET", undefined, tokens.analyst)).find(a => a.type === "health-trend");
    });
    await check("停用不静默替换当前基线，健康提示和模态候选同步更新，可重新启用", async () => {
      await click("基线管理"); await rowAction(fullId, "切换基线状态"); await until(`document.querySelector('[data-testid="baseline-${fullId}"] .tag')?.textContent==='停用'`); await click("关闭基线管理"); assert.equal(await js("!!document.querySelector('[data-testid=health-overall-grade]')"), false);
      await click("模态识别"); await until("!!document.querySelector('select[aria-label=正常态基准]')"); assert.equal(await js(`!!document.querySelector('select[aria-label=正常态基准] option[value="${fullId}"]')`), false);
      await click("基线管理"); await rowAction(fullId, "切换基线状态"); await until(`document.querySelector('[data-testid="baseline-${fullId}"] .tag')?.textContent==='启用'`); await useBaseline(fullId); assert.equal(await js("document.querySelector('select[aria-label=正常态基准]').value"), fullId);
    });
    for (const role of ["operator", "viewer"]) await check(role + " 能查看基线和选择用途，但维护按钮均不可写", async () => {
      await login(role); await click("基线管理"); assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='登记新基线').disabled"), true);
      for (const action of ["编辑基线", "复制基线", "切换基线状态", "删除基线"]) assert.equal(await js(`document.querySelector('button[aria-label="${action} ${fullId}"]').disabled`), true);
      await useBaseline(fullId); await until("!!document.querySelector('[data-testid=health-overall-grade]')");
    });
    await check("删除必须勾选确认；仅删除该登记，原模态与趋势历史均保留", async () => {
      await login("analyst"); await click("基线管理"); await rowAction(fullId, "删除基线"); assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认删除基线').disabled"), true); await capture("delete-confirm-1366"); await js("document.querySelector('input[aria-label=确认删除此基线登记]').click()"); await click("确认删除基线"); await until(`!document.querySelector('[data-testid=baseline-delete-confirm]') && !document.querySelector('[data-testid="baseline-${fullId}"]')`);
      assert.deepEqual((await api("records/analyses/" + oldModal.id, "GET", undefined, tokens.analyst)).result, oldModal.result); assert.deepEqual((await api("records/analyses/" + oldTrend.id, "GET", undefined, tokens.analyst)).result, oldTrend.result); assert.equal((await api("records/baselines", "GET", undefined, tokens.analyst)).length, 1); await capture("remaining-1366");
    });
  } catch (error) { failure = error; console.error(error); if (win) await capture("failure").catch(() => {}); }
  finally { if (win) win.destroy(); if (db) { await db.execute("DELETE FROM records WHERE tenant=?", [tenant]); for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [id, tenant]); } await db.end(); } if (rootToken) await api("session", "DELETE").catch(() => {}); clearTimeout(watchdog); fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "Only isolated QA group/users removed; audit retained", platform: process.platform }, null, 2)); app.exit(failure ? 1 : 0); }
});
