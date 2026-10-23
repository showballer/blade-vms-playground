// Built renderer + real IPC, isolated profile and in-memory device service only.
'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/capture-state-audit-20261023'); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-capture-audit-')));
delete process.env.BLADE_DEV_URL;
global.fetch = async () => { throw Error('External network disabled in readiness fixture'); };
const secret = randomBytes(24).toString('base64url'), salt = randomBytes(32).toString('hex');
const bootstrap = path.join(root, 'apps/desktop/electron/bootstrap-admin.json');
require.cache[require.resolve(bootstrap)] = { id: bootstrap, filename: bootstrap, loaded: true,
  exports: { version: 1, username: 'admin', salt, hash: scryptSync(secret, salt, 64).toString('hex') } };
const port = 'tcp://192.168.10.50:5000', signature = JSON.stringify([[0, 3, 10000, 17], [0, 3, 10000, 17]]);
const origin = { port, generation: 1, referenceSignature: signature, axis1AngleDeg: 1.212, axis2AngleDeg: .015 };
const axis = (angle, limit) => ({ output_angle_deg: angle, motor_rpm: 0, actual_counts: 0, commanded_counts: 0, error_counts: 0,
  display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 3, fault: 0, origin_counts: 0, home_phase: 0,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const info = () => ({ state: 'ready', dllConfigured: true, generation: serviceGeneration });
const laser = () => ({ deviceIp: '192.168.106.90', state: 'unknown', readAt: null, source: 'unavailable', busy: false });
let controller, acquiring = false, pointCycle, failProbe = true, invalidReference = false;
let serviceGeneration = 2, stateOverride, failStart = false, failStop = false, holdStart, releaseStart, returnFault = false, failOriginStop = false;
const checks = [];
const checked = name => { checks.push(name); console.log('PASS ' + name); };
const calls = [];
const status = () => structuredClone({ state: stateOverride || (acquiring ? 'acquiring' : 'idle'), receiver: { running: acquiring },
  service: info(), laserStatus: laser(), turntable: controller, pointCycle, turntableBusy: false });
function feedback() {
  controller ??= { port, axis: 1, motionCapability: { supported: false, mode: 'sequential', protocol: null, probe: 'legacy-command-unsupported', status: null },
    feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0,
      axes: { '1': axis(origin.axis1AngleDeg, 35), '2': axis(origin.axis2AngleDeg, 180) } } };
  controller.state = 'checked'; controller.feedback.observedAt = Date.now() / 1000;
  controller.feedback.axes['1'].origin_counts = invalidReference ? 1 : 0;
  return status();
}
const serviceFile = path.join(root, 'apps/desktop/electron/field-service.cjs');
require.cache[require.resolve(serviceFile)] = { id: serviceFile, filename: serviceFile, loaded: true, exports: {
  failure: (message, status = 503) => Object.assign(Error(message), { status }),
  createFieldService: () => ({ serviceInfo: info, start: async () => status(), status: async () => status(), frame: async () => status(),
    shutdown: async () => {}, recordings: async () => ({ recordings: [] }), device: async () => laser(),
    turntablePorts: async () => ({ ports: [] }),
    turntable: async request => {
      calls.push({ action: request.action, port: request.port });
      assert.equal(request.port, port);
      if (request.action === 'probe') { if (failProbe) throw Error('fixture first probe unavailable'); return feedback(); }
      if (request.action === 'health') {
        feedback(); controller.health = {readOnly:true,readAt:Date.now()/1000,referenceChangedDuringRead:false,
          axes:{'1':{alarmCode:0,limitFlags:0},'2':{alarmCode:0,limitFlags:0}}}; return status();
      }
      if (request.action === 'clear_guard_fault') {
        feedback(); controller.feedback.axes['1'].fault = 0; controller.error = null;
        controller.recovery = {action:request.action,axis:1,verified:true}; return status();
      }
      if (request.action === 'stop') { if(failOriginStop)throw Error('fixture stop reply unavailable'); return feedback(); }
      assert.equal(request.action, 'recall');
      if(returnFault) { feedback(); controller.feedback.axes['1'].fault=8; controller.error='fixture positioning fault';
        controller.recall={state:'error',targets:[request.axis1AngleDeg,request.axis2AngleDeg],completedAxes:[]};return status(); }
 assert.equal(request.referenceSignature, signature);
      assert.equal(request.axis2AngleDeg, .015, 'First radial point retains the saved yaw offset');
      feedback(); controller.feedback.axes['1'].output_angle_deg = request.axis1AngleDeg;
      controller.feedback.axes['2'].output_angle_deg = request.axis2AngleDeg;
      controller.recall = { state: 'complete', targets: [request.axis1AngleDeg, request.axis2AngleDeg], completedAxes: [1, 2] };
      return status();
    },
    begin: async config => {
      calls.push({ action: 'start', kind: config.pointCycle?.mode || 'ordinary' });
      if(failStart)throw Error('fixture start rejected');
      if(holdStart)await new Promise(resolve=>releaseStart=resolve);
      if(config.pointCycle) {
        assert.equal(config.pointCycle.port,port); const first=config.pointCycle.points[0];
        assert.equal(first.referenceSignature,signature);
        assert.equal(first.axis1AngleDeg,controller.feedback.axes['1'].output_angle_deg);
        assert.equal(first.axis2AngleDeg,controller.feedback.axes['2'].output_angle_deg);
        assert.equal(calls.filter(call=>call.action==='recall').length,1,'No repeated positioning');
      }
      acquiring=true; stateOverride=undefined;
      pointCycle=config.pointCycle?{...config.pointCycle,state:'capturing',pointCount:2,cycle:1,point:1,completedRecords:0}:undefined;
      return status();
    },
    stop: async () => { calls.push({action:'stop'}); if(failStop){stateOverride='stopping';throw Error('fixture save reply unavailable');}
      acquiring=false;stateOverride=undefined;pointCycle=pointCycle?{...pointCycle,state:'cancelled'}:undefined;return status(); },
  }) } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win; const watchdog = setTimeout(() => finish(Error('Readiness UI fixture timed out')), 60000);
function finish(error) {
  clearTimeout(watchdog);
  const result = { passed: !error, hardwareAccessed: false, externalNetworkAccessed: false, checks, calls,
    ...(error ? { error: error.stack } : {}) };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); app.exit(error ? 1 : 0);
}
app.on('browser-window-created', (_, window) => {
  if (win) return; win = window; win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const wait = async code => { for (let i = 0; i < 160; i++) { if (await js(code)) return; await pause(40); } throw Error('Missing UI: ' + code); };
    const click = text => js(`(() => { const b=[...document.querySelectorAll('button')].find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.trim()===${JSON.stringify(text)}); if(!b)throw Error('Missing enabled button: '+${JSON.stringify(text)});b.click(); })()`);
    const field = options => js(`window.blade.field(${JSON.stringify(options)})`);
    try {
      await wait(`document.body.innerText.includes('登录现场工作台')`);
      assert.equal((await field({ action: 'login', username: 'admin', password: secret })).status, 200);
      assert.equal((await field({ action: 'changePassword', currentPassword: secret, newPassword: randomBytes(24).toString('base64url') })).status, 200);
      await js(`localStorage.setItem('blade-field-config-v1',JSON.stringify({name:'Readiness fixture',deviceIp:'192.168.106.90',hostIp:'192.168.106.10',object:'',turbine:'',point:''}));
        localStorage.setItem('blade-turntable-connection-v1',JSON.stringify({version:1,endpoint:${JSON.stringify(port)}}));
        localStorage.setItem('blade-turntable-work-origins-v1',JSON.stringify({version:1,work:${JSON.stringify(origin)},optical:${JSON.stringify(origin)}}));
        localStorage.setItem('blade-turntable-optical-origin-required-v1','true');`);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await wait(`!!document.querySelector('.field-sidebar')`); await click('转盘点位'); await click('自动跟随');
      await pause(250); assert.ok(calls.some(call => call.action === 'probe'));
      await click('数据采集');
      await js(`document.querySelector('[aria-label="联动转盘与测振仪"]').click()`);
      await wait(`!!document.querySelector('[aria-label="风机叶片逐点采集"]')`);
      const actions = `document.querySelector('[aria-label="风机叶片逐点采集"]')`;
      await wait(`![...${actions}.querySelectorAll('button')].find(b=>b.textContent.trim()==='移动到预设位置').disabled`);
      assert.equal(await js(`[...${actions}.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始采集').disabled`), false);
      fs.writeFileSync(path.join(output, 'pending-origin.png'), (await win.webContents.capturePage()).toPNG());
      await click('移动到预设位置');await wait(`document.body.innerText.includes('fixture first probe unavailable')`);
      await wait(`![...${actions}.querySelectorAll('button')].find(b=>b.textContent.trim()==='移动到预设位置').disabled`);
      checked('预定位读取失败后按钮恢复，未下发运动');
      failProbe = false;
      await click('移动到预设位置'); await wait(`document.body.innerText.includes('已到预设位置并停稳')`);
      assert.equal(calls.filter(call => call.action === 'recall').length, 1);
      failStart=true;
      await click('开始采集');await wait(`document.body.innerText.includes('fixture start rejected')`);
      await wait(`![...${actions}.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始采集').disabled`);
      checked('启动失败释放按钮，可直接重试且不重复预定位');
      failStart=false;
      await click('开始采集');await wait(`document.body.innerText.includes('已向设备发送采集请求')`);
      assert.equal(calls.filter(call=>call.action==='recall').length,1);
      failStop=true;await click('停止并保存');await wait(`document.body.innerText.includes('fixture save reply unavailable')`);
      await wait(`![...${actions}.querySelectorAll('button')].find(b=>b.textContent.trim()==='停止并保存').disabled`);
      failStop=false;await click('停止并保存');await wait(`!document.querySelector('[aria-label="采集安全控制"]')`);
      checked('停止失败保留运行保护，停止按钮可重试，成功后恢复采集');
      holdStart=true;releaseStart=undefined;await click('开始采集');
      for(let i=0;i<100&&!releaseStart;i++)await pause(30);
      assert.equal(typeof releaseStart,'function');
      const stopsBefore=calls.filter(c=>c.action==='stop').length;
      await click('停止并保存');holdStart=false;releaseStart();
      await wait(`!document.querySelector('[aria-label="采集安全控制"]')`);
      assert.equal(acquiring,false);assert.equal(calls.filter(c=>c.action==='stop').length,stopsBefore+1);
      checked('启动回包未返回时可取消，晚到启动不会覆盖停止结果');
      invalidReference = true;
      await click('移动到预设位置');
      await wait(`document.body.innerText.includes('参考位') && !!document.querySelector('[role="alert"]')`);
      assert.equal(calls.filter(call => call.action === 'recall').length, 1, 'Changed reference must not move');
      invalidReference=false;feedback();await pause(1200);
      pointCycle={...pointCycle,state:'positioning'};
      await click('转盘点位');await click('自动跟随');
      await wait(`!document.querySelector('input[aria-label="叶轮每圈时间 · s"]').disabled`);
      checked('历史换点阶段不锁住空闲配置，参考变化仍阻止错误运动');
      for(const recovery of ['health','generation']) {
        returnFault=true;failOriginStop=true;
        await click('回到原点');
        await wait(`document.body.innerText.includes('停止尚未确认，请在转盘状态中')`);
        await wait(`!document.querySelector('[aria-label="检查转盘状态"]').disabled`);
        if(recovery==='health') {
          await click('转盘状态');await wait(`document.body.innerText.includes('清除执行故障')`);
          await click('清除执行故障');
          await wait(`document.body.innerText.includes('新反馈已确认两轴停止')`);
          await js(`document.querySelector('dialog button[aria-label="关闭弹窗"]').click()`);
        } else {
          serviceGeneration++;controller=undefined;feedback();
          await wait(`document.body.innerText.includes('连接或服务已变化')`);
        }
        await wait(`!document.querySelector('[aria-label="回到原点"]').disabled`);
        returnFault=false;failOriginStop=false;
        checked(recovery==='health'?'回原点停止未确认时仍可打开状态并清故障，fresh核验后解锁':'服务重启丢弃旧停止等待，不自动运动且保留原点坐标');
      }
      await click('数据采集');
      await js(`document.querySelector('[aria-label="联动转盘与测振仪"]').click()`);
      await wait(`![...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()==='开始采集').disabled`);
      await click('开始采集');await wait(`document.body.innerText.includes('已向设备发送采集请求')`);
      assert.equal(pointCycle,undefined);
      await click('停止并保存');await wait(`!document.querySelector('[aria-label="采集安全控制"]')`);
      checked('联动切回普通采集不带入旧点位任务，停止后可继续操作');
      fs.writeFileSync(path.join(output,'recovered.png'),(await win.webContents.capturePage()).toPNG());
      finish();
    } catch (error) { fs.writeFileSync(path.join(output,"failure-ui.txt"),await js("document.body.innerText"));fs.writeFileSync(path.join(output,"failure.png"),(await win.webContents.capturePage()).toPNG());finish(error); }
  });
});
require(path.join(root, 'apps/desktop/electron/field-main.cjs'));
