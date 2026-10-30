import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldRecordAnalysis } from "./field-record-analysis";
import { aggregateFor, analysisTabs, chartUnavailable, epochMs, pointsForTask, pointCounts, resultEvents, spectrumPairs, taskHasFormalData, type AnalysisTask, type AnalysisReport } from "./field-record-analysis-data";

const task: AnalysisTask = { id: "test-task", name: "真实任务", windFarm: "wf1", turbine: "1303", recordingIds: ["r1"], records: [{ id: "r1", bladeId: "2", pointName: "P1", radiusM: .16, azimuthDeg: 0, sourceQuality: { diagnostic_only: true, valid_measurement: false, identity_verified: false } }],
  plannedPoints: [{ bladeId: "2", radialPointName: "P1", radiusM: .16, azimuthDeg: 0 }, { bladeId: "2", radialPointName: "P1", radiusM: .16, azimuthDeg: 120 }, { bladeId: "2", radialPointName: "P1", radiusM: .16, azimuthDeg: 240 }, { bladeId: "2", radialPointName: "P2", radiusM: .3, azimuthDeg: 0 }] };
const points = pointsForTask(task);
assert.equal(points.length, 2, "Unmeasured planned points must stay in the tree");
assert.deepEqual(points[0].plannedAzimuths, [0, 120, 240], "Do not replace actual plan with four cardinal angles");
assert.equal(points[1].records.length, 0);
assert.equal(taskHasFormalData(task), false, "Source diagnostic flags cannot be upgraded by UI");
assert.equal(taskHasFormalData({ ...task, records: [{ ...task.records[0], sourceQuality: { diagnostic_only: false, valid_measurement: true, identity_verified: true } }] }), true);
assert.equal(taskHasFormalData({ ...task, records: [{ ...task.records[0], sourceQuality: { diagnostic_only: false, valid_measurement: true, identity_verified: false } }] }), false);
assert.equal(taskHasFormalData({ ...task, records: [{ ...task.records[0], sourceQuality: { source_flags_allow_formal_review: false, diagnostic_only: false, valid_measurement: true, identity_verified: true } }] }), false, "An explicit backend refusal cannot be overridden by source flags or UI fallbacks");
const assessed = pointCounts(points[0], {records: [
  {recording_id:"r1",representative:"valid",source_quality:{diagnostic_only:true,valid_measurement:false},quality_assessment:{analysis_eligible:true}},
],aggregates:[]});
assert.equal(assessed.analyzable,1,"Historical test flags must not hide a pass that meets per-record analysis quality");
assert.equal(assessed.review,0,"Identity/source warnings are separate from actual review blockers");
assert.equal(pointCounts(points[0],{records:[{recording_id:"r1",representative:"moving",quality_assessment:{analysis_eligible:false,reason_codes:["PASS_DURING_MOTION"]}}],aggregates:[]}).review,1);
const zero = pointsForTask({ ...task, plannedPoints: [], records: [{ ...task.records[0], radiusM: 0 }] });
assert.equal(zero[0].radiusM, 0, "A real zero must not be replaced by an invented radius");
const report: AnalysisReport = { records: [], aggregates: [{ blade: "2", point: "P1", layer: "los_residual", radius_from_hub_m: .16 }, { blade: "2", point: "P1", layer: "los_residual", radius_from_hub_m: .18 }] };
assert.equal(aggregateFor(report, points[0], "los_residual"), undefined, "Different radius/configuration groups must never be silently merged");
assert.equal(aggregateFor({ ...report, aggregates: [report.aggregates[0]] }, points[0], "los_residual")?.radius_from_hub_m, .16);
const event = { id: "event-one", code: "SPIKE_SUSPECT", source_start: 10, source_end: 12 };
const events = resultEvents({ records: [{ recording_id: "r1", quality_events: [event], segments: [{ segment_id: "s1", events: [event] }] }], aggregates: [] }, task);
assert.equal(events.length, 1, "The same event ID must not be counted again in each chart");
const anonymousEvents = resultEvents({ records: [{ recording_id: "r1", quality_events: [{ code: "OVERRANGE", source_start: 1, source_end: 2 }, { code: "OVERRANGE", source_start: 1, source_end: 2 }], segments: [] }], aggregates: [] }, task);
assert.equal(anonymousEvents.length, 1);
assert.deepEqual(spectrumPairs({ fft_frequency_hz: [0, 10], fft_peak_amplitude_m_s: [.1, .2] }, "fft"), [[0, 100], [10, 200]], "SI amplitude display conversion is ×1000");
assert.deepEqual(spectrumPairs({ frequency_hz: [0, 10], psd_m2_s2_per_hz: [.001, .002] }, "psd"), [[0, 1000], [10, 2000]], "PSD display conversion is ×10^6");
assert.deepEqual(spectrumPairs({ frequency_hz: { storage: "npz" }, psd_m2_s2_per_hz: { shape: [2] } }, "psd"), [], "Array descriptors cannot become invented curves");
assert.equal(chartUnavailable({ records: [], aggregates: [], chartAvailability: { A01: { status: "ready", message: "来自真实连续片段" } } }, "A01", "原始数据读取失败"), "原始数据读取失败", "A generic ready marker must not hide a specific local failure");
assert.equal(epochMs(null), null); assert.equal(epochMs(1700000000), 1700000000000);
assert.equal(analysisTabs.length, 6); assert.deepEqual(analysisTabs.map(item => item[1]), ["风机总览", "叶片分析", "点位分析", "单次波形", "扩展分析", "趋势与事件"]);
let requests = 0;
const markup = renderToStaticMarkup(<FieldRecordAnalysis request={async () => { requests++; throw Error("SSR must not request a device"); }} />);
assert.equal(requests, 0);
assert.ok(markup.includes("风机数据分析"));
assert.ok(!markup.includes("健康度") && !markup.includes("损伤率") && !markup.includes("模态已识别"));
assert.ok(markup.includes("正在读取本机已保存记录"));
console.log("PASS record-analysis display adapters: plans, formal separation, provenance, units, empty states and six-tab scope");
