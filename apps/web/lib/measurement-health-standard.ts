import {audit,HttpError,type User} from './db';
import {objects,listMeasurementRows,saveMeasurementRow,requireAnalyst} from './measurement-store';
import {processingResult,processingSelection,processingSummaries} from './measurement-processing';
import {healthWindSelection} from './measurement-health-wind';
import {wholeBladeVersion} from './measurement-version-policy';
import {matchSegmentConditions,processingSegmentTimes} from '@blade/ui/measurement-conditions';
import {buildHealthStandard,healthStandardMode,STANDARD_ALGORITHM} from '@blade/ui/blade-health-standard';
import {healthWindDatasets} from '@blade/ui/measurement-health-readiness';

export const projectDamageContract={status:'connected',enabled:true,version:STANDARD_ALGORITHM,input:['publishedProcessingResultId','approvedHealthyEnvelope','matchedMeanConditions','identityReview'],output:{riskLevel:'normal|medium|high',conclusion:'健康|疑似损伤|待复核',damageConfirmation:'人工复核发布'},reason:'基于已确认健康样本的速度、响应峰频率、峰值因子和峭度包络筛查；未标定结构损伤概率'};
export const healthScope=(s:any,c:any,code:string)=>s.context?.farmId===c.farmId&&s.turbineCode===code;
export async function currentHealthStandard(user:User,context:any,code:string){
 return (await listMeasurementRows(user,'measurement_health_standards')).filter(s=>healthScope(s,context,code)&&s.published).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0]||null;
}
export async function healthStandardCatalog(user:User,context:any){
 const all=await objects(user),turbine=all.find(o=>o.kind==='turbine'&&o.id===context?.turbineId&&o.parentId===context?.farmId);
 if(!turbine)throw new HttpError(400,'请选择有效风场和风机');const code=turbine.windTurbineCode||turbine.code;
 const ts=all.filter(o=>o.kind==='turbine'&&o.parentId===context.farmId&&(o.windTurbineCode||o.code)===code).map(o=>o.id);
 const results=await processingSummaries(user,{});
 return {defaultName:`${all.find(o=>o.id===context.farmId)?.name||''} ${code} 健康响应标准`.trim(),standard:await currentHealthStandard(user,context,code),choices:results.filter(p=>p.status==='complete'&&p.scope==='analysis'&&p.context?.farmId===context.farmId&&ts.includes(p.context.turbineId)&&p.workspace?.purpose==='synthesis').map(p=>({id:p.id,name:p.name,bladeName:all.find(o=>o.id===p.context.bladeId)?.name||'整机',context:p.context,published:!!p.published,finishedAt:p.finishedAt}))};
}
function text(v:any,name:string){if(typeof v!=='string'||!v.trim()||v.length>3000)throw new HttpError(400,'请填写'+name);return v.trim();}
export async function publishHealthStandard(user:User,b:any){
 requireAnalyst(user);const approval=text(b.approval,'健康样本确认依据'),catalog=await healthStandardCatalog(user,b.context);
 let mode;try{mode=healthStandardMode(b.mode);}catch(e){throw new HttpError(400,(e as Error).message);}
 const minimum=mode==='response_reference'?3:6;
 if(!Array.isArray(b.sourceIds)||b.sourceIds.length<minimum||b.sourceIds.length>60||new Set(b.sourceIds).size!==b.sourceIds.length||b.sourceIds.some((id:any)=>!catalog.choices.some(c=>c.id===id)))throw new HttpError(400,mode==='response_reference'?'请选择当前风机至少三片已确认健康叶片的完整分析版本':'请选择当前风机至少两批、每批三片叶片的完整分析版本');
 if(b.confirmHealthy!==true)throw new HttpError(400,'需明确确认所选来源为已知健康样本，并核对其对象分组和历史处理标记');
 const all=await objects(user),datasets=await listMeasurementRows(user,'wind_datasets'),sources=[];const provenance:string[]=[];
 for(const id of b.sourceIds){
  const p=await processingResult(user,id),t=all.find(o=>o.id===p.context.turbineId),code=t!.windTurbineCode||t!.code;
  const blades=all.filter(o=>o.kind==='blade'&&o.parentId===t!.id&&(!p.context.bladeId||o.id===p.context.bladeId));
  const choice=await healthWindSelection(user,p.context,healthWindDatasets(datasets,p.context.farmId,code));const wind=datasets.filter(d=>d.id===choice.id);
  for(const blade of blades){
   const selected=await processingSelection(user,{...p.context,bladeId:blade.id});if(!wholeBladeVersion(p,String(blade.code),selected?.task.recordingIds||[]))throw new HttpError(400,'来源并非覆盖当前全部记录的整叶片版本');
   const records=p.report.records.filter((r:any)=>String(r.object?.blade)===String(blade.code));
   for(const r of records){const h=r.importSource?.originalHeader||{};if(h.dataRevision||JSON.stringify(r.manifestContent||{}).includes('dataRevision'))provenance.push('来源包含历史增益修订；标准描述仓库当前数值，不是未经处理的仪器标定范围');if(h.angleAssignment||r.source_quality?.identity_verified!==true)provenance.push('来源角度/叶片分组由用户确认，未用编码器独立核验；仅在相同分组口径下比较');}
   sources.push({processing:p,bladeCode:String(blade.code),name:p.name,conditions:records.map((r:any)=>({recordingId:r.recording_id,condition:matchSegmentConditions(wind,p.context.farmId,code,processingSegmentTimes(r))})),windDatasetId:choice.id});
  }
 }
 let built;try{built=buildHealthStandard(sources,approval,{mode});}catch(e){throw new HttpError(400,(e as Error).message);}
 const t=all.find(o=>o.id===b.context.turbineId)!;
 const saved=await saveMeasurementRow(user,'measurement_health_standards',{...built,name:text(b.name||catalog.defaultName,'标准名称'),context:{farmId:b.context.farmId},turbineCode:t.windTurbineCode||t.code,sourceKeys:[...new Set(sources.flatMap(s=>s.processing.sourceKeys))],references:sources.flatMap(s=>s.processing.references),sourceIds:b.sourceIds,provenanceNotes:[...new Set(provenance)],published:true,approvedBy:user.name,approvedById:user.id,confirmationType:'user_declared_healthy',createdAt:new Date().toISOString(),windSourceIds:[...new Set(sources.map(s=>s.windDatasetId).filter(Boolean))]});
 await audit(user,'发布项目健康响应标准',saved.id);return {standard:saved};
}
export async function saveHealthIdentity(user:User,b:any,blade:any){
 requireAnalyst(user);if(b.confirmIdentity!==true)throw new HttpError(400,'请确认叶片身份及测点/角度分组');
 return saveMeasurementRow(user,'measurement_health_identity_reviews',{context:{...b.context,bladeId:blade.bladeId},processingResultId:blade.processingResultId,sourceHashes:blade.records.map((r:any)=>r.sourceHash).sort(),note:text(b.note,'身份核验依据'),reviewer:user.name,reviewerId:user.id,createdAt:new Date().toISOString(),sourceKeys:blade.sourceKeys,references:blade.references});
}
export function validateHealthDecision(b:any,blade:any){
 if(blade.syntheticScenario)throw new HttpError(409,'合成情景不能发布现场健康或损伤结论');
 if(!blade.standardSnapshot||!blade.healthScreening||!blade.processingResultId||blade.status==='insufficient')throw new HttpError(409,'请先完成标准适用性检查和本版本检测');
 if(b.inputKey!==blade.inputKey)throw new HttpError(409,'分析、标准或工况已经变化，请刷新后复核');
 if(!['healthy','damaged','inconclusive'].includes(b.conclusion))throw new HttpError(400,'请选择有效复核结论');
 if(b.conclusion==='healthy'&&blade.healthScreening.status!=='normal')throw new HttpError(409,'存在超限指标，不能直接发布健康；请排查工况或补充可比基线后重新检测');
 if(b.conclusion==='damaged'&&blade.healthScreening.status==='normal')throw new HttpError(409,'当前检测未见超限，请关联异常检测版本后发布损伤结论');
 text(b.note,'复核说明');text(b.evidence,'巡检、检测报告或其他复核依据');
}
export async function saveHealthDecision(user:User,b:any,blade:any){
 requireAnalyst(user);validateHealthDecision(b,blade);
 const saved=await saveMeasurementRow(user,'measurement_health_decisions',{context:{...b.context,bladeId:blade.bladeId},processingResultId:blade.processingResultId,standardId:blade.standardSnapshot.id,inputKey:blade.screeningKey||blade.inputKey,conclusion:b.conclusion,note:text(b.note,'复核说明'),evidence:text(b.evidence,'巡检、检测报告或其他复核依据'),reviewer:user.name,reviewerId:user.id,createdAt:new Date().toISOString(),sourceKeys:blade.sourceKeys,references:blade.references});
 await audit(user,'发布叶片健康复核结论',saved.id);return {decision:saved};
}
