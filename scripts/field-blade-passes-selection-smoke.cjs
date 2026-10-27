'use strict';
// Isolated Electron renderer test for selecting points across multiple tasks.
// Uses in-memory fixtures only; no service, account, or hardware is started.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'packages/ui/src');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-pass-selection-'));
app.setPath('userData', path.join(temp, 'profile'));

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as echarts from 'echarts/core';
import {WebBladePasses} from ${JSON.stringify(path.join(ui, 'web-blade-passes.tsx'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'web-blade-passes.css'))};

const tasks=[['a'.repeat(32),'任务甲'],['b'.repeat(32),'任务乙']];
let sequence=0;
const recordings=tasks.flatMap(([collectionId,name], taskIndex)=>['P1','P2'].map((point,index)=>{
  sequence++;
  return {id:String(sequence).padStart(32,'0'),name,samples:1000,sampleRate:1000,startedAt:1700000000000+sequence,status:'complete',
    windFarm:'风场 A',turbine:'机组 1',object:'叶片',pointCycle:{mode:'automatic_stations',collectionId,
      sessionId:String(sequence).padStart(32,'0'),bladeId:'2',radialPointId:point,radialPointName:point,
      radiusM:index===0?.31:.5,azimuthDeg:taskIndex*90,stationIndex:taskIndex+1,stationCount:2,lapIndex:1,completion:'confirmed_pass'}};
}));
window.__bladePassFixture={analysis:null,errors:[]};
window.__bladePassFixture.charts=()=>[...document.querySelectorAll('[role=img]')].map(element=>({label:element.getAttribute('aria-label'),option:echarts.getInstanceByDom(element)?.getOption()}));
const localData={listRecordings:async()=>({recordings}),analyze:async parameters=>{
  window.__bladePassFixture.analysis=parameters;
  const metrics={rmsVelocityMps:.002,peakVelocityMps:.003,peakToPeakVelocityMps:.006};
  const sources=recordings.filter(record=>parameters.recordingIds.includes(record.id)).map(record=>{
    const m=record.pointCycle, scale=m.radialPointId==='P1'?1:2;
    return {recordingId:record.id,name:record.name,...m,sampleRate:1000,sampleOrigin:0,status:'included',
      candidateRange:{start:0,end:100},validRanges:[{start:0,end:100,samples:100}],exclusions:[],metrics,
      segments:[{start:0,end:100,samples:100,durationSeconds:.1,metrics,
        timeDomain:{sampleIndices:[0,99],seconds:[0,.099],values:[.001*scale,-.001*scale]},
        spectrum:{frequencies:[0,10],amplitudes:[0,.001*scale],frequencySpacingHz:10}}]};
  });
  const mergedPoints=['P1','P2'].map((id,index)=>{
    const selected=sources.filter(source=>source.radialPointId===id),scale=index+1;
    return {radialPointId:id,radialPointName:id,radiusM:index===0?.31:.5,samples:selected.length*100,durationSeconds:selected.length*.1,
      segments:selected.map((source,i)=>({segmentId:source.recordingId+':0:100',recordingId:source.recordingId,sourceRecordingId:source.recordingId,
        azimuthDeg:source.azimuthDeg,originalStart:0,originalEnd:100,sampleRate:1000,mergedStart:i*100,mergedEnd:(i+1)*100,
        compressedStartSeconds:i*.1,compressedEndSeconds:(i+1)*.1,originalStartSeconds:0,originalEndSeconds:.1,timeDomain:source.segments[0].timeDomain})),
      stitchedWaveform:{seconds:[0,.1,.199],valuesMps:[.001*scale,-.002*scale,.003*scale]},
      stitchedSpectrum:{sampleRate:1000,fftSampleRate:1000,samples:200,frequencySpacingHz:5,frequencies:[0,5,10],amplitudesMps:[0,.003*scale,.001*scale],method:'fixture'}};
  });
  return {algorithmVersion:'fixture',parameters,collectionId:tasks[0][0],bladeId:'2',phaseAvailable:false,modeShapeUnavailableReason:'相位未知',
    coverage:{selectedRecords:sources.length,includedRecords:sources.length,excludedRecords:0,rawSamples:sources.length*1000,validSamples:sources.length*100,validSeconds:sources.length*.1,segmentCount:sources.length},
    sources,points:[],amplitudeDistributions:[],warnings:[],synthesis:{algorithmVersion:'fixture',status:'insufficient_evidence',reason:'隔离样例',
      coordinate:'compressed-valid-time',measuredPhaseAvailable:false,damageAssessmentAvailable:false,assumptions:[],candidates:[],bandResponses:[],mergedPoints}};
}};
createRoot(document.getElementById('root')).render(<WebBladePasses canAnalyze refreshKey={0} preferredIds={[]}
  onError={error=>window.__bladePassFixture.errors.push(String(error))} localData={localData}/>);
`;

buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true,
  outfile: path.join(temp, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>叶片测点选择测试</title><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');

let win;
const run = async code => {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) { throw new Error(`Renderer check failed: ${code}`, { cause: error }); }
};
async function waitFor(code) {
  for (let i = 0; i < 120; i++) { if (await run(code)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error('Timed out: ' + code);
}
async function choose(label, text) {
  await run(`document.querySelector('[role=combobox][aria-label="${label}"]').click()`);
  await waitFor('!!document.querySelector("[role=listbox]")');
  await run(`(()=>{const option=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!option)throw Error('Missing option');option.click()})()`);
  await waitFor('!document.querySelector("[role=listbox]")');
}
async function signalChart(kind) {
  const label = kind === 'wave' ? '拼接波形' : kind === 'fft' ? '拼接后的 FFT' : '单个连续有效段';
  await waitFor(`window.__bladePassFixture.charts().some(c=>c.label.includes('${label}')&&c.option)`);
  return run(`window.__bladePassFixture.charts().find(c=>c.label.includes('${label}')).option`);
}
const finish = error => {
  if (error) console.error(error.stack || error);
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(error ? 1 : 0);
};

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1280, height: 900, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') throw Error(event.message); });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    await win.loadFile(path.join(temp, 'index.html'));
    await waitFor('document.querySelectorAll(".blade-task-options > label").length===2');

    await run(`(()=>{const e=[...document.querySelectorAll('.blade-task-options input')].find(x=>x.getAttribute('aria-label').includes('任务乙'));if(!e)throw Error('Second task checkbox missing');e.click()})()`);
    await waitFor('document.querySelectorAll(".blade-task-workspace").length===2');
    assert.equal(await run('document.querySelectorAll(".blade-task-workspace").length'), 2);
    assert.equal(await run('document.querySelector(".blade-pass-selection").innerText.includes("4 / 64")'), true);

    await run(`(()=>{const workspaces=[...document.querySelectorAll('.blade-task-workspace')];const point=workspaces[0].querySelector('input[aria-label="选择测点 P2"]');if(!point)throw Error('First task P2 checkbox missing');point.click()})()`);
    await waitFor('document.querySelector(".blade-pass-selection").innerText.includes("3 / 64")');
    assert.equal(await run('document.querySelectorAll(".blade-task-workspace")[1].innerText.includes("已选 2/2 个测点")'), true);
    await run(`(()=>document.querySelectorAll('.blade-task-workspace')[0].querySelector('input[aria-label="选择测点 P2"]').click())()`);
    await waitFor('document.querySelector(".blade-pass-selection").innerText.includes("4 / 64")');

    await run(`(()=>{const field=document.querySelector('input[aria-label="组合叶片标识"]');if(!field)throw Error('Composition confirmation missing');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(field,'叶片实体 A');field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('input[aria-label="确认所选任务来自同一根实体叶片"]').click();})()`);
    await run(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('合并片段并查看叶片'));if(!button||button.disabled)throw Error('Analyze button unavailable');button.click()})()`);
    await waitFor('window.__bladePassFixture.analysis!==null');
    const sent = await run('window.__bladePassFixture.analysis');
    assert.equal(sent.recordingIds.length, 4);
    assert.equal(sent.bladeComposition.bladeLabel, '叶片实体 A');
    assert.deepEqual(sent.bladeComposition.tasks.map(task=>task.recordingIds.length), [2,2]);
    assert.equal(await run('window.__bladePassFixture.errors.length'), 0);
    console.log('PASS cross-task and multi-point checkboxes update independently and submit task-matched recording IDs; no hardware used');
    await waitFor('!!document.querySelector(".blade-pass-results")');
    assert.deepEqual((await signalChart('wave')).series[0].data, [[0,1],[.1,-2],[.199,3]]);
    assert.deepEqual((await signalChart('fft')).series[0].data, [[0,0],[5,3],[10,1]]);
    assert.equal(await run('document.querySelectorAll("[role=img]").length'), 2, 'Merged charts appear once');
    assert.ok(await run('document.body.textContent.includes("2 条记录 · 2 个有效片段 · 角度 0°、90°")'));
    await choose('有效信号合并测点', 'P2');
    assert.deepEqual((await signalChart('wave')).series[0].data, [[0,2],[.1,-4],[.199,6]]);
    assert.deepEqual((await signalChart('fft')).series[0].data, [[0,0],[5,6],[10,2]]);
    assert.deepEqual((await signalChart('wave')).series[0].markLine.data.map(item=>item.xAxis), [.1]);
    await choose('有效信号查看方式', '单条记录');
    await waitFor(`document.querySelector('select[aria-label="查看有效波形记录"]').selectedOptions[0].textContent.includes('P2')`);
    assert.deepEqual((await signalChart('recording')).series[0].data, [[0,0],[10,2]]);
    await choose('查看有效波形记录', 'P1');
    await choose('有效信号查看方式', '同测点合并');
    assert.deepEqual((await signalChart('fft')).series[0].data, [[0,0],[5,3],[10,1]]);
    console.log('PASS merged wave/FFT switch together by point, preserve source context, and return to individual-record spectra');
    const output = path.join(root, 'artifacts/blade-merged-signals-ui');
    fs.mkdirSync(output, { recursive: true });
    for (const width of [1280, 480]) {
      win.setContentSize(width, 900);
      await new Promise(resolve => setTimeout(resolve, 150));
      const bounds = await run('({width:innerWidth,scroll:document.documentElement.scrollWidth})');
      assert.ok(bounds.scroll <= bounds.width + 2, JSON.stringify(bounds));
      await run(`document.querySelector('[role=combobox][aria-label="有效信号查看方式"]').closest('section').scrollIntoView({block:'start'})`);
      await new Promise(resolve => setTimeout(resolve, 60));
      fs.writeFileSync(path.join(output, `merged-signals-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    console.log('PASS desktop and mobile layouts have no horizontal overflow');
    finish();
  } catch (error) { finish(error); }
});
