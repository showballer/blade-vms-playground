// Native renderer/bridge workflow with an explicit fake service; no serial or SDK access.
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'field-turntable-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-turntable-ui-')));
delete process.env.BLADE_DEV_URL;
const password = randomBytes(24).toString('base64url'), nextPassword = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const config = { port: 'COM6', axis: 1, speedRpm: 0.2, direction: 'forward', durationSeconds: 0, protocol: 'legacy_speed' };
const info = () => ({ state: 'ready', dllConfigured: true, executable: 'TEST-ONLY-NO-HARDWARE' });
const feedback = { motorRpm: 0, outputRpm: 0, runState: 0, alarmCode: 0, limitFlags: null, positionRaw: 1234, observedAt: Date.now() / 1000 };
let current = { state: 'idle', error: null, recording: null, turntableBusy: false, turntableWarning: null,
  turntable: { state: 'disconnected' }, receiver: { running: false }, waveform: { values: [], rssi: [], overrange: [], sampleRate: null, unit: 'm/s' } };
const calls = [];
const snapshot = () => ({ ...structuredClone(current), service: info() });
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => snapshot(), status: async () => snapshot(), frame: async () => snapshot(),
    recordings: async () => ({ recordings: [] }), turntablePorts: async () => ({ ports: [{ port: 'COM6', description: 'TEST ONLY' }] }),
    turntable: async request => {
      calls.push(request);
      if (request.action === 'probe') current.turntable = { state: 'checked', port: 'COM6', axis: 1, feedback };
      if (request.action === 'test') {
        current.turntableBusy = true;
        current.turntablePreparation = null;
        current.turntable = { state: 'testing', port: 'COM6', axis: 1, positionDelta: 100, feedback: { ...feedback, motorRpm: 10, outputRpm: 0.2 } };
      }
      if (request.action === 'stop') {
        current.turntableBusy = false;
        current.turntable = { state: 'stopped', port: 'COM6', axis: 1, feedback };
        current.turntableTest = { passed: false, cancelled: true, config, positionDelta: 100, testedAt: Date.now() / 1000 };
      }
      if (request.action === 'prepare') {
        assert.equal(current.turntableTest?.passed, true);
        assert.equal(request.confirmMotion, true);
        current.turntablePreparation = { config, checkedAt: Date.now() / 1000, ready: true };
        current.turntable.state = 'prepared';
      }
      return snapshot();
    },
    begin: async value => { assert.deepEqual(value.turntable, config); assert.equal(value.confirmMotion, true); calls.push({ action: 'begin' }); return snapshot(); },
    stop: async () => snapshot(), shutdown: async () => {} }),
} };
const report = { hardwareTouched: false, realServiceStarted: false, checks: [], passed: false };
const watchdog = setTimeout(() => { console.error('Turntable UI smoke timed out'); app.exit(1); }, 60000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = source => win.webContents.executeJavaScript(source, true);
    const field = value => js(`window.blade.field(${JSON.stringify(value)})`);
    const reload = () => new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    const button = text => `([...document.querySelectorAll('button')].find(e => e.textContent.includes(${JSON.stringify(text)})))`;
    const click = text => js(`(() => { const e = ${button(text)}; if (!e || e.disabled) throw Error('Button unavailable: ' + ${JSON.stringify(text)}); e.click(); })()`);
    const wait = async (source, label) => { for (let i = 0; i < 100; i++) { if (await js(source)) return; await pause(60); } throw Error('Timed out: ' + label); };
    const check = label => { report.checks.push(label); console.log('PASS ' + label); };
    try {
      await wait("document.body.innerText.includes('登录现场工作台')", 'login');
      assert.equal((await field({ action: 'login', username: 'admin', password })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: password, newPassword: nextPassword })).status, 200);
      await js(`localStorage.setItem('blade-field-config-v1', ${JSON.stringify(JSON.stringify({ name: 'TEST ONLY 转盘检查', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', object: '', turbine: '', point: '', turntable: config }))})`);
      await reload();
      await wait("document.body.innerText.includes('联动连续转盘')", 'workspace');
      await js("document.querySelector('.field-turntable-toggle input').click()");
      await wait("document.body.innerText.includes('采集前转盘检查')", 'setup');
      await js(`(() => { const e = document.querySelector('[aria-label="转盘串口"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'COM6'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
      await wait(`${button('1. 读取转盘工况')}.disabled === false`, 'port set');
      assert.equal(await js(`${button('开始采集')}.disabled`), true);
      await click('1. 读取转盘工况');
      await wait("document.body.innerText.includes('无报警')", 'probe feedback');
      check('工况显示报警、速度和位置，检查阶段禁止联合采集');
      const consent = '.field-turntable-test input[type=checkbox]';
      await js(`document.querySelector(${JSON.stringify(consent)}).click()`);
      await click('2. 开始短时试转');
      await wait("document.body.innerText.includes('独立试转中')", 'testing');
      assert.equal(await js(`${button('停止试转 / 核查停稳')}.disabled`), false);
      assert.equal(await js(`${button('开始采集')}.disabled`), true);
      await click('停止试转 / 核查停稳');
      await wait("document.body.innerText.includes('试转已取消')", 'cancelled');
      assert.equal(await js(`${button('3. 确认设置')}.disabled`), true);
      check('试转可取消并保持联合采集未放行');
      await js(`document.querySelector(${JSON.stringify(consent)}).click()`);
      await click('2. 开始短时试转');
      await wait("document.body.innerText.includes('独立试转中')", 'retest');
      current.turntableBusy = false;
      current.turntable = { state: 'stopped', port: 'COM6', axis: 1, feedback };
      current.turntableTest = { passed: true, config, positionDelta: 1200, testedAt: Date.now() / 1000 };
      await wait("document.body.innerText.includes('目标转速、位置变化和停止反馈均已验证')", 'test passed');
      assert.equal(await js(`${button('开始采集')}.disabled`), true);
      await js(`document.querySelectorAll(${JSON.stringify(consent)})[1].click()`);
      await click('3. 确认设置');
      await wait(`${button('开始采集')}.disabled === false`, 'prepared');
      check('试转通过后仍需现场观察确认，完成设置才放行联合采集');
      for (const [width, height] of [[1366, 768], [1024, 600]]) {
        win.unmaximize(); win.setMinimumSize(360, 240); win.setContentSize(width, height);
        await pause(120);
        const geometry = await js('({ width: innerWidth, scroll: document.documentElement.scrollWidth })');
        assert.ok(geometry.scroll <= geometry.width + 2, JSON.stringify(geometry));
        await js("document.querySelector('.field-turntable-check').scrollIntoView({block:'start'})");
        await pause(80);
        fs.writeFileSync(path.join(output, `prepared-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      check('常规与较小窗口无横向溢出，工况检查可见');
      await js(`(() => { const e = document.querySelector('[aria-label="转盘输出轴转速"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '0.4'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
      await wait(`${button('开始采集')}.disabled === true`, 'changed config');
      check('更改转速立即撤销采集放行');
      assert.equal(calls.some(call => call.action === 'begin'), false);
      assert.equal(calls.filter(call => call.action === 'test').length, 2);
      assert.ok(calls.every(call => call.action !== 'test' || call.confirmMotion === true));
      report.passed = true;
    } catch (error) { report.error = error.message; console.error(error); }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    clearTimeout(watchdog);
    app.exit(report.passed ? 0 : 1);
  });
});
require('../apps/desktop/electron/field-main.cjs');
