const { app, dialog } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), out = path.join(root, "artifacts/desktop-rotation"), restore = process.env.BLADE_ROTATION_RESTORE === "1";
fs.mkdirSync(out, { recursive: true }); const fixturePath = path.join(out, "fixture.json"), fixture = restore ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : { profile: fs.mkdtempSync(path.join(out, "profile-")) };
if (path.dirname(fixture.profile) !== out || !path.basename(fixture.profile).startsWith("profile-")) throw Error("Refusing non-QA profile");
app.setPath("userData", fixture.profile); delete process.env.BLADE_DEV_URL;
const tests = []; const watchdog = setTimeout(() => { console.error("Rotation UI timeout"); app.exit(1); }, 60000);
app.on("browser-window-created", (_e, win) => { const wc = win.webContents; wc.once("did-finish-load", async () => {
  const js = code => wc.executeJavaScript(code, true), ipc = options => js(`window.blade.offline(${JSON.stringify(options)})`);
  async function until(condition) { const start = Date.now(); while (Date.now() - start < 10000) { if (typeof condition === "string" ? await js(condition) : await condition()) return; await new Promise(r => setTimeout(r, 50)); } throw Error("UI timeout: " + condition); }
  const click = text => until(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true; })()`);
  const field = (label, value, select = false) => js(`(() => { const el=document.querySelector(${JSON.stringify((select ? "select" : "input") + '[aria-label="' + label + '"]')}); if(!el)throw Error('Missing field'); Object.getOwnPropertyDescriptor(${select ? "HTMLSelectElement" : "HTMLInputElement"}.prototype,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(select ? "change" : "input")},{bubbles:true})); })()`);
  const capture = async name => { await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"); fs.writeFileSync(path.join(out, name + ".png"), (await wc.capturePage()).toPNG()); };
  async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
  async function download(label, format, name) { await field(label + "格式", format, true); const file = path.join(fs.mkdtempSync(path.join(fixture.profile, "export-")), name); let called = false; dialog.showSaveDialog = async (_w, options) => { assert.deepEqual(options.filters[0].extensions, [format]); called = true; return { canceled: false, filePath: file }; }; await click(label); await until(() => called && fs.existsSync(file)); const bytes = fs.readFileSync(file); fs.writeFileSync(path.join(out, name), bytes); return bytes; }
  let failure;
  try {
    if (!restore) {
      const result = await ipc({ path: "records/tasks", method: "POST", body: { name: "QA 旋转波形", object: "QA 叶片", turbine: "QA", point: "P1", rpm: 60, blades: 2, sampleRate: 4, duration: 99, samples: [1,-2,3,-4,5,-6,7,-8,9,-10,11], source: "import", environment: "原始环境", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] } }); assert.equal(result.status, 201); fixture.taskId = result.data.id;
    }
    await click("离线演示工作区"); await until("!!document.querySelector('nav.sidebar')"); win.setContentSize(1366, 768); await click("旋转测振"); await field("任务", fixture.taskId, true);
    if (!restore) {
      await check("旋转参数从所选任务加载，时间范围按真实采样长度初始化", async () => {
        await until("document.querySelector('input[aria-label=\"转速 n\"]')?.value==='60'"); assert.equal(await js("document.querySelector('input[aria-label=截取终点]').value"), "2.75");
        assert.equal(await js("document.querySelector('[data-testid=task-source]').textContent"), "导入");
        await click("生成分段"); await until("document.querySelectorAll('.rotation-segments tbody tr').length===6"); assert.ok(await js("document.querySelector('.rotation-segments').textContent.includes('不足完整周期')")); await capture("generated-1366");
      });
      await check("人工异常标注与保留选择实际生效，导出保留原始绝对时间", async () => {
        await field("分段质量 2", "异常", true); await js("document.querySelectorAll('.rotation-segments summary')[1].click()"); await field("分段备注 2", "人工排除冲击");
        for (const index of [4,5,6]) await js(`document.querySelector('input[aria-label="保留分段 ${index}"]').click()`);
        await click("剔除异常段"); await until("document.querySelector('[data-testid=rotation-selection]')?.textContent.includes('保留 2 / 6 段 · 4 点')");
        const data = JSON.parse(await download("导出有效段", "json", "selected.json")); assert.deepEqual(data.rows, [[1,0,0,1],[1,1,.25,-2],[3,4,1,5],[3,5,1.25,-6]]); assert.equal(data.metadata.excludedRanges[0].note, "人工排除冲击");
        await download("导出有效段", "csv", "selected.csv"); await download("导出有效段", "mat", "selected.mat"); await capture("selected-1366");
      });
      await check("多段对比只对齐局部起点，不改写导出的原始时间", async () => {
        await click("多段对比"); await until("document.querySelector('.rotation-screen').textContent.includes('最多同时绘制前 6 个保留段')"); await capture("compare-1366");
        assert.equal(JSON.parse(await download("导出有效段", "json", "compared.json")).rows[2][2], 1); await click("返回原始时间轴");
      });
      await check("原生保存分段分析，原任务与采样不被替换", async () => {
        const before = (await ipc({ path: "records/tasks", method: "GET" })).data; await click("截取并保存");
        await until(async () => { const records = (await ipc({ path: "records/analyses", method: "GET" })).data; const cut = records.find(r => r.type === "cut" && r.taskId === fixture.taskId); if (!cut) return false; fixture.cutId = cut.id; return true; });
        assert.deepEqual((await ipc({ path: "records/tasks", method: "GET" })).data, before);
      });
      await check("键相/信号估计和非法叶片数不能伪装为已执行的阶次结果", async () => {
        await field("转速来源", "键相（未接入）", true); await until("[...document.querySelectorAll('button')].find(b=>b.textContent==='保存演示分析').disabled");
        await field("转速来源", "手动", true); await field("叶片数 Z", 2.5); await until("[...document.querySelectorAll('button')].find(b=>b.textContent==='保存演示分析').disabled"); await field("叶片数 Z", 2);
        await click("保存演示分析"); await until(async () => (await ipc({ path: "records/analyses", method: "GET" })).data.some(r => r.type === "order" && r.taskId === fixture.taskId));
        const data = JSON.parse(await download("导出阶次样例", "json", "order.json")); assert.deepEqual(data.rows.map(r=>r[3]), [1.8,1.25,.8,.5]); assert.equal(data.metadata.demo, true);
      });
      await check("源任务修改后陈旧保存被主进程拒绝，刷新后旧选择不可继续导出", async () => {
        const task = (await ipc({ path: "records/tasks/" + fixture.taskId, method: "GET" })).data;
        await ipc({ path: "records/tasks/" + fixture.taskId, method: "PUT", body: { samples: [99,...task.samples.slice(1)], environment: "已修改" } });
        await click("截取并保存"); await until("document.querySelector('.toast')?.textContent.includes('源任务已变化')"); assert.equal((await ipc({ path: "records/analyses", method: "GET" })).data.filter(r=>r.type==='cut').length, 1);
        const cut = (await ipc({ path: "records/analyses/" + fixture.cutId, method: "GET" })).data;
        assert.equal((await ipc({ path: "records/tasks/" + fixture.taskId, method: "PUT", body: { sampleRate: 8 } })).status, 200);
        assert.equal((await ipc({ path: "records/analyses", method: "POST", body: cut })).status, 409);
        assert.equal((await ipc({ path: "records/tasks/" + fixture.taskId, method: "PUT", body: { sampleRate: 4 } })).status, 200);
        await js("document.querySelector('button[aria-label=刷新数据]').click()"); await until("document.querySelector('.rotation-screen [role=alert]')?.textContent.includes('任务或参数已变化')");
        assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='导出有效段').disabled"), true); await capture("stale-1366");
      });
      fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
    } else {
      await check("独立进程冷启动保留分段历史、排除原因和原始数据快照", async () => {
        await until(`!!document.querySelector('button[aria-label="查看旋转结果 ${fixture.cutId}"]')`); await js(`document.querySelector('button[aria-label="查看旋转结果 ${fixture.cutId}"]').click()`); await until("!!document.querySelector('.saved-result-table')");
        const result = JSON.parse(await download("导出数值结果", "json", "restored.json")); assert.equal(result.rows[0][3], 1); assert.equal(result.metadata.task.environment, "原始环境"); assert.equal(result.metadata.excludedSamples, 7);
        const raw = (await ipc({ path: "records/tasks/" + fixture.taskId, method: "GET" })).data; assert.equal(raw.samples[0], 99); await download("导出数值结果", "xlsx", "restored.xlsx"); await capture("history-1366"); await click("关闭");
      });
      await check("空保留选择阻止保存和导出，不产生空结果", async () => {
        await click("生成分段"); await until("document.querySelectorAll('.rotation-segments tbody tr').length===6");
        await js("document.querySelectorAll('.rotation-segments input[type=checkbox]').forEach(el=>el.click())"); await until("document.querySelector('.rotation-screen [role=alert]')?.textContent.includes('至少保留')");
        for (const label of ["截取并保存", "导出有效段"]) assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}).disabled`), true);
      });
      await check("手动范围重新生成后保存实际采样区间，不继承旧周期选择", async () => {
        await field("截取方式", "manual", true); await field("截取起点", .25); await field("截取终点", 1.25); await click("生成分段"); await until("document.querySelectorAll('.rotation-segments tbody tr').length===1");
        await click("截取并保存"); await until(async () => (await ipc({ path: "records/analyses", method: "GET" })).data.filter(r=>r.type==='cut').length===2);
        const manual = JSON.parse(await download("导出有效段", "json", "manual.json")); assert.deepEqual(manual.rows.map(r=>r[1]), [1,2,3,4]); await capture("manual-1366");
      });
    }
  } catch (error) { failure = error; console.error(error); await capture("failure").catch(()=>{}); }
  clearTimeout(watchdog); fs.writeFileSync(path.join(out, "results-" + (restore ? "restore" : "create") + ".json"), JSON.stringify({ time: new Date().toISOString(), platform: process.platform, tests, error: failure?.message }, null, 2)); app.exit(failure ? 1 : 0);
}); });
require(path.join(root, "apps/desktop/electron/main.cjs"));
