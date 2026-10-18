// Native renderer/bridge workflow with an explicit fake service; no serial or SDK access.
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'field-position-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-turntable-ui-')));
delete process.env.BLADE_DEV_URL;
const password = randomBytes(24).toString('base64url'), nextPassword = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const config = { port: 'COM6', axis: 1, speedRpm: 0.2, direction: 'forward', durationSeconds: 0, protocol: 'position', targetAngleDeg: 8 };
const info = () => ({ state: 'ready', dllConfigured: true, executable: 'TEST-ONLY-NO-HARDWARE' });
const axisFeedback = axis => ({ output_angle_deg: axis === 1 ? 25 : 0, actual_counts: axis * 1000,
  motor_rpm: 0, referenceAngleDeg: axis === 1 ? 25 : 0, observedAt: Date.now() / 1000,
  guard: { soft_enabled: true, hardware_enabled: true, minimum_deg: axis === 1 ? -35 : -180, maximum_deg: axis === 1 ? 35 : 180 } });
const feedback = { axes: { '1': axisFeedback(1), '2': axisFeedback(2) }, outputAngleDeg: 25, motorRpm: 0, outputRpm: 0, runState: 0, alarmCode: 0, limitFlags: null, positionRaw: 1234, observedAt: Date.now() / 1000 };
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
      const selected = request.axis;
      if (['probe', 'reference', 'limits'].includes(request.action)) current.turntable = { state: 'checked', port: 'COM6', axis: selected, feedback };
      if (request.action === 'test') {
        current.turntableBusy = true;
        current.turntablePreparation = null;
        current.turntable = { state: 'testing', port: 'COM6', axis: selected, feedback };
      }
      if (request.action === 'stop') {
        current.turntableBusy = false;
        current.turntable = { state: 'stopped', port: 'COM6', axis: selected, feedback };
        current.turntableTest = { passed: false, cancelled: true, config: request, positionDelta: 0, testedAt: Date.now() / 1000 };
      }
      if (request.action === 'prepare') {
        assert.equal(request.confirmMotion, true);
        const prepared = { port: request.port, axis: request.axis, protocol: request.protocol, targetAngleDeg: request.targetAngleDeg,
          speedRpm: request.speedRpm, direction: request.direction, durationSeconds: request.durationSeconds };
        current.turntablePreparation = { config: prepared, checkedAt: Date.now() / 1000, ready: true };
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
    const js = source => win.webContents.executeJavaScript(`(async () => { try { return {ok:true, value: await (async () => { return (${source.replace(/;\s*$/, '')}); })()}; } catch(error) { return {ok:false, error: error.message}; } })()`, true).then(result => { if (!result.ok) throw Error(result.error); return result.value; });
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
      await wait("document.body.innerText.includes('联动转盘与测振仪')", 'workspace');
      await js("document.querySelector('.field-turntable-toggle input').click()");
      await wait("document.body.innerText.includes('采集前转盘检查')", 'setup');
      const input = async (label, value) => js(`(() => { const e = document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(String(value))}); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
      await input('转盘串口', 'COM6');
      await input('转盘目标角度', 8);
      await input('转盘输出轴转速', 0.3);
      await click('轴2 · 水平');
      assert.equal(await js("document.querySelector('[aria-label=转盘目标角度]').value"), '');
      await input('转盘目标角度', -20);
      await input('转盘输出轴转速', 0.5);
      await click('轴1 · 俯仰');
      assert.equal(await js("document.querySelector('[aria-label=转盘目标角度]').value"), '8');
      assert.equal(await js("document.querySelector('[aria-label=转盘输出轴转速]').value"), '0.3');
      await click('轴2 · 水平');
      assert.equal(await js("document.querySelector('[aria-label=转盘目标角度]').value"), '-20');
      assert.equal(await js("document.querySelector('[aria-label=转盘输出轴转速]').value"), '0.5');
      check('两轴分别保留目标角度和速度，轴2不沿用轴1设置');
      await click('1. 读取转盘工况');
      await wait("document.body.innerText.includes('参考姿态 0°')", 'feedback');
      await js("[...document.querySelectorAll('label')].find(e => e.textContent.includes('已确认轴2当前位置作为0°参考')).querySelector('input').click()");
      await click('设当前轴参考位');
      await wait(`${button('应用当前轴 ±180°')}.disabled === false`, 'reference complete');
      await click('应用当前轴 ±180°');
      await wait(`${button('单独定位到目标角度')}.disabled === true && !document.querySelector('[aria-label=转盘目标角度]').matches(':disabled')`, 'limits complete');
      assert.ok(calls.some(row => row.action === 'reference' && row.axis === 2));
      assert.ok(calls.some(row => row.action === 'limits' && row.axis === 2));
      check('当前轴参考位及软限位通过同一桌面桥接发送');
      await js("[...document.querySelectorAll('label')].find(e => e.textContent.includes('允许当前轴移动')).querySelector('input').click()");
      await click('单独定位到目标角度');
      await wait("document.body.innerText.includes('独立试转中')", 'positioning');
      assert.equal(await js(`${button('轴1 · 俯仰')}.matches(':disabled')`), true);
      assert.equal(await js(`${button('停止试转 / 核查停稳')}.disabled`), false);
      await click('停止试转 / 核查停稳');
      await wait("document.body.innerText.includes('已确认停止')", 'stopped');
      assert.equal(calls.filter(row => row.action === 'stop').at(-1).axis, 2);
      check('定位期间轴切换锁定，停止命令绑定运动轴2');
      await js("[...document.querySelectorAll('label')].find(e => e.textContent.includes('允许当前轴移动')).querySelector('input').click()");
      await click('确认定位设置，允许联合采集');
      await wait(`${button('开始采集')}.disabled === false`, 'prepared');
      check('定位准备配置包含轴2目标角度，放行联合采集');
      for (const [width, height] of [[1366, 768], [1024, 600]]) {
        win.unmaximize(); win.setMinimumSize(360, 240); win.setContentSize(width, height);
        await pause(120);
        const geometry = await js('({ width: innerWidth, scroll: document.documentElement.scrollWidth })');
        assert.ok(geometry.scroll <= geometry.width + 2, JSON.stringify(geometry));
        await js("document.querySelector('.field-turntable-check').scrollIntoView({block:'start'})");
        await pause(80);
        fs.writeFileSync(path.join(output, `prepared-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      check('桌面常规与小窗口无横向溢出');
      await input('转盘目标角度', -21);
      await wait(`${button('开始采集')}.disabled === true`, 'target changed');
      check('修改目标角度即撤销联合采集准备状态');
      await reload();
      await wait("document.body.innerText.includes('联动转盘与测振仪')", 'reload');
      await js("document.querySelector('.field-turntable-toggle input').click()");
      await click('轴2 · 水平');
      assert.equal(await js("document.querySelector('[aria-label=转盘目标角度]').value"), '-21');
      assert.equal(await js("document.querySelector('[aria-label=转盘输出轴转速]').value"), '0.5');
      check('关闭页面重开后两轴草稿仍分别保留，不缓存参考有效状态');
      assert.equal(calls.some(row => row.action === 'begin'), false);
      report.passed = true;
    } catch (error) { report.error = error.message; console.error(error); fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    clearTimeout(watchdog);
    app.exit(report.passed ? 0 : 1);
  });
});
require('../apps/desktop/electron/field-main.cjs');
