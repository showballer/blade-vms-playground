/**
 * Local source E2E: actual Python simulation -> desktop cloud queue -> Web/MySQL
 * -> native waveform -> rotation worker. Never starts a hardware receiver.
 *
 * node --env-file=apps/web/.env.local scripts/test-capture-flow-e2e.mjs
 * CAPTURE_TEST_ORIGIN and BLADE_{CAPTURE,ANALYSIS}_DATA_DIR must match the local Web.
 * KEEP_CAPTURE_E2E=1 retains only this run's fixtures for browser acceptance.
 * The private fixture file can later be cleaned by running this script --cleanup.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import mysql from "mysql2/promise";

const require = createRequire(import.meta.url);
const { createFieldService } = require("../apps/desktop/electron/field-service.cjs");
const { createFieldCloudSync } = require("../apps/desktop/electron/field-cloud-sync.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.env.CAPTURE_TEST_ORIGIN || "http://127.0.0.1:3210";
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, "Only a local Web server may be tested");
assert.ok(["127.0.0.1", "localhost", "::1"].includes(process.env.DB_HOST), "Only a local fixture database may be used");
assert.equal(process.env.DB_NAME, "blade_vms_playground");
assert.equal(process.env.DB_USER, "blade_vms_app");
assert.ok(process.argv.slice(2).every(value => value === "--cleanup"), "Unknown test argument");
const captureRoot = path.resolve(process.env.BLADE_CAPTURE_DATA_DIR || path.join(root, ".data/web-captures"));
const analysisRoot = path.resolve(process.env.BLADE_ANALYSIS_DATA_DIR || path.join(root, ".data/web-rotation"));
const output = path.join(root, "artifacts/capture-flow-e2e");
const fixtureFile = path.join(output, "fixture.json");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => createHash("sha256").update(value).digest("hex");
const digestFile = async file => { const digest = createHash("sha256"); for await (const block of fs.createReadStream(file)) digest.update(block); return digest.digest("hex"); };
const database = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

async function cleanFixtures(fixture) {
  assert.equal(fixture.schema, "blade-vms/capture-e2e-fixture-v1");
  assert.match(fixture.tenant, /^qa-capture-flow-[a-f0-9-]{36}$/);
  assert.equal(path.resolve(fixture.captureRoot), captureRoot, "Cleanup must use the same capture storage root");
  assert.equal(path.resolve(fixture.analysisRoot), analysisRoot, "Cleanup must use the same analysis storage root");
  for (const user of fixture.users) {
    assert.match(user.id, /^[a-f0-9-]{36}$/);
    assert.match(user.username, /^qa_cflow_[a-z]+_[a-f0-9]{16}$/);
    assert.ok([fixture.tenant, fixture.tenant + "-other"].includes(user.tenant));
    const [found] = await database.execute("SELECT username,tenant FROM users WHERE id=?", [user.id]);
    if (found.length) assert.ok(found[0].username === user.username && found[0].tenant === user.tenant, "Refuse to clean a changed or unrelated account");
    const [captures] = await database.execute("SELECT id FROM captures WHERE owner_id=? AND tenant=?", [user.id, user.tenant]);
    for (const capture of captures) {
      assert.match(capture.id, /^[a-f0-9]{32}$/);
      fs.rmSync(path.join(captureRoot, capture.id), { recursive: true, force: true });
    }
    await database.execute("DELETE FROM captures WHERE owner_id=? AND tenant=?", [user.id, user.tenant]);
    await database.execute("DELETE FROM records WHERE created_by=? AND tenant=?", [user.id, user.tenant]);
    await database.execute("DELETE FROM sync_imports WHERE user_id=? AND tenant=?", [user.id, user.tenant]);
    await database.execute("DELETE FROM audit_logs WHERE actor_id=? AND tenant=?", [user.id, user.tenant]);
    await database.execute("DELETE FROM sessions WHERE user_id=?", [user.id]);
    await database.execute("DELETE FROM users WHERE id=? AND username=? AND tenant=?", [user.id, user.username, user.tenant]);
    fs.rmSync(path.join(analysisRoot, sha256(`${user.tenant}\0${user.id}`)), { recursive: true, force: true });
  }
  if (fixture.temporary) {
    assert.equal(path.dirname(fixture.temporary), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(fixture.temporary).startsWith("blade-capture-flow-"));
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes("--cleanup")) {
  try {
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
    await cleanFixtures(fixture); fs.unlinkSync(fixtureFile);
    console.log("PASS cleaned only the retained capture E2E fixtures");
  } finally { await database.end(); }
} else {
  assert.ok(!fs.existsSync(fixtureFile), "A previous kept fixture exists; clean it first with --cleanup");
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "blade-capture-flow-"));
  const dataDir = path.join(temporary, "desktop-data"), queueFile = path.join(temporary, "cloud-queue.json");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(output, { recursive: true });
  const fixture = { schema: "blade-vms/capture-e2e-fixture-v1", tenant: `qa-capture-flow-${randomUUID()}`,
    origin, captureRoot, analysisRoot, temporary, users: [], captures: [] };
  const report = { startedAt: new Date().toISOString(), passed: false, hardwareTested: false,
    platform: process.platform, actualPythonService: true, actualDesktopSync: true, actualWebApi: true,
    sdkDisabled: true, checks: [], captures: [], network: { rejectedRequests: 0, lostChunkResponses: 0, resumedPlans: 0 }, fixturesRetained: false };
  let service, cloud, ownedChild, cloudContext, offline = false, loseNextChunkAck = false, preserved = false;
  const clients = {}, tokens = new Map(), chunkRequests = new Map();
  const check = name => { report.checks.push(name); console.log("PASS " + name); };
  async function api(route, { user = "operator", method = "GET", body, binary, expected = 200 } = {}) {
    const token = tokens.get(user);
    const response = await fetch(`${origin}/api/v1/${route}`, { method, redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined && binary === undefined ? {} : { "content-type": binary === undefined ? "application/json" : "application/octet-stream" }) },
      ...(binary !== undefined ? { body: binary } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${route} expected ${expected}, got ${response.status}: ${data.error || ""}`);
    return data;
  }
  async function waitFor(callback, label, timeout = 25_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const result = await callback(); if (result) return result; await pause(100); }
    throw Error(`Timed out: ${label}; cloud=${cloud?.status().state || "none"}; ${cloud?.status().error || ""}`);
  }
  function keepFixture() { fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 }); fs.chmodSync(fixtureFile, 0o600); preserved = true; }
  async function createUser(label, role, other = false) {
    const user = { id: randomUUID(), username: `qa_cflow_${label}_${randomBytes(8).toString("hex")}`, name: `联动验收 ${label}`,
      role, tenant: fixture.tenant + (other ? "-other" : ""), password: randomBytes(24).toString("base64url") };
    const salt = randomBytes(16).toString("hex"), hash = `${salt}:${scryptSync(user.password, salt, 64).toString("hex")}`;
    await database.execute("INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,1)", [user.id, user.username, user.name, hash, user.role, user.tenant]);
    fixture.users.push(user); clients[label] = user;
    const session = await api("session", { user: "none", method: "POST", body: { username: user.username, password: user.password } });
    assert.equal(session.user.id, user.id); tokens.set(label, session.token);
    if (process.env.KEEP_CAPTURE_E2E === "1") keepFixture();
    return user;
  }
  function openCloud() {
    return createFieldCloudSync({ file: queueFile, dataDir: path.join(dataDir, "recordings"), intervalMs: 250,
      auth: { cloudBinding: () => ({ serverUrl: origin, user: clients.operator }), cloudSession: () => cloudContext,
        clearCloudSession: () => { cloudContext = null; } }, getLive: () => service.frame(1000),
      fetchImpl: async (url, request) => {
        assert.equal(new URL(url).origin, origin); assert.ok(new URL(url).pathname.startsWith("/api/v1/captures"));
        if (offline) { report.network.rejectedRequests++; throw new TypeError("Deliberate local E2E network outage"); }
        const route = new URL(url).pathname;
        if (route.includes("/chunks/")) chunkRequests.set(url, (chunkRequests.get(url) || 0) + 1);
        const response = await fetch(url, request);
        if (!response.ok) {
          const rejected = await response.clone().json().catch(() => ({}));
          report.network.lastRejection = { path: new URL(url).pathname, status: response.status, error: String(rejected.error || "").slice(0, 500) };
        }
        if (loseNextChunkAck && request.method === "PUT" && route.includes("/chunks/") && response.ok) {
          await response.arrayBuffer(); loseNextChunkAck = false; offline = true;
          report.network.lostChunkResponses++; throw new TypeError("Deliberate lost successful chunk acknowledgement");
        }
        if (route.endsWith("/upload") && response.ok) {
          const plan = await response.clone().json();
          if (plan.received?.length || Object.values(plan.offsets || {}).some(value => value > 0)) report.network.resumedPlans++;
        }
        return response;
      } });
  }
  async function run() {
    await api("health", { user: "none" });
    await createUser("operator", "operator"); await createUser("analyst", "analyst");
    await createUser("viewer", "viewer"); await createUser("colleague", "operator");
    await createUser("stranger", "analyst", true); await createUser("admin", "admin", true);
    cloudContext = { serverUrl: origin, user: clients.operator, token: tokens.get("operator") };
    const disabledDll = path.join(temporary, "HARDWARE_DISABLED_DO_NOT_CREATE.dll");
    service = createFieldService({ getConfig: () => ({ dll: disabledDll }), dataDir,
      resourcesDir: path.join(root, "apps/desktop/resources"), servicesRoot: path.join(root, "services/acquisition"), WebSocketImpl: null,
      spawnImpl: (file, args, config) => { assert.equal(config.env.BLADE_POLYTEC_DLL, disabledDll); ownedChild = spawn(file, args, config); return ownedChild; },
      fetchImpl: (url, request = {}) => {
        const parsed = new URL(url); assert.equal(parsed.hostname, "127.0.0.1");
        const route = parsed.pathname.slice("/api/field/".length);
        assert.ok(parsed.pathname.startsWith("/api/field/") && /^(status|simulation|frame|start|stop|recordings(?:\/[0-9a-f]{32}(?:\/export)?)?)$/.test(route), `Blocked acquisition route ${route}`);
        if (route === "start") { const body = JSON.parse(request.body); assert.equal(body.source, "simulation"); assert.ok(!body.deviceIp && !body.hostIp && !body.confirmLaser); }
        return fetch(url, request);
      } });
    const ready = await service.start(); assert.equal(ready.service.state, "ready", ready.service.error);
    assert.equal(ready.receiver.dllAvailable, false);
    const catalog = await service.simulation(); assert.deepEqual(catalog.points.map(point => point.id), ["P1", "P2", "P3"]);
    cloud = openCloud(); cloud.resume();
    for (const [index, point] of catalog.points.entries()) {
      const started = await service.begin({ source: "simulation", simulation: { point: point.id, scenario: "baseline" }, name: `云端联动验收 ${point.id}`, object: "临时模拟叶片", turbine: "E2E", point: point.id });
      assert.equal(started.recording.source, "simulation"); cloud.started(started.recording);
      const item = await waitFor(() => cloud.status().items.find(value => value.recordingId === started.recording.id)?.captureId, `${point.id} cloud registration`);
      fixture.captures.push(item); if (preserved) keepFixture();
      const first = await waitFor(async () => { const detail = await api(`captures/${item}`); return detail.frame?.waveform?.values.length > 0 && detail; }, `${point.id} first Web frame`);
      assert.equal(first.capture.liveState, "acquiring"); assert.equal(first.frame.recording.source, "simulation");
      const next = await waitFor(async () => { const detail = await api(`captures/${item}`); return detail.frame?.sequence > first.frame.sequence && detail.frame.recording.samples > first.frame.recording.samples && detail; }, `${point.id} increasing sequence and samples`);
      assert.ok(next.frame.waveform.values.length <= 2048);
      if (index === 0) {
        offline = true; await cloud.settled();
        const before = await api(`captures/${item}`), localBefore = await service.frame(1000);
        await waitFor(async () => { const frame = await service.frame(1000); return report.network.rejectedRequests > 0 && frame.recording.samples > localBefore.recording.samples + point.sampleRate * 0.6 && frame; }, "local acquisition continues through network outage");
        const unchanged = await api(`captures/${item}`); assert.equal(unchanged.frame.sequence, before.frame.sequence);
        offline = false;
        await waitFor(async () => { const detail = await api(`captures/${item}`); return detail.frame?.sequence > before.frame.sequence; }, "automatic live retry after network recovery");
        check("Network outage leaves local acquisition running; live publishing automatically resumes");
      }
      await waitFor(async () => { const frame = await service.frame(1000); assert.notEqual(frame.state, "error", frame.error); return frame.recording.samples >= Math.max(5000, Math.ceil(point.sampleRate * 6)); }, `${point.id} full 4096-sample live analysis window`);
      const analyzed = await waitFor(async () => {
        const detail = await api(`captures/${item}`);
        return detail.frame?.recording.samples > 4096 && detail.frame.realtime?.available === true &&
          detail.frame.realtime.spectrum?.frequencies.length === 2049 && detail;
      }, `${point.id} full 2049-bin FFT reaches Web`);
      assert.equal(analyzed.frame.realtime.spectrum.amplitudes.length, 2049);
      assert.ok(analyzed.frame.realtime.timeDomain.values.length > 0);
      assert.ok(analyzed.frame.realtime.spectrogram.db.length > 0);
      const fullWindowNext = await waitFor(async () => {
        const detail = await api(`captures/${item}`);
        return detail.frame?.sequence > analyzed.frame.sequence && detail.frame.realtime?.available === true &&
          detail.frame.realtime.spectrum?.frequencies.length === 2049 && detail;
      }, `${point.id} subsequent full-window live frame remains available`);
      cloud.pause(); await cloud.settled();
      const stopped = await service.stop(); assert.equal(stopped.recording.status, "complete"); assert.equal(stopped.receiver.running, false);
      const localDirectory = path.join(dataDir, "recordings", stopped.recording.id);
      const nativeFiles = fs.readdirSync(localDirectory).filter(name => /^(chunk-[0-9]{8}\.bin|unpaired-rssi\.bin)$/.test(name)).sort();
      const originalHashes = Object.fromEntries(await Promise.all(nativeFiles.map(async name => [name, await digestFile(path.join(localDirectory, name))])));
      if (index === 0) loseNextChunkAck = true;
      cloud.finished(stopped.recording); cloud.resume();
      if (index === 0) {
        await waitFor(() => report.network.lostChunkResponses === 1 && cloud.status().items.find(value => value.captureId === item)?.state === "error", "acknowledgement loss and persistent retry queue");
        const partial = await api(`captures/${item}`); assert.equal(partial.capture.uploadState, "uploading");
        cloud.dispose(); await cloud.settled(); offline = false;
        cloud = openCloud(); cloud.resume();
      }
      await waitFor(() => cloud.status().items.find(value => value.captureId === item)?.state === "synced", `${point.id} complete native upload`, 40_000);
      const detail = await api(`captures/${item}`);
      assert.equal(detail.capture.uploadState, "complete"); assert.equal(detail.capture.liveState, "stopped");
      assert.equal(detail.capture.recording.samples, stopped.recording.samples);
      assert.equal(detail.capture.receivedBytes, detail.capture.totalBytes);
      for (const name of nativeFiles) {
        assert.equal(await digestFile(path.join(localDirectory, name)), originalHashes[name], "Sync must not mutate desktop raw files");
        assert.equal(await digestFile(path.join(captureRoot, item, "complete", name)), originalHashes[name], "Cloud raw bytes must equal original native files");
      }
      const wave = await api(`captures/${item}/waveform?start=0&end=128`, { user: "analyst" });
      const localBytes = fs.readFileSync(path.join(localDirectory, nativeFiles.find(name => name.startsWith("chunk-"))));
      assert.equal(wave.waveform.values.length, 128);
      for (let sample = 0; sample < 128; sample++) assert.equal(wave.waveform.values[sample], localBytes.readDoubleLE(32 + sample * 29 + 12));
      const completedAgain = await api(`captures/${item}/complete`, { method: "POST", body: {} }); assert.equal(completedAgain.capture.id, item);
      const queued = JSON.parse(fs.readFileSync(queueFile, "utf8"));
      const createdAgain = await api("captures", { method: "POST", expected: 201, body: { clientId: queued.clientId, recording: stopped.recording } }); assert.equal(createdAgain.capture.id, item);
      if (index === 0) {
        assert.equal(report.network.lostChunkResponses, 1); assert.ok(report.network.resumedPlans > 0);
        const requestKey = `${origin}/api/v1/captures/${item}/chunks/${nativeFiles[0]}?offset=0`;
        assert.equal(chunkRequests.get(requestKey), 1, "Restart must resume from server acknowledgement rather than send accepted bytes twice");
        const gzip = path.join(temporary, "offline-export.csv.gz");
        assert.equal((await service.exportRecording(stopped.recording.id, gzip)).saved, true);
        const imported = await api("rotation/import?filename=offline-export.csv.gz&source=simulation", { user: "analyst", method: "POST", binary: fs.readFileSync(gzip), expected: 201 });
        assert.equal(imported.recordings[0].samples, stopped.recording.samples); assert.equal(imported.recordings[0].source, "simulation");
        check("Lost successful chunk response resumes after queue restart without duplicate raw bytes; manual CSV.GZ import also succeeds");
      }
      report.captures.push({ id: item, localId: stopped.recording.id, point: point.id, samples: stopped.recording.samples, sampleRate: point.sampleRate,
        firstSequence: first.frame.sequence, nextSequence: next.frame.sequence, fullWindowSequence: fullWindowNext.frame.sequence,
        fftFrequencyBins: analyzed.frame.realtime.spectrum.frequencies.length, liveRealtimeAvailable: true,
        nativeHashesMatched: true, waveform128Exact: true });
      check(`${point.id}: increasing live frames with full 2049-bin FFT, complete native upload, exact original sample readback and idempotent confirmation`);
    }
    const id = fixture.captures[0];
    for (const label of ["operator", "analyst", "viewer", "admin"]) {
      const list = await api("captures", { user: label });
      assert.equal(list.captures.filter(value => fixture.captures.includes(value.id)).length, 3);
      await api(`captures/${id}`, { user: label });
      await api(`captures/${id}/waveform?start=0&end=64`, { user: label });
    }
    for (const label of ["colleague", "stranger"]) {
      const list = await api("captures", { user: label }); assert.equal(list.captures.filter(value => fixture.captures.includes(value.id)).length, 0);
      await api(`captures/${id}`, { user: label, expected: 404 });
      await api(`captures/${id}/waveform?start=0&end=64`, { user: label, expected: 404 });
    }
    const recording = (await api(`captures/${id}`)).capture.recording;
    await api("captures", { user: "viewer", method: "POST", body: { clientId: "forbidden-viewer", recording }, expected: 403 });
    await api(`captures/${id}/complete`, { user: "analyst", method: "POST", body: {}, expected: 403 });
    for (const label of ["operator", "viewer"]) await api(`captures/${id}/prepare-analysis`, { user: label, method: "POST", body: {}, expected: 403 });
    check("Role isolation: administrators global, analysts/viewers same group, operators own records; readonly and analysis restrictions enforced");
    const prepared = [];
    for (const captureId of fixture.captures) {
      const result = await api(`captures/${captureId}/prepare-analysis`, { user: "analyst", method: "POST", body: {} });
      assert.equal(result.recording.cloudCaptureId, captureId); assert.equal(result.recording.source, "simulation"); prepared.push(result.recording.id);
      const retry = await api(`captures/${captureId}/prepare-analysis`, { user: "analyst", method: "POST", body: {} }); assert.equal(retry.recording.id, result.recording.id);
    }
    const parameters = { recordingIds: prepared, rpm: 1200, pointsPerRevolution: 256, maxOrder: 20, targetOrder: 1, maxRevolutions: 50, positions: [0.2, 0.6, 0.9], pointNames: ["P1", "P2", "P3"] };
    await api("rotation/analyze", { user: "operator", method: "POST", body: parameters, expected: 403 });
    const result = await api("rotation/analyze", { user: "analyst", method: "POST", body: parameters });
    assert.equal(result.modeShape.points.length, 3); assert.equal(result.orderSpectra.length, 3); assert.equal(result.revolutions, 50);
    assert.ok(result.sources.every(source => source.source === "simulation"));
    assert.ok(result.warnings.some(text => text.includes("模拟")));
    report.rotation = { points: 3, revolutions: result.revolutions, samplesPerRevolution: 256, rpm: result.rpm, simulationProvenance: true };
    check("Three independently simulated points prepare idempotently and complete real Python rotation analysis with simulation provenance");
    const owned = await api("captures"); assert.equal(owned.captures.length, 3);
    assert.equal((await service.recordings()).recordings.length, 3);
    report.passed = true;
  }
  try { await run(); }
  catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
  finally {
    cloud?.dispose(); await cloud?.settled();
    try {
      if (service) await service.shutdown({ force: true });
      if (ownedChild) assert.ok(ownedChild.exitCode !== null || ownedChild.signalCode, "Owned simulation process must exit");
      if (process.env.KEEP_CAPTURE_E2E === "1") { keepFixture(); report.fixturesRetained = true; }
      else { await cleanFixtures(fixture); if (preserved && fs.existsSync(fixtureFile)) fs.unlinkSync(fixtureFile); }
    } catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
    await database.end();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`Report: ${path.join(output, "report.json")}`);
    if (report.fixturesRetained) console.log("Temporary browser fixtures retained in the private fixture.json file; run --cleanup after acceptance.");
  }
}
