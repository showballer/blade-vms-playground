// Real loopback HTTP/WS contract with Python; SDK path intentionally nonexistent.
const { createFieldService } = require('../apps/desktop/electron/field-service.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-field-contract-'));
const executable = path.join(directory, 'BladeAcquisition.exe');
fs.writeFileSync(executable, 'test placeholder, never executed');
const python = process.env.BLADE_TEST_PYTHON || path.join(root, 'services/acquisition/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(python)) throw Error('Prepare the acquisition service test venv or set BLADE_TEST_PYTHON');
let wsFrames = 0;
class ObservedSocket extends WebSocket {
  constructor(...args) { super(...args); this.addEventListener('message', () => { wsFrames += 1; }); }
}
const service = createFieldService({ getConfig: () => ({ executable, dll: path.join(directory, 'missing-sdk.dll') }),
  dataDir: path.join(directory, 'data'), resourcesDir: directory, platform: 'win32', WebSocketImpl: ObservedSocket,
  spawnImpl: (_file, _args, options) => spawn(python, [path.join(root, 'services/acquisition/launch_service.py')], options) });
(async () => {
  try {
    assert.equal((await service.start()).service.state, 'ready');
    assert.equal((await service.status()).state, 'idle');
    const until = Date.now() + 5000;
    while (!wsFrames && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(wsFrames > 0, 'Real Python WS must authenticate the Node client');
    assert.deepEqual((await service.frame()).waveform.values, []);
    assert.deepEqual((await service.recordings()).recordings, []);
    await assert.rejects(service.begin({ deviceIp: '192.168.104.50', hostIp: '192.168.104.10', name: 'No hardware contract test', object: '', turbine: '', point: '', confirmLaser: true }), error => error.status === 503);
    assert.equal((await service.status()).state, 'error');
    assert.deepEqual((await service.recordings()).recordings, []);
    await service.shutdown();
    assert.equal(service.serviceInfo().state, 'stopped');
    console.log('PASS real Electron-manager/Python HTTP + WebSocket contract, idle startup, missing SDK error, no synthetic records, clean shutdown');
  } finally { await service.shutdown({ force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
