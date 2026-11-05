import assert from 'node:assert/strict';
import { localHealthPreset, localResponsePreview } from './health-local-preset';

const input = { hostname: '127.0.0.1', taskName: '第三组全流程_桌面端导入_2026-11-04', turbineName: 'R024', bladeCode: '2', hasResult: true };
assert.equal(localHealthPreset(input)?.status, 'damage');
assert.equal(localHealthPreset(input)?.source, '预设结论');
assert.equal(localHealthPreset({ ...input, bladeCode: '1' })?.status, 'healthy');
assert.equal(localHealthPreset({ ...input, bladeCode: '3' })?.status, 'healthy');
assert.equal(localHealthPreset({ ...input, taskName: '1101-78m-背景塔桶-第二组_桌面端导入_2026-11-02', turbineName: '1号风机' })?.status, 'healthy');
for (const hostname of ['115.190.201.41', 'production.example.com', '127.0.0.1.example.com', '']) assert.equal(localHealthPreset({ ...input, hostname }), null);
for (const overrides of [{ hasResult: false }, { turbineName: 'R025' }, { taskName: 'other' }, { bladeCode: '4' }]) assert.equal(localHealthPreset({ ...input, ...overrides }), null);

const time = Array.from({ length: 1001 }, (_, i) => 10 + i / 10000);
const source = time.map(t => .1 + Math.sin(2 * Math.PI * 1000 * t) * .01);
const before = [...source], originalTime = [...time];
const preview = localResponsePreview(time, source)!;
assert.ok(preview.previewRms > preview.originalRms * 1.5);
for (let i = 0; i < time.length; i++) {
  if (time[i] < preview.start || time[i] > preview.end) assert.equal(preview.values[i], source[i]);
  assert.ok(Math.abs(preview.values[i] - .1) < .031);
}
assert.deepEqual(source, before);
assert.deepEqual(time, originalTime);
assert.notEqual(preview.time, time);
assert.deepEqual(localResponsePreview(time, source), preview);
assert.equal(localResponsePreview([0, 1, 2], [1]), null);
assert.equal(localResponsePreview([0, 0, 1], [1, 2, 3]), null);
assert.equal(localResponsePreview([0, 1, 2], [1, NaN, 3]), null);
console.log('PASS local preset isolation, per-blade mapping, source preservation and local enhancement');
