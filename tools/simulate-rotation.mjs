#!/usr/bin/env node
// Generate deterministic rotating-blade data for desktop/API algorithm checks.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).reduce((out, item, i, all) => {
  if (item.startsWith('--')) out[item.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true;
  return out;
}, {});
const samples = Math.max(100, Number(args.samples ?? 8192));
const sampleRate = Number(args.sampleRate ?? 2000);
const rpm = Number(args.rpm ?? 1200);
const blades = Math.max(1, Number(args.blades ?? 4));
const noise = Number(args.noise ?? 0.01);
const seed = Number(args.seed ?? 20260915) >>> 0;
let state = seed;
const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 0x100000000) - 0.5;
const out = path.resolve(String(args.output ?? 'simulation-rotation.csv'));
const taskOut = args.task ? path.resolve(String(args.task)) : null;
fs.mkdirSync(path.dirname(out), { recursive: true });
const fr = rpm / 60, fb = blades * fr;
const rows = ['sample,time_s,rpm,keyphase,CH1_m_s,CH2_m_s,RSSI1_percent,quality'];
for (let i = 0; i < samples; i += 1) {
  const t = i / sampleRate;
  const phase = (t * fr) % 1;
  const base = 0.08 * Math.sin(2 * Math.PI * fr * t) + 0.025 * Math.sin(2 * Math.PI * fb * t);
  const sideband = 0.012 * Math.sin(2 * Math.PI * (fb + fr) * t);
  const ch1 = base + sideband + noise * random();
  const ch2 = 0.9 * base + noise * random();
  const rssi = 72 + 4 * Math.sin(2 * Math.PI * 0.7 * t) + 2 * random();
  rows.push([i, t.toFixed(9), rpm.toFixed(3), phase < 1 / sampleRate ? 1 : 0, ch1.toFixed(9), ch2.toFixed(9), rssi.toFixed(4), 'OK'].join(','));
}
fs.writeFileSync(out, `${rows.join('\n')}\n`, 'utf8');
const truth = { source: 'simulation', seed, sample_rate_hz: sampleRate, rpm, blade_count: blades,
  rotational_frequency_hz: fr, blade_passing_frequency_hz: fb, expected_peaks_hz: [fr, 2 * fr, fb],
  channels: ['CH1', 'CH2', 'RPM', 'KEYPHASE', 'RSSI1'], note: 'Synthetic data for software validation only.' };
fs.writeFileSync(out.replace(/\.csv$/i, '.truth.json'), `${JSON.stringify(truth, null, 2)}\n`, 'utf8');
if (taskOut) {
  const task = { name: `仿真旋转 ${rpm}rpm`, object: '虚拟叶片', turbine: 'SIM-01', point: 'CH1',
    rpm, blades, sampleRate, samples: rows.slice(1).map(row => Number(row.split(',')[4])),
    channels: [{ name: 'CH1', unit: 'm/s' }], source: 'simulation', condition: 'synthetic',
    note: `seed=${seed}; 标准答案见 ${path.basename(out).replace(/\.csv$/i, '.truth.json')}` };
  fs.writeFileSync(taskOut, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  console.log(`Wrote desktop task JSON to ${taskOut}`);
}
console.log(`Wrote ${samples} samples to ${out}`);
