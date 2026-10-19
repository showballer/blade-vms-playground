// Hardware-free gate for the NEW frozen planner, not a physical tracking test.
// Windows x64: node scripts/test-windows-motion-trial.cjs --resources <resources>
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const previewRequest = () => ({ action: 'preview', config: {
  distanceM: 2.86, hubHeightDeltaM: 1.46, radiusM: .31, periodSeconds: 30,
  rotationDirection: 'clockwise', axis1Sign: 1, axis2Sign: 1,
} });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function optionsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(['--resources', '--output'].includes(argv[index]), 'Unknown test option');
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), 'Missing test option value');
    options[argv[index].slice(2)] = path.resolve(argv[index + 1]);
  }
  assert.ok(options.resources, '--resources is required');
  options.output ||= path.join(root, 'artifacts', 'windows-motion-trial-smoke');
  return options;
}

function assertIdle(value) {
  assert.equal(value.state, 'idle');
  assert.equal(value.receiver.running, false);
  assert.equal(value.receiver.dllAvailable, false, 'This gate must disable the SDK');
  assert.equal(value.deviceBusy, false);
  assert.equal(value.turntableBusy, false);
  assert.equal(value.recording, null, 'Preview/rejected arm must not create a recording');
  assert.equal(value.turntableWarning, null);
}

function validatePreview(value) {
  assertIdle(value);
  const preview = value.motionTrialPreview;
  assert.ok(preview, 'Frozen service lacks the new motion-trial preview');
  assert.equal(preview.durationSeconds, 30);
  assert.equal(preview.rotorRpm, 2);
  assert.equal(preview.anchorBound, false);
  assert.equal(preview.executionReady, false, 'A software-only preview cannot authorize movement');
  assert.equal(preview.requiresRunIn, true);
  assert.equal(preview.requiresRunOut, true);
  assert.equal(preview.capability.supported, false);
  assert.equal(preview.capability.checkedHardware, false);
  assert.equal(preview.capability.source, 'client_protocol');
  assert.equal(preview.capability.code, 'trajectory_protocol_unavailable');
  assert.ok(Array.isArray(preview.blockReasons) && preview.blockReasons.length > 0);
  for (const endpoint of [preview.startAngles, preview.endAngles]) {
    assert.equal(endpoint.axis1AngleDeg, null);
    assert.equal(endpoint.axis2AngleDeg, null);
  }
  const points = preview.trajectory;
  assert.equal(points.length, 721, 'Expected 720 intervals and the closing endpoint');
  const near = (value, expected, label) => {
    assert.ok(Number.isFinite(value) && Math.abs(value - expected) < 1e-8, label);
  };
  for (const [index, point] of points.entries()) {
    near(point.timeSeconds, 30 * index / 720, 'Trajectory time grid differs');
    near(point.rotorPhaseDeg, 180 + index / 2, 'Trajectory phase grid differs');
    near(point.phaseFromSixDeg, index / 2, 'Phase from six-o-clock differs');
    assert.equal(point.axis1AngleDeg, null, 'Unanchored trajectory must not contain encoder targets');
    assert.equal(point.axis2AngleDeg, null, 'Unanchored trajectory must not contain encoder targets');
    for (const key of ['axis1DeltaAngleDeg', 'axis2DeltaAngleDeg', 'axis1VelocityDegS',
      'axis2VelocityDegS', 'axis1AccelerationDegS2', 'axis2AccelerationDegS2', 'pointXM', 'pointHeightM']) {
      assert.ok(Number.isFinite(point[key]), `Invalid trajectory field ${key}`);
    }
  }
  for (const key of ['axis1DeltaAngleDeg', 'axis2DeltaAngleDeg', 'pointXM', 'pointHeightM']) {
    near(points[0][key], points.at(-1)[key], `Circle did not close: ${key}`);
  }
  assert.ok(points.some(point => Math.abs(point.axis1DeltaAngleDeg) > 1));
  assert.ok(points.some(point => Math.abs(point.axis2DeltaAngleDeg) > 1));
  return { durationSeconds: 30, rotorRpm: 2, trajectoryPoints: points.length,
    circleClosed: true, absoluteTargetsAbsent: true, executionReady: false,
    capabilitySource: preview.capability.source, hardwareCapabilityChecked: false };
}

function guardedRequestBody(route, body) {
  assert.ok(['status', 'recordings', 'motion-trial'].includes(route), 'Device routes are forbidden');
  if (route === 'motion-trial') {
    const expected = previewRequest();
    if (body?.action === 'arm') {
      expected.action = 'arm'; expected.confirmMotion = true;
    }
    assert.deepEqual(body, expected, 'Only the fixed preview and deliberately rejected arm may be sent');
  } else assert.equal(body, undefined, 'Read-only routes cannot receive a body');
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, token, route, body, authenticated = true) {
  guardedRequestBody(route, body);
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  // Native http.request uses the explicit loopback peer: no environment proxy
  // and no redirect following. Tokens are never arguments or report fields.
  return new Promise((resolve, reject) => {
    const headers = { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) };
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/field/${route}`,
      method: bytes ? 'POST' : 'GET', headers, agent: false }, response => {
      const chunks = []; let length = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 2_000_000) response.destroy(Error('Response exceeded test limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { reject(Error('Service returned invalid JSON')); }
      });
    });
    req.setTimeout(3000, () => req.destroy(Error('Isolated service request timed out')));
    req.on('error', reject);
    req.end(bytes);
  });
}

function isolatedEnvironment(extra) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  return { ...env, ...extra };
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'win32', 'Frozen Windows gate must run on Windows; source checks are separate');
  assert.equal(process.arch, 'x64', 'Use Windows x64 Node');
  const options = optionsFrom(argv);
  const serviceDirectory = path.join(options.resources, 'acquisition');
  const executable = path.join(serviceDirectory, 'BladeAcquisition.exe');
  assert.ok(fs.statSync(executable).isFile());
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-motion-trial-release-'));
  const dataDirectory = path.join(temporary, '轨迹预览数据 with spaces');
  fs.mkdirSync(dataDirectory);
  fs.mkdirSync(options.output, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const redact = value => String(value).split(token).join('[REDACTED]');
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    frozenWindowsTested: true, hardwareTested: false, physicalAcquisitionStarted: false,
    motionExecuted: false, sdkDisabled: true, passed: false,
    serviceSha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex') };
  let child, childClosed, closed = false, childError, tail = '', port;
  try {
    port = await freePort();
    child = spawn(executable, [], { cwd: serviceDirectory, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: isolatedEnvironment({
        BLADE_SERVICE_PORT: String(port), BLADE_SERVICE_TOKEN: token, BLADE_DATA_DIR: dataDirectory,
        BLADE_POLYTEC_DLL: path.join(temporary, 'HARDWARE_DISABLED_DO_NOT_CREATE.dll'),
      }) });
    childClosed = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
    child.once('error', error => { childError = error; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', bytes => { tail = (tail + bytes.toString('utf8')).slice(-12000); });
    }
    const deadline = Date.now() + 30000;
    let ready;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (closed) throw Error('Isolated frozen service exited before readiness');
      try {
        const response = await request(port, token, 'status');
        if (response.status === 200) { ready = response.body; break; }
        throw Error(`Unexpected readiness HTTP ${response.status}`);
      } catch (error) {
        if (error.code !== 'ECONNREFUSED') throw error;
      }
      await pause(100);
    }
    assert.ok(ready, 'Frozen service readiness timed out');
    assertIdle(ready);
    assert.equal((await request(port, token, 'motion-trial', previewRequest(), false)).status, 401);
    report.authenticationEnforced = true;
    let response = await request(port, token, 'motion-trial', previewRequest());
    assert.equal(response.status, 200, 'New frozen motion-trial endpoint must be available');
    report.preview = validatePreview(response.body);
    response = await request(port, token, 'motion-trial', { ...previewRequest(), action: 'arm', confirmMotion: true });
    assert.equal(response.status, 422, 'Unavailable firmware must not permit arm');
    report.armRejected = true;
    response = await request(port, token, 'status');
    assert.equal(response.status, 200); assertIdle(response.body);
    response = await request(port, token, 'recordings');
    assert.equal(response.status, 200); assert.deepEqual(response.body.recordings, []);
    const recordingDirectory = path.join(dataDirectory, 'recordings');
    const records = fs.existsSync(recordingDirectory) ? fs.readdirSync(recordingDirectory) : [];
    assert.ok(!records.some(name => /^[0-9a-f]{32}$/.test(name)), 'No recording directory may be created');
    assert.equal(fs.existsSync(path.join(dataDirectory, 'turntable-state.json')), false, 'Preview must not write a motion guard');
    report.noRecordingsCreated = true;
    report.passed = true;
  } catch (error) {
    report.error = redact(error.message); report.serviceLog = redact(tail);
    process.exitCode = 1;
  } finally {
    try {
      if (child && !closed) {
        child.kill();
        await Promise.race([childClosed, pause(5000)]);
        if (!closed) { child.kill('SIGKILL'); await Promise.race([childClosed, pause(5000)]); }
      }
      assert.ok(!child || closed, 'Owned frozen service did not exit');
      report.childExited = !!child && closed;
      if (child && closed && port) {
        await assert.rejects(request(port, token, 'status'), 'Isolated service must not remain reachable');
      }
    } catch (error) {
      report.cleanupError = redact(error.message); report.passed = false; process.exitCode = 1;
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (!child || closed) fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`${report.passed ? 'PASS' : 'FAIL'} frozen motion-trial planner and unavailable-firmware guard`);
  console.log(`Report: ${path.join(options.output, 'report.json')}`);
  return report;
}

module.exports = { previewRequest, optionsFrom, assertIdle, validatePreview, guardedRequestBody };
if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
