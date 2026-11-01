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
const source = path.resolve(process.argv[2] || path.join(root, '../1309_三叶片四角度方法复测_2026-11-01'));
const output = path.resolve(process.argv[3] || path.join(root, 'artifacts/measurement-modes-20261101/desktop-ui'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-record-analysis-'));
const target = path.join(profile, 'field-data', 'recordings');
const report = { passed: false, hardwareUsed: false, productionProfileTouched: false, source, checks: [], screenshots: [], errors: [], requests: [], blockedNetwork: [] };
const payloads = [];
let service, cloud;
let releasePreview, holdPreview = false;
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
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
function hashes(directory) {
 const result={};function visit(p,rel=''){for(const name of fs.readdirSync(p).sort()){const f=path.join(p,name),k=path.join(rel,name);if(fs.statSync(f).isDirectory())visit(f,k);else result[k]=createHash('sha256').update(fs.readFileSync(f)).digest('hex');}}visit(directory);return result;
}
const before=hashes(source);
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
    check('Original outdoor package retains every SHA-256 value');
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
      assert.equal((await bridge({action:'login',username:'admin',password})).status,200);
      assert.equal((await bridge({action:'changePassword',currentPassword:password,newPassword:changedPassword})).status,200);
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
      await click('叶片响应分析','.field-sidebar');
      await click('导入户外分段');await click('选择文件夹');
      await wait("document.querySelectorAll('.outdoor-import-files tbody tr').length===12",'12 file preview');
      await input('户外任务名称','1309_三叶片四角度方法复测_2026-11-01');
      await input('户外风场','wf1');await input('户外风机','1309');
      await shot('01-import-twelve-segments.png');
      await click('建立户外任务');
      await wait("!document.querySelector('.outdoor-import-dialog')",'import committed');
      await wait("document.querySelector('select[aria-label=测量模式]')?.value==='outdoor'",'outdoor mode restored');
      const catalog=(await bridge({action:'recordAnalysis',request:{action:'catalog'}})).data;
      report.catalog=catalog;
      await shot('02-outdoor-task.png');
      // The workflow analyzes the selected blade; inspect all three separately.
      for(const blade of ['1','2','3']){
        if(blade!=='1')await select('合成分析叶片','叶片'+blade);
        const from=payloads.length;
        await click('开始分析');
        await wait("!!document.querySelector('[data-analysis-card=SYN-WAVE-P1] canvas') && !document.querySelector('[data-analysis-card=SYN-WAVE-P1] [role=status]')",'stitched P1 blade '+blade,60000);
        await wait("!!document.querySelector('[data-analysis-card=SYN-AMPLITUDE] canvas') && !!document.querySelector('[data-analysis-card=SYN-PSD-P1] canvas') && !!document.querySelector('[data-analysis-card=SYN-BAND] canvas')",'all single-point charts');
        await wait("[...document.querySelectorAll('.dra-actions button')].some(e=>e.textContent==='开始分析'&&!e.disabled)",'analysis completed');
        const job=payloads.slice(from).filter(x=>x.command.action==='result'&&!x.command.recordingId&&x.result.workspace?.purpose==='synthesis').at(-1)?.result;
        assert(job);assert.equal(job.measurementMode,'outdoor');assert.equal(job.records.length,4);assert.equal(job.coverage.analyzableCount,4);
        const preview=payloads.slice(from).filter(x=>x.command.action==='preview').at(-1)?.result;
        assert(preview);assert.equal(preview.joins.length,3);assert.equal(preview.blocks.filter(b=>b.kind==='measured_processed').length,4);
        assert.equal(preview.series.filter(b=>b.kind==='synthetic_display_transition').length,3);assert(preview.series.every(b=>b.values_m_s.every(Number.isFinite)));
        (report.blades||=[]).push({blade,jobId:job.jobId,coverage:job.coverage,joins:preview.joins,amplitude:job.aggregates.map(a=>a.mean_half_peak_to_peak_m_s)});
        await js("document.querySelector('[data-analysis-card=SYN-WAVE-P1]').scrollIntoView({block:'start'})");await shot('03-blade-'+blade+'-waveform.png');
        await js("document.querySelector('[data-analysis-card=SYN-AMPLITUDE]').scrollIntoView({block:'center'})");await shot('04-blade-'+blade+'-single-point.png');
        await click('保存此版本');
        check('Blade '+blade+': four real angles, three fitted joins, PSD/band/amplitude with unknown radius');
      }
      await click('旋转测振','.field-sidebar');
      await wait("document.querySelector('select[aria-label=分析数据记录]')?.options.length===12",'12 selectable raw records');
      await click('开始分析');
      await wait("!!document.querySelector('[data-analysis-card=SIG-STFT] canvas')",'outdoor single-angle STFT',60000);
      await js("document.querySelector('[data-analysis-card=SIG-STFT]').scrollIntoView({block:'center'})");await shot('05-angle-spectrum-stft.png');
      check('Outdoor original records, FFT, Welch and STFT render through the native desktop workflow');
      fs.writeFileSync(path.join(output,'bridge-results.json'),JSON.stringify(payloads));
      await finish(0);
    } catch (error) { report.error=error.stack||String(error);console.error(error);await finish(1); }
  });
});
require('../apps/desktop/electron/field-main.cjs');
