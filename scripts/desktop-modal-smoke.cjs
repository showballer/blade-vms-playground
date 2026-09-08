// Native persistence/export coverage for the shared modal record contract; no new desktop navigation.
const { app, dialog } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { modalBaselineCanonical, modalWorkflow } = require("../apps/desktop/electron/modal-data.cjs"), { rotationCanonical } = require("../apps/desktop/electron/rotation-data.cjs");
const root = path.resolve(__dirname, ".."), out = path.join(root, "artifacts/desktop-modal"), restore = process.env.BLADE_MODAL_RESTORE === "1";
fs.mkdirSync(out, { recursive: true }); const fixturePath = path.join(out, "fixture.json"), fixture = restore ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : { profile: fs.mkdtempSync(path.join(out, "profile-")) };
if (path.dirname(fixture.profile) !== out || !path.basename(fixture.profile).startsWith("profile-")) throw Error("Refusing non-QA profile");
app.setPath("userData", fixture.profile); delete process.env.BLADE_DEV_URL;
const tests = [], hash = value => createHash("sha256").update(value).digest("hex");
const watchdog = setTimeout(() => { console.error("Native modal timeout"); app.exit(1); }, 60000);
app.on("browser-window-created", (_event, win) => { const wc = win.webContents; wc.once("did-finish-load", async () => {
  const js = code => wc.executeJavaScript(code, true), ipc = options => js(`window.blade.offline(${JSON.stringify(options)})`);
  async function until(condition) { const start = Date.now(); while (Date.now() - start < 10000) { if (typeof condition === "string" ? await js(condition) : await condition()) return; await new Promise(r => setTimeout(r, 50)); } throw Error("UI timeout: " + condition); }
  const click = label => until(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true})()`);
  const field = (label, value) => js(`(() => {const e=document.querySelector('select[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const capture = async name => { await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"); fs.writeFileSync(path.join(out, name + ".png"), (await wc.capturePage()).toPNG()); };
  async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
  async function download(key, format, name) { await field("已保存子结果", key); await field("导出数值结果格式", format); const file = path.join(fs.mkdtempSync(path.join(fixture.profile,"export-")), name); let called = false; dialog.showSaveDialog = async (_win, options) => { assert.deepEqual(options.filters[0].extensions, [format]); called = true; return { canceled: false, filePath: file }; }; await click("导出数值结果"); await until(() => called && fs.existsSync(file)); const bytes = fs.readFileSync(file); fs.writeFileSync(path.join(out, name), bytes); return bytes; }
  let failure;
  try {
    if (!restore) {
      await check("离线主进程派生所选点模态子结果，拒绝非法配置与伪造矩阵", async () => {
        const response = await ipc({ path: "records/tasks", method: "POST", body: { name: "QA 本机模态", object: "QA", turbine: "QA", point: "P2", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [1,-2,3,-4], source: "import", environment: "原始环境" } }); assert.equal(response.status, 201); fixture.taskId = response.data.id;
        const task = (await ipc({ path: "records/tasks/" + fixture.taskId, method: "GET" })).data;
        fixture.request = { name: "QA 本机模态记录", taskId: task.id, type: "modal", source: "real", result: { dataset: { rows: [[999]] } }, parameters: { workflow: modalWorkflow, sourceRevision: hash(rotationCanonical(task)), baselineRevision: hash(modalBaselineCanonical()), config: { test: "free", method: "ERA", damping: "时域衰减", points: ["P2"], activeOrder: 3, baselineId: "prototype" } } };
        assert.equal((await ipc({ path: "records/analyses", method: "POST", body: { ...fixture.request, parameters: { ...fixture.request.parameters, config: { ...fixture.request.parameters.config, points: [] } } } })).status, 400);
        const created = await ipc({ path: "records/analyses", method: "POST", body: fixture.request }); assert.equal(created.status, 201); fixture.analysisId = created.data.id; assert.equal(created.data.source, "demo"); assert.equal(created.data.result.datasets.shape.rows.length, 3); assert.deepEqual((await ipc({ path: "records/tasks/" + task.id, method: "GET" })).data, task);
      });
      await check("源任务变化后本机拒绝旧修订，保存的参数和子结果仍冻结", async () => {
        await ipc({ path: "records/tasks/" + fixture.taskId, method: "PUT", body: { environment: "已修改", samples: [99,-2,3,-4] } });
        assert.equal((await ipc({ path: "records/analyses", method: "POST", body: fixture.request })).status, 409);
        const saved = (await ipc({ path: "records/analyses/" + fixture.analysisId, method: "GET" })).data; assert.equal(saved.result.datasets.points.metadata.task.environment, "原始环境");
      });
    }
    await click("离线演示工作区"); await until("!!document.querySelector('nav.sidebar')"); win.setContentSize(1366,768); await click("信号处理"); await field("数据源", fixture.taskId);
    await until('!!document.querySelector(\'button[aria-label="查看分析结果 QA 本机模态记录"]\')'); await js('document.querySelector(\'button[aria-label="查看分析结果 QA 本机模态记录"]\').click()'); await until("!!document.querySelector('.saved-result-table')");
    if (!restore) {
      await check("共享结果窗口选择子结果并通过原生保存窗口导出 JSON/MAT", async () => {
        const points = JSON.parse(await download("points", "json", "points.json")); assert.deepEqual(points.columns.map(c=>c.key), ["frequency","P2"]); assert.deepEqual(points.rows[0], [.2,.36]); await download("shape", "mat", "shape.mat"); await capture("history-1366");
      });
      fs.writeFileSync(fixturePath, JSON.stringify(fixture,null,2));
    } else {
      await check("独立 Electron 进程恢复四类子结果和原始任务元信息", async () => {
        const parameters = JSON.parse(await download("parameters", "json", "restored-parameters.json")); assert.equal(parameters.metadata.task.environment, "原始环境"); assert.deepEqual(parameters.metadata.parameters.points, ["P2"]); assert.equal(parameters.rows[2][1], 3.5);
      });
      await check("冷启动后切换振型子结果可原生导出 Excel，不回退为参数表", async () => { await download("shape", "xlsx", "restored-shape.xlsx"); assert.equal(await js("document.querySelectorAll('.saved-result-table tbody tr').length"), 3); await capture("restored-1366"); });
    }
  } catch (error) { failure = error; console.error(error); await capture("failure").catch(()=>{}); }
  clearTimeout(watchdog); fs.writeFileSync(path.join(out,"results-"+(restore ? "restore" : "create")+".json"), JSON.stringify({ time: new Date().toISOString(), tests, error: failure?.message, platform: process.platform },null,2)); app.exit(failure ? 1 : 0);
}); });
require(path.join(root,"apps/desktop/electron/main.cjs"));
