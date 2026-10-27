import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { measurementSynthesisSelection } from "../apps/web/lib/measurement-api";
import type { User } from "../apps/web/lib/db";
import type { MeasurementSource } from "../apps/web/lib/measurement-store";
import { rotationUpload, rotationWorker } from "../apps/web/lib/rotation";
import type { MeasurementObject } from "../packages/ui/src/measurement-domain";

const user: User = { id: "synthesis-qa", tenant: "isolated-synthesis-qa", name: "QA", username: "qa", role: "analyst", active: 1 };
const scope = { farmId: "farm", campaignId: "campaign", turbineId: "turbine", bladeId: "blade" };
const objects: MeasurementObject[] = [
  { id: "farm", kind: "farm", parentId: null },
  { id: "campaign", kind: "campaign", parentId: "farm", turbineIds: ["turbine"] },
  { id: "turbine", kind: "turbine", parentId: "farm" },
  { id: "blade", kind: "blade", parentId: "turbine" },
  ...[1, 2, 3].map((n) => ({ id: `p${n}`, kind: "position", parentId: "blade" })),
].map((o) => ({ name: o.id, code: o.id, active: true, revision: "1", ...o })) as MeasurementObject[];
const source = (n: number, overrides: Partial<MeasurementSource> = {}): MeasurementSource => ({
  key: `import:${user.id}:${n}`, reference: { kind: "import", id: n.toString(16).padStart(32, "0") },
  name: `P${n}`, raw: {}, measuredAt: 1700000000, tenant: user.tenant,
  context: { ...scope, positionId: `p${n}` }, bindingRevision: "1", ...overrides,
});

async function fingerprints(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fingerprints(file));
    // The catalog refreshes its SQLite index; the immutable manifests, raw
    // chunks and uploaded source CSVs must remain byte-for-byte unchanged.
    else if (!entry.name.startsWith("recordings.sqlite3"))
      result[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return result;
}

async function main() {
  const available = [source(1), source(2), source(3, { raw: { diagnosticOnly: true, validMeasurement: false } })];
  assert.deepEqual(measurementSynthesisSelection(user, available, objects, scope).chosen.map((s) => s.name), ["P1", "P2"]);
  assert.equal(measurementSynthesisSelection(user, available, objects, { ...scope, includeDiagnostic: true }).chosen.length, 3);
  assert.deepEqual(measurementSynthesisSelection(user, available, objects, { ...scope, positionIds: ["p2"] }).chosen.map((s) => s.name), ["P2"]);
  for (const b of [
    { ...scope, recordingIds: [available[0].reference.id] },
    { ...scope, includeDiagnostic: "true" }, { ...scope, minHz: 100, maxHz: 20 },
    { ...scope, minHz: true }, { ...scope, positionIds: ["foreign"] },
    { ...scope, farmId: "another-farm" }, { ...scope, positionIds: ["p1", "p1"] },
  ]) assert.throws(() => measurementSynthesisSelection(user, available, objects, b));
  assert.throws(() => measurementSynthesisSelection({ ...user, role: "operator" }, available, objects, scope));
  assert.throws(() => measurementSynthesisSelection({ ...user, tenant: "another-tenant" }, available, objects, scope));
  assert.throws(() => measurementSynthesisSelection(user, [source(1, { bindingRevision: null })], objects, scope));
  assert.throws(() => measurementSynthesisSelection(user, [source(1, { context: { ...scope, campaignId: "another-task", positionId: "p1" } })], objects, scope));
  assert.throws(() => measurementSynthesisSelection(user, [available[2]], objects, scope), /诊断/);

  const root = await mkdtemp(path.join(os.tmpdir(), "measurement-synthesis-"));
  const previous = process.env.BLADE_ANALYSIS_DATA_DIR;
  process.env.BLADE_ANALYSIS_DATA_DIR = root;
  try {
    const samples = 4000, rate = 1000;
    const imported: MeasurementSource[] = [];
    for (const n of [1, 2]) for (const angle of [0, 90]) {
      const serial = imported.length + 1;
      const pointCycle = {
        mode: "automatic_stations", executionMode: "manual_segments", collectionId: "c".repeat(32), bladeId: "2",
        sessionId: serial.toString(16).padStart(32, "0"), radialPointId: `p${n}`, radialPointName: `P${n}`, radiusM: n * .1,
        azimuthDeg: angle, stationId: `p${n}-${angle}`, stationIndex: angle / 90 + 1, stationCount: 4, lapIndex: 1,
        completion: "confirmed_pass", outcome: "observed", identityVerified: false,
        handoff: { reason: "blade_left", entrySampleIndex: 100, entryConfirmedSampleIndex: 119, exitSampleIndex: 3900, exitConfirmedSampleIndex: 3929 },
      };
      const csv = "# BladeVMS " + JSON.stringify({ format: "blade-vms-csv-1", name: `P${n} ${angle}`, source: "measured", samples, sampleRate: rate, pointCycle }) +
        "\ntime_s,velocity_m_s,rssi_percent\n" + Array.from({ length: samples }, (_, i) =>
          `${i / rate},${.002 * n * Math.sin(2 * Math.PI * 50 * i / rate + serial)},80`).join("\n");
      const upload = await rotationUpload(user, new Request(`http://localhost/api?filename=p${n}-${angle}.csv&source=measured`, { method: "POST", body: csv }));
      imported.push(source(n, { key: `fixture-${serial}`, reference: { kind: "import", id: upload.recordings[0].id }, raw: upload.recordings[0] }));
    }
    const selection = measurementSynthesisSelection(user, imported, objects, { ...scope, minHz: 20, maxHz: 200 });
    const parameters = { recordingIds: selection.chosen.map((s) => s.reference.id), includeDiagnostic: selection.includeDiagnostic,
      passWindow: "detected", detrend: "constant", synthesis: { minHz: selection.minHz, maxHz: selection.maxHz } };
    const before = await fingerprints(root);
    const result = await rotationWorker(user, { action: "blade-passes", parameters });
    assert.equal(result.synthesis.mergedPoints.length, 2);
    assert.ok(result.synthesis.mergedPoints.every((p: any) => p.segments.length === 2 && p.stitchedWaveform.valuesMps.includes(null)));
    assert.equal(result.synthesis.measuredPhaseAvailable, false);
    const candidate = result.synthesis.candidates.find((c: any) => Math.abs(c.frequencyHz - 50) < 2);
    assert.ok(candidate, "known common 50 Hz peak must be recovered");
    assert.ok(Math.abs(candidate.points[0].normalizedAmplitude - .5) < .02);
    assert.ok(Math.abs(candidate.points[1].normalizedAmplitude - 1) < .02);
    assert.ok(candidate.points.every((p: any) => p.spatialPhaseDeg === null));
    assert.deepEqual(await fingerprints(root), before, "synthesis must never rewrite source files");
    await assert.rejects(rotationWorker({ ...user, id: "other-account" }, { action: "blade-passes", parameters }));
    console.log("PASS measurement synthesis: bound tenant/task/blade/position scope, explicit diagnostics, no worker-ID injection; real CSV -> independent-angle merge -> 50 Hz amplitude shape without invented phase or source mutation");
  } finally {
    if (previous === undefined) delete process.env.BLADE_ANALYSIS_DATA_DIR;
    else process.env.BLADE_ANALYSIS_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
void main();
