// Native renderer/bridge regression. Fake feedback only; no serial or SDK access.
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'field-record-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-record-ui-')));
delete process.env.BLADE_DEV_URL;
const password = randomBytes(24).toString('base64url'), nextPassword = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const info = () => ({ state: 'ready', dllConfigured: true, executable: 'TEST-ONLY-NO-HARDWARE' });
const axis = (angle, fault) => ({ output_angle_deg: angle, motor_rpm: 0, actual_counts: 99,
  commanded_counts: 99, error_counts: 0, display_mode: 3, command_counts_per_rev: 10000,
  encoder_bits: 17, flags: 3, fault, origin_counts: 0, home_phase: 8, observedAt: 1,
  referenceAngleDeg: 25, guard: { soft_enabled: true, hardware_enabled: true, minimum_deg: -35, maximum_deg: 35 } });
const current = { state: 'idle', turntableBusy: false, turntableWarning: null,
  turntable: { state: 'stopped', port: 'COM3', axis: 1,
    feedback: { axes: { '1': axis(32.927, 2), '2': axis(15.247, 0) }, outputRpm: 0,
      motorRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 99 } }, receiver: { running: false } };
const snapshot = () => ({ ...structuredClone(current), service: info() });
let failProbe = false;
let holdRecall = false;
const calls = [];
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => snapshot(), status: async () => snapshot(), frame: async () => snapshot(),
    recordings: async () => ({ recordings: [] }), shutdown: async () => {},
    turntable: async request => {
      calls.push(request);
      if (request.action === 'recall') {
        assert.equal(request.confirmMotion, true);
        assert.equal(request.axis1AngleDeg, 32.901);
        assert.equal(request.axis2AngleDeg, 15.301);
        assert.ok(request.referenceSignature);
        assert.equal(request.speedRpm, holdRecall ? 2 : 1, 'Recall must use the selected speed');
        current.turntable.recall = { state: holdRecall ? 'moving' : 'complete', targets: [request.axis1AngleDeg, request.axis2AngleDeg], completedAxes: holdRecall ? [1] : [1, 2] };
        current.turntable.axis = 2;
        current.turntable.state = holdRecall ? 'positioning' : 'stopped';
        current.turntableBusy = holdRecall;
        return snapshot();
      }
      if (request.action === 'stop') {
        assert.equal(request.axis, 2, 'Stop must address active recall axis, even while axis1 is selected');
        current.turntableBusy = false;
        current.turntable.state = 'stopped';
        current.turntable.recall.state = 'cancelled';
        return snapshot();
      }
      assert.equal(request.action, 'probe');
      assert.equal(request.axis, 1);
      if (failProbe) throw Error('TEST ONLY: feedback unavailable');
      current.turntable.feedback.axes['1'].output_angle_deg = 32.901;
      current.turntable.feedback.axes['2'].output_angle_deg = 15.301;
      return snapshot();
    } }),
} };
const report = { hardwareTouched: false, realServiceStarted: false, checks: [], passed: false };
const watchdog = setTimeout(() => { console.error('Record UI smoke timed out'); app.exit(1); }, 60000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = source => win.webContents.executeJavaScript(source, true);
    const button = text => `([...document.querySelectorAll('button')].find(e => e.textContent.includes(${JSON.stringify(text)})))`;
    const wait = async (source, label) => { for (let i = 0; i < 100; i++) { if (await js(source)) return; await pause(60); } throw Error('Timed out: ' + label); };
    const check = label => { report.checks.push(label); console.log('PASS ' + label); };
    try {
      await wait("document.body.innerText.includes('登录现场工作台')", 'login');
      const login = await js(`window.blade.field(${JSON.stringify({ action: 'login', username: 'admin', password })})`);
      assert.equal(login.status, 200);
      const changed = await js(`window.blade.field(${JSON.stringify({ action: 'changePassword', currentPassword: password, newPassword: nextPassword })})`);
      assert.equal(changed.status, 200);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait(`${button('转盘点位')} != null`, 'workspace');
      await wait("document.querySelector('.field-page-tools')?.innerText.includes('等待采集')", 'initial status loaded');
      await js(`${button('转盘点位')}.click()`);
      await wait(`${button('读取并记录两轴角度')} && !${button('读取并记录两轴角度')}.disabled`, 'record enabled with fault 2');
      for (const text of ['当前轴 −步长', '当前轴 +步长', '移动到目标点']) assert.equal(await js(`${button(text)}.disabled`), true);
      assert.equal(await js("document.body.innerText.includes('可记录 · 运动受限')"), true);
      check('Stopped axis1 with fault2 can record while motion stays blocked');
      await js(`${button('读取并记录两轴角度')}.click()`);
      await wait("JSON.parse(localStorage.getItem('blade-turntable-manual-points-v1') || '[]').length === 1", 'saved');
      const points = await js("JSON.parse(localStorage.getItem('blade-turntable-manual-points-v1'))");
      assert.equal(points[0].axis1AngleDeg, 32.901);
      assert.equal(points[0].axis2AngleDeg, 15.301);
      assert.equal(points[0].axis1RawCounts, 99);
      assert.equal(calls.length, 1);
      check('Click queries fresh feedback and persists both latest angles, not cached angles');
      failProbe = true;
      await wait(`!${button('读取并记录两轴角度')}.disabled`, 'record unlocked');
      await js(`${button('读取并记录两轴角度')}.click()`);
      await wait("document.body.innerText.includes('TEST ONLY: feedback unavailable')", 'probe failure');
      assert.equal(await js("JSON.parse(localStorage.getItem('blade-turntable-manual-points-v1')).length"), 1);
      assert.equal(calls.length, 2);
      check('Failed probe shows error and never saves stale feedback');
      await wait(`${button('移动到此点')} != null`, 'recall action');
      assert.equal(await js(`${button('移动到此点')}.disabled`), true);
      assert.equal(await js("document.body.innerText.includes('轴1故障码 2')"), true);
      failProbe = false;
      current.turntable.feedback.axes['1'].fault = 0;
      await wait(`!${button('移动到此点')}.disabled`, 'recall ready');
      assert.equal(await js("document.querySelector('select[aria-label=点位回位速度]').value"), '0.2');
      await js("document.querySelector('button[aria-label=点位回位速度]').click()");
      await wait("[...document.querySelectorAll('[role=option]')].some(e => e.textContent === '1 rpm · 6°/秒')", 'speed options');
      await js("[...document.querySelectorAll('[role=option]')].find(e => e.textContent === '1 rpm · 6°/秒').click()");
      await js(`${button('移动到此点')}.click()`);
      await wait("document.body.innerText.includes('两轴已到达记录点')", 'recall complete');
      assert.equal(calls.filter(row => row.action === 'recall').length, 1);
      check('One row click sends both recorded angles and reference signature, then displays completion');
      holdRecall = true;
      await wait(`!${button('移动到此点')}.disabled`, 'second recall ready');
      await js("document.querySelector('button[aria-label=点位回位速度]').click()");
      await wait("[...document.querySelectorAll('[role=option]')].some(e => e.textContent === '2 rpm · 12°/秒')", 'second speed options');
      await js("[...document.querySelectorAll('[role=option]')].find(e => e.textContent === '2 rpm · 12°/秒').click()");
      await js(`${button('移动到此点')}.click()`);
      await wait("document.body.innerText.includes('正在处理轴2')", 'recall axis2');
      assert.equal(await js(`${button('停止当前轴')}.disabled`), false);
      assert.equal(await js(`${button('移动到此点')}.disabled`), true);
      assert.equal(await js("document.querySelector('button[aria-label=点位回位速度]').disabled"), true);
      await js(`${button('停止当前轴')}.click()`);
      await wait("document.body.innerText.includes('已取消，后续轴不再启动')", 'recall cancelled');
      check('While selected axis1, stop addresses recall axis2 and cancels the whole return');
      check('Recall speed defaults to 0.2 rpm; 1 and 2 rpm selections reach the bridge and lock during motion');
      await js("localStorage.setItem('blade-turntable-manual-points-v1', JSON.stringify([...JSON.parse(localStorage.getItem('blade-turntable-manual-points-v1')), {name:'OUTSIDE',recordedAt:1,axis1AngleDeg:36.7,axis2AngleDeg:0}]))");
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait("document.querySelector('.field-page-tools')?.innerText.includes('等待采集')", 'reload status');
      await js(`${button('转盘点位')}.click()`);
      await wait("document.body.innerText.includes('记录轴1角度超出 ±35°')", 'outside target reason');
      assert.equal(await js("[...document.querySelectorAll('tr')].find(row => row.textContent.includes('OUTSIDE')).querySelector('button').disabled"), true);
      check('Historical out-of-range point is visibly blocked and never clamped');
      fs.writeFileSync(path.join(output, 'record-fault2.png'), (await win.webContents.capturePage()).toPNG());
      report.passed = true;
    } catch (error) {
      report.error = error.message; console.error(error);
      report.body = await js('document.body.innerText');
      fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    clearTimeout(watchdog);
    app.exit(report.passed ? 0 : 1);
  });
});
require('../apps/desktop/electron/field-main.cjs');
