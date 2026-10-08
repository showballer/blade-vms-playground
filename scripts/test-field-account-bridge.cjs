// Main-process IPC authorization tests with Electron/service doubles; no UI or hardware.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const mainPath = path.resolve(__dirname, '../apps/desktop/electron/field-main.cjs');
async function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-account-ipc-'));
  const calls = [], handlers = new Map();
  let window, signedIn = false;
  let snapshot = { service: { state: 'ready' }, state: 'idle', receiver: { running: false } };
  const fail = (message, status = 500) => Object.assign(new Error(message), { status });
  const session = () => { if (!signedIn) throw fail('请先登录', 401); return { user: { username: 'admin', name: 'test', role: 'admin' }, mustChangePassword: false }; };
  const auth = {
    info: () => ({ mode: 'local' }), requireSession: session, session,
    login: () => { signedIn = true; return session(); },
    logout: () => { signedIn = false; return { ok: true }; },
    bindAccount: async options => { session(); calls.push(['bind', options]); return session(); },
    changePassword: async (...args) => { session(); calls.push(['password', args]); return session(); },
  };
  const service = { status: async () => snapshot, frame: async () => snapshot, start: async () => ({}),
    begin: async () => { snapshot = { ...snapshot, state: 'acquiring', receiver: { running: true } }; return snapshot; },
    stop: async () => { snapshot = { ...snapshot, state: 'idle', receiver: { running: false } }; return snapshot; },
  };
  class Window {
    constructor() {
      window = this;
      this.webContents = { mainFrame: { url: '' }, setWindowOpenHandler() {}, on() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } };
    }
    on() {}
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
  }
  const electron = { app: { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    on() {}, getPath: () => directory, isPackaged: false, quit() {} }, BrowserWindow: Window,
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), on() {} }, dialog: { showErrorBox: (...args) => { throw Error(args.join(':')); } }, shell: {},
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { width: 1000, height: 800 } }) } };
  const customRequire = name => {
    if (name === 'electron') return electron;
    if (name === './local-auth.cjs') return { createLocalAuth: () => auth };
    if (name === './unified-auth.cjs') return { createUnifiedAuth: () => auth };
    if (name === './field-service.cjs') return { createFieldService: () => service, failure: fail };
    if (name === './field-window.cjs') return { initialWindowBounds: () => ({}) };
    if (name === './bootstrap-admin.json') return {};
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), { require: customRequire, __dirname: path.dirname(mainPath), process: { platform: process.platform, env: {} } }, { filename: mainPath });
  await new Promise(resolve => setImmediate(resolve));
  const request = (options, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }) => handlers.get('blade:field')(event, options);
  return { request, calls, setStatus: next => { snapshot = next; }, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('public account mode never grants a session; untrusted windows cannot read or bind', async () => {
  const h = await harness();
  try {
    assert.equal((await h.request({ action: 'accountInfo' })).data.mode, 'local');
    for (const action of ['bindAccount', 'changePassword', 'status', 'start']) assert.equal((await h.request({ action })).status, 401);
    assert.equal((await h.request({ action: 'accountInfo' }, { sender: {}, senderFrame: { url: 'file://malicious' } })).status, 403);
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});

test('binding and password changes cannot interrupt capture, device operations or unknown service state', async () => {
  const h = await harness();
  try {
    await h.request({ action: 'login' });
    for (const state of [
      { service: { state: 'ready' }, state: 'acquiring', receiver: { running: true } },
      { service: { state: 'ready' }, state: 'idle', deviceBusy: true },
      { service: { state: 'ready', error: 'transport unavailable' }, state: 'idle' },
    ]) {
      h.setStatus(state);
      for (const action of ['bindAccount', 'changePassword']) assert.equal((await h.request({ action })).status, 409);
    }
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});

test('capture start and account mutations share the serialized safety boundary', async () => {
  const h = await harness();
  try {
    await h.request({ action: 'login' });
    const [started, binding] = await Promise.all([h.request({ action: 'start', config: {} }), h.request({ action: 'bindAccount' })]);
    assert.equal(started.status, 200); assert.equal(binding.status, 409);
    assert.equal(h.calls.length, 0);
    assert.equal((await h.request({ action: 'stop' })).status, 200);
    const options = { action: 'bindAccount', serverUrl: 'https://example.invalid', username: 'operator', password: 'test-only', currentPassword: 'local-test-only', arbitraryPath: '/private/data' };
    assert.equal((await h.request(options)).status, 200);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(Object.keys(h.calls[0][1]).sort(), ['currentPassword', 'password', 'serverUrl', 'username']);
    assert.equal((await h.request({ action: 'changePassword', currentPassword: 'old-test', newPassword: 'new-test' })).status, 200);
  } finally { h.cleanup(); }
});

test('desktop package includes the unified authentication module', () => {
  const config = require('../apps/desktop/package.json');
  assert.ok(config.build.files.includes('electron/unified-auth.cjs'));
});
