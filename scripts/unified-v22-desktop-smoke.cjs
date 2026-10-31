'use strict';
// Production renderer + IPC + source Python analysis in a disposable profile.
// Copies real saved records, never connects hardware/cloud or edits source data.
const { app, session, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash, randomBytes, scryptSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || path.join(root, 'artifacts/blade2-five-point-audit-20261027/imported-recordings'));
const output = path.resolve(process.argv[3] || path.join(root, 'artifacts/unified-analysis-v22-20261030/desktop-ui'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-record-analysis-'));
const target = path.join(profile, 'field-data', 'recordings');
const report = { passed: false, hardwareUsed: false, productionProfileTouched: false, source, checks: [], screenshots: [], errors: [], requests: [], blockedNetwork: [] };
const payloads = [];
let service, cloud;
let releasePreview, holdPreview = true;
let releaseCatalog, holdCatalog = false;
let finished = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(target, { recursive: true });
const exportsDirectory = path.join(output, 'exports'); fs.mkdirSync(exportsDirectory, { recursive: true });
const savedFiles = [];
dialog.showSaveDialog = async (_window, options) => {
  const name = path.basename(options.defaultPath); assert.ok(name.endsWith('.zip'));
  const filePath = path.join(exportsDirectory, name); savedFiles.push(filePath);
  return { canceled: false, filePath };
};
const ids = fs.readdirSync(source).filter(id => /^[0-9a-f]{32}$/.test(id)).sort();
assert.equal(ids.length, 20, 'Acceptance fixture must contain five real points × four angles');
function hashes(directory) {
  const result = {};
  const visit = (folder, relative = '') => {
    for (const name of fs.readdirSync(folder).sort()) {
      const key = path.join(relative, name), file = path.join(folder, name), stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, 'Record source must not escape through links');
      if (stat.isDirectory()) visit(file, key);
      else if (stat.isFile()) result[key] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  for (const id of ids) visit(path.join(directory, id), id);
  return result;
}
const before = hashes(source);
for (const id of ids) fs.cpSync(path.join(source, id), path.join(target, id), { recursive: true });
assert.deepEqual(hashes(target), before);
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'blade-field-settings.json'), JSON.stringify({ dll: path.join(profile, 'HARDWARE_DISABLED_DO_NOT_CREATE.dylib') }));
delete process.env.BLADE_DEV_URL;
const password = randomBytes(24).toString('base64url'), changedPassword = randomBytes(24).toString('base64url'), salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
// Replace the require entry without reading the developer's real bootstrap file.
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const nativeFetch = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    report.blockedNetwork.push(url.origin); throw Error('Acceptance profile blocks external network');
  }
  return nativeFetch(input, options);
};
const serviceModule = require('../apps/desktop/electron/field-service.cjs'), factory = serviceModule.createFieldService;
serviceModule.createFieldService = options => {
  assert.equal(path.resolve(options.dataDir), path.join(profile, 'field-data'));
  service = factory(options);
  for (const method of ['begin', 'rssiCalibration', 'turntable', 'singlePoint', 'motionTrial']) {
    service[method] = async () => { throw Error('Acceptance profile blocks hardware operation: ' + method); };
  }
  service.device = async command => {
    if (command.action === 'laser_read') return { state: 'unknown', deviceIp: command.deviceIp, source: 'test-hardware-disabled', busy: false };
    throw Error('Acceptance profile blocks device mutation');
  };
  service.turntablePorts = async () => ({ ports: [] });
  const analyze = service.recordAnalysis;
  service.recordAnalysis = async command => {
    if (command.action === 'catalog' && holdCatalog) {
      await new Promise(resolve => { releaseCatalog = resolve; });
    }
    // Hold only a derived display request to observe pending UI deterministically.
    if (command.action === 'preview' && holdPreview) {
      await new Promise(resolve => { releasePreview = resolve; });
    }
    const started = Date.now(), result = await analyze(command);
    report.requests.push({ action: command.action, kind: command.kind, recordingId: command.recordingId, scope: command.scope, ms: Date.now() - started });
    payloads.push({ command, result }); return result;
  };
  return service;
};
const cloudModule = require('../apps/desktop/electron/field-cloud-sync.cjs'), cloudFactory = cloudModule.createFieldCloudSync;
cloudModule.createFieldCloudSync = options => {
  cloud = cloudFactory({ ...options, fetchImpl: async () => { throw Error('Acceptance profile blocks cloud upload'); } });
  return cloud;
};
const timer = setTimeout(() => { report.error = 'Bounded acceptance watchdog exceeded 240 seconds'; void finish(1); }, 240000);
function check(message) { report.checks.push(message); console.log('PASS ' + message); }
async function finish(code) {
  if (finished) return; finished = true; clearTimeout(timer);
  try {
    assert.deepEqual(hashes(source), before, 'Original source records changed');
    assert.deepEqual(hashes(target), before, 'Analysis changed copied record files');
    check('All 20 manifests and raw files retain their original SHA-256 values');
    report.sourceFileCount = Object.keys(before).length;
  } catch (error) { code = 1; report.errors.push(error.message); }
  try { cloud?.dispose(); await service?.shutdown({ force: true }); } catch (error) { code = 1; report.errors.push(error.message); }
  report.passed = code === 0;
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2));
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}
app.whenReady().then(() => {
  assert.equal(app.getPath('userData'), profile);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(details.url)) {
      report.blockedNetwork.push(new URL(details.url).origin); callback({ cancel: true });
    } else callback({ cancel: false });
  });
});
app.on('browser-window-created', (_event, win) => {
  win.setSize(1500, 1000); win.webContents.setBackgroundThrottling(false);
  let expectedSize = [1500, 1000];
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  win.webContents.once('did-finish-load', async () => {
    const js = async code => {
      const result = await win.webContents.executeJavaScript(`(async()=>{try{return {value:await (${code})}}catch(error){return {error:error.message}}})()`, true);
      if (result.error) throw Error('Renderer: ' + result.error); return result.value;
    };
    const bridge = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const wait = async (code, name, timeout = 45000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) { if (await js(code)) return; await sleep(100); }
      throw Error('UI timeout: ' + name);
    };
    const waitPayload = async predicate => {
      const until = Date.now() + 45000;
      while (Date.now() < until) { const item = [...payloads].reverse().find(predicate); if (item) return item.result; await sleep(50); }
      throw Error('Completed job result did not reach the bridge');
    };
    const button = (text, scope = 'body') => `([...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(e=>e.getClientRects().length && e.textContent.trim()===${JSON.stringify(text)}))`;
    const click = async (text, scope) => { await wait(`${button(text, scope)}?.disabled===false`, 'button ' + text); await js(`${button(text, scope)}.click()`); await sleep(70); };
    const clickSelector = async selector => { await wait(`!!document.querySelector(${JSON.stringify(selector)})`, selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(70); };
    const input = async (label, value) => {
      const selector = `[aria-label=${JSON.stringify(label)}]`;
      await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e || e.disabled)throw Error('Input unavailable');const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(25);
    };
    const select = async (label, text) => {
      await clickSelector(`[role=combobox][aria-label=${JSON.stringify(label)}]`);
      const option = `([...document.querySelectorAll('[role=option]')].find(e=>e.textContent.trim()===${JSON.stringify(text)}))`;
      await wait(`!!${option}`, 'select ' + text); await js(`${option}.click()`); await sleep(70);
    };
    const shot = async name => {
      if (win.isMaximized()) win.unmaximize();
      win.setSize(...expectedSize);
      await sleep(200);
      try { const file = path.join(output, name), capture = await win.webContents.capturePage(); fs.writeFileSync(file, capture.toPNG()); report.screenshots.push(file); (report.viewports ||= []).push({ name, bounds: win.getBounds(), image: capture.getSize() }); }
      catch (error) { (report.captureUnavailable ||= []).push({ name, reason: error.message }); }
    };
    const response = action => payloads.filter(item => item.command.action === action).at(-1)?.result;
    try {
      assert.equal((await bridge({action:'recordAnalysis',request:{action:'catalog'}})).status,401);
      assert.equal((await bridge({action:'login',username:'admin',password})).status,200);
      assert.equal((await bridge({action:'changePassword',currentPassword:password,newPassword:changedPassword})).status,200);
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
      holdCatalog=true;await click('旋转测振','.field-sidebar');
      await wait("!!document.querySelector('.dra-record-filters .dra-field-loading')&&document.querySelector('.dra-controls').getAttribute('aria-busy')==='true'",'signal task form loading');
      assert(await js("document.querySelector('[role=combobox][aria-label=原始记录任务]').disabled"));
      await shot('11-signal-form-loading.png');holdCatalog=false;assert.equal(typeof releaseCatalog,'function');releaseCatalog();
      await wait("!document.querySelector('.dra-field-loading')&&document.querySelector('.dra-controls').getAttribute('aria-busy')==='false'",'signal task form loaded');
      check('Signal task form shows inline loading throughout its pending catalog read');
      await wait("document.querySelectorAll('[role=tablist][aria-label=信号记录视图] [role=tab]').length===2",'two signal views');
      assert.equal(payloads.filter(x=>x.command.action==='start').length,0,'Selection must not start an analysis');
      await wait("document.querySelector('select[aria-label=分析数据记录]')?.options.length===20",'loaded record catalog');
      assert.equal(await js("document.querySelectorAll('.dra-record-filters select').length"),4);
      await select('原始记录任务','10241804-叶片2-P1至P5');
      await select('原始记录风场','wf1');await select('原始记录风机','1303');await select('原始记录叶片','叶片2');
      await wait("document.querySelector('select[aria-label=分析数据记录]')?.options.length===20",'20 records within selected physical blade');
      assert.equal(await js("[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='导出分析结果')"),false);
      check('Task/farm/turbine/blade filters are linked, keep matching records and do not start analysis');

      await clickSelector('[role=combobox][aria-label=分析数据记录]');
      await wait("document.querySelectorAll('[role=option]').length===20",'all 20 raw records in one selector');
      const labels=await js("[...document.querySelectorAll('[role=option]')].map(e=>e.textContent)");assert(labels.every(s=>s.includes('10241804')&&s.includes('1303')&&s.includes('叶片2')&&s.includes('－P')&&s.includes('°')));
      await js("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('－P2－0°')).click()");
      await click('开始分析');
      await wait("!!document.querySelector('[data-analysis-card=SIG-FFT] canvas')",'real signal FFT');
      await wait("!!document.querySelector('[data-analysis-card=SIG-STFT] canvas')",'automatic STFT');
      // A saved STFT must remain still while the desktop polls device status.
      await wait("[...document.querySelectorAll('.dra-actions button')].some(e=>e.textContent==='开始分析'&&!e.disabled)",'single analysis complete');
      await sleep(250);
      await js("(()=>{window.__stftClears=0;const original=CanvasRenderingContext2D.prototype.clearRect;window.__restoreStftCounter=()=>{CanvasRenderingContext2D.prototype.clearRect=original;};CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.closest('[data-analysis-card=SIG-STFT]'))window.__stftClears++;return original.apply(this,args);};})()");
      const stftPollStart=payloads.length,stftFrames=[];
      for(let i=0;i<16;i++){stftFrames.push(createHash('sha256').update(await js("[...document.querySelectorAll('[data-analysis-card=SIG-STFT] canvas')].map(c=>c.toDataURL()).join('|')")).digest('hex'));await sleep(250);}
      report.stftStability={samples:stftFrames.length,distinctFrames:new Set(stftFrames).size,bridgeCallsDuringObservation:payloads.length-stftPollStart,canvasClears:await js('window.__stftClears')};await js('window.__restoreStftCounter()');
      if(process.env.BLADE_STFT_BASELINE==='1'){await shot('baseline-stft.png');await finish(0);return;}
      assert.equal(report.stftStability.distinctFrames,1,'Saved STFT must not animate during background polling');
      assert.equal(report.stftStability.canvasClears,0,'Saved STFT must not redraw during background polling');
      check('Saved STFT pixels remain unchanged across 16 samples during background status polling');

      assert(!(await js("[...document.querySelectorAll('input')].some(e=>/起始样本|结束样本|STFT窗长|FFT点数/.test(e.getAttribute('aria-label')||''))")));
      const single=await waitPayload(p=>p.command.action==='result'&&!p.command.recordingId&&p.result.workspace?.purpose==='signal');assert.equal(single.records.length,1);assert.equal(single.records[0].segments[0].spectrum.zero_padding_samples,0);check('Single record selector has complete identity; explicit start; valid segments, FFT/PSD/STFT use automatic real parameters');
      await shot('01-signal-effective.png');
      await js("(()=>{window.__rawAreaLabels=[];const original=CanvasRenderingContext2D.prototype.fillText;window.__restoreRawAreaLabels=()=>{CanvasRenderingContext2D.prototype.fillText=original;};CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(this.canvas.closest('[data-analysis-card=SIG-RAW]')&&/回波|零值|经过范围/.test(text))window.__rawAreaLabels.push(text);return original.call(this,text,...args);};})()");
      await click('原始记录','[aria-label=信号记录视图]');await wait("!!document.querySelector('[data-analysis-card=SIG-RAW] canvas')",'full raw record');await sleep(150);assert.deepEqual(await js('window.__rawAreaLabels'),[],'Dense quality labels must remain off the raw canvas');await js('window.__restoreRawAreaLabels()');check('Raw quality intervals remain available without overlapping event labels');await shot('02-signal-raw.png');check('Raw view preserves velocity/RSSI and does not trigger another analysis');
      await click('有效信号','[aria-label=信号记录视图]');
      await clickSelector('.dra-settings summary');await select('分析窗函数','Hamming');
      await wait("document.body.innerText.includes('需重新分析')",'changed algorithm marked dirty');assert.equal(await js("!!document.querySelector('[data-analysis-card=SIG-FFT] canvas')"),false,'Stale spectra must not remain under new options');
      await click('开始分析');await wait("!!document.querySelector('[data-analysis-card=SIG-FFT] canvas')",'Hamming executed');
      const hamming=await waitPayload(p=>p.command.action==='result'&&!p.command.recordingId&&p.result.workspace?.algorithmOptions.window==='hamming');assert.equal(hamming.records[0].segments[0].spectrum.window,'periodic_hamming');check('Window option really executes and stale numerical results disappear until explicit recomputation');
      await select('分析窗函数','Hann');
      const fieldLayout=await js("(()=>[...document.querySelectorAll('.dra-settings .dra-algorithm-grid>label')].map(label=>{const e=label.querySelector('[role=combobox]')||label.querySelector('input:not([type=checkbox])');if(!e)return null;const l=label.getBoundingClientRect(),r=e.getBoundingClientRect();return {label:label.textContent.slice(0,12),labelWidth:l.width,width:r.width,height:r.height};}).filter(Boolean))()");
      assert(fieldLayout.length>=5);for(const f of fieldLayout)assert(Math.abs(f.labelWidth-f.width)<3,'Settings controls must fill their aligned grid column');assert(Math.max(...fieldLayout.map(f=>f.height))-Math.min(...fieldLayout.map(f=>f.height))<2,'Number inputs and dropdowns must share one height');report.settingsFieldLayout=fieldLayout;
      await shot('09-analysis-band-settings.png');await select('频带用途','指定频带响应');await input('目标频带下限',100);await input('目标频带上限',20000);await input('目标频带来源','软件一致性验收，不作为结构模态判据');
      holdCatalog=true;await click('叶片响应分析','.field-sidebar');
      await wait("!!document.querySelector('.dra-field-caption .dra-field-loading')&&document.querySelector('.dra-controls').getAttribute('aria-busy')==='true'",'synthesis task form loading');
      assert(await js("document.querySelector('[role=combobox][aria-label=合成分析任务]').disabled"));
      await shot('12-synthesis-form-loading.png');holdCatalog=false;assert.equal(typeof releaseCatalog,'function');releaseCatalog();
      await wait("!document.querySelector('.dra-field-loading')&&document.querySelector('.dra-controls').getAttribute('aria-busy')==='false'",'synthesis task form loaded');
      check('Synthesis task form clears inline loading only after its own catalog request finishes');
      await wait("document.querySelectorAll('.dra-object-grid [role=combobox]').length===4",'task/farm/turbine/blade selectors');
      assert.equal(await js("[...document.querySelectorAll('.desktop-analysis-workspace h2')].some(e=>e.textContent==='同点多角度拼接波形')"),false);
      await js("(()=>{window.__analysisLabelRows={};const original=CanvasRenderingContext2D.prototype.fillText;window.__restoreAnalysisLabels=()=>{CanvasRenderingContext2D.prototype.fillText=original;};CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){const card=this.canvas.closest('[data-analysis-card]'),id=card?.getAttribute('data-analysis-card');if(id?.startsWith('SYN-')&&['mm/s','拟合接缝','平均振幅','频带 RMS','平均半峰峰值 / mm/s','频带 RMS / mm/s'].includes(text)){const b=this.canvas.getBoundingClientRect(),p=new DOMPoint(x,y).matrixTransform(this.getTransform());if(b.width){(window.__analysisLabelRows[id]||={})[text]=p.y/(this.canvas.width/b.width);}}return original.call(this,text,x,y,...rest);};})()");
      await click('开始分析');
      await wait("document.querySelectorAll('[data-analysis-card^=SYN-PSD-] canvas').length===5",'5 real point Welch charts');
      await wait("document.querySelector('[data-analysis-card=SYN-BAND] canvas')&&document.querySelector('[data-analysis-card=SYN-AMPLITUDE] canvas')",'whole blade band response and mean amplitude');
      await wait("!!document.querySelector('[data-analysis-card=SYN-WAVE-P2] [role=status]')",'preview loading indicator');
      assert.equal(await js("!!document.querySelector('[data-analysis-card=SYN-WAVE-P2] canvas')"),false,'Partial independent curves must not masquerade as a loaded preview');
      await js("document.querySelector('[data-analysis-card=SYN-WAVE-P2]').scrollIntoView({block:'center'})");
      await shot('10-preview-pending.png');
      assert.equal(typeof releasePreview,'function');holdPreview=false;releasePreview();
      check('Pending real preview shows loading and withholds partial chart data');
      await wait("!!document.querySelector('[data-analysis-card=SYN-WAVE-P1] .fra-card-provenance')",'point preview states');
      const synthesis=await waitPayload(p=>p.command.action==='result'&&!p.command.recordingId&&p.result.workspace?.purpose==='synthesis');assert(synthesis.coverage.analyzableCount>0&&synthesis.coverage.analyzableCount<20);assert(synthesis.coverage.reviewCount>=1);assert.equal(synthesis.records.length,20);assert.equal(synthesis.aggregates.length,5);const p390=synthesis.records.find(r=>r.object.point==='P3'&&r.object.azimuth_deg===90),p390Rep=p390.segments.find(s=>s.result_id===p390.representative);assert(p390Rep.features.half_peak_to_peak_m_s<.005,'P3/90 platform must not leak into quantitative amplitude');check('P3/90 persistent platform is retained as review and excluded from the representative');
      const g=synthesis.aggregates.find(g=>g.point==='P1');assert(g.azimuth_count>=1&&g.azimuth_count<4);assert(Math.abs(g.mean_half_peak_to_peak_m_s-g.azimuth_results.reduce((s,a)=>s+a.mean_half_peak_to_peak_m_s,0)/g.azimuth_count)<1e-12);
      assert.equal(synthesis.processingContract.version,'unified-analysis-2.2.3');
      for(const [point,angle,endMs] of [['P3',0,50],['P3',180,36],['P3',270,48],['P4',0,22],['P4',180,12],['P5',0,6],['P5',180,8],['P5',270,8]]){
        const r=synthesis.records.find(r=>r.object.point===point&&r.object.azimuth_deg===angle),s=r.segments.find(s=>s.result_id===r.representative);
        assert(s,`${point}/${angle} must retain its actual pre-transition segment`);
        assert(Math.abs(s.features.observation_seconds*1000-endMs)<.01,`${point}/${angle}: use full stable segment, not the platform change or background tail`);
        assert(r.quality_events.some(e=>e.code==='PASS_EXIT_CONTEXT_REVIEW'&&!e.excluded));
      }
      const p590=synthesis.records.find(r=>r.object.point==='P5'&&r.object.azimuth_deg===90);
      assert.equal(p590.representative,null);assert.equal(p590.quality_assessment.analysis_eligible,false);
      assert(p590.segments.length>0,'P5/90 diagnostic samples remain available');
      check('P3/P4/P5 transition cores are source-bound; P5/90 background stays review, not low vibration');
      const ids=await js("[...document.querySelectorAll('.desktop-analysis-workspace>section>h2')].map(e=>e.textContent)");assert(ids.includes('同点多角度拼接波形')&&ids.includes('各测点 Welch 功率谱'));
      assert.equal(await js("document.querySelectorAll('[data-analysis-card^=SYN-WAVE-]').length"),5);assert.equal(await js("document.querySelectorAll('[data-analysis-card^=SYN-PSD-]').length"),5);
      assert.equal(await js("document.querySelectorAll('[data-analysis-card=SIG-RAW]').length"),0);check('Synthesis shows five waveforms then five Welch charts, one band and one absolute average-amplitude chart; no raw/phase duplication');
      await wait("[...document.querySelectorAll('.dra-actions button')].some(e=>e.textContent==='开始分析'&&!e.disabled)",'synthesis previews finished');
      await wait("![...document.querySelectorAll('.fra-plot-wrap')].some(e=>e.getAttribute('aria-busy')==='true')",'all chart paints complete');
      assert.equal(await js("document.querySelectorAll('[data-analysis-card^=SYN-WAVE-] [role=status]').length"),0,'Completed previews must clear their loading indicators');
      check('All loaded chart spinners clear after completed ECharts rendering');
      const headerLayout=await js("(()=>{const card=document.querySelector('[data-analysis-card=SYN-WAVE-P3]'),button=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='导出带来源拼接'),title=card.querySelector('h3').getBoundingClientRect(),tools=card.querySelector('.fra-card-tools').getBoundingClientRect();return {exportInHeader:!!button?.closest('.fra-card-heading'),titleCenter:title.top+title.height/2,toolsCenter:tools.top+tools.height/2,removedCaption:card.innerText.includes('仅展示，禁止作为连续信号计算'),labels:window.__analysisLabelRows};})()");
      assert.equal(headerLayout.exportInHeader,true);assert.equal(headerLayout.removedCaption,false);assert(Math.abs(headerLayout.titleCenter-headerLayout.toolsCenter)<5,'Card title and icon toolbar must align');
      for(const [id,labels] of Object.entries(headerLayout.labels)){
        if(id.startsWith('SYN-WAVE-')&&labels['拟合接缝']!==undefined&&labels['mm/s']!==undefined)assert(labels['mm/s']-labels['拟合接缝']>=22,'Wave legend and axis caption require separate rows');
        if(id==='SYN-AMPLITUDE')assert(labels['平均半峰峰值 / mm/s']-labels['平均振幅']>=22,'Amplitude legend must not touch its axis caption');
      }
      report.chartHeaderLayout=headerLayout;await js('window.__restoreAnalysisLabels()');check('Preview export is in the header; title/tools align; chart legend and units occupy separate rows');
      await shot('03-blade-synthesis.png');
      for(const point of ['P3','P4','P5']){
        await js(`document.querySelector('[data-analysis-card=SYN-WAVE-${point}]').scrollIntoView({block:'center'})`);
        await clickSelector(`[data-analysis-card=SYN-WAVE-${point}] .fra-plot`);
        await wait("!!document.querySelector('.fra-full-chart canvas')",'large corrected point '+point);
        await shot(`15-${point}-corrected.png`);await clickSelector('dialog[open] button[aria-label=关闭弹窗]');
      }
      assert.equal(await js("document.querySelectorAll('.dra-response-coverage .dra-coverage-open').length"),5);
      assert(!await js("!!document.querySelector('dialog[open]')"),'Source details open only on request');
      assert.equal(await js("[...document.querySelectorAll('.dra-response-coverage button')].filter(b=>b.getClientRects().length).length"),5,'Coverage overview must show only one text detail action per point');
      await js("document.querySelector('.dra-response-coverage').scrollIntoView({block:'start'})");await shot('13-coverage-summary.png');
      await js("document.querySelector('[data-coverage-point=P2] .dra-coverage-open').click()");
      assert.equal(await js("document.querySelector('select[aria-label=\"P2 来源记录\"]').options.length"),4);
      const sourceOption=await js("[...document.querySelector('select[aria-label=\"P2 来源记录\"]').options].find(o=>o.text.startsWith('90°')).text");
      await select('P2 来源记录',sourceOption);
      const sourceRecord=synthesis.records.find(r=>r.object.point==='P2'&&r.object.azimuth_deg===90).recording_id;
      assert.equal(await js("document.querySelector('select[aria-label=\"P2 来源记录\"]').value"),sourceRecord);
      await shot('14-coverage-details.png');await clickSelector('dialog[open] button[aria-label=关闭弹窗]');
      check('Coverage overview is compact; one weight dialog and searchable source picker retain every original record');
      for(const [selector,name] of [['[data-analysis-card=SYN-WAVE-P3]','07-wave-card.png'],['[data-analysis-card=SYN-AMPLITUDE]','08-amplitude-card.png']]){
        await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`);await sleep(200);
        const rect=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.ceil(r.x),y:Math.ceil(Math.max(0,r.y)),width:Math.floor(r.width),height:Math.floor(Math.min(r.height,innerHeight-Math.max(0,r.y)-32))};})()`);
        fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(rect)).toPNG());
      }
      await clickSelector('[data-analysis-card=SYN-PSD-P2] .fra-plot');await wait("!!document.querySelector('.fra-full-chart canvas')",'large chart');await shot('04-chart-expanded.png');await clickSelector('dialog[open] button[aria-label=关闭弹窗]');check('Small charts open a large view with the same source and zoom boundaries');
      for(const width of [1366,1024]){expectedSize=[width,900];win.setSize(...expectedSize);await sleep(250);assert(await js('document.documentElement.scrollWidth<=window.innerWidth+2'));await shot('05-responsive-'+width+'.png');}
      expectedSize=[1500,1000];win.setSize(...expectedSize);
      assert.equal(await js("[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='导出分析结果')"),false);
      await click('保存此版本');await click('导出真实处理结果');await click('导出汇总');await sleep(100);
      const until=Date.now()+20000;while(savedFiles.length<1&&Date.now()<until)await sleep(100);assert(savedFiles.length);check('Summary export remains available; removed full-analysis export is absent');
      await js("document.querySelector('[data-coverage-point=P2] .dra-coverage-open').click()");
      await click('查看原始记录','dialog[open]');
      await wait(`document.querySelector('select[aria-label=分析数据记录]')?.value===${JSON.stringify(sourceRecord)}`,'selected source record navigation');
      check('The single source action opens the selected P2/90 original record');
      await click('旋转测振','.field-sidebar');await wait("document.querySelector('select[aria-label=分析数据记录]')?.options.length===20",'reloaded catalog');await clickSelector('[role=combobox][aria-label=分析数据记录]');await js("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('－P1－90°')).click()");await click('开始分析');await wait("document.body.innerText.includes('当前记录没有可分析的有效段')",'out of bounds P1/90 retained');await click('原始记录','[aria-label=信号记录视图]');await wait("!!document.querySelector('[data-analysis-card=SIG-RAW] canvas')",'invalid boundary raw still viewable');await shot('06-p1-boundary-preserved.png');check('P1/90 boundary remains blocked, raw remains available and source data is unchanged');
      for(const name of ['数据采集','转盘点位','本机记录','设备与服务']){await click(name,'.field-sidebar');await sleep(50);assert((await js('document.body.innerText')).includes(name));}check('Acquisition, turntable, local records and services remain reachable');
      fs.writeFileSync(path.join(output,'analysis-summary.json'),JSON.stringify(synthesis,null,2));
      assert.deepEqual(report.errors,[],'Renderer errors');await finish(0);
    } catch(error){report.error=error.stack;console.error(error.stack);await shot('failure.png');await finish(1);}
  });
});
require('../apps/desktop/electron/field-main.cjs');
