'use strict';
// Real React desktop renderer, disposable profile and in-memory bridge only.
// Geometry assertions never connect a device or start the real acquisition service.
const {app,BrowserWindow}=require('electron');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ui=path.join(root,'packages/ui/src');
const output=path.join(root,'artifacts/capture-layout-smoke');fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'blade-capture-layout-')));
const fixture=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {FieldDesktopApp} from ${JSON.stringify(path.join(ui,'field-desktop.tsx'))};
import {defaultAutoFollowSurvey,autoFollowStorageKey} from ${JSON.stringify(path.join(ui,'field-auto-follow-config.ts'))};
import {turntableReferenceSignature} from ${JSON.stringify(path.join(ui,'field-turntable-points.ts'))};
${['styles','field-styles','field-turntable','field-auto-follow','field-auto-capture-list','field-header-laser','field-turntable-health','field-blade-summary','field-cycle-motion'].map(x=>`import ${JSON.stringify(path.join(ui,x+'.css'))};`).join('\n')}
const axis=limit=>({output_angle_deg:0,motor_rpm:0,actual_counts:0,commanded_counts:0,error_counts:0,display_mode:3,command_counts_per_rev:10000,encoder_bits:17,flags:3,fault:0,origin_counts:0,home_phase:0,observedAt:Date.now()/1000,referenceAngleDeg:0,guard:{soft_enabled:true,hardware_enabled:false,minimum_deg:-limit,maximum_deg:limit}});
const base={service:{state:'ready',dllConfigured:true,generation:1},state:'idle',receiver:{running:false},deviceBusy:false,turntableBusy:false,pointCycleExecutionModes:['continuous','manual_segments'],turntable:{state:'checked',port:'COM6',axis:1,motionCapability:{supported:true,mode:'dual_axis_timed',pointMode:'drive_internal',preloadedPoints:true,protocol:'0x30-0x36',probe:'confirmed',status:{state:0,fault:0}},feedback:{axes:{'1':axis(35),'2':axis(180)},motorRpm:0,outputRpm:0,alarmCode:0,limitFlags:0,positionRaw:0}}};
const m=window.__layoutFixture={base,server:structuredClone(base),calls:[],reads:0,failRecall:false,holdRecall:false,transportFailure:false};
const snapshot=()=>{for(const a of Object.values(m.server.turntable.feedback.axes))a.observedAt=Date.now()/1000;return structuredClone(m.server)};
localStorage.setItem('blade-field-config-v1',JSON.stringify({name:'采集按钮稳定性验收',deviceIp:'192.0.2.90',hostIp:'192.0.2.10',object:'风机叶片',turbine:'T1',point:''}));
localStorage.setItem('blade-turntable-connection-v1',JSON.stringify({version:1,endpoint:'COM6'}));
const survey=defaultAutoFollowSurvey();survey.port='COM6';survey.settings={...survey.settings,distanceM:2.5,periodSeconds:5,stepDeg:90,maxMoveRpm:5,maxMoveAccelerationDegS2:30};survey.heights={hubHeightM:1.5,laserHeightM:.77};survey.blades=[{id:'blade-test',name:'2',lengthM:.8,rootReservePercent:20,tipReservePercent:10,points:[.16,.30,.44,.58,.72].map((radiusM,i)=>({id:'p'+(i+1),name:'P'+(i+1),radiusM}))}];survey.selectedBladeId='blade-test';survey.selectedPointId='p3';localStorage.setItem(autoFollowStorageKey,JSON.stringify(survey));
localStorage.setItem('blade-segmented-capture-v1',JSON.stringify({pointsPerStart:2,stepDeg:90,startAzimuthDeg:0,starts:{}}));
localStorage.setItem('blade-turntable-points-v2',JSON.stringify([{pointId:'m1',name:'M1',axis1AngleDeg:2,axis2AngleDeg:3},{pointId:'m2',name:'M2',axis1AngleDeg:5,axis2AngleDeg:6}].map(p=>({...p,port:'COM6',referenceSignature:turntableReferenceSignature(base.turntable.feedback.axes)}))));
window.blade={windowControl:()=>{},field:async o=>{
 m.calls.push(structuredClone(o));
 const ok=data=>({status:200,data});
 if(o.action==='accountInfo')return ok({mode:'unified',serverUrl:'https://example.invalid',offline:false});
 if(o.action==='session')return ok({user:{id:'fixture',username:'fixture',name:'隔离测试'},mustChangePassword:false});
 if(o.action==='syncStatus')return ok({enabled:false,connected:true,state:'ready',items:[{recordingId:'test-a',state:'synced'},{recordingId:'test-b',state:'synced'}]});
 if(o.action==='recordings')return ok({recordings:[]});
 if(o.action==='status'||o.action==='frame'){m.reads++;if(m.transportFailure)return {status:503,data:{error:'测试断线'}};return ok(snapshot())}
 if(o.action==='turntablePorts')return ok({ports:[{port:'COM6',description:'TEST ONLY'}]});
 if(o.action==='device'&&o.request.action==='laser_read')return ok({deviceIp:o.request.deviceIp,state:'unknown',readAt:null,source:'unavailable',busy:false});
 if(o.action==='turntable'&&o.request.action==='probe')return ok(snapshot());
 if(o.action==='turntable'&&o.request.action==='stop'){m.server.turntableBusy=false;m.server.turntable.recall={...m.server.turntable.recall,state:'cancelled'};return ok(snapshot())}
 if(o.action==='turntable'&&o.request.action==='recall'){
  if(m.holdRecall)await new Promise(resolve=>m.releaseRecall=resolve);
  if(m.failRecall)return {status:503,data:{error:'测试定位失败'}};
  const q=o.request;m.server.turntable.feedback.axes['1'].output_angle_deg=q.axis1AngleDeg;m.server.turntable.feedback.axes['2'].output_angle_deg=q.axis2AngleDeg;
  m.server.turntableBusy=false;m.server.turntable.state='stopped';m.server.turntable.stopConfirmed=true;m.server.turntable.recall={state:'complete',targets:[q.axis1AngleDeg,q.axis2AngleDeg],completedAxes:[1,2]};return ok(snapshot());
 }
 if(o.action==='start'){
  m.lastStart=structuredClone(o.config.pointCycle);m.startPending=true;
  await new Promise(resolve=>m.releaseStart=resolve);m.startPending=false;return ok(snapshot());
 }
 if(o.action==='stop'){
  m.stopPending=true;await new Promise(resolve=>m.releaseStop=resolve);m.stopPending=false;return ok(snapshot());
 }
 throw Error('Unexpected isolated operation '+JSON.stringify(o));
}};
m.phase=(phase,point=1)=>{
 const route=m.lastStart||{},planned=route.segmentStations||route.points||[];
 m.server=structuredClone(base);
 if(phase==='idle')return;
 const end=['complete','error','cancelled'].includes(phase);
 m.server.state=end?(phase==='error'?'error':'idle'):phase==='starting'?'starting':phase==='stopping'?'stopping':'acquiring';
 m.server.receiver={running:!end&&phase!=='starting'};
 const p=route.points?.[Math.min(point-1,route.points.length-1)]||planned[0];
 m.server.pointCycle={...route,sessionId:'a'.repeat(32),plannedStations:planned,
  state:end?phase:phase==='starting'?'checking':phase==='moving'?'positioning':'capturing',
  pointCount:route.points?.length||2,point,cycle:1,completedRecords:end?(route.points?.length||2):Math.max(0,point-1),totalRecords:route.points?.length||2,
  targetPointId:p?.pointId,currentPoint:p?.name,processPhase:phase==='moving'?'moving':phase==='capturing'?'waiting_blade':phase==='next'?'blade_present':phase,
  movingToWaitPoint:phase==='moving'};
 if(phase==='complete'&&route.executionMode==='manual_segments')m.server.pointCycle.waitingPoint={...route.nextWaitPoint,confirmedAt:Date.now()/1000,actualAngles:{'1':route.nextWaitPoint.axis1AngleDeg,'2':route.nextWaitPoint.axis2AngleDeg}};
 if(!end&&phase!=='starting')m.server.recording={id:'b'.repeat(32),name:'采集按钮稳定性验收',source:'polytec_ivs500',status:'recording',samples:1200,sampleRate:250000,
  pointCycle:{...route,bladeId:'2',radialPointId:'p3',pointId:p?.pointId,pointName:p?.name}};
 if(!end&&phase!=='starting')m.server.waveform={sampleRate:250000,sampleStart:0,sampleStride:1,unit:'m/s',rssiUnit:'%',values:[0,.001],rssi:[20,30],overrange:[false,false],latest:{velocity:.001,rssi:30},sourceSamples:2};
 if(phase==='error'){m.server.error='隔离测试：可见真实错误';m.server.pointCycle.error=m.server.error;}
};
createRoot(document.getElementById('root')).render(<FieldDesktopApp/>);
`;
buildSync({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,outfile:path.join(output,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><title>采集布局隔离验收</title></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const report={hardwareUsed:false,realServiceStarted:false,productionUserDataTouched:false,checks:[],screenshots:[],rendererErrors:[]};
let win,watchdog,currentCase='startup';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code,true).catch(e=>{throw Error(e.message+'\nCODE: '+code)});
const row='[...document.querySelectorAll(".field-auto-capture-list tbody tr")].find(e=>e.querySelector(".field-auto-capture-point")?.textContent==="P3")';
const primary='document.querySelector(".field-auto-capture-toolbar .field-auto-capture-primary")';
const buttons='[...document.querySelectorAll("button")].filter(e=>!e.closest("[hidden]"))';
async function wait(code){for(let i=0;i<200;i++){if(await js(code))return;await pause(25)}throw Error('Timed out '+code)}
async function click(code){await js('(()=>{const n='+code+';if(!n||n.disabled)throw Error("Action unavailable");n.click();})()');await pause(35)}
async function phase(next,point=1){const reads=await js('window.__layoutFixture.reads');await js('window.__layoutFixture.phase('+JSON.stringify(next)+','+point+')');await wait('window.__layoutFixture.reads>'+reads);await pause(150)}
async function rect(){return js('(()=>{const b=('+primary+').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,text:('+primary+').textContent,disabled:('+primary+').disabled,scrollY:scrollY};})()')}
async function stable(baseline,label,measurements){const current=await rect();measurements.push({state:label,...current});for(const k of ['x','y','width','height'])assert.ok(Math.abs(current[k]-baseline[k])<=1,`${label} ${k} moved ${current[k]-baseline[k]}px (${baseline[k]}→${current[k]})`)}
async function shot(name){fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());report.screenshots.push(name)}
async function startHeld(){await js('delete window.__layoutFixture.releaseStart');await click(primary);await wait('window.__layoutFixture.startPending&&!!window.__layoutFixture.releaseStart')}
function finish(e){clearTimeout(watchdog);report.passed=!e;if(e){report.error={case:currentCase,message:e.stack};console.error(e)}fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));app.exit(e?1:0)}
app.whenReady().then(async()=>{try{
 watchdog=setTimeout(()=>finish(Error('UI layout acceptance timeout')),120000);
 win=new BrowserWindow({width:1366,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)report.rendererErrors.push(event.message)});
 win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
 for(const [width,height] of [[1366,900],[1024,800]])for(const mode of ['分段采集','自动跟随']){
  currentCase=width+' '+mode;win.setSize(width,height);await win.loadFile(path.join(output,'index.html'));
  await wait('!!document.querySelector("input[aria-label=联动转盘与测振仪]")');
  await click('document.querySelector("input[aria-label=联动转盘与测振仪]")');
  await click(buttons+'.find(e=>e.textContent.trim()==='+JSON.stringify(mode)+')');
  await wait(primary+'&&!('+primary+').disabled');
  assert.equal(await js('document.querySelectorAll(".field-auto-capture-point").length'),5);
  assert.equal(await js('document.querySelectorAll(".field-auto-capture-primary").length'),1);
  assert.equal(await js('!!document.querySelector(".field-capture-aside")'),false);
  const second='document.querySelectorAll(".field-auto-capture-list tbody tr")[1]';
  await click('('+second+').querySelector("td")');
  assert.equal(await js('('+second+').dataset.selected'),'true','Clicking the radius cell selects P2');
  assert.match(await js('document.querySelector(".field-auto-capture-current strong").textContent'),/P2/);
  await click('('+row+').querySelector("td:last-child")');
  assert.equal(await js('('+row+').dataset.selected'),'true','Clicking the state cell selects P3');
  assert.match(await js('document.querySelector(".field-auto-capture-current strong").textContent'),/P3/);
  assert.equal(await js('window.__layoutFixture.calls.some(c=>c.action==="start"||c.request?.action==="recall")'),false,'Selecting a row does not move or acquire');

  await wait('!!document.querySelector(".field-sync-chip")');
  assert.match(await js('document.querySelector(".field-sync-chip").title'),/2 条近期已上传/);
  assert.equal(await js('!!document.querySelector(".field-cloud-sync-inline")'),false);
  await js('document.querySelector(".field-content").scrollTop=0');
  await shot(width+'-'+(mode==='分段采集'?'segmented':'auto')+'-header.png');
  await js('('+primary+').scrollIntoView({block:"center",inline:"end"})');await pause(160);
  const baseline=await rect(),measurements=[{state:'idle',...baseline}];
  assert.ok(baseline.height>=50,'Primary action must remain large under shared servo CSS');
  await shot(width+'-'+(mode==='分段采集'?'segmented':'auto')+'-idle.png');
  await startHeld();assert.equal(await js('('+primary+').disabled'),false);await stable(baseline,'start pending',measurements);
  await click('('+second+').querySelector("td")');
  assert.equal(await js('('+row+').dataset.selected'),'true','Pending start locks row selection');

  await phase('starting');await stable(baseline,'starting',measurements);
  await js('window.__layoutFixture.releaseStart()');await wait('!window.__layoutFixture.startPending');
  await phase('capturing');await stable(baseline,'capturing',measurements);
  await click('('+second+').querySelector("td:last-child")');
  assert.equal(await js('('+row+').dataset.selected'),'true','Live acquisition locks row selection');

  assert.match(await js('('+primary+').textContent'),/停止并保存/);
  assert.equal(await js('document.querySelector(".field-auto-capture-position").disabled'),true);
  await shot(width+'-'+(mode==='分段采集'?'segmented':'auto')+'-capturing.png');
  await phase('next',2);await stable(baseline,'next point',measurements);
  await phase('moving',2);await stable(baseline,'moving to wait',measurements);
  await phase('complete',2);await stable(baseline,'complete waiting',measurements);assert.equal(await js('('+primary+').disabled'),false);
  await startHeld();await stable(baseline,'next manual start',measurements);
  await phase('capturing');await js('window.__layoutFixture.releaseStart()');await wait('!window.__layoutFixture.startPending');
  await phase('stopping');await stable(baseline,'stopping',measurements);
  await click(primary);await wait('window.__layoutFixture.stopPending');await stable(baseline,'stop request pending',measurements);assert.equal(await js('('+primary+').disabled'),true);
  await js('window.__layoutFixture.phase("cancelled");window.__layoutFixture.releaseStop()');await wait('!window.__layoutFixture.stopPending');await pause(250);
  // Explicit stop notices/error banners may change page flow; ensure recovery
  // is actionable, then start again to dismiss the transient notice normally.
  assert.equal(await js('('+primary+').disabled'),false);
  await startHeld();await js('window.__layoutFixture.phase("idle");window.__layoutFixture.releaseStart()');await pause(300);
  await phase('error');assert.ok((await js('document.body.innerText')).includes('隔离测试：可见真实错误'));
  await phase('idle');await stable(baseline,'recovered idle',measurements);assert.equal(await js('('+primary+').disabled'),false);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'),true,'Only the point table may scroll horizontally');
  report.checks.push({name:currentCase,measurements});console.log('PASS '+currentCase+' fixed button across '+measurements.length+' states');
 }
 assert.deepEqual(report.rendererErrors,[]);finish();
}catch(e){finish(e)}});
