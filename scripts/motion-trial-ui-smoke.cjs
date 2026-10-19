'use strict';
// Isolated Electron renderer, no production preload and no network/hardware.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { buildReview } = require('./build-motion-trial-ui-review.cjs');
const output = buildReview();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-motion-trial-ui-')));
app.setName('BladeVMS 整圈界面离线验收');
let win;
const report = { hardwareTested: false, checks: [], screenshots: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = async code => {
 let result;
 try {result=await win.webContents.executeJavaScript(`(async()=>{try{return {value:await eval(${JSON.stringify(code)})};}catch(error){return {error:String(error?.stack||error)};}})()`,true);}catch(error){throw Error(String(error)+' while executing '+code);}
 if(result.error)throw Error(result.error);return result.value;
};
const button = text => `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.closest('[hidden]'))`;
async function click(text) { await run(`(()=>{const e=${button(text)};if(!e||e.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});e.click();})()`);await pause(40); }
async function waitFor(code) { for(let i=0;i<80;i++){if(await run(code))return;await pause(25);}throw Error('UI wait timed out: '+code); }
async function check(name,fn) { await fn();report.checks.push({name,passed:true});console.log('PASS '+name); }
async function input(label,value) { await run(`(()=>{const e=document.querySelector('input[aria-label="'+${JSON.stringify(label)}+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(30); }
function finish(error) { report.passed=!error;if(error)report.error=error.stack;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');if(error)console.error(error);app.exit(error?1:0); }
const watchdog=setTimeout(()=>finish(Error('UI fixture timeout')),60000);
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1366,height:768,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file:')&&!details.url.startsWith('data:')}));
 await win.loadFile(path.join(output,'index.html'),{hash:'capture'});await waitFor('window.__motionFixture?.ready');
 await check('进入与切换模式不发送设备或预览请求，键盘可切换',async()=>{
  assert.equal(await run('window.__motionFixture.calls.length'),0);
  await run(`(()=>{const e=document.querySelector('[role=tab]');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));})()`);await pause(40);
  assert.equal(await run('document.querySelector("[role=tab][aria-selected=true]").textContent'),'转速试运行');
  assert.equal(await run('document.activeElement.textContent'),'转速试运行');
  assert.equal(await run('window.__motionFixture.calls.length'),0);
 });
 await check('显式计算仅请求preview，显示纯数学721点闭合轨迹且执行禁用',async()=>{
  await click('计算整圈轨迹');await waitFor('!!document.querySelector(".motion-trial-chart svg")');
  const calls=await run('window.__motionFixture.calls');assert.equal(calls.length,1);assert.equal(calls[0].action,'motionTrial');assert.equal(calls[0].request.action,'preview');assert.equal(calls[0].request.config.periodSeconds,30);
  assert.equal(await run('document.querySelector(".motion-trial-axis-one").getAttribute("points").split(" ").length'),721);
  assert.equal(await run(`${button('启动整圈试运行')}.disabled`),true);
  assert.ok(await run('document.querySelector(".motion-trial-workspace").textContent.includes("30 s / 圈 · 2 rpm")'));
 });
 await check('1366、1920与窄窗口无横向溢出，曲线和表格有独立空间',async()=>{
  for(const [width,height] of [[1366,768],[1920,1080],[820,700],[480,800]]){
   win.setContentSize(width,height);await pause(80);
   const m=await run(`({width:innerWidth,body:document.body.scrollWidth,main:document.querySelector('.field-content').scrollWidth,client:document.querySelector('.field-content').clientWidth})`);
   assert.ok(m.body<=m.width+2&&m.main<=m.client+2,JSON.stringify(m));
   await run(`document.querySelector('.field-content').scrollTop=0`);
   const file='preview-'+width+'x'+height+'.png';fs.writeFileSync(path.join(output,file),(await win.webContents.capturePage()).toPNG());report.screenshots.push(file);
  }
  win.setContentSize(1366,768);await pause(50);
  await run(`document.querySelector('.motion-trial-execution').scrollIntoView({block:'end'})`);await pause(50);
  const file='execution-unavailable.png';fs.writeFileSync(path.join(output,file),(await win.webContents.capturePage()).toPNG());report.screenshots.push(file);
 });
 await check('改周期使旧预览失效，切换后保留输入；重新计算为10秒一圈',async()=>{
  await input('叶轮每圈时间 · s','10');assert.equal(await run('!!document.querySelector(".motion-trial-chart svg")'),false);
  await click('测点采集');await click('转速试运行');assert.equal(await run(`document.querySelector(${JSON.stringify('.motion-trial-workspace input[aria-label="叶轮每圈时间 · s"]')}).value`),'10');
  await click('计算整圈轨迹');assert.ok(await run('document.querySelector(".motion-trial-workspace").textContent.includes("10 s / 圈 · 6 rpm")'));
  assert.equal(await run(`${button('启动整圈试运行')}.disabled`),true);
 });
 await check('非法周期不能计算，待响应时禁止切换模式',async()=>{
  await input('叶轮每圈时间 · s','0');assert.equal(await run(`${button('计算整圈轨迹')}.disabled`),true);
  await input('叶轮每圈时间 · s','30');await run('window.__motionFixture.hold=true');await click('计算整圈轨迹');
  assert.equal(await run(`${button('测点采集')}.disabled`),true);
  assert.equal(await run(`${button('应用30秒模型')}.disabled`),true);
  await run('window.__motionFixture.release();window.__motionFixture.hold=false');await waitFor(`${button('测点采集')}.disabled===false`);
 });
 await check('外部设备或采集忙时禁止切换，停止控制导航不会发设备请求',async()=>{
  for(const patch of [{deviceBusy:true},{turntableBusy:true},{state:'acquiring'}]){
   await run(`window.__motionFixture.inject({service:{state:'ready'},state:'idle',...${JSON.stringify(patch)}})`);await pause(30);
   assert.equal(await run(`${button('测点采集')}.disabled`),true);
   assert.equal(await run(`${button('应用30秒模型')}.disabled`),true);
  }
  await run(`window.__motionFixture.inject({service:{state:'ready'},state:'idle'})`);await pause(30);
  const count=await run('window.__motionFixture.calls.length');await click('查看转盘状态与停止控制');
  assert.equal(await run('window.__motionFixture.navigations'),1);assert.equal(await run('window.__motionFixture.calls.length'),count);
  assert.ok((await run('window.__motionFixture.calls')).every(c=>c.action==='motionTrial'&&c.request.action==='preview'));
 });
 await check('旧5秒草稿不被隐式覆盖，主动应用30秒模型保留轴向并清旧预览',async()=>{
  await win.loadFile(path.join(output,'index.html'),{query:{fixture:'legacy'},hash:'capture-legacy'});await waitFor('window.__motionFixture?.ready');await click('转速试运行');
  assert.equal(await run(`document.querySelector(${JSON.stringify('.motion-trial-workspace input[aria-label="叶轮每圈时间 · s"]')}).value`),'5');
  await click('计算整圈轨迹');assert.ok(await run('document.querySelector(".motion-trial-workspace").textContent.includes("5 s / 圈 · 12 rpm")'));
  const before=await run('window.__motionFixture.calls.length');await click('应用30秒模型');
  assert.equal(await run('!!document.querySelector(".motion-trial-chart svg")'),false);
  assert.equal(await run('window.__motionFixture.calls.length'),before);
  const saved=await run('JSON.parse(localStorage.getItem("blade-motion-trial-geometry-v1"))');
  assert.deepEqual(saved,{distanceM:2.86,hubHeightDeltaM:1.46,radiusM:.31,periodSeconds:30,rotationDirection:'clockwise',axis1Sign:-1,axis2Sign:1});
  await click('计算整圈轨迹');assert.ok(await run('document.querySelector(".motion-trial-workspace").textContent.includes("30 s / 圈 · 2 rpm")'));
 });
 clearTimeout(watchdog);finish();
}catch(error){clearTimeout(watchdog);finish(error);}});
