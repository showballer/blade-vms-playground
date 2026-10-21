const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGzip } = require('node:zlib');
const { randomBytes } = require('node:crypto');
const { isTurntablePort } = require('./field-turntable-port.cjs');
const { isSdkFile, resolveSdkPath } = require('./field-sdk.cjs');
const { singlePointRequest } = require('./field-single-point.cjs');
const { motionTrialRequest } = require('./field-motion-trial.cjs');

function failure(message, status = 503) {
  return Object.assign(new Error(message), { status });
}
function validPointReference(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  try {
    const axes = JSON.parse(value);
    return Array.isArray(axes) && axes.length === 2 && axes.every(axis => Array.isArray(axis) && axis.length === 4 && axis.every(Number.isSafeInteger));
  } catch { return false; }
}
function turntableConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['port', 'axis', 'speedRpm', 'direction', 'durationSeconds', 'protocol', 'targetAngleDeg'].includes(key)) ||
      !isTurntablePort(value.port) || ![1, 2].includes(value.axis) ||
      typeof value.speedRpm !== 'number' || !Number.isFinite(value.speedRpm) || value.speedRpm < 0.02 || value.speedRpm > 100 ||
      !['forward', 'reverse'].includes(value.direction) || typeof value.durationSeconds !== 'number' ||
      !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > 86400 ||
      (value.protocol !== undefined && !['legacy_speed', 'continuous', 'position'].includes(value.protocol))) throw failure('无效转盘参数：输出轴 0.02～100 rpm，运行时长 0～86400 秒', 400);
  if ((value.targetAngleDeg !== undefined && (typeof value.targetAngleDeg !== 'number' || !Number.isFinite(value.targetAngleDeg) || Math.abs(value.targetAngleDeg) > (value.axis === 1 ? 35 : 180))) ||
      (value.protocol === 'position' && value.targetAngleDeg === undefined)) throw failure('目标角度须在轴1±35°、轴2±180°内', 400);
  return { ...(value.targetAngleDeg !== undefined ? { targetAngleDeg: value.targetAngleDeg } : {}), port: value.port, axis: value.axis, speedRpm: value.speedRpm, direction: value.direction, durationSeconds: value.durationSeconds,
    protocol: value.protocol || 'legacy_speed' };
}
function pointCycleConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !isTurntablePort(value.port) || !Array.isArray(value.points) ||
      value.points.length < 1 || value.points.length > 200 ||
      !Number.isInteger(value.cycles) || value.cycles < 1 || value.cycles > 100 ||
      value.points.length * value.cycles > 2000 || typeof value.dwellSeconds !== 'number' ||
      !Number.isFinite(value.dwellSeconds) || value.dwellSeconds < 1 || value.dwellSeconds > 3600 ||
      typeof value.speedRpm !== 'number' || !Number.isFinite(value.speedRpm) || value.speedRpm < 0.02 || value.speedRpm > 10)
    throw failure('无效多点循环参数：点位、圈数、停留时间或回位速度超出范围', 400);
  if (value.mode !== undefined && !['legacy', 'automatic_stations'].includes(value.mode)) throw failure('无效自动跟随模式', 400);
  const automatic = value.mode === 'automatic_stations';
  const follow = {};
  if (value.followErrorLimitDeg !== undefined) {
    if (typeof value.followErrorLimitDeg !== 'number' || !Number.isFinite(value.followErrorLimitDeg) ||
        value.followErrorLimitDeg < .5 || value.followErrorLimitDeg > 10)
      throw failure('运动中跟随误差上限应为0.5～10°', 400);
    follow.followErrorLimitDeg = value.followErrorLimitDeg;
  }
  if (value.maxMoveAccelerationDegS2 !== undefined) {
    if (typeof value.maxMoveAccelerationDegS2 !== 'number' || !Number.isFinite(value.maxMoveAccelerationDegS2) ||
        value.maxMoveAccelerationDegS2 < 0.1 || value.maxMoveAccelerationDegS2 > 120)
      throw failure('换点加速度上限应为0.1～120 °/s²', 400);
    follow.maxMoveAccelerationDegS2 = value.maxMoveAccelerationDegS2;
  }
  if (value.startAtCurrentPose !== undefined) {
    if (typeof value.startAtCurrentPose !== 'boolean' || value.startAtCurrentPose && !automatic)
      throw failure('首个点位原地等待必须为布尔值，且仅适用于已校准的自动点位采集', 400);
    follow.startAtCurrentPose = value.startAtCurrentPose;
  }
  if (value.routeOrder !== undefined) {
    if (!['configured', 'shortest_safe'].includes(value.routeOrder)) throw failure('无效点位执行顺序', 400);
    if (value.routeOrder === 'configured' && value.rssiTriggerEnabled !== true) throw failure('按配置顺序换点必须确认叶片进入和离开', 400);
    follow.routeOrder = value.routeOrder;
  }
  if (value.collectionId !== undefined) {
    if (!automatic || typeof value.collectionId !== 'string' || value.collectionId.length !== 32 || !/^[a-f0-9]{32}$/.test(value.collectionId))
      throw failure('无效叶片采集任务编号', 400);
    follow.collectionId = value.collectionId;
  }
  if (automatic) {
    const number = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    const geometry = value.geometry;
    const fields = ['distanceM', 'hubHeightDeltaM', 'rotationDirection', 'axis1Sign', 'axis2Sign', 'anchorRadiusM', 'anchorAxis1AngleDeg', 'anchorAxis2AngleDeg'];
    if (value.rssiTriggerEnabled !== true || !(value.nominalPeriodSeconds === 0 || number(value.nominalPeriodSeconds, 0.5, 3600)) ||
        !number(value.maxMoveRpm, 0.02, 10) || value.speedRpm > value.maxMoveRpm || Math.abs(value.speedRpm / 0.02 - Math.round(value.speedRpm / 0.02)) > 1e-7 ||
        !geometry || typeof geometry !== 'object' || Array.isArray(geometry) || Object.keys(geometry).some(key => !fields.includes(key)) ||
        !number(geometry.distanceM, 0.001, 10000) || !number(geometry.hubHeightDeltaM, -10000, 10000) ||
        !number(geometry.anchorRadiusM, 0.001, 1000) || !number(geometry.anchorAxis1AngleDeg, -35, 35) || !number(geometry.anchorAxis2AngleDeg, -180, 180) ||
        !['clockwise', 'counterclockwise'].includes(geometry.rotationDirection) || ![-1, 1].includes(geometry.axis1Sign) || ![-1, 1].includes(geometry.axis2Sign))
      throw failure('自动跟随需要有效安装几何、周期、速度上限及进入离开判定', 400);
    Object.assign(follow, { mode: 'automatic_stations', nominalPeriodSeconds: value.nominalPeriodSeconds,
      maxMoveRpm: value.maxMoveRpm, geometry: Object.fromEntries(fields.map(key => [key, geometry[key]])) });
  }
  const points = value.points.map(point => {
    if (!point || (point.pointId !== undefined && (typeof point.pointId !== 'string' || !point.pointId.trim() || point.pointId.length > 120)) ||
        typeof point.name !== 'string' || !point.name.trim() || point.name.length > 120 ||
        typeof point.axis1AngleDeg !== 'number' || !Number.isFinite(point.axis1AngleDeg) || Math.abs(point.axis1AngleDeg) > 35 ||
        typeof point.axis2AngleDeg !== 'number' || !Number.isFinite(point.axis2AngleDeg) || Math.abs(point.axis2AngleDeg) > 180 ||
        point.port !== value.port || !validPointReference(point.referenceSignature))
      throw failure('无效多点循环点位：需要名称、有效角度、原串口和两轴参考位；历史点位请重新标定', 400);
    const identity = {};
    if (automatic) {
      for (const field of ['bladeId', 'radialPointId', 'radialPointName']) {
        if (typeof point[field] !== 'string' || !point[field].trim() || point[field].length > 80) throw failure('自动跟随需要叶片编号和测点信息', 400);
        identity[field] = point[field].trim();
      }
      if (!point.pointId || typeof point.radiusM !== 'number' || !Number.isFinite(point.radiusM) || point.radiusM < 0.001 || point.radiusM > 1000 ||
          typeof point.azimuthDeg !== 'number' || !Number.isFinite(point.azimuthDeg) || point.azimuthDeg < 0 || point.azimuthDeg >= 360)
        throw failure('自动跟随测点半径和圆周位置无效', 400);
      Object.assign(identity, { radiusM: point.radiusM, azimuthDeg: point.azimuthDeg });
    }
    for (const field of ['rootRadiusM', 'bladeLengthM']) {
      if (point[field] !== undefined) {
        if (typeof point[field] !== 'number' || !Number.isFinite(point[field]) || point[field] < (field === 'rootRadiusM' ? 0 : 0.000001) || point[field] > 1000)
          throw failure('叶根半径和叶片长度必须为有效距离', 400);
        identity[field] = point[field];
      }
    }
    if (point.rootRadiusM !== undefined && point.radiusM !== undefined &&
        (point.radiusM < point.rootRadiusM || point.bladeLengthM !== undefined && point.radiusM > point.rootRadiusM + point.bladeLengthM))
      throw failure('测点必须位于叶根到叶尖范围内', 400);
    return { ...identity, ...(point.pointId !== undefined ? { pointId: point.pointId.trim() } : {}), name: point.name.trim(), axis1AngleDeg: point.axis1AngleDeg, axis2AngleDeg: point.axis2AngleDeg,
      port: point.port, referenceSignature: point.referenceSignature };
  });
  if (value.returnToOrigin !== undefined) {
    const origin = value.returnToOrigin;
    if (!origin || typeof origin !== 'object' || Array.isArray(origin) ||
        Object.keys(origin).some(key => !['name', 'port', 'referenceSignature', 'axis1AngleDeg', 'axis2AngleDeg'].includes(key)) ||
        typeof origin.name !== 'string' || !origin.name.trim() || origin.name.length > 120 || origin.port !== value.port ||
        !validPointReference(origin.referenceSignature) || origin.referenceSignature !== points[0].referenceSignature ||
        typeof origin.axis1AngleDeg !== 'number' || !Number.isFinite(origin.axis1AngleDeg) || Math.abs(origin.axis1AngleDeg) > 35 ||
        typeof origin.axis2AngleDeg !== 'number' || !Number.isFinite(origin.axis2AngleDeg) || Math.abs(origin.axis2AngleDeg) > 180)
      throw failure('作业原点需要有效的两轴坐标、相同串口与参考位', 400);
    follow.returnToOrigin = { name: origin.name.trim(), port: origin.port, referenceSignature: origin.referenceSignature,
      axis1AngleDeg: origin.axis1AngleDeg, axis2AngleDeg: origin.axis2AngleDeg };
  }
  const echo = {};
  if (value.rssiTriggerEnabled !== undefined) {
    if (typeof value.rssiTriggerEnabled !== 'boolean') throw failure('RSSI 开关必须为布尔值', 400);
    echo.rssiTriggerEnabled = value.rssiTriggerEnabled;
  }
  if (value.rssiThresholdMode !== undefined) {
    if (!['adaptive', 'absolute'].includes(value.rssiThresholdMode)) throw failure('无效 RSSI 阈值模式', 400);
    echo.rssiThresholdMode = value.rssiThresholdMode;
  }
  for (const [key, min, max] of [['rssiLeaveThresholdPercent', 0, 100], ['rssiBaselineRatio', 0.5, 0.99],
    ['rssiSmoothingMs', 2, 100], ['rssiConfirmMs', 10, 1000], ['rssiMotionMarginMs', 0, 5000],
    ['rssiMinimumSeconds', 0, value.dwellSeconds], ['rssiEnterSpread', 0, 100],
    ['rssiExitSpread', 0, 100], ['rssiEnterConfirmMs', 10, 1000]]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < min || value[key] > max)
      throw failure(`无效 RSSI 参数 ${key}`, 400);
    echo[key] = value[key];
  }
  if ((echo.rssiEnterSpread ?? 8) <= (echo.rssiExitSpread ?? 3))
    throw failure('离开波动阈值必须小于进入波动阈值', 400);
  if (value.keepLaserOnBetweenPoints !== undefined) {
    if (typeof value.keepLaserOnBetweenPoints !== 'boolean') throw failure('激光持续状态必须为布尔值', 400);
    echo.keepLaserOnBetweenPoints = value.keepLaserOnBetweenPoints;
  }
  if (echo.rssiTriggerEnabled && echo.rssiThresholdMode === 'absolute' && echo.rssiLeaveThresholdPercent === undefined)
    throw failure('绝对阈值模式需要填写 RSSI 离开阈值', 400);
  return { port: value.port, points, cycles: value.cycles, dwellSeconds: value.dwellSeconds, speedRpm: value.speedRpm, ...echo, ...follow };
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

// Non-Windows platforms run the same acquisition service from source through the
// project virtualenv (services/acquisition/.venv). Real device I/O loads a native
// vendor library built for the same OS and architecture as that interpreter.
function posixServiceEnvironment({ dataDir, dll, port, secret, source = process.env }) {
  // Mirror the Windows hardening: never inherit Python/Conda/venv variables that
  // could redirect module resolution away from the project virtualenv.
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || key.includes('\0')) continue;
    if (/^(PYTHON|CONDA)/.test(key) || key === 'VIRTUAL_ENV') continue;
    env[key] = value;
  }
  Object.assign(env, { BLADE_SERVICE_PORT: String(port), BLADE_SERVICE_TOKEN: secret,
    BLADE_DATA_DIR: dataDir, BLADE_POLYTEC_DLL: dll || '', PYTHONUNBUFFERED: '1' });
  return env;
}

// The service credential and address never cross the preload bridge. The renderer
// receives only bounded data; it cannot choose URLs, executable arguments or files.
function createFieldService({ getConfig, dataDir, resourcesDir, platform = process.platform,
  spawnImpl = spawn, fetchImpl = global.fetch, WebSocketImpl = global.WebSocket,
  environment = process.env,
  servicesRoot = path.join(__dirname, '..', '..', '..', 'services', 'acquisition'),
  startupTimeoutMs = 25000, requestTimeoutMs = 12000, terminationTimeoutMs = 5000 }) {
  let child = null, opening = null, state = 'stopped', error = null;
  let port = null, secret = '', socket = null, cachedFrame = null, receivedAt = 0;
  let lastStatus = { state: 'idle', error: null, recording: null }, frameRequest = null;
  let stopping = false, generation = 0, logTail = '';
  let snapshotEpoch = 0;
  const exitedChildren = new WeakSet();

  function pythonLauncher() {
    const override = environment.BLADE_ACQUISITION_PYTHON;
    if (typeof override === 'string' && override.length > 0 && path.isAbsolute(override) && fs.existsSync(override)) {
      return { python: override, root: servicesRoot };
    }
    const candidate = path.join(servicesRoot, '.venv', 'bin', 'python');
    return { python: fs.existsSync(candidate) ? candidate : null, root: servicesRoot };
  }
  function executable() {
    if (platform !== 'win32') {
      const resolved = pythonLauncher();
      return resolved.python || path.join(resolved.root, '.venv', 'bin', 'python');
    }
    return getConfig().executable || path.join(resourcesDir, 'acquisition', 'BladeAcquisition.exe');
  }
  function dllPath() {
    return resolveSdkPath({ configured: getConfig().dll, environment, platform,
      executable: executable(), resourcesDir, servicesRoot });
  }
  function serviceInfo() {
    return { state, error, generation, executable: executable(),
      dllConfigured: isSdkFile(dllPath(), platform), sdkPath: dllPath(),
      launcher: platform === 'win32' ? 'windows-bundle' : 'python-module' };
  }
  function launchSpec() {
    if (platform === 'win32') {
      const file = executable();
      if (!fs.existsSync(file)) {
        return { state: 'missing', error: '未找到 Windows x64 采集服务。请在设置中选择联调好的 BladeAcquisition.exe，或将完整服务目录放入安装资源。' };
      }
      if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.exe') throw failure('请选择本机 Windows 采集服务 EXE');
      return { file, args: [], cwd: path.dirname(file),
        environment: ({ port, secret }) => windowsServiceEnvironment({ file, dataDir, dll: dllPath(), port, secret, source: environment }) };
    }
    const resolved = pythonLauncher();
    if (!resolved.python) {
      return { state: 'missing', error: '未找到本机 Python 采集服务环境。请先在 services/acquisition 创建 .venv 并安装依赖（pip install -r requirements.txt），或通过 BLADE_ACQUISITION_PYTHON 指定解释器。' };
    }
    if (!fs.existsSync(path.join(resolved.root, 'blade_acquisition', '__main__.py'))) {
      return { state: 'missing', error: '未找到采集服务源码 blade_acquisition，请确认 services/acquisition 目录完整。' };
    }
    return { file: resolved.python, args: ['-m', 'blade_acquisition'], cwd: resolved.root,
      environment: ({ port, secret }) => posixServiceEnvironment({ dataDir, dll: dllPath(), port, secret, source: environment }) };
  }
  function envelope(data = lastStatus) {
    // A failed child cannot be presented as healthy acquisition. Keep unknown
    // live-process guards, but distinguish a terminated receiver from hardware.
    if (state === 'error') return { ...data, state: 'error', error: error || '本机采集服务异常，请检查未完成记录',
      ...(!child ? { receiver: { ...data.receiver, running: false } } : {}), service: serviceInfo() };
    return { ...data, service: serviceInfo() };
  }
  function closeSocket() {
    socket?.close(); socket = null; cachedFrame = null; receivedAt = 0;
  }
  async function http(route, method = 'GET', body) {
    if (!port || !secret || !child) throw failure('本机采集服务尚未就绪');
    const requestGeneration = generation, requestChild = child;
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/field/${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(route.endsWith('/analysis') || route === 'rotation' || route.endsWith('/waveform') || route.includes('/waveform?') ? 120000 :
        route === 'device' || route === 'rssi-calibration' ? 90000 : route === 'stop' || route === 'turntable' || route === 'single-point' && body?.action === 'cancel' ? Math.max(75000, requestTimeoutMs) : requestTimeoutMs),
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
      const spec = launchSpec();
      if (spec.error) {
        state = spec.state; error = spec.error;
        return envelope();
      }
      state = 'starting'; error = null; stopping = false; logTail = '';
      const current = ++generation;
      port = await freePort(); secret = randomBytes(32).toString('hex');
      const env = spec.environment({ port, secret });
      try {
        const processChild = spawnImpl(spec.file, spec.args, { cwd: spec.cwd, env,
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
  async function frame(windowMs) {
    if (windowMs !== undefined && ![20, 100, 500, 1000].includes(windowMs)) throw failure('无效显示时间窗', 400);
    if (state !== 'ready') return envelope({ ...lastStatus, waveform: { sampleRate: null, unit: 'm/s', values: [], rssi: [], overrange: [] } });
    if (windowMs !== undefined) {
      const epoch = snapshotEpoch;
      const data = await http(`frame?window_ms=${windowMs}`);
      if (epoch !== snapshotEpoch) return envelope();
      validateWave(data.waveform);
      // A verified response recovers transport health, while data.error remains
      // the previous capture result. Keep those two meanings independent.
      lastStatus = { ...data, waveform: undefined }; error = null;
      return envelope(data);
    }
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
  async function begin(config, { captureSessionId } = {}) {
    if (!config || (config.source !== undefined && !['device', 'simulation'].includes(config.source))) throw failure('无效采集来源', 400);
    const simulated = config.source === 'simulation';
    const body = {};
    if (captureSessionId !== undefined) {
      if (typeof captureSessionId !== 'string' || !/^[a-f0-9]{32}$/.test(captureSessionId)) throw failure('无效采集会话编号', 400);
      body.captureSessionId = captureSessionId;
    }
    if (config.clientRequestedAt !== undefined) {
      if (!Number.isFinite(config.clientRequestedAt) || config.clientRequestedAt < 0) throw failure('无效启动时间', 400);
      body.clientRequestedAt = config.clientRequestedAt;
    }
    if (config.pointCycle !== undefined) {
      if (simulated || config.confirmMotion !== true) throw failure('多点循环任务必须使用真实采集并确认转盘运动', 400);
      body.pointCycle = pointCycleConfig(config.pointCycle);
      body.confirmMotion = true;
    } else if (config.turntable !== undefined) {
      if (simulated || config.confirmMotion !== true) throw failure('联合转盘任务必须使用真实采集并确认转盘运动', 400);
      body.turntable = turntableConfig(config.turntable);
      body.confirmMotion = true;
    }
    if (simulated) {
      if (!config.simulation || !['P1', 'P2', 'P3'].includes(config.simulation.point) ||
          !['baseline', 'imbalance', 'impact', 'low_return'].includes(config.simulation.scenario)) throw failure('请选择有效的模拟测点和场景', 400);
      body.source = 'simulation';
      body.simulation = { point: config.simulation.point, scenario: config.simulation.scenario };
    } else {
      if (config.confirmLaser !== true) throw failure('必须明确确认开启激光、设置设备目标地址和开始采集', 400);
      for (const field of ['deviceIp', 'hostIp']) {
        if (typeof config[field] !== 'string' || net.isIP(config[field]) !== 4) throw failure('设备和本机网卡地址须为有效 IPv4 地址', 400);
      }
      if (config.deviceIp === config.hostIp) throw failure('设备 IP 与本机网卡 IP 不能相同', 400);
      Object.assign(body, { deviceIp: config.deviceIp, hostIp: config.hostIp, confirmLaser: true });
    }
    for (const field of ['name', 'object', 'turbine', 'point']) {
      if (typeof config[field] !== 'string' || (field === 'name' && !config[field].trim()) || config[field].length > 120) throw failure('请填写有效的采集任务信息，任务名不能为空，各字段最多120字', 400);
      body[field] = config[field].trim();
    }
    if (config.windFarm !== undefined) {
      if (typeof config.windFarm !== 'string' || config.windFarm.length > 120 || config.windFarm.includes('\0')) throw failure('风场编号最多120字，不能包含空字符', 400);
      body.windFarm = config.windFarm.trim();
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
    await ready();
    if (id !== undefined) return http(`recordings/${id}`);
    const records = new Map(); let offset = 0;
    // Keep the renderer contract unchanged while each service response stays
    // below the transport limit. Uploads/details still read full manifests.
    for (let page = 0; page < 1001; page += 1) {
      const data = await http(`recordings?summary=true&offset=${offset}`);
      if (!Array.isArray(data.recordings)) throw failure('采集记录列表响应无效');
      for (const recording of data.recordings) {
        if (!recording || typeof recording.id !== 'string') throw failure('采集记录编号无效');
        records.set(recording.id, recording);
      }
      if (data.nextOffset === null || data.nextOffset === undefined) return { recordings: [...records.values()] };
      if (!Number.isSafeInteger(data.nextOffset) || data.nextOffset <= offset || data.nextOffset > 1001 || !data.recordings.length)
        throw failure('采集记录分页无效，请刷新重试');
      offset = data.nextOffset;
    }
    throw failure('采集记录分页未结束，请刷新重试');
  }
  async function simulation() {
    await ready(); return http('simulation');
  }
  async function exportRecording(id, file) {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id) || typeof file !== 'string' || !path.isAbsolute(file) || !/\.(?:csv(?:\.gz)?|jsonl)$/i.test(file)) throw failure('无效原始数据导出请求', 400);
    await ready();
    const current = generation, target = child;
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const route = /\.jsonl$/i.test(file) ? 'turntable-export' : 'export';
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/field/recordings/${id}/${route}`, {
        redirect: 'error', signal: AbortSignal.timeout(300000), headers: { Authorization: `Bearer ${secret}` },
      });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw failure(typeof data.detail === 'string' ? data.detail : '原始记录导出失败', response.status); }
      if (!response.body) throw failure('采集服务未返回原始数据');
      const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      const input = Readable.fromWeb(response.body);
      if (/\.gz$/i.test(file)) await pipeline(input, createGzip(), output);
      else await pipeline(input, output);
      if (current !== generation || target !== child) throw failure('采集服务已变化，请重试导出', 409);
      await fs.promises.rename(temporary, file);
      return { saved: true, fileName: path.basename(file) };
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  }
  async function exportTask(recordingIds, file, level = 'task') {
    if (!['task', 'blade', 'point'].includes(level) || !Array.isArray(recordingIds) || recordingIds.length < 1 || recordingIds.length > 1000 ||
        recordingIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) ||
        new Set(recordingIds).size !== recordingIds.length || typeof file !== 'string' || !path.isAbsolute(file) || !/\.zip$/i.test(file))
      throw failure('无效任务导出请求', 400);
    await ready();
    const current = generation, target = child;
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/field/recordings/export-task`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1800000),
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordingIds, level }),
      });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw failure(typeof data.detail === 'string' ? data.detail : '任务导出失败', response.status); }
      if (!response.body || !response.headers.get('content-type')?.startsWith('application/zip')) throw failure('采集服务未返回任务数据包');
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (current !== generation || target !== child) throw failure('采集服务已变化，请重试导出', 409);
      await fs.promises.rename(temporary, file);
      return { saved: true, fileName: path.basename(file), recordCount: recordingIds.length };
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  }
  function validateWave(wave) {
    if (!wave || !Array.isArray(wave.values) || wave.values.length > 4096 ||
        (wave.envelope !== undefined && (!Array.isArray(wave.envelope) || wave.envelope.length > 1000))) throw failure('采集波形超过安全显示限制');
  }
  async function waveform(id, start, end) {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw failure('无效录制编号', 400);
    for (const value of [start, end]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw failure('无效波形区间', 400);
    if (end !== undefined && end <= (start || 0)) throw failure('结束样本必须大于起始样本', 400);
    await ready();
    const query = new URLSearchParams({ start: String(start || 0) });
    if (end !== undefined) query.set('end', String(end));
    const result = await http(`recordings/${id}/waveform?${query}`);
    validateWave(result.waveform);
    return result;
  }
  async function device(request) {
    if (!request || net.isIP(request.deviceIp) !== 4 || !['read', 'laser_read', 'set', 'autofocus', 'laser_on', 'laser_off'].includes(request.action)) throw failure('无效设备配置请求', 400);
    if (request.action === 'set' && (request.confirmChange !== true || !['velocityRange', 'bandwidth', 'highPass', 'ase'].includes(request.key))) throw failure('请确认修改支持的配置项', 400);
    if (['autofocus', 'laser_on', 'laser_off'].includes(request.action) && request.confirmLaser !== true) throw failure('请确认现场激光安全', 400);
    for (const value of [request.value, request.expected]) if (value !== undefined &&
      !(typeof value === 'string' && value.length <= 120 && !value.includes('\0')) && !(Number.isInteger(value) && [0, 1].includes(value))) throw failure('无效设备配置值', 400);
    await ready();
    if (request.action === 'laser_read') return http('device', 'POST', { deviceIp: request.deviceIp, action: 'laser_read' });
    const current = await http('status');
    if (current.deviceBusy || current.turntableBusy || current.receiver?.running || ['starting', 'acquiring', 'stopping'].includes(current.state)) throw failure('设备正在使用，请先停止并保存', 409);
    return http('device', 'POST', Object.fromEntries(['deviceIp', 'action', 'key', 'value', 'expected', 'confirmChange', 'confirmLaser']
      .filter(key => request[key] !== undefined).map(key => [key, request[key]])));
  }
  async function rssiCalibration(request) {
    if (!request || net.isIP(request.deviceIp) !== 4 || net.isIP(request.hostIp) !== 4 || request.deviceIp === request.hostIp ||
        !['background', 'blade_on', 'blade_pass'].includes(request.state) || request.confirmLaser !== true ||
        typeof request.durationSeconds !== 'number' || !Number.isFinite(request.durationSeconds) || request.durationSeconds < 0.5 || request.durationSeconds > 10)
      throw failure('无效 RSSI 三状态标定请求', 400);
    await ready();
    const current = await http('status');
    if (current.deviceBusy || current.turntableBusy || current.receiver?.running || ['starting', 'acquiring', 'stopping'].includes(current.state)) throw failure('设备正在使用，请先停止采集或转盘动作', 409);
    return http('rssi-calibration', 'POST', { deviceIp: request.deviceIp, hostIp: request.hostIp, state: request.state, durationSeconds: request.durationSeconds, confirmLaser: true });
  }
  async function turntablePorts() { await ready(); return http('turntable/ports'); }
  async function motionTrial(request) {
    const body = motionTrialRequest(request);
    await ready();
    return envelope(await http('motion-trial', 'POST', body));
  }
  async function singlePoint(request, trustedCapture) {
    const body = singlePointRequest(request, trustedCapture);
    await ready();
    if (body.action === 'preview') return envelope(await http('single-point', 'POST', body));
    const epoch = ++snapshotEpoch;
    try {
      const result = await http('single-point', 'POST', body);
      // A delayed prepare/mark response must not revive the UI after cancel.
      lastStatus = epoch === snapshotEpoch ? result : await http('status');
      if (body.action === 'prepare') { closeSocket(); stream(); }
      return envelope();
    } finally { snapshotEpoch += 1; }
  }
  async function turntable(request) {
    if (!request || !['probe', 'health', 'test', 'manual_move', 'recall', 'prepare', 'stop', 'reference', 'limits', 'clear_trajectory_fault', 'clear_guard_fault', 'reset_alarm', 'cancel_trajectory', 'read_motion_profile', 'set_motion_profile'].includes(request.action) || !isTurntablePort(request.port) ||
        (request.action === 'health' && request.confirmRecovery === true) ||
        (['clear_trajectory_fault', 'clear_guard_fault', 'reset_alarm', 'cancel_trajectory'].includes(request.action) && request.confirmRecovery !== true) ||
        (request.action === 'cancel_trajectory' && (!Number.isInteger(request.expectedTrajectorySession) || request.expectedTrajectorySession < 1 || request.expectedTrajectorySession > 65535)) ||
        (request.action === 'clear_trajectory_fault' && request.expectedTrajectorySession !== undefined &&
          (!Number.isInteger(request.expectedTrajectorySession) || request.expectedTrajectorySession < 1 || request.expectedTrajectorySession > 65535)) ||
        ![1, 2].includes(request.axis) || (['stop', 'test', 'manual_move', 'recall', 'prepare', 'reference', 'limits'].includes(request.action) && request.confirmMotion !== true) ||
        (request.confirmRecovery !== undefined && typeof request.confirmRecovery !== 'boolean') ||
        (request.testSeconds !== undefined && (!Number.isInteger(request.testSeconds) || request.testSeconds < 1 || request.testSeconds > 15))) throw failure('无效转盘检查/试转请求', 400);
    const profile = {};
    const validProfile = value => value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 3 && ['accel_ms', 'decel_ms', 's_curve_ms'].every(key =>
        Number.isInteger(value[key]) && value[key] >= (key === 's_curve_ms' ? 0 : 1) && value[key] <= (key === 's_curve_ms' ? 1000 : 10000));
    if (request.action === 'set_motion_profile') {
      if (!validProfile(request.motionProfile) || !validProfile(request.expectedMotionProfile))
        throw failure('请先读取驱动参数；PA40/41须为1～10000整数，PA42须为0～1000整数', 400);
      profile.motionProfile = { ...request.motionProfile };
      profile.expectedMotionProfile = { ...request.expectedMotionProfile };
    } else if (request.motionProfile !== undefined || request.expectedMotionProfile !== undefined) {
      throw failure('只有应用驱动参数操作可以携带修改值', 400);
    }
    if (['read_motion_profile', 'set_motion_profile'].includes(request.action) && (request.confirmMotion || request.confirmRecovery))
      throw failure('驱动参数操作不能同时执行运动或故障恢复', 400);
    const config = ['test', 'manual_move', 'prepare'].includes(request.action) ? turntableConfig({ port: request.port, axis: request.axis,
      speedRpm: request.speedRpm, direction: request.direction, durationSeconds: request.durationSeconds, protocol: request.protocol, targetAngleDeg: request.targetAngleDeg }) : {};
    const recall = request.action === 'recall' ? (() => {
      if (!Number.isFinite(request.axis1AngleDeg) || Math.abs(request.axis1AngleDeg) > 35 ||
          !Number.isFinite(request.axis2AngleDeg) || Math.abs(request.axis2AngleDeg) > 180) throw failure('点位需要两轴有效角度，轴1限±35°，轴2限±180°', 400);
      if (request.recordedPort !== request.port || !validPointReference(request.referenceSignature)) throw failure('点位串口或参考位信息缺失/不匹配，请重新标定后回位', 400);
      const acceleration = {};
      if (request.followErrorLimitDeg !== undefined) {
        if (typeof request.followErrorLimitDeg !== 'number' || !Number.isFinite(request.followErrorLimitDeg) ||
            request.followErrorLimitDeg < .5 || request.followErrorLimitDeg > 10)
          throw failure('回位运动中跟随误差上限应为0.5～10°', 400);
        acceleration.followErrorLimitDeg = request.followErrorLimitDeg;
      }
      if (request.maxMoveAccelerationDegS2 !== undefined) {
        if (typeof request.maxMoveAccelerationDegS2 !== 'number' || !Number.isFinite(request.maxMoveAccelerationDegS2) ||
            request.maxMoveAccelerationDegS2 < .1 || request.maxMoveAccelerationDegS2 > 120)
          throw failure('回位加速度上限应为0.1～120 °/s²', 400);
        acceleration.maxMoveAccelerationDegS2 = request.maxMoveAccelerationDegS2;
      }
      return { axis1AngleDeg: request.axis1AngleDeg, axis2AngleDeg: request.axis2AngleDeg,
        recordedPort: request.recordedPort, referenceSignature: request.referenceSignature, ...acceleration,
        speedRpm: turntableConfig({ port: request.port, axis: 1, speedRpm: request.speedRpm, direction: 'forward', durationSeconds: 0, protocol: 'position', targetAngleDeg: request.axis1AngleDeg }).speedRpm };
    })() : {};
    await ready();
    const current = await http('status');
    if (current.deviceBusy || (current.turntableBusy && request.action !== 'stop') || current.receiver?.running || ['starting', 'acquiring', 'stopping'].includes(current.state)) throw failure('设备正在使用，请先停止并保存', 409);
    snapshotEpoch += 1;
    try {
      lastStatus = await http('turntable', 'POST', { ...config, ...recall, ...profile, action: request.action, port: request.port, axis: request.axis,
        ...(request.testSeconds !== undefined ? { testSeconds: request.testSeconds } : {}),
        ...(['cancel_trajectory', 'clear_trajectory_fault'].includes(request.action) && request.expectedTrajectorySession !== undefined
          ? { expectedTrajectorySession: request.expectedTrajectorySession } : {}),
        confirmMotion: request.confirmMotion === true, confirmRecovery: request.confirmRecovery === true });
      return envelope();
    } finally { snapshotEpoch += 1; }
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
      if (lastStatus.deviceWarning) throw failure(lastStatus.deviceWarning);
      if (lastStatus.turntableWarning) throw failure(lastStatus.turntableWarning);
      if (lastStatus.recording && lastStatus.recording.status !== 'complete') throw failure('本次采集没有完整保存，请检查错误或明确保留未完成数据后退出');
    }
    await terminateChild(child);
    state = 'stopped'; port = null; secret = '';
  }
  async function analysis(id, parameters) {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id) || !parameters || typeof parameters !== 'object' ||
        Array.isArray(parameters) || JSON.stringify(parameters).length > 10000) throw failure('无效分析请求', 400);
    await ready();
    return http(`recordings/${id}/analysis`, 'POST', parameters);
  }
  async function rotation(parameters) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) ||
        JSON.stringify(parameters).length > 20000 || !Array.isArray(parameters.recordingIds) ||
        parameters.recordingIds.length < 1 || parameters.recordingIds.length > 8 ||
        parameters.recordingIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)))
      throw failure('无效恒转速旋转分析请求', 400);
    await ready();
    return http('rotation', 'POST', parameters);
  }
  return { start, status, frame, begin, stop, recordings, simulation, exportRecording, exportTask, waveform, analysis, rotation, device, rssiCalibration, turntable, turntablePorts, singlePoint, motionTrial, shutdown, serviceInfo };
}
module.exports = { createFieldService, windowsServiceEnvironment, posixServiceEnvironment, failure };
