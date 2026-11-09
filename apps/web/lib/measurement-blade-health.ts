import {damageContract,responseWarning} from '@blade/ui/response-health-policy';
import {audit,digest,HttpError,type User} from './db';
import {objects,listMeasurementRows,saveMeasurementRow,requireAnalyst} from './measurement-store';
import {processingSelection,processingSummaries,processingResult,processingEndpoint} from './measurement-processing';
import {matchSegmentConditions,processingSegmentTimes,windDatasetRevisionInput} from '@blade/ui/measurement-conditions';
import {bladeDisplaySlots} from '@blade/ui/measurement-domain';
import {wholeBladeVersion} from './measurement-version-policy';
import {healthWindSelection,saveHealthWindSelection} from './measurement-health-wind';
import {healthEvidenceReadiness} from '@blade/ui/measurement-health-readiness';
const same=(r:any,c:any)=>['farmId','campaignId','turbineId'].every(k=>r.context?.[k]===c[k]);
export async function bladeHealthWorkspace(user:User,context:any,save=false,preferredId?:string,preferredIds:Record<string,string>={},windDatasetId?:string){
 if(!context?.farmId||!context?.campaignId||!context?.turbineId)throw new HttpError(400,'请选择风场、批次和风机');
 const [all,processing,allDatasets,history,reviews,healthRules,modalVersions,faultTests]=await Promise.all([objects(user),processingSummaries(user,{}),listMeasurementRows(user,'wind_datasets'),listMeasurementRows(user,'measurement_blade_assessments'),listMeasurementRows(user,'measurement_reviews'),listMeasurementRows(user,'measurement_health_rules'),listMeasurementRows(user,'measurement_formal_modal'),listMeasurementRows(user,'measurement_health_tests')]);
 history.sort((a,b)=>Date.parse(b.evaluatedAt)-Date.parse(a.evaluatedAt));
 const turbine=all.find(o=>o.id===context.turbineId&&o.parentId===context.farmId&&o.kind==='turbine');if(!turbine)throw new HttpError(400,'风机归属无效');
 const selected=await processingSelection(user,{farmId:context.farmId,campaignId:context.campaignId,turbineId:context.turbineId});
 const windChoices=allDatasets.filter(d=>d.farmId===context.farmId);
 const windSelection=await healthWindSelection(user,context,windChoices,windDatasetId);windDatasetId=windSelection.id;
 const datasets=windChoices.filter(d=>d.id===windDatasetId);
 const windCode=turbine.windTurbineCode||turbine.code;
 const windRevision=digest(JSON.stringify([windDatasetId??'legacy_auto',windDatasetRevisionInput(datasets,context.farmId)]));
 if(preferredId&&!processing.some(p=>p.id===preferredId&&p.status==='complete'&&same(p,context)))throw new HttpError(400,'所选处理版本不属于当前批次或无权访问');
 processing.sort((a,b)=>Number(b.id===preferredId)-Number(a.id===preferredId));
 const cached=new Map<string,any>();const blades=[];
 for(const slot of bladeDisplaySlots(all.filter(o=>o.kind==='blade'&&o.parentId===turbine.id))){
  const blade=slot.blade;
  const expectedIds=(selected?.task.records||[]).filter(r=>String(r.bladeId)===String(blade?.code)).map(r=>r.id);
  const preferred=preferredIds[blade?.id||'']||preferredId;
  const options=processing.filter(p=>p.status==='complete'&&p.scope==='analysis'&&same(p,context)&&(!p.context.bladeId||p.context.bladeId===blade?.id)&&(p.workspace?.purpose==='synthesis'||!p.workspace?.purpose)).sort((a,b)=>Number(b.id===preferred)-Number(a.id===preferred));
  let source:any=null,records:any[]=[];
  for(const p of options){if(!cached.has(p.id))cached.set(p.id,await processingResult(user,p.id));const detail=cached.get(p.id);const own=detail.report.records.filter((r:any)=>String(r.object?.blade)===String(blade?.code));if(wholeBladeVersion(detail,String(blade?.code),expectedIds)){source=detail;records=own;break;}}
  const previous=history.find(h=>h.context?.bladeId===blade?.id&&same(h,context));
  if(!source){blades.push({bladeId:blade?.id||null,name:slot.name,status:'unmeasured',label:expectedIds.length?'待整叶片分析':'未测量',reasons:[expectedIds.length?`本批已采到 ${expectedIds.length} 条，尚无覆盖全部来源的整叶片版本；单条分析不用于整体评价`:'本批次尚无该叶片的已保存处理结果'],processingResultId:null,canAnalyze:expectedIds.length>0,acquired:expectedIds.length,previousId:previous?.id});continue;}
  const ownReviews=reviews.filter(r=>r.processingResultId===source.id).sort((a,b)=>Date.parse(b.reviewedAt)-Date.parse(a.reviewedAt)),reviewRevision=digest(JSON.stringify(ownReviews.map(r=>[r.id,r.reviewedAt,r.note])));
  const conditions=records.map(r=>({recordingId:r.recording_id,point:r.object?.point,azimuthDeg:r.object?.azimuth_deg,sourceTimes:processingSegmentTimes(r),condition:matchSegmentConditions(datasets,context.farmId,windCode,processingSegmentTimes(r))}));
  const eligible=records.filter(r=>r.quality_assessment?.analysis_eligible),blocked=records.filter(r=>!r.quality_assessment?.analysis_eligible);
  const qualityEvents=records.flatMap(r=>(r.quality_events||[]).slice(0,50).map((e:any)=>({...e,recordingId:r.recording_id,point:r.object?.point,azimuthDeg:r.object?.azimuth_deg,category:'data_quality'})));
  const peaks=eligible.flatMap(r=>(r.segments||[]).map((s:any)=>({recordingId:r.recording_id,resultId:s.result_id,point:r.object?.point,azimuthDeg:r.object?.azimuth_deg,features:s.features,peaks:s.spectrum?.peaks||[],resolutionHz:s.spectrum?.resolution_hz,observationSeconds:s.features?.observation_seconds})));
  const coverage=(source.report.coverage?.points||[]).filter((p:any)=>String(p.bladeId)===String(blade?.code));
  const missing=coverage.flatMap((p:any)=>(p.missingAzimuths||[]).map((a:number)=>`${p.pointName} / ${a}°`));
  const conditionReasons=[...new Set<string>(conditions.filter(c=>!c.condition.healthEligible).flatMap(c=>c.condition.reasons?.length?c.condition.reasons:['工况时间、转速语义或匹配资格不足']))];
  const reasons=[...(missing.length?[`观测缺项：${missing.join('、')}`]:[]),...(source.packageVerification?.reviewAttribution==='client_provenance_only'&&Object.keys(source.report.qualityReviews||{}).length?['桌面复核的物理依据尚未在服务端确认，不能据此升级健康资格']:[]),...(source.composition.mode==='diagnostic_group'?['跨任务实体身份未核验，当前为业务诊断展示组']:[]),...(!records.every(r=>r.source_quality?.identity_verified===true)?['来源物理叶片身份尚未独立核验']:[]),...conditionReasons];
  const rule=healthRules.find(r=>r.context?.turbineId===turbine.id&&r.context?.bladeId===blade?.id);
  let reference:any=null;if(rule?.referenceResultId){try{reference=await processingResult(user,rule.referenceResultId);}catch{}}
  const referenceRecords=reference?.report.records.filter((r:any)=>String(r.object?.blade)===String(blade?.code))||[];
  const referenceConditions=referenceRecords.map((r:any)=>({condition:matchSegmentConditions(datasets,context.farmId,windCode,processingSegmentTimes(r))}));
  const warning=reasons.length?{status:'insufficient',label:'证据不足',reason:reasons.join('；'),comparisons:[]}:responseWarning({...source,conditions},{...reference,conditions:referenceConditions},rule?{...rule,bladeCode:blade?.code}:null);
  if(warning.reason&&!reasons.length)reasons.push(warning.reason);
  const snapshot:any={context:{...context,bladeId:blade!.id,positionId:undefined},bladeId:blade!.id,name:slot.name,status:warning.status,label:warning.label,reasons,responseWarning:warning,ruleSnapshot:rule||null,referenceSnapshot:reference?{id:reference.id,algorithmVersion:reference.algorithmVersion,sourceFingerprints:reference.report.sourceFingerprints,conditions:referenceConditions}:null,damageAlgorithm:damageContract,
   sourceKeys:source.sourceKeys,references:source.references,processingResultId:source.id,processingAlgorithmVersion:source.algorithmVersion,processingCreatedAt:source.finishedAt,
   geometryEstimates:records.flatMap(r=>r.segments?.[0]?.parameters?.geometry_correction?[{recordingId:r.recording_id,...r.segments[0].parameters.geometry_correction}]:[]),
   coverage:{acquired:expectedIds.length,purpose:'synthesis',observed:records.length,analyzable:eligible.length,review:blocked.length,missing,points:coverage},commonResponse:(source.report.commonResponse||[]).filter((g:any)=>String(g.blade)===String(blade?.code)),
   records:records.map(r=>({id:r.recording_id,point:r.object?.point,azimuthDeg:r.object?.azimuth_deg,representative:r.representative,resultIds:(r.segments||[]).map((s:any)=>s.result_id),issues:r.issues,quality:r.quality_assessment,sourceQuality:r.source_quality,sourceHash:r.source_hash,review:ownReviews.find(v=>v.recordingId===r.recording_id)||null})),
   modalResults:modalVersions.filter(r=>r.published&&r.context?.turbineId===turbine.id&&r.context?.campaignId===context.campaignId&&r.context?.bladeId===blade?.id).map(r=>({id:r.id,method:r.method,result:r.result,sourceSha256:r.sourceSha256,publishedAt:r.publishedAt})),conditions,evidenceReadiness:healthEvidenceReadiness({conditions,records,rule,reference,published:!!source.published}),qualityEvents,features:peaks,windDatasetId:windDatasetId||null,windTurbineCode:windCode,windRevision,reviewRevision,assessmentAlgorithmVersion:'blade-evidence-v2.2.0',rulesVersion:'response-warning-v22',evaluatedAt:new Date().toISOString(),structuralDamageConfirmed:false,probability:null,
   previousId:previous?.id||null,stale:!!previous&&(previous.windRevision!==windRevision||previous.processingResultId!==source.id||previous.reviewRevision!==reviewRevision)};
  snapshot.inputKey=digest(JSON.stringify([source.id,windRevision,reviewRevision,snapshot.assessmentAlgorithmVersion,snapshot.rulesVersion,rule?.id,reference?.id]));
  if(save){requireAnalyst(user);const prior=history.find(h=>h.inputKey===snapshot.inputKey&&h.bladeId===blade?.id);const saved=prior||await saveMeasurementRow(user,'measurement_blade_assessments',snapshot);snapshot.assessmentId=saved.id; snapshot.evaluatedAt=saved.evaluatedAt;snapshot.stale=false;}
  else {snapshot.assessmentId=previous?.inputKey===snapshot.inputKey?previous.id:null;}
  blades.push(snapshot);
 }
 return {context,windRevision,windDatasetId:windDatasetId||null,windSelectionSource:windSelection.source,windDatasets:windChoices.map(d=>({id:d.id,name:d.name,start:d.start,end:d.end,timeSemantics:d.timeSemantics})),blades,faultTests:faultTests.filter(t=>same(t,context)).map(t=>({id:t.id,context:t.context,name:t.name,point:t.point,label:t.label,status:t.status,test_only:true,sourceProcessingResultId:t.sourceProcessingResultId,createdAt:t.createdAt})),history:history.filter(r=>r.context?.farmId===context.farmId&&r.context?.turbineId===context.turbineId).map(r=>({id:r.id,context:r.context,name:r.name,status:r.status,label:r.label,coverage:r.coverage,processingResultId:r.processingResultId,windRevision:r.windRevision,evaluatedAt:r.evaluatedAt})),damageAlgorithm:damageContract,healthRules,referenceChoices:processing.filter(p=>p.published&&p.context?.turbineId===context.turbineId).map(p=>({id:p.id,name:p.name,context:p.context,finishedAt:p.finishedAt})),formalMethods:['decay','frf','ssi_cov'],datasetCount:datasets.length};
}
export async function bladeHealthEndpoint(user:User,b:any){if(b.action==='damage')return damageContract;
 if(b.action==='select-wind'){await saveHealthWindSelection(user,b.context,b.windDatasetId);await audit(user,'保存健康监测风场数据集关联',JSON.stringify({context:b.context,windDatasetId:b.windDatasetId}));return bladeHealthWorkspace(user,b.context,false,undefined,b.processingResultIds);}
 if(b.action==='fault-test-detail'){
  const test=(await listMeasurementRows(user,'measurement_health_tests')).find(t=>t.id===b.testId);
  if(!test)throw new HttpError(404,'缺陷测试记录不存在或无权访问');return test;
 }
 if(b.action==='fault-test'){
  requireAnalyst(user);const source=await processingResult(user,b.processingResultId),all=await objects(user);
  const blade=all.find(o=>o.active&&o.kind==='blade'&&o.id===b.bladeId&&o.parentId===b.context?.turbineId);
  if(!blade||!same(source,b.context)||source.context.bladeId&&source.context.bladeId!==blade.id||source.status!=='complete')throw new HttpError(400,'请选择当前批次已完成的整叶片处理版本');
  const selected=await processingSelection(user,{...b.context,bladeId:blade.id});
  if(!wholeBladeVersion(source,String(blade.code),selected?.task.recordingIds||[]))throw new HttpError(400,'测试需基于覆盖当前全部来源的整叶片分析');
  const point=typeof b.point==='string'?b.point:'P3';
  const own=source.report.records.filter((r:any)=>String(r.object?.blade)===String(blade.code)&&r.object?.point===point&&r.quality_assessment?.analysis_eligible&&r.representative);
  if(!own.length)throw new HttpError(400,'所选测点没有可用于缺陷验证的有效连续段');
  const byAngle=new Map<number,any>();for(const r of own)if(!byAngle.has(r.object.azimuth_deg))byAngle.set(r.object.azimuth_deg,r);
  const ids=[...byAngle.values()].sort((a,b)=>a.object.azimuth_deg-b.object.azimuth_deg).map(r=>r.representative);
  const result=await processingEndpoint(user,{request:{action:'extended',jobId:source.id,kind:'defect_validation',resultIds:ids}});
  if(!result.available)throw new HttpError(400,'测点有效段不足，无法执行缺陷注入验证');
  const alarm=result.items.some((i:any)=>i.available&&i.detection.suspectedDamage),status=alarm?'warning':result.status==='normal'?'normal':'insufficient';
  const saved=await saveMeasurementRow(user,'measurement_health_tests',{name:`${source.name} · 叶片${blade.code} · ${point} · 缺陷注入测试`,context:{farmId:b.context.farmId,campaignId:b.context.campaignId,turbineId:b.context.turbineId,bladeId:blade.id},sourceKeys:source.sourceKeys,references:source.references,sourceProcessingResultId:source.id,point,createdAt:new Date().toISOString(),test_only:true,structuralDamageConfirmed:false,status,label:alarm?'疑似损伤预警（测试副本）':status==='normal'?'未触发测试阈值':'测试证据不足',result});
  await audit(user,'运行缺陷注入与预警验证',saved.id);return saved;
 }
 if(b.action==='analyze'){
  requireAnalyst(user);const scope={farmId:b.context?.farmId,campaignId:b.context?.campaignId,turbineId:b.context?.turbineId,bladeId:b.bladeId};
  const all=await objects(user);if(!scope.bladeId||!all.some(o=>o.active&&o.kind==='blade'&&o.id===scope.bladeId&&o.parentId===scope.turbineId))throw new HttpError(400,'请选择当前风机的叶片');
  const catalog=await processingEndpoint(user,{context:scope,request:{action:'catalog'}}),task=catalog.tasks?.[0];if(!task?.recordingIds?.length)throw new HttpError(400,'本批次没有该叶片的测量记录');
  return processingEndpoint(user,{context:scope,compositionMode:catalog.composition?.required?'diagnostic_group':undefined,compositionReason:catalog.composition?.required?'健康监测：按当前已关联批次汇总同一叶片的全部来源，仅用于响应分析':undefined,request:{action:'start',taskId:task.id,recordingIds:task.recordingIds,scope:'analysis',profile:'LOS_DIAGNOSTIC',workspace:{purpose:'synthesis',algorithmOptions:{...catalog.processingContract.defaults,measurementMode:'outdoor',...(task.analysisGeometry?{geometry:task.analysisGeometry}:{})}}}});
 }

 if(b.action==='configure'){requireAnalyst(user);if(!b.context?.bladeId||!b.referenceApproval?.trim()||!b.thresholdSource?.trim())throw new HttpError(400,'请选择叶片并填写参考复核与阈值依据');const reference=await processingResult(user,b.referenceResultId);if(!reference.published||reference.context.turbineId!==b.context.turbineId)throw new HttpError(400,'正常参考须是当前风机已保存版本');for(const k of ['warningRatio','alarmRatio','windTolerance','rpmTolerance'])if(!Number.isFinite(b[k]))throw new HttpError(400,'请填写有限数值');if(b.warningRatio<=1||b.alarmRatio<=b.warningRatio||b.windTolerance<0||b.rpmTolerance<0)throw new HttpError(400,'阈值或容差范围无效');return saveMeasurementRow(user,'measurement_health_rules',{name:'响应变化预警规则',context:b.context,method:'response_ratio',referenceResultId:reference.id,referenceApproval:String(b.referenceApproval).slice(0,2000),thresholdSource:String(b.thresholdSource).slice(0,2000),warningRatio:b.warningRatio,alarmRatio:b.alarmRatio,windTolerance:b.windTolerance,rpmTolerance:b.rpmTolerance,reviewer:user.id,createdAt:new Date().toISOString()});}
 const save=b.action==='evaluate';if(!['workspace','evaluate'].includes(b.action))throw new HttpError(400,'不支持的叶片评价动作');if(save)requireAnalyst(user);const result=await bladeHealthWorkspace(user,b.context,save,b.processingResultId,b.processingResultIds,b.windDatasetId);if(save)await audit(user,'更新工况关联与叶片评价',JSON.stringify(b.context));return result;}
