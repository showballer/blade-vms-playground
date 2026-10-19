/** Temporary files and real Python analysis worker only; no devices, database or network. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { rotationUpload, rotationWorker } from "../apps/web/lib/rotation";

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "blade-pass-worker-"));
  const previous = process.env.BLADE_ANALYSIS_DATA_DIR;
  process.env.BLADE_ANALYSIS_DATA_DIR = root;
  const user = { id: "pass-worker", tenant: "temporary-test" };
  const collection = "c".repeat(32);
  async function upload(index: number, radius: number, azimuth: number, session: string) {
    const samples = 2000, rate = 1000, radial = radius < .4 ? "p1" : "p2";
    const metadata = { format: "blade-vms-csv-1", recordingId: index.toString(16).padStart(32, "0"),
      name: "隔离点位分析测试", source: "simulation", object: "测试叶轮", turbine: "test", sampleOrigin: 1700000000 + index,
      sampleRate: rate, samples, rssiSampleStride: 4, rssiSampleRate: rate / 4,
      pointCycle: { mode: "automatic_stations", collectionId: collection, bladeId: "2", sessionId: session,
        radialPointId: radial, radialPointName: radial.toUpperCase(), radiusM: radius, azimuthDeg: azimuth,
        stationId: `${radial}-${azimuth}`, stationIndex: azimuth === 0 ? 1 : 2, stationCount: 4, lapIndex: 1,
        identityVerified: false, coverageKind: "sparse_station_passes", completion: "confirmed_pass", outcome: "observed",
        handoff: { reason: "blade_left", entrySampleIndex: 180, entryConfirmedSampleIndex: 199, exitSampleIndex: 1600, exitConfirmedSampleIndex: 1629 } } };
    const text = "# BladeVMS " + JSON.stringify(metadata) + "\ntime_s,velocity_m_s,RSSI_percent,overrange\n" +
      Array.from({ length: samples }, (_, i) => `${i / rate},${radius * Math.sin(2 * Math.PI * 50 * i / rate)},${i % 4 ? "" : i >= 600 && i < 700 ? 10 : 80},${i >= 1000 && i < 1100 ? 1 : 0}`).join("\n");
    const response = await rotationUpload(user, new Request("http://127.0.0.1/api/v1/rotation/import?filename=points.csv.gz&source=measured", { method: "POST", body: new Uint8Array(gzipSync(text)) }));
    const record = response.recordings[0];
    assert.equal(record.pointCycle.collectionId, collection);
    assert.equal(record.sourceSampleOrigin, metadata.sampleOrigin);
    assert.equal(record.sourceRecordingId, metadata.recordingId);
    assert.equal(record.rssiSampleStride, 4);
    assert.equal(record.source, "simulation");
    return record;
  }
  try {
    const a = await upload(1, .31, 0, "a".repeat(32));
    const b = await upload(2, .5, 0, "b".repeat(32));
    const c = await upload(3, .31, 90, "a".repeat(32));
    const parameters = { recordingIds: [a.id, b.id, c.id], detrend: "constant", rssiThresholdPercent: 50 };
    const result = await rotationWorker(user, { action: "blade-passes", parameters });
    assert.equal(result.phaseAvailable, false);
    assert.equal(result.coverage.validSamples, 3600);
    assert.equal(result.coverage.segmentCount, 9);
    assert.deepEqual(result.sources[0].validRanges.map((range: any) => [range.start, range.end]), [[200, 600], [700, 1000], [1100, 1600]]);
    assert.deepEqual(result.amplitudeDistributions.map((item: any) => [item.azimuthDeg, item.points.length]), [[0, 2], [90, 1]]);
    assert.ok(Math.abs(result.amplitudeDistributions[0].points[0].value - .31 / Math.sqrt(2)) < 1e-8);
    assert.equal(result.sources[0].provenance.originalSampleOrigin, 1700000001);
    assert.notEqual(result.sources[0].provenance.storeSampleOrigin, 1700000001);
    assert.equal(result.modalMatch, undefined);
    assert.ok(JSON.stringify(result).length < 8 * 1024 * 1024);
    await assert.rejects(rotationWorker(user, { action: "rotation", parameters: { recordingIds: [a.id], rpm: 1200 } }), /片段|间歇|站位/);
    await assert.rejects(rotationWorker({ ...user, id: "other-user" }, { action: "blade-passes", parameters }), /记录|文件|No such file/);
    const duplicate = await upload(1, .31, 0, "a".repeat(32));
    await assert.rejects(rotationWorker(user, { action: "blade-passes", parameters: { recordingIds: [a.id, duplicate.id] } }), /重复|副本|去重/);
    console.log("PASS gzip import → identity/RSSI preservation → disjoint pass analysis → radial/station grouping → account isolation and legacy guard");
  } finally {
    if (previous === undefined) delete process.env.BLADE_ANALYSIS_DATA_DIR;
    else process.env.BLADE_ANALYSIS_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
void main();
