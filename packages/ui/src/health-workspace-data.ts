import type { Item } from "./api";
import type { CaptureSummary } from "./capture-types";
import { healthGrade } from "./health-data";
import type { BladePassSource } from "./web-blade-passes-data";

type RecordData = Record<string, any>;
export type HealthAmplitudeThresholds = { attentionRatio: number; warningRatio: number; rms?: number; peak?: number; peakToPeak?: number };
export type HealthAmplitudeConfig = { id: string | null; tenant: string; revision: string; values: HealthAmplitudeThresholds | null };
export function validateHealthAmplitudeRules(value: RecordData): HealthAmplitudeThresholds {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("预警规则无效");
  const { attentionRatio, warningRatio } = value;
  if (!Number.isFinite(attentionRatio) || !Number.isFinite(warningRatio) || !(0 < attentionRatio && attentionRatio < warningRatio && warningRatio < 1)) throw Error("分级比例应满足 0 < 注意 < 预警 < 1");
  const result: HealthAmplitudeThresholds = { attentionRatio, warningRatio };
  for (const key of ["rms", "peak", "peakToPeak"] as const) {
    if (value[key] == null || value[key] === "") continue;
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0) throw Error("幅值阈值须为正数，留空表示不判定");
    result[key] = value[key];
  }
  return result;
}
export type HealthRecord = {
  key: string; kind: "task" | "capture" | "import"; id: string; analysisId?: string;
  tenant: string; turbineKey: string; turbine: string; windFarm: string;
  taskKey: string; taskName: string; blade: string; point: string; pointId: string;
  radius?: number; angle?: number; rpm?: number; timestamp: number;
  raw: RecordData; quality: string | null;
};
export type HealthMeasurement = {
  rms: number; peak: number; peakToPeak: number; frequency?: number;
  seconds: number; source?: BladePassSource; note: string;
};
export const healthTime = (value: unknown): number => {
  if (value == null || value === "") return 0;
  const time = typeof value === "number" ? (value < 1e11 ? value * 1000 : value) : Date.parse(String(value));
  return Number.isFinite(time) ? time : 0;
};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const healthPointCycle = (raw: RecordData) => raw.pointCycle ?? raw.sourceMetadata?.pointCycle;
/** Simulation flags take precedence over an outer measured label. No name-based guessing. */
export function isHealthDemo(raw: RecordData): boolean {
  return ["demo", "simulation", "mock"].includes(raw.source) || raw.demo === true || Boolean(raw.simulation) ||
    (raw.sourceMetadata ? isHealthDemo(raw.sourceMetadata) : false);
}
export function healthRecordIssue(raw: RecordData, kind: HealthRecord["kind"], uploaded = true): string | null {
  if (!uploaded) return "等待完整上传";
  if (raw.error || raw.status === "error") return "采集异常";
  if (kind !== "task" && raw.status !== "complete") return "记录未完成";
  if (!["polytec_ivs500", "device", "measured", "real"].includes(raw.source)) return "数据来源待确认";
  const pc = healthPointCycle(raw);
  if (pc?.diagnosticOnly || pc?.validMeasurement === false || pc?.completion === "diagnostic_pass") return "诊断测试记录";
  if (pc) {
    if (pc.mode !== "automatic_stations" || !pc.bladeId || !pc.radialPointId) return "叶片与测点归属不完整";
    if (pc.completion !== "confirmed_pass" || pc.outcome !== "observed") return "叶片经过待确认";
    const h = pc.handoff;
    const indices = [h?.entrySampleIndex, h?.entryConfirmedSampleIndex, h?.exitSampleIndex, h?.exitConfirmedSampleIndex];
    if (h?.reason !== "blade_left" || !indices.every(v => Number.isInteger(v) && v >= 0 && v < raw.samples) ||
      !(indices[0] <= indices[1] && indices[1] + 1 < indices[2] && indices[2] <= indices[3])) return "缺少有效经过边界";
  } else if (kind !== "task") return "缺少叶片经过边界";
  return null;
}
export function healthRecords(tasks: Item[], captures: CaptureSummary[], imported: RecordData[], ownTenant: string): HealthRecord[] {
  const records: HealthRecord[] = [];
  const prepared = new Map(imported.filter(r => r.cloudCaptureId).map(r => [r.cloudCaptureId, r.id]));
  const capturesById = new Set(captures.map(c => c.id));
  function add(raw: RecordData, kind: HealthRecord["kind"], id: string, tenant: string, scope: string, uploaded = true, analysisId?: string) {
    if (isHealthDemo(raw)) return;
    const pc = healthPointCycle(raw), turbine = text(raw.turbine), windFarm = text(raw.windFarm);
    const turbineKey = JSON.stringify([tenant, windFarm, turbine || `unassigned:${scope}:${id}`]);
    const collection = text(pc?.collectionId) || text(raw.collectionId) || id;
    const period = pc?.nominalPeriodSeconds;
    records.push({ key: `${kind}:${id}`, kind, id, analysisId, tenant, turbineKey, turbine, windFarm,
      taskKey: JSON.stringify([turbineKey, scope, collection]), taskName: text(raw.name) || "未命名任务",
      blade: text(pc?.bladeId) || text(raw.bladeId), pointId: text(pc?.radialPointId) || text(raw.pointId) || text(raw.point),
      point: text(pc?.radialPointName) || text(raw.point), radius: finite(pc?.radiusM) ? pc.radiusM : undefined,
      angle: finite(pc?.azimuthDeg) ? pc.azimuthDeg : undefined,
      rpm: finite(period) && period > 0 ? 60 / period : finite(raw.rpm) && raw.rpm > 0 ? raw.rpm : undefined,
      timestamp: healthTime(raw.testTime ?? raw.sourceStartedAt ?? raw.sourceMetadata?.startedAt ?? raw.sourceSampleOrigin ?? raw.startedAt), raw,
      quality: healthRecordIssue(raw, kind, uploaded) });
  }
  for (const task of tasks) add(task, "task", task.id, task.recordTenant || ownTenant, `task:${task.ownerId || ""}`);
  for (const capture of captures) add(capture.recording, "capture", capture.id, capture.tenant, `${capture.ownerId}:${capture.clientId}`, capture.uploadState === "complete", prepared.get(capture.id));
  for (const record of imported) {
    if (record.cloudCaptureId && capturesById.has(record.cloudCaptureId)) continue;
    add(record, "import", record.id, ownTenant, "import", true, record.id);
  }
  return records.sort((a, b) => b.timestamp - a.timestamp || a.key.localeCompare(b.key));
}
export function latestHealthRecords(records: HealthRecord[]) {
  const seen = new Set<string>();
  return [...records].sort((a, b) => b.timestamp - a.timestamp).filter(record => {
    const key = JSON.stringify([record.taskKey, record.blade, record.pointId || record.key, record.angle]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function healthTaskMeasurement(record: HealthRecord): HealthMeasurement | null {
  if (record.kind !== "task" || record.quality) return null;
  // A full rotating task without pass metadata is not a blade-only measurement.
  if ((record.rpm ?? 0) > 0 || healthPointCycle(record.raw)) return null;
  const values = record.raw.samples, rate = record.raw.sampleRate;
  const unit = record.raw.channels?.length === 1 ? record.raw.channels[0].unit : record.raw.unit;
  const factor = unit === "m/s" ? 1000 : unit === "mm/s" ? 1 : null;
  if (!factor || !Array.isArray(values) || values.length < 2 || !values.every(finite) || !finite(rate) || rate <= 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let sum = 0, lo = Infinity, hi = -Infinity;
  for (const value of values) { const v = (value - mean) * factor; sum += v * v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return { rms: Math.sqrt(sum / values.length), peak: Math.max(Math.abs(lo), Math.abs(hi)), peakToPeak: hi - lo,
    seconds: values.length / rate, note: "静止连续记录，去均值速度指标（mm/s）" };
}
export function healthPassMeasurement(source?: BladePassSource): HealthMeasurement | null {
  if (!source || source.status !== "included" || source.simulation || !source.metrics || !source.segments.length) return null;
  const m = source.metrics;
  if (![m.rmsVelocityMps, m.peakVelocityMps, m.peakToPeakVelocityMps].every(finite)) return null;
  // Frequency belongs to the longest continuous segment. Never FFT concatenated gaps.
  const segment = [...source.segments].sort((a, b) => b.durationSeconds - a.durationSeconds)[0];
  let frequency: number | undefined, amplitude = 0;
  segment.spectrum?.frequencies.forEach((hz, i) => {
    const value = segment.spectrum!.amplitudes[i];
    if (hz > 0 && finite(value) && value > amplitude) { amplitude = value; frequency = hz; }
  });
  return { rms: m.rmsVelocityMps * 1000, peak: m.peakVelocityMps * 1000, peakToPeak: m.peakToPeakVelocityMps * 1000,
    frequency, seconds: source.segments.reduce((n, s) => n + s.durationSeconds, 0), source,
    note: "叶片有效段 · 去均值速度指标；主频取最长连续段，不代表固有频率" };
}
export function healthMeasurementState(record: HealthRecord, measurement?: HealthMeasurement | null, settings?: HealthAmplitudeThresholds | null) {
  if (record.quality) return { label: record.quality, tone: "gray", grade: null };
  if (!measurement) return { label: "待分析", tone: "gray", grade: null };
  const grades = settings ? (["rms", "peak", "peakToPeak"] as const).flatMap(key => {
    const grade = healthGrade(measurement[key], settings[key]!, settings);
    return grade === null ? [] : [grade];
  }) : [];
  const grade = grades.length ? Math.max(...grades) : null;
  return { label: grade === null ? "未配置阈值" : ["幅值未超限", "注意", "预警", "报警"][grade], tone: grade === null ? "gray" : grade === 0 ? "green" : grade === 3 ? "red" : "amber", grade };
}
export function comparableHealthRecord(a: HealthRecord, b: HealthRecord) {
  return a.key !== b.key && a.turbineKey === b.turbineKey && a.blade !== "" && a.blade === b.blade &&
    a.pointId !== "" && a.pointId === b.pointId && a.radius === b.radius && a.angle === b.angle &&
    a.rpm !== undefined && b.rpm !== undefined && Math.abs(a.rpm - b.rpm) < .001 && !a.quality && !b.quality;
}
