/** Isolated capture API/storage contract: memory repository + real Python worker, no SQL or hardware. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureBody, createCaptureService, type CaptureRepository, type CaptureRow } from "../apps/web/lib/captures";
import { canReadCapture, HttpError, type User } from "../apps/web/lib/db";
import { rotationWorker } from "../apps/web/lib/rotation";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const user = (id: string, role: User["role"], tenant = "test-team"): User => ({ id, username: id, name: id, role, tenant, active: 1 });
const owner = user("owner", "operator"), teammate = user("teammate", "operator"), analyst = user("analyst", "analyst"), viewer = user("viewer", "viewer"), outsider = user("outsider", "analyst", "other-team"), admin = user("administrator", "admin", "other-team");
const rejected = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;
const entries = new Map<string, CaptureRow>();
let transactions = 0;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const repository: CaptureRepository = {
  async create(user, clientId, recording) {
    const prior = [...entries.values()].find(row => row.owner_id === user.id && row.client_id === clientId && row.local_id === recording.id);
    if (prior) return clone(prior);
    const row: CaptureRow = { id: randomUUID().replaceAll("-", ""), owner_id: user.id, owner_name: user.name, tenant: user.tenant, client_id: clientId, local_id: recording.id,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), body: { recording, liveState: "offline", uploadState: "pending", receivedBytes: 0, totalBytes: 0, lastSeenAt: null, sequence: -1 } };
    entries.set(row.id, clone(row)); return clone(row);
  },
  async list(user) { return [...entries.values()].filter(row => canReadCapture(user, { ownerId: row.owner_id, tenant: row.tenant })).map(clone); },
  async get(id) { return entries.has(id) ? clone(entries.get(id)!) : null; },
  async mutate(id, action) {
    const original = entries.get(id); if (!original) throw new HttpError(404, "Missing capture");
    transactions++;
    try { const row = clone(original), result = await action(row); entries.set(id, row); return result; }
    finally { transactions--; }
  },
};
function fixture(id = randomUUID().replaceAll("-", ""), corruptIndex = false) {
  const samples = 1001, sampleRate = 1000, sampleOrigin = 1700000000;
  const chunks: Record<string, Buffer> = {};
  for (const [chunk, start, end] of [[0, 0, 500], [1, 500, samples]]) {
    const bytes = Buffer.alloc(32 + (end - start) * 29);
    bytes.write("BLADEV01"); bytes.writeDoubleLE(sampleRate, 8); bytes.writeDoubleLE(sampleOrigin, 16); bytes.writeBigUInt64LE(BigInt(start), 24);
    for (let i = start; i < end; i++) {
      const at = 32 + (i - start) * 29, value = 0.01 * Math.sin(i / sampleRate * 2 * Math.PI * 20);
      bytes.writeBigUInt64LE(BigInt(corruptIndex && i === 123 ? 125 : i), at);
      bytes.writeInt32LE(Math.round(value * 1e6), at + 8); bytes.writeDoubleLE(value, at + 12);
      bytes.writeInt32LE(80000, at + 20); bytes.writeFloatLE(80, at + 24); bytes[at + 28] = i === 3 ? 3 : 2;
    }
    chunks[`chunk-${String(chunk).padStart(8, "0")}.bin`] = bytes;
  }
  const unpaired = Buffer.alloc(32);
  unpaired.writeBigUInt64LE(0n); unpaired.writeBigUInt64LE(2n, 8);
  unpaired.writeInt32LE(80000, 16); unpaired.writeFloatLE(80, 20); unpaired.writeInt32LE(90000, 24); unpaired.writeFloatLE(90, 28);
  chunks["unpaired-rssi.bin"] = unpaired;
  const recording = { id, name: "native capture contract", object: "test", turbine: "test", point: "P1", source: "simulation", simulation: { point: "P1", synthetic: true, position: 0.2, rpm: 1200 },
    samples, sampleRate, sampleOrigin, startedAt: sampleOrigin, endedAt: sampleOrigin + samples / sampleRate,
    status: "complete", error: null, unit: "m/s", rssiUnit: "%", channels: ["CH1", "RSSI1"], chunks: 2,
    format: "BLADEV01/<QidifB", overrangeSamples: 1, missingRssiSamples: 0, unpairedRssiSamples: 2 };
  const files = Object.entries(chunks).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: digest(bytes) }));
  return { recording, files, chunks };
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "blade-captures-test-"));
  const before = { capture: process.env.BLADE_CAPTURE_DATA_DIR, analysis: process.env.BLADE_ANALYSIS_DATA_DIR };
  process.env.BLADE_CAPTURE_DATA_DIR = root; process.env.BLADE_ANALYSIS_DATA_DIR = path.join(root, "analysis");
  const worker: typeof rotationWorker = async (...args) => {
    assert.equal(transactions, 0, "Native validation and analysis must run outside database transactions");
    return rotationWorker(...args);
  };
  let time = Date.now(); const service = createCaptureService({ repository, root, now: () => time, worker });
  const passed: string[] = [];
  try {
    const f = fixture(), initial = { ...f.recording, status: "incomplete", samples: 0 };
    await assert.rejects(service.create(viewer, { clientId: "desktop-1", recording: initial }), rejected(403));
    await assert.rejects(service.create(owner, { clientId: "desktop-1", recording: initial, ownerId: "administrator" }), rejected(400));
    const { capture } = await service.create(owner, { clientId: "desktop-1", recording: initial });
    const id = capture.id;
    assert.equal((await service.create(owner, { clientId: "desktop-1", recording: initial })).capture.id, id);
    assert.equal(capture.ownerId, owner.id);
    assert.equal((await service.list(teammate)).captures.length, 0);
    for (const permitted of [owner, analyst, viewer, admin]) assert.equal((await service.detail(permitted, id)).capture.id, id);
    for (const forbidden of [teammate, outsider]) await assert.rejects(service.detail(forbidden, id), rejected(404));
    passed.push("Authenticated ownership, idempotent registration, role and tenant read isolation");

    const frame = { sequence: 1, sentAt: time, recording: { ...initial, samples: 500 }, state: "acquiring", waveform: { values: [0, 0.1], sampleRate: 1000, unit: "m/s" } };
    await service.live(owner, id, frame);
    assert.equal((await service.detail(viewer, id)).capture.liveState, "acquiring");
    await service.live(owner, id, { ...frame, sequence: 0, state: "error" });
    assert.equal((await service.detail(viewer, id)).frame.sequence, 1);
    time += 16_000;
    assert.equal((await service.detail(viewer, id)).capture.liveState, "offline");
    assert.equal((await service.detail(viewer, id)).capture.uploadState, "pending");
    await assert.rejects(service.live(owner, id, { ...frame, sequence: 2, waveform: { values: Array(2049).fill(0) } }), rejected(400));
    const realtime = { available: true, timeDomain: { times: [0, 1], values: [0, 0] },
      spectrum: { frequencies: Array.from({ length: 2049 }, (_, index) => index), amplitudes: Array(2049).fill(0) },
      spectrogram: { times: [0], frequencies: [0], db: [[0]] } };
    await service.live(owner, id, { ...frame, sequence: 2, realtime });
    assert.equal((await service.detail(viewer, id)).frame.realtime.spectrum.frequencies.length, 2049);
    await assert.rejects(service.live(owner, id, { ...frame, sequence: 3, realtime: { ...realtime, spectrum: { frequencies: Array(4097).fill(0), amplitudes: [] } } }), rejected(400));
    const sparseWaveform = { ...frame.waveform, sampleRate: 51200, sampleStride: 2, rssi: [80, null], rssiSampleStride: 32, rssiSampleRate: 1600 };
    await service.live(owner, id, { ...frame, sequence: 3, waveform: sparseWaveform });
    assert.deepEqual((await service.detail(viewer, id)).frame.waveform, sparseWaveform);
    const invalidRssiTiming = [
      ...[0, -1, 1.5, 100001, '32', true, null].map(rssiSampleStride => ({ rssiSampleStride, rssiSampleRate: 1600 })),
      ...[0, -1, '1600', true, null, 1601, 102400, Number.MIN_VALUE].map(rssiSampleRate => ({ rssiSampleStride: 32, rssiSampleRate })),
      { rssiSampleStride: 32, rssiSampleRate: undefined }, { rssiSampleStride: undefined, rssiSampleRate: 1600 },
    ];
    for (const metadata of invalidRssiTiming) {
      await assert.rejects(service.live(owner, id, { ...frame, sequence: 4,
        waveform: { ...sparseWaveform, ...metadata } }), rejected(400));
    }
    assert.deepEqual((await service.detail(viewer, id)).frame.waveform, sparseWaveform, "Rejected RSSI metadata cannot alter the last accepted live waveform");
    passed.push("Sparse RSSI acquisition timing survives preview storage; invalid or incomplete timing is rejected");
    const envelope = { values: [], representation: "envelope", sampleRate: 250000, sampleStart: 0, rangeStart: 0, rangeEnd: 500,
      envelope: [{ start: 0, end: 500, min: -0.1, max: 0.2, rssiMin: 5, rssiMax: 80, overrange: 1, missing: 0 }] };
    await service.live(owner, id, { ...frame, sequence: 4, waveform: envelope });
    assert.deepEqual((await service.detail(viewer, id)).frame.waveform, envelope);
    for (const entry of [{ ...envelope.envelope[0], min: 5 }, { ...envelope.envelope[0], start: -1 }, { ...envelope.envelope[0], max: Infinity }]) {
      await assert.rejects(service.live(owner, id, { ...frame, sequence: 5, waveform: { ...envelope, envelope: [entry] } }), rejected(400));
    }
    await assert.rejects(service.live(owner, id, { ...frame, sequence: 5, waveform: { ...envelope, envelope: Array(1001).fill(envelope.envelope[0]) } }), rejected(400));
    passed.push("High-rate bounded min/max previews survive live sync; malformed envelopes are rejected");
    await assert.rejects(service.live(teammate, id, frame), rejected(403));
    await assert.rejects(service.prepareAnalysis(owner, id), rejected(403));
    await assert.rejects(service.prepareAnalysis(analyst, id), rejected(409));
    await assert.rejects(service.waveform(viewer, id), rejected(409));
    passed.push("Live preview sequence and TTL, bounded arrays, incomplete raw data never becomes analysis");

    const uploading = await service.upload(owner, id, { recording: f.recording, files: f.files });
    assert.deepEqual(uploading.received, []);
    // MySQL's binary JSON changes key order and can round float64 on decoding.
    entries.get(id)!.body.recording = { ...entries.get(id)!.body.recording, sampleRate: 1000.0000000000001 };
    entries.get(id)!.body.files = f.files.map(file => ({ sha256: file.sha256, bytes: file.bytes, name: file.name }));
    await service.upload(owner, id, { recording: f.recording, files: f.files });
    delete entries.get(id)!.body.planHash;
    await service.upload(owner, id, { recording: f.recording, files: f.files });
    await assert.rejects(service.upload(owner, id, { recording: { ...f.recording, name: "changed immutable plan" }, files: f.files }), rejected(409));
    await assert.rejects(service.complete(owner, id), rejected(409));
    await assert.rejects(service.upload(owner, id, { recording: { ...f.recording, source: "polytec_ivs500", simulation: null }, files: f.files }), rejected(400));
    const name = f.files[0].name, bytes = f.chunks[name];
    assert.equal((await service.chunk(owner, id, name, 0, bytes.subarray(0, 100))).nextOffset, 100);
    assert.equal((await service.chunk(owner, id, name, 0, bytes.subarray(0, 100))).nextOffset, 100);
    await assert.rejects(service.chunk(owner, id, name, 0, Buffer.alloc(100)), rejected(409));
    await assert.rejects(service.chunk(owner, id, name, 101, bytes.subarray(0, 10)), rejected(409));
    const recreated = createCaptureService({ repository, root, now: () => time, worker });
    assert.equal((await recreated.upload(owner, id, { recording: f.recording, files: [...f.files].reverse() })).offsets[name], 100);
    await recreated.chunk(owner, id, name, 100, bytes.subarray(100));
    // Model a restart after the last byte arrived but before SHA/rename finished.
    await rename(path.join(root, id, "incoming", name), path.join(root, id, "incoming", name + ".part"));
    const resume = await recreated.upload(owner, id, { recording: f.recording, files: f.files });
    assert.equal(resume.offsets[name], bytes.length - 1);
    assert.ok(!resume.received.includes(name));
    assert.deepEqual(await recreated.chunk(owner, id, name, bytes.length - 1, bytes.subarray(-1)), { ok: true, nextOffset: bytes.length, complete: true });
    for (const file of f.files.slice(1)) await recreated.chunk(owner, id, file.name, 0, f.chunks[file.name]);
    const complete = await recreated.complete(owner, id);
    assert.equal(complete.capture.uploadState, "complete");
    assert.equal(complete.capture.receivedBytes, f.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.equal((await recreated.complete(owner, id)).capture.uploadState, "complete");
    assert.equal((await recreated.chunk(owner, id, name, 0, bytes)).complete, true);
    assert.deepEqual(await readFile(path.join(root, id, "complete/unpaired-rssi.bin")), f.chunks["unpaired-rssi.bin"]);
    // Model a process exit after directory rename but before its SQL commit.
    entries.get(id)!.body.uploadState = "uploading";
    assert.equal((await recreated.upload(owner, id, { recording: f.recording, files: f.files })).received.length, f.files.length);
    assert.equal((await recreated.complete(owner, id)).capture.uploadState, "complete");
    passed.push("Resumable offsets, MySQL JSON precision, hash/finalize crash recovery and unpaired RSSI preservation");

    const historical = await recreated.waveform(viewer, id, 20, 120);
    assert.equal(historical.waveform.values.length, 100);
    assert.equal(historical.recording.source, "simulation");
    await assert.rejects(recreated.prepareAnalysis(viewer, id), rejected(403));
    await assert.rejects(recreated.prepareAnalysis(outsider, id), rejected(404));
    const imported = await recreated.prepareAnalysis(analyst, id);
    assert.equal(imported.recording.source, "simulation");
    assert.equal(imported.recording.cloudCaptureId, id);
    assert.equal(imported.recording.sampleRate, 1000, "Analysis reads exact native metadata, never MySQL-rounded floats");
    assert.equal((await recreated.prepareAnalysis(analyst, id)).recording.id, imported.recording.id);
    assert.equal((await rotationWorker(analyst, { action: "recordings" })).recordings.length, 1);
    const result = await rotationWorker(analyst, { action: "rotation", parameters: { recordingIds: [imported.recording.id], rpm: 1200, maxOrder: 20, positions: [0.2], startSeconds: 0.1 } });
    assert.ok(Math.abs(result.modeShape.points[0].amplitude - 0.01) < 0.0001);
    assert.ok(result.warnings.some((value: string) => value.includes("模拟")));
    await assert.rejects(rotationWorker(analyst, { action: "capture-import", captureDirectory: path.join(root, "../outside/complete") }), rejected(400));
    passed.push("Authorized historical raw waveform and deduplicated native rotation import with simulation provenance");

    const measured = fixture();
    const measuredRecording = { ...measured.recording, source: "polytec_ivs500", simulation: null };
    const measuredId = (await service.create(owner, { clientId: "desktop-1", recording: measuredRecording })).capture.id;
    await service.upload(owner, measuredId, { recording: measuredRecording, files: measured.files });
    for (const file of measured.files) await service.chunk(owner, measuredId, file.name, 0, measured.chunks[file.name]);
    await service.complete(owner, measuredId);
    const measuredImport = await service.prepareAnalysis(analyst, measuredId);
    assert.equal(measuredImport.recording.source, "polytec_ivs500");
    assert.equal(measuredImport.recording.simulation, null);
    const measuredResult = await rotationWorker(analyst, { action: "rotation", parameters: { recordingIds: [measuredImport.recording.id], rpm: 1200, positions: [0.2], startSeconds: 0.1 } });
    assert.equal(measuredResult.sources[0].source, "polytec_ivs500");
    assert.ok(!measuredResult.warnings.some((value: string) => value.includes("模拟")));
    assert.ok(Math.abs(measuredResult.modeShape.points[0].amplitude - 0.01) < 0.0001);
    passed.push("Artificial polytec_ivs500 native fixture uploads/imports/analyzes with source preserved; no device used");

    const servo = fixture();
    const telemetry = Buffer.from([0, 1].map((index) => JSON.stringify({ event: index ? "status" : "start", hostTime: 1700000000 + index,
      elapsedSeconds: index, receivedSamples: index * 500, feedback: { axes: { "1": { output_angle_deg: index * 2 }, "2": { output_angle_deg: 30 } } } })).join("\n") + "\n");
    const servoRecording = { ...servo.recording, source: "polytec_ivs500", simulation: null,
      turntable: { config: { port: "COM6", axis: 1 }, preparedReferences: { "1": { origin_counts: 123 } },
        telemetry: { file: "turntable.jsonl", events: 2, sha256: digest(telemetry), timestampBasis: "sequential host observations; not hardware synchronized" } },
      pointCycle: { cycle: 2, pointIndex: 1, pointName: "B1-P2", actualAngles: { "1": 2, "2": 30 },
        mode: "automatic_stations", collectionId: "c".repeat(32), sessionId: "a".repeat(32), bladeId: "2", radialPointId: "p2", radialPointName: "叶尖",
        radiusM: .5, azimuthDeg: 90, stationIndex: 2, stationCount: 4, lapIndex: 2, cycles: 2,
        identitySource: "operator_assigned", identityVerified: false, coverageKind: "sparse_station_passes", completion: "confirmed_pass",
        plannedStations: [0, 90, 180, 270].map((azimuthDeg, index) => ({ pointId: `p2-s${index + 1}`, bladeId: "2",
          radialPointId: "p2", radialPointName: "叶尖", radiusM: .5, azimuthDeg, stationIndex: index + 1, stationCount: 4 })) } };
    const servoFiles = [...servo.files, { name: "turntable.jsonl", bytes: telemetry.length, sha256: digest(telemetry) }];
    const servoId = (await service.create(owner, { clientId: "desktop-servo", recording: servoRecording })).capture.id;
    await assert.rejects(service.attachment(viewer, servoId, "manifest.json"), rejected(409));
    await assert.rejects(service.upload(owner, servoId, { recording: servoRecording, files: servo.files }), rejected(400));
    await assert.rejects(service.upload(owner, servoId, { recording: { ...servoRecording, turntable: {} }, files: servoFiles }), rejected(400));
    await service.upload(owner, servoId, { recording: servoRecording, files: servoFiles });
    for (const file of servo.files) await service.chunk(owner, servoId, file.name, 0, servo.chunks[file.name]);
    await service.chunk(owner, servoId, "turntable.jsonl", 0, telemetry.subarray(0, 80));
    const resumedServo = createCaptureService({ repository, root, worker });
    assert.equal((await resumedServo.upload(owner, servoId, { recording: servoRecording, files: servoFiles })).offsets["turntable.jsonl"], 80);
    await resumedServo.chunk(owner, servoId, "turntable.jsonl", 80, telemetry.subarray(80));
    await resumedServo.complete(owner, servoId);
    const collect = async (file: Awaited<ReturnType<typeof service.attachment>>) => { const chunks: Buffer[] = []; for await (const bytes of file.stream) chunks.push(bytes); return Buffer.concat(chunks); };
    assert.deepEqual(await collect(await resumedServo.attachment(viewer, servoId, "turntable.jsonl")), telemetry);
    const downloaded = JSON.parse((await collect(await resumedServo.attachment(viewer, servoId, "manifest.json"))).toString("utf8"));
    assert.deepEqual(downloaded.turntable, servoRecording.turntable); assert.deepEqual(downloaded.pointCycle, servoRecording.pointCycle);
    for (const forbidden of [outsider, teammate]) await assert.rejects(resumedServo.attachment(forbidden, servoId, "turntable.jsonl"), rejected(404));
    await assert.rejects(resumedServo.attachment(viewer, servoId, "../manifest.json"), rejected(400));
    await assert.rejects(resumedServo.attachment(viewer, measuredId, "turntable.jsonl"), rejected(404));
    const servoImported = await resumedServo.prepareAnalysis(analyst, servoId);
    assert.deepEqual(servoImported.recording.turntable, servoRecording.turntable);
    assert.deepEqual(servoImported.recording.pointCycle, servoRecording.pointCycle);
    const analysisOwner = createHash("sha256").update(`${analyst.tenant}\0${analyst.id}`).digest("hex");
    assert.deepEqual(await readFile(path.join(root, "analysis", analysisOwner, "recordings", servoImported.recording.id, "turntable.jsonl")), telemetry);
    assert.equal((await resumedServo.waveform(viewer, servoId, 0, 10)).waveform.values.length, 10);
    passed.push("Turntable telemetry resumes, validates, downloads with read authorization and survives native analysis import unchanged");

    const malformed = fixture(), malformedTelemetry = Buffer.from('{"event":"status","hostTime":1,"elapsedSeconds":-1}\n');
    const malformedRecording = { ...servoRecording, ...malformed.recording, turntable: { ...servoRecording.turntable,
      telemetry: { file: "turntable.jsonl", events: 1, sha256: digest(malformedTelemetry) } } };
    const malformedFiles = [...malformed.files, { name: "turntable.jsonl", bytes: malformedTelemetry.length, sha256: digest(malformedTelemetry) }];
    const malformedId = (await service.create(owner, { clientId: "desktop-servo", recording: malformedRecording })).capture.id;
    await service.upload(owner, malformedId, { recording: malformedRecording, files: malformedFiles });
    for (const file of malformed.files) await service.chunk(owner, malformedId, file.name, 0, malformed.chunks[file.name]);
    await service.chunk(owner, malformedId, "turntable.jsonl", 0, malformedTelemetry);
    await assert.rejects(service.complete(owner, malformedId), rejected(400));
    assert.equal((await service.detail(owner, malformedId)).capture.uploadState, "error");
    passed.push("Matching-hash malformed telemetry cannot finalize or become a downloadable complete record");

    const bad = fixture(undefined, true), badId = (await service.create(owner, { clientId: "desktop-1", recording: bad.recording })).capture.id;
    await service.upload(owner, badId, { recording: bad.recording, files: bad.files });
    for (const file of bad.files) await service.chunk(owner, badId, file.name, 0, bad.chunks[file.name]);
    await assert.rejects(service.complete(owner, badId), rejected(400));
    assert.notEqual((await service.detail(owner, badId)).capture.uploadState, "complete");
    const damaged = fixture(), damagedId = (await service.create(owner, { clientId: "desktop-1", recording: damaged.recording })).capture.id;
    await service.upload(owner, damagedId, { recording: damaged.recording, files: damaged.files });
    await assert.rejects(service.chunk(owner, damagedId, damaged.files[0].name, 0, Buffer.alloc(damaged.files[0].bytes)), rejected(422));
    assert.equal((await service.upload(owner, damagedId, { recording: damaged.recording, files: damaged.files })).offsets[damaged.files[0].name], 0);
    await assert.rejects(service.chunk(owner, damagedId, "../../evil", 0, Buffer.from("x")), rejected(400));
    passed.push("SHA mismatch resets only invalid pending file; matching-hash corrupt native samples cannot finalize; traversal blocked");
    await assert.rejects(captureBody(new Request("http://test", { method: "POST", body: "abcd" }), 3), rejected(413));
    assert.deepEqual(await captureBody(new Request("http://test", { method: "POST", body: "abcd" }), 4), Buffer.from("abcd"));
    for (const line of passed) console.log(`PASS ${line}`);
    console.log(`${passed.length} capture contract groups passed; no database or physical device was accessed.`);
  } finally {
    if (before.capture === undefined) delete process.env.BLADE_CAPTURE_DATA_DIR; else process.env.BLADE_CAPTURE_DATA_DIR = before.capture;
    if (before.analysis === undefined) delete process.env.BLADE_ANALYSIS_DATA_DIR; else process.env.BLADE_ANALYSIS_DATA_DIR = before.analysis;
    await rm(root, { recursive: true, force: true });
  }
}
void main();
