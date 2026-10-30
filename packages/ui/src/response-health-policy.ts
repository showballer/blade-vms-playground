// Descriptive response warnings are separate from the reserved damage classifier.
export const damageContract={status:'algorithm_not_connected',enabled:false,version:'damage-contract-1',input:['savedProcessingResultId','qualifiedModalResultId','conditionSnapshotId','independentReferenceId'],output:{riskLevel:null,probability:null,damageLocation:null},reason:'专项损伤算法尚未接入'};
export function responseWarning(current:any,reference:any,rule:any){
 const fail=(reason:string)=>({status:'insufficient',label:'证据不足',reason,comparisons:[]});
 if(!rule||rule.method!=='response_ratio')return fail('尚未配置有依据的响应变化预警规则');
 if(!current.published||!reference?.published)return fail('当前或参考处理版本尚未保存发布');
 if(current.id===reference.id||current.context?.campaignId===reference.context?.campaignId)return fail('参考必须来自独立测量批次');
 const hashes=new Set((current.report?.records||[]).map((r:any)=>r.source_hash));if((reference.report?.records||[]).some((r:any)=>hashes.has(r.source_hash)))return fail('当前与参考存在同源记录，不能视为独立历史');
 if(!rule.referenceApproval?.trim()||!rule.thresholdSource?.trim())return fail('缺少正常参考复核依据或预警阈值来源');
 if(![rule.warningRatio,rule.alarmRatio,rule.windTolerance,rule.rpmTolerance].every(Number.isFinite)||rule.warningRatio<=1||rule.alarmRatio<=rule.warningRatio||rule.windTolerance<0||rule.rpmTolerance<0)return fail('预警阈值或同工况容差无效');
 if(current.algorithmVersion!==reference.algorithmVersion||JSON.stringify(current.report.workspace?.algorithmOptions)!==JSON.stringify(reference.report.workspace?.algorithmOptions))return fail('处理、方向或目标频带方案不同，不能直接比较');
 if(!current.conditions?.length||!reference.conditions?.length||[...current.conditions,...reference.conditions].some((c:any)=>!c.condition.healthEligible))return fail('当前或参考缺少经过核验的同期工况');
 const mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/values.length;
 for(const [field,tolerance] of [['windSpeed',rule.windTolerance],['rpm',rule.rpmTolerance]] as const){const a=current.conditions.map((c:any)=>c.condition[field]),b=reference.conditions.map((c:any)=>c.condition[field]);if(![...a,...b].every(Number.isFinite)||Math.abs(mean(a)-mean(b))>tolerance)return fail('当前与参考的风速或转速不在配置容差内');}
 if([...(current.report?.records||[]),...(reference.report?.records||[])].some((r:any)=>r.source_quality?.identity_verified!==true||!r.quality_assessment?.analysis_eligible))return fail('实体身份或原始质量尚未核验');
 const blade=String(rule.bladeCode??'');const cs=(current.report.comparisonAggregates||[]).filter((g:any)=>!blade||String(g.blade)===blade),rs=(reference.report.comparisonAggregates||[]).filter((g:any)=>!blade||String(g.blade)===blade);const comparisons=[];
 for(const c of cs){const r=rs.find((r:any)=>r.point===c.point&&r.layer===c.layer&&r.basis===c.basis&&r.radius_from_hub_m===c.radius_from_hub_m&&JSON.stringify(r.commonAngles)===JSON.stringify(c.commonAngles));if(!r||!(r.mean_half_peak_to_peak_m_s>0))return fail('参考测点、方位覆盖、方向或有效幅值不足');comparisons.push({point:c.point,layer:c.layer,angles:c.commonAngles,metric:'equal_azimuth_half_peak_to_peak',current:c.mean_half_peak_to_peak_m_s,reference:r.mean_half_peak_to_peak_m_s,ratio:c.mean_half_peak_to_peak_m_s/r.mean_half_peak_to_peak_m_s});}
 if(!comparisons.length)return fail('缺少共同方位的可比响应');
 const max=Math.max(...comparisons.map(c=>c.ratio));return {status:max>=rule.alarmRatio?'alarm':max>=rule.warningRatio?'warning':'normal',label:max>=rule.alarmRatio?'响应明显异常':max>=rule.warningRatio?'响应变化预警':'配置指标未见异常',reason:'按已保存响应变化规则复核；不代表结构损伤确诊',comparisons};
}
