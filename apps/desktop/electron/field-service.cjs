const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

function failure(message, status = 503) {
  return Object.assign(new Error(message), { status });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function windowsServiceEnvironment({ file, dataDir, dll, port, secret, source = process.env }) {
  // Windows environment names are case-insensitive. Emit each allowed variable
  // once; passing both PATH and Path lets Node choose an unintended value.
  const inherited = new Map();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !inherited.has(key.toUpperCase())) inherited.set(key.toUpperCase(), value);
  }
  const env = {};
  for (const key of ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'LANG']) {
    const value = inherited.get(key);
    if (value !== undefined) env[key] = value;
  }
  const localDirectory = value => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !/[;\0]/.test(value);
  const systemRoot = [inherited.get('SYSTEMROOT'), inherited.get('WINDIR')].find(localDirectory) || 'C:\\Windows';
  env.SystemRoot = path.win32.normalize(systemRoot);
  env.WINDIR = env.SystemRoot;
  env.SystemDrive = path.win32.parse(env.SystemRoot).root.slice(0, 2);
  const serviceDirectory = path.win32.dirname(file);
  // Never reuse the caller's PATH, Python/Conda/venv variables, or PyInstaller
  // parent-process flags. All dependencies belong to this onedir distribution.
  // An explicitly selected external SDK is loaded by absolute path and its own
  // add_dll_directory scope in Python, not added to the global search path.
  env.PATH = [...new Set([
    serviceDirectory,
    path.win32.join(serviceDirectory, '_internal'),
    path.win32.join(serviceDirectory, 'vendor'),
    path.win32.join(env.SystemRoot, 'System32'),
    env.SystemRoot,
    path.win32.join(env.SystemRoot, 'System32', 'Wbem'),
  ])].join(';');
  Object.assign(env, { BLADE_SERVICE_PORT: String(port), BLADE_SERVICE_TOKEN: secret,
    BLADE_DATA_DIR: dataDir, BLADE_POLYTEC_DLL: dll, PYTHONUNBUFFERED: '1' });
  return env;
}

// The service credential and address never cross the preload bridge. The renderer
// receives only bounded data; it cannot choose URLs, executable arguments or files.
function createFieldService({ getConfig, dataDir, resourcesDir, platform = process.platform,
  spawnImpl = spawn, fetchImpl = global.fetch, WebSocketImpl = global.WebSocket,
  environment = process.env,
  startupTimeoutMs = 25000, requestTimeoutMs = 12000, terminationTimeoutMs = 5000 }) {
  let child = null, opening = null, state = 'stopped', error = null;
  let port = null, secret = '', socket = null, cachedFrame = null, receivedAt = 0;
  let lastStatus = { state: 'idle', error: null, recording: null }, frameRequest = null;
  let stopping = false, generation = 0, logTail = '';
  let snapshotEpoch = 0;
  const exitedChildren = new WeakSet();

  function executable() {
    return getConfig().executable || path.join(resourcesDir, 'acquisition', 'BladeAcquisition.exe');
  }
  function dllPath() {
    return getConfig().dll || path.join(path.dirname(executable()), 'vendor', 'DeviceCommunication.dll');
  }
  function serviceInfo() {
    return { state, error, executable: executable(),
      dllConfigured: fs.existsSync(dllPath()) };
  }
  function envelope(data = lastStatus) {
    return { ...data, service: serviceInfo() };
  }
  function closeSocket() {
    socket?.close(); socket = null; cachedFrame = null; receivedAt = 0;
  }
  async function http(route, method = 'GET', body) {
    if (!port || !secret || !child) throw failure('本机采集服务尚未就绪');
    const requestGeneration = generation, requestChild = child;
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/field/${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(route === 'stop' ? Math.max(30000, requestTimeoutMs) : requestTimeoutMs),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const content = await response.text();
    if (requestGeneration !== generation || requestChild !== child) throw failure('采集服务已变化，请刷新状态后重试', 409);
    if (content.length > 2_000_000) throw failure('采集服务响应超过安全大小限制');
    let data;
    try { data = JSON.parse(content); } catch { throw failure('采集服务返回了无效响应'); }
    if (!response.ok) throw failure(typeof data.detail === 'string' ? data.detail : data.error || '采集操作失败', response.status);
    return data;
  }
  async function terminateChild(target) {
    if (!target) return;
    // Invalidate in-flight HTTP/WS responses before stopping a process. Wait for
    // this exact child to exit before another process may take its place.
    generation += 1; closeSocket(); stopping = true;
    const previousState = state;
    state = 'stopping';
    try { await new Promise((resolve, reject) => {
      let finished = false;
      let timeout, finalTimeout;
      const done = () => {
        if (finished) return;
        finished = true; clearTimeout(timeout); clearTimeout(finalTimeout);
        target.removeListener('exit', done); target.removeListener('close', done);
        resolve();
      };
      target.once('exit', done); target.once('close', done);
      timeout = setTimeout(() => {
        finalTimeout = setTimeout(() => {
          if (finished) return;
          finished = true;
          target.removeListener('exit', done); target.removeListener('close', done);
          reject(failure('采集服务进程未退出，请在 Windows 检查进程后重试；不会启动第二个采集进程'));
        }, terminationTimeoutMs);
        try { target.kill('SIGKILL'); } catch { /* Wait for a confirmed exit. */ }
      }, terminationTimeoutMs);
      if (exitedChildren.has(target) || target.signalCode || (target.exitCode !== null && target.exitCode !== undefined)) return done();
      try { target.kill(); } catch { /* Wait for exit or the bounded failure. */ }
    }); } catch (cause) {
      state = 'error'; error = cause.message; throw cause;
    }
    if (child === target) child = null;
    port = null; secret = '';
    state = previousState === 'error' ? 'error' : 'stopped';
  }
  function stream() {
    if (!WebSocketImpl || !port || !secret) return;
    const current = generation;
    try {
      const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws/field`, ['blade', secret]);
      socket = ws;
      ws.addEventListener('message', event => {
        if (generation !== current || socket !== ws || typeof event.data !== 'string' || event.data.length > 2_000_000) return;
        try {
          const data = JSON.parse(event.data);
          if (!data || !Array.isArray(data.waveform?.values) || data.waveform.values.length > 4096) return;
          cachedFrame = data; lastStatus = { ...data, waveform: undefined }; receivedAt = Date.now();
        } catch { /* Malformed frames cannot replace a valid acquisition snapshot. */ }
      });
      ws.addEventListener('error', () => {}); // HTTP provides an authenticated fallback.
      ws.addEventListener('close', () => { if (socket === ws) socket = null; });
    } catch { /* Old runtimes can still display bounded HTTP frames. */ }
  }
  async function start() {
    if (opening) return opening;
    if (state === 'ready' && child) return envelope();
    if (child) { state = 'error'; error = '旧采集进程尚未退出，请先重启服务或检查进程'; return envelope(); }
    opening = (async () => {
      const file = executable();
      if (!fs.existsSync(file)) {
        state = 'missing'; error = '未找到 Windows x64 采集服务。请在设置中选择联调好的 BladeAcquisition.exe，或将完整服务目录放入安装资源。';
        return envelope();
      }
      if (platform !== 'win32') {
        state = 'error'; error = '设备采集服务只在 Windows x64 实机启动；当前系统可查看客户端界面。';
        return envelope();
      }
      if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.exe') throw failure('请选择本机 Windows 采集服务 EXE');
      state = 'starting'; error = null; stopping = false; logTail = '';
      const current = ++generation;
      port = await freePort(); secret = randomBytes(32).toString('hex');
      const env = windowsServiceEnvironment({ file, dataDir, dll: dllPath(), port, secret, source: environment });
      try {
        const processChild = spawnImpl(file, [], { cwd: path.dirname(file), env,
          shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child = processChild;
        const capture = bytes => {
          // Never forward service logs or its token to the renderer.
          logTail = (logTail + String(bytes).replaceAll(secret, '[redacted]')).slice(-4000);
        };
        processChild.stdout?.on('data', capture); processChild.stderr?.on('data', capture);
        processChild.once('error', () => {
          if (current !== generation) return;
          error = '采集服务进程启动失败，请核对 Windows x64 服务包及依赖。'; state = 'error';
        });
        const exited = code => {
          exitedChildren.add(processChild);
          if (child === processChild) { child = null; closeSocket(); }
          if (current !== generation) return;
          if (stopping) { state = 'stopped'; return; }
          state = 'error'; error = `采集服务已退出（${code ?? '异常终止'}）。未完成的采集请在重启服务后检查。`;
        };
        processChild.once('exit', exited); processChild.once('close', exited);
        const deadline = Date.now() + startupTimeoutMs;
        while (Date.now() < deadline && child && state === 'starting') {
          try {
            const data = await http('status');
            if (!data || typeof data.state !== 'string' || !data.receiver) throw failure('采集服务协议不匹配');
            if (current !== generation || child !== processChild || state !== 'starting') throw failure('采集服务在就绪前已退出');
            lastStatus = data; state = 'ready'; error = null; stream(); return envelope();
          } catch { await pause(150); }
        }
        if (state === 'starting') { state = 'error'; error = '采集服务启动超时。请核对服务包版本和依赖后重试。'; }
        // A timed-out process must not retain a port or become a hidden orphan.
        if (child) await terminateChild(child);
        return envelope();
      } catch (cause) {
        state = 'error'; error = '无法启动本机采集服务，请检查可执行文件和目录权限。';
        if (child) await terminateChild(child);
        return envelope();
      }
    })().finally(() => { opening = null; });
    return opening;
  }
  async function ready() {
    if (state !== 'ready') await start();
    if (state !== 'ready' || !child) throw failure(error || '本机采集服务不可用');
  }
  async function status() {
    if (state === 'starting' || opening) return envelope();
    if (state !== 'ready') return envelope();
    const current = generation, epoch = snapshotEpoch;
    try {
      const data = await http('status');
      if (epoch !== snapshotEpoch) return envelope();
      lastStatus = data; error = null; return envelope();
    }
    catch (cause) {
      if (current !== generation || epoch !== snapshotEpoch) return envelope();
      error = cause.message; return envelope({ state: 'error', error: cause.message, recording: lastStatus.recording });
    }
  }
  async function frame() {
    if (state !== 'ready') return envelope({ ...lastStatus, waveform: { sampleRate: null, unit: 'm/s', values: [], rssi: [], overrange: [] } });
    if (cachedFrame && Date.now() - receivedAt < 1500) return envelope(cachedFrame);
    if (frameRequest) return frameRequest;
    const current = generation, epoch = snapshotEpoch;
    frameRequest = (async () => {
      try {
        const data = await http('frame');
        if (epoch !== snapshotEpoch) return envelope();
        if (!Array.isArray(data.waveform?.values) || data.waveform.values.length > 4096) throw failure('采集波形格式无效');
        lastStatus = { ...data, waveform: undefined }; error = null;
        if (!socket) stream();
        return envelope(data);
      } catch (cause) {
        if (current !== generation || epoch !== snapshotEpoch) return envelope();
        error = cause.message;
        return envelope({ state: 'error', error: cause.message, recording: lastStatus.recording,
          waveform: { sampleRate: null, unit: 'm/s', values: [], rssi: [], overrange: [] } });
      }
    })().finally(() => { frameRequest = null; });
    return frameRequest;
  }
  async function begin(config) {
    if (!config || config.confirmLaser !== true) throw failure('必须明确确认开启激光、设置设备目标地址和开始采集', 400);
    for (const field of ['deviceIp', 'hostIp']) {
      if (typeof config[field] !== 'string' || net.isIP(config[field]) !== 4) throw failure('设备和本机网卡地址须为有效 IPv4 地址', 400);
    }
    if (config.deviceIp === config.hostIp) throw failure('设备 IP 与本机网卡 IP 不能相同', 400);
    const body = { deviceIp: config.deviceIp, hostIp: config.hostIp, confirmLaser: true };
    for (const field of ['name', 'object', 'turbine', 'point']) {
      if (typeof config[field] !== 'string' || (field === 'name' && !config[field].trim()) || config[field].length > 120) throw failure('请填写有效的采集任务信息，任务名不能为空，各字段最多120字', 400);
      body[field] = config[field].trim();
    }
    await ready(); closeSocket();
    snapshotEpoch += 1;
    try { lastStatus = await http('start', 'POST', body); stream(); return envelope(); }
    finally { snapshotEpoch += 1; }
  }
  async function stop() {
    if (!child || state !== 'ready') throw failure('采集服务不可用，不能确认数据已完整保存；请重启后检查未完成记录');
    closeSocket(); snapshotEpoch += 1;
    try { lastStatus = await http('stop', 'POST'); stream(); return envelope(); }
    finally { snapshotEpoch += 1; }
  }
  async function recordings(id) {
    if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) throw failure('无效录制编号', 400);
    await ready(); return http(id === undefined ? 'recordings' : `recordings/${id}`);
  }
  async function shutdown({ force = false } = {}) {
    if (opening) await opening;
    if (!child) {
      const unfinished = ['starting', 'acquiring', 'stopping'].includes(lastStatus.state) ||
        lastStatus.recording?.status === 'incomplete';
      if (!force && unfinished) throw failure('采集服务已异常退出，无法确认本次数据完整保存，请检查未完成记录');
      closeSocket(); state = 'stopped'; return;
    }
    if (!force) {
      await stop();
      if (lastStatus.recording && lastStatus.recording.status !== 'complete') throw failure('本次采集没有完整保存，请检查错误或明确保留未完成数据后退出');
    }
    await terminateChild(child);
    state = 'stopped'; port = null; secret = '';
  }
  return { start, status, frame, begin, stop, recordings, shutdown, serviceInfo };
}
module.exports = { createFieldService, windowsServiceEnvironment, failure };
