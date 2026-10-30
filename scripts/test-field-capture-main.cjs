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
async function harness(t, hooks = {}) {
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
    async start() { return snapshot; }, async status() { return snapshot; }, async frame(windowMs) { hooks.frame?.(windowMs); return snapshot; },
    async begin(_config, context) {
      startedWith = context;
      snapshot = { service: { state: 'ready' }, state: 'starting', receiver: { running: true }, recording: null };
      return snapshot;
    },
    async singlePoint(request, context) {
      hooks.singlePoint?.(request);
      if (request.action === 'prepare') { await hooks.beforePrepare?.(); return this.begin(request, context); }
      if (request.action === 'cancel') return this.stop();
      return snapshot;
    },
    async device(request) {
      await hooks.device?.(request);
      return { deviceIp: request.deviceIp, state: 'unknown', readAt: null, source: 'unavailable', busy: true };
    },
    async recordAnalysis(request) { return hooks.recordAnalysis?.(request) || { state: 'queued' }; },
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
    if (name === './field-cloud-sync.cjs') return { createFieldCloudSync: options => { hooks.cloudSync?.(options); return queue; } };
    if (name === './field-capture-tracker.cjs') return { createCaptureTracker: options => {
      tracker = createCaptureTracker({ ...options, intervalMs: 10 }); return tracker;
    } };
    return mainRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), { require: requireOverride, __dirname: path.dirname(mainFile),
    process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval }, { filename: mainFile });
  await waitFor(() => ipc && win?.webContents.mainFrame.url);
  async function raw(options) { return ipc({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, options); }
  async function invoke(options) {
    const result = await raw(options);
    assert.equal(result.status, 200, result.data?.error); return result.data;
  }
  t.after(async () => { tracker.dispose(); await tracker.settled(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { invoke, raw, recording, observed, directory, get startedWith() { return startedWith; },
    active(recording) { snapshot = { service: { state: 'ready' }, state: 'acquiring', receiver: { running: true }, recording }; },
    close() { win.emit('close', { preventDefault() {} }); }, get closed() { return quit && queueDisposed; } };
}

test('actual main sends a one-second cloud preview even without the acquisition page open', async t => {
  let cloud, selectedWindow;
  await harness(t, { cloudSync: options => { cloud = options; }, frame: window => { selectedWindow = window; } });
  await cloud.getLive();
  assert.equal(selectedWindow, 1000, 'cloud preview must not use the 2048-sample no-argument frame');
});

test('new analysis jobs cannot queue behind or postpone capture stop in the actual main', async t => {
  let finish, received;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = await harness(t, { recordAnalysis: async request => { received = request; return pending; } });
  const request = { action: 'start', recordingIds: ['a'.repeat(32)], scope: 'diagnostic', profile: 'LOS_DIAGNOSTIC' };
  const analysis = h.invoke({ action: 'recordAnalysis', request });
  await waitFor(() => received);
  const stopped = h.invoke({ action: 'stop' });
  await stopped;
  assert.equal(received, request);
  finish({ state: 'queued', jobId: 'job-1' });
  assert.deepEqual(await analysis, { state: 'queued', jobId: 'job-1' });
});

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

test('actual main enrolls a single point once across retries and cancellation flushes its record', async t => {
  const h = await harness(t);
  const request = { action: 'prepare', sessionId: 'session-single-0001', commandId: 'prepare-single-0001',
    config: { materialMark: 'A/P1', distanceM: 2, hubHeightDeltaM: 0.2, radiusM: 0.4 },
    capture: { name: 'single-point', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', port: 'COM6', captureSessionId: 'f'.repeat(32) },
    confirmLaser: true, confirmStaticPoint: true, confirmGeometry: true };
  await h.invoke({ action: 'singlePoint', request });
  const id = h.startedWith.captureSessionId;
  assert.match(id, /^[a-f0-9]{32}$/); assert.notEqual(id, 'f'.repeat(32));
  await h.invoke({ action: 'singlePoint', request });
  assert.equal(h.startedWith.captureSessionId, id);
  const record = h.recording(1, 'incomplete'); h.active(record);
  await h.invoke({ action: 'singlePoint', request: { action: 'cancel', sessionId: request.sessionId, commandId: 'cancel-single-0001' } });
  assert.equal(h.observed.get(record.id).status, 'complete');
});

test('single-point preparation blocks account mutations while cancellation bypasses its pending response', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; }); const actions = [];
  const h = await harness(t, { beforePrepare: () => pending, singlePoint: request => actions.push(request.action) });
  const request = { action: 'prepare', sessionId: 'session-pending-0001', commandId: 'prepare-pending-0001',
    config: { materialMark: 'A/P1', distanceM: 2, hubHeightDeltaM: 0.2, radiusM: 0.4 },
    capture: { name: 'single-point', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', port: 'COM6' },
    confirmLaser: true, confirmStaticPoint: true, confirmGeometry: true };
  const preparing = h.invoke({ action: 'singlePoint', request });
  await waitFor(() => actions.includes('prepare'));
  let accountResolved = false;
  const logout = h.raw({ action: 'logout' }).then(value => { accountResolved = true; return value; });
  await pause(20); assert.equal(accountResolved, false, 'Account mutation must wait for preparation');
  await h.invoke({ action: 'singlePoint', request: { action: 'cancel', sessionId: request.sessionId, commandId: 'cancel-pending-0001' } });
  assert.deepEqual(actions, ['prepare', 'cancel']);
  release(); await preparing;
  assert.equal((await logout).status, 409, 'The active service prevents logout after prepare resolves');
});

test('read-only laser monitoring bypasses a pending device write while other writes stay serialized', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const actions = [];
  const h = await harness(t, { device: async request => {
    actions.push(request.action);
    if (request.action === 'autofocus') await pending;
  } });
  const focusing = h.invoke({ action: 'device', request: { action: 'autofocus', deviceIp: '192.168.106.90', confirmLaser: true } });
  await waitFor(() => actions.includes('autofocus'));
  const closing = h.invoke({ action: 'device', request: { action: 'laser_off', deviceIp: '192.168.106.90', confirmLaser: true } });
  const read = await h.invoke({ action: 'device', request: { action: 'laser_read', deviceIp: '192.168.106.90' } });
  assert.equal(read.source, 'unavailable');
  assert.equal(read.busy, true);
  assert.deepEqual(actions, ['autofocus', 'laser_read']);
  release();
  await Promise.all([focusing, closing]);
  assert.deepEqual(actions, ['autofocus', 'laser_read', 'laser_off']);
});
