'use strict';
// Actual React/ECharts browser rendering. Numerical fixtures are QA only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..'), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-chart-loading-'));
const output = path.resolve(process.argv[2] || path.join(root, 'artifacts/chart-loading-controls-20261030/chart-runtime.json'));
app.setPath('userData', path.join(folder, 'profile'));
buildSync({ stdin: { contents: `
  import React,{useState} from 'react';import{createRoot}from'react-dom/client';
  import{Chart}from'./packages/ui/src/charts';import{AnalysisCard}from'./packages/ui/src/field-record-analysis-charts';
  import*as ec from'echarts/core';
  const option=(n=1)=>({animation:false,grid:{left:40,right:20,top:25,bottom:45},xAxis:{type:'value'},yAxis:{type:'value'},
   dataZoom:[{type:'inside'}],series:[{type:'line',data:Array.from({length:120},(_,i)=>[i,Math.sin(i*.1)*n])}]});
  function App(){const[n,setN]=useState(1),[active,setActive]=useState(false),[pending,setPending]=useState(true);
   window.qa={replace:setN,activate:()=>setActive(true),ready:()=>setPending(false),instance:()=>ec.getInstanceByDom(document.querySelector('[data-qa=live] [role=img]'))};
   return <><div data-qa="canvas"><Chart option={option(n)} label="QA Canvas"/></div>
    <div data-qa="svg"><Chart renderer="svg" option={option(n)} label="QA SVG"/></div>
    <div data-qa="live" style={{display:active?'block':'none'}}><Chart active={active} updateMode="merge" option={option(n)} label="QA Live"/></div>
    <AnalysisCard id="QA-LOADING" context="QA only" loading={pending} option={option(n)}/></>;
  }createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
  bundle: true, platform: 'browser', jsx: 'automatic', outfile: path.join(folder, 'app.js'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(folder, 'index.html'), '<!doctype html><html><body><div id="root" style="width:900px"></div><script src="app.js"></script></body></html>');
let win;const checks=[],errors=[];
const js=code=>win.webContents.executeJavaScript(code,true);
const until=async code=>{const end=Date.now()+15000;while(Date.now()<end){if(await js('!!('+code+')'))return;await new Promise(r=>setTimeout(r,50));}throw Error('Chart runtime timeout: '+code);};
app.whenReady().then(async()=>{let error;try{
  win=new BrowserWindow({show:false,width:1100,height:1200,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  await win.loadFile(path.join(folder,'index.html'));
  await until("document.querySelector('[data-qa=canvas] [aria-busy=false] canvas')&&document.querySelector('[data-qa=svg] [aria-busy=false] svg')");
  assert(await js("!!document.querySelector('[data-qa=svg] svg').getAttribute('viewBox')"));
  assert(!await js("!!document.querySelector('[data-qa=live] canvas')"));checks.push('Canvas and report SVG complete rendering; inactive live panel stays uninitialized');
  assert(await js("!!document.querySelector('[data-analysis-card=QA-LOADING] [role=status]')&&!document.querySelector('[data-analysis-card=QA-LOADING] canvas')"));
  await js("window.qa.ready()");await until("document.querySelector('[data-analysis-card=QA-LOADING] [aria-busy=false] canvas')");checks.push('Pending analysis withholds data and clears loading when its real chart is drawn');
  await js("window.qa.activate()");await until("document.querySelector('[data-qa=live] [aria-busy=false] canvas')");
  await js("window.qa.instance().dispatchAction({type:'dataZoom',start:25,end:75})");
  // Freeze animation frames only in the harness to observe the pre-paint state.
  await js("(()=>{const raf=window.requestAnimationFrame;window.__queued=[];window.requestAnimationFrame=cb=>{window.__queued.push(cb);return window.__queued.length;};window.__resumeFrames=()=>{window.requestAnimationFrame=raf;for(const cb of window.__queued)raf(cb);};})()");
  await js('window.qa.replace(2)');await until("document.querySelector('[data-qa=canvas] [aria-busy=true]')");
  assert(await js("!!document.querySelector('[data-qa=canvas] [role=status]')"));
  assert(!await js("!!document.querySelector('[data-qa=live] [role=status]')"),'Live updates must not flash loading on every frame');
  await js('window.__resumeFrames()');await until("document.querySelector('[data-qa=canvas] [aria-busy=false]')&&document.querySelector('[data-qa=svg] [aria-busy=false]')");
  await until("window.qa.instance().getOption().series[0].data[15][1]===Math.sin(1.5)*2");
  assert.equal(await js('window.qa.instance().getOption().dataZoom[0].start'),25);assert.equal(await js('window.qa.instance().getOption().dataZoom[0].end'),75);
  checks.push('Static replacement remains loading until painting; streaming updates retain zoom and avoid spinner flicker');
  await js("window.dispatchEvent(new Event('beforeprint'))");assert(await js("!!document.querySelector('[data-qa=svg] svg').getAttribute('viewBox')"));
  assert.deepEqual(errors,[]);
}catch(e){error=e;console.error(e.stack);}finally{
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({passed:!error,checks,...(error?{error:error.stack}:{})},null,2));
  win?.destroy();fs.rmSync(folder,{recursive:true,force:true});console.log((error?'FAIL':'PASS')+' shared chart loading runtime');app.exit(error?1:0);
}});
