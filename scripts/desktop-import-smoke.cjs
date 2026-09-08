const { app, dialog } = require("electron"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), artifact = path.join(root, "artifacts/desktop-import-smoke"); fs.mkdirSync(artifact, { recursive: true });
const restore = process.env.BLADE_IMPORT_RESTORE === "1", manifestPath = path.join(artifact, "fixture.json");
const fixture = restore ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { profile: fs.mkdtempSync(path.join(artifact, "profile-")), filename: "QA-mixed.json" };
if (path.dirname(fixture.profile) !== artifact || !path.basename(fixture.profile).startsWith("profile-")) throw Error("Refusing a non-QA profile");
app.setPath("userData", fixture.profile); delete process.env.BLADE_DEV_URL;
const tests = []; const watchdog = setTimeout(()=>{console.error("Import native QA timed out");app.exit(1);},60000);
let hold = false, release, drop = false;
const adapter = require(path.join(root, "apps/desktop/electron/imports.cjs")), originalRequest = adapter.offlineImportRequest;
adapter.offlineImportRequest = (...args) => {
  const result = originalRequest(...args);
  if (args[1].path.endsWith("/item") && args[1].body?.index === 0 && hold) { hold = false; return new Promise(resolve=>{release=()=>resolve(result);}); }
  if (args[1].path.endsWith("/item") && args[1].body?.index === 3 && drop) { drop = false; throw Error("QA：任务已提交，但响应丢失"); }
  return result;
};
app.on("browser-window-created", (_event, win) => {
  const wc = win.webContents;
  wc.once("did-finish-load", async () => {
    const js = (code)=>wc.executeJavaScript(code,true), ipc = (options)=>js(`window.blade.offline(${JSON.stringify(options)})`);
    const until = async (condition) => { const start=Date.now(); while(Date.now()-start<10000) { if(typeof condition==="string"?await js(condition):await condition()) return; await new Promise(resolve=>setTimeout(resolve,50)); } throw Error("UI condition timed out: "+condition); };
    const click = (text)=>until(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.scrollIntoView({block:'nearest'});b.click();return true;})()`);
    const fill = (label, value)=>js(`(()=>{const e=[...document.querySelectorAll('dialog label')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input');if(!e)throw Error('Input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const select = (value)=>js(`(()=>{const e=document.querySelector('select[aria-label=导入批次]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const capture = async(name)=>{await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");fs.writeFileSync(path.join(artifact,name),(await wc.capturePage()).toPNG());};
    async function fileInput(file) {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      const { root: document } = await wc.debugger.sendCommand("DOM.getDocument");
      const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", { nodeId: document.nodeId, selector: 'input[aria-label="导入任务文件"]' });
      assert.ok(nodeId); await wc.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [file] });
    }
    async function check(name, run) { await run(); tests.push({name,result:"pass"});console.log("PASS "+name); }
    const job = async()=> (await ipc({path:"imports/"+fixture.jobId,method:"GET"})).data;
    let failure;
    try {
      await click("离线演示工作区");await until("!!document.querySelector('nav.sidebar')");win.setContentSize(1366,768);await until("innerWidth===1366");
      if (!restore) {
        fixture.original = (await ipc({path:"records/tasks/task-a1",method:"GET"})).data;
        const input = { id: "task-a1", name: "QA 首项", object: "QA 叶片", turbine: "QA01", point: "叶尖", rpm: 12, blades: 3, sampleRate: 4, duration: 90, samples: [2,-4,6,-8], channels: [{no:2,type:"velocity",unit:"mm/s"}], source:"import" };
        fs.writeFileSync(path.join(artifact,fixture.filename),JSON.stringify([input,{...input,name:"QA 坏波形",samples:[1,null]},null,{...input,name:"QA 后续项"}]));
        await check("真实 JSON 文件选择后逐条预检，混合坏记录不会提前创建任何任务",async()=>{
          await click("导入 JSON / CSV");await until("!!document.querySelector('dialog')");await fileInput(path.join(artifact,fixture.filename));
          await until("document.querySelector('.import-result-table')?.innerText.includes('QA 后续项')");
          assert.equal(await js("document.querySelectorAll('.import-result-table tbody tr').length"),4);
          assert.ok(await js("document.querySelector('.import-result-table').innerText.includes('有限数值')"));
          assert.equal((await ipc({path:"imports",method:"GET"})).data.length,0);await capture("preview-1366.png");
        });
        await check("确认后仅逐项提交，原生窗口可停止后续导入并保留已成功项",async()=>{
          hold=true;await click("确认导入有效项 (2)");await until(()=>!!release);await click("停止后续导入");release();
          await until("![...document.querySelectorAll('button')].find(b=>b.textContent==='继续导入 / 重试未完成项')?.disabled");
          const jobs=(await ipc({path:"imports",method:"GET"})).data;assert.equal(jobs.length,1);fixture.jobId=jobs[0].id;
          assert.equal(jobs[0].completed,1);assert.equal(jobs[0].pending,1);assert.equal(jobs[0].invalid,2);await capture("paused-1366.png");
        });
        await check("任务重新分配 ID 且原始记录未被覆盖，进度写入本机文件",async()=>{
          const saved=await job();assert.notEqual(saved.items[0].taskId,"task-a1");
          assert.deepEqual((await ipc({path:"records/tasks/task-a1",method:"GET"})).data,fixture.original);
          const disk=JSON.parse(fs.readFileSync(path.join(fixture.profile,"blade-offline.json"),"utf8"));assert.equal(disk.imports[0].items[0].state,"completed");
          fs.writeFileSync(manifestPath,JSON.stringify(fixture,null,2));
        });
      } else {
        await check("独立 Electron 进程恢复导入记录及成功/失败/待处理状态",async()=>{
          await click("导入记录");await until("!!document.querySelector('select[aria-label=导入批次]')");await select(fixture.jobId);
          await until("!!document.querySelector('.import-result-table')");assert.equal((await job()).completed,1);assert.equal((await job()).pending,1);
        });
        await check("提交后丢失响应仍可从 UI 继续核验，不重复创建已成功任务",async()=>{
          drop=true;await click("继续导入 / 重试未完成项");await until("document.querySelector('dialog')?.innerText.includes('响应丢失')");
          await until("document.querySelector('.import-result-table')?.innerText.includes('状态待核验')");
          assert.equal((await job()).completed,2);const before=(await ipc({path:"records/tasks",method:"GET"})).data.length;
          await click("继续导入 / 重试未完成项");await until("[...document.querySelectorAll('button')].find(b=>b.textContent==='继续导入 / 重试未完成项')?.disabled");
          assert.equal((await ipc({path:"records/tasks",method:"GET"})).data.length,before);assert.equal((await job()).pending,0);await capture("completed-1366.png");
        });
        await check("未导入项通过原生保存窗口下载，不夹带成功任务",async()=>{
          const output=path.join(artifact,"unimported.json");let called=false;dialog.showSaveDialog=async()=>{called=true;return{canceled:false,filePath:output};};
          await click("导出未导入项 JSON");await until(()=>called&&fs.existsSync(output));const rows=JSON.parse(fs.readFileSync(output,"utf8"));
          assert.equal(rows.length,2);assert.equal(rows[0].name,"QA 坏波形");assert.equal(rows[1],null);
        });
        await check("原始波形 CSV 文件可自动恢复元信息，采样率不匹配时禁止确认",async()=>{
          await click("新文件");await fileInput(path.join(root,"artifacts/result-data/raw.csv"));await until("!!document.querySelector('.import-csv-fields')");
          assert.equal(await js("[...document.querySelectorAll('.import-csv-fields label')].find(e=>e.querySelector('span').textContent==='采样率 Hz').querySelector('input').value"),"4");
          await fill("采样率 Hz","8");await until("document.querySelector('dialog').innerText.includes('采样率一致')");
          assert.ok(await js("[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('确认导入有效项')).disabled"));
          await fill("采样率 Hz","4");await until("document.querySelector('.import-result-table')?.innerText.includes('4 点')");await capture("csv-1366.png");
          await click("确认导入有效项 (1)");await until(async()=> (await ipc({path:"imports",method:"GET"})).data.length===2);
          await until(async()=> (await ipc({path:"imports",method:"GET"})).data.find(j=>j.id!==fixture.jobId)?.completed===1);
        });
        await check("坏 JSON 可见错误且不会新增批次，随后仍能重新选择文件",async()=>{
          await click("新文件");const bad=path.join(artifact,"bad.json");fs.writeFileSync(bad,"[{broken");await fileInput(bad);
          await until("document.querySelector('dialog')?.innerText.includes('JSON 格式无效')");assert.equal((await ipc({path:"imports",method:"GET"})).data.length,2);
          assert.ok(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='选择 JSON / CSV 文件')&&!document.querySelector('.import-result-table')"));await capture("bad-file-1366.png");
        });
      }
    } catch(error) { failure=error;console.error(error);await capture("failure.png"); }
    clearTimeout(watchdog);fs.writeFileSync(path.join(artifact,`results-${restore?"restore":"create"}.json`),JSON.stringify({time:new Date().toISOString(),platform:process.platform,tests,error:failure?.message},null,2));app.exit(failure?1:0);
  });
});
require(path.join(root,"apps/desktop/electron/main.cjs"));
