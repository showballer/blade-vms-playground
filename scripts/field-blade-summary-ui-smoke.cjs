'use strict';
// Disposable renderer fixture only: no real profile, acquisition service, or device.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'packages/ui/src');
const out = path.join(root, 'artifacts/blade-summary-ui'); fs.mkdirSync(out, {recursive:true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(),'blade-summary-ui-')));
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FieldBladeSummary} from ${JSON.stringify(path.join(ui,'field-blade-summary.tsx'))};
import {summarizeBladeRecords} from ${JSON.stringify(path.join(ui,'field-blade-summary-data.ts'))};
import {recordingExportIds,groupRecordingTasks} from ${JSON.stringify(path.join(ui,'field-recording-tasks.tsx'))};
${['styles','field-styles','field-turntable','field-blade-summary'].map(name=>`import ${JSON.stringify(path.join(ui,name+'.css'))};`).join('\n')}
const records=[];let serial=0;
function add(task,blade,point,count=4,mode='manual_segments',old=false){
 const radius=[.16,.30,.44,.58,.72][point-1];
 const plan=[0,90,180,270].map((azimuthDeg,i)=>({pointId:'p'+point+'-'+i,bladeId:blade,radialPointId:'P'+point,radialPointName:'P'+point,radiusM:radius,azimuthDeg,stationIndex:i+1,stationCount:4,axis1AngleDeg:point+i,axis2AngleDeg:i}));
 for(let i=0;i<count;i++){
  const id='fixture-'+(++serial);const start=1792800000+(task==='a'?3600:0)+point*10+i+(old?-1000:0);
  records.push({id,name:'1号风机叶片检测',windFarm:'WF-001',turbine:task==='a'?'WT-001':'WT-002',object:'风机叶片',source:'polytec_ivs500',status:'complete',sampleRate:250000,samples:80000+i*10000,startedAt:start,endedAt:start+1,unit:'m/s',
   pointCycle:{mode:'automatic_stations',executionMode:mode,collectionId:task.repeat(32),sessionId:(serial.toString(16).padStart(32,'0')),bladeId:blade,radialPointId:'P'+point,radialPointName:'P'+point,radiusM:radius,lapIndex:1,cycle:1,cycles:1,pointIndex:i,stationIndex:i+1,stationCount:4,pointId:plan[i].pointId,pointName:'点位 '+(i+1),azimuthDeg:i*90,plannedStations:plan,segmentStations:plan,segmentStationIds:[plan[i].pointId],segmentStepDeg:90,totalStationCount:4,completion:'confirmed_pass',targetAxis1AngleDeg:point+i,targetAxis2AngleDeg:i,dwellSeconds:30,recordedPort:'TEST',referenceSignature:'fixture-ref'}});
 }
}
for(let p=1;p<=5;p++)add('a','2',p,p===2?2:4);
add('a','1',1);add('a','3',1);add('b','2',1);
const old={...records.find(r=>r.pointCycle.radialPointId==='P3'),id:'history-retry',status:'error',error:'等待离开超时'};old.pointCycle={...old.pointCycle,completion:'missing_exit',sessionId:'f'.repeat(32)};old.startedAt-=10;old.endedAt-=10;records.push(old);
const failed=records.find(r=>r.pointCycle.radialPointId==='P4');failed.status='error';failed.error='定位异常';failed.pointCycle.completion='device_error';
add('a','2',1,1,'continuous',true);
const f=window.__summaryFixture={records,exports:[],opened:[],summary:summarizeBladeRecords(records),expected:(task,blade,point)=>recordingExportIds(records,task,blade,point)};
function App(){const [items,setItems]=useState(records),[busy,setBusy]=useState(false);f.setItems=setItems;f.setBusy=setBusy;
 return <div className="field-app"><header className="field-header"><div className="field-brand">BladeVMS <small>汇总界面验收 · 隔离数据</small></div></header><div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button>数据采集</button><button>转盘点位</button><button className="active">本机记录</button><button>设备与服务</button></aside><main className="field-content"><div className="field-page-heading"><h1>本机记录</h1></div><FieldBladeSummary recordings={items} busy={busy} syncItems={items.slice(0,5).map(r=>({recordingId:r.id,state:'synced'}))} onExportTask={(ids,level)=>f.exports.push({ids,level:level||'task'})} onOpenRecording={id=>f.opened.push(id)}/></main></div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
buildSync({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,outfile:path.join(out,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
let win;const errors=[],checks=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function wait(code){for(let i=0;i<160;i++){if(await js(code))return;await sleep(25)}throw Error('Timeout '+code)}
async function click(selector){await js('(()=>{const n=document.querySelector('+JSON.stringify(selector)+');if(!n||n.disabled)throw Error("Action unavailable "+'+JSON.stringify(selector)+');n.click()})()');await sleep(60)}
async function choose(label,value){await click('button[role="combobox"][aria-label="'+label+'"]');await js('(()=>{const select=document.querySelector('+JSON.stringify('select[aria-label="'+label+'"]')+');const index=[...select.options].findIndex(o=>o.value==='+JSON.stringify(value)+');document.querySelectorAll("[role=option]")[index].click()})()');await sleep(80)}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name)}
async function checkExport(selector,task,blade,point,level){await click(selector);const result=await js('window.__summaryFixture.exports.at(-1)');const expected=await js('window.__summaryFixture.expected('+[task,blade,point].map(v=>JSON.stringify(v)??'undefined').join(',')+')');assert.deepEqual([...result.ids].sort(),expected.sort());assert.equal(result.level,level)}
async function shot(name){fs.writeFileSync(path.join(out,name),(await win.webContents.capturePage()).toPNG())}
function finish(error){fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:!error,hardwareUsed:false,productionUserDataTouched:false,checks,errors,error:error?.stack},null,2));if(error)console.error(error);app.exit(error?1:0)}
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1366,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
 await win.loadFile(path.join(out,'index.html'));await wait('!!document.querySelector(".field-blade-summary")');await sleep(100);
 if(process.argv.includes('--baseline')){await shot('before.png');finish();return;}
 const taskA=await js('window.__summaryFixture.summary.tasks.find(t=>t.collectionId==="a".repeat(32)).key');
 const taskB=await js('window.__summaryFixture.summary.tasks.find(t=>t.collectionId==="b".repeat(32)).key');
 const point3='details.field-blade-point[aria-label="叶片 2 · P3"]';
 await check('任务选择与叶片切换仅展示当前范围，每个测点只占一行',async()=>{
  assert.equal(await js('document.querySelectorAll("select[aria-label=选择汇总任务] option").length'),2);
  assert.equal(await js('document.querySelectorAll(".field-blade-tabs [role=tab]").length'),3);
  await click('.field-blade-tabs button:nth-child(2)');
  assert.equal(await js('document.querySelectorAll(".field-blade-point").length'),5);
  assert.equal(await js('document.querySelectorAll(".field-blade-collection").length'),1);
  await shot('overview-1366.png');
 });
 await check('分段累计完整度保留，历史记录折叠且可分别打开波形',async()=>{
  await click(point3+' > summary');
  assert.match(await js('document.querySelector('+JSON.stringify(point3+' > summary')+').innerText'),/4 \/ 4/);
  assert.equal(await js('document.querySelectorAll('+JSON.stringify(point3+' table > tbody > tr')+').length'),4);
  await click(point3+' button[aria-label="查看 0° 历史记录"]');
  assert.equal(await js('document.querySelectorAll(".field-blade-history-list > div").length'),2);
  await click('.field-blade-history-list > div:last-child button');
  assert.equal(await js('window.__summaryFixture.opened.at(-1)'),'history-retry');
  await js('document.querySelector('+JSON.stringify(point3)+').scrollIntoView({block:"start"})');await sleep(60);await shot('detail-1366.png');
 });
 await check('三级导出范围准确，测点导出包含全部历史与批次',async()=>{
  await checkExport('.field-blade-task-picker > button',taskA,undefined,undefined,'task');
  await checkExport('.field-blade-collection-heading > button',taskA,'2',undefined,'blade');
  await checkExport(point3+' button[aria-label="导出叶片 2 测点 P3全部数据"]',taskA,'2','P3','point');
  assert.ok((await js('window.__summaryFixture.exports.at(-1).ids')).includes('history-retry'));
 });
 await check('同测点旧批次可切换，不把旧缺口合成最新完整度',async()=>{
  await click('details[aria-label="叶片 2 · P1"] > summary');
  const keys=await js(`[...document.querySelector('select[aria-label="P1 观测组"]').options].map(o=>o.value)`);
  assert.equal(keys.length,2);await choose('P1 观测组',keys[1]);
  assert.match(await js(`document.querySelector('details[aria-label="叶片 2 · P1"] > summary').innerText`),/1 \/ 4/);
  await choose('P1 观测组',keys[0]);
  assert.match(await js(`document.querySelector('details[aria-label="叶片 2 · P1"] > summary').innerText`),/4 \/ 4/);
 });
 await check('同名任务切换不会串叶片与导出记录',async()=>{
  await choose('选择汇总任务',taskB);
  assert.equal(await js('document.querySelectorAll(".field-blade-tabs [role=tab]").length'),1);
  assert.equal(await js('document.querySelectorAll(".field-blade-point").length'),1);
  await checkExport('.field-blade-task-picker > button',taskB,undefined,undefined,'task');
 });
 await check('刷新新增任务保留当前选择，移除当前任务后回退到有效任务',async()=>{
  await js('(()=>{const f=window.__summaryFixture;const extra=structuredClone(f.records.find(r=>r.pointCycle.collectionId==="b".repeat(32)));extra.id="new-record";extra.pointCycle.collectionId="c".repeat(32);extra.endedAt+=100000;extra.startedAt+=100000;f.setItems([...f.records,extra]);})()');await sleep(80);
  assert.equal(await js('document.querySelector("select[aria-label=选择汇总任务]").value'),taskB);
  await js('window.__summaryFixture.setItems(window.__summaryFixture.records.filter(r=>r.pointCycle.collectionId!=="b".repeat(32)))');await sleep(80);
  assert.equal(await js('document.querySelector("select[aria-label=选择汇总任务]").value'),taskA);
 });
 await check('导出忙时禁止重复导出，叶片标签支持键盘切换',async()=>{
  await js('window.__summaryFixture.setBusy(true)');await sleep(60);
  assert.equal(await js('[...document.querySelectorAll("button[aria-label^=导出]")].every(b=>b.disabled)'),true);
  await js('document.querySelector(".field-blade-tabs button").focus()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});await sleep(60);
  assert.match(await js('document.activeElement.textContent'),/叶片 3/);
  assert.equal(await js('document.activeElement.getAttribute("aria-selected")'),'true');
  await js('window.__summaryFixture.setBusy(false)');await sleep(40);
 });
 await check('空态可恢复，窄窗口只有明细表内部横向滚动',async()=>{
  await js('window.__summaryFixture.setItems([])');await sleep(60);assert.match(await js('document.body.innerText'),/暂无可汇总/);
  await js('window.__summaryFixture.setItems(window.__summaryFixture.records)');await sleep(60);
  await click('.field-blade-tabs button:nth-child(2)');win.setSize(1024,800);await sleep(100);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'),true);
  await js('document.querySelector(".field-content").scrollTop=0');await sleep(60);await shot('overview-1024.png');await click(point3+' > summary');await sleep(40);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'),true);await js('document.querySelector('+JSON.stringify(point3)+').scrollIntoView({block:"start"})');await sleep(60);await shot('detail-1024.png');
 });
 assert.deepEqual(errors,[]);finish();
}catch(error){finish(error)}});
