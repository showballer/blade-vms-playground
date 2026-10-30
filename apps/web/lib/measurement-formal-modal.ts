import {compareModalResults} from '@blade/ui/modal-result-comparison';
import {pool,rows,unpack,HttpError,type User,type RecordItem} from './db';
import {processingResult} from './measurement-processing';
import {requireAnalyst,saveMeasurementRow,objects} from './measurement-store';
import {rotationWorker,rotationDataDirectory} from './rotation';
import {realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
const state=globalThis as typeof globalThis & {modalV22?:Map<string,AbortController>};
const active=state.modalV22??=new Map();
const worker=(u:User,operation:string,parameters:any={},signal?:AbortSignal)=>rotationWorker(u,{action:'formal-modal',operation,parameters},signal);
async function saved(u:User,id:string){const r=await rows<RecordItem>("SELECT * FROM records WHERE id=? AND kind='measurement_formal_modal' AND tenant=? AND created_by=?",[id,u.tenant,u.id]);if(!r.length)throw new HttpError(404,'模态结果不存在或不属于当前账号');return unpack(r[0]);}
const update=(u:User,id:string,v:any)=>pool().execute("UPDATE records SET body=? WHERE id=? AND kind='measurement_formal_modal' AND tenant=? AND created_by=?",[JSON.stringify(v),id,u.tenant,u.id]);
export async function formalModalEndpoint(user:User,body:any){
 const action=body.action;
 if(action==='catalog'){const result=await worker(user,'catalog');const records=await rows<RecordItem>("SELECT * FROM records WHERE kind='measurement_formal_modal' AND tenant=? AND created_by=? ORDER BY updated_at DESC LIMIT 100",[user.tenant,user.id]);return {...result,jobs:records.map(unpack)};}
 if(action==='from-segment'){
  requireAnalyst(user);const p=await processingResult(user,body.processingResultId);if(!p.report.records.some((r:any)=>r.segments.some((s:any)=>s.result_id===body.resultId)))throw new HttpError(403,'真实段不属于所选处理版本');if(p.workerAccount.id!==user.id)throw new HttpError(403,'请由当前账号重新计算并保存此输入');return worker(user,'from-segment',{processingResultId:p.id,workerJobId:p.workerJobId,packageSha256:p.packageSha256,resultId:body.resultId,startSeconds:body.startSeconds,endSeconds:body.endSeconds,pointId:p.context.positionId,context:p.context,calibrationSource:body.calibrationSource,evidence:body.evidence,name:body.name});
 }
 if(action==='import'){requireAnalyst(user);if(Buffer.byteLength(JSON.stringify(body))>20*1024*1024)throw new HttpError(413,'模态输入上限20 MiB');const all=await objects(user);const context=body.context;if(context?.turbineId&&!all.some(o=>o.id===context.turbineId&&o.parentId===context.farmId&&o.kind==='turbine'))throw new HttpError(400,'模态输入对象归属无效');return worker(user,'import',{context,dataset:body.dataset,name:String(body.name||'实测同步数据').slice(0,200)});}
 if(action==='start'){
  requireAnalyst(user);const catalog=await worker(user,'catalog');if(!catalog.datasets.some((d:any)=>d.id===body.datasetId))throw new HttpError(404,'实测输入不存在');
  const input=catalog.datasets.find((d:any)=>d.id===body.datasetId);const record=await saveMeasurementRow(user,'measurement_formal_modal',{context:input.context,sourceSha256:input.sourceSha256,inputSummary:input,name:'模态参数识别',datasetId:body.datasetId,method:body.method,status:'running',createdAt:new Date().toISOString(),published:false});const controller=new AbortController();active.set(record.id,controller);
  void worker(user,'start',{datasetId:body.datasetId,method:body.method},controller.signal).then(async r=>{if(!controller.signal.aborted)await update(user,record.id,{...record,status:'complete',workerJobId:r.job.id,result:r.result,finishedAt:new Date().toISOString(),published:false});}).catch(async e=>{if(!controller.signal.aborted)await update(user,record.id,{...record,status:'failed',error:(e as Error).message});}).finally(()=>active.delete(record.id));
  return record;
 }
 const r=await saved(user,body.id);
 if(action==='cancel'){requireAnalyst(user);active.get(r.id)?.abort();await update(user,r.id,{...r,status:'cancelled'});return {status:'cancelled',backgroundMayContinue:false};}
 if(action==='status')return {...r,status:r.status==='running'&&!active.has(r.id)?'failed':r.status,error:r.status==='running'&&!active.has(r.id)?'进程已重启，请重新运行':r.error};
 if(r.status!=='complete')throw new HttpError(409,'模态结果尚未完成');
 if(action==='compare'){const reference=await saved(user,body.referenceId);if(reference.status!=='complete')throw new HttpError(409,'参考未完成');return compareModalResults(r,reference);}
 if(action==='save'){requireAnalyst(user);const v={...r,published:true,publishedAt:new Date().toISOString(),publishedBy:user.id};await update(user,r.id,v);return v;}
 if(action==='result')return r;
 if(action==='export'){
  const out=await worker(user,'export',{jobId:r.workerJobId});const base=await realpath(path.join(rotationDataDirectory(user),'formal-modal-v22','jobs',r.workerJobId)),file=await realpath(out.path);if(path.dirname(file)!==base||!(await stat(file)).isFile())throw new HttpError(400,'结果文件无效');
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream,{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename=modal.zip; filename*=UTF-8''${encodeURIComponent(out.fileName)}`,'Cache-Control':'no-store'}});
 }
 throw new HttpError(400,'不支持的模态操作');
}
