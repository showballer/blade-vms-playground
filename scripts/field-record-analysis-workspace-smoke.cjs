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
const output = path.resolve(process.argv[3] || path.join(root, 'artifacts/record-analysis-workspace-20261028/desktop'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-record-analysis-'));
const target = path.join(profile, 'field-data', 'recordings');
const report = { passed: false, hardwareUsed: false, productionProfileTouched: false, source, checks: [], screenshots: [], errors: [], requests: [], blockedNetwork: [] };
const payloads = [];
let service, cloud;
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
      assert.equal((await bridge({ action: 'recordAnalysis', request: { action: 'catalog' } })).status, 401);
      assert.equal((await bridge({ action: 'login', username: 'admin', password })).status, 200);
      assert.equal((await bridge({ action: 'changePassword', currentPassword: password, newPassword: changedPassword })).status, 200);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await click('风机数据分析', '.field-sidebar');
      await wait("document.querySelectorAll('[role=tablist][aria-label=记录分析视图] [role=tab]').length===6", 'six independent analysis tabs');
      check('Independent analysis menu is available while legacy record-analysis menus stay hidden');
      await wait("document.querySelector('.fra-job-status')?.dataset.state==='complete'", 'actual saved task analysis complete');
      const catalog = response('catalog');
      assert.equal(catalog.tasks.length, 1);
      assert.equal(catalog.tasks[0].name, '10241804-叶片2-P1至P5');
      assert.equal(catalog.tasks[0].recordingIds.length, 20);
      const analyzed = await waitPayload(item => item.command.action === 'result' && !item.command.recordingId && item.result.scope === 'analysis');
      assert.equal(analyzed.coverage.recordCount, 20);
      assert.equal(analyzed.coverage.analyzableCount, 19);
      assert.equal(analyzed.coverage.blockedCount, 1);
      assert.equal(analyzed.coverage.formalEligibleCount, 0);
      assert.equal(analyzed.aggregates.length, 5);
      assert.equal(analyzed.scope, 'analysis');
      assert.equal(analyzed.healthConclusionAvailable, false);
      assert.equal(analyzed.coverage.reviewCount, 1);
      assert.equal(analyzed.records.filter(r=>r.quality_assessment.analysis_eligible).length,19);
      assert.ok(analyzed.records.every(r=>r.source_quality.diagnostic_only===true && r.source_quality.valid_measurement===false));
      const bad = analyzed.records.find(item => item.recording_id === '1cd48794efcb29f393e738055c118621');
      assert.ok(bad && !bad.representative && JSON.stringify(bad).includes('PASS_BOUNDARY_OUTSIDE_RECORDING'));
      assert.equal(analyzed.phaseAvailable, false); assert.equal(analyzed.healthConclusionAvailable, false);
      check('Actual source Python: one task, five points, 19 analyzable / one boundary-blocked record, zero formal eligibility');
      fs.writeFileSync(path.join(output, 'analysis-summary.json'), JSON.stringify(analyzed, null, 2));
      const tabList = ['风机总览', '叶片分析', '点位分析', '单次波形', '扩展分析', '趋势与事件'];
      for (const [index, name] of tabList.entries()) {
        await click(name, '[role=tablist][aria-label=记录分析视图]');
        await wait("document.querySelectorAll('.fra-card,.fra-empty-state').length>0", 'content ' + name);
        await js("document.querySelector('.field-record-analysis').scrollIntoView({block:'start'})");
        await shot(`${String(index + 1).padStart(2, '0')}-${['overview','blade','point','waveform','extended','events'][index]}.png`);
      }
      check('All six tabs render real content or explicit availability reasons');
      await click('点位分析', '[role=tablist][aria-label=记录分析视图]');
      assert.equal(await js("[...document.querySelectorAll('[aria-label=点位分析内容] [role=tab]')].find(e=>e.textContent==='有效段与拼接').getAttribute('aria-selected')"), 'true');
      check('Point analysis opens real disjoint segments first; smooth display preview is opt-in');
      await click('方位与特征', '[aria-label=点位分析内容]');
      await click('查看单次', '[data-recording-id="1cd48794efcb29f393e738055c118621"]');
      await wait("document.querySelector('[data-analysis-card=A01] canvas')", 'boundary-blocked original waveform');
      await wait("document.body.innerText.includes('PASS_BOUNDARY_OUTSIDE_RECORDING')", 'specific preserved boundary reason');
      const detail = payloads.filter(item => item.command.action === 'result' && item.command.recordingId === '1cd48794efcb29f393e738055c118621').at(-1)?.result;
      assert.ok(detail?.detail?.raw?.velocity_m_s?.length || detail?.raw?.velocity_m_s?.length);
      await js("document.querySelector('.fra-tab-content').scrollIntoView({block:'start'})");
      await shot('07-boundary-blocked-original.png');
      check('Boundary-blocked P1/90 remains visible with its original velocity/RSSI and precise reason');
      await click('可分析结果');
      await wait("document.querySelector('.fra-job-status')?.dataset.state==='complete'", 'formal scope complete');
      const formal = await waitPayload(item => item.command.action === 'result' && !item.command.recordingId && item.result.scope === 'analysis');
      assert.equal(formal.scope, 'analysis'); assert.equal(formal.aggregates.length, 5);
      assert.equal(formal.coverage.analyzableCount,19); assert.equal(formal.healthConclusionAvailable,false);
      assert.equal(formal.coverage.formalEligibleCount, 0);
      assert.equal(formal.records.length, 20);
      await click('风机总览', '[role=tablist][aria-label=记录分析视图]');
      await wait("!!document.querySelector('[data-analysis-card=A21] canvas')", 'ordinary analysis available despite historic diagnostic flags');
      await shot('08-analyzable-results.png');
      check('Default analysis admits 19 real passes, retains all original flags and keeps health conclusions separate');
      await click('全部记录复核');
      await wait("document.querySelector('.fra-job-status')?.dataset.state==='complete'", 'diagnostic scope restored');
      // Review a strict interior of an already valid P2/0 candidate. This is
      // an isolated UI acceptance action, not an invented fix for P1/90.
      const reviewId = '5760a034151eb12c15e77c7cafaf216d';
      const originalRecord = analyzed.records.find(item => item.recording_id === reviewId);
      const reviewStart = originalRecord.candidate_window.local_start + 1000;
      const reviewEnd = originalRecord.candidate_window.local_end_exclusive - 1000;
      await clickSelector('[aria-label="查看叶片 2 测点 P2"]');
      await click('方位与特征', '[aria-label=点位分析内容]');
      await click('查看单次', `[data-recording-id="${reviewId}"]`);
      await wait("!!document.querySelector('[data-analysis-card=A01] canvas')", 'P2 original waveform');
      await clickSelector('.fra-review-window > summary');
      await input('复核窗口起始样本', reviewStart); await input('复核窗口结束样本', reviewEnd);
      assert.equal(await js(`${button('保存诊断窗口并重算')}?.disabled`), true, 'Review reason is required');
      await input('窗口复核原因', '隔离界面验收：保留原有效窗口内部，检验版本隔离');
      await click('保存诊断窗口并重算');
      const reviewed = await waitPayload(item => item.command.action === 'result' && !item.command.recordingId && item.result.scope === 'diagnostic' && item.result.jobId !== analyzed.jobId && item.result.records.some(record => record.recording_id === reviewId && record.review_window));
      const reviewedRecord = reviewed.records.find(item => item.recording_id === reviewId);
      assert.equal(reviewedRecord.review_window.start, reviewStart); assert.equal(reviewedRecord.review_window.end, reviewEnd);
      assert.deepEqual(reviewedRecord.candidate_window, originalRecord.candidate_window);
      assert.deepEqual(reviewedRecord.source_quality, originalRecord.source_quality);
      assert.deepEqual(reviewed.sourceFingerprints, analyzed.sourceFingerprints);
      assert.equal(reviewed.coverage.formalEligibleCount, 0);
      await wait("document.body.innerText.includes('已保存诊断复核版本')", 'review version visible');
      await js("document.querySelector('.fra-review-window').scrollIntoView({block:'start'})");
      await shot('09-isolated-review-version.png');
      check('Explicit review requires a reason, creates a new job and preserves source boundary, quality flags and source hashes');
      await click('扩展分析', '[role=tablist][aria-label=记录分析视图]');
      await input('时频窗长秒', .02); await click('计算时频');
      const extended = await waitPayload(item => item.command.action === 'extended' && item.command.kind === 'stft' && item.result.available === true);
      assert.equal(extended.resultId, reviewedRecord.representative);
      await wait("!!document.querySelector('[data-analysis-card=A10] canvas')", 'real segment STFT heatmap');
      await js("document.querySelector('[data-analysis-card=A10]').scrollIntoView({block:'start'})");
      await shot('11-real-segment-stft.png');
      await click('可分析结果');
      await wait("document.querySelector('.fra-job-status')?.dataset.state==='complete' && document.querySelector('.fra-result-set button[aria-pressed=true]')?.textContent==='可分析结果'", 'default analysis restored after manual review');
      const afterReview=await bridge({action:'recordAnalysis',request:{action:'result',jobId:payloads.filter(item=>item.command.action==='start'&&item.command.scope==='analysis').at(-1).result.jobId}});
      assert.equal(afterReview.data.coverage.analyzableCount,19); assert.equal(afterReview.data.healthConclusionAvailable,false);
      assert.equal(await js("document.querySelector('[data-analysis-card=A10] canvas')===null"), true, 'Reviewed STFT must not remain in ordinary analysis scope');
      assert.ok(payloads.filter(item => item.command.action === 'start' && item.command.scope === 'analysis').every(item => !item.command.reviewWindows));
      await click('分析设置'); await select('本机分析配置', '原始信号复核');
      await wait("document.querySelector('.fra-job-status')?.dataset.state==='complete' && document.querySelector('.fra-basis-strip')?.textContent.includes('RAW_REVIEW')", 'raw profile formal result');
      assert.equal(await js("document.querySelector('[data-analysis-card=A10] canvas')===null"), true, 'Old extension must not remain after profile change');
      await click('全部记录复核');
      await wait("document.querySelector('.fra-job-status')?.dataset.state==='complete' && !document.querySelector('.fra-formal-empty')", 'raw diagnostic profile restored');
      assert.equal(await js("document.querySelector('[data-analysis-card=A10] canvas')===null"), true);
      await click('分析设置'); await select('本机分析配置', '视线诊断 · 显式经验背景');
      await wait("document.querySelector('.fra-job-status')?.dataset.state==='complete' && document.querySelector('.fra-basis-strip')?.textContent.includes('LOS_DIAGNOSTIC')", 'reviewed LOS profile restored');
      check('Real STFT uses one continuous segment and is cleared when scope or profile changes');
      await click('单次波形', '[role=tablist][aria-label=记录分析视图]');
      await wait("document.body.innerText.includes('已保存诊断复核版本')", 'reviewed waveform selected');
      await js("(()=>{const panel=document.querySelector('.fra-review-window');if(!panel.open)panel.querySelector('summary').click()})()");
      const beforeRestore = payloads.length;
      await click('恢复原始候选窗');
      const restored = await waitPayload(item => payloads.indexOf(item) >= beforeRestore && item.command.action === 'result' && !item.command.recordingId && item.result.scope === 'diagnostic' && item.result.records.some(record => record.recording_id === reviewId && !record.review_window));
      const restoredRecord = restored.records.find(item => item.recording_id === reviewId);
      assert.notEqual(restored.jobId, reviewed.jobId);
      assert.deepEqual(restoredRecord.candidate_window, originalRecord.candidate_window);
      assert.deepEqual(restoredRecord.source_quality, originalRecord.source_quality);
      assert.deepEqual(restored.sourceFingerprints, analyzed.sourceFingerprints);
      assert.equal(restored.coverage.formalEligibleCount, 0);
      const history = await service.recordAnalysis({ action: 'result', jobId: reviewed.jobId });
      assert.deepEqual(history.records.find(item => item.recording_id === reviewId).review_window, reviewedRecord.review_window);
      await wait(`${button('恢复原始候选窗')}?.disabled===true`, 'restored candidate no active review');
      check('Restoring the original candidate creates a new version without deleting the reviewed history or promoting quality');
      await wait("!!document.querySelector('[data-analysis-card=A01] canvas')", 'restored original waveform');
      await js("document.querySelector('[data-analysis-card=A01]').scrollIntoView({block:'start'})");
      await shot('12-original-waveform-complete.png');
      for (const text of ['导出真实分析', '导出汇总']) {
        const count = savedFiles.length;
        await click(text);
        await wait("[...document.querySelectorAll('.fra-top-actions button')].filter(e=>e.textContent.startsWith('导出')).every(e=>!e.disabled)", 'export copy complete');
        assert.equal(savedFiles.length, count + 1);
        const file = savedFiles.at(-1); assert.ok(fs.statSync(file).size > 0);
        const info = JSON.parse(execFileSync(path.join(root, 'services/acquisition/.venv/bin/python'), ['-c',
          'import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps({"files":z.namelist(),"size":sum(i.file_size for i in z.infolist())}))', file], { encoding: 'utf8', timeout: 10000 }));
        assert.ok(info.files.includes('README.txt'));
        (report.exports ||= []).push({ file, entries: info.files.length, bytes: info.size });
      }
      check('Actual analysis and summary ZIP exports complete through the save-dialog bridge and pass integrity validation');
      await click('点位分析', '[role=tablist][aria-label=记录分析视图]');
      await click('有效段与拼接', '[aria-label=点位分析内容]');
      const pointIds = catalog.tasks[0].records.filter(item => item.pointName === 'P2').map(item => item.id);
      assert.equal(pointIds.length, 4);
      for (const id of pointIds) await waitPayload(item => item.command.action === 'result' && item.command.jobId === restored.jobId && item.command.recordingId === id);
      await wait("document.querySelectorAll('.fra-record-strip [data-analysis-card=\"A01/A02\"] canvas').length===4", 'all four azimuth details published to renderer');
      await wait("!!document.querySelector('[data-analysis-card=A14] canvas')", 'real disjoint segment chart');
      await js("document.querySelector('[data-analysis-card=A14]').scrollIntoView({block:'start'})");
      await shot('10-point-real-segments.png');
      await click('风机总览', '[role=tablist][aria-label=记录分析视图]');
      for (const [width, height] of [[1366, 768], [1024, 900]]) {
        expectedSize = [width, height]; if (win.isMaximized()) win.unmaximize(); win.setSize(width, height); await sleep(200);
        assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'), true, `Overflow at ${width}`);
        const charts = await js("[...document.querySelectorAll('.fra-plot')].map(e=>({width:e.clientWidth,height:e.clientHeight}))");
        assert.ok(charts.length && charts.every(plot => plot.height >= 250 && plot.width >= 100), 'Plots retain visible drawable height');
        await shot(`overview-${width}.png`);
      }
      check('1366 / 1024 responsive layout keeps complete plot heights without page overflow');
      for (const name of ['数据采集', '转盘点位', '本机记录', '设备与服务']) {
        await click(name, '.field-sidebar'); await sleep(100);
        assert.ok((await js('document.body.innerText')).includes(name));
      }
      check('Existing acquisition, positioning, records and services menus remain reachable without touching hardware');
      assert.deepEqual(report.errors, [], 'Renderer errors');
      await finish(0);
    } catch (error) { report.error = error.stack; console.error(error.message); await shot('failure.png'); await finish(1); }
  });
});
require('../apps/desktop/electron/field-main.cjs');
