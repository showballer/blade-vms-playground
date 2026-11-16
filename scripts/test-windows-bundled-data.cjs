'use strict';
// Package-only, disposable profile. No acquisition, SDK, device or upload calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const resources = path.resolve(process.argv[2]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-bundled-data-gate-'));
const output = path.join(root, 'artifacts/windows-bundled-data-smoke');
const report = { passed: false, hardwareTested: false, tasks: [], recordings: 0 };
let service;
async function main() {
  const moduleFile = path.join(temporary, 'field-bundled-recordings.cjs');
  const bytes = asar.extractFile(path.join(resources, 'app.asar'), 'electron/field-bundled-recordings.cjs');
  assert.deepEqual(bytes, fs.readFileSync(path.join(root, 'apps/desktop/electron/field-bundled-recordings.cjs')));
  fs.writeFileSync(moduleFile, bytes);
  const { installBundledCatalog } = require(moduleFile);
  const dataDir = path.join(temporary, 'profile'), bundleDir = path.join(resources, 'bundled-recordings');
  const installed = installBundledCatalog({ bundleDir, dataDir });
  assert.equal(installed.imported.length, 180); assert.equal(installed.conflicts.length, 0);
  assert.deepEqual(installed.tasks.map(t => t.taskName).sort(), ['武川风场 R001 风机测量任务', '武川风场 R024 风机测量任务', '化德风场B071-20'].sort());
  for (const task of installed.tasks) {
    const slots = new Set();
    for (const id of task.imported) {
      const m = JSON.parse(fs.readFileSync(path.join(dataDir, 'recordings', id, 'manifest.json'), 'utf8'));
      assert.equal(m.name, task.taskName);
      assert.ok(fs.statSync(path.join(dataDir, 'recordings', id, 'split-source.csv.gz')).size > 0);
      slots.add([m.pointCycle.bladeId, m.pointCycle.radialPointName, m.pointCycle.azimuthDeg].join('/'));
    }
    assert.equal(slots.size, 60);
    for (const blade of ['1', '2', '3']) for (const point of ['P1', 'P2', 'P3', 'P4', 'P5']) for (const angle of [0, 90, 180, 270]) assert.ok(slots.has(`${blade}/${point}/${angle}`));
    report.tasks.push({ name: task.taskName, records: slots.size, blades: 3, pointsPerBlade: 5, anglesPerPoint: 4 });
  }
  assert.equal(installBundledCatalog({ bundleDir, dataDir }).imported.length, 0);
  const packaged = require('./windows-packaged-bridge.cjs').extractPackagedBridge({ archive: path.join(resources, 'app.asar'), directory: path.join(temporary, 'bridge'), sourceDirectory: path.join(root, 'apps/desktop/electron') });
  service = require(packaged.bridgeFile).createFieldService({ dataDir, resourcesDir: resources,
    getConfig: () => ({ dll: path.join(temporary, 'HARDWARE_DISABLED.dll') }), WebSocketImpl: null,
    fetchImpl: (url, options = {}) => {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, '127.0.0.1');
      if (parsed.pathname === '/api/field/record-analysis') {
        assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), { action: 'catalog' });
        return fetch(url, options);
      }
      assert.equal(options.method || 'GET', 'GET');
      assert.match(parsed.pathname, /^\/api\/field\/(status|recordings(?:\/[a-f0-9]{32})?)$/);
      return fetch(url, options);
    } });
  const status = await service.start();
  assert.equal(status.service.state, 'ready'); assert.equal(status.recording, null);
  const records = (await service.recordings()).recordings;
  assert.equal(records.length, 180);
  assert.deepEqual(records.map(r => r.id).sort(), [...installed.imported].sort());
  // Read a bounded waveform from each blade in each actual shipped task.
  for (const task of installed.tasks) {
    for (const blade of ['1', '2', '3']) {
      const record = records.find(r => r.name === task.taskName && r.pointCycle?.bladeId === blade);
      assert.ok(record);
      const detail = await service.recordings(record.id);
      assert.ok(detail.waveform.values.length > 0, `${task.taskName} / ${blade}: empty waveform`);
    }
  }
  const catalog = await service.recordAnalysis({ action: 'catalog' });
  assert.equal(catalog.tasks.length, 3);
  assert.ok(catalog.tasks.every(t => t.records.length === 60));
  report.recordings = records.length;
  report.readableBladeWaveforms = 9;
  const wind = JSON.parse(fs.readFileSync(path.join(bundleDir, 'reference-data/wind-datasets.json'), 'utf8'));
  assert.equal(wind.datasets.length, 2);
  report.windRows = wind.datasets.map(d => ({ name: d.name, rows: d.rows.length }));
  report.passed = true;
}
main().catch(error => { report.error = error.stack; console.error(error); process.exitCode = 1; }).finally(async () => {
  if (service) await service.shutdown({ force: true });
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(report));
});
