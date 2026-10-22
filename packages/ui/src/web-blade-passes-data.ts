import type { FieldAutomaticRecord, FieldRecording } from "./field-types";

export type BladePassRecording = FieldRecording & { sourceMetadata?: { pointCycle?: FieldAutomaticRecord } };
export type BladePassTask = { key: string; collectionId: string; bladeId: string; name: string; records: BladePassRecording[] };
export type BladePassMetrics = { rmsVelocityMps: number; peakVelocityMps: number; peakToPeakVelocityMps: number };
export type BladePassSegment = {
  start: number; end: number; samples: number; durationSeconds: number; metrics: BladePassMetrics;
  timeDomain: { sampleIndices: number[]; seconds: number[]; values: number[] };
  plotTimeDomain?: { sampleIndices: number[]; seconds: number[]; values: (number | null)[]; representation?: string };
  plotFilter?: { method: string; thresholdMps: number; flaggedSteps: number; hiddenSamples: number; hiddenTimeBuckets: number; plottedSamples: number; effect: string };
  spectrum?: { frequencies: number[]; amplitudes: number[]; frequencySpacingHz: number } | null;
};
export type BladePassSource = {
  recordingId: string; name: string; sessionId: string; radialPointId: string; radialPointName: string;
  radiusM: number; azimuthDeg: number; sampleRate: number; sampleOrigin: number;
  status: "included" | "excluded"; reason?: string; candidateRange?: { start: number; end: number } | null;
  validRanges: { start: number; end: number; samples: number }[]; exclusions: { reason: string; samples: number }[];
  metrics?: BladePassMetrics | null; segments: BladePassSegment[]; provenance?: unknown;
  source?: string; simulation?: boolean;
};
export type BladePassDistribution = {
  azimuthDeg: number; metric: "rmsVelocityMps"; unit: "m/s";
  points: { radialPointId: string; radialPointName: string; radiusM: number; value: number; validSamples: number; recordingIds: string[] }[];
};
export type BladePassResult = {
  algorithmVersion: string; parameters: Record<string, unknown>; collectionId: string; bladeId: string;
  phaseAvailable: false; modeShapeUnavailableReason: string;
  coverage: { selectedRecords: number; includedRecords: number; excludedRecords: number; rawSamples: number; validSamples: number; validSeconds: number; segmentCount: number };
  sources: BladePassSource[];
  points: { radialPointId: string; radialPointName: string; radiusM: number; stations: { azimuthDeg: number; recordingIds: string[]; validSamples: number; validSeconds: number; metrics: BladePassMetrics }[] }[];
  amplitudeDistributions: BladePassDistribution[]; warnings: string[];
  hasSimulation?: boolean;
  synthesis?: BladeSynthesis;
};

export type BladeMergedSegment = {
  segmentId: string; recordingId: string; sourceRecordingId: string; azimuthDeg: number;
  originalStart: number; originalEnd: number; sampleRate: number;
  mergedStart: number; mergedEnd: number; compressedStartSeconds: number; compressedEndSeconds: number;
  originalStartSeconds: number; originalEndSeconds: number;
  timeDomain: BladePassSegment["timeDomain"];
  plotTimeDomain?: NonNullable<BladePassSegment["plotTimeDomain"]>;
  plotFilter?: BladePassSegment["plotFilter"];
  discontinuityAudit?: { count: number; maxStepMps: number; firstOriginalSampleIndices: number[] };
};
export type BladeMergedPoint = {
  radialPointId: string; radialPointName: string; radiusM: number;
  samples: number; durationSeconds: number; segments: BladeMergedSegment[];
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

/** Group by explicit identity only. A matching task name never joins two collections. */
export function bladePassTasks(records: readonly BladePassRecording[]): BladePassTask[] {
  const tasks = new Map<string, BladePassTask>();
  const seen = new Set<string>();
  for (const record of records) {
    const metadata = bladePassMetadata(record);
    if (seen.has(record.id) || !metadata || bladePassUnavailableReason(record)) continue;
    seen.add(record.id);
    const { collectionId, bladeId, radialPointId } = metadata;
    if (!collectionId || collectionId.length !== 32 || !/^[a-f0-9]{32}$/.test(collectionId) || !bladeId?.trim() || !radialPointId?.trim()) continue;
    const key = JSON.stringify([collectionId, bladeId]);
    const existing = tasks.get(key);
    if (existing) existing.records.push(record);
    else tasks.set(key, { key, collectionId, bladeId, name: record.name, records: [record] });
  }
  return [...tasks.values()];
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
  recording_not_complete: "记录未完整保存", missing_entry: "缺少叶片进入", missing_exit: "缺少叶片离开", signal_gap: "回波中断",
  missing_pass_boundaries: "缺少有效经过边界", invalid_pass_boundaries: "经过边界无效", no_usable_segment: "没有可用连续段",
  outside_confirmed_pass: "处于已确认经过范围之外", nonfinite_velocity: "速度值无效", overrange: "速度超量程",
  missing_rssi: "缺少 RSSI", invalid_rssi: "RSSI 无效", low_rssi: "RSSI 低于阈值", segment_shorter_than_64_samples: "连续段不足 64 个样本",
};
export const bladePassReason = (reason: string) => reasonLabels[reason] || reason;
