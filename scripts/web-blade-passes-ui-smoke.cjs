'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { buildReview } = require('./build-web-blade-passes-review.cjs');
const output = buildReview();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-pass-ui-')));
app.setName('BladeVMS 有效片段隔离界面验收');
const report = { hardwareTested: false, networkUsed: false, checks: [], screenshots: [] };
let win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(`(async()=>{return await eval(${JSON.stringify(code)})})()`, true);
const button = text => `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
async function click(text) { await run(`(()=>{const element=${button(text)};if(!element||element.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});element.click()})()`); await pause(45); }
async function waitFor(code) { for (let index=0;index<120;index++){if(await run(code))return;await pause(25);}throw Error('Timeout: '+code); }
async function choose(label,text) {
 await run(`(()=>{const element=document.querySelector('[role=combobox][aria-label="'+${JSON.stringify(label)}+'"]');element.scrollIntoView({block:'center'});element.click()})()`);
 await waitFor('!!document.querySelector("[role=listbox]")');
 await run(`(()=>{const element=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!element)throw Error('Option missing');element.click()})()`);await pause(70);
}
async function check(name,callback){await callback();report.checks.push({name,passed:true});console.log('PASS '+name);}
function finish(error){report.passed=!error;if(error)report.error=error.stack;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));if(error)console.error(error);app.exit(error?1:0);}
const watchdog=setTimeout(()=>finish(Error('Isolated UI timeout')),90000);
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1366,height:768,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file:')&&!details.url.startsWith('data:')}));
 await win.loadFile(path.join(output,'index.html'));await waitFor('document.querySelectorAll(".blade-pass-points input").length===2');
 await check('只加载记录，不自动分析；旧记录不混入任务且说明缺失归属',async()=>{
  assert.equal(await run('window.__bladePassFixture.requests.length'),1);
  assert.equal(await run('document.querySelectorAll(".blade-pass-records tbody tr").length'),5);
  assert.ok(await run('document.body.textContent.includes("缺少有效任务归属")'));
  assert.equal(await run('document.querySelectorAll(".blade-pass-results").length'),0);
 });
 await check('任务与测点选择限制请求范围，结果按真实返回显示',async()=>{
  await run(`document.querySelector('input[aria-label="选择测点 P2 · 叶尖"]').click()`);await pause(40);await click('筛选并分析');
  const request=await run('window.__bladePassFixture.requests.at(-1)');assert.deepEqual(request.body.recordingIds,['a-p1-0','a-p1-90']);
  assert.equal(request.body.detrend,'constant');assert.equal(request.body.rssiThresholdPercent,undefined);
  await waitFor('document.querySelectorAll(".blade-pass-results").length===1');
  await run(`document.querySelector('input[aria-label="选择测点 P2 · 叶尖"]').click()`);await pause(40);
  assert.equal(await run('document.querySelectorAll(".blade-pass-results").length'),0);await click('筛选并分析');
  await waitFor('document.querySelectorAll(".blade-pass-results").length===1');
  assert.ok(await run('document.querySelector(".blade-pass-results").textContent.includes("缺少叶片离开")'));
 });
 await check('不同圆周点位的多点分布独立，缺相位不生成振型动画',async()=>{
  await waitFor('window.__bladePassFixture.chartOptions().every(item=>item.option)');
  let chart=await run('window.__bladePassFixture.chartOptions()[0].option');assert.deepEqual(chart.series[0].data,[[.31,2],[.5,4]]);
  await choose('幅值分布圆周点位','90°');chart=await run('window.__bladePassFixture.chartOptions()[0].option');assert.deepEqual(chart.series[0].data,[[.31,6],[.5,12]]);
  assert.ok(await run('document.querySelector(".blade-pass-boundary").textContent.includes("不能据此生成实测振型")'));
  assert.equal(await run('!!'+button('播放动画')),false);
 });
 await check('有效段保持原记录时间与间隙，FFT只来自选中的单段',async()=>{
  const wave=await run('window.__bladePassFixture.chartOptions()[1].option');assert.equal(wave.series.length,2);
  assert.equal(wave.series[0].data[0][0],.1);assert.equal(wave.series[1].data[0][0],.5);assert.ok(wave.series.every(series=>!series.connectNulls));
  let fft=await run('window.__bladePassFixture.chartOptions()[2].option');assert.equal(fft.series[0].data[1][1],2);
  await choose('FFT 连续有效段','第 2 段');fft=await run('window.__bladePassFixture.chartOptions()[2].option');assert.equal(fft.series[0].data[1][1],4);
  await choose('查看有效波形记录','P1 · 叶中 · 90°');fft=await run('window.__bladePassFixture.chartOptions()[2].option');assert.equal(fft.series[0].data[1][1],6);
  assert.ok(await run('document.querySelector(".blade-pass-spectrum-heading").textContent.includes("7.813")'));
 });
 await check('1366/820/480视口无页面横向溢出，图表与控件留有间距',async()=>{
  for(const [width,height] of [[1366,768],[820,768],[480,800]]){
   win.setContentSize(width,height);await pause(120);await run('window.scrollTo(0,0)');await pause(50);
   const bounds=await run('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(bounds.scroll<=bounds.width+2,JSON.stringify(bounds));
   const name='blade-passes-'+width+'x'+height+'.png';fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());report.screenshots.push(name);
   await run('document.querySelector(".blade-pass-results").scrollIntoView({block:"start"})');await pause(70);
   const resultName='blade-passes-results-'+width+'x'+height+'.png';fs.writeFileSync(path.join(output,resultName),(await win.webContents.capturePage()).toPNG());report.screenshots.push(resultName);
  }
  win.setContentSize(1366,768);await pause(80);
  await run('document.querySelector(".blade-pass-spectrum-heading").scrollIntoView({block:"center"})');await pause(70);
  fs.writeFileSync(path.join(output,'blade-passes-waveform.png'),(await win.webContents.capturePage()).toPNG());report.screenshots.push('blade-passes-waveform.png');
 });
 await check('任务切换与参数更改清理旧结果，迟到回复不能重新标到新任务',async()=>{
  await run('window.__bladePassFixture.hold=true');await click('筛选并分析');await waitFor('window.__bladePassFixture.resolvers.length===1');
  await choose('任务与叶片','叶片3');assert.equal(await run('document.querySelectorAll(".blade-pass-results").length'),0);
  await run('window.__bladePassFixture.resolvers.shift()();window.__bladePassFixture.hold=false');await pause(100);
  assert.equal(await run('document.querySelectorAll(".blade-pass-results").length'),0);
  await click('筛选并分析');assert.deepEqual((await run('window.__bladePassFixture.requests.at(-1)')).body.recordingIds,['b-p1-0']);
  await run('document.querySelector(".blade-pass-advanced").open=true');
  await run(`(()=>{const element=document.querySelector('input[aria-label="RSSI 下限百分比"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(element,"35");element.dispatchEvent(new Event("input",{bubbles:true}))})()`);await pause(40);
  assert.equal(await run('document.querySelectorAll(".blade-pass-results").length'),0);await click('筛选并分析');assert.equal((await run('window.__bladePassFixture.requests.at(-1)')).body.rssiThresholdPercent,35);
 });
 await check('取消等待丢弃迟到结果，只读权限不允许运行分析',async()=>{
  await run('window.__bladePassFixture.hold=true');await click('筛选并分析');await waitFor('window.__bladePassFixture.resolvers.length===1');
  await click('取消等待');await run('window.__bladePassFixture.resolvers.shift()();window.__bladePassFixture.hold=false');await pause(70);
  assert.equal(await run('document.querySelectorAll(".blade-pass-results").length'),0);
  await run('window.__bladePassFixture.setCanAnalyze(false)');await pause(60);assert.equal(await run(`${button('筛选并分析')}.disabled`),true);
  assert.deepEqual(await run('window.__bladePassFixture.errors'),[]);
  assert.ok((await run('window.__bladePassFixture.requests')).every(request=>['/api/v1/rotation/recordings','/api/v1/rotation/blade-passes'].includes(request.url)));
 });
 clearTimeout(watchdog);finish();
}catch(error){clearTimeout(watchdog);finish(error);}});
