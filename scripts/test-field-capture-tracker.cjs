'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createCaptureTracker } = require('../apps/desktop/electron/field-capture-tracker.cjs');
const { createFieldCloudSync } = require('../apps/desktop/electron/field-cloud-sync.cjs');
const id = number => number.toString(16).padStart(32, '0');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const ownerOf = binding => JSON.stringify([binding.serverUrl, binding.user.id, binding.user.tenant]);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-capture-tracker-'));
  const dataDir = path.join(directory, 'recordings'); fs.mkdirSync(dataDir);
  const file = path.join(directory, 'runs.json'), queueFile = path.join(directory, 'queue.json');
  let binding = { serverUrl: 'http://localhost:3000', user: { id: 'user-a', tenant: 'tenant-a' } }, online = true;
  let snapshot = { service: { state: 'ready' }, state: 'idle', receiver: { running: false }, recording: null };
  let failRequests = false, statusGate;
  const captures = new Map(), requests = [], trackers = [], queues = [];
  const auth = { cloudBinding: () => binding, cloudSession: () => online && binding ? { ...binding, token: 'test-session' } : null,
    clearCloudSession: () => { online = false; } };
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method });
    if (failRequests) return json({}, 503);
    const parsed = new URL(url), route = parsed.pathname.replace('/api/v1/captures', '');
    const body = options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : options.body;
    if (!route) {
      const recordingId = body.recording.id;
      if (!captures.has(recordingId)) captures.set(recordingId, { id: recordingId, metadata: body.recording, bytes: {}, live: [] });
      return json({ capture: { id: recordingId } });
    }
    const [recordingId, action, name] = route.slice(1).split('/'), capture = captures.get(recordingId);
    assert.ok(capture);
    if (action === 'live') { capture.live.push(body); return json({ ok: true, sequence: body.sequence }); }
    if (action === 'upload') { capture.metadata = body.recording; capture.files = body.files; return json({ received: [], offsets: {} }); }
    if (action === 'chunks') {
      const offset = Number(parsed.searchParams.get('offset')), before = capture.bytes[name] || Buffer.alloc(0);
      assert.equal(offset, before.length); capture.bytes[name] = Buffer.concat([before, body]);
      return json({ ok: true, nextOffset: capture.bytes[name].length });
    }
    if (action === 'complete') {
      for (const part of capture.files) assert.equal(createHash('sha256').update(capture.bytes[part.name]).digest('hex'), part.sha256);
      capture.complete = true; return json({ capture: { id: recordingId, uploadState: 'complete' } });
    }
    throw Error('Unexpected route');
  };
  function queue(factory = createFieldCloudSync) {
    const value = factory({ file: queueFile, dataDir, auth, fetchImpl, intervalMs: 60000, getLive: async () => ({ ...snapshot,
      waveform: { values: [0.01, 0.02], rssi: [30, 31], overrange: [false, false], sampleRate: 1000, sampleStart: 0 } }) });
    queues.push(value); value.resume(); return value;
  }
  function tracker(sync) {
    const value = createCaptureTracker({ file, dataDir, auth, sync, getSnapshot: async () => statusGate ? statusGate() : snapshot, intervalMs: 60000 });
    trackers.push(value); return value;
  }
  function recording(number, runId, status = 'complete', cycle = false) {
    const recordingId = id(number), dir = path.join(dataDir, recordingId); fs.mkdirSync(dir, { recursive: true });
    const raw = Buffer.alloc(32 + 29 * 2); raw.write('BLADEV01'); raw.writeDoubleLE(1000, 8); raw.writeDoubleLE(1800000000, 16);
    raw.writeBigUInt64LE(0n, 24); raw.writeBigUInt64LE(0n, 32); raw.writeBigUInt64LE(1n, 61);
    fs.writeFileSync(path.join(dir, 'chunk-00000000.bin'), raw);
    const value = { id: recordingId, name: `point-${number}`, status, samples: 2, chunks: 1, sampleRate: 1000,
      sampleOrigin: 1800000000, startedAt: 1800000000, endedAt: status === 'incomplete' ? null : 1800000001,
      source: 'simulation', unit: 'm/s', unpairedRssiSamples: 0, ...(runId ? { captureSessionId: runId } : {}),
      ...(cycle ? { pointCycle: { cycle: 1, pointIndex: number, pointName: `P${number}` },
        turntable: { state: 'holding', point: `P${number}`, config: { port: 'COM6' } } } : {}) };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value)); return value;
  }
  const active = recording => { snapshot = { service: { state: 'ready' }, state: 'acquiring', receiver: { running: true }, recording }; };
  const idle = () => { snapshot = { service: { state: 'ready' }, state: 'idle', receiver: { running: false }, recording: snapshot.recording }; };
  async function settle(sync) { for (let index = 0; index < 5; index++) { await sync.settled(); sync.resume(); } await sync.settled(); }
  t.after(async () => {
    for (const value of trackers) value.dispose(); await Promise.all(trackers.map(value => value.settled()));
    for (const value of queues) value.dispose(); await Promise.all(queues.map(value => value.settled()));
    fs.rmSync(directory, { force: true, recursive: true });
  });
  return { directory, dataDir, file, queueFile, queue, tracker, recording, active, idle, settle, captures, requests, auth,
    setOnline(value) { online = value; }, setBinding(value) { binding = value; }, setFailure(value) { failRequests = value; },
    setStatusGate(value) { statusGate = value; }, get snapshot() { return snapshot; } };
}

test('rapid multi-point cycle: every point between polls reaches durable upload; unrelated history stays local', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync);
  f.recording(9999); const run = tracker.prepare(); tracker.activate(run);
  // This exceeds the legacy /recordings endpoint's 1000-row limit.
  for (let point = 1; point <= 1005; point++) f.recording(point, run, 'complete', true);
  await tracker.scan(); await f.settle(sync);
  assert.equal(f.captures.size, 1005);
  assert.ok([...f.captures.values()].every(capture => capture.complete && capture.metadata.pointCycle));
  assert.equal(f.captures.has(id(9999)), false);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).runs.length, 0);
  const before = f.requests.length;
  tracker.dispose(); const second = f.tracker(sync); await second.scan(); await f.settle(sync);
  assert.equal(f.requests.length, before, 'retired run must not re-enroll compacted cloud history');
});

test('current live point follows writer changes and stop flush uploads skipped and final points', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync), run = tracker.prepare(); tracker.activate(run);
  const first = f.recording(1, run, 'incomplete', true); f.active(first);
  await tracker.scan(); await f.settle(sync); assert.equal(f.captures.get(first.id).live.length > 0, true);
  f.recording(1, run, 'complete', true); f.recording(2, run, 'complete', true);
  const third = f.recording(3, run, 'incomplete', true); f.active(third);
  await tracker.scan(); await f.settle(sync);
  assert.equal(f.captures.get(id(1)).complete, true); assert.equal(f.captures.get(id(2)).complete, true);
  assert.equal(f.captures.get(id(3)).live.length > 0, true); assert.equal(f.captures.get(id(3)).complete, undefined);
  f.recording(3, run, 'complete', true); f.idle(); await tracker.flush(f.snapshot); await f.settle(sync);
  assert.equal(f.captures.get(id(3)).complete, true); assert.equal(tracker.status().pendingRuns, 0);
});

test('ordinary acquisition retains live and automatic save upload behavior', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync), run = tracker.prepare(); tracker.activate(run);
  const current = f.recording(1, run, 'incomplete'); f.active(current);
  await tracker.scan(); await f.settle(sync); assert.equal(f.captures.get(current.id).live.length > 0, true);
  f.recording(1, run); f.idle(); await tracker.flush(f.snapshot); await f.settle(sync);
  assert.equal(f.captures.get(current.id).complete, true);
});

test('auto-sync off or no bound account enrolls no run and cannot sweep existing recordings', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync);
  sync.setEnabled(false); assert.equal(tracker.prepare(), null); f.recording(1); await tracker.scan();
  sync.setEnabled(true); f.setBinding(null); assert.equal(tracker.prepare(), null); await tracker.scan();
  assert.equal(f.requests.length, 0); assert.equal(fs.existsSync(f.file), false);
});

test('previously authorized run keeps its original owner across offline work and account switching', async t => {
  const f = fixture(t), firstOwner = f.auth.cloudBinding(), sync = f.queue(), tracker = f.tracker(sync);
  f.setOnline(false); const run = tracker.prepare(); tracker.activate(run); f.recording(1, run, 'complete', true);
  f.setBinding({ serverUrl: 'http://localhost:3000', user: { id: 'user-b', tenant: 'tenant-b' } });
  await tracker.scan(); assert.equal(sync.status().items.length, 0); assert.equal(tracker.status().pendingRuns, 1);
  f.setBinding(firstOwner); sync.setEnabled(false); // Changes future enrollment, not this already authorized run.
  await tracker.scan(); assert.equal(sync.status().items.length, 1); assert.equal(sync.status().items[0].state, 'queued');
  assert.equal(f.requests.length, 0); f.setOnline(true); await f.settle(sync);
  assert.equal(f.captures.get(id(1)).complete, true);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('test-session'), false);
});

test('restart recovers unobserved point manifests from authorized run but never restarts motion', async t => {
  const f = fixture(t), sync = f.queue(), first = f.tracker(sync), run = first.prepare(); first.activate(run);
  f.recording(1, run, 'complete', true); f.recording(2, run, 'complete', true);
  first.dispose(); const restarted = f.tracker(sync); await restarted.scan(); await f.settle(sync);
  assert.equal(f.captures.size, 2); assert.equal(restarted.status().pendingRuns, 0);
});

test('abort or crash preserves failed/incomplete point locally and uploads earlier complete points only', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync), run = tracker.prepare(); tracker.activate(run);
  f.recording(1, run, 'complete', true); f.recording(2, run, 'error', true); f.recording(3, run, 'incomplete', true);
  await tracker.flush(f.snapshot); await f.settle(sync);
  assert.equal(f.captures.size, 1); assert.equal(f.captures.get(id(1)).complete, true);
  assert.deepEqual(sync.status().items.filter(item => item.state === 'error').map(item => item.recordingId), [id(2), id(3)]);
  assert.ok(fs.existsSync(path.join(f.dataDir, id(3), 'manifest.json')));
});

test('repeated polling preserves upload backoff and wrong-owner observation is ignored', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync), run = tracker.prepare(); tracker.activate(run);
  f.setFailure(true); const complete = f.recording(1, run); f.active(f.recording(2, run, 'incomplete'));
  await tracker.scan(); await sync.settled();
  const before = JSON.parse(fs.readFileSync(f.queueFile)).items.find(item => item.recordingId === complete.id);
  const owner = ownerOf(f.auth.cloudBinding());
  for (let index = 0; index < 5; index++) { sync.observeRecording(complete, { owner, active: false }); await tracker.scan(); }
  await sync.settled();
  const after = JSON.parse(fs.readFileSync(f.queueFile)).items.find(item => item.recordingId === complete.id);
  assert.equal(after.retryAt, before.retryAt); assert.equal(after.attempts, before.attempts);
  assert.equal(sync.observeRecording(f.recording(3, run), { owner: 'other-owner', active: false }), false);
  assert.equal(sync.status().items.some(item => item.recordingId === id(3)), false);
});

test('scan racing a new start cannot retire its run based on an older idle snapshot', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync), initialRun = tracker.prepare(); tracker.activate(initialRun);
  let release; f.setStatusGate(() => new Promise(resolve => { release = resolve; }));
  const scanning = tracker.scan(); await new Promise(resolve => setImmediate(resolve));
  const run = tracker.prepare(); tracker.activate(run); const current = f.recording(1, run, 'incomplete'); f.active(current);
  release({ service: { state: 'ready' }, state: 'idle', receiver: { running: false } }); await scanning;
  assert.equal(JSON.parse(fs.readFileSync(f.file)).runs.some(item => item.id === run), true);
  f.setStatusGate(null); await tracker.scan(); await f.settle(sync);
  assert.equal(f.captures.get(id(1)).live.length > 0, true);
});

test('a partial manifest is retried and never causes the authorization to be discarded', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync), run = tracker.prepare(); tracker.activate(run);
  const recording = f.recording(1, run), file = path.join(f.dataDir, recording.id, 'manifest.json');
  fs.writeFileSync(file, '{'); await tracker.scan(); assert.ok(tracker.status().error); assert.equal(tracker.status().pendingRuns, 1);
  fs.writeFileSync(file, JSON.stringify(recording)); await tracker.scan(); await f.settle(sync);
  assert.equal(f.captures.get(recording.id).complete, true); assert.equal(tracker.status().pendingRuns, 0);
});

test('invalid private run journal remains untouched and blocks only automatic enrollment', t => {
  const f = fixture(t), sync = f.queue(); fs.writeFileSync(f.file, '{broken', { mode: 0o600 });
  const tracker = f.tracker(sync); assert.throws(() => tracker.prepare(), /登记不可用/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken'); assert.equal(f.requests.length, 0);
});

test('queue capacity backpressure retains the run and retries only undiscovered points after capacity frees', async t => {
  const f = fixture(t), sync = f.queue(); f.setOnline(false);
  let blocked = true;
  const bounded = { ...sync, observeRecording(recording, options) {
    if (blocked && recording.id === id(2)) throw Error('本机待同步队列已满');
    return sync.observeRecording(recording, options);
  } };
  const tracker = f.tracker(bounded), run = tracker.prepare(); tracker.activate(run);
  f.recording(1, run); f.recording(2, run);
  await tracker.scan(); assert.equal(tracker.status().pendingRuns, 1); assert.match(tracker.status().error, /队列已满/);
  assert.equal(sync.status().items.length, 1);
  f.setOnline(true); await f.settle(sync); blocked = false;
  await tracker.scan(); await f.settle(sync);
  assert.equal(f.captures.size, 2); assert.ok([...f.captures.values()].every(capture => capture.complete));
  assert.equal(tracker.status().pendingRuns, 0);
});

test('queue file write failure never acknowledges enrollment; saved run recovers after restart', async t => {
  const f = fixture(t), sync = f.queue(), tracker = f.tracker(sync), run = tracker.prepare(); tracker.activate(run);
  f.recording(1, run); fs.mkdirSync(f.queueFile); // Fault: rename cannot replace a directory with the queue file.
  await tracker.scan();
  assert.equal(sync.status().items.length, 0, 'failed enrollment must be rolled back in memory');
  assert.equal(tracker.status().pendingRuns, 1); assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.file)).runs[0].records).length, 0);
  await tracker.scan(); assert.equal(tracker.status().pendingRuns, 1);
  tracker.dispose(); sync.dispose(); fs.rmdirSync(f.queueFile);
  const recoveredQueue = f.queue(), recoveredTracker = f.tracker(recoveredQueue);
  await recoveredTracker.scan(); await f.settle(recoveredQueue);
  assert.equal(f.captures.get(id(1)).complete, true); assert.equal(recoveredTracker.status().pendingRuns, 0);
});

test('failed terminal queue save restores recording state and retains run for restart recovery', async t => {
  const f = fixture(t); f.setOnline(false);
  const sync = f.queue(), tracker = f.tracker(sync), run = tracker.prepare(); tracker.activate(run);
  f.active(f.recording(1, run, 'incomplete')); await tracker.scan();
  const backup = f.queueFile + '.backup'; fs.renameSync(f.queueFile, backup); fs.mkdirSync(f.queueFile);
  f.recording(1, run); f.idle(); await tracker.scan();
  assert.equal(sync.status().items[0].state, 'recording'); assert.equal(tracker.status().pendingRuns, 1);
  tracker.dispose(); sync.dispose(); fs.rmdirSync(f.queueFile); fs.renameSync(backup, f.queueFile);
  const recoveredQueue = f.queue(), recoveredTracker = f.tracker(recoveredQueue);
  await recoveredTracker.scan(); f.setOnline(true); await f.settle(recoveredQueue);
  assert.equal(f.captures.get(id(1)).complete, true); assert.equal(recoveredTracker.status().pendingRuns, 0);
});

test('pre-write capacity failure rolls back both new enrollment and terminal transitions', async t => {
  const f = fixture(t); f.setOnline(false);
  const original = f.queue(), tracker = f.tracker(original), run = tracker.prepare(); tracker.activate(run);
  const active = f.recording(1, run, 'incomplete'); f.active(active); await tracker.scan();
  const limit = fs.statSync(f.queueFile).size + 1;
  tracker.dispose(); original.dispose();
  // Fault injection reduces only the journal byte cap. No production hooks or
  // filesystem monkeypatches are needed, and all real persist logic executes.
  const sourceFile = path.resolve(__dirname, '../apps/desktop/electron/field-cloud-sync.cjs');
  const source = fs.readFileSync(sourceFile, 'utf8').replace('MAX_QUEUE_BYTES = 9 * 1024 * 1024', `MAX_QUEUE_BYTES = ${limit}`);
  assert.notEqual(source, fs.readFileSync(sourceFile, 'utf8'));
  const loaded = { exports: {} };
  vm.runInNewContext(source, { module: loaded, require: createRequire(sourceFile), Buffer, process, global,
    setInterval, clearInterval, setTimeout, clearTimeout, AbortController }, { filename: sourceFile });
  const constrained = f.queue(loaded.exports.createFieldCloudSync), limitedTracker = f.tracker(constrained);
  f.recording(1, run, 'error'); f.idle(); await limitedTracker.scan();
  assert.equal(constrained.status().items[0].state, 'recording'); assert.equal(limitedTracker.status().pendingRuns, 1);
  await limitedTracker.scan(); assert.equal(limitedTracker.status().pendingRuns, 1, 'a later poll cannot mistake an unsaved transition for durable');
  limitedTracker.dispose(); constrained.dispose(); fs.unlinkSync(f.queueFile);
  const emptyConstrained = f.queue(loaded.exports.createFieldCloudSync), newTracker = f.tracker(emptyConstrained);
  await newTracker.scan(); assert.equal(emptyConstrained.status().items.length, 0); assert.equal(newTracker.status().pendingRuns, 1);
});
