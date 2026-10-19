'use strict';
// Review-only in-memory fixtures. Never imported by production code.
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/web-blade-passes-review');
function buildReview() {
  fs.mkdirSync(output, { recursive: true });
  const ui = path.join(root, 'packages/ui/src');
  const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import * as echarts from 'echarts/core';
import {WebBladePasses} from ${JSON.stringify(path.join(ui, 'web-blade-passes.tsx'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'web-rotation.css'))};
import ${JSON.stringify(path.join(ui, 'web-blade-passes.css'))};
const first='a'.repeat(32),second='c'.repeat(32);
function record(id,point,angle,collection=first){return {id,name:collection===first?'叶片2 · 径向巡测':'叶片3 · 独立任务',samples:1000,sampleRate:1000,startedAt:1792400000,status:'complete',source:'polytec_ivs500',pointCycle:{mode:'automatic_stations',collectionId:collection,sessionId:point.padEnd(32,'0'),bladeId:collection===first?'2':'3',radialPointId:point,radialPointName:point==='P1'?'P1 · 叶中':'P2 · 叶尖',radiusM:point==='P1'?.31:.5,azimuthDeg:angle,stationIndex:angle/90+1,stationCount:4,lapIndex:1,completion:'confirmed_pass'}};}
const records=[record('a-p1-0','P1',0),record('a-p1-90','P1',90),record('a-p2-0','P2',0),record('a-p2-90','P2',90),record('b-p1-0','P1',0,second),record('missing-exit','P2',180),record('old-record','P1',0)];
records[5].pointCycle.completion='missing_exit';delete records[6].pointCycle.collectionId;
function response(ids,parameters){
 const selected=records.filter(record=>ids.includes(record.id)),metadata=selected[0].pointCycle;
 const sources=selected.map(record=>{const m=record.pointCycle,multiplier=(m.radialPointId==='P1'?1:2)*(m.azimuthDeg===90?3:1),metrics={rmsVelocityMps:.002*multiplier,peakVelocityMps:.003*multiplier,peakToPeakVelocityMps:.006*multiplier};
 const segments=[0,1].map(index=>{const start=index?500:100,samples=128;return {start,end:start+samples,samples,durationSeconds:.128,metrics,timeDomain:{sampleIndices:Array.from({length:samples},(_,i)=>start+i),seconds:Array.from({length:samples},(_,i)=>(start+i)/1000),values:Array.from({length:samples},(_,i)=>.003*multiplier*Math.sin(i/8))},spectrum:{frequencies:[0,7.8125,15.625],amplitudes:[0,.002*multiplier*(index+1),.0001],frequencySpacingHz:7.8125}};});
 const excluded=record.id==='missing-exit';return {recordingId:record.id,name:record.name,sessionId:m.sessionId,radialPointId:m.radialPointId,radialPointName:m.radialPointName,radiusM:m.radiusM,azimuthDeg:m.azimuthDeg,sampleRate:1000,sampleOrigin:2000,status:excluded?'excluded':'included',...(excluded?{reason:'missing_exit'}:{}),candidateRange:excluded?null:{start:100,end:628},validRanges:excluded?[]:segments.map(({start,end,samples})=>({start,end,samples})),exclusions:excluded?[]:[{reason:'outside_confirmed_pass',samples:472},{reason:'low_rssi',samples:272}],metrics:excluded?null:metrics,segments:excluded?[]:segments,provenance:{entry:{sampleIndex:100},leave:{sampleIndex:628},originalSampleOrigin:2000}};});
 const included=sources.filter(source=>source.status==='included');
 return {algorithmVersion:'isolated-review-only',parameters,collectionId:metadata.collectionId,bladeId:metadata.bladeId,phaseAvailable:false,modeShapeUnavailableReason:'分次采集没有共同相位基准。',coverage:{selectedRecords:sources.length,includedRecords:included.length,excludedRecords:sources.length-included.length,rawSamples:sources.length*1000,validSamples:included.length*256,validSeconds:included.length*.256,segmentCount:included.length*2},sources,points:[],amplitudeDistributions:[...new Set(included.map(source=>source.azimuthDeg))].sort((a,b)=>a-b).map(azimuthDeg=>({azimuthDeg,metric:'rmsVelocityMps',unit:'m/s',points:included.filter(source=>source.azimuthDeg===azimuthDeg).map(source=>({radialPointId:source.radialPointId,radialPointName:source.radialPointName,radiusM:source.radiusM,value:source.metrics.rmsVelocityMps,validSamples:256,recordingIds:[source.recordingId]}))})),warnings:['叶片身份来自人工指定。','未观测时间保留为空缺，不作为连续整圈测量。']};
}
window.__bladePassFixture={requests:[],errors:[],hold:false,resolvers:[],noHardware:true};
window.__bladePassFixture.chartOptions=()=>[...document.querySelectorAll('[role=img]')].map(element=>({label:element.getAttribute('aria-label'),option:echarts.getInstanceByDom(element)?.getOption()}));
window.fetch=async(url,options={})=>{
 const item={url:String(url),method:options.method||'GET',body:options.body?JSON.parse(options.body):null};window.__bladePassFixture.requests.push(item);
 if(item.url==='/api/v1/rotation/recordings')return {ok:true,json:async()=>({recordings:structuredClone(records)})};
 if(item.url==='/api/v1/rotation/blade-passes'&&item.method==='POST'){
  const value=response(item.body.recordingIds,item.body);
  if(window.__bladePassFixture.hold)await new Promise(resolve=>window.__bladePassFixture.resolvers.push(resolve));
  return {ok:true,json:async()=>value};
 }
 throw Error('Blocked non-fixture request: '+item.url);
};
function App(){const [canAnalyze,setCanAnalyze]=useState(true),[refreshKey,setRefreshKey]=useState(0),[preferredIds,setPreferredIds]=useState([]);
 window.__bladePassFixture.setCanAnalyze=setCanAnalyze;window.__bladePassFixture.refresh=()=>setRefreshKey(key=>key+1);window.__bladePassFixture.prefer=setPreferredIds;
 return <main className="web-rotation-workspace" style={{maxWidth:1600,margin:'0 auto',padding:20}}><header className="rotation-page-heading"><div><h1>旋转测振</h1><p>隔离界面验收 · 内存样例 · 不连接设备</p></div></header><WebBladePasses canAnalyze={canAnalyze} refreshKey={refreshKey} preferredIds={preferredIds} onError={cause=>window.__bladePassFixture.errors.push(cause.message)}/></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
  buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BladeVMS 有效片段隔离验收</title><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(output, 'fixture-evidence.json'), JSON.stringify({ hardwareUsed: false, networkUsed: false, requests: 'in-memory fixture only', purpose: 'isolated renderer acceptance; not physical acceptance' }, null, 2));
  return output;
}
module.exports = { buildReview, output };
if (require.main === module) console.log(buildReview());
