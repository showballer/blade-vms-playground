'use strict';
// Disposable renderer: no production preload, network, hardware or user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { buildReview } = require(process.cwd()+'/scripts/build-auto-follow-ui-review.cjs');
const output=buildReview();
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'blade-auto-ui-')));
let win;
const report={hardwareTested:false,realServiceStarted:false,productionUserDataTouched:false,checks:[],screenshots:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const run=code=>win.webContents.executeJavaScript('(async()=>{return await eval('+JSON.stringify(code)+')})()',true);
const button=text=>"[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==="+JSON.stringify(text)+"&&!e.closest('[hidden]'))";
async function click(text){await run('(()=>{const e='+button(text)+';if(!e||e.disabled)throw Error("Button unavailable: "+'+JSON.stringify(text)+');e.click();})()');await pause(45);}
const inputSelector=label=>'input[aria-label="'+label+'"]';
async function action(label){await run('(()=>{const e=document.querySelector('+JSON.stringify('button[aria-label="'+label+'"]')+');if(!e||e.disabled)throw Error("Action unavailable");e.click();})()');await pause(45);}
async function input(label,value){await run('(()=>{const e=document.querySelector('+JSON.stringify(inputSelector(label))+');if(!e||e.disabled)throw Error("Input unavailable");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');await pause(45);}
async function choose(index){await run('document.querySelector('+JSON.stringify(inputSelector('选择测点'+index))+').click()');await pause(45);}
async function blade(name){await run('([...document.querySelectorAll(".field-auto-blade-choice")].find(e=>e.querySelector("strong").textContent==='+JSON.stringify('叶片 '+name)+')).click()');await pause(45);}
async function waitFor(code){for(let i=0;i<120;i++){if(await run(code))return;await pause(25);}throw Error('Timeout: '+code);}
const target=(bladeId,name)=>'window.__autoFixture.routes.auto.targets.find(t=>t.bladeId==='+JSON.stringify(bladeId)+'&&t.pointName==='+JSON.stringify(name)+')';
const calibrated=(bladeId,name)=>run('!!'+target(bladeId,name)+'?.route.cycle&&'+target(bladeId,name)+'.route.referenceMode!=="read_at_start"');
const theoretical=(bladeId,name)=>run('!!'+target(bladeId,name)+'?.route.cycle&&'+target(bladeId,name)+'.route.referenceMode==="read_at_start"');
const calls=action=>run('window.__autoFixture.calls.filter(c=>c.action==='+JSON.stringify(action)+').length');
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS '+name);}
async function screenshot(name){fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());report.screenshots.push(name);}
function finish(error){report.passed=!error;if(error)report.error=error.stack;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));if(error)console.error(error);app.exit(error?1:0);}
const watchdog=setTimeout(()=>finish(Error('UI fixture timeout')),90000);
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1366,height:768,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((d,c)=>c({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
 await win.loadFile(path.join(output,'index.html'));await waitFor('window.__autoFixture?.ready&&window.__autoFixture.routes?.auto');
 await check('只在进入自动页枚举串口一次，唯一串口自动选择，不读取位置或运动',async()=>{
  assert.equal(await calls('turntablePorts'),0);await click('自动跟随');await waitFor('document.querySelector("input[aria-label=自动跟随转盘串口]").value==="COM3"');
  assert.equal(await calls('turntablePorts'),1);assert.equal(await calls('turntable'),0);
  await input('叶轮每圈时间 · s','31');await input('叶轮每圈时间 · s','30');assert.equal(await calls('turntablePorts'),1);
  assert.ok(await run('!!document.querySelector(".field-auto-port-control button[aria-label=刷新转盘串口]")'));
  assert.equal(await run('document.querySelector(".field-auto-follow").textContent.includes("设备与服务设置")'),false);
  await action('刷新转盘串口');assert.equal(await calls('turntablePorts'),2);
 });
 await check('转盘设置弹窗中速度与加速度可编辑，保存后仍无设备运动请求',async()=>{
  await input('叶轮每圈时间 · s','0');
  await action('打开转盘设置');
  await waitFor('!!document.querySelector(".field-auto-turntable-setup")&&!document.querySelector("button[aria-label=重新检查转盘状态]").disabled');
  await input('两轴换点转速上限 · rpm','5');
  await input('换点加速度上限 · °/s²','30');
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.maxMoveAccelerationDegS2'),30);
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.maxMoveRpm'),5);
  assert.equal(await run('JSON.parse(localStorage.getItem("blade-auto-follow-draft-v1")).settings.maxMoveAccelerationDegS2'),30);
  assert.ok(await run('window.__autoFixture.calls.filter(c=>c.action==="turntable").every(c=>c.request.action==="health")'));
  await run('document.querySelector(".field-auto-turntable-setup").scrollIntoView({block:"center"})');
  await screenshot('motion-settings-1366.png');
  await input('换点加速度上限 · °/s²','3');await input('两轴换点转速上限 · rpm','0.6');
  await action('关闭弹窗');await input('叶轮每圈时间 · s','30');
 });
 await check('未校准即可形成绝对几何模板，行内校准，无全局校准卡和待校准门槛',async()=>{
  assert.equal(await theoretical('2','P1'),true);
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.startAtCurrentPose'),false);
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.points.some(p=>p.referenceSignature)'),false);
  assert.equal(await run('!!document.querySelector(".field-auto-anchor")'),false);
  assert.equal(await run('document.querySelector(".field-auto-follow").textContent.includes("待校准")'),false);
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.points.length'),4);
  assert.ok(await run('window.__autoFixture.routes.auto.cycle.points[0].axis1AngleDeg')>20);
 });
 await check('新增空点先补半径，补齐即理论可采集，不要求逐点校准',async()=>{
  await click('添加测点');assert.equal(await run('document.querySelector("input[aria-label=选择测点2]").checked'),true);
  assert.equal(await run('!window.__autoFixture.routes.auto.cycle'),true);await input('测点2半径','0.5');assert.equal(await theoretical('2','P2'),true);
 });
 await check('逐点校准只读取反馈，运动中拒绝校准，仍保留理论路线',async()=>{
  await run('window.__autoFixture.probeStatus=structuredClone(window.__autoFixture.initial);window.__autoFixture.probeStatus.turntable.feedback.axes["1"].motor_rpm=.01');
  await action('校准测点2');assert.equal(await calibrated('2','P2'),false);assert.equal(await theoretical('2','P2'),true);
  const before=await run(target('2','P2')+'.route.cycle.points');
  await run('window.__autoFixture.probeStatus=null');await action('校准测点2');assert.equal(await calibrated('2','P2'),true);assert.equal(await theoretical('2','P1'),true);
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.points[0].axis1AngleDeg'),10);
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.startAtCurrentPose'),true);
  assert.equal(await run(target('2','P1')+'.route.cycle.startAtCurrentPose'),false);
  assert.ok(await run('window.__autoFixture.calls.filter(c=>c.action==="turntable").every(c=>["probe","health"].includes(c.request.action))'));
  const correction=await run('document.querySelector("[aria-label=测点2整圈修正量]").textContent');
  assert.ok(correction.includes((10-before[0].axis1AngleDeg).toFixed(3)));
  assert.ok(correction.includes('整圈角度修正'));assert.ok(correction.includes('水平 0.000°'));
  assert.equal(await run('document.querySelector(".field-auto-follow").textContent.includes("已记录首个点位")'),true);
  const after=await run(target('2','P2')+'.route.cycle.points');
  for(let i=0;i<after.length;i++)assert.ok(Math.abs((after[i].axis1AngleDeg-before[i].axis1AngleDeg)-(10-before[0].axis1AngleDeg))<.000002);
  await run('document.querySelector("[aria-label=测点2整圈修正量]").scrollIntoView({block:"center"})');
  await screenshot('calibration-offset-1366.png');
 });
 await check('两个点校准独立；修改一个半径只恢复该点理论计算，支持恢复计算',async()=>{
  await action('校准测点1');assert.equal(await calibrated('2','P1'),true);assert.equal(await calibrated('2','P2'),true);
  await input('测点2半径','0.51');assert.equal(await theoretical('2','P2'),true);assert.equal(await calibrated('2','P1'),true);
  await input('测点2半径','0.5');assert.equal(await theoretical('2','P2'),true);await action('校准测点2');
  await action('恢复测点2计算角度');assert.equal(await theoretical('2','P2'),true);assert.equal(await calibrated('2','P1'),true);
  assert.equal(await run(target('2','P2')+'.route.cycle.startAtCurrentPose'),false);
 });
 await check('移除测点手动瞄准跳转，顶部手动标签仍可用；返回时保留其他点校准',async()=>{
  assert.equal(await run('document.querySelectorAll("button[aria-label^=手动瞄准测点]").length'),0);
  const before=await calls('turntable'),ports=await calls('turntablePorts');await click('手动控制');
  assert.equal(await run('document.querySelector("[role=tab][aria-selected=true]").textContent'),'手动控制');
  assert.equal(await calls('turntable'),before);await click('自动跟随');await waitFor('window.__autoFixture.calls.filter(c=>c.action==="turntablePorts").length==='+String(ports+1));
  assert.equal(await calibrated('2','P1'),true);
 });
 await check('不同叶片同名测点互不覆盖，公共几何改变恢复各点理论计算',async()=>{
  await click('添加叶片');await input('测点1半径','0.31');assert.equal(await theoretical('1','P1'),true);await action('校准测点1');
  assert.equal(await calibrated('1','P1'),true);assert.equal(await calibrated('2','P1'),true);
  await input('设备至叶轮平面 · m','2.9');
  assert.equal(await run('window.__autoFixture.routes.auto.targets.every(t=>t.route.referenceMode==="read_at_start")'),true);
  await input('设备至叶轮平面 · m','2.86');await blade('2');await action('校准测点1');
 });
 await check('服务代际变化清除校准；迟到校准包不能覆盖新服务状态',async()=>{
  await run('window.__autoFixture.holdProbe=true;window.__autoFixture.releaseProbe=null');await action('校准测点2');await waitFor('typeof window.__autoFixture.releaseProbe==="function"');
  const updates=await run('window.__autoFixture.statusUpdates.length');await run('window.__autoFixture.inject({...structuredClone(window.__autoFixture.initial),service:{state:"ready",dllConfigured:true,generation:2}})');await pause(50);
  await run('window.__autoFixture.holdProbe=false;window.__autoFixture.releaseProbe()');await pause(80);
  assert.equal(await run('window.__autoFixture.statusUpdates.length'),updates);
  assert.equal(await run('window.__autoFixture.routes.auto.targets.every(t=>t.route.referenceMode==="read_at_start")'),true);
  await run('window.__autoFixture.inject(structuredClone(window.__autoFixture.initial))');await pause(50);
 });
 await check('五点生成可手改，不自动覆盖现有点；其他叶片及历史点ID不混用',async()=>{
  const old=await run('window.__autoFixture.routes.auto.targets');await input('叶片长度 · m','0.5');
  const afterLength=await run('window.__autoFixture.routes.auto.targets');
  assert.deepEqual(afterLength.map(t=>[t.key,t.radiusM]),old.map(t=>[t.key,t.radiusM]));
  assert.deepEqual(afterLength.filter(t=>t.bladeId!=='2'),old.filter(t=>t.bladeId!=='2'));
  await click('生成5个测点');const generated=await run('window.__autoFixture.routes.auto.targets.filter(t=>t.bladeId==="2")');
  assert.deepEqual(generated.map(t=>t.radiusM),[.05,.15,.25,.35,.45]);assert.ok(generated.every(t=>!old.some(o=>o.key===t.key)));
  await input('测点3半径','0.26');await input('叶片长度 · m','0.6');assert.equal(await run(target('2','P3')+'.radiusM'),.26);
  assert.equal(await run('!!document.querySelector(".field-auto-root-offset")'),false);
  await input('叶根预留 · %','5');await input('叶尖预留 · %','20');await input('叶片长度 · m','0.5');await click('生成5个测点');
  assert.deepEqual(await run('window.__autoFixture.routes.auto.targets.filter(t=>t.bladeId==="2").map(t=>t.radiusM)'),[.025,.11875,.2125,.30625,.4]);
  const savedPoints=await run('window.__autoFixture.routes.auto.targets.map(t=>[t.key,t.radiusM])');
  await input('叶根预留 · %','80');await input('叶尖预留 · %','30');await click('生成5个测点');
  assert.ok(await run('document.querySelector(".field-auto-point-generator").textContent.includes("预留比例之和必须小于100%")'));
  assert.deepEqual(await run('window.__autoFixture.routes.auto.targets.map(t=>[t.key,t.radiusM])'),savedPoints);
  await input('叶根预留 · %','5');await input('叶尖预留 · %','20');
  assert.equal(await run('window.__autoFixture.routes.auto.targets.filter(t=>t.bladeId==="2").every(t=>t.rootRadiusM===0&&t.route.cycle.points.every(p=>p.rootRadiusM===0))'),true);

 });
 await check('高度自动计算实际用于理论路线，缺值不回退；输入变化不触发设备',async()=>{
  const before=await calls('turntable');
  await input('激光出射点离地高度 · m','0.65');assert.equal(await run('window.__autoFixture.routes.auto.targets.every(t=>!t.route.cycle)'),true);
  await input('风机旋转中心离地高度 · m','1.5');
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.geometry.hubHeightDeltaM'),.85);
  await input('激光出射点离地高度 · m','');assert.equal(await run('window.__autoFixture.routes.auto.targets.every(t=>!t.route.cycle)'),true);
  await input('激光出射点离地高度 · m','0.65');assert.equal(await calls('turntable'),before);
 });
 await check('串口异步刷新不覆盖人工选择，隐藏时回包不修改串口',async()=>{
  await run('window.__autoFixture.holdPorts=true;window.__autoFixture.releasePorts=null');await action('刷新转盘串口');await waitFor('typeof window.__autoFixture.releasePorts==="function"');
  await input('自动跟随转盘串口','COM4');await run('window.__autoFixture.holdPorts=false;window.__autoFixture.releasePorts()');await pause(60);
  assert.equal(await run('document.querySelector("input[aria-label=自动跟随转盘串口]").value'),'COM4');
  await run('window.__autoFixture.holdPorts=true;window.__autoFixture.releasePorts=null');await action('刷新转盘串口');await waitFor('typeof window.__autoFixture.releasePorts==="function"');
  await run('window.__autoFixture.inject({...structuredClone(window.__autoFixture.initial),service:{state:"ready",dllConfigured:true,generation:2}})');await pause(50);
  await run('window.__autoFixture.holdPorts=false;window.__autoFixture.releasePorts()');await pause(60);
  assert.equal(await run('document.querySelector("input[aria-label=自动跟随转盘串口]").value'),'COM4');
  await run('window.__autoFixture.inject(structuredClone(window.__autoFixture.initial))');await pause(50);
  await run('window.__autoFixture.holdPorts=true;window.__autoFixture.releasePorts=null');await action('刷新转盘串口');await waitFor('typeof window.__autoFixture.releasePorts==="function"');
  await click('手动控制');await run('window.__autoFixture.holdPorts=false;window.__autoFixture.releasePorts()');await pause(60);
  assert.equal(await run('document.querySelector("input[aria-label=自动跟随转盘串口]").value'),'COM4');await click('自动跟随');await waitFor('document.querySelector("input[aria-label=自动跟随转盘串口]").value==="COM3"');
 });
 await check('重载保留全部配置和选择，不恢复校准，不自动采集或读取位置',async()=>{
  await action('校准测点1');assert.equal(await calibrated('2','P1'),true);const selected=await run('window.__autoFixture.routes.auto.selectedTargetKey');
  await new Promise(r=>{win.webContents.once('did-finish-load',r);win.webContents.reload();});await waitFor('window.__autoFixture?.routes?.auto?.targets?.length===6');
  assert.equal(await calls('turntable'),0);assert.equal(await calls('turntablePorts'),0);await click('自动跟随');
  assert.equal(await run('window.__autoFixture.routes.auto.selectedTargetKey'),selected);assert.equal(await theoretical('2','P1'),true);
  assert.equal(await run('window.__autoFixture.routes.auto.cycle.geometry.hubHeightDeltaM'),.85);
  assert.equal(await run('document.querySelector('+JSON.stringify(inputSelector('叶片长度 · m'))+').value'),'0.5');
  assert.equal(await run('document.querySelector('+JSON.stringify(inputSelector('叶根预留 · %'))+').value'),'5');
  assert.equal(await run('document.querySelector('+JSON.stringify(inputSelector('叶尖预留 · %'))+').value'),'20');

 });
 await check('采集中禁用校准、配置与串口刷新；1366/1024/480布局无横向溢出',async()=>{
  await run('window.__autoFixture.inject({...structuredClone(window.__autoFixture.initial),state:"acquiring"})');await pause(60);
  assert.equal(await run('document.querySelector("button[aria-label=校准测点1]").disabled'),true);
  assert.equal(await run('document.querySelector("button[aria-label=刷新转盘串口]").disabled'),true);
  await run('window.__autoFixture.inject(structuredClone(window.__autoFixture.initial))');await pause(60);

  for(const [width,height] of [[1366,768],[1024,768],[480,800]]){
   win.setContentSize(width,height);await pause(100);await run('document.querySelector(".field-auto-points").scrollIntoView({block:"center"})');await pause(50);
   assert.equal(await run('document.body.scrollWidth<=innerWidth+2&&document.querySelector(".field-content").scrollWidth<=document.querySelector(".field-content").clientWidth+2'),true);
   assert.equal(await run('[...document.querySelectorAll(".field-auto-point-buttons .btn")].every(e=>e.clientHeight<=40)'),true);
   await screenshot('inline-calibration-'+width+'.png');
  }
 });
 clearTimeout(watchdog);finish();
}catch(error){clearTimeout(watchdog);finish(error);}});
