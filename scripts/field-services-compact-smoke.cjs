'use strict';
// Actual shared renderer components, isolated profile and in-memory responses only.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'packages/ui/src');
const output = path.join(root, 'artifacts/service-compact-20261028');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-services-compact-'));
app.setPath('userData', profile); fs.mkdirSync(output, { recursive: true });
const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {FieldAccountPanel,FieldCloudSyncPanel} from ${JSON.stringify(path.join(ui, 'field-account.tsx'))};
import {FieldDevicePanel} from ${JSON.stringify(path.join(ui, 'field-device.tsx'))};
import {FieldServicePanel} from ${JSON.stringify(path.join(ui, 'field-desktop.tsx'))};
${['styles','field-styles','field-turntable','field-auto-follow','field-turntable-health'].map(x => `import ${JSON.stringify(path.join(ui, x + '.css'))};`).join('\n')}
const initial={state:'idle',service:{state:'ready',dllConfigured:true,generation:1,launcher:'python-module',executable:'/isolated-fixture/acquisition-service/bin/blade-acquisition',sdkPath:'/isolated-fixture/vendor-sdk/lib/Polytec.IVS.dll'}};
const unified={mode:'unified',serverUrl:'https://blade-ui-test.example.invalid',username:'ui-fixture',offline:false,lastVerifiedAt:1793145600000,offlineUntil:1795737600000};
const device={deviceIp:'198.51.100.90',readAt:1793145600,source:'isolated-ui-fixture',fields:{
 velocityRange:{supported:true,writable:true,value:'125 mm/s',options:['125 mm/s','250 mm/s','1000 mm/s']},
 bandwidth:{supported:true,writable:true,value:'20 kHz',options:['20 kHz','100 kHz']},
 highPass:{supported:true,writable:true,value:'Off',options:['Off','100 Hz']},
 ase:{supported:true,writable:true,value:0,options:[0,1]},laser:{supported:true,writable:false,value:1},
 focusPosition:{supported:true,writable:false,value:2048},signalLevel:{supported:true,writable:false,value:22000,percent:41.8},
 autofocus:{supported:true,writable:false,value:0},autofocusResult:{supported:true,writable:false,value:1}}};
const cloud={enabled:false,connected:true,uploadSampleRate:50000,state:'ready',items:[
 {recordingId:'queued-1',name:'风机 T1 / 叶片 2 / P3 / 90°',state:'queued',progress:0},
 {recordingId:'synced-1',name:'风机 T1 / 叶片 2 / P3 / 0°',state:'synced',progress:100}]};
window.__servicesFixture={initial,unified,device,cloud,calls:[],errors:[],hardwareUsed:false};
function Demo(){
 const [status,setStatus]=useState(initial),[account,setAccount]=useState(unified),[sync,setSync]=useState(cloud),[busy,setBusy]=useState(false),[deviceIp,setDeviceIp]=useState(device.deviceIp);
 const f=window.__servicesFixture;Object.assign(f,{setStatus,setAccount,setSync,setBusy,setDeviceIp});
 const call=name=>f.calls.push({action:name});
 const request=async options=>{f.calls.push({action:'device',request:options});if(f.hold){f.hold=false;await new Promise(resolve=>{f.release=resolve;});}if(f.fail){f.fail=false;throw Error('隔离验收：设备读取超时，旧配置不可继续作为读回结果。');}
  if(options.action==='set'){if(f.device.fields[options.key].value!==options.expected)throw Error('Stale fixture setting');f.device.fields[options.key].value=options.value;}
  if(options.action==='laser_on')f.device.fields.laser.value=1;if(options.action==='laser_off'||options.action==='autofocus')f.device.fields.laser.value=0;
  return structuredClone(f.device);};
 const calibrate=async options=>{f.calls.push({action:'calibrate',request:options});return {state:options.state,label:'背景',recordedAt:1793145600,startedAt:1793145598,durationSeconds:2,sampleRate:250000,sampleCount:500000,minimum:40,p10:41,median:41.8,mean:41.8,p90:42,maximum:43,samples:[41,42]};};
 return <div className="field-app"><header className="field-header"><div className="field-brand">BladeVMS <small>设备与服务界面验收 · 不连接设备</small></div></header><div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button>数据采集</button><button>转盘点位</button><button>本机记录</button><button className="active">设备与服务</button></aside><main className="field-content"><div className="field-page-heading"><h1>设备与服务</h1></div><div className="field-settings-grid">
 <div className="field-settings-column">
 <FieldDevicePanel deviceIp={deviceIp} hostIp="198.51.100.10" onIp={setDeviceIp} status={status} disabled={busy} onBusy={setBusy} onError={e=>f.errors.push(e.message)} request={request} calibrate={calibrate}/>
 <FieldServicePanel status={status} busy={busy} onAction={call}/>
 </div><div className="field-settings-column">
 <FieldAccountPanel account={account} busy={busy} active={status.state==='acquiring'} onBind={()=>call('bind')} onPassword={()=>call('password')} onRebind={()=>call('rebind')} onUnbind={()=>call('unbind')}/>
 <FieldCloudSyncPanel account={account} status={sync} busy={busy} onAuto={enabled=>{call('auto:'+enabled);setSync(previous=>({...previous,enabled}));}} onSampleRate={uploadSampleRate=>{call('sample-rate:'+uploadSampleRate);setSync(previous=>({...previous,uploadSampleRate}));}} onRetry={()=>call('retry-sync')}/>
 </div>
 </div></main></div></div>;
}createRoot(document.getElementById('root')).render(<Demo/>);
`;
buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &apos;self&apos;; style-src &apos;self&apos; &apos;unsafe-inline&apos;; script-src &apos;self&apos;; img-src &apos;self&apos; data:"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const report = { hardwareUsed: false, externalNetworkUsed: false, productionUserDataTouched: false, checks: [], screenshots: [], layouts: [], rendererErrors: [] };
let win, currentCase = 'startup';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function wait(code) { for (let i = 0; i < 150; i++) { if (await js(code)) return; await pause(25); } throw Error('Timeout: ' + code); }
async function check(name, fn) { currentCase = name; await fn(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
const button = (text, scope = 'document') => `[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
async function click(text, scope) { await js(`(()=>{const e=${button(text, scope)};if(!e||e.disabled)throw Error('Unavailable button: '+${JSON.stringify(text)});e.click();})()`); await pause(45); }
async function select(label, value) {
 await js(`document.querySelector('button[role=combobox][aria-label='+${JSON.stringify(JSON.stringify(label))}+']').click()`);
 await wait('!!document.querySelector("[role=listbox]")');
 await js(`(()=>{const option=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.trim()===${JSON.stringify(value)});if(!option)throw Error('Missing option');option.click();})()`); await pause(45);
}
async function shot(name) { await pause(100); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); report.screenshots.push(name); }
async function layout(width, name) {
 win.setContentSize(width, width >= 1024 ? 1000 : 850); await pause(65); await js('document.querySelector(".field-content").scrollTop=0');
 const dimensions = await js(`(()=>{const c=document.querySelector('.field-content'),g=document.querySelector('.field-settings-grid');const cards=[...g.querySelectorAll('.field-settings-column > section')];return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,contentWidth:c.clientWidth,contentScrollWidth:c.scrollWidth,columns:getComputedStyle(g).gridTemplateColumns.split(' ').filter(v=>parseFloat(v)>0).length,cards:cards.map(e=>({title:e.querySelector('h2')?.textContent,width:e.clientWidth,height:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight})),overflowControls:[...g.querySelectorAll('input,button')].filter(e=>e.getClientRects().length).filter(e=>{const b=e.getBoundingClientRect(),p=e.closest('.field-settings-column > section')?.getBoundingClientRect();return p&&(b.left<p.left-2||b.right>p.right+2);}).map(e=>e.getAttribute('aria-label')||e.textContent)};})()`);
 assert.equal(dimensions.documentWidth <= width + 2, true, JSON.stringify(dimensions));
 assert.equal(dimensions.contentScrollWidth <= dimensions.contentWidth + 2, true, JSON.stringify(dimensions));
 assert.deepEqual(dimensions.overflowControls, []);
 assert.equal(dimensions.columns,width>1100?2:1);
 for (const card of dimensions.cards) { assert.equal(card.scrollWidth <= card.width + 2, true, JSON.stringify(card)); assert.equal(card.height > 60, true, JSON.stringify(card)); assert.equal(card.scrollHeight <= card.height + 2,true,'Card content must not be vertically clipped: '+JSON.stringify(card)); }
 // The parent page's responsive breakpoints are verified against the final stylesheet.
 report.layouts.push({ name, ...dimensions }); await shot(`${name}-${width}.png`);
 if(width<=1024){
  await js('(()=>{const e=document.querySelector(".field-content");e.scrollTop=e.scrollHeight;})()');await pause(50);
  assert.equal(await js('(()=>{const e=document.querySelector(".field-content");return Math.abs(e.scrollTop+e.clientHeight-e.scrollHeight)<=2;})()'),true);
  await shot(`${name}-bottom-${width}.png`);
 }
}
function finish(error) {
 clearTimeout(watchdog); report.passed = !error;
 if (error) { report.error = { case: currentCase, message: error.stack }; console.error(error); }
 fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
 win?.destroy(); app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => finish(Error('Services fixture timeout')), 90000);
app.whenReady().then(async () => {
 try {
  win = new BrowserWindow({ show: false, width: 1600, height: 1000, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 3) report.rendererErrors.push(e.message); });
  win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  await win.loadFile(path.join(output, 'index.html')); await wait('document.querySelectorAll(".field-settings-column > section").length===4');
  await check('未读取厂商配置不显示虚假数值，账号/同步/服务入口完整', async () => {
   assert.equal(await js('window.__servicesFixture.calls.length'), 0);
   assert.equal(await js('!!document.querySelector("button[role=combobox][aria-label=速度量程]")'), false);
   for (const label of ['修改统一密码','更换绑定','解除绑定','重试同步','选择设备 SDK','重启采集服务','打开数据目录','读取实际配置']) assert.equal(await js(`!!(${button(label)})`), true, label);
   for (const width of [2880,1600,1366,1024,640]) await layout(width, 'unread');
  });
  await check('账号按钮、同步开关及上传采样率与服务回调仍可操作', async () => {
   for (const label of ['修改统一密码','更换绑定','解除绑定','重试同步','选择设备 SDK','重启采集服务','打开数据目录']) await click(label);
   await js('document.querySelector("button[aria-label=自动同步新采集]").click()');
   await select('上传采样率', '20 kHz');
   const calls = await js('window.__servicesFixture.calls.map(x=>x.action)');
   for (const label of ['password','rebind','unbind','retry-sync','configureDll','restartService','openDataDirectory','auto:true','sample-rate:20000']) assert(calls.includes(label), label);
   await js('window.__servicesFixture.setAccount({mode:"local"})'); await wait(`!!(${button('绑定 Web 账号')})`);
   await click('绑定 Web 账号'); await click('修改本机密码');
   assert.equal(await js('document.querySelector("button[aria-label=自动同步新采集]").disabled'), true);
   await js('window.__servicesFixture.setAccount(window.__servicesFixture.unified)');
  });
  await check('读取后参数编辑、只读反馈及RSSI入口完整；应用保留一次确认和读回', async () => {
   await click('读取实际配置'); await wait('!!document.querySelector("button[role=combobox][aria-label=速度量程]")');
   assert.equal(await js('document.querySelectorAll(".field-device-fields > .field-device-row").length'),4);
   assert.equal(await js('document.querySelectorAll(".field-device-readback > div").length'),5);
   assert.equal(await js('!!document.querySelector(".field-device-calibration")'),true);
   for (const width of [2880,1600,1366,1024,640]) await layout(width,'read');
   await select('速度量程','250 mm/s');
   await js(`(()=>{const control=document.querySelector('button[role=combobox][aria-label=速度量程]');control.closest('.field-device-row').querySelector('button:not([role=combobox])').click();})()`);
   await wait('!!document.querySelector("dialog[open]")');
   assert.equal(await js(`(${button('确认执行')}).disabled`),true);
   await js('document.querySelector("dialog[open] input[type=checkbox]").click()'); await click('确认执行');
   await wait('!document.querySelector("dialog[open]")');
   const write=await js('window.__servicesFixture.calls.filter(c=>c.request?.action==="set").at(-1).request');
   assert.equal(write.key,'velocityRange');assert.equal(write.expected,'125 mm/s');assert.equal(write.value,'250 mm/s');
   assert.equal(await js('document.querySelector("select[aria-label=速度量程]").value'),'250 mm/s');
   await js('document.querySelector(".field-device-calibration input[type=checkbox]").click()');
   await click('记录无叶片/背景');
   await wait('document.querySelector(".field-calibration-results").textContent.includes("41.80")');
   assert.equal(await js('window.__servicesFixture.calls.filter(c=>c.action==="calibrate").at(-1).request.state'),'background');
  });
  await check('读取进行中锁定编辑，失败清除旧快照，重读可恢复',async()=>{
   await js('window.__servicesFixture.hold=true');await click('读取实际配置');await wait('typeof window.__servicesFixture.release==="function"');
   assert.equal(await js(`document.querySelector('input[aria-label="配置设备 IP"]').disabled`),true);
   for(const label of ['修改统一密码','更换绑定','解除绑定','重启采集服务'])assert.equal(await js(`(${button(label)}).disabled`),true,label);
   await js('window.__servicesFixture.release();delete window.__servicesFixture.release');await wait('!!document.querySelector("button[role=combobox][aria-label=速度量程]")');
   await js('window.__servicesFixture.fail=true');await click('读取实际配置');await wait('!!document.querySelector(".field-device-panel [role=alert]")');
   assert.equal(await js('!!document.querySelector("button[role=combobox][aria-label=速度量程]")'),false);
   assert.equal(await js(`(${button('读取实际配置')}).disabled`),false);
   await layout(1366,'read-error');
   await click('读取实际配置');await wait('!!document.querySelector("button[role=combobox][aria-label=速度量程]")');
  });
  await check('采集中限制参数修改与账号服务变更，停止后恢复；错误服务提示可见',async()=>{
   await js('window.__servicesFixture.setStatus({...window.__servicesFixture.initial,state:"acquiring"})');await pause(60);
   for(const label of ['读取实际配置','修改统一密码','更换绑定','解除绑定','重启采集服务','选择设备 SDK'])assert.equal(await js(`(${button(label)}).disabled`),true,label);
   assert.equal(await js('document.querySelector("button[role=combobox][aria-label=速度量程]").disabled'),true);
   await layout(1366,'acquiring');
   await js('window.__servicesFixture.setStatus(window.__servicesFixture.initial)');await pause(50);
   assert.equal(await js(`(${button('读取实际配置')}).disabled`),false);
   await js('window.__servicesFixture.setStatus({state:"idle",service:{state:"error",dllConfigured:false,error:"隔离验收：服务启动失败，请核对SDK配置路径。"}})');await pause(50);
   assert.equal(await js('!!document.querySelector(".field-service-card [role=alert]")'),true);
   await layout(1024,'service-error');
  });
  assert.deepEqual(report.rendererErrors, []);console.log('PASS services compact renderer: '+report.checks.length+' checks');finish();
 } catch(error){finish(error);}
});
