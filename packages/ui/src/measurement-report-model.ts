/** User-facing presentation of an immutable health snapshot. No health inference from silence. */
export function healthReportStatus(blade: any) {
  if(blade?.syntheticScenario)return `样本检测：${blade.syntheticScenario.detection?.label || '待复核'}（构造样本）`;
  if (!blade?.processingResultId) return (blade?.acquired || blade?.coverage?.acquired) ? '待分析' : '未测量';
  if(blade.standardSnapshot&&blade.healthScreening){
    if(blade.status==='insufficient')return '待复核';
    if(blade.finalDecision?.conclusion==='damaged')return '损伤（人工复核确认）';
    if(blade.finalDecision?.conclusion==='inconclusive')return '待复核';
    if(blade.healthScreening.status==='normal')return blade.healthScreening.baselineMember?'健康（基线样本）':'健康（项目响应标准）';
    return '疑似损伤，待复核';
  }
  if (!blade.ruleSnapshot || !blade.referenceSnapshot || blade.evidenceReadiness?.blockers?.length || blade.status === 'insufficient') return '健康状态未核验';
  if (['warning', 'alarm', 'suspected', 'critical'].includes(blade.status)) return '响应异常，待复核';
  if (['normal', 'within_reference'].includes(blade.status)) return '未触发响应预警';
  return '健康状态未核验';
}

export function reportNumber(value: unknown, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', {maximumFractionDigits: digits}) : '—';
}
export function reportDate(value: unknown) {
  if (value === null || value === undefined || value === '') return '未记录';
  const d = new Date(value as string);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}).format(d) : '未记录';
}
function range(values: any[], unit: string) {
  const finite = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  return finite.length ? `${reportNumber(Math.min(...finite), 2)}～${reportNumber(Math.max(...finite), 2)} ${unit}` : '未匹配';
}
export function measurementReportModel(report: any) {
  const objects = report.objects || [];
  const name = (id: string) => {const o = objects.find((v:any) => v.id === id); return o?.name || o?.code || '未记录';};
  const blades = (report.bladeAssessments || []).map((b:any) => {
    const group = b.commonResponse?.find((g:any) => g.layer === 'los_residual') || b.commonResponse?.[0];
    const ds = (report.displacementSnapshots || []).find((d:any) => d.processingResultId === b.processingResultId);
    const points = (group?.points || []).map((p:any) => {
      const displacement = ds?.points?.filter((d:any) => d.layer === 'los_residual' && d.object?.point === p.point);
      const coverage = b.coverage?.points?.find((c:any) => c.pointName === p.point);
      return {name:p.point, radiusM:p.radiusM, velocityMmS:Number.isFinite(p.mean_half_peak_to_peak_m_s) ? p.mean_half_peak_to_peak_m_s * 1000 : null,
        displacementMm:displacement?.length === 1 && Number.isFinite(displacement[0].mean_half_peak_to_peak_m) ? displacement[0].mean_half_peak_to_peak_m * 1000 : null,
        angles:(coverage?.usableAzimuths || group.azimuths || []).join(' / ')};
    }).sort((a:any,b:any) => a.name.localeCompare(b.name, 'zh-CN', {numeric:true}));
    const conditions = b.conditions || [];
    const shiftedConditions = conditions.some((c:any) => c.condition?.reasons?.some((r:string) => /平移/.test(r))) || [...(b.reasons || []), ...(b.evidenceReadiness?.blockers || [])].some((r:string) => /平移/.test(r));
    const matched = conditions.filter((c:any) => c.condition?.status === 'matched' && Number.isFinite(c.condition.windSpeed) && Number.isFinite(c.condition.rpm));
    const notes: string[] = [];
    const reasons = [...(b.reasons || []), ...(b.evidenceReadiness?.blockers || [])];
    if (!b.standardSnapshot&&(!b.ruleSnapshot || !b.referenceSnapshot)) notes.push('尚未建立正常参考和预警判据，暂不能判断是否健康。');
    if (reasons.some(r => /身份/.test(r))) notes.push('采集记录对应的物理叶片身份仍需现场核对。');
    if (conditions.some((c:any) => c.condition?.reasons?.some((r:string) => /平移|测试副本/.test(r))) || reasons.some(r => /平移|测试副本/.test(r))) notes.push('关联工况含时间平移测试副本，仅供展示，不作为同期实测依据。');
    else if (!b.standardSnapshot&&(conditions.some((c:any) => !c.condition?.healthEligible) || reasons.some(r => /工况/.test(r)))) notes.push('工况关联尚不满足健康评价要求，需核对同期风速、转速及采样口径。');
    if ((b.coverage?.review || 0) > 0) notes.push(`${b.coverage.review} 条记录待复核。`);
    if (b.coverage?.missing?.length) notes.push('部分测点或角度缺失，需要补充测量。');
    if (b.geometryEstimates?.some((c:any) => Number.isFinite(c.values?.radius_from_hub_m))) notes.push('测点位置使用估算尺寸，不作为实测空间定位结果。');
    if (reasons.some(r => /尚未发布/.test(r))) notes.push('当前分析版本尚未发布，健康核验待完成。');
    const known = /身份|参考|判据|阈值|工况|平移|测试副本|缺|质量|复核|诊断|发布/;
    for (const r of reasons) if (typeof r === 'string' && !known.test(r) && !notes.includes(r)) notes.push(r);
    return {id:b.bladeId, name:/^[1-3]$/.test(b.name) ? `叶片 ${b.name}` : b.name,
      status:healthReportStatus(b), acquired:b.coverage?.acquired ?? b.acquired ?? b.coverage?.observed ?? 0,
      analyzable:b.coverage?.analyzable ?? 0, review:b.coverage?.review ?? 0, points,
      estimatedPositions:!!b.geometryEstimates?.some((c:any) => Number.isFinite(c.values?.radius_from_hub_m)),
      matched:matched.length, conditionCount:conditions.length, shiftedConditions,
      wind:range(matched.map((c:any) => c.condition.windSpeed), 'm/s'), rpm:range(matched.map((c:any) => c.condition.rpm), 'rpm'),
      healthStandard:b.standardSnapshot?{id:b.standardSnapshot.id,name:b.standardSnapshot.name,approval:b.standardSnapshot.approval,approvedBy:b.standardSnapshot.approvedBy,validation:b.standardSnapshot.validation}:null,screening:b.healthScreening||null,finalDecision:b.finalDecision||null,
      notes};
  });
  const dates = (report.bladeAssessments || []).flatMap((b:any) => (b.conditions || []).flatMap((c:any) => (c.sourceTimes || []).flatMap((t:any) => [t.start, t.end]))).filter((t:any) => t !== null && t !== undefined && t !== '').map((t:any) => new Date(t).getTime()).filter(Number.isFinite);
  return {title:'叶片测量分析报告', task:name(report.campaignId || report.context?.campaignId), farm:name(report.context?.farmId), turbine:name(report.turbineId || report.context?.turbineId),
    number:report.reportNumber || '未编号', author:report.author || '未记录', created:reportDate(report.createdAt), measured:dates.length ? `${reportDate(Math.min(...dates))} ～ ${reportDate(Math.max(...dates))}` : '未记录',
    blades, acquired:blades.reduce((n:number,b:any) => n+b.acquired,0), analyzable:blades.reduce((n:number,b:any) => n+b.analyzable,0),
    notes:[...new Set<string>(blades.flatMap((b:any) => b.notes))]};
}
