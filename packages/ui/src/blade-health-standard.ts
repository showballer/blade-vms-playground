/** Project-specific response envelope; no fitted seam values or natural-frequency claims. */
export const STANDARD_ALGORITHM = 'blade-response-envelope-1.1';
export type HealthStandardMode = 'same_condition' | 'response_reference';
export function healthStandardMode(value:unknown):HealthStandardMode {
 if(value===undefined||value==='same_condition')return 'same_condition';
 if(value==='response_reference')return value;
 throw Error('健康标准类型无效');
}
export const STANDARD_METRICS = [
  {key:'rms',name:'速度 RMS',unit:'m/s',margin:.10},
  {key:'amplitude',name:'速度半峰峰值',unit:'m/s',margin:.10},
  {key:'frequency',name:'主响应峰频率',unit:'Hz',margin:.05},
  {key:'crest',name:'峰值因子',unit:'',margin:.20},
  {key:'kurtosis',name:'峭度',unit:'',margin:.20},
] as const;
const finite=(v:any):v is number=>typeof v==='number'&&Number.isFinite(v);
const median=(a:number[])=>{const s=[...a].sort((x,y)=>x-y);return s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;};
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function syntheticProcessing(p:any){return !!p?.syntheticScenario||(p?.report?.records||[]).some((r:any)=>{const h=r.importSource?.originalHeader||{};return h.source==='simulation'||h.source==='demo'||h.source==='mock'||!!h.simulation||h.dataOrigin==='synthetic';});}
function comparableGeometry(p:any,geometry:any){
 if(!geometry)return geometry;
 const result={...geometry};
 if(geometry.inputOverrides)result.inputOverrides={values:geometry.inputOverrides.values};
 if(geometry.recordOverrides){
  const records=new Map<string,any>((p.report?.records||[]).map((r:any)=>[r.recording_id,r]));
  // IDs and provenance text identify the source, not the numerical setup. Keep the
  // point/angle mapping and every override value so real geometry changes still fail.
  result.recordOverrides=Object.entries(geometry.recordOverrides).map(([id,override]:[string,any])=>{
   const record=records.get(id);
   return record?{point:record.object?.point,angle:record.object?.azimuth_deg,values:override.values}:{unresolvedRecordId:id,values:override.values};
  }).sort((a,b)=>JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
 }
 return result;
}
export function healthProcessingSignature(p:any,version=1){
 const o=p.report?.workspace?.algorithmOptions||p.workspace?.algorithmOptions||{};
 // Existing standards have no signatureVersion and must retain their original comparison.
 if(version!==1&&version!==2)throw Error('健康标准处理签名版本无效');
 return JSON.stringify(canonical({algorithm:p.algorithmVersion,detrend:o.detrend,window:o.window,filterKind:o.filterKind,filterOrder:o.filterOrder,lowHz:o.lowHz,highHz:o.highHz,measurementMode:o.measurementMode,targetBandMode:o.targetBandMode,targetBandHz:o.targetBandHz,geometry:version===2?comparableGeometry(p,o.geometry):o.geometry}));
}
export function healthObservations(p:any,bladeCode:string){
 return (p.report?.records||[]).filter((r:any)=>String(r.object?.blade)===bladeCode).map((r:any)=>{
  const s=(r.segments||[]).find((s:any)=>s.result_id===r.representative),f=s?.features||{},segments=(r.segments||[]).filter((v:any)=>v.layer===s?.layer&&v.basis===s?.basis);
  const maximum=(key:string)=>{const selected=['crest_factor','kurtosis_ordinary'].includes(key)?segments.filter((v:any)=>v.features?.sample_count>=32):segments;const values=selected.map((v:any)=>v.features?.[key]);return values.length&&values.every(finite)?Math.max(...values):undefined;};
  const band=p.report?.workspace?.automaticPlan?.requestedBandHz||[100,20000];
  const peaks=(s?.spectrum?.peaks||[]).filter((v:any)=>finite(v.frequency_hz)&&v.frequency_hz>=band[0]&&v.frequency_hz<=band[1]&&finite(v.peak_amplitude_m_s)).sort((a:any,b:any)=>b.peak_amplitude_m_s-a.peak_amplitude_m_s);
  return {recordingId:r.recording_id,sourceHash:r.source_hash,point:String(r.object?.point||''),angle:r.object?.azimuth_deg,radiusM:r.object?.radius_from_hub_m,
   layer:s?.layer,basis:s?.basis,sampleRateHz:r.sample_rate_hz,resolutionHz:s?.spectrum?.resolution_hz??(f.observation_seconds>0?1/f.observation_seconds:null),
   featureCoverage:{totalSegments:segments.length,shapeSegments:segments.filter((v:any)=>v.features?.sample_count>=32).length,shortShapeExcluded:segments.filter((v:any)=>v.features?.sample_count<32).length},eligible:r.quality_assessment?.analysis_eligible===true&&!!s,values:{rms:maximum('rms_m_s'),amplitude:maximum('half_peak_to_peak_m_s'),frequency:peaks[0]?.frequency_hz,crest:maximum('crest_factor'),kurtosis:maximum('kurtosis_ordinary')}};
 });
}
export function standardConditionEligible(c:any){
 return !!c&&c.status==='matched'&&finite(c.windSpeed)&&c.windSpeed>=0&&finite(c.rpm)&&c.rpm>0&&!c.timeShiftedForTest&&!c.conflictingSamples&&['interval_mean','instantaneous'].includes(c.timeBasis)&&!(c.reasons||[]).some((r:string)=>/语义尚未确认/.test(r));
}
/** Shared numerical rules. Eligibility/provenance checks remain the caller's responsibility. */
export function compareHealthObservation(o:any,slot:any){
 return STANDARD_METRICS.map(m=>{const l=slot.limits[m.key],value=o.values[m.key],extra=m.key==='frequency'?Math.max(0,o.resolutionHz-l.padding):0,min=Math.max(0,l.min-extra),max=l.max+extra,excess=value<min?(min-value)/Math.max(max-min,1e-9):value>max?(value-max)/Math.max(max-min,1e-9):0;return {recordingId:o.recordingId,point:o.point,angle:o.angle,metric:m.key,name:m.name,unit:m.unit,value,min,max,observedMin:l.observedMin,observedMax:l.observedMax,excess,outside:excess>1e-10};});
}
export function responseEnvelopeDecision(comparisons:any[]){
 const outside=comparisons.filter(c=>c.outside),affected=new Set(outside.map(c=>c.recordingId));
 const multi=[...affected].some(id=>outside.filter(c=>c.recordingId===id).length>=2);
 const normal=!outside.length,level=multi||affected.size>=2?'alarm':'warning';
 const pointEvidence=[...new Set(outside.map(c=>c.point))].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true})).map(point=>{const items=outside.filter(c=>c.point===point);return {point,angles:[...new Set(items.map(c=>c.angle))].sort((a,b)=>a-b),metrics:[...new Set(items.map(c=>c.name))],outsideCount:items.length};});
 const valid=comparisons.length>0&&comparisons.every(c=>finite(c.value)&&finite(c.min)&&finite(c.max)&&c.min<=c.max&&finite(c.excess));
 return {status:valid?(normal?'normal':level):'insufficient',label:valid?(normal?'健康':'疑似损伤'):'待复核',riskLevel:valid?(normal?'normal':level==='alarm'?'high':'medium'):'unknown',
  reasons:!valid?['缺少可比较的有效指标']:normal?[]:[`${affected.size} 个测点/角度、${outside.length} 项响应指标超出健康包络`],
  compared:comparisons.length,outsideCount:outside.length,affected:affected.size,pointEvidence,severity:outside.reduce((n,c)=>n+c.excess,0),structuralDamageConfirmed:false};
}
export function buildHealthStandard(sources:any[],approval:string,options:{mode?:HealthStandardMode}={}){
 const mode=healthStandardMode(options.mode),responseOnly=mode==='response_reference';
 if(!approval?.trim()||sources.length<(responseOnly?3:2)||sources.length>60)throw Error('请选择完整健康来源并填写确认依据');
 if(new Set(sources.map(s=>s.processing.id)).size!==sources.length)throw Error('健康来源不可重复');
 if(!responseOnly&&new Set(sources.map(s=>s.processing.context.campaignId)).size<2)throw Error('同工况健康标准至少需要两个独立批次');
 const hashes=new Set<string>(),variants:any[]=[];
 for(const source of sources){
  const p=source.processing,obs=healthObservations(p,source.bladeCode);
  if(syntheticProcessing(p))throw Error('合成情景不能作为已知健康实测基线');
  if(!p.published||obs.length!==20||obs.some((o:any)=>!o.eligible||!o.sourceHash||!finite(o.radiusM)||!finite(o.sampleRateHz)||!finite(o.resolutionHz)||o.resolutionHz<=0||o.sampleRateHz<=0||!o.layer||!o.basis||!o.point||![0,90,180,270].includes(o.angle)||STANDARD_METRICS.some(m=>!finite(o.values[m.key])||o.values[m.key]<0)))throw Error('基线需已发布、质量合格且覆盖 P1–P5 四角度的完整20条记录和五项特征');
  if(new Set(obs.map((o:any)=>`${o.point}|${o.angle}`)).size!==20||!['P1','P2','P3','P4','P5'].every(point=>obs.filter((o:any)=>o.point===point).length===4))throw Error('基线测点或角度覆盖不完整');
  for(const o of obs){if(hashes.has(o.sourceHash))throw Error('基线来源存在重复波形，不计作独立样本');hashes.add(o.sourceHash);}
  const conditions=source.conditions||[];
  if(!responseOnly&&(conditions.length!==obs.length||conditions.some((c:any)=>!standardConditionEligible(c.condition))))throw Error('基线需要真实同期风速与主轴转速；均值可作平均工况，时间平移副本不可用');
  const signature=healthProcessingSignature(p,2);
  let variant=variants.find(v=>v.campaignId===p.context.campaignId&&v.signature===signature);
  if(!variant){variant={campaignId:p.context.campaignId,name:source.name,signature,signatureVersion:2,sources:[],slots:[],wind:[],rpm:[]};variants.push(variant);}
  variant.sources.push({processingResultId:p.id,bladeCode:source.bladeCode,sourceHashes:obs.map((o:any)=>o.sourceHash)});
  for(const c of conditions.filter((c:any)=>standardConditionEligible(c.condition))){variant.wind.push(c.condition.windSpeed);variant.rpm.push(c.condition.rpm);}
  for(const o of obs){
   let slot=variant.slots.find((s:any)=>s.point===o.point&&s.angle===o.angle);
   if(!slot){slot={point:o.point,angle:o.angle,radiusM:o.radiusM,layer:o.layer,basis:o.basis,sampleRateHz:o.sampleRateHz,samples:[]};variant.slots.push(slot);}
   if(Math.abs(slot.radiusM-o.radiusM)>.01||slot.layer!==o.layer||slot.basis!==o.basis||slot.sampleRateHz!==o.sampleRateHz)throw Error('同一基线场景的测量方向、采样率或测点半径不同，请分别建立标准');
   slot.samples.push(o);
  }
 }
 for(const v of variants){
  if(new Set(v.sources.map((s:any)=>s.bladeCode)).size<3)throw Error('每个基线场景需覆盖至少三片经确认的健康叶片');
  v.windRange=v.wind.length?[Math.max(0,Math.min(...v.wind)-.5),Math.max(...v.wind)+.5]:null;v.rpmRange=v.rpm.length?[Math.max(0,Math.min(...v.rpm)-.5),Math.max(...v.rpm)+.5]:null;delete v.wind;delete v.rpm;
  for(const s of v.slots){s.maximumResolutionHz=Math.max(...s.samples.map((o:any)=>o.resolutionHz));s.limits=Object.fromEntries(STANDARD_METRICS.map(m=>{const values=s.samples.map((o:any)=>o.values[m.key]),lo=Math.min(...values),hi=Math.max(...values),padding=m.key==='frequency'?Math.max(...s.samples.map((o:any)=>o.resolutionHz),median(values)*m.margin):Math.max(Math.abs(median(values))*m.margin,1e-9);return [m.key,{min:Math.max(0,lo-padding),max:hi+padding,observedMin:lo,observedMax:hi,padding,count:values.length}];}));delete s.samples;}
  v.slots.sort((a:any,b:any)=>a.point.localeCompare(b.point)||a.angle-b.angle);
 }
 return {algorithmVersion:STANDARD_ALGORITHM,mode,approval:approval.trim(),variants,policy:{velocityMargin:.10,frequencyMargin:.05,shapeMargin:.20,windTolerance:.5,rpmTolerance:.5,radiusToleranceM:.5,radiusToleranceRatio:.02,conditionsRequired:!responseOnly},purpose:responseOnly?'用户确认健康样本的响应参考；未控制工况差异，不直接作结构健康确诊':'项目健康响应包络；异常筛查不直接确诊裂纹或腐蚀',validation:`${new Set(sources.map(s=>s.processing.context.campaignId)).size} 批已知健康样本；基线回代不代表独立验证，损伤检出率和误报率待新样本验证`};
}
export function evaluateHealthStandard(p:any,bladeCode:string,conditions:any[],standard:any,identityConfirmed:boolean){
 const fail=(reason:string,comparisons:any[]=[])=>({status:'insufficient',label:'待复核',reasons:[reason],comparisons,algorithmVersion:STANDARD_ALGORITHM,baselineMember:false});
 if(!standard?.variants?.length)return fail('请先建立并发布健康标准');
 if(syntheticProcessing(p))return fail('合成情景仅供数值对照，不进入正式健康评价');
 if(standard.algorithmVersion!==STANDARD_ALGORITHM)return fail('健康标准算法版本已变化，请重新发布标准');
 let mode:HealthStandardMode;try{mode=healthStandardMode(standard.mode);}catch{return fail('健康标准类型无效，请重新发布');}
 const responseOnly=mode==='response_reference';
 if(!p.published)return fail('请先保存发布整叶片分析版本');
 const obs=healthObservations(p,bladeCode);
 if(standard.variants.some((v:any)=>![1,2].includes(v.signatureVersion??1)))return fail('健康标准处理签名版本无效，请重新发布');
 if(obs.length!==20||new Set(obs.map((o:any)=>`${o.point}|${o.angle}`)).size!==20||obs.some((o:any)=>!o.eligible||STANDARD_METRICS.some(m=>!finite(o.values[m.key])||o.values[m.key]<0)||!(o.values.rms>0)||!(o.values.amplitude>0)||!(o.values.frequency>0)||!(o.resolutionHz>0)))return fail('有效特征或 P1–P5 四角度覆盖不足；缺项不补零、不判健康');
 const member=standard.variants.find((v:any)=>v.sources.some((s:any)=>s.processingResultId===p.id&&s.bladeCode===bladeCode&&JSON.stringify([...s.sourceHashes].sort())===JSON.stringify(obs.map((o:any)=>o.sourceHash).sort())));
 if(!member&&!identityConfirmed)return fail('请先核验本批次叶片身份、测点及角度分组');
 if(!responseOnly&&(conditions.length!==20||conditions.some(c=>!standardConditionEligible(c.condition))))return fail('缺少可用同期工况，或工况为时间平移/语义未确认副本');
 const candidates=standard.variants.filter((v:any)=>v.signature===healthProcessingSignature(p,v.signatureVersion??1)&&obs.every((o:any)=>{const s=v.slots.find((s:any)=>s.point===o.point&&s.angle===o.angle);return s&&finite(o.radiusM)&&Math.abs(s.radiusM-o.radiusM)<=Math.max(.5,s.radiusM*.02)&&s.layer===o.layer&&s.basis===o.basis&&s.sampleRateHz===o.sampleRateHz&&o.resolutionHz<=s.maximumResolutionHz*2;})&&(responseOnly||conditions.every(c=>v.windRange&&v.rpmRange&&c.condition.windSpeed>=v.windRange[0]&&c.condition.windSpeed<=v.windRange[1]&&c.condition.rpm>=v.rpmRange[0]&&c.condition.rpm<=v.rpmRange[1])));
 if(!candidates.length)return fail('当前处理配置、测点半径、采样率、频率分辨率或工况超出标准适用范围；请补充可比健康基线，不能据此判损伤');
 // A complete scenario is compared as a whole; never cherry-pick per-point limits.
 const evaluations=candidates.map((v:any)=>{
  const comparisons=obs.flatMap((o:any)=>compareHealthObservation(o,v.slots.find((s:any)=>s.point===o.point&&s.angle===o.angle)));
  const decision=responseEnvelopeDecision(comparisons);
  return {variant:v,comparisons,outside:comparisons.filter((c:any)=>c.outside),affected:decision.affected,severity:decision.severity,level:decision.status};
 }).sort((a:any,b:any)=>a.outside.length-b.outside.length||a.severity-b.severity);
 const e=evaluations[0];
 if(e.level==='insufficient')return fail('健康标准阈值或比较结果无效，请重新发布标准',e.comparisons);
 const normal=!e.outside.length;
 return {status:normal?'normal':e.level,label:normal?(responseOnly&&!member?'响应正常':'健康'):'疑似损伤',reasons:normal?[]:[`${e.affected} 个测点/角度、${e.outside.length} 项响应指标超出健康包络，需结合工况及巡检复核`],comparisons:e.comparisons,variantName:e.variant.name,variantCampaignId:e.variant.campaignId,algorithmVersion:STANDARD_ALGORITHM,baselineMember:!!member,validationMode:member?'baseline_resubstitution':'independent_screening',assessmentScope:mode,...(responseOnly?{formalHealthAssessment:false,scopeNote:'按用户确认健康样本的响应范围筛查，未控制风速和转速差异；超限需排查工况与测量原因。'}:{}),riskLevel:normal?'normal':e.level==='alarm'?'high':'medium',structuralDamageConfirmed:false};
}
