"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createFieldService, windowsServiceEnvironment } = require("../apps/desktop/electron/field-service.cjs");

const idle = () => ({ state: "idle", error: null, receiver: { connected: false }, recording: null });
const acquiring = () => ({ state: "acquiring", error: null, receiver: { connected: true }, recording: { id: "recording-1", state: "acquiring" } });
const waveform = values => ({ sampleRate: 1000, unit: "m/s", values, rssi: [], overrange: [] });
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

test("missing executable and non-Windows platform never start a process", async (t) => {
  const f = fixture(t, { options: { platform: "darwin" } });
  assert.equal((await f.service.start()).service.state, "error");
  assert.equal(f.children.length, 0);
  fs.unlinkSync(path.join(f.directory, "BladeAcquisition.exe"));
  assert.equal((await f.service.start()).service.state, "missing");
  assert.equal(f.children.length, 0);
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
