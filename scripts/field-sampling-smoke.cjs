// Production UI + IPC, isolated account/data and fixture service. No hardware or Web calls.
'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/upload-sampling-20261022');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-sampling-ui-')));
delete process.env.BLADE_DEV_URL;
const initial = randomBytes(24).toString('base64url'), changed = randomBytes(24).toString('base64url'), salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(initial, salt, 64).toString('hex') } };
const record = { id: 'a'.repeat(32), name: 'P4 · 图表加载检查', source: 'polytec_ivs500', status: 'complete',
  samples: 250000, sampleRate: 250000, startedAt: 1800000000, endedAt: 1800000001 };
const waveform = { values: [], rssi: [], overrange: [], sampleRate: 250000, sampleStart: 0, sampleOrigin: 1800000000,
  rangeStart: 0, rangeEnd: 250000, sourceSamples: 250000, representation: 'envelope',
  envelope: Array.from({ length: 500 }, (_, i) => ({ start: i * 500, end: (i + 1) * 500,
    min: Math.sin(i / 12) * .01 - .002, max: Math.sin(i / 12) * .01 + .002, rssiMin: 50, rssiMax: 80, missing: 0, overrange: 0 })) };
const info = () => ({ state: 'ready', dllConfigured: true, executable: 'UI-FIXTURE-NO-HARDWARE' });
const snapshot = () => ({ state: 'idle', service: info(), receiver: { running: false } });
let resolveWave;
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => snapshot(), status: async () => snapshot(), frame: async () => snapshot(),
    shutdown: async () => {}, recordings: async id => id ? { recording: record } : { recordings: [record] },
    waveform: () => new Promise(resolve => { resolveWave = () => resolve({ recording: record, waveform }); }) }) } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win; const report = { hardwareAccessed: false, checks: [] };
const watchdog = setTimeout(() => finish(Error('Sampling UI watchdog')), 60000);
function finish(error) { clearTimeout(watchdog); report.passed = !error; if (error) report.error = error.stack;
  fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(error ? 1 : 0); }
app.on('browser-window-created', (_, current) => {
  if (win) return; win = current; win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const wait = async expression => { for (let i = 0; i < 120; i++) { if (await js(expression)) return; await pause(50); } throw Error('Missing: ' + expression); };
    const click = text => js(`(() => { const el = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)} && el.getClientRects().length && !el.disabled); if (!el) throw Error('Missing button '+${JSON.stringify(text)}); el.click(); })()`);
    try {
      await wait(`document.body.innerText.includes('登录现场工作台')`);
      assert.equal((await field({ action: 'login', username: 'admin', password: initial })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: initial, newPassword: changed })).status, 200);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait(`!!document.querySelector('.field-sidebar')`); await click('设备与服务');
      await wait(`!!document.querySelector('button[aria-label="上传采样率"]')`);
      await js(`document.querySelector('button[aria-label="上传采样率"]').click()`);
      await wait(`!!document.querySelector('[role="option"]')`);
      await js(`[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === '10 kHz').click()`);
      await wait(`document.querySelector('button[aria-label="上传采样率"]').textContent.includes('10 kHz')`);
      assert.equal((await field({ action: 'syncStatus' })).data.uploadSampleRate, 10000);
      report.checks.push('Custom select writes upload sample rate through real IPC');
      for (const width of [1440, 1024]) {
        win.setMinimumSize(640, 480); win.setContentSize(width, 900); await pause(200);
        await js(`document.querySelector('.field-upload-sampling').scrollIntoView({block:'center'})`);
        assert.ok(await js(`document.body.scrollWidth <= innerWidth + 2`));
        fs.writeFileSync(path.join(output, `settings-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await click('本机记录'); await wait(`document.body.innerText.includes('P4 · 图表加载检查')`); await click('查看波形');
      await wait(`!!document.querySelector('.field-recording-dialog .chart-loading')`);
      fs.writeFileSync(path.join(output, 'chart-loading.png'), (await win.webContents.capturePage()).toPNG());
      for (let i = 0; i < 100 && !resolveWave; i++) await pause(30);
      assert.ok(resolveWave); resolveWave();
      await wait(`!document.querySelector('.field-recording-dialog .chart-loading') && !!document.querySelector('.field-recording-dialog svg')`);
      fs.writeFileSync(path.join(output, 'chart-loaded.png'), (await win.webContents.capturePage()).toPNG());
      report.checks.push('Recording dialog reserves chart area during read then shows bounded waveform');
      finish();
    } catch (error) { finish(error); }
  });
});
require(path.join(root, 'apps/desktop/electron/field-main.cjs'));
