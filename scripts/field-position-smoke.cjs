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
const info = () => ({ state: 'ready', dllConfigured: true, executable: 'TEST-ONLY-NO-HARDWARE', generation: 1 });
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
let rejectProbe = false, changeReferenceOnProbe = false, holdProbe = false, releaseProbe = null;
let missingReferenceOnProbe = false, disableSoftLimitOnProbe = false;
let pitchDriftOnProbe = 0;
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
      current.turntable.motionCapability = { supported: false, mode: 'sequential', protocol: null, probe: 'legacy-command-unsupported', status: null };
      if (request.action === 'probe') {
        if (holdProbe) await new Promise(resolve => { releaseProbe = resolve; });
        if (rejectProbe) throw Error('TEST ONLY 读取失败');
        if (changeReferenceOnProbe) current.turntable.feedback.axes['1'].origin_counts += 1;
        if (missingReferenceOnProbe) current.turntable.feedback.axes['1'].output_angle_deg = null;
        if (disableSoftLimitOnProbe) current.turntable.feedback.axes['1'].guard.soft_enabled = false;
        if (pitchDriftOnProbe) current.turntable.feedback.axes['1'].output_angle_deg += pitchDriftOnProbe;
      }
      if (request.action === 'prepare') {
        const { action, confirmMotion, ...config } = request;
        current.turntablePreparation = { config, ready: true, checkedAt: Date.now()/1000 };
      }
      if (request.action === 'manual_move') { current.turntableBusy = true; current.turntable.state = 'positioning'; }
      if (request.action === 'stop') current.turntableBusy = false;
      return snapshot();
    },
    begin: async config => {
      calls.push({ action: 'begin', config: structuredClone(config) });
      assert.equal(config.turntable, undefined);
      if (config.pointCycle) {
        assert.equal(config.confirmMotion, true); assert.equal(config.pointCycle.rssiTriggerEnabled, true);
        current.pointCycle = { state: 'capturing', processPhase: 'waiting_blade', currentPoint: config.pointCycle.points[0].name,
          port: config.pointCycle.port, cycles: config.pointCycle.cycles, dwellSeconds: config.pointCycle.dwellSeconds, speedRpm: config.pointCycle.speedRpm,
          pointCount: config.pointCycle.points.length, cycle: 1, point: 1, completedRecords: 0, totalRecords: config.pointCycle.points.length * config.pointCycle.cycles,
          rssiTriggerEnabled: true };
      } else current.pointCycle = null;
      current.state = 'acquiring'; current.receiver.running = true;
      current.recording = { id: 'a'.repeat(32), name: config.name, source: 'polytec_ivs500', status: 'incomplete', samples: 0,
        sampleRate: null, startedAt: Date.now()/1000, ...(config.pointCycle ? { turntable: { config: config.pointCycle }, pointCycle: { pointName: config.pointCycle.points[0].name, targetAxis1AngleDeg: 25, targetAxis2AngleDeg: 0 } } : {}) };
      return snapshot();
    },
    stop: async () => { calls.push({ action: 'capture-stop' }); current.state = 'idle'; current.receiver.running = false;
      current.turntableBusy = false; if (current.pointCycle) current.pointCycle.state = 'cancelled'; if (current.recording) current.recording.status = 'complete'; return snapshot(); },
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
      await pause(25);
      await wait("!document.querySelector('.field-confirm')&&!document.body.textContent.includes('正在检查并启动采集')", 'direct start finished preflight');
    };
    try {
      await wait("document.body.innerText.includes('登录现场工作台')",'login');
      await field({action:'login',username:'admin',password});
      await field({action:'changePassword',currentPassword:password,newPassword:nextPassword});
      const stale = {name:'TEST ONLY 联动采集',deviceIp:'192.0.2.90',hostIp:'192.0.2.10',object:'原测量对象',turbine:'原机组',point:'原测点',
        turntable:{port:'COM6',axis:1,speedRpm:.2,direction:'forward',durationSeconds:0,protocol:'position',targetAngleDeg:8}, pointCycle:{port:'COM6'}};
      const signature = JSON.stringify([1,2].map(axis => [100,3,10000,21]));
      const points = [1,2].map(index => ({pointId:'manual-'+index,name:'M0'+index,port:'COM6',referenceSignature:signature,
        axis1AngleDeg:25-index,axis2AngleDeg:index,recordedAt:index,bladeIndex:1,bladePointIndex:1,circleIndex:index,circleStepDeg:90}));
      await js(`localStorage.setItem('blade-field-config-v1',${JSON.stringify(JSON.stringify(stale))});localStorage.setItem('blade-turntable-points-v2',${JSON.stringify(JSON.stringify(points))})`);
      await reload();
      await wait("!!document.querySelector('.field-capture-setup')",'acquisition');
      const link = () => js("document.querySelector('[aria-label=联动转盘与测振仪]').click()");
      const begin = async () => { await click('开始采集','.field-capture-inputs'); await confirm(); };
      const stop = async () => { await click('停止并保存','.field-live-controls'); await wait("!document.querySelector('.field-live-controls')",'stopped'); };
      assert.equal(await js("document.querySelector('[aria-label=联动转盘与测振仪]').checked"),false);
      await begin(); await wait("!!document.querySelector('.field-live-controls')",'ordinary');
      const ordinary=calls.find(x=>x.action==='begin').config;
      assert.equal(ordinary.turntable,undefined); assert.equal(ordinary.pointCycle,undefined); assert.equal(ordinary.confirmMotion,undefined);
      assert.equal(calls.some(x=>['probe','prepare','manual_move'].includes(x.action)),false);
      await stop(); check('默认普通采集不继承旧运动草稿、不读取或控制转盘');
      await link(); await wait("document.querySelector('.field-link-blockers')",'route blockers');
      assert.equal(await js(`${button('开始采集','.field-capture-inputs')}.disabled`),true);
      await click('配置转盘点位'); await input('手动控制转盘串口','COM6'); await click('读取反馈');
      await wait("document.querySelector('.field-route-order').textContent.includes('M01')",'saved points');
      assert.equal(await js("!!document.querySelector('.field-joint-block')"),false);
      assert.equal(await js("!!document.querySelector('.field-turntable-workspace .field-capture-chart')"),false);
      await js("document.querySelector('[aria-label=\"采集点位 M02\"]').click()");
      await wait("document.querySelector('.field-route-order').textContent.trim()==='M01'",'deselected');
      await js("document.querySelector('[aria-label=\"采集点位 M02\"]').click()");
      await js("document.querySelector('[aria-label=\"上移点位 M02\"]').click()");
      await wait("document.querySelector('.field-route-order').textContent.trim()==='M02 → M01'",'ordered');
      check('既有手动点位参与采集，可排除和排序，无需填写单轴目标角度');
      await click('前往数据采集','.field-route-settings');
      await wait(`${button('开始采集','.field-capture-inputs')}.disabled===false`,'linked ready');
      fs.writeFileSync(path.join(output,'capture-link-summary.png'),(await win.webContents.capturePage()).toPNG()); report.screenshots.push('capture-link-summary.png');
      const initialBegins=calls.filter(x=>x.action==='begin').length;
      changeReferenceOnProbe=true; await begin();
      await wait("document.querySelector('.field-confirm .field-error')",'reference mismatch');
      assert.equal(calls.filter(x=>x.action==='begin').length,initialBegins);
      await click('取消','.field-confirm'); changeReferenceOnProbe=false;
      await click('转盘点位','.field-sidebar'); await click('读取反馈'); await click('前往数据采集','.field-route-settings');
      await wait(`${button('开始采集','.field-capture-inputs')}.disabled===false`,'restored');
      rejectProbe=true; await begin(); await wait("document.querySelector('.field-confirm .field-error')",'probe rejection');
      assert.equal(calls.filter(x=>x.action==='begin').length,initialBegins);
      await click('取消','.field-confirm'); rejectProbe=false;
      check('启动前重读两轴，读取失败或参考改变时不会开始采集和换点');
      holdProbe=true; await begin(); await wait("!!document.querySelector('.field-live-controls')",'pending controls');
      await wait('true','dispatch'); while(!releaseProbe) await pause(20);
      await click('停止并保存','.field-live-controls'); holdProbe=false; releaseProbe(); releaseProbe=null;
      await wait("!document.querySelector('.field-live-controls')",'cancelled probe');
      await pause(150); assert.equal(calls.filter(x=>x.action==='begin').length,initialBegins);
      check('启动检查期间仍可停止，迟到读取不会触发采集');
      await begin(); await wait("!!document.querySelector('.field-cycle-progress')",'linked capture');
      const joint=calls.filter(x=>x.action==='begin').at(-1).config;
      assert.deepEqual(joint.pointCycle.points.map(x=>x.name),['M02','M01']);
      assert.equal(joint.pointCycle.routeOrder,'configured'); assert.equal(joint.pointCycle.rssiTriggerEnabled,true);
      assert.equal(joint.turntable,undefined); assert.equal(joint.object,'原测量对象');
      await click('转盘点位','.field-sidebar'); assert.equal(await js(`${button('自动跟随','[role=tablist]')}.disabled`),true);
      await click('数据采集','.field-sidebar');
      current.recording=null; current.state='starting'; current.pointCycle.state='positioning'; current.pointCycle.processPhase='moving';
      await wait("document.querySelector('.field-cycle-progress').textContent.includes('正在移动到点位')",'between station progress');
      assert.equal(await js(`${button('停止并保存','.field-live-controls')}.disabled`),false);
      await stop(); check('手动路线透传已保存点位和顺序，换点期间仍显示进度并可停止');
      await click('转盘点位','.field-sidebar');
      for(const [width,height,zoom] of [[1366,768,1],[1024,600,1],[853,600,1],[1280,720,1.5]]) {
        win.unmaximize(); win.setMinimumSize(360,240); win.setContentSize(width,height); win.webContents.setZoomFactor(zoom); await pause(160);
        assert.equal(await js('document.documentElement.scrollWidth <= innerWidth+2'),true);
        await js("document.querySelector('.field-route-settings').scrollIntoView({block:'end',behavior:'instant'})"); await pause(150);
        const name=`joint-${width}-${zoom}.png`; fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG()); report.screenshots.push(name);
      }
      win.webContents.setZoomFactor(1); win.setContentSize(1366,768);
      const startAuto = async (bladeId, pointName) => {
        const before = calls.filter(item => item.action === 'begin').length;
        const label=`开始采集叶片 ${bladeId} 测点 ${pointName}`;
        const selector='[aria-label='+JSON.stringify(label)+']';
        await wait(`document.querySelector(${JSON.stringify(selector)})?.disabled===false`, label+' ready');
        await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await confirm();
        await wait("!!document.querySelector('.field-live-controls')", label+' running');
        for (let i = 0; i < 160 && calls.filter(item => item.action === 'begin').length === before; i++) await pause(50);
        assert.equal(calls.filter(item => item.action === 'begin').length, before + 1, 'Start must reach the fake acquisition worker');
      };
      await click('自动跟随','[role=tablist]'); await input('自动跟随转盘串口','COM6');
      await input('每个测点采集轮数','2');
      assert.equal(await js("document.querySelectorAll('.field-auto-point .field-badge.green').length"), 0);
      await click('前往数据采集','.field-auto-actions');
      const beforeAuto = calls.filter(item => item.action === 'begin').length;
      const requestAuto = async () => {
        await js("document.querySelector('[aria-label=\"开始采集叶片 2 测点 P1\"]').click()"); await confirm();
      };
      disableSoftLimitOnProbe = true; await requestAuto();
      await wait("document.querySelector('.field-confirm .field-error')?.textContent.includes('软限位')", 'missing real soft limit rejected');
      assert.equal(calls.filter(item => item.action === 'begin').length, beforeAuto);
      await click('取消', '.field-confirm'); disableSoftLimitOnProbe = false;
      missingReferenceOnProbe = true; await requestAuto();
      await wait("document.querySelector('.field-confirm .field-error')?.textContent.includes('两轴有效参考位')", 'invalid real reference rejected');
      assert.equal(calls.filter(item => item.action === 'begin').length, beforeAuto);
      await click('取消', '.field-confirm'); missingReferenceOnProbe = false;
      check('计算路线可以请求启动检查，但无真实参考位或软限位时不会启动采集');
      await startAuto('2','P1');
      const automatic=calls.filter(x=>x.action==='begin').at(-1).config.pointCycle;
      assert.equal(automatic.mode,'automatic_stations'); assert.equal(automatic.points.length,4); assert.equal(automatic.cycles,2); assert.equal(automatic.collectionId.length,32);
      assert.equal(automatic.startAtCurrentPose,false,'An uncalibrated theoretical route may position at its first station');
      assert.deepEqual([...new Set(automatic.points.map(x=>x.bladeId))],['2']);
      assert.ok(automatic.points.every(point => point.referenceSignature === signature && point.port === 'COM6'));
      const absolutePitch = Math.atan2(automatic.geometry.hubHeightDeltaM - automatic.geometry.anchorRadiusM, automatic.geometry.distanceM) * 180 / Math.PI;
      assert.ok(Math.abs(automatic.points[0].axis1AngleDeg - absolutePitch) < 1e-6);
      assert.equal(automatic.points[0].axis2AngleDeg, 0);
      assert.ok(Math.abs(automatic.geometry.anchorAxis1AngleDeg - absolutePitch) < 1e-6);
      assert.notEqual(automatic.points[0].axis1AngleDeg, 25, 'Uncalibrated route uses optical geometry, not the current motor angle');
      const collectionId=automatic.collectionId; await stop();
      await click('转盘点位','.field-sidebar'); await click('添加测点'); await input('测点2半径','0.2');
      await js("document.querySelector('[aria-label=\"校准测点2\"]').click()");
      await wait("document.querySelectorAll('.field-auto-point')[1].textContent.includes('已校准')", 'only selected point calibrated');
      await click('前往数据采集','.field-auto-actions');
      const beforeCalibrated = calls.filter(item => item.action === 'begin').length;
      pitchDriftOnProbe = .2;
      await js("document.querySelector('[aria-label=\"开始采集叶片 2 测点 P2\"]').click()"); await confirm();
      await wait("!!document.querySelector('.field-confirm .field-error')", 'calibrated first station drift rejected');
      assert.equal(calls.filter(item => item.action === 'begin').length, beforeCalibrated,
        'A fresh first-station drift must not reach begin or send an initial positioning move');
      assert.match(await js("document.querySelector('.field-confirm .field-error').textContent"), /首个点位|起点|当前.*位置|对准|当前位置/);
      await click('取消','.field-confirm'); pitchDriftOnProbe = 0;
      // Emulate physically returning to the calibrated pose and obtaining a new
      // readback. The rejected 25.2° feedback correctly keeps the row disabled.
      await field({ action: 'turntable', request: { action: 'probe', port: 'COM6', axis: 1 } });
      await startAuto('2','P2');
      const second=calls.filter(x=>x.action==='begin').at(-1).config.pointCycle;
      assert.equal(second.collectionId,collectionId); assert.notEqual(second.points[0].radialPointId,automatic.points[0].radialPointId);
      assert.equal(second.points.length,4); assert.deepEqual([...new Set(second.points.map(x=>x.radialPointName))],['P2']);
      assert.equal(second.points[0].axis1AngleDeg, 25, 'Optional per-point calibration overrides theoretical first-station angle');
      assert.equal(second.points[0].axis2AngleDeg, 0);
      assert.equal(second.startAtCurrentPose,true,'A calibrated first station must be read and held, not repositioned');
      await stop(); check('风机任务逐点启动配置的两轮，P1/P2独立采集且共用任务编号');
      check('校准点首个点位漂移超过0.1°被拒绝；重新对准后透传原地开始标记，不发初始补移');
      await click('转盘点位','.field-sidebar'); await click('添加叶片'); await input('目标叶片编号','3'); await input('测点1半径','0.31');
      await click('前往数据采集','.field-auto-actions');
      await wait("document.querySelectorAll('.field-auto-capture-blade').length===2",'two blades');
      await startAuto('3','P1');
      const third=calls.filter(x=>x.action==='begin').at(-1).config.pointCycle;
      assert.equal(third.collectionId,collectionId); assert.deepEqual([...new Set(third.points.map(x=>x.bladeId))],['3']);
      assert.equal(third.startAtCurrentPose,false,'The previous blade calibration must not bind another blade');
      assert.deepEqual([...new Set(third.points.map(x=>x.radialPointName))],['P1']);
      await stop(); check('不同叶片同名P1逐行启动，风机任务编号不因切换叶片拆分');
      for (const [width,height] of [[1366,900],[1024,768],[853,600]]) {
        win.setContentSize(width,height); await pause(160);
        await js("document.querySelector('.field-auto-capture-list').scrollIntoView({block:'start',behavior:'instant'})"); await pause(100);
        assert.equal(await js('document.documentElement.scrollWidth <= innerWidth+2'),true);
        assert.equal(await js("[...document.querySelectorAll('.field-auto-capture-actions .btn')].every(e => getComputedStyle(e).whiteSpace === 'nowrap' && e.getBoundingClientRect().height <= 40 && e.getBoundingClientRect().width >= 64)"),true);
        const name=`auto-targets-${width}.png`; fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG()); report.screenshots.push(name);
      }
      win.setContentSize(1366,768);

      await input('任务名称','TEST ONLY 第二台风机');
      await wait("document.querySelector('[aria-label=\"开始采集叶片 3 测点 P1\"]').disabled===false",'new turbine may use theoretical coordinates');
      assert.equal(await js("document.querySelectorAll('.field-auto-point .field-badge.green').length"), 0);
      await startAuto('3','P1');
      assert.notEqual(calls.filter(x=>x.action==='begin').at(-1).config.pointCycle.collectionId,collectionId);
      await stop(); check('切换风机清除旧光斑校准但可用计算角度开始，新归档编号不混入上一风机');
      await link(); await begin(); await wait("!!document.querySelector('.field-live-controls')",'ordinary again');
      assert.equal(calls.filter(x=>x.action==='begin').at(-1).config.pointCycle,undefined); await stop();
      await click('本机记录','.field-sidebar'); await wait("document.body.innerText.includes('TEST ONLY 旧联合采集')",'legacy');
      assert.equal(JSON.stringify(history),originalHistory); check('关闭联动恢复普通采集，既有记录未迁移或修改');
      await click('数据采集','.field-sidebar'); await input('任务名称','TEST ONLY 未启动的风机任务草稿');
      await reload(); await wait("document.querySelector('[aria-label=联动转盘与测振仪]')",'reload');
      assert.equal(await js("document.querySelector('[aria-label=任务名称]').value"),'TEST ONLY 未启动的风机任务草稿');
      assert.equal(await js("document.querySelector('[aria-label=联动转盘与测振仪]').checked"),false);
      check('重启不自动勾选联动或恢复校准，不会自动采集和运动');
      report.passed=true; report.platform=process.platform; report.beginCalls=calls.filter(x=>x.action==='begin').length;
      fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)); clearTimeout(watchdog);
      if(process.env.BLADE_QA_HOLD==='1') { await click('转盘点位','.field-sidebar'); console.log('QA_HOLD_READY'); }
      else app.exit(0);
    } catch(error) { clearTimeout(watchdog); report.error=error.stack; report.uiText=await js('document.body.innerText').catch(()=>null); report.calls=calls; fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)); console.error(error); app.exit(1); }
  });
});
require('../apps/desktop/electron/field-main.cjs');
