'use strict';

// Exercises the actual packaged main/preload/renderer and bundled acquisition
// reader. Never use the developer profile, bootstrap file, Web account or devices.
// Usage: node scripts/test-custom-mac-package.cjs --app /path/BladeVMS.app
//   --instructions /path/installation-notes.txt [--output /path/to/evidence]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert.ok(['--app', '--instructions', '--output'].includes(key) && value && !value.startsWith('--'), 'Expected --app, --instructions and optional --output paths.');
  options[key.slice(2)] = path.resolve(value);
}
assert.equal(process.platform, 'darwin', 'This acceptance test requires macOS.');
assert.ok(options.app && options.instructions, 'Provide the packaged .app and its newly generated installation notes.');
assert.equal(path.extname(options.app), '.app');
const output = options.output || path.join(root, 'artifacts', `custom-mac-package-${Date.now()}`);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
// Electron canonicalizes macOS /var -> /private/var in --user-data-dir.
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blade-package-qa-')));
const sdk = path.join(profile, 'intentionally-missing-device-SDK.dylib');
assert.ok(!fs.existsSync(sdk));
fs.writeFileSync(path.join(profile, 'blade-field-settings.json'), JSON.stringify({ dll: sdk }), { mode: 0o600 });
const notes = fs.readFileSync(options.instructions, 'utf8');
const initialPassword = /初始密码\s+([^\s]+)/u.exec(notes)?.[1];
assert.ok(initialPassword && initialPassword.length >= 12, 'New package installation notes must contain the generated initial password.');
const nextPassword = randomBytes(24).toString('base64url');
const executableName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(options.app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
assert.ok(executableName && path.basename(executableName) === executableName, 'Invalid bundle executable.');
const executable = path.join(options.app, 'Contents/MacOS', executableName);
const resources = path.join(options.app, 'Contents/Resources');
const bundleDirectory = path.join(resources, 'bundled-recordings');
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDirectory, 'manifest.json'), 'utf8'));
assert.equal(manifest.records.length, 20, 'Expected the explicitly selected 20-record task.');
const results = { app: options.app, profile, taskName: manifest.taskName, bundleId: manifest.bundleId,
  hardwareTested: false, webConnected: false, tests: [], screenshots: [], runs: [] };
let current = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function cleanError(error) {
  let message = String(error?.message || error);
  for (const secret of [initialPassword, nextPassword]) message = message.replaceAll(secret, '[redacted]');
  // Never emit inspector expressions, raw process output or authentication data.
  return message.slice(0, 2000);
}
async function waitFor(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(100); }
  throw Error(`Timed out: ${label}`);
}
async function check(name, fn) { await fn(); results.tests.push(name); console.log(`PASS ${name}`); }
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function verifyInstalled() {
  const target = path.join(profile, 'field-data/recordings');
  const ids = fs.readdirSync(target).filter(name => /^[a-f0-9]{32}$/.test(name)).sort();
  assert.deepEqual(ids, manifest.records.map(record => record.id).sort());
  let bytes = 0, files = 0;
  for (const record of manifest.records) for (const item of record.files) {
    assert.ok(/^(?:manifest\.json|source-export-manifest\.json|chunk-\d{8}\.bin|unpaired-rssi\.bin)$/.test(item.path));
    for (const base of [path.join(bundleDirectory, 'records'), target]) {
      const file = path.join(base, record.id, item.path), stat = fs.lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.size, item.size, `Size mismatch in ${record.id}/${item.path}`);
      assert.equal(await hash(file), item.sha256, `Hash mismatch in ${record.id}/${item.path}`);
    }
    bytes += item.size; files++;
  }
  const state = JSON.parse(fs.readFileSync(path.join(profile, 'field-data/bundled-recordings-state.json'), 'utf8'));
  assert.equal(Object.keys(state.records).length, 20);
  assert.ok(Object.values(state.records).every(item => item.status === 'imported' && item.bundleId === manifest.bundleId));
  assert.ok(!fs.existsSync(path.join(profile, 'field-data/bundled-recordings-error.json')));
  return { records: ids.length, files, bytes, allHashesMatch: true, stateSha256: await hash(path.join(profile, 'field-data/bundled-recordings-state.json')) };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
class Inspector {
  constructor(ws) {
    this.ws = ws; this.sequence = 0; this.pending = new Map(); this.paused = null;
    ws.addEventListener('message', event => {
      const value = JSON.parse(String(event.data));
      if (value.method === 'Debugger.paused') this.paused = value.params;
      if (value.method === 'Debugger.resumed') this.paused = null;
      if (value.id && this.pending.has(value.id)) {
        const item = this.pending.get(value.id); this.pending.delete(value.id); clearTimeout(item.timer);
        if (value.error) item.reject(Error(`Inspector ${item.method} failed (${value.error.code})`)); else item.resolve(value.result);
      }
    });
    ws.addEventListener('close', () => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('Inspector disconnected')); }
      this.pending.clear();
    });
  }
  call(method, params = {}, timeout = 120000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Inspector ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, paused = false) {
    const params = { expression, returnByValue: true, ...(paused ? { callFrameId: this.paused.callFrames[0].callFrameId } : { awaitPromise: true }) };
    const result = await this.call(paused ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate', params);
    if (result.exceptionDetails) throw Error(`Packaged application evaluation failed: ${result.exceptionDetails.exception?.description?.split('\n')[0] || result.exceptionDetails.text}`);
    return result.result?.value;
  }
  close() { this.ws.close(); }
}
function guardsSource() {
  // Runs while the app entry point is paused, before its service or auth modules
  // can capture fetch/spawn. Only local read-only recording APIs are allowed.
  return `(() => {
    const q=globalThis.__bladePackageQa, e=q.electron, expected=${JSON.stringify(profile)}, sdk=${JSON.stringify(sdk)};
    if(e.app.getPath('userData')!==expected) throw Error('Temporary profile not selected');
    q.blocked=[];q.localRequests=[];q.servicePids=[];
    const allow=url=>{try{const u=new URL(String(url));return u.hostname==='127.0.0.1'&&u.protocol==='http:'&&/^\\/api\\/field\\/(?:status|frame|recordings(?:\\/[a-f0-9]{32}(?:\\/waveform)?)?)$/.test(u.pathname);}catch{return false;}};
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init={})=>{const url=typeof input==='string'||input instanceof URL?String(input):input.url;const method=init.method||input.method||'GET';
      const stop=q.allowIdleStop&&method==='POST'&&/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/api\\/field\\/stop$/.test(url);
      if(!(allow(url)&&method==='GET')&&!stop){q.blocked.push({channel:'fetch',method});return Promise.reject(Error('Package QA blocks device and Web requests'));}
      q.localRequests.push(new URL(url).pathname);return originalFetch(input,init);};
    const OriginalWebSocket=globalThis.WebSocket;
    globalThis.WebSocket=class extends OriginalWebSocket{constructor(url,protocols){const u=new URL(url);if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1'||u.pathname!=='/ws/field')throw Error('Package QA blocks external WebSocket');super(url,protocols);}};
    const cp=q.require('node:child_process'), originalSpawn=cp.spawn;
    cp.spawn=function(file,args,opts){if(file!==${JSON.stringify(path.join(resources, 'acquisition/BladeAcquisition'))}||opts?.env?.BLADE_POLYTEC_DLL!==sdk||opts?.env?.BLADE_DATA_DIR!==expected+'/field-data')throw Error('Package QA rejects unisolated service spawn');
      const child=originalSpawn.call(this,file,args,opts);q.servicePids.push(child.pid);return child;};
    e.app.on('web-contents-created',(_event,wc)=>{wc.session.webRequest.onBeforeRequest((details,callback)=>{const safe=/^(file:|data:|blob:|devtools:)/.test(details.url);if(!safe)q.blocked.push({channel:'renderer'});callback({cancel:!safe});});});
    return {userData:e.app.getPath('userData'),guardsInstalled:true};
  })()`;
}
async function launch(run) {
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:BLADE_|PYTHON|CONDA|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|VIRTUAL_ENV)/.test(key)));
  const child = spawn(executable, [`--user-data-dir=${profile}`, `--inspect-brk=127.0.0.1:${port}`, '--disable-background-networking'], { cwd: profile, env, stdio: ['ignore', 'ignore', 'pipe'] });
  // Drain stderr without recording it: packaged credentials must never leak in
  // diagnostics even if a future dependency prints them.
  child.stderr.on('data', () => {});
  let launchError; child.on('error', error => { launchError = error; });
  const runtime = { child, inspector: null, servicePids: [], run }; current = runtime;
  const endpoint = await waitFor(async () => {
    if (launchError || child.exitCode !== null) throw Error('Packaged application exited before inspector startup');
    try { const response = await fetch(`http://127.0.0.1:${port}/json/list`); const entries = await response.json(); return entries[0]?.webSocketDebuggerUrl; } catch { return null; }
  }, 'packaged application inspector', 30000);
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(Error('Inspector connection failed')), { once: true }); });
  const inspector = runtime.inspector = new Inspector(ws);
  await inspector.call('Runtime.enable'); await inspector.call('Debugger.enable');
  await inspector.call('Runtime.runIfWaitingForDebugger');
  await waitFor(() => inspector.paused, 'paused packaged entry point', 15000);
  await inspector.evaluate(`globalThis.__bladePackageQa={require:typeof require==='function'?require:process.getBuiltinModule('module').createRequire(process.execPath)};globalThis.__bladePackageQa.electron=globalThis.__bladePackageQa.require('electron');true`, true);
  const actual = await inspector.evaluate(`globalThis.__bladePackageQa.electron.app.getPath('userData')`, true);
  // Never repair a mismatch by changing a real profile after startup.
  assert.equal(actual, profile, 'Packaged app did not honor the temporary user directory; aborting before main startup');
  await inspector.evaluate(guardsSource(), true);
  await inspector.call('Debugger.resume');
  await inspector.call('Debugger.disable');
  const main = code => inspector.evaluate(code);
  const js = code => main(`globalThis.__bladePackageQa.electron.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(code)},true)`);
  const field = request => js(`window.blade.field(${JSON.stringify(request)})`);
  const body = () => js('document.body.innerText');
  await waitFor(async () => await main(`Boolean(globalThis.__bladePackageQa.electron.BrowserWindow.getAllWindows()[0]?.webContents.getURL().startsWith('file://'))`), 'packaged file window');
  await waitFor(async () => { try { return (await body()).includes('登录现场工作台'); } catch { return false; } }, 'login page');
  await main(`globalThis.__bladePackageQa.electron.BrowserWindow.getAllWindows()[0].setSize(1366,1000);true`);
  async function screenshot(name) {
    const file = path.join(output, name);
    await main(`(async()=>{const q=globalThis.__bladePackageQa;const image=await q.electron.BrowserWindow.getAllWindows()[0].webContents.capturePage();q.require('node:fs').writeFileSync(${JSON.stringify(file)},image.toPNG());return true;})()`);
    results.screenshots.push(file);
  }
  async function reload() { await main(`globalThis.__bladePackageQa.electron.BrowserWindow.getAllWindows()[0].webContents.reload();true`); await pause(300); }
  Object.assign(runtime, { main, js, field, body, reload, screenshot });
  return runtime;
}
async function stop(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  try {
    // Even startup failure after main resumed can leave the bundled reader
    // running. Recover only this test's recorded child PIDs before disconnecting.
    if (runtime.inspector && !runtime.inspector.paused)
      runtime.servicePids = await runtime.inspector.evaluate('globalThis.__bladePackageQa?.servicePids || []').catch(() => []);
    if (runtime.main) {
      const status = await runtime.field({ action: 'status' }).catch(() => null);
      assert.ok(status?.status === 200 && status.data.receiver?.running === false && !status.data.deviceBusy && !status.data.turntableBusy, 'Isolated package must remain idle before shutdown');
      await runtime.main('globalThis.__bladePackageQa.allowIdleStop=true');
      await runtime.main('globalThis.__bladePackageQa.electron.BrowserWindow.getAllWindows()[0]?.close();true');
    } else throw Error('Package startup did not complete');
    runtime.inspector?.close();
    await waitFor(() => runtime.child.exitCode !== null || runtime.child.signalCode !== null, 'clean package exit', 15000);
  } catch {
    // Kill only PIDs created by this isolated test; never pkill other clients.
    runtime.inspector?.close();
    for (const pid of runtime.servicePids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    runtime.child.kill('SIGKILL'); throw Error('Packaged application did not close cleanly');
  }
  current = null;
}
function verifyRecords(records) {
  assert.equal(records.length, 20);
  assert.deepEqual(records.map(r => r.id).sort(), manifest.records.map(r => r.id).sort());
  assert.ok(records.every(r => r.name === manifest.taskName && r.status === 'complete'));
  assert.equal(new Set(records.map(r => r.pointCycle?.collectionId)).size, 1);
  assert.match(records[0].pointCycle?.collectionId || '', /^[a-f0-9]{32}$/);
  assert.deepEqual([...new Set(records.map(r => String(r.pointCycle?.bladeId)))], ['2']);
  const points = {};
  for (const record of records) { const cycle = record.pointCycle; (points[cycle.radialPointName] ||= []).push(cycle.azimuthDeg); }
  assert.deepEqual(Object.keys(points).sort(), ['P1','P2','P3','P4','P5']);
  for (const angles of Object.values(points)) assert.deepEqual(angles.sort((a,b)=>a-b), [0,90,180,270]);
  return points;
}
async function verifyQueue(runtime) {
  const response = await runtime.field({ action: 'syncStatus' });
  assert.equal(response.status, 200); assert.equal(response.data.connected, false); assert.equal(response.data.state, 'unbound'); assert.deepEqual(response.data.items, []);
  const file = path.join(profile, 'blade-cloud-sync.json');
  if (fs.existsSync(file)) assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items, []);
}
async function run() {
  const first = await launch(1);
  await check('actual packaged application uses an isolated profile and production renderer', async () => {
    const state = await first.main(`(()=>{const q=globalThis.__bladePackageQa,w=q.electron.BrowserWindow.getAllWindows()[0];return {profile:q.electron.app.getPath('userData'),packaged:q.electron.app.isPackaged,url:w.webContents.getURL(),sandbox:w.webContents.getLastWebPreferences().sandbox};})()`);
    assert.equal(state.profile, profile); assert.equal(state.packaged, true); assert.ok(state.url.startsWith('file://')); assert.equal(state.sandbox, true);
    assert.equal((await first.field({ action: 'recordings' })).status, 401);
    await first.screenshot('01-first-login.png');
  });
  await check('fresh package password requires a local password change', async () => {
    const logged = await first.field({ action: 'login', username: 'admin', password: initialPassword });
    assert.equal(logged.status, 200); assert.equal(logged.data.mustChangePassword, true);
    await first.reload(); await waitFor(async () => (await first.body()).includes('首次登录'), 'first password change');
    await first.screenshot('02-first-password-change.png');
    assert.equal((await first.field({ action: 'changePassword', currentPassword: initialPassword, newPassword: nextPassword })).status, 200);
    await first.reload(); await waitFor(async () => (await first.body()).includes('开始采集'), 'local workspace');
  });
  let records;
  await check('bundled standalone service reads exactly one task with five points and four angles', async () => {
    await waitFor(async () => { const r = await first.field({ action: 'status' }); return r.status === 200 && r.data.service?.state === 'ready'; }, 'bundled recording reader', 90000);
    const status = (await first.field({ action: 'status' })).data;
    assert.equal(status.service.sdkPath, sdk); assert.equal(status.service.dllConfigured, false); assert.equal(status.service.launcher, 'macos-bundle');
    assert.equal(status.receiver.running, false);
    const response = await first.field({ action: 'recordings' }); assert.equal(response.status, 200); records = response.data.recordings;
    results.points = verifyRecords(records); await verifyQueue(first);
  });
  await check('local recording list and blade summary display the real bundled task', async () => {
    await first.js(`[...document.querySelectorAll('.field-sidebar button')].find(b=>b.textContent.includes('本机记录')).click()`);
    await waitFor(async () => await first.js(`document.querySelectorAll('.field-table tbody tr').length===20`), '20 visible recording rows');
    await first.screenshot('03-local-recordings.png');
    await first.js(`[...document.querySelectorAll('[role="tab"]')].find(b=>b.textContent.includes('叶片采集汇总')).click()`);
    await waitFor(async () => await first.js(`Boolean(document.querySelector('.field-blade-summary .field-blade-points'))`), 'blade summary');
    const summary = await first.js(`document.querySelector('.field-blade-summary').innerText`);
    assert.ok(summary.includes(manifest.taskName) && summary.includes('叶片 2'));
    for (const point of ['P1','P2','P3','P4','P5']) assert.ok(summary.includes(point));
    await first.screenshot('04-blade-summary.png');
  });
  await check('waveform dialog loads actual stored samples without a device', async () => {
    await first.js(`document.querySelector('.field-blade-summary .field-blade-point').open=true`);
    await first.js(`[...document.querySelectorAll('.field-blade-summary button')].find(b=>b.textContent.includes('查看波形')).click()`);
    await waitFor(async () => await first.js(`Boolean(document.querySelector('.field-recording-dialog .field-full-waveform[aria-busy="false"] .field-wave-svg path[d]'))`), 'stored waveform', 120000);
    const view = await first.js(`({plots:document.querySelectorAll('.field-recording-dialog .field-wave-svg').length,errors:[...document.querySelectorAll('.field-recording-dialog .field-error')].map(e=>e.textContent),data:document.querySelector('[data-testid="wave-representation"]')?.textContent})`);
    assert.ok(view.plots >= 2); assert.deepEqual(view.errors, []); assert.ok(view.data);
    await first.screenshot('05-stored-waveform.png');
  });
  await check('package and installed raw files have identical sizes and SHA-256 hashes', async () => { results.initialImport = await verifyInstalled(); });
  const beforeState = results.initialImport.stateSha256;
  results.runs.push(await first.main('({run:1,blockedRequests:globalThis.__bladePackageQa.blocked,readOnlyRequests:globalThis.__bladePackageQa.localRequests.length})'));
  assert.deepEqual(results.runs[0].blockedRequests, []);
  await stop(first);
  const second = await launch(2);
  await check('restart preserves the changed password and imports no duplicates', async () => {
    assert.equal((await second.field({ action: 'login', username: 'admin', password: initialPassword })).status, 401);
    const logged = await second.field({ action: 'login', username: 'admin', password: nextPassword });
    assert.equal(logged.status, 200); assert.equal(logged.data.mustChangePassword, false);
    await second.reload(); await waitFor(async () => (await second.body()).includes('开始采集'), 'restarted workspace');
    await waitFor(async () => { const r = await second.field({ action: 'status' }); return r.status === 200 && r.data.service?.state === 'ready'; }, 'restarted reader');
    const response = await second.field({ action: 'recordings' }); assert.equal(response.status, 200); verifyRecords(response.data.recordings);
    results.afterRestart = await verifyInstalled(); assert.equal(results.afterRestart.stateSha256, beforeState); await verifyQueue(second);
  });
  results.runs.push(await second.main('({run:2,blockedRequests:globalThis.__bladePackageQa.blocked,readOnlyRequests:globalThis.__bladePackageQa.localRequests.length})'));
  assert.deepEqual(results.runs[1].blockedRequests, []);
  await stop(second);
  results.passed = results.tests.length;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  console.log(`PASS ${results.passed} actual Mac package checks; evidence: ${output}`);
}
run().catch(async error => {
  results.failure = cleanError(error);
  try { await stop(current); } catch (stopError) { results.cleanupError = cleanError(stopError); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  console.error(`FAIL ${results.failure}`); process.exitCode = 1;
});
