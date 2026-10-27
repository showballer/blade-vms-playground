import assert from "node:assert/strict";
import { healthRecords, healthRecordIssue, healthTaskMeasurement, latestHealthRecords, healthMeasurementState, healthPassMeasurement, comparableHealthRecord, validateHealthAmplitudeRules } from "../packages/ui/src/health-workspace-data";
import type { CaptureSummary } from "../packages/ui/src/capture-types";
import type { BladePassSource } from "../packages/ui/src/web-blade-passes-data";

const raw = (patch: Record<string, any> = {}) => ({ id: "r1", name: "同名任务", source: "polytec_ivs500", turbine: "01", windFarm: "A", status: "complete", samples: 1000, sampleRate: 1000, startedAt: 1700000000,
  pointCycle: { mode: "automatic_stations", collectionId: "c1", bladeId: "2", radialPointId: "p1", radialPointName: "P1", radiusM: .16, azimuthDeg: 0,
    nominalPeriodSeconds: 5, completion: "confirmed_pass", outcome: "observed", handoff: { reason: "blade_left", entrySampleIndex: 10, entryConfirmedSampleIndex: 30, exitSampleIndex: 100, exitConfirmedSampleIndex: 130 } }, ...patch });
const capture = (patch: Record<string, any> = {}): CaptureSummary => ({ id: "c1", tenant: "a", ownerId: "u1", clientId: "mac", uploadState: "complete", recording: raw(), ...patch } as CaptureSummary);
let count = 0;
function check(name: string, fn: () => void) { fn(); console.log("PASS", name); count++; }
check("no baseline and no genuine data produces an empty workspace", () => {
  assert.equal(healthRecords([{ id: "demo", name: "demo", source: "demo" }], [], [], "a").length, 0);
  assert.equal(healthRecords([], [capture({ recording: raw({ simulation: { point: "P1" } }) })], [raw({ sourceMetadata: { source: "demo" } })], "a").length, 0);
});
check("identity separates tenant, wind farm, client and collection; never groups by task name", () => {
  const records = healthRecords([], [capture(), capture({ id: "c2", tenant: "b" }), capture({ id: "c3", clientId: "win" }), capture({ id: "c4", recording: raw({ windFarm: "B" }) }), capture({ id: "c5", recording: raw({ pointCycle: { ...raw().pointCycle, collectionId: "other" } }) })], [], "a");
  assert.equal(new Set(records.map(r => r.turbineKey)).size, 3);
  assert.equal(new Set(records.map(r => r.taskKey)).size, 5);
});
check("prepared cloud copies do not duplicate source captures", () => {
  const records = healthRecords([], [capture()], [raw({ id: "prepared", cloudCaptureId: "c1" })], "a");
  assert.equal(records.length, 1); assert.equal(records[0].analysisId, "prepared");
});
check("upload, diagnosis, source and boundary checks precede health grading", () => {
  assert.equal(healthRecordIssue(raw(), "capture", false), "等待完整上传");
  assert.equal(healthRecordIssue(raw({ source: "offline" }), "import"), "数据来源待确认");
  for (const patch of [{ diagnosticOnly: true }, { validMeasurement: false }, { completion: "diagnostic_pass" }]) assert.equal(healthRecordIssue(raw({ pointCycle: { ...raw().pointCycle, ...patch } }), "capture"), "诊断测试记录");
  assert.equal(healthRecordIssue(raw({ pointCycle: { ...raw().pointCycle, handoff: {} } }), "capture"), "缺少有效经过边界");
  assert.equal(healthRecordIssue(raw(), "capture"), null);
});
check("new failed repeat is not hidden behind an older successful record", () => {
  const records = healthRecords([], [capture(), capture({ id: "new", recording: raw({ startedAt: 1700000010, error: "interrupted" }) })], [], "a");
  const latest = latestHealthRecords(records); assert.equal(latest.length, 1); assert.equal(latest[0].quality, "采集异常");
});
check("measurement is not health: absent rules, partial data and diagnostic flags stay explicit", () => {
  const record = healthRecords([], [capture()], [], "a")[0], metric = { rms: 2, peak: 3, peakToPeak: 6, seconds: 1, note: "" };
  assert.equal(healthMeasurementState(record).label, "待分析");
  assert.equal(healthMeasurementState(record, metric).label, "未配置阈值");
  const rules = validateHealthAmplitudeRules({ rms: 2, attentionRatio: .6, warningRatio: .8 });
  assert.equal(healthMeasurementState(record, metric, rules).grade, 3);
  assert.equal(healthMeasurementState({ ...record, quality: "诊断测试记录" }, metric, rules).grade, null);
});
check("real stationary samples use explicit units and centered RMS; rotating whole-wave data is not substituted", () => {
  const [record] = healthRecords([{ id: "task", name: "test", source: "measured", turbine: "1", rpm: 0, samples: [1, -1, 1, -1], sampleRate: 4, channels: [{ unit: "m/s" }] }], [], [], "a");
  const value = healthTaskMeasurement(record)!; assert.equal(value.rms, 1000); assert.equal(value.peakToPeak, 2000); assert.equal(value.seconds, 1);
  assert.equal(healthTaskMeasurement({ ...record, rpm: 12 }), null);
  assert.equal(healthTaskMeasurement({ ...record, raw: { ...record.raw, channels: [] } }), null);
});
check("native metrics convert m/s once; peak frequency comes from a continuous segment only", () => {
  const source = { status: "included", metrics: { rmsVelocityMps: .001, peakVelocityMps: .002, peakToPeakVelocityMps: .004 }, segments: [{ durationSeconds: .1, spectrum: { frequencies: [0, 10, 20], amplitudes: [5, .1, .2] } }] } as BladePassSource;
  assert.equal(healthPassMeasurement(source)!.rms, 1); assert.equal(healthPassMeasurement(source)!.frequency, 20);
  assert.equal(healthPassMeasurement({ ...source, simulation: true }), null); assert.equal(healthPassMeasurement(), null);
});
check("history requires matching blade, radius, angle and rpm, not just matching labels", () => {
  const [record] = healthRecords([], [capture()], [], "a"), other = { ...record, key: "new" };
  assert.equal(comparableHealthRecord(record, other), true);
  for (const patch of [{ blade: "3" }, { radius: .3 }, { angle: 90 }, { rpm: 6 }, { rpm: undefined }, { quality: "诊断测试记录" }]) assert.equal(comparableHealthRecord(record, { ...other, ...patch }), false);
});
check("rules can omit unsupported metrics and clear thresholds without treating blank as zero", () => {
  assert.deepEqual(validateHealthAmplitudeRules({ attentionRatio: .6, warningRatio: .8, rms: "", peak: null }), { attentionRatio: .6, warningRatio: .8 });
  for (const patch of [{ rms: 0 }, { peak: "2" }, { attentionRatio: .9 }, { warningRatio: 1 }]) assert.throws(() => validateHealthAmplitudeRules({ rms: 2, attentionRatio: .6, warningRatio: .8, ...patch }));
});
console.log(`${count} health workspace checks passed`);
