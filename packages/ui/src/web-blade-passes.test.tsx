// Isolated data and SSR fixtures. No network, acquisition service or device calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BladePassResults, WebBladePasses } from "./web-blade-passes";
import { BladeTaskSelection } from "./web-blade-task-selection";
import { BladeSynthesisResults } from "./web-blade-synthesis";
import { activeBladePassGroup, bladePassPointKey, bladePassAnalysisJobs, bladePassCompositionError, bladePassPointGroups, bladePassTasks, bladePassUnavailableReason, bladePassWaveSeries, defaultBladePassSelection, preferredBladePassTask, selectedBladePassRecords,
  type BladePassRecording, type BladePassResult, type BladePassSource, type BladeSynthesis } from "./web-blade-passes-data";

let checks = 0;
const check = (name: string, run: () => void) => { run(); checks++; console.log(`PASS ${name}`); };
const collection = "a".repeat(32);
function record(id: string, point = "P1", task = collection, blade = "2"): BladePassRecording {
  return { id, name: "叶片检测", samples: 1000, sampleRate: 1000, startedAt: 1000, status: "complete", source: "polytec_ivs500",
    pointCycle: { mode: "automatic_stations", collectionId: task, sessionId: createHash("sha256").update(id).digest("hex").slice(0, 32), pointId: `${point}-0`, bladeId: blade,
      radialPointId: point, radialPointName: point, radiusM: point === "P1" ? .31 : .5, azimuthDeg: 0, stationIndex: 1, stationCount: 4,
      lapIndex: 1, completion: "confirmed_pass", cycle: 1, cycles: 1, pointIndex: 1, pointName: "点位1", dwellSeconds: 30, targetAxis1AngleDeg: 0, targetAxis2AngleDeg: 0 },
    windFarm: "风场 A", turbine: "机组 1", object: "叶片" };
}
const metrics = { rmsVelocityMps: .002, peakVelocityMps: .003, peakToPeakVelocityMps: .006 };
const source: BladePassSource = { recordingId: "r1", name: "P1原记录", sessionId: "b".repeat(32), radialPointId: "P1", radialPointName: "P1",
  radiusM: .31, azimuthDeg: 0, sampleRate: 1000, sampling: { kind: "anti_alias_lowpass", sourceSampleRate: 4000, targetSampleRate: 1000, recommendedMaxFrequencyHz: 400 }, sampleOrigin: 2000, status: "included", candidateRange: { start: 10, end: 400 },
  validRanges: [{ start: 10, end: 110, samples: 100 }, { start: 300, end: 400, samples: 100 }], exclusions: [{ reason: "low_rssi", samples: 190 }], metrics,
  segments: [{ start: 10, end: 110, samples: 100, durationSeconds: .1, metrics, timeDomain: { sampleIndices: [10, 109], seconds: [.01, .109], values: [.002, -.002] }, spectrum: { frequencies: [0, 10], amplitudes: [0, .002], frequencySpacingHz: 10 } },
    { start: 300, end: 400, samples: 100, durationSeconds: .1, metrics, timeDomain: { sampleIndices: [300, 399], seconds: [.3, .399], values: [.003, -.003] }, spectrum: { frequencies: [0, 10], amplitudes: [0, .003], frequencySpacingHz: 10 } }], provenance: { event: "confirmed_leave", index: 400 } };
const result: BladePassResult = { algorithmVersion: "test-v1", parameters: { detrend: "constant" }, collectionId: collection, bladeId: "2", phaseAvailable: false,
  modeShapeUnavailableReason: "各批次没有共同相位基准。", coverage: { selectedRecords: 2, includedRecords: 1, excludedRecords: 1, rawSamples: 1000, analysisSamples: 800, validSamples: 200, validSeconds: .2, segmentCount: 2 },
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
  assert.ok(bladePassTasks([missing, incomplete, legacy]).some(task => task.records.some(record => record.id === incomplete.id)), "未完成记录保留在采集统计中");
  const malformed = record("malformed"); malformed.pointCycle!.bladeId = 2 as unknown as string;
  assert.equal(bladePassUnavailableReason(malformed), "缺少叶片编号"); assert.equal(bladePassTasks([malformed]).length, 0);
});
check("非法任务ID与重复记录不能产生错误分组或重复选择", () => {
  assert.ok(bladePassTasks([record("newline", "P1", collection + "\n"), record("upper", "P1", collection.toUpperCase())]).every(task => defaultBladePassSelection(task).length === 0));
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
check("同测点先按角度分组，多个测点保持独立", () => {
  const p1a = record("p1a", "P1"); p1a.pointCycle!.azimuthDeg = 90;
  const p1b = record("p1b", "P1"); p1b.pointCycle!.azimuthDeg = 0;
  const p2 = record("p2", "P2"); p2.pointCycle!.azimuthDeg = 0;
  const groups = bladePassPointGroups(bladePassTasks([p1a, p1b, p2])[0]);
  assert.deepEqual(groups.map(item => item.id), ["P1", "P2"]);
  assert.deepEqual(groups[0].angles.map(item => item.azimuthDeg), [0, 90]);
  assert.deepEqual(groups[0].angles.map(item => item.records[0].id), ["p1b", "p1a"]);
});
check("多个任务的测点工作区分别显示，允许跨任务勾选并保持任务归属", () => {
  const first = record("task-a-p1", "P1", collection), second = record("task-b-p2", "P2", "d".repeat(32));
  const tasks = bladePassTasks([first, second]);
  const markup = renderToStaticMarkup(<BladeTaskSelection tasks={tasks} taskKeys={tasks.map(task => task.key)} selected={[first.id, second.id]} loading={false}
    onTask={() => {}} onRecords={() => {}} onRestore={() => {}} onClear={() => {}} />);
  const jobs = bladePassAnalysisJobs(tasks, tasks.map(task => task.key), [first.id, second.id, "stale-id"]);
  assert.equal((markup.match(/本任务测点（可多选）/g) || []).length, 2);
  assert.deepEqual(jobs.map(job => job.records.map(item => item.id)).sort(), [[first.id], [second.id]].sort());
  assert.deepEqual(jobs.map(job => job.identity.recordingIds).sort(), [[first.id], [second.id]].sort());
  assert.equal(bladePassCompositionError([jobs[0]], false, ""), null, "单任务单测点仍可分析波形和频谱");
  assert.equal(bladePassCompositionError(jobs, false, "叶片 2"), "跨任务组合前，请确认这些采集任务的数据来自同一根实体叶片。");
  assert.equal(bladePassCompositionError(jobs, true, "叶片 2"), null);
});
check("默认选择各测点最新观测组的确认经过记录，并按测点交错覆盖", () => {
  const p1old = record("p1-old", "P1"), p1new = record("p1-new", "P1"), p2 = record("p2", "P2");
  p1old.startedAt = 100; p1new.startedAt = 200;
  const task = bladePassTasks([p1old, p1new, p2])[0];
  assert.deepEqual(defaultBladePassSelection(task), ["p1-new", "p2"]);
});
check("跨任务组成校验拦截不同风机对象和单一半径", () => {
  const first = record("scope-a", "P1", collection), second = record("scope-b", "P2", "d".repeat(32));
  second.turbine = "机组 2";
  const tasks = bladePassTasks([first, second]), jobs = bladePassAnalysisJobs(tasks, tasks.map(task => task.key), [first.id, second.id]);
  assert.match(bladePassCompositionError(jobs, true, "叶片 2") || "", /风场、风机或测量对象不一致/);
  second.turbine = first.turbine;
  second.pointCycle!.radiusM = first.pointCycle!.radiusM;
  const sameRadiusTasks = bladePassTasks([first, second]);
  const sameRadiusJobs = bladePassAnalysisJobs(sameRadiusTasks, sameRadiusTasks.map(task => task.key), [first.id, second.id]);
  assert.match(bladePassCompositionError(sameRadiusJobs, true, "叶片 2") || "", /至少选择两个不同半径/);
});
check("旧任务缺少风机和对象字段时可由操作员确认同一叶片后组合", () => {
  const first = record("legacy-scope-a", "P1", collection), second = record("legacy-scope-b", "P2", "d".repeat(32));
  for (const item of [first, second]) { item.windFarm = ""; item.turbine = ""; item.object = ""; }
  const tasks = bladePassTasks([first, second]), jobs = bladePassAnalysisJobs(tasks, tasks.map(task => task.key), [first.id, second.id]);
  assert.equal(bladePassCompositionError(jobs, true, "叶片实体 A"), null);
  second.object = "轮毂";
  const changedTasks = bladePassTasks([first, second]);
  const changedJobs = bladePassAnalysisJobs(changedTasks, changedTasks.map(task => task.key), [first.id, second.id]);
  assert.match(bladePassCompositionError(changedJobs, true, "叶片实体 A") || "", /风场、风机或测量对象不一致/);
});
const stations = (point = "P1", blade = "2") => [0, 90, 180, 270].map((azimuthDeg, index) => ({
  pointId: `${point}-${azimuthDeg}`, bladeId: blade, radialPointId: point, radialPointName: point,
  radiusM: point === "P1" ? .31 : .5, azimuthDeg, stationIndex: index + 1, stationCount: 4,
  axis1AngleDeg: index + 1, axis2AngleDeg: index - 1,
}));
function plannedRecord(id: string, angle = 0, session = "1".repeat(32), point = "P1", blade = "2") {
  const value = record(id, point, collection, blade), plan = stations(point, blade), station = plan.find(item => item.azimuthDeg === angle)!;
  value.pointCycle = { ...value.pointCycle!, sessionId: session, pointId: station.pointId, azimuthDeg: angle,
    stationIndex: station.stationIndex, plannedStations: plan, targetAxis1AngleDeg: station.axis1AngleDeg, targetAxis2AngleDeg: station.axis2AngleDeg };
  value.endedAt = Number(value.startedAt) + 1;
  return value;
}
check("任务下叶片分页，计划未采集测点也保留，时间与采集次数不按有效记录缩减", () => {
  const first = plannedRecord("hierarchy"), thirdBlade = plannedRecord("blade-3", 0, "2".repeat(32), "P1", "3");
  first.pointCycle!.plannedStations = [...stations(), ...stations("P2")];
  const pending = plannedRecord("incomplete", 90); pending.status = "incomplete";
  pending.pointCycle!.plannedStations = first.pointCycle!.plannedStations;
  const tasks = bladePassTasks([first, pending, thirdBlade]);
  assert.equal(tasks.length, 2); assert.equal(tasks[0].collection.blades.length, 2);
  const task = tasks.find(item => item.bladeId === "2")!, points = bladePassPointGroups(task);
  assert.equal(task.collection.sessionCount, 2); assert.equal(task.summary.sessionCount, 1);
  assert.equal(points.length, 2); assert.equal(points[1].records.length, 0);
  assert.equal(points[0].groups[0].plannedCount, 4); assert.equal(points[0].groups[0].observedCount, 1);
  assert.equal(points[0].groups[0].incompleteCount, 1);
  assert.deepEqual(defaultBladePassSelection(task), [first.id]);
  const html = renderToStaticMarkup(<BladeTaskSelection tasks={tasks} taskKeys={[task.key]} selected={[first.id]} loading={false} onTask={() => {}} onRecords={() => {}} onRestore={() => {}} onClear={() => {}} />);
  assert.equal((html.match(/class="blade-task-options"/g) || []).length, 1);
  assert.equal((html.match(/aria-label="选择任务 /g) || []).length, 1, "同任务多个叶片只显示一个任务入口");
  for (const label of ["叶片 2", "叶片 3", "距中心", "累计采集时长", "观测不完整", "未收到记录"]) {
    // Planned station rows are included in SSR even while details are closed.
    assert.ok(html.includes(label), label);
  }
  assert.deepEqual(bladePassAnalysisJobs(tasks, [task.key], [first.id, pending.id])[0].identity.recordingIds, [first.id]);
});
check("默认仅选最新观测组，切历史组不混入其他批次，最新失败不复活旧成功", () => {
  const old = plannedRecord("old-group", 90), current = plannedRecord("latest-group", 0, "2".repeat(32));
  current.startedAt = 2000; current.endedAt = 2001;
  const retry = plannedRecord("failed-retry", 0, "2".repeat(32));
  retry.status = "error"; retry.startedAt = 3000; retry.endedAt = 3001;
  const task = bladePassTasks([old, current, retry])[0], point = bladePassPointGroups(task)[0];
  assert.equal(point.groups.length, 2);
  assert.deepEqual(defaultBladePassSelection(task), [], "不能自动跳回旧成功或旧组");
  const oldGroup = point.groups.find(group => group.sessionId === "1".repeat(32))!;
  const groupKeys = { [bladePassPointKey(task, point.id)]: oldGroup.key };
  assert.equal(activeBladePassGroup(task, point, groupKeys).key, oldGroup.key);
  assert.deepEqual(defaultBladePassSelection(task, groupKeys), [old.id]);
});
check("四次分段兼容计划累计为一组，参考位不一致另分组且不跨组补角度", () => {
  const records = [0, 90, 180, 270].map((angle, index) => {
    const value = plannedRecord(`manual-${index}`, angle, String(index + 1).repeat(32));
    value.pointCycle = { ...value.pointCycle!, executionMode: "manual_segments", segmentStepDeg: 90, totalStationCount: 4,
      segmentStationIds: [value.pointCycle!.pointId!], recordedPort: "COM3", referenceSignature: "reference-a" };
    return value;
  });
  const task = bladePassTasks(records)[0], group = bladePassPointGroups(task)[0].groups[0];
  assert.deepEqual([group.observedCount, group.plannedCount, group.sessionIds.length], [4, 4, 4]);
  assert.equal(defaultBladePassSelection(task).length, 4);
  const changed = { ...records[3], pointCycle: { ...records[3].pointCycle!, referenceSignature: "reference-b" } };
  const separate = bladePassTasks([...records.slice(0, 3), changed])[0];
  assert.equal(bladePassPointGroups(separate)[0].groups.length, 2);
  assert.ok(defaultBladePassSelection(separate).length < 4);
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
});
check("结果可读展示排除原因与相位边界，只展示单段FFT", () => {
  const markup = renderToStaticMarkup(<BladePassResults result={result} />);
  assert.ok(markup.includes("不能据此生成实测振型")); assert.ok(markup.includes("缺少叶片离开"));
  assert.ok(markup.includes("RSSI 低于阈值")); assert.ok(markup.includes("FFT 连续有效段"));
  assert.ok(markup.includes("原始边界依据")); assert.ok(!markup.includes("播放动画"));
  assert.ok(markup.includes("速度 RMS mm/s")); assert.ok(markup.includes("短片段不能通过拼接提高频率分辨率"));
  assert.ok(markup.includes("上传目标 1,000 Hz")); assert.ok(markup.includes("Nyquist 上限 500 Hz"));
  assert.ok(markup.includes("分析时已降采样：1,000 个原始样本 → 800 个分析样本"));
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
const synthesis: BladeSynthesis = {
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
  };
check("有效信号默认按测点合并，显示全部角度且合并图仅展示一次", () => {
  const point = synthesis.mergedPoints[0];
  const mergedPoint = { ...point, segments: [...point.segments, { ...point.segments[0], recordingId: "r3", segmentId: "r3:10:110", azimuthDeg: 0 }],
    stitchedWaveform: { seconds: [0, .1], valuesMps: [.002, -.002] },
    stitchedSpectrum: { sampleRate: 1000, fftSampleRate: 1000, samples: 200, frequencySpacingHz: 5, frequencies: [0, 5], amplitudesMps: [0, .002], method: "test" } };
  const markup = renderToStaticMarkup(<BladePassResults result={{ ...result, synthesis: { ...synthesis,
    mergedPoints: [mergedPoint, { ...mergedPoint, radialPointId: "P2", radialPointName: "P2", radiusM: .5 }] } }} />);
  assert.ok(markup.includes("有效信号查看方式")); assert.ok(markup.includes("有效信号合并测点"));
  assert.ok(markup.includes("P2 ·")); assert.ok(markup.includes("2 条记录")); assert.ok(markup.includes("角度 0°、90°"));
  assert.equal((markup.match(/aria-label="单个径向测点多角度片段经边界基线偏置对齐后的拼接波形"/g) || []).length, 1);
  assert.ok(markup.includes("拼接后 FFT 频谱")); assert.ok(!markup.includes("FFT 连续有效段"));
  assert.ok(markup.includes("不能恢复各次经过之间未测到的振动相位"));
});
check("旧合并结果缺少信号数组时回退原记录，提示重新分析", () => {
  const markup = renderToStaticMarkup(<BladePassResults result={{ ...result, synthesis }} />);
  assert.ok(markup.includes("FFT 连续有效段")); assert.ok(!markup.includes("有效信号查看方式"));
  assert.ok(markup.includes("请勾选“合并片段并合成振型候选”后重新分析"));
});
check("实验合成区分探索频带与模态候选，展示压缩时间与未知相位", () => {
  const markup = renderToStaticMarkup(<BladeSynthesisResults synthesis={synthesis} />);
  assert.ok(markup.includes("探索频带")); assert.ok(markup.includes("未检出共同窄带峰"));
  assert.ok(markup.includes("步骤 1 · 同测点多角度合并")); assert.ok(markup.includes("同相假设"));
  assert.ok(markup.includes("不是识别出的模态")); assert.ok(markup.includes("节点正负未知"));
  assert.ok(markup.includes("角度幅值最大/最小")); assert.ok(markup.includes("频带位移 RMS"));
});
console.log(`${checks} blade-pass UI/data checks passed; hardware tested: false`);
