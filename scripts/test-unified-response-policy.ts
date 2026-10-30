import assert from 'node:assert/strict';
import {responseWarning,damageContract} from '../packages/ui/src/response-health-policy';
import {compareModalResults} from '../packages/ui/src/modal-result-comparison';
const conditions=[{condition:{healthEligible:true,windSpeed:5,rpm:12}}];
function snapshot(id:string,batch:string,amplitude:number){return {id,published:true,context:{farmId:'farm',turbineId:'t',bladeId:'b',campaignId:batch},algorithmVersion:'v22',conditions,report:{workspace:{algorithmOptions:{geometry:{direction:'los'}}},records:[{source_hash:id,source_quality:{identity_verified:true},quality_assessment:{analysis_eligible:true}}],comparisonAggregates:[{blade:'b',point:'P1',layer:'los',basis:'los',radius_from_hub_m:.16,commonAngles:[0,180],mean_half_peak_to_peak_m_s:amplitude}]}};}
const rule={method:'response_ratio',referenceApproval:'Independent known normal batch was reviewed',thresholdSource:'QA explicit rule only',warningRatio:1.5,alarmRatio:2,windTolerance:.5,rpmTolerance:1};
assert.equal(responseWarning(snapshot('current','now',1.6),snapshot('previous','before',1),rule).status,'warning');
assert.equal(responseWarning(snapshot('current','now',2.5),snapshot('previous','before',1),rule).status,'alarm');
assert.equal(responseWarning(snapshot('current','now',1),snapshot('previous','before',1),rule).status,'normal');
assert.equal(responseWarning(snapshot('current','now',2),snapshot('current','before',1),rule).status,'insufficient');
assert.equal(responseWarning(snapshot('current','now',2),snapshot('previous','now',1),rule).status,'insufficient');
const p=snapshot('previous','before',1);p.report.records[0].source_quality.identity_verified=false;assert.equal(responseWarning(snapshot('current','now',2),p,rule).status,'insufficient');
assert.equal(responseWarning(snapshot('current','now',1),snapshot('previous','before',1),null).status,'insufficient');assert.equal(damageContract.status,'algorithm_not_connected');assert.equal(damageContract.output.probability,null);
const shape={nodes:[{pointId:'p1',direction:'axial',real:1,imag:0},{pointId:'p2',direction:'axial',real:0,imag:1}]};
const source={id:'a',context:{farmId:'f',turbineId:'t',bladeId:'b'},sourceSha256:'a',inputSummary:{channels:[{pointId:'p1',direction:'axial',quantity:'velocity'},{pointId:'p2',direction:'axial',quantity:'velocity'}]},result:{method:'ssi_cov',modes:[{naturalFrequencyHz:10,dampingRatio:.02,shape}]}};
const ref={...source,id:'b',sourceSha256:'b',result:{...source.result,modes:[{naturalFrequencyHz:10.1,dampingRatio:.03,shape:{nodes:[{pointId:'p1',direction:'axial',real:0,imag:1},{pointId:'p2',direction:'axial',real:-1,imag:0}]}}]}};
const comparison=compareModalResults(source,ref);assert.equal(comparison.independentMeasurement,true);assert.equal(comparison.rows[0].MAC,1);assert.equal(comparison.healthConclusion,null);const unequal=compareModalResults(source,{...ref,context:{...ref.context,bladeId:'other'}});assert(unequal.limitations.includes('ENTITY_OR_BLADE_SCOPE_MISMATCH'));assert.equal(unequal.rows[0].MAC,null);
console.log('PASS 12 response qualification, independent batch and complex-MAC policy checks');
