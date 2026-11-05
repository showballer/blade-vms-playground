import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAnalysisDetails } from './analysis-detail-loader';

const records = Array.from({length:20},(_,i)=>({recording_id:`record-${i}`,representative:`segment-${i}`}));

test('Web batches preserve all source selections and publish incremental immutable results',async()=>{
  const requests:any[]=[];const batches:Record<string,any>[]=[];
  await loadAnalysisDetails({records,jobId:'job',web:true,representativeOnly:true,current:()=>true,
    request:async body=>{requests.push(body);return {details:Object.fromEntries(body.selections.map((s:any)=>[s.recordingId,{source:s.segmentId}]))};},
    onBatch:value=>batches.push(value)});
  assert.equal(requests.length,4);
  assert.ok(requests.every(r=>r.action==='details'&&r.jobId==='job'&&r.selections.length===5));
  assert.deepEqual(requests.flatMap(r=>r.selections),records.map(r=>({recordingId:r.recording_id,segmentId:r.representative})));
  assert.deepEqual(batches.map(b=>Object.keys(b).length),[5,10,15,20]);
  assert.deepEqual(batches.at(-1)?.['record-19'],{source:'segment-19'});
});

test('Changing selection during an in-flight read discards stale results and remaining requests',async()=>{
  let current=true,calls=0,published=0;
  await loadAnalysisDetails({records,jobId:'old',web:true,representativeOnly:true,current:()=>current,
    request:async()=>{calls++;current=false;return {details:{old:{}}};},onBatch:()=>published++});
  assert.equal(calls,1);assert.equal(published,0);
});

test('A failed batch reports its own records and does not suppress later batches',async()=>{
  let calls=0;let result:Record<string,any>={};
  await loadAnalysisDetails({records:records.slice(0,7),jobId:'job',web:true,representativeOnly:false,current:()=>true,
    request:async body=>{calls++;assert.ok(body.selections.every((s:any)=>!('segmentId'in s)));if(calls===1)throw Error('read failed');return {details:Object.fromEntries(body.selections.map((s:any)=>[s.recordingId,{ok:true}]))};},
    onBatch:value=>result=value});
  assert.equal(calls,2);assert.equal(result['record-0'].message,'read failed');assert.equal(result['record-6'].ok,true);
});

test('Desktop retains the existing single-record bridge protocol',async()=>{
  const requests:any[]=[];let result:Record<string,any>={};
  await loadAnalysisDetails({records:records.slice(0,2),jobId:'desktop',web:false,representativeOnly:true,current:()=>true,
    request:async body=>{requests.push(body);return {detail:{id:body.recordingId}};},onBatch:value=>result=value});
  assert.deepEqual(requests,records.slice(0,2).map(r=>({action:'result',jobId:'desktop',recordingId:r.recording_id,segmentId:r.representative})));
  assert.equal(Object.keys(result).length,2);
});
