// Isolated data and SSR fixtures. No network, acquisition service or device calls.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BladePassResults, WebBladePasses } from "./web-blade-passes";
import { BladeTaskSelection } from "./web-blade-task-selection";
import { summarizeBladeRecords } from "./field-blade-summary-data";
import { BladeSynthesisResults } from "./web-blade-synthesis";
import { bladePassTasks, bladePassPointGroups, defaultBladePassSelection, bladePassUnavailableReason, bladePassWaveSeries, preferredBladePassTask, selectedBladePassRecords,
  type BladePassRecording, type BladePassResult, type BladePassSource } from "./web-blade-passes-data";

let checks = 0;
const check = (name: string, run: () => void) => { run(); checks++; console.log(`PASS ${name}`); };
const collection = "a".repeat(32);
function record(id: string, point = "P1", task = collection, blade = "2"): BladePassRecording {
  return { id, name: "叶片检测", samples: 1000, sampleRate: 1000, startedAt: 1000, status: "complete", source: "polytec_ivs500",
    pointCycle: { mode: "automatic_stations", collectionId: task, sessionId: Buffer.from(id).toString("hex").slice(0, 32).padEnd(32, "0"), pointId: `${point}-0`, completion: "confirmed_pass", bladeId: blade,
      radialPointId: point, radialPointName: point, radiusM: point === "P1" ? .31 : .5, azimuthDeg: 0, stationIndex: 1, stationCount: 4,
      lapIndex: 1, cycle: 1, cycles: 1, pointIndex: 1, pointName: "点位1", dwellSeconds: 30, targetAxis1AngleDeg: 0, targetAxis2AngleDeg: 0 } };
}
const metrics = { rmsVelocityMps: .002, peakVelocityMps: .003, peakToPeakVelocityMps: .006 };
const source: BladePassSource = { recordingId: "r1", name: "P1原记录", sessionId: "b".repeat(32), radialPointId: "P1", radialPointName: "P1",
  radiusM: .31, azimuthDeg: 0, sampleRate: 1000, sampling: { kind: "anti_alias_lowpass", sourceSampleRate: 4000, targetSampleRate: 1000, recommendedMaxFrequencyHz: 400 }, sampleOrigin: 2000, status: "included", candidateRange: { start: 10, end: 400 },
  validRanges: [{ start: 10, end: 110, samples: 100 }, { start: 300, end: 400, samples: 100 }], exclusions: [{ reason: "low_rssi", samples: 190 }], metrics,
  segments: [{ start: 10, end: 110, samples: 100, durationSeconds: .1, metrics, timeDomain: { sampleIndices: [10, 109], seconds: [.01, .109], values: [.002, -.002] }, spectrum: { frequencies: [0, 10], amplitudes: [0, .002], frequencySpacingHz: 10 } },
    { start: 300, end: 400, samples: 100, durationSeconds: .1, metrics, timeDomain: { sampleIndices: [300, 399], seconds: [.3, .399], values: [.003, -.003] }, spectrum: { frequencies: [0, 10], amplitudes: [0, .003], frequencySpacingHz: 10 } }], provenance: { event: "confirmed_leave", index: 400 } };
const result: BladePassResult = { algorithmVersion: "test-v1", parameters: { detrend: "constant" }, collectionId: collection, bladeId: "2", phaseAvailable: false,
  modeShapeUnavailableReason: "各批次没有共同相位基准。", coverage: { selectedRecords: 2, includedRecords: 1, excludedRecords: 1, rawSamples: 1000, validSamples: 200, validSeconds: .2, segmentCount: 2 },
  sources: [source, { ...source, recordingId: "r2", name: "缺失离开记录", status: "excluded", reason: "missing_exit", candidateRange: null, validRanges: [], exclusions: [], metrics: null, segments: [] }], points: [],
  amplitudeDistributions: [{ azimuthDeg: 0, metric: "rmsVelocityMps", unit: "m/s", points: [{ radialPointId: "P1", radialPointName: "P1", radiusM: .31, value: .002, validSamples: 200, recordingIds: ["r1"] }] }], warnings: ["当前数据不代表连续整圈测量。"] };

check("同任务同叶片的独立径向批次归一组，同名任务与不同叶片隔离", () => {
  const tasks = bladePassTasks([record("r1"), record("r2", "P2"), record("r3", "P1", "c".repeat(32)), record("r4", "P1", collection, "3")]);
  assert.equal(tasks.length, 3); assert.deepEqual(tasks[0].records.map(item => item.id), ["r1", "r2"]);
});
check("完整离线元信息可用于分组，不从普通记录名称猜测", () => {
  const imported = record("offline"); imported.sourceMetadata = { pointCycle: imported.pointCycle }; delete imported.pointCycle;
  const ordinary = record("ordinary"); delete ordinary.pointCycle;
  assert.deepEqual(bladePassTasks([imported, ordinary])[0].records.map(item => item.id), ["offline"]);
});
check("旧记录或归属缺失给出明确原因，不静默跨任务合并", () => {
  const missing = record("missing"); delete missing.pointCycle!.collectionId;
  const incomplete = record("pending"); incomplete.status = "incomplete";
  const legacy = record("legacy"); legacy.pointCycle!.mode = "legacy";
  assert.equal(bladePassUnavailableReason(missing), "缺少有效任务归属");
  assert.equal(bladePassUnavailableReason(incomplete), "记录尚未完整上传或保存");
  assert.equal(bladePassUnavailableReason(legacy), "旧点位记录缺少自动点位信息");
  assert.equal(bladePassTasks([missing, incomplete, legacy]).length, 0);
  const malformed = record("malformed"); malformed.pointCycle!.bladeId = 2 as unknown as string;
  assert.equal(bladePassUnavailableReason(malformed), "缺少叶片编号"); assert.equal(bladePassTasks([malformed]).length, 0);
});
check("非法任务ID与重复记录不能产生错误分组或重复选择", () => {
  assert.equal(bladePassTasks([record("newline", "P1", collection + "\n"), record("upper", "P1", collection.toUpperCase())]).length, 0);
  assert.equal(bladePassTasks([record("same"), record("same")])[0].records.length, 1);
});
check("优先打开所选记录任务，未知偏好保留当前任务", () => {
  const tasks = bladePassTasks([record("r1"), record("r2", "P1", "c".repeat(32))]);
  assert.equal(preferredBladePassTask(tasks, ["unknown", "r2"])?.key, tasks[1].key);
  assert.equal(preferredBladePassTask(tasks, ["unknown"], tasks[1].key)?.key, tasks[1].key);
});
check("请求记录只取当前任务且限制64，不带入其他任务或过期ID", () => {
  const records = Array.from({ length: 70 }, (_, index) => record(`r${index}`));
  const task = bladePassTasks(records)[0];
  const chosen = selectedBladePassRecords(task, [...records.map(item => item.id), "foreign-task"]);
  assert.equal(chosen.length, 64); assert.ok(chosen.every(item => task.records.includes(item)));
  assert.equal(selectedBladePassRecords(undefined, ["r1"]).length, 0);
});
check("有效波形分段保留原时间间隙，展示单位转换不拼接", () => {
  const series = bladePassWaveSeries(source);
  assert.equal(series.length, 2); assert.deepEqual(series[0].data, [[.01, 2], [.109, -2]]);
  assert.deepEqual(series[1].data, [[.3, 3], [.399, -3]]); assert.ok(series.every(item => item.connectNulls === false));
  assert.deepEqual(source.segments[0].timeDomain.values, [.002, -.002]);
});
check("异常大单步仅在波形预览中断线，分析时域值仍完整", () => {
  const filtered: BladePassSource = { ...source, segments: [{ ...source.segments[0],
    plotTimeDomain: { sampleIndices: [10, 50, 109], seconds: [.01, .05, .109], values: [.002, null, -.002] },
    plotFilter: { method: "step-over-50-times-p99", thresholdMps: .01, flaggedSteps: 1,
      hiddenSamples: 10, hiddenTimeBuckets: 1, plottedSamples: 90, effect: "plot-only" } }] };
  assert.deepEqual(bladePassWaveSeries(filtered)[0].data, [[.01, 2], [.05, null], [.109, -2]]);
  assert.deepEqual(filtered.segments[0].timeDomain.values, [.002, -.002]);
});
check("只读界面不能运行分析，SSR不会调用网络或设备", () => {
  const markup = renderToStaticMarkup(<WebBladePasses canAnalyze={false} refreshKey={0} preferredIds={[]} onError={() => { throw Error("must not perform a request"); }} />);
  assert.match(markup, /type="submit" disabled=""/); assert.ok(markup.includes("运行分析需要分析权限"));
  assert.ok(!markup.includes("开始采集"));
  assert.ok(!markup.includes("筛选与预处理设置")); assert.ok(!markup.includes("RSSI 下限百分比")); assert.ok(!markup.includes("经过范围"));
  assert.ok(markup.includes("合成频率下限")); assert.ok(markup.includes("合成频率上限"));
});
check("结果可读展示排除原因与相位边界，只展示单段FFT", () => {
  const markup = renderToStaticMarkup(<BladePassResults result={result} />);
  assert.ok(markup.includes("不能据此生成实测振型")); assert.ok(markup.includes("缺少叶片离开"));
  assert.ok(markup.includes("RSSI 低于阈值")); assert.ok(markup.includes("FFT 连续有效段"));
  assert.ok(markup.includes("原始边界依据")); assert.ok(!markup.includes("播放动画"));
  assert.ok(markup.includes("速度 RMS mm/s")); assert.ok(markup.includes("短片段不能通过拼接提高频率分辨率"));
  assert.ok(markup.includes("上传目标 1,000 Hz")); assert.ok(markup.includes("Nyquist 上限 500 Hz"));
});
check("全部排除结果仍展示原因，不出现虚构的波形或幅值", () => {
  const excluded = { ...result, sources: [result.sources[1]], amplitudeDistributions: [] };
  const markup = renderToStaticMarkup(<BladePassResults result={excluded} />);
  assert.ok(markup.includes("缺少叶片离开")); assert.ok(!markup.includes("多点幅值分布")); assert.ok(!markup.includes("有效波形与频谱"));
});
check("历史模拟记录保留来源标记，不能误显示为实测", () => {
  const markup = renderToStaticMarkup(<BladePassResults result={{ ...result, hasSimulation: true, sources: [{ ...source, source: "simulation", simulation: true }] }} />);
  assert.ok(markup.includes("含模拟数据")); assert.ok(markup.includes("来源：模拟数据"));
});
check("任务与来源元信息按文本转义", () => {
  const unsafe = { ...result, sources: [{ ...source, name: "<script>alert(1)</script>", provenance: { raw: "<img onerror=alert(1)>" } }] };
  const markup = renderToStaticMarkup(<BladePassResults result={unsafe} />);
  assert.ok(!markup.includes("<script>")); assert.ok(markup.includes("&lt;script&gt;")); assert.ok(!markup.includes("<img onerror"));
});
check("实验合成区分探索频带与模态候选，展示压缩时间与未知相位", () => {
  const markup = renderToStaticMarkup(<BladeSynthesisResults synthesis={{
    algorithmVersion: "test", status: "band_responses_only", reason: "未检出共同窄带峰",
    coordinate: "compressed-valid-time", measuredPhaseAvailable: false, damageAssessmentAvailable: false,
    assumptions: ["同一叶片假设"], candidates: [],
    mergedPoints: [{ radialPointId: "P1", radialPointName: "P1", radiusM: .2, samples: 100, durationSeconds: .1,
      segments: [{ segmentId: "r1:10:110", recordingId: "r1", sourceRecordingId: "original-r1", azimuthDeg: 90,
        originalStart: 10, originalEnd: 110, sampleRate: 1000, mergedStart: 0, mergedEnd: 100,
        compressedStartSeconds: 0, compressedEndSeconds: .1, originalStartSeconds: .01, originalEndSeconds: .11,
        timeDomain: source.segments[0].timeDomain }] }],
    bandResponses: [{ frequencyHz: 30, bandHz: [20, 40], frequencyGridHz: 2,
      kind: "exploratory_band_response", phaseAssumption: "in_phase_for_preview_only", warnings: ["不是识别出的模态"],
      points: [{ radialPointId: "P1", radialPointName: "P1", radiusM: .2, velocityRmsMps: .002,
        displacementRmsM: .00001, normalizedAmplitude: 1, spatialPhaseDeg: null, stationCount: 2, stationAmplitudeRatio: 10 }] }],
  }} />);
  assert.ok(markup.includes("探索频带")); assert.ok(markup.includes("未检出共同窄带峰"));
  assert.ok(markup.includes("按所选记录顺序压缩无效时间")); assert.ok(markup.includes("同相假设"));
  assert.ok(markup.includes("不是识别出的模态")); assert.ok(markup.includes("节点正负未知"));
  assert.ok(markup.includes("角度幅值最大/最小")); assert.ok(markup.includes("频带位移 RMS"));
});
check("任务与叶片层级复用汇总，同名不同风机隔离", () => {
  const records = [record("a1"), { ...record("a2", "P2"), windFarm: "F1", turbine: "T1" }, { ...record("a3", "P1"), windFarm: "F1", turbine: "T2" }];
  const tasks = bladePassTasks(records), summary = summarizeBladeRecords(records);
  assert.equal(tasks.length, 3);
  assert.deepEqual(new Set(tasks.map(item => item.taskKey)), new Set(summary.tasks.map(item => item.key)));
});
check("默认排除诊断数据，开启后覆盖各测点角度且不重复选择", () => {
  const records = [record("d1"), record("d2", "P2")];
  for (const record of records) { record.diagnosticOnly = true; record.validMeasurement = false; record.pointCycle!.completion = "diagnostic_pass"; record.pointCycle!.passCompleteness = "confirmed"; }
  const task = bladePassTasks(records)[0];
  assert.deepEqual(defaultBladePassSelection(task), []);
  assert.equal(defaultBladePassSelection(task, true).length, 2);
  assert.equal(bladePassPointGroups(task).length, 2);
  const pending = { ...record("d3"), diagnosticOnly: true, validMeasurement: false };
  pending.pointCycle!.completion = "diagnostic_pass";
  assert.deepEqual(defaultBladePassSelection(bladePassTasks([pending])[0], true), []);
});
check("推荐选择不跨旧参考或半径填补新批次缺失角度", () => {
  const older = record("old"); older.startedAt = 100; older.pointCycle!.azimuthDeg = 90;
  const recent = record("new"); recent.startedAt = 200; recent.pointCycle!.radiusM = .4;
  const task = bladePassTasks([older, recent])[0];
  assert.deepEqual(defaultBladePassSelection(task), ["new"]);
});
check("选择器为任务→叶片→测点，诊断开关默认关闭", () => {
  const rec = record("diag"); rec.diagnosticOnly = true; rec.pointCycle!.completion = "diagnostic_pass"; rec.pointCycle!.passCompleteness = "confirmed";
  const tasks = bladePassTasks([rec]);
  const markup = renderToStaticMarkup(<BladeTaskSelection tasks={tasks} taskKey={tasks[0].key} selected={[]} loading={false} includeDiagnostic={false} onTask={() => {}} onRecords={() => {}} onRestore={() => {}} onDiagnostic={() => {}} />);
  assert.ok(markup.includes("采集任务")); assert.ok(markup.includes("选择叶片")); assert.ok(markup.includes("选择测点 P1"));
  assert.ok(markup.includes("纳入诊断数据分析")); assert.ok(!markup.includes('checked=""'));
});
check("诊断结果显著标注，排除记录也可显示原始波形", () => {
  const diagnostic: BladePassResult = { ...result, hasDiagnostic: true, diagnosticOnly: true, validMeasurement: false,
    sources: [{ ...source, diagnosticOnly: true, validMeasurement: false, status: "excluded", reason: "pass_boundary_outside_recording", segments: [], validRanges: [],
      rawTimeDomain: { seconds: [0, .2], values: [0, .003] } }] };
  const markup = renderToStaticMarkup(<BladePassResults result={diagnostic} />);
  assert.ok(markup.includes("诊断分析 · 非有效测量结论")); assert.ok(markup.includes("原始波形保留供核对"));
  assert.ok(markup.includes("原始波形与保留范围对照"));
});
check("正式合并谱使用独立段Welch，不显示拼接FFT", () => {
  const markup = renderToStaticMarkup(<BladeSynthesisResults synthesis={{ algorithmVersion: "test", status: "insufficient_evidence", reason: "缺少相位",
    coordinate: "compressed-valid-time", measuredPhaseAvailable: false, damageAssessmentAvailable: false, assumptions: [], candidates: [], bandResponses: [],
    mergedPoints: [{ radialPointId: "P1", radialPointName: "P1", radiusM: .2, samples: 100, durationSeconds: .1, segments: [],
      independentSpectrum: { frequencies: [0, 10], psdMps2PerHz: [0, .001], frequencySpacingHz: 10, method: "independent-segment-welch", segmentCount: 2 },
      stitchedSpectrum: { sampleRate: 1000, fftSampleRate: 1000, samples: 100, frequencySpacingHz: 1, frequencies: [0, 1], amplitudesMps: [0, 100], method: "legacy" } }] }} />);
  assert.ok(markup.includes("Welch 功率谱")); assert.ok(!markup.includes("拼接后 FFT")); assert.ok(markup.includes("各段不平移基线"));
});
check("汇总同口径比较原始保留样本，单独标明分析降采样", () => {
  const downsampled: BladePassResult = { ...result, coverage: { ...result.coverage, rawSamples: 3680000, validSamples: 126500 },
    sources: [{ ...source, sourceValidSamples: 632500, originalSampleRate: 250000, sampleRate: 50000, sampling: null,
      analysisSampling: { configuredTargetSampleRate: 50000, sourceSampleRate: 250000, analysisSampleRate: 50000, resampled: true } }] };
  const markup = renderToStaticMarkup(<BladePassResults result={downsampled} />);
  assert.ok(markup.includes("保留原始样本")); assert.ok(markup.includes("632,500")); assert.ok(markup.includes("3,680,000"));
  assert.ok(markup.includes("分析样本 126,500（软件降采样）"));
  assert.ok(markup.includes("原记录 250,000 Hz → 实际分析 50,000 Hz"));
  assert.ok(!markup.includes("此记录为 Web 同步降采样副本"));
});
console.log(`${checks} blade-pass UI/data checks passed; hardware tested: false`);
