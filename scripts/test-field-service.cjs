"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { EventEmitter } = require("node:events");
const { createFieldService, windowsServiceEnvironment } = require("../apps/desktop/electron/field-service.cjs");

const idle = () => ({ state: "idle", error: null, receiver: { connected: false }, recording: null });
const acquiring = () => ({ state: "acquiring", error: null, receiver: { connected: true }, recording: { id: "recording-1", state: "acquiring" } });
const waveform = values => ({ sampleRate: 1000, unit: "m/s", values, rssi: [], overrange: [] });

test("waveform bridge permits only bounded sample ranges and no arbitrary paths", async t => {
  const f = fixture(t, { fetch: ({ route }) => response(route.includes('/waveform') ? { waveform: waveform([1]) } : idle()) });
  for (const id of ['../secret', 'http://remote', 'x'.repeat(32), 'record?file=1']) await assert.rejects(f.service.waveform(id), { status: 400 });
  for (const [start, end] of [[-1, 10], [1.2, 10], [10, 2], [Infinity, 100], [0, Number.MAX_SAFE_INTEGER + 1]]) await assert.rejects(f.service.waveform('a'.repeat(32), start, end), { status: 400 });
  await f.service.waveform('a'.repeat(32), 10, 20);
  const url = new URL(f.requests.at(-1).url);
  assert.equal(url.searchParams.get('start'), '10');
  assert.equal(url.searchParams.get('end'), '20');
});

test("device bridge requires explicit consent and refuses modifying an active capture", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.device({ deviceIp: '192.168.104.50', action: 'set', key: 'laser', value: 1, confirmChange: true }), { status: 400 });
  await assert.rejects(f.service.device({ deviceIp: '192.168.104.50', action: 'autofocus' }), { status: 400 });
  await assert.rejects(f.service.frame(50000), { status: 400 });
  const active = fixture(t, { fetch: () => response(acquiring()) });
  await assert.rejects(active.service.device({ deviceIp: '192.168.104.50', action: 'read' }), { status: 409 });
  assert.ok(active.requests.every(request => request.route !== 'device'));
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) });

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blade-field-service-test-"));
  const executable = path.join(directory, "BladeAcquisition.exe");
  fs.writeFileSync(executable, "test fixture; never executed");
  const children = [], requests = [], sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; sockets.push(this); }
    addEventListener(name, handler) { this.on(name, handler); }
    close() { this.emit("close"); }
  }
  const service = createFieldService({
    getConfig: () => ({ executable }), dataDir: path.join(directory, "data"), resourcesDir: directory,
    servicesRoot: path.join(directory, "services-acquisition"),
    platform: "win32", startupTimeoutMs: 300, requestTimeoutMs: 300, terminationTimeoutMs: 20,
    WebSocketImpl: FakeSocket,
    spawnImpl(file, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.file = file; child.args = args; child.options = options; child.signals = []; child.exited = false;
      child.exitCode = null; child.signalCode = null;
      child.finish = (code = 0, signal = null) => {
        if (!child.exited) {
          child.exited = true; child.exitCode = code; child.signalCode = signal;
          child.emit("exit", code, signal); child.emit("close", code, signal);
        }
      };
      child.kill = (signal = "SIGTERM") => {
        child.signals.push(signal);
        if (overrides.kill) return overrides.kill(child, signal, children.length - 1);
        queueMicrotask(() => child.finish()); return true;
      };
      children.push(child);
      overrides.spawn?.(child, children.length - 1);
      return child;
    },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname.replace("/api/field/", "");
      const request = { url, route, options }; requests.push(request);
      if (overrides.fetch) return overrides.fetch(request, { children, requests, sockets });
      return response(route === "frame" ? { ...idle(), waveform: waveform([]) } : idle());
    },
    ...overrides.options,
  });
  t.after(async () => {
    for (const child of children) child.finish();
    try { await service.shutdown({ force: true }); } catch { /* Keep the assertion failure. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { service, children, requests, sockets, directory };
}

function pythonServiceFixture() {
  const servicesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blade-services-root-"));
  fs.mkdirSync(path.join(servicesRoot, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(servicesRoot, ".venv", "bin", "python"), "fixture; never executed");
  fs.mkdirSync(path.join(servicesRoot, "blade_acquisition"), { recursive: true });
  fs.writeFileSync(path.join(servicesRoot, "blade_acquisition", "__main__.py"), "# fixture");
  return servicesRoot;
}

test("start is single-flight and secret stays in process environment and authenticated transport", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.service.start(), f.service.start()]);
  assert.equal(f.children.length, 1);
  assert.equal(results[0].service.state, "ready");
  const child = f.children[0], secret = child.options.env.BLADE_SERVICE_TOKEN;
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(child.options.shell, false);
  assert.equal(child.options.windowsHide, true);
  assert.deepEqual(child.args, []);
  assert.equal(Object.hasOwn(child.options.env, "DATABASE_URL"), false);
  for (const request of f.requests) {
    assert.equal(new URL(request.url).hostname, "127.0.0.1");
    assert.equal(request.options.headers.Authorization === `Bearer ${secret}`, true);
    assert.equal(request.options.redirect, "error");
  }
  assert.equal(JSON.stringify(results).includes(secret), false);
  assert.equal(f.sockets[0].protocols[1] === secret, true);
});

test("Windows service ignores installed Python, Conda, venv and inherited DLL search paths", () => {
  const source = Object.freeze({
    PATH: "C:\\Python32;C:\\Python312;C:\\Miniconda\\Library\\bin;C:\\project\\.venv\\Scripts",
    Path: "C:\\other-python;C:\\old-sdk", pAtH: "C:\\another-python",
    PYTHONHOME: "C:\\Python32", pythonpath: "C:\\unrelated-packages",
    PYTHONSTARTUP: "C:\\startup.py", PYTHONUSERBASE: "C:\\user-packages",
    PYTHONINSPECT: "1", PYTHONUNBUFFERED: "0", PYTHONWARNINGS: "error",
    CONDA_PREFIX: "C:\\Miniconda", CONDA_DEFAULT_ENV: "other-project", VIRTUAL_ENV: "C:\\project\\.venv",
    _PYI_APPLICATION_HOME_DIR: "C:\\other-bundled-app", _PYI_ARCHIVE_FILE: "C:\\other-app.exe",
    _MEIPASS2: "C:\\other-app\\runtime", PYINSTALLER_RESET_ENVIRONMENT: "0",
    SystemRoot: "D:\\Windows", WINDIR: "C:\\incorrect-windows", SystemDrive: "C:",
    TEMP: "D:\\Users\\测试用户\\Temp", TMP: "D:\\Users\\测试用户\\Temp",
    USERPROFILE: "D:\\Users\\测试用户", LOCALAPPDATA: "D:\\Users\\测试用户\\AppData\\Local",
    APPDATA: "D:\\Users\\测试用户\\AppData\\Roaming", PROGRAMDATA: "D:\\ProgramData", LANG: "zh_CN.UTF-8",
    DATABASE_URL: "private-data", BLADE_SERVICE_TOKEN: "caller-token", BLADE_SERVICE_PORT: "8000",
  });
  const before = { ...source };
  const env = windowsServiceEnvironment({
    file: "D:\\Applications\\旋转叶片测振\\acquisition\\BladeAcquisition.exe",
    dataDir: "D:\\Users\\测试用户\\field-data", dll: "E:\\SDK\\DeviceCommunication.dll",
    port: 54321, secret: "new-random-token", source,
  });
  assert.deepEqual(source, before, "building child environment must never mutate user/system environment");
  assert.deepEqual(env.PATH.split(";"), [
    "D:\\Applications\\旋转叶片测振\\acquisition",
    "D:\\Applications\\旋转叶片测振\\acquisition\\_internal",
    "D:\\Applications\\旋转叶片测振\\acquisition\\vendor",
    "D:\\Windows\\System32", "D:\\Windows", "D:\\Windows\\System32\\Wbem",
  ]);
  assert.equal(env.SystemRoot, "D:\\Windows");
  assert.equal(env.WINDIR, "D:\\Windows");
  assert.equal(env.SystemDrive, "D:");
  assert.equal(env.PYTHONUNBUFFERED, "1");
  for (const key of ["TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "LANG"]) {
    assert.equal(env[key], source[key]);
  }
  for (const key of Object.keys(source)) {
    if (/^(?:PYTHON(?!UNBUFFERED)|CONDA|VIRTUAL_ENV|_PYI|_MEIPASS|PYINSTALLER|DATABASE_URL)/i.test(key)) {
      assert.equal(Object.hasOwn(env, key), false, `${key} must not cross the process boundary`);
    }
  }
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === "path").length, 1);
  assert.equal(env.BLADE_SERVICE_PORT, "54321");
  assert.equal(env.BLADE_SERVICE_TOKEN, "new-random-token");
  assert.equal(env.BLADE_POLYTEC_DLL, "E:\\SDK\\DeviceCommunication.dll");
  assert.equal(env.BLADE_DATA_DIR, "D:\\Users\\测试用户\\field-data");
});

test("Windows environment allowlist handles mixed casing and never emits duplicate names", () => {
  const env = windowsServiceEnvironment({ file: "C:\\App\\BladeAcquisition.exe", dataDir: "C:\\data",
    dll: "C:\\App\\vendor\\DeviceCommunication.dll", port: 32100, secret: "secret",
    source: { sYsTeMrOoT: "E:/Windows/", SystemRoot: "F:\\wrong", tEmP: "E:\\temp", tmp: "E:\\tmp",
      UserProfile: "E:\\Users\\admin", LocalAppData: "E:\\local", aPpDaTa: "E:\\roaming", pAtH: "C:\\Conda" } });
  assert.equal(env.SystemRoot, "E:\\Windows\\");
  assert.equal(env.SystemDrive, "E:");
  assert.equal(env.TEMP, "E:\\temp");
  assert.equal(env.TMP, "E:\\tmp");
  assert.equal(env.USERPROFILE, "E:\\Users\\admin");
  assert.equal(env.LOCALAPPDATA, "E:\\local");
  assert.equal(env.APPDATA, "E:\\roaming");
  const names = Object.keys(env).map(key => key.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(env.PATH.includes("Conda"), false);
});

test("missing or unusable Windows root cannot turn inherited PATH into a fallback", () => {
  const build = source => windowsServiceEnvironment({ file: "C:\\App\\BladeAcquisition.exe", dataDir: "C:\\data",
    dll: "C:\\App\\vendor\\DeviceCommunication.dll", port: 32100, secret: "secret", source });
  for (const source of [{}, { SystemRoot: "relative\\Windows", PATH: "C:\\Python" },
    { SystemRoot: "C:\\Windows;C:\\Python", WINDIR: "\\\\server\\share", Path: "C:\\Conda" }]) {
    const env = build(source);
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.SystemDrive, "C:");
    assert.equal(env.PATH.includes("Python") || env.PATH.includes("Conda") || env.PATH.includes("server"), false);
  }
  assert.equal(build({ SystemRoot: "invalid", windir: "F:\\Windows" }).SystemRoot, "F:\\Windows");
});

test("service startup passes only the isolated environment without invoking system Python", async (t) => {
  const environment = Object.freeze({ Path: "C:\\Miniconda\\Scripts;C:\\Python32", SystemRoot: "C:\\Windows",
    PYTHONHOME: "C:\\Python32", PYTHONPATH: "C:\\foreign-packages", VIRTUAL_ENV: "C:\\venv", CONDA_PREFIX: "C:\\Miniconda" });
  const f = fixture(t, { options: { environment } });
  await f.service.start();
  const child = f.children[0];
  assert.equal(child.file, path.join(f.directory, "BladeAcquisition.exe"));
  assert.equal(child.options.cwd, f.directory);
  assert.equal(child.options.shell, false);
  assert.deepEqual(child.args, []);
  assert.equal(child.options.env.PATH.includes("Miniconda") || child.options.env.PATH.includes("Python32"), false);
  for (const key of ["Path", "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX"]) assert.equal(Object.hasOwn(child.options.env, key), false);
  assert.equal(environment.Path, "C:\\Miniconda\\Scripts;C:\\Python32");
});

test("missing Windows bundle reports missing without spawning", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.directory, "BladeAcquisition.exe"));
  assert.equal((await f.service.start()).service.state, "missing");
  assert.equal(f.children.length, 0);
});

test("non-Windows platform without a virtualenv reports missing without spawning", async (t) => {
  const f = fixture(t, { options: { platform: "darwin" } });
  const result = await f.service.start();
  assert.equal(result.service.state, "missing");
  assert.match(result.service.error, /Python 采集服务环境/);
  assert.equal(f.children.length, 0);
});

test("non-Windows platform spawns python -m blade_acquisition with a scrubbed environment", async (t) => {
  const servicesRoot = pythonServiceFixture();
  const environment = Object.freeze({ PATH: "/usr/bin:/bin", PYTHONPATH: "/foreign", PYTHONHOME: "/conda",
    VIRTUAL_ENV: "/venv", CONDA_PREFIX: "/conda", DATABASE_URL: "mysql://should-not-leak" });
  const f = fixture(t, { options: { platform: "darwin", servicesRoot, environment } });
  const result = await f.service.start();
  assert.equal(result.service.state, "ready");
  assert.equal(result.service.launcher, "python-module");
  assert.equal(f.children.length, 1);
  const child = f.children[0];
  assert.equal(child.file, path.join(servicesRoot, ".venv", "bin", "python"));
  assert.deepEqual(child.args, ["-m", "blade_acquisition"]);
  assert.equal(child.options.cwd, servicesRoot);
  assert.equal(child.options.shell, false);
  assert.equal(child.options.windowsHide, true);
  assert.equal(child.options.env.PATH, "/usr/bin:/bin");
  for (const key of ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "CONDA_PREFIX"]) assert.equal(Object.hasOwn(child.options.env, key), false);
  assert.equal(child.options.env.DATABASE_URL, "mysql://should-not-leak");
  assert.equal(child.options.env.BLADE_DATA_DIR, path.join(f.directory, "data"));
  assert.match(child.options.env.BLADE_SERVICE_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(child.options.env.BLADE_POLYTEC_DLL, "");
  fs.rmSync(servicesRoot, { recursive: true, force: true });
});

test("BLADE_ACQUISITION_PYTHON overrides the virtualenv interpreter", async (t) => {
  const servicesRoot = pythonServiceFixture();
  const custom = path.join(servicesRoot, "custom-python");
  fs.writeFileSync(custom, "fixture");
  const f = fixture(t, { options: { platform: "darwin", servicesRoot,
    environment: Object.freeze({ PATH: "/usr/bin", BLADE_ACQUISITION_PYTHON: custom }) } });
  assert.equal((await f.service.start()).service.state, "ready");
  assert.equal(f.children[0].file, custom);
  assert.deepEqual(f.children[0].args, ["-m", "blade_acquisition"]);
  fs.rmSync(servicesRoot, { recursive: true, force: true });
});

test("laser and acquisition require complete explicit confirmation before any start call", async (t) => {
  const f = fixture(t);
  const config = { deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "实机任务", object: "叶片", turbine: "机组", point: "测点" };
  await assert.rejects(f.service.begin(config), error => error.status === 400);
  await assert.rejects(f.service.begin({ ...config, confirmLaser: true, hostIp: "example.com" }), error => error.status === 400);
  await assert.rejects(f.service.begin({ ...config, confirmLaser: true, name: "" }), error => error.status === 400);
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
  await f.service.begin({ ...config, confirmLaser: true });
  assert.equal(f.requests.filter(request => request.route === "start").length, 1);
});

test("simulation needs an explicit source and rejects invalid point/scenario before launching or requesting", async (t) => {
  const f = fixture(t);
  const config = { source: "simulation", name: "模拟风机", object: "叶片", turbine: "机组", point: "测点",
    simulation: { point: "P2", scenario: "impact" } };
  for (const source of ["mock", "SIMULATION", "", null, false]) {
    await assert.rejects(f.service.begin({ ...config, source }), { status: 400 });
  }
  for (const simulation of [undefined, {}, { point: "P0", scenario: "baseline" }, { point: "P4", scenario: "impact" },
    { point: "P1", scenario: "unknown" }, { point: "P1", scenario: "" }, { point: "P1", scenario: null }]) {
    await assert.rejects(f.service.begin({ ...config, simulation }), { status: 400 });
  }
  await assert.rejects(f.service.begin({ ...config, source: undefined }), { status: 400 });
  await assert.rejects(f.service.begin({ ...config, name: "  " }), { status: 400 });
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
});

test("explicit simulation starts without DLL, device addresses or laser consent and forwards only simulation controls", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => response(route === "start" ? { ...acquiring(), source: "simulation" } : idle()) });
  const config = { source: "simulation", simulation: { point: "P2", scenario: "impact", file: "/must-not-forward" },
    name: "  模拟风机  ", object: "叶片", turbine: "", point: "" };
  assert.equal(f.service.serviceInfo().dllConfigured, false);
  const result = await f.service.begin(config);
  assert.equal(result.state, "acquiring");
  assert.equal(result.source, "simulation");
  const starts = f.requests.filter(request => request.route === "start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.method, "POST");
  assert.deepEqual(JSON.parse(starts[0].options.body), { source: "simulation", simulation: { point: "P2", scenario: "impact" },
    name: "模拟风机", object: "叶片", turbine: "", point: "" });
  assert.equal(f.requests.filter(request => request.route === "device").length, 0);
});

test("simulation cannot make omitted/default device source bypass laser confirmation or IPv4 checks", async (t) => {
  const f = fixture(t);
  const config = { source: "device", simulation: { point: "P1", scenario: "baseline" }, name: "设备任务", object: "", turbine: "", point: "",
    deviceIp: "192.168.0.10", hostIp: "192.168.0.2" };
  for (const confirmLaser of [undefined, false, 1, "true"]) await assert.rejects(f.service.begin({ ...config, confirmLaser }), { status: 400 });
  for (const patch of [{ deviceIp: "" }, { hostIp: "" }, { hostIp: "192.168.0.10" }, { deviceIp: "::1" }, { hostIp: "example.com" }]) {
    await assert.rejects(f.service.begin({ ...config, ...patch, confirmLaser: true }), { status: 400 });
  }
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
  await f.service.begin({ ...config, source: undefined, confirmLaser: true });
  const body = JSON.parse(f.requests.find(request => request.route === "start").options.body);
  assert.equal(body.confirmLaser, true);
  assert.equal(body.deviceIp, config.deviceIp);
  assert.equal(body.hostIp, config.hostIp);
  assert.equal(body.simulation, undefined);
  assert.notEqual(body.source, "simulation");
});

test("device startup errors propagate and never retry as simulation", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => route === "start" ? response({ detail: "设备 DLL 不可用" }, 503) : response(idle()) });
  await assert.rejects(f.service.begin({ source: "device", confirmLaser: true, name: "设备任务", object: "", turbine: "", point: "",
    deviceIp: "192.168.0.10", hostIp: "192.168.0.2" }), error => error.status === 503 && /DLL/.test(error.message));
  const starts = f.requests.filter(request => request.route === "start");
  assert.equal(starts.length, 1);
  const body = JSON.parse(starts[0].options.body);
  assert.notEqual(body.source, "simulation");
  assert.equal(body.simulation, undefined);
});

test("recording export streams original CSV into gzip or CSV without buffering via text()", async (t) => {
  const chunks = ["# source=simulation\n", "time_s,velocity_mps\n", "0,0.001\n", "0.001,-0.002\n"];
  const f = fixture(t, { fetch: ({ route }) => {
    if (!route.endsWith("/export")) return response(idle());
    let index = 0;
    return { ok: true, status: 200, body: new ReadableStream({ pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunks[index++]));
    } }), text() { throw Error("export must stream, not buffer through response.text()"); } };
  } });
  for (const suffix of ["csv.gz", "csv"]) {
    const file = path.join(f.directory, `original.${suffix}`);
    assert.deepEqual(await f.service.exportRecording("a".repeat(32), file), { saved: true, fileName: `original.${suffix}` });
    const stored = fs.readFileSync(file);
    assert.equal((suffix.endsWith("gz") ? gunzipSync(stored) : stored).toString("utf8"), chunks.join(""));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(f.directory).some(file => file.endsWith(".tmp")), false);
  const request = f.requests.find(request => request.route.endsWith("/export"));
  assert.equal(request.route, `recordings/${"a".repeat(32)}/export`);
  assert.match(request.options.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
});

test("failed recording export preserves an existing file and leaves no temporary file", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => route.endsWith("/export")
    ? new Response(JSON.stringify({ detail: "原始记录尚未完整保存" }), { status: 409 }) : response(idle()) });
  const file = path.join(f.directory, "original.csv.gz");
  fs.writeFileSync(file, "EXISTING EXPORT");
  await assert.rejects(f.service.exportRecording("a".repeat(32), file), error => error.status === 409 && /完整保存/.test(error.message));
  assert.equal(fs.readFileSync(file, "utf8"), "EXISTING EXPORT");
  assert.equal(fs.readdirSync(f.directory).some(file => file.endsWith(".tmp")), false);
});

test("a truncated export stream cannot replace an existing file or leave its partial data", async (t) => {
  const f = fixture(t, { fetch: ({ route }) => {
    if (!route.endsWith("/export")) return response(idle());
    let sent = false;
    return { ok: true, status: 200, body: new ReadableStream({ pull(controller) {
      if (sent) controller.error(Error("stream interrupted"));
      else { sent = true; controller.enqueue(new TextEncoder().encode("time_s,velocity_mps\n0,0.001\n")); }
    } }) };
  } });
  const file = path.join(f.directory, "original.csv");
  fs.writeFileSync(file, "KEEP COMPLETE FILE");
  await assert.rejects(f.service.exportRecording("a".repeat(32), file), /stream interrupted/);
  assert.equal(fs.readFileSync(file, "utf8"), "KEEP COMPLETE FILE");
  assert.equal(fs.readdirSync(f.directory).some(file => file.endsWith(".tmp")), false);
});

test("recording export rejects invalid ids or relative/non-CSV targets before launching or fetching", async (t) => {
  const f = fixture(t);
  const file = path.join(f.directory, "original.csv.gz");
  for (const id of ["../secret", "", "a".repeat(31), "g".repeat(32), null]) {
    await assert.rejects(f.service.exportRecording(id, file), { status: 400 });
  }
  for (const invalidFile of ["relative.csv", "", path.join(f.directory, "original.json"), path.join(f.directory, "original.csv.gz.tmp"), null]) {
    await assert.rejects(f.service.exportRecording("a".repeat(32), invalidFile), { status: 400 });
  }
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
});

test("HTTP frame fallback remains bounded and a failed stop is not acknowledged as saved", async (t) => {
  const f = fixture(t, { fetch: async request => {
    if (request.route === "frame") return response({ ...acquiring(), waveform: waveform(new Array(4097).fill(1)) });
    if (request.route === "stop") return response({ detail: "磁盘写入失败，记录未完成" }, 500);
    return response(idle());
  } });
  await f.service.start();
  const frame = await f.service.frame();
  assert.equal(frame.state, "error");
  assert.deepEqual(frame.waveform.values, []);
  await assert.rejects(f.service.stop(), error => error.status === 500);
  await assert.rejects(f.service.shutdown());
  assert.equal(f.children[0].signals.length, 0);
});

test("normal shutdown stops saving before process termination and restart rotates token", async (t) => {
  const f = fixture(t);
  await f.service.start();
  const firstSecret = f.children[0].options.env.BLADE_SERVICE_TOKEN;
  await f.service.shutdown();
  assert.equal(f.requests.at(-1).route, "stop");
  assert.equal(f.children[0].exited, true);
  assert.equal(f.service.serviceInfo().state, "stopped");
  await f.service.start();
  assert.equal(f.children.length, 2);
  assert.equal(firstSecret === f.children[1].options.env.BLADE_SERVICE_TOKEN, false);
});

test("a startup response arriving after process exit cannot mark the service ready", async (t) => {
  const received = deferred(), pending = deferred();
  const f = fixture(t, { fetch: async () => { received.resolve(); return pending.promise; } });
  const opening = f.service.start();
  await received.promise;
  f.children[0].finish(1);
  pending.resolve(response(idle()));
  const result = await opening;
  assert.notEqual(result.service.state, "ready");
  assert.notEqual(f.service.serviceInfo().state, "ready");
  assert.equal(f.sockets.length, 0);
});

test("a frame response from before restart cannot replace or display the new session", async (t) => {
  const received = deferred(), pending = deferred();
  const f = fixture(t, { fetch: async request => {
    if (request.route === "frame") { received.resolve(); return pending.promise; }
    return response(idle());
  } });
  await f.service.start();
  const frame = f.service.frame().catch(error => ({ rejected: true, error }));
  await received.promise;
  await f.service.shutdown();
  await f.service.start();
  pending.resolve(response({ ...acquiring(), waveform: waveform([987654]) }));
  const result = await frame;
  assert.equal(result.waveform?.values?.includes(987654) || false, false);
});

test("crashed acquisition cannot silently complete a non-forced shutdown", async (t) => {
  const f = fixture(t, { fetch: async request => response(request.route === "start" ? acquiring() : idle()) });
  await f.service.begin({ confirmLaser: true, deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "任务", object: "叶片", turbine: "机组", point: "测点" });
  f.children[0].finish(1);
  await assert.rejects(f.service.shutdown(), error => error.status >= 400);
  await f.service.shutdown({ force: true });
  assert.equal(f.service.serviceInfo().state, "stopped");
});

test("startup timeout escalates termination before another process can be created", async (t) => {
  const f = fixture(t, {
    options: { startupTimeoutMs: 20 },
    fetch: async (_request, state) => {
      if (state.children.length === 1) throw Error("not listening");
      return response(idle());
    },
    kill: (child, signal) => { if (signal === "SIGKILL") queueMicrotask(() => child.finish()); return true; },
  });
  await f.service.start();
  await f.service.start();
  assert.equal(f.children[0].exited, true);
  assert.equal(f.children[0].signals.includes("SIGKILL"), true);
  assert.equal(f.children.length, 2);
});

test("messages from an old authenticated socket cannot overwrite the new session", async (t) => {
  const f = fixture(t);
  await f.service.start();
  const oldSocket = f.sockets[0];
  await f.service.shutdown();
  await f.service.start();
  oldSocket.emit("message", { data: JSON.stringify({ ...acquiring(), waveform: waveform([654321]) }) });
  const result = await f.service.frame();
  assert.equal(result.waveform?.values?.includes(654321) || false, false);
});

test("unconfirmed termination is an error and cannot create or reuse a supposedly ready service", async (t) => {
  const f = fixture(t, { kill: () => false });
  await f.service.start();
  await assert.rejects(f.service.shutdown({ force: true }));
  assert.equal(f.service.serviceInfo().state, "error");
  assert.notEqual((await f.service.start()).service.state, "ready");
  assert.equal(f.children.length, 1);
  f.children[0].finish(null, "SIGKILL");
  await f.service.shutdown({ force: true });
  assert.equal(f.service.serviceInfo().state, "stopped");
});

test("a close-only spawn failure cannot retain an active child", async (t) => {
  const f = fixture(t, { spawn: child => queueMicrotask(() => {
    child.exitCode = -2;
    child.emit("error", Object.assign(Error("spawn failed"), { code: "ENOENT" }));
    child.exited = true;
    child.emit("close", -2);
  }) });
  assert.notEqual((await f.service.start()).service.state, "ready");
  await f.service.shutdown({ force: true });
  assert.equal(f.service.serviceInfo().state, "stopped");
});

test("a pre-stop frame cannot restore an acquiring display after stop succeeds", async (t) => {
  const received = deferred(), pending = deferred();
  const f = fixture(t, { fetch: async request => {
    if (request.route === "frame") { received.resolve(); return pending.promise; }
    return response(request.route === "start" ? acquiring() : idle());
  } });
  await f.service.begin({ confirmLaser: true, deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "任务", object: "叶片", turbine: "机组", point: "测点" });
  const oldFrame = f.service.frame().catch(error => ({ rejected: true, error }));
  await received.promise;
  assert.equal((await f.service.stop()).state, "idle");
  pending.resolve(response({ ...acquiring(), waveform: waveform([246810]) }));
  const staleResult = await oldFrame;
  assert.notEqual(staleResult.state, "acquiring");
  assert.equal(staleResult.waveform?.values?.includes(246810) || false, false);
});

test("a pre-start idle status cannot overwrite a successful acquisition start", async (t) => {
  const received = deferred(), pending = deferred();
  let statusCount = 0;
  const f = fixture(t, { fetch: async request => {
    if (request.route === "status" && ++statusCount === 2) { received.resolve(); return pending.promise; }
    return response(request.route === "start" ? acquiring() : idle());
  } });
  await f.service.start();
  const oldStatus = f.service.status().catch(error => ({ rejected: true, error }));
  await received.promise;
  assert.equal((await f.service.begin({ confirmLaser: true, deviceIp: "192.168.0.10", hostIp: "192.168.0.2", name: "任务", object: "叶片", turbine: "机组", point: "测点" })).state, "acquiring");
  pending.resolve(response(idle()));
  assert.notEqual((await oldStatus).state, "idle");
});
