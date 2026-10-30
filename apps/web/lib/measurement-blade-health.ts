import {audit,digest,HttpError,type User} from './db';
import {objects,listMeasurementRows,saveMeasurementRow,requireAnalyst} from './measurement-store';
import {processingSummaries,processingResult} from './measurement-processing';
import {matchSegmentConditions,processingSegmentTimes,windDatasetRevisionInput} from '@blade/ui/measurement-conditions';
import {bladeDisplaySlots} from '@blade/ui/measurement-domain';
const same=(r:any,c:any)=>['farmId','campaignId','turbineId'].every(k=>r.context?.[k]===c[k]);
export async function bladeHealthWorkspace(user:User,context:any,save=false,preferredId?:string){
 if(!context?.farmId||!context?.campaignId||!context?.turbineId)throw new HttpError(400,'请选择风场、批次和风机');
 const [all,processing,datasets,history,reviews]=await Promise.all([objects(user),processingSummaries(user,{}),listMeasurementRows(user,'wind_datasets'),listMeasurementRows(user,'measurement_blade_assessments'),listMeasurementRows(user,'measurement_reviews')]);
 history.sort((a,b)=>Date.parse(b.evaluatedAt)-Date.parse(a.evaluatedAt));
 const turbine=all.find(o=>o.id===context.turbineId&&o.parentId===context.farmId&&o.kind==='turbine');if(!turbine)throw new HttpError(400,'风机归属无效');
 const windRevision=digest(JSON.stringify(windDatasetRevisionInput(datasets,context.farmId)));
 if(preferredId&&!processing.some(p=>p.id===preferredId&&p.status==='complete'&&same(p,context)))throw new HttpError(400,'所选处理版本不属于当前批次或无权访问');
 processing.sort((a,b)=>Number(b.id===preferredId)-Number(a.id===preferredId));
 const cached=new Map<string,any>();const blades=[];
 for(const slot of bladeDisplaySlots(all.filter(o=>o.kind==='blade'&&o.parentId===turbine.id))){
  const blade=slot.blade;
  const options=processing.filter(p=>p.status==='complete'&&p.scope==='analysis'&&same(p,context)&&(!p.context.bladeId||p.context.bladeId===blade?.id));
  let source:any=null,records:any[]=[];
  for(const p of options){if(!cached.has(p.id))cached.set(p.id,await processingResult(user,p.id));const detail=cached.get(p.id);const own=detail.report.records.filter((r:any)=>String(r.object?.blade)===String(blade?.code));if(own.length){source=detail;records=own;break;}}
  const previous=history.find(h=>h.context?.bladeId===blade?.id&&same(h,context));
  if(!source){blades.push({bladeId:blade?.id||null,name:slot.name,status:'unmeasured',label:'未测量',reasons:['本批次尚无该叶片的已保存处理结果'],processingResultId:null,previousId:previous?.id});continue;}
  const ownReviews=reviews.filter(r=>r.processingResultId===source.id).sort((a,b)=>Date.parse(b.reviewedAt)-Date.parse(a.reviewedAt)),reviewRevision=digest(JSON.stringify(ownReviews.map(r=>[r.id,r.reviewedAt,r.note])));
  const conditions=records.map(r=>({recordingId:r.recording_id,point:r.object?.point,azimuthDeg:r.object?.azimuth_deg,sourceTimes:processingSegmentTimes(r),condition:matchSegmentConditions(datasets,context.farmId,turbine.code,processingSegmentTimes(r))}));
  const eligible=records.filter(r=>r.quality_assessment?.analysis_eligible),blocked=records.filter(r=>!r.quality_assessment?.analysis_eligible);
  const qualityEvents=records.flatMap(r=>(r.quality_events||[]).slice(0,50).map((e:any)=>({...e,recordingId:r.recording_id,point:r.object?.point,azimuthDeg:r.object?.azimuth_deg,category:'data_quality'})));
  const peaks=eligible.flatMap(r=>(r.segments||[]).map((s:any)=>({recordingId:r.recording_id,resultId:s.result_id,point:r.object?.point,azimuthDeg:r.object?.azimuth_deg,features:s.features,peaks:s.spectrum?.peaks||[],resolutionHz:s.spectrum?.resolution_hz,observationSeconds:s.features?.observation_seconds})));
  const coverage=(source.report.coverage?.points||[]).filter((p:any)=>String(p.bladeId)===String(blade?.code));
  const missing=coverage.flatMap((p:any)=>(p.missingAzimuths||[]).map((a:number)=>`${p.pointName} / ${a}°`));
  const reasons=[...(missing.length?[`观测缺项：${missing.join('、')}`]:[]),...(source.composition.mode==='diagnostic_group'?['跨任务实体身份未核验，当前为业务诊断展示组']:[]),...(!records.every(r=>r.source_quality?.identity_verified===true)?['来源物理叶片身份尚未独立核验']:[]),...(conditions.some(c=>c.condition.status!=='matched')?['有效片段缺少匹配风速和转速']:[]),...(conditions.some(c=>!c.condition.healthEligible)?['工况时间、转速语义或匹配资格不足']:[]),'缺少经复核的独立同工况参考批次','正式模态及结构损伤判据尚未经对照验收'];
  const snapshot:any={context:{...context,bladeId:blade!.id,positionId:undefined},bladeId:blade!.id,name:slot.name,status:'insufficient',label:'证据不足',reasons,
   sourceKeys:source.sourceKeys,references:source.references,processingResultId:source.id,processingAlgorithmVersion:source.algorithmVersion,processingCreatedAt:source.finishedAt,
   coverage:{observed:records.length,analyzable:eligible.length,review:blocked.length,missing,points:coverage},commonResponse:(source.report.commonResponse||[]).filter((g:any)=>String(g.blade)===String(blade?.code)),
   records:records.map(r=>({id:r.recording_id,point:r.object?.point,azimuthDeg:r.object?.azimuth_deg,representative:r.representative,resultIds:(r.segments||[]).map((s:any)=>s.result_id),issues:r.issues,quality:r.quality_assessment,sourceQuality:r.source_quality,sourceHash:r.source_hash,review:ownReviews.find(v=>v.recordingId===r.recording_id)||null})),
   conditions,qualityEvents,features:peaks,windRevision,reviewRevision,assessmentAlgorithmVersion:'blade-evidence-v2.1.0',rulesVersion:'qualification-gates-v1',evaluatedAt:new Date().toISOString(),structuralDamageConfirmed:false,probability:null,
   previousId:previous?.id||null,stale:!!previous&&(previous.windRevision!==windRevision||previous.processingResultId!==source.id||previous.reviewRevision!==reviewRevision)};
  snapshot.inputKey=digest(JSON.stringify([source.id,windRevision,reviewRevision,snapshot.rulesVersion]));
  if(save){requireAnalyst(user);const prior=history.find(h=>h.inputKey===snapshot.inputKey&&h.bladeId===blade?.id);const saved=prior||await saveMeasurementRow(user,'measurement_blade_assessments',snapshot);snapshot.assessmentId=saved.id; snapshot.evaluatedAt=saved.evaluatedAt;snapshot.stale=false;}
  else {snapshot.assessmentId=previous?.inputKey===snapshot.inputKey?previous.id:null;}
  blades.push(snapshot);
 }
 return {context,windRevision,blades,history:history.filter(r=>r.context?.farmId===context.farmId&&r.context?.turbineId===context.turbineId).map(r=>({id:r.id,context:r.context,name:r.name,status:r.status,label:r.label,coverage:r.coverage,processingResultId:r.processingResultId,windRevision:r.windRevision,evaluatedAt:r.evaluatedAt})),formalMethods:[],datasetCount:datasets.length};
}
export async function bladeHealthEndpoint(user:User,b:any){const save=b.action==='evaluate';if(!['workspace','evaluate'].includes(b.action))throw new HttpError(400,'不支持的叶片评价动作');if(save)requireAnalyst(user);const result=await bladeHealthWorkspace(user,b.context,save,b.processingResultId);if(save)await audit(user,'更新工况关联与叶片评价',JSON.stringify(b.context));return result;}
