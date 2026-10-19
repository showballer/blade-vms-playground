'use strict';
// Portable contract checks for the release gate. No EXE, service or device is launched.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, createFixtures, guardServiceRequest, optionsFrom, validateExport, cloudHarness } = require('./test-windows-blade-passes.cjs');

function csv(item) {
  const meta = { ...item.manifest, format: 'blade-vms-csv-1', recordingId: item.manifest.id };
  return Buffer.from('# BladeVMS ' + JSON.stringify(meta) + '\ntime_s,velocity_m_s,RSSI_percent,overrange\n' +
    Array.from({ length: 2000 }, (_, i) => {
      const offset = 32 + i * 29;
      return [i / 1000, item.bytes.readDoubleLE(offset + 12), i % 4 ? '' : item.bytes.readFloatLE(offset + 24),
        Number(Boolean(item.bytes[offset + 28] & 1))].join(',');
    }).join('\n') + '\n');
}

test('frozen gate requires resources and does not accept a source-only substitute', () => {
  assert.throws(() => optionsFrom([]));
  assert.throws(() => optionsFrom(['--source']));
  assert.throws(() => optionsFrom(['--resources']));
  assert.ok(path.isAbsolute(optionsFrom(['--resources', 'fixture']).resources));
});

test('read-only loopback allowlist rejects every operation route, method and redirect', () => {
  for (const route of ['status', 'recordings', `recordings/${'a'.repeat(32)}`, `recordings/${'a'.repeat(32)}/export`]) {
    assert.doesNotThrow(() => guardServiceRequest(`http://127.0.0.1:1234/api/field/${route}`, { redirect: 'error' }));
  }
  for (const route of ['start', 'stop', 'device', 'turntable', 'turntable/ports', 'single-point', 'motion-trial', 'simulation', 'rssi-calibration']) {
    assert.throws(() => guardServiceRequest(`http://127.0.0.1:1234/api/field/${route}`, { redirect: 'error' }));
  }
  for (const options of [{ method: 'POST', redirect: 'error' }, { body: '{}', redirect: 'error' }, { redirect: 'follow' }]) {
    assert.throws(() => guardServiceRequest('http://127.0.0.1:1234/api/field/status', options));
  }
  for (const url of ['http://192.168.106.90/api/field/status', 'https://127.0.0.1/api/field/status',
    'http://127.0.0.1/api/field/status?deviceIp=192.168.106.90', 'http://a:b@127.0.0.1/api/field/status']) {
    assert.throws(() => guardServiceRequest(url, { redirect: 'error' }));
  }
});

test('fixture contains separated P1/P2 sessions in one collection with original RSSI sampling', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-pass-gate-contract-'));
  try {
    const records = createFixtures(directory);
    assert.equal(new Set(records.map(item => item.manifest.pointCycle.collectionId)).size, 1);
    assert.equal(new Set(records.map(item => item.manifest.pointCycle.sessionId)).size, 2);
    assert.equal(new Set(records.map(item => item.manifest.id)).size, 3);
    assert.deepEqual(records.map(item => [item.manifest.pointCycle.radialPointId, item.manifest.pointCycle.azimuthDeg]),
      [['p1', 0], ['p2', 0], ['p1', 90]]);
    for (const item of records) {
      assert.equal(item.bytes.length, 32 + 2000 * 29);
      assert.equal(item.manifest.source, 'simulation');
      let rssi = 0, overrange = 0;
      for (let i = 0; i < 2000; i++) {
        const offset = 32 + i * 29;
        assert.equal(item.bytes.readBigUInt64LE(offset), BigInt(i));
        rssi += Number(Boolean(item.bytes[offset + 28] & 2)); overrange += Number(Boolean(item.bytes[offset + 28] & 1));
      }
      assert.equal(rssi, 500); assert.equal(overrange, 100);
      validateExport(csv(item), item);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('CSV acceptance rejects lost grouping, shifted valid boundaries and fabricated RSSI', () => {
  const item = fixture(1, 'p1', .31, 0, 'a'.repeat(32));
  for (const mutate of [
    value => { delete value.pointCycle.collectionId; },
    value => { value.pointCycle.handoff.entryConfirmedSampleIndex += 1; },
    value => { value.rssiSampleStride = 1; },
    value => { value.source = 'polytec_ivs500'; },
  ]) {
    const lines = csv(item).toString().split('\n');
    const meta = JSON.parse(lines[0].slice('# BladeVMS '.length)); mutate(meta);
    lines[0] = '# BladeVMS ' + JSON.stringify(meta);
    assert.throws(() => validateExport(Buffer.from(lines.join('\n')), item));
  }
  const lines = csv(item).toString().split('\n');
  const row = lines[3].split(','); row[2] = '80'; lines[3] = row.join(',');
  assert.throws(() => validateExport(Buffer.from(lines.join('\n')), item));
  assert.throws(() => validateExport(Buffer.from(csv(item).toString().split('\n').slice(0, -3).join('\n')), item));
});

test('source cloud queue fixture enrolls completed records automatically and preserves metadata/bytes', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-pass-queue-contract-'));
  const recordingsDir = path.join(temporary, 'recordings'), items = createFixtures(recordingsDir);
  const cloud = cloudHarness(path.resolve(__dirname, '../apps/desktop/electron/field-cloud-sync.cjs'), temporary, recordingsDir);
  try {
    cloud.queue.resume();
    for (const item of items) {
      assert.equal(cloud.observe(item.manifest), true);
      await cloud.queue.settled();
      assert.equal(cloud.queue.status().items.find(entry => entry.recordingId === item.manifest.id).state, 'synced');
      const saved = cloud.captures.get(item.manifest.id);
      assert.deepEqual(saved.recording, item.manifest);
      assert.equal(saved.complete, true);
      assert.deepEqual(saved.bytes['chunk-00000000.bin'], item.bytes);
    }
  } finally { cloud.queue.dispose(); await cloud.queue.settled(); fs.rmSync(temporary, { recursive: true, force: true }); }
});

module.exports = { csv };
