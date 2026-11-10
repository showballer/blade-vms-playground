/** Explicit local import of the generated synthetic batch. Measured sources are untouched. */
import {cp,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {rows,pool,digest,audit,type User} from '../apps/web/lib/db';
import {objects,saveObject,saveMeasurementRow,listMeasurementRows,bindMeasurement,measurementSources} from '../apps/web/lib/measurement-store';
import {rotationDataDirectory} from '../apps/web/lib/rotation';
import {processingEndpoint,processingResult} from '../apps/web/lib/measurement-processing';
import {bladeHealthEndpoint} from '../apps/web/lib/measurement-blade-health';
import {healthObservations} from '../packages/ui/src/blade-health-standard';

const directory=path.resolve('artifacts/R025-crack-scenario-20261110');
const name='化德风场B071-20';
async function main(){try{
 const [user]=await rows<User>("SELECT id,username,name,role,tenant,active FROM users WHERE username='admin' AND active=1 AND deleted_at IS NULL");
 if(!user)throw Error('Existing administrator required');
 const aligned=(await listMeasurementRows(user,'measurement_synthetic_imports')).find(r=>r.ownerId===user.id&&r.name===name&&r.timeAlignment);
 if(aligned){console.log(JSON.stringify({name,context:aligned.context,timeAlignment:aligned.timeAlignment,note:'已完成化德020#时间与工况对齐，保留当前归属；维护请使用 import-huade-wind-and-align.ts'}));return;}
 const apply=process.argv.includes('--apply');
 const manifest=JSON.parse(await readFile(path.join(directory,'数据来源与生成参数.json'),'utf8'));
 const comparison=JSON.parse(await readFile(path.join(directory,'健康包络数值对照.json'),'utf8'));
 const input=JSON.parse(await readFile(path.join(directory,'runtime-input.json'),'utf8'));
 if(manifest.dataOrigin!=='synthetic'||manifest.records.length!==60||comparison.formalHealthAssessment!==false)throw Error('Expected labelled 60-record scenario');
 console.log(JSON.stringify({apply,name,farm:'化德风场',turbine:'R025',origin:'synthetic',records:60},null,2));if(!apply)return;
 let all=await objects(user);
 async function ensure(kind:string,code:string,parentId:string|null,extra:any={}){
  const matches=all.filter(o=>o.kind===kind&&o.code===code&&o.parentId===parentId);
  if(matches.length>1||matches[0]&&!matches[0].active)throw Error('Ambiguous/inactive destination '+code);
  if(matches[0])return matches[0];
  const o=(await saveObject(user,{kind,code,parentId,name:code,...extra}))!;all=await objects(user);return o;
 }
 const farm=await ensure('farm','huade-scenario',null,{name:'化德风场'});
 const turbine=await ensure('turbine','R025',farm.id,{name:'R025',model:'裂纹响应合成情景，非现场测量'});
 const campaign=await ensure('campaign','r025-crack-scenario-20261110',farm.id,{name,turbineIds:[turbine.id],weather:'合成情景数据：R025叶片2为假设裂纹；批次名称为化德风场B071-20，非B071现场实测。未提供同期风况，不作现场健康/损伤结论。'});
 if(campaign.name!==name)throw Error('Destination batch has a different name');
 const context={farmId:farm.id,campaignId:campaign.id,turbineId:turbine.id};
 const target=path.join(rotationDataDirectory(user),'recordings');await mkdir(target,{recursive:true});
 for(const rec of manifest.records){
  const location=path.join(target,rec.recordingId),source=path.join(directory,'analysis-runtime','recordings',rec.recordingId);
  const m=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
  if(m.source!=='simulation'||!m.simulation||m.turbine!=='R025')throw Error('Synthetic provenance missing');
  let exists=false;try{await stat(location);exists=true;}catch(e){if((e as any).code!=='ENOENT')throw e;}
  if(!exists){await cp(source,location,{recursive:true,errorOnExist:true,force:false});m.name=name;m.windFarm=farm.code;m.originalScenarioName=manifest.name;await writeFile(path.join(location,'manifest.json'),JSON.stringify(m));}
  else{const old=JSON.parse(await readFile(path.join(location,'manifest.json'),'utf8'));if(old.source!=='simulation'||old.name!==name||old.simulation.baselineSourceHash!==rec.baselineSourceHash)throw Error('Refusing to overwrite existing record');}
 }
 const registrationId='scenario-'+digest(user.tenant+'|'+user.id+'|'+campaign.id).slice(0,48);
 const registrations=await listMeasurementRows(user,'measurement_synthetic_imports');
 if(!registrations.some(r=>r.id===registrationId))await saveMeasurementRow(user,'measurement_synthetic_imports',{name,ownerId:user.id,context,dataOrigin:'synthetic',recordingIds:manifest.records.map((r:any)=>r.recordingId),referenceStandardName:input.standard.name,referenceVariant:input.standard.variants.find((v:any)=>v.name==='武川风场-R024-1101-第二组'),comparison,createdAt:new Date().toISOString(),sourceManifestSha256:digest(JSON.stringify(manifest))},registrationId);
 const registered=registrations.find(r=>r.id===registrationId);
 if(registered&&!registered.referenceVariant&&registered.ownerId===user.id&&registered.context?.campaignId===campaign.id)await pool().execute("UPDATE records SET body=JSON_SET(body,'$.referenceVariant',CAST(? AS JSON)) WHERE id=? AND tenant=? AND kind='measurement_synthetic_imports'",[JSON.stringify(input.standard.variants.find((v:any)=>v.name==='武川风场-R024-1101-第二组')),registrationId,user.tenant]);
 const contexts:any[]=[];
 for(const blade of ['1','2','3']){
  const b=await ensure('blade',blade,turbine.id,{name:'叶片 '+blade});
  for(const point of ['P1','P2','P3','P4','P5']){
   const radiusM=manifest.records.find((r:any)=>r.blade===blade&&r.point===point).radiusM;
   const p=await ensure('position',point,b.id,{name:point,radiusM});
   const selected=manifest.records.filter((r:any)=>r.blade===blade&&r.point===point);
   for(const r of selected){const reference={kind:'import' as const,id:r.recordingId};const sources=await measurementSources(user,{references:[reference]});const current=sources[0];if(!current)throw Error('Registered source missing');const desired={...context,bladeId:b.id,positionId:p.id};if(Object.entries(desired).some(([k,v])=>(current.context as any)?.[k]!==v))await bindMeasurement(user,{reference,revision:current.bindingRevision,context:desired});}
  }
  contexts.push({...context,bladeId:b.id});
 }
 for(const scope of contexts){
  const c=await processingEndpoint(user,{context:scope,request:{action:'catalog'}}),task=c.tasks[0];
  if(task.recordingIds.length!==20)throw Error('Incomplete synthetic blade');
  const source=input.sources.find((s:any)=>s.blade===all.find(o=>o.id===scope.bladeId)?.code);
  // ensure() refreshes `all`, so this is the destination blade's code.
  const blade=all.find(o=>o.id===scope.bladeId)!.code;
  const sourceSettings=source||input.sources.find((s:any)=>s.blade===blade);
  const start=await processingEndpoint(user,{context:scope,request:{action:'start',taskId:task.id,recordingIds:task.recordingIds,scope:'analysis',profile:'LOS_DIAGNOSTIC',workspace:{purpose:'synthesis',algorithmOptions:sourceSettings.workspace.algorithmOptions}}});
  const deadline=Date.now()+240000;
  for(;;){const status=await processingEndpoint(user,{request:{action:'status',jobId:start.jobId}});if(status.status==='complete')break;if(['failed','cancelled'].includes(status.status))throw Error(status.error||status.status);if(Date.now()>deadline)throw Error('Processing timed out');await new Promise(r=>setTimeout(r,500));}
  await processingEndpoint(user,{request:{action:'publish',jobId:start.jobId}});
  const p=await processingResult(user,start.jobId);const obs=healthObservations(p,blade);
  if(obs.length!==20||obs.some((o:any)=>!o.eligible))throw Error('Quality/coverage verification failed');
  console.log(JSON.stringify({blade,jobId:start.jobId,records:obs.length,origin:'synthetic'}));
 }
 const health=await bladeHealthEndpoint(user,{action:'evaluate',context});
 if(health.blades.length!==3||health.blades.some((b:any)=>!b.syntheticScenario||b.structuralDamageConfirmed||!b.processingResultId))throw Error('Synthetic isolation check failed');
 if(health.blades.some((b:any)=>b.syntheticScenario.comparisons.length!==100))throw Error('Expected 100 current feature comparisons per blade');
 await audit(user,'导入合成裂纹情景批次',campaign.id);
 await writeFile(path.join(directory,'web-import-receipt.json'),JSON.stringify({name,context,blades:health.blades.map((b:any)=>({blade:b.name,processingResultId:b.processingResultId,label:b.label,compared:b.syntheticScenario.comparisons.length,outliers:b.syntheticScenario.comparisons.filter((c:any)=>c.outside).length}))},null,2));
 console.log(JSON.stringify({name,context,blades:health.blades.map((b:any)=>({blade:b.name,label:b.label,records:b.coverage.observed}))},null,2));
}finally{await pool().end();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
