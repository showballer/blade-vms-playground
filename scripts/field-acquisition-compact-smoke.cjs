'use strict';
// Renderer-only workflow check. No bridge, SDK, network or user profile access.
const {app,BrowserWindow}=require('electron');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ui=path.join(root,'packages/ui/src');
const out=path.join(root,'artifacts/acquisition-compact-20261028');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'blade-acquisition-compact-'));app.setPath('userData',profile);app.on('window-all-closed',()=>{});
const fixture=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {FieldAcquisition} from ${JSON.stringify(path.join(ui,'field-acquisition.tsx'))};
import {autoFollowDefaults} from ${JSON.stringify(path.join(ui,'field-auto-follow-plan.ts'))};
import {planSegmentedFollow} from ${JSON.stringify(path.join(ui,'field-segmented-plan.ts'))};
${['styles','field-styles','field-turntable','field-auto-follow','field-auto-capture-list','field-blade-summary','field-cycle-motion'].map(x=>`import ${JSON.stringify(path.join(ui,x+'.css'))};`).join('\n')}
window.calls=[];
const initial={name:'分段采集布局验收',windFarm:'WF-001',turbine:'T1',object:'风机叶片',point:'',deviceIp:'192.0.2.90',hostIp:'192.0.2.10'};
const targets=[1,2,3].flatMap(blade=>[1,2,3,4,5].map(n=>{
 const plan=planSegmentedFollow({...autoFollowDefaults,distanceM:2.5,hubHeightDeltaM:.73,bladeId:String(blade),points:[{id:'P'+n,name:'P'+n,radiusM:n*.12}],activePointId:'P'+n},{pointsPerStart:1,stepDeg:90,startAzimuthDeg:0,autoMove:true},null,'drive_internal','COM6');
 return {key:blade+'-P'+n,bladeKey:String(blade),bladeId:String(blade),pointId:'P'+n,pointName:'P'+n,radiusM:n*.12,cycles:1,stations:1,route:{kind:'segmented',name:'叶片'+blade,pointNames:plan.points.map(p=>p.name),referenceMode:'read_at_start',errors:plan.errors,cycle:plan.pointCycle}};
}));
function Demo(){const[config,onConfig]=useState(initial),[key,setKey]=useState('1-P1'),[auto,setAuto]=useState(true);
 const items=targets.map(t=>({...t,route:{...t.route,cycle:{...t.route.cycle,segmentedAutoMove:auto}}}));
 const route={...items.find(t=>t.key===key).route,targets:items,selectedTargetKey:key};
 return <main className="field-app"><div className="field-content"><h1>数据采集</h1><FieldAcquisition config={config} onConfig={onConfig} source="device" status={{service:{state:'ready',dllConfigured:true,generation:1},state:'idle'}} busy="" pollError="" windowMs={1000} onWindow={()=>{}} refreshMs={250} onRefresh={()=>{}} request={async()=>({})} onDeviceStart={()=>window.calls.push('device-start')} onStop={()=>{}} onService={()=>{}} onRecords={()=>{}}
 link={{enabled:true,onEnabled:()=>{},mode:'segmented',onMode:()=>{},route,errors:[],onConfigure:()=>{},onSelectTarget:k=>{window.calls.push('select:'+k);setKey(k)},onStartTarget:k=>window.calls.push('start:'+k),onPosition:k=>window.calls.push('position:'+k),onSegmentAutoMove:value=>{window.calls.push('auto:'+value);setAuto(value)}}}/></div></main>;
}createRoot(document.getElementById('root')).render(<Demo/>);
`;
buildSync({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,outfile:path.join(out,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
const report={hardwareTested:false,networkUsed:false,productionUserDataTouched:false,checks:[]};let win;
const js=code=>win.webContents.executeJavaScript(code,true);
async function wait(code){for(let i=0;i<150;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('UI timeout: '+code);}
app.whenReady().then(async()=>{let failure;const guard=setTimeout(()=>app.exit(1),90000);try{
 win=new BrowserWindow({show:false,width:1500,height:1100,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)console.error(event.message)});
 win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
 await win.loadFile(path.join(out,'index.html'));await wait("!!document.querySelector('.field-auto-capture-blade')");
 assert.equal(await js("document.querySelectorAll('.field-auto-capture-blade').length"),1);
 assert.equal(await js("document.querySelectorAll('.field-auto-capture-point').length"),5);
 assert.equal(await js("document.querySelectorAll('.field-auto-capture-blade-tabs [role=tab]').length"),3);
 assert.equal(await js("!!document.querySelector('[aria-label=数据采集视图],.field-task-details')"),false);
 assert.equal(await js("!!document.querySelector('.field-realtime-analysis')"),true);
 report.checks.push('One blade at a time, five rows, no duplicate top-level view tabs or optional task form; analysis remains mounted below waveforms');
 await js("document.querySelectorAll('.field-auto-capture-blade-tabs [role=tab]')[1].click()");
 await wait("document.querySelector('.field-auto-capture-blade')?.getAttribute('aria-label')==='叶片 2 采集测点'");
 await js("document.querySelector('.field-auto-capture-blade-tabs [aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
 await wait("document.querySelector('.field-auto-capture-blade')?.getAttribute('aria-label')==='叶片 3 采集测点'");
 assert.equal(await js("window.calls.some(x=>x.startsWith('position:')||x.startsWith('start:'))"),false);
 report.checks.push('Mouse and keyboard blade switching select a target without positioning or acquiring');
 await js("document.querySelector('input[aria-label=自动移动]').click()");await wait("document.querySelector('input[aria-label=自动移动]').checked===false");
 assert(await js("window.calls.includes('auto:false')"));
 await js("document.querySelector('.field-auto-capture-position').click()");
 await wait("window.calls.includes('position:3-P1')");
 report.checks.push('Auto-move checkbox updates the caller; explicit positioning uses the selected blade and point');
 for(const [width,height]of [[1500,1100],[1024,900]]){win.setSize(width,height);await js('document.fonts.ready');await new Promise(r=>setTimeout(r,120));assert(await js('document.documentElement.scrollWidth<=window.innerWidth+1'));fs.writeFileSync(path.join(out,'acquisition-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
 report.checks.push('Wide and compact windows render without document horizontal overflow');
 console.log('PASS acquisition compact UI: '+report.checks.length+' workflow and layout checks');
}catch(e){failure=e;console.error(e.stack||e.message);}finally{clearTimeout(guard);win?.destroy();report.passed=!failure;report.error=failure?.message||null;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));app.exit(failure?1:0);}});
