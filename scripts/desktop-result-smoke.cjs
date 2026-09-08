// Real isolated Electron renderer/IPC downloads; never the user's offline profile.
const { app, dialog } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), ExcelJS = require("exceljs");
const root = path.resolve(__dirname, ".."), artifact = path.join(root, "artifacts/desktop-result-smoke"); fs.mkdirSync(artifact, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(artifact, "profile-"))); delete process.env.BLADE_DEV_URL;
const tests = []; const watchdog = setTimeout(() => { console.error("Result export UI test timed out"); app.exit(1); }, 60000);
app.on("browser-window-created", (_event, win) => {
  const wc = win.webContents;
  wc.once("did-finish-load", async () => {
    const js = (code) => wc.executeJavaScript(code, true), ipc = (options) => js(`window.blade.offline(${JSON.stringify(options)})`);
    await js("window.qaNotices=[]; new MutationObserver(()=>{const text=document.querySelector('.toast')?.textContent; if(text&&window.qaNotices.at(-1)!==text)window.qaNotices.push(text)}).observe(document.body,{subtree:true,childList:true,characterData:true})");
    const until = async (condition) => { const started = Date.now(); while (Date.now() - started < 10000) { if (typeof condition === "string" ? await js(condition) : await condition()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw Error("UI condition timed out: " + condition); };
    const click = (text) => until(`(() => { const button = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if (!button || button.disabled) return false; button.scrollIntoView({block:'nearest'}); button.click(); return true; })()`);
    const select = (label, value) => js(`(() => { const el=[...document.querySelectorAll('select')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)} || e.closest('label')?.querySelector('span')?.textContent===${JSON.stringify(label)}); if(!el) throw Error('Select missing: '+${JSON.stringify(label)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    const capture = async (name) => { await js("new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)))"); fs.writeFileSync(path.join(artifact, name), (await wc.capturePage()).toPNG()); };
    async function download(label, format, filename) {
      await select(label + "格式", format);
      const output = path.join(artifact, filename);
      let called = false;
      dialog.showSaveDialog = async (_win, options) => { assert.deepEqual(options.filters[0].extensions, [format === "record-json" ? "json" : format]); called = true; return { canceled: false, filePath: output }; };
      await click(label); await until(() => called && fs.existsSync(output)); return fs.readFileSync(output);
    }
    async function check(name, fn) { await fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
    let failure;
    try {
      const task = (await ipc({ path: "records/tasks", method: "POST", body: { name: "QA 标签导出", object: "叶片", turbine: "QA-01", point: "P1", rpm: 12, blades: 3, sampleRate: 4, duration: 1, samples: [2, -4, 6, -8], source: "import", channels: [{ no: 2, type: "velocity", unit: "mm/s" }], environment: "导出验收" } })).data;
      await click("离线演示工作区"); await until("!!document.querySelector('nav.sidebar')"); win.setContentSize(1366, 768); await until("innerWidth===1366");
      await click("信号处理"); await select("数据源", task.id);
      const tabs = [["时域波形", "time", 4], ["FFT频谱", "fft", 100], ["时频分析", "tf", 640], ["滤波降噪", "filter", 400], ["包络谱", "env", 150], ["频带能量", "band", 3], ["平均波形", "avg", 400], ["特征值", "feat", 8]];
      for (const [name, type, rows] of tabs) await check(`原生界面 ${name} 导出与当前标签相符`, async () => {
        await click(name); const data = JSON.parse(await download("导出当前标签", "json", type + ".json"));
        assert.equal(data.metadata.type, type); assert.equal(data.metadata.task.id, task.id); assert.equal(data.rows.length, rows);
        if (type === "time") assert.deepEqual(data.rows, [[0, 2], [.25, -4], [.5, 6], [.75, -8]]);
        else assert.equal(data.metadata.demo, true);
        if (type === "fft") assert.deepEqual(data.rows[12], [.6, 1.8]);
        if (type === "tf") assert.equal(data.rows[41][1], 50);
        if (type === "band") assert.deepEqual(data.rows.map(row=>row[1]), [42, 38, 20]);
        if (type === "feat") assert.deepEqual(data.rows[5], ["主频", .6, "Hz"]);
      });
      await check("离线 Excel 按需加载并实际下载，保留单元格数值和元信息页", async () => {
        const book = new ExcelJS.Workbook(); await book.xlsx.load(await download("导出当前标签", "xlsx", "features.xlsx"));
        assert.equal(book.getWorksheet("结果数据").getCell("B2").value, 1.21); assert.ok(book.getWorksheet("元信息"));
        await capture("features-1366.png");
      });
      let result;
      await check("保存标签数据后修改任务，已保存结果仍引用原快照并可导出 MAT", async () => {
        await click("运行演示并保存"); await until(async () => { result = (await ipc({ path: "records/analyses", method: "GET" })).data.find(a=>a.taskId===task.id); return !!result; });
        assert.equal(result.result.dataset.rows.length, 8);
        await ipc({ path: "records/tasks/" + task.id, method: "PUT", body: { samples: [99, 98, 97, 96], environment: "已修改" } });
        await until("!!document.querySelector('button[aria-label^=查看分析结果]')");
        await js(`document.querySelector('button[aria-label='+CSS.escape(${JSON.stringify("查看分析结果 " + result.name)})+']').click()`);
        await until("!!document.querySelector('.saved-result-table')");
        const dataset = JSON.parse(await download("导出数值结果", "json", "saved.json")); assert.equal(dataset.metadata.task.environment, "导出验收");
        await capture("saved-result-before-mat.png"); await download("导出数值结果", "mat", "saved.mat"); await capture("saved-result-1366.png");
        await click("关闭");
      });
      await check("离线原始波形五格式入口可见，导出当前存储数据而非分析快照", async () => {
        await click("数据采集"); await until("!!document.querySelector('.acquisition-screen')");
        await js(`(() => { const row=[...document.querySelectorAll('tr')].find(r=>r.innerText.includes(${JSON.stringify(task.name)})); if(!row) throw Error('Task row missing'); row.click(); })()`);
        await until("!![...document.querySelectorAll('button')].find(b=>b.textContent==='导出原始波形')");
        const bytes = await download("导出原始波形", "xlsx", "raw.xlsx"), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes);
        assert.equal(book.getWorksheet("结果数据").getCell("B2").value, 99);
        assert.equal(await js("document.querySelector('select[aria-label=导出原始波形格式]').options.length"), 6);
        const records = JSON.parse(await download("导出原始波形", "record-json", "task-record.json")); assert.equal(records[0].id, task.id); assert.deepEqual(records[0].samples, [99, 98, 97, 96]);
        await capture("raw-export-1366.png");
      });
      await check("原生结果保存取消不产生成功，非法格式/超限和磁盘失败均明确拒绝", async () => {
        let chooserCalls = 0; dialog.showSaveDialog = async () => { chooserCalls++; return { canceled: true }; };
        assert.deepEqual(await js("window.blade.saveData({format:'mat',bytes:new Uint8Array([1,2,3])})"), { canceled: true });
        for (const request of ["{format:'exe',bytes:new Uint8Array([1])}", "{format:'csv',bytes:new Uint8Array(16000001)}", "{format:'csv',bytes:[1,2]}"])
          await assert.rejects(() => js(`window.blade.saveData(${request})`), /16 MB/);
        assert.equal(chooserCalls, 1);
        await select("导出原始波形格式", "csv"); await click("导出原始波形"); await until("document.querySelector('.toast')?.textContent==='已取消导出'");
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: artifact });
        await assert.rejects(() => js("window.blade.saveData({format:'csv',bytes:new Uint8Array([1])})"), /EISDIR/);
      });
    } catch (error) { failure = error; console.error(error); await capture("failure.png"); }
    clearTimeout(watchdog); fs.writeFileSync(path.join(artifact, "results.json"), JSON.stringify({ time: new Date().toISOString(), platform: process.platform, tests, error: failure?.message }, null, 2)); app.exit(failure ? 1 : 0);
  });
});
require(path.join(root, "apps/desktop/electron/main.cjs"));
