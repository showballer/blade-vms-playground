'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { recordAnalysisRequest, recordAnalysisExportFile } = require('../apps/desktop/electron/field-record-analysis.cjs');

test('new record workspace accepts IDs and independent jobs, never renderer-supplied files', () => {
  const start = { action: 'start', recordingIds: ['a'.repeat(32)], scope: 'diagnostic', profile: 'LOS_DIAGNOSTIC' };
  assert.deepEqual(recordAnalysisRequest(start), start);
  assert.deepEqual(recordAnalysisRequest({ action: 'catalog' }), { action: 'catalog' });
  for (const request of [null, [], {}, { action: 'turntable' }, { ...start, path: '/tmp/raw.csv' },
    { ...start, recordingIds: ['../raw'] }, { ...start, recordingIds: [...start.recordingIds, ...start.recordingIds] },
    { ...start, scope: 'all' }, { action: 'result', jobId: '../other' }, { action: 'export', jobId: 'a', kind: 'unknown' }]) {
    assert.throws(() => recordAnalysisRequest(request), { status: 400 });
  }
});

test('analysis export is confined to its job and rejects a link to original data', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-record-analysis-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'record-analysis-v1', 'job-1', 'exports');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, '分析汇总.json');
  fs.writeFileSync(file, '{"source":"read-only"}');
  const result = { path: file, fileName: path.basename(file), mimeType: 'application/json' };
  assert.equal(await recordAnalysisExportFile(root, 'job-1', result), fs.realpathSync(file));
  const source = path.join(root, 'original.bin'); fs.writeFileSync(source, 'unchanged');
  await assert.rejects(recordAnalysisExportFile(root, 'job-1', { ...result, path: source, fileName: 'original.bin' }), { status: 400 });
  await assert.rejects(recordAnalysisExportFile(root, 'job-1', { ...result, fileName: '../original.bin' }), { status: 400 });
  const link = path.join(directory, 'source.bin'); fs.symlinkSync(source, link);
  await assert.rejects(recordAnalysisExportFile(root, 'job-1', { ...result, path: link, fileName: 'source.bin' }), { status: 400 });
  assert.equal(fs.readFileSync(source, 'utf8'), 'unchanged');
});


test('raw inspection accepts a saved record ID and rejects paths or missing identity', () => {
  assert.deepEqual(recordAnalysisRequest({action:'inspect',recordingId:'b'.repeat(32)}), {action:'inspect',recordingId:'b'.repeat(32)});
  for (const request of [{action:'inspect'}, {action:'inspect',recordingId:'../raw'}, {action:'inspect',recordingId:'b'.repeat(32),file:'/tmp/raw'}]) {
    assert.throws(() => recordAnalysisRequest(request), {status:400});
  }
});
