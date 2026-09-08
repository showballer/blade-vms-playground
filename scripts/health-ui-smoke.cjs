// Real Web UI in an isolated Chromium window, with isolated project DB groups.
const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), mysql = require("mysql2/promise"), { randomBytes } = require("node:crypto");
const root = path.resolve(__dirname, ".."), out = path.join(root, "artifacts/health-ui");
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
if (process.env.DB_NAME !== "blade_vms_playground") throw Error("Refusing non-project DB");
fs.mkdirSync(out, { recursive: true }); app.setPath("userData", fs.mkdtempSync(path.join(out, "profile-")));
app.on("window-all-closed", () => {});
const origin = "http://127.0.0.1:3210", tenant = "qa_health_ui_" + Date.now(), emptyTenant = tenant + "_empty", password = randomBytes(18).toString("base64url"), users = [], tokens = {}, tests = [];
let rootToken, db, failure, win;
async function api(p, method = "GET", body, token = rootToken) {
  const res = await fetch(origin + "/api/v1/" + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await res.json(); if (!res.ok) throw Error(p + ": " + res.status + " " + data.error); return data;
}
const js = code => win.webContents.executeJavaScript(code, true);
async function until(condition) { const start = Date.now(); while (Date.now() - start < 10000) { if (typeof condition === "string" ? await js(condition) : await condition()) return; await new Promise(r => setTimeout(r, 50)); } throw Error("UI timeout: " + condition); }
async function click(text) { await until(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true })()`); }
async function setField(label, value, select = false) {
  await js(`(() => { const label=${JSON.stringify(label)}; const el=[...document.querySelectorAll(${JSON.stringify(select ? "select" : "input,textarea")})].find(e=>e.getAttribute('aria-label')===label||e.closest('label')?.querySelector('span')?.textContent.replaceAll('*','').trim()===label); if(!el)throw Error('Missing field: '+label); Object.getOwnPropertyDescriptor(${select ? "HTMLSelectElement" : "(el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement)"}.prototype,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(select ? "change" : "input")},{bubbles:true})); })()`);
}
async function capture(name) { await js("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))"); fs.writeFileSync(path.join(out, name + ".png"), (await win.webContents.capturePage()).toPNG()); }
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
async function login(role) {
  if (win) win.destroy();
  win = new BrowserWindow({ show: false, width: 1366, height: 768, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: tenant + role } });
  await win.loadURL(origin); await until("!!document.querySelector('.login-card')");
  await setField("账号", tenant + "_" + role); await setField("密码", password); await click("登录"); await until("!!document.querySelector('nav.sidebar')");
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error("Health UI timeout"); app.exit(1); }, 60000);
  try {
    db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    rootToken = (await api("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, "")).token;
    for (const role of ["admin", "analyst", "operator", "viewer", "empty"]) {
      const username = tenant + "_" + role, created = await api("users", "POST", { username, password, name: "UI " + role, role: role === "empty" ? "viewer" : role, tenant: role === "empty" ? emptyTenant : tenant }); users.push(created.id);
      tokens[role] = (await api("session", "POST", { username, password }, "")).token;
    }
    const object = "QA UI 叶片";
    const baseline = await api("records/baselines", "POST", { name: "QA UI 基线", object, rms: 1, frequency: .6, modal: .61, score: 80, confidence: .8 }, tokens.analyst);
    for (const name of ["原始任务一", "原始任务二"]) await api("records/tasks", "POST", { name, object, turbine: "QA", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [1, -2, 3, -4], source: "demo" }, tokens.operator);
    const tasks = (await api("bootstrap", "GET", undefined, tokens.analyst)).tasks, task = tasks[1]; assert.ok(task);
    const alert = await api("records/alerts", "POST", { name: "QA 待复核预警", object, taskId: task.id, metric: "RMS", value: 1.05, threshold: 1, level: "报警", status: "待复核", source: "demo" }, tokens.analyst);
    await login("admin"); await setField("监测对象", object, true); await until("document.querySelector('[data-testid=health-config-status]')?.textContent.includes('未配置阈值')");
    await check("无阈值显示未判定，管理员可明确配置而不是偷偷使用默认值", async () => {
      assert.equal(await js("document.querySelector('[data-testid=health-overall-grade]').textContent"), "未判定"); await capture("missing-1366");
      await click("阈值设置"); await setField("RMS 报警阈值 mm/s", .5); await click("保存"); await until("!document.querySelector('dialog[open]') && document.querySelector('[data-testid=health-overall-grade]')?.textContent==='报警'");
    });
    await check("管理员设置注意/预警比例，指标与总体等级同步更新", async () => {
      await click("自定义分级"); await setField("注意占报警阈值的比例（小于预警）", .4); await setField("预警占报警阈值的比例（0~1）", .7); await capture("levels-1366"); await click("保存"); await until("!document.querySelector('dialog[open]')");
      await click("阈值设置"); await setField("RMS 报警阈值 mm/s", 2); await setField("主频偏移绝对值 %", 9); await setField("频带能量阈值", 1.2); await click("保存");
      await until("document.querySelector('[data-testid=health-overall-grade]')?.textContent==='注意'");
      assert.deepEqual((await api("health/thresholds?baselineId=" + baseline.id, "GET", undefined, tokens.viewer)).values, { rms: 2, frequency: 9, band: 1.2, attentionRatio: .4, warningRatio: .7 }); await capture("admin-1366");
    });
    await check("六指标显示单位，新增阈值可保存并重新打开，清空不转换为零或正常", async () => {
      assert.equal(await js("document.querySelectorAll('[data-testid^=health-metric-]').length"), 6);
      assert.ok(await js("document.querySelector('[data-testid=health-threshold-coverage]').textContent.includes('3/6')"));
      await click("阈值设置");
      await setField("峰值报警阈值 mm/s（可留空）", 1.8); await setField("峰峰值报警阈值 mm/s（可留空）", 3.5); await setField("主频幅值报警阈值 mm/s（可留空）", .48);
      await capture("six-thresholds-dialog-1366"); await click("保存"); await until("!document.querySelector('dialog[open]') && document.querySelector('[data-testid=health-threshold-coverage]')?.textContent.includes('6/6')");
      for (const key of ["peak", "peakToPeak", "mainAmplitude"]) assert.ok(await js(`document.querySelector('[data-testid=health-metric-${key}]').textContent.includes('报警')`));
      const stored = (await api("health/thresholds?baselineId=" + baseline.id, "GET", undefined, tokens.viewer)).values; assert.equal(stored.peak, 1.8); assert.equal(stored.peakToPeak, 3.5); assert.equal(stored.mainAmplitude, .48);
      await js("document.querySelector('[data-testid=health-extra-metrics]').scrollIntoView({block:'center'})"); await capture("six-metrics-1366");
      await click("阈值设置"); for (const label of ["峰值报警阈值 mm/s（可留空）", "峰峰值报警阈值 mm/s（可留空）", "主频幅值报警阈值 mm/s（可留空）"]) await setField(label, "");
      await click("保存"); await until("!document.querySelector('dialog[open]') && document.querySelector('[data-testid=health-threshold-coverage]')?.textContent.includes('3/6')");
      assert.ok(await js("document.querySelector('[data-testid=health-metric-peak]').textContent.includes('未判定')"));
      assert.equal((await api("health/thresholds?baselineId=" + baseline.id, "GET", undefined, tokens.viewer)).values.peak, undefined);
    });
    await login("analyst"); await until("document.querySelector('[data-testid=health-overall-grade]')?.textContent==='注意'"); await setField("关联任务", task.id, true);
    await check("演示检测保存完整结论、定位、严重程度和六指标，来源明确未接入", async () => {
      await click("重新运行演示检测"); await until(async () => (await api("records/analyses", "GET", undefined, tokens.analyst)).some(a => a.type === "damage"));
      const result = (await api("records/analyses", "GET", undefined, tokens.analyst)).find(a => a.type === "damage");
      assert.equal(result.taskId, task.id); assert.equal(result.source, "demo"); assert.equal(result.result.metrics.length, 6); assert.equal(result.result.severity, "无");
      assert.ok(result.result.location.includes("未发现定位异常")); assert.ok(result.result.conclusion.includes("不代表所选任务")); assert.equal(result.parameters.thresholds.tenant, tenant);
    });
    await check("分析员看到已配置阈值但不能修改，复核通过真实界面写入并留痕", async () => {
      assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='阈值设置').disabled"), true);
      await click("人工复核标记"); await setField("复核意见", "UI 已核对原始任务"); await click("保存"); await until("!document.querySelector('dialog[open]')");
      const saved = await api("records/alerts/" + alert.id, "GET", undefined, tokens.analyst); assert.equal(saved.reviewer, "UI analyst"); assert.equal(saved.reviewHistory.length, 1); assert.ok(saved.reviewedAt);
      await capture("analyst-1366");
    });
    await check("一键溯源锁定所选任务，而不是数据列表第一项", async () => {
      await click("一键溯源"); await until("!!document.querySelector('select[aria-label=数据源]')");
      assert.equal(await js("document.querySelector('select[aria-label=数据源]').value"), task.id); assert.equal(await js("document.querySelector('select[aria-label=数据源]').options.length"), 1);
      await click("时域波形"); await capture("trace-1366"); await js("document.querySelector('dialog button[aria-label=关闭弹窗]').click()"); await until("!document.querySelector('dialog[open]')");
    });
    await check("导报告携带同一任务，实际保存的报告快照不串任务", async () => {
      await click("导报告"); await until("!!document.querySelector('select[aria-label=数据任务]')"); assert.equal(await js("document.querySelector('select[aria-label=数据任务]').value"), task.id);
      await click("保存报告"); await until(async () => (await api("records/reports", "GET", undefined, tokens.analyst)).length === 1);
      const report = (await api("records/reports", "GET", undefined, tokens.analyst))[0]; assert.equal(report.taskId, task.id); assert.equal(report.taskSnapshot.id, task.id); await capture("report-1366");
    });
    await check("告警中心展示服务端复核时间和完整处置历史", async () => {
      await js("document.querySelector('button[aria-label=查看告警]').click()"); await until("!!document.querySelector('.review-history')");
      await js("document.querySelector('.review-history summary').click()");
      assert.equal(await js("document.querySelectorAll('.review-history li').length"), 1);
      assert.ok(await js("document.querySelector('.review-history').textContent.includes('UI 已核对原始任务')")); await capture("review-history-1366");
    });
    for (const role of ["operator", "viewer"]) {
      await login(role); await until("document.querySelector('[data-testid=health-overall-grade]')?.textContent==='注意'");
      await check(role + " 读取同一分级，复核和检测按钮不可写", async () => {
        for (const text of ["阈值设置", "自定义分级", "人工复核标记", "重新运行演示检测"])
          assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).disabled`), true);
        await capture(role + "-1366");
      });
    }
    await login("empty"); await check("空组不显示虚构基线健康度或诊断结论", async () => {
      await until("document.querySelector('.empty')?.textContent.includes('暂无有效健康基线')"); assert.equal(await js("!!document.querySelector('[data-testid=health-overall-grade]')"), false); await capture("empty-1366");
    });
  } catch (error) { failure = error; console.error(error); if (win) await capture("failure").catch(() => {}); }
  finally {
    if (win) win.destroy();
    if (db) { for (const group of [tenant, emptyTenant]) await db.execute("DELETE FROM records WHERE tenant=?", [group]); for (const id of users) { await db.execute("DELETE FROM sessions WHERE user_id=?", [id]); await db.execute("DELETE FROM users WHERE id=? AND tenant IN (?,?)", [id, tenant, emptyTenant]); } await db.end(); }
    if (rootToken) await api("session", "DELETE").catch(() => {});
    clearTimeout(watchdog); fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, cleanup: "QA groups and users removed; audit retained", platform: process.platform }, null, 2)); app.exit(failure ? 1 : 0);
  }
});
