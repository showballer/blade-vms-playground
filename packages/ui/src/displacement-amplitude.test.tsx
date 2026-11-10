import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DisplacementAmplitude, displacementAmplitudeOption, displacementAmplitudeRows} from './displacement-amplitude';

// Six saved blade results, including the R024 blade 1 screenshot regression.
const cases = [
  ['R001/1', [0.0588044244, 0.3433908541, 0.6111607460, 0.6739562838, 1.0851743098]],
  ['R001/2', [0.0262407279, 0.1403561459, 0.2410226970, 0.2811056799, 0.2580082196]],
  ['R001/3', [0.0480717932, 0.2712808569, 0.4451928073, 0.4055529461, 0.7407847224]],
  ['R024/1', [0.8858999989, 1.4323512885, 1.2847845222, 1.5880452780, 2.4514366239]],
  ['R024/2', [0.9142253630, 1.3340452158, 1.2437184069, 1.7099708601, 2.4014736076]],
  ['R024/3', [0.8960562948, 1.2817045046, 1.4437213291, 1.7886793779, 2.1768276824]],
] as const;
const radii = [7.05, 21.15, 35.25, 49.35, 63.45];
for (const [blade, actual] of cases) {
  const input = actual.map((actualMm, i) => Object.freeze({point: `P${i + 1}`, radiusM: radii[i], actualMm, angleCount: 4, plannedAngleCount: 4}));
  const before = JSON.stringify(input), rows = displacementAmplitudeRows(Object.freeze(input));
  const fitted = displacementAmplitudeOption(rows)!;
  assert.equal(fitted.series.length, 1);
  assert.equal(fitted.series[0].name, '递增拟合');
  assert(rows.every((p, i) => !i || p.displayMm! > rows[i - 1].displayMm!), `${blade} trend`);
  assert.deepEqual(fitted.series[0].data, rows.map(p => [p.radiusM, p.displayMm]));
  assert.deepEqual(rows.map(p => p.actualMm), [...actual]);
  assert.equal(JSON.stringify(input), before, 'Fitting cannot rewrite the measured result');
  const markup = renderToStaticMarkup(<DisplacementAmplitude points={input} context={blade} loading={false}/>);
  assert(markup.includes('叶片各测点平均位移振幅'));
  assert(!markup.includes('位移振幅显示方式') && !markup.includes('<select'), 'Main chart has no view selector');
  assert(markup.includes('递增拟合用于趋势展示'), 'Main chart always shows the fit');
  assert(markup.includes('实测计算 · mm') && markup.includes('递增拟合 · mm'));
  assert(!markup.includes('SYN-DISPLACEMENT-DISPLAY'), 'One amplitude card contains the results');
}
const partial = displacementAmplitudeRows([
  {point:'P1',radiusM:7.05,actualMm:1,angleCount:4,plannedAngleCount:4},
  {point:'P2',radiusM:21.15,actualMm:null,angleCount:0,plannedAngleCount:4},
  {point:'P3',radiusM:35.25,actualMm:2,angleCount:4,plannedAngleCount:4},
]);
assert.equal(partial[1].displayMm, null, 'Missing points are not reconstructed');
assert.equal(displacementAmplitudeOption(partial)!.series[0].data[1][1], null);
const noRadius = displacementAmplitudeRows(partial.map(p => ({...p,radiusM:null})));
assert.equal(displacementAmplitudeOption(noRadius), null);
const noRadiusMarkup = renderToStaticMarkup(<DisplacementAmplitude points={noRadius} loading={false} context="missing geometry"/>);
assert(noRadiusMarkup.includes('实测计算 · mm') && noRadiusMarkup.includes('已有实测计算值见下表'), 'Actual values remain in the table without geometry');
assert.equal(displacementAmplitudeOption([]), null);
const loading = renderToStaticMarkup(<DisplacementAmplitude points={partial} loading context="loading"/>);
assert(loading.includes('正在读取真实分析结果') && !loading.includes('<table>'));
console.log('PASS displacement amplitude: six blades use fixed fit view; measured values, gaps and loading preserved');
