const { app, dialog } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { rotationCanonical, rotationWorkflow, generateRotationSegments } = require("../apps/desktop/electron/rotation-data.cjs");
const root = path.resolve(__dirname, ".."), out = path.join(root, "artifacts/desktop-signal"), restore = process.env.BLADE_SIGNAL_RESTORE === "1";
fs.mkdirSync(out, { recursive: true }); const fixturePath = path.join(out, "fixture.json"), fixture = restore ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : { profile: fs.mkdtempSync(path.join(out, "profile-")) };
if (path.dirname(fixture.profile) !== out || !path.basename(fixture.profile).startsWith("profile-")) throw Error("Refusing non-QA profile");
app.setPath("userData", fixture.profile); delete process.env.BLADE_DEV_URL;
const tests = [], watchdog = setTimeout(() => { console.error("Signal UI timeout"); app.exit(1); }, 60000);
app.on("browser-window-created", (_e, win) => { const wc = win.webContents; wc.once("did-finish-load", async () => {
  const js = code => wc.executeJavaScript(code, true), ipc = options => js(`window.blade.offline(${JSON.stringify(options)})`);
  async function until(condition) { const start = Date.now(); while (Date.now() - start < 10000) { if (typeof condition === "string" ? await js(condition) : await condition()) return; await new Promise(r => setTimeout(r, 50)); } throw Error("UI timeout: " + condition); }
  const click = text => until(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true; })()`);
  const field = (label, value) => js(`(() => { const el=[...document.querySelectorAll('select')].find(el=>el.getAttribute('aria-label')===${JSON.stringify(label)}); if(!el)throw Error('Missing field'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const capture = async name => { await js("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))"); fs.writeFileSync(path.join(out, name + ".png"), (await wc.capturePage()).toPNG()); };
  async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
  async function download(label, format, name) { await field(label + "格式", format); const file = path.join(fs.mkdtempSync(path.join(fixture.profile, "export-")), name); let called = false; dialog.showSaveDialog = async (_w, options) => { assert.deepEqual(options.filters[0].extensions, [format]); called = true; return { canceled: false, filePath: file }; }; await click(label); await until(() => called && fs.existsSync(file)); const bytes = fs.readFileSync(file); fs.writeFileSync(path.join(out, name), bytes); return bytes; }
  let failure;
  try {
    if (!restore) {
      const base = { name: "QA 信号 P1", object: "QA 叶片", turbine: "QA", point: "P1", rpm: 60, blades: 2, sampleRate: 4, duration: 2, samples: [1,-2,3,-4,5,-6,7,-8], source: "import", environment: "原始环境", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
      const created = await ipc({ path: "records/tasks", method: "POST", body: base }); assert.equal(created.status, 201); const task = created.data; fixture.taskId = task.id;
      fixture.secondId = (await ipc({ path: "records/tasks", method: "POST", body: { ...base, name: "QA 信号 P2", point: "P2", sampleRate: 2, samples: [10,20,30] } })).data.id;
      fixture.emptyId = (await ipc({ path: "records/tasks", method: "POST", body: { ...base, name: "QA 无波形", samples: [] } })).data.id;
      const config = { rpm: 60, blades: 2, source: "手动", mode: "period", start: 0, end: 2 }, segments = generateRotationSegments(task, config).segments.map((s,i) => ({ ...s, keep: i !== 1 }));
      const cut = await ipc({ path: "records/analyses", method: "POST", body: { name: "QA 已保存段", taskId: task.id, type: "cut", parameters: { workflow: rotationWorkflow, config, segments, sourceRevision: createHash("sha256").update(rotationCanonical(task)).digest("hex") } } }); assert.equal(cut.status, 201); fixture.cutId = cut.data.id;
    }
    await click("离线演示工作区"); await until("!!document.querySelector('nav.sidebar')"); win.setContentSize(1366,768); await click("信号处理"); await field("数据源", fixture.taskId);
    if (!restore) {
      await check("任务与已保存段真实可选，已排除段不出现，时域读历史两点", async () => {
        await field("任务 / 已保存段", JSON.stringify(["analyses",fixture.cutId,"4:6"])); await click("时域波形");
        await until("document.querySelector('[data-testid=signal-input-summary]')?.textContent.includes('2 点')");
        assert.equal(await js("document.querySelector('select[aria-label=\"任务 / 已保存段\"]').options.length"), 4);
        const data = JSON.parse(await download("导出当前标签", "json", "segment.json")); assert.deepEqual(data.rows, [[1,5],[1.25,-6]]); assert.equal(data.columns[1].unit, "mm/s"); await capture("segment-1366");
      });
      await check("改变通道不转换已保存原始单位，算法标签记录正确段来源", async () => {
        await field("通道", "加速度"); assert.deepEqual(JSON.parse(await download("导出当前标签", "json", "channel.json")).rows, [[1,5],[1.25,-6]]);
        await click("FFT频谱"); await click("运行演示并保存"); await until(async () => (await ipc({ path: "records/analyses", method: "GET" })).data.some(a => a.taskId === fixture.taskId && a.type === "fft"));
        const saved = (await ipc({ path: "records/analyses", method: "GET" })).data.find(a => a.taskId === fixture.taskId && a.type === "fft"); assert.equal(saved.source,"demo"); assert.equal(saved.result.dataset.metadata.inputs[0].ref.segmentId,"4:6"); await click("时域波形");
      });
      await check("多测点对比按各自采样率，起点切换保留原时间，五格式真实保存", async () => {
        await click("多测点对比");
        const label = "对比输入 " + JSON.stringify(["tasks",fixture.secondId,""]);
        await js(`[...document.querySelectorAll('input[type=checkbox]')].find(el=>el.getAttribute('aria-label')===${JSON.stringify(label)}).click()`);
        await until("!!document.querySelector('[aria-label=多测点对比波形]')");
        const absolute = JSON.parse(await download("导出对比数据","json","source.json")); assert.deepEqual(absolute.rows[0], [1,4,1,1,5]); assert.deepEqual(absolute.rows[3], [2,1,.5,.5,20]);
        await field("对比时间轴","relative"); const relative = JSON.parse(await download("导出对比数据","json","relative.json")); assert.deepEqual(relative.rows[0], [1,4,1,0,5]);
        for (const format of ["csv","txt","xlsx","mat"]) await download("导出对比数据",format,"relative."+format); await capture("compare-1366");
        await click("保存对比快照"); await until(async () => { const saved = (await ipc({ path: "records/analyses", method: "GET" })).data.find(a => a.taskId === fixture.taskId && a.parameters?.compare); if (!saved) return false; fixture.comparisonId = saved.id; fixture.comparisonName = saved.name; return true; }); await click("关闭");
      });
      await check("新保存快照不可改写；陈旧整波形被主进程拒绝，已保存段仍可保存", async () => {
        assert.equal((await ipc({ path: "records/analyses/"+fixture.comparisonId, method:"PUT",body:{parameters:{}} })).status,405);
        await field("任务 / 已保存段",JSON.stringify(["tasks",fixture.taskId,""]));
        await ipc({path:"records/tasks/"+fixture.taskId,method:"PUT",body:{samples:Array(8).fill(99),environment:"已修改"}});
        await click("保存波形快照"); await until("document.querySelector('.toast')?.textContent.includes('已变化')");
        await field("任务 / 已保存段",JSON.stringify(["analyses",fixture.cutId,"4:6"])); await click("保存波形快照"); await until(async () => (await ipc({path:"records/analyses",method:"GET"})).data.some(a=>a.taskId===fixture.taskId&&a.parameters?.workflow==='signal-input-v1'&&a.parameters.compare===false&&a.type==='time'));
      });
      await check("已选分段被删除并刷新后明确失效，不静默回退整条任务", async () => {
        await ipc({path:"records/analyses/"+fixture.cutId,method:"DELETE"}); await js("document.querySelector('button[aria-label=刷新数据]').click()");
        await until("document.querySelector('.signal-source [role=alert]')?.textContent.includes('已不存在')");
        assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='导出当前标签').disabled"),true); await capture("missing-segment-1366");
      });
      await check("没有波形的任务显示空状态，不生成或导出演示替代原始数据", async () => {
        await field("数据源",fixture.emptyId); await until("document.querySelector('.signal-source [role=alert]')?.textContent.includes('没有有效原始波形')"); assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='保存波形快照').disabled"),true); await capture("empty-1366");
      });
      fs.writeFileSync(fixturePath,JSON.stringify(fixture,null,2));
    } else {
      await check("独立进程冷启动打开历史对比，源任务变化/分段删除不改写结果",async()=>{
        const label="查看分析结果 "+fixture.comparisonName; await until(`!![...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)})`);
        await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}).click()`); await until("!!document.querySelector('.saved-result-table')");
        const data=JSON.parse(await download("导出数值结果","json","restored.json")); assert.deepEqual(data.rows[0],[1,4,1,0,5]); assert.equal(data.metadata.inputs[0].task.environment,"原始环境"); assert.equal(data.metadata.inputs[1].task.sampleRate,2); await download("导出数值结果","mat","restored.mat"); await capture("history-1366");
      });
    }
  } catch(e) {failure=e;console.error(e);await capture("failure").catch(()=>{});}
  clearTimeout(watchdog);fs.writeFileSync(path.join(out,"results-"+(restore?"restore":"create")+".json"),JSON.stringify({time:new Date().toISOString(),platform:process.platform,tests,error:failure?.message},null,2));app.exit(failure?1:0);
});});
require(path.join(root,"apps/desktop/electron/main.cjs"));
