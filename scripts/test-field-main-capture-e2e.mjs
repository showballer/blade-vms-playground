/** Actual field-main assembly + auth/service/queue/IPC, with only Electron UI stubbed.
 * Requires the retained local fixtures created by test-capture-flow-e2e.mjs.
 * The original E2E --cleanup removes this run's account-owned data and temp files.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureFile = path.join(root, "artifacts/capture-flow-e2e/fixture.json");
const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
assert.equal(fixture.schema, "blade-vms/capture-e2e-fixture-v1");
assert.match(fixture.tenant, /^qa-capture-flow-[a-f0-9-]{36}$/);
assert.match(fixture.origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
assert.ok(path.basename(fixture.temporary).startsWith("blade-capture-flow-"));
const operator = fixture.users.find(user => user.role === "operator" && user.tenant === fixture.tenant);
assert.match(operator.username, /^qa_cflow_operator_[a-f0-9]{16}$/);
const userData = fs.mkdtempSync(path.join(fixture.temporary, "field-main-"));
const mainFile = path.join(root, "apps/desktop/electron/field-main.cjs");
const mainRequire = createRequire(mainFile);
const { createLocalAuth } = mainRequire("./local-auth.cjs");
const { createFieldService, failure } = mainRequire("./field-service.cjs");
const { createFieldCloudSync } = mainRequire("./field-cloud-sync.cjs");
const localSecret = randomBytes(24).toString("base64url");
// Bootstrap an isolated local workspace with a known random password, without
// reading or changing any installed desktop user's credentials.
const { scryptSync } = mainRequire("node:crypto");
const salt = randomBytes(32).toString("hex");
const bootstrap = { version: 1, username: "admin", salt, hash: scryptSync(localSecret, salt, 64).toString("hex") };
const seeded = createLocalAuth({ file: path.join(userData, "blade-local-auth.json"), bootstrap });
seeded.login("admin", localSecret);
const localPassword = randomBytes(24).toString("base64url");
seeded.changePassword(localSecret, localPassword); seeded.logout();
const disabledDll = path.join(userData, "HARDWARE_DISABLED_DO_NOT_CREATE.dll");
fs.writeFileSync(path.join(userData, "blade-field-settings.json"), JSON.stringify({ dll: disabledDll }), { mode: 0o600 });
const report = { passed: false, actualFieldMainEntry: true, actualIpc: true, actualAuth: true,
  actualService: true, actualCloudQueue: true, electronWindowStubbed: true, hardwareTested: false };
let win, ipc, service, queue, unified, child, apiToken;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(operation, label, timeout = 40_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await operation(); if (value) return value; await pause(150); }
  throw Error(`Timed out: ${label}; ${queue?.status().error || ""}`);
}
async function api(route, method = "GET", body) {
  const response = await fetch(`${fixture.origin}/api/v1/${route}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { origin: fixture.origin, ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); assert.ok(response.ok, `${route}: ${response.status} ${value.error || ""}`); return value;
}
async function invoke(options) {
  assert.ok(ipc && win, "Actual field-main must register its IPC entry");
  const result = await ipc({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, options);
  assert.equal(result.status, 200, `${options.action}: ${result.data?.error || ""}`); return result.data;
}
const app = new EventEmitter();
Object.assign(app, { isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
  getPath: name => { assert.equal(name, "userData"); return userData; }, quit: () => {} });
class BrowserWindow extends EventEmitter {
  constructor() { super(); win = this; this.webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "" }, setWindowOpenHandler: () => {}, session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} },
  }); }
  async loadURL(url) { this.webContents.mainFrame.url = url; }
}
const electron = { app, BrowserWindow, ipcMain: { handle: (channel, handler) => { assert.equal(channel, "blade:field"); ipc = handler; }, on: () => {} },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
  dialog: { showErrorBox: () => { throw Error("Actual field-main initialization failed"); }, showMessageBox: async () => ({ response: 1 }) }, shell: {} };
function requireFromMain(name) {
  if (name === "electron") return electron;
  if (name === "./unified-auth.cjs") return { createUnifiedAuth: options => {
    unified = mainRequire(name).createUnifiedAuth(options); return unified;
  } };
  if (name === "./field-service.cjs") return { failure, createFieldService: options => {
    // All main-selected paths pass through unchanged. Only the process/network
    // hooks add assertions that this isolated test cannot call a hardware route.
    service = createFieldService({ ...options, WebSocketImpl: null,
      spawnImpl: (file, args, config) => { assert.equal(config.env.BLADE_POLYTEC_DLL, disabledDll); child = spawn(file, args, config); return child; },
      fetchImpl: (url, request = {}) => {
        const target = new URL(url), route = target.pathname.slice("/api/field/".length);
        assert.equal(target.hostname, "127.0.0.1");
        assert.ok(target.pathname.startsWith("/api/field/") && /^(status|simulation|frame|start|stop|recordings(?:\/[0-9a-f]{32})?)$/.test(route));
        if (route === "start") { const data = JSON.parse(request.body); assert.equal(data.source, "simulation"); assert.ok(!data.deviceIp && !data.hostIp && !data.confirmLaser); }
        return fetch(url, request);
      } }); return service;
  } };
  if (name === "./field-cloud-sync.cjs") return { createFieldCloudSync: options => {
    report.queueDataDirectory = path.relative(userData, options.dataDir);
    queue = createFieldCloudSync({ ...options, fetchImpl: (url, request) => {
      assert.equal(new URL(url).origin, fixture.origin); return fetch(url, request);
    } }); return queue;
  } };
  return mainRequire(name);
}
try {
  apiToken = (await api("session", "POST", { username: operator.username, password: operator.password })).token;
  vm.runInNewContext(fs.readFileSync(mainFile, "utf8"), { require: requireFromMain, __dirname: path.dirname(mainFile),
    process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval }, { filename: mainFile });
  await waitFor(() => ipc && win?.webContents.mainFrame.url, "actual main IPC readiness");
  await invoke({ action: "login", username: "admin", password: localPassword });
  const ready = await waitFor(async () => { const status = await invoke({ action: "status" }); return status.service.state === "ready" && status; }, "actual main Python service ready");
  assert.equal(ready.receiver.dllAvailable, false);
  await invoke({ action: "bindAccount", serverUrl: fixture.origin, username: operator.username, password: operator.password, currentPassword: localPassword });
  const started = await invoke({ action: "start", config: { source: "simulation", simulation: { point: "P1", scenario: "baseline" },
    name: "实际 field-main 装配联动验收", object: "临时模拟叶片", turbine: "E2E", point: "P1" } });
  const captureId = await waitFor(async () => (await invoke({ action: "syncStatus" })).items.find(item => item.recordingId === started.recording.id)?.captureId, "actual main cloud registration");
  fixture.captures.push(captureId);
  fs.writeFileSync(fixtureFile + ".tmp", JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(fixtureFile + ".tmp", fixtureFile);
  const live = await waitFor(async () => { const detail = await api(`captures/${captureId}`); return detail.frame?.recording.samples > 4096 && detail.frame.realtime?.spectrum?.frequencies.length === 2049 && detail; }, "actual main 4096-sample real-time FFT reaches Web");
  assert.equal(live.frame.realtime.available, true);
  const stopped = await invoke({ action: "stop" }); assert.equal(stopped.recording.status, "complete");
  await waitFor(async () => (await invoke({ action: "syncStatus" })).items.find(item => item.recordingId === started.recording.id)?.state === "synced", "actual main stopped recording fully uploaded");
  const final = await api(`captures/${captureId}`);
  assert.equal(final.capture.uploadState, "complete"); assert.equal(final.capture.recording.samples, stopped.recording.samples);
  const nativeDirectory = path.join(userData, "field-data/recordings", stopped.recording.id);
  for (const name of fs.readdirSync(nativeDirectory).filter(name => /^chunk-[0-9]{8}\.bin$/.test(name))) {
    const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.equal(digest(path.join(nativeDirectory, name)), digest(path.join(fixture.captureRoot, captureId, "complete", name)));
  }
  Object.assign(report, { passed: true, captureId, samples: stopped.recording.samples, fftFrequencyBins: 2049, nativeHashesMatched: true });
  console.log("PASS actual field-main assembly: local login -> unified binding -> IPC simulation -> live 2049-bin FFT -> stop -> exact raw cloud upload");
} catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
finally {
  queue?.dispose(); await queue?.settled();
  try { await service?.shutdown({ force: true }); if (child) assert.ok(child.exitCode !== null || child.signalCode); unified?.logout(); }
  catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  if (apiToken) await api("session", "DELETE").catch(() => {});
  fs.writeFileSync(path.join(root, "artifacts/capture-flow-e2e/main-assembly-report.json"), JSON.stringify(report, null, 2) + "\n");
}
