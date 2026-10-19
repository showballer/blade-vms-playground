// Pure chart/numerical contracts and server-rendering checks; no hardware or UI automation.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as echarts from "echarts/core";
import { FieldRealtimeAnalysis, realtimeChartOption, realtimePoints } from "./field-realtime";
import { FieldWaveChart, waveLimit } from "./field-waveform";
import type { FieldRealtime, FieldWaveform } from "./field-types";

const input: FieldRealtime = {
  available: true, unit: "m/s", source: "simulation", sampleRate: 2048, sampleStart: 0, sampleCount: 4096, windowSamples: 4096,
  recordingId: "fixture", sampleRange: { start: 0, end: 4096 }, frequencySpacingHz: 0.5,
  features: { rms: 0.001, peak: 0.002, peakToPeak: 0.004, dominantHz: 32 },
  spectrum: { frequencies: [0, 32, 64], amplitudes: [0, 0.002, 0.0005] },
  timeDomain: { times: [0, 0.5, 1], values: [0.001, -0.002, 0.0005], unit: "m/s", representation: "full" },
  spectrogram: { times: [0.25, 0.5, 0.75], frequencies: [0, 32], db: [[-110, -105, -120], [-60, -55, -50]], unit: "dB re 1 m/s", windowSamples: 256, hopSamples: 64 },
  quality: { overrangeSamples: 0, missingRssiSamples: 0, lowReturnSamples: 0 }, warnings: [],
};
let passed = 0;
function check(title: string, run: () => void) { run(); passed++; console.log(`PASS ${title}`); }

check("time and spectrum convert m/s to mm/s without changing time/frequency or source", () => {
  const before = JSON.stringify(input);
  const time = realtimeChartOption(input, "time")!, spectrum = realtimeChartOption(input, "spectrum")!;
  assert.deepEqual(time.series[0].data, [[0, 1], [0.5, -2], [1, 0.5]]);
  assert.deepEqual(spectrum.series[0].data, [[0, 0], [32, 2], [64, 0.5]]);
  assert.equal(time.yAxis.name, "mm/s"); assert.equal(spectrum.yAxis.name, "mm/s");
  assert.equal(time.series[0].smooth, false); assert.equal(time.series[0].connectNulls, false);
  assert.equal(JSON.stringify(input), before);
});
check("invalid measurements and missing amplitudes create gaps instead of false zero values", () => {
  assert.deepEqual(realtimePoints([0, 1, 2, 3, 4], [0.001, NaN, Infinity, -0.003]), [[0, 1], [1, null], [2, null], [3, -3], [4, null]]);
  assert.equal(realtimeChartOption(undefined, "time"), null);
  assert.equal(realtimeChartOption({ ...input, available: false }, "spectrum"), null);
  assert.equal(realtimeChartOption({ ...input, timeDomain: undefined }, "time"), null);
});
check("STFT uses frequency-by-time matrix and preserves its fixed dB reference across windows", () => {
  const chart = realtimeChartOption(input, "spectrogram")!;
  assert.deepEqual(chart.series[0].data, [[0, 0, -110], [1, 0, -105], [2, 0, -120], [0, 1, -60], [1, 1, -55], [2, 1, -50]]);
  assert.equal(chart.visualMap.min, -160); assert.equal(chart.visualMap.max, 0);
  assert.match(chart.tooltip.formatter({ value: [1, 1, -55] }), /0\.5 s.*32 Hz.*-55 dB re 1 m\/s/);
  const next = realtimeChartOption({ ...input, spectrogram: { ...input.spectrogram!, db: [[-25, -20, -15], [-10, -5, -1]] } }, "spectrogram")!;
  assert.equal(next.visualMap.min, chart.visualMap.min); assert.equal(next.visualMap.max, chart.visualMap.max);
});
check("incremental ECharts data updates retain user zoom and replace the series tail", () => {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 900, height: 340 });
  try {
    chart.setOption(realtimeChartOption(input, "spectrum")!);
    chart.dispatchAction({ type: "dataZoom", start: 25, end: 75 });
    chart.setOption(realtimeChartOption({ ...input, spectrum: { frequencies: [0, 32], amplitudes: [0, 0.003] } }, "spectrum")!, { notMerge: false, replaceMerge: ["series"] });
    const updated = chart.getOption() as any;
    assert.equal(updated.dataZoom[0].start, 25); assert.equal(updated.dataZoom[0].end, 75);
    assert.deepEqual(updated.series[0].data, [[0, 0], [32, 3]]);
    assert.match(chart.renderToSVGString(), /<svg/);
  } finally { chart.dispose(); }
});
check("empty real-time panels expose acquisition sources and simulation panels keep provenance", () => {
  const empty = renderToStaticMarkup(<FieldRealtimeAnalysis />);
  assert.match(empty, /等待时域波形数据/); assert.match(empty, /开始采集，连续窗口达到 64 点后显示/);
  assert.equal((empty.match(/role="tab"/g) || []).length, 3);
  const active = renderToStaticMarkup(<FieldRealtimeAnalysis realtime={input} />);
  assert.match(active, /模拟数据/); assert.match(active, /主频/); assert.match(active, />32<small>Hz/);
  const paused = renderToStaticMarkup(<FieldRealtimeAnalysis realtime={input} paused />);
  assert.match(paused, /显示已暂停/); assert.match(paused, /采集和保存仍在继续/);
});
check("waveform bounds remain finite for long records and envelope extrema remain visible", () => {
  const wave: FieldWaveform = { sampleRate: 2000, sampleStart: 0, values: Array.from({ length: 250000 }, (_, index) => index === 123 ? 0.09 : -0.01), rssi: [], unit: "m/s", overrange: [] };
  assert.equal(waveLimit(wave), 0.09 * 1.2);
  const envelope = { ...wave, values: [], rangeStart: 0, rangeEnd: 250000, envelope: [{ start: 0, end: 250000, min: -0.04, max: 0.09, rssiMin: null, rssiMax: null, missing: 1, overrange: 0 }] };
  const html = renderToStaticMarkup(<FieldWaveChart waveform={envelope} yLimit={0.05} />);
  assert.match(html, /部分信号超出/); assert.match(html, /d="M/); assert.ok(!html.includes("NaN"));
});
console.log(`Real-time chart checks: ${passed} passed (numerical, ECharts SSR and markup only).`);
