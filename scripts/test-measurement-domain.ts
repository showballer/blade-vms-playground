import assert from "node:assert/strict";
import {
  assessMeasurement,
  bladeDisplaySlots,
  canonicalPositionCode,
  measurementHistory,
  measurementAlertRank,
  isDiagnosticMeasurement,
  conditionWindow,
  initialDamageRules,
  responseDistribution,
  validateDamageRules,
  validateWindRows,
} from "../packages/ui/src/measurement-domain";
const context = {
  farmId: "f",
  turbineId: "t",
  bladeId: "b",
  positionId: "p",
  campaignId: "c",
};
const feature = (freq = 50, rms = 1) => ({
  status: "analyzed",
  algorithmVersion: "v1",
  parameters: { detrend: "constant", windowSeconds: 1 },
  metrics: { rmsVelocityMps: rms },
  peaks: [{ frequencyHz: freq, bandRmsVelocityMps: rms }],
  spectrum: {
    resolutionHz: 1, completeBins: true,
    frequencies: Array.from({ length: 101 }, (_, i) => i),
    psd: Array.from({ length: 101 }, (_, i) => i === freq ? rms ** 2 : 0),
  },
});
const row = (i: number, f = 50, rms = 1) => ({
  id: String(i),
  context: { ...context, campaignId: String(i) },
  createdAt: String(i),
  measuredAt: i * 1000,
  azimuthDeg: 0,
  condition: { status: "matched", windSpeed: 3, rpm: 12 },
  features: feature(f, rms),
  referenceApproved: true,
});
const refs = [row(1), row(2), row(3)];
assert.equal(
  assessMeasurement(row(5, 40, 2), refs, initialDamageRules).status,
  "review",
);
assert.equal(
  assessMeasurement(
    row(5, 40, 2),
    [...refs, { ...row(4, 40, 2), referenceApproved: false }],
    initialDamageRules,
  ).status,
  "suspected",
);
assert.equal(
  assessMeasurement(row(5), refs, initialDamageRules).status,
  "within_reference",
);
assert.equal(
  assessMeasurement(
    { ...row(5), condition: { status: "unmatched" } },
    refs,
    initialDamageRules,
  ).status,
  "insufficient",
);
assert.equal(
  assessMeasurement({ ...row(5), azimuthDeg: 90 }, refs, initialDamageRules)
    .status,
  "insufficient",
);
assert.equal(
  assessMeasurement(row(5), [row(1), row(1), row(1)], initialDamageRules)
    .status,
  "insufficient",
);
assert.equal(
  assessMeasurement(
    { ...row(5), features: { ...feature(), algorithmVersion: "v2" } },
    refs,
    initialDamageRules,
  ).status,
  "insufficient",
);
assert.equal(
  assessMeasurement(
    {
      ...row(5),
      features: { ...feature(40, 2), spectrum: { resolutionHz: 20 } },
    },
    refs,
    initialDamageRules,
  ).status,
  "within_reference",
);
assert.throws(() =>
  validateDamageRules({ ...initialDamageRules, minCampaigns: 1 }),
);
assert.throws(() =>
  validateWindRows([
    { time: "2026-10-27 10:00:00", turbineCode: "T1", windSpeed: 1, rpm: 12 },
  ]),
);
const wind = {
  time: "2026-10-27T10:00:00+08:00",
  turbineCode: "T1",
  windSpeed: 3,
  rpm: 12,
};
const validated = validateWindRows([wind]);
assert.equal(validated[0].time, "2026-10-27T02:00:00.000Z");
assert.throws(() => validateWindRows([wind, wind]));
assert.equal(
  conditionWindow(
    [{ id: "w", farmId: "f", rows: validated }],
    "f",
    "T1",
    Date.parse(wind.time) + 1,
    Date.parse(wind.time) + 1000,
  ).status,
  "unmatched",
);
assert.equal(
  conditionWindow(
    [{ id: "w", farmId: "f", rows: validated }],
    "f",
    "T1",
    Date.parse(wind.time),
    Date.parse(wind.time) + 1000,
  ).samples,
  1,
);
const objects: any[] = [
  { id: "b", kind: "blade", parentId: "t", code: "1", name: "叶片1" },
  {
    id: "p",
    kind: "position",
    parentId: "b",
    code: "P1",
    name: "P1",
    radiusM: 0.2,
  },
];
const distribution = responseDistribution([row(1)], objects, {
  campaignId: "1",
  turbineId: "t",
  azimuthDeg: 0,
  frequencyHz: 50,
});
assert.equal(distribution.curves[0].points.length, 5);
assert.equal(distribution.curves[0].points[0].amplitudeMps, 1);
assert.equal(distribution.curves[0].points[1].amplitudeMps, null);
assert.equal(distribution.phaseAvailable, false);
const diagnostic = { ...row(1), diagnosticOnly: true, validMeasurement: false };
assert.equal(isDiagnosticMeasurement(diagnostic), true);
assert.equal(isDiagnosticMeasurement({ metadata: { pointCycle: { completion: "diagnostic_pass" } } }), true);
assert.equal(assessMeasurement(diagnostic, refs, initialDamageRules).label, "诊断数据");
assert.equal(assessMeasurement(row(5), refs.map(r => ({ ...r, diagnosticOnly: true })), initialDamageRules).status, "insufficient");
assert.equal(measurementAlertRank({ ...diagnostic, features: { events: [{}] }, assessment: { status: "suspected" } }), 2);
assert.throws(() => responseDistribution([diagnostic], objects, {
  campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 50,
}));
const diagnosticDistribution = responseDistribution([diagnostic], objects, {
  campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 50, includeDiagnostic: true,
});
assert.equal(diagnosticDistribution.hasDiagnostic, true);
assert.equal(diagnosticDistribution.diagnosticOnly, true);
assert.equal(diagnosticDistribution.validMeasurement, false);
assert.equal(diagnosticDistribution.curves[0].points[0].reason, "诊断响应");
assert.equal(diagnosticDistribution.curves[0].points[0].amplitudeMps, 1);
assert.equal(diagnosticDistribution.curves[0].points[1].amplitudeMps, null);
assert.ok(Math.abs(distribution.curves[0].points[0].rmsDisplacementM! - 1 / (2 * Math.PI * 50)) < 1e-12);
assert.equal(distribution.config.bandwidthHz, 1);
const extraPoint = { id: "p2", kind: "position", parentId: "b", code: "P2", name: "P2", radiusM: 0.4 };
const denseSpectrum = (resolutionHz: number) => ({ resolutionHz, completeBins: true,
  frequencies: Array.from({ length: 100 / resolutionHz + 1 }, (_, i) => i * resolutionHz),
  psd: Array(100 / resolutionHz + 1).fill(1),
});
const bandRows = [
  { ...row(1), features: { ...feature(12), spectrum: denseSpectrum(1) } },
  { ...row(1), id: "p2-result", context: { ...row(1).context, positionId: "p2" }, features: { ...feature(80), spectrum: denseSpectrum(2) } },
];
const bandResult = responseDistribution(bandRows, [...objects, extraPoint], { campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 50, bandwidthHz: 4 });
assert.equal(bandResult.curves[0].points[0].amplitudeMps, 2);
assert.equal(bandResult.curves[0].points[1].amplitudeMps, 2, "the same band is integrated despite different top peaks and bin widths");
const autoBand = responseDistribution(bandRows, [...objects, extraPoint], { campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 50 });
assert.equal(autoBand.config.bandwidthHz, 2);
const withOldResult = responseDistribution([...bandRows, { ...bandRows[0], id: "old", createdAt: "0", features: { ...feature(), spectrum: denseSpectrum(10) } }], [...objects, extraPoint], { campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 50 });
assert.equal(withOldResult.config.bandwidthHz, 2, "superseded spectra do not widen the current common band");
assert.equal(autoBand.curves[0].points[0].amplitudeMps, Math.sqrt(2));
assert.equal(autoBand.curves[0].points[1].amplitudeMps, Math.sqrt(2));
const legacyPoint = { ...bandRows[1], features: { ...feature(), spectrum: { resolutionHz: 1 } } };
const legacyResult = responseDistribution([bandRows[0], legacyPoint], [...objects, extraPoint], { campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 50 });
assert.equal(legacyResult.curves[0].points[1].amplitudeMps, null);
assert.match(legacyResult.curves[0].points[1].reason, /重新分析/);
const fineBand = responseDistribution(bandRows, [...objects, extraPoint], { campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 50, bandwidthHz: 1 });
assert.equal(fineBand.curves[0].points[1].amplitudeMps, null);
assert.match(fineBand.curves[0].points[1].reason, /分辨率不足/);
assert.throws(() => responseDistribution(bandRows, objects, { campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 101, bandwidthHz: 4 }), /超出实测频谱/);
assert.throws(() => responseDistribution(bandRows, objects, { campaignId: "1", turbineId: "t", azimuthDeg: 0, frequencyHz: 1, bandwidthHz: 4 }), /下限/);
console.log(
  "PASS measurement domain: real rules, missing evidence, campaign dedup, compatible spectra, timezone/window matching, incomplete five-point response",
);

assert.equal(canonicalPositionCode("uuid-from-desktop", "p3"), "P3");
assert.equal(canonicalPositionCode("custom", "tip"), "custom");
const history = measurementHistory([
  row(1),
  { ...row(1), id: "rerun", createdAt: "2" },
  { ...row(1), id: "angle90", azimuthDeg: 90 },
]);
assert.equal(history.length, 2);
assert.equal(history.find((r) => r.azimuthDeg === 0).id, "rerun");

assert.ok(
  measurementAlertRank({
    assessment: { status: "insufficient" },
    features: { events: [{}] },
  }) > measurementAlertRank({ assessment: { status: "insufficient" } }),
);
assert.ok(
  measurementAlertRank({ assessment: { status: "suspected" } }) >
    measurementAlertRank({
      assessment: { status: "within_reference" },
      features: { events: [{}] },
    }),
);

const blade2: any = { id: "blade-uuid", code: "uuid-2", name: "叶片 2", kind: "blade" };
const bladeSlots = bladeDisplaySlots([blade2]);
assert.deepEqual(bladeSlots.map(s => s.name), ["叶片 1", "叶片 2", "叶片 3"]);
assert.deepEqual(bladeSlots.map(s => s.blade?.id || null), [null, "blade-uuid", null]);
assert.equal(new Set(bladeSlots.map(s => s.key)).size, 3);
const customSlots = bladeDisplaySlots([{ ...blade2, name: "检修叶片A" }]);
assert.equal(customSlots[0].name, "检修叶片A");
assert.equal(customSlots.filter(s => s.blade).length, 1);
assert.equal(customSlots.filter(s => !s.blade).length, 2);
