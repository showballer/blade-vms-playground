'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepareBundledRecordings, installBundledRecordings } = require('../apps/desktop/electron/field-bundled-recordings.cjs');
const taskName = '10241804-叶片2-P1至P5';
const idA = 'a'.repeat(32), idB = 'b'.repeat(32), idC = 'c'.repeat(32);
const sha = value => createHash('sha256').update(value).digest('hex');
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function fixture(t, prepare = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-bundled-recordings-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), bundle = path.join(root, 'bundle'), data = path.join(root, 'profile/field-data');
  fs.mkdirSync(source);
  const f = { root, source, bundle, data, build: () => prepareBundledRecordings({ recordingsDir: source, taskName, outputDir: bundle }),
    install: () => installBundledRecordings({ bundleDir: bundle, dataDir: data }) };
  record(source, idA); record(source, idB); record(source, idC, { name: taskName + '-other' });
  if (prepare) f.summary = f.build();
  return f;
}
function record(source, id, changes = {}) {
  const dir = path.join(source, id); fs.mkdirSync(dir);
  const samples = 4, sampleRate = 250000, sampleOrigin = 1792800000;
  const raw = Buffer.alloc(32 + samples * 29); raw.write('BLADEV01'); raw.writeDoubleLE(sampleRate, 8); raw.writeDoubleLE(sampleOrigin, 16);
  for (let i = 0; i < samples; i++) { raw.writeBigUInt64LE(BigInt(i), 32 + i * 29); raw.writeDoubleLE(i / 1000, 44 + i * 29); }
  fs.writeFileSync(path.join(dir, 'chunk-00000000.bin'), raw);
  write(path.join(dir, 'manifest.json'), { id, name: taskName, originalTaskName: taskName, format: 'BLADEV01/<QidifB', samples, chunks: 1,
    sampleRate, sampleOrigin, startedAt: sampleOrigin, status: 'complete', error: null, source: 'device', diagnosticOnly: true,
    validMeasurement: false, pointCycle: { bladeId: '2', radialPointName: 'P1', diagnosticDetection: { enabled: true } },
    importSource: { type: 'blade-vms-task-zip', physicalSamplesPreserved: true, rawCodesAvailable: false, autoUpload: false }, ...changes });
  write(path.join(dir, 'source-export-manifest.json'), { id: 'original', name: 'original point', diagnosticOnly: true, importSource: { type: 'original' } });
  return dir;
}
function resign(bundle, mutate) {
  const file = path.join(bundle, 'manifest.json'), m = read(file); mutate(m);
  m.bundleId = sha(JSON.stringify({ schemaVersion: m.schemaVersion, taskName: m.taskName, records: m.records })); write(file, m);
}
function noImported(f) {
  const dir = path.join(f.data, 'recordings');
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir).filter(id => /^[a-f0-9]{32}$/.test(id)) : [], []);
}

test('explicit task only; original raw bytes and diagnostics preserved, no profiles or SQLite copied', t => {
  const f = fixture(t, false), before = sha(fs.readFileSync(path.join(f.source, idA, 'manifest.json')));
  for (const file of ['recordings.sqlite3', 'blade-local-auth.json', 'blade-field-settings.json', 'blade-cloud-sync.json']) fs.writeFileSync(path.join(f.source, file), 'PRIVATE DO NOT COPY');
  fs.writeFileSync(path.join(f.source, idA, 'account.json'), 'PRIVATE DO NOT COPY');
  const summary = f.build(); assert.equal(summary.recordCount, 2); assert.equal(summary.fileCount, 6);
  assert.deepEqual(fs.readdirSync(path.join(f.bundle, 'records')), [idA, idB]);
  assert.equal(sha(fs.readFileSync(path.join(f.source, idA, 'manifest.json'))), before);
  const result = f.install(); assert.equal(result.status, 'installed'); assert.deepEqual(result.imported, [idA, idB]);
  for (const id of result.imported) for (const name of ['manifest.json', 'source-export-manifest.json', 'chunk-00000000.bin'])
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'recordings', id, name)), fs.readFileSync(path.join(f.source, id, name)));
  assert.deepEqual(fs.readdirSync(f.data).sort(), ['bundled-recordings-state.json', 'recordings']);
  assert.equal(read(path.join(f.data, 'recordings', idA, 'manifest.json')).importSource.autoUpload, false);
});

test('nested account/credential/sync fields are removed without stripping measured device settings', t => {
  const f = fixture(t, false), file = path.join(f.source, idA, 'manifest.json'), m = read(file);
  Object.assign(m, { captureSessionId: 'old-profile-capture-session', ownerId: 'do-not-copy', accountBinding: { token: 'do-not-copy' }, syncOrigin: { userId: 'do-not-copy' },
    sourceMetadata: { tenantId: 'do-not-copy', user: 'do-not-copy', token: 'do-not-copy', diagnosticOnly: true }, deviceSettings: { bandwidth: '250 kHz' } });
  write(file, m); const sourceFile = path.join(f.source, idA, 'source-export-manifest.json');
  write(sourceFile, { ...read(sourceFile), credentials: { password: 'do-not-copy' } });
  f.build(); f.install(); const imported = read(path.join(f.data, 'recordings', idA, 'manifest.json'));
  assert.equal(JSON.stringify(imported).includes('do-not-copy'), false); assert.deepEqual(imported.deviceSettings, m.deviceSettings);
  assert.equal(imported.captureSessionId, undefined); assert.deepEqual(imported.pointCycle, m.pointCycle);
  assert.equal(imported.diagnosticOnly, true); assert.equal(imported.importSource.rawCodesAvailable, false);
  assert.equal(read(file).ownerId, 'do-not-copy', 'source data must stay untouched');
});

test('repeated launch is idempotent; user modifications and deletions never overwritten or resurrected', t => {
  const f = fixture(t); f.install();
  const file = path.join(f.data, 'recordings', idB, 'manifest.json'); write(file, { ...read(file), name: 'user edited' });
  fs.rmSync(path.join(f.data, 'recordings', idA), { recursive: true });
  const result = f.install(); assert.equal(result.status, 'skipped'); assert.deepEqual(result.skipped, [idA, idB]);
  assert.equal(fs.existsSync(path.join(f.data, 'recordings', idA)), false); assert.equal(read(file).name, 'user edited');
});

test('new bundle version imports only new IDs; deleted old data stays deleted', t => {
  const f = fixture(t); const firstId = f.summary.bundleId; f.install(); fs.rmSync(path.join(f.data, 'recordings', idA), { recursive: true });
  const file = path.join(f.source, idC, 'manifest.json'); write(file, { ...read(file), name: taskName });
  const next = path.join(f.root, 'bundle-next'); const summary = prepareBundledRecordings({ recordingsDir: f.source, taskName, outputDir: next });
  assert.notEqual(summary.bundleId, firstId); const result = installBundledRecordings({ bundleDir: next, dataDir: f.data });
  assert.deepEqual(result.imported, [idC]); assert.deepEqual(result.skipped, [idA, idB]); assert.equal(fs.existsSync(path.join(f.data, 'recordings', idA)), false);
});

test('pre-existing identical record skipped; conflicting same ID reported without overwrite', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.data, 'recordings'), { recursive: true });
  fs.cpSync(path.join(f.source, idA), path.join(f.data, 'recordings', idA), { recursive: true });
  fs.mkdirSync(path.join(f.data, 'recordings', idB)); fs.writeFileSync(path.join(f.data, 'recordings', idB, 'custom.txt'), 'user-owned');
  const result = f.install(); assert.equal(result.status, 'partial'); assert.deepEqual(result.skipped, [idA]); assert.deepEqual(result.conflicts, [idB]);
  assert.equal(fs.readFileSync(path.join(f.data, 'recordings', idB, 'custom.txt'), 'utf8'), 'user-owned');
  assert.equal(fs.existsSync(path.join(f.data, 'recordings', idB, 'manifest.json')), false);
});

test('integrity failure in last record publishes none, leaves diagnostic, fixed bundle retries', t => {
  const f = fixture(t), file = path.join(f.bundle, 'records', idB, 'chunk-00000000.bin'), original = fs.readFileSync(file);
  const bad = Buffer.from(original); bad[60] ^= 0xff; fs.writeFileSync(file, bad);
  assert.throws(f.install, /完整性校验失败/); noImported(f);
  assert.match(read(path.join(f.data, 'bundled-recordings-error.json')).message, /完整性校验失败/);
  fs.writeFileSync(file, original); assert.equal(f.install().imported.length, 2);
});

test('rejects path traversal and unsupported manifest versions before import', t => {
  for (const mutate of [m => { m.records[0].id = '../escape'; }, m => { m.records[0].files[0].path = '../escape'; },
    m => { m.records[0].files[0].path = 'C:\\escape'; }, m => { m.schemaVersion = 2; }, m => { m.records.push(m.records[0]); }]) {
    const f = fixture(t); resign(f.bundle, mutate); assert.throws(f.install, /预置采集记录/); noImported(f);
  }
});

test('source and bundled symlinks rejected; target symlink never traversed', t => {
  const f = fixture(t, false), original = path.join(f.source, idA, 'chunk-00000000.bin'), outside = path.join(f.root, 'outside.bin');
  fs.renameSync(original, outside); fs.symlinkSync(outside, original); assert.throws(f.build, /文件类型/); assert.equal(fs.existsSync(f.bundle), false);
  fs.unlinkSync(original); fs.copyFileSync(outside, original); f.build();
  const bundled = path.join(f.bundle, 'records', idA, 'chunk-00000000.bin'); fs.unlinkSync(bundled); fs.symlinkSync(outside, bundled);
  assert.throws(f.install, /文件类型/); noImported(f);
  fs.unlinkSync(bundled); fs.copyFileSync(outside, bundled); fs.mkdirSync(path.join(f.data, 'recordings'), { recursive: true });
  const external = path.join(f.root, 'external-record'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'unchanged'), 'keep');
  fs.symlinkSync(external, path.join(f.data, 'recordings', idA));
  assert.deepEqual(f.install().conflicts, [idA]); assert.deepEqual(fs.readdirSync(external), ['unchanged']);
});

test('invalid raw sample counts rejected even with matching declared hashes', t => {
  const f = fixture(t), file = path.join(f.bundle, 'records', idB, 'manifest.json'), m = read(file); m.samples++; write(file, m);
  resign(f.bundle, b => { const entry = b.records.find(r => r.id === idB).files.find(f => f.path === 'manifest.json'); entry.sha256 = sha(fs.readFileSync(file)); entry.size = fs.statSync(file).size; });
  assert.throws(f.install, /样本数量不符/); noImported(f);
});

test('absent optional bundle does not create user data; invalid import ledger is never reset', t => {
  const f = fixture(t); const absentData = path.join(f.root, 'unused');
  assert.equal(installBundledRecordings({ bundleDir: path.join(f.root, 'no-bundle'), dataDir: absentData }).status, 'absent'); assert.equal(fs.existsSync(absentData), false);
  fs.mkdirSync(f.data, { recursive: true }); const state = path.join(f.data, 'bundled-recordings-state.json'); fs.writeFileSync(state, '{broken');
  assert.throws(f.install, /JSON 格式/); assert.equal(fs.readFileSync(state, 'utf8'), '{broken'); noImported(f);
});

test('interrupted publication is diagnosed and never silently replays an uncertain import', t => {
  const f = fixture(t); fs.mkdirSync(f.data, { recursive: true });
  write(path.join(f.data, 'bundled-recordings-state.json'), { schemaVersion: 1, records: { [idA]: { status: 'pending', bundleId: f.summary.bundleId } } });
  const result = f.install(); assert.equal(result.status, 'partial'); assert.deepEqual(result.interrupted, [idA]); assert.deepEqual(result.imported, [idB]);
  assert.equal(fs.existsSync(path.join(f.data, 'recordings', idA)), false);
});

test('build output cannot overwrite existing data, selected task must exist and be complete', t => {
  const f = fixture(t); assert.throws(f.build, /已存在/);
  assert.throws(() => prepareBundledRecordings({ recordingsDir: f.source, taskName: 'missing', outputDir: path.join(f.root, 'missing') }), /找不到任务/);
  const next = path.join(f.root, 'next'), file = path.join(f.source, idA, 'manifest.json'); write(file, { ...read(file), status: 'incomplete' });
  assert.throws(() => prepareBundledRecordings({ recordingsDir: f.source, taskName, outputDir: next }), /完整状态/); assert.equal(fs.existsSync(next), false);
});
