// Pure contract checks for the release gate. Never launches an EXE or a service.
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { previewRequest, validatePreview, guardedRequestBody } = require('./test-windows-motion-trial.cjs');

function fixture() {
  return {
    state: 'idle', receiver: { running: false, dllAvailable: false }, deviceBusy: false,
    turntableBusy: false, turntableWarning: null, recording: null,
    motionTrialPreview: {
      durationSeconds: 30, rotorRpm: 2, anchorBound: false, executionReady: false,
      requiresRunIn: true, requiresRunOut: true,
      capability: { supported: false, checkedHardware: false, source: 'client_protocol', code: 'trajectory_protocol_unavailable' },
      blockReasons: ['No firmware protocol'],
      startAngles: { axis1AngleDeg: null, axis2AngleDeg: null },
      endAngles: { axis1AngleDeg: null, axis2AngleDeg: null },
      trajectory: Array.from({ length: 721 }, (_, index) => {
        const phase = index * Math.PI / 360;
        return { timeSeconds: 30 * index / 720, rotorPhaseDeg: 180 + index / 2,
          phaseFromSixDeg: index / 2, axis1AngleDeg: null, axis2AngleDeg: null,
          axis1DeltaAngleDeg: 5 * (1 - Math.cos(phase)), axis2DeltaAngleDeg: 6 * Math.sin(phase),
          axis1VelocityDegS: 1, axis2VelocityDegS: 1, axis1AccelerationDegS2: 1,
          axis2AccelerationDegS2: 1, pointXM: .31 * Math.sin(phase), pointHeightM: 1.46 - .31 * Math.cos(phase) };
      }),
    },
  };
}

test('accepts only a complete idle, unanchored and non-executable thirty-second preview', () => {
  const result = validatePreview(fixture());
  assert.equal(result.trajectoryPoints, 721);
  assert.equal(result.circleClosed, true);
  assert.equal(result.executionReady, false);
  assert.equal(result.hardwareCapabilityChecked, false);
});

test('rejects execution or hardware claims without firmware validation', () => {
  for (const mutate of [
    p => { p.executionReady = true; }, p => { p.capability.supported = true; },
    p => { p.capability.checkedHardware = true; }, p => { p.capability.source = 'hardware'; },
    p => { p.requiresRunIn = false; }, p => { p.requiresRunOut = false; },
    p => { p.blockReasons = []; },
  ]) {
    const value = fixture(); mutate(value.motionTrialPreview);
    assert.throws(() => validatePreview(value));
  }
});

test('rejects encoder targets or a false anchor in preview-only output', () => {
  for (const mutate of [
    p => { p.anchorBound = true; }, p => { p.startAngles.axis1AngleDeg = 0; },
    p => { p.endAngles.axis2AngleDeg = 0; },
    p => { p.trajectory[10].axis1AngleDeg = 1; }, p => { p.trajectory[10].axis2AngleDeg = -1; },
  ]) {
    const value = fixture(); mutate(value.motionTrialPreview);
    assert.throws(() => validatePreview(value));
  }
});

test('rejects stale, truncated, non-finite and unclosed trajectory payloads', () => {
  for (const mutate of [
    p => { p.durationSeconds = 6; }, p => { p.rotorRpm = 10; },
    p => { p.trajectory.pop(); }, p => { p.trajectory[50].timeSeconds += .1; },
    p => { p.trajectory[50].rotorPhaseDeg += .1; },
    p => { p.trajectory[50].axis1VelocityDegS = null; },
    p => { p.trajectory[50].axis2AccelerationDegS2 = Infinity; },
    p => { p.trajectory.at(-1).axis1DeltaAngleDeg = 1; },
  ]) {
    const value = fixture(); mutate(value.motionTrialPreview);
    assert.throws(() => validatePreview(value));
  }
  const value = fixture(); delete value.motionTrialPreview;
  assert.throws(() => validatePreview(value));
});

test('rejects acquisition, recordings and unexpected SDK availability', () => {
  for (const mutate of [
    s => { s.receiver.running = true; }, s => { s.receiver.dllAvailable = true; },
    s => { s.deviceBusy = true; }, s => { s.turntableBusy = true; },
    s => { s.recording = { id: 'unexpected-recording' }; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => validatePreview(value));
  }
});

test('request allowlist excludes hardware routes, ports and unchecked actions', () => {
  assert.doesNotThrow(() => guardedRequestBody('status'));
  assert.doesNotThrow(() => guardedRequestBody('recordings'));
  assert.doesNotThrow(() => guardedRequestBody('motion-trial', previewRequest()));
  assert.doesNotThrow(() => guardedRequestBody('motion-trial', { ...previewRequest(), action: 'arm', confirmMotion: true }));
  for (const route of ['start', 'device', 'turntable', 'single-point']) {
    assert.throws(() => guardedRequestBody(route, previewRequest()));
  }
  for (const extra of [{ port: 'COM3' }, { action: 'prepare' }, { anchor: { axis1AngleDeg: 0 } }]) {
    assert.throws(() => guardedRequestBody('motion-trial', { ...previewRequest(), ...extra }));
  }
});
