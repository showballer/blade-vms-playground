// Built renderer + real IPC, isolated profile and in-memory device service only.
'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/capture-readiness-20261023'); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-capture-readiness-')));
delete process.env.BLADE_DEV_URL;
global.fetch = async () => { throw Error('External network disabled in readiness fixture'); };
const secret = randomBytes(24).toString('base64url'), salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(secret, salt, 64).toString('hex') } };
const port = 'tcp://192.168.10.50:5000', signature = JSON.stringify([[0, 3, 10000, 17], [0, 3, 10000, 17]]);
const origin = { port, generation: 1, referenceSignature: signature, axis1AngleDeg: 1.212, axis2AngleDeg: .015 };
const axis = (angle, limit) => ({ output_angle_deg: angle, motor_rpm: 0, actual_counts: 0, commanded_counts: 0, error_counts: 0,
  display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 3, fault: 0, origin_counts: 0, home_phase: 0,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const info = () => ({ state: 'ready', dllConfigured: true, generation: 2 });
const laser = () => ({ deviceIp: '192.168.106.90', state: 'unknown', readAt: null, source: 'unavailable', busy: false });
let controller, acquiring = false, pointCycle, failProbe = true, invalidReference = false;
const calls = [];
const status = () => structuredClone({ state: acquiring ? 'acquiring' : 'idle', receiver: { running: acquiring },
  service: info(), laserStatus: laser(), turntable: controller, pointCycle, turntableBusy: false });
function feedback() {
  controller ??= { port, axis: 1, motionCapability: { supported: false, mode: 'sequential', protocol: null, probe: 'legacy-command-unsupported', status: null },
    feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0,
      axes: { '1': axis(origin.axis1AngleDeg, 35), '2': axis(origin.axis2AngleDeg, 180) } } };
  controller.state = 'checked'; controller.feedback.observedAt = Date.now() / 1000;
  if (invalidReference) controller.feedback.axes['1'].origin_counts = 1;
  return status();
}
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => status(), status: async () => status(), frame: async () => status(),
    shutdown: async () => {}, recordings: async () => ({ recordings: [] }), device: async () => laser(),
    turntablePorts: async () => ({ ports: [] }),
    turntable: async request => {
      calls.push({ action: request.action, port: request.port });
      assert.equal(request.port, port);
      if (request.action === 'probe') { if (failProbe) throw Error('fixture first probe unavailable'); return feedback(); }
      assert.equal(request.action, 'recall'); assert.equal(request.referenceSignature, signature);
      assert.equal(request.axis2AngleDeg, .015, 'First radial point retains the saved yaw offset');
      feedback(); controller.feedback.axes['1'].output_angle_deg = request.axis1AngleDeg;
      controller.feedback.axes['2'].output_angle_deg = request.axis2AngleDeg;
      controller.recall = { state: 'complete', targets: [request.axis1AngleDeg, request.axis2AngleDeg], completedAxes: [1, 2] };
      return status();
    },
    begin: async config => {
      calls.push({ action: 'start' }); assert.equal(config.pointCycle.port, port);
      const first = config.pointCycle.points[0];
      assert.equal(first.referenceSignature, signature);
      assert.equal(first.axis1AngleDeg, controller.feedback.axes['1'].output_angle_deg);
      assert.equal(first.axis2AngleDeg, controller.feedback.axes['2'].output_angle_deg);
      assert.equal(calls.filter(call => call.action === 'recall').length, 1, 'Start must not repeat pre-positioning');
      acquiring = true; pointCycle = { ...config.pointCycle, state: 'capturing', pointCount: 2, cycle: 1, point: 1, completedRecords: 0 };
      return status();
    },
    stop: async () => { acquiring = false; pointCycle = { ...pointCycle, state: 'cancelled' }; return status(); },
  }) } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win; const watchdog = setTimeout(() => finish(Error('Readiness UI fixture timed out')), 60000);
function finish(error) {
  clearTimeout(watchdog);
  const result = { passed: !error, hardwareAccessed: false, externalNetworkAccessed: false, calls,
    ...(error ? { error: error.stack } : {}) };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); app.exit(error ? 1 : 0);
}
app.on('browser-window-created', (_, window) => {
  if (win) return; win = window; win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const wait = async code => { for (let i = 0; i < 160; i++) { if (await js(code)) return; await pause(40); } throw Error('Missing UI: ' + code); };
    const click = text => js(`(() => { const b=[...document.querySelectorAll('button')].find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.trim()===${JSON.stringify(text)}); if(!b)throw Error('Missing enabled button: '+${JSON.stringify(text)});b.click(); })()`);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    try {
      await wait(`document.body.innerText.includes('登录现场工作台')`);
      assert.equal((await field({ action: 'login', username: 'admin', password: secret })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: secret, newPassword: randomBytes(24).toString('base64url') })).status, 200);
      await js(`localStorage.setItem('blade-field-config-v1',JSON.stringify({name:'Readiness fixture',deviceIp:'192.168.106.90',hostIp:'192.168.106.10',object:'',turbine:'',point:''}));
        localStorage.setItem('blade-turntable-connection-v1',JSON.stringify({version:1,endpoint:${JSON.stringify(port)}}));
        localStorage.setItem('blade-turntable-work-origins-v1',JSON.stringify({version:1,work:${JSON.stringify(origin)},optical:${JSON.stringify(origin)}}));
        localStorage.setItem('blade-turntable-optical-origin-required-v1','true');`);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait(`!!document.querySelector('.field-sidebar')`); await click('转盘点位'); await click('自动跟随');
      await pause(250); assert.ok(calls.some(call => call.action === 'probe'));
      await click('数据采集');
      await js(`document.querySelector('[aria-label="联动转盘与测振仪"]').click()`);
      await wait(`!!document.querySelector('[aria-label="风机叶片逐点采集"]')`);
      const actions = `document.querySelector('[aria-label="风机叶片逐点采集"]')`;
      await wait(`![...${actions}.querySelectorAll('button')].find(b=>b.textContent.trim()==='移动到预设位置').disabled`);
      assert.equal(await js(`[...${actions}.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始采集').disabled`), false);
      fs.writeFileSync(path.join(output, 'pending-origin.png'), (await win.webContents.capturePage()).toPNG());
      failProbe = false;
      await click('移动到预设位置'); await wait(`document.body.innerText.includes('已到预设位置并停稳')`);
      assert.equal(calls.filter(call => call.action === 'recall').length, 1);
      await click('开始采集'); await wait(`!!document.querySelector('[aria-label="采集安全控制"]')`);
      assert.equal(calls.filter(call => call.action === 'start').length, 1);
      assert.equal(calls.filter(call => call.action === 'recall').length, 1);
      await click('停止并保存'); await wait(`!document.querySelector('[aria-label="采集安全控制"]')`);
      invalidReference = true;
      await click('移动到预设位置');
      await wait(`document.body.innerText.includes('参考位') && !!document.querySelector('[role="alert"]')`);
      assert.equal(calls.filter(call => call.action === 'recall').length, 1, 'Changed reference must not move');
      finish();
    } catch (error) { finish(error); }
  });
});
require(path.join(root, 'apps/desktop/electron/field-main.cjs'));
