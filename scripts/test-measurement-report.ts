import assert from "node:assert/strict";
import { buildMeasurementReportCoverage } from "../apps/web/lib/measurement-api";

const context = { farmId: "f", turbineId: "t", bladeId: "b", positionId: "p", campaignId: "c" };
const objects = [
  { id: "f", name: "风场", kind: "farm" },
  { id: "t", name: "风机", kind: "turbine" },
  { id: "b", name: "叶片2", kind: "blade" },
  { id: "p", name: "P1", kind: "position" },
  { id: "c", name: "任务", kind: "campaign" },
];
const sources = Array.from({ length: 20 }, (_, i) => ({
  key: `capture:${i}`, reference: { kind: "capture", id: String(i) }, context,
  name: "叶片2五点", raw: { diagnosticOnly: true, validMeasurement: false, pointCycle: {
    azimuthDeg: (i % 4) * 90,
    continuousSession: { sampleClock: "continuous_session_raw", sampleStart: 21000, sampleEndExclusive: 41000 },
    handoff: { sampleClock: "continuous_session_raw", entrySampleIndex: i === 1 ? 20000 : 22000, exitConfirmedSampleIndex: 40000 },
  } },
}));
const results = sources.filter((_, i) => i !== 1).map((s) => ({ sourceKey: s.key }));
const report = buildMeasurementReportCoverage(sources, results, objects);
assert.deepEqual(report.coverage, {
  registeredSources: 20, analyzedSources: 19, unanalyzedSources: 1, complete: false,
  meaning: "已关联来源的分析覆盖，不代表物理整圈连续覆盖或健康结论",
});
assert.equal(report.excludedSources[0].azimuthDeg, 90);
assert.equal(report.excludedSources[0].names.position, "P1");
assert.equal(report.excludedSources[0].diagnosticOnly, true);
assert.match(report.excludedSources[0].reason, /缺少经过头部/);
assert.equal(report.excludedSources[0].reasonCode, "pass_boundary_outside_recording");
const combined = buildMeasurementReportCoverage(sources, [{ sourceKeys: sources.map((s) => s.key) }], objects);
assert.equal(combined.coverage.analyzedSources, 20);
assert.equal(combined.coverage.complete, true);
assert.deepEqual(combined.excludedSources, []);
assert.equal(buildMeasurementReportCoverage([], [], objects).coverage.complete, false);
const unknown = buildMeasurementReportCoverage([{ ...sources[0], raw: {} }], [], objects);
assert.match(unknown.excludedSources[0].reason, /尚无成功分析结果/);
console.log("PASS report source coverage: 19/20 with missing entry, grouped source keys, explicit unknown, no fabricated completeness");
