export function compareModalResults(current:any,reference:any){
 const reasons:string[]=[];for(const k of ['farmId','turbineId','bladeId'])if(!current.context?.[k]||current.context[k]!==reference.context?.[k])reasons.push('ENTITY_OR_BLADE_SCOPE_MISMATCH');
 if(current.result?.method!==reference.result?.method)reasons.push('METHOD_MISMATCH');
 const a=current.inputSummary?.channels||[],b=reference.inputSummary?.channels||[];if(a.some((c:any)=>!b.some((d:any)=>d.pointId===c.pointId&&d.direction===c.direction&&d.quantity===c.quantity)))reasons.push('DIRECTION_OR_NODE_COVERAGE_MISMATCH');
 const independent=current.sourceSha256!==reference.sourceSha256;
 const rows=(current.result?.modes||[]).map((m:any,i:number)=>{
  const candidates=(reference.result?.modes||[]).map((r:any,j:number)=>({r,j})).filter(({r}:any)=>Math.abs(m.naturalFrequencyHz/r.naturalFrequencyHz-1)<=.15).sort((a:any,b:any)=>Math.abs(a.r.naturalFrequencyHz-m.naturalFrequencyHz)-Math.abs(b.r.naturalFrequencyHz-m.naturalFrequencyHz));
  const best=candidates[0];if(!best)return {mode:i+1,status:'unmatched',reason:'NO_FREQUENCY_CANDIDATE_WITHIN_15_PERCENT'};
  const r=best.r;let mac:number|null=null;
  if(m.shape&&r.shape&&!reasons.length){const pairs=m.shape.nodes.map((n:any)=>[n,r.shape.nodes.find((v:any)=>v.pointId===n.pointId&&v.direction===n.direction)]);if(pairs.every((v:any)=>v[1])&&pairs.length===r.shape.nodes.length){let real=0,imag=0,aa=0,bb=0;for(const [x,y] of pairs){real+=x.real*y.real+x.imag*y.imag;imag+=x.real*y.imag-x.imag*y.real;aa+=x.real*x.real+x.imag*x.imag;bb+=y.real*y.real+y.imag*y.imag;}if(aa>0&&bb>0)mac=(real*real+imag*imag)/(aa*bb);}}
  return {mode:i+1,referenceMode:best.j+1,status:reasons.length?'limited_comparison':'comparable',frequencyChangeHz:m.naturalFrequencyHz-r.naturalFrequencyHz,frequencyRelativeChange:m.naturalFrequencyHz/r.naturalFrequencyHz-1,dampingChange:m.dampingRatio-r.dampingRatio,MAC:mac,shapeReason:mac===null?'缺少同方向、同节点的合格复振型':null};
 });
 // Ambiguous matching remains a candidate; no reuse of one reference mode as
 // several independently matched modes and no frequency-drop damage inference.
 const used=new Set<number>();for(const r of rows){if(r.referenceMode!==undefined){if(used.has(r.referenceMode)){r.status='ambiguous';r.MAC=null;r.shapeReason='多个候选对应同一参考模态，需人工复核';}used.add(r.referenceMode);}}
 return {version:'modal-comparison-2.2',currentId:current.id,referenceId:reference.id,independentMeasurement:independent,limitations:[...new Set(reasons),...(!independent?['SAME_INPUT_DIFFERENT_PROCESSING_NOT_INDEPENDENT_MEASUREMENT']:[])],matchingFrequencyRelativeTolerance:.15,rows,healthConclusion:null};
}
