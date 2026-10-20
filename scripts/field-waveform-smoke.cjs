// Native Electron interaction QA with an explicit test-only service. No device,
// laser, real user credentials, or production recordings are used by this test.
'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/field-waveform-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-waveform-qa-')));
delete process.env.BLADE_DEV_URL;
const initial = randomBytes(24).toString('base64url'), changed = randomBytes(24).toString('base64url'), salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true, exports: {
  version: 1, username: 'admin', salt, hash: scryptSync(initial, salt, 64).toString('hex') } };
const fixture = { active: false, frames: 0, stops: 0, starts: 0, frameWindows: [], waveRequests: [], deviceRequests: [] };
const record = { id: 'a'.repeat(32), name: 'TEST ONLY · 波形浏览交互验证', samples: 500000, sampleRate: 218750,
  sampleOrigin: 1700000000, startedAt: 1699999999, status: 'complete', velocityRangeMps: 0.5 };
const panelRequests = () => fixture.deviceRequests.filter(request => request.action !== 'laser_read');
const fields = { velocityRange: { supported: true, writable: true, value: '500 mm/s', options: ['500 mm/s', '100 mm/s'] },
  bandwidth: { supported: true, writable: true, value: '10 kHz', options: ['10 kHz', '5 kHz'] },
  highPass: { supported: true, writable: true, value: 'Off', options: ['Off', '13 Hz'] },
  ase: { supported: true, writable: true, value: 0, options: [0, 1] }, laser: { supported: true, value: 0 },
  focusPosition: { supported: true, value: 399 }, autofocus: { supported: true, value: 0 }, signalLevel: { supported: true, value: 82, percent: 82 } };
function wave(start, end, phase = 0) {
  const result = { sampleRate: record.sampleRate, sampleOrigin: record.sampleOrigin, sampleStart: start,
    rangeStart: start, rangeEnd: end, sourceSamples: end - start, unit: 'm/s', rssiUnit: '%', sampleStride: 1,
    values: [], rssi: [], overrange: [], overrangeCount: 0, missingRssiCount: 0, latest: { velocity: 0.000016785, rssi: 82.6 } };
  if (end - start <= 4096) {
    result.representation = 'raw';
    for (let index = start; index < end; index++) { result.values.push(Math.sin(index / 30 + phase) * 0.00003); result.rssi.push(82 + Math.sin(index / 50)); result.overrange.push(false); }
  } else {
    result.representation = 'envelope'; result.envelope = [];
    const step = Math.ceil((end - start) / 800);
    for (let index = start; index < end; index += step) result.envelope.push({ start: index, end: Math.min(end, index + step), min: -0.00004, max: 0.00004 + Math.sin(index / 100) * 0.00001, rssiMin: 81, rssiMax: 83, missing: 0, overrange: 0 });
  }
  return result;
}
const serviceInfo = () => ({ state: 'ready', dllConfigured: true, executable: 'C:\\TEST-ONLY\\BladeAcquisition.exe' });
function snapshot() { fixture.frames += 1; return { service: serviceInfo(), state: fixture.active ? 'acquiring' : 'idle',
  receiver: { running: fixture.active }, recording: { ...record, status: fixture.active ? 'incomplete' : 'complete', samples: record.samples + fixture.frames * 5000 },
  waveform: wave(fixture.frames * 5000, fixture.frames * 5000 + 2048, fixture.frames) }; }
const moduleFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(moduleFile)] = { id: moduleFile, filename: moduleFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo, start: async () => snapshot(), status: async () => snapshot(), frame: async windowMs => { fixture.frameWindows.push(windowMs); return snapshot(); },
    begin: async () => { fixture.starts++; throw Error('QA must never begin actual acquisition'); },
    stop: async () => { fixture.stops++; fixture.active = false; return snapshot(); }, shutdown: async () => {},
    recordings: async id => id ? { recording: record, waveform: wave(497952, 500000) } : { recordings: [record] },
    waveform: async (id, start = 0, end = 500000) => { fixture.waveRequests.push({ id, start, end }); await new Promise(r => setTimeout(r, 80)); return { recording: record, waveform: wave(start, end) }; },
    device: async request => { fixture.deviceRequests.push(request);
      if (request.action === 'laser_read') return { deviceIp: request.deviceIp, state: 'off', laser: 0, readAt: Date.now()/1000, source: 'explicit-test-fixture', busy: false };
      if (request.action === 'set') fields[request.key].value = request.value;
      return { deviceIp: request.deviceIp, readAt: 1700000000, source: 'explicit-test-fixture', fields: structuredClone(fields) }; },
  }),
} };
const report = { hardwareTested: false, fixture: 'explicit native UI test service', checks: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let watchdog = setTimeout(() => finish(Error('Native waveform QA timed out')), 120000);
function finish(error) { clearTimeout(watchdog); report.passed = !error; report.error = error?.message; report.requests = fixture;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); if (error) console.error(error); app.exit(error ? 1 : 0); }
app.on('browser-window-created', (_event, win) => {
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.once('did-finish-load', async () => {
    const js = async code => {
      // Preserve the actual renderer error without logging expressions that can
      // contain the test-only login password.
      const result = await wc.executeJavaScript(`(async () => { try { return { value: await (${code}) }; } catch (error) { return { error: error.message }; } })()`, true);
      if (result.error) throw Error('Renderer QA: ' + result.error);
      return result.value;
    };
    const body = () => js('document.body.innerText');
    async function waitFor(fn, label) { const end = Date.now() + 12000; while (Date.now() < end) { if (await fn()) return; await pause(70); } throw Error('Timeout: ' + label); }
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const reload = () => new Promise(resolve => { wc.once('did-finish-load', resolve); wc.reload(); });
    const click = async (text, scope = 'document') => {
      // Controls render before the initial status request completes. Windows CI
      // must wait for the same enabled state a user needs, not just button text.
      await waitFor(() => js(`(() => { const root = ${scope}; const b = root && [...root.querySelectorAll('button')].find(b => !b.disabled && b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`), 'enabled button: ' + text);
    };
    const set = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
    const select = async (label, option) => {
      const selector = `[role="combobox"][aria-label=${JSON.stringify(label)}]`;
      await waitFor(() => js(`(() => { const trigger = document.querySelector(${JSON.stringify(selector)}); if (!trigger || trigger.disabled) return false; trigger.scrollIntoView({block:'center'}); trigger.click(); return true; })()`), 'enabled combobox: ' + label);
      await waitFor(() => js(`(() => { const trigger = document.querySelector(${JSON.stringify(selector)}); const popup = document.getElementById(trigger?.getAttribute('aria-controls')); const item = popup && [...popup.querySelectorAll('[role="option"]')].find(item => item.textContent.trim() === ${JSON.stringify(option)} && item.getAttribute('aria-disabled') !== 'true'); if (!item) return false; item.click(); return true; })()`), 'select option: ' + option);
      await waitFor(() => js(`(() => { const trigger = document.querySelector(${JSON.stringify(selector)}); return trigger?.getAttribute('aria-expanded') === 'false' && trigger.textContent.trim() === ${JSON.stringify(option)}; })()`), 'selected option: ' + option);
    };
    async function check(label, fn) { await fn(); report.checks.push(label); console.log('PASS '+label); }
    const capture = async name => { fs.writeFileSync(path.join(output, name+'.png'), (await wc.capturePage()).toPNG()); };
    try {
      await waitFor(async () => (await body()).includes('登录现场工作台'), 'login');
      assert.equal((await field({ action: 'waveform', id: record.id })).status, 401);
      assert.equal((await field({ action: 'device', request: { deviceIp: '192.0.2.10', action: 'read' } })).status, 401);
      assert.equal((await field({ action: 'login', username: 'admin', password: initial })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: initial, newPassword: changed })).status, 200);
      assert.equal((await field({ action: 'session' })).data.mustChangePassword, false);
      // A real first-time user changes their password before capture starts.
      // Only now mark this explicit test fixture as capturing; never start hardware.
      fixture.active = true;
      await reload();
      await waitFor(async () => (await body()).includes('暂停显示'), 'live controls');
      await check('active capture keeps password changes blocked', async () => {
        assert.equal((await field({ action: 'changePassword', currentPassword: changed, newPassword: initial })).status, 409);
        assert.equal(await js(`document.querySelector('button[aria-label="修改本机密码"]').disabled`), true);
      });
      await check('custom display selectors update units, time axis and requested window', async () => {
        await js('document.querySelector(".field-chart-options summary").click()');
        await select('速度单位', 'm/s');
        assert.equal(await js(`document.querySelectorAll('svg[aria-label="CH1 振动速度曲线，单位米每秒"]').length`), 1);
        await select('横坐标', '实际时间（本机推算）');
        assert.deepEqual(await js('[...document.querySelectorAll(".field-capture-chart .field-wave-axis-label")].map(e=>e.textContent)'), ['本机时间', '本机时间']);
        await select('实时显示时间窗', '100 ms');
        await waitFor(() => fixture.frameWindows.at(-1) === 100, '100 ms frame request');
        await select('速度单位', 'mm/s');
        await select('横坐标', '相对采集时间');
        assert.deepEqual(await js('[...document.querySelectorAll(".field-capture-chart .field-wave-axis-label")].map(e=>e.textContent)'), ['相对时间 / ms', '相对时间 / ms']);
      });
      await check('pause freezes both plots while metrics and stop remain active', async () => {
        await click('暂停显示');
        await pause(100);
        const plots = await js('[...document.querySelectorAll(".field-capture-chart svg.field-wave-svg path")].map(p=>p.getAttribute("d"))');
        assert.equal(plots.length, 2, 'Both CH1 and RSSI must exist before comparing frozen plots');
        const frames = fixture.frames;
        await pause(1300);
        assert.ok(fixture.frames > frames);
        assert.deepEqual(await js('[...document.querySelectorAll(".field-capture-chart svg.field-wave-svg path")].map(p=>p.getAttribute("d"))'), plots);
        assert.ok((await body()).includes('显示已暂停，采集和保存仍在继续。'));
        await capture('01-paused');
        await click('恢复显示');
        await click('停止并保存', 'document.querySelector(".field-live-controls")');
        await waitFor(() => fixture.stops === 1, 'stop');
        // Receiving stop is not UI completion: the handler still flushes the
        // capture and refreshes records before clearing stoppingCapture. Its
        // operation guard intentionally ignores record actions during cleanup.
        await waitFor(() => js('!document.querySelector(".field-live-controls")'), 'stop/save UI cleanup');
      });
      await click('本机记录'); await waitFor(async () => (await body()).includes('查看波形'), 'records'); await click('查看波形');
      await check('history opens the entire recording, not just its tail', async () => {
        await waitFor(() => js('!!document.querySelector(".field-recording-preview")'), 'record preview opened');
        await waitFor(() => js(`document.querySelector('.field-recording-preview [data-testid="wave-representation"]')?.textContent.includes('区间最小/最大值包络')`), 'overview');
        assert.deepEqual(fixture.waveRequests.at(-1), { id: record.id, start: 0, end: 500000 });
        await js('document.querySelector(".field-recording-preview").scrollIntoView({block:"start"})');
        await capture('02-full-record');
      });
      await check('precise interval loads original samples and CH1/RSSI share axes', async () => {
        await set('[aria-label="波形起点秒"]', '0.01'); await set('[aria-label="波形终点秒"]', '0.02'); await click('查看时间段');
        await waitFor(async () => (await body()).includes('当前区间显示全部原始点'), 'raw zoom');
        assert.equal(fixture.waveRequests.at(-1).start, 2187); assert.equal(fixture.waveRequests.at(-1).end, 4375);
        assert.equal(await js('document.querySelectorAll(".field-full-waveform > h3").length'), 2);
        await capture('03-raw-range');
        await click('后一段 →');
        await waitFor(() => fixture.waveRequests.at(-1).start > 2187, 'pan');
      });
      await check('horizontal slider and overview pointer selection request bounded ranges', async () => {
        await set('[aria-label="横向浏览波形"]', '80000');
        await waitFor(() => fixture.waveRequests.at(-1).start === 80000, 'slider');
        await js('document.querySelector(".field-wave-overview").scrollIntoView({block:"center"})');
        await pause(100);
        const rect = await js('(() => { const r=document.querySelector(".field-overview-selection").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
        const x = Math.round(rect.x), y = Math.round(rect.y);
        wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
        wc.sendInputEvent({ type: 'mouseMove', x: x+35, y });
        wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: x+35, y });
        await waitFor(() => fixture.waveRequests.at(-1).start !== 80000 || fixture.waveRequests.at(-1).end !== 82188, 'overview drag');
      });
      await js('document.querySelector("dialog button[aria-label=关闭弹窗]").click()');
      await click('设备与服务'); await set('[aria-label="配置设备 IP"]', '192.0.2.10'); await click('读取实际配置');
      await check('device options come from readback and changing a draft does not write', async () => {
        await waitFor(async () => (await body()).includes('上次读回'), 'settings read');
        assert.equal(panelRequests().length, 1); assert.equal(panelRequests()[0].action, 'read');
        await select('带宽', '5 kHz');
        assert.equal(panelRequests().length, 1);
        await click('应用此项');
        assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="确认执行").disabled'), true);
        await js('document.querySelector(".field-confirm input[type=checkbox]").click()');
        await click('确认执行');
        await waitFor(() => panelRequests().length === 2, 'setting confirmed');
        assert.equal(panelRequests()[1].confirmChange, true);
        assert.equal(panelRequests()[1].key, 'bandwidth');
        await waitFor(async () => (await body()).includes('已修改并读回确认'), 'verified setting');
        await capture('04-device-settings');
      });
      await check('autofocus requires separate laser confirmation and no implicit start', async () => {
        await click('安全自动聚焦…');
        assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="确认执行").disabled'), true);
        assert.ok((await body()).includes('临时开启真实设备激光'));
        await click('取消');
        assert.equal(panelRequests().length, 2); assert.equal(fixture.starts, 0);
      });
      await check('new settings and waveform controls fit 853x480 with vertical scrolling', async () => {
        win.setMinimumSize(360,240); win.setContentSize(853,480); await pause(250);
        assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 2'));
        await capture('05-small-settings');
        await click('本机记录'); await click('查看波形');
        await waitFor(async () => (await body()).includes('全程概览'), 'small overview');
        await js('document.querySelector(".field-recording-preview").scrollIntoView({block:"start"})');
        assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 2'));
        await capture('06-small-waveform');
      });
      finish();
    } catch (error) { await capture('failure'); finish(error); }
  });
});
require('../apps/desktop/electron/field-main.cjs');
