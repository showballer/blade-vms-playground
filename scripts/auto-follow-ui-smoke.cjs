'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { buildReview } = require('./build-auto-follow-ui-review.cjs');
const output = buildReview();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-auto-follow-ui-')));
app.setName('BladeVMS 自动跟随界面离线验收');
let win;
const report = { hardwareTested: false, checks: [], screenshots: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(`(async()=>{return await eval(${JSON.stringify(code)})})()`, true);
const button = text => `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.closest('[hidden]'))`;
async function click(text) { await run(`(()=>{const e=${button(text)};if(!e||e.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});e.click();})()`); await pause(40); }
async function input(label,value) { await run(`(()=>{const e=document.querySelector('input[aria-label="'+${JSON.stringify(label)}+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await pause(35); }
async function waitFor(code) { for(let i=0;i<100;i++){if(await run(code))return;await pause(25);}throw Error('Timeout: '+code); }
async function check(name,fn) { await fn(); report.checks.push({name,passed:true}); console.log('PASS '+name); }
function finish(error) { report.passed=!error;if(error)report.error=error.stack;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));if(error)console.error(error);app.exit(error?1:0); }
const watchdog=setTimeout(()=>finish(Error('UI fixture timeout')),90000);
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1366,height:768,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file:')&&!details.url.startsWith('data:')}));
 await win.loadFile(path.join(output,'index.html'));await waitFor('window.__autoFixture?.ready');
 await check('进入不操作设备，手动/自动标签键盘切换且隐藏面板不占位',async()=>{
  assert.equal(await run('window.__autoFixture.calls.length'),0);
  await run(`(()=>{const e=document.querySelector('[role=tab]');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));})()`);await pause(40);
  assert.equal(await run('document.activeElement.textContent'),'自动跟随');
  assert.equal(await run(`getComputedStyle(document.querySelector('[role=tabpanel][hidden]')).display`),'none');
  assert.equal(await run('window.__autoFixture.calls.length'),0);
  assert.equal(await run(`${button('开始自动采集')}.disabled`),true);
 });
 await check('可添加叶根到叶尖测点，未读取锚点不生成可执行路线',async()=>{
  await click('添加测点');await input('测点2名称','P2 · 叶尖');await input('测点2半径','0.5');
  assert.equal(await run('document.querySelectorAll(".field-auto-point").length'),2);
  assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),0);
  assert.equal(await run(`${button('开始自动采集')}.disabled`),true);
 });
 await check('校准只读取反馈，运动中拒绝起点；静止有效后无需重复勾选',async()=>{
  await run('document.querySelector(".field-auto-setup").open=true');await input('自动跟随转盘串口','COM3');
  assert.equal(await run('document.querySelectorAll(".field-auto-follow input[type=checkbox]").length'),0);
  await run('window.__autoFixture.probeStatus=structuredClone(window.__autoFixture.initial);window.__autoFixture.probeStatus.turntable.feedback.axes["1"].motor_rpm=.01');
  await click('以当前位置为起点');assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),0);
  assert.equal(await run(`${button('开始自动采集')}.disabled`),true);
  assert.ok(await run('document.querySelector(".field-auto-follow").textContent.includes("未确认静止")'));
  await run('window.__autoFixture.probeStatus=null');await click('以当前位置为起点');await waitFor('document.querySelectorAll(".field-auto-route tbody tr").length===8');
  const calls=await run('window.__autoFixture.calls');assert.deepEqual(calls.map(c=>[c.action,c.request?.action]),[['turntable','probe'],['turntable','probe']]);
  assert.equal(await run(`${button('开始自动采集')}.disabled`),false);
  assert.ok(await run('document.querySelector(".field-auto-actions").textContent.includes("开始后将开启激光，并按路线自动换点。")'));
 });
 await check('周期与后续半径仅更新路线，安装、首点或设备变化撤销校准',async()=>{
  await input('叶轮每圈时间 · s','40');assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),8);assert.equal(await run(`${button('开始自动采集')}.disabled`),false);
  await input('测点2半径','0.45');assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),8);
  await input('设备至叶轮平面 · m','2.9');assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),0);
  assert.ok(await run('document.querySelector(".field-auto-anchor").textContent.includes("待校准")'));
  assert.equal(await run(`${button('开始自动采集')}.disabled`),true);
  await input('设备至叶轮平面 · m','2.86');await input('叶轮每圈时间 · s','30');await click('以当前位置为起点');
  await input('测点1半径','0.32');assert.equal(await run(`${button('开始自动采集')}.disabled`),true);
  await input('测点1半径','0.31');await click('以当前位置为起点');
  await input('自动跟随设备 IP','198.51.100.12');assert.equal(await run(`${button('开始自动采集')}.disabled`),true);
  await input('自动跟随设备 IP','198.51.100.10');await click('以当前位置为起点');
  assert.equal(await run('window.__autoFixture.calls.filter(c=>c.action==="start").length'),0);
 });
 await check('1366/820/480窗口不横向溢出，底部操作不被遮挡',async()=>{
  await run(`document.querySelector('[role=combobox][aria-label="叶轮旋向"]').scrollIntoView({block:'center'})`);await pause(50);
  await run(`document.querySelector('[role=combobox][aria-label="叶轮旋向"]').click()`);await waitFor('!!document.querySelector("[role=listbox]")');
  assert.deepEqual(await run('[...document.querySelectorAll("[role=listbox] [role=option]")].map(e=>e.textContent.trim())'),['顺时针','逆时针']);
  fs.writeFileSync(path.join(output,'automatic-direction-options.png'),(await win.webContents.capturePage()).toPNG());report.screenshots.push('automatic-direction-options.png');
  await run(`document.querySelector('[role=combobox][aria-label="叶轮旋向"]').click()`);
  await run('document.querySelector(".field-auto-setup").open=false');
  for(const [width,height] of [[1366,768],[820,768],[480,800]]){
   win.setContentSize(width,height);await pause(90);await run(`document.querySelector('.field-content').scrollTop=0`);
   const m=await run(`({width:innerWidth,body:document.body.scrollWidth,main:document.querySelector('.field-content').scrollWidth,client:document.querySelector('.field-content').clientWidth})`);
   assert.ok(m.body<=m.width+2&&m.main<=m.client+2,JSON.stringify(m));
   const name='automatic-'+width+'x'+height+'.png';fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());report.screenshots.push(name);
  }
  win.setContentSize(1366,768);await pause(50);await run(`document.querySelector('.field-auto-actions').scrollIntoView({block:'end'})`);await pause(50);
  const bounds=await run(`(()=>{const r=document.querySelector('.field-auto-actions').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};})()`);assert.ok(bounds.top>0&&bounds.bottom<=bounds.height);
  const name='automatic-start-controls.png';fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());report.screenshots.push(name);
 });
 await check('显式开始才发送激光与运动许可，8站位顺序和pending停止有效',async()=>{
  await run('window.__autoFixture.holdStart=true');await click('开始自动采集');
  assert.equal(await run(`${button('手动控制')}.disabled`),true);
  assert.equal(await run(`${button('查看本机记录')}.disabled`),true);
  assert.equal(await run(`${button('停止并保存')}.disabled`),false);
  await click('停止并保存');await run('window.__autoFixture.release()');await waitFor(`${button('手动控制')}.disabled===false`);
  const calls=await run('window.__autoFixture.calls'),start=calls.find(c=>c.action==='start');
  assert.equal(start.config.source,'device');assert.equal(start.config.turntable,undefined);assert.equal(start.config.confirmLaser,true);assert.equal(start.config.confirmMotion,true);
  assert.equal(start.config.pointCycle.mode,'automatic_stations');assert.deepEqual(start.config.pointCycle.points.map(p=>p.azimuthDeg),[0,90,180,270,0,90,180,270]);
  assert.equal(calls.filter(c=>c.action==='stop').length,1);assert.ok(!(await run('window.__autoFixture.statusUpdates')).includes('acquiring'),'Late start reply was discarded');
 });
 await check('服务generation变更清理旧参考，草稿没有锚点和安全许可',async()=>{
  await run('window.__autoFixture.inject({...window.__autoFixture.initial,service:{state:"ready",dllConfigured:true,generation:2}})');await pause(40);
  assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),0);
  const saved=await run('JSON.parse(localStorage.getItem("blade-auto-follow-draft-v1"))');assert.deepEqual(Object.keys(saved).sort(),['draft','port']);assert.ok(!('anchor' in saved));assert.ok(!('confirmLaser' in saved.draft));
 });
 clearTimeout(watchdog);finish();
}catch(error){clearTimeout(watchdog);finish(error);}});
