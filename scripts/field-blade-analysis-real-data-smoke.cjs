'use strict';
// Actual exported measurements in an isolated desktop profile. Never contacts hardware/cloud.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const input = path.resolve(process.argv[2] || 'artifacts/blade2-five-point-audit-20261027/imported-recordings');
const output = path.resolve(process.argv[3] || 'artifacts/blade2-five-point-audit-20261027/desktop');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-real-pass-review-'));
app.setPath('userData', profile);
fs.mkdirSync(output, { recursive: true });
const target = path.join(profile, 'field-data', 'recordings');
fs.mkdirSync(target, { recursive: true });
const sourceIds = fs.readdirSync(input).filter(id => /^[0-9a-f]{32}$/.test(id));
assert.equal(sourceIds.length, 20, 'This acceptance case requires the five real four-angle packages');
for (const id of sourceIds) fs.cpSync(path.join(input, id), path.join(target, id), { recursive: true });
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
const password = randomBytes(24).toString('hex'), nextPassword = randomBytes(24).toString('hex'), salt = randomBytes(32).toString('hex');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const serviceModule = require('../apps/desktop/electron/field-service.cjs');
const factory = serviceModule.createFieldService;
const results = [];
serviceModule.createFieldService = options => {
  const service = factory(options);
  for (const method of ['begin', 'device', 'rssiCalibration', 'turntable', 'singlePoint', 'motionTrial']) {
    service[method] = async () => { throw Error('Read-only data review: hardware operations disabled'); };
  }
  const analyze = service.bladePasses;
  service.bladePasses = async parameters => {
    console.log('Analysis request', parameters.recordingIds.length, 'records');
    const started = Date.now();
    try { const result = await analyze(parameters); results.push(result); console.log('Analysis response', Date.now() - started, 'ms'); return result; }
    catch (error) { console.error('Analysis failed', error.message); throw error; }
  };
  return service;
};
delete process.env.BLADE_DEV_URL;
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('Real data review timed out'); app.exit(1); }, 120000);
app.on('browser-window-created', (_event, win) => {
  win.setSize(1500, 1000);
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const wait = async code => { for (let n = 0; n < 600; n++) { if (await js(code)) return; await sleep(100); } throw Error(`UI timeout: ${code}`); };
    const clickText = text => js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
    const shot = async name => { await sleep(150); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
    try {
      assert.equal((await field({ action: 'bladePasses', parameters: { recordingIds: sourceIds } })).status, 401);
      assert.equal((await field({ action: 'login', username: 'admin', password })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: password, newPassword: nextPassword })).status, 200);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait("!![...document.querySelectorAll('.field-sidebar button')].find(b=>b.textContent==='叶片片段分析')");
      await clickText('叶片片段分析');
      await wait("document.querySelectorAll('.blade-pass-point-group').length===5");
      assert.equal(await js("document.querySelectorAll('select[aria-label=采集任务] option').length"), 1);
      assert.equal(await js("document.querySelector('input[aria-label=纳入诊断数据分析]').checked"), false);
      assert.equal(await js("document.querySelector('button[type=submit]').disabled"), true);
      checks.push('One logical task, one blade and five radial points; diagnostic samples excluded by default');
      await js("document.querySelector('input[aria-label=纳入诊断数据分析]').click()");
      await wait("!document.querySelector('button[type=submit]').disabled");
      await shot('01-task-selection.png');
      await clickText('筛选并分析');
      await wait("document.body.innerText.includes('有效数据汇总')");
      const result = results.at(-1);
      assert.ok(result && result.hasDiagnostic);
      assert.equal(result.coverage.selectedRecords, 20);
      assert.equal(result.coverage.includedRecords, 19);
      assert.equal(result.coverage.excludedRecords, 1);
      assert.equal(result.synthesis.mergedPoints.length, 5);
      assert.ok(result.sources.find(item => item.radialPointName === 'P1' && item.azimuthDeg === 90 && item.status === 'excluded'));
      assert.ok(result.synthesis.mergedPoints.every(point => !point.stitchedSpectrum && point.independentSpectrum));
      checks.push('Actual Python analysis: 19 included / 1 boundary-incomplete excluded, five-point synthesis, independent segment spectra');
      fs.writeFileSync(path.join(output, 'analysis.json'), JSON.stringify(result, null, 2));
      await js("document.querySelector('.blade-pass-results').scrollIntoView({block:'start'})");
      await shot('02-analysis-summary.png');
      await js("[...document.querySelectorAll('h2')].find(h=>h.textContent.includes('有效波形')).closest('section').scrollIntoView({block:'start'})");
      await shot('03-waveform-review.png');
      win.setSize(1024, 850);
      await sleep(180);
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'), true);
      checks.push('1024 px layout has no page-wide overflow');
      await js("document.querySelector('.blade-pass-setup').scrollIntoView({block:'start'})");
      await shot('04-narrow.png');
      assert.deepEqual(errors, []);
      fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ passed: true, hardwareUsed: false,
        productionProfileTouched: false, source: input, checks }, null, 2));
      console.log(checks.map(item => 'PASS ' + item).join('\n'));
      clearTimeout(watchdog);
      win.close();
    } catch (error) {
      console.error(error);
      fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack }, null, 2));
      await shot('error.png'); clearTimeout(watchdog); app.exit(1);
    }
  });
});
require('../apps/desktop/electron/field-main.cjs');
