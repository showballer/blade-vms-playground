import {isDeepStrictEqual} from "node:util";
import { digest,HttpError,pool,rows,unpack,type User,type RecordItem } from './db';
import { measurementSources,objects,prepareSource,sourceBindings,saveMeasurementRow,requireAnalyst,filterMeasurementAccess } from './measurement-store';
import { rotationWorker,rotationDataDirectory } from './rotation';
import { realpath,stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
const globalJobs=globalThis as typeof globalThis & {bladeProcessingJobs?:Map<string,{cancelled:boolean}>;bladeProcessingQueue?:Map<string,Promise<unknown>>};
const running=globalJobs.bladeProcessingJobs??=new Map();
const queues=globalJobs.bladeProcessingQueue??=new Map();
function worker(user:Pick<User,'id'|'tenant'>,operation:string,parameters:any={}) {
  const key=JSON.stringify([user.tenant,user.id]);
  const pending=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(()=>rotationWorker(user,{action:'signal-workspace',operation,parameters}));
  queues.set(key,pending);void pending.finally(()=>{if(queues.get(key)===pending)queues.delete(key);}).catch(()=>{});
  return pending;
}
const pcOf=(s:any)=>s.raw.pointCycle||s.raw.sourceMetadata?.pointCycle||{};
const wid=(s:any)=>s.reference.kind==='capture'?digest('cloud-capture:'+s.reference.id).slice(0,32):s.reference.id;
const labels=(v:unknown)=>String(v??'').replace(/^叶片\s*/,'').trim();
async function selection(user:User,context:any) {
  if(!context?.farmId||!context?.campaignId||!context?.turbineId)return null;
  const [all,sources]=await Promise.all([objects(user),measurementSources(user,{context})]);
  const farm=all.find(o=>o.id===context.farmId&&o.kind==='farm'),turbine=all.find(o=>o.id===context.turbineId&&o.kind==='turbine'),campaign=all.find(o=>o.id===context.campaignId&&o.kind==='campaign');
  if(!farm||!turbine||!campaign||turbine.parentId!==farm.id||campaign.parentId!==farm.id||campaign.turbineIds?.length&&!campaign.turbineIds.includes(turbine.id))throw new HttpError(400,'请选择同一风场、批次与风机');
  const chosen=sources.filter(s=>s.context&&s.bindingRevision&&s.reference.kind!=='task'&&Object.entries(context).every(([k,v])=>!v||s.context?.[k as keyof typeof s.context]===v));
  if(chosen.length>64)throw new HttpError(400,'单次处理最多64条来源，请缩小叶片范围');
  const keys=new Set<string>(),unique=chosen.filter(s=>{const k=s.raw.sourceRecordingId||s.raw.sourceLocalId||s.raw.sourceSha256||s.key;if(keys.has(k))return false;keys.add(k);return true;});
  const groups=[...new Set(unique.map(s=>JSON.stringify([pcOf(s).collectionId||s.key,pcOf(s).bladeId,s.raw.windFarm||s.raw.sourceMetadata?.windFarm,s.raw.turbine||s.raw.sourceMetadata?.turbine])))];
  const bindings:Record<string,any>={};
  for(const s of unique){
    const pc=pcOf(s),blade=all.find(o=>o.id===s.context!.bladeId),point=all.find(o=>o.id===s.context!.positionId);
    if(!blade||!point||point.parentId!==blade.id||blade.parentId!==turbine.id)throw new HttpError(400,'叶片或测点归属无效');
    const rawFarm=s.raw.windFarm||s.raw.sourceMetadata?.windFarm,rawTurbine=s.raw.turbine||s.raw.sourceMetadata?.turbine;
    if(rawFarm&&labels(rawFarm)!==labels(farm.code)||rawTurbine&&labels(rawTurbine)!==labels(turbine.code)||pc.bladeId&&labels(pc.bladeId)!==labels(blade.code))throw new HttpError(409,'来源属于不同实体风机或叶片，不能组合；请核对原始身份与对象关联');
    if(typeof pc.radiusM==='number'&&typeof point.radiusM==='number'&&Math.abs(pc.radiusM-point.radiusM)>1e-6)throw new HttpError(409,`测点${point.code}半径与原始快照不一致，须明确校正关联`);
    bindings[wid(s)]={windFarm:farm.code,turbine:turbine.code,bladeId:blade.code,pointName:point.code,sourceKey:s.key,bindingRevision:s.bindingRevision,sourceTask:pc.collectionId||null,sourceRecordingId:s.raw.sourceRecordingId||s.reference.id};
  }
  const taskId=digest(JSON.stringify([context.farmId,context.campaignId,context.turbineId,context.bladeId||''])).slice(0,32);
  const task={id:taskId,name:campaign.name,windFarm:farm.code,turbine:turbine.code,recordingIds:unique.map(wid),plannedPoints:unique.flatMap(s=>pcOf(s).plannedStations||[]),records:unique.map(s=>({id:wid(s),bladeId:bindings[wid(s)].bladeId,pointName:bindings[wid(s)].pointName,radiusM:pcOf(s).radiusM??null,azimuthDeg:pcOf(s).azimuthDeg??null,createdAt:s.measuredAt,context:s.context,sourceKey:s.key,reference:s.reference,sourceQuality:{diagnostic_only:s.raw.diagnosticOnly,valid_measurement:s.raw.validMeasurement,identity_verified:pcOf(s).identityVerified},measurementInputs:{horizontal_distance_m:(s.raw.turntable||s.raw.sourceMetadata?.turntable)?.config?.geometry?.distanceM??null,hub_height_delta_m:(s.raw.turntable||s.raw.sourceMetadata?.turntable)?.config?.geometry?.hubHeightDeltaM??null,radius_from_hub_m:pcOf(s).radiusM??null,azimuth_deg:pcOf(s).azimuthDeg??null,blade_length_m:pcOf(s).bladeLengthM??null}}))};
  return {all,chosen:unique,task,bindings,groups,context:{...context}};
}
async function stored(user:User,id:string){
  if(typeof id!=='string'||id.length>100)throw new HttpError(400,'处理结果编号无效');
  const found=await rows<RecordItem>("SELECT * FROM records WHERE id=? AND kind='measurement_processing' AND tenant=?",[id,user.tenant]);
  if(!found.length)throw new HttpError(404,'处理结果不存在');
  const value=unpack(found[0]);if(!(await filterMeasurementAccess(user,[value])).length)throw new HttpError(403,'无权查看处理来源');return value;
}
async function update(user:User,id:string,body:any){await pool().execute("UPDATE records SET body=? WHERE id=? AND kind='measurement_processing' AND tenant=?",[JSON.stringify(body),id,user.tenant]);}
export async function processingSummaries(user:User,context:any={}){
 const found=await rows<RecordItem>("SELECT r.id,r.kind,r.tenant,JSON_REMOVE(r.body,'$.report') AS body,r.created_by,r.updated_at,recent.created_at AS sort_created_at FROM (SELECT id,created_at FROM records WHERE kind='measurement_processing' AND tenant=? ORDER BY created_at DESC,id DESC LIMIT 500) AS recent INNER JOIN records r ON r.id=recent.id",[user.tenant]);
 return (await filterMeasurementAccess(user,found.sort((a:any,b:any)=>new Date(b.sort_created_at).getTime()-new Date(a.sort_created_at).getTime()).map(unpack))).filter(r=>Object.entries(context).every(([k,v])=>!v||r.context?.[k]===v));
}
export async function processingResult(user:User,id:string){return stored(user,id);}
export async function processingEndpoint(user:User,b:any){
 const command=b.request||{},action=command.action;
 if(action==='capabilities')return worker(user,'capabilities');
 if(action==='history')return {results:await processingSummaries(user,b.context)};
 if(action==='catalog'||action==='start'){
  const s=await selection(user,b.context);if(!s)return {tasks:[],revision:'empty'};
  const revision=digest(JSON.stringify(s.chosen.map(x=>[x.key,x.bindingRevision,digest(JSON.stringify(x.raw)),x.raw.samples,x.raw.sampleRate])));
  if(action==='catalog')return {tasks:s.chosen.length?[s.task]:[],revision,composition:{required:s.groups.length>1,groups:s.groups,mode:b.compositionMode||null},algorithmVersion:'desktop-record-analysis-1.1.0'};
  if(command.taskId!==s.task.id||!Array.isArray(command.recordingIds)||command.recordingIds.length!==s.task.recordingIds.length||command.recordingIds.some((id:string)=>!s.task.recordingIds.includes(id)))throw new HttpError(400,'来源选择已变化，请刷新');
  if(s.groups.length>1&&!['diagnostic_group','confirmed_same_blade'].includes(b.compositionMode))throw new HttpError(409,'需明确建立跨任务业务诊断展示组，或提供同一实体核验依据');
  if(b.compositionMode==='confirmed_same_blade'&&!s.chosen.every(x=>pcOf(x).identityVerified===true))throw new HttpError(409,'来源实体身份尚未核验，只能建立诊断展示组');
  if(s.groups.length>1&&!(typeof b.compositionReason==='string'&&b.compositionReason.trim()))throw new HttpError(400,'请填写跨任务组合依据或诊断分组理由');
  if(!['analysis','diagnostic'].includes(command.scope)||!['LOS_DIAGNOSTIC','RAW_REVIEW'].includes(command.profile))throw new HttpError(400,'处理集合或方案无效');
  if(command.reviewWindows)throw new HttpError(400,'Web复核请使用独立复核记录，不修改来源窗口');
  const key=digest(JSON.stringify(['web-signal-v2.1',revision,command.scope,command.profile,command.config||{},b.compositionMode||null,b.compositionReason||null]));
  const prior=(await processingSummaries(user,b.context)).find(r=>r.inputKey===key&&r.status==='complete');
  if(prior){const saved=await stored(user,prior.id),current=await worker(saved.workerAccount,'fingerprints',{recordingIds:s.task.recordingIds});if(isDeepStrictEqual(current.sources,saved.report.sourceFingerprints))return {jobId:prior.id,status:'complete',total:prior.total,completed:prior.total,cacheHit:true};}
  requireAnalyst(user);
  const body:any={name:s.task.name,context:s.context,sourceKeys:s.chosen.map(x=>x.key),references:s.chosen.map(x=>x.reference),bindingRevisions:s.chosen.map(x=>[x.key,x.bindingRevision]),inputKey:key,status:'queued',total:s.chosen.length,completed:0,createdAt:new Date().toISOString(),task:s.task,workerAccount:{id:user.id,tenant:user.tenant},composition:{mode:b.compositionMode||'same_source_task',reason:b.compositionReason||null,actor:user.id,at:new Date().toISOString(),sourceTasks:s.groups},scope:command.scope,profile:command.profile};
  const job=await saveMeasurementRow(user,'measurement_processing',body),state={cancelled:false};running.set(job.id,state);
  void (async()=>{try{
   await update(user,job.id,{...body,status:'running'});
   for(const source of s.chosen){const id=await prepareSource(user,source);if(id!==wid(source))throw new HttpError(409,'来源编号映射变化，请重新计算');}
   for(const binding of Object.values(s.bindings))binding.compositionMode=body.composition.mode;
   const result=await worker(user,'process',{recordingIds:s.task.recordingIds,bindings:s.bindings,task:s.task,scope:command.scope,profile:command.profile,config:command.config||{}});
   const current=await sourceBindings(user,s.chosen.map(x=>x.key));
   if(s.chosen.some(source=>!current.some(link=>link.key===source.key&&digest(JSON.stringify(link))===source.bindingRevision)))throw new Error('处理期间来源归属已变化，结果未发布');
   if(!state.cancelled)await update(user,job.id,{...body,status:'complete',completed:body.total,workerJobId:result.jobId,algorithmVersion:result.algorithmVersion,finishedAt:new Date().toISOString(),report:result});
  }catch(e){if(!state.cancelled)await update(user,job.id,{...body,status:'failed',error:(e as Error).message});}finally{running.delete(job.id);}})();
  return {jobId:job.id,status:'queued',completed:0,total:body.total};
 }
 const value=await stored(user,command.jobId);
 if(action==='status')return {jobId:value.id,status:['queued','running'].includes(value.status)&&!running.has(value.id)?'failed':value.status,error:['queued','running'].includes(value.status)&&!running.has(value.id)?'服务已重新启动，请重试处理':value.error,completed:value.completed,total:value.total};
 if(action==='cancel'){requireAnalyst(user);const task=running.get(value.id);if(task)task.cancelled=true;await update(user,value.id,{...value,status:'cancelled'});return {status:'cancelled',backgroundMayContinue:true};}
 if(value.status!=='complete')throw new HttpError(409,'处理尚未完成');
 const owner=value.workerAccount;
 if(action==='snapshot')return {result:{...value,workerAccount:undefined,report:value.report}};
 if(action==='result')return command.recordingId?worker(owner,'result',{jobId:value.workerJobId,recordingId:command.recordingId,segmentId:command.segmentId}):{...value.report,jobId:value.id,processingResultId:value.id};
 if(action==='export'){
  const output=await worker(owner,'export',{jobId:value.workerJobId,kind:command.kind,previewId:command.previewId});
  const base=await realpath(path.join(rotationDataDirectory(owner),'record-analysis-v1',value.workerJobId,'exports')),file=await realpath(output.path);
  if(path.dirname(file)!==base||path.basename(file)!==output.fileName||!(await stat(file)).isFile())throw new HttpError(400,'导出文件无效');
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream,{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename=analysis.zip; filename*=UTF-8''${encodeURIComponent(output.fileName)}`,'Cache-Control':'no-store'}});
 }
 if(action==='waveforms')return worker(owner,'waveforms',{jobId:value.workerJobId});
 if(action==='extended'||action==='preview')return worker(owner,action,{...command,action:undefined,jobId:value.workerJobId});
 throw new HttpError(400,'不支持的Web处理动作');
}
