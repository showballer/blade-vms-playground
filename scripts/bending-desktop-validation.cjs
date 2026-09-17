// Isolated real Electron -> IPC -> Python test. Never opens the user's recordings or hardware.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, scryptSync } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const serviceRoot = path.join(root, 'services/acquisition');
const python = process.env.BLADE_VALIDATION_PYTHON || path.join(serviceRoot, '.venv-build', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-bending-validation-'));
app.setPath('userData', profile);
const output = path.join(root, 'artifacts/bending-validation');
fs.mkdirSync(output, { recursive: true });
const fixture = spawnSync(python, ['tests/create_bending_fixture.py', path.join(profile, 'field-data')], {
  cwd: serviceRoot, env: { ...process.env, PYTHONPATH: serviceRoot }, encoding: 'utf8', windowsHide: true });
if (fixture.status !== 0) throw Error(fixture.stderr);
const input = JSON.parse(fixture.stdout);
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
const password = randomBytes(24).toString('hex'), nextPassword = randomBytes(24).toString('hex'), salt = randomBytes(32).toString('hex');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const serviceModule = require('../apps/desktop/electron/field-service.cjs');
const realFactory = serviceModule.createFieldService;
let isolatedService;
serviceModule.createFieldService = options => {
  const service = realFactory({ ...options, platform: 'win32', getConfig: () => ({ executable: process.execPath }),
    spawnImpl: (_file, _args, settings) => spawn(python, ['-m', 'blade_acquisition'], { ...settings, cwd: serviceRoot,
      env: { ...process.env, BLADE_SERVICE_PORT: settings.env.BLADE_SERVICE_PORT, BLADE_SERVICE_TOKEN: settings.env.BLADE_SERVICE_TOKEN,
        BLADE_DATA_DIR: settings.env.BLADE_DATA_DIR, BLADE_POLYTEC_DLL: '' }, windowsHide: true }) });
  service.begin = async () => { throw Error('No hardware allowed in isolated validation.'); };
  service.device = async () => { throw Error('No device control allowed in isolated validation.'); };
  isolatedService = service;
  return service;
};
delete process.env.BLADE_DEV_URL;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(async () => { console.error('Bending validation timed out'); await isolatedService?.shutdown({ force: true }); app.exit(1); }, 180000);
async function waitFor(fn) {
  const end = Date.now() + 45000;
  while (Date.now() < end) { if (await fn()) return; await pause(100); }
  throw Error('Bending UI validation timed out');
}
app.on('browser-window-created', (_event, win) => {
  win.setTitle('BladeVMS isolated bending validation — synthetic input');
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    const click = text => js(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
    const setInput = (selector, value) => js(`{const input=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(value))}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));}`);
    try {
      await field({ action: 'login', username: 'admin', password });
      await field({ action: 'changePassword', currentPassword: password, newPassword: nextPassword });
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await waitFor(() => js(`document.body.innerText.includes('开始真实采集')`));
      await waitFor(async () => (await field({ action: 'status' })).data.service.state === 'ready');
      await js(`document.querySelector('.field-sidebar button[title="固定 RPM 台架模型分析"]').click()`);
      await waitFor(() => js(`document.querySelectorAll('.field-rotation-records input[type=checkbox]').length===6`));
      for (let i = 0; i < input.positions.length; i++) {
        await js(`document.querySelectorAll('.field-rotation-records input[type=checkbox]')[${i}].click()`);
      }
      for (let i = 0; i < input.positions.length; i++) await setInput(`[aria-label='Simulation P${i+1} x/L']`, input.positions[i]);
      await setInput('.field-rotation-config label:nth-child(1) input', 600);
      await setInput('.field-rotation-config label:nth-child(6) input', 2);
      await click('开始恒转速分析');
      await waitFor(() => js(`document.body.innerText.includes('最接近第 2 阶弯曲模板')`));
      await waitFor(() => js(`document.querySelector('.field-bending-scores tr.selected')?.textContent.includes('第 2 阶')`));
      const result = await field({ action: 'rotation', parameters: { ...input, rpm: 600, targetOrder: 2, maxOrder: 5 } });
      assert.equal(result.status, 200);
      assert.equal(result.data.modalMatch.candidateMode, 2);
      assert.ok(result.data.modalMatch.candidates[1].mac > .99999);
      assert.equal((await field({ action: 'status' })).data.receiver.running, false);
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result.data, null, 2));
      await js(`document.querySelector('.field-bending-card').scrollIntoView({block:'start'})`);
      await pause(300);
      fs.writeFileSync(path.join(output, 'matching.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('.field-bending-toolbar').scrollIntoView({block:'start'})`);
      const firstFrame = await js(`document.querySelector('.field-bending-svg').innerHTML`);
      await click('播放动画'); await pause(400); await click('暂停动画');
      const pausedFrame = await js(`document.querySelector('.field-bending-svg').innerHTML`);
      assert.notEqual(firstFrame, pausedFrame);
      await pause(150);
      assert.equal(await js(`document.querySelector('.field-bending-svg').innerHTML`), pausedFrame);
      fs.writeFileSync(path.join(output, 'animation.png'), (await win.webContents.capturePage()).toPNG());
      await click('查看第 3 阶');
      await waitFor(() => js(`document.querySelector('.field-bending-scores tr.selected')?.textContent.includes('第 3 阶')`));
      await js(`{const select=document.querySelector('.field-bending-toolbar select');select.value='theory';select.dispatchEvent(new Event('change',{bubbles:true}));}`);
      await waitFor(() => js(`document.body.innerText.includes('理论模型预览 · 非实测')`));
      win.setSize(1024, 740); await pause(300);
      assert.ok(await js(`document.documentElement.scrollWidth <= innerWidth + 1`));
      fs.writeFileSync(path.join(output, 'theory-1024.png'), (await win.webContents.capturePage()).toPNG());
      console.log('PASS real Electron/Python mode-2 match, score selection, animation play/pause, theory switch, 1024px layout; no hardware');
      clearTimeout(watchdog);
      await field({ action: 'stop' }); win.close();
    } catch (error) {
      console.error(error); clearTimeout(watchdog);
      fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
      await isolatedService?.shutdown({ force: true }); app.exit(1);
    }
  });
});
require('../apps/desktop/electron/field-main.cjs');
