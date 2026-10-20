'use strict';
// Production React app with an in-memory bridge and disposable browser profile.
// No preload, SDK, serial port, real account, service, raw data, or Web upload.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'packages/ui/src');
const output = path.join(root, 'artifacts/field-error-retry-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-error-retry-')));
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {FieldDesktopApp} from ${JSON.stringify(path.join(ui, 'field-desktop.tsx'))};
import {defaultAutoFollowSurvey,autoFollowStorageKey} from ${JSON.stringify(path.join(ui, 'field-auto-follow-config.ts'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable.css'))};
import ${JSON.stringify(path.join(ui, 'field-auto-follow.css'))};
import ${JSON.stringify(path.join(ui, 'field-auto-capture-list.css'))};
import ${JSON.stringify(path.join(ui, 'field-header-laser.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable-health.css'))};
import ${JSON.stringify(path.join(ui, 'field-blade-summary.css'))};
const axis=limit=>({output_angle_deg:0,motor_rpm:0,actual_counts:0,commanded_counts:0,error_counts:0,display_mode:3,command_counts_per_rev:10000,encoder_bits:17,flags:3,fault:0,origin_counts:0,home_phase:0,observedAt:1,referenceAngleDeg:0,guard:{soft_enabled:true,hardware_enabled:false,minimum_deg:-limit,maximum_deg:limit}});
const base={service:{state:'ready',dllConfigured:true,generation:1},state:'error',error:'双轴运动期间参考位或反馈计数单位已变化',receiver:{running:false},deviceBusy:false,turntableBusy:false,turntable:{state:'checked',port:'COM6',axis:1,motionCapability:{supported:false,mode:'sequential',protocol:null,probe:'legacy-command-unsupported',status:null},feedback:{axes:{'1':axis(35),'2':axis(180)},motorRpm:0,outputRpm:0,alarmCode:0,limitFlags:0,positionRaw:0}}};
const model=window.__retryFixture={base,server:structuredClone(base),transportFailure:false,calls:[],reads:0,recordings:[]};
if(!localStorage.getItem('blade-field-config-v1'))localStorage.setItem('blade-field-config-v1',JSON.stringify({name:'异常后重试隔离验收',deviceIp:'192.0.2.90',hostIp:'192.0.2.10',object:'',turbine:'WT01',point:''}));
const survey=defaultAutoFollowSurvey();survey.port='COM6';survey.blades[0].points=[survey.blades[0].points[0]];localStorage.setItem(autoFollowStorageKey,JSON.stringify(survey));
window.blade={windowControl:()=>{},field:async options=>{
 model.calls.push(structuredClone(options));
 if(options.action==='accountInfo')return {status:200,data:model.account||{mode:'local'}};
 if(options.action==='session')return {status:200,data:{user:{id:'fixture',username:'fixture',name:'隔离验收'},mustChangePassword:false}};
 if(options.action==='syncStatus')return {status:200,data:{enabled:false,connected:false,state:'unbound',items:[]}};
 if(options.action==='recordings')return {status:200,data:{recordings:structuredClone(model.recordings)}};
 if(options.action==='recording'){
  const record=structuredClone(model.recordings.find(item=>item.id===options.id));
  if(model.holdRecord)await new Promise(resolve=>model.releaseRecord=resolve);
  if(model.failRecord)return {status:503,data:{error:'隔离验收：记录读取失败'}};
  return {status:200,data:{recording:record}};
 }
 if(options.action==='waveform')return {status:200,data:{recording:structuredClone(model.recordings.find(item=>item.id===options.id)),waveform:{sampleRate:1000,sampleStart:0,sampleStride:1,sourceSamples:1000,rangeStart:0,rangeEnd:1000,unit:'m/s',rssiUnit:'%',representation:'raw',values:Array.from({length:1000},(_,i)=>Math.sin(i/12)*.01),rssi:Array(1000).fill(80),overrange:Array(1000).fill(false)}}};
 if(options.action==='exportRecording')return {status:200,data:{saved:true,fileName:options.id+'.csv'}};
 if(options.action==='syncRecording')return {status:200,data:{}};
 if(options.action==='status'||options.action==='frame'){model.reads++;if(model.transportFailure)return {status:503,data:{error:'隔离验收：状态连接中断'}};return {status:200,data:structuredClone(model.server)};}
 if(options.action==='turntablePorts')return {status:200,data:{ports:[{port:'COM6',description:'TEST ONLY'}]}};
 if(options.action==='device'&&options.request.action==='laser_read')return {status:200,data:{deviceIp:options.request.deviceIp,state:'unknown',readAt:null,source:'unavailable',busy:false}};
 if(options.action==='turntable'&&options.request.action==='probe'){const reply=structuredClone(model.server);reply.turntable.state='checked';return {status:200,data:reply};}
 if(options.action==='turntable'&&options.request.action==='reference'){
  const axis=model.server.turntable.feedback.axes[String(options.request.axis)];
  Object.assign(axis,{output_angle_deg:options.request.axis===1?25:0,flags:3,fault:0,origin_counts:axis.origin_counts+100});
  return {status:200,data:structuredClone(model.server)};
 }
 if(options.action==='turntable'&&options.request.action==='manual_move'){
  model.server.turntable.feedback.axes[String(options.request.axis)].output_angle_deg=options.request.targetAngleDeg;
  return {status:200,data:structuredClone(model.server)};
 }
 if(options.action==='turntable'&&['clear_trajectory_fault','clear_guard_fault','reset_alarm','cancel_trajectory'].includes(options.request.action)){
  if(model.recoveryFailure)return {status:503,data:{error:'独立清除轨迹需要配套 v3.4 或更新固件'}};
  const request=options.request, table=model.server.turntable;
  if(request.action==='clear_trajectory_fault')table.motionCapability.status={state:0,fault:0};
  if(request.action==='cancel_trajectory')table.motionCapability.status={state:8,fault:1,session:request.expectedTrajectorySession};
  if(request.action==='clear_guard_fault')table.feedback.axes[String(request.axis)].fault=0;
  if(request.action==='reset_alarm')table.health.axes[String(request.axis)].alarmCode=0;
  table.recovery={action:request.action,axis:request.axis,verified:true,completedAt:Date.now()/1000};
  return {status:200,data:structuredClone(model.server)};
 }
 if(options.action==='turntable'&&options.request.action==='health'){
  if(model.healthFailure)return {status:503,data:{error:'隔离验收：读取转盘超时'}};
  const reply=structuredClone(model.server);reply.turntable.state='checked';
  reply.turntable.health={readOnly:true,readAt:Date.now()/1000,referenceChangedDuringRead:false,axes:{'1':{alarmCode:0,runState:0,limitFlags:0,observedAt:Date.now()/1000},'2':{alarmCode:model.axis2Alarm||0,runState:0,limitFlags:0,observedAt:Date.now()/1000}}};
  reply.turntable.health.motionProfiles={'1':{accel_ms:1500,decel_ms:1500,s_curve_ms:100},'2':{accel_ms:500,decel_ms:800,s_curve_ms:0}};
  model.server.turntable.health=structuredClone(reply.turntable.health);
  if(model.holdHealth)await new Promise(resolve=>model.releaseHealth=resolve);
  return {status:200,data:reply};
 }
 if(options.action==='turntable'&&options.request.action==='recall'){
  model.server.turntable.feedback.axes['1'].output_angle_deg=options.request.axis1AngleDeg;
  model.server.turntable.feedback.axes['2'].output_angle_deg=options.request.axis2AngleDeg;
  model.server.turntable.state='stopped';model.server.turntable.stopConfirmed=true;
  model.server.turntable.recall={state:'complete',targets:[options.request.axis1AngleDeg,options.request.axis2AngleDeg],completedAxes:[1,2]};return {status:200,data:structuredClone(model.server)};
 }
 if(options.action==='start')return {status:200,data:structuredClone(model.server)};
 throw Error('隔离验收禁止此操作：'+JSON.stringify(options));
}};
createRoot(document.getElementById('root')).render(<FieldDesktopApp/>);
`;
buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true,
  outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><title>异常后重试隔离验收</title></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const report = { hardwareTouched: false, realServiceStarted: false, productionUserDataTouched: false, nativeMotionExecuted: false, checks: [], passed: false };
let win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript('(async()=>{return await eval(' + JSON.stringify(code) + ')})()', true);
const button = text => '[...document.querySelectorAll("button")].find(e=>!e.closest("[hidden]")&&e.textContent.trim()===' + JSON.stringify(text) + ')';
const rowStart = 'document.querySelector("button[aria-label^=开始采集叶片]")';
const inputNode = label => 'document.querySelector(' + JSON.stringify('input[aria-label=' + JSON.stringify(label) + ']') + ')';
async function wait(code, message = code) { for (let i = 0; i < 200; i++) { if (await js(code)) return; await pause(25); } throw Error('Timed out: ' + message); }
async function click(code) { await js('(()=>{const node=' + code + ';if(!node||node.disabled)throw Error("Button unavailable");node.click();})()'); }
async function input(label, value) { await js('(()=>{const node=document.querySelector(' + JSON.stringify('input[aria-label=' + JSON.stringify(label) + ']') + ');if(!node||node.disabled)throw Error("Input unavailable");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(node,' + JSON.stringify(String(value)) + ');node.dispatchEvent(new Event("input",{bubbles:true}));})()'); }
async function changed(code) { const before = await js('window.__retryFixture.reads'); await js(code); await wait('window.__retryFixture.reads>' + (before + 1)); await pause(60); }
async function check(name, action) { await action(); report.checks.push(name); console.log('PASS ' + name); }
function finish(error) { report.passed = !error; if (error) { report.error = error.stack; console.error(error); } fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); app.exit(error ? 1 : 0); }
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => finish(Error('Error retry acceptance timed out')), 60000);
  try {
    win = new BrowserWindow({ width: 1366, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    await win.loadFile(path.join(output, 'index.html'));
    await wait('!!document.querySelector("input[aria-label=任务名称]")');
    await check('终态采集错误持续显示，普通采集可重试', async () => {
      await wait(button('开始采集') + '&&!(' + button('开始采集') + ').disabled');
      await input('风场编号', ' WF-001 ');
      assert.ok(await js('document.body.innerText.includes("上次采集异常：双轴运动期间参考位或反馈计数单位已变化")'));
      await js('(()=>{const button='+button('开始采集')+';button.click();button.click();})()');
      await wait('window.__retryFixture.calls.filter(call=>call.action==="start").length===1');
      assert.equal(await js('window.__retryFixture.calls.find(call=>call.action==="start").config.windFarm'),'WF-001');
      await wait('!document.querySelector("dialog")&&!(' + button('开始采集') + ').disabled');
    });
    await check('成功回包可清除传输故障，断线或服务不可用仍禁用', async () => {
      await changed('window.__retryFixture.transportFailure=true'); assert.equal(await js('(' + button('开始采集') + ').disabled'), true);
      await changed('window.__retryFixture.transportFailure=false'); assert.equal(await js('(' + button('开始采集') + ').disabled'), false);
      await changed('window.__retryFixture.server.service.state="stopped"'); assert.equal(await js('(' + button('开始采集') + ').disabled'), true);
      await changed('window.__retryFixture.server.service.state="ready"'); assert.equal(await js('(' + button('开始采集') + ').disabled'), false);
    });
    await check('ready进程的HTTP错误envelope在frame和status路径均阻断，恢复后才可重试', async () => {
      await changed('window.__retryFixture.server.service.error="隔离验收：进程存在但HTTP状态请求失败"');
      assert.equal(await js('(' + button('开始采集') + ').disabled'), true);
      assert.ok(await js('[...document.querySelectorAll("[role=alert]")].some(e=>e.textContent.includes("进程存在但HTTP状态请求失败"))'));
      const before = await js('window.__retryFixture.calls.filter(call=>call.action==="status").length');
      await click(button('本机记录')); await wait('window.__retryFixture.calls.filter(call=>call.action==="status").length>' + before);
      assert.ok(await js('[...document.querySelectorAll("[role=alert]")].some(e=>e.textContent.includes("进程存在但HTTP状态请求失败"))'));
      await click(button('数据采集')); await wait(button('开始采集')); assert.equal(await js('(' + button('开始采集') + ').disabled'), true);
      await changed('delete window.__retryFixture.server.service.error'); assert.equal(await js('(' + button('开始采集') + ').disabled'), false);
    });
    await click('document.querySelector("input[aria-label=联动转盘与测振仪]")');
    await click(button('自动跟随')); await wait(rowStart);
    await check('自动联动已准备的测点也可在历史错误后重试', async () => {
      await wait(rowStart + '&&!(' + rowStart + ').disabled');
      const startsBefore=await js('window.__retryFixture.calls.filter(call=>call.action==="start").length');
      await click(rowStart);
      await wait('window.__retryFixture.calls.filter(call=>call.action==="start").length>'+startsBefore);
      assert.equal(await js('!!document.querySelector("dialog")'), false);
      const requests = await js('window.__retryFixture.calls.filter(call=>call.action==="start")');
      assert.equal(requests.length, startsBefore+1); assert.equal(requests.at(-1).config.windFarm,'WF-001'); assert.ok(requests.at(-1).config.pointCycle.points.every(point => point.referenceSignature));
      assert.ok((await js('window.__retryFixture.calls')).some(call => call.action === 'turntable' && call.request.action === 'probe'));
      await wait(rowStart + '&&!(' + rowStart + ').disabled');
    });
    await check('停止未确认、设备警告和运动中仍拦截，恢复后不残留 busy', async () => {
      for (const patch of ['turntableWarning="停止未确认"', 'deviceWarning="激光状态未确认"', 'turntableBusy=true', 'deviceBusy=true']) {
        await changed('window.__retryFixture.server.' + patch); assert.equal(await js('(' + rowStart + ').disabled'), true, patch);
        await changed('window.__retryFixture.server=structuredClone(window.__retryFixture.base)'); await wait(rowStart + '&&!(' + rowStart + ').disabled');
      }
      await changed('window.__retryFixture.server.turntable.motionCapability={supported:true,mode:"dual_axis_timed",protocol:"0x30-0x36",probe:"confirmed",status:{state:3,fault:0}}');
      assert.equal(await js('(' + rowStart + ').disabled'), true);
      await changed('window.__retryFixture.server=structuredClone(window.__retryFixture.base)'); await wait(rowStart + '&&!(' + rowStart + ').disabled');
    });
    await check('新鲜探测的未知能力或无有效参考不能发送开始命令', async () => {
      // Unbound geometry may request a fresh probe. The fresh result still must
      // pass complete reference, limit and motion-capability validation.
      for (const code of ['window.__retryFixture.server.turntable.motionCapability=undefined', 'window.__retryFixture.server.turntable.feedback.axes["1"].flags=2;window.__retryFixture.server.turntable.feedback.axes["1"].output_angle_deg=null']) {
        const before=await js('window.__retryFixture.calls.filter(call=>call.action==="start").length');
        await changed(code); await click(rowStart); await pause(150);
        assert.equal(await js('window.__retryFixture.calls.filter(call=>call.action==="start").length'), before, code);
        assert.equal(await js('!!document.querySelector("dialog")'), false); await changed('window.__retryFixture.server=structuredClone(window.__retryFixture.base)');
      }
    });
    await check('每圈时间0显示人手转动并以较小真实上限下发，切回周期保留等待设置', async () => {
      await click(button('转盘点位')); await wait('!!' + inputNode('叶轮每圈时间 · s'));
      await input('单站最多等待 · 圈', 4); await input('两轴换点转速上限 · rpm', .22); await input('叶轮每圈时间 · s', 0);
      await wait('document.body.innerText.includes("人手转动叶片")&&!' + inputNode('单站最多等待 · 圈'));
      assert.ok(await js('document.querySelector(".field-auto-metrics").innerText.includes("0.22 rpm")'));
      assert.ok(await js('document.body.innerText.includes("每个点位最多等待 60 秒")'));
      assert.equal(await js('document.body.innerText.includes("Infinity")'), false);
      report.manualScreenshot = path.join(output, 'manual-rotation-config-1366.png');
      fs.writeFileSync(report.manualScreenshot, (await win.webContents.capturePage()).toPNG());
      await click(button('前往数据采集')); await wait(rowStart + '&&!(' + rowStart + ').disabled');
      const startsBefore=await js('window.__retryFixture.calls.filter(call=>call.action==="start").length');
      await click(rowStart);
      await wait('window.__retryFixture.calls.filter(call=>call.action==="start").length>'+startsBefore);
      assert.equal(await js('!!document.querySelector("dialog")'), false);
      const request = await js('window.__retryFixture.calls.filter(call=>call.action==="start").at(-1)');
      assert.equal(request.config.pointCycle.nominalPeriodSeconds, 0);
      assert.equal(request.config.pointCycle.speedRpm, .22); assert.equal(request.config.pointCycle.maxMoveRpm, .22);
      assert.equal(request.config.pointCycle.dwellSeconds, 60); assert.equal(request.config.pointCycle.rssiTriggerEnabled, true);
      assert.equal(request.config.pointCycle.keepLaserOnBetweenPoints, true);
      assert.ok(request.config.pointCycle.points.every(point => point.referenceSignature));
      await click(button('转盘点位')); await input('叶轮每圈时间 · s', 30);
      await wait('!!' + inputNode('单站最多等待 · 圈'));
      assert.equal(await js(inputNode('单站最多等待 · 圈') + '.value'), '4');
      await click(button('前往数据采集'));
    });
    await check('运动临时警告不清原点；跨页面开始请求保留返回坐标；结束后可手动回原点', async () => {
      await changed('window.__retryFixture.server.state="idle";window.__retryFixture.server.error=null;window.__retryFixture.server.turntable.feedback.axes["1"].output_angle_deg=-.47;window.__retryFixture.server.turntable.feedback.axes["2"].output_angle_deg=-16.73');
      await click(button('转盘点位')); await click('document.querySelector("button[aria-label=设置归零]")');
      await wait('document.querySelector("[aria-label=保存的原点坐标]")?.textContent.includes("-16.730")');
      await click(button('前往数据采集')); await wait(rowStart + '&&!(' + rowStart + ').disabled');
      const startsBefore=await js('window.__retryFixture.calls.filter(call=>call.action==="start").length');
      await click(rowStart);
      await wait('window.__retryFixture.calls.filter(call=>call.action==="start").length>'+startsBefore);
      assert.equal(await js('!!document.querySelector("dialog")'), false);
      const started = await js('window.__retryFixture.calls.filter(call=>call.action==="start").at(-1)');
      assert.deepEqual([started.config.pointCycle.returnToOrigin.axis1AngleDeg, started.config.pointCycle.returnToOrigin.axis2AngleDeg], [-.47, -16.73]);
      await changed('window.__retryFixture.server.state="acquiring";window.__retryFixture.server.receiver.running=true;window.__retryFixture.server.turntableWarning="双轴换点停止尚未确认";window.__retryFixture.server.turntable.state="positioning";window.__retryFixture.server.turntable.stopConfirmed=false');
      const saved = await js('JSON.parse(localStorage.getItem("blade-turntable-work-origins-v1"))');
      assert.equal(saved.optical.axis1AngleDeg, -.47); assert.equal(saved.optical.axis2AngleDeg, -16.73);
      await changed('window.__retryFixture.server.state="idle";window.__retryFixture.server.receiver.running=false;window.__retryFixture.server.turntableWarning=null;window.__retryFixture.server.turntable.state="stopped";window.__retryFixture.server.turntable.stopConfirmed=true;window.__retryFixture.server.turntable.feedback.axes["1"].output_angle_deg=13.89;window.__retryFixture.server.turntable.feedback.axes["2"].output_angle_deg=-15.312');
      await click(button('转盘点位')); await wait('document.querySelector("button[aria-label=回到原点]")?.disabled===false');
      await click('document.querySelector("button[aria-label=回到原点]")');
      assert.equal(await js('!!document.querySelector("dialog[open]")'), false);
      await wait('document.querySelector(".field-work-origin .field-success")?.textContent.includes("已回到")');
      const recall = await js('window.__retryFixture.calls.filter(call=>call.action==="turntable"&&call.request.action==="recall").at(-1)');
      assert.deepEqual([recall.request.axis1AngleDeg, recall.request.axis2AngleDeg], [-.47, -16.73]);
    });
    await check('页面重载保留坐标，fresh只读核验后恢复按钮，不把当前位置当零点', async () => {
      await win.webContents.reload(); await wait('!!document.querySelector("input[aria-label=任务名称]")');
      assert.equal(await js('document.querySelector("input[aria-label=风场编号]").value'),'WF-001');
      await click(button('转盘点位'));
      await wait('document.querySelector(".field-work-origin")?.textContent.includes("作业零点已设置")');
      assert.ok(await js('document.querySelector("[aria-label=保存的原点坐标]").textContent.includes("-16.730")'));
      assert.ok(await js('window.__retryFixture.calls.some(call=>call.action==="turntable"&&call.request.action==="probe")'));
      assert.equal(await js('window.__retryFixture.calls.some(call=>call.action==="turntable"&&call.request.action!=="probe"||call.action==="start")'), false);
    });
    await check('回原点遇跟随故障可就地清除同一旧轨迹，原点不变且不自动重启运动', async () => {
      await changed('window.__retryFixture.server.state="idle";window.__retryFixture.server.error=null;window.__retryFixture.server.turntable.state="checked";window.__retryFixture.server.turntable.motionCapability={supported:true,mode:"dual_axis_timed",protocol:"0x30-0x36",probe:"confirmed",status:{state:7,fault:7,session:442,error1_deg:.774,error2_deg:.013}}');
      const saved=await js('localStorage.getItem("blade-turntable-work-origins-v1")');
      const before=await js('window.__retryFixture.calls.length');
      await click('document.querySelector("button[aria-label=回到原点]")');
      await wait('document.querySelector(".field-work-origin .field-error")?.textContent.includes("清除旧轨迹")');
      assert.equal(await js('window.__retryFixture.calls.slice('+before+').some(c=>c.action==="turntable"&&c.request.action==="recall")'),false);
      const clear='Array.from(document.querySelectorAll(".field-work-origin button")).find(b=>b.textContent==="清除旧轨迹")';
      await click(clear);
      await wait('document.querySelector(".field-work-origin .field-success")?.textContent.includes("旧轨迹已清除")');
      const actions=await js('window.__retryFixture.calls.slice('+before+').filter(c=>c.action==="turntable")');
      assert.deepEqual(actions.map(c=>c.request.action),['probe','health','clear_trajectory_fault']);
      assert.equal(actions[2].request.expectedTrajectorySession,442);
      assert.equal(await js('localStorage.getItem("blade-turntable-work-origins-v1")'),saved);
      await click('document.querySelector("button[aria-label=回到原点]")');
      await wait('document.querySelector(".field-work-origin .field-success")?.textContent.includes("已回到")');
      const recalls=await js('window.__retryFixture.calls.slice('+before+').filter(c=>c.action==="turntable"&&c.request.action==="recall")');
      assert.equal(recalls.length,1);
      assert.deepEqual([recalls[0].request.axis1AngleDeg,recalls[0].request.axis2AngleDeg],[-.47,-16.73]);
      assert.equal(recalls[0].request.followErrorLimitDeg,.75);
    });
    await check('标题旁只读转盘检查区分轨迹7、轴3与停止待确认，重复点击不并发', async () => {
      await changed('window.__retryFixture.server.state="idle";window.__retryFixture.server.error=null;window.__retryFixture.server.turntable.motionCapability={supported:true,mode:"dual_axis_timed",protocol:"0x30-0x36",probe:"confirmed",status:{state:7,fault:7,error1_deg:-1.031,error2_deg:-.004}};Object.assign(window.__retryFixture.server.turntable.feedback.axes["1"],{flags:18,fault:3,output_angle_deg:null});window.__retryFixture.holdHealth=true');
      assert.ok(await js('document.querySelector(".field-turntable-heading h1").textContent.includes("转盘点位控制")'));
      assert.ok(await js('!!document.querySelector(".field-turntable-heading button[aria-label=检查转盘状态]")'));
      const before=await js('window.__retryFixture.calls.length');
      await click('document.querySelector("button[aria-label=检查转盘状态]")');
      await wait('typeof window.__retryFixture.releaseHealth==="function"');
      assert.equal(await js('document.querySelector("button[aria-label=检查转盘状态]").disabled'),true);
      await js('window.__retryFixture.holdHealth=false;window.__retryFixture.releaseHealth()');
      await wait('document.querySelector(".field-turntable-health").textContent.includes("上次完整检查")&&document.querySelector("button[aria-label=重新检查转盘状态]").disabled===false');
      const added=await js('window.__retryFixture.calls.slice('+before+').filter(c=>c.action==="turntable")');
      assert.deepEqual(added.map(c=>c.request.action),['health']);
      const text=await js('document.querySelector(".field-turntable-health").textContent');
      for(const label of ['驱动加速 PA40','驱动减速 PA41','驱动平滑 PA42','1500 ms','500 ms'])assert.ok(text.includes(label),label);
      assert.ok(text.includes('反馈单位变化／计数不连续（3）'));assert.ok(text.includes('跟随误差超限（7）'));
      assert.ok(text.includes('停机待确认'));assert.ok(text.includes('无有效角度'));assert.ok(!text.includes('本次检查未发现异常'));
      for(const [width,height] of [[1366,768],[480,850]]){
        win.setContentSize(width,height);await pause(80);
        assert.equal(await js('document.querySelector("dialog").scrollWidth<=document.querySelector("dialog").clientWidth+2'),true);
        fs.writeFileSync(path.join(output,'turntable-health-fault-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      win.setContentSize(1366,768);await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
    });
    await check('取消待执行轨迹只发送一次组取消，保留角度、参考和保存原点，不启动采集', async () => {
      await changed('window.__retryFixture.server=structuredClone(window.__retryFixture.base);window.__retryFixture.server.state="idle";window.__retryFixture.server.turntable.motionCapability={supported:true,mode:"dual_axis_timed",probe:"confirmed",protocol:"0x30-0x36",status:{state:2,fault:0,session:34240}}');
      await click('document.querySelector("button[aria-label=检查转盘状态]")');
      await wait('('+button('取消待执行轨迹')+').disabled===false');
      assert.equal(await js('('+button('清除旧轨迹')+').disabled'),true);
      fs.writeFileSync(path.join(output,'turntable-ready-cancel-1366.png'),(await win.webContents.capturePage()).toPNG());
      const before=await js('({count:window.__retryFixture.calls.length,axes:structuredClone(window.__retryFixture.server.turntable.feedback.axes),storage:JSON.stringify(Object.entries(localStorage).sort())})');
      await click(button('取消待执行轨迹'));
      await wait('document.querySelector(".field-turntable-health").textContent.includes("待执行轨迹已取消")');
      const calls=await js('window.__retryFixture.calls.slice('+before.count+').filter(c=>c.action==="turntable"||c.action==="start")');
      assert.deepEqual(calls.map(c=>c.request),[{action:'cancel_trajectory',port:'COM6',axis:1,expectedTrajectorySession:34240,confirmRecovery:true}]);
      assert.deepEqual(await js('window.__retryFixture.server.turntable.feedback.axes'),before.axes);
      assert.equal(await js('JSON.stringify(Object.entries(localStorage).sort())'),before.storage);
      assert.equal(await js('('+button('取消待执行轨迹')+').disabled'),true);
      await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
    });
    await check('故障恢复明确分项，参考无效不允许强清，失败后不自动重试', async () => {
      await changed('window.__retryFixture.server=structuredClone(window.__retryFixture.base);window.__retryFixture.server.state="idle";window.__retryFixture.server.turntable.motionCapability={supported:true,mode:"dual_axis_timed",probe:"confirmed",protocol:"0x30-0x36",status:{state:7,fault:7}};Object.assign(window.__retryFixture.server.turntable.feedback.axes["1"],{fault:3,flags:18,output_angle_deg:null})');
      await click('document.querySelector("button[aria-label=检查转盘状态]")');
      await wait('('+button('清除旧轨迹')+').disabled===false');
      assert.equal(await js('('+button('清除俯仰轴故障')+').disabled'),true);
      const before=await js('window.__retryFixture.calls.length');
      await click(button('清除旧轨迹'));
      await wait('document.querySelector(".field-turntable-health").textContent.includes("本项恢复已读回确认")');
      const recoveryCalls=await js('window.__retryFixture.calls.slice('+before+').filter(c=>c.action==="turntable")');
      assert.deepEqual(recoveryCalls.map(c=>c.request),[{action:'clear_trajectory_fault',port:'COM6',axis:1,confirmRecovery:true}]);
      assert.ok(await js('document.querySelector(".field-turntable-health").textContent.includes("反馈单位变化／计数不连续（3）")'));
      await changed('Object.assign(window.__retryFixture.server.turntable.feedback.axes["1"],{fault:2,flags:3,output_angle_deg:10})');
      await click('document.querySelector("button[aria-label=重新检查转盘状态]")');
      await wait('('+button('清除俯仰轴故障')+').disabled===false');
      await click(button('清除俯仰轴故障'));
      await wait('document.querySelector(".field-turntable-health").textContent.includes("本项恢复已读回确认")');
      assert.equal(await js('window.__retryFixture.server.turntable.feedback.axes["1"].fault'),0);
      await changed('window.__retryFixture.server.turntable.motionCapability.status={state:7,fault:7};window.__retryFixture.recoveryFailure=true');
      await click('document.querySelector("button[aria-label=重新检查转盘状态]")');
      await wait('('+button('清除旧轨迹')+').disabled===false');
      await click(button('清除旧轨迹'));
      await wait('document.querySelector(".field-turntable-health").textContent.includes("需要配套 v3.4")');
      assert.equal(await js('('+button('清除旧轨迹')+').disabled'),true);
      await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
      await changed('window.__retryFixture.recoveryFailure=false;window.__retryFixture.server=structuredClone(window.__retryFixture.base)');
    });
    await check('转盘检查失败保留异常，运行时只查看已有反馈不占用串口', async () => {
      await js('window.__retryFixture.healthFailure=true');await click('document.querySelector("button[aria-label=检查转盘状态]")');
      await wait('document.querySelector(".field-turntable-health").textContent.includes("读取转盘超时")');
      assert.ok(await js('document.querySelector(".field-turntable-health").textContent.includes("本次检查失败")'));
      await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
      await js('window.__retryFixture.healthFailure=false');
      await changed('window.__retryFixture.server.state="acquiring";window.__retryFixture.server.receiver.running=true');
      const before=await js('window.__retryFixture.calls.filter(c=>c.action==="turntable"&&c.request.action==="health").length');
      await click('document.querySelector("button[aria-label=检查转盘状态]")');await pause(100);
      assert.equal(await js('window.__retryFixture.calls.filter(c=>c.action==="turntable"&&c.request.action==="health").length'),before);
      assert.equal(await js('document.querySelector("button[aria-label=重新检查转盘状态]").disabled'),true);
      await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
      await changed('window.__retryFixture.server.state="idle";window.__retryFixture.server.receiver.running=false');
    });
    await check('故障清除后重新查询才显示无异常，晚到的旧服务结果不能覆盖新状态', async () => {
      await changed('window.__retryFixture.server=structuredClone(window.__retryFixture.base);window.__retryFixture.server.state="idle";window.__retryFixture.server.error=null');
      await click('document.querySelector("button[aria-label=检查转盘状态]")');
      await wait('document.querySelector(".field-turntable-health").textContent.includes("本次检查未发现异常")');
      await js('window.__retryFixture.holdHealth=true;window.__retryFixture.releaseHealth=null');
      await click('document.querySelector("button[aria-label=重新检查转盘状态]")');
      await wait('typeof window.__retryFixture.releaseHealth==="function"');
      await changed('window.__retryFixture.server.service.generation=2;window.__retryFixture.server.turntable.feedback.axes["1"].fault=3');
      await js('window.__retryFixture.holdHealth=false;window.__retryFixture.releaseHealth()');await pause(100);
      assert.ok(await js('document.querySelector(".field-turntable-health").textContent.includes("反馈单位变化／计数不连续（3）")'));
      await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
    });
    await check('本机记录顶层标签切换，长列表波形弹窗保留滚动、键盘焦点和原始导出', async () => {
      await js(`window.__retryFixture.recordings=Array.from({length:40},(_,i)=>({id:'fixture-record-'+i,name:'现场记录 '+(i+1),source:'polytec_ivs500',samples:1000,sampleRate:1000,startedAt:1700000000+i,endedAt:1700000001+i,status:'complete',turbine:'WT01',windFarm:'WF-001',unit:'m/s',...(i===0?{pointCycle:{mode:'automatic_stations',sessionId:'a'.repeat(32),bladeId:'2',radialPointId:'P1',radialPointName:'P1',radiusM:.31,azimuthDeg:0,stationIndex:1,stationCount:1,lapIndex:1,cycle:1,cycles:1,pointIndex:1,pointId:'p1',pointName:'点位1',dwellSeconds:30,targetAxis1AngleDeg:1,targetAxis2AngleDeg:1,identitySource:'operator_assigned',identityVerified:false,coverageKind:'sparse_station_passes',completion:'confirmed_pass',plannedStations:[{pointId:'p1',bladeId:'2',radialPointId:'P1',radialPointName:'P1',radiusM:.31,azimuthDeg:0,stationIndex:1,stationCount:1}]}}:{})}));`);
      await click(button('本机记录')); await wait('document.querySelectorAll(".field-records-workspace .field-table tbody tr").length===40');
      const tab='document.querySelector("[role=tablist][aria-label=本机记录视图]")';
      assert.equal(await js(tab+'.querySelector("[aria-selected=true]").textContent'), '本机采集记录');
      assert.equal(await js('document.querySelector(".field-blade-summary").closest("[role=tabpanel]").hidden'),true);
      await js('document.querySelector(".field-content").scrollTop=900');
      const scroll=await js('document.querySelector(".field-content").scrollTop');assert.ok(scroll>0);
      await js('document.querySelectorAll(".field-record-actions")[20].querySelector("button").focus({preventScroll:true});document.querySelectorAll(".field-record-actions")[20].querySelector("button").click()');
      await wait('!!document.querySelector(".field-recording-preview [data-testid=wave-representation]")');
      assert.ok(await js('document.querySelector("dialog[open] .dialog-heading").textContent.includes("现场记录 21")'));
      assert.equal(await js('document.querySelector(".field-content").scrollTop'),scroll);
      assert.equal(await js('document.querySelectorAll(".field-content > .field-recording-preview").length'),0);
      await pause(100);
      fs.writeFileSync(path.join(output,'recording-dialog-1366.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      await wait('!document.querySelector("dialog[open]")');
      assert.equal(await js('document.querySelector(".field-content").scrollTop'),scroll);
      assert.equal(await js('document.activeElement===document.querySelectorAll(".field-record-actions")[20].querySelector("button")'),true);
      const exported=await js('window.__retryFixture.calls.filter(c=>c.action==="exportRecording").length');
      await click('document.querySelectorAll(".field-record-actions")[20].querySelectorAll("button")[1]');
      await wait('window.__retryFixture.calls.filter(c=>c.action==="exportRecording").length>'+exported);
      assert.equal(await js('window.__retryFixture.calls.filter(c=>c.action==="exportRecording").at(-1).id'),'fixture-record-20');
      await js('document.querySelector(".field-content").scrollTop=0');
      await click(tab+'.querySelectorAll("[role=tab]")[1]');
      assert.equal(await js('document.querySelector(".field-records-workspace .field-table").closest("[role=tabpanel]").hidden'),true);
      await js('document.querySelector(".field-blade-group").open=true');
      assert.ok(await js('document.querySelector(".field-blade-task-heading").textContent.includes("风场 WF-001")'));
      assert.ok(await js('document.querySelector(".field-blade-timing").textContent.includes("累计采集时长：1 秒")'));
      assert.ok(await js('document.querySelector(".field-blade-record-times").textContent.includes("开始")&&document.querySelector(".field-blade-record-times").textContent.includes("结束")'));
      await pause(80);fs.writeFileSync(path.join(output,'blade-summary-timing-1366.png'),(await win.webContents.capturePage()).toPNG());
      await click(button('查看记录'));await wait('!!document.querySelector(".field-recording-preview [data-testid=wave-representation]")');
      assert.ok(await js('document.querySelector("dialog[open] .dialog-heading").textContent.includes("现场记录 1")'));
      win.setContentSize(480,850);await pause(80);
      assert.equal(await js('document.querySelector("dialog").scrollWidth<=document.querySelector("dialog").clientWidth+2'),true);
      assert.equal(await js('document.querySelector(".field-recording-preview").scrollHeight>document.querySelector(".field-recording-preview").clientHeight'),true);
      fs.writeFileSync(path.join(output,'recording-dialog-480.png'),(await win.webContents.capturePage()).toPNG());
      await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
      assert.equal(await js('document.querySelector(".field-blade-group").open'),true);
      await js('document.querySelector("[role=tablist][aria-label=本机记录视图] [aria-selected=true]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');
      assert.equal(await js(tab+'.querySelector("[aria-selected=true]").textContent'),'本机采集记录');
      assert.equal(await js('document.activeElement.getAttribute("aria-selected")'),'true');
      win.setContentSize(1366,768);
    });
    await check('关闭后晚到的波形记录不会重开弹窗，读取失败可以原地重试', async () => {
      await js('window.__retryFixture.holdRecord=true');
      await click(button('查看波形'));await wait('typeof window.__retryFixture.releaseRecord==="function"');
      assert.ok(await js('document.querySelector("dialog").textContent.includes("正在读取采集记录")'));
      await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
      await js('window.__retryFixture.holdRecord=false;window.__retryFixture.releaseRecord()');await pause(100);
      assert.equal(await js('!!document.querySelector("dialog[open]")'),false);
      await js('window.__retryFixture.failRecord=true');await click(button('查看波形'));
      await wait('document.querySelector("dialog")?.textContent.includes("隔离验收：记录读取失败")');
      await js('window.__retryFixture.failRecord=false');await click(button('重新读取'));
      await wait('!!document.querySelector(".field-recording-preview [data-testid=wave-representation]")');
      await click('document.querySelector("dialog button[aria-label=关闭弹窗]")');
      assert.equal(await js('[...document.querySelectorAll(".field-global-message[role=alert]")].some(e=>e.textContent.includes("记录读取失败"))'),false);
    });
    report.screenshot = path.join(output, 'retry-ready-1366.png');
    fs.writeFileSync(report.screenshot, (await win.webContents.capturePage()).toPNG());
    await check('已知姿态参考恢复与回水平分开点击，使用设备0而非保存的作业零点', async () => {
      await changed('window.__retryFixture.server=structuredClone(window.__retryFixture.base);window.__retryFixture.server.state="idle";Object.assign(window.__retryFixture.server.turntable.feedback.axes["1"],{output_angle_deg:7});Object.assign(window.__retryFixture.server.turntable.feedback.axes["2"],{output_angle_deg:-16.73})');
      await click(button('转盘点位'));
      await click(button('手动控制'));
      await wait('('+button('俯仰回水平0°')+').disabled===false');
      await input('手动定位转速',.8);
      const before=await js('({count:window.__retryFixture.calls.length,origin:localStorage.getItem("blade-turntable-work-origins-v1")})');
      assert.ok(before.origin, '必须存在保存的作业原点');
      await click(button('俯仰回水平0°'));
      await wait('window.__retryFixture.calls.some((c,i)=>i>='+before.count+'&&c.action==="turntable"&&c.request.action==="manual_move")');
      assert.deepEqual(await js('window.__retryFixture.calls.slice('+before.count+').filter(c=>c.action==="turntable"||c.action==="start").map(c=>c.request)'),
        [{action:'manual_move',port:'COM6',axis:1,protocol:'position',targetAngleDeg:0,speedRpm:.8,durationSeconds:0,confirmMotion:true}]);
      assert.equal(await js('localStorage.getItem("blade-turntable-work-origins-v1")'),before.origin);
      await changed('Object.assign(window.__retryFixture.server.turntable.feedback.axes["1"],{output_angle_deg:null,flags:18,fault:3})');
      await wait('('+button('俯仰回水平0°')+').disabled===true');
      assert.equal(await js('('+button('确认当前为+25°参考')+').disabled'),false);
      const count=await js('window.__retryFixture.calls.length');
      await click(button('确认当前为+25°参考'));
      await wait('('+button('俯仰回水平0°')+').disabled===false');
      assert.deepEqual(await js('window.__retryFixture.calls.slice('+count+').filter(c=>c.action==="turntable"||c.action==="start").map(c=>c.request)'),
        [{action:'reference',port:'COM6',axis:1,confirmMotion:true}]);
      assert.equal(await js('window.__retryFixture.server.turntable.feedback.axes["1"].output_angle_deg'),25);
      assert.equal(await js('localStorage.getItem("blade-turntable-work-origins-v1")'),before.origin);
      win.setContentSize(1366,900);await pause(100);
      await js('document.querySelector(".field-turntable-manual").scrollIntoView({block:"start"})');
      fs.writeFileSync(path.join(output,'turntable-reference-1366.png'),(await win.webContents.capturePage()).toPNG());
      await click(button('轴2 · 水平'));
      await wait('('+button('水平回设备0°')+').disabled===false');
      const yawCount=await js('window.__retryFixture.calls.length');
      await click(button('水平回设备0°'));
      await wait('window.__retryFixture.calls.some((c,i)=>i>='+yawCount+'&&c.action==="turntable"&&c.request.action==="manual_move")');
      assert.deepEqual(await js('window.__retryFixture.calls.slice('+yawCount+').filter(c=>c.action==="turntable"||c.action==="start").map(c=>c.request)'),
        [{action:'manual_move',port:'COM6',axis:2,protocol:'position',targetAngleDeg:0,speedRpm:.2,durationSeconds:0,confirmMotion:true}]);
    });
    clearTimeout(watchdog); finish();
  } catch (error) { clearTimeout(watchdog); if (win) report.failureState = await js('({calls:window.__retryFixture.calls,server:window.__retryFixture.server,text:document.body.innerText})').catch(() => null); finish(error); }
});
