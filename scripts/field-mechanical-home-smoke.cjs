// Production desktop renderer + IPC with an isolated profile. Never opens a device.
'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/mechanical-home-20261022');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-home-fixture-')));
delete process.env.BLADE_DEV_URL;
global.fetch = async () => { throw Error('External network disabled in homing UI fixture'); };
const secret = randomBytes(24).toString('base64url'), salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(secret, salt, 64).toString('hex') } };
const serialPort = '/dev/cu.usbserial-HOMING-TEST', commands = [];
let port = serialPort;
const axis = (angle, limit) => ({ output_angle_deg: angle, motor_rpm: 0, actual_counts: 0, commanded_counts: 0,
  error_counts: 0, display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 3, fault: 0,
  origin_counts: 0, home_phase: 0, referenceAngleDeg: 35, observedAt: Date.now() / 1000,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const info = () => ({ state: 'ready', generation: 1, dllConfigured: true });
let turntable, busy = false, task;
const status = () => ({ state: 'idle', service: info(), receiver: { running: false }, turntableBusy: busy,
  turntableWarning: null, turntable });
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => status(), status: async () => status(), frame: async () => status(),
    shutdown: async () => { clearTimeout(task); }, recordings: async () => ({ recordings: [] }),
    turntablePorts: async () => ({ ports: [{ port: serialPort, description: 'USB Serial fixture' }] }),
    turntable: async request => {
      commands.push(request);
      assert.equal(request.port, port); assert.equal(request.axis, request.action === 'reference' ? 2 : 1);
      if (request.action === 'probe' || request.action === 'health') {
        turntable = { state: 'checked', port, axis: 1, feedback: { outputRpm: 0, motorRpm: 0, alarmCode: 0, limitFlags: 0,
          positionRaw: 0, axes: { 1: axis(0, 35), 2: axis(0, 180) } },
          health: { readAt: Date.now() / 1000, readOnly: true, referenceChangedDuringRead: false,
            axes: { 1: { alarmCode: 0, runState: 0, limitFlags: 0 }, 2: { alarmCode: 0, runState: 0, limitFlags: 0 } } },
          motionCapability: { supported: true, mode: 'dual_axis_timed', probe: 'confirmed',
            status: { session: 42, state: 0, fault: 0, error1_deg: 0, error2_deg: 0 } } };
      } else if (request.action === 'reference') {
        assert.equal(request.confirmMotion, true);
        assert.equal(request.homingSpeedDegS, undefined);
        turntable.axis = 2;
        turntable.feedback.axes['2'] = { ...axis(0, 180), origin_counts: 555 };
      } else if (request.action === 'stop') {
        clearTimeout(task); busy = false;
        turntable.state = 'stopped';
        turntable.homing = { ...turntable.homing, state: 'cancelled', phase: 'cancelled', verified: false, stopConfirmed: true };
      } else {
        assert.ok(['mechanical_home', 'horizontal_zero'].includes(request.action));
        assert.equal(request.confirmMotion, true); assert.equal(request.homingSpeedDegS, .6);
        busy = true;
        turntable = { state: 'homing', port, axis: 1, homing: { action: request.action, state: 'running', phase: 'seeking_limit',
          speedDegS: .6, effectiveRpm: .1, targetAngleDeg: request.action === 'mechanical_home' ? 35 : 0 } };
        task = setTimeout(() => {
          busy = false; turntable.state = 'stopped';
          turntable.homing = { ...turntable.homing, state: 'complete', phase: 'complete', verified: true, stopConfirmed: true };
          turntable.feedback = { outputRpm: 0, motorRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0,
            axes: { 1: axis(turntable.homing.targetAngleDeg, 35), 2: axis(0, 180) } };
        }, 1600);
      }
      return status();
    } }) } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win; const watchdog = setTimeout(() => finish(Error('UI fixture timed out')), 60000);
function finish(error) {
  clearTimeout(watchdog); clearTimeout(task);
  const results = { passed: !error, hardwareAccessed: false, externalNetworkAccessed: false,
    actions: commands.map(({ action, axis, port }) => ({ action, axis, port })), ...(error ? { error: error.stack } : {}) };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results)); app.exit(error ? 1 : 0);
}
app.on('browser-window-created', (_, window) => {
  if (win) return; win = window; win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const wait = async code => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await pause(50); } throw Error('Missing UI: ' + code); };
    const click = text => js(`(() => { const button = [...document.querySelectorAll('button,[role="option"]')].find(el => el.getClientRects().length && !el.disabled && el.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw Error('Missing enabled control: ' + ${JSON.stringify(text)}); button.click(); })()`);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const screenshot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    try {
      await wait(`document.body.innerText.includes('登录现场工作台')`);
      assert.equal((await field({ action: 'login', username: 'admin', password: secret })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: secret, newPassword: randomBytes(24).toString('base64url') })).status, 200);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait(`!!document.querySelector('.field-sidebar')`); await click('转盘点位');
      await wait(`!!document.querySelector('[aria-label="手动控制转盘串口"]')`);
      await js(`(() => { const el = document.querySelector('[aria-label="手动控制转盘串口"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(port)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await pause(100); await click('转盘状态');
      await wait(`!!document.querySelector('.field-mechanical-home')`);
      assert.ok(await js(`!!document.querySelector('dialog .field-mechanical-home')`));
      await wait(`![...document.querySelectorAll('.field-mechanical-home button')].find(el => el.textContent.trim() === '机械回零').disabled`);
      assert.equal(commands.filter(c => c.action === 'mechanical_home').length, 0);
      await js(`document.querySelector('[role="combobox"][aria-label="转盘连接方式"]').click()`);
      await click('网口 TCP');
      const fillTcpPort = async value => {
        await js(`(() => { const el = document.querySelector('[aria-label="转盘TCP端口"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await pause(50);
      };
      const oldCommandCount = commands.length;
      await fillTcpPort('0'); await click('连接并检查');
      await wait(`document.querySelector('.field-turntable-connection').innerText.includes('1～65535')`);
      assert.equal(commands.length, oldCommandCount);
      await fillTcpPort('5000'); port = 'tcp://192.168.10.50:5000';
      await click('连接并检查');
      await wait(`document.querySelector('.field-turntable-connection').innerText.includes('已读取转盘反馈')`);
      assert.equal(await js(`JSON.parse(localStorage.getItem('blade-turntable-connection-v1')).endpoint`), port);
      assert.equal(await js(`document.querySelector('[aria-label="手动控制转盘串口"]').value`), port);
      for (const width of [1440, 1024]) {
        win.setMinimumSize(640, 480); win.setContentSize(width, 900); await pause(150);
        assert.ok(await js('document.body.scrollWidth <= innerWidth + 2'));
        assert.ok(await js(`(() => { const region = document.querySelector('.field-turntable-health'); return region.scrollHeight > region.clientHeight && getComputedStyle(region).overflowY === 'auto'; })()`));
        await screenshot('ready-' + width);
      }
      await click('机械回零'); await wait(`document.querySelector('.field-mechanical-home').innerText.includes('寻找机械限位')`);
      await screenshot('running'); await click('停止回零');
      await wait(`document.querySelector('.field-mechanical-home').innerText.includes('已停止')`);
      await click('机械回零'); await wait(`document.querySelector('.field-mechanical-home').innerText.includes('已完成 · 俯仰 35°')`);
      await click('回水平 0°'); await wait(`document.querySelector('.field-mechanical-home').innerText.includes('已完成 · 俯仰 0°')`);
      await screenshot('level-complete');
      await click('确认水平轴为 0°');
      await wait(`document.querySelector('.field-mechanical-home').innerText.includes('水平轴当前位置已设为设备0°')`);
      assert.equal(commands.filter(c => c.action === 'reference').length, 1);
      assert.equal(commands.find(c => c.action === 'reference').axis, 2);
      assert.ok(await js(`!![...document.querySelectorAll('dialog .field-mechanical-home button')].find(el => el.textContent.trim() === '确认水平轴为 0°')`));
      assert.ok(await js(`![...document.querySelectorAll('button')].some(el => el.textContent.trim() === '确认当前为0°参考')`));
      assert.equal(commands.filter(c => c.action === 'mechanical_home').length, 2);
      assert.equal(commands.filter(c => c.action === 'horizontal_zero').length, 1);
      assert.equal(commands.filter(c => c.action === 'stop').length, 1);
      await js(`document.querySelector('dialog [aria-label="关闭弹窗"]').click()`);
      await click('自动跟随');
      assert.equal(await js(`document.querySelector('[aria-label="自动跟随转盘串口"]').value`), port);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait(`!!document.querySelector('.field-sidebar')`); await click('转盘点位');
      await wait(`document.querySelector('[aria-label="手动控制转盘串口"]')?.value === 'tcp://192.168.10.50:5000'`);
      finish();
    } catch (error) { await screenshot('failure'); finish(error); }
  });
});
require(path.join(root, 'apps/desktop/electron/field-main.cjs'));
