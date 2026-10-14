// Native Electron responsive QA only. Production main/preload/UI, random temporary
// credentials, and a test-only service module. Never launches Python or touches hardware.
// Run after the desktop Vite build: electron scripts/field-responsive-smoke.cjs
'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'field-responsive-smoke');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-responsive-qa-'));
app.setPath('userData', profile);
delete process.env.BLADE_DEV_URL;
const initial = randomBytes(24).toString('base64url');
const changed = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const bootstrapFile = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrapFile)] = { id: bootstrapFile, filename: bootstrapFile, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(initial, salt, 64).toString('hex') } };

const fixture = { active: false, beginCalls: 0, stopCalls: 0, factories: 0 };
const serviceModule = path.join(root, 'apps/desktop/electron/field-service.cjs');
const serviceInfo = () => ({ state: 'ready', error: null, dllConfigured: true,
  executable: 'C:\\TEST-ONLY-RESPONSIVE-QA\\中文安装路径 with spaces\\独立采集服务及运行环境\\BladeAcquisition.exe' });
function snapshot() {
  return { state: fixture.active ? 'acquiring' : 'idle', error: null, indexWarning: null,
    service: serviceInfo(), receiver: { source: 'explicit-test-fixture', running: fixture.active,
      deviceIp: '', hostIp: '', channels: ['CH1', 'RSSI1'], dllAvailable: true },
    recording: fixture.active ? { id: 'f'.repeat(32), name: 'TEST ONLY · 响应式停止按钮检查（不连接设备）',
      status: 'incomplete', samples: 0, sampleRate: null, startedAt: 1700000000,
      object: '', turbine: '', point: '', error: null } : null,
    waveform: { values: [], rssi: [], overrange: [], sampleRate: null, unit: 'm/s',
      rssiUnit: '%', sampleStart: 0, sampleStride: 1 } };
}
require.cache[require.resolve(serviceModule)] = { id: serviceModule, filename: serviceModule, loaded: true,
  exports: {
    failure: (message, status = 503) => Object.assign(Error(message), { status }),
    createFieldService() {
      fixture.factories += 1;
      return { start: async () => snapshot(), status: async () => snapshot(), frame: async () => snapshot(),
        serviceInfo, recordings: async () => ({ recordings: [] }),
        begin: async () => { fixture.beginCalls += 1; throw Error('Responsive QA MUST NOT start acquisition'); },
        stop: async () => { fixture.stopCalls += 1; fixture.active = false; return snapshot(); },
        shutdown: async () => { fixture.active = false; } };
    },
  } };

const sizes = [
  { name: '1366x768', width: 1366, height: 768, zoom: 1 },
  { name: '1280x720', width: 1280, height: 720, zoom: 1 },
  { name: '1024x600', width: 1024, height: 600, zoom: 1 },
  { name: '853x480', width: 853, height: 480, zoom: 1 },
  { name: '1366x768-zoom150', width: 1366, height: 768, zoom: 1.5 },
  { name: '1280x720-zoom150', width: 1280, height: 720, zoom: 1.5 },
];
const report = { startedAt: new Date().toISOString(), platform: process.platform, hardwareTested: false,
  realServiceStarted: false, fixture: 'test-only require.cache service; zero samples and empty records',
  note: 'Window minimum is relaxed only in this test to exercise low-resolution CSS. Native window launch bounds are a separate test.',
  checks: [], screenshots: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let currentCase = 'startup';
let activeWindow;
const watchdog = setTimeout(() => finish(Error(`Responsive smoke watchdog: ${currentCase}`)), 180000);

function finish(error) {
  clearTimeout(watchdog);
  report.passed = !error;
  report.finishedAt = new Date().toISOString();
  report.fixtureBeginCalls = fixture.beginCalls;
  report.fixtureStopCalls = fixture.stopCalls;
  if (error) report.error = { case: currentCase, message: error.message };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  if (error) console.error(error);
  else console.log(`PASS ${report.checks.length} native responsive checks, ${report.screenshots.length} screenshots; no hardware or real credentials used`);
  app.exit(error ? 1 : 0);
}

async function waitFor(fn, label, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await pause(60);
  }
  throw Error(`Timed out: ${label}`);
}

async function check(label, fn) {
  currentCase = label;
  const details = await fn();
  report.checks.push({ name: label, passed: true, ...(details ? { details } : {}) });
  console.log(`PASS ${label}`);
}

app.on('browser-window-created', (_event, win) => {
  if (activeWindow) return;
  activeWindow = win;
  const wc = win.webContents;
  // QA may run while another app covers this window. Do not let compositor
  // visibility suspend geometry checks; this affects only the disposable test.
  wc.setBackgroundThrottling(false);
  wc.once('did-finish-load', async () => {
    const js = code => wc.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const body = () => js('document.body.innerText');
    const reload = () => new Promise(resolve => { wc.once('did-finish-load', resolve); wc.reload(); });
    const button = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(element => element.textContent.trim() === ${JSON.stringify(text)})`;
    const screenshot = async name => {
      const file = `${name}.png`;
      fs.writeFileSync(path.join(output, file), (await wc.capturePage()).toPNG());
      report.screenshots.push(file);
    };
    const noHorizontalOverflow = () => js(`(() => ({ viewport: innerWidth,
      document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      root: document.querySelector('.field-app').scrollWidth }))()`);
    const assertNoHorizontalOverflow = async () => {
      const value = await noHorizontalOverflow();
      assert.ok(value.document <= value.viewport + 2 && value.body <= value.viewport + 2 && value.root <= value.viewport + 2,
        `Horizontal document overflow: ${JSON.stringify(value)}`);
      return value;
    };
    const layout = selector => js(`(() => { const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null; const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return { overflowY: style.overflowY, overflowX: style.overflowX, scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; })()`);
    const reach = async (expression, scroll = true) => {
      const result = await js(`(async () => {
        const element = ${expression}; if (!element) throw Error('QA target missing');
        if (${scroll}) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        await new Promise(resolve => setTimeout(resolve, 35));
        const rect = element.getBoundingClientRect();
        const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        const clippedBy = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2)) clippedBy.push(parent.className || parent.tagName);
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left < bounds.left - 2 || rect.right > bounds.right + 2)) clippedBy.push(parent.className || parent.tagName);
        }
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { text: element.textContent.trim().slice(0, 80), box, disabled: Boolean(element.disabled),
          inViewport: rect.top >= -2 && rect.left >= -2 && rect.right <= innerWidth + 2 && rect.bottom <= innerHeight + 2,
          clippedBy, hit: Boolean(hit && (element === hit || element.contains(hit))) };
      })()`);
      assert.ok(result.box.width > 0 && result.box.height > 0 && result.inViewport && !result.clippedBy.length && result.hit,
        `Unreachable target ${expression}: ${JSON.stringify(result)}`);
      return result;
    };
    const resize = async size => {
      win.unmaximize();
      win.setMinimumSize(360, 240);
      win.setContentSize(size.width, size.height);
      wc.setZoomFactor(size.zoom);
      // Chromium may apply a restored per-origin zoom after did-finish-load.
      // Wait for real geometry and reassert the intended test scale, not a fixed sleep.
      let actual;
      await waitFor(async () => {
        wc.setZoomFactor(size.zoom);
        actual = await js('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
        return Math.abs(actual.width - size.width / size.zoom) <= 2 && Math.abs(actual.height - size.height / size.zoom) <= 2;
      }, 'native viewport geometry');
      assert.ok(Math.abs(actual.width - size.width / size.zoom) <= 2 && Math.abs(actual.height - size.height / size.zoom) <= 2,
        `Native viewport did not resize: ${JSON.stringify({ size, actual, contentSize: win.getContentSize() })}`);
      return actual;
    };
    const scrollMain = async fraction => {
      await js(`(() => { const main = document.querySelector('.field-content'); main.scrollTop = (main.scrollHeight - main.clientHeight) * ${fraction}; })()`);
      await pause(60);
      return layout('.field-content');
    };
    const navigate = async (text, expected) => {
      const target = button('.field-sidebar', text);
      await reach(target);
      await js(`${target}.click()`);
      await waitFor(async () => (await body()).includes(expected), expected);
      await scrollMain(0);
    };

    try {
      await waitFor(async () => (await body()).includes('登录现场工作台'), 'local login');
      assert.equal(fixture.factories, 1, 'Main must use only the explicit test service factory');
      const prefs = wc.getLastWebPreferences();
      assert.equal(prefs.nodeIntegration, false);
      assert.equal(prefs.sandbox, true);
      assert.equal(prefs.contextIsolation, true);
      assert.equal(await js('typeof window.require'), 'undefined');
      await js(`localStorage.setItem('blade-field-config-v1', ${JSON.stringify(JSON.stringify({
        name: 'TEST ONLY · 响应式确认弹窗（不连接设备）', object: '响应式测试', turbine: '', point: '',
        deviceIp: '192.0.2.10', hostIp: '192.0.2.20',
      }))})`);

      for (const size of sizes) await check(`${size.name}: login fields and submit vertically reachable`, async () => {
        const viewport = await resize(size);
        await reach("document.querySelector('.field-auth-card h2')");
        for (const expression of ["document.querySelector('.field-auth-card input[name=username]')",
          "document.querySelector('.field-auth-card input[name=password]')", button('.field-auth-card', '登录工作台'),
          "document.querySelector('.field-auth-footnote')"]) await reach(expression);
        await assertNoHorizontalOverflow();
        await screenshot(`${size.name}-login`);
        return { viewport, scroll: await layout('.field-auth-shell') };
      });

      assert.equal((await field({ action: 'login', username: 'admin', password: initial })).status, 200);
      await reload();
      await waitFor(async () => (await body()).includes('首次登录'), 'mandatory password UI');
      for (const size of sizes) await check(`${size.name}: password controls vertically reachable`, async () => {
        const viewport = await resize(size);
        await reach("document.querySelector('.field-password-card h2')");
        for (let index = 0; index < 3; index++) await reach(`document.querySelectorAll('.field-password-card input')[${index}]`);
        await reach(button('.field-password-card', '保存新密码'));
        await reach(button('.field-password-card', '退出登录'));
        await assertNoHorizontalOverflow();
        await screenshot(`${size.name}-password`);
        return { viewport, scroll: await layout('.field-password-shell') };
      });
      assert.equal((await field({ action: 'changePassword', currentPassword: initial, newPassword: changed })).status, 200);
      await reload();
      await waitFor(async () => (await body()).includes('开始采集'), 'authenticated acquisition UI');

      for (const size of sizes) {
        await check(`${size.name}: acquisition has a bounded vertical scroll area`, async () => {
          const viewport = await resize(size);
          await reload();
          await waitFor(async () => (await body()).includes('开始采集'), 'fresh acquisition UI');
          await navigate('数据采集', '采集任务');
          const top = await layout('.field-content');
          assert.ok(['auto', 'scroll'].includes(top.overflowY), `Main overflowY must scroll: ${JSON.stringify(top)}`);
          assert.ok(top.scrollHeight > top.clientHeight + 5, 'This acquisition layout needs real vertical scrolling');
          await assertNoHorizontalOverflow();
          await screenshot(`${size.name}-acquisition-top`);
          const bottom = await scrollMain(1);
          assert.ok(bottom.scrollTop > 0 && Math.abs(bottom.scrollHeight - bottom.clientHeight - bottom.scrollTop) <= 2,
            `Main could not reach its end: ${JSON.stringify(bottom)}`);
          await screenshot(`${size.name}-acquisition-bottom`);
          return { viewport, top, bottom };
        });

        await check(`${size.name}: confirmation dialog safety checks and footer reachable`, async () => {
          const start = button('.field-capture-inputs', '开始采集');
          assert.equal((await reach(start)).disabled, false);
          await js(`${start}.click()`);
          await waitFor(() => js("Boolean(document.querySelector('dialog[open]'))"), 'start confirmation dialog');
          await reach("document.querySelector('dialog .dialog-heading h2')");
          for (let index = 0; index < 3; index++) {
            const checkbox = `document.querySelectorAll('dialog input[type=checkbox]')[${index}]`;
            await reach(checkbox);
            await js(`${checkbox}.click()`);
          }
          const confirm = button('dialog', '确认并开始采集');
          assert.equal((await reach(confirm)).disabled, false);
          await reach(button('dialog', '取消'));
          await reach("document.querySelector('dialog .dialog-heading h2')", false);
          await reach("document.querySelector('dialog .dialog-heading button')", false);
          await reach(confirm, false);
          const dialog = await layout('dialog');
          assert.ok(dialog.rect.y >= -2 && dialog.rect.y + dialog.rect.height <= size.height / size.zoom + 2,
            `Dialog exceeds viewport: ${JSON.stringify(dialog)}`);
          await assertNoHorizontalOverflow();
          await screenshot(`${size.name}-dialog-bottom`);
          await js(`${button('dialog', '取消')}.click()`);
          await waitFor(() => js("!document.querySelector('dialog[open]')"), 'confirmation dismissed without starting');
          assert.equal(fixture.beginCalls, 0);
          return dialog;
        });

        await check(`${size.name}: settings buttons reachable and empty records fit`, async () => {
          await navigate('设备与服务', 'Windows 实机联调检查');
          for (const text of ['选择采集服务 EXE', '选择设备 DLL', '重启采集服务', '打开数据目录']) {
            assert.equal((await reach(button('.field-service-actions', text))).disabled, false);
          }
          await scrollMain(1);
          await assertNoHorizontalOverflow();
          await screenshot(`${size.name}-settings-bottom`);
          await navigate('本机记录', '还没有真实采集记录');
          await reach("document.querySelector('.field-recordings-empty h3')");
          await reach("document.querySelector('.field-recordings-empty p')");
          const bounds = await layout('.field-recordings-empty');
          assert.ok(bounds.scrollWidth <= bounds.clientWidth + 2, 'Empty-record message overflows its card');
          await assertNoHorizontalOverflow();
          await screenshot(`${size.name}-empty-records`);
          return { empty: bounds };
        });

        await check(`${size.name}: sticky stop stays reachable at bottom of active workspace`, async () => {
          await navigate('数据采集', '采集任务');
          fixture.active = true;
          await waitFor(async () => (await body()).includes('正在采集'), 'explicit active UI fixture');
          await scrollMain(1);
          const sticky = "[...document.querySelectorAll('.field-live-controls button')].find(element => element.textContent.trim() === '停止并保存')";
          assert.equal((await reach(sticky, false)).disabled, false);
          await assertNoHorizontalOverflow();
          await screenshot(`${size.name}-active-sticky-stop`);
          for (const [tab, text] of [['设备与服务', 'Windows 实机联调检查'], ['本机记录', '还没有真实采集记录']]) {
            await navigate(tab, text);
            await scrollMain(1);
            assert.equal((await reach(sticky, false)).disabled, false,
              'Stop/save control must remain reachable after switching workspace tabs');
            await assertNoHorizontalOverflow();
          }
          await screenshot(`${size.name}-active-records-stop`);
          const before = fixture.stopCalls;
          await js(`${sticky}.click()`);
          await waitFor(() => fixture.stopCalls === before + 1 && !fixture.active, 'test-only stop action');
          await waitFor(async () => !(await body()).includes('正在采集'), 'idle UI restored after fixture stop');
          assert.equal(fixture.beginCalls, 0);
          return { mockStops: fixture.stopCalls, realStartCalls: fixture.beginCalls, reachableTabs: ['acquisition', 'service', 'recordings'] };
        });
      }
      finish();
    } catch (error) {
      try {
        await screenshot('failure');
        fs.writeFileSync(path.join(output, 'failure-dom.json'), JSON.stringify({ case: currentCase,
          text: await body(), viewport: await noHorizontalOverflow(), main: await layout('.field-content') }, null, 2));
      } catch { /* Preserve the original verification failure. */ }
      finish(error);
    }
  });
});

require('../apps/desktop/electron/field-main.cjs');
