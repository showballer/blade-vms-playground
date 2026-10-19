'use strict';
// Isolated renderer fixture only. Does not load production Electron main/preload,
// credentials, Python, serial ports, networking or any real acquisition service.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'single-point-ui-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-single-point-ui-')));
app.setName('BladeVMS 单点界面离线验收');
const ui = path.join(root, 'packages/ui/src');
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FieldSinglePoint, singlePointDefaults } from ${JSON.stringify(path.join(ui, 'field-single-point.tsx'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable.css'))};
import ${JSON.stringify(path.join(ui, 'field-single-point.css'))};
const cfg = {...singlePointDefaults, distanceM:2, hubHeightDeltaM:.8, radiusM:.6, nominalPeriodSeconds:5, maxSyncAgeSeconds:15, axis1Sign:-1, materialMark:'A 叶片上的白色圆点'};
localStorage.setItem('blade-single-point-draft-v1', JSON.stringify({config:cfg,port:'TEST-ONLY'}));
const initial = { service:{state:'ready',dllConfigured:true,generation:1},state:'idle' };
const plan = { ready:true,blockReasons:[],warnings:[],motionModel:'position_chord_approximation',phaseLocked:false,identityConfirmed:false,anchorBound:true,periodSeconds:5,periodSource:'manual_marks',durationSeconds:.278,startAngles:{axis1AngleDeg:10.037,axis2AngleDeg:-1.162},endAngles:{axis1AngleDeg:10.137,axis2AngleDeg:-1.262},axisMoves:[],maxPathErrorMm:.4,predictionErrorMm:3.2,errorBudget:{pathApproximationMm:.4,manualSyncMm:1.8,periodVariationMm:.4,commandTimingMm:.3,axisStartSkewMm:.3,totalMm:3.2},trajectory:[] };
window.__fixture = { calls:[], holds:[], holdPrepare:false, holdBeforePublish:false, pending:null, active:initial, noHardware:true };
function App() {
 const [status,setStatus] = useState(initial),[config,setConfig] = useState({name:'单点界面验收 · 无设备连接',deviceIp:'198.51.100.10',hostIp:'198.51.100.11',object:'',turbine:'',point:''});
 const emit = data => {window.__fixture.active=data;setStatus(data);};
 window.__fixture.inject = emit;
 async function request(options) {
  window.__fixture.calls.push(options);
  if(options.action==='turntablePorts')return {ports:[{port:'COM3',description:'UI fixture, no hardware'}]};
  if(options.action!=='singlePoint')throw Error('Unexpected fixture request');
  const req=options.request, previous=window.__fixture.active, prev=previous.singlePoint;
  if(req.action==='preview')return {...previous,singlePointPreview:plan};
  let sp={...prev,version:(prev?.version||0)+1,updatedAt:Date.now()/1000};
  if(req.action==='prepare')sp={sessionId:req.sessionId,config:req.config,state:'awaiting_sync',anchor:plan.startAngles,preview:plan,marks:[],sync:{ready:false,blockReasons:['至少记录 5 次同一叶片过点'],markCount:0,phaseLocked:false,identityConfirmed:false,source:'manual_marks'},phaseLocked:false,identityConfirmed:false,motionModel:'position_chord_approximation',quality:'manual_unverified',version:1,updatedAt:Date.now()/1000};
  if(req.action==='mark'){const n=(sp.marks?.length||0)+1;sp.marks=[...(sp.marks||[]),{sequence:n,hostTime:1792400000+n*5,receivedSamples:n*1000}];sp.sync={ready:n>=5,blockReasons:n>=5?[]:['至少记录 5 次同一叶片过点'],markCount:n,periodSeconds:n>=2?5:null,rpm:n>=2?12:null,periodVariationPercent:n>=2?.2:null,phaseLocked:false,identityConfirmed:false,source:'manual_marks'};sp.state=n>=5?'ready':'awaiting_sync';}
  if(req.action==='reset_sync'){sp.marks=[];sp.sync={...sp.sync,ready:false,markCount:0};sp.state='awaiting_sync';}
  if(req.action==='arm'){sp.state='scheduled';sp.scheduledStartAt=Date.now()/1000+5;sp.skippedRevolutions=1;}
  if(req.action==='cancel'){if(window.__fixture.pending?.singlePoint.sessionId===req.sessionId)sp={...window.__fixture.pending.singlePoint,version:window.__fixture.pending.singlePoint.version+1};sp.state='cancelled';}
  const data={...initial,state:req.action==='cancel'?'idle':'acquiring',singlePoint:sp};
  if(req.action==='prepare'&&window.__fixture.holdBeforePublish){window.__fixture.pending=data;await new Promise(resolve=>window.__fixture.holds.push(resolve));window.__fixture.pending=null;return data;}
  emit(data);
  if(req.action==='prepare'&&window.__fixture.holdPrepare)await new Promise(resolve=>window.__fixture.holds.push(resolve));
  return data;
 }
 return <div className="field-app"><div className="field-header"><div className="field-brand">BladeVMS <small>界面离线验收 · 不连接设备</small></div></div><div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button>数据采集</button><button className="active">单点跟随</button><button>转盘点位</button><button>本机记录</button></aside><main className="field-content"><div className="field-page-heading"><h1>单叶片 · 单测点跟随</h1></div><FieldSinglePoint config={config} onConfig={setConfig} status={status} request={request} onStatus={emit} onTurntable={()=>{}} onRecords={()=>{}} /></main></div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const report = { hardwareTested: false, fixture: 'isolated component renderer with in-memory request stub; no preload', checks: [], screenshots: [] };
let win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code) { for (let i=0;i<80;i++){if(await run(code))return;await pause(25);}throw Error('UI wait timed out: '+code); }
async function check(name, fn) { await fn(); report.checks.push({ name, passed:true }); console.log('PASS '+name); }
const button = text => `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
async function click(text) { await run(`(()=>{const e=${button(text)};if(!e||e.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});e.click();})()`); await pause(40); }
async function checkbox(text) { await run(`(()=>{const l=[...document.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(text)}));const e=l?.querySelector('input[type=checkbox]');if(!e||e.disabled)throw Error('Checkbox unavailable');e.click();})()`);await pause(20); }
function finish(error) { report.passed=!error; if(error)report.error=error.stack;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');if(error)console.error(error);app.exit(error?1:0); }
const watchdog = setTimeout(()=>finish(Error('UI fixture timed out')), 90000);
app.whenReady().then(async()=>{
 try {
  win=new BrowserWindow({width:1366,height:768,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file:')&&!details.url.startsWith('data:')}));
  await win.loadFile(path.join(output,'index.html'));await waitFor('!!document.querySelector(".single-point-workspace")');
  await check('初始真实设备界面不会发起请求',async()=>assert.equal(await run('window.__fixture.calls.length'),0));
  await check('已有5秒草稿保持原周期与几何，不被30秒默认隐式覆盖',async()=>{
   assert.equal(await run(`document.querySelector('input[aria-label="估计每圈时间 · s"]').value`),'5');
   assert.equal(await run(`document.querySelector('input[aria-label="设备至叶轮平面距离 · m"]').value`),'2');
  });
  await check('1366、1920与窄窗口无横向溢出，参数和图形可见',async()=>{
   for(const [w,h] of [[1366,768],[1920,1080],[820,700],[480,800]]){
    win.setContentSize(w,h);await pause(80);
    const m=await run(`({width:innerWidth,body:document.body.scrollWidth,root:document.querySelector('.field-app').scrollWidth,main:document.querySelector('.field-content').scrollWidth,client:document.querySelector('.field-content').clientWidth})`);
    assert.ok(m.body<=m.width+2&&m.root<=m.width+2&&m.main<=m.client+2,JSON.stringify(m));
    const name='initial-'+w+'x'+h+'.png';fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());report.screenshots.push(name);
   }
   win.setContentSize(1366,768);
  });
  await check('自定义下拉有键盘路径与图标空间',async()=>{
   await run(`document.querySelector('.single-point-advanced').open=true`);
   const m=await run(`(()=>{const e=document.querySelector('.single-point-fields .custom-select-trigger');e.focus();return {role:e.getAttribute('role'),padding:getComputedStyle(e).paddingRight,focus:document.activeElement===e}})()`);
   assert.equal(m.focus,true);assert.ok(parseFloat(m.padding)>=28,JSON.stringify(m));
  });
  await click('刷新串口');await click('COM3');
  await checkbox('已核对设备正对叶轮');await checkbox('已实测或核对上述运动');
  await checkbox('叶轮已停止');await checkbox('光路及人员安全已确认');
  await check('准备显式启动记录，反馈只读且无自动运动',async()=>{
   await click('准备并开始记录');await waitFor('window.__fixture.active.singlePoint?.state==="awaiting_sync"');
   const calls=await run('window.__fixture.calls');assert.equal(calls.filter(c=>c.request?.action==='arm').length,0);
   const req=calls.find(c=>c.request?.action==='prepare').request;assert.equal(req.confirmLaser,true);assert.equal(req.confirmStaticPoint,true);assert.equal(req.capture.port,'COM3');
   assert.equal(await run(`${button('预约下一次经过并跟随')}.disabled`),true);
   assert.equal(await run(`${button('应用30秒模型')}.disabled`),true);
  });
  await checkbox('我能根据材料标记辨认目标叶片');
  await check('五次同叶片人工标记后仍须明确运动确认',async()=>{
   for(let i=0;i<5;i++)await click('A 经过6点 · 记录一次');
   assert.equal(await run('window.__fixture.active.singlePoint.sync.markCount'),5);
   assert.equal(await run(`${button('预约下一次经过并跟随')}.disabled`),true);
   await checkbox('运动空间已清空');await click('预约下一次经过并跟随');
   assert.equal(await run('window.__fixture.active.singlePoint.state'),'scheduled');
   assert.equal(await run('window.__fixture.active.singlePoint.phaseLocked'),false);
   await run(`document.querySelector('.field-content').scrollTop=0`);
   await run(`document.querySelector('.single-point-stopbar').scrollIntoView({block:'end'})`);await pause(40);
   fs.writeFileSync(path.join(output,'scheduled.png'),(await win.webContents.capturePage()).toPNG());report.screenshots.push('scheduled.png');
  });
  await check('滚动到底后停止栏不遮挡最后一项操作',async()=>{
   await run(`document.querySelector('.field-content').scrollTop=100000`);await pause(50);
   const boxes=await run(`(()=>{const layout=document.querySelector('.single-point-layout').getBoundingClientRect(),stop=document.querySelector('.single-point-stopbar').getBoundingClientRect(),main=document.querySelector('.field-content').getBoundingClientRect();return {layoutBottom:layout.bottom,stopTop:stop.top,stopBottom:stop.bottom,mainBottom:main.bottom}})()`);
   assert.ok(boxes.layoutBottom+8<=boxes.stopTop,JSON.stringify(boxes));assert.ok(boxes.stopBottom<=boxes.mainBottom,JSON.stringify(boxes));
  });
  await check('预约后停止保存，结束后不沿用现场确认',async()=>{
   await click('停止转盘并结束记录');assert.equal(await run('window.__fixture.active.singlePoint.state'),'cancelled');
   assert.equal(await run(`${button('准备并开始记录')}.disabled`),true);
   const stored=JSON.parse(await run(`localStorage.getItem('blade-single-point-draft-v1')`));
   for(const key of ['frontFacingConfirmed','motionTimingConfirmed','anchor','sessionId','confirmLaser'])assert.equal(key in stored.config,false);
  });
  await check('准备请求尚未返回时可停止，迟到响应不会恢复运行',async()=>{
   await checkbox('叶轮已停止');await checkbox('光路及人员安全已确认');
   await run('window.__fixture.holdPrepare=true');await click('准备并开始记录');
   await click('停止转盘并结束记录');await run('window.__fixture.holds.splice(0).forEach(r=>r())');await pause(80);
   assert.equal(await run('window.__fixture.active.singlePoint.state'),'cancelled');
  });
  await check('旧终态仍在时取消第二次未回包prepare，取消目标必须是新会话',async()=>{
   const oldSession=await run('window.__fixture.active.singlePoint.sessionId');
   await checkbox('叶轮已停止');await checkbox('光路及人员安全已确认');
   await run('window.__fixture.holdPrepare=false;window.__fixture.holdBeforePublish=true');
   await click('准备并开始记录');
   assert.equal(await run('window.__fixture.active.singlePoint.sessionId'),oldSession);
   const newSession=await run('window.__fixture.pending.singlePoint.sessionId');assert.notEqual(newSession,oldSession);
   await click('停止转盘并结束记录');
   assert.equal(await run("window.__fixture.calls.filter(x=>x.request?.action==='cancel').at(-1).request.sessionId"),newSession);
   await run('window.__fixture.holds.splice(0).forEach(r=>r())');await pause(80);
   assert.equal(await run('window.__fixture.active.singlePoint.sessionId'),newSession);
   assert.equal(await run('window.__fixture.active.singlePoint.state'),'cancelled');
  });
  await check('服务重启清除旧运行快照，旧generation迟到不会恢复假运行',async()=>{
   await run(`window.__fixture.oldGeneration={...window.__fixture.active,state:'acquiring',singlePoint:{...window.__fixture.active.singlePoint,state:'following',version:100}};window.__fixture.inject(window.__fixture.oldGeneration)`);await pause(40);
   assert.equal(await run("!!document.querySelector('.single-point-stopbar')"),true);
   await run(`window.__fixture.inject({service:{state:'ready',dllConfigured:true,generation:2},state:'idle',singlePoint:null})`);await pause(50);
   assert.equal(await run("!!document.querySelector('.single-point-stopbar')"),false);
   assert.equal(await run("document.querySelector('input[aria-label=材料标记]').disabled"),false);
   await run('window.__fixture.inject(window.__fixture.oldGeneration)');await pause(50);
   assert.equal(await run("!!document.querySelector('.single-point-stopbar')"),false);
   assert.equal(await run("document.querySelector('.single-point-overview').innerText.includes('尚未准备')"),true);
   assert.equal(await run("document.body.innerText.includes('采集服务已重启')"),true);
  });
  await check('修改几何或时序后必须重新核对对应参数组',async()=>{
   await run(`document.querySelector('.single-point-inputs').open=true;document.querySelector('.single-point-advanced').open=true`);
   await checkbox('已核对设备正对叶轮');await checkbox('已实测或核对上述运动');
   for(const [label,value,confirmation] of [['设备至叶轮平面距离 · m','2.2','已核对设备正对叶轮'],['指令延迟上界 · ms','110','已实测或核对上述运动']]){
    await run(`(()=>{const e=document.querySelector('input[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify('REPLACE_VALUE')});e.dispatchEvent(new Event('input',{bubbles:true}));})()`.replace('REPLACE_VALUE',value));await pause(30);
    assert.equal(await run(`(()=>{const l=[...document.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(confirmation)}));return l.querySelector('input').checked})()`),false);
   }
  });
  await check('主动应用30秒模型只改指定参数，撤销旧确认与预览，不发设备请求',async()=>{
   await checkbox('已核对设备正对叶轮');await checkbox('已实测或核对上述运动');await checkbox('叶轮已停止');await checkbox('光路及人员安全已确认');
   await click('检查轨迹与时间预算');
   const before=await run('JSON.parse(localStorage.getItem("blade-single-point-draft-v1"))'),count=await run('window.__fixture.calls.length');
   await click('应用30秒模型');
   const after=await run('JSON.parse(localStorage.getItem("blade-single-point-draft-v1"))');
   assert.deepEqual(after,{...before,config:{...before.config,distanceM:2.86,hubHeightDeltaM:1.46,radiusM:.31,nominalPeriodSeconds:30,rotationDirection:'clockwise',maxSyncAgeSeconds:45}});
   assert.equal(after.config.axis1Sign,-1);assert.equal(after.config.commandLatencyMs,110);assert.equal(after.config.arcDegrees,20);
   assert.equal(await run('window.__fixture.calls.length'),count);
   for(const label of ['已核对设备正对叶轮','已实测或核对上述运动','叶轮已停止','光路及人员安全已确认'])assert.equal(await run(`(()=>{const l=[...document.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(label)}));return l.querySelector('input').checked})()`),false);
   assert.ok(await run('document.querySelector(".single-point-preview").textContent.includes("填写实际尺寸后检查轨迹")'));
   await run(`document.querySelector('.field-content').scrollTop=0`);await pause(40);
   fs.writeFileSync(path.join(output,'applied-30-second-model.png'),(await win.webContents.capturePage()).toPNG());report.screenshots.push('applied-30-second-model.png');
  });
  report.requestCount=await run('window.__fixture.calls.length');report.noHardware=await run('window.__fixture.noHardware');clearTimeout(watchdog);finish();
 } catch(error){clearTimeout(watchdog);finish(error);}
}).catch(finish);
