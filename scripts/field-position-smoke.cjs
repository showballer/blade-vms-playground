// Native production renderer/bridge contract with a disposable profile and fake service.
// No SDK, serial connection, real credentials, original recordings, or Web upload.
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'field-position-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-joint-ui-')));
delete process.env.BLADE_DEV_URL;
const password = randomBytes(24).toString('base64url'), nextPassword = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(password, salt, 64).toString('hex') } };
const info = () => ({ state: 'ready', dllConfigured: true, executable: 'TEST-ONLY-NO-HARDWARE' });
const axis = (angle, limit) => ({ output_angle_deg: angle, actual_counts: 1000, commanded_counts: 1000, error_counts: 0,
  display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 21, flags: 3, fault: 0, home_phase: 0, origin_counts: 100,
  motor_rpm: 0, observedAt: Date.now()/1000, guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const feedback = { axes: { '1': axis(25, 35), '2': axis(0, 90) }, motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: null, positionRaw: 1000 };
const history = [{ id: 'b'.repeat(32), name: 'TEST ONLY 旧联合采集', source: 'polytec_ivs500', samples: 2000, sampleRate: 1000,
  status: 'complete', startedAt: 1700000000, object: '', turbine: '', point: '', turntable: { config: { port: 'COM6', axis: 1 }, telemetry: { file: 'turntable.jsonl', events: 3 } } }];
const originalHistory = JSON.stringify(history);
let current = { state: 'idle', error: null, recording: null, turntableBusy: false, turntableWarning: null,
  turntable: { state: 'disconnected' }, receiver: { running: false }, waveform: { values: [], rssi: [], overrange: [], sampleRate: null, unit: 'm/s' } };
const calls = [];
let rejectPreparation = false, changeReferenceOnPrepare = false;
const snapshot = () => ({ ...structuredClone(current), service: info() });
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => snapshot(), status: async () => snapshot(), frame: async () => snapshot(),
    recordings: async () => ({ recordings: structuredClone(history) }), turntablePorts: async () => ({ ports: [{ port: 'COM6', description: 'TEST ONLY' }, { port: '/dev/cu.TEST_ONLY', description: 'TEST ONLY MAC' }] }),
    turntable: async request => {
      calls.push(structuredClone(request));
      if (request.confirmRecovery) current.turntableWarning = null;
      current.turntable = { state: request.action === 'stop' ? 'stopped' : 'checked', port: request.port, axis: request.axis, feedback: structuredClone(feedback) };
      if (request.action === 'prepare') {
        if (rejectPreparation) throw Error('TEST ONLY 参考位已变化');
        const { action, confirmMotion, ...config } = request;
        current.turntablePreparation = { config, ready: true, checkedAt: Date.now()/1000 };
        if (changeReferenceOnPrepare) current.turntable.feedback.axes['1'].origin_counts += 1;
      }
      if (request.action === 'manual_move') { current.turntableBusy = true; current.turntable.state = 'positioning'; }
      if (request.action === 'stop') current.turntableBusy = false;
      return snapshot();
    },
    begin: async config => {
      calls.push({ action: 'begin', config: structuredClone(config) });
      if (config.turntable) {
        assert.equal(config.confirmMotion, true); assert.equal(config.turntable.protocol, 'position');
        assert.deepEqual(config.turntable, current.turntablePreparation.config);
      }
      current.state = 'acquiring'; current.receiver.running = true;
      current.recording = { id: 'a'.repeat(32), name: config.name, source: 'polytec_ivs500', status: 'incomplete', samples: 0,
        sampleRate: null, startedAt: Date.now()/1000, ...(config.turntable ? { turntable: { config: config.turntable } } : {}) };
      return snapshot();
    },
    stop: async () => { calls.push({ action: 'capture-stop' }); current.state = 'idle'; current.receiver.running = false;
      current.turntableBusy = false; if (current.recording) current.recording.status = 'complete'; return snapshot(); },
    shutdown: async () => {} }),
} };
const report = { hardwareTouched: false, realServiceStarted: false, productionUserDataTouched: false, checks: [], screenshots: [], passed: false };
const watchdog = setTimeout(() => { console.error('Joint acquisition UI smoke timed out'); app.exit(1); }, 120000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = source => win.webContents.executeJavaScript(source, true);
    const field = value => js(`window.blade.field(${JSON.stringify(value)})`);
    const reload = () => new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    const button = (text, scope='body') => `([...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(e => e.textContent.trim() === ${JSON.stringify(text)}))`;
    const click = (text, scope) => js(`(() => { const e = ${button(text,scope)}; if (!e || e.disabled) throw Error('Button unavailable: '+${JSON.stringify(text)}); e.click(); })()`);
    const wait = async (source, label) => { for(let i=0;i<160;i++) { if(await js(source)) return; await pause(50); } throw Error('Timed out: '+label); };
    const input = (label, value) => js(`(() => { const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']'); if(!e || e.disabled) throw Error('Input unavailable: '+${JSON.stringify(label)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const check = label => { report.checks.push(label); console.log('PASS '+label); };
    const confirm = async () => {
      await wait("!!document.querySelector('.field-confirm')", 'confirmation');
      await js("document.querySelectorAll('.field-confirm input[type=checkbox]').forEach(e=>{if(!e.checked)e.click()})");
      await click('确认并开始采集');
    };
    try {
      await wait("document.body.innerText.includes('登录现场工作台')",'login');
      await field({action:'login',username:'admin',password});
      await field({action:'changePassword',currentPassword:password,newPassword:nextPassword});
      const stale = {name:'TEST ONLY 普通采集',deviceIp:'192.0.2.90',hostIp:'192.0.2.10',object:'原测量对象',turbine:'原机组',point:'原测点',
        turntable:{port:'COM6',axis:1,speedRpm:.2,direction:'forward',durationSeconds:0,protocol:'position',targetAngleDeg:8}, pointCycle:{port:'COM6'}};
      await js(`localStorage.setItem('blade-field-config-v1',${JSON.stringify(JSON.stringify(stale))})`);
      await reload();
      await wait("!!document.querySelector('.field-capture-setup')",'acquisition');
      assert.equal(await js("document.body.innerText.includes('联动转盘与测振仪')"),false);
      assert.equal(await js("!!document.querySelector('.field-turntable-setup')"),false);
      await click('开始采集','.field-capture-inputs'); await confirm();
      await wait("!!document.querySelector('.field-live-controls')",'ordinary running');
      const ordinary=calls.find(x=>x.action==='begin').config;
      assert.equal(ordinary.turntable,undefined); assert.equal(ordinary.pointCycle,undefined); assert.equal(ordinary.confirmMotion,undefined);
      assert.equal(calls.some(x=>x.action==='prepare'),false);
      await click('停止并保存','.field-live-controls'); await wait("!document.querySelector('.field-live-controls')",'ordinary stopped');
      check('遗留联动草稿不会使普通采集下发转盘或多点指令');
      await click('转盘点位','.field-sidebar');
      await input('手动控制转盘串口','COM6'); await input('手动控制目标角度',8); await input('手动定位转速',.3);
      await click('轴2 · 水平'); assert.equal(await js("document.querySelector('[aria-label=手动控制目标角度]').value"),'');
      await input('手动控制目标角度',-20); await input('手动定位转速',.5);
      await click('轴1 · 俯仰'); assert.equal(await js("document.querySelector('[aria-label=手动控制目标角度]').value"),'8');
      assert.equal(await js("document.querySelector('[aria-label=手动定位转速]').value"),'0.3');
      await click('轴2 · 水平'); await click('读取反馈');
      await wait(`${button('定位并采集','.field-joint-actions')}.disabled === false`,'joint available');
      check('手动模式共用串口与定位字段，两轴目标和速度独立保留');
      await input('联合采集任务名称','TEST ONLY 联合采集'); await input('联合采集自动停止秒数',12);
      rejectPreparation=true;
      const before=calls.filter(x=>x.action==='begin').length;
      await click('定位并采集','.field-joint-actions'); await confirm();
      await wait("document.querySelector('.field-confirm').textContent.includes('参考位已变化')",'prepare rejected');
      assert.equal(calls.filter(x=>x.action==='begin').length,before);
      await click('取消','.field-confirm'); rejectPreparation=false;
      check('联合启动现场检查失败时不启动采集或运动');
      changeReferenceOnPrepare=true;
      await click('定位并采集','.field-joint-actions'); await confirm();
      await wait("document.querySelector('.field-confirm').textContent.includes('参考位或计数单位已变化')",'reference changed');
      assert.equal(calls.filter(x=>x.action==='begin').length,before);
      await click('取消','.field-confirm'); changeReferenceOnPrepare=false;
      await click('读取反馈'); await wait(`${button('定位并采集','.field-joint-actions')}.disabled === false`,'reference restored');
      check('确认期间参考坐标变化时不把旧目标用于新参考');
      await click('定位并采集','.field-joint-actions');
      await wait("document.querySelector('.field-confirm').textContent.includes('定位至 -20°')",'correct axis confirmation');
      await confirm(); await wait("!!document.querySelector('.field-capture-workspace')",'waveform navigation');
      const joint=calls.filter(x=>x.action==='begin').at(-1).config;
      assert.deepEqual(joint.turntable,{port:'COM6',axis:2,speedRpm:.5,direction:'forward',durationSeconds:12,protocol:'position',targetAngleDeg:-20});
      assert.equal(joint.object,'原测量对象'); assert.equal(joint.turbine,'原机组'); assert.equal(joint.point,'原测点');
      const saved=await js("JSON.parse(localStorage.getItem('blade-field-config-v1'))"); assert.equal(saved.turntable,undefined);
      await click('转盘点位','.field-sidebar');
      assert.equal(await js(`${button('自动跟随','[role=tablist]')}.disabled`),true);
      await click('停止并保存','.field-joint-actions'); await wait("!document.querySelector('.field-live-controls')",'joint stopped');
      check('联合采集确认后按当前轴目标启动，切换到波形页，并可从手动模式停止保存');
      for(const [width,height,zoom] of [[1366,768,1],[1024,600,1],[853,600,1],[1280,720,1.5]]) {
        win.unmaximize(); win.setMinimumSize(360,240); win.setContentSize(width,height); win.webContents.setZoomFactor(zoom); await pause(160);
        assert.equal(await js('document.documentElement.scrollWidth <= innerWidth+2'),true);
        await js("document.querySelector('.field-joint-block').scrollIntoView({block:'start',behavior:'instant'})"); await pause(100);
        const name=`joint-${width}-${zoom}.png`; fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG()); report.screenshots.push(name);
      }
      check('手动定位采集在常规、小窗口及150%缩放下无横向溢出');
      await click('本机记录','.field-sidebar'); await wait("document.body.innerText.includes('TEST ONLY 旧联合采集')",'legacy record');
      assert.equal(JSON.stringify(history),originalHistory);
      check('已有联合记录继续显示，未迁移或修改历史记录');
      await click('转盘点位','.field-sidebar');
      await input('手动控制转盘串口','/dev/cu.TEST_ONLY'); await click('读取反馈');
      await wait(`${button('定位并采集','.field-joint-actions')}.disabled === false`,'Mac port available');
      await click('定位并采集','.field-joint-actions'); await confirm();
      await wait("!!document.querySelector('.field-live-controls')",'Mac joint running');
      assert.equal(calls.filter(x=>x.action==='begin').at(-1).config.turntable.port,'/dev/cu.TEST_ONLY');
      await click('停止并保存','.field-live-controls'); await wait("!document.querySelector('.field-live-controls')",'Mac stopped');
      check('COM 与 Mac 串口均通过同一联合采集入口和桥接');
      await click('转盘点位','.field-sidebar');
      current.turntableWarning='TEST ONLY 停止未确认';
      await wait("!!document.querySelector('[aria-label=确认现场停稳后恢复读取]')",'recovery warning');
      await js("document.querySelector('[aria-label=确认现场停稳后恢复读取]').click()");
      await click('读取反馈');
      await wait("!document.querySelector('[aria-label=确认现场停稳后恢复读取]')",'recovered');
      assert.equal(calls.filter(x=>x.action==='probe').at(-1).confirmRecovery,true);
      check('停止未确认时保留现场确认与读取恢复入口');
      await click('数据采集','.field-sidebar');
      const p=calls.filter(x=>x.action==='prepare').length;
      await click('开始采集','.field-capture-inputs'); await confirm();
      await wait("!!document.querySelector('.field-live-controls')",'second ordinary');
      assert.equal(calls.filter(x=>x.action==='begin').at(-1).config.turntable,undefined);
      assert.equal(calls.filter(x=>x.action==='prepare').length,p);
      await click('停止并保存','.field-live-controls'); await wait("!document.querySelector('.field-live-controls')",'finished');
      check('联合采集结束后返回普通采集，不继承转盘运动配置');
      report.passed=true; report.platform=process.platform; report.beginCalls=calls.filter(x=>x.action==='begin').length;
      fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
      clearTimeout(watchdog);
      if(process.env.BLADE_QA_HOLD==='1') {
        win.webContents.setZoomFactor(1); win.setContentSize(1280,800);
        await click('转盘点位','.field-sidebar'); win.setTitle('BladeVMS 界面验收（不连接设备）');
        console.log('QA_HOLD_READY');
      } else app.exit(0);
    } catch(error) { clearTimeout(watchdog); report.error=error.stack; report.uiText=await js('document.body.innerText').catch(()=>null); report.calls=calls; fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)); console.error(error); app.exit(1); }
  });
});
require('../apps/desktop/electron/field-main.cjs');
