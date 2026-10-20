'use strict';
// Isolated renderer acceptance: no preload, actual service, serial port, laser,
// cloud upload, credentials, production user profile, or native movement.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'field-origin-ui-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-origin-ui-')));
const ui = path.join(root, 'packages/ui/src');
const fixture = `
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FieldTurntableWorkspace} from ${JSON.stringify(path.join(ui, 'field-auto-follow.tsx'))};
import {autoFollowStorageKey,defaultAutoFollowSurvey} from ${JSON.stringify(path.join(ui, 'field-auto-follow-config.ts'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable.css'))};
import ${JSON.stringify(path.join(ui, 'field-auto-follow.css'))};
const axis=(angle,limit,origin,soft=true)=>({output_angle_deg:angle,motor_rpm:0,actual_counts:1234,commanded_counts:1234,error_counts:0,display_mode:3,command_counts_per_rev:10000,encoder_bits:17,flags:soft?3:1,fault:0,origin_counts:origin,home_phase:0,observedAt:1792400000,referenceAngleDeg:0,guard:{soft_enabled:soft,hardware_enabled:false,minimum_deg:soft?-limit:0,maximum_deg:soft?limit:0}});
const initial={service:{state:'ready',dllConfigured:true,generation:1},state:'idle',turntableBusy:false,turntable:{state:'checked',port:'COM3',axis:1,connected:true,motionCapability:{supported:true,mode:'dual_axis_timed',protocol:'0x30-0x36',probe:'confirmed',status:null},feedback:{outputRpm:0,motorRpm:0,alarmCode:0,limitFlags:0,positionRaw:1234,axes:{'1':axis(10,35,101),'2':axis(0,180,202,false)}}}};
const oldPoint={pointId:'origin-existing-point',name:'既有绝对点',port:'COM3',referenceSignature:'[[101,3,10000,17],[202,3,10000,17]]',axis1AngleDeg:12,axis2AngleDeg:-3,recordedAt:1792400000000,axis1RawCounts:1234,axis2RawCounts:5678};
if(!localStorage.getItem('__originFixtureSeeded')){const survey=defaultAutoFollowSurvey();survey.settings.distanceM=3.3;survey.settings.hubHeightDeltaM=.85;survey.blades[0].points[0].radiusM=.078;localStorage.setItem(autoFollowStorageKey,JSON.stringify(survey));localStorage.setItem('blade-turntable-points-v2',JSON.stringify([oldPoint]));localStorage.setItem('__originFixtureSeeded','true');}
window.__originFixture={calls:[],statusUpdates:[],initial,oldPoint,ready:false,server:structuredClone(initial)};
function App(){
 const [status,setStatus]=useState(initial),[config,setConfig]=useState({name:'共用作业零点隔离验收',deviceIp:'198.51.100.10',hostIp:'198.51.100.11',object:'风机叶片',turbine:'WT01',point:''});
 const [mode,setMode]=useState('manual'),[selected,setSelected]=useState(''),[epoch,setEpoch]=useState(0);
 window.__originFixture.resetOrigins=()=>{localStorage.removeItem('blade-turntable-work-origins-v1');setEpoch(value=>value+1);};
 const live=useRef(status);live.current=status;
 window.__originFixture.inject=next=>{window.__originFixture.server=structuredClone(next);setStatus(structuredClone(next));};
 window.__originFixture.injectUiOnly=next=>setStatus(structuredClone(next));
 window.__originFixture.pose=(pitch,yaw,{busy=false,rpm=0,recallState='complete'}={})=>{
  const next=structuredClone(window.__originFixture.server);next.turntableBusy=busy;next.turntable.state=busy?'positioning':'stopped';next.turntable.stopConfirmed=!busy;
  next.turntable.feedback.axes['1'].output_angle_deg=pitch;next.turntable.feedback.axes['2'].output_angle_deg=yaw;
  next.turntable.feedback.axes['1'].motor_rpm=next.turntable.feedback.axes['2'].motor_rpm=rpm;
  next.turntable.feedback.motorRpm=rpm;next.turntable.feedback.outputRpm=rpm/50;
  if(next.turntable.recall)next.turntable.recall.state=recallState;
  window.__originFixture.server=structuredClone(next);setStatus(next);
 };
 const accept=next=>{window.__originFixture.statusUpdates.push(structuredClone(next));setStatus(next);};
 async function request(options){
  window.__originFixture.calls.push(structuredClone(options));
  if(options.action==='turntablePorts')return {ports:[{port:'COM3',description:'隔离端口3'},{port:'COM4',description:'隔离端口4'}]};
  if(options.action==='turntable'){
   if(options.request.action==='probe'){
    const reply=structuredClone(window.__originFixture.probeStatus||window.__originFixture.server);
    reply.turntable.port=options.request.port;reply.turntable.state='checked';reply.turntable.connected=false;
    if(window.__originFixture.holdProbe)await new Promise(resolve=>window.__originFixture.releaseProbe=resolve);
    return reply;
   }
   if(options.request.action==='recall'){
    if(window.__originFixture.recallError)throw Error('隔离测试：回原点指令失败');
    const reply=structuredClone(window.__originFixture.server);reply.turntableBusy=true;reply.turntable.state='positioning';reply.turntable.stopConfirmed=false;
    reply.turntable.recall={state:'moving',targets:[options.request.axis1AngleDeg,options.request.axis2AngleDeg],completedAxes:[]};
    window.__originFixture.server=structuredClone(reply);return reply;
   }
   if(options.request.action==='stop'&&window.__originFixture.stopReturn){
    if(window.__originFixture.stopError)throw Error('隔离测试：停止回位未确认');
    const reply=structuredClone(window.__originFixture.server);reply.turntableBusy=false;reply.turntable.state='stopped';reply.turntable.stopConfirmed=true;
    reply.turntable.feedback.motorRpm=reply.turntable.feedback.outputRpm=0;
    reply.turntable.feedback.axes['1'].motor_rpm=reply.turntable.feedback.axes['2'].motor_rpm=0;
    if(reply.turntable.recall)reply.turntable.recall.state='cancelled';
    window.__originFixture.server=structuredClone(reply);return reply;
   }
   // Capture the real renderer's absolute request without executing movement.
   if(options.request.action==='manual_move'||options.request.action==='stop')return structuredClone(live.current);
  }
  if(options.action==='status')return structuredClone(window.__originFixture.server);
  throw Error('隔离验收不允许此设备操作：'+JSON.stringify(options));
 }
 useEffect(()=>{window.__originFixture.ready=true;},[]);
 return <div className="field-app"><header className="field-header"><div className="field-brand">BladeVMS <small>共用作业零点隔离验收</small></div></header><div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button>数据采集</button><button className="active">转盘点位</button><button>本机记录</button></aside><main className="field-content"><div className="field-page-heading"><h1>转盘点位</h1></div><FieldTurntableWorkspace key={epoch} config={config} onConfig={setConfig} status={status} disabled={false} request={request} onStatus={accept} onService={()=>{}} onRecords={()=>{}} routeMode={mode} onRouteMode={setMode} autoTargetKey={selected} onAutoTarget={setSelected} onRoute={route=>{window.__originFixture.routes={...window.__originFixture.routes,[route.kind]:route};}} onAcquisition={()=>{}} /></main></div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true,
  outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BladeVMS 作业零点隔离验收</title><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const report = { hardwareTouched: false, realServiceStarted: false, productionUserDataTouched: false,
  nativeMotionExecuted: false, checks: [], screenshots: [], passed: false };
let win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript('(async()=>{return await eval(' + JSON.stringify(code) + ')})()', true);
const visibleButton = text => '[...document.querySelectorAll("button")].find(e=>!e.closest("[hidden]")&&e.textContent.trim()===' + JSON.stringify(text) + ')';
const labelSelector = label => '[aria-label=' + JSON.stringify(label) + ']';
const originSelector = 'button[aria-label="设置归零"]';
const restoreExpression = 'document.querySelector("button[aria-label=恢复设备坐标]")||' + visibleButton('恢复设备坐标');
async function waitFor(code, message = code) {
  for (let i = 0; i < 160; i++) { if (await run(code)) return; await pause(25); }
  throw Error('Timed out: ' + message);
}
async function click(text) {
  await run('(()=>{const e=' + visibleButton(text) + ';if(!e||e.disabled)throw Error("Button unavailable: "+' + JSON.stringify(text) + ');e.click();})()');
  await pause(45);
}
async function action(label) {
  const selector = 'button' + labelSelector(label);
  await run('(()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');if(!e||e.disabled)throw Error("Action unavailable: "+' + JSON.stringify(label) + ');e.click();})()');
  await pause(45);
}
async function input(label, value, allowDisabled = false) {
  await run('(()=>{const e=document.querySelector(' + JSON.stringify('input' + labelSelector(label)) + ');if(!e||e.disabled&&!'+JSON.stringify(allowDisabled)+')throw Error("Input unavailable: "+' + JSON.stringify(label) + ');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,' + JSON.stringify(String(value)) + ');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await pause(45);
}
const calls = () => run('window.__originFixture.calls');
const savedPoints = () => run('JSON.parse(localStorage.getItem("blade-turntable-points-v2"))');
const autoCycle = () => run('window.__originFixture.routes.auto.cycle');
const autoTargets = () => run('window.__originFixture.routes.auto.targets');
const hasOrigin = () => run('!!(' + restoreExpression + ')');
const requiresOpticalZero = () => run('window.__originFixture.routes.auto.targets.every(target=>target.route.cycle===null&&target.route.errors.some(error=>error.includes("公共光学零点需重新设置")))');
function assertOpticalBase(cycle, pitchBase, yawBase) {
  assert.ok(cycle, 'A physical route must exist');
  assert.equal(cycle.startAtCurrentPose, false, 'Common optical zero must not claim a point was aimed');
  assert.equal(cycle.points[0].axis2AngleDeg, yawBase);
  assert.equal(cycle.geometry.anchorAxis2AngleDeg, yawBase);
  const firstOpticalPitch = Math.atan2(cycle.geometry.hubHeightDeltaM - cycle.geometry.anchorRadiusM, cycle.geometry.distanceM) * 180 / Math.PI;
  assert.ok(Math.abs(cycle.geometry.anchorAxis1AngleDeg - (pitchBase + firstOpticalPitch)) < 1e-8);
  for (const point of cycle.points) {
    const phase = point.azimuthDeg * Math.PI / 180;
    const x = (cycle.geometry.rotationDirection === 'clockwise' ? -1 : 1) * point.radiusM * Math.sin(phase);
    const y = cycle.geometry.hubHeightDeltaM - point.radiusM * Math.cos(phase);
    const pitch = Math.atan2(y, Math.hypot(cycle.geometry.distanceM, x)) * 180 / Math.PI;
    const yaw = Math.atan2(x, cycle.geometry.distanceM) * 180 / Math.PI;
    assert.ok(Math.abs(point.axis1AngleDeg - (pitchBase + cycle.geometry.axis1Sign * pitch)) < 1e-5);
    assert.ok(Math.abs(point.axis2AngleDeg - (yawBase + cycle.geometry.axis2Sign * yaw)) < 1e-5);
  }
}
async function resetStatus() {
  await run('window.__originFixture.probeStatus=null;window.__originFixture.resetOrigins();window.__originFixture.inject(window.__originFixture.initial)');
  await pause(60);
}
async function zero() {
  await waitFor('document.querySelector(' + JSON.stringify(originSelector) + ')?.disabled===false');
  await action('设置归零'); await waitFor('!!(' + restoreExpression + ')', 'work origin applied');
}
async function restore() {
  await run('(()=>{const e=' + restoreExpression + ';if(!e||e.disabled)throw Error("Restore unavailable");e.click();})()');
  await pause(55); assert.equal(await hasOrigin(), false);
}
async function check(name, fn) { await fn(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
async function screenshot(name) { fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); report.screenshots.push(name); }
function finish(error) {
  report.passed = !error; if (error) report.error = error.stack;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  if (error) console.error(error); app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => finish(Error('Work-origin UI acceptance timeout')), 90000);
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1366, height: 768, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  await win.loadFile(path.join(output, 'index.html'));
  await waitFor('window.__originFixture?.ready&&window.__originFixture.routes?.manual&&window.__originFixture.routes?.auto');
  const original = (await savedPoints())[0];
  let baselineCycle;
  await check('默认不恢复作业零点，进入页面不读位置或下发指令', async () => {
    assert.equal(await hasOrigin(), false);
    assert.equal(await run('document.querySelector("button[aria-label=回到原点]").disabled'), true);
    assert.equal((await calls()).filter(item => item.action === 'turntable').length, 0);
    await click('自动跟随'); await input('自动跟随转盘串口', 'COM3');
    await waitFor('!!window.__originFixture.routes.auto.cycle'); baselineCycle = await autoCycle();
    assert.ok(baselineCycle.points[0].axis1AngleDeg > 0);
    await click('手动控制');
  });
  await check('设置归零只做一次fresh probe，轴2关闭软限位仍可建立软件零点', async () => {
    await input('手动控制目标角度', '10');
    await input('记录轴1角度', '10'); await input('记录轴2角度', '0');
    const before = (await calls()).length; await zero();
    const added = (await calls()).slice(before);
    assert.equal(added.length, 1); assert.equal(added[0].action, 'turntable');
    assert.equal(added[0].request.action, 'probe');
    assert.equal(await run('document.querySelector("input[aria-label=手动控制目标角度]").value'), '0');
    assert.equal(Number(await run('document.querySelector("input[aria-label=记录轴1角度]").value')), 0);
    assert.equal(Number(await run('document.querySelector("input[aria-label=记录轴2角度]").value')), 0);
    const feedbackText = await run('document.querySelector("[aria-label=转盘反馈]").textContent');
    assert.ok(feedbackText.includes('0.000°'));
    const header = await run('document.querySelector(".field-work-origin")?.textContent||document.querySelector("[aria-label=作业坐标设置]")?.textContent||""');
    assert.ok(header.includes('作业零点'), header);
    assert.equal(await run('document.querySelector("[aria-label=作业俯仰角]").textContent'), '0.000°');
    assert.equal(await run('document.querySelector("[aria-label=作业水平角]").textContent'), '0.000°');
    assert.deepEqual((await savedPoints())[0], original);
  });
  await check('相对输入1°实际请求绝对11°，记录和旧点库始终保留设备绝对角度', async () => {
    await input('手动控制目标角度', '1');
    await run('(()=>{const e=document.querySelector(".field-motion-block input[type=checkbox]");if(!e)throw Error("Motion consent missing");if(!e.checked)e.click();})()');
    await pause(50); await click('移动到目标点');
    const move = (await calls()).filter(item => item.action === 'turntable' && item.request.action === 'manual_move').at(-1);
    assert.equal(move.request.targetAngleDeg, 11); assert.equal(move.request.axis, 1);
    const bank = await run('JSON.parse(localStorage.getItem("blade-turntable-axes-v1"))');
    assert.equal(bank[1].targetAngleDeg, 11);
    await input('手动点位记录名称', '零点后保存'); await input('记录轴1角度', '2'); await input('记录轴2角度', '-3');
    const before = (await calls()).length; await click('读取并记录两轴角度');
    await waitFor('JSON.parse(localStorage.getItem("blade-turntable-points-v2")).length===2');
    assert.equal((await calls()).length, before);
    const records = await savedPoints(); assert.deepEqual(records[0], original);
    assert.equal(records[1].axis1AngleDeg, 12); assert.equal(records[1].axis2AngleDeg, -3);
    const firstRow = await run('document.querySelector("[aria-label=手动记录的转盘点位] tbody tr").textContent');
    assert.ok(firstRow.includes('2.000°'), firstRow);
    assert.deepEqual((await run('window.__originFixture.routes.manual.cycle.points')).map(point => point.axis1AngleDeg), [12, 12]);
  });
  await check('公共归零补偿自动路线的真实角度，恢复设备坐标只恢复显示，不清光学基准', async () => {
    await click('自动跟随'); await waitFor('!!document.querySelector(".field-auto-route tbody tr")');
    const compensatedCycle = await autoCycle();
    assertOpticalBase(compensatedCycle, 10, 0);
    assert.notDeepEqual(compensatedCycle, baselineCycle);
    assert.equal((await autoTargets())[0].route.referenceMode, undefined);
    assert.ok(compensatedCycle.points.every(point => point.referenceSignature === original.referenceSignature));
    await run('document.querySelector(".field-auto-route").open=true');
    const pitch = await run('document.querySelector(".field-auto-route tbody tr").cells[3].textContent');
    assert.equal(pitch, (compensatedCycle.points[0].axis1AngleDeg - 10).toFixed(3) + '°');
    const firstStation = await run('document.querySelector(".field-auto-point-angle").textContent');
    assert.ok(firstStation.includes((compensatedCycle.points[0].axis1AngleDeg - 10).toFixed(3)), firstStation);
    const before = (await calls()).length; await restore(); assert.equal((await calls()).length, before);
    assert.deepEqual(await autoCycle(), compensatedCycle);
    assert.equal(await run('document.querySelector(".field-auto-route tbody tr").cells[3].textContent'), compensatedCycle.points[0].axis1AngleDeg.toFixed(3) + '°');
    await click('手动控制');
    assert.equal(Number(await run('document.querySelector("input[aria-label=记录轴1角度]").value')), 12);
  });
  await check('非零水平基准避免首个点位回到设备yaw0，不同测点按自身半径计算，测点校准优先', async () => {
    await run('(()=>{const next=structuredClone(window.__originFixture.initial);next.turntable.feedback.axes["2"].output_angle_deg=7;window.__originFixture.probeStatus=next;window.__originFixture.inject(next);})()');
    await pause(60); await zero();
    await click('自动跟随'); assertOpticalBase(await autoCycle(), 10, 7);
    await click('添加测点'); await input('测点2半径', '.2');
    let targets = await autoTargets();
    const first = targets.find(target => target.bladeId === '2' && target.pointName === 'P1');
    const second = targets.find(target => target.bladeId === '2' && target.pointName === 'P2');
    assertOpticalBase(first.route.cycle, 10, 7); assertOpticalBase(second.route.cycle, 10, 7);
    assert.notEqual(first.route.cycle.points[0].axis1AngleDeg, second.route.cycle.points[0].axis1AngleDeg);
    assert.equal(first.route.referenceMode, undefined); assert.equal(second.route.referenceMode, undefined);
    await action('校准测点2');
    targets = await autoTargets();
    const calibrated = targets.find(target => target.bladeId === '2' && target.pointName === 'P2').route;
    assert.equal(calibrated.referenceMode, undefined);
    assert.equal(calibrated.cycle.startAtCurrentPose, true);
    assert.deepEqual([calibrated.cycle.points[0].axis1AngleDeg, calibrated.cycle.points[0].axis2AngleDeg], [10, 7]);
    assert.equal(calibrated.cycle.geometry.anchorAxis1AngleDeg, 10);
    assert.equal(calibrated.cycle.geometry.anchorAxis2AngleDeg, 7);
    assert.deepEqual(targets.find(target => target.bladeId === '2' && target.pointName === 'P1').route.cycle, first.route.cycle);
    const beforeRestore = await autoCycle(); await restore(); assert.deepEqual(await autoCycle(), beforeRestore);
    await run('document.querySelector("input[aria-label=选择测点1]").click()'); await pause(60);
    assertOpticalBase(await autoCycle(), 10, 7);
    await click('手动控制'); await resetStatus();
  });
  await check('fresh probe发现故障、运动、参考失效或俯仰软范围关闭时不能归零', async () => {
    for (const kind of ['fault', 'moving', 'reference', 'pitchSoftOff']) {
      await resetStatus();
      await run('(()=>{const next=structuredClone(window.__originFixture.initial);const axis=next.turntable.feedback.axes["1"];switch('+JSON.stringify(kind)+'){case "fault":axis.fault=2;break;case "moving":axis.motor_rpm=1;break;case "reference":axis.flags=2;axis.output_angle_deg=null;break;case "pitchSoftOff":axis.guard.soft_enabled=false;axis.flags=1;break;}window.__originFixture.probeStatus=next;})()');
      await action('设置归零'); await pause(60); assert.equal(await hasOrigin(), false, kind);
    }
    await resetStatus();
  });
  await check('probe完成回包仍标busy时必须拒绝，服务清理后busy=false才能设置零点', async () => {
    // The desktop bridge forwards the Python snapshot unchanged. A return from
    // inside try used to serialize turntableBusy before finally released it.
    const before = (await calls()).length, updates = await run('window.__originFixture.statusUpdates.length');
    await run('window.__originFixture.probeStatus={...structuredClone(window.__originFixture.initial),turntableBusy:true}');
    await action('设置归零');
    await waitFor('document.querySelector(".field-work-origin .field-error")?.textContent.includes("任务尚未结束")', 'busy response is rejected');
    assert.equal(await hasOrigin(), false);
    assert.equal(await run('window.__originFixture.statusUpdates.length'), updates, 'Busy feedback cannot replace the completed status');
    assert.equal(await run('window.__originFixture.probeStatus.turntableBusy'), true, 'The renderer must not erase a busy response');
    await run('window.__originFixture.probeStatus={...structuredClone(window.__originFixture.initial),turntableBusy:false}');
    await zero();
    assert.equal(await run('window.__originFixture.statusUpdates.at(-1).turntableBusy'), false);
    assert.equal(await run('window.__originFixture.statusUpdates.length'), updates + 1);
    const added = (await calls()).slice(before);
    assert.equal(added.length, 2);
    assert.ok(added.every(item => item.action === 'turntable' && item.request.action === 'probe'));
    await restore(); await resetStatus();
  });
  await check('参考签名或所选串口改变暂停使用已保存零点且不写设备', async () => {
    for (const kind of ['reference', 'port']) {
      await resetStatus(); await input('手动控制转盘串口', 'COM3'); await zero();
      const before = (await calls()).length;
      if (kind === 'port') await input('手动控制转盘串口', 'COM4');
      else await run('(()=>{const next=structuredClone(window.__originFixture.initial);'+(kind === 'reference' ? 'next.turntable.feedback.axes["1"].origin_counts++;' : 'next.service.generation=2;')+'window.__originFixture.inject(next);})()');
      await waitFor('!('+restoreExpression+')', 'origin invalidated: ' + kind);
      if (kind === 'reference') {
        await waitFor('window.__originFixture.routes.auto.targets.every(target=>target.route.cycle===null&&target.route.errors.some(error=>error.includes("公共光学零点需重新设置")))', 'changed reference blocks calculated routes');
        assert.equal(await autoCycle(), null, 'A changed reference must not produce an executable device-zero fallback');
      } else {
        assert.equal((await autoCycle()).port, 'COM3', 'Switching the manual port cannot erase the other port\'s saved optical basis');
      }
      assert.equal((await calls()).length, before);
    }
    await resetStatus(); await input('手动控制转盘串口', 'COM3');
  });
  await check('公共零点失效后保持待重设，重新归零才恢复补偿路线且不下发运动', async () => {
    assert.equal(await requiresOpticalZero(), true);
    const before = (await calls()).length;
    await zero(); await click('自动跟随');
    assertOpticalBase(await autoCycle(), 10, 0);
    assert.equal(await requiresOpticalZero(), false);
    const reads = (await calls()).slice(before).filter(item => item.action === 'turntable');
    assert.equal(reads.length, 1); assert.equal(reads[0].request.action, 'probe');
    await restore(); await click('手动控制');
  });
  await check('迟到probe不能把旧零点应用到新服务、新端口或已开始采集的状态', async () => {
    for (const kind of ['generation', 'reference', 'position', 'fault', 'stopWarning', 'port', 'acquiring']) {
      await resetStatus(); await input('手动控制转盘串口', 'COM3');
      await run('window.__originFixture.holdProbe=true;window.__originFixture.releaseProbe=null');
      await action('设置归零'); await waitFor('typeof window.__originFixture.releaseProbe==="function"');
      const updates = await run('window.__originFixture.statusUpdates.length');
      if (kind === 'port') await input('手动控制转盘串口', 'COM4', true);
      else {
        const mutation = {
          generation: 'next.service.generation=2;',
          reference: 'next.turntable.feedback.axes["1"].origin_counts++;',
          position: 'next.turntable.feedback.axes["1"].output_angle_deg=11;',
          fault: 'next.turntable.feedback.axes["1"].fault=2;',
          stopWarning: 'next.turntableWarning="隔离测试：上次停止尚未确认";',
          acquiring: 'next.state="acquiring";',
        }[kind];
        await run('(()=>{const next=structuredClone(window.__originFixture.initial);'+mutation+'window.__originFixture.inject(next);})()');
      }
      await pause(50); await run('window.__originFixture.holdProbe=false;window.__originFixture.releaseProbe()');
      await pause(90); assert.equal(await hasOrigin(), false, kind);
      assert.equal(await run('window.__originFixture.statusUpdates.length'), updates, kind);
    }
    await resetStatus(); await input('手动控制转盘串口', 'COM3');
  });
  await check('probe进行中的轮询busy不自我取消，但完成回包必须已经清busy', async () => {
    await run('window.__originFixture.holdProbe=true;window.__originFixture.releaseProbe=null');
    await action('设置归零'); await waitFor('typeof window.__originFixture.releaseProbe==="function"');
    const updates = await run('window.__originFixture.statusUpdates.length');
    await run('window.__originFixture.injectUiOnly({...structuredClone(window.__originFixture.initial),turntableBusy:true})');
    await pause(60);
    await run('window.__originFixture.holdProbe=false;window.__originFixture.releaseProbe()');
    await waitFor('!!('+restoreExpression+')', 'own probe may report busy');
    assert.equal(await run('window.__originFixture.statusUpdates.length'), updates + 1);
    assert.equal(await run('window.__originFixture.statusUpdates.at(-1).turntableBusy'), false);
    assert.equal(await run('document.querySelector("[aria-label=作业俯仰角]").textContent'), '0.000°');
    await restore();
  });
  await check('采集中归零禁用；重载只读核验后恢复保存坐标，不改写姿态或点位', async () => {
    await zero();
    await run('window.__originFixture.inject({...structuredClone(window.__originFixture.initial),state:"acquiring"})'); await pause(60);
    assert.equal(await run('document.querySelector('+JSON.stringify(originSelector)+').disabled'), true);
    const saved = await savedPoints();
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    await waitFor('window.__originFixture?.ready&&window.__originFixture.routes?.manual');
    await waitFor(restoreExpression, 'saved origin revalidated');
    assert.equal(await hasOrigin(), true); assert.deepEqual(await savedPoints(), saved);
    const reads = (await calls()).filter(item => item.action === 'turntable');
    assert.equal(reads.length, 1); assert.equal(reads[0].request.action, 'probe');
    assert.equal(await run('localStorage.getItem("blade-turntable-optical-origin-required-v1")'), 'true');
    await waitFor('!!window.__originFixture.routes.auto.cycle');
    assertOpticalBase(await autoCycle(), 10, 0);
  });
  await check('1366、1024及480窗口的归零工具栏和相对角度不造成页面横向溢出', async () => {
    await zero();
    for (const [width, height] of [[1366, 768], [1024, 768], [480, 800]]) {
      win.setContentSize(width, height); await pause(100);
      await run('document.querySelector(".field-turntable-workspace").scrollIntoView({block:"start"})'); await pause(50);
      assert.equal(await run('document.body.scrollWidth<=innerWidth+2&&document.querySelector(".field-content").scrollWidth<=document.querySelector(".field-content").clientWidth+2'), true);
      await screenshot('work-origin-' + width + '.png');
    }
    await click('自动跟随'); await waitFor('!!document.querySelector(".field-auto-route tbody tr")');
    await run('document.querySelector(".field-auto-route").open=true');
    assertOpticalBase(await autoCycle(), 10, 0);
    for (const [width, height] of [[1366, 768], [480, 800]]) {
      win.setContentSize(width, height); await pause(100);
      await run('document.querySelector(".field-auto-route").scrollIntoView({block:"center"})'); await pause(50);
      assert.equal(await run('document.body.scrollWidth<=innerWidth+2&&document.querySelector(".field-content").scrollWidth<=document.querySelector(".field-content").clientWidth+2'), true);
      await screenshot('auto-work-origin-' + width + '.png');
    }
    assert.equal((await calls()).some(item => item.action === 'turntable' && !['probe', 'manual_move'].includes(item.request.action)), false);
  });
  win.setContentSize(1366, 768); await pause(80); await click('手动控制');
  await run('window.__originFixture.stopReturn=true');
  const returnNotice = () => run('document.querySelector(".field-work-origin .field-success")?.textContent||""');
  const returnError = () => run('document.querySelector(".field-work-origin .field-error")?.textContent||""');
  const recallCount = () => run('window.__originFixture.calls.filter(call=>call.action==="turntable"&&call.request.action==="recall").length');
  const stopCount = () => run('window.__originFixture.calls.filter(call=>call.action==="turntable"&&call.request.action==="stop").length');
  async function beginReturn() {
    await waitFor('document.querySelector("button[aria-label=回到原点]")?.disabled===false');
    await action('回到原点');
    assert.equal(await run('!!document.querySelector("dialog[open]")'), false);
  }
  async function away() { await run('window.__originFixture.pose(12,3)'); await pause(65); }
  async function returnFinished() { await waitFor('!document.querySelector("button[aria-label=停止回原点]")', 'return owner finished'); }
  await check('恢复设备坐标仍保留回原点目标；先fresh读，再以绝对角和真实参考发双轴回位', async () => {
    await resetStatus(); if (await hasOrigin()) await restore();
    await zero(); await restore(); await away();
    const before = (await calls()).length; await beginReturn();
    await waitFor('!!document.querySelector("button[aria-label=停止回原点]")');
    const added = (await calls()).slice(before).filter(item => item.action === 'turntable');
    assert.equal(added[0].request.action, 'probe'); assert.equal(added[1].request.action, 'recall');
    assert.equal(added[1].request.port, 'COM3'); assert.equal(added[1].request.recordedPort, 'COM3');
    assert.equal(added[1].request.referenceSignature, original.referenceSignature);
    assert.deepEqual([added[1].request.axis1AngleDeg, added[1].request.axis2AngleDeg], [10, 0]);
    assert.equal(added[1].request.speedRpm, .6); assert.equal(added[1].request.maxMoveAccelerationDegS2, 3); assert.equal(added[1].request.confirmMotion, true);
    assert.equal(await hasOrigin(), false, 'Display restore is independent of the physical optical target');
    assert.equal((await returnNotice()).includes('已回到公共光学原点'), false);
    await run('window.__originFixture.pose(10,0,{busy:true,rpm:1,recallState:"complete"})'); await pause(400);
    assert.equal((await returnNotice()).includes('已回到公共光学原点'), false, 'Coordinates alone cannot confirm the axes stopped');
    await run('window.__originFixture.pose(10,0)'); await returnFinished();
    assert.ok((await returnNotice()).includes('已回到公共光学原点'), await returnError());
    assert.equal((await calls()).filter(item => item.action === 'turntable').at(-1).request.action, 'probe');
  });
  await check('改自动跟随速度后立即回原点使用新值，切手动标签也不回退固定低速', async () => {
    await resetStatus(); await zero(); await click('自动跟随');
    for (const [speed, acceleration, manual] of [[5,30,false],[1,10,true]]) {
      await input('两轴换点转速上限 · rpm',String(speed)); await input('换点加速度上限 · °/s²',String(acceleration));
      if(manual)await click('手动控制');
      await away();await action('回到原点');await waitFor('!!document.querySelector("button[aria-label=停止回原点]")');
      assert.equal(await run('!!document.querySelector("dialog[open]")'),false);
      const settings=await run('document.querySelector("[aria-label=回原点运动参数]").textContent');
      assert.ok(settings.includes('转速上限 '+speed+' rpm'));assert.ok(settings.includes('加速度上限 '+acceleration+' °/s²'));
      if(!manual)await screenshot('return-motion-direct-1366.png');
      const request=(await calls()).filter(c=>c.action==='turntable'&&c.request.action==='recall').at(-1).request;
      assert.equal(request.speedRpm,speed);assert.equal(request.maxMoveAccelerationDegS2,acceleration);
      assert.deepEqual([request.axis1AngleDeg,request.axis2AngleDeg],[10,0]);
      await run('window.__originFixture.pose(10,0)');await returnFinished();
      if(manual)await click('自动跟随');
    }
    await input('两轴换点转速上限 · rpm','0.6');await input('换点加速度上限 · °/s²','3');
  });
  await check('无效回位设置禁用动作；控制器精度向下取整并显示实际返回参数', async () => {
    const before=await recallCount();await input('换点加速度上限 · °/s²','');
    assert.equal(await run('document.querySelector("button[aria-label=回到原点]").disabled'),true);
    assert.equal(await recallCount(),before);
    await input('两轴换点转速上限 · rpm','0.231');await input('换点加速度上限 · °/s²','3.14159');
    const text=await run('document.querySelector("[aria-label=回原点运动参数]").textContent');
    assert.ok(text.includes('0.22 rpm'));assert.ok(text.includes('3.141 °/s²'));
    await input('两轴换点转速上限 · rpm','0.6');await input('换点加速度上限 · °/s²','3');
  });
  await check('重载后回原点继续使用已保存速度和加速度，无隐式运动', async () => {
    await input('两轴换点转速上限 · rpm','5');await input('换点加速度上限 · °/s²','30');
    await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
    await waitFor('window.__originFixture?.ready&&window.__originFixture.routes?.auto');await click('自动跟随');
    await run('window.__originFixture.stopReturn=true');
    await waitFor('document.querySelector("input[aria-label=自动跟随转盘串口]").value==="COM3"');
    assert.equal(await recallCount(),0);
    const text=await run('document.querySelector("[aria-label=回原点运动参数]").textContent');
    assert.ok(text.includes('5 rpm'));assert.ok(text.includes('30 °/s²'));
    await away();await beginReturn();await waitFor('!!document.querySelector("button[aria-label=停止回原点]")');
    const request=(await calls()).filter(c=>c.action==='turntable'&&c.request.action==='recall').at(-1).request;
    assert.equal(request.speedRpm,5);assert.equal(request.maxMoveAccelerationDegS2,30);
    await run('window.__originFixture.pose(10,0)');await returnFinished();
    await input('两轴换点转速上限 · rpm','0.6');await input('换点加速度上限 · °/s²','3');
  });
  await check('回位前参考签名、服务代际或目标软范围不匹配均不下发运动', async () => {
    for (const kind of ['reference', 'generation', 'targetRange']) {
      await resetStatus(); await zero(); await away();
      await run('(()=>{const next=structuredClone(window.__originFixture.initial);next.turntable.feedback.axes["1"].output_angle_deg=12;next.turntable.feedback.axes["2"].output_angle_deg=3;'+({reference:'next.turntable.feedback.axes["1"].origin_counts++;',generation:'next.service.generation++;',targetRange:'next.turntable.feedback.axes["1"].guard.minimum_deg=11;'})[kind]+'window.__originFixture.probeStatus=next;})()');
      const before = await recallCount(); await beginReturn(); await returnFinished();
      assert.equal(await recallCount(), before, kind); assert.ok(await returnError(), kind);
    }
    await resetStatus();
  });
  await check('回位前检查可取消，迟到probe不会触发回位或停止指令', async () => {
    await zero(); await away();
    await run('window.__originFixture.holdProbe=true;window.__originFixture.releaseProbe=null');
    const moves = await recallCount(), stops = await stopCount(); await beginReturn();
    await waitFor('typeof window.__originFixture.releaseProbe==="function"');
    await action('停止回原点'); await run('window.__originFixture.holdProbe=false;window.__originFixture.releaseProbe()');
    await returnFinished(); assert.equal(await recallCount(), moves); assert.equal(await stopCount(), stops);
    assert.ok((await returnNotice()).includes('未发送运动指令'));
  });
  await check('运动中停止回原点按钮可用，真实停止与fresh读回后显示已停止且不冒充到位', async () => {
    await resetStatus(); await zero(); await away();
    const before = await stopCount(); await beginReturn(); await waitFor('window.__originFixture.calls.some(call=>call.action==="turntable"&&call.request.action==="recall")&&document.querySelector("button[aria-label=停止回原点]")?.disabled===false');
    await action('停止回原点'); await returnFinished();
    assert.equal(await stopCount(), before + 1); assert.ok((await returnNotice()).includes('已停止回原点'));
    assert.equal((await returnNotice()).includes('已回到公共光学原点'), false);
    assert.equal((await calls()).filter(item => item.action === 'turntable').at(-1).request.action, 'probe');
  });
  await check('停止失败保留未确认与操作锁，重试停止经fresh读确认停稳才解锁', async () => {
    await resetStatus(); await zero(); await away(); await beginReturn();
    await waitFor('document.querySelector("button[aria-label=停止回原点]")?.disabled===false');
    await run('window.__originFixture.stopError=true'); const before = await stopCount(); await action('停止回原点');
    await waitFor('document.querySelector("button[aria-label=停止回原点]")?.textContent.includes("重试停止")', 'unconfirmed stop retains ownership');
    assert.equal(await stopCount(), before + 1);
    assert.equal(await run('document.querySelector("button[aria-label=设置归零]").disabled'), true);
    assert.equal(await run('document.querySelector("button[aria-label=回到原点]").disabled'), true);
    assert.equal((await returnNotice()).includes('已回到公共光学原点'), false);
    assert.ok((await returnError()).includes('停止未确认'));
    await run('window.__originFixture.stopError=false;(()=>{const next=structuredClone(window.__originFixture.server);next.turntable.feedback.axes["1"].guard.soft_enabled=false;next.turntable.feedback.axes["1"].flags=1;window.__originFixture.inject(next);})()');
    await action('停止回原点'); await returnFinished();
    assert.equal(await stopCount(), before + 2);
    assert.ok((await returnNotice()).includes('已停止回原点'));
    assert.equal(await run('document.querySelector("button[aria-label=设置归零]").disabled'), false);
    await resetStatus();
  });
  await check('服务报告complete但实际距原点超过0.1°时拒绝到位并尝试停止', async () => {
    await resetStatus(); await zero(); await away();
    const before = await stopCount(); await beginReturn();
    await waitFor('!!document.querySelector("button[aria-label=停止回原点]")');
    await run('window.__originFixture.pose(10.3,0)'); await returnFinished();
    assert.ok((await returnError()).includes('0.1°'), await returnError());
    assert.equal((await returnNotice()).includes('已回到公共光学原点'), false);
    assert.equal(await stopCount(), before + 1);
  });
  await check('回位指令异常保留失败提示并请求停止，不显示完成', async () => {
    await resetStatus(); await zero(); await away(); await run('window.__originFixture.recallError=true');
    const before = await stopCount(); await beginReturn(); await returnFinished();
    assert.ok((await returnError()).includes('回原点指令失败')); assert.equal(await stopCount(), before + 1);
    assert.equal((await returnNotice()).includes('已回到公共光学原点'), false);
    await run('window.__originFixture.recallError=false'); await resetStatus();
  });
  await check('回位preflight期间出现新参考位或保护范围时，旧probe不覆盖新状态也不发回位', async () => {
    for (const kind of ['reference', 'guard']) {
      await resetStatus(); await zero(); await away();
      await run('window.__originFixture.holdProbe=true;window.__originFixture.releaseProbe=null');
      const moves = await recallCount(); await beginReturn(); await waitFor('typeof window.__originFixture.releaseProbe==="function"');
      const updates = await run('window.__originFixture.statusUpdates.length');
      await run('(()=>{const next=structuredClone(window.__originFixture.initial);next.turntable.feedback.axes["1"].output_angle_deg=12;next.turntable.feedback.axes["2"].output_angle_deg=3;'+(kind === 'reference' ? 'next.turntable.feedback.axes["1"].origin_counts++;' : 'next.turntable.feedback.axes["1"].guard.minimum_deg=11;')+'window.__originFixture.inject(next);})()');
      await pause(60); await run('window.__originFixture.holdProbe=false;window.__originFixture.releaseProbe()'); await returnFinished();
      assert.equal(await recallCount(), moves, kind); assert.equal(await run('window.__originFixture.statusUpdates.length'), updates, kind);
    }
    await resetStatus();
  });
  clearTimeout(watchdog); finish();
} catch (error) { clearTimeout(watchdog); finish(error); } });
