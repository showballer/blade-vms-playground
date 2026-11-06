import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldModalWorkspace } from "./field-modal-workspace";
import type { FieldRecording } from "./field-types";
import { modalPreviewData } from "./modal-preview-data";

const recordings: FieldRecording[] = [
  { id: "a".repeat(32), name: "静止叶片自由衰减", object: "叶片静止模态试验", point: "P1", samples: 8000, sampleRate: 4000, startedAt: 1793930400, status: "complete", source: "device" },
  { id: "b".repeat(32), name: "户外旋转记录", object: "风机叶片", samples: 8000, sampleRate: 4000, startedAt: 1793930500, status: "complete", source: "device" },
  { id: "c".repeat(32), name: "incomplete record", object: "叶片静止模态试验", samples: 100, sampleRate: 1000, startedAt: 1793930400, status: "incomplete", source: "device" },
  { id: "d".repeat(32), name: "simulation source", object: "叶片静止模态试验", samples: 8000, sampleRate: 4000, startedAt: 1793930400, status: "complete", source: "simulation" },
];
const request = async <T,>() => ({} as T);
const captureHtml = renderToStaticMarkup(<FieldModalWorkspace view="capture" recordings={recordings} request={request} onStartCapture={() => {}} />);
const analysisHtml = renderToStaticMarkup(<FieldModalWorkspace view="analysis" recordings={recordings} request={request} onStartCapture={() => {}} />);

for (const value of ["模态试验采集", "开始单点采集", "锁止叶片"]) {
  assert.ok(captureHtml.includes(value), `Missing modal capture field: ${value}`);
}
for (const value of ["分析批次与原始响应", "自由衰减", "FRF 半功率带宽", "工作模态 SSI-COV", "数据批次", "固定叶片单点响应", "数值合成"]) {
  assert.ok(analysisHtml.includes(value), `Missing modal analysis field: ${value}`);
}
assert.ok(analysisHtml.includes("静止叶片自由衰减"));
assert.ok(analysisHtml.includes("户外旋转记录"));
assert.ok(!analysisHtml.includes("incomplete record"));
assert.ok(!analysisHtml.includes("simulation source"));
assert.ok(!captureHtml.includes("数据批次"));
assert.ok(!analysisHtml.includes('aria-pressed="false" disabled=""'));
assert.doesNotMatch(captureHtml + analysisHtml, /真实采集数据|户外测量第一批/);
for (const method of ["decay", "frf", "ssi_cov"]) {
  const sample = modalPreviewData[method];
  assert.equal(sample.result.method, method);
  assert.equal(sample.result.synthetic, true);
  assert.equal(sample.result.healthConclusion, null);
  assert.match(sample.inputSha256, /^[0-9a-f]{64}$/);
  assert.ok(sample.result.modes.length > 0);
  assert.ok(sample.result.modes.some((mode: any) => Math.abs(mode.naturalFrequencyHz - .75) < .02));
  for (const channel of sample.waveform.channels) assert.equal(channel.values.length, sample.waveform.time_s.length);
}
assert.equal(modalPreviewData.ssi_cov.channels.length, 5);
assert.ok(modalPreviewData.frf.channels.some((c: any) => c.role === "excitation" && c.quantity === "force"));
console.log("PASS separate capture/analysis views and provenance-labelled samples with method-specific inputs");
