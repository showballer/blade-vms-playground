// Isolated real Electron -> HTTP -> Python numerical validation. No hardware.
// --interactive leaves the validation window open. Never loads installed app data.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, scryptSync } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const serviceRoot = path.join(root, 'services/acquisition');
const python = process.env.BLADE_VALIDATION_PYTHON || path.join(serviceRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(python)) throw Error('Prepare services/acquisition/.venv with requirements.txt first.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-analysis-validation-'));
app.setPath('userData', profile);
const output = path.join(root, 'artifacts/analysis-validation');
fs.mkdirSync(output, { recursive: true });
const fixture = spawnSync(python, ['tests/create_analysis_fixture.py', path.join(profile, 'field-data')], { cwd: serviceRoot,
  env: { ...process.env, PYTHONPATH: serviceRoot }, encoding: 'utf8', windowsHide: true });
if (fixture.status !== 0) throw Error(fixture.stderr);
const recordingId = fixture.stdout.trim();
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
const password = randomBytes(24).toString('hex'), nextPassword = randomBytes(24).toString('hex'), salt = randomBytes(32).toString('hex');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const serviceModule = require('../apps/desktop/electron/field-service.cjs');
const realFactory = serviceModule.createFieldService;
serviceModule.createFieldService = options => {
  const service = realFactory({ ...options, platform: 'win32',
    // Existing launcher validation is preserved; only this test's spawn uses Python.
    getConfig: () => ({ executable: process.execPath }),
    spawnImpl: (_file, _args, settings) => spawn(python, ['-m', 'blade_acquisition'], { ...settings, cwd: serviceRoot,
      env: { ...process.env, BLADE_SERVICE_PORT: settings.env.BLADE_SERVICE_PORT, BLADE_SERVICE_TOKEN: settings.env.BLADE_SERVICE_TOKEN,
        BLADE_DATA_DIR: settings.env.BLADE_DATA_DIR, BLADE_POLYTEC_DLL: '' }, windowsHide: true }) });
  service.begin = async () => { throw Error('隔离仿真验证窗口禁止启动真实采集。'); };
  service.device = async () => { throw Error('隔离仿真验证窗口禁止设备控制。'); };
  return service;
};
delete process.env.BLADE_DEV_URL;
const interactive = process.argv.includes('--interactive');
const watchdog = setTimeout(() => { console.error('Analysis validation timed out'); app.exit(1); }, 120000);
async function waitFor(fn) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('UI validation timed out'); }
app.on('browser-window-created', (_event, win) => {
  win.setTitle('BladeVMS 独立分析验证 · 仿真输入');
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    try {
      assert.equal((await field({ action: 'analysis', id: recordingId, parameters: { end: 16384 } })).status, 401);
      await field({ action: 'login', username: 'admin', password });
      await field({ action: 'changePassword', currentPassword: password, newPassword: nextPassword });
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await waitFor(() => js(`document.body.innerText.includes('开始真实采集')`));
      await waitFor(async () => (await field({ action: 'status' })).data.service.state === 'ready');
      await js(`[...document.querySelectorAll('.field-sidebar button')].find(b=>b.textContent==='信号处理').click()`);
      await waitFor(() => js(`document.querySelector('select')?.options.length > 1`));
      await js(`{const s=document.querySelector('select'); s.value=${JSON.stringify(recordingId)};s.dispatchEvent(new Event('change',{bubbles:true}));}`);
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='开始分析').click()`);
      await waitFor(() => js(`document.body.innerText.includes('signal-1.0.0')`));
      assert.ok(await js(`document.body.innerText.includes('来源 simulation')`));
      for (const tab of ['FFT频谱', '时频分析', '滤波降噪', '包络谱', '频带能量', '平均波形', '特征值']) {
        await js(`[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent===${JSON.stringify(tab)}).click()`);
        await new Promise(r => setTimeout(r, 150));
        if (tab !== '平均波形' && tab !== '特征值') assert.ok(await js(`document.querySelectorAll('canvas').length > 0`));
      }
      const result = await field({ action: 'analysis', id: recordingId, parameters: { end: 16384, nfft: 16384 } });
      assert.equal(result.status, 200);
      assert.equal(result.data.features.dominantHz, 32);
      assert.ok(Math.abs(result.data.features.rms - Math.sqrt((0.2 ** 2 + 0.05 ** 2) / 2)) < 1e-8);
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result.data, null, 2));
      await js(`[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent==='FFT频谱').click(); document.querySelector('[role=tablist]').scrollIntoView({block:'start'});`);
      await new Promise(r => setTimeout(r, 200));
      fs.writeFileSync(path.join(output, 'fft.png'), (await win.webContents.capturePage()).toPNG());
      win.setSize(1024, 700);
      await new Promise(r => setTimeout(r, 200));
      assert.ok(await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
      fs.writeFileSync(path.join(output, 'fft-1024.png'), (await win.webContents.capturePage()).toPNG());
      console.log('PASS real Electron/Python analysis, authentication, all tabs, 32 Hz/RMS reference and 1024px layout');
      clearTimeout(watchdog);
      if (!interactive) { await field({ action: 'stop' }); win.close(); }
    } catch (e) { console.error(e); clearTimeout(watchdog); win.close(); app.exitCode = 1; }
  });
});
require('../apps/desktop/electron/field-main.cjs');
