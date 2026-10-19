'use strict';
// Exercise the actual Electron main/IPC assembly. Only OS windows, credentials,
// hardware service and network queue are replaced; the durable tracker is real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createCaptureTracker } = require('../apps/desktop/electron/field-capture-tracker.cjs');
const mainFile = path.resolve(__dirname, '../apps/desktop/electron/field-main.cjs'), mainRequire = createRequire(mainFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (check()) return; await pause(10); }
  assert.fail('Timed out waiting for actual field-main assembly');
}
async function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-capture-main-'));
  const records = path.join(directory, 'field-data/recordings'); fs.mkdirSync(records, { recursive: true });
  const binding = { serverUrl: 'http://localhost:3000', user: { id: 'owner', tenant: 'tenant' } };
  const observed = new Map(); let win, ipc, tracker, startedWith, enabled = true, queueDisposed = false, quit = false;
  let snapshot = { service: { state: 'ready' }, state: 'idle', receiver: { running: false }, recording: null };
  const auth = { requireSession() {}, cloudBinding: () => binding, cloudSession: () => ({ ...binding, token: 'fixture' }),
    login: async () => ({}), logout() {}, session: () => ({ authenticated: true }), info: () => ({}) };
  const queue = { resume() {}, pause() {}, dispose() { queueDisposed = true; },
    status: () => ({ enabled, items: [...observed.values()], state: 'ready', connected: true }),
    setEnabled(value) { enabled = value; return this.status(); },
    observeRecording(recording, { owner, active }) {
      assert.equal(owner, JSON.stringify([binding.serverUrl, binding.user.id, binding.user.tenant]));
      observed.set(recording.id, { ...recording, active }); return true;
    } };
  function recording(number, status, runId = startedWith?.captureSessionId) {
    const id = number.toString(16).padStart(32, '0'), dir = path.join(records, id); fs.mkdirSync(dir, { recursive: true });
    const manifest = { id, name: `point-${number}`, status, samples: 2, captureSessionId: runId };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); return manifest;
  }
  const service = {
    async start() { return snapshot; }, async status() { return snapshot; }, async frame() { return snapshot; },
    async begin(_config, context) {
      startedWith = context;
      snapshot = { service: { state: 'ready' }, state: 'starting', receiver: { running: true }, recording: null };
      return snapshot;
    },
    async stop() {
      if (snapshot.recording) recording(parseInt(snapshot.recording.id, 16), 'complete');
      snapshot = { service: { state: 'ready' }, state: 'idle', receiver: { running: false },
        recording: snapshot.recording ? { ...snapshot.recording, status: 'complete' } : null };
      return snapshot;
    },
    async shutdown() { await this.stop(); snapshot.service.state = 'stopped'; },
  };
  const app = new EventEmitter(); Object.assign(app, { isPackaged: false, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => directory, quit: () => { quit = true; } });
  class BrowserWindow extends EventEmitter {
    constructor() { super(); win = this; this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' },
      setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }); }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
  }
  const electron = { app, BrowserWindow, shell: {}, ipcMain: { handle(_name, callback) { ipc = callback; }, on() {} },
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1366, height: 768 } }) },
    dialog: { showErrorBox() { assert.fail('Actual main initialization failed'); }, showMessageBox: async () => ({ response: 1 }) } };
  const requireOverride = name => {
    if (name === 'electron') return electron;
    if (name === './local-auth.cjs') return { createLocalAuth: () => ({}) };
    if (name === './unified-auth.cjs') return { createUnifiedAuth: () => auth };
    if (name === './bootstrap-admin.json') return {}; // Never inspect real local credentials.
    if (name === './field-service.cjs') return { createFieldService: () => service, failure: (message, status) => Object.assign(Error(message), { status }) };
    if (name === './field-cloud-sync.cjs') return { createFieldCloudSync: () => queue };
    if (name === './field-capture-tracker.cjs') return { createCaptureTracker: options => {
      tracker = createCaptureTracker({ ...options, intervalMs: 10 }); return tracker;
    } };
    return mainRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), { require: requireOverride, __dirname: path.dirname(mainFile),
    process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval }, { filename: mainFile });
  await waitFor(() => ipc && win?.webContents.mainFrame.url);
  async function invoke(options) {
    const result = await ipc({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, options);
    assert.equal(result.status, 200, result.data?.error); return result.data;
  }
  t.after(async () => { tracker.dispose(); await tracker.settled(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { invoke, recording, observed, directory, get startedWith() { return startedWith; },
    active(recording) { snapshot = { service: { state: 'ready' }, state: 'acquiring', receiver: { running: true }, recording }; },
    close() { win.emit('close', { preventDefault() {} }); }, get closed() { return quit && queueDisposed; } };
}

test('actual main enrolls a cycle before first writer exists; background follows points and stop flushes all records', async t => {
  const h = await harness(t);
  const started = await h.invoke({ action: 'start', config: { pointCycle: { points: [] } } });
  assert.equal(started.recording, null); assert.match(h.startedWith.captureSessionId, /^[a-f0-9]{32}$/);
  h.recording(1, 'complete'); const second = h.recording(2, 'incomplete'); h.active(second);
  await waitFor(() => h.observed.get(second.id)?.active && h.observed.size === 2);
  const third = h.recording(3, 'complete');
  await h.invoke({ action: 'stop' });
  assert.equal(h.observed.get(second.id).status, 'complete'); assert.equal(h.observed.get(third.id).status, 'complete');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory, 'blade-capture-runs.json'))).runs.length, 0);
});

test('actual main safe close stops and flushes final point before tracker and queue disposal', async t => {
  const h = await harness(t); await h.invoke({ action: 'start', config: {} });
  h.recording(1, 'complete'); const last = h.recording(2, 'incomplete'); h.active(last);
  h.close(); await waitFor(() => h.closed);
  assert.equal(h.observed.get(last.id).status, 'complete'); assert.equal(h.observed.size, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory, 'blade-capture-runs.json'))).runs.length, 0);
});

test('actual main honors disabled auto-sync and does not forward renderer-authored run IDs', async t => {
  const h = await harness(t); await h.invoke({ action: 'setAutoSync', enabled: false });
  await h.invoke({ action: 'start', config: { captureSessionId: 'f'.repeat(32) } });
  assert.equal(h.startedWith, undefined);
  h.active(h.recording(1, 'incomplete', 'f'.repeat(32))); await h.invoke({ action: 'stop' });
  assert.equal(h.observed.size, 0);
});
