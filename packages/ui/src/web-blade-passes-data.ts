import { fieldDate, type FieldAutomaticRecord, type FieldRecording } from "./field-types";

export type BladePassRecording = FieldRecording & { sourceMetadata?: { pointCycle?: FieldAutomaticRecord; windFarm?: string; turbine?: string; object?: string } };
export type BladePassTaskIdentity = { collectionId: string; bladeId: string; windFarm: string; turbine: string; object: string };
export type BladePassCompositionTask = BladePassTaskIdentity & { recordingIds: string[] };
export type BladePassTask = BladePassTaskIdentity & { key: string; name: string; records: BladePassRecording[] };
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
  radiusM: number; azimuthDeg: number; sampleRate: number; sampleOrigin: number; executionMode?: "continuous" | "manual_segments";
  taskIdentity?: BladePassTaskIdentity;
  sampling?: { kind?: string; sourceSampleRate?: number; sourceSamples?: number; targetSampleRate?: number;
    recommendedMaxFrequencyHz?: number; filter?: string } | null;
  status: "included" | "excluded"; reason?: string; candidateRange?: { start: number; end: number } | null;
  validRanges: { start: number; end: number; samples: number }[]; sourceValidSamples?: number;
  exclusions: { reason: string; samples: number }[];
  metrics?: BladePassMetrics | null; segments: BladePassSegment[]; provenance?: unknown;
  source?: string; simulation?: boolean;
};
export type BladePassDistribution = {
  azimuthDeg: number; metric: "rmsVelocityMps"; unit: "m/s";
  points: { radialPointId: string; radialPointName: string; radiusM: number; value: number; validSamples: number; recordingIds: string[] }[];
};
export type BladePassResult = {
  algorithmVersion: string; parameters: Record<string, unknown>; collectionId: string; bladeId: string;
  composition?: { confirmedSameBlade: true; bladeLabel: string; tasks: BladePassCompositionTask[]; taskCount: number };
  phaseAvailable: false; modeShapeUnavailableReason: string;
  coverage: { selectedRecords: number; includedRecords: number; excludedRecords: number; rawSamples: number; analysisSamples?: number; validSamples: number; validSeconds: number; segmentCount: number };
  sources: BladePassSource[];
  points: { radialPointId: string; radialPointName: string; radiusM: number; stations: { azimuthDeg: number; recordingIds: string[]; validSamples: number; validSeconds: number; metrics: BladePassMetrics }[] }[];
  amplitudeDistributions: BladePassDistribution[]; warnings: string[];
  hasSimulation?: boolean;
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
  stitchedSpectrum?: { sampleRate: number; fftSampleRate: number; samples: number; frequencySpacingHz: number;
    frequencies: number[]; amplitudesMps: number[]; method: string };
  stitchInfo?: { segments: number; sampleRate: number; resampledSegments: number; fftSamples: number;
    originalSamples: number; method: string };
  stitchedWaveform?: { seconds: number[]; valuesMps: number[] };
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
  mergePlan?: { pointMerge: string; bladeComposition: string; sourceSegments: number };
  qualityWarnings?: string[];
};

export const BLADE_PASS_RECORD_LIMIT = 64;
export const bladePassMetadata = (record: BladePassRecording) => record.pointCycle ?? record.sourceMetadata?.pointCycle;
export const bladePassExecutionLabel = (record: BladePassRecording) => bladePassMetadata(record)?.executionMode === "manual_segments" ? "分段采集" : "自动点位";
const identityText = (value: unknown) => typeof value === "string" ? value.trim().normalize("NFC") : "";
export function bladePassTaskIdentity(record: BladePassRecording): BladePassTaskIdentity {
  const metadata = bladePassMetadata(record);
  return { collectionId: metadata?.collectionId ?? "", bladeId: metadata?.bladeId ?? "",
    windFarm: identityText(record.windFarm ?? record.sourceMetadata?.windFarm),
    turbine: identityText(record.turbine ?? record.sourceMetadata?.turbine),
    object: identityText(record.object ?? record.sourceMetadata?.object) };
}
export const bladePassTaskKey = (identity: BladePassTaskIdentity) => JSON.stringify([
  identity.collectionId, identity.bladeId, identity.windFarm, identity.turbine, identity.object]);
export const bladePassTaskLabel = (task: BladePassTask) => `${task.name} · 叶片 ${task.bladeId} · ${task.collectionId.slice(0, 8)}${[task.windFarm, task.turbine].filter(Boolean).length ? ` · ${[task.windFarm, task.turbine].filter(Boolean).join(" / ")}` : ""}`;
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

/** Group by stable task, operator-assigned blade and turbine/object scope. */
export function bladePassTasks(records: readonly BladePassRecording[]): BladePassTask[] {
  const tasks = new Map<string, BladePassTask>();
  const seen = new Set<string>();
  for (const record of records) {
    const metadata = bladePassMetadata(record);
    if (seen.has(record.id) || !metadata || bladePassUnavailableReason(record)) continue;
    seen.add(record.id);
    const { collectionId, bladeId, radialPointId } = metadata;
    if (!collectionId || collectionId.length !== 32 || !/^[a-f0-9]{32}$/.test(collectionId) || !bladeId?.trim() || !radialPointId?.trim()) continue;
    const identity = bladePassTaskIdentity(record), key = bladePassTaskKey(identity);
    const existing = tasks.get(key);
    if (existing) existing.records.push(record);
    else tasks.set(key, { key, ...identity, name: record.name, records: [record] });
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

export function preferredBladePassTasks(tasks: readonly BladePassTask[], preferredIds: readonly string[], currentKeys: readonly string[] = []) {
  const preferred = new Set(preferredIds);
  const found = tasks.filter(task => task.records.some(record => preferred.has(record.id)));
  if (found.length) return found;
  const current = tasks.filter(task => currentKeys.includes(task.key));
  return current.length ? current : tasks.slice(0, 1);
}

/** Intersect IDs with one exact task identity, even after refresh or stale UI state. */
export function selectedBladePassRecords(task: BladePassTask | undefined, ids: readonly string[]) {
  const selected = new Set(ids);
  return (task?.records ?? []).filter(record => selected.has(record.id) &&
    bladePassTaskKey(bladePassTaskIdentity(record)) === task?.key).slice(0, BLADE_PASS_RECORD_LIMIT);
}

/** Prefer the latest confirmed pass at every angle, round-robin across points.
 * This prevents repeated passes at P1 from consuming every slot before P2. */
export function defaultBladePassSelection(task: BladePassTask | undefined): string[] {
  const queues = bladePassPointGroups(task).map(point => point.angles.flatMap(angle => {
    const candidates = angle.records.filter(record => bladePassMetadata(record)?.completion === "confirmed_pass").sort((a, b) =>
      (fieldDate(b.startedAt)?.getTime() ?? 0) - (fieldDate(a.startedAt)?.getTime() ?? 0) || a.id.localeCompare(b.id));
    return candidates[0] ? [candidates[0].id] : [];
  }));
  const selected: string[] = [];
  for (let round = 0; queues.some(queue => round < queue.length) && selected.length < BLADE_PASS_RECORD_LIMIT; round++) {
    for (const queue of queues) if (queue[round] && selected.length < BLADE_PASS_RECORD_LIMIT) selected.push(queue[round]);
  }
  return selected;
}

/** Keep each source task attached to its selected recording IDs for explicit composition. */
export function bladePassAnalysisJobs(tasks: readonly BladePassTask[], taskKeys: readonly string[], selected: readonly string[]) {
  const keys = new Set(taskKeys), ids = new Set(selected);
  return tasks.filter(task => keys.has(task.key)).flatMap(task => {
    const matching = task.records.filter(record => ids.has(record.id) && bladePassTaskKey(bladePassTaskIdentity(record)) === task.key);
    if (matching.length > BLADE_PASS_RECORD_LIMIT) throw new Error(`任务 ${task.name} 最多选择 ${BLADE_PASS_RECORD_LIMIT} 条记录，请减少该任务的选择。`);
    return matching.length ? [{ task, records: matching,
      identity: { collectionId: task.collectionId, bladeId: task.bladeId, windFarm: task.windFarm, turbine: task.turbine,
        object: task.object, recordingIds: matching.map(record => record.id) } }] : [];
  });
}

export function bladePassCompositionError(jobs: ReturnType<typeof bladePassAnalysisJobs>, confirmed: boolean, bladeLabel: string): string | null {
  if (!jobs.length) return "请先选择至少一条与任务匹配的记录。";
  if (jobs.length > 1 && !confirmed) return "跨任务组合前，请确认这些采集任务的数据来自同一根实体叶片。";
  if (jobs.length > 1) {
    if (!bladeLabel.trim()) return "请填写这组测点对应的叶片标识。";
    if (bladeLabel.trim().length > 80) return "组合叶片标识不能超过 80 个字符。";
    const scopes = new Set(jobs.map(({ task }) => JSON.stringify([task.windFarm.trim().normalize("NFC"), task.turbine.trim().normalize("NFC"), task.object.trim().normalize("NFC")])));
    if (scopes.size > 1) return "所选任务的风场、风机或测量对象不一致，不能组合为同一根叶片。";
  }
  if (jobs.some(({ records }) => !records.length || records.some(record => !bladePassMetadata(record)))) return "所选记录与任务归属不匹配，请刷新后重新选择。";
  const points = new Map<string, number>();
  for (const { records } of jobs) for (const record of records) {
    const meta = bladePassMetadata(record)!;
    if (!Number.isFinite(meta.radiusM)) continue;
    const old = points.get(meta.radialPointId!);
    if (old !== undefined && old !== meta.radiusM) return `测点 ${meta.radialPointName || meta.radialPointId} 在不同任务中的半径不一致。`;
    points.set(meta.radialPointId!, meta.radiusM!);
  }
  if (jobs.length > 1 && new Set(points.values()).size < 2) return "至少选择两个不同半径的测点，才能组成叶片空间响应。";
  return null;
}

/** Build the two selection levels used by the segmented workflow. Identity is
 * explicit: angle groups never join records from another radial point. */
export function bladePassPointGroups(task: BladePassTask | undefined): BladePassPointGroup[] {
  const points = new Map<string, BladePassPointGroup>();
  for (const record of task?.records ?? []) {
    const metadata = bladePassMetadata(record);
    if (!metadata?.radialPointId) continue;
    const point = points.get(metadata.radialPointId) ?? { id: metadata.radialPointId, name: metadata.radialPointName || metadata.radialPointId,
      radius: metadata.radiusM, records: [], angles: [] };
    point.records.push(record);
    points.set(metadata.radialPointId, point);
  }
  for (const point of points.values()) {
    const angles = new Map<string, BladePassAngleGroup>();
    for (const record of point.records) {
      const angle = bladePassMetadata(record)?.azimuthDeg;
      const key = Number.isFinite(angle) ? String(angle) : "unknown";
      const group = angles.get(key) ?? { key, azimuthDeg: Number.isFinite(angle) ? angle! : null, records: [] };
      group.records.push(record); angles.set(key, group);
    }
    point.angles = [...angles.values()].sort((a, b) => (a.azimuthDeg ?? Infinity) - (b.azimuthDeg ?? Infinity));
  }
  return [...points.values()].sort((a, b) => (a.radius ?? Infinity) - (b.radius ?? Infinity) || a.id.localeCompare(b.id));
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
  unconfirmed_pass: "经过完整性待确认", missing_initial_background: "缺少进入前背景", exit_baseline_mismatch: "离开回波与背景不一致",
  recording_not_complete: "记录未完整保存", missing_entry: "缺少叶片进入", missing_exit: "缺少叶片离开", signal_gap: "回波中断",
  missing_pass_boundaries: "缺少有效经过边界", invalid_pass_boundaries: "经过边界无效", no_usable_segment: "没有可用连续段",
  outside_confirmed_pass: "处于已确认经过范围之外", nonfinite_velocity: "速度值无效", overrange: "速度超量程",
  missing_rssi: "缺少 RSSI", invalid_rssi: "RSSI 无效", low_rssi: "RSSI 低于阈值", segment_shorter_than_64_samples: "连续段不足 64 个样本",
};
export const bladePassReason = (reason: string) => reasonLabels[reason] || reason;
