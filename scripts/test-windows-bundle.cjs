// Hardware-free Windows x64 release gate. Only the isolated simulation gate calls
// /start with source=simulation, and disables the SDK. No real device is accessed.
// Node 22+: node scripts/test-windows-bundle.cjs --resources <win-unpacked/resources>
//          --installer <BladeVMS-Setup-VERSION-x64.exe> [--output <report-directory>]
// The installer test changes only a disposable CI user's BladeVMS installation. Do not run
// against a real user's existing installation. Outside CI, opt in with BLADE_ALLOW_INSTALL_SMOKE=1.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, scryptSync, createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  hardwareTested: false, physicalAcquisitionStarted: false, cleanWindowsTested: false,
  environmentCoverage: ['system Python unavailable through child PATH', 'existing runner Python preserved',
    'poisoned PYTHONHOME/PYTHONPATH and simulated activated Conda/venv'],
  limitations: ['CI has no IVS-500 hardware: sample correctness, network, packet loss and laser safety require a physical test.',
    'An actual clean Windows OS, installed Conda distribution and 32-bit Python are not provisioned by this script.'], checks: [] };
const liveChildren = new Set();

// Receiver + device-panel binding contract. Additional SDK bindings are allowed,
// but every operation used by the shipped capture/configuration adapters is required.
const REQUIRED_SDK_SYMBOLS = Object.freeze([
  'PolyOpenUdpEthernetCommunication', 'PolyCloseCommunication', 'PolyLastCommunicationStatus',
  'PolySendGetString', 'PolySendGetFloat', 'PolySendSetString', 'PolyItemListGetCurrentItem',
  'PolySendSetInt16', 'PolyOpenDataAcquisition', 'PolyCloseDataAcquisition',
  'PolyStartDataAcquisition', 'PolyStopDataAcquisition', 'PolyReadData',
  'PolyExtractedSampleCount', 'PolyGetInt32Data', 'PolyGetOverrange',
  'PolyBaseSampleRateInHz', 'PolyChannelMaxValue', 'PolyHasCommand',
  'PolySendGetInt16', 'PolySendGetInt32', 'PolyItemListGetAvailableItems',
  'PolyItemListSetCurrentItem', 'PolyChannelActivationIsChannelAvailable',
  'PolyChannelActivationIsChannelEnabled', 'PolyChannelActivationEnableChannel',
  'PolySendGetWithTag', 'PolyGetInt16FromPayload', 'PolyFreePayload', 'PolySendGetDevInfoRange',
]);

function assertSdkBindings(diagnostic) {
  assert.ok(Array.isArray(diagnostic.sdkSymbolNames), 'Frozen self-check must list its SDK bindings');
  assert.ok(diagnostic.sdkSymbolNames.every(name => typeof name === 'string' && name.startsWith('Poly')),
    'Frozen self-check contains invalid SDK binding names');
  assert.equal(diagnostic.sdkSymbols, diagnostic.sdkSymbolNames.length, 'SDK binding count must match named bindings');
  const names = new Set(diagnostic.sdkSymbolNames);
  assert.equal(names.size, diagnostic.sdkSymbolNames.length, 'SDK binding names must be unique');
  for (const symbol of REQUIRED_SDK_SYMBOLS) {
    assert.ok(names.has(symbol), `Missing required capture/configuration SDK binding: ${symbol}`);
  }
}

function assertIdleWaveformUi(value) {
  assert.equal(value.emptyCount, 2, 'Both velocity and RSSI plots must show their empty state');
  assert.equal(value.waveformCount, 0, 'Idle plots must not draw invented waveforms');
  assert.equal(value.velocityTitle, '振动速度');
  assert.equal(value.rssiTitle, 'RSSI 回波强度');
}

async function idleWaveformUi(cdp) {
  return cdp.evaluate(`(() => {
    const panel = document.querySelector('.field-capture-chart');
    return { emptyCount: panel?.querySelectorAll('.field-chart-empty').length ?? 0,
      waveformCount: panel?.querySelectorAll('.field-wave-svg').length ?? 0,
      velocityTitle: panel?.querySelector('.field-capture-wave-heading h2')?.textContent.trim(),
      rssiTitle: panel?.querySelector('.field-rssi-heading h3')?.textContent.trim() };
  })()`);
}

async function captureFormState(cdp) {
  return cdp.evaluate(`(() => {
    const form = document.querySelector('.field-capture-setup form');
    const inputs = [...form.querySelectorAll('input[required]')];
    const button = document.querySelector('.field-plain-capture-toolbar .field-auto-capture-primary');
    if (!button || button.type !== 'button') throw Error('Missing current acquisition action');
    return { valid: form.checkValidity(), missingRequired: inputs.filter(input => input.validity.valueMissing).length,
      requiredValues: inputs.map(input => input.value), startDisabled: button.disabled };
  })()`);
}

async function deadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function optionsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    assert.ok(['--resources', '--installer', '--output'].includes(key), `Unknown option: ${key}`);
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing value: ${key}`);
    options[key.slice(2)] = path.resolve(argv[index + 1]);
  }
  assert.ok(options.resources, '--resources is required');
  options.output ||= path.join(root, 'artifacts', 'windows-bundle-smoke');
  return options;
}

function execute(file, args = [], options = {}) {
  const { timeoutMs = 45000, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    liveChildren.add(child);
    let stdout = '', stderr = '', expired = false;
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-4_000_000); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-20000); });
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); liveChildren.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); liveChildren.delete(child);
      if (expired) reject(Error(`Timed out: ${path.basename(file)}`));
      else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function powershell(source) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); ${source}`, 'utf16le').toString('base64');
  const result = await execute(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  assert.equal(result.code, 0, `PowerShell check failed: ${result.stderr}`);
  return result.stdout;
}

async function check(name, callback) {
  const started = Date.now();
  try {
    const details = await callback();
    report.checks.push({ name, passed: true, durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, durationMs: Date.now() - started, error: error.message });
    throw error;
  }
}

async function waitFor(callback, description, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try { const result = await callback(); if (result) return result; } catch (error) { lastError = error; }
    await pause(150);
  }
  throw Error(`Timed out: ${description}${lastError ? ` (${lastError.message})` : ''}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function isolatedEnvironment(extra = {}) {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  return { ...environment, ...extra };
}

function watchChild(file, args, options) {
  const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  liveChildren.add(child);
  let tail = '';
  const capture = bytes => { tail = (tail + bytes).slice(-12000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.once('error', error => { tail += error.message; });
  const closed = new Promise(resolve => child.once('close', code => { liveChildren.delete(child); resolve(code); }));
  return { child, closed, tail: () => tail };
}

async function stopChild(processInfo) {
  if (processInfo.child.exitCode === null && processInfo.child.signalCode === null) processInfo.child.kill();
  await deadline(processInfo.closed, 10000, 'Owned test process did not exit');
}

function assertIdle(status) {
  assert.equal(status.state, 'idle');
  assert.equal(status.receiver.running, false);
  assert.equal(status.receiver.dllAvailable, true);
  assert.equal(status.receiver.deviceIp, '');
  assert.equal(status.receiver.hostIp, '');
  assert.equal(status.recording, null);
}

async function socketFrame(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ['blade', token]);
    const timer = setTimeout(() => { socket.close(); reject(Error('Authenticated WebSocket produced no frame')); }, 10000);
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Authenticated WebSocket connection failed')); }, { once: true });
    socket.addEventListener('message', event => {
      clearTimeout(timer);
      try { assert.equal(socket.protocol, 'blade'); resolve(JSON.parse(event.data)); }
      catch (error) { reject(error); }
      finally { socket.close(); }
    }, { once: true });
  });
}

async function validateService(resources, environment, caseDirectory) {
  const serviceDirectory = path.join(resources, 'acquisition');
  const executable = path.join(serviceDirectory, 'BladeAcquisition.exe');
  const dll = path.join(serviceDirectory, 'vendor', 'DeviceCommunication.dll');
  const dataDirectory = path.join(caseDirectory, '采集数据 with spaces');
  fs.mkdirSync(dataDirectory, { recursive: true });
  assert.ok(fs.statSync(executable).isFile());
  assert.ok(fs.statSync(dll).isFile());

  const selfCheck = await execute(executable, ['--self-check'], {
    cwd: serviceDirectory, env: { ...environment, BLADE_POLYTEC_DLL: dll },
  });
  assert.equal(selfCheck.code, 0, `Frozen self-check failed: ${selfCheck.stdout} ${selfCheck.stderr}`);
  const diagnostic = JSON.parse(selfCheck.stdout);
  assert.equal(diagnostic.frozen, true, 'Must use bundled Python, not system Python');
  assert.equal(path.resolve(diagnostic.executable).toLowerCase(), executable.toLowerCase());
  assert.equal(diagnostic.dllLoaded, true);
  assertSdkBindings(diagnostic);
  assert.equal(diagnostic.hardwareTouched, false);
  assert.match(diagnostic.pythonVersion, /^3\./);

  const port = await freePort();
  const token = randomBytes(32).toString('hex');
  const base = `http://127.0.0.1:${port}`;
  const child = watchChild(executable, [], { cwd: serviceDirectory, env: { ...environment,
    BLADE_SERVICE_PORT: String(port), BLADE_SERVICE_TOKEN: token, BLADE_DATA_DIR: dataDirectory, BLADE_POLYTEC_DLL: dll } });
  const request = (route, options = {}) => fetch(`${base}/api/field/${route}`, {
    signal: AbortSignal.timeout(3000), ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  try {
    await waitFor(async () => {
      if (child.child.exitCode !== null) throw Error(`Service exited early (${child.child.exitCode})`);
      const response = await request('status');
      return response.ok && response.json();
    }, 'frozen service HTTP readiness');
    assertIdle(await (await request('status')).json());
    assert.equal((await fetch(`${base}/api/field/status`, { signal: AbortSignal.timeout(3000) })).status, 401);
    assert.equal((await request('status', { headers: { Authorization: 'Bearer invalid-test-token' } })).status, 401);
    assert.equal((await request('status', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const response = await request('frame');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const frame = await response.json();
    assertIdle(frame); assert.deepEqual(frame.waveform.values, []);
    assert.deepEqual((await (await request('recordings')).json()).recordings, []);
    const streamed = await socketFrame(`ws://127.0.0.1:${port}/ws/field`, token);
    assertIdle(streamed); assert.deepEqual(streamed.waveform.values, []);
    // Stop is safe in idle and cannot open a device. NEVER send /start, even with a dummy address.
    const stopped = await request('stop', { method: 'POST' });
    assert.equal(stopped.status, 200); assertIdle(await stopped.json());
  } finally { await stopChild(child); }
  await assert.rejects(fetch(`${base}/api/field/status`, { signal: AbortSignal.timeout(1500) }));
  return { pythonVersion: diagnostic.pythonVersion, frozen: true, sdkSymbols: diagnostic.sdkSymbols,
    dllLoaded: true, authenticatedHttp: true, authenticatedWebSocket: true, hardwareTouched: false, noOrphan: true };
}

async function environmentSnapshot() {
  const environment = JSON.parse(await powershell(`$result=@{}; foreach($scope in @('User','Machine')) {
    foreach($name in @('Path','PYTHONHOME','PYTHONPATH','VIRTUAL_ENV','CONDA_PREFIX')) {
      $result["$scope/$name"]=[Environment]::GetEnvironmentVariable($name,$scope)
    }
  }; ConvertTo-Json -InputObject $result -Compress`));
  const registry = {};
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  for (const key of ['HKCU\\Software\\Python', 'HKLM\\Software\\Python',
    'HKCU\\Software\\Classes\\.py', 'HKCU\\Software\\Classes\\.pyw',
    'HKCU\\Software\\Classes\\Python.File', 'HKLM\\Software\\Classes\\.py',
    'HKLM\\Software\\Classes\\.pyw', 'HKLM\\Software\\Classes\\Python.File']) {
    for (const architecture of ['32', '64']) {
      const query = await execute(reg, ['query', key, '/s', `/reg:${architecture}`]);
      assert.ok([0, 1].includes(query.code), 'Could not inspect Python registry state');
      registry[`${architecture}/${key}`] = digest(query.code === 0 ? query.stdout : 'absent');
    }
  }
  let externalPython = null;
  // setup-python on CI publishes the absolute interpreter location. Never follow Store aliases.
  const candidate = process.env.BLADE_EXTERNAL_PYTHON || (process.env.pythonLocation && path.join(process.env.pythonLocation, 'python.exe'));
  if (candidate) {
    assert.ok(path.isAbsolute(candidate) && fs.statSync(candidate).isFile());
    const result = await execute(candidate, ['-I', '-c', 'import sys,json,importlib.metadata as m;print(json.dumps({"executable":sys.executable,"version":sys.version,"packages":sorted((d.metadata["Name"] or "",d.version) for d in m.distributions())},sort_keys=True))']);
    assert.equal(result.code, 0, 'Existing external Python is not healthy');
    const parsed = JSON.parse(result.stdout);
    externalPython = { executable: parsed.executable, version: parsed.version, packagesSha256: digest(JSON.stringify(parsed.packages)) };
  }
  return { environment, registry, externalPython };
}

async function executableProcesses(executable) {
  return JSON.parse(await powershell(`ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -ieq ${psQuote(executable)} } |
    Select-Object ProcessId,ParentProcessId) -Compress`));
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('CDP connection timed out')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP connection failed')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id); clearTimeout(waiting.timer);
    if (message.error) waiting.reject(Error(message.error.message));
    else waiting.resolve(message.result);
  });
  socket.addEventListener('error', () => {});
  socket.addEventListener('close', () => {
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(Error('CDP closed')); }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => socket.close(), evaluate: async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 12000 });
    assert.ok(!result.exceptionDetails, 'Renderer expression failed');
    return result.result.value;
  } };
}

async function validateInstalledAutoFollow(cdp, field, output, { expectedRecordingIds = [] } = {}) {
  // Exercise the installed renderer, not a source fixture. Only navigate and edit
  // its disposable draft: never probe, calibrate, start, or send device commands.
  const click = async (selector, text) => {
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find(item => item.textContent.trim() === ${JSON.stringify(text)} && !item.closest('[hidden]'));
      if (!button || button.disabled) throw Error('Unavailable UI control');
      button.click();
    })()`);
  };
  const snapshot = () => cdp.evaluate(`(() => {
    const panel = document.querySelector('.field-auto-follow.field-turntable-configuration')?.closest('dialog') || document.querySelector('.field-auto-follow');
    if (!panel) return null;
    const rows = [...document.querySelectorAll('.field-follow-configuration:not([hidden]) .field-auto-point')];
    return { text: document.querySelector('.field-auto-follow').innerText, pointCount: rows.length,
      selected: rows.map((row, index) => row.querySelector('input[type=radio]').checked ? index : -1).filter(index => index >= 0),
      names: rows.map(row => row.querySelector('input[aria-label$="名称"]').value),
      radii: rows.map(row => row.querySelector('input[aria-label$="半径"]').value),
      firstAngles: rows.map(row => row.querySelector('.field-auto-point-angle')?.textContent.trim()),
      calibratedCount: rows.filter(row => row.querySelector('.field-badge.green')).length,
      installationOpen: !!document.querySelector('dialog .field-auto-turntable-setup'),
      installationLabels: [...document.querySelectorAll('dialog .field-auto-turntable-setup [aria-label]')].map(item => item.getAttribute('aria-label')),
      selectedMode: document.querySelector('.field-turntable-mode-tabs [aria-selected=true]')?.textContent.trim(),
      simulationControls: [...document.querySelectorAll('.field-auto-follow button,.field-auto-follow input,.field-auto-follow [role=switch]')]
        .filter(item => /模拟|演示/.test(item.textContent + ' ' + item.getAttribute('aria-label'))).length };
  })()`);
  const setInput = async (label, value) => {
    const selector = `input[aria-label=${JSON.stringify(label)}]`;
    await cdp.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input || input.disabled) throw Error('Unavailable installed input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`), 'installed input: ' + label);
  };
  const savedSurvey = () => cdp.evaluate('JSON.parse(localStorage.getItem("blade-auto-follow-draft-v1"))');
  await click('.field-sidebar button', '转盘点位');
  await waitFor(() => cdp.evaluate(`Array.from(document.querySelectorAll('[role=tab]')).some(item => item.textContent.trim() === '自动跟随' && !item.closest('[hidden]'))`),
    'installed turntable work-mode tabs');
  assert.deepEqual(await cdp.evaluate(`[...document.querySelectorAll('.field-turntable-mode-tabs [role=tab]')].map(item=>item.textContent.trim())`), ['分段采集', '自动跟随', '手动控制']);
  assert.equal((await snapshot()).selectedMode, '分段采集', 'New installations must default to segmented capture');
  await click('[role=tab]', '自动跟随');
  const initial = await waitFor(async () => { const value = await snapshot(); return value?.pointCount === 1 && value; },
    'installed automatic-follow page and current measurement point');
  for (const label of ['测量设置', '自动跟随配置', '叶片与测点', '添加测点', '校准', '转盘设置']) {
    assert.ok(initial.text.includes(label), `Installed automatic-follow UI lacks ${label}`);
  }
  assert.equal(initial.installationOpen, false, 'Installation calibration must start collapsed');
  // A fresh Windows VM can enumerate exactly one virtual COM port and select
  // it asynchronously. Writing an already-empty value does not fire React's
  // onChange, so explicitly enter an invalid nonempty draft: this increments
  // the user's edit revision and prevents the pending enumeration replacing it.
  // Opening settings then remains locally blocked and cannot query any device.
  await setInput('自动跟随转盘串口', 'qa-invalid-before-settings');
  await waitFor(async () => (await savedSurvey())?.port === 'qa-invalid-before-settings', 'invalid connection persisted before settings');
  await click('button[aria-label="打开转盘设置"]', '配置与检查');
  const installation = await waitFor(async () => { const value = await snapshot(); return value?.installationOpen && value; }, 'installed turntable settings dialog');
  for (const label of ['俯仰轴方向', '水平轴方向', '两轴换点转速上限 · rpm']) {
    assert.ok(installation.installationLabels.includes(label), `Missing installation parameter ${label}`);
  }
  await setInput('两轴换点转速上限 · rpm', '5');
  await waitFor(async () => (await savedSurvey())?.settings?.maxMoveRpm === 5, 'installed movement-setting persistence');
  await click('dialog button[aria-label="关闭弹窗"]', '');
  assert.deepEqual(initial.selected, [0]);
  assert.deepEqual(initial.names, ['P1']);
  assert.equal(initial.calibratedCount, 0, 'Installed UI must not invent a hardware calibration');
  assert.ok(!initial.text.includes('待校准'), 'Point calibration is optional, not a prerequisite for theoretical geometry');
  assert.ok(!initial.text.includes('开始自动采集'), 'Capture must be started from the acquisition page');
  assert.equal(initial.simulationControls, 0, 'Automatic-follow production page must not offer simulation controls');

  await click('.field-auto-follow button', '添加测点');
  const added = await waitFor(async () => { const value = await snapshot(); return value?.pointCount === 2 && value; },
    'next radial point added to installed renderer');
  assert.deepEqual(added.selected, [1], 'Adding P2 must select P2 alone');
  assert.deepEqual(added.names, ['P1', 'P2']);
  assert.equal(added.radii[1], '', 'P2 must require its own measured radius');
  await setInput('测点2半径', '0.5');
  await setInput('激光出射点离地高度 · m', '0.65');
  await setInput('风机旋转中心离地高度 · m', '1.5');
  await waitFor(async () => (await snapshot()).radii[1] === '0.5', 'installed P2 radius draft');
  await waitFor(async () => (await snapshot()).firstAngles.every(text => /俯仰 -?\d/.test(text) && /水平 -?\d/.test(text)), 'uncalibrated points have calculated angles');
  await cdp.evaluate('document.querySelector(\'.field-auto-follow .field-auto-point\').click()');
  const selected = await waitFor(async () => { const value = await snapshot(); return value?.selected[0] === 0 && value; },
    'manual radial-point selection in installed renderer');
  assert.deepEqual(selected.selected, [0]);
  assert.equal(selected.radii[1], '0.5', 'Selecting P1 must preserve the separately configured P2');
  assert.equal(selected.calibratedCount, 0, 'Editing point drafts cannot establish device calibration');
  const saved = await waitFor(async () => {
    const value = await savedSurvey(), blade = value?.blades?.find(item => item.id === value.selectedBladeId);
    return value?.version === 3 && blade?.points.length === 2 && value.selectedPointId === blade.points[0].id && value;
  }, 'installed current-point draft persistence');
  const savedBlade = saved.blades.find(item => item.id === saved.selectedBladeId);
  assert.equal(saved.selectedPointId, savedBlade.points[0].id);
  assert.equal(savedBlade.points.length, 2);
  assert.equal(saved.settings.stepDeg, 90);
  assert.equal(saved.settings.cycles, 1, 'Two radial points must preserve one requested circle for each selected point');
  assert.ok(!('anchor' in saved), 'A draft must not persist a fabricated hardware reference');
  assert.equal(saved.collectionId, '', 'Editing alone must not create an acquisition task');
  await click('.field-sidebar button', '数据采集');
  await cdp.evaluate(`(() => { const checkbox = document.querySelector('input[aria-label="联动转盘与测振仪"]'); if (!checkbox || checkbox.disabled) throw Error('Unavailable linkage control'); if (!checkbox.checked) checkbox.click(); })()`);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.field-link-mode')`), 'installed linkage modes');
  await click('.field-link-mode button', '自动跟随');
  const captureTargets = await waitFor(() => cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.field-auto-capture-blade tbody tr')];
    if (rows.length !== 2) return null;
    return rows.map(row => ({ name: row.querySelector('th').textContent.trim(),
      stations: row.querySelectorAll('td')[1].textContent.trim(),
      cycles: row.querySelectorAll('td')[2].textContent.trim(), selected: row.dataset.selected === 'true' }));
  })()`), 'installed independent point capture choices');
  assert.deepEqual(captureTargets.map(row => [row.name, row.stations, row.cycles]), [['P1', '4 个', '1 轮'], ['P2', '4 个', '1 轮']]);
  assert.deepEqual(captureTargets.map(row => row.selected), [true, false]);
  // The hidden configuration remains editable. Establish this precondition
  // again after navigation/mode effects, instead of assuming no ports exist on
  // the host. Never click Start or probe the enumerated virtual/physical port.
  await setInput('自动跟随转盘串口', 'qa-invalid-before-start');
  const connectionGuard = () => cdp.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="自动跟随转盘串口"]');
    const saved = JSON.parse(localStorage.getItem('blade-auto-follow-draft-v1'));
    const button = document.querySelector('.field-auto-capture-list .field-auto-capture-primary');
    return { port: input?.value, savedPort: saved?.port, startDisabled: button?.disabled,
      reason: button?.title, mode: document.querySelector('.field-link-mode [aria-pressed=true]')?.textContent.trim() };
  })()`);
  await waitFor(async () => {
    const value = await connectionGuard();
    return value.port === 'qa-invalid-before-start' && value.savedPort === value.port &&
      value.startDisabled === true && /请选择有效的转盘串口/.test(value.reason) && value.mode === '自动跟随';
  }, 'explicitly invalid connection blocks installed acquisition').catch(async error => {
    throw Error(`${error.message}: ${JSON.stringify(await connectionGuard())}`);
  });
  assertIdle((await field({ action: 'status' })).data);
  assert.deepEqual((await field({ action: 'recordings' })).data.recordings.map(item => item.id).sort(), [...expectedRecordingIds].sort(),
    'Editing the installed point configuration must not create or remove recordings');
  await cdp.evaluate('document.querySelector(".field-content").scrollTop = 0');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, 'installed-windows-auto-follow-current-point.png'), Buffer.from(shot.data, 'base64'));
  return { installedRenderer: true, oneSelectedRadialPoint: true, separatePointDrafts: true,
    fourStationsPerSelectedPoint: true, installationCollapsed: true, optionalCalibrationWithTheoreticalAngles: true,
    noSimulationControls: true, collectionNotCreatedByEditing: true, deviceControlsInvoked: false,
    screenshot: 'installed-windows-auto-follow-current-point.png' };
}

async function validateInstalledDesktop(directory, environment, temporary, output) {
  const executable = path.join(directory, 'BladeVMS.exe');
  const serviceExe = path.join(directory, 'resources', 'acquisition', 'BladeAcquisition.exe');
  const profile = path.join(temporary, 'isolated UI profile 中文');
  fs.mkdirSync(profile, { recursive: true });
  const initial = randomBytes(24).toString('base64url'), changed = randomBytes(24).toString('base64url');
  const salt = randomBytes(32).toString('hex');
  // Only seed the disposable profile. Neither production bootstrap nor an existing user's data is touched.
  const credential = path.join(profile, 'blade-local-auth.json');
  fs.writeFileSync(credential, JSON.stringify({ version: 1, username: 'admin', salt,
    hash: scryptSync(initial, salt, 64).toString('hex'), mustChangePassword: true }), { flag: 'wx' });
  const port = await freePort();
  assert.deepEqual(await executableProcesses(serviceExe), [], 'Pre-existing service in disposable installation');
  const child = watchChild(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
    { cwd: directory, env: environment });
  let cdp;
  let safelyClosed = false;
  try {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      const targets = await response.json();
      return targets.find(item => item.type === 'page' && item.url.startsWith('file://') && item.webSocketDebuggerUrl);
    }, 'installed desktop renderer', 45000);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    const field = value => cdp.evaluate(`window.blade.field(${JSON.stringify(value)})`);
    const body = () => cdp.evaluate('document.body.innerText');
    const reload = async () => { await cdp.send('Page.reload'); await pause(300); };
    await waitFor(async () => (await body()).includes('登录现场工作台'), 'local login UI');
    assert.equal(await cdp.evaluate('typeof window.require'), 'undefined');
    assert.deepEqual(await cdp.evaluate('Object.keys(window.blade).sort()'), ['field', 'version', 'windowControl']);
    assert.equal((await field({ action: 'status' })).status, 401);
    assert.equal((await field({ action: 'login', username: 'admin', password: 'incorrect-test-password' })).status, 401);
    const login = await field({ action: 'login', username: 'admin', password: initial });
    assert.equal(login.status, 200); assert.equal(login.data.mustChangePassword, true);
    assert.equal((await field({ action: 'status' })).status, 403);
    await reload();
    await waitFor(async () => (await body()).includes('首次登录'), 'mandatory password change UI');
    assert.equal((await field({ action: 'changePassword', currentPassword: initial, newPassword: changed })).status, 200);
    const stored = JSON.parse(fs.readFileSync(credential, 'utf8'));
    assert.equal(stored.mustChangePassword, false, 'Electron must use the disposable --user-data-dir profile');
    assert.equal(stored.hash, scryptSync(changed, stored.salt, 64).toString('hex'), 'Changed test password was not persisted');
    await reload();
    await waitFor(async () => (await body()).includes('开始采集'), 'authenticated acquisition UI');
    const status = await waitFor(async () => {
      const response = await field({ action: 'status' });
      return response.status === 200 && response.data.service.state === 'ready' && response.data;
    }, 'automatically managed bundled Python service');
    assertIdle(status);
    assert.equal(path.resolve(status.service.executable).toLowerCase(), serviceExe.toLowerCase());
    assert.equal(status.service.dllConfigured, true);
    assert.equal((await executableProcesses(serviceExe)).length, 1, 'Exactly one app-owned acquisition service');
    const frame = await field({ action: 'frame' });
    assert.equal(frame.status, 200); assert.deepEqual(frame.data.waveform.values, []);
    assert.deepEqual((await field({ action: 'recordings' })).data.recordings, []);
    await waitFor(async () => (await idleWaveformUi(cdp)).emptyCount === 2, 'empty velocity and RSSI waveform UI');
    assertIdleWaveformUi(await idleWaveformUi(cdp));
    const text = await body();
    assert.ok(!text.includes('离线演示工作区'));
    // Native validation and the separate primary action must agree. Never
    // click Start: these reserved documentation addresses are draft values only.
    const emptyForm = await captureFormState(cdp);
    assert.equal(emptyForm.valid, false, 'Empty acquisition configuration must not pass form validation');
    assert.equal(emptyForm.missingRequired, 3, 'Task name, device IP and host IP must all be required');
    assert.deepEqual(emptyForm.requiredValues, ['', '', '']);
    assert.equal(emptyForm.startDisabled, true, 'Empty configuration must disable the separate Start button');
    for (const [selector, value] of [
      ['input[aria-label="任务名称"]', 'TEST ONLY · ready control without acquisition'],
      ['input[placeholder="设备 IPv4 地址"]', '192.0.2.10'],
      ['input[placeholder="连接设备的网卡 IPv4 地址"]', '192.0.2.20'],
    ]) {
      await cdp.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(async () => await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`) === value,
        'test-only acquisition field is displayed');
    }
    await waitFor(async () => { const form = await captureFormState(cdp); return form.valid && !form.startDisabled; },
      'valid test-only configuration enables the ready start control');
    assertIdle((await field({ action: 'status' })).data);
    assert.deepEqual((await field({ action: 'frame' })).data.waveform.values, []);
    assert.deepEqual((await field({ action: 'recordings' })).data.recordings, []);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, 'installed-windows-acquisition-idle.png'), Buffer.from(screenshot.data, 'base64'));
    const automaticFollowUi = await validateInstalledAutoFollow(cdp, field, output);
    const viewports = [[1366, 768, 1], [1280, 720, 1], [1024, 600, 1], [853, 480, 1.5]];
    for (const [width, height, scale] of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      await pause(200);
      for (const screenName of ['数据采集', '设备与服务', '本机记录']) {
        await cdp.evaluate(`[...document.querySelectorAll('.field-sidebar button')].find(b=>b.textContent.trim() === ${JSON.stringify(screenName)}).click()`);
        await pause(300);
        const layout = await cdp.evaluate(`(() => {
          const main = document.querySelector('.field-content');
          const app = document.querySelector('.field-app');
          main.scrollTop = main.scrollHeight;
          return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
            appHeight: app.getBoundingClientRect().height, mainHeight: main.clientHeight,
            overflowY: getComputedStyle(main).overflowY, scrollHeight: main.scrollHeight, scrollTop: main.scrollTop };
        })()`);
        assert.ok(layout.documentWidth <= layout.width + 1, `Horizontal page clipping: ${screenName} at ${width}x${height}`);
        assert.ok(layout.appHeight <= layout.height + 1 && layout.mainHeight > 60, `Unbounded application height: ${screenName}`);
        assert.ok(['auto', 'scroll'].includes(layout.overflowY), 'Main content must own vertical scrolling');
        if (layout.scrollHeight > layout.mainHeight + 1) assert.ok(layout.scrollTop > 0, 'Main content cannot scroll to lower controls');
        if (screenName === '数据采集') {
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(output, `installed-${width}x${height}-scroll-bottom.png`), Buffer.from(shot.data, 'base64'));
        }
      }
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    assert.equal((await field({ action: 'logout' })).status, 200);
    assert.equal((await field({ action: 'login', username: 'admin', password: initial })).status, 401);
    assert.equal((await field({ action: 'login', username: 'admin', password: changed })).status, 200);
    // The preload close path invokes the production stop/save/child-exit lifecycle.
    await cdp.evaluate('window.blade.windowControl("close"); true').catch(() => {});
    await deadline(child.closed, 25000, 'Installed app did not close safely');
    await waitFor(async () => (await executableProcesses(serviceExe)).length === 0, 'no acquisition service orphan after UI exit', 15000);
    safelyClosed = true;
    return { isolatedCredentials: true, login: true, requiredPasswordChange: true, passwordPersistence: true,
      serviceReady: true, dllAvailable: true, emptyConfigurationBlockedByFormValidation: true,
      startControlEnabledAfterValidConfiguration: true, displayedSamples: 0,
      hardwareTouched: false, safeAppClose: true, noServiceOrphan: true,
      responsiveViewports: viewports, responsiveScreens: 3, automaticFollowUi };
  } finally {
    cdp?.close();
    if (!safelyClosed) {
      await stopChild(child).catch(() => {});
      // Clean only processes whose executable is this script's new disposable installation.
      for (const owned of await executableProcesses(serviceExe)) {
        await powershell(`Stop-Process -Id ${Number(owned.ProcessId)} -Force -ErrorAction SilentlyContinue`);
      }
    }
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'This gate must run on real Windows, not Wine or a mocked platform');
  assert.equal(process.arch, 'x64', 'Use Windows x64 Node.js');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22+ is required for native WebSocket');
  const options = optionsFrom(process.argv.slice(2));
  if (options.installer) assert.ok(process.env.CI === 'true' || process.env.BLADE_ALLOW_INSTALL_SMOKE === '1',
    'Install smoke is restricted to disposable CI. It may replace an existing BladeVMS installation for this user.');
  fs.mkdirSync(options.output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-win-bundle-'));
  const external = path.join(temporary, 'external Python Conda 环境');
  fs.mkdirSync(external, { recursive: true });
  const marker = path.join(external, 'EXTERNAL_PYTHON_WAS_USED');
  const fakePython = path.join(external, 'python.cmd');
  fs.writeFileSync(fakePython, `@echo off\r\necho forbidden>"${marker.replaceAll('%', '%%')}"\r\nexit /b 91\r\n`, { flag: 'wx' });
  const sitecustomize = path.join(external, 'sitecustomize.py');
  fs.writeFileSync(sitecustomize, 'raise RuntimeError("BladeVMS must not import external sitecustomize")\n', { flag: 'wx' });
  const sentinelBefore = [fakePython, sitecustomize].map(file => digest(fs.readFileSync(file)));
  const clean = isolatedEnvironment();
  const poisoned = isolatedEnvironment({ PATH: `${external};${clean.PATH}`, PYTHONHOME: external, PYTHONPATH: external,
    VIRTUAL_ENV: external, CONDA_PREFIX: external, CONDA_DEFAULT_ENV: 'blade-do-not-use', CONDA_SHLVL: '1' });
  const before = await environmentSnapshot();
  report.externalPython = before.externalPython;
  report.windowsVersion = os.release();
  let installDirectory;
  let installed = false;
  let failed;
  try {
    await check('frozen bundle with no system Python on PATH', () => validateService(options.resources, clean, path.join(temporary, 'clean')));
    await check('frozen bundle with poisoned Python/Conda/venv environment', () => validateService(options.resources, poisoned, path.join(temporary, 'poisoned')));
    if (options.installer) {
      installDirectory = path.join(temporary, '安装目录 with spaces', 'BladeVMS');
      await check('NSIS silent current-user installation at a Chinese path with spaces', async () => {
        // /D must be last. windowsVerbatimArguments preserves NSIS's unquoted /D=<path with spaces> syntax.
        const installedResult = await execute(options.installer, ['/S', '/currentuser', `/D=${installDirectory}`],
          { env: { ...process.env }, timeoutMs: 180000, windowsVerbatimArguments: true, argv0: `"${options.installer}"` });
        installed = fs.existsSync(path.join(installDirectory, 'BladeVMS.exe'));
        assert.equal(installedResult.code, 0, installedResult.code === 3010
          ? 'VC++ runtime requires a Windows reboot; post-reboot readiness cannot be certified in this run'
          : `Installer exit code: ${installedResult.code}`);
        assert.ok(installed, 'Installer did not install to requested disposable directory');
        assert.ok(fs.existsSync(path.join(installDirectory, 'resources', 'acquisition', 'BladeAcquisition.exe')));
      });
      await check('installed service, SDK and bundled Python survive poisoned external environment', () =>
        validateService(path.join(installDirectory, 'resources'), poisoned, path.join(temporary, 'installed service')));
      await check('installed desktop login, change password, ready acquisition screen and safe exit', () =>
        validateInstalledDesktop(installDirectory, poisoned, temporary, options.output));
      await check('installed frozen simulation, live cloud preview, complete raw upload and CSV export', async () => {
        const output = path.join(options.output, 'installed-simulation');
        const result = await execute(process.execPath, [path.join(root, 'scripts/test-windows-simulation.cjs'),
          '--resources', path.join(installDirectory, 'resources'), '--output', output], { timeoutMs: 120000 });
        assert.equal(result.code, 0, `Installed simulation gate failed: ${result.stdout} ${result.stderr}`);
        const evidence = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
        assert.equal(evidence.passed, true); assert.equal(evidence.frozenWindowsTested, true);
        assert.equal(evidence.hardwareTested, false); assert.equal(evidence.captures.length, 3);
        return { frozenWindowsTested: true, cloudProtocolPeer: 'local in-memory test peer',
          packagedCloudSyncSha256: evidence.packagedCloudSyncSha256, captures: evidence.captures };
      });
      await check('install and app startup do not modify existing Python or environment settings', async () => {
        assert.deepEqual(await environmentSnapshot(), before);
        assert.deepEqual([fakePython, sitecustomize].map(file => digest(fs.readFileSync(file))), sentinelBefore);
        assert.equal(fs.existsSync(marker), false, 'App executed external Python shim');
      });
    }
  } catch (error) { failed = error; }
  finally {
    if (installed) {
      try {
        await check('silent uninstall preserves external Python and environment settings', async () => {
          const uninstallers = fs.readdirSync(installDirectory).filter(name => /^uninstall.*\.exe$/i.test(name));
          assert.equal(uninstallers.length, 1, 'Expected exactly one NSIS uninstaller');
          const uninstalled = await execute(path.join(installDirectory, uninstallers[0]), ['/S', '/currentuser', `_?=${installDirectory}`],
            { timeoutMs: 120000, windowsVerbatimArguments: true, argv0: `"${path.join(installDirectory, uninstallers[0])}"` });
          assert.equal(uninstalled.code, 0);
          await waitFor(() => !fs.existsSync(path.join(installDirectory, 'BladeVMS.exe')), 'installed application removed');
          assert.deepEqual(await executableProcesses(path.join(installDirectory, 'resources', 'acquisition', 'BladeAcquisition.exe')), []);
          assert.deepEqual(await environmentSnapshot(), before);
          assert.deepEqual([fakePython, sitecustomize].map(file => digest(fs.readFileSync(file))), sentinelBefore);
          assert.equal(fs.existsSync(marker), false);
          return { externalPythonPreserved: Boolean(before.externalPython), environmentAndAssociationsPreserved: true };
        });
      } catch (error) { failed ||= error; }
    }
    for (const child of liveChildren) child.kill();
    report.passed = !failed;
    report.finishedAt = new Date().toISOString();
    // Only report and screenshots are release artifacts. Temp profiles contain random test credentials.
    fs.writeFileSync(path.join(options.output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failed) throw failed;
  console.log(`PASS ${report.checks.length} Windows bundle gates. Only simulated acquisition was started; no device or laser was accessed.`);
  console.log(`Report: ${path.join(options.output, 'result.json')}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { optionsFrom, isolatedEnvironment, assertIdle, assertSdkBindings, REQUIRED_SDK_SYMBOLS, assertIdleWaveformUi,
  idleWaveformUi, captureFormState, validateInstalledAutoFollow, connectCdp };
