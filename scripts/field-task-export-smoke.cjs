// Exercise the production Electron UI/IPC with isolated fixture records. No hardware.
// Run after the desktop build: electron scripts/field-task-export-smoke.cjs
'use strict';
const { app, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/task-export-ui');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-task-export-ui-'));
app.setPath('userData', profile);
delete process.env.BLADE_DEV_URL;
const initial = randomBytes(24).toString('base64url'), changed = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(initial, salt, 64).toString('hex') } };
function record(n, blade = '1', point = 'P1', lap = 1, collection = 'a'.repeat(32)) {
  const station = { pointId: point+'-s1', bladeId: blade, radialPointId: point, radialPointName: point, radiusM: .31,
    stationIndex: 1, stationCount: 1, azimuthDeg: 0 };
  return { id: n.toString(16).padStart(32, '0'), name: '1号风机叶片检测', source: 'polytec_ivs500',
    windFarm: 'WF-001', turbine: 'WT-001', object: '风机叶片', point, samples: 1000, sampleRate: 1000,
    startedAt: 1792555200+n*60, endedAt: 1792555201+n*60, status: 'complete',
    pointCycle: { ...station, mode: 'automatic_stations', collectionId: collection, sessionId: n.toString(16).padStart(32, 'f'),
      cycle: lap, cycles: 2, lapIndex: lap, pointIndex: 1, pointName: '点位1', dwellSeconds: 5,
      targetAxis1AngleDeg: 10, targetAxis2AngleDeg: 0, completion: 'confirmed_pass', plannedStations: [station] } };
}
const records = [record(1), record(2, '1', 'P1', 2), record(3, '1', 'P2'), record(4, '2'), record(5, '2', 'P1', 1, 'b'.repeat(32))];
const calls = [];
let cancelDialog = false;
dialog.showSaveDialog = async (_win, options) => {
  assert.equal(options.filters[0].extensions[0], 'zip');
  return cancelDialog ? { canceled: true } : { canceled: false, filePath: path.join(profile, options.defaultPath) };
};
const info = () => ({ state: 'ready', dllConfigured: true, executable: 'TEST-ONLY' });
const status = () => ({ state: 'idle', service: info(), turntableBusy: false, receiver: { running: false } });
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, code = 503) => Object.assign(Error(message), { status: code }),
  createFieldService: () => ({ serviceInfo: info, start: async () => status(), status: async () => status(), frame: async () => status(),
    recordings: async id => id ? { recording: records.find(record => record.id === id) } : { recordings: records },
    exportTask: async (ids, file, level) => { calls.push({ ids, file: path.basename(file), level });
      await new Promise(resolve => setTimeout(resolve, 150));
      return { saved: true, fileName: path.basename(file), recordCount: ids.length }; },
    device: async request => { assert.equal(request.action, 'laser_read'); return { laserOn: false, readAt: Date.now()/1000 }; },
    shutdown: async () => {},
  }),
} };
const report = { passed: false, hardwareTouched: false, realServiceStarted: false, checks: [], screenshots: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function finish(error) { report.passed = !error; if (error) { report.error = error.stack; console.error(error); }
  report.exports = calls; fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); app.exit(error ? 1 : 0); }
setTimeout(() => finish(Error('Task export UI timed out')), 60000);
let win;
app.on('browser-window-created', (_, current) => {
  if (win) return; win = current; win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const wait = async (source, label) => { for (let i=0;i<120;i++) { if (await js(source)) return; await pause(60); } throw Error('Timed out: '+label); };
    const click = text => js(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)} && el.getClientRects().length && !el.disabled); if(!button) throw Error('Missing '+${JSON.stringify(text)}); button.click(); })()`);
    const settled = () => wait(`!document.body.innerText.includes('正在导出…')`, 'export settled');
    try {
      await wait(`document.body.innerText.includes('登录现场工作台')`, 'login');
      assert.equal((await field({ action: 'login', username: 'admin', password: initial })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: initial, newPassword: changed })).status, 200);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait(`!!document.querySelector('.field-sidebar')`, 'workspace');
      await click('本机记录');
      await wait(`!!document.querySelector('[aria-label="筛选采集任务"]')`, 'task selector');
      // Use the real custom select's menu rather than setting React state.
      await js(`document.querySelector('button[aria-label="筛选采集任务"]').click()`);
      await wait(`!!document.querySelector('[role="option"]')`, 'select menu');
      await js(`([...document.querySelectorAll('[role="option"]')].find(el => el.textContent.includes('4 条'))).click()`);
      await click('导出任务 ZIP');
      await wait(`document.body.innerText.includes('已导出任务数据包')`, 'task result');
      assert.deepEqual(calls.at(-1).ids.sort(), records.slice(0,4).map(record => record.id).sort());
      assert.equal(calls.at(-1).level, 'task'); report.checks.push('Task filter exports only selected task despite same names');
      for (const width of [1440, 1024]) {
        win.setMinimumSize(640, 480); win.setContentSize(width, 900); await pause(200);
        assert.ok(await js(`document.body.scrollWidth <= innerWidth + 2`));
        fs.writeFileSync(path.join(output, `records-${width}.png`), (await win.webContents.capturePage()).toPNG());
        report.screenshots.push(`records-${width}.png`);
      }
      await click('叶片采集汇总');
      await js(`document.querySelector('button[aria-label="导出叶片 1全部数据"]').click()`);
      await wait(`document.body.innerText.includes('已导出叶片数据包')`, 'blade result');
      assert.equal(calls.at(-1).level, 'blade'); assert.equal(calls.at(-1).ids.length, 3);
      report.checks.push('Blade export includes both points and all laps');
      await js(`([...document.querySelectorAll('.field-blade-group')].find(el => el.textContent.includes('叶片 1 · P1'))).open = true`);
      await js(`([...document.querySelectorAll('button[aria-label="导出叶片 1 测点 P1全部数据"]')].find(el => el.getClientRects().length)).click()`);
      await wait(`document.body.innerText.includes('已导出测点数据包')`, 'point result');
      assert.equal(calls.at(-1).level, 'point'); assert.deepEqual(calls.at(-1).ids.sort(), records.slice(0,2).map(record => record.id).sort());
      report.checks.push('Point export includes all laps, excludes other blade same-named points');
      await js(`document.querySelector('.field-blade-summary').scrollIntoView()`);
      fs.writeFileSync(path.join(output, 'summary-1024.png'), (await win.webContents.capturePage()).toPNG());
      report.screenshots.push('summary-1024.png');
      await js(`([...document.querySelectorAll('.field-blade-group')].find(el => el.open)).scrollIntoView({block:'start'})`);
      await pause(100);
      fs.writeFileSync(path.join(output, 'point-1024.png'), (await win.webContents.capturePage()).toPNG());
      report.screenshots.push('point-1024.png');
      const previous = calls.length; cancelDialog = true;
      await js(`document.querySelector('button[aria-label="导出叶片 1全部数据"]').click()`); await pause(300); await settled();
      assert.equal(calls.length, previous); report.checks.push('Cancel save dialog creates no export');
      finish();
    } catch (error) { finish(error); }
  });
});
require(path.join(root, 'apps/desktop/electron/field-main.cjs'));
