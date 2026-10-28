'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFieldCloudSync } = require('../apps/desktop/electron/field-cloud-sync.cjs');
const { normalizeRecordingName } = require('../apps/desktop/electron/field-recording-name.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('diagnostic names keep user text and legacy uploads do not rewrite local records', async t => {
  const f = fixture(t), current = f.recording();
  const name = '用户任务 [未停稳判定测试]';
  const evidence = { diagnosticOnly: true, validMeasurement: false, pointCycle: { diagnosticDetection: { enabled: true } } };
  assert.equal(normalizeRecordingName({ name }).name, name);
  assert.equal(normalizeRecordingName({ ...evidence, name, originalTaskName: name }).name, name);
  Object.assign(current.manifest, evidence, { name: name + ' [未停稳判定测试]' });
  const file = path.join(current.dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(current.manifest));
  const before = fs.readFileSync(file);
  const queue = f.create(); queue.resume(); queue.uploadRecording(current.manifest.id); await queue.settled();
  const capture = f.captures.get(current.manifest.id);
  assert.equal(capture.recording.name, name);
  assert.equal(capture.recording.diagnosticOnly, true);
  assert.equal(capture.complete, true);
  assert.equal(queue.status().items[0].name, name);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('upload sampling persists, freezes across retry, and never modifies source bytes', async t => {
  const f = fixture(t), original = f.recording();
  original.manifest.sampleRate = 250000; original.raw.writeDoubleLE(250000, 8);
  fs.writeFileSync(path.join(original.dir, 'manifest.json'), JSON.stringify(original.manifest));
  fs.writeFileSync(path.join(original.dir, 'chunk-00000000.bin'), original.raw);
  const rates = [];
  const prepareUpload = async (id, rate) => {
    rates.push(rate);
    const directory = path.join(path.dirname(f.dataDir), 'upload-cache', `${id}-${rate}`);
    fs.mkdirSync(directory, { recursive: true });
    const raw = Buffer.from(original.raw.subarray(0, 32 + 20 * 29)); raw.writeDoubleLE(rate, 8);
    const recording = { ...original.manifest, sampleRate: rate, samples: 20, sampling: { sourceSampleRate: 250000 } };
    fs.writeFileSync(path.join(directory, 'chunk-00000000.bin'), raw);
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(recording));
    return { directory, recording };
  };
  let queue = f.create({ prepareUpload });
  assert.equal(queue.status().uploadSampleRate, 50000);
  for (const rate of [-1, 9999, 100001, NaN, '50000', true]) assert.throws(() => queue.setUploadSampleRate(rate));
  f.setHandler((url, options, respond) => url.includes('/upload') ? json({}, 503) : respond(url, options));
  queue.resume(); queue.uploadRecording(original.manifest.id); await queue.settled();
  queue.setUploadSampleRate(10000); queue.dispose(); await queue.settled();
  f.setHandler(null);
  queue = f.create({ prepareUpload }); assert.equal(queue.status().uploadSampleRate, 10000);
  queue.resume(); await queue.settled();
  assert.deepEqual(rates, [50000, 50000]);
  assert.equal(f.captures.get(original.manifest.id).recording.sampleRate, 50000);
  assert.equal(queue.status().items[0].state, 'synced');
  assert.deepEqual(fs.readFileSync(path.join(original.dir, 'chunk-00000000.bin')), original.raw);
});

test('high-rate min/max live envelopes reach Web without requiring a raw display array', async t => {
  const f = fixture(t), source = f.recording('a'.repeat(32), 100, 'incomplete');
  const queue = f.create(); queue.resume(); queue.started(source.manifest); await queue.settled();
  const waveform = { sampleRate: 250000, sampleStart: 0, sampleStride: 1, sampleOrigin: 1800000000,
    values: [], rssi: [], overrange: [], representation: 'envelope', rangeStart: 0, rangeEnd: 250000,
    envelope: [{ start: 0, end: 250000, min: -2, max: 3, rssiMin: 0, rssiMax: 80, missing: 0, overrange: 2 }] };
  f.setFrame({ recording: source.manifest, state: 'acquiring', waveform });
  queue.resume(); await queue.settled();
  const delivered = f.captures.get(source.manifest.id).live.at(-1).waveform;
  assert.deepEqual(delivered.envelope, waveform.envelope);
  assert.equal(delivered.sampleRate, 250000);
  assert.equal(delivered.rangeEnd, 250000);
});

test('completed points send metadata-only terminal frames after active writer changes', async t => {
  const f = fixture(t), current = f.recording('a'.repeat(32), 100, 'incomplete');
  const queue = f.create(), owner = JSON.stringify([f.identity.serverUrl, f.identity.user.id, f.identity.user.tenant]);
  f.setFrame({ state: 'acquiring', recording: current.manifest,
    waveform: { sampleRate: 1000, sampleStart: 0, sampleOrigin: 1800000000, values: [1, 2], rssi: [80, 80], overrange: [false, false] } });
  queue.resume(); queue.observeRecording(current.manifest, { owner, active: true }); await queue.settled();
  const complete = f.recording(current.manifest.id, 100).manifest;
  complete.pointCycle = { completion: 'confirmed_pass', handoff: { sampleClock: 'continuous_session_raw', entrySampleIndex: 5001, exitSampleIndex: 5050 } };
  fs.writeFileSync(path.join(current.dir, 'manifest.json'), JSON.stringify(complete));
  // The service has already switched writers; no final getLive() is available.
  f.setFrame({ state: 'acquiring', recording: { id: 'b'.repeat(32) }, waveform: { values: [99] } });
  queue.observeRecording(complete, { owner, active: false }); await queue.settled();
  const capture = f.captures.get(current.manifest.id), last = capture.live.at(-1);
  assert.equal(capture.complete, true);
  assert.equal(last.state, 'stopped'); assert.equal(last.recording.status, 'complete');
  assert.deepEqual(last.recording.pointCycle, complete.pointCycle);
  assert.equal(last.waveform, undefined, 'never relabel a stale short window as the completed pass');
  assert.equal(last.realtime, undefined);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).items[0].terminalPending, false);
  queue.observeRecording(current.manifest, { owner, active: true }); queue.resume(); await queue.settled();
  assert.equal(capture.live.at(-1).state, 'stopped', 'late incomplete snapshots cannot reactivate a completed record');
});

test('terminal retry survives restart independently of upload success and remains with its original owner', async t => {
  const f = fixture(t), current = f.recording('a'.repeat(32), 100, 'incomplete');
  let binding = f.identity;
  const auth = { ...f.auth, cloudBinding: () => binding, cloudSession: () => ({ ...binding, token: f.token }) };
  let queue = f.create({ auth }); queue.resume(); queue.started(current.manifest); await queue.settled();
  f.setHandler((url, options, respond) => url.endsWith('/live') && JSON.parse(options.body).state === 'stopped' ? json({}, 503) : respond(url, options));
  const complete = f.recording(current.manifest.id, 100); queue.finished(complete.manifest); await queue.settled();
  assert.equal(queue.status().items[0].state, 'synced');
  assert.equal(JSON.parse(fs.readFileSync(f.file)).items[0].terminalPending, true);
  queue.dispose(); await queue.settled();
  binding = { ...f.identity, user: { ...f.identity.user, id: 'different-owner' } };
  f.setHandler(null); queue = f.create({ auth }); queue.resume(); await queue.settled();
  assert.equal(f.captures.get(current.manifest.id).live.length, 0, 'new account cannot send old terminal metadata');
  binding = f.identity; queue.resume(); await queue.settled();
  assert.equal(f.captures.get(current.manifest.id).live.at(-1).state, 'stopped');
  assert.equal(queue.status().items[0].state, 'synced');
  assert.equal(JSON.parse(fs.readFileSync(f.file)).items[0].terminalPending, false);
});

test('terminal metadata keeps the original clock while archive upload uses a sampled derivative', async t => {
  const f = fixture(t), current = f.recording('a'.repeat(32), 100, 'incomplete');
  current.manifest.sampleRate = 250000; current.raw.writeDoubleLE(250000, 8);
  fs.writeFileSync(path.join(current.dir, 'chunk-00000000.bin'), current.raw);
  fs.writeFileSync(path.join(current.dir, 'manifest.json'), JSON.stringify(current.manifest));
  const queue = f.create({ prepareUpload: async (id, rate) => {
    const directory = path.join(path.dirname(f.dataDir), 'upload-cache', `${id}-${rate}`); fs.mkdirSync(directory, { recursive: true });
    const raw = Buffer.from(current.raw.subarray(0, 32 + 20 * 29)); raw.writeDoubleLE(rate, 8);
    const recording = { ...current.manifest, status: 'complete', samples: 20, sampleRate: rate, endedAt: 1800000001, sampling: { sourceSampleRate: 250000 } };
    fs.writeFileSync(path.join(directory, 'chunk-00000000.bin'), raw); fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(recording));
    return { directory, recording };
  } });
  queue.resume(); queue.started(current.manifest); await queue.settled();
  const complete = { ...current.manifest, status: 'complete', endedAt: 1800000001 };
  fs.writeFileSync(path.join(current.dir, 'manifest.json'), JSON.stringify(complete));
  queue.finished(complete); await queue.settled();
  const capture = f.captures.get(current.manifest.id);
  assert.equal(capture.recording.sampleRate, 50000); assert.equal(capture.recording.samples, 20);
  const terminal = capture.live.at(-1);
  assert.equal(terminal.state, 'stopped'); assert.equal(terminal.recording.sampleRate, 250000);
  assert.equal(terminal.recording.samples, 100); assert.equal(terminal.recording.sampling, undefined);
  assert.equal(terminal.waveform, undefined); assert.deepEqual(fs.readFileSync(path.join(current.dir, 'chunk-00000000.bin')), current.raw);
});

test('failed derivative preparation can switch to original-rate upload without discarding the record', async t => {
  const f = fixture(t), original = f.recording();
  original.manifest.sampleRate = 250000; original.raw.writeDoubleLE(250000, 8);
  fs.writeFileSync(path.join(original.dir, 'manifest.json'), JSON.stringify(original.manifest));
  fs.writeFileSync(path.join(original.dir, 'chunk-00000000.bin'), original.raw);
  let preparations = 0;
  const queue = f.create({ prepareUpload: async () => { preparations++; throw Error('Unpaired RSSI requires original rate'); } });
  queue.resume(); queue.uploadRecording(original.manifest.id); await queue.settled();
  assert.equal(queue.status().items[0].state, 'error');
  queue.setUploadSampleRate(0); queue.retry(); await queue.settled();
  assert.equal(preparations, 1);
  assert.equal(queue.status().items[0].state, 'synced');
  assert.equal(f.captures.get(original.manifest.id).recording.sampleRate, 250000);
  assert.deepEqual(fs.readFileSync(path.join(original.dir, 'chunk-00000000.bin')), original.raw);
});

test('unbinding and rebinding preserve the old owner queue and never automatically upload it for the new account', async t => {
  const f = fixture(t), old = f.recording('a'.repeat(32)), fresh = f.recording('b'.repeat(32));
  const originalIdentity = JSON.parse(JSON.stringify(f.identity));
  let bound = f.identity; f.auth.cloudBinding = () => bound;
  const oldOwner = JSON.stringify([bound.serverUrl, bound.user.id, bound.user.tenant]);
  f.setHandler(() => json({}, 503));
  const queue = f.create(); queue.resume(); queue.uploadRecording(old.manifest.id); await queue.settled();
  const calls = f.requests.length;
  queue.pause({ forgetActive: true }); bound = null; f.setSession(null); queue.resume(); await queue.settled();
  assert.equal(queue.status().state, 'unbound'); assert.equal(queue.status().items.length, 0);
  assert.equal(f.requests.length, calls);
  queue.pause({ forgetActive: true });
  f.identity.serverUrl = 'https://new.example.test'; f.identity.user = { id: 'owner-two', tenant: 'tenant-two', username: 'second' };
  bound = f.identity; f.setSession('new-owner-token-fixture'); f.setHandler(null);
  queue.resume(); await queue.settled();
  queue.started(old.manifest); queue.finished(old.manifest); queue.retry(); await queue.settled();
  assert.equal(queue.observeRecording(old.manifest, { owner: oldOwner }), false);
  assert.equal(queue.status().items.length, 0); assert.equal(f.requests.length, calls);
  queue.setUploadSampleRate(10000);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).items.find(row => row.owner === oldOwner).uploadSampleRate, 50000);
  queue.started(fresh.manifest); queue.finished(fresh.manifest); await queue.settled();
  assert.deepEqual(queue.status().items.map(row => row.recordingId), [fresh.manifest.id]);
  assert.equal(f.captures.has(old.manifest.id), false); assert.equal(f.captures.get(fresh.manifest.id).complete, true);
  queue.pause({ forgetActive: true }); Object.assign(f.identity, originalIdentity); f.setSession('old-owner-relogin-token-fixture'); queue.resume(); await queue.settled();
  assert.equal(queue.status().items[0].recordingId, old.manifest.id);
  assert.equal(f.captures.get(old.manifest.id).complete, true);
  assert.deepEqual(fs.readFileSync(path.join(old.dir, 'chunk-00000000.bin')), old.raw);
});

test('old in-flight replies cannot mutate the newly bound account or publish an old live frame', async t => {
  const f = fixture(t), old = f.recording('a'.repeat(32));
  let release, waiting = false;
  const gate = new Promise(resolve => { release = resolve; });
  f.setHandler(async () => { waiting = true; return gate; });
  const queue = f.create(); queue.resume(); queue.uploadRecording(old.manifest.id);
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  queue.pause({ forgetActive: true });
  f.identity.user = { id: 'other-owner', tenant: 'other-tenant', username: 'other' }; f.setSession('different-token-fixture');
  queue.resume(); release(json({}, 401)); await queue.settled();
  assert.equal(queue.status().connected, true); assert.equal(queue.status().items.length, 0);
  assert.ok(!queue.status().error);
  assert.equal(f.token, 'different-token-fixture');
});

test('a failed old-account sampling job cannot show errors or upload status for the replacement account', async t => {
  const f = fixture(t), old = f.recording(); old.manifest.sampleRate = 250000;
  fs.writeFileSync(path.join(old.dir, 'manifest.json'), JSON.stringify(old.manifest));
  let rejectJob, waiting = false;
  const job = new Promise((_, reject) => { rejectJob = reject; });
  const queue = f.create({ prepareUpload: async () => { waiting = true; return job; } });
  queue.resume(); queue.uploadRecording(old.manifest.id);
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  queue.pause({ forgetActive: true });
  f.identity.user = { id: 'replacement', tenant: 'replacement-group', username: 'replacement' }; f.setSession('replacement-token-fixture'); queue.resume();
  assert.equal(queue.status().state, 'ready');
  rejectJob(Error('old account derivative fixture failed')); await queue.settled();
  assert.ok(!queue.status().error); assert.equal(queue.status().items.length, 0);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-cloud-sync-'));
  const dataDir = path.join(directory, 'data'); fs.mkdirSync(dataDir);
  const file = path.join(directory, 'queue.json');
  const identity = { serverUrl: 'http://115.190.201.41:3000', user: { id: 'owner-one', tenant: 'tenant-one', username: 'test' } };
  let session = { ...identity, token: 'private-session-token-never-persist' }, frame = null;
  const captures = new Map(), requests = [], instances = [];
  let handler;
  const auth = { cloudBinding: () => identity, cloudSession: () => session, clearCloudSession: () => { session = null; } };
  async function respond(url, options) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${session?.token}`);
    assert.ok(url.startsWith(identity.serverUrl + '/api/v1/captures'));
    const parsed = new URL(url), route = parsed.pathname.replace('/api/v1/captures', '');
    if (!route) {
      const body = JSON.parse(options.body), id = body.recording.id;
      if (!captures.has(id)) captures.set(id, { id, recording: body.recording, files: [], bytes: {}, complete: false, live: [] });
      return json({ capture: { id } });
    }
    const [id, action, name] = route.slice(1).split('/'), capture = captures.get(id);
    if (!capture) return json({}, 404);
    if (action === 'live') { capture.live.push(JSON.parse(options.body)); return json({ ok: true, sequence: capture.live.at(-1).sequence }); }
    if (action === 'upload') {
      const body = JSON.parse(options.body); capture.files = body.files; capture.recording = body.recording;
      const offsets = Object.fromEntries(body.files.map(f => [f.name, capture.bytes[f.name]?.length || 0]));
      return json({ capture: { id }, received: body.files.filter(f => offsets[f.name] === f.bytes && sha(capture.bytes[f.name]) === f.sha256).map(f => f.name), offsets });
    }
    if (action === 'chunks') {
      const offset = Number(parsed.searchParams.get('offset')), previous = capture.bytes[name] || Buffer.alloc(0);
      assert.equal(offset, previous.length); assert.ok(options.body.length <= 8 * 1024 * 1024);
      capture.bytes[name] = Buffer.concat([previous, Buffer.from(options.body)]);
      return json({ ok: true, nextOffset: capture.bytes[name].length, complete: capture.bytes[name].length === capture.files.find(f => f.name === name).bytes });
    }
    if (action === 'complete') {
      for (const part of capture.files) { assert.equal(capture.bytes[part.name].length, part.bytes); assert.equal(sha(capture.bytes[part.name]), part.sha256); }
      capture.complete = true; return json({ capture: { id, uploadState: 'complete' } });
    }
    throw Error('unexpected request');
  }
  async function fetchImpl(url, options) { requests.push({ url, method: options.method, body: options.body }); return handler ? handler(url, options, respond) : respond(url, options); }
  function create(options = {}) {
    const queue = createFieldCloudSync({ file, dataDir, auth, fetchImpl, getLive: async () => frame, intervalMs: 60000, ...options }); instances.push(queue); return queue;
  }
  function recording(id = 'a'.repeat(32), samples = 100, status = 'complete') {
    const dir = path.join(dataDir, id); fs.mkdirSync(dir, { recursive: true });
    const raw = Buffer.alloc(32 + samples * 29); raw.write('BLADEV01'); raw.writeDoubleLE(1000, 8); raw.writeDoubleLE(1800000000, 16); raw.writeBigUInt64LE(0n, 24);
    for (let index = 0; index < samples; index++) raw.writeBigUInt64LE(BigInt(index), 32 + index * 29);
    fs.writeFileSync(path.join(dir, 'chunk-00000000.bin'), raw);
    const manifest = { id, name: `test ${id[0]}`, source: 'simulation', status, samples, sampleRate: 1000, sampleOrigin: 1800000000,
      startedAt: 1800000000, endedAt: status === 'complete' ? 1800000001 : null, unit: 'm/s', chunks: 1, unpairedRssiSamples: 0 };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); return { manifest, raw, dir };
  }
  t.after(async () => { for (const queue of instances) queue.dispose(); await Promise.all(instances.map(queue => queue.settled())); fs.rmSync(directory, { force: true, recursive: true }); });
  return { create, recording, captures, requests, file, dataDir, auth, identity,
    get token() { return session?.token; }, setSession(value) { session = value ? { ...identity, token: value } : null; },
    setHandler(value) { handler = value; }, setFrame(value) { frame = value; } };
}

test('only new tracked captures auto-sync; live preview is bounded and raw files upload unchanged after stop', async t => {
  const f = fixture(t); f.recording('b'.repeat(32)); // historical data must stay local
  const current = f.recording('a'.repeat(32), 4096, 'incomplete');
  const queue = f.create(); queue.resume(); await queue.settled(); assert.equal(f.requests.length, 0);
  queue.started(current.manifest); await queue.settled();
  f.setFrame({ state: 'acquiring', recording: current.manifest, waveform: { sampleRate: 1000, sampleStart: 0, sampleStride: 1,
    values: Array.from({ length: 4096 }, (_, i) => i / 100), rssi: Array(4096).fill(50), overrange: Array(4096).fill(false) } });
  queue.resume(); await queue.settled();
  const live = f.captures.get(current.manifest.id).live.at(-1);
  assert.equal(live.waveform.values.length, 2048); assert.equal(live.waveform.sampleStride, 2);
  assert.equal(f.captures.get(current.manifest.id).complete, false);
  const finished = f.recording(current.manifest.id, 4096, 'complete');
  queue.finished(finished.manifest); await queue.settled();
  const capture = f.captures.get(current.manifest.id);
  assert.equal(capture.complete, true); assert.deepEqual(capture.bytes['chunk-00000000.bin'], finished.raw);
  assert.equal(f.captures.size, 1); assert.equal(queue.status().items[0].state, 'synced');
  assert.equal(JSON.stringify(queue.status()).includes(f.token), false);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes(f.token), false);
});

test('live RSSI acquisition timing survives display decimation without changing existing waveform samples', async t => {
  const f = fixture(t), current = f.recording('a'.repeat(32), 4096, 'incomplete');
  const queue = f.create(); queue.resume(); queue.started(current.manifest); await queue.settled();
  const waveform = { sampleRate: 51200, sampleStart: 32, sampleStride: 2, sampleOrigin: 1800000000,
    values: Array.from({ length: 4096 }, (_, i) => i / 1000),
    rssi: Array.from({ length: 4096 }, (_, i) => i % 32 === 0 ? 80 : null),
    overrange: Array.from({ length: 4096 }, (_, i) => i % 7 === 0) };
  const original = structuredClone(waveform);
  async function preview(metadata) {
    f.setFrame({ state: 'acquiring', recording: current.manifest, waveform: { ...waveform, ...metadata } });
    queue.resume(); await queue.settled();
    return f.captures.get(current.manifest.id).live.at(-1).waveform;
  }
  const legacy = await preview({});
  for (const [rssiSampleStride, rssiSampleRate] of [[1, 51200], [32, 1600], [100000, 0.512], [3, 51200 / 3]]) {
    const result = await preview({ rssiSampleStride, rssiSampleRate });
    assert.equal(result.rssiSampleStride, rssiSampleStride);
    assert.equal(result.rssiSampleRate, rssiSampleRate);
    const { rssiSampleStride: omittedStride, rssiSampleRate: omittedRate, ...unchanged } = result;
    assert.deepEqual(unchanged, legacy);
  }
  assert.equal(legacy.values.length, 2048); assert.equal(legacy.sampleStride, 4);
  assert.equal(legacy.rssiSampleStride, undefined); assert.equal(legacy.rssiSampleRate, undefined);
  assert.deepEqual(waveform, original);
});

test('invalid or incomplete RSSI timing is omitted while legacy live waveform remains unchanged', async t => {
  const f = fixture(t), current = f.recording('a'.repeat(32), 100, 'incomplete');
  const queue = f.create(); queue.resume(); queue.started(current.manifest); await queue.settled();
  const waveform = { sampleRate: 51200, sampleStart: 0, values: [0, 0.01, -0.01], rssi: [80, null, 70], overrange: [false, true, false] };
  async function preview(metadata) {
    f.setFrame({ state: 'acquiring', recording: current.manifest, waveform: { ...waveform, ...metadata } });
    queue.resume(); await queue.settled();
    return f.captures.get(current.manifest.id).live.at(-1).waveform;
  }
  const legacy = await preview({});
  const invalid = [
    ...[0, -1, 1.5, 100001, Number.MAX_SAFE_INTEGER + 1, '32', true, null, NaN, Infinity].map(rssiSampleStride => ({ rssiSampleStride, rssiSampleRate: 1600 })),
    ...[0, -1, '1600', true, null, NaN, Infinity, 1601, 102400, Number.MIN_VALUE].map(rssiSampleRate => ({ rssiSampleStride: 32, rssiSampleRate })),
    { rssiSampleStride: 32 }, { rssiSampleRate: 1600 },
  ];
  for (const metadata of invalid) assert.deepEqual(await preview(metadata), legacy);
  assert.equal(queue.status().items[0].error, undefined);
});

test('lost chunk response resumes at persisted server offset after application restart without uploading duplicate bytes', async t => {
  const f = fixture(t), current = f.recording('a'.repeat(32), 160000);
  let interrupted = false;
  f.setHandler(async (url, options, respond) => {
    const result = await respond(url, options);
    if (!interrupted && url.includes('/chunks/')) { interrupted = true; throw Error('connection lost after server persisted block'); }
    return result;
  });
  const first = f.create(); first.resume(); first.uploadRecording(current.manifest.id); await first.settled();
  assert.equal(first.status().items[0].state, 'error'); assert.equal(f.captures.get(current.manifest.id).bytes['chunk-00000000.bin'].length, 4 * 1024 * 1024);
  first.dispose(); f.setHandler(null);
  const second = f.create(); second.resume(); await second.settled();
  assert.equal(second.status().items[0].state, 'synced');
  assert.deepEqual(f.captures.get(current.manifest.id).bytes['chunk-00000000.bin'], current.raw);
  const uploads = f.requests.filter(r => r.url.includes('/chunks/'));
  assert.equal(uploads.length, 2); assert.ok(uploads[1].url.endsWith('?offset=4194304'));
});

test('offline capture queues locally, logout clears live capability, and a new online session continues saved work', async t => {
  const f = fixture(t), current = f.recording('a'.repeat(32), 100, 'incomplete');
  f.setSession(null); const queue = f.create(); queue.resume(); queue.started(current.manifest);
  const complete = f.recording(current.manifest.id, 100); queue.finished(complete.manifest); await queue.settled();
  assert.equal(f.requests.length, 0); assert.equal(queue.status().items[0].state, 'queued');
  queue.pause(); assert.equal(queue.status().state, 'signed-out');
  f.setSession('new-private-session-token'); queue.resume(); await queue.settled();
  assert.equal(queue.status().items[0].state, 'synced');
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('new-private-session-token'), false);
});

test('Web 401 clears sync capability and retains local queue until a fresh authenticated session', async t => {
  const f = fixture(t), current = f.recording();
  f.setHandler(() => json({}, 401)); const queue = f.create(); queue.resume(); queue.uploadRecording(current.manifest.id); await queue.settled();
  assert.equal(f.auth.cloudSession(), null); assert.equal(queue.status().connected, false); assert.equal(queue.status().items[0].state, 'error');
  const requests = f.requests.length; queue.retry(); await queue.settled(); assert.equal(f.requests.length, requests);
  f.setHandler(null); f.setSession('new-after-reauth'); queue.resume(); await queue.settled();
  assert.equal(queue.status().items[0].state, 'synced');
});

test('automatic synchronization can be disabled while explicitly selected historical records remain uploadable', async t => {
  const f = fixture(t), old = f.recording('b'.repeat(32)), current = f.recording('a'.repeat(32));
  const queue = f.create(); queue.resume(); queue.setEnabled(false); queue.started(current.manifest); queue.finished(current.manifest); await queue.settled();
  assert.equal(f.requests.length, 0); assert.equal(queue.status().items.length, 0);
  queue.uploadRecording(old.manifest.id); await queue.settled();
  assert.equal(f.captures.size, 1); assert.equal(queue.status().items[0].recordingId, old.manifest.id);
});

test('original raw RSSI extras are preserved, and incomplete/symlinked/corrupt raw recordings never reach Web', async t => {
  const f = fixture(t), current = f.recording();
  const extras = Buffer.from('extra raw RSSI fixture'); fs.writeFileSync(path.join(current.dir, 'unpaired-rssi.bin'), extras);
  current.manifest.unpairedRssiSamples = 1; fs.writeFileSync(path.join(current.dir, 'manifest.json'), JSON.stringify(current.manifest));
  const queue = f.create(); queue.resume(); queue.uploadRecording(current.manifest.id); await queue.settled();
  assert.deepEqual(f.captures.get(current.manifest.id).bytes['unpaired-rssi.bin'], extras);
  const incomplete = f.recording('c'.repeat(32), 20, 'incomplete');
  assert.throws(() => queue.uploadRecording(incomplete.manifest.id), /完整保存/);
  assert.throws(() => queue.uploadRecording('../not-allowed'), /无效/);
  const broken = f.recording('d'.repeat(32)); fs.appendFileSync(path.join(broken.dir, 'chunk-00000000.bin'), Buffer.from([1]));
  queue.uploadRecording(broken.manifest.id); await queue.settled();
  assert.equal(f.captures.has(broken.manifest.id), false);
  const linked = f.recording('e'.repeat(32)); fs.unlinkSync(path.join(linked.dir, 'chunk-00000000.bin')); fs.symlinkSync(path.join(current.dir, 'chunk-00000000.bin'), path.join(linked.dir, 'chunk-00000000.bin'));
  queue.uploadRecording(linked.manifest.id); await queue.settled(); assert.equal(f.captures.has(linked.manifest.id), false);
});

test('a damaged private queue is preserved and disables cloud work without touching raw recordings', async t => {
  const f = fixture(t), current = f.recording();
  fs.writeFileSync(f.file, '{broken', { mode: 0o600 }); const queue = f.create(); queue.resume();
  assert.equal(queue.status().state, 'error'); assert.throws(() => queue.started(current.manifest), /同步队列/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken'); assert.deepEqual(fs.readFileSync(path.join(current.dir, 'chunk-00000000.bin')), current.raw);
  assert.equal(f.requests.length, 0);
});


test('unconfirmed completion never marks a local recording synced', async t => {
  const f = fixture(t), current = f.recording();
  f.setHandler((url, options, respond) => url.endsWith('/complete') ? json({ capture: { id: current.manifest.id, uploadState: 'uploading' } }) : respond(url, options));
  const queue = f.create(); queue.resume(); queue.uploadRecording(current.manifest.id); await queue.settled();
  assert.equal(queue.status().items[0].state, 'error');
  assert.match(queue.status().items[0].error, /校验未确认/);
});


test('turning off auto enrollment preserves already queued work and excludes only future captures', async t => {
  const f = fixture(t), queued = f.recording('a'.repeat(32)), later = f.recording('b'.repeat(32));
  f.setSession(null); const queue = f.create(); queue.resume(); queue.started(queued.manifest); queue.finished(queued.manifest);
  queue.setEnabled(false); queue.started(later.manifest); queue.finished(later.manifest);
  assert.equal(queue.status().items.length, 1);
  f.setSession('online-session-for-previous-queue'); queue.resume(); await queue.settled();
  assert.equal(queue.status().items[0].state, 'synced'); assert.equal(f.captures.has(later.manifest.id), false);
});


test('oversize metadata fails locally and is not retried on every timer tick', async t => {
  const f = fixture(t), current = f.recording();
  current.manifest.notes = 'x'.repeat(530000);
  fs.writeFileSync(path.join(current.dir, 'manifest.json'), JSON.stringify(current.manifest));
  const queue = f.create(); queue.resume(); queue.uploadRecording(current.manifest.id); await queue.settled();
  assert.equal(queue.status().items[0].state, 'error'); assert.match(queue.status().items[0].error, /512 KiB/);
  assert.equal(f.requests.length, 0);
  const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(state.items[0].retryAt, Number.MAX_SAFE_INTEGER);
});


test('late live errors after stopping cannot overwrite a completed raw-upload state', async t => {
  const f = fixture(t), current = f.recording('a'.repeat(32), 100, 'incomplete');
  const queue = f.create(); queue.resume(); queue.started(current.manifest); await queue.settled();
  let release, waiting = false;
  const gate = new Promise(resolve => { release = resolve; });
  f.setHandler((url, options, respond) => {
    if (url.endsWith('/live')) { waiting = true; return gate; }
    return respond(url, options);
  });
  f.setFrame({ state: 'acquiring', recording: current.manifest, waveform: { sampleRate: 1000, sampleStart: 0, values: [1, 2], rssi: [80, 80], overrange: [false, false] } });
  queue.resume();
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  const finished = f.recording(current.manifest.id, 100); queue.finished(finished.manifest);
  const deadline = Date.now() + 2000;
  while (!f.captures.get(current.manifest.id).complete && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.captures.get(current.manifest.id).complete, true);
  release(json({}, 409)); await queue.settled();
  assert.equal(queue.status().items[0].state, 'synced');
});

test('completed history is compacted and cannot fill the queue or persist whole raw manifests', async t => {
  const f = fixture(t), current = f.recording('f'.repeat(32));
  const owner = JSON.stringify([f.identity.serverUrl, f.identity.user.id, f.identity.user.tenant]);
  const items = Array.from({ length: 2000 }, (_, index) => ({ recordingId: index.toString(16).padStart(32, '0'),
    name: 'past capture', owner, manual: false, state: 'synced', finishedAt: index,
    recording: { notes: 'legacy manifest payload'.repeat(20) }, files: [{ name: 'chunk-00000000.bin', bytes: 32, sha256: 'a'.repeat(64) }] }));
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, clientId: 'a1234567-1234-4321-8123-123456789abc', enabled: true, items }), { mode: 0o600 });
  f.setSession(null); const queue = f.create(); queue.resume(); queue.uploadRecording(current.manifest.id);
  const persisted = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(persisted.items.filter(item => item.state === 'synced').length, 200);
  assert.equal(persisted.items.length, 201);
  assert.ok(persisted.items.every(item => !item.recording && !item.files));
  assert.ok(fs.statSync(f.file).size < 100000);
});

test('current live registration and full 2049-bin FFT bypass an older blocked raw upload', async t => {
  const f = fixture(t), old = f.recording('a'.repeat(32)), current = f.recording('b'.repeat(32), 100, 'incomplete');
  let release, blocked = false;
  const gate = new Promise(resolve => { release = resolve; });
  f.setHandler(async (url, options, respond) => {
    if (url.includes(`/${old.manifest.id}/chunks/`)) { blocked = true; await gate; }
    return respond(url, options);
  });
  const queue = f.create(); queue.resume(); queue.uploadRecording(old.manifest.id);
  let deadline = Date.now() + 2000;
  while (!blocked && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(blocked, true);
  f.setFrame({ state: 'acquiring', recording: current.manifest, waveform: { sampleRate: 1000, sampleStart: 0, values: [1, 2], rssi: [80, 80], overrange: [false, false] },
    realtime: { available: true, spectrum: { frequencies: Array.from({ length: 2049 }, (_, i) => i), amplitudes: Array(2049).fill(0.1) } } });
  queue.started(current.manifest);
  deadline = Date.now() + 2000;
  while (!f.captures.get(current.manifest.id)?.live.length && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.captures.get(current.manifest.id)?.live.length, 1);
  assert.equal(f.captures.get(current.manifest.id).live[0].realtime.spectrum.frequencies.length, 2049);
  assert.equal(f.captures.get(old.manifest.id).complete, false);
  const snapshot = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.ok(snapshot.items.every(item => !item.files && !item.recording));
  const hashes = JSON.parse(fs.readFileSync(path.join(f.file + '.plans', `${old.manifest.id}.json`), 'utf8'));
  assert.equal(hashes.files[0].sha256, sha(old.raw));
  release(); await queue.settled();
  assert.equal(f.captures.get(old.manifest.id).complete, true);
});

test('turntable telemetry and point metadata upload unchanged and resume after a lost telemetry response', async t => {
  const f = fixture(t), current = f.recording();
  const telemetry = Buffer.from('{"event":"status","hostTime":1800000000,"elapsedSeconds":0,"axis":1}\n');
  current.manifest.turntable = { config: { port: 'COM6', axis: 1 }, preparedReferences: { '1': { origin_counts: 500 } },
    telemetry: { file: 'turntable.jsonl', events: 1, sha256: sha(telemetry) } };
  current.manifest.pointCycle = { cycle: 1, pointIndex: 2, actualAngles: { '1': 5, '2': 20 },
    mode: 'automatic_stations', collectionId: 'c'.repeat(32), sessionId: 'a'.repeat(32), bladeId: '2', radialPointId: 'p1', radialPointName: 'P1',
    radiusM: .31, azimuthDeg: 90, stationIndex: 2, stationCount: 4, lapIndex: 1, cycles: 1,
    identitySource: 'operator_assigned', identityVerified: false, coverageKind: 'sparse_station_passes', completion: 'confirmed_pass',
    plannedStations: [0, 90, 180, 270].map((azimuthDeg, index) => ({ pointId: `p1-s${index + 1}`, bladeId: '2',
      radialPointId: 'p1', radialPointName: 'P1', radiusM: .31, azimuthDeg, stationIndex: index + 1, stationCount: 4 })) };
  fs.writeFileSync(path.join(current.dir, 'manifest.json'), JSON.stringify(current.manifest));
  fs.writeFileSync(path.join(current.dir, 'turntable.jsonl'), telemetry);
  let lost = false;
  f.setHandler(async (url, options, respond) => {
    const result = await respond(url, options);
    if (!lost && url.includes('/chunks/turntable.jsonl')) { lost = true; throw Error('response lost after telemetry persisted'); }
    return result;
  });
  const first = f.create(); first.resume(); first.uploadRecording(current.manifest.id); await first.settled();
  assert.equal(first.status().items[0].state, 'error'); first.dispose();
  f.setHandler(null); const restarted = f.create(); restarted.resume(); await restarted.settled();
  assert.equal(restarted.status().items[0].state, 'synced');
  const uploaded = f.captures.get(current.manifest.id);
  assert.deepEqual(uploaded.bytes['turntable.jsonl'], telemetry);
  assert.deepEqual(uploaded.recording.turntable, current.manifest.turntable);
  assert.deepEqual(uploaded.recording.pointCycle, current.manifest.pointCycle);
  assert.equal(f.requests.filter(r => r.url.includes('/chunks/turntable.jsonl')).length, 1);
  assert.deepEqual(fs.readFileSync(path.join(current.dir, 'turntable.jsonl')), telemetry);
});

test('missing or changed turntable telemetry cannot mark a joint recording synced', async t => {
  const f = fixture(t), current = f.recording();
  current.manifest.turntable = { telemetry: { file: 'turntable.jsonl', events: 1, sha256: sha(Buffer.from('original')) } };
  fs.writeFileSync(path.join(current.dir, 'manifest.json'), JSON.stringify(current.manifest));
  const queue = f.create(); queue.resume(); queue.uploadRecording(current.manifest.id); await queue.settled();
  assert.equal(queue.status().items[0].state, 'error'); assert.equal(f.requests.length, 0);
  fs.writeFileSync(path.join(current.dir, 'turntable.jsonl'), 'changed');
  queue.retry(); await queue.settled();
  assert.equal(queue.status().items[0].state, 'error'); assert.equal(f.requests.length, 0);
});
