// Preposition workflow QA with production main/preload/UI, temporary credentials
// and a test-only service. Never launches Python or touches real hardware/data.
// Run after the desktop build: electron scripts/field-preset-smoke.cjs
'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'preset-position-20261020');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-preset-qa-'));
app.setPath('userData', profile);
delete process.env.BLADE_DEV_URL;
const initial = randomBytes(24).toString('base64url');
const changed = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const bootstrapFile = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrapFile)] = { id: bootstrapFile, filename: bootstrapFile, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(initial, salt, 64).toString('hex') } };


// All device operations below are fixtures. This cannot create a serial owner.
const axes = Object.fromEntries([1, 2].map(axis => [String(axis), { output_angle_deg: 0, motor_rpm: 0,
  actual_counts: 0, commanded_counts: 0, error_counts: 0, display_mode: 3, command_counts_per_rev: 10000,
  encoder_bits: 17, flags: 3, fault: 0, origin_counts: 0, home_phase: 0, observedAt: 1,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: axis === 1 ? -35 : -180, maximum_deg: axis === 1 ? 35 : 180 } }]));
const fixture = { active: false, beginCalls: [], motionCalls: [], laserWrites: 0, recall: null, moving: false, finishMotion: true };
const serviceInfo = () => ({ state: 'ready', dllConfigured: true, generation: 1 });
function snapshot() { return { state: fixture.active ? 'acquiring' : 'idle', service: serviceInfo(), deviceBusy: false, turntableBusy: fixture.moving,
  receiver: { running: fixture.active }, turntable: { state: fixture.moving ? 'positioning' : 'checked', port: 'COM6', axis: 1,
    motionCapability: { supported: false, mode: 'sequential', protocol: null, probe: 'legacy-command-unsupported', status: null },
    recall: fixture.recall, feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0, axes } },
  waveform: { values: [], rssi: [], overrange: [], sampleRate: null, unit: 'm/s', rssiUnit: '%', sampleStart: 0, sampleStride: 1 } }; }
const serviceModule = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceModule)] = { id: serviceModule, filename: serviceModule, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService() { return { serviceInfo, start: async () => snapshot(), status: async () => snapshot(), frame: async () => snapshot(),
    recordings: async () => ({ recordings: [] }), shutdown: async () => {},
    begin: async config => { fixture.beginCalls.push(config); fixture.active = true; return snapshot(); },
    stop: async () => { fixture.active = false; return snapshot(); },
    device: async request => { if (request.action !== 'laser_read') fixture.laserWrites++; return { deviceIp: request.deviceIp, laserOn: false, readAt: Date.now()/1000 }; },
    turntablePorts: async () => ({ ports: [{ port: 'COM6', description: 'TEST fixture only' }] }),
    turntable: async request => { fixture.motionCalls.push(request);
      if (request.action === 'recall') { fixture.moving = true; fixture.recall = { state: 'moving', targets: [request.axis1AngleDeg, request.axis2AngleDeg], completedAxes: [] };
        if (fixture.finishMotion) setTimeout(() => { fixture.moving = false; fixture.recall.state = 'complete'; fixture.recall.completedAxes = [1, 2];
          axes['1'].output_angle_deg = request.axis1AngleDeg; axes['2'].output_angle_deg = request.axis2AngleDeg; }, 300); }
      else if (request.action === 'stop') { fixture.moving = false; fixture.recall.state = 'cancelled'; }
      else assert.equal(request.action, 'probe');
      return snapshot(); },
  }; },
} };
const report = { hardwareTested: false, realServiceStarted: false, checks: [], screenshots: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const finish = error => { report.passed = !error; if (error) { report.error = error.stack; console.error(error); }
  fs.writeFileSync(path.join(output, 'ui-result.json'), JSON.stringify(report, null, 2)); app.exit(error ? 1 : 0); };
setTimeout(() => finish(Error('UI verification timed out')), 90000);
app.on('browser-window-created', (_, current) => {
  if (win) return; win = current; win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const waitFor = async (fn, label) => { const until = Date.now() + 10000; while (Date.now() < until) { if (await fn()) return; await pause(80); } throw Error('Timed out: '+label+'\n'+await js('document.body.innerText')); };
    const click = async text => { await js(`(() => { const el=[...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled && e.getClientRects().length); if(!el) throw Error('Missing enabled button: '+${JSON.stringify(text)}); el.click(); })()`); };
    const reload = () => new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    try {
      await waitFor(async () => (await js('document.body.innerText')).includes('登录现场工作台'), 'login');
      assert.equal((await field({ action: 'login', username: 'admin', password: initial })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: initial, newPassword: changed })).status, 200);
      const survey = { version: 3, port: 'COM6', selectedBladeId: 'b2', selectedPointId: 'p4', collectionId: '', collectionContext: '',
        settings: { periodSeconds: 5, stepDeg: 90, distanceM: 3.3, hubHeightDeltaM: .85, direction: 'clockwise', axis1Sign: 1, axis2Sign: 1,
          maxMoveRpm: 5, maxMoveAccelerationDegS2: 30, followErrorLimitDeg: 2, cycles: 1, waitRevolutions: 2,
          rssiEnterSpread: 8, rssiExitSpread: 3, rssiEnterConfirmMs: 20, rssiConfirmMs: 30 },
        blades: [{ id: 'b2', name: '2', points: [{ id: 'p1', name: 'P1', radiusM: .078 }, { id: 'p4', name: 'P4', radiusM: .5655 }] }] };
      await js(`localStorage.setItem('blade-auto-follow-draft-v1', ${JSON.stringify(JSON.stringify(survey))});localStorage.setItem('blade-field-config-v1', ${JSON.stringify(JSON.stringify({ name: '1号风机', windFarm: 'WF-001', turbine: 'WT01', object: '', point: '', deviceIp: '192.168.106.90', hostIp: '192.168.106.10' }))});`);
      await reload();
      await waitFor(async () => await js(`!!document.querySelector('[aria-label="联动转盘与测振仪"]')`), 'acquisition');
      await js(`document.querySelector('[aria-label="联动转盘与测振仪"]').click()`);
      await click('自动跟随');
      await waitFor(async () => await js(`!!document.querySelector('button[aria-label="移动到预设位置：叶片 2 测点 P4"]:not(:disabled)')`), 'P4 position');
      const position = () => js(`document.querySelector('button[aria-label="移动到预设位置：叶片 2 测点 P4"]').click()`);
      await position();
      await waitFor(async () => (await js('document.body.innerText')).includes('已到预设位置并停稳'), 'completed position');
      assert.equal(fixture.beginCalls.length, 0); assert.equal(fixture.laserWrites, 0);
      const recall = fixture.motionCalls.filter(call => call.action === 'recall');
      assert.equal(recall.length, 1); assert.ok(Math.abs(recall[0].axis1AngleDeg - 4.927407) < .001);
      assert.equal(recall[0].speedRpm, 5);
      report.checks.push('P4 preposition uses first target and configured speed; no acquisition or laser writes');
      for (const [width, height] of [[1440, 900], [1024, 768]]) {
        win.setMinimumSize(640, 480); win.setContentSize(width, height); await pause(250);
        await js(`document.querySelector('.field-auto-capture-list').scrollIntoView({block:'center'})`);
        const geometry = await js(`(() => {const el=document.querySelector('.field-auto-capture-scroll'); return {viewport:innerWidth,body:document.body.scrollWidth,tableScroll:el.scrollWidth>el.clientWidth};})()`);
        assert.ok(geometry.body <= geometry.viewport + 2, JSON.stringify(geometry));
        fs.writeFileSync(path.join(output, 'auto-'+width+'.png'), (await win.webContents.capturePage()).toPNG());
        report.screenshots.push('auto-'+width+'.png');
      }
      await js(`document.querySelector('button[aria-label="开始采集叶片 2 测点 P4"]').click()`);
      await waitFor(async () => fixture.beginCalls.length === 1, 'explicit capture');
      assert.equal(fixture.motionCalls.filter(call => call.action === 'recall').length, 1, 'Start does not request another recall');
      assert.equal(fixture.beginCalls[0].pointCycle.points[0].radialPointId, 'p4');
      report.checks.push('Explicit start sends selected P4 acquisition only; no second UI positioning request');
      await click('停止并保存'); await waitFor(async () => !fixture.active, 'stop acquisition');
      fixture.finishMotion = false;
      await waitFor(async () => await js(`!!document.querySelector('button[aria-label="移动到预设位置：叶片 2 测点 P4"]:not(:disabled)')`), 'position after capture');
      await position();
      await waitFor(async () => (await js('document.body.innerText')).includes('停止定位'), 'cancel control');
      await click('停止定位'); await waitFor(async () => (await js('document.body.innerText')).includes('已取消预定位'), 'cancel result');
      assert.equal(fixture.beginCalls.length, 1); assert.equal(fixture.moving, false);
      report.checks.push('Cancel remains available during positioning; no accidental new capture');
      await click('手动点位');
      await waitFor(async () => await js(`!!document.querySelector('.field-capture-start-actions')`), 'manual controls');
      await js(`document.querySelector('.field-capture-start-actions').scrollIntoView({block:'center'})`);
      await pause(200);
      fs.writeFileSync(path.join(output, 'manual-1024.png'), (await win.webContents.capturePage()).toPNG());
      report.screenshots.push('manual-1024.png');
      assert.equal(fixture.laserWrites, 0);
      console.log('PASS preset position UI, explicit start, cancel, responsive screenshots; isolated fixture only');
      finish();
    } catch (error) { finish(error); }
  });
});
require('../apps/desktop/electron/field-main.cjs');
