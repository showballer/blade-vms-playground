// Real Electron main/preload/renderer; isolated credentials, no device or Python process.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/field-desktop-smoke');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-field-smoke-'));
app.setPath('userData', profile);
const initial = randomBytes(24).toString('base64url'), changed = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(initial, salt, 64).toString('hex') } };
delete process.env.BLADE_DEV_URL;
let checks = 0;
const watchdog = setTimeout(() => { console.error('Field Electron smoke timed out'); app.exit(1); }, 45000);
async function waitFor(fn, description) {
  const until = Date.now() + 8000;
  while (Date.now() < until) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw Error('Timed out: ' + description);
}
async function check(label, fn) { await fn(); checks += 1; console.log('PASS ' + label); }
app.on('browser-window-created', (_event, win) => {
  const wc = win.webContents;
  wc.once('did-finish-load', async () => {
    const js = code => wc.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const body = () => js('document.body.innerText');
    const reload = () => new Promise(resolve => { wc.once('did-finish-load', resolve); wc.reload(); });
    try {
      await waitFor(async () => (await body()).includes('登录现场工作台'), 'local login');
      await check('production local resources and sandboxed, restricted field bridge', async () => {
        assert.ok(wc.getURL().startsWith('file://'));
        const prefs = wc.getLastWebPreferences();
        assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true);
        assert.equal(await js('typeof window.require'), 'undefined');
        assert.deepEqual(await js('Object.keys(window.blade).sort()'), ['field', 'version', 'windowControl']);
        assert.ok(!(await body()).includes('离线演示工作区'));
      });
      fs.writeFileSync(path.join(output, '01-login.png'), (await wc.capturePage()).toPNG());
      await check('unauthenticated operations are denied', async () => {
        for (const action of ['status', 'frame', 'recordings', 'start', 'openDataDirectory']) assert.equal((await field({ action })).status, 401);
      });
      await check('incorrect password fails and first login requires password change', async () => {
        assert.equal((await field({ action: 'login', username: 'admin', password: 'incorrect' })).status, 401);
        const result = await field({ action: 'login', username: 'admin', password: initial });
        assert.equal(result.status, 200); assert.equal(result.data.mustChangePassword, true);
        assert.equal((await field({ action: 'start', config: {} })).status, 403);
        await reload();
        await waitFor(async () => (await body()).includes('首次登录'), 'mandatory password screen');
      });
      fs.writeFileSync(path.join(output, '02-password.png'), (await wc.capturePage()).toPNG());
      await check('password persistence unlocks local workspace without management server', async () => {
        assert.equal((await field({ action: 'changePassword', currentPassword: initial, newPassword: changed })).status, 200);
        const credential = fs.readFileSync(path.join(profile, 'blade-local-auth.json'), 'utf8');
        assert.ok(!credential.includes(initial) && !credential.includes(changed));
        await reload();
        await waitFor(async () => (await body()).includes('开始真实采集'), 'field acquisition page');
        assert.ok((await body()).includes('本机运行'));
      });
      await check('missing Windows service shows empty data and disabled start, never demo', async () => {
        await waitFor(async () => (await body()).includes('采集服务未安装'), 'missing service status');
        assert.equal((await field({ action: 'frame' })).data.service.state, 'missing');
        assert.ok((await body()).includes('等待真实振动数据'));
        assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("开始真实采集")).disabled'), true);
        assert.ok(!fs.existsSync(path.join(profile, 'blade-offline.json')));
      });
      fs.writeFileSync(path.join(output, '03-acquisition-missing.png'), (await wc.capturePage()).toPNG());
      await js('[...document.querySelectorAll(".field-sidebar button")].find(b=>b.textContent.includes("设备与服务")).click()');
      await waitFor(async () => (await body()).includes('Windows 实机联调检查'), 'service settings page');
      fs.writeFileSync(path.join(output, '04-settings.png'), (await wc.capturePage()).toPNG());
      await check('logout clears session and old password cannot log back in', async () => {
        assert.equal((await field({ action: 'logout' })).status, 200);
        assert.equal((await field({ action: 'session' })).status, 401);
        assert.equal((await field({ action: 'login', username: 'admin', password: initial })).status, 401);
        assert.equal((await field({ action: 'login', username: 'admin', password: changed })).status, 200);
        assert.equal((await field({ action: 'unknown-operation' })).status, 400);
      });
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: checks, hardwareTested: false, profile, screenshots: 4 }, null, 2));
      console.log(`PASS ${checks} native field smoke checks; no hardware or actual credentials used`);
      clearTimeout(watchdog); app.exit(0);
    } catch (error) { console.error(error); clearTimeout(watchdog); app.exit(1); }
  });
});
require('../apps/desktop/electron/field-main.cjs');
