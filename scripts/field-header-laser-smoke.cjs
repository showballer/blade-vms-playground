'use strict';
// Production renderer/preload with a disposable profile and an in-memory service.
// No real SDK, device, serial port, saved credentials, recording, or upload is used.
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/field-header-laser-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-header-laser-')));
delete process.env.BLADE_DEV_URL;
const password = randomBytes(24).toString('base64url'), changedPassword = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
// Cache-only replacement: the production credential file is never read.
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const mainIp = '192.0.2.90', secondIp = '192.0.2.91';
const fixture = { generation: 1, serviceState: 'ready', active: false, deviceBusy: false,
  unavailable: false, readFailure: false, staleRead: false, futureRead: false, subMillisecondRead: false,
  holdNextRead: false, holdNextWrite: false,
  readRelease: null, writeRelease: null, rejectedWrite: false, reads: [], writes: [], forbidden: [],
  actual: { [mainIp]: 'off', [secondIp]: 'off' }, selectedIp: mainIp, cached: null, statusLaserOverride: null };
const now = () => Date.now() / 1000;
const info = () => ({ state: fixture.serviceState, dllConfigured: true, generation: fixture.generation, executable: 'TEST-ONLY-NO-HARDWARE' });
function readback(deviceIp) {
  const unknown = fixture.unavailable;
  return { deviceIp, state: unknown ? 'unknown' : fixture.actual[deviceIp] || 'off',
    readAt: unknown ? null : now() + (fixture.futureRead ? 10 : fixture.staleRead ? -10 : fixture.subMillisecondRead ? .0005 : 0),
    source: unknown ? 'unavailable' : 'device-readback', busy: fixture.active || fixture.deviceBusy,
    ...(unknown ? { error: 'TEST ONLY 设备暂不可达' } : {}) };
}
function snapshot() {
  // Emulate the receiver publishing its own readback while it owns the device.
  if (fixture.active) fixture.cached = readback(fixture.selectedIp);
  return { service: info(), state: fixture.active ? 'acquiring' : 'idle', error: null,
    receiver: { running: fixture.active }, deviceBusy: fixture.deviceBusy, turntableBusy: false,
    laserStatus: fixture.statusLaserOverride
      ? typeof fixture.statusLaserOverride === 'function' ? fixture.statusLaserOverride() : structuredClone(fixture.statusLaserOverride)
      : fixture.cached ? structuredClone(fixture.cached) : undefined,
    // Deliberately contradictory historical settings must not drive live state.
    deviceSettings: { deviceIp: mainIp, readAt: 1700000000, source: 'TEST-ONLY-OLD-SNAPSHOT', fields: { laser: { supported: true, value: 1 } } },
    waveform: { values: [], rssi: [], overrange: [], sampleRate: null, unit: 'm/s' } };
}
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => snapshot(), status: async () => snapshot(), frame: async () => snapshot(),
    recordings: async () => ({ recordings: [] }), shutdown: async () => {}, turntablePorts: async () => ({ ports: [] }),
    device: async request => {
      fixture.selectedIp = request.deviceIp;
      if (request.action === 'laser_read') {
        fixture.reads.push({ deviceIp: request.deviceIp, generation: fixture.generation });
        if (fixture.readFailure) throw Object.assign(Error('TEST ONLY 激光状态读取失败'), { status: 503 });
        const reply = readback(request.deviceIp);
        fixture.cached = reply;
        if (fixture.holdNextRead) {
          fixture.holdNextRead = false;
          await new Promise(resolve => { fixture.readRelease = resolve; });
        }
        return structuredClone(reply);
      }
      if (['laser_on', 'laser_off'].includes(request.action)) {
        fixture.writes.push(structuredClone(request));
        assert.equal(request.confirmLaser, true);
        if (fixture.active || fixture.deviceBusy) throw Object.assign(Error('TEST ONLY 设备已由采集占用'), { status: 409 });
        if (fixture.holdNextWrite) {
          fixture.holdNextWrite = false;
          await new Promise(resolve => { fixture.writeRelease = resolve; });
        }
        if (fixture.rejectedWrite) throw Object.assign(Error('TEST ONLY 激光命令未确认'), { status: 503 });
        fixture.actual[request.deviceIp] = request.action === 'laser_on' ? 'on' : 'off';
        fixture.cached = readback(request.deviceIp);
        return { deviceIp: request.deviceIp, readAt: now(), source: 'TEST-ONLY-DEVICE',
          fields: { laser: { supported: true, value: fixture.actual[request.deviceIp] === 'on' ? 1 : 0 } } };
      }
      if (request.action === 'read') return { deviceIp: request.deviceIp, readAt: now(), source: 'TEST-ONLY-DEVICE',
        fields: { laser: { supported: true, value: fixture.actual[request.deviceIp] === 'on' ? 1 : 0 }, autofocus: { supported: true, value: 0 } } };
      fixture.forbidden.push(request.action); throw Error('TEST ONLY 禁止设备操作：' + request.action);
    },
    begin: async () => { fixture.forbidden.push('begin'); throw Error('TEST ONLY 禁止启动采集'); },
    stop: async () => { fixture.forbidden.push('stop'); throw Error('TEST ONLY 禁止改变采集流程'); },
    turntable: async () => { fixture.forbidden.push('turntable'); throw Error('TEST ONLY 禁止转盘操作'); },
  }),
} };
const report = { hardwareTouched: false, realServiceStarted: false, productionUserDataTouched: false,
  nativeMotionExecuted: false, checks: [], screenshots: [], passed: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, executing = false;
const watchdog = setTimeout(() => finish(Error('Header laser acceptance timed out')), 150000);
function finish(error) {
  clearTimeout(watchdog); report.passed = !error; if (error) report.error = error.stack;
  report.deviceWrites = fixture.writes; report.laserReadCount = fixture.reads.length; report.forbidden = fixture.forbidden;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  if (error) console.error(error); app.exit(error ? 1 : 0);
}
app.on('browser-window-created', (_event, window) => {
  if (executing) return;
  executing = true; win = window;
  win.webContents.setBackgroundThrottling(false);
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  win.webContents.once('did-finish-load', async () => {
    const js = source => win.webContents.executeJavaScript('(async()=>(' + source + '))()', true);
    const bridge = options => js('window.blade.field(' + JSON.stringify(options) + ')');
    const headerState = () => js('document.querySelector(".field-header-laser")?.dataset.state');
    async function wait(check, label) {
      for (let i = 0; i < 200; i++) { if (typeof check === 'string' ? await js(check) : await check()) return; await pause(40); }
      throw Error('Timed out: ' + label);
    }
    const button = (text, scope = 'body') => '[...document.querySelectorAll(' + JSON.stringify(scope + ' button') + ')].find(e=>!e.closest("[hidden]")&&e.textContent.trim()===' + JSON.stringify(text) + ')';
    async function click(text, scope) {
      await js('(()=>{const e=' + button(text, scope) + ';if(!e||e.disabled)throw Error("Button unavailable: "+' + JSON.stringify(text) + ');e.click();})()');
      await pause(50);
    }
    async function headerClick(label) {
      const selector = '.field-header-laser button[aria-label=' + JSON.stringify(label) + ']';
      await js('(()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');if(!e||e.disabled)throw Error("Laser action unavailable");e.click();})()'); await pause(50);
    }
    async function check(name, fn) { await fn(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
    async function fresh(state) { await wait(async () => await headerState() === state, 'header ' + state); }
    const headerDisabled = () => js('document.querySelector(".field-header-laser button").disabled');
    let expectedWrites = 0;
    try {
      await wait('document.body.innerText.includes("登录现场工作台")', 'login');
      await bridge({ action: 'login', username: 'admin', password });
      await bridge({ action: 'changePassword', currentPassword: password, newPassword: changedPassword });
      await js('localStorage.setItem("blade-field-config-v1",' + JSON.stringify(JSON.stringify({ name: 'TEST ONLY 顶栏激光状态验收', deviceIp: mainIp, hostIp: '192.0.2.10', turbine: 'WT-TEST', object: '', point: '' })) + ')');
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait('!!document.querySelector(".field-header-laser")', 'header laser');
      await check('首次只读取设备状态，不将旧配置中的On当作实际状态，也不发送激光或运动命令', async () => {
        await fresh('off'); await wait(() => fixture.reads.some(read => read.deviceIp === mainIp), 'explicit laser read');
        assert.equal(fixture.writes.length, 0); assert.equal(fixture.forbidden.length, 0);
        assert.equal(await js('document.querySelector(".field-header-laser [role=status]").getAttribute("aria-label")'), '激光状态：已关闭');
      });
      await check('Python微秒精度多0.5ms的正常回读保持已关闭，不闪未知或无效回读警告', async () => {
        fixture.subMillisecondRead = true;
        await js('(()=>{window.__laserPrecisionSamples=[];const root=document.querySelector(".field-header-laser");const sample=()=>window.__laserPrecisionSamples.push({state:root.dataset.state,error:root.querySelector(".field-header-laser-message")?.textContent||""});window.__laserPrecisionObserver=new MutationObserver(sample);window.__laserPrecisionObserver.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});sample();})()');
        const before = fixture.reads.length;
        await wait(() => fixture.reads.length >= before + 3, 'three submillisecond device readbacks');
        await pause(100); await fresh('off');
        const samples = await js('(()=>{window.__laserPrecisionObserver.disconnect();return window.__laserPrecisionSamples;})()');
        assert.ok(samples.length > 0);
        assert.ok(samples.every(sample => sample.state === 'off' && !sample.error), JSON.stringify(samples));
        assert.equal(await js('!!document.querySelector(".field-header-laser-error")'), false);
        fixture.subMillisecondRead = false;
      });
      await check('单击开启立即发一条指令且无确认弹窗，等待实际回读后更新', async () => {
        fixture.holdNextWrite = true; fixture.writeRelease = null;
        await headerClick('开启激光');
        await wait(() => typeof fixture.writeRelease === 'function', 'pending laser command');
        assert.equal(await js('!!document.querySelector(".field-header-laser-confirm,[role=dialog]")'), false);
        assert.equal(fixture.writes.length, 1); assert.equal(await headerDisabled(), true);
        assert.notEqual(await headerState(), 'on', 'A queued command is not an On readback');
        fixture.writeRelease(); fixture.writeRelease = null;
        await fresh('on'); assert.equal(fixture.writes[0].action, 'laser_on');
      });
      await check('顶栏跨数据采集、转盘点位、本机记录、设备与服务保持共享状态，关闭立即回读', async () => {
        for (const screen of ['转盘点位', '本机记录', '设备与服务', '数据采集']) {
          await click(screen, '.field-sidebar'); await fresh('on');
          assert.equal(await js('document.querySelectorAll(".field-header-laser").length'), 1);
        }
        await headerClick('关闭激光'); await fresh('off');
        assert.equal(fixture.writes.length, 2); assert.equal(fixture.writes[1].action, 'laser_off');
        expectedWrites = fixture.writes.length;
      });
      await check('快速双击开启不会重复发送，关闭仍然直接生效', async () => {
        fixture.holdNextWrite = true; fixture.writeRelease = null;
        await js('(()=>{const e=document.querySelector(\'.field-header-laser button[aria-label="开启激光"]\');if(!e||e.disabled)throw Error("Laser action unavailable");e.click();e.click();})()');
        await wait(() => typeof fixture.writeRelease === 'function', 'double-click command pending');
        assert.equal(fixture.writes.length, expectedWrites + 1);
        assert.equal(fixture.writes.at(-1).action, 'laser_on');
        assert.equal(await js('!!document.querySelector(".field-header-laser-confirm,[role=dialog]")'), false);
        assert.equal(await headerDisabled(), true);
        fixture.writeRelease(); fixture.writeRelease = null;
        await fresh('on'); await headerClick('关闭激光'); await fresh('off');
        assert.equal(fixture.writes.length, expectedWrites + 2);
        expectedWrites = fixture.writes.length;
      });
      await check('设备外部On/Off变化由周期回读同步，页面不发送控制命令', async () => {
        const before = fixture.writes.length;
        fixture.actual[mainIp] = 'on'; await fresh('on');
        fixture.actual[mainIp] = 'off'; await fresh('off');
        assert.equal(fixture.writes.length, before);
      });
      await check('较旧status缓存Off不能覆盖刚读回的On并跳过关闭，较新busy回读拒绝写入', async () => {
        fixture.actual[mainIp] = 'on'; await fresh('on');
        fixture.statusLaserOverride = { deviceIp: mainIp, state: 'off', readAt: now() - 1,
          source: 'device-readback', busy: false };
        await headerClick('关闭激光');
        await wait(() => fixture.writes.length === expectedWrites + 1, 'new On readback requires an actual Off command');
        expectedWrites++; await fresh('off'); assert.equal(fixture.writes.at(-1).action, 'laser_off');
        fixture.statusLaserOverride = null;
        fixture.statusLaserOverride = () => ({ deviceIp: mainIp, state: 'off', readAt: now(), source: 'device-readback', busy: true });
        await headerClick('开启激光');
        await wait('document.querySelector(".field-header-laser-message")?.textContent.includes("设备正在操作")', 'newer busy cache blocks the write');
        await fresh('off'); assert.equal(fixture.writes.length, expectedWrites);
        fixture.statusLaserOverride = null;
      });
      await check('断线、读取异常、过期回读显示未知，检查按钮只读，不伪装为已关闭', async () => {
        const before = fixture.writes.length;
        fixture.unavailable = true; await fresh('unknown');
        assert.equal(await js('document.querySelector(".field-header-laser [role=status]").getAttribute("aria-label")'), '激光状态：未知');
        await headerClick('检查激光'); assert.equal(fixture.writes.length, before);
        fixture.unavailable = false; fixture.readFailure = true; await pause(1200); await fresh('unknown');
        fixture.readFailure = false; fixture.staleRead = true; fixture.actual[mainIp] = 'on';
        await pause(1200); await fresh('unknown');
        fixture.staleRead = false; fixture.futureRead = true; await pause(1200); await fresh('unknown');
        fixture.futureRead = false; fixture.serviceState = 'error';
        await wait(() => headerDisabled(), 'disconnected service blocks actions'); await fresh('unknown');
        fixture.serviceState = 'ready'; fixture.actual[mainIp] = 'off'; await fresh('off');
        assert.equal(fixture.writes.length, before);
      });
      await check('采集或设备配置占用时禁写，接收线程发布的实际状态仍可更新', async () => {
        const before = fixture.writes.length;
        fixture.active = true; fixture.actual[mainIp] = 'on';
        await fresh('on'); await wait(() => headerDisabled(), 'acquisition lock');
        await js('document.querySelector(".field-header-laser button").click()');
        fixture.actual[mainIp] = 'off'; await fresh('off'); assert.equal(fixture.writes.length, before);
        fixture.active = false; fixture.deviceBusy = true;
        await pause(1200); assert.equal(await headerDisabled(), true);
        await js('document.querySelector(".field-header-laser button").click()'); assert.equal(fixture.writes.length, before);
        fixture.deviceBusy = false; await wait(async () => !await headerDisabled(), 'device unlocked');
      });
      await check('迟到的上一设备回读不覆盖新设备状态或触发写入', async () => {
        await click('数据采集', '.field-sidebar');
        fixture.actual[mainIp] = 'on'; fixture.holdNextRead = true; fixture.readRelease = null;
        await wait(() => typeof fixture.readRelease === 'function', 'held old-IP read');
        await js('(()=>{const e=document.querySelector(' + JSON.stringify('input[placeholder="设备 IPv4 地址"]') + ');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,' + JSON.stringify(secondIp) + ');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
        fixture.readRelease(); fixture.readRelease = null;
        await fresh('off'); await pause(150); assert.notEqual(await headerState(), 'on');
        assert.equal(fixture.writes.length, expectedWrites);
      });
      await check('服务代际变化使旧回包失效，新的设备回读才恢复已知状态', async () => {
        fixture.actual[secondIp] = 'on'; fixture.holdNextRead = true; fixture.readRelease = null;
        await wait(() => typeof fixture.readRelease === 'function', 'held old-generation read');
        fixture.generation++; fixture.actual[secondIp] = 'off'; fixture.cached = null;
        await fresh('unknown'); fixture.readRelease(); fixture.readRelease = null;
        await fresh('off'); await pause(150); assert.notEqual(await headerState(), 'on');
        assert.equal(fixture.writes.length, expectedWrites);
      });
      await check('开启前检查取得更新的On回读时不重复写入', async () => {
        fixture.actual[secondIp] = 'on';
        fixture.statusLaserOverride = () => ({ deviceIp: secondIp, state: 'on', readAt: now(), source: 'device-readback', busy: false });
        await headerClick('开启激光'); await fresh('on');
        assert.equal(await js('!!document.querySelector(".field-header-laser-confirm,[role=dialog]")'), false);
        assert.equal(fixture.writes.length, expectedWrites);
        fixture.statusLaserOverride = null;
        fixture.actual[secondIp] = 'off'; await fresh('off');
      });
      await check('写命令失败保持明确错误，后续读回Off不冒充写入成功', async () => {
        const before = fixture.writes.length; fixture.rejectedWrite = true;
        await headerClick('开启激光');
        await wait(() => fixture.writes.length === before + 1, 'failed command dispatched');
        await fresh('off');
        await wait('document.querySelector(".field-header-laser-message")?.textContent.includes("激光命令未确认")', 'write failure retained');
        await pause(1100);
        assert.equal(await headerState(), 'off');
        assert.match(await js('document.querySelector(".field-header-laser-message").textContent'), /激光命令未确认/);
        fixture.rejectedWrite = false;
      });
      await check('设备配置单击开启观察激光无弹窗，顶栏同步回读；自动聚焦仍单独确认', async () => {
        await click('设备与服务', '.field-sidebar');
        await click('读取实际配置', '.field-device-panel');
        const before = fixture.writes.length;
        fixture.holdNextWrite = true; fixture.writeRelease = null;
        await click('开启观察激光', '.field-device-panel');
        await wait(() => typeof fixture.writeRelease === 'function', 'observation laser command pending');
        assert.equal(fixture.writes.length, before + 1);
        assert.equal(fixture.writes.at(-1).action, 'laser_on');
        assert.equal(await js('!!document.querySelector("[role=dialog]")'), false);
        fixture.writeRelease(); fixture.writeRelease = null;
        await fresh('on'); await click('关闭激光', '.field-device-panel'); await fresh('off');
        assert.equal(fixture.writes.length, before + 2);
        await click('读取实际配置', '.field-device-panel');
        await click('安全自动聚焦…', '.field-device-panel');
        await wait('!!document.querySelector(".field-confirm")', 'autofocus confirmation retained');
        assert.equal(fixture.writes.length, before + 2);
        await click('取消', '.field-confirm');
        await click('数据采集', '.field-sidebar');
      });
      await check('1366、1024、480及360窗口顶栏无横向溢出且激光状态与操作均可见', async () => {
        for (const [width, height] of [[1366, 768], [1024, 768], [480, 800], [360, 740]]) {
          win.unmaximize(); win.setMinimumSize(320, 240); win.setContentSize(width, height); await pause(140);
          assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+2'), true);
          assert.equal(await js('(()=>{const e=document.querySelector(".field-header-laser"),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+2&&r.height>0&&r.top>=0;})()'), true);
          assert.equal(await js('(()=>{const e=document.querySelector(".field-header-laser button"),r=e.getBoundingClientRect();return r.width>=40&&r.height>=30&&r.right<=innerWidth+2;})()'), true);
          const file = 'header-laser-' + width + '.png'; fs.writeFileSync(path.join(output, file), (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
        }
      });
      assert.equal(fixture.forbidden.length, 0); finish();
    } catch (error) {
      report.uiText = await js('document.body.innerText').catch(() => null); finish(error);
    }
  });
});
require('../apps/desktop/electron/field-main.cjs');
