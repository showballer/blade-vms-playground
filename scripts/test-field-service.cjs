"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { EventEmitter } = require("node:events");
const { createFieldService, windowsServiceEnvironment } = require("../apps/desktop/electron/field-service.cjs");

const idle = () => ({ state: "idle", error: null, receiver: { connected: false }, recording: null,
  pointCycleExecutionModes: ['continuous', 'manual_segments'] });
const acquiring = () => ({ state: "acquiring", error: null, receiver: { connected: true }, recording: { id: "recording-1", state: "acquiring" } });
const waveform = values => ({ sampleRate: 1000, unit: "m/s", values, rssi: [], overrange: [] });

function segmentedCycle(port, count = 1, stepDeg = 90) {
  const referenceSignature = '[[0,3,10000,17],[0,3,10000,17]]';
  const segmentStations = Array.from({length: 360 / stepDeg}, (_, i) => i * stepDeg).map((azimuthDeg, i) => ({ pointId: `p1-s${i}`, name: `P1 ${azimuthDeg}`,
    port, referenceSignature, axis1AngleDeg: 10 + i, axis2AngleDeg: i,
    bladeId: '2', radialPointId: 'p1', radialPointName: 'P1', radiusM: .31, azimuthDeg }));
  return { mode: 'automatic_stations', executionMode: 'manual_segments', port, cycles: 1, dwellSeconds: 60, speedRpm: 5,
    nominalPeriodSeconds: 5, maxMoveRpm: 5, rssiTriggerEnabled: true, rssiEnterConfirmMs: 20, rssiConfirmMs: 30,
    geometry: { distanceM: 2.5, hubHeightDeltaM: .73, rotationDirection: 'clockwise', axis1Sign: 1, axis2Sign: 1,
      anchorRadiusM: .31, anchorAxis1AngleDeg: 10, anchorAxis2AngleDeg: 0 },
    segmentStepDeg: stepDeg, totalStationCount: segmentStations.length, segmentStations, points: segmentStations.slice(0, count),
    nextWaitPoint: segmentStations[count % segmentStations.length], motionLaserPolicy: 'continuous', startAtCurrentPose: false };
}

test('segmented two-point capture requires 90 degrees; single-point intervals remain configurable', async t => {
  const f = fixture(t);
  for (const port of ['COM7', '/dev/cu.usbserial-110', 'tcp://192.168.10.50:5000']) {
    for (const stepDeg of [180, 120, 60, 45, 30, 22.5]) {
      const start = count => ({ source: 'device', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', name: 'Segment',
        object: '', turbine: 'T1', point: 'P1', confirmLaser: true, confirmMotion: true, pointCycle: segmentedCycle(port, count, stepDeg) });
      const before = f.requests.length;
      await assert.rejects(f.service.begin(start(2)), /两点采集的圆周移动间隔固定为90/);
      assert.equal(f.requests.length, before, 'Invalid pair must fail before network or device I/O');
      await f.service.begin(start(1));
      const body = JSON.parse(f.requests.filter(row => row.route === 'start').at(-1).options.body);
      assert.equal(body.pointCycle.segmentStepDeg, stepDeg);
      assert.equal(body.pointCycle.points.length, 1);
    }
  }
});

test('segmented Start preserves one/two-point boundaries and waiting coordinates on Mac, Windows and TCP', async t => {
  const f = fixture(t);
  for (const port of ['/dev/cu.usbserial-110', 'COM7', 'tcp://192.168.10.50:5000']) for (const count of [1, 2]) {
    const pointCycle = segmentedCycle(port, count);
    await f.service.begin({ source: 'device', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', name: 'Segment',
      object: '', turbine: 'T1', point: 'P1', confirmLaser: true, confirmMotion: true, pointCycle });
    const body = JSON.parse(f.requests.filter(row => row.route === 'start').at(-1).options.body);
    assert.deepEqual(body.pointCycle, pointCycle);
    assert.equal(body.pointCycle.points.length, count);
    assert.equal(body.pointCycle.nextWaitPoint.azimuthDeg, count * 90);
    assert.equal(body.pointCycle.returnToOrigin, undefined);
  }
});

test('segmented malformed sequence and incompatible auto-stop policy are rejected before I/O', async t => {
  const f = fixture(t), cycle = segmentedCycle('COM7');
  for (const change of [{ executionMode: 'unknown' }, { executionMode: 'continuous' }, { cycles: 2 },
    { points: cycle.segmentStations.slice(0, 3) }, { startAtCurrentPose: true }, { motionLaserPolicy: 'off_during_motion' },
    { nextWaitPoint: undefined }, { nextWaitPoint: cycle.segmentStations[3] }, { totalStationCount: 2 },
    { segmentStepDeg: 0 }, { segmentStations: cycle.segmentStations.slice().reverse() },
    { returnToOrigin: cycle.segmentStations[0] }, { points: [cycle.segmentStations[1], cycle.segmentStations[3]] }]) {
    const requests = f.requests.length;
    await assert.rejects(f.service.begin({ source: 'device', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', name: 'Segment',
      object: '', turbine: '', point: '', confirmLaser: true, confirmMotion: true, pointCycle: { ...cycle, ...change } }), { status: 400 });
    assert.equal(f.requests.length, requests);
  }
});

test('direct segment preposition never uploads a bank or starts acquisition', async t => {
  const f = fixture(t);
  for (const port of ['COM7', '/dev/cu.usbserial-110', 'tcp://192.168.10.50:5000']) {
    const point = segmentedCycle(port).points[0];
    const request = { action: 'recall', port, recordedPort: port, axis: 1, confirmMotion: true, speedRpm: 5,
      axis1AngleDeg: point.axis1AngleDeg, axis2AngleDeg: point.axis2AngleDeg,
      referenceSignature: point.referenceSignature, directPositionOnly: true };
    await f.service.turntable(request);
    const body = JSON.parse(f.requests.filter(row => row.route === 'turntable').at(-1).options.body);
    assert.equal(body.directPositionOnly, true);
    assert.equal(body.preloadPoints, undefined);
    assert.ok(!f.requests.some(row => row.route === 'start' || row.route === 'device'));
    for (const change of [{ action: 'probe' }, { directPositionOnly: 'true' }, { preloadPoints: [[10, 0]] }])
      await assert.rejects(f.service.turntable({ ...request, ...change }), { status: 400 });
  }
});

test('old packaged services cannot silently turn a manual segment into automatic following', async t => {
  const f = fixture(t, { fetch: async () => response({ ...idle(), pointCycleExecutionModes: undefined }) });
  const pointCycle = segmentedCycle('COM7');
  await assert.rejects(f.service.begin({ source: 'device', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', name: 'Segment',
    object: '', turbine: '', point: '', confirmLaser: true, confirmMotion: true, pointCycle }), /不支持分段采集/);
  await assert.rejects(f.service.turntable({ action: 'recall', port: 'COM7', recordedPort: 'COM7', axis: 1,
    confirmMotion: true, speedRpm: 5, axis1AngleDeg: 10, axis2AngleDeg: 0,
    referenceSignature: pointCycle.points[0].referenceSignature, directPositionOnly: true }), /不支持分段直接定位/);
  assert.ok(!f.requests.some(row => row.route === 'start' || row.route === 'turntable'));
});

test('indexed capture preposition forwards the full route without starting acquisition on Mac and Windows', async t => {
  const f = fixture(t);
  for (const port of ['COM7', '/dev/cu.usbserial-110', 'tcp://192.168.10.50:5000']) {
    const request = { action: 'recall', port, recordedPort: port, axis: 1, confirmMotion: true,
      axis1AngleDeg: 10, axis2AngleDeg: 0, speedRpm: 5,
      referenceSignature: '[[0,3,10000,17],[0,3,10000,17]]',
      preloadPoints: [[10, 0], [12, 3]], preloadReturnPoint: [0, 0] };
    await f.service.turntable(request);
    const body = JSON.parse(f.requests.filter(r => r.route === 'turntable').at(-1).options.body);
    assert.deepEqual(body.preloadPoints, request.preloadPoints);
    assert.deepEqual(body.preloadReturnPoint, [0, 0]);
    assert.equal(body.speedRpm, 5);
    assert.ok(!f.requests.some(r => r.route === 'start' || r.route === 'device'));
    for (const bad of [{ preloadPoints: [[11, 0]] }, { preloadPoints: [[10, 0], [36, 0]] },
      { action: 'probe' }, { preloadReturnPoint: [false, 0] }, { preloadPoints: [] }]) {
      const count = f.requests.length;
      await assert.rejects(f.service.turntable({ ...request, ...bad }), { status: 400 });
      assert.equal(f.requests.length, count);
    }
  }
});

test('app5 homing and level return use the same axis1 API for Mac and Windows', async t => {
  const f = fixture(t);
  for (const port of ['COM7', '/dev/cu.usbserial-110', 'tcp://192.168.10.50:5000']) for (const action of ['mechanical_home', 'horizontal_zero']) {
    await f.service.turntable({ action, port, axis: 1, homingSpeedDegS: .6, confirmMotion: true });
    const body = JSON.parse(f.requests.filter(row => row.route === 'turntable').at(-1).options.body);
    assert.equal(body.action, action); assert.equal(body.axis, 1); assert.equal(body.port, port);
    assert.equal(body.homingSpeedDegS, .6); assert.equal(body.confirmMotion, true);
    assert.equal(body.speedRpm, undefined, 'capture RPM is independent of the homing setting');
  }
});

test('homing rejects wrong axes, missing explicit action and invalid speed before any I/O', async t => {
  const f = fixture(t), base = { action: 'mechanical_home', port: 'COM7', axis: 1, confirmMotion: true };
  for (const action of ['mechanical_home', 'horizontal_zero']) for (const change of [{ axis: 2 }, { confirmMotion: false },
    { confirmRecovery: true }, ...[true, null, '0.6', .19, 1.51, NaN, Infinity].map(homingSpeedDegS => ({ homingSpeedDegS }))])
    await assert.rejects(f.service.turntable({ ...base, action, ...change }), { status: 400 });
  assert.equal(f.requests.length, 0);
});

test('drive profile bridge preserves explicit per-axis values on Mac and Windows', async t => {
  const f = fixture(t);
  const values = { accel_ms: 100, decel_ms: 100, s_curve_ms: 0 };
  for (const port of ['COM7', '/dev/cu.usbserial-110']) {
    await f.service.turntable({ action: 'read_motion_profile', port, axis: 2 });
    let body = JSON.parse(f.requests.filter(row => row.route === 'turntable').at(-1).options.body);
    assert.equal(body.action, 'read_motion_profile'); assert.equal(body.axis, 2);
    assert.equal(body.motionProfile, undefined);
    await f.service.turntable({ action: 'set_motion_profile', port, axis: 2, motionProfile: values, expectedMotionProfile: values });
    body = JSON.parse(f.requests.filter(row => row.route === 'turntable').at(-1).options.body);
    assert.deepEqual(body.motionProfile, values); assert.deepEqual(body.expectedMotionProfile, values);
    assert.equal(body.port, port); assert.equal(body.axis, 2); assert.equal(body.confirmMotion, false);
  }
});

test('drive profile rejects missing reads and invalid values before starting service', async t => {
  const f = fixture(t), values = { accel_ms: 100, decel_ms: 100, s_curve_ms: 0 };
  const request = { action: 'set_motion_profile', port: 'COM7', axis: 1, motionProfile: values, expectedMotionProfile: values };
  for (const changes of [{ expectedMotionProfile: undefined }, { confirmMotion: true }, { confirmRecovery: true },
    { action: 'read_motion_profile' }, { axis: 3 }, ...[
      ['accel_ms', 0], ['accel_ms', 10001], ['decel_ms', '100'], ['decel_ms', true], ['s_curve_ms', 1001],
      ['s_curve_ms', -1], ['accel_ms', 1.5], ['accel_ms', NaN],
    ].map(([key, value]) => ({ motionProfile: { ...values, [key]: value } }))]) {
    await assert.rejects(f.service.turntable({ ...request, ...changes }), { status: 400 });
  }
  assert.equal(f.requests.length, 0);
});

const singlePointConfig = { materialMark: 'A/P1 marked region', distanceM: 2, hubHeightDeltaM: 0.2, radiusM: 0.4 };
const motionTrialConfig = { distanceM: 2.86, hubHeightDeltaM: 1.46, radiusM: 0.31,
  periodSeconds: 5, rotationDirection: 'clockwise', axis1Sign: 1, axis2Sign: 1 };

test('motion trial cannot turn a preview into hardware access or accept invented feedback', async t => {
  const f = fixture(t);
  for (const request of [
    { action: 'arm', config: motionTrialConfig, confirmMotion: true },
    { action: 'prepare', config: motionTrialConfig, port: 'COM3' },
    { action: 'preview', config: motionTrialConfig, anchor: { axis1AngleDeg: 10, axis2AngleDeg: 0 } },
    { action: 'preview', config: { ...motionTrialConfig, supported: true } },
    { action: 'preview', config: { ...motionTrialConfig, periodSeconds: 0 } },
    { action: 'preview', config: { ...motionTrialConfig, axis1Sign: true } },
  ]) await assert.rejects(f.service.motionTrial(request), { status: 400 });
  assert.equal(f.requests.length, 0);
  await f.service.motionTrial({ action: 'preview', config: motionTrialConfig });
  assert.equal(f.requests.at(-1).route, 'motion-trial');
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body), { action: 'preview', config: motionTrialConfig });
  assert.ok(f.requests.every(item => !['turntable', 'start', 'device', 'single-point'].includes(item.route)));
});
const singlePointPrepare = () => ({ action: 'prepare', sessionId: 'session-0001', commandId: 'prepare-0001', config: singlePointConfig,
  capture: { name: 'single-point-test', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', port: 'COM6' },
  confirmLaser: true, confirmStaticPoint: true, confirmGeometry: true });

test('single-point bridge rejects fabricated authority and invalid motion before transport', async t => {
  const f = fixture(t);
  const request = singlePointPrepare();
  for (const change of [{ confirmLaser: false }, { confirmStaticPoint: false }, { confirmGeometry: false },
    { commandId: '' }, { config: { ...singlePointConfig, axis1Sign: true } },
    { config: { ...singlePointConfig, radiusM: Infinity } }, { config: { ...singlePointConfig, arcDegrees: 31 } },
    { anchor: { axis1AngleDeg: 0, axis2AngleDeg: 0 } }, { timestamp: 1 }, { source: 'simulation' }])
    await assert.rejects(f.service.singlePoint({ ...request, ...change }), { status: 400 });
  await assert.rejects(f.service.singlePoint({ action: 'arm', sessionId: 'session-0001', commandId: 'arm-0001' }), { status: 400 });
  assert.equal(f.requests.length, 0);
});

test('single-point real preparation strips renderer upload IDs and forwards a trusted run ID', async t => {
  const f = fixture(t);
  const request = singlePointPrepare(); request.capture.captureSessionId = 'f'.repeat(32);
  await f.service.singlePoint(request);
  assert.equal(JSON.parse(f.requests.at(-1).options.body).capture.captureSessionId, undefined);
  await f.service.singlePoint(request, { captureSessionId: 'a'.repeat(32) });
  const body = JSON.parse(f.requests.at(-1).options.body);
  assert.equal(f.requests.at(-1).route, 'single-point');
  assert.equal(body.capture.captureSessionId, 'a'.repeat(32));
  assert.equal(body.capture.port, 'COM6');
  await f.service.singlePoint({ action: 'mark', sessionId: request.sessionId, commandId: 'mark-0001' });
  assert.equal(JSON.parse(f.requests.at(-1).options.body).action, 'mark');
});

test('single-point cancellation is not queued behind pending prepare and stale responses refresh status', async t => {
  const pending = deferred(); let latest = idle();
  const f = fixture(t, { fetch: ({ route, options }) => {
    if (route !== 'single-point') return response(latest);
    const body = JSON.parse(options.body);
    if (body.action === 'prepare') return pending.promise;
    latest = { ...idle(), singlePoint: { sessionId: body.sessionId, state: 'cancelled' } };
    return response(latest);
  } });
  await f.service.start();
  const preparing = f.service.singlePoint(singlePointPrepare());
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await f.service.singlePoint({ action: 'cancel', sessionId: 'session-0001', commandId: 'cancel-0001' });
  assert.equal(cancelled.singlePoint.state, 'cancelled');
  pending.resolve(response({ ...acquiring(), singlePoint: { state: 'preparing' } }));
  assert.equal((await preparing).singlePoint.state, 'cancelled');
});

test("waveform bridge permits only bounded sample ranges and no arbitrary paths", async t => {
  const f = fixture(t, { fetch: ({ route }) => response(route.includes('/waveform') ? { waveform: waveform([1]) } : idle()) });
  for (const id of ['../secret', 'http://remote', 'x'.repeat(32), 'record?file=1']) await assert.rejects(f.service.waveform(id), { status: 400 });
  for (const [start, end] of [[-1, 10], [1.2, 10], [10, 2], [Infinity, 100], [0, Number.MAX_SAFE_INTEGER + 1]]) await assert.rejects(f.service.waveform('a'.repeat(32), start, end), { status: 400 });
  await f.service.waveform('a'.repeat(32), 10, 20);
  const url = new URL(f.requests.at(-1).url);
  assert.equal(url.searchParams.get('start'), '10');
  assert.equal(url.searchParams.get('end'), '20');
});

test("device bridge requires explicit consent and refuses modifying an active capture", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.device({ deviceIp: '192.168.104.50', action: 'set', key: 'laser', value: 1, confirmChange: true }), { status: 400 });
  await assert.rejects(f.service.device({ deviceIp: '192.168.104.50', action: 'autofocus' }), { status: 400 });
  await assert.rejects(f.service.frame(50000), { status: 400 });
  const active = fixture(t, { fetch: () => response(acquiring()) });
  await assert.rejects(active.service.device({ deviceIp: '192.168.104.50', action: 'read' }), { status: 409 });
  assert.ok(active.requests.every(request => request.route !== 'device'));
});

test('validated window frame recovers a status transport failure without erasing a capture error', async t => {
  let statusFailed = false, malformed = false;
  const f = fixture(t, { fetch: ({ route }) => {
    if (route === 'status' && statusFailed) return response({ detail: 'temporary status transport failure' }, 503);
    if (route === 'frame') return response({ ...idle(), state: 'error', error: 'previous motion failed',
      waveform: malformed ? { values: 'invalid' } : waveform([]) });
    return response(idle());
  } });
  await f.service.start();
  statusFailed = true;
  const failed = await f.service.status();
  assert.equal(failed.service.state, 'ready');
  assert.equal(failed.service.error, 'temporary status transport failure');
  malformed = true;
  await assert.rejects(f.service.frame(1000));
  assert.equal(f.service.serviceInfo().error, 'temporary status transport failure');
  malformed = false;
  const recovered = await f.service.frame(1000);
  assert.equal(recovered.service.state, 'ready');
  assert.equal(recovered.service.error, null);
  assert.equal(recovered.state, 'error');
  assert.equal(recovered.error, 'previous motion failed');
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
test("manual laser commands and RSSI calibration reach the desktop service", async t => {
  const f = fixture(t);
  for (const action of ['laser_on', 'laser_off']) {
    await f.service.device({ deviceIp: '192.168.104.50', action, confirmLaser: true });
    assert.equal(f.requests.at(-1).route, 'device');
    assert.equal(JSON.parse(f.requests.at(-1).options.body).action, action);
  }
  const request = { deviceIp: '192.168.104.50', hostIp: '192.168.104.10', state: 'background', durationSeconds: 2, confirmLaser: true };
  await f.service.rssiCalibration(request);
  assert.equal(f.requests.at(-1).route, 'rssi-calibration');
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body), request);
  await assert.rejects(f.service.rssiCalibration({ ...request, confirmLaser: false }), { status: 400 });
});

test('laser monitor reads bypass active-capture prechecks and forward only a read request', async t => {
  const status = { deviceIp: '192.168.104.50', state: 'on', readAt: Date.now() / 1000,
    source: 'device-readback', busy: true };
  const f = fixture(t, { fetch: ({ route }) => response(route === 'device' ? status : acquiring()) });
  await f.service.start();
  f.requests.length = 0;
  const result = await f.service.device({ deviceIp: status.deviceIp, action: 'laser_read',
    key: 'laser', value: 1, confirmLaser: true, arbitrary: 'never-forward' });
  assert.deepEqual(result, status);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].route, 'device');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { deviceIp: status.deviceIp, action: 'laser_read' });
  for (const action of ['laser_on', 'laser_off'])
    await assert.rejects(f.service.device({ deviceIp: status.deviceIp, action, confirmLaser: true }), { status: 409 });
  assert.equal(f.requests.filter(request => request.route === 'device').length, 1);
});
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) });

test('recording list pages are aggregated while detail reads stay complete', async t => {
  const full = { id: 'a'.repeat(32), pointCycle: { arrivalMove: { referenceChecks: [1, 2, 3] } } };
  const f = fixture(t, { fetch: ({ route, url }) => {
    if (route === `recordings/${full.id}`) return response({ recording: full });
    if (route !== 'recordings') return response(idle());
    const query = new URL(url).searchParams;
    assert.equal(query.get('summary'), 'true');
    return response(query.get('offset') === '0'
      ? { recordings: [{ id: full.id, name: 'first' }], nextOffset: 1, total: 2 }
      : { recordings: [{ id: 'b'.repeat(32), name: 'second' }], nextOffset: null, total: 2 });
  } });
  assert.deepEqual((await f.service.recordings()).recordings.map(item => item.name), ['first', 'second']);
  assert.deepEqual((await f.service.recordings(full.id)).recording, full);
});

test('recording pagination rejects repeated cursors instead of looping or returning a partial list', async t => {
  const f = fixture(t, { fetch: ({ route }) => response(route === 'recordings'
    ? { recordings: [{ id: 'a'.repeat(32) }], nextOffset: 0 } : idle()) });
  await assert.rejects(f.service.recordings(), /分页无效/);
  assert.equal(f.requests.filter(item => item.route === 'recordings').length, 1);
});

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blade-field-service-test-"));
  const executable = path.join(directory, "BladeAcquisition.exe");
  fs.writeFileSync(executable, "test fixture; never executed");
  const children = [], requests = [], sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; sockets.push(this); }
    addEventListener(name, handler) { this.on(name, handler); }
    close() { this.emit("close"); }
  }
  const service = createFieldService({
    getConfig: () => ({ executable }), dataDir: path.join(directory, "data"), resourcesDir: directory,
    servicesRoot: path.join(directory, "services-acquisition"),
    platform: "win32", startupTimeoutMs: 300, requestTimeoutMs: 300, terminationTimeoutMs: 20,
    WebSocketImpl: FakeSocket,
    spawnImpl(file, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.file = file; child.args = args; child.options = options; child.signals = []; child.exited = false;
      child.exitCode = null; child.signalCode = null;
      child.finish = (code = 0, signal = null) => {
        if (!child.exited) {
          child.exited = true; child.exitCode = code; child.signalCode = signal;
          child.emit("exit", code, signal); child.emit("close", code, signal);
        }
      };
      child.kill = (signal = "SIGTERM") => {
        child.signals.push(signal);
        if (overrides.kill) return overrides.kill(child, signal, children.length - 1);
        queueMicrotask(() => child.finish()); return true;
      };
      children.push(child);
      overrides.spawn?.(child, children.length - 1);
      return child;
    },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname.replace("/api/field/", "");
      const request = { url, route, options }; requests.push(request);
      if (overrides.fetch) return overrides.fetch(request, { children, requests, sockets });
      return response(route === "frame" ? { ...idle(), waveform: waveform([]) } : idle());
    },
    ...overrides.options,
  });
  t.after(async () => {
    for (const child of children) child.finish();
    try { await service.shutdown({ force: true }); } catch { /* Keep the assertion failure. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { service, children, requests, sockets, directory };
}

function pythonServiceFixture() {
  const servicesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blade-services-root-"));
  fs.mkdirSync(path.join(servicesRoot, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(servicesRoot, ".venv", "bin", "python"), "fixture; never executed");
  fs.mkdirSync(path.join(servicesRoot, "blade_acquisition"), { recursive: true });
  fs.writeFileSync(path.join(servicesRoot, "blade_acquisition", "__main__.py"), "# fixture");
  return servicesRoot;
}

test("start is single-flight and secret stays in process environment and authenticated transport", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.service.start(), f.service.start()]);
  assert.equal(f.children.length, 1);
  assert.equal(results[0].service.state, "ready");
  const child = f.children[0], secret = child.options.env.BLADE_SERVICE_TOKEN;
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(child.options.shell, false);
  assert.equal(child.options.windowsHide, true);
  assert.deepEqual(child.args, []);
  assert.equal(Object.hasOwn(child.options.env, "DATABASE_URL"), false);
  for (const request of f.requests) {
    assert.equal(new URL(request.url).hostname, "127.0.0.1");
    assert.equal(request.options.headers.Authorization === `Bearer ${secret}`, true);
    assert.equal(request.options.redirect, "error");
  }
  assert.equal(JSON.stringify(results).includes(secret), false);
  assert.equal(f.sockets[0].protocols[1] === secret, true);
});

test("Windows service ignores installed Python, Conda, venv and inherited DLL search paths", () => {
  const source = Object.freeze({
    PATH: "C:\\Python32;C:\\Python312;C:\\Miniconda\\Library\\bin;C:\\project\\.venv\\Scripts",
    Path: "C:\\other-python;C:\\old-sdk", pAtH: "C:\\another-python",
    PYTHONHOME: "C:\\Python32", pythonpath: "C:\\unrelated-packages",
    PYTHONSTARTUP: "C:\\startup.py", PYTHONUSERBASE: "C:\\user-packages",
    PYTHONINSPECT: "1", PYTHONUNBUFFERED: "0", PYTHONWARNINGS: "error",
    CONDA_PREFIX: "C:\\Miniconda", CONDA_DEFAULT_ENV: "other-project", VIRTUAL_ENV: "C:\\project\\.venv",
    _PYI_APPLICATION_HOME_DIR: "C:\\other-bundled-app", _PYI_ARCHIVE_FILE: "C:\\other-app.exe",
    _MEIPASS2: "C:\\other-app\\runtime", PYINSTALLER_RESET_ENVIRONMENT: "0",
    SystemRoot: "D:\\Windows", WINDIR: "C:\\incorrect-windows", SystemDrive: "C:",
    TEMP: "D:\\Users\\测试用户\\Temp", TMP: "D:\\Users\\测试用户\\Temp",
    USERPROFILE: "D:\\Users\\测试用户", LOCALAPPDATA: "D:\\Users\\测试用户\\AppData\\Local",
    APPDATA: "D:\\Users\\测试用户\\AppData\\Roaming", PROGRAMDATA: "D:\\ProgramData", LANG: "zh_CN.UTF-8",
    DATABASE_URL: "private-data", BLADE_SERVICE_TOKEN: "caller-token", BLADE_SERVICE_PORT: "8000",
  });
  const before = { ...source };
  const env = windowsServiceEnvironment({
    file: "D:\\Applications\\旋转叶片测振\\acquisition\\BladeAcquisition.exe",
    dataDir: "D:\\Users\\测试用户\\field-data", dll: "E:\\SDK\\DeviceCommunication.dll",
    port: 54321, secret: "new-random-token", source,
  });
  assert.deepEqual(source, before, "building child environment must never mutate user/system environment");
  assert.deepEqual(env.PATH.split(";"), [
    "D:\\Applications\\旋转叶片测振\\acquisition",
    "D:\\Applications\\旋转叶片测振\\acquisition\\_internal",
    "D:\\Applications\\旋转叶片测振\\acquisition\\vendor",
    "D:\\Windows\\System32", "D:\\Windows", "D:\\Windows\\System32\\Wbem",
  ]);
  assert.equal(env.SystemRoot, "D:\\Windows");
  assert.equal(env.WINDIR, "D:\\Windows");
  assert.equal(env.SystemDrive, "D:");
  assert.equal(env.PYTHONUNBUFFERED, "1");
  for (const key of ["TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "LANG"]) {
    assert.equal(env[key], source[key]);
  }
  for (const key of Object.keys(source)) {
    if (/^(?:PYTHON(?!UNBUFFERED)|CONDA|VIRTUAL_ENV|_PYI|_MEIPASS|PYINSTALLER|DATABASE_URL)/i.test(key)) {
      assert.equal(Object.hasOwn(env, key), false, `${key} must not cross the process boundary`);
    }
  }
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === "path").length, 1);
  assert.equal(env.BLADE_SERVICE_PORT, "54321");
  assert.equal(env.BLADE_SERVICE_TOKEN, "new-random-token");
  assert.equal(env.BLADE_POLYTEC_DLL, "E:\\SDK\\DeviceCommunication.dll");
  assert.equal(env.BLADE_DATA_DIR, "D:\\Users\\测试用户\\field-data");
});

test("Windows environment allowlist handles mixed casing and never emits duplicate names", () => {
  const env = windowsServiceEnvironment({ file: "C:\\App\\BladeAcquisition.exe", dataDir: "C:\\data",
    dll: "C:\\App\\vendor\\DeviceCommunication.dll", port: 32100, secret: "secret",
    source: { sYsTeMrOoT: "E:/Windows/", SystemRoot: "F:\\wrong", tEmP: "E:\\temp", tmp: "E:\\tmp",
      UserProfile: "E:\\Users\\admin", LocalAppData: "E:\\local", aPpDaTa: "E:\\roaming", pAtH: "C:\\Conda" } });
  assert.equal(env.SystemRoot, "E:\\Windows\\");
  assert.equal(env.SystemDrive, "E:");
  assert.equal(env.TEMP, "E:\\temp");
  assert.equal(env.TMP, "E:\\tmp");
  assert.equal(env.USERPROFILE, "E:\\Users\\admin");
  assert.equal(env.LOCALAPPDATA, "E:\\local");
  assert.equal(env.APPDATA, "E:\\roaming");
  const names = Object.keys(env).map(key => key.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(env.PATH.includes("Conda"), false);
});

test("missing or unusable Windows root cannot turn inherited PATH into a fallback", () => {
  const build = source => windowsServiceEnvironment({ file: "C:\\App\\BladeAcquisition.exe", dataDir: "C:\\data",
    dll: "C:\\App\\vendor\\DeviceCommunication.dll", port: 32100, secret: "secret", source });
  for (const source of [{}, { SystemRoot: "relative\\Windows", PATH: "C:\\Python" },
    { SystemRoot: "C:\\Windows;C:\\Python", WINDIR: "\\\\server\\share", Path: "C:\\Conda" }]) {
    const env = build(source);
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.SystemDrive, "C:");
    assert.equal(env.PATH.includes("Python") || env.PATH.includes("Conda") || env.PATH.includes("server"), false);
  }
  assert.equal(build({ SystemRoot: "invalid", windir: "F:\\Windows" }).SystemRoot, "F:\\Windows");
});

test("service startup passes only the isolated environment without invoking system Python", async (t) => {
  const environment = Object.freeze({ Path: "C:\\Miniconda\\Scripts;C:\\Python32", SystemRoot: "C:\\Windows",
    PYTHONHOME: "C:\\Python32", PYTHONPATH: "C:\\foreign-packages", VIRTUAL_ENV: "C:\\venv", CONDA_PREFIX: "C:\\Miniconda" });
  const f = fixture(t, { options: { environment } });
  await f.service.start();
  const child = f.children[0];
  assert.equal(child.file, path.join(f.directory, "BladeAcquisition.exe"));
  assert.equal(child.options.cwd, f.directory);
  assert.equal(child.options.shell, false);
  assert.deepEqual(child.args, []);
  assert.equal(child.options.env.PATH.includes("Miniconda") || child.options.env.PATH.includes("Python32"), false);
  for (const key of ["Path", "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX"]) assert.equal(Object.hasOwn(child.options.env, key), false);
  assert.equal(environment.Path, "C:\\Miniconda\\Scripts;C:\\Python32");
});

test("missing Windows bundle reports missing without spawning", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.directory, "BladeAcquisition.exe"));
  assert.equal((await f.service.start()).service.state, "missing");
  assert.equal(f.children.length, 0);
});

test("Mac bundle starts its own service without source or a Python installation", async (t) => {
  const f = fixture(t, { options: { platform: "darwin", environment: {
    PATH: "/usr/bin:/bin", PYTHONHOME: "/foreign", PYTHONPATH: "/foreign", VIRTUAL_ENV: "/foreign",
  } } });
  const file = path.join(f.directory, "acquisition", "BladeAcquisition");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "test fixture; never executed", { mode: 0o755 });
  const result = await f.service.start();
  assert.equal(result.service.state, "ready");
  assert.equal(result.service.launcher, "macos-bundle");
  assert.equal(result.service.executable, file);
  const child = f.children[0];
  assert.equal(child.file, file);
  assert.deepEqual(child.args, []);
  assert.equal(child.options.cwd, path.dirname(file));
  assert.equal(child.options.shell, false);
  assert.equal(child.options.env.BLADE_DATA_DIR, path.join(f.directory, "data"));
  for (const key of ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"])
    assert.equal(Object.hasOwn(child.options.env, key), false);
});

test("non-Windows platform without a virtualenv reports missing without spawning", async (t) => {
  const f = fixture(t, { options: { platform: "darwin" } });
  const result = await f.service.start();
  assert.equal(result.service.state, "missing");
  assert.match(result.service.error, /Python 采集服务环境/);
  assert.equal(f.children.length, 0);
});

test("non-Windows platform spawns python -m blade_acquisition with a scrubbed environment", async (t) => {
  const servicesRoot = pythonServiceFixture();
  const environment = Object.freeze({ PATH: "/usr/bin:/bin", PYTHONPATH: "/foreign", PYTHONHOME: "/conda",
    VIRTUAL_ENV: "/venv", CONDA_PREFIX: "/conda", DATABASE_URL: "mysql://should-not-leak" });
  const f = fixture(t, { options: { platform: "darwin", servicesRoot, environment } });
  const result = await f.service.start();
  assert.equal(result.service.state, "ready");
  assert.equal(result.service.launcher, "python-module");
  assert.equal(f.children.length, 1);
  const child = f.children[0];
  assert.equal(child.file, path.join(servicesRoot, ".venv", "bin", "python"));
  assert.deepEqual(child.args, ["-m", "blade_acquisition"]);
  assert.equal(child.options.cwd, servicesRoot);
  assert.equal(child.options.shell, false);
  assert.equal(child.options.windowsHide, true);
  assert.equal(child.options.env.PATH, "/usr/bin:/bin");
  for (const key of ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "CONDA_PREFIX"]) assert.equal(Object.hasOwn(child.options.env, key), false);
  assert.equal(child.options.env.DATABASE_URL, "mysql://should-not-leak");
  assert.equal(child.options.env.BLADE_DATA_DIR, path.join(f.directory, "data"));
  assert.match(child.options.env.BLADE_SERVICE_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(child.options.env.BLADE_POLYTEC_DLL, path.join(servicesRoot, "vendor", "libDeviceCommunication.dylib"));
  fs.rmSync(servicesRoot, { recursive: true, force: true });
});

test("BLADE_ACQUISITION_PYTHON overrides the virtualenv interpreter", async (t) => {
  const servicesRoot = pythonServiceFixture();
  const custom = path.join(servicesRoot, "custom-python");
  fs.writeFileSync(custom, "fixture");
  const f = fixture(t, { options: { platform: "darwin", servicesRoot,
    environment: Object.freeze({ PATH: "/usr/bin", BLADE_ACQUISITION_PYTHON: custom }) } });
  assert.equal((await f.service.start()).service.state, "ready");
  assert.equal(f.children[0].file, custom);
  assert.deepEqual(f.children[0].args, ["-m", "blade_acquisition"]);
  fs.rmSync(servicesRoot, { recursive: true, force: true });
});

test("laser and acquisition require complete explicit confirmation before any start call", async (t) => {
  const f = fixture(t);
  const config = { deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "实机任务", object: "叶片", turbine: "机组", point: "测点" };
  await assert.rejects(f.service.begin(config), error => error.status === 400);
  await assert.rejects(f.service.begin({ ...config, confirmLaser: true, hostIp: "example.com" }), error => error.status === 400);
  await assert.rejects(f.service.begin({ ...config, confirmLaser: true, name: "" }), error => error.status === 400);
  for (const windFarm of [42, 'x'.repeat(121), 'WF\0bad']) await assert.rejects(f.service.begin({ ...config, confirmLaser: true, windFarm }), { status: 400 });
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
  await f.service.begin({ ...config, confirmLaser: true, windFarm: ' WF-001 ' });
  assert.equal(JSON.parse(f.requests.find(request => request.route === 'start').options.body).windFarm, 'WF-001');
  assert.equal(f.requests.filter(request => request.route === "start").length, 1);
});

test("point cycle forwards entry, exit and work-zero return coordinates through the desktop bridge", async t => {
  const f = fixture(t);
  const config = { deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "回波换点", object: "", turbine: "", point: "",
    confirmLaser: true, confirmMotion: true, pointCycle: { port: "COM6", cycles: 1, dwellSeconds: 60, speedRpm: 2,
      points: [{ port: "COM6", referenceSignature: "[[0,3,10000,17],[0,3,10000,17]]", name: "M01", axis1AngleDeg: 2, axis2AngleDeg: 6 }], rssiTriggerEnabled: true,
      rssiThresholdMode: "adaptive", rssiBaselineRatio: .9, rssiConfirmMs: 25, rssiSmoothingMs: 10,
      rssiMinimumSeconds: .5, rssiMotionMarginMs: 200,
      rssiEnterSpread: 9, rssiExitSpread: 2, rssiEnterConfirmMs: 40,
      returnToOrigin: { name: "作业原点", port: "COM6", referenceSignature: "[[0,3,10000,17],[0,3,10000,17]]", axis1AngleDeg: -.47, axis2AngleDeg: -16.73 } } };
  for (const change of [null, { ...config.pointCycle.returnToOrigin, port: 'COM7' },
    { ...config.pointCycle.returnToOrigin, axis1AngleDeg: 36 }, { ...config.pointCycle.returnToOrigin, axis2AngleDeg: true },
    { ...config.pointCycle.returnToOrigin, axis2AngleDeg: NaN }, { ...config.pointCycle.returnToOrigin, referenceSignature: '[]' },
    { ...config.pointCycle.returnToOrigin, referenceSignature: '[[1,3,10000,17],[0,3,10000,17]]' }]) {
    await assert.rejects(f.service.begin({ ...config, pointCycle: { ...config.pointCycle, returnToOrigin: change } }), { status: 400 });
  }
  for (const change of [{ rssiConfirmMs: 0 }, { rssiBaselineRatio: NaN }, { rssiTriggerEnabled: "true" },
    { rssiThresholdMode: "absolute" }, { rssiMinimumSeconds: 61 }, { rssiEnterSpread: 2 },
    { rssiEnterSpread: true }, { rssiExitSpread: NaN }, { rssiExitSpread: 9 },
    { rssiEnterConfirmMs: 0 }]) {
    await assert.rejects(f.service.begin({ ...config, pointCycle: { ...config.pointCycle, ...change } }), { status: 400 });
  }
  assert.equal(f.children.length, 0);
  await f.service.begin(config);
  const sent = JSON.parse(f.requests.find(request => request.route === "start").options.body);
  assert.deepEqual(sent.pointCycle, config.pointCycle);
});

test("manual configured route preserves order and requires echo handoff before hardware", async t => {
  const f = fixture(t);
  const points = [0, 20, -5, 1].map((angle, index) => ({ port: "COM6", referenceSignature: "[[0,3,10000,17],[0,3,10000,17]]", pointId: `p${index}`, name: `M${index}`, axis1AngleDeg: angle, axis2AngleDeg: 0 }));
  const config = { deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "手动点位联动", object: "", turbine: "", point: "",
    confirmLaser: true, confirmMotion: true, pointCycle: { port: "COM6", routeOrder: "configured", points, cycles: 1, dwellSeconds: 60, speedRpm: .2, rssiTriggerEnabled: true } };
  for (const change of [{ routeOrder: "guess" }, { routeOrder: true }, { rssiTriggerEnabled: false }]) {
    await assert.rejects(f.service.begin({ ...config, pointCycle: { ...config.pointCycle, ...change } }), { status: 400 });
  }
  assert.equal(f.children.length, 0);
  await f.service.begin(config);
  const sent = JSON.parse(f.requests.find(request => request.route === "start").options.body);
  assert.deepEqual(sent.pointCycle, config.pointCycle);
});

test("simulation needs an explicit source and rejects invalid point/scenario before launching or requesting", async (t) => {
  const f = fixture(t);
  const config = { source: "simulation", name: "模拟风机", object: "叶片", turbine: "机组", point: "测点",
    simulation: { point: "P2", scenario: "impact" } };
  for (const source of ["mock", "SIMULATION", "", null, false]) {
    await assert.rejects(f.service.begin({ ...config, source }), { status: 400 });
  }
  for (const simulation of [undefined, {}, { point: "P0", scenario: "baseline" }, { point: "P4", scenario: "impact" },
    { point: "P1", scenario: "unknown" }, { point: "P1", scenario: "" }, { point: "P1", scenario: null }]) {
    await assert.rejects(f.service.begin({ ...config, simulation }), { status: 400 });
  }
  await assert.rejects(f.service.begin({ ...config, source: undefined }), { status: 400 });
  await assert.rejects(f.service.begin({ ...config, name: "  " }), { status: 400 });
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
});

test('automatic stations preserve physical geometry and multi-point classification without accepting fabricated run identity', async t => {
  const f = fixture(t);
  const pointCycle = { mode: 'automatic_stations', port: 'COM6', cycles: 2, dwellSeconds: 60, speedRpm: .52,
    collectionId: 'c'.repeat(32),
    nominalPeriodSeconds: 30, maxMoveRpm: .6, maxMoveAccelerationDegS2: 30, rssiTriggerEnabled: true,
    geometry: { distanceM: 2.86, hubHeightDeltaM: 1.46, rotationDirection: 'clockwise', axis1Sign: 1, axis2Sign: 1,
      anchorRadiusM: .31, anchorAxis1AngleDeg: 10, anchorAxis2AngleDeg: 0 },
    points: [{ pointId: 'p1-s1', name: 'P1 · 0°', port: 'COM6', referenceSignature: '[[0,3,10000,17],[0,3,10000,17]]',
      axis1AngleDeg: 10, axis2AngleDeg: 0, bladeId: '2', radialPointId: 'p1', radialPointName: 'P1', radiusM: .31,
      rootRadiusM: .1, bladeLengthM: .7, azimuthDeg: 0 }] };
  const config = { source: 'device', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', name: '分站采集', object: '', turbine: '', point: '', confirmLaser: true, confirmMotion: true, pointCycle };
  for (const change of [{ mode: 'unknown' }, { mode: 'legacy' }, { collectionId: '' }, { collectionId: 'c'.repeat(32) + '\n' }, { collectionId: true }, { collectionId: null }, { collectionId: 'C'.repeat(32) }, { rssiTriggerEnabled: false }, { nominalPeriodSeconds: .1 }, { nominalPeriodSeconds: -1 }, { nominalPeriodSeconds: true }, { maxMoveRpm: .2 }, { speedRpm: .231, maxMoveRpm: .231 },
    ...[0, -.1, .099, 120.001, NaN, Infinity, true, '30', null].map(maxMoveAccelerationDegS2 => ({ maxMoveAccelerationDegS2 })),
    { geometry: { ...pointCycle.geometry, axis1Sign: true } }, { geometry: { ...pointCycle.geometry, calibrated: true } },
    ...[0, .4999, 1.5001, true, null, '0.9', NaN, Infinity].map(pitchAngleScale => ({ geometry: { ...pointCycle.geometry, pitchAngleScale } })),
    ...[0, .4999, 1.5001, true, null, '0.95', NaN, Infinity].map(yawAngleScale => ({ geometry: { ...pointCycle.geometry, yawAngleScale } })),
    { points: [{ ...pointCycle.points[0], radialPointId: '' }] }, { points: [{ ...pointCycle.points[0], azimuthDeg: 360 }] },
    ...[{ rootRadiusM: true }, { rootRadiusM: -.1 }, { rootRadiusM: .4 }, { rootRadiusM: Infinity },
      { bladeLengthM: 0 }, { bladeLengthM: '1' }, { bladeLengthM: .1 }].map(change => ({ points: [{ ...pointCycle.points[0], ...change }] }))]) {
    await assert.rejects(f.service.begin({ ...config, pointCycle: { ...pointCycle, ...change } }), { status: 400 });
  }
  assert.equal(f.requests.length, 0);
  await f.service.begin({ ...config, pointCycle: { ...pointCycle, sessionId: 'invented', identityVerified: true } });
  assert.deepEqual(JSON.parse(f.requests.find(request => request.route === 'start').options.body).pointCycle, pointCycle);
  for (const port of ['COM6', '/dev/cu.usbserial-110', 'tcp://192.168.10.50:5000']) {
    const corrected = { ...pointCycle, port, geometry: { ...pointCycle.geometry, pitchAngleScale: .896932, yawAngleScale: .950153 },
      points: pointCycle.points.map(point => ({ ...point, port })) };
    await f.service.begin({ ...config, pointCycle: corrected });
    assert.deepEqual(JSON.parse(f.requests.filter(row => row.route === 'start').at(-1).options.body).pointCycle, corrected);
  }
  const operator = { ...pointCycle, nominalPeriodSeconds: 0, speedRpm: .22, maxMoveRpm: .22, dwellSeconds: 60 };
  await f.service.begin({ ...config, pointCycle: operator });
  assert.deepEqual(JSON.parse(f.requests.filter(request => request.route === 'start').at(-1).options.body).pointCycle, operator);
});

test('calibrated first-station hold is a strict automatic-only opt-in forwarded unchanged', async t => {
  const f = fixture(t);
  const pointCycle = { mode: 'automatic_stations', port: 'COM6', cycles: 1, dwellSeconds: 60, speedRpm: .52,
    nominalPeriodSeconds: 30, maxMoveRpm: .6, rssiTriggerEnabled: true,
    geometry: { distanceM: 2.86, hubHeightDeltaM: 1.46, rotationDirection: 'clockwise', axis1Sign: 1, axis2Sign: 1,
      anchorRadiusM: .31, anchorAxis1AngleDeg: 10, anchorAxis2AngleDeg: 2 },
    points: [{ pointId: 'p1-s1', name: 'P1 · 0°', port: 'COM6', referenceSignature: '[[0,3,10000,17],[0,3,10000,17]]',
      axis1AngleDeg: 10, axis2AngleDeg: 2, bladeId: '2', radialPointId: 'p1', radialPointName: 'P1', radiusM: .31, azimuthDeg: 0 }] };
  const config = { source: 'device', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', name: '首个点位原地等待', object: '', turbine: '', point: '', confirmLaser: true, confirmMotion: true, pointCycle };
  for (const value of ['true', 'false', 1, 0, null])
    await assert.rejects(f.service.begin({ ...config, pointCycle: { ...pointCycle, startAtCurrentPose: value } }), { status: 400 });
  await assert.rejects(f.service.begin({ ...config, pointCycle: { ...pointCycle, mode: 'legacy', startAtCurrentPose: true } }), { status: 400 });
  assert.equal(f.requests.length, 0);
  assert.equal(f.children.length, 0);
  for (const value of [undefined, false, true]) {
    const next = { ...pointCycle, ...(value === undefined ? {} : { startAtCurrentPose: value }) };
    await f.service.begin({ ...config, pointCycle: next });
    const sent = JSON.parse(f.requests.filter(request => request.route === 'start').at(-1).options.body).pointCycle;
    assert.deepEqual(sent, next);
    assert.equal(sent.points[0].axis1AngleDeg, 10);
    assert.equal(sent.geometry.anchorAxis2AngleDeg, 2);
  }
});

test("explicit simulation starts without DLL, device addresses or laser consent and forwards only simulation controls", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => response(route === "start" ? { ...acquiring(), source: "simulation" } : idle()) });
  const config = { source: "simulation", simulation: { point: "P2", scenario: "impact", file: "/must-not-forward" },
    name: "  模拟风机  ", object: "叶片", turbine: "", point: "" };
  assert.equal(f.service.serviceInfo().dllConfigured, false);
  const result = await f.service.begin(config);
  assert.equal(result.state, "acquiring");
  assert.equal(result.source, "simulation");
  const starts = f.requests.filter(request => request.route === "start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.method, "POST");
  assert.deepEqual(JSON.parse(starts[0].options.body), { source: "simulation", simulation: { point: "P2", scenario: "impact" },
    name: "模拟风机", object: "叶片", turbine: "", point: "" });
  assert.equal(f.requests.filter(request => request.route === "device").length, 0);
});

test("simulation cannot make omitted/default device source bypass laser confirmation or IPv4 checks", async (t) => {
  const f = fixture(t);
  const config = { source: "device", simulation: { point: "P1", scenario: "baseline" }, name: "设备任务", object: "", turbine: "", point: "",
    deviceIp: "192.168.0.10", hostIp: "192.168.0.2" };
  for (const confirmLaser of [undefined, false, 1, "true"]) await assert.rejects(f.service.begin({ ...config, confirmLaser }), { status: 400 });
  for (const patch of [{ deviceIp: "" }, { hostIp: "" }, { hostIp: "192.168.0.10" }, { deviceIp: "::1" }, { hostIp: "example.com" }]) {
    await assert.rejects(f.service.begin({ ...config, ...patch, confirmLaser: true }), { status: 400 });
  }
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
  await f.service.begin({ ...config, source: undefined, confirmLaser: true });
  const body = JSON.parse(f.requests.find(request => request.route === "start").options.body);
  assert.equal(body.confirmLaser, true);
  assert.equal(body.deviceIp, config.deviceIp);
  assert.equal(body.hostIp, config.hostIp);
  assert.equal(body.simulation, undefined);
  assert.notEqual(body.source, "simulation");
});

test("device startup errors propagate and never retry as simulation", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => route === "start" ? response({ detail: "设备 DLL 不可用" }, 503) : response(idle()) });
  await assert.rejects(f.service.begin({ source: "device", confirmLaser: true, name: "设备任务", object: "", turbine: "", point: "",
    deviceIp: "192.168.0.10", hostIp: "192.168.0.2" }), error => error.status === 503 && /DLL/.test(error.message));
  const starts = f.requests.filter(request => request.route === "start");
  assert.equal(starts.length, 1);
  const body = JSON.parse(starts[0].options.body);
  assert.notEqual(body.source, "simulation");
  assert.equal(body.simulation, undefined);
});

test("recording export streams original CSV into gzip or CSV without buffering via text()", async (t) => {
  const chunks = ["# source=simulation\n", "time_s,velocity_mps\n", "0,0.001\n", "0.001,-0.002\n"];
  const f = fixture(t, { fetch: ({ route }) => {
    if (!route.endsWith("/export")) return response(idle());
    let index = 0;
    return { ok: true, status: 200, body: new ReadableStream({ pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunks[index++]));
    } }), text() { throw Error("export must stream, not buffer through response.text()"); } };
  } });
  for (const suffix of ["csv.gz", "csv"]) {
    const file = path.join(f.directory, `original.${suffix}`);
    assert.deepEqual(await f.service.exportRecording("a".repeat(32), file), { saved: true, fileName: `original.${suffix}` });
    const stored = fs.readFileSync(file);
    assert.equal((suffix.endsWith("gz") ? gunzipSync(stored) : stored).toString("utf8"), chunks.join(""));
    // Windows access is governed by ACLs; POSIX permission bits are not preserved.
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(f.directory).some(file => file.endsWith(".tmp")), false);
  const request = f.requests.find(request => request.route.endsWith("/export"));
  assert.equal(request.route, `recordings/${"a".repeat(32)}/export`);
  assert.match(request.options.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
});

test("task package export streams ZIP atomically with scoped record IDs", async t => {
  const payload = Buffer.from('PK\x03\x04test-stream');
  const f = fixture(t, { fetch: ({ route }) => route === 'recordings/export-task'
    ? new Response(payload, { headers: { 'Content-Type': 'application/zip' } }) : response(idle()) });
  for (const level of ['task', 'blade', 'point']) {
    const file = path.join(f.directory, `${level}.zip`), ids = ['a'.repeat(32), 'b'.repeat(32)];
    assert.deepEqual(await f.service.exportTask(ids, file, level), { saved: true, fileName: `${level}.zip`, recordCount: 2 });
    assert.deepEqual(fs.readFileSync(file), payload);
    const request = f.requests.at(-1);
    assert.deepEqual(JSON.parse(request.options.body), { recordingIds: ids, level });
    assert.equal(request.options.method, 'POST');
    assert.match(request.options.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
  }
  assert.ok(!fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')));
});

test("task package rejects invalid selections before transport and preserves existing files on failure", async t => {
  let broken = false;
  const f = fixture(t, { fetch: ({ route }) => route === 'recordings/export-task'
    ? broken ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(Error('stream interrupted')); } }), { headers: { 'content-type': 'application/zip' } })
      : Response.json({ detail: '任务记录已变化' }, { status: 409 }) : response(idle()) });
  const file = path.join(f.directory, 'existing.zip'); fs.writeFileSync(file, 'previous export');
  for (const ids of [[], ['../secret'], ['a'.repeat(32), 'a'.repeat(32)], Array(1001).fill('a'.repeat(32))])
    await assert.rejects(f.service.exportTask(ids, file), { status: 400 });
  await assert.rejects(f.service.exportTask(['a'.repeat(32)], file, 'unknown'), { status: 400 });
  await assert.rejects(f.service.exportTask(['a'.repeat(32)], 'relative.zip'), { status: 400 });
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.service.exportTask(['a'.repeat(32)], file), { status: 409 });
  broken = true;
  await assert.rejects(f.service.exportTask(['a'.repeat(32)], file), /stream interrupted/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous export');
  assert.ok(!fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')));
});

test("turntable telemetry export accepts JSONL and uses the dedicated route", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => route.endsWith("/turntable-export")
    ? { ok: true, status: 200, body: ReadableStream.from([new TextEncoder().encode('{"event":"finished"}\\n')]) }
    : response(idle()) });
  const file = path.join(f.directory, "turntable.jsonl");
  assert.deepEqual(await f.service.exportRecording("a".repeat(32), file), { saved: true, fileName: "turntable.jsonl" });
  assert.equal(fs.readFileSync(file, "utf8"), '{"event":"finished"}\\n');
  assert.equal(f.requests.at(-1).route, `recordings/${"a".repeat(32)}/turntable-export`);
});

test("turntable health is a read-only request and cannot confirm recovery or send motion settings", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.turntable({ action: 'health', port: 'COM6', axis: 1, confirmRecovery: true }), { status: 400 });
  assert.equal(f.requests.length, 0);
  await f.service.turntable({ action: 'health', port: 'COM6', axis: 1, speedRpm: 5, confirmMotion: true });
  const body = JSON.parse(f.requests.find(call => call.route === 'turntable').options.body);
  assert.equal(body.action, 'health'); assert.equal(body.confirmRecovery, false);
  assert.equal(body.speedRpm, undefined); assert.equal(body.targetAngleDeg, undefined);
});

test("turntable recovery requires explicit action and keeps motion parameters out of the request", async t => {
  const f = fixture(t);
  for (const action of ['clear_trajectory_fault', 'clear_guard_fault', 'reset_alarm']) {
    await assert.rejects(f.service.turntable({ action, port: 'COM6', axis: 1 }), { status: 400 });
    await f.service.turntable({ action, port: 'COM6', axis: 2, confirmRecovery: true, speedRpm: 100 });
    const call = f.requests.filter(call => call.route === 'turntable').at(-1);
    assert.deepEqual(JSON.parse(call.options.body), { action, port: 'COM6', axis: 2, confirmMotion: false, confirmRecovery: true });
  }
});
test("pending trajectory cancellation forwards a verified session on Mac and Windows without motion settings", async t => {
  const f = fixture(t);
  for (const port of ['COM6', '/dev/cu.usbserial-110']) {
    const request = { action: 'cancel_trajectory', port, axis: 1, confirmRecovery: true };
    for (const session of [undefined, null, true, 0, 65536, 2.5, '42']) {
      await assert.rejects(f.service.turntable({ ...request, expectedTrajectorySession: session }), { status: 400 });
    }
    await assert.rejects(f.service.turntable({ ...request, confirmRecovery: false, expectedTrajectorySession: 42 }), { status: 400 });
    await f.service.turntable({ ...request, expectedTrajectorySession: 42, speedRpm: 100, targetAngleDeg: 10 });
    const body = JSON.parse(f.requests.filter(call => call.route === 'turntable').at(-1).options.body);
    assert.deepEqual(body, { ...request, expectedTrajectorySession: 42, confirmMotion: false });
  }
});

test("pitch reference clear is explicit and never forwards motion settings on Mac or Windows", async t => {
  const f = fixture(t);
  for (const port of ['COM6', '/dev/cu.usbserial-110', 'tcp://192.168.10.50:5000']) {
    const request = { action: 'clear_axis1_reference', port, axis: 1, confirmRecovery: true };
    for (const changes of [{ axis: 2 }, { confirmRecovery: false }, { confirmMotion: true }])
      await assert.rejects(f.service.turntable({ ...request, ...changes }), { status: 400 });
    await f.service.turntable({ ...request, speedRpm: 100, targetAngleDeg: 30 });
    const body = JSON.parse(f.requests.filter(call => call.route === 'turntable').at(-1).options.body);
    assert.deepEqual(body, { ...request, confirmMotion: false });
  }
});

test("clearing an old trajectory can bind recovery to its verified session on Mac and Windows", async t => {
  const f = fixture(t);
  for (const port of ['COM6', '/dev/cu.usbserial-110']) {
    const request = { action: 'clear_trajectory_fault', port, axis: 1, confirmRecovery: true };
    for (const expectedTrajectorySession of [null, true, 0, 65536, 2.5, '42'])
      await assert.rejects(f.service.turntable({ ...request, expectedTrajectorySession }), { status: 400 });
    await f.service.turntable({ ...request, expectedTrajectorySession: 42, speedRpm: 100, followErrorLimitDeg: 9 });
    const body = JSON.parse(f.requests.filter(call => call.route === 'turntable').at(-1).options.body);
    assert.deepEqual(body, { ...request, expectedTrajectorySession: 42, confirmMotion: false });
  }
});

test("following-error settings pass through point cycles and recall without a disable sentinel", async t => {
  const f = fixture(t);
  const referenceSignature = '[[0,3,10000,17],[0,3,10000,17]]';
  for (const port of ['COM6', '/dev/cu.usbserial-110']) {
    const point = { name: 'P1', port, referenceSignature, axis1AngleDeg: 25, axis2AngleDeg: 0 };
    const config = { source: 'device', deviceIp: '192.168.106.90', hostIp: '192.168.106.10',
      name: '误差设置透传', object: '', turbine: '', point: '', confirmLaser: true, confirmMotion: true,
      pointCycle: { port, points: [point], cycles: 1, dwellSeconds: 1, speedRpm: .2 } };
    const recall = { action: 'recall', port, recordedPort: port, axis: 1, speedRpm: .2,
      axis1AngleDeg: 25, axis2AngleDeg: 0, referenceSignature, confirmMotion: true };
    for (const followErrorLimitDeg of [0, -.5, .499, 10.001, NaN, Infinity, true, '1.5', null]) {
      await assert.rejects(f.service.begin({ ...config, pointCycle: { ...config.pointCycle, followErrorLimitDeg } }), { status: 400 });
      await assert.rejects(f.service.turntable({ ...recall, followErrorLimitDeg }), { status: 400 });
    }
    for (const followErrorLimitDeg of [.5, .75, 1.5, 10]) {
      await f.service.begin({ ...config, pointCycle: { ...config.pointCycle, followErrorLimitDeg } });
      const cycle = JSON.parse(f.requests.filter(call => call.route === 'start').at(-1).options.body).pointCycle;
      assert.equal(cycle.followErrorLimitDeg, followErrorLimitDeg);
      await f.service.turntable({ ...recall, followErrorLimitDeg });
      const returned = JSON.parse(f.requests.filter(call => call.route === 'turntable').at(-1).options.body);
      assert.equal(returned.followErrorLimitDeg, followErrorLimitDeg);
      assert.equal(returned.axis1AngleDeg, 25);
    }
    await f.service.begin(config);
    assert.equal(JSON.parse(f.requests.filter(call => call.route === 'start').at(-1).options.body).pointCycle.followErrorLimitDeg, undefined);
    await f.service.turntable(recall);
    assert.equal(JSON.parse(f.requests.filter(call => call.route === 'turntable').at(-1).options.body).followErrorLimitDeg, undefined);
  }
});

test("turntable standalone test validates consent, limits and protocol before any device call", async t => {
  const f = fixture(t);
  const config = { port: 'COM6', axis: 2, speedRpm: 0.2, direction: 'reverse', durationSeconds: 0, protocol: 'continuous' };
  for (const changes of [{ confirmMotion: undefined }, { speedRpm: NaN }, { speedRpm: 0 }, { testSeconds: 100 }, { protocol: 'guess' }]) {
    await assert.rejects(f.service.turntable({ ...config, action: 'test', confirmMotion: true, ...changes }), { status: 400 });
  }
  assert.equal(f.requests.length, 0);
  await f.service.turntable({ ...config, action: 'test', confirmMotion: true, testSeconds: 3 });
  const call = f.requests.find(item => item.route === 'turntable');
  assert.deepEqual(JSON.parse(call.options.body), { ...config, action: 'test', testSeconds: 3, confirmMotion: true, confirmRecovery: false });
  assert.equal(f.requests.some(item => ['start', 'device'].includes(item.route)), false);
});

test("Mac serial bridge preserves path case for probe, stop, recall and point cycles", async t => {
  const servicesRoot = pythonServiceFixture();
  t.after(() => fs.rmSync(servicesRoot, { recursive: true, force: true }));
  const f = fixture(t, { options: { platform: "darwin", servicesRoot } });
  const port = "/dev/cu.SLAB_USBtoUART", referenceSignature = "[[0,3,10000,17],[0,3,10000,17]]";
  for (const action of ["probe", "stop"]) {
    await f.service.turntable({ port, axis: 1, action, ...(action === "stop" ? { confirmMotion: true } : {}) });
    assert.equal(JSON.parse(f.requests.filter(row => row.route === "turntable").at(-1).options.body).port, port);
  }
  const recall = { port, recordedPort: port, axis: 1, action: "recall", axis1AngleDeg: 25, axis2AngleDeg: 0,
    speedRpm: 0.2, confirmMotion: true, referenceSignature };
  await f.service.turntable(recall);
  const body = JSON.parse(f.requests.filter(row => row.route === "turntable").at(-1).options.body);
  assert.equal(body.port, port); assert.equal(body.recordedPort, port); assert.equal(body.referenceSignature, referenceSignature);
  for (const changes of [{ recordedPort: port.toLowerCase() }, { referenceSignature: undefined }, { confirmMotion: false }, { axis1AngleDeg: 36 }]) {
    await assert.rejects(f.service.turntable({ ...recall, ...changes }), { status: 400 });
  }
  const points = [{ name: "M01", port, referenceSignature, axis1AngleDeg: 25, axis2AngleDeg: 0 }];
  await f.service.begin({ name: "Mac cycle", object: "", turbine: "", point: "", deviceIp: "192.168.106.90", hostIp: "192.168.106.10",
    confirmLaser: true, confirmMotion: true, pointCycle: { port, points, cycles: 1, dwellSeconds: 1, speedRpm: 0.2 } });
  assert.deepEqual(JSON.parse(f.requests.find(row => row.route === "start").options.body).pointCycle.points, points);
});

test("serial bridge rejects URLs, traversal, non-cu paths and control characters before I/O", async t => {
  const f = fixture(t);
  const cases = require("./fixtures/turntable-ports.json");
  for (const port of [...cases.invalid, `/dev/cu.${"a".repeat(129)}`]) {
    await assert.rejects(f.service.turntable({ port, axis: 1, action: "probe" }), { status: 400 });
  }
  assert.equal(f.requests.length, 0); assert.equal(f.children.length, 0);
});

test("busy turntable allows a stop request but blocks probes and setting confirmation", async t => {
  const f = fixture(t, { fetch: ({ route }) => response(route === 'turntable' ? idle() : { ...idle(), turntableBusy: true }) });
  const config = { port: 'COM6', axis: 1, speedRpm: 0.2, direction: 'forward', durationSeconds: 0, confirmMotion: true };
  for (const action of ['probe', 'test', 'prepare']) await assert.rejects(f.service.turntable({ ...config, action }), { status: 409 });
  await f.service.turntable({ port: 'COM6', axis: 1, action: 'stop', confirmMotion: true });
  assert.equal(f.requests.filter(item => item.route === 'turntable').length, 1);
});

test("failed recording export preserves an existing file and leaves no temporary file", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => route.endsWith("/export")
    ? new Response(JSON.stringify({ detail: "原始记录尚未完整保存" }), { status: 409 }) : response(idle()) });
  const file = path.join(f.directory, "original.csv.gz");
  fs.writeFileSync(file, "EXISTING EXPORT");
  await assert.rejects(f.service.exportRecording("a".repeat(32), file), error => error.status === 409 && /完整保存/.test(error.message));
  assert.equal(fs.readFileSync(file, "utf8"), "EXISTING EXPORT");
  assert.equal(fs.readdirSync(f.directory).some(file => file.endsWith(".tmp")), false);
});

test("a truncated export stream cannot replace an existing file or leave its partial data", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => {
    if (!route.endsWith("/export")) return response(idle());
    let sent = false;
    return { ok: true, status: 200, body: new ReadableStream({ pull(controller) {
      if (sent) controller.error(Error("stream interrupted"));
      else { sent = true; controller.enqueue(new TextEncoder().encode("time_s,velocity_mps\n0,0.001\n")); }
    } }) };
  } });
  const file = path.join(f.directory, "original.csv");
  fs.writeFileSync(file, "KEEP COMPLETE FILE");
  await assert.rejects(f.service.exportRecording("a".repeat(32), file), /stream interrupted/);
  assert.equal(fs.readFileSync(file, "utf8"), "KEEP COMPLETE FILE");
  assert.equal(fs.readdirSync(f.directory).some(file => file.endsWith(".tmp")), false);
});

test("recording export rejects invalid ids or relative/non-CSV targets before launching or fetching", async (t) => {
  const f = fixture(t);
  const file = path.join(f.directory, "original.csv.gz");
  for (const id of ["../secret", "", "a".repeat(31), "g".repeat(32), null]) {
    await assert.rejects(f.service.exportRecording(id, file), { status: 400 });
  }
  for (const invalidFile of ["relative.csv", "", path.join(f.directory, "original.json"), path.join(f.directory, "original.csv.gz.tmp"), null]) {
    await assert.rejects(f.service.exportRecording("a".repeat(32), invalidFile), { status: 400 });
  }
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
});

test("HTTP frame fallback remains bounded and a failed stop is not acknowledged as saved", async (t) => {
  const f = fixture(t, { fetch: async request => {
    if (request.route === "frame") return response({ ...acquiring(), waveform: waveform(new Array(4097).fill(1)) });
    if (request.route === "stop") return response({ detail: "磁盘写入失败，记录未完成" }, 500);
    return response(idle());
  } });
  await f.service.start();
  const frame = await f.service.frame();
  assert.equal(frame.state, "error");
  assert.deepEqual(frame.waveform.values, []);
  await assert.rejects(f.service.stop(), error => error.status === 500);
  await assert.rejects(f.service.shutdown());
  assert.equal(f.children[0].signals.length, 0);
});

test("normal shutdown stops saving before process termination and restart rotates token", async (t) => {
  const f = fixture(t);
  await f.service.start();
  const firstSecret = f.children[0].options.env.BLADE_SERVICE_TOKEN;
  await f.service.shutdown();
  assert.equal(f.requests.at(-1).route, "stop");
  assert.equal(f.children[0].exited, true);
  assert.equal(f.service.serviceInfo().state, "stopped");
  await f.service.start();
  assert.equal(f.children.length, 2);
  assert.equal(firstSecret === f.children[1].options.env.BLADE_SERVICE_TOKEN, false);
});

test("a startup response arriving after process exit cannot mark the service ready", async (t) => {
  const received = deferred(), pending = deferred();
  const f = fixture(t, { fetch: async () => { received.resolve(); return pending.promise; } });
  const opening = f.service.start();
  await received.promise;
  f.children[0].finish(1);
  pending.resolve(response(idle()));
  const result = await opening;
  assert.notEqual(result.service.state, "ready");
  assert.notEqual(f.service.serviceInfo().state, "ready");
  assert.equal(f.sockets.length, 0);
});

test("a frame response from before restart cannot replace or display the new session", async (t) => {
  const received = deferred(), pending = deferred();
  const f = fixture(t, { fetch: async request => {
    if (request.route === "frame") { received.resolve(); return pending.promise; }
    return response(idle());
  } });
  await f.service.start();
  const frame = f.service.frame().catch(error => ({ rejected: true, error }));
  await received.promise;
  await f.service.shutdown();
  await f.service.start();
  pending.resolve(response({ ...acquiring(), waveform: waveform([987654]) }));
  const result = await frame;
  assert.equal(result.waveform?.values?.includes(987654) || false, false);
});

test("crashed acquisition cannot silently complete a non-forced shutdown", async (t) => {
  const f = fixture(t, { fetch: async request => response(request.route === "start" ? acquiring() : idle()) });
  await f.service.begin({ confirmLaser: true, deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "任务", object: "叶片", turbine: "机组", point: "测点" });
  f.children[0].finish(1);
  await assert.rejects(f.service.shutdown(), error => error.status >= 400);
  await f.service.shutdown({ force: true });
  assert.equal(f.service.serviceInfo().state, "stopped");
});

for (const platform of ['darwin', 'win32']) test(`${platform}: confirmed process exit clears only process busy guards and cancels its pending HTTP`, async t => {
  const servicesRoot = pythonServiceFixture(); t.after(() => fs.rmSync(servicesRoot, { recursive: true, force: true }));
  const received = deferred(); let live = idle(), aborted = false;
  const f = fixture(t, { options: { platform, servicesRoot }, fetch: async ({ route, options }) => {
    if (route === 'turntable') {
      received.resolve();
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
        aborted = true; reject(options.signal.reason);
      }, { once: true }));
    }
    return response(live);
  } });
  await f.service.start();
  const checking = f.service.turntable({ action: 'health', port: 'tcp://192.168.10.50:5000', axis: 1 });
  const rejected = assert.rejects(checking, /进程已退出/);
  await received.promise;
  live = { ...acquiring(), receiver: { running: true }, deviceBusy: true, turntableBusy: true,
    recording: { id: 'unfinished', status: 'incomplete' }, turntableWarning: '需现场检查停止状态' };
  await f.service.status(); f.children[0].finish(1); await rejected;
  const failed = await f.service.status();
  assert.equal(aborted, true); assert.equal(failed.state, 'error');
  assert.equal(failed.receiver.running, false); assert.equal(failed.deviceBusy, false); assert.equal(failed.turntableBusy, false);
  assert.equal(failed.recording.status, 'incomplete'); assert.equal(failed.turntableWarning, live.turntableWarning);
  const oldGeneration = failed.service.generation;
  await f.service.shutdown({ force: true });
  const closed = await f.service.status();
  assert.equal(closed.service.state, 'stopped'); assert.equal(closed.receiver.running, false);
  assert.equal(closed.turntableBusy, false); assert.equal(closed.deviceBusy, false);
  assert.equal(closed.state, 'error'); assert.equal(closed.recording.status, 'incomplete');
  live = idle();
  const fresh = await f.service.start();
  assert.equal(fresh.service.state, 'ready'); assert.ok(fresh.service.generation > oldGeneration);
  assert.equal(fresh.state, 'idle'); assert.equal(f.children.length, 2);
});

test('failed status/frame reads retain a live receiver Stop entry; a fresh idle read clears it', async t => {
  let failRead = false;
  const active = { ...acquiring(), receiver: { running: true }, turntableBusy: false, deviceBusy: false };
  const f = fixture(t, { fetch: async ({ route }) => {
    if (failRead && ['status', 'frame'].includes(route)) throw Error('fixture transport unavailable');
    return response(route === 'start' ? active : idle());
  } });
  await f.service.begin({ confirmLaser: true, deviceIp: '192.168.0.10', hostIp: '192.168.0.2', name: '任务', object: '', turbine: '', point: '' });
  failRead = true;
  for (const next of [await f.service.status(), await f.service.frame()]) {
    assert.equal(next.state, 'error'); assert.equal(next.receiver.running, true);
    assert.match(next.service.error, /transport/);
  }
  failRead = false;
  const fresh = await f.service.status();
  assert.equal(fresh.receiver.running, undefined); assert.equal(fresh.service.error, null);
});

test("startup timeout escalates termination before another process can be created", async (t) => {
  const f = fixture(t, {
    options: { startupTimeoutMs: 20 },
    fetch: async (_request, state) => {
      if (state.children.length === 1) throw Error("not listening");
      return response(idle());
    },
    kill: (child, signal) => { if (signal === "SIGKILL") queueMicrotask(() => child.finish()); return true; },
  });
  await f.service.start();
  await f.service.start();
  assert.equal(f.children[0].exited, true);
  assert.equal(f.children[0].signals.includes("SIGKILL"), true);
  assert.equal(f.children.length, 2);
});

test("messages from an old authenticated socket cannot overwrite the new session", async (t) => {
  const f = fixture(t);
  await f.service.start();
  const oldSocket = f.sockets[0];
  await f.service.shutdown();
  await f.service.start();
  oldSocket.emit("message", { data: JSON.stringify({ ...acquiring(), waveform: waveform([654321]) }) });
  const result = await f.service.frame();
  assert.equal(result.waveform?.values?.includes(654321) || false, false);
});

test("unconfirmed termination is an error and cannot create or reuse a supposedly ready service", async (t) => {
  const f = fixture(t, { kill: () => false });
  await f.service.start();
  await assert.rejects(f.service.shutdown({ force: true }));
  assert.equal(f.service.serviceInfo().state, "error");
  assert.notEqual((await f.service.start()).service.state, "ready");
  assert.equal(f.children.length, 1);
  f.children[0].finish(null, "SIGKILL");
  await f.service.shutdown({ force: true });
  assert.equal(f.service.serviceInfo().state, "stopped");
});

test("a close-only spawn failure cannot retain an active child", async (t) => {
  const f = fixture(t, { spawn: child => queueMicrotask(() => {
    child.exitCode = -2;
    child.emit("error", Object.assign(Error("spawn failed"), { code: "ENOENT" }));
    child.exited = true;
    child.emit("close", -2);
  }) });
  assert.notEqual((await f.service.start()).service.state, "ready");
  await f.service.shutdown({ force: true });
  assert.equal(f.service.serviceInfo().state, "stopped");
});

test("a pre-stop frame cannot restore an acquiring display after stop succeeds", async (t) => {
  const received = deferred(), pending = deferred();
  const f = fixture(t, { fetch: async request => {
    if (request.route === "frame") { received.resolve(); return pending.promise; }
    return response(request.route === "start" ? acquiring() : idle());
  } });
  await f.service.begin({ confirmLaser: true, deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "任务", object: "叶片", turbine: "机组", point: "测点" });
  const oldFrame = f.service.frame().catch(error => ({ rejected: true, error }));
  await received.promise;
  assert.equal((await f.service.stop()).state, "idle");
  pending.resolve(response({ ...acquiring(), waveform: waveform([246810]) }));
  const staleResult = await oldFrame;
  assert.notEqual(staleResult.state, "acquiring");
  assert.equal(staleResult.waveform?.values?.includes(246810) || false, false);
});

test("a pre-start idle status cannot overwrite a successful acquisition start", async (t) => {
  const received = deferred(), pending = deferred();
  let statusCount = 0;
  const f = fixture(t, { fetch: async request => {
    if (request.route === "status" && ++statusCount === 2) { received.resolve(); return pending.promise; }
    return response(request.route === "start" ? acquiring() : idle());
  } });
  await f.service.start();
  const oldStatus = f.service.status().catch(error => ({ rejected: true, error }));
  await received.promise;
  assert.equal((await f.service.begin({ confirmLaser: true, deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "任务", object: "叶片", turbine: "机组", point: "测点" })).state, "acquiring");
  pending.resolve(response(idle()));
  assert.notEqual((await oldStatus).state, "idle");
});


test("position bridge preserves independent axis targets and rejects unsafe angles before I/O", async t => {
  const f = fixture(t);
  const config = { port: 'COM6', axis: 1, speedRpm: 0.2, direction: 'forward', durationSeconds: 0, protocol: 'position', targetAngleDeg: 12 };
  for (const changes of [{ targetAngleDeg: undefined }, { targetAngleDeg: true }, { targetAngleDeg: NaN }, { targetAngleDeg: 35.001 }, { axis: 2, targetAngleDeg: -180.001 }]) {
    await assert.rejects(f.service.turntable({ ...config, action: 'prepare', confirmMotion: true, ...changes }), { status: 400 });
  }
  assert.equal(f.requests.length, 0);
  await f.service.turntable({ ...config, action: 'prepare', confirmMotion: true });
  assert.equal(JSON.parse(f.requests.find(row => row.route === 'turntable').options.body).targetAngleDeg, 12);
  for (const action of ['reference', 'limits']) {
    await assert.rejects(f.service.turntable({ port: 'COM6', axis: 2, action }), { status: 400 });
    await f.service.turntable({ port: 'COM6', axis: 2, action, confirmMotion: true });
    const body = JSON.parse(f.requests.filter(row => row.route === 'turntable').at(-1).options.body);
    assert.equal(body.axis, 2);
    assert.equal(body.action, action);
  }
});

test("recorded point recall validates both targets and forwards both angles and reference signature", async t => {
  const f = fixture(t);
  const request = { action: 'recall', port: 'COM6', recordedPort: 'COM6', axis: 1, speedRpm: 5, maxMoveAccelerationDegS2: 30, axis1AngleDeg: 25.935, axis2AngleDeg: -6.994, confirmMotion: true,
    referenceSignature: '[[0,3,10000,17],[0,3,10000,17]]' };
  for (const changes of [{ confirmMotion: false }, { axis1AngleDeg: 36.7 }, { axis2AngleDeg: -180.001 }, { axis1AngleDeg: true }, { axis2AngleDeg: undefined },
    ...[0, .099, 120.001, NaN, Infinity, true, '30', null].map(maxMoveAccelerationDegS2 => ({ maxMoveAccelerationDegS2 }))]) {
    await assert.rejects(f.service.turntable({ ...request, ...changes }), { status: 400 });
  }
  assert.equal(f.requests.length, 0);
  await f.service.turntable(request);
  const body = JSON.parse(f.requests.find(row => row.route === 'turntable').options.body);
  assert.equal(body.action, 'recall');
  assert.equal(body.axis1AngleDeg, 25.935);
  assert.equal(body.axis2AngleDeg, -6.994);
  assert.equal(body.referenceSignature, request.referenceSignature);
  assert.equal(body.recordedPort, request.port);
  assert.equal(body.speedRpm, 5); assert.equal(body.maxMoveAccelerationDegS2, 30);
  for (const changes of [{ recordedPort: undefined }, { recordedPort: 'COM7' }, { referenceSignature: undefined },
    { referenceSignature: '[null,null]' }, { referenceSignature: '[[0,3,10000,17],[0.5,3,10000,17]]' }]) {
    await assert.rejects(f.service.turntable({ ...request, ...changes }), { status: 400 });
  }
  assert.equal(f.requests.filter(row => row.route === 'turntable').length, 1);
});

test('cycle bridge rejects missing or mismatched point references before starting service', async t => {
  const f = fixture(t);
  const point = { name: 'safe', axis1AngleDeg: 1, axis2AngleDeg: 2, port: 'COM6', referenceSignature: '[[0,3,10000,17],[0,3,10000,17]]' };
  const config = { deviceIp: '192.168.0.10', hostIp: '192.168.0.2', name: 'cycle', object: '', turbine: '', point: '',
    confirmLaser: true, confirmMotion: true, pointCycle: { port: 'COM6', cycles: 1, dwellSeconds: 1, speedRpm: 1, points: [point] } };
  for (const change of [{ port: undefined }, { port: 'COM7' }, { referenceSignature: undefined }, { referenceSignature: 'broken' }]) {
    await assert.rejects(f.service.begin({ ...config, pointCycle: { ...config.pointCycle, points: [{ ...point, ...change }] } }), { status: 400 });
  }
  assert.equal(f.children.length, 0);
  await f.service.begin(config);
  assert.deepEqual(JSON.parse(f.requests.find(row => row.route === 'start').options.body).pointCycle.points, [point]);
});

test('capture session id is supplied only by main and validates before starting service', async t => {
  const f = fixture(t);
  const config = { source: 'simulation', simulation: { point: 'P1', scenario: 'baseline' }, name: 'session', object: '', turbine: '', point: '', captureSessionId: 'b'.repeat(32) };
  for (const captureSessionId of ['bad', 'A'.repeat(32), 42, null]) await assert.rejects(f.service.begin(config, { captureSessionId }), { status: 400 });
  assert.equal(f.children.length, 0);
  await f.service.begin(config);
  assert.equal(JSON.parse(f.requests.find(row => row.route === 'start').options.body).captureSessionId, undefined);
  await f.service.begin(config, { captureSessionId: 'a'.repeat(32) });
  assert.equal(JSON.parse(f.requests.filter(row => row.route === 'start').at(-1).options.body).captureSessionId, 'a'.repeat(32));
});


test('click time survives desktop IPC for readiness diagnostics and rejects invalid clocks', async t => {
  const f = fixture(t);
  const config = { source: 'simulation', simulation: { point: 'P1', scenario: 'baseline' }, name: 'timing', object: '', turbine: '', point: '' };
  for (const value of [-1, Infinity, NaN, '12']) await assert.rejects(f.service.begin({ ...config, clientRequestedAt: value }), { status: 400 });
  assert.equal(f.children.length, 0);
  await f.service.begin({ ...config, clientRequestedAt: 1792501200.25 });
  assert.equal(JSON.parse(f.requests.find(row => row.route === 'start').options.body).clientRequestedAt, 1792501200.25);
});


test('Mac and Windows bridge forwards dark-motion policy without silently falling back to continuous light', async t => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(t, { options: { platform, servicesRoot: pythonServiceFixture() } });
    const port = 'tcp://192.168.10.50:5000';
    const config = { deviceIp: '192.168.106.90', hostIp: '192.168.106.10', name: '移动关灯', object: '', turbine: '', point: '', confirmLaser: true, confirmMotion: true,
      pointCycle: { port, cycles: 1, dwellSeconds: 60, speedRpm: 5, rssiTriggerEnabled: true,
        points: [{ port, referenceSignature: '[[0,3,10000,17],[0,3,10000,17]]', name: 'P3', axis1AngleDeg: 6, axis2AngleDeg: 0 }] } };
    for (const policy of [null, true, 'off', 1, {}]) {
      const before = f.requests.length;
      await assert.rejects(f.service.begin({ ...config, pointCycle: { ...config.pointCycle, motionLaserPolicy: policy } }), { status: 400 });
      assert.equal(f.requests.length, before);
    }
    for (const policy of ['off_during_motion', 'continuous', undefined]) {
      const cycle = { ...config.pointCycle, ...(policy === undefined ? {} : { motionLaserPolicy: policy }) };
      await f.service.begin({ ...config, pointCycle: cycle });
      const sent = JSON.parse(f.requests.filter(r => r.route === 'start').at(-1).options.body);
      assert.deepEqual(sent.pointCycle, cycle);
    }
  }
});

test('Mac and Windows forward diagnostic early detection only as an explicit boolean', async t => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(t, { options: { platform, servicesRoot: pythonServiceFixture() } });
    const port = 'tcp://192.168.10.50:5000';
    const config = { deviceIp: '192.168.106.90', hostIp: '192.168.106.10', name: 'early diagnostic fixture', object: '', turbine: '', point: '', confirmLaser: true, confirmMotion: true,
      pointCycle: { port, cycles: 1, dwellSeconds: 60, speedRpm: 5, rssiTriggerEnabled: true,
        points: [{ port, referenceSignature: '[[0,3,10000,17],[0,3,10000,17]]', name: 'P3', axis1AngleDeg: 6, axis2AngleDeg: 0 }] } };
    for (const value of [null, 'true', 1, {}]) await assert.rejects(f.service.begin({ ...config, pointCycle: { ...config.pointCycle, diagnosticDetectBeforeSettled: value } }), { status: 400 });
    for (const angle of [null, '1', true, -1, 11, Infinity, NaN]) {
      const before=f.requests.length;
      await assert.rejects(f.service.begin({...config,pointCycle:{...config.pointCycle,diagnosticAngleWindowDeg:angle}}),{status:400});
      assert.equal(f.requests.length,before);
    }
    for (const angle of [0,.5,1,2,3,5,10]) {
      await f.service.begin({...config,pointCycle:{...config.pointCycle,diagnosticAngleWindowDeg:angle}});
      assert.equal(JSON.parse(f.requests.filter(r=>r.route==='start').at(-1).options.body).pointCycle.diagnosticAngleWindowDeg,angle);
    }
    for (const value of [true, false]) {
      await f.service.begin({ ...config, pointCycle: { ...config.pointCycle, diagnosticDetectBeforeSettled: value } });
      assert.equal(JSON.parse(f.requests.filter(r => r.route === 'start').at(-1).options.body).pointCycle.diagnosticDetectBeforeSettled, value);
    }
  }
});
