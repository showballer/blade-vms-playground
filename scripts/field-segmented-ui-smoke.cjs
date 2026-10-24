'use strict';
// Isolated renderer integration test. No production preload, user profile, service or hardware.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'packages/ui/src');
const output = path.join(root, 'artifacts/segmented-ui-smoke');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-segmented-ui-'));
app.setPath('userData', profile);
fs.mkdirSync(output, { recursive: true });
const fixture = `
import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FieldTurntableWorkspace} from ${JSON.stringify(path.join(ui, 'field-auto-follow.tsx'))};
import {defaultAutoFollowSurvey,autoFollowStorageKey,generateAutoFollowBladePoints} from ${JSON.stringify(path.join(ui, 'field-auto-follow-config.ts'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable.css'))};
import ${JSON.stringify(path.join(ui, 'field-auto-follow.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable-health.css'))};
const axis=(angle,limit)=>({output_angle_deg:angle,motor_rpm:0,actual_counts:0,commanded_counts:0,error_counts:0,display_mode:3,command_counts_per_rev:10000,encoder_bits:17,flags:3,fault:0,origin_counts:0,home_phase:0,observedAt:Date.now()/1000,referenceAngleDeg:0,guard:{soft_enabled:true,hardware_enabled:false,minimum_deg:-limit,maximum_deg:limit}});
const initial={service:{state:'ready',dllConfigured:true,generation:1},state:'idle',turntable:{state:'idle',port:'COM3',connected:true,motionCapability:{supported:true,mode:'dual_axis_timed',pointMode:'drive_internal',preloadedPoints:true,protocol:'0x30-0x36',probe:'confirmed',status:null},feedback:{outputRpm:0,motorRpm:0,alarmCode:0,limitFlags:0,positionRaw:0,axes:{'1':axis(0,35),'2':axis(0,180)}}}};
if(!localStorage.getItem(autoFollowStorageKey)){
 const survey=defaultAutoFollowSurvey();let point=0;
 survey.settings={...survey.settings,distanceM:2.5,periodSeconds:5,stepDeg:90,maxMoveRpm:5,maxMoveAccelerationDegS2:30};
 survey.heights={hubHeightM:1.5,laserHeightM:.77};
 survey.port='COM3';survey.blades=[{id:'blade-test',name:'2',lengthM:.8,rootReservePercent:20,tipReservePercent:10,points:generateAutoFollowBladePoints(.8,20,10,()=> 'p'+(++point))}];
 survey.selectedBladeId='blade-test';survey.selectedPointId='p1';localStorage.setItem(autoFollowStorageKey,JSON.stringify(survey));
}
window.__segmentedFixture={initial,calls:[],positions:[],routes:{},hardwareUsed:false,profiles:{1:{accel_ms:1500,decel_ms:1500,s_curve_ms:100},2:{accel_ms:1200,decel_ms:1300,s_curve_ms:50}}};
function App(){
 const [status,setStatus]=useState(initial),[config,setConfig]=useState({name:'隔离分段测试',deviceIp:'198.51.100.90',hostIp:'198.51.100.10',object:'风机叶片',turbine:'T1',point:''});
 const [mode,setMode]=useState('segmented'),[key,setKey]=useState(''),[positioned,setPositioned]=useState();
 window.__segmentedFixture.positionAt=angle=>{const route=window.__segmentedFixture.routes.segmented;const point=route.cycle.segmentStations.find(p=>p.azimuthDeg===angle);setPositioned({kind:'segmented',sequence:Date.now(),port:'COM3',generation:1,targetKey:route.selectedTargetKey,pointId:point.pointId,azimuthDeg:angle});};
 window.__segmentedFixture.inject=next=>setStatus(next);
 window.__segmentedFixture.select=next=>setKey(next);
 window.__segmentedFixture.changeTask=name=>setConfig(previous=>({...previous,name}));
 const request=async options=>{
  const fixture=window.__segmentedFixture;fixture.calls.push(options);
  if(options.action==='turntablePorts')return {ports:[{port:'COM3',description:'隔离假设备'}]};
  if(options.action==='turntable'&&options.request.action==='probe')return structuredClone(initial);
  if(options.action==='turntable'&&['read_motion_profile','set_motion_profile'].includes(options.request.action)){
   const {axis,action,motionProfile,expectedMotionProfile}=options.request;
   if(fixture.holdProfile){fixture.holdProfile=false;await new Promise(resolve=>{fixture.releaseProfile=resolve;});}
   if(action==='set_motion_profile'){
    if(JSON.stringify(expectedMotionProfile)!==JSON.stringify(fixture.profiles[axis]))throw Error('Stale drive parameters');
    fixture.profiles[axis]=structuredClone(motionProfile);
   }
   const next=structuredClone(initial);
   next.turntable.motionProfile={axis,values:structuredClone(fixture.profiles[axis]),operation:action==='read_motion_profile'?'read':'write',verified:true,temporary:true,readAt:Date.now()/1000};
   return next;
  }
  throw Error('Unexpected request in isolated test');
 };
 useEffect(()=>{window.__segmentedFixture.ready=true;},[]);
 return <div className="field-app"><header className="field-header"><div className="field-brand">BladeVMS <small>分段采集界面验收 · 不连接设备</small></div></header><main className="field-content"><FieldTurntableWorkspace config={config} onConfig={setConfig} status={status} disabled={false} request={request} onStatus={setStatus} onService={()=>{}} onRecords={()=>{}} connectionPort="COM3" routeMode={mode} onRouteMode={setMode} autoTargetKey={key} onAutoTarget={setKey} onRoute={route=>{window.__segmentedFixture.routes={...window.__segmentedFixture.routes,[route.kind]:route};}} positionedStation={positioned} onAcquisition={()=>{}} /></main></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true,
  outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &apos;self&apos;; style-src &apos;self&apos; &apos;unsafe-inline&apos;; script-src &apos;self&apos;; img-src &apos;self&apos; data:"><title>分段采集隔离验收</title><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const report = { hardwareUsed: false, realServiceStarted: false, productionUserDataTouched: false, checks: [], screenshots: [], rendererErrors: [] };
let win, currentCase = 'startup';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true).catch(error => { throw Error(error.message + "\nRenderer code: " + code); });
async function waitFor(code) {
  for (let i = 0; i < 120; i++) { if (await run(code)) return; await pause(25); }
  throw Error('Timeout: ' + code);
}
async function check(name, fn) { currentCase = name; await fn(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
async function tab(name) {
  await run(`(()=>{const e=[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.trim()===${JSON.stringify(name)});if(!e||e.disabled)throw Error('Tab unavailable');e.click();})()`);
  await pause(50);
}
async function choose(label, text) {
  await run(`(()=>{const e=document.querySelector('button[role="combobox"][aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!e||e.disabled)throw Error('Select unavailable');e.click();})()`);
  await waitFor('!!document.querySelector("[role=listbox]")');
  await run(`(()=>{const e=[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Option unavailable');e.click();})()`);
  await pause(50);
}
async function input(label, value) {
  await run(`(()=>{const e=document.querySelector('input[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!e||e.disabled)throw Error('Input unavailable');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await pause(50);
}
async function action(label) {
  await run(`(()=>{const e=document.querySelector('button[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!e||e.disabled)throw Error('Action unavailable');e.click();})()`);
  await pause(50);
}
async function screenshot(name) { await pause(220); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); report.screenshots.push(name); }
function finish(error) {
  clearTimeout(watchdog); report.passed = !error;
  if (error) { report.error = { case: currentCase, message: error.stack }; console.error(error); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  if (!error) console.log('PASS ' + report.checks.length + ' segmented renderer checks; no hardware used');
  app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => finish(Error('Segmented fixture timeout')), 90000);
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1366, height: 900, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') { report.rendererErrors.push(event.message); console.error('renderer:', event.message); } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    await win.loadFile(path.join(output, 'index.html'));
    await waitFor('window.__segmentedFixture?.ready&&window.__segmentedFixture.routes.auto?.cycle&&window.__segmentedFixture.routes.segmented?.cycle');
    await check('三个tab可操作且几何与五测点只由一个编辑器维护', async () => {
      assert.equal(await run('document.querySelectorAll("[aria-label=转盘作业方式] [role=tab]").length'), 3);
      const radii = await run('window.__segmentedFixture.routes.segmented.targets.map(t=>t.radiusM)');
      assert.deepEqual(radii, [.16, .30, .44, .58, .72]);
      await input('测点3半径', '.45');
      await tab('自动跟随'); assert.equal(await run('window.__segmentedFixture.routes.auto.targets[2].radiusM'), .45);
      await tab('手动控制'); await tab('分段采集');
      assert.equal(await run('window.__segmentedFixture.routes.segmented.targets[2].radiusM'), .45);
      assert.equal(await run(`document.querySelectorAll('input[aria-label="叶片长度 · m"]').length`), 1);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth + 2'), true);
      await screenshot('segmented-tabs-1366.png');
    });
    await check('单点120°切两点固定90°并重置旧起点，切回单点可重新选120°', async () => {
      await choose('圆周移动间隔', '120° · 一圈 3 个点位');
      await run('window.__segmentedFixture.positionAt(120)'); await pause(90);
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [120]);
      await choose('每次开始采集', '两点采集');
      assert.equal(await run(`document.querySelector('button[role="combobox"][aria-label="圆周移动间隔"]').disabled`), true);
      assert.deepEqual(await run(`Array.from(document.querySelector('select[aria-label="圆周移动间隔"]').options,o=>o.value)`), ['90']);
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.segmentStations.map(p=>p.azimuthDeg)'), [0,90,180,270]);
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [0,90]);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.nextWaitPoint.azimuthDeg'), 180);
      await run('window.__segmentedFixture.positionAt(180)'); await pause(90);
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [180,270]);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.nextWaitPoint.azimuthDeg'), 0);
      await choose('每次开始采集', '单点采集');
      assert.equal(await run(`document.querySelector('button[role="combobox"][aria-label="圆周移动间隔"]').disabled`), false);
      assert.deepEqual(await run(`Array.from(document.querySelector('select[aria-label="圆周移动间隔"]').options,o=>o.value)`), ['180','120','90','60','45','30','22.5']);
      await choose('圆周移动间隔', '120° · 一圈 3 个点位');
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [0]);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.nextWaitPoint.azimuthDeg'), 120);
      await choose('圆周移动间隔', '90° · 一圈 4 个点位');
    });
    await check('配置页无重复定位入口，接收采集页定位成功后的角度更新', async () => {
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.executionMode'), 'manual_segments');
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [0]);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.nextWaitPoint.azimuthDeg'), 90);
      await choose('每次开始采集', '两点采集');
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [0, 90]);
      assert.equal(await run('window.__segmentedFixture.routes.auto.cycle.points.length'), 4);
      await run('window.__segmentedFixture.positionAt(180)'); await pause(90);
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [180, 270]);
      assert.equal(await run('document.querySelectorAll(".field-segment-point-position").length'), 0);
      assert.equal(await run('window.__segmentedFixture.calls.some(c=>c.action==="start")'), false);
    });
    await check('只有成功移到等待点才推进，重复状态和切tab不会覆盖人工选择', async () => {
      await run(`(()=>{const f=window.__segmentedFixture,route=f.routes.segmented.cycle;const next=structuredClone(f.initial);next.state='acquiring';next.receiver={running:true};next.pointCycle={...route,sessionId:'a'.repeat(32),state:'capturing',pointCount:2,point:2,cycle:1,totalRecords:2,completedRecords:1};f.inject(next);})()`);
      await pause(60);
      assert.equal(await run(`document.querySelector('input[aria-label="测点1半径"]').disabled`), true, 'Live capture locks point positioning');
      await run(`(()=>{const f=window.__segmentedFixture,route=f.routes.segmented.cycle;const next=structuredClone(f.initial);next.pointCycle={...route,sessionId:'a'.repeat(32),state:'complete',pointCount:2,point:2,cycle:1,totalRecords:2,completedRecords:2,waitingPoint:{...route.nextWaitPoint,confirmedAt:Date.now()/1000,actualAngles:{'1':route.nextWaitPoint.axis1AngleDeg,'2':route.nextWaitPoint.axis2AngleDeg}}};f.lastComplete=next;f.inject(next);})()`);
      await waitFor('window.__segmentedFixture.routes.segmented.cycle.points[0].azimuthDeg===0');
      await run('window.__segmentedFixture.positionAt(90)'); await pause(90);
      await run('window.__segmentedFixture.inject(structuredClone(window.__segmentedFixture.lastComplete))');
      await tab('自动跟随'); await tab('分段采集');
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.points[0].azimuthDeg'), 90);
      await run(`(()=>{const f=window.__segmentedFixture,next=structuredClone(f.lastComplete);next.pointCycle.sessionId='b'.repeat(32);next.pointCycle.state='error';next.pointCycle.waitingPoint.azimuthDeg=270;f.inject(next);})()`);
      await pause(60);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.points[0].azimuthDeg'), 90);
      const saved = await run('JSON.parse(localStorage.getItem("blade-segmented-capture-v1"))');
      assert.equal(saved.starts['["blade-test","p1"]'], 90);
      await run('document.querySelector(".field-auto-point").scrollIntoView({block:"center"})');
      await screenshot('segmented-point-angle-1366.png');
    });
    await check('单点修改分段间隔清理旧游标，不改变自动跟随的圆周间隔', async () => {
      await choose('每次开始采集', '单点采集');
      await choose('圆周移动间隔', '120° · 一圈 3 个点位');
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [0]);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.nextWaitPoint.azimuthDeg'), 120);
      assert.equal(await run('window.__segmentedFixture.routes.auto.cycle.points.length'), 4);
      assert.equal(await run('window.__segmentedFixture.calls.every(c=>c.action==="turntablePorts"||c.action==="turntable"&&c.request.action==="probe")'), true);
    });
    await check('旧任务完成包与新任务/间隔隔离，未观察到运行的历史状态不推进', async () => {
      await run(`(()=>{const f=window.__segmentedFixture,route=f.routes.segmented.cycle;const next=structuredClone(f.initial);next.state='acquiring';next.receiver={running:true};next.pointCycle={...route,sessionId:'c'.repeat(32),state:'capturing',pointCount:route.points.length,point:1,cycle:1,totalRecords:route.points.length,completedRecords:0};f.oldActive=next;f.inject(next);})()`);
      await pause(60);
      await run(`(()=>{const f=window.__segmentedFixture,next=structuredClone(f.oldActive);next.state='idle';next.receiver={running:false};f.inject(next);})()`);
      await pause(60);
      await choose('圆周移动间隔', '90° · 一圈 4 个点位');
      await run(`(()=>{const f=window.__segmentedFixture,next=structuredClone(f.oldActive),wait=next.pointCycle.nextWaitPoint;next.state='idle';next.receiver={running:false};next.pointCycle.state='complete';next.pointCycle.waitingPoint={...wait,confirmedAt:Date.now()/1000,actualAngles:{'1':wait.axis1AngleDeg,'2':wait.axis2AngleDeg}};f.inject(next);})()`);
      await pause(60);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.points[0].azimuthDeg'), 0);
      await run(`(()=>{const f=window.__segmentedFixture,route=f.routes.segmented.cycle;const next=structuredClone(f.initial);next.state='acquiring';next.receiver={running:true};next.pointCycle={...route,sessionId:'d'.repeat(32),state:'capturing',pointCount:route.points.length,point:1,cycle:1,totalRecords:route.points.length,completedRecords:0};f.oldActive=next;f.inject(next);})()`);
      await pause(60);
      await run(`(()=>{const f=window.__segmentedFixture;f.changeTask('另一风机任务');const next=structuredClone(f.oldActive),wait=next.pointCycle.nextWaitPoint;next.state='idle';next.receiver={running:false};next.pointCycle.state='complete';next.pointCycle.waitingPoint={...wait,confirmedAt:Date.now()/1000,actualAngles:{'1':wait.axis1AngleDeg,'2':wait.axis2AngleDeg}};f.lastComplete=next;f.inject(next);})()`);
      await pause(60);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.points[0].azimuthDeg'), 0);
      await run(`(()=>{const f=window.__segmentedFixture,next=structuredClone(f.lastComplete);next.pointCycle.sessionId='e'.repeat(32);f.inject(next);})()`);
      await pause(60);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.points[0].azimuthDeg'), 0);
    });
    await check('重载旧两点120°配置自动归一为90°并清理旧测点游标', async () => {
      await run('localStorage.setItem("blade-segmented-capture-v1",JSON.stringify({pointsPerStart:2,stepDeg:120,startAzimuthDeg:120,starts:{[JSON.stringify(["blade-test","p1"])]:120,[JSON.stringify(["blade-test","p2"])]:240}}))');
      await win.loadFile(path.join(output, 'index.html'));
      await waitFor('window.__segmentedFixture?.ready&&window.__segmentedFixture.routes.segmented?.cycle');
      assert.equal(await run(`document.querySelector('button[role="combobox"][aria-label="圆周移动间隔"]').disabled`), true);
      assert.deepEqual(await run(`Array.from(document.querySelector('select[aria-label="圆周移动间隔"]').options,o=>o.value)`), ['90']);
      assert.deepEqual(await run('window.__segmentedFixture.routes.segmented.cycle.points.map(p=>p.azimuthDeg)'), [0,90]);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.nextWaitPoint.azimuthDeg'), 180);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.segmentStations.length'), 4);
      const migrated = await run('JSON.parse(localStorage.getItem("blade-segmented-capture-v1"))');
      assert.equal(migrated.pointsPerStart, 2); assert.equal(migrated.stepDeg, 90); assert.equal(migrated.startAzimuthDeg, 0);
      assert.deepEqual(migrated.starts, {});
      assert.equal(await run('window.__segmentedFixture.calls.some(c=>c.action==="start"||c.request?.action==="recall")'), false);
    });
    await check('分段速度与驱动快速预设在安装设置中统一配置，只在明确应用后写入', async () => {
      await run('window.__segmentedFixture.inject(structuredClone(window.__segmentedFixture.initial))');
      await tab('分段采集');
      assert.equal(await run('document.querySelectorAll(".field-drive-profile").length'), 1);
      assert.equal(await run('!!document.querySelector(".field-auto-turntable-setup .field-drive-profile")'), true);
      assert.equal(await run(`!!document.querySelector('input[aria-label="换点加速度上限 · °/s²"]')`), false);
      const preset = '[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="填入快速预设")';
      assert.equal(await run(preset + '.disabled'), true, 'Preset must not invent current drive readback');
      await action('读取俯仰轴驱动参数');
      assert.equal(await run(preset + '.disabled'), true, 'Both axes must be read first');
      await action('读取水平轴驱动参数');
      await waitFor(preset + '&&!(' + preset + ').disabled');
      await input('点位移动速度 · rpm', '1');
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.speedRpm'), 1);
      const writesBefore = await run('window.__segmentedFixture.calls.filter(c=>c.request?.action==="set_motion_profile").length');
      await run('(' + preset + ').click()'); await pause(60);
      assert.equal(await run(`document.querySelector('input[aria-label="点位移动速度 · rpm"]').value`), '5');
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.speedRpm'), 5);
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.maxMoveRpm'), 5);
      assert.equal(await run('window.__segmentedFixture.calls.filter(c=>c.request?.action==="set_motion_profile").length'), writesBefore);
      for (const axis of ['俯仰轴', '水平轴']) {
        for (const [label, value] of [['加速时间 · PA40', '100'], ['减速时间 · PA41', '100'], ['S 曲线时间 · PA42', '0']]) {
          assert.equal(await run('document.querySelector(' + JSON.stringify('input[aria-label="' + axis + label + '"]') + ').value'), value);
        }
      }
      const oldProfiles = await run('structuredClone(window.__segmentedFixture.profiles)');
      await run('window.__segmentedFixture.holdProfile=true');
      await action('应用俯仰轴驱动参数');
      await waitFor('typeof window.__segmentedFixture.releaseProfile==="function"');
      assert.equal(await run(preset + '.disabled'), true);
      assert.equal(await run(`document.querySelector('input[aria-label="点位移动速度 · rpm"]').disabled`), true);
      assert.equal(await run(`document.querySelector('button[aria-label="应用水平轴驱动参数"]').disabled`), true);
      await run('window.__segmentedFixture.releaseProfile();delete window.__segmentedFixture.releaseProfile');
      await waitFor(`!document.querySelector('button[aria-label="应用水平轴驱动参数"]').disabled`);
      await action('应用水平轴驱动参数');
      await waitFor(`document.querySelector('[aria-label="水平轴驱动参数"]').textContent.includes("已应用并读回确认")`);
      const writes = await run('window.__segmentedFixture.calls.filter(c=>c.request?.action==="set_motion_profile").slice(-2).map(c=>c.request)');
      assert.deepEqual(writes.map(write => write.axis), [1, 2]);
      for (const write of writes) {
        assert.deepEqual(write.motionProfile, {accel_ms:100, decel_ms:100, s_curve_ms:0});
        assert.deepEqual(write.expectedMotionProfile, oldProfiles[write.axis]);
      }
      assert.equal(await run('window.__segmentedFixture.routes.segmented.cycle.speedRpm'), 5);
      await run('document.querySelector(".field-auto-turntable-setup").scrollIntoView({block:"start"})');
      await screenshot('segmented-speed-drive-preset-1366.png');
    });
    finish();
  } catch (error) { finish(error); }
});
