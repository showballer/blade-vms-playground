'use strict';

// Windows release gate: exercise the shipped bridge and BladeAcquisition.exe.
// Completed-record fixtures live only in a private temporary directory. There
// is deliberately no start/device/serial/laser route, even for simulation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { gunzipSync } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const COLLECTION = 'c'.repeat(32);
const SAMPLE_COUNT = 2000, RATE = 1000, STRIDE = 4;

function optionsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(['--resources', '--output'].includes(argv[index]), 'Unknown gate option');
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), 'Missing gate option value');
    options[argv[index].slice(2)] = path.resolve(argv[index + 1]);
  }
  assert.ok(options.resources, '--resources is required; source Python is not frozen acceptance');
  options.output ||= path.join(root, 'artifacts/windows-blade-passes-smoke');
  return options;
}

function guardServiceRequest(url, request = {}) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'http:');
  assert.equal(parsed.hostname, '127.0.0.1', 'Gate may only contact its private local service');
  assert.equal(parsed.search, '');
  assert.equal(parsed.username + parsed.password + parsed.hash, '');
  assert.equal(request.method || 'GET', 'GET', 'No operation requests are permitted');
  assert.equal(request.body, undefined, 'Read-only fixture checks cannot carry operation bodies');
  assert.equal(request.redirect, 'error', 'Gate must never follow redirects');
  assert.ok(/^\/api\/field\/(?:status|recordings(?:\/[a-f0-9]{32}(?:\/export)?)?)$/.test(parsed.pathname),
    'Acquisition, device, serial, laser and motion routes are forbidden');
}

function fixture(index, radialPointId, radiusM, azimuthDeg, sessionId) {
  const id = index.toString(16).padStart(32, '0');
  const origin = 1700000000 + index;
  const pointCycle = { mode: 'automatic_stations', collectionId: COLLECTION, bladeId: '2', sessionId,
    radialPointId, radialPointName: radialPointId.toUpperCase(), radiusM, azimuthDeg,
    stationId: `${radialPointId}-${azimuthDeg}`, pointId: `${radialPointId}-${azimuthDeg}`,
    stationIndex: azimuthDeg === 0 ? 1 : 2, stationCount: 4, lapIndex: 1,
    identitySource: 'operator_assigned', identityVerified: false, coverageKind: 'sparse_station_passes',
    completion: 'confirmed_pass', outcome: 'observed',
    handoff: { reason: 'blade_left', entrySampleIndex: 180, entryConfirmedSampleIndex: 199,
      exitSampleIndex: 1600, exitConfirmedSampleIndex: 1629 } };
  // Mark test provenance explicitly. This data never came from hardware.
  const manifest = { id, name: 'Windows 隔离验收 · 分次测点', object: '隔离测试叶轮', turbine: 'test',
    point: radialPointId, source: 'simulation', simulation: { testFixture: 'windows-blade-passes-release-gate' },
    pointCycle, samples: SAMPLE_COUNT, sampleRate: RATE, rssiSampleStride: STRIDE, rssiSampleRate: RATE / STRIDE,
    startedAt: origin, sampleOrigin: origin, endedAt: origin + SAMPLE_COUNT / RATE, status: 'complete',
    error: null, unit: 'm/s', rssiUnit: '%', channels: ['CH1', 'RSSI1'], chunks: 1,
    format: 'BLADEV01/<QidifB', overrangeSamples: 100, missingRssiSamples: 1500, unpairedRssiSamples: 0,
    dataLossAssessment: 'not_applicable_simulation', timestampBasis: 'isolated release fixture sample clock' };
  const bytes = Buffer.alloc(32 + SAMPLE_COUNT * 29);
  bytes.write('BLADEV01', 0, 'ascii'); bytes.writeDoubleLE(RATE, 8); bytes.writeDoubleLE(origin, 16);
  bytes.writeBigUInt64LE(0n, 24);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const offset = 32 + i * 29;
    bytes.writeBigUInt64LE(BigInt(i), offset);
    bytes.writeInt32LE(0, offset + 8);
    bytes.writeDoubleLE(radiusM * Math.sin(2 * Math.PI * 50 * i / RATE), offset + 12);
    bytes.writeInt32LE(0, offset + 20);
    bytes.writeFloatLE(i >= 600 && i < 700 ? 10 : 80, offset + 24);
    bytes[offset + 28] = (i % STRIDE === 0 ? 2 : 0) | (i >= 1000 && i < 1100 ? 1 : 0);
  }
  return { manifest, bytes };
}

function createFixtures(directory) {
  const fixtures = [fixture(1, 'p1', .31, 0, 'a'.repeat(32)),
    fixture(2, 'p2', .5, 0, 'b'.repeat(32)), fixture(3, 'p1', .31, 90, 'a'.repeat(32))];
  for (const item of fixtures) {
    const folder = path.join(directory, item.manifest.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(item.manifest));
    fs.writeFileSync(path.join(folder, 'chunk-00000000.bin'), item.bytes);
  }
  return fixtures;
}

function validateExport(csv, item) {
  const lines = csv.toString('utf8').trimEnd().split('\n');
  assert.ok(lines[0].startsWith('# BladeVMS '));
  const meta = JSON.parse(lines[0].slice('# BladeVMS '.length));
  assert.equal(meta.format, 'blade-vms-csv-1');
  assert.equal(meta.recordingId, item.manifest.id);
  assert.deepEqual(meta.pointCycle, item.manifest.pointCycle, 'Point identity and exact pass boundaries must survive CSV');
  assert.equal(meta.sampleOrigin, item.manifest.sampleOrigin);
  assert.equal(meta.rssiSampleStride, STRIDE);
  assert.equal(meta.rssiSampleRate, RATE / STRIDE);
  assert.equal(meta.source, 'simulation', 'Fixture provenance must never become measured data');
  assert.deepEqual(meta.simulation, item.manifest.simulation);
  assert.equal(meta.unit, 'm/s');
  assert.equal(meta.samples, SAMPLE_COUNT);
  assert.equal(meta.sampleRate, RATE);
  assert.equal(meta.object, item.manifest.object);
  assert.equal(meta.turbine, item.manifest.turbine);
  assert.equal(lines[1], 'time_s,velocity_m_s,RSSI_percent,overrange');
  assert.equal(lines.length, SAMPLE_COUNT + 2, 'CSV includes every original sample, including invalid intervals');
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const row = lines[i + 2].split(','), offset = 32 + i * 29;
    assert.equal(row.length, 4);
    assert.equal(Number(row[0]), i / RATE);
    assert.equal(Number(row[1]), item.bytes.readDoubleLE(offset + 12));
    if (i % STRIDE) assert.equal(row[2], '', 'Unsampled RSSI must remain blank, not a fabricated observation');
    else assert.equal(Number(row[2]), item.bytes.readFloatLE(offset + 24));
    assert.equal(Number(row[3]), Number(Boolean(item.bytes[offset + 28] & 1)));
  }
  return meta;
}

function environment(extra) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extra };
}

async function webWorker(python, dataRoot, captureRoot, payload) {
  const serviceRoot = path.join(root, 'services/acquisition');
  const child = spawn(python, ['-m', 'blade_acquisition.web_rotation', dataRoot], {
    cwd: serviceRoot, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: environment({ PYTHONPATH: serviceRoot, BLADE_CAPTURE_DATA_DIR: captureRoot }),
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let output = '', errors = '';
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', value => {
        output += value.toString('utf8');
        if (Buffer.byteLength(output) > 8 * 1024 * 1024) child.kill();
      });
      child.stderr.on('data', value => { errors = (errors + value.toString('utf8')).slice(-8000); });
      child.once('close', code => resolve(code));
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify(payload));
    });
    let parsed;
    try { parsed = JSON.parse(output); } catch { throw Error(`Web worker returned invalid JSON (${result}): ${errors}`); }
    return { code: result, ...parsed };
  } finally { clearTimeout(timer); }
}

function assertAnalysis(result) {
  assert.equal(result.phaseAvailable, false, 'Independent passes cannot claim common phase');
  assert.equal(result.modalMatch, undefined, 'Amplitude grouping is not measured mode-shape reconstruction');
  assert.equal(result.coverage.validSamples, 3600);
  assert.equal(result.coverage.segmentCount, 9);
  assert.deepEqual(result.sources[0].candidateRange, { start: 200, end: 1600 });
  for (const source of result.sources) {
    assert.deepEqual(source.validRanges.map(range => [range.start, range.end]), [[200, 600], [700, 1000], [1100, 1600]]);
    assert.equal(source.provenance.rssiSampleStride, STRIDE);
    assert.equal(source.validSamples, 1200);
    assert.deepEqual(Object.fromEntries(source.exclusions.map(value => [value.reason, value.samples])),
      { outside_confirmed_pass: 600, overrange: 100, low_rssi: 100 });
    assert.equal(source.segments[1].timeDomain.seconds[0], .7, 'Original gaps must not be compressed away');
  }
  assert.deepEqual(result.amplitudeDistributions.map(item => [item.azimuthDeg, item.points.length]), [[0, 2], [90, 1]]);
  assert.ok(Math.abs(result.amplitudeDistributions[0].points[0].value - .31 / Math.sqrt(2)) < 1e-8);
  assert.ok(Math.abs(result.amplitudeDistributions[0].points[1].value - .5 / Math.sqrt(2)) < 1e-8);
  assert.ok(!JSON.stringify(result).includes('relativePhaseDeg'));
}

function cloudHarness(moduleFile, directory, recordingsDir) {
  const captures = new Map(), token = randomBytes(32).toString('hex');
  const identity = { serverUrl: 'https://blade-passes-release.invalid', user: { id: 'release-gate', tenant: 'release-gate' } };
  const queue = require(moduleFile).createFieldCloudSync({ file: path.join(directory, 'isolated-queue.json'),
    dataDir: recordingsDir, getLive: () => { throw Error('Completed fixtures must not request live device frames'); }, intervalMs: 60000,
    auth: { cloudBinding: () => identity, cloudSession: () => ({ ...identity, token }),
      clearCloudSession() { throw Error('Unexpected authentication failure'); } },
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, identity.serverUrl);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.ok(parsed.pathname.startsWith('/api/v1/captures'));
      const route = parsed.pathname.slice('/api/v1/captures'.length);
      const body = options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : null;
      const response = value => new Response(JSON.stringify(value));
      if (!route) {
        assert.equal(body.recording.status, 'complete');
        captures.set(body.recording.id, { recording: body.recording, bytes: {}, files: [], complete: false });
        return response({ capture: { id: body.recording.id } });
      }
      const [id, action, name] = route.slice(1).split('/'), capture = captures.get(id);
      assert.ok(capture);
      if (action === 'upload') {
        assert.deepEqual(body.recording, capture.recording);
        capture.files = body.files;
        return response({ capture: { id }, received: [], offsets: {} });
      }
      if (action === 'chunks') {
        const previous = capture.bytes[name] || Buffer.alloc(0);
        assert.equal(Number(parsed.searchParams.get('offset')), previous.length);
        capture.bytes[name] = Buffer.concat([previous, Buffer.from(options.body)]);
        return response({ ok: true, nextOffset: capture.bytes[name].length });
      }
      if (action === 'complete') {
        for (const file of capture.files) {
          assert.equal(capture.bytes[file.name].length, file.bytes);
          assert.equal(sha256(capture.bytes[file.name]), file.sha256);
          assert.deepEqual(capture.bytes[file.name], fs.readFileSync(path.join(recordingsDir, id, file.name)));
        }
        capture.complete = true;
        return response({ capture: { id, uploadState: 'complete' } });
      }
      throw Error(`Unapproved cloud fixture action: ${action}`);
    },
  });
  return { queue, captures, observe(recording) {
    return queue.observeRecording(recording, { owner: JSON.stringify([identity.serverUrl, identity.user.id, identity.user.tenant]), active: false });
  } };
}

async function validateWebPaths({ python, temporary, fixtures, exports, captures }) {
  const captureRoot = path.join(temporary, '上传数据'), offlineRoot = path.join(temporary, '离线工作区'), nativeRoot = path.join(temporary, '原始工作区');
  fs.mkdirSync(captureRoot); fs.mkdirSync(offlineRoot); fs.mkdirSync(nativeRoot);
  const offline = [], native = [];
  async function success(dataRoot, payload) {
    const response = await webWorker(python, dataRoot, captureRoot, payload);
    assert.equal(response.ok, true, response.error || 'Web worker rejected fixture');
    assert.equal(response.code, 0); return response.data;
  }
  for (const [index, item] of fixtures.entries()) {
    const { manifest } = item, capture = captures.get(manifest.id);
    assert.equal(capture.complete, true);
    assert.deepEqual(capture.recording, manifest, 'Packaged cloud sync must retain the entire saved manifest');
    const completed = path.join(captureRoot, manifest.id, 'complete');
    fs.mkdirSync(completed, { recursive: true });
    fs.writeFileSync(path.join(completed, 'manifest.json'), JSON.stringify(capture.recording));
    fs.writeFileSync(path.join(completed, 'transfer.json'), JSON.stringify({ files: capture.files }));
    for (const file of capture.files) fs.writeFileSync(path.join(completed, file.name), capture.bytes[file.name]);
    await success(nativeRoot, { action: 'capture-validate', captureDirectory: completed });
    native.push((await success(nativeRoot, { action: 'capture-import', captureDirectory: completed })).recording);
    const suffix = index % 2 ? '.csv' : '.csv.gz';
    const upload = path.join(offlineRoot, `.upload-${manifest.id}${suffix}`);
    fs.copyFileSync(exports[index][suffix === '.csv' ? 'csv' : 'gzip'], upload);
    const imported = await success(offlineRoot, { action: 'import', inputFile: upload, filename: `${manifest.id}${suffix}`, options: { source: 'measured' } });
    offline.push(imported.recordings[0]);
    for (const record of [native.at(-1), offline.at(-1)]) {
      assert.deepEqual(record.pointCycle, manifest.pointCycle);
      assert.equal(record.rssiSampleStride, STRIDE);
      assert.equal(record.source, 'simulation', 'Import must not relabel fixture provenance');
    }
    assert.equal(offline.at(-1).sourceRecordingId, manifest.id);
    assert.equal(offline.at(-1).sourceSampleOrigin, manifest.sampleOrigin);
  }
  for (const [dataRoot, records] of [[nativeRoot, native], [offlineRoot, offline]]) {
    const ids = records.map(record => record.id);
    assertAnalysis(await success(dataRoot, { action: 'blade-passes', parameters: { recordingIds: ids, rssiThresholdPercent: 50 } }));
    const rejected = await webWorker(python, dataRoot, captureRoot, { action: 'rotation', parameters: { recordingIds: [ids[0]], rpm: 1200 } });
    assert.equal(rejected.ok, false, 'Legacy continuous rotation analysis must refuse sparse station passes');
    assert.equal(rejected.code, 2);
    assert.match(rejected.error, /片段|间歇|站位/);
  }
  return { uploadedNativeValidated: true, offlineCsvAndGzipValidated: true,
    collectionAndSessionsPreserved: true, validSamplesPerRoute: 3600, segmentsPerRoute: 9,
    sameAzimuthRadialGrouping: true, rssiStridePreserved: true, phaseAvailable: false,
    legacyContinuousAnalysisRejected: true, workerExecution: 'server source Python; not desktop frozen binary' };
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'win32', 'This is a real Windows frozen gate; use the separate pure contract tests elsewhere');
  assert.equal(process.arch, 'x64');
  const options = optionsFrom(argv);
  const executable = path.join(options.resources, 'acquisition/BladeAcquisition.exe');
  const python = path.join(root, 'services/acquisition/.venv-build/Scripts/python.exe');
  assert.ok(fs.statSync(executable).isFile()); assert.ok(fs.statSync(python).isFile());
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-pass-release-'));
  const dataDir = path.join(temporary, '桌面数据 with spaces'), recordingsDir = path.join(dataDir, 'recordings');
  const fixtures = createFixtures(recordingsDir);
  const before = fixtures.map(item => ({ manifest: sha256(fs.readFileSync(path.join(recordingsDir, item.manifest.id, 'manifest.json'))), raw: sha256(item.bytes) }));
  fs.mkdirSync(options.output, { recursive: true });
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    frozenWindowsTested: true, hardwareTested: false, physicalAcquisitionStarted: false, sdkDisabled: true,
    serviceSha256: sha256(fs.readFileSync(executable)), deviceRequests: 0, passed: false };
  let service, ownedChild, cloud;
  try {
    const packaged = require('./windows-packaged-bridge.cjs').extractPackagedBridge({
      archive: path.join(options.resources, 'app.asar'), directory: path.join(temporary, 'packaged-bridge'),
      sourceDirectory: path.join(root, 'apps/desktop/electron') });
    report.packagedModuleSha256 = packaged.hashes;
    const disabledDll = path.join(temporary, 'HARDWARE_DISABLED_DO_NOT_CREATE.dll');
    service = require(packaged.bridgeFile).createFieldService({ getConfig: () => ({ dll: disabledDll }),
      dataDir, resourcesDir: options.resources, servicesRoot: path.join(root, 'services/acquisition'), WebSocketImpl: null,
      spawnImpl: (file, args, configuration) => {
        assert.equal(path.resolve(file), executable, 'Only the shipped frozen service may execute');
        assert.equal(configuration.env.BLADE_POLYTEC_DLL, disabledDll);
        assert.equal(configuration.env.BLADE_DATA_DIR, dataDir);
        ownedChild = spawn(file, args, configuration); return ownedChild;
      },
      fetchImpl: (url, request) => { guardServiceRequest(url, request); return fetch(url, request); },
    });
    const status = await service.start();
    assert.equal(status.service.state, 'ready', status.service.error || 'Frozen service must become ready');
    assert.equal(status.receiver.running, false); assert.equal(status.receiver.dllAvailable, false);
    assert.equal(status.recording, null); assert.equal(status.turntableBusy, false);
    const persisted = (await service.recordings()).recordings;
    assert.equal(persisted.length, fixtures.length);
    cloud = cloudHarness(packaged.cloudFile, temporary, recordingsDir);
    cloud.queue.resume();
    const exports = [];
    for (const item of fixtures) {
      const detail = await service.recordings(item.manifest.id);
      assert.deepEqual(detail.recording, item.manifest, 'Frozen service must preserve saved point metadata');
      assert.equal(detail.waveform.rssiSampleStride, STRIDE);
      assert.equal(detail.waveform.rssi[1], null);
      const csv = path.join(temporary, `${item.manifest.id}.csv`), gzip = `${csv}.gz`;
      assert.equal((await service.exportRecording(item.manifest.id, csv)).saved, true);
      assert.equal((await service.exportRecording(item.manifest.id, gzip)).saved, true);
      const bytes = fs.readFileSync(csv);
      assert.deepEqual(gunzipSync(fs.readFileSync(gzip)), bytes);
      validateExport(bytes, item); exports.push({ csv, gzip });
      assert.equal(cloud.observe(detail.recording), true);
      await cloud.queue.settled();
      assert.equal(cloud.queue.status().items.find(record => record.recordingId === item.manifest.id).state, 'synced');
    }
    report.webCompatibility = await validateWebPaths({ python, temporary, fixtures, exports, captures: cloud.captures });
    const finalStatus = await service.status();
    assert.equal(finalStatus.state, 'idle');
    assert.equal(finalStatus.receiver.running, false);
    assert.equal(finalStatus.receiver.dllAvailable, false);
    assert.equal(finalStatus.recording, null);
    assert.equal(finalStatus.deviceBusy, false);
    assert.equal(finalStatus.turntableBusy, false);
    for (const [index, item] of fixtures.entries()) {
      assert.equal(sha256(fs.readFileSync(path.join(recordingsDir, item.manifest.id, 'manifest.json'))), before[index].manifest);
      assert.equal(sha256(fs.readFileSync(path.join(recordingsDir, item.manifest.id, 'chunk-00000000.bin'))), before[index].raw);
    }
    report.originalRecordsUnchanged = true;
    report.independentSessions = new Set(fixtures.map(item => item.manifest.pointCycle.sessionId)).size;
    report.completedFixtureRecords = fixtures.length;
    report.passed = true;
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    cloud?.queue.dispose();
    if (cloud) await cloud.queue.settled();
    try {
      // Force bypasses the normal stop route, which is intentionally forbidden.
      if (service) await service.shutdown({ force: true });
      assert.ok(!ownedChild || ownedChild.exitCode !== null || ownedChild.signalCode, 'Owned service must exit');
      report.childExited = !!ownedChild && (ownedChild.exitCode !== null || !!ownedChild.signalCode);
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`${report.passed ? 'PASS' : 'FAIL'} frozen point-record export/upload and server pass analysis; hardware not tested`);
  console.log(`Report: ${path.join(options.output, 'report.json')}`);
  return report;
}

module.exports = { optionsFrom, guardServiceRequest, fixture, createFixtures, validateExport, assertAnalysis, validateWebPaths, cloudHarness };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
