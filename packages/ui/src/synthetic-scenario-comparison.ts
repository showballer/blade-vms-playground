import {compareHealthObservation,responseEnvelopeDecision,healthObservations,healthProcessingSignature,STANDARD_METRICS,STANDARD_ALGORITHM,syntheticProcessing} from './blade-health-standard';

export const SCENARIO_DETECTION_VERSION='scenario-response-envelope-1';
function detection(comparisons:any[]){const result=responseEnvelopeDecision(comparisons);return {...result,label:result.status==='normal'?'响应正常':result.label,algorithmVersion:STANDARD_ALGORITHM,executionVersion:SCENARIO_DETECTION_VERSION,mode:'scenario_validation',formalHealthAssessment:false};}

/** Numeric software test only. Never invent wind eligibility, identity or field diagnosis. */
export function syntheticScenarioComparison(processing:any,bladeCode:string,variant:any){
 const fail=(reason:string)=>({comparisons:[],reason,detection:{...detection([]),reasons:[reason]},formalHealthAssessment:false,structuralDamageConfirmed:false});
 if(!syntheticProcessing(processing)||!variant)return fail('没有已登记的场景来源或参考标准');
 if(![1,2].includes(variant.signatureVersion??1))return fail('参考标准的处理签名版本无效');
 if(healthProcessingSignature(processing,variant.signatureVersion??1)!==variant.signature)return fail('处理配置与参考场景不同，不沿用旧数值对照；请恢复导入时方案');
 const observations=healthObservations(processing,bladeCode);
 if(observations.length!==20||new Set(observations.map((o:any)=>o.point+'|'+o.angle)).size!==20||!['P1','P2','P3','P4','P5'].every(point=>[0,90,180,270].every(angle=>observations.some((o:any)=>o.point===point&&o.angle===angle)))||observations.some((o:any)=>!o.eligible||STANDARD_METRICS.some(m=>!Number.isFinite(o.values[m.key])||o.values[m.key]<0)||!(o.values.rms>0)||!(o.values.amplitude>0)||!(o.values.frequency>0)))return fail('连续段特征或测点角度覆盖不完整');
 const comparisons:any[]=[];
 for(const o of observations){
  const slot=variant.slots.find((s:any)=>s.point===o.point&&s.angle===o.angle);
  if(!slot||slot.sampleRateHz!==o.sampleRateHz||slot.layer!==o.layer||slot.basis!==o.basis||!Number.isFinite(o.radiusM)||Math.abs(slot.radiusM-o.radiusM)>Math.max(.5,slot.radiusM*.02)||!(o.resolutionHz>0)||o.resolutionHz>slot.maximumResolutionHz*2)return fail('位置、采样率、测量方向或频率分辨率与参考场景不同');
  if(STANDARD_METRICS.some(m=>{const l=slot.limits?.[m.key];return !l||![l.min,l.max,l.padding].every(Number.isFinite)||l.min<0||l.max<l.min||l.padding<0;}))return fail('参考阈值无效，请检查已登记标准');
  comparisons.push(...compareHealthObservation(o,slot));
 }
 return {comparisons,detection:detection(comparisons),reason:'场景检测采用健康响应包络判据；关联工况用于背景展示，结构损伤类型需独立检测确认',formalHealthAssessment:false,structuralDamageConfirmed:false};
}
