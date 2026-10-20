'use strict';
// Isolated rendering of the shipped live-trajectory component. Every feedback
// event is an explicit in-memory fixture; no device/service/preload is loaded.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'packages/ui/src');
const output = path.join(root, 'artifacts/field-cycle-live-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-cycle-live-')));
const fixture = `
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FieldCycleMotion} from ${JSON.stringify(path.join(ui, 'field-cycle-motion.tsx'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable.css'))};
import ${JSON.stringify(path.join(ui, 'field-cycle-motion.css'))};
const signature='[[101,3,10000,21],[202,3,10000,21]]';
const stations=[[10,7],[11,6],[12,7],[11,8]].map(([pitch,yaw],index)=>({pointId:'p1-s'+(index+1),name:'P1 · '+(index*90)+'°',axis1AngleDeg:pitch,axis2AngleDeg:yaw,port:'COM3',referenceSignature:signature,bladeId:'2',radialPointId:'p1',radialPointName:'P1',radiusM:.31,rootRadiusM:.05,bladeLengthM:.5,azimuthDeg:index*90,stationIndex:index+1,stationCount:4}));
const geometry={distanceM:3.3,hubHeightDeltaM:.85,rotationDirection:'clockwise',axis1Sign:1,axis2Sign:1,anchorRadiusM:.31,anchorAxis1AngleDeg:10,anchorAxis2AngleDeg:7};
const route={kind:'auto',name:'叶片2/P1',pointNames:stations.map(point=>point.name),generation:1,errors:[],cycle:{port:'COM3',mode:'automatic_stations',points:stations,cycles:2,speedRpm:.2,dwellSeconds:60,geometry}};
const config={name:'1号风机 · 联动轨迹隔离验收',deviceIp:'192.0.2.90',hostIp:'192.0.2.10',turbine:'WT01',object:'风机叶片',point:'P1'};
const axis=(angle,at,rpm,origin,limit)=>({output_angle_deg:angle,observedAt:at,motor_rpm:rpm,actual_counts:1000,commanded_counts:1000,error_counts:0,display_mode:3,command_counts_per_rev:10000,encoder_bits:21,flags:3,fault:0,origin_counts:origin,home_phase:0,referenceAngleDeg:0,guard:{soft_enabled:true,hardware_enabled:false,minimum_deg:-limit,maximum_deg:limit}});
function frame(pitch=9,yaw=5,options={}){
 const {at=Date.now()/1000,phase='moving',target='p1-s1',rpm=.5,laser='off'}=options;
 const point=stations.find(point=>point.pointId===target)||stations[0];
 return {service:{state:'ready',dllConfigured:true,generation:1},state:'acquiring',receiver:{running:true},turntableBusy:false,
  laserStatus:{deviceIp:config.deviceIp,state:laser,readAt:Date.now()/1000,source:'device-readback',busy:true},
  pointCycle:{state:'capturing',mode:'automatic_stations',port:'COM3',sessionId:'isolated-session',plannedStations:structuredClone(stations),geometry,cycles:2,cycle:1,point:1,pointCount:4,currentPoint:stations[0].name,targetPointId:target,targetAxis1AngleDeg:point.axis1AngleDeg,targetAxis2AngleDeg:point.axis2AngleDeg,speedRpm:.2,dwellSeconds:60,completedRecords:0,totalRecords:8,processPhase:phase},
  turntable:{port:'COM3',state:'holding',feedback:{motorRpm:rpm,outputRpm:rpm/50,alarmCode:0,limitFlags:0,positionRaw:1000,axes:{'1':axis(pitch,at,rpm,101,35),'2':axis(yaw,at,rpm,202,180)}}}};
}
window.__cycleFixture={frame,route,config,ready:false,requests:[]};
function App(){
 const [status,setStatus]=useState({service:{state:'ready',generation:1,dllConfigured:true},state:'idle',receiver:{running:false}}),[plan,setPlan]=useState(route),[unavailable,setUnavailable]=useState(false);
 window.__cycleFixture.inject=value=>setStatus(structuredClone(value));window.__cycleFixture.plan=value=>setPlan(structuredClone(value));window.__cycleFixture.unavailable=setUnavailable;
 useEffect(()=>{window.__cycleFixture.ready=true;},[]);
 return <div className='field-app'><header className='field-header'><div className='field-brand'>BladeVMS <small>联动轨迹隔离验收</small></div></header><div className='field-workspace'><aside className='field-sidebar'><button className='active'>数据采集</button><button>转盘点位</button><button>本机记录</button></aside><main className='field-content'><div className='field-page-heading'><h1>数据采集</h1></div><FieldCycleMotion status={status} route={plan} config={config} unavailable={unavailable}/></main></div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true,
  outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>联动轨迹隔离验收</title><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const report = { hardwareTouched: false, realServiceStarted: false, productionUserDataTouched: false,
  nativeMotionExecuted: false, checks: [], screenshots: [], passed: false };
let win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = source => win.webContents.executeJavaScript('(async()=>(' + source + '))()', true);
async function waitFor(source, label = source) {
  for (let i = 0; i < 120; i++) { if (await run(source)) return; await pause(25); }
  throw Error('Timed out: ' + label);
}
const section = 'document.querySelector("section[aria-label=转盘联动轨迹]")';
const samples = () => run('Number(document.querySelector("path[data-kind=feedback]")?.dataset.samples||0)');
const plot = () => run('document.querySelector("path[data-kind=feedback]")?.getAttribute("d")||""');
const current = () => run('(()=>{const node=document.querySelector("g.field-motion-current");return node?{pitch:Number(node.dataset.pitch),yaw:Number(node.dataset.yaw),at:Number(node.dataset.observedAt)}:null;})()');
async function inject(pitch, yaw, options = {}) {
  await run('window.__cycleFixture.inject(window.__cycleFixture.frame(' + JSON.stringify(pitch) + ',' + JSON.stringify(yaw) + ',' + JSON.stringify(options) + '))'); await pause(55);
}
async function check(name, fn) { await fn(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
function finish(error) {
  report.passed = !error; if (error) report.error = error.stack;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  if (error) console.error(error); app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => finish(Error('Cycle live acceptance timed out')), 90000);
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1366, height: 768, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  await win.loadFile(path.join(output, 'index.html')); await waitFor('window.__cycleFixture?.ready');
  await check('计划预览独立显示，未收到真实反馈时不生成实际轨迹或到位状态', async () => {
    assert.equal(await run('document.querySelectorAll(".field-motion-station").length'), 4);
    assert.ok(await run('document.querySelector("path[data-kind=plan]")?.getAttribute("d")'));
    assert.equal(await samples(), 0); assert.equal(await current(), null);
    assert.equal(await run(section + '.dataset.arrived'), 'false');
    assert.ok(await run(section + '.textContent.includes("计划预览")'));
    assert.match(await run('getComputedStyle(document.querySelector("path[data-kind=plan]")).strokeDasharray'), /6/);
  });
  let firstAt;
  await check('移动中按实际两轴反馈标记位置，与目标及计划路线明确分开，激光状态来自Off回读', async () => {
    await inject(9, 5); firstAt = (await current()).at;
    assert.deepEqual(await current(), { pitch: 9, yaw: 5, at: firstAt }); assert.equal(await samples(), 1);
    assert.equal(await run(section + '.dataset.moving'), 'true'); assert.equal(await run(section + '.dataset.arrived'), 'false');
    assert.equal(await run('document.querySelector(".field-motion-station.target").dataset.station'), 'p1-s1');
    assert.equal(await run('document.querySelector(".field-motion-laser").dataset.state'), 'off');
    const text = await run(section + '.textContent');
    assert.ok(text.includes('叶片 2') && text.includes('P1') && text.includes('0.26') && text.includes('0.31') && text.includes('0.5'), text);
    assert.ok(text.includes('反馈轨迹') && text.includes('计划路线') && text.includes('设备坐标'));
  });
  await check('没有新反馈时不会按时钟生成中间位置，同一observedAt重复帧不增加样本', async () => {
    await pause(550); assert.equal(await samples(), 1);
    await inject(9, 5, { at: firstAt }); assert.equal(await samples(), 1);
    assert.deepEqual(await current(), { pitch: 9, yaw: 5, at: firstAt });
    await inject(9.5, 6); assert.equal(await samples(), 2);
    assert.equal((await plot()).match(/L/g)?.length, 1, 'Only the two actual samples may be connected');
  });
  await check('反馈不可用时隐藏当前位置且不追加；恢复的新反馈与之前路径断开', async () => {
    await run('window.__cycleFixture.unavailable(true)'); await pause(60);
    assert.equal(await run(section + '.dataset.feedback'), 'unknown'); assert.equal(await current(), null); assert.equal(await samples(), 2);
    await run('window.__cycleFixture.unavailable(false)'); await inject(9.8, 6.8);
    assert.equal(await samples(), 3); assert.equal((await plot()).match(/M/g)?.length, 2);
    await inject(10, 7, { at: Date.now() / 1000 - 3, phase: 'waiting_blade', rpm: 0, laser: 'on' });
    assert.equal(await run(section + '.dataset.arrived'), 'false'); assert.equal(await current(), null);
  });
  await check('坐标到目标但仍移动时不确认到位；到位停稳Off后才展示等待叶片与On', async () => {
    await inject(10, 7, { phase: 'moving', rpm: .1, laser: 'off' });
    assert.equal(await run(section + '.dataset.arrived'), 'false');
    await inject(10, 7, { phase: 'arrived', rpm: 0, laser: 'off' });
    assert.equal(await run(section + '.dataset.arrived'), 'true'); assert.equal(await run('document.querySelector(".field-motion-laser").dataset.state'), 'off');
    await inject(10, 7, { phase: 'waiting_blade', rpm: 0, laser: 'on' });
    assert.equal(await run(section + '.dataset.arrived'), 'true'); assert.equal(await run('document.querySelector(".field-motion-laser").dataset.state'), 'on');
    assert.ok(await run(section + '.textContent.includes("等待叶片")'));
  });
  await check('换点使用服务端targetPointId，旧currentPoint名称与编辑草稿不改变运行目标', async () => {
    await run('(()=>{const route=structuredClone(window.__cycleFixture.route);route.cycle.points=route.cycle.points.map(point=>({...point,axis1AngleDeg:30,axis2AngleDeg:90}));window.__cycleFixture.plan(route);})()');
    await inject(10.2, 6.8, { target: 'p1-s2', phase: 'moving', rpm: .2 });
    assert.equal(await run('document.querySelector(".field-motion-station.target").dataset.station'), 'p1-s2');
    assert.equal(await run(section + '.dataset.arrived'), 'false');
    const cells = await run('[...document.querySelectorAll(".field-motion-angles tbody tr")].map(row=>[...row.cells].map(cell=>cell.textContent))');
    assert.equal(cells[0][2], '11'); assert.equal(cells[1][2], '6');
    assert.ok(await run(section + '.textContent.includes("90")'));
  });
  await check('缺少叶根或叶长记录时显示未知，不把距旋转中心当作距叶根', async () => {
    await run('(()=>{const next=window.__cycleFixture.frame(10.2,6.8,{target:"p1-s2"});next.pointCycle.plannedStations.forEach(point=>{delete point.rootRadiusM;delete point.bladeLengthM;});window.__cycleFixture.inject(next);})()'); await pause(55);
    const dimensions = await run('[...document.querySelectorAll(".field-motion-dimensions>div")].map(node=>[node.querySelector("dt").textContent,node.querySelector("dd").textContent])');
    assert.equal(dimensions.find(([label]) => label === '测点距叶根')[1], '—m');
    assert.equal(dimensions.find(([label]) => label === '叶片长度')[1], '—m');
    assert.equal(dimensions.find(([label]) => label === '距旋转中心')[1], '0.31m');
  });
  await check('端口不匹配、参考失效、故障、回零中、陈旧或未来反馈均不能冒充实际到位', async () => {
    for (const kind of ['port', 'reference', 'fault', 'homing', 'stale', 'future']) {
      await run('(()=>{const next=window.__cycleFixture.frame(10,7,{phase:"waiting_blade",rpm:0});'+({port:'next.turntable.port="COM4";',reference:'next.turntable.feedback.axes["1"].flags=2;',fault:'next.turntable.feedback.axes["2"].fault=2;',homing:'next.turntable.feedback.axes["1"].flags|=16;',stale:'Object.values(next.turntable.feedback.axes).forEach(axis=>axis.observedAt-=3);',future:'Object.values(next.turntable.feedback.axes).forEach(axis=>axis.observedAt+=10);'})[kind]+'window.__cycleFixture.inject(next);})()'); await pause(55);
      assert.equal(await run(section + '.dataset.feedback'), 'unknown', kind); assert.equal(await current(), null, kind);
      assert.equal(await run(section + '.dataset.arrived'), 'false', kind);
    }
  });
  await check('运行计划没有实际绝对目标时不回退编辑草稿来绘制伪点位', async () => {
    await run('(()=>{const next=window.__cycleFixture.frame(10,7,{phase:"waiting_blade",rpm:0});next.pointCycle.plannedStations.forEach(point=>{delete point.axis1AngleDeg;delete point.axis2AngleDeg;});window.__cycleFixture.inject(next);})()'); await pause(55);
    assert.equal(await run('document.querySelectorAll(".field-motion-station").length'), 0);
    assert.equal(await run('!!document.querySelector("path[data-kind=plan]")'), false);
    assert.equal(await run(section + '.dataset.arrived'), 'false');
  });
  await check('1366、1024、480及360窗口计划/实测图例、角度和测点信息无横向溢出', async () => {
    await run('window.__cycleFixture.plan(window.__cycleFixture.route)'); await inject(10.5, 6.5, { target: 'p1-s2' });
    for (const [width, height] of [[1366, 768], [1024, 768], [480, 800], [360, 740]]) {
      win.setContentSize(width, height); await pause(110);
      assert.equal(await run('document.body.scrollWidth<=innerWidth+2&&document.querySelector(".field-content").scrollWidth<=document.querySelector(".field-content").clientWidth+2'), true);
      assert.equal(await run('[...document.querySelectorAll(".field-motion-legend svg")].every(icon=>{const r=icon.getBoundingClientRect();return r.width<=20&&r.height<=20;})'), true, 'Legend icons must not inherit the main plot dimensions');
      const file = 'cycle-live-' + width + '.png'; fs.writeFileSync(path.join(output, file), (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
    }
    assert.deepEqual(await run('window.__cycleFixture.requests'), []);
  });
  clearTimeout(watchdog); finish();
} catch (error) { clearTimeout(watchdog); finish(error); } });
