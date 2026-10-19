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
async function checkBox(text) { await run(`(()=>{const e=[...document.querySelectorAll('.field-auto-follow label')].find(e=>e.textContent.includes(${JSON.stringify(text)}))?.querySelector('input[type=checkbox]');if(!e||e.disabled)throw Error('Checkbox unavailable');e.click();})()`); await pause(35); }
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
  assert.equal(await run(`${button('开始自动跟随')}.disabled`),true);
 });
 await check('可添加叶根到叶尖测点，未读取锚点不生成可执行路线',async()=>{
  await click('添加测点');await input('测点2名称','P2 · 叶尖');await input('测点2半径','0.5');
  assert.equal(await run('document.querySelectorAll(".field-auto-point").length'),2);
  assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),0);
  assert.equal(await run(`${button('开始自动跟随')}.disabled`),true);
 });
 await check('安装和参考确认后读取两轴，只调用probe，不会开启激光',async()=>{
  await run('document.querySelector(".field-auto-setup").open=true');await input('自动跟随转盘串口','COM3');
  await checkBox('叶轮和转盘已停止');await click('读取两轴瞄准参考');await waitFor('document.querySelectorAll(".field-auto-route tbody tr").length===8');
  const calls=await run('window.__autoFixture.calls');assert.deepEqual(calls.map(c=>[c.action,c.request?.action]),[['turntable','probe']]);
  assert.equal(await run(`${button('开始自动跟随')}.disabled`),true);
  await checkBox('核对俯仰');await checkBox('光路与人员');await checkBox('已核对站位');
  assert.equal(await run(`${button('开始自动跟随')}.disabled`),false);
 });
 await check('周期与后续半径修改保留参考但撤销运动许可；安装变化撤销参考',async()=>{
  await input('叶轮每圈时间 · s','40');assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),8);assert.equal(await run(`${button('开始自动跟随')}.disabled`),true);
  await checkBox('光路与人员');await checkBox('已核对站位');await input('测点2半径','0.45');assert.equal(await run(`${button('开始自动跟随')}.disabled`),true);assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),8);
  await input('设备至叶轮平面 · m','2.9');assert.equal(await run('document.querySelectorAll(".field-auto-route tbody tr").length'),0);
  assert.ok(await run('document.querySelector(".field-auto-anchor").textContent.includes("待读取")'));
  await input('设备至叶轮平面 · m','2.86');await input('叶轮每圈时间 · s','30');await checkBox('叶轮和转盘已停止');await click('读取两轴瞄准参考');await checkBox('核对俯仰');
 });
 await check('1366/820/480窗口不横向溢出，底部操作不被遮挡',async()=>{
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
 await check('真实采集请求保留有序8站位与双安全确认，pending start可停止',async()=>{
  await checkBox('光路与人员');await checkBox('已核对站位');await run('window.__autoFixture.holdStart=true');await click('开始自动跟随');
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
