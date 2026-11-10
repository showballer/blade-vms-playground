/** Local, reversible maintenance: real minute SCADA + explicitly synthetic response batch. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {rows,pool,digest,audit,type User} from '../apps/web/lib/db';
import {objects,saveObject,listMeasurementRows,replaceMeasurementRow,measurementSources,bindMeasurement,windDatasetSummaries} from '../apps/web/lib/measurement-store';
import {measurementEndpoint} from '../apps/web/lib/measurement-api';
import {rotationDataDirectory} from '../apps/web/lib/rotation';
import {processingEndpoint,processingResult} from '../apps/web/lib/measurement-processing';
import {bladeHealthEndpoint} from '../apps/web/lib/measurement-blade-health';
import {saveHealthWindSelection} from '../apps/web/lib/measurement-health-wind';
import {healthObservations} from '../packages/ui/src/blade-health-standard';

const name='化德风场B071-20', windName='化德风场_020#_2026-10-18（分钟工况）';
const windFilename='化德风场_020#_20261018_20261018_minute.csv';
const output=path.resolve('artifacts/化德风场B071-20_20261018');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function body(r:any){const {id,ownerId,recordTenant,updatedAt,revision,...b}=r;return b;}
async function main(){try{
 const file=process.argv.find(v=>v.startsWith('--source='))?.slice(9);assert(file,'Pass --source=CSV');
 const apply=process.argv.includes('--apply'),bytes=await readFile(file),sourceHash=sha(bytes);
 const lines=new TextDecoder('gb18030').decode(bytes).trim().split(/\r?\n/),header=lines.shift()!;
 assert.equal(header,'名称,时间,风速,发电机有功功率,主轴转速,舱外温度,风向');assert.equal(lines.length,1440);
 const expected=lines.map(line=>{const [code,time,w,p,r,t,d]=line.split(',');assert.equal(code,'020#');return {turbineCode:code,time:new Date(time.replace(' ','T')+'+08:00').toISOString(),windSpeed:+w,powerKw:+p,rpm:+r,temperatureC:+t,windDirection:+d};});
 assert.equal(expected[0].time,'2026-10-17T16:00:00.000Z');assert.equal(expected.at(-1)!.time,'2026-10-18T15:59:00.000Z');
 const [user]=await rows<User>("SELECT id,username,name,role,tenant,active FROM users WHERE username='admin' AND active=1 AND deleted_at IS NULL");assert(user);
 let all=await objects(user);
 const campaign=all.find(o=>o.active&&o.kind==='campaign'&&o.name===name)!;assert(campaign);
 const farm=all.find(o=>o.id===campaign.parentId)!;
 let registry=(await listMeasurementRows(user,'measurement_synthetic_imports')).find(r=>r.context?.campaignId===campaign.id&&r.ownerId===user.id)!;assert(registry);
 const original=JSON.parse(await readFile('artifacts/R025-crack-scenario-20261110/数据来源与生成参数.json','utf8'));
 const originalRecordingIds=original.records.map((r:any)=>r.recordingId);
 const duplicateIds=['002c56a1-d69c-4141-a16b-5877a7b5739a','ec5d242f-6f3a-4689-bc5e-25b89fa1b36b'];
 console.log(JSON.stringify({apply,name,windName,windFilename,rows:1440,sourceHash,shiftDate:'2026-10-18',archiveOldDatasets:duplicateIds},null,2));if(!apply)return;
 await mkdir(output,{recursive:true});
 // Preserve source byte-for-byte under a consistent upload name; source file stays untouched.
 await writeFile(path.join(output,windFilename),bytes);
 const backup=path.join(output,'导入前数据库快照.json');
 try{await stat(backup);}catch(e){if((e as any).code!=='ENOENT')throw e;await writeFile(backup,JSON.stringify(await rows("SELECT id,kind,tenant,body,created_by FROM records WHERE tenant=? AND kind IN ('measurement_objects','wind_datasets','measurement_synthetic_imports','health_wind_bindings')",[user.tenant]),null,2));}
 const plan={recordings:path.join(rotationDataDirectory(user),'recordings'),output,name,farmCode:farm.code,sourceWindSha256:sourceHash,originalRecordingIds};
 const planFile=path.join(output,'local-alignment-plan.json');await writeFile(planFile,JSON.stringify(plan));
 const derivedResult=execFileSync('python3',['scripts/align-huade-scenario.py',planFile],{encoding:'utf8'});console.log(derivedResult.trim());
 const derived=JSON.parse(await readFile(path.join(output,'时间对齐与来源.json'),'utf8'));assert.equal(derived.records.length,60);
 async function ensure(kind:string,code:string,parentId:string|null,extra:any={}){
  const found=all.filter(o=>o.kind===kind&&o.code===code&&o.parentId===parentId);assert(found.length<=1);if(found[0]){assert(found[0].active);return found[0];}
  const obj=(await saveObject(user,{kind,code,name:code,parentId,...extra}))!;all=await objects(user);return obj;
 }
 const turbine=await ensure('turbine','020#',farm.id,{name:'20号风机（020#）',model:'实测分钟工况关联对象；本批叶片响应为合成情景'});
 const note='合成情景数据：叶片2为假设裂纹；波形日期平移至2026-10-18，与化德20号风机（020#）实测分钟工况作情景关联，不是现场同期叶片测量，不作正式健康/损伤结论。';
 const currentCampaign=(await objects(user)).find(o=>o.id===campaign.id)!;
 if(JSON.stringify(currentCampaign.turbineIds)!==JSON.stringify([turbine.id])||currentCampaign.weather!==note)await saveObject(user,{...currentCampaign,turbineIds:[turbine.id],date:'2026-10-18',weather:note});
 const context={farmId:farm.id,campaignId:campaign.id,turbineId:turbine.id};
 const registeredBody={...body(registry),context,recordingIds:derived.records.map((r:any)=>r.recordingId),originalRecordingIds,timeAlignment:{date:'2026-10-18',sourceWindSha256:sourceHash,waveformPayloadUnchanged:true,clock:'constructed_not_measured'},originalScenarioTurbine:'R025',associatedWindTurbine:'020#'};
 if(JSON.stringify(body(registry))!==JSON.stringify(registeredBody))await replaceMeasurementRow(user,'measurement_synthetic_imports',registry.id,registeredBody,digest(JSON.stringify(registry)),'更新合成情景时间与工况归属');
 const contexts:any[]=[];
 for(const code of ['1','2','3']){
  const b=await ensure('blade',code,turbine.id,{name:'叶片 '+code});
  for(const point of ['P1','P2','P3','P4','P5']){
   const recs=derived.records.filter((r:any)=>r.blade===code&&r.point===point);assert.equal(recs.length,4);
   const p=await ensure('position',point,b.id,{radiusM:recs[0].radiusM});
   for(const rec of recs){const reference={kind:'import' as const,id:rec.recordingId};const [s]=await measurementSources(user,{references:[reference]});assert(s);const desired={...context,bladeId:b.id,positionId:p.id};if(Object.entries(desired).some(([k,v])=>(s.context as any)?.[k]!==v))await bindMeasurement(user,{reference,revision:s.bindingRevision,context:desired});}
  }
  contexts.push({...context,bladeId:b.id});
 }
 const existing=(await listMeasurementRows(user,'wind_datasets')).filter(d=>d.farmId===farm.id&&d.sources?.some((s:any)=>s.sha256===sourceHash));assert(existing.length<=1);
 let dataset=existing[0];
 if(!dataset){
  const preview:any=await measurementEndpoint(user,new Request('http://127.0.0.1:3210/api/v1/wind-datasets/preview-file?filename='+encodeURIComponent(windFilename),{method:'POST',body:new Uint8Array(bytes)}),['wind-datasets','preview-file']);
  assert.equal(preview.rowCount,1440);assert.equal(preview.sha256,sourceHash);assert.equal(preview.sourceFormat,'turbine-minute-v1');
  const imported:any=await measurementEndpoint(user,new Request('http://127.0.0.1:3210/api/v1/wind-datasets/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:windName,farmId:farm.id,timezoneOffset:'+08:00',units:preview.suggestedUnits,files:[{token:preview.token,mapping:preview.suggestedMapping}],timeSemantics:{timeBasis:'interval_mean',intervalSeconds:60,timestampPosition:'start',rpmMeaning:'rotor',maxGapMs:0,clockOffsetMs:0,basis:'按minute文件及60秒等间隔暂解释为分钟区间均值、起点时间；统计口径待提供方确认。主轴转速按列名识别。源时标和所有数值不改，仅将合成波形日期对齐用于情景工况展示。'}})}),['wind-datasets','import']);
  dataset=(await listMeasurementRows(user,'wind_datasets')).find(d=>d.id===imported.id)!;
 }
 assert.deepEqual(dataset.rows,expected);assert.equal(dataset.rows.length,1440);
 await saveHealthWindSelection(user,context,dataset.id);
 const input=JSON.parse(await readFile('artifacts/R025-crack-scenario-20261110/runtime-input.json','utf8'));
 for(const scope of contexts){
  const code=(await objects(user)).find(o=>o.id===scope.bladeId)!.code;
  const c=await processingEndpoint(user,{context:scope,request:{action:'catalog'}}),task=c.tasks[0];assert.equal(task.recordingIds.length,20);
  const start=await processingEndpoint(user,{context:scope,request:{action:'start',taskId:task.id,recordingIds:task.recordingIds,scope:'analysis',profile:'LOS_DIAGNOSTIC',workspace:{purpose:'synthesis',algorithmOptions:input.sources.find((s:any)=>s.blade===code).workspace.algorithmOptions}}});
  const deadline=Date.now()+240000;
  for(;;){const s=await processingEndpoint(user,{request:{action:'status',jobId:start.jobId}});if(s.status==='complete')break;assert(!['failed','cancelled'].includes(s.status),s.error);assert(Date.now()<deadline,'Processing timeout');await new Promise(r=>setTimeout(r,500));}
  await processingEndpoint(user,{request:{action:'publish',jobId:start.jobId}});
  const processed=await processingResult(user,start.jobId),obs=healthObservations(processed,code);assert.equal(obs.length,20);assert(obs.every((o:any)=>o.eligible));console.log(JSON.stringify({blade:code,jobId:start.jobId,records:20}));
 }
 const health=await bladeHealthEndpoint(user,{action:'evaluate',context});assert.equal(health.blades.length,3);
 for(const b of health.blades){assert(b.syntheticScenario&&!b.structuralDamageConfirmed&&!b.finalDecision);assert.equal(b.syntheticScenario.comparisons.length,100);assert.equal(b.conditions.length,20);assert(b.conditions.every((c:any)=>c.condition.status==='matched'&&c.condition.datasetIds.includes(dataset.id)));}
 // Archive obsolete R025 display objects from this scenario, retaining IDs/history.
 const oldTurbine=all.find(o=>o.kind==='turbine'&&o.code==='R025'&&o.parentId===farm.id);
 if(oldTurbine?.active){const blades=all.filter(o=>o.parentId===oldTurbine.id),ids=new Set(blades.map(o=>o.id));const descendants=all.filter(o=>ids.has(o.parentId||''));for(const o of [...descendants,...blades,oldTurbine]){const fresh=(await objects(user)).find(v=>v.id===o.id)!;if(fresh.active)await saveObject(user,{...fresh,active:false});}}
 // Reversible archive: retain complete dataset bodies; remove only duplicate historical imports from active lists.
 for(const id of duplicateIds){const [d]=await rows<any>("SELECT id,body FROM records WHERE id=? AND tenant=? AND kind='wind_datasets'",[id,user.tenant]);if(!d)continue;const old=typeof d.body==='string'?JSON.parse(d.body):d.body;assert((await objects(user)).some(o=>o.kind==='farm'&&o.id===old.farmId&&!o.active));await pool().execute("UPDATE records SET kind='wind_datasets_archive',body=JSON_SET(body,'$.archivedAt',?,'$.archiveReason',?) WHERE id=? AND tenant=? AND kind='wind_datasets'",[new Date().toISOString(),'历史重复导入；当前仅保留武川与化德两份风场数据集，完整原记录保留',id,user.tenant]);await audit(user,'归档历史重复风场数据集',id);}
 const datasets=await windDatasetSummaries(user),active=(await objects(user)).filter(o=>o.active),campaigns=active.filter(o=>o.kind==='campaign');assert.equal(datasets.length,2);assert.equal(active.filter(o=>o.kind==='farm').length,2);assert.equal(campaigns.length,3);assert.equal(campaigns.filter(o=>o.parentId===farm.id).length,1);
 assert.equal(sha(await readFile(file)),sourceHash);
 const receipt={name,context,windDatasetId:dataset.id,windName,windFilename,windRows:1440,originalWindSha256:sourceHash,sourceUnchanged:true,timeAlignment:registeredBody.timeAlignment,activeDatasets:datasets.map(d=>({id:d.id,name:d.name,farmId:d.farmId})),campaigns:campaigns.map(c=>({name:c.name,farmId:c.parentId})),archivedDatasetIds:duplicateIds,blades:health.blades.map((b:any)=>({blade:b.name,label:b.label,processingResultId:b.processingResultId,matched:b.conditions.filter((c:any)=>c.condition.status==='matched').length,compared:b.syntheticScenario.comparisons.length,outliers:b.syntheticScenario.comparisons.filter((c:any)=>c.outside).length}))};
 await writeFile(path.join(output,'web-import-receipt.json'),JSON.stringify(receipt,null,2));await audit(user,'化德分钟工况导入与合成日期对齐完成',JSON.stringify(context));console.log(JSON.stringify(receipt,null,2));
}finally{await pool().end();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
