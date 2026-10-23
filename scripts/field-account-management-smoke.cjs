// Production renderer, IPC, auth and upload queue; isolated profile, fixture HTTP only.
'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/account-management-20261022'); fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-account-management-'));
app.setPath('userData', profile); delete process.env.BLADE_DEV_URL;
const initial = randomBytes(24).toString('base64url'), local = randomBytes(24).toString('base64url');
const oldSecret = randomBytes(24).toString('base64url'), newSecret = randomBytes(24).toString('base64url');
const localAfter = randomBytes(24).toString('base64url'), salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(initial, salt, 64).toString('hex') } };
const original = 'https://first.example.test', replacement = 'https://second.example.test';
const people = new Map([[original, { username: 'first', name: '原绑定账号', secret: oldSecret }],
  [replacement, { username: 'second', name: '新绑定账号', secret: newSecret }]]);
let newAccountUploadRequests = 0;
global.fetch = async (url, options) => {
  const u = new URL(url), user = people.get(u.origin);
  if (!user) throw Error('Unexpected network destination in isolated fixture');
  if (u.pathname === '/api/v1/session') {
    if (options.method === 'DELETE') return Response.json({ ok: true });
    const body = JSON.parse(options.body);
    if (body.username !== user.username || body.password !== user.secret) return Response.json({}, { status: 401 });
    return Response.json({ token: randomBytes(32).toString('base64url'), user: {
      id: user.username, username: user.username, name: user.name, role: 'admin', tenant: user.username, active: 1 } });
  }
  if (u.pathname.startsWith('/api/v1/captures')) {
    if (u.origin === replacement) newAccountUploadRequests++;
    return Response.json({}, { status: 503 }); // Preserve an old owner's pending upload.
  }
  throw Error('Unexpected fixture endpoint');
};
const record = { id: 'a'.repeat(32), name: '保留本机记录检查', source: 'polytec_ivs500', status: 'complete',
  samples: 100, chunks: 1, sampleRate: 1000, startedAt: 1800000000, sampleOrigin: 1800000000, endedAt: 1800000000.1 };
const directory = path.join(profile, 'field-data/recordings', record.id); fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(record));
const raw = Buffer.alloc(32 + 100 * 29); raw.write('BLADEV01'); raw.writeDoubleLE(1000, 8); raw.writeDoubleLE(1800000000, 16);
for (let i = 0; i < 100; i++) raw.writeBigUInt64LE(BigInt(i), 32 + i * 29);
const rawPath = path.join(directory, 'chunk-00000000.bin'); fs.writeFileSync(rawPath, raw);
const hash = () => createHash('sha256').update(fs.readFileSync(rawPath)).digest('hex'); const originalHash = hash();
const info = () => ({ state: 'ready', dllConfigured: true, executable: 'ISOLATED-ACCOUNT-FIXTURE' });
const status = () => ({ state: 'idle', receiver: { running: false }, service: info() });
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => status(), status: async () => status(), frame: async () => status(),
    shutdown: async () => {}, recordings: async () => ({ recordings: [record] }) }) } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = { hardwareAccessed: false, externalNetworkAccessed: false, checks: [] };
let win; const watchdog = setTimeout(() => finish(Error('Account management UI timed out')), 60000);
function finish(error) { clearTimeout(watchdog); results.passed = !error; if (error) results.error = error.stack;
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results)); app.exit(error ? 1 : 0); }
app.on('browser-window-created', (_, window) => {
  if (win) return; win = window; win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const wait = async code => { for (let i = 0; i < 160; i++) { if (await js(code)) return; await pause(40); } throw Error('Missing UI state: ' + code); };
    const click = text => js(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.getClientRects().length && !el.disabled && el.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw Error('Missing button'); b.click(); })()`);
    const fill = async (selector, value) => { await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`); await pause(30); };
    const reload = () => new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    const screenshot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    try {
      await wait(`document.body.innerText.includes('登录现场工作台')`);
      assert.equal((await field({ action: 'login', username: 'admin', password: initial })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: initial, newPassword: local })).status, 200);
      assert.equal((await field({ action: 'bindAccount', serverUrl: original, username: 'first', password: oldSecret, currentPassword: local })).status, 200);
      await field({ action: 'syncRecording', id: record.id }); await reload();
      await wait(`!!document.querySelector('.field-sidebar')`); await click('设备与服务');
      await wait(`document.body.innerText.includes('更换绑定')`); await click('更换绑定');
      await wait(`!!document.querySelector('.field-account-bind-form')`);
      await fill('[name="currentPassword"]', oldSecret); await fill('[name="serverUrl"]', replacement);
      await fill('[name="username"]', 'second'); await fill('[name="password"]', 'wrong-target-fixture');
      await click('确认更换绑定'); await wait(`!!document.querySelector('.field-account-bind-form [role="alert"]') || document.body.innerText.includes('统一账号或密码错误')`);
      assert.equal((await field({ action: 'accountInfo' })).data.serverUrl, original);
      results.checks.push('Rejected destination password keeps the original binding and form open');
      await fill('[name="currentPassword"]', oldSecret); await fill('[name="password"]', newSecret); await click('确认更换绑定');
      await wait(`!document.querySelector('.field-account-bind-form') && document.body.innerText.includes('新绑定账号')`);
      assert.equal((await field({ action: 'syncStatus' })).data.items.length, 0);
      for (const width of [1440, 1024]) { win.setMinimumSize(640, 480); win.setContentSize(width, 900); await pause(150);
        assert.ok(await js('document.body.scrollWidth <= innerWidth + 2')); await screenshot('bound-' + width); }
      await click('解除绑定'); await wait(`!!document.querySelector('[name="newLocalPassword"]')`); await screenshot('unbind-dialog');
      await fill('[name="currentPassword"]', newSecret); await fill('[name="newLocalPassword"]', localAfter); await fill('[name="confirmation"]', localAfter);
      await click('确认解除绑定'); await wait(`!document.querySelector('[name="newLocalPassword"]') && document.body.innerText.includes('绑定 Web 账号')`);
      assert.equal((await field({ action: 'accountInfo' })).data.mode, 'local');
      assert.equal((await field({ action: 'syncStatus' })).data.items.length, 0);
      assert.equal(hash(), originalHash); assert.equal(newAccountUploadRequests, 0);
      results.checks.push('UI rebind and unbind preserve original recording bytes and isolate pending uploads');
      await screenshot('local-account'); await click('退出'); await wait(`!!document.querySelector('.field-auth-card')`);
      await fill('[name="password"]', localAfter); await click('登录工作台');
      await wait(`!!document.querySelector('.field-sidebar')`); await click('设备与服务'); await click('绑定 Web 账号');
      await wait(`document.body.innerText.includes('当前本机密码')`); await click('取消');
      results.checks.push('Local admin login works with the new password and can bind again'); finish();
    } catch (error) { finish(error); }
  });
});
require(path.join(root, 'apps/desktop/electron/field-main.cjs'));
