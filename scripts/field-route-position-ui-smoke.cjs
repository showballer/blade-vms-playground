'use strict';
// Real desktop React tree with an in-memory bridge and disposable profile.
// No SDK, real acquisition service, device, real account, or production storage.
const {app,BrowserWindow}=require('electron');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ui=path.join(root,'packages/ui/src');
const output=path.join(root,'artifacts/route-position-ui-smoke');fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'blade-route-position-')));
const fixture=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {FieldDesktopApp} from ${JSON.stringify(path.join(ui,'field-desktop.tsx'))};
import {defaultAutoFollowSurvey,autoFollowStorageKey} from ${JSON.stringify(path.join(ui,'field-auto-follow-config.ts'))};
import {turntableReferenceSignature} from ${JSON.stringify(path.join(ui,'field-turntable-points.ts'))};
${['styles','field-styles','field-turntable','field-auto-follow','field-auto-capture-list','field-header-laser','field-turntable-health','field-blade-summary','field-cycle-motion'].map(x=>`import ${JSON.stringify(path.join(ui,x+'.css'))};`).join('\n')}
const axis=limit=>({output_angle_deg:0,motor_rpm:0,actual_counts:0,commanded_counts:0,error_counts:0,display_mode:3,command_counts_per_rev:10000,encoder_bits:17,flags:3,fault:0,origin_counts:0,home_phase:0,observedAt:Date.now()/1000,referenceAngleDeg:0,guard:{soft_enabled:true,hardware_enabled:false,minimum_deg:-limit,maximum_deg:limit}});
const base={service:{state:'ready',dllConfigured:true,generation:1},state:'idle',receiver:{running:false},deviceBusy:false,turntableBusy:false,pointCycleExecutionModes:['continuous','manual_segments'],turntable:{state:'checked',port:'COM6',axis:1,motionCapability:{supported:true,mode:'dual_axis_timed',pointMode:'drive_internal',preloadedPoints:true,protocol:'0x30-0x36',probe:'confirmed',status:{state:0,fault:0}},feedback:{axes:{'1':axis(35),'2':axis(180)},motorRpm:0,outputRpm:0,alarmCode:0,limitFlags:0,positionRaw:0}}};
const m=window.__positionFixture={base,server:structuredClone(base),calls:[],reads:0,failRecall:false,holdRecall:false,transportFailure:false};
const snapshot=()=>{for(const a of Object.values(m.server.turntable.feedback.axes))a.observedAt=Date.now()/1000;return structuredClone(m.server)};
localStorage.setItem('blade-field-config-v1',JSON.stringify({name:'图上点位定位验收',deviceIp:'192.0.2.90',hostIp:'192.0.2.10',object:'风机叶片',turbine:'T1',point:''}));
localStorage.setItem('blade-turntable-connection-v1',JSON.stringify({version:1,endpoint:'COM6'}));
const survey=defaultAutoFollowSurvey();survey.port='COM6';survey.settings={...survey.settings,distanceM:2.5,periodSeconds:5,stepDeg:90,maxMoveRpm:5,maxMoveAccelerationDegS2:30};survey.heights={hubHeightM:1.5,laserHeightM:.77};survey.blades=[{id:'blade-test',name:'2',lengthM:.8,rootReservePercent:20,tipReservePercent:10,points:[{id:'p4',name:'P4',radiusM:.58}]}];survey.selectedBladeId='blade-test';survey.selectedPointId='p4';localStorage.setItem(autoFollowStorageKey,JSON.stringify(survey));
localStorage.setItem('blade-segmented-capture-v1',JSON.stringify({pointsPerStart:2,stepDeg:90,startAzimuthDeg:0,starts:{}}));
localStorage.setItem('blade-turntable-points-v2',JSON.stringify([{pointId:'m1',name:'M1',axis1AngleDeg:2,axis2AngleDeg:3},{pointId:'m2',name:'M2',axis1AngleDeg:5,axis2AngleDeg:6}].map(p=>({...p,port:'COM6',referenceSignature:turntableReferenceSignature(base.turntable.feedback.axes)}))));
window.blade={windowControl:()=>{},field:async o=>{
 m.calls.push(structuredClone(o));
 const ok=data=>({status:200,data});
 if(o.action==='accountInfo')return ok({mode:'local'});
 if(o.action==='session')return ok({user:{id:'fixture',username:'fixture',name:'隔离测试'},mustChangePassword:false});
 if(o.action==='syncStatus')return ok({enabled:false,connected:false,state:'unbound',items:[]});
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
 if(o.action==='start')return ok(snapshot());
 throw Error('Unexpected isolated operation '+JSON.stringify(o));
}};
createRoot(document.getElementById('root')).render(<FieldDesktopApp/>);
`;
buildSync({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,outfile:path.join(output,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><title>图上定位隔离验收</title></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const report={hardwareUsed:false,realServiceStarted:false,productionUserDataTouched:false,checks:[],rendererErrors:[]};let win,watchdog,currentCase='startup';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code,true).catch(e=>{throw Error(e.message+'\nCODE: '+code)});
const visibleButtons='[...document.querySelectorAll("button")].filter(e=>!e.closest("[hidden]"))';
const button=text=>visibleButtons+'.find(e=>e.textContent.trim()==='+JSON.stringify(text)+')';
const plot='.field-cycle-motion';
const station=angle=>'[...document.querySelectorAll("'+plot+' g[data-station]")].find(e=>e.querySelector("text")?.textContent.endsWith('+JSON.stringify(' · '+angle+'°')+'))';
const manual=id=>'document.querySelector('+JSON.stringify(plot+' g[data-station="'+id+'"]')+')';
const row='document.querySelector(".field-auto-capture-list tbody tr")';
const calls=kind=>'window.__positionFixture.calls.filter(c=>c.action==="turntable"&&c.request.action==='+JSON.stringify(kind)+')';
async function wait(code){for(let i=0;i<240;i++){if(await js(code))return;await pause(25)}throw Error('Timed out '+code)}
async function click(code){await js('(()=>{const n='+code+';if(!n||n.disabled)throw Error("Action unavailable");n.dispatchEvent(new MouseEvent("click",{bubbles:true}));})()')}
async function key(code,k){await js('('+code+').dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(k)+',bubbles:true}))')}
async function mode(name){await click(button(name));await pause(80)}
async function changed(code){const r=await js('window.__positionFixture.reads');await js(code);await wait('window.__positionFixture.reads>'+r);await pause(80)}
async function settled(){await wait('!document.querySelector("[aria-label=预定位控制]")');await pause(160)}
async function check(name,fn){currentCase=name;await fn();report.checks.push(name);console.log('PASS '+name)}
function finish(e){clearTimeout(watchdog);report.passed=!e;if(e){report.error={case:currentCase,message:e.stack};console.error(e)}fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));app.exit(e?1:0)}
app.whenReady().then(async()=>{try{
 watchdog=setTimeout(()=>finish(Error('UI acceptance timeout')),90000);
 win=new BrowserWindow({width:1440,height:1100,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)report.rendererErrors.push(event.message)});
 win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
 await win.loadFile(path.join(output,'index.html'));await wait('!!document.querySelector("input[aria-label=联动转盘与测振仪]")');
 await click('document.querySelector("input[aria-label=联动转盘与测振仪]")');await mode('分段采集');
 await check('两轴校正从配置保存并传入分段定位，测点半径保持不变',async()=>{
  await click(button('转盘点位'));await mode('分段采集');
  await wait('!!document.querySelector("input[aria-label=俯仰角校正系数]")');
  await js('(()=>{const input=document.querySelector("input[aria-label=俯仰角校正系数]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"0.896932");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await wait('JSON.parse(localStorage.getItem("blade-auto-follow-draft-v1")).settings.pitchAngleScale===.896932');
  await js('(()=>{const input=document.querySelector("input[aria-label=水平角校正系数]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"0.950153");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await wait('JSON.parse(localStorage.getItem("blade-auto-follow-draft-v1")).settings.yawAngleScale===.950153');
  assert.equal(await js('JSON.parse(localStorage.getItem("blade-auto-follow-draft-v1")).blades[0].points[0].radiusM'),.58);
  await click(button('数据采集'));await pause(100);
 });
 await wait(station(180)+'?.getAttribute("aria-disabled")==="false"');
 await check('分段点位双击只定位一次，成功后同步本段与段后位置',async()=>{
  await js('window.__positionFixture.holdRecall=true');
  const before=await js(calls('recall')+'.length');
  await js('(()=>{const n='+station(180)+';n.dispatchEvent(new MouseEvent("click",{bubbles:true}));n.dispatchEvent(new MouseEvent("click",{bubbles:true}));})()');
  await wait('!!window.__positionFixture.releaseRecall');assert.equal(await js(calls('recall')+'.length'),before+1);
  const corrected=await js(calls('recall')+'.at(-1).request');
  assert.ok(Math.abs(corrected.axis1AngleDeg-.896932*Math.atan2(.73+.58,2.5)*180/Math.PI)<.001);
  assert.ok(Math.abs(corrected.axis2AngleDeg)<.001);
  assert.equal(await js('window.__positionFixture.calls.filter(c=>c.action==="start").length'),0);
  assert.ok((await js('document.querySelector(".field-auto-capture-scroll table tbody").innerText')).includes('0° → 90°'));
  await js('window.__positionFixture.holdRecall=false;window.__positionFixture.releaseRecall()');await settled();
  await wait('document.querySelector(".field-auto-capture-scroll table tbody").innerText.includes("180° → 270°")');
  const cells=await js('[...document.querySelectorAll(".field-auto-capture-scroll table tbody tr:first-child td")].map(e=>e.innerText)');assert.equal(cells[2],'0°');
  assert.equal(await js('Object.values(JSON.parse(localStorage.getItem("blade-segmented-capture-v1")).starts)[0]'),180);
  await js('document.querySelector(".field-cycle-motion").scrollIntoView({block:"end"})');await pause(80);
  fs.writeFileSync(path.join(output,'segmented-position-success.png'),(await win.webContents.capturePage()).toPNG());
 });
 await check('定位失败不推进本段及等待点',async()=>{
  await js('window.__positionFixture.failRecall=true');const n=await js(calls('recall')+'.length');await click(station(90));await wait(calls('recall')+'.length>'+n);await settled();
  assert.ok((await js('document.querySelector(".field-auto-capture-scroll table tbody").innerText')).includes('180° → 270°'));
  assert.equal(await js('Object.values(JSON.parse(localStorage.getItem("blade-segmented-capture-v1")).starts)[0]'),180);await js('window.__positionFixture.failRecall=false');
 });
 await check('取消定位保留当前段与等待点',async()=>{
  await js('window.__positionFixture.holdRecall=true;delete window.__positionFixture.releaseRecall');
  await click(station(90));await wait('!!window.__positionFixture.releaseRecall');await click(button('停止定位'));
  await js('window.__positionFixture.holdRecall=false;window.__positionFixture.releaseRecall()');await settled();
  assert.ok((await js('document.querySelector(".field-auto-capture-scroll table tbody").innerText')).includes('180° → 270°'));
  assert.equal(await js('Object.values(JSON.parse(localStorage.getItem("blade-segmented-capture-v1")).starts)[0]'),180);
 });
 await check('键盘定位同步新起点，开始采集使用新段且不重复预定位',async()=>{
  const before=await js(calls('recall')+'.length');await key(station(270),'Enter');await wait(calls('recall')+'.length>'+before);await settled();
  await wait('document.querySelector(".field-auto-capture-scroll table tbody").innerText.includes("270° → 0°")');
  const recalls=await js(calls('recall')+'.length');await click('document.querySelector("button[aria-label^=开始采集叶片]")');await wait('window.__positionFixture.calls.some(c=>c.action==="start")');
  const start=await js('window.__positionFixture.calls.findLast(c=>c.action==="start")');assert.deepEqual(start.config.pointCycle.points.map(p=>p.azimuthDeg),[270,0]);assert.equal(start.config.pointCycle.nextWaitPoint.azimuthDeg,90);assert.equal(await js(calls('recall')+'.length'),recalls);await settled();
  assert.equal(start.config.pointCycle.geometry.pitchAngleScale,.896932);
  assert.equal(start.config.pointCycle.geometry.yawAngleScale,.950153);
  assert.ok(Math.abs(start.config.pointCycle.points[0].axis2AngleDeg-.950153*Math.atan2(.58,2.5)*180/Math.PI)<.001);
 });
 await check('自动跟随图保持只读',async()=>{await mode('自动跟随');assert.equal(await js('document.querySelectorAll(".field-cycle-motion g[role=button]").length'),0);const n=await js(calls('recall')+'.length');await click(station(90));await pause(100);assert.equal(await js(calls('recall')+'.length'),n)});
 await check('手动图定位M2后按M2到M1采集，Space可定位',async()=>{
  await mode('手动点位');await wait(manual('m2')+'?.getAttribute("aria-disabled")==="false"');const n=await js(calls('recall')+'.length');await key(manual('m2'),' ');await wait(calls('recall')+'.length>'+n);await settled();
  const q=await js(calls('recall')+'.at(-1).request');assert.equal(q.axis1AngleDeg,5);assert.equal(q.axis2AngleDeg,6);
  await wait('document.body.innerText.includes("M2 → M1")');assert.equal(await js('JSON.parse(localStorage.getItem("blade-manual-capture-route-v1")).startPointId'),'m2');
 });
 await check('正在采集时图上点位禁止点击',async()=>{
  const before=await js(calls('recall')+'.length');
  await changed('(()=>{const s=window.__positionFixture.server;s.state="acquiring";s.receiver.running=true;s.pointCycle={state:"waiting_blade",port:"COM6",mode:"legacy",point:1,pointCount:2,cycle:1,cycles:1,plannedStations:JSON.parse(localStorage.getItem("blade-turntable-points-v2")),currentPoint:"M2",targetPointId:"m2"}})()');
  assert.equal(await js(manual('m1')+'.getAttribute("aria-disabled")'),'true');await click(manual('m1'));await key(manual('m1'),'Enter');await pause(80);assert.equal(await js(calls('recall')+'.length'),before);
  await changed('window.__positionFixture.server.state="idle";window.__positionFixture.server.receiver.running=false;delete window.__positionFixture.server.pointCycle');
 });
 await check('设备忙与断线期间拒绝图点击和键盘移动',async()=>{
  const before=await js(calls('recall')+'.length');await changed('window.__positionFixture.server.deviceBusy=true');assert.equal(await js(manual('m1')+'.getAttribute("aria-disabled")'),'true');await click(manual('m1'));await key(manual('m1'),'Enter');await pause(80);assert.equal(await js(calls('recall')+'.length'),before);
  await changed('window.__positionFixture.server.deviceBusy=false;window.__positionFixture.transportFailure=true');assert.equal(await js(manual('m1')+'.getAttribute("aria-disabled")'),'true');await click(manual('m1'));await pause(80);assert.equal(await js(calls('recall')+'.length'),before);
  await changed('window.__positionFixture.transportFailure=false');
 });
 assert.equal(report.rendererErrors.length,0,report.rendererErrors.join('\n'));finish();
}catch(e){finish(e)}}).catch(finish);
