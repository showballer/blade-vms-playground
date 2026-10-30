import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {mkdir,open,stat,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {digest,HttpError,type User} from './db';
import {measurementSources,saveMeasurementRow,requireAnalyst,prepareSource} from './measurement-store';
import {processingSummaries} from './measurement-processing';
import {rotationDataDirectory,rotationWorker} from './rotation';
const hex=/^[0-9a-f]{64}$/;const id=/^[0-9a-f]{32}$/;const limit=256*1024*1024;
const state=globalThis as typeof globalThis & {packageLocksV22?:Set<string>};const locks=state.packageLocksV22??=new Set();
async function dependencies(user:User,ids:string[]){
 const sources=await measurementSources(user,{});const matches=ids.map(r=>sources.find(s=>s.reference.kind!=='task'&&[s.raw.sourceRecordingId,s.raw.sourceLocalId,s.raw.sourceMetadata?.id,s.reference.id].includes(r)&&s.context&&s.bindingRevision));
 if(matches.some(s=>!s))throw new HttpError(409,'waiting_dependencies：请先上传并关联所有源记录，再重试处理结果上传');
 const contexts=matches.map(s=>s!.context!),scope=contexts[0];if(!scope?.farmId||!scope.turbineId||!scope.campaignId||contexts.some(c=>['farmId','turbineId','campaignId','bladeId'].some(k=>(c as any)[k]!== (scope as any)[k])))throw new HttpError(409,'包的依赖没有关联到同一风场、批次、风机与叶片');
 return {sources:matches.map(s=>s!),context:scope};
}
export async function analysisPackageEndpoint(user:User,req:Request){
 requireAnalyst(user);const u=new URL(req.url),operation=u.searchParams.get('operation')||'init';const hash=u.searchParams.get('sha256')||'';if(!hex.test(hash))throw new HttpError(400,'结果包 SHA-256 无效');
 const base=path.join(rotationDataDirectory(user),'analysis-package-uploads');await mkdir(base,{recursive:true,mode:0o700});const key=digest([user.tenant,user.id,hash].join(':'));if(locks.has(key))throw new HttpError(409,'同一结果包正在处理');locks.add(key);
 try{
  const metaPath=path.join(base,hash+'.json'),file=path.join(base,hash.slice(0,32)+'.zip');
  if(operation==='init'){
   const reader=req.body?.getReader();if(!reader)throw new HttpError(400,'缺少结果包清单');const pieces:Uint8Array[]=[];let size=0;for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>64000){await reader.cancel();throw new HttpError(413,'清单超过64KB');}pieces.push(r.value);}const body=JSON.parse(Buffer.concat(pieces).toString());if(!Number.isSafeInteger(body.bytes)||body.bytes<1||body.bytes>limit||!Array.isArray(body.recordingIds)||!body.recordingIds.length||body.recordingIds.length>200||body.recordingIds.some((v:any)=>!id.test(v)))throw new HttpError(400,'结果包大小或依赖清单无效');
   await dependencies(user,body.recordingIds);let old:any;try{old=JSON.parse(await readFile(metaPath,'utf8'));}catch{}
   if(old&&(old.bytes!==body.bytes||JSON.stringify(old.recordingIds)!==JSON.stringify(body.recordingIds)))throw new HttpError(409,'同一校验和的依赖清单冲突');
   if(!old)await writeFile(metaPath,JSON.stringify({bytes:body.bytes,recordingIds:body.recordingIds}),{mode:0o600,flag:'wx'});
   const offset=await stat(file).then(s=>s.size).catch(()=>0);return {offset,blockBytes:4*1024*1024};
  }
  const meta=JSON.parse(await readFile(metaPath,'utf8'));
  if(operation==='chunk'){
   const offset=Number(u.searchParams.get('offset'));if(!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'分块偏移无效');const expected=await stat(file).then(s=>s.size).catch(()=>0);if(offset!==expected)throw new HttpError(409,'分块偏移变化，请重新初始化续传');
   const reader=req.body?.getReader();if(!reader)throw new HttpError(400,'分块为空');const blocks:Uint8Array[]=[];let bytes=0;for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>4*1024*1024||offset+bytes>meta.bytes){await reader.cancel();throw new HttpError(413,'分块过大');}blocks.push(r.value);}if(!bytes)throw new HttpError(400,'分块为空');
   const f=await open(file,'a',0o600);try{await f.writeFile(Buffer.concat(blocks));await f.sync();}finally{await f.close();}return {offset:offset+bytes};
  }
  if(operation==='complete'){
   const deps=await dependencies(user,meta.recordingIds),hasher=createHash('sha256');for await(const chunk of createReadStream(file))hasher.update(chunk);if((await stat(file)).size!==meta.bytes||hasher.digest('hex')!==hash)throw new HttpError(409,'结果包未完整上传或校验和不匹配');
   const prior=(await processingSummaries(user,deps.context)).find(p=>p.packageSha256===hash&&p.processingSource==='desktop_verified');if(prior)return {id:prior.id,status:'verified',reused:true};
   const serverSources:Record<string,string>={};for(let i=0;i<meta.recordingIds.length;i++)serverSources[meta.recordingIds[i]]=await prepareSource(user,deps.sources[i]);
   const verified=await rotationWorker(user,{action:'signal-workspace',operation:'verify-package',parameters:{uploadId:hash.slice(0,32),allowedIds:meta.recordingIds,serverSources}});
   const body={name:verified.task.name,context:deps.context,status:'complete',scope:verified.report.scope,profile:verified.report.profile,task:verified.task,workspace:verified.workspace,selectedRecordingIds:verified.selectedRecordingIds,processingSource:'desktop_verified',packageSha256:hash,packageId:verified.packageId,packageVerification:{rtol:verified.rtol,atol:verified.atol,verifiedArrays:verified.verifiedArrays,reviewAttribution:verified.reviewAttribution,sourceRelations:verified.sourceRelations},sourceKeys:deps.sources.map(s=>s.key),references:deps.sources.map(s=>s.reference),sourceBindings:deps.sources.map(s=>({key:s.key,context:s.context,bindingRevision:s.bindingRevision})),workerAccount:{id:user.id,tenant:user.tenant},workerJobId:verified.jobId,report:verified.report,algorithmVersion:verified.report.algorithmVersion,finishedAt:new Date().toISOString(),published:true,publishedAt:new Date().toISOString(),composition:{mode:'desktop_saved_package',healthQualification:'not_promoted_by_package'}};
   const saved=await saveMeasurementRow(user,'measurement_processing',body);return {id:saved.id,status:'verified',verifiedArrays:verified.verifiedArrays,readBack:{taskName:body.name,records:verified.report.records.length,algorithmVersion:body.algorithmVersion,packageSha256:hash}};
  }
  throw new HttpError(400,'不支持的结果包操作');
 }finally{locks.delete(key);}
}
