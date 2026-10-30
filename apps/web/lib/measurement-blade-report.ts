import {audit,digest,HttpError,type User} from './db';
import {objects,saveMeasurementRow,requireAnalyst,listMeasurementRows} from './measurement-store';
import {bladeHealthWorkspace} from './measurement-blade-health';
import {processingResult} from './measurement-processing';
export async function createBladeReport(user:User,b:any){
 requireAnalyst(user);const all=await objects(user),campaign=all.find(o=>o.id===b.campaignId&&o.kind==='campaign');
 if(!campaign||!b.turbineId||!all.some(o=>o.id===b.turbineId&&o.kind==='turbine'&&o.parentId===campaign.parentId))throw new HttpError(400,'请选择批次和风机');
 const workspace=await bladeHealthWorkspace(user,{farmId:campaign.parentId,campaignId:campaign.id,turbineId:b.turbineId},true,b.processingResultId);
 const ids=[...new Set<string>(workspace.blades.map(b=>b.processingResultId).filter(Boolean))];if(!ids.length)throw new HttpError(400,'请先在模态识别保存本批次的真实信号处理结果');
 const processing=await Promise.all(ids.map(id=>processingResult(user,id)));
 const modalSnapshots=(await listMeasurementRows(user,'measurement_formal_modal')).filter(r=>r.published&&r.status==='complete'&&r.context?.farmId===campaign.parentId&&r.context?.turbineId===b.turbineId&&r.context?.campaignId===campaign.id).map(r=>({id:r.id,context:r.context,inputSummary:r.inputSummary,sourceSha256:r.sourceSha256,method:r.method,result:r.result,publishedAt:r.publishedAt,publishedBy:r.publishedBy}));
 const snapshots=processing.map(p=>({id:p.id,algorithmVersion:p.algorithmVersion,createdAt:p.finishedAt,profile:p.profile,composition:p.composition,sourceKeys:p.sourceKeys,references:p.references,sourceFingerprints:p.report.sourceFingerprints,bindingRevisions:p.bindingRevisions,processingContract:p.report.processingContract,workspace:p.report.workspace,qualityReviews:p.report.qualityReviews,packageVerification:p.packageVerification,geometryVersions:p.report.records.map((r:any)=>({id:r.recording_id,inputs:r.measurement_inputs,correction:r.segments?.[0]?.parameters?.geometry_correction})),coverage:p.report.coverage,commonResponse:p.report.commonResponse,records:p.report.records}));
 const body:any={name:campaign.name+' · 逐叶片证据报告',reportNumber:'RPT-BLADE-'+new Date().toISOString().replace(/[-:.TZ]/g,'')+'-'+digest(JSON.stringify(ids)).slice(0,6),createdAt:new Date().toISOString(),author:user.name,campaignId:campaign.id,turbineId:b.turbineId,
  context:workspace.context,objects:all.filter(o=>o.id===campaign.parentId||o.id===campaign.id||o.id===b.turbineId||o.parentId===b.turbineId||all.some(parent=>parent.parentId===b.turbineId&&o.parentId===parent.id)),
  sourceKeys:[...new Set(processing.flatMap(p=>p.sourceKeys))],references:processing.flatMap(p=>p.references),rows:[],hasDiagnostic:true,diagnosticOnly:true,
  modalSnapshots,damageAlgorithm:workspace.damageAlgorithm,bladeAssessments:workspace.blades,processingSnapshots:snapshots,windRevision:workspace.windRevision,
  conclusion:'按每片叶片保存来源、信号处理、有效经过工况和评价版本。可分析响应与正式健康资格分开；缺项不填零，未测叶片不推断正常。'};
 body.snapshotHash=digest(JSON.stringify(body));const report=await saveMeasurementRow(user,'measurement_reports',body);await audit(user,'保存逐叶片证据报告',report.id);return {report};
}
