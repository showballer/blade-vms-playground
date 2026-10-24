'use strict';
// Isolated renderer; never opens the production profile or sends device requests.
const {app,BrowserWindow}=require('electron');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ui=path.join(root,'packages/ui/src'),out=path.join(root,'artifacts/task-search-ui');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'blade-task-search-')));
const source=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {FieldTaskRecords} from ${JSON.stringify(path.join(ui,'field-recording-tasks.tsx'))};
import {FieldBladeSummary} from ${JSON.stringify(path.join(ui,'field-blade-summary.tsx'))};
import {CustomSelect} from ${JSON.stringify(path.join(ui,'custom-select.tsx'))};
${['styles','field-styles','field-blade-summary','custom-select'].map(n=>`import ${JSON.stringify(path.join(ui,n+'.css'))};`).join('\n')}
const records=Array.from({length:12},(_,i)=>{const id=(i+1).toString(16).padStart(32,'0');return {id,name:i<2?'1024-16-13-P3':i===2?'叶尖复测':'历史任务 '+i,windFarm:i===1?'北风场':'南风场',turbine:'WT-'+String(i+1).padStart(3,'0'),object:'叶片',source:'polytec_ivs500',status:'complete',samples:100,sampleRate:1000,startedAt:1792800000-i,endedAt:1792800001-i,
pointCycle:{mode:'automatic_stations',collectionId:id,sessionId:id,bladeId:'2',radialPointId:'P3',radialPointName:'P3',radiusM:.44,stationCount:1,stationIndex:1,lapIndex:1,cycles:1,cycle:1,pointIndex:1,pointId:'station-1',pointName:'点位1',dwellSeconds:5,targetAxis1AngleDeg:10,targetAxis2AngleDeg:0,completion:'confirmed_pass'}}});
const f=window.__taskSearch={records,exports:[]};
function App(){const[busy,setBusy]=useState(false);f.setBusy=setBusy;return <main className="field-content"><h1>本机记录</h1><section className="field-card"><h2>本机采集记录</h2><FieldTaskRecords recordings={records} busy={busy} onExportTask={ids=>f.exports.push(ids)}>{items=>{f.visible=items.map(r=>r.id);return <p>{items.length} 条记录</p>}}</FieldTaskRecords></section><FieldBladeSummary recordings={records} onExportTask={ids=>f.exports.push(ids)}/><label>普通选择<CustomSelect aria-label="普通选择" defaultValue="a"><option value="a">甲</option><option value="b">乙</option></CustomSelect></label><button id="after-select">下一项</button></main>};
createRoot(document.getElementById('root')).render(<App/>);`;
buildSync({stdin:{contents:source,loader:'tsx',resolveDir:root},bundle:true,outfile:path.join(out,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>');
let win;const checks=[],errors=[],pause=ms=>new Promise(r=>setTimeout(r,ms));const js=c=>win.webContents.executeJavaScript(c,true);
async function wait(c){for(let i=0;i<100;i++){if(await js(c))return;await pause(20)}throw Error('Timeout '+c)}
async function open(label){await js(`(()=>{const b=document.querySelector('button[role=combobox][aria-label="${label}"]');b.focus();b.click()})()`);await wait('!!document.querySelector(".custom-select-popup")');await pause(30)}
async function search(value){await js(`(()=>{const e=document.querySelector('.custom-select-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(50)}
async function key(keyCode){win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await pause(50)}
const options=()=>js('[...document.querySelectorAll(".custom-select-popup [role=option]")].map(x=>x.textContent)');
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name)}
app.whenReady().then(async()=>{try{
win=new BrowserWindow({width:1200,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
await win.loadFile(path.join(out,'index.html'));await wait('!!document.querySelector(".field-blade-summary")');
await check('任务名搜索保留同名任务，输入时不切换任务',async()=>{await open('筛选采集任务');assert.equal(await js('document.activeElement.type'),'search');await search('1024-16-13-P3');assert.equal((await options()).length,2);assert.equal((await js('window.__taskSearch.visible')).length,12);});
await check('按风场和风机筛选，回车选中后导出范围正确',async()=>{await search('北风场 wt-002');assert.equal((await options()).length,1);await key('Enter');assert.equal(await js('!!document.querySelector(".custom-select-popup")'),false);const id='2'.padStart(32,'0');assert.deepEqual(await js('window.__taskSearch.visible'),[id]);await js('document.querySelector(".field-task-export-toolbar > button").click()');assert.deepEqual(await js('window.__taskSearch.exports.at(-1)'),[id]);});
await check('无匹配不改变选择，Escape退出，重开清空关键词',async()=>{await open('筛选采集任务');assert.equal(await js('document.querySelector(".custom-select-search input").value'),'');await search('不存在的任务');assert.equal((await options()).length,0);await key('Enter');assert.equal(await js('!!document.querySelector(".custom-select-popup")'),true);await key('Escape');assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'筛选采集任务');assert.deepEqual(await js('window.__taskSearch.visible'),['2'.padStart(32,'0')]);await open('筛选采集任务');await search('');assert.equal((await options()).length,13);await key('Escape');});
await check('汇总任务支持中文输入法，组合输入回车不误选',async()=>{await open('选择汇总任务');await search('叶尖');assert.equal((await options()).length,1);await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}))');assert.equal(await js('!!document.querySelector(".custom-select-popup")'),true);await key('Enter');const value=await js('document.querySelector("select[aria-label=选择汇总任务]").value');assert.ok(value.includes('3'.padStart(32,'0')));await js('document.querySelector(".field-blade-task-picker > button").click()');assert.deepEqual(await js('window.__taskSearch.exports.at(-1)'),['3'.padStart(32,'0')]);});
await check('方向键可选过滤结果，Tab退出不锁住焦点',async()=>{await open('选择汇总任务');await search('1024');await key('Down');await key('Enter');assert.ok((await js('document.querySelector("select[aria-label=选择汇总任务]").value')).includes('2'.padStart(32,'0')));await open('筛选采集任务');await key('Tab');assert.equal(await js('!!document.querySelector(".custom-select-popup")'),false);assert.equal(await js('document.activeElement===document.body'),false);});
await check('普通下拉框保留原键盘选择行为',async()=>{await open('普通选择');assert.equal(await js('!!document.querySelector(".custom-select-search")'),false);await key('Down');await key('Enter');assert.equal(await js('document.querySelector("select[aria-label=普通选择]").value'),'b');});
await check('忙碌状态无法打开任务选择，恢复后可正常搜索',async()=>{await js('window.__taskSearch.setBusy(true)');await pause(40);assert.equal(await js('document.querySelector("button[aria-label=筛选采集任务]").disabled'),true);await js('window.__taskSearch.setBusy(false)');await pause(40);await open('筛选采集任务');await search('1024');});
fs.writeFileSync(path.join(out,'task-search.png'),(await win.webContents.capturePage()).toPNG());assert.deepEqual(errors,[]);
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,hardwareUsed:false,checks,errors},null,2));app.exit(0);
}catch(error){console.error(error);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));app.exit(1)}});
