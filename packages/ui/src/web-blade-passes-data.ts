import { fieldDate, type FieldAutomaticRecord, type FieldRecording } from "./field-types";
import { summarizeBladeRecords } from "./field-blade-summary-data";

export type BladePassRecording = FieldRecording & { sourceMetadata?: { pointCycle?: FieldAutomaticRecord; windFarm?: string; turbine?: string; object?: string }; diagnosticOnly?: boolean; validMeasurement?: boolean };
export type BladePassTask = { key: string; taskKey: string; collectionId: string; bladeId: string; name: string; windFarm: string; turbine: string; object: string; latestAt: number; records: BladePassRecording[] };
export type BladePassAngleGroup = { key: string; azimuthDeg: number | null; records: BladePassRecording[] };
export type BladePassPointGroup = { id: string; name: string; radius: number | undefined; records: BladePassRecording[]; angles: BladePassAngleGroup[] };
export type BladePassMetrics = { rmsVelocityMps: number; peakVelocityMps: number; peakToPeakVelocityMps: number };
export type BladePassSegment = {
  start: number; end: number; samples: number; sourceSamples?: number; durationSeconds: number; metrics: BladePassMetrics;
  timeDomain: { sampleIndices: number[]; seconds: number[]; values: number[] };
  plotTimeDomain?: { sampleIndices: number[]; seconds: number[]; values: (number | null)[]; representation?: string };
  plotFilter?: { method: string; thresholdMps: number; flaggedSteps: number; hiddenSamples: number; hiddenTimeBuckets: number; plottedSamples: number; effect: string };
  spectrum?: { frequencies: number[]; amplitudes: number[]; frequencySpacingHz: number } | null;
};
export type BladePassSource = {
  recordingId: string; name: string; sessionId: string; radialPointId: string; radialPointName: string;
  radiusM: number; azimuthDeg: number; sampleRate: number; originalSampleRate?: number; sampleOrigin: number;
  analysisSampling?: { configuredTargetSampleRate: number; sourceSampleRate: number; analysisSampleRate: number; resampled: boolean } | null;
  sampling?: { kind?: string; sourceSampleRate?: number; sourceSamples?: number; targetSampleRate?: number;
    recommendedMaxFrequencyHz?: number; filter?: string } | null;
  status: "included" | "excluded"; reason?: string; candidateRange?: { start: number; end: number } | null;
  validRanges: { start: number; end: number; samples: number }[]; sourceValidSamples?: number;
  exclusions: { reason: string; samples: number }[];
  metrics?: BladePassMetrics | null; segments: BladePassSegment[]; provenance?: unknown;
  source?: string; simulation?: boolean; diagnosticOnly?: boolean; validMeasurement?: boolean;
  boundaryBasis?: { sampleClock: string; sourceOffset: number; originalRange?: { start: number; end: number }; localRange?: { start: number; end: number } };
  rawTimeDomain?: { sampleIndices?: number[]; seconds: number[]; values: (number | null)[]; rssiPercent?: (number | null)[] };
};
export type BladePassDistribution = {
  azimuthDeg: number; metric: "rmsVelocityMps"; unit: "m/s";
  points: { radialPointId: string; radialPointName: string; radiusM: number; value: number; validSamples: number; recordingIds: string[] }[];
};
export type BladePassResult = {
  algorithmVersion: string; parameters: Record<string, unknown>; collectionId: string; bladeId: string;
  phaseAvailable: false; modeShapeUnavailableReason: string;
  coverage: { selectedRecords: number; includedRecords: number; excludedRecords: number; rawSamples: number; analysisSamples?: number; diagnosticRecords?: number; includedDiagnosticRecords?: number; validSamples: number; validSeconds: number; segmentCount: number };
  sources: BladePassSource[];
  points: { radialPointId: string; radialPointName: string; radiusM: number; stations: { azimuthDeg: number; recordingIds: string[]; validSamples: number; validSeconds: number; metrics: BladePassMetrics }[] }[];
  amplitudeDistributions: BladePassDistribution[]; warnings: string[];
  hasSimulation?: boolean; hasDiagnostic?: boolean; diagnosticOnly?: boolean; validMeasurement?: boolean;
  synthesis?: BladeSynthesis;
};

export type BladeMergedSegment = {
  segmentId: string; recordingId: string; sourceRecordingId: string; azimuthDeg: number;
  originalStart: number; originalEnd: number; sampleRate: number; mergedSampleRate?: number; sourceSamples?: number; analysisSamples?: number;
  mergedStart: number; mergedEnd: number; compressedStartSeconds: number; compressedEndSeconds: number;
  originalStartSeconds: number; originalEndSeconds: number;
  stitchOffsetMps?: number;
  timeDomain: BladePassSegment["timeDomain"];
  plotTimeDomain?: NonNullable<BladePassSegment["plotTimeDomain"]>;
  plotFilter?: BladePassSegment["plotFilter"];
  discontinuityAudit?: { count: number; maxStepMps: number; firstOriginalSampleIndices: number[] };
};
export type BladeMergedPoint = {
  radialPointId: string; radialPointName: string; radiusM: number;
  samples: number; durationSeconds: number; segments: BladeMergedSegment[];
  independentSpectrum?: { frequencies: number[]; psdMps2PerHz: number[]; frequencySpacingHz: number; method: "independent-segment-welch"; segmentCount: number };
  stitchedSpectrum?: { sampleRate: number; fftSampleRate: number; samples: number; frequencySpacingHz: number;
    frequencies: number[]; amplitudesMps: number[]; method: string };
  stitchInfo?: { segments: number; sampleRate: number; resampledSegments: number; fftSamples: number;
    originalSamples: number; method: string };
  stitchedWaveform?: { seconds: number[]; valuesMps: (number | null)[] };
};
export type BladeShapeCandidate = {
  frequencyHz: number; bandHz: [number, number]; frequencyGridHz: number;
  kind: "unsigned_band_response_candidate" | "exploratory_band_response"; phaseAssumption: "in_phase_for_preview_only"; warnings: string[];
  points: { radialPointId: string; radialPointName: string; radiusM: number;
    velocityRmsMps: number; displacementRmsM: number; normalizedAmplitude: number;
    spatialPhaseDeg: null; stationCount: number; stationAmplitudeRatio: number | null }[];
};
export type BladeSynthesis = {
  algorithmVersion: string; status: "candidates_available" | "band_responses_only" | "insufficient_evidence";
  reason: string | null; mergedPoints: BladeMergedPoint[]; candidates: BladeShapeCandidate[]; bandResponses: BladeShapeCandidate[];
  coordinate: "compressed-valid-time"; measuredPhaseAvailable: false;
  assumptions: string[]; damageAssessmentAvailable: false;
  qualityWarnings?: string[];
};

export const BLADE_PASS_RECORD_LIMIT = 64;
export const bladePassMetadata = (record: BladePassRecording) => record.pointCycle ?? record.sourceMetadata?.pointCycle;
export function bladePassUnavailableReason(record: BladePassRecording): string | null {
  const metadata = bladePassMetadata(record);
  if (!metadata) return null;
  if (record.status !== "complete") return "记录尚未完整上传或保存";
  if (metadata.mode !== "automatic_stations") return "旧点位记录缺少自动点位信息";
  if (typeof metadata.collectionId !== "string" || metadata.collectionId.length !== 32 || !/^[a-f0-9]{32}$/.test(metadata.collectionId)) return "缺少有效任务归属";
  if (typeof metadata.bladeId !== "string" || !metadata.bladeId.trim()) return "缺少叶片编号";
  if (typeof metadata.radialPointId !== "string" || !metadata.radialPointId.trim()) return "缺少径向测点编号";
  return null;
}

/** Use the same object/task/blade identity and deduplication as the local summary.
 * Imported sourceMetadata is promoted for grouping only; original records are not changed. */
export function bladePassTasks(records: readonly BladePassRecording[]): BladePassTask[] {
  const normalized = records.filter(record => !bladePassUnavailableReason(record)).map(record => ({ ...record,
    pointCycle: bladePassMetadata(record) as FieldRecording["pointCycle"], windFarm: record.windFarm ?? record.sourceMetadata?.windFarm,
    turbine: record.turbine ?? record.sourceMetadata?.turbine, object: record.object ?? record.sourceMetadata?.object }));
  return summarizeBladeRecords(normalized).tasks.flatMap(task => task.collectionId ? task.blades.flatMap(blade => {
    const members = new Map<string, BladePassRecording>();
    for (const group of blade.groups) for (const station of group.stations) for (const record of station.records) members.set(record.id, record);
    return members.size ? [{ key: blade.key, taskKey: task.key, collectionId: task.collectionId!, bladeId: blade.bladeId,
      name: task.taskName, windFarm: task.windFarm, turbine: task.turbine, object: task.measurementObject,
      latestAt: task.latestAt, records: [...members.values()] }] : [];
  }) : []);
}

export const bladePassIsDiagnostic = (record: BladePassRecording) => record.diagnosticOnly === true || record.validMeasurement === false || bladePassMetadata(record)?.completion === "diagnostic_pass";
export const bladePassExecutionLabel = (record: BladePassRecording) => bladePassMetadata(record)?.executionMode === "manual_segments" ? "分段采集" : "自动跟随";
export const bladePassRecordLabel = (record: BladePassRecording) => bladePassIsDiagnostic(record) ?
  bladePassMetadata(record)?.passCompleteness === "confirmed" ? "诊断经过 · 待验证" : "诊断边界待确认" :
  bladePassMetadata(record)?.completion === "confirmed_pass" ? "完整经过" : "经过边界待确认";

/** Every angle uses its latest complete pass, balanced across radial points. */
export function defaultBladePassSelection(task: BladePassTask | undefined, includeDiagnostic = false): string[] {
  // A new plan/reference/radius starts a new observation group. Do not fill
  // missing angles of that group using old angles from another configuration.
  const groups = summarizeBladeRecords(task?.records ?? []).groups;
  const queues = bladePassPointGroups(task).map(point => {
    const candidates = groups.filter(group => group.radialPointId === point.id).sort((a, b) => {
      const latest = (group: typeof a) => Math.max(0, ...group.stations.flatMap(station => station.records.map(record => fieldDate(record.startedAt)?.getTime() ?? 0)));
      return latest(b) - latest(a) || b.lapIndex - a.lapIndex;
    });
    const current = new Set(candidates[0]?.stations.flatMap(station => station.records.map(record => record.id)) ?? []);
    return point.angles.flatMap(angle => {
      const eligible = angle.records.filter(record => {
        if (!current.has(record.id)) return false;
        const meta = bladePassMetadata(record)!;
        return !bladePassIsDiagnostic(record) && meta.completion === "confirmed_pass" ||
          includeDiagnostic && bladePassIsDiagnostic(record) && meta.completion === "diagnostic_pass" && meta.passCompleteness === "confirmed";
      }).sort((a, b) => (fieldDate(b.startedAt)?.getTime() ?? 0) - (fieldDate(a.startedAt)?.getTime() ?? 0) || a.id.localeCompare(b.id));
      return eligible[0] ? [eligible[0].id] : [];
    });
  });
  const selected: string[] = [];
  for (let index = 0; queues.some(queue => index < queue.length) && selected.length < BLADE_PASS_RECORD_LIMIT; index++)
    for (const queue of queues) if (queue[index] && selected.length < BLADE_PASS_RECORD_LIMIT) selected.push(queue[index]);
  return selected;
}

export function bladePassPointGroups(task: BladePassTask | undefined): BladePassPointGroup[] {
  const points = new Map<string, BladePassPointGroup>();
  for (const record of task?.records ?? []) {
    const meta = bladePassMetadata(record);
    if (!meta?.radialPointId) continue;
    const point = points.get(meta.radialPointId) ?? { id: meta.radialPointId, name: meta.radialPointName || meta.radialPointId, radius: meta.radiusM, records: [], angles: [] };
    point.records.push(record); points.set(point.id, point);
  }
  for (const point of points.values()) {
    const angles = new Map<string, BladePassAngleGroup>();
    for (const record of point.records) {
      const angle = bladePassMetadata(record)?.azimuthDeg, key = Number.isFinite(angle) ? String(angle) : "unknown";
      const group = angles.get(key) ?? { key, azimuthDeg: Number.isFinite(angle) ? angle! : null, records: [] };
      group.records.push(record); angles.set(key, group);
    }
    point.angles = [...angles.values()].sort((a,b) => (a.azimuthDeg ?? Infinity) - (b.azimuthDeg ?? Infinity));
  }
  return [...points.values()].sort((a,b) => (a.radius ?? Infinity) - (b.radius ?? Infinity) || a.id.localeCompare(b.id));
}

export function preferredBladePassTask(tasks: readonly BladePassTask[], preferredIds: readonly string[], currentKey?: string) {
  for (const id of preferredIds) {
    const preferred = tasks.find(task => task.records.some(record => record.id === id));
    if (preferred) return preferred;
  }
  return tasks.find(task => task.key === currentKey) ?? tasks[0];
}

/** Every payload is intersected with the active task, even after asynchronous refresh. */
export function selectedBladePassRecords(task: BladePassTask | undefined, ids: readonly string[]) {
  const selected = new Set(ids);
  return (task?.records ?? []).filter(record => selected.has(record.id)).slice(0, BLADE_PASS_RECORD_LIMIT);
}

export function bladePassWaveSeries(source: BladePassSource) {
  return source.segments.map((segment, index) => ({
    name: `有效段 ${index + 1}`, type: "line", showSymbol: false, connectNulls: false,
    data: (segment.plotTimeDomain ?? segment.timeDomain).seconds.map((seconds, sample) => {
      const value = (segment.plotTimeDomain ?? segment.timeDomain).values[sample];
      return [seconds, value == null ? null : value * 1000];
    }),
  }));
}

export const bladePassNumber = (value: number | null | undefined, digits = 4) => value == null || !Number.isFinite(value) ? "—" : Number(value.toPrecision(digits)).toLocaleString("zh-CN", { maximumFractionDigits: 9 });

const reasonLabels: Record<string, string> = {
  diagnostic_pass: "诊断记录，需开启诊断分析", pass_boundary_outside_recording: "经过边界超出本记录，缺少完整原始数据", diagnostic_requires_opt_in: "未开启诊断数据分析", unconfirmed_pass: "经过完整性待确认", missing_initial_background: "缺少进入前背景", exit_baseline_mismatch: "离开回波与背景不一致",
  recording_not_complete: "记录未完整保存", missing_entry: "缺少叶片进入", missing_exit: "缺少叶片离开", signal_gap: "回波中断",
  missing_pass_boundaries: "缺少有效经过边界", invalid_pass_boundaries: "经过边界无效", no_usable_segment: "没有可用连续段",
  outside_confirmed_pass: "处于已确认经过范围之外", nonfinite_velocity: "速度值无效", overrange: "速度超量程",
  missing_rssi: "缺少 RSSI", invalid_rssi: "RSSI 无效", low_rssi: "RSSI 低于阈值", segment_shorter_than_64_samples: "连续段不足 64 个样本",
};
export const bladePassReason = (reason: string) => reasonLabels[reason] || reason;
