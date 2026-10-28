/** Pure identity contract; no SQL, network or hardware. */
import assert from "node:assert/strict";
import { inferredMeasurementContext, measurementIdentity, resolvedMeasurementContext } from "../apps/web/lib/measurement-store";
import { archivePreviewWindow, capturePageParameters } from "../apps/web/lib/captures";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rotationWorker } from "../apps/web/lib/rotation";
import { normalizeImportedMetadata } from "../apps/web/lib/rotation-catalog";

const raw = { windFarm: " wf1 ", turbine: "1303", pointCycle: {
  bladeId: "2", radialPointId: "desktop-point-uuid", radialPointName: " p3 ", collectionId: "collection-1",
} };
const objects: any[] = [
  { id: "farm", kind: "farm", code: "wf1", parentId: null, active: true },
  { id: "turbine", kind: "turbine", code: "1303", parentId: "farm", active: true },
  { id: "blade", kind: "blade", code: "2", parentId: "turbine", active: true },
  { id: "position", kind: "position", code: "P3", parentId: "blade", active: true },
  { id: "campaign", kind: "campaign", code: "collection-1", parentId: "farm", active: true, turbineIds: ["turbine"] },
];
const context = { farmId: "farm", turbineId: "turbine", bladeId: "blade", positionId: "position", campaignId: "campaign" };
assert.deepEqual(measurementIdentity(raw), { farmCode: "wf1", turbineCode: "1303", bladeCode: "2", positionCode: "P3", campaignCode: "collection-1" });
assert.deepEqual(inferredMeasurementContext(raw, objects), context);
assert.deepEqual(measurementIdentity({ sourceMetadata: raw }), measurementIdentity(raw), "native/imported provenance uses the same identity");
const manual = { ...context, positionId: "manual-position", campaignId: "manual-campaign" };
assert.deepEqual(resolvedMeasurementContext(raw, objects, { context: manual }), manual, "manual links take precedence over raw labels");
assert.deepEqual(resolvedMeasurementContext(raw, objects), context);
assert.equal(inferredMeasurementContext(raw, objects.map(o => o.kind === "campaign" ? { ...o, turbineIds: [] } : o)), null);
assert.equal(inferredMeasurementContext(raw, objects.map(o => o.kind === "position" ? { ...o, active: false } : o)), null);
assert.equal(inferredMeasurementContext({ ...raw, windFarm: "other-farm" }, objects), null);
assert.equal(inferredMeasurementContext({ ...raw, pointCycle: { ...raw.pointCycle, bladeId: "3" } }, objects), null);
assert.equal(inferredMeasurementContext({}, objects), null);
assert.equal(capturePageParameters({ limit: 200 }).limit, 200);
assert.throws(() => capturePageParameters({ cursor: "x".repeat(300) }));
const local: any = { sampleRate: 1000, samples: 5000, pointCycle: {
  continuousSession: { sampleClock: "continuous_session_raw", sampleRate: 1000, sampleStart: 10000, sampleEndExclusive: 15000 },
  handoff: { entrySampleIndex: 2000, exitConfirmedSampleIndex: 2200 },
} };
const localRange = archivePreviewWindow(local);
assert.ok(localRange.start > 0 && localRange.start <= 2000 && localRange.end > 2200, "a global session link does not make a local handoff global");
const global = structuredClone(local);
global.pointCycle.handoff = { sampleClock: "continuous_session_raw", entrySampleIndex: 12000, exitConfirmedSampleIndex: 12200 };
assert.deepEqual(archivePreviewWindow(global), localRange);
const derivative = { ...global, sampleRate: 500, samples: 2500, sampling: {
  version: 2, kind: "anti_alias_lowpass", sourceSampleRate: 1000, targetSampleRate: 500,
  sourceSamples: 5000, sourceHandoff: structuredClone(global.pointCycle.handoff),
  pointCycleIndexMapping: { version: 1, sourceClock: "continuous_session_raw", targetClock: "recording_local", sourceOffset: 10000, numerator: 1, denominator: 2 },
} };
const derivativeRange = archivePreviewWindow(derivative);
assert.ok(derivativeRange.start <= 1000 && derivativeRange.end > 1100 && derivativeRange.end - derivativeRange.start <= 500);
for (const corrupt of [
  { ...derivative, sampling: { ...derivative.sampling, version: 1 } },
  { ...derivative, sampling: { ...derivative.sampling, sourceSamples: 4999 } },
  { ...derivative, sampling: { ...derivative.sampling, sourceHandoff: {} } },
  { ...derivative, sampling: { ...derivative.sampling, pointCycleIndexMapping: { ...derivative.sampling.pointCycleIndexMapping, sourceOffset: 0 } } },
]) assert.throws(() => archivePreviewWindow(corrupt), /时钟映射/);
console.log("PASS shared identity, canonical point names, manual-binding precedence, bounded paging, local/global and derivative archive clocks");

async function catalogueContract() {
  const root = await mkdtemp(path.join(os.tmpdir(), "measurement-catalogue-"));
  const before = process.env.BLADE_ANALYSIS_DATA_DIR, python = process.env.BLADE_ANALYSIS_PYTHON;
  const user = { id: "catalogue-owner", tenant: "catalogue-qa" }, id = "a".repeat(32), corruptId = "b".repeat(32), linkedId = "c".repeat(32);
  const data = path.join(root, createHash("sha256").update(`${user.tenant}\0${user.id}`).digest("hex"));
  const location = path.join(data, "recordings", id, "manifest.json");
  try {
    process.env.BLADE_ANALYSIS_DATA_DIR = root;
    process.env.BLADE_ANALYSIS_PYTHON = path.join(root, "must-not-start-python");
    await mkdir(path.dirname(location), { recursive: true });
    const evidence = { passCompleteness: "confirmed", sampleClock: "continuous_session_raw", completenessReason: "full_pass" };
    const manifest = { id, name: "QA [未停稳判定测试]", startedAt: 10, status: "complete", diagnosticOnly: true, validMeasurement: false,
      pointCycle: { completion: "diagnostic_pass", recordPreparation: "deferred_from_continuous_raw", handoff: evidence,
        diagnosticDetection: { enabled: true, trigger: evidence } } };
    const original = JSON.stringify(manifest);
    await writeFile(location, original);
    await mkdir(path.join(data, "recordings", corruptId));
    await writeFile(path.join(data, "recordings", corruptId, "manifest.json"), "corrupt metadata");
    await symlink(path.dirname(location), path.join(data, "recordings", linkedId), "dir");
    const result = await rotationWorker(user, { action: "recordings" });
    assert.equal(result.recordings.length, 2, "symlinked recording directories are not traversed");
    assert.deepEqual(result.recordings[0], normalizeImportedMetadata(manifest));
    assert.equal(result.recordings[0].name, "QA");
    assert.equal(result.recordings[0].pointCycle.passCompleteness, "confirmed");
    assert.equal(result.recordings[0].validMeasurement, false, "diagnostics never become normal measurements");
    assert.equal(result.recordings[1].status, "incomplete", "corrupt records stay visible instead of empty success");
    assert.equal(await readFile(location, "utf8"), original, "catalogue reads never rewrite manifests");
    assert.deepEqual(await rotationWorker({ ...user, id: "another-owner" }, { action: "recordings" }), { recordings: [] });
    assert.deepEqual(await rotationWorker({ ...user, tenant: "another-tenant" }, { action: "recordings" }), { recordings: [] });
    assert.equal(normalizeImportedMetadata({ ...manifest, pointCycle: { ...manifest.pointCycle, passCompleteness: "unconfirmed" } }).pointCycle.passCompleteness, "unconfirmed");
    console.log("PASS read-only catalogue without Python, account isolation, metadata parity, corruption visibility and unchanged source files");
  } finally {
    if (before === undefined) delete process.env.BLADE_ANALYSIS_DATA_DIR; else process.env.BLADE_ANALYSIS_DATA_DIR = before;
    if (python === undefined) delete process.env.BLADE_ANALYSIS_PYTHON; else process.env.BLADE_ANALYSIS_PYTHON = python;
    await rm(root, { recursive: true, force: true });
  }
}
catalogueContract().catch(error => { console.error(error); process.exitCode = 1; });
