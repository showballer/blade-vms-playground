const { app, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const artifact = path.join(root, "artifacts/desktop-batch-smoke"); fs.mkdirSync(artifact, { recursive: true });
const restore = process.env.BLADE_BATCH_RESTORE === "1";
const manifestPath = path.join(artifact, "fixture.json");
const fixture = restore ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { profile: fs.mkdtempSync(path.join(artifact, "profile-")), name: "QA 批处理 " + Date.now() };
if (path.dirname(fixture.profile) !== artifact || !path.basename(fixture.profile).startsWith("profile-")) throw Error("Refusing a non-QA profile");
app.setPath("userData", fixture.profile); delete process.env.BLADE_DEV_URL;
const tests = []; let finished = false;
const watchdog = setTimeout(() => { console.error("Batch UI test timed out"); app.exit(1); }, 60000);
let holdFirstStep = false, releaseStep;
const batchModule = require(path.join(root, "apps/desktop/electron/batches.cjs")), originalBatchRequest = batchModule.offlineBatchRequest;
batchModule.offlineBatchRequest = (...args) => {
  const result = originalBatchRequest(...args);
  // Hold a saved response, not a timer, so the UI can pause a real in-flight request.
  if (holdFirstStep && args[1].path.endsWith("/step") && args[1].body.taskId === fixture.goodId) {
    holdFirstStep = false;
    return new Promise((resolve) => { releaseStep = () => resolve(result); });
  }
  return result;
};
async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
app.on("browser-window-created", (_event, win) => {
  const wc = win.webContents;
  wc.once("did-finish-load", async () => {
    const js = (code) => wc.executeJavaScript(code, true), ipc = (options) => js(`window.blade.offline(${JSON.stringify(options)})`);
    const until = async (test) => { const started = Date.now(); while (Date.now() - started < 10000) { if (typeof test === "string" ? await js(test) : await test()) return; await new Promise((r) => setTimeout(r, 60)); } throw Error("UI condition timed out: " + test); };
    const click = async (text) => until(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)return false; b.click(); return true; })()`);
    const fill = async (label, value) => js(`(() => { const el=[...document.querySelectorAll('dialog label')].find(x=>x.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input'); if(!el)throw Error('Input missing'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const checkBox = async (label) => js(`(() => { const el=[...document.querySelectorAll('input[type="checkbox"]')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)}); if(!el)throw Error('Checkbox missing'); if(!el.checked)el.click(); })()`);
    const batchCall = (suffix = "", body, method = "GET") => ipc({ path: "batches/" + fixture.batchId + suffix, method, body });
    const capture = async (name) => { await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); fs.writeFileSync(path.join(artifact, name), (await wc.capturePage()).toPNG()); };
    async function finish(error) {
      if (finished) return; finished = true; clearTimeout(watchdog);
      if (error) console.error(error);
      fs.writeFileSync(path.join(artifact, `${restore ? "restore" : "create"}${error ? "-failure" : ""}.png`), (await wc.capturePage()).toPNG());
      fs.writeFileSync(path.join(artifact, `results-${restore ? "restore" : "create"}.json`), JSON.stringify({ time: new Date().toISOString(), platform: process.platform, tests, error: error?.message }, null, 2));
      app.exit(error ? 1 : 0);
    }
    try {
      if (!restore) {
        const input = { name: fixture.name + " 有效波形", object: "QA 叶片", turbine: "QA-01", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [2, -4, 6, -8], source: "import", channels: [{ no: 1, type: "velocity", unit: "mm/s" }] };
        const good = await ipc({ path: "records/tasks", method: "POST", body: input }); assert.equal(good.status, 201); fixture.goodId = good.data.id;
        const bad = await ipc({ path: "records/tasks", method: "POST", body: { ...input, name: fixture.name + " 空波形", samples: [] } }); assert.equal(bad.status, 201); fixture.badId = bad.data.id;
      }
      await click("离线演示工作区"); await until("!!document.querySelector('nav.sidebar')");
      win.setContentSize(1366, 768); await until("innerWidth===1366 && innerHeight===768");
      if (!restore) {
        await check("历史列表选择多任务并打开批处理配置", async () => {
          await checkBox("选择 " + fixture.name + " 有效波形"); await checkBox("选择 " + fixture.name + " 空波形");
          await click("批量处理 (2)"); await until("!!document.querySelector('.batch-config-grid')");
          assert.equal(await js("document.querySelectorAll('.batch-task-picker input:checked').length"), 2);
          await fill("批次名称", fixture.name); await fill("截取起点 s", "0.25"); await fill("截取终点 s（可留空）", "0.75");
          await capture("configuration-1366.png");
          await click("创建批次并保存配置"); await until("!!document.querySelector('.batch-progress-table')");
          const list = await ipc({ path: "batches", method: "GET" }); assert.equal(list.data.length, 1);
          fixture.batchId = list.data[0].id;
          assert.equal(list.data[0].total, 8); assert.equal(list.data[0].paused, true);
          assert.equal(list.data[0].config.cut.start, 0.25); assert.equal(list.data[0].config.cut.end, 0.75);
        });
        await check("运行时可暂停后续步骤，当前响应返回后保留进度", async () => {
          holdFirstStep = true;
          await click("继续批次 / 重试失败项");
          await until(() => !!releaseStep);
          await click("暂停后续步骤"); releaseStep();
          await until("document.querySelector('dialog').innerText.includes('已停止后续步骤') && ![...document.querySelectorAll('button')].find(b=>b.textContent==='继续批次 / 重试失败项').disabled");
          const job = (await batchCall()).data;
          assert.equal(job.completed, 1); assert.equal(job.paused, true);
          assert.equal(job.items.find((item) => item.taskId === fixture.goodId).steps[0].state, "completed");
          const stored = JSON.parse(fs.readFileSync(path.join(fixture.profile, "blade-offline.json"), "utf8"));
          assert.equal(stored.batches[0].items.find((item) => item.taskId === fixture.goodId).steps[0].state, "completed");
        });
        await check("批次执行不会修改原任务幅值，未完成步骤留待冷启动继续", async () => {
          const original = await ipc({ path: "records/tasks/" + fixture.goodId, method: "GET" }); assert.deepEqual(original.data.samples, [2, -4, 6, -8]);
          const job = (await batchCall()).data; assert.equal(job.completed, 1); assert.equal(job.total, 8);
          fs.writeFileSync(manifestPath, JSON.stringify(fixture, null, 2));
        });
      } else {
        await check("新 Electron 进程从批次记录恢复暂停状态与输入配置", async () => {
          const restored = (await batchCall()).data; assert.equal(restored.completed, 1); assert.equal(restored.paused, true);
          await click("批次记录"); await until("!!document.querySelector('dialog select[aria-label=批次]')");
          await until(`document.querySelector('dialog select[aria-label=批次]').querySelector('option[value="${fixture.batchId}"]') !== null`);
          await js(`(() => { const el=document.querySelector('dialog select[aria-label=批次]'); el.value=${JSON.stringify(fixture.batchId)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
          await until("!!document.querySelector('.batch-progress-table')");
          assert.ok(await js("document.querySelector('dialog').innerText.includes('已完成 1 / 8 步')"));
        });
        await check("继续批次跳过成功步骤，空波形失败不影响有效任务", async () => {
          await click("继续批次 / 重试失败项");
          await until("document.querySelector('dialog').innerText.includes('已完成 4 / 8 步') && ![...document.querySelectorAll('button')].find(b=>b.textContent==='继续批次 / 重试失败项').disabled");
          const job = (await batchCall()).data;
          const good = job.items.find((item) => item.taskId === fixture.goodId), bad = job.items.find((item) => item.taskId === fixture.badId);
          assert.equal(good.steps[0].attempts, 1); assert.ok(good.steps.every((step) => step.state === "completed"));
          assert.equal(bad.steps[0].state, "failed"); assert.match(bad.steps[0].error, /没有有效波形/);
          const analyses = (await ipc({ path: "records/analyses", method: "GET" })).data.filter((a) => a.parameters?.batchId === fixture.batchId);
          assert.equal(analyses.length, 4);
          const raw = await ipc({ path: "records/tasks/" + fixture.goodId, method: "GET" }); assert.deepEqual(raw.data.samples, [2, -4, 6, -8]);
          await capture("progress-1366.png");
        });
        await check("结果查看显示截取数据和演示边界，可下载完整 JSON", async () => {
          await js(`document.querySelector('button[aria-label="查看${fixture.name} 有效波形的截取结果"]').click()`);
          await until("document.querySelectorAll('dialog').length===2 && !!document.querySelector('.batch-result-table')");
          assert.ok(await js("document.querySelectorAll('dialog')[1].innerText.includes('按 [起点,终点)')"));
          assert.ok(await js("document.querySelector('.batch-result-table').innerText.includes('-4') && document.querySelector('.batch-result-table').innerText.includes('6')"));
          const output = path.join(artifact, "cut-result.json");
          let called = false; dialog.showSaveDialog = async () => { called = true; return { canceled: false, filePath: output }; };
          await click("导出结果 JSON"); await until(() => called && fs.existsSync(output));
          const data = JSON.parse(fs.readFileSync(output, "utf8"))[0]; assert.deepEqual(data.result.rows, [[0.25, -4], [0.5, 6]]);
          assert.equal(data.parameters.inputMetadata.channels[0].unit, "mm/s"); assert.equal(data.result.demo, true);
          await capture("result-1366.png");
          await click("返回批次");
        });
        await check("重试失败项不会重复保存其他任务的四份结果", async () => {
          await click("继续批次 / 重试失败项");
          await until("![...document.querySelectorAll('button')].find(b=>b.textContent==='继续批次 / 重试失败项').disabled");
          const analyses = (await ipc({ path: "records/analyses", method: "GET" })).data.filter((a) => a.parameters?.batchId === fixture.batchId); assert.equal(analyses.length, 4);
          const job = (await batchCall()).data; assert.equal(job.items.find((i) => i.taskId === fixture.goodId).steps[0].attempts, 1);
        });
        await check("失败批次可复制配置新建，不改写历史输入和结果", async () => {
          await click("复制配置新建批次"); await until("!!document.querySelector('.batch-config-grid')");
          assert.equal(await js("[...document.querySelectorAll('dialog label')].find(x=>x.querySelector('span')?.textContent==='截取起点 s').querySelector('input').value"), "0.25");
          assert.equal((await ipc({ path: "batches", method: "GET" })).data.length, 1);
          assert.equal((await batchCall()).data.completed, 4);
        });
        await check("演示快照点数、采样率与时长一致，1366 宽度主要操作可见", async () => {
          await js("document.querySelector('dialog button[aria-label=关闭弹窗]').click()");
          await until("!document.querySelector('dialog')");
          const before = (await ipc({ path: "records/tasks", method: "GET" })).data;
          await click("演示快照（400 点）");
          await until(async () => (await ipc({ path: "records/tasks", method: "GET" })).data.length === before.length + 1);
          const snapshot = (await ipc({ path: "records/tasks", method: "GET" })).data.find((task) => !before.some((old) => old.id === task.id));
          assert.equal(snapshot.samples.length, 400); assert.equal(snapshot.duration, 400 / snapshot.sampleRate); assert.equal(snapshot.source, "demo");
          const visible = await js("(() => { const names=['演示快照（400 点）','保存任务','批次记录']; return names.map(name=>{const b=[...document.querySelectorAll('.workspace button')].find(b=>b.textContent.trim()===name);const r=b.getBoundingClientRect();return {name,top:r.top,bottom:r.bottom,visible:r.top>=0&&r.bottom<=innerHeight};}); })()");
          assert.ok(visible.every((item) => item.visible), JSON.stringify(visible));
          await capture("acquisition-1366.png");
        });
      }
      await finish();
    } catch (e) { await finish(e); }
  });
});
require(path.join(root, "apps/desktop/electron/main.cjs"));
