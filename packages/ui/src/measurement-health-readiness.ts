/** Association is independent of the evidence required for a structural assessment. */
export function resolveHealthWindDataset(choices: {id:string}[], requested: unknown, saved?: {windDatasetId:string} | null) {
  if (requested !== undefined && typeof requested !== 'string') throw Error('风场数据集编号无效');
  const id = requested !== undefined ? requested as string : saved ? saved.windDatasetId : choices.length === 1 ? choices[0].id : '';
  if (id && !choices.some(d => d.id === id)) {
    if (requested !== undefined) throw Error('风场数据集不存在或不属于当前风场');
    return {id:'',source:'unavailable' as const};
  }
  return {id,source:requested !== undefined ? 'selected' as const : saved ? 'saved' as const : id ? 'single_dataset' as const : 'unselected' as const};
}

export function healthEvidenceReadiness({conditions,records,rule,reference,published}:{conditions:any[];records:any[];rule:any;reference:any;published:boolean}) {
  const matched = conditions.filter(c => c.condition.status === 'matched' && Number.isFinite(c.condition.windSpeed) && Number.isFinite(c.condition.rpm)).length;
  const blockers = [
    ...(!published ? ['当前整叶片分析尚未发布'] : []),
    ...(records.some(r => r.source_quality?.identity_verified !== true) ? ['待核验测量记录对应的物理叶片身份'] : []),
    ...(records.some(r => !r.quality_assessment?.analysis_eligible) ? ['部分记录质量待复核'] : []),
    ...(!rule ? ['尚未配置正常参考和响应预警阈值'] : !reference ? ['配置的正常参考版本不可用'] : []),
    ...(conditions.some(c => !c.condition.healthEligible) ? ['工况仅满足背景展示，尚不满足当前正式评价规则'] : []),
  ];
  return {matched,total:conditions.length,association:matched === conditions.length && matched > 0 ? 'matched' : matched ? 'partial' : 'unmatched',blockers};
}
