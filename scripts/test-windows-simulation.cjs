// Exercise the shipped desktop bridge and frozen service without device access.
// Windows: node scripts/test-windows-simulation.cjs --resources <win-unpacked/resources>
// Local source-only validation (NOT Windows acceptance): add --source instead.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  assert.ok(['--source', '--resources', '--output'].includes(key), `Unknown option: ${key}`);
  if (key === '--source') options.source = true;
  else {
    const value = process.argv[++index];
    assert.ok(value && !value.startsWith('--'), `Missing value for ${key}`);
    options[key.slice(2)] = path.resolve(value);
  }
}
assert.ok(Boolean(options.source) !== Boolean(options.resources), 'Use exactly one of --source or --resources');
if (!options.source) assert.equal(process.platform, 'win32', 'Frozen Windows acceptance must run on Windows');
const output = options.output || path.join(root, 'artifacts', options.source ? 'source-simulation-smoke' : 'windows-simulation-smoke');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-simulation-release-'));
const dataDir = path.join(temporary, '采集数据 with spaces');
fs.mkdirSync(dataDir);
fs.mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), platform: process.platform,
  frozenWindowsTested: !options.source, hardwareTested: false, deviceRequests: 0,
  sdkDisabled: true, captures: [], passed: false };
let service, ownedChild, cloud;

async function waitFor(callback, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await pause(80);
  }
  throw Error(`Timed out: ${description}`);
}

function validateCsv(bytes, recording, expectedPoint) {
  const lines = bytes.toString('utf8').trimEnd().split('\n');
  assert.ok(lines[0].startsWith('# BladeVMS '));
  const metadata = JSON.parse(lines[0].slice('# BladeVMS '.length));
  assert.equal(metadata.format, 'blade-vms-csv-1');
  assert.equal(metadata.recordingId, recording.id);
  assert.equal(metadata.source, 'simulation');
  assert.equal(metadata.simulation.point, expectedPoint);
  assert.equal(metadata.simulation.scenario, 'baseline');
  assert.equal(metadata.simulation.sourceFile, 'rotation_from_static.xlsx');
  assert.equal(metadata.unit, 'm/s');
  assert.equal(metadata.sampleRate, recording.sampleRate);
  assert.equal(metadata.samples, recording.samples);
  assert.equal(lines[1], 'time_s,velocity_m_s,RSSI_percent,overrange');
  const rows = lines.slice(2).map(line => line.split(',').map(Number));
  assert.equal(rows.length, recording.samples, 'Export must include every saved raw sample');
  const recordDir = path.join(dataDir, 'recordings', recording.id);
  const chunks = fs.readdirSync(recordDir).filter(name => /^chunk-\d{8}\.bin$/.test(name)).sort();
  assert.ok(chunks.length > 0);
  let sample = 0;
  for (const name of chunks) {
    const bytes = fs.readFileSync(path.join(recordDir, name));
    assert.equal(bytes.subarray(0, 8).toString('ascii'), 'BLADEV01');
    assert.equal(bytes.readDoubleLE(8), recording.sampleRate);
    assert.equal(Number(bytes.readBigUInt64LE(24)), sample);
    assert.equal((bytes.length - 32) % 29, 0);
    for (let offset = 32; offset < bytes.length; offset += 29) {
      assert.equal(Number(bytes.readBigUInt64LE(offset)), sample);
      const row = rows[sample];
      assert.equal(row.length, 4);
      assert.ok(row.every(Number.isFinite));
      assert.equal(row[0], sample / recording.sampleRate);
      assert.equal(row[1], bytes.readDoubleLE(offset + 12), 'CSV velocity must equal the raw float64 sample');
      assert.ok(Math.abs(row[2] - bytes.readFloatLE(offset + 24)) < 0.000001, 'CSV RSSI differs from raw sample');
      assert.equal(row[3], Number(Boolean(bytes[offset + 28] & 1)));
      sample++;
    }
  }
  assert.equal(sample, rows.length);
  return metadata;
}

async function main() {
  let bridgeFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
  let cloudFile = path.join(root, 'apps/desktop/electron/field-cloud-sync.cjs');
  if (!options.source) {
    assert.ok(fs.statSync(path.join(options.resources, 'acquisition/BladeAcquisition.exe')).isFile());
    const asar = require('@electron/asar');
    const packagedBridge = asar.extractFile(path.join(options.resources, 'app.asar'), 'electron/field-service.cjs');
    bridgeFile = path.join(temporary, 'field-service.cjs');
    fs.writeFileSync(bridgeFile, packagedBridge);
    report.packagedBridgeSha256 = sha256(packagedBridge);
    const packagedCloud = asar.extractFile(path.join(options.resources, 'app.asar'), 'electron/field-cloud-sync.cjs');
    assert.equal(sha256(packagedCloud), sha256(fs.readFileSync(cloudFile)), 'Packaged cloud-sync must match this release source');
    cloudFile = path.join(temporary, 'field-cloud-sync.cjs');
    fs.writeFileSync(cloudFile, packagedCloud);
    report.packagedCloudSyncSha256 = sha256(packagedCloud);
  }
  const { createFieldService } = require(bridgeFile);
  // A nonexistent explicit DLL makes even an accidental receiver path unable
  // to load the real SDK. The fetch guard below additionally forbids devices.
  const disabledDll = path.join(temporary, 'HARDWARE_DISABLED_DO_NOT_CREATE.dll');
  service = createFieldService({
    getConfig: () => ({ dll: disabledDll }), dataDir,
    resourcesDir: options.resources || path.join(root, 'apps/desktop/resources'),
    servicesRoot: path.join(root, 'services/acquisition'),
    WebSocketImpl: null,
    spawnImpl: (file, args, configuration) => {
      assert.equal(configuration.env.BLADE_POLYTEC_DLL, disabledDll);
      assert.equal(configuration.env.BLADE_DATA_DIR, dataDir);
      if (!options.source) assert.equal(path.resolve(file), path.join(options.resources, 'acquisition/BladeAcquisition.exe'));
      ownedChild = spawn(file, args, configuration);
      return ownedChild;
    },
    fetchImpl: (url, request = {}) => {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, '127.0.0.1');
      const route = parsed.pathname.slice('/api/field/'.length);
      assert.ok(parsed.pathname.startsWith('/api/field/'));
      assert.ok(/^(status|simulation|frame|start|stop|recordings(?:\/[0-9a-f]{32}(?:\/export)?)?)$/.test(route), `Unapproved test route: ${route}`);
      if (route === 'start') {
        assert.equal(request.method, 'POST');
        const body = JSON.parse(request.body);
        assert.equal(body.source, 'simulation', 'Never start a real device in this test');
        assert.ok(!body.deviceIp && !body.hostIp && !body.confirmLaser);
        assert.ok(['P1', 'P2', 'P3'].includes(body.simulation.point));
        assert.equal(body.simulation.scenario, 'baseline');
      }
      return fetch(url, request);
    },
  });
  const ready = await service.start();
  assert.equal(ready.service.state, 'ready', ready.service.error || 'Service did not start');
  assert.equal(ready.receiver.dllAvailable, false, 'SDK must remain unavailable for this simulation gate');
  const catalog = await service.simulation();
  assert.deepEqual(catalog.points.map(point => point.id), ['P1', 'P2', 'P3']);
  assert.equal(catalog.unit, 'm/s');
  report.fixtureSha256 = catalog.sourceSha256;
  cloud = require('./windows-cloud-sync-harness.cjs').createHarness({ moduleFile: cloudFile,
    directory: temporary, recordingsDir: path.join(dataDir, 'recordings'), getLive: () => service.frame(1000) });
  cloud.queue.resume();
  for (const point of catalog.points) {
    const started = await service.begin({ source: 'simulation', simulation: { point: point.id, scenario: 'baseline' },
      name: `Windows release simulation ${point.id}`, object: '', turbine: '', point: point.id });
    cloud.queue.started(started.recording);
    await cloud.queue.settled();
    const frame = await waitFor(async () => {
      const value = await service.frame(1000);
      assert.notEqual(value.state, 'error', value.error || 'Simulation failed');
      return value.recording?.samples >= 2048 && value.realtime?.available && value;
    }, `${point.id} simulated samples and realtime analysis`);
    assert.equal(frame.receiver.source, 'simulation');
    assert.equal(frame.receiver.dataPort, null);
    assert.equal(frame.receiver.deviceIp, '');
    assert.equal(frame.receiver.hostIp, '');
    assert.equal(frame.recording.sampleRate, point.sampleRate);
    assert.ok(frame.realtime.timeDomain.values.length > 0);
    assert.ok(frame.realtime.spectrum.amplitudes.some(value => value > 0));
    assert.ok(frame.realtime.spectrogram.db.length > 0);
    const id = frame.recording.id;
    cloud.queue.resume();
    await cloud.queue.settled();
    await assert.rejects(service.exportRecording(id, path.join(temporary, 'active.csv')), error => error.status === 409);
    const stopped = await service.stop();
    assert.equal(stopped.receiver.running, false);
    assert.equal(stopped.recording.status, 'complete');
    cloud.queue.finished(stopped.recording);
    await cloud.queue.settled();
    const cloudChecks = cloud.assertSynced(id);
    const csvFile = path.join(temporary, `${point.id}.csv`);
    const gzipFile = path.join(temporary, `${point.id}.csv.gz`);
    assert.equal((await service.exportRecording(id, csvFile)).saved, true);
    assert.equal((await service.exportRecording(id, gzipFile)).saved, true);
    const csv = fs.readFileSync(csvFile);
    assert.deepEqual(gunzipSync(fs.readFileSync(gzipFile)), csv, 'CSV and gzip export must contain identical complete samples');
    validateCsv(csv, stopped.recording, point.id);
    report.captures.push({ point: point.id, samples: stopped.recording.samples,
      sampleRate: point.sampleRate, csvSha256: sha256(csv), rawSamplesMatched: true,
      gzipRoundtrip: true, realtimeTimeFftStft: true, cloudSync: cloudChecks });
    console.log(`PASS ${point.id}: ${options.source ? 'source' : 'frozen'} fixture, simulation, realtime analysis and ${stopped.recording.samples} raw CSV/GZ samples`);
  }
  assert.equal((await service.recordings()).recordings.length, 3);
  await service.shutdown();
  assert.ok(ownedChild.exitCode !== null || ownedChild.signalCode, 'Owned service process must exit');
  // Reopen from the same private directory to verify persistence, not UI cache.
  assert.equal((await service.start()).service.state, 'ready');
  const persisted = (await service.recordings()).recordings;
  assert.equal(persisted.length, 3);
  assert.ok(persisted.every(recording => recording.status === 'complete' && recording.source === 'simulation'));
  report.persistedAfterRestart = true;
  await service.shutdown();
  assert.ok(ownedChild.exitCode !== null || ownedChild.signalCode);
  report.passed = true;
}

main().catch(error => { report.error = error.message; process.exitCode = 1; console.error(error.stack); })
  .finally(async () => {
    cloud?.queue.dispose();
    if (cloud) await cloud.queue.settled();
    try { if (service) await service.shutdown({ force: true }); }
    catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(temporary, { recursive: true, force: true });
    console.log(`Report: ${path.join(output, 'report.json')}`);
  });
