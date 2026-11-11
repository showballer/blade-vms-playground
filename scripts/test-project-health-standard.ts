import assert from 'node:assert/strict';
import {buildHealthStandard,evaluateHealthStandard,healthProcessingSignature,healthObservations,standardConditionEligible} from '../packages/ui/src/blade-health-standard';
import {healthReportStatus} from '../packages/ui/src/measurement-report-model';
import {syntheticScenarioComparison} from '../packages/ui/src/synthetic-scenario-comparison';
function source(batch:string,blade:string,gain=1){
 const records=['P1','P2','P3','P4','P5'].flatMap((point,i)=>[0,90,180,270].map(angle=>{const id=`${batch}-${blade}-${point}-${angle}`;return {recording_id:id,source_hash:id,sample_rate_hz:1000,object:{blade,point,azimuth_deg:angle,radius_from_hub_m:(i+1)*10},representative:id,quality_assessment:{analysis_eligible:true},segments:[{result_id:id,layer:'los_residual',basis:'velocity',features:{sample_count:1000,rms_m_s:gain*(i+1),half_peak_to_peak_m_s:gain*(i+1)*2,crest_factor:3,kurtosis_ordinary:3,observation_seconds:1},spectrum:{resolution_hz:1,peaks:[{frequency_hz:100,peak_amplitude_m_s:1}]}}]};}));
 const processing={id:`${batch}-${blade}`,context:{campaignId:batch},published:true,algorithmVersion:'test',report:{records,workspace:{algorithmOptions:{detrend:'linear',window:'hann',geometry:{direction:'los'},measurementMode:'outdoor'},automaticPlan:{requestedBandHz:[50,500]}}}};
 const conditions=records.map(r=>({recordingId:r.recording_id,condition:{status:'matched',windSpeed:8,rpm:10,timeBasis:'interval_mean',timeShiftedForTest:false}}));
 return {processing,conditions,bladeCode:blade,name:batch};
}
const sources=['one','two'].flatMap(batch=>['1','2','3'].map(blade=>source(batch,blade)));
const original=JSON.stringify(sources),standard=buildHealthStandard(sources,'user confirmed healthy samples');
assert.equal(JSON.stringify(sources),original);assert.equal(standard.variants.length,2);assert.equal(standard.variants[0].slots.length,20);
const known=evaluateHealthStandard(sources[0].processing,'1',sources[0].conditions,standard,false);
assert.equal(known.label,'健康');assert.equal(known.baselineMember,true);assert.equal(known.validationMode,'baseline_resubstitution');assert.equal(known.comparisons.length,100);
const independent=source('new','1');let p=independent.processing;
assert.equal(evaluateHealthStandard(p,'1',independent.conditions,standard,false).status,'insufficient');
assert.equal(evaluateHealthStandard(p,'1',independent.conditions,standard,true).label,'健康');
const faulty=structuredClone(independent);faulty.processing.report.records[8].segments[0].features.rms_m_s*=3;faulty.processing.report.records[8].segments[0].features.half_peak_to_peak_m_s*=3;
const detected=evaluateHealthStandard(faulty.processing,'1',faulty.conditions,standard,true);assert.equal(detected.status,'alarm');assert.equal(detected.label,'疑似损伤');assert.equal(detected.structuralDamageConfirmed,false);assert(detected.comparisons.some(c=>c.point==='P3'&&c.outside));
const freq=structuredClone(independent);freq.processing.report.records[0].segments[0].spectrum.peaks[0].frequency_hz=300;assert.equal(evaluateHealthStandard(freq.processing,'1',freq.conditions,standard,true).status,'warning');
const quality=structuredClone(faulty);quality.processing.report.records[8].quality_assessment.analysis_eligible=false;assert.equal(evaluateHealthStandard(quality.processing,'1',quality.conditions,standard,true).status,'insufficient');
const missing=structuredClone(independent);missing.processing.report.records.pop();assert.equal(evaluateHealthStandard(missing.processing,'1',missing.conditions,standard,true).status,'insufficient');
const config=structuredClone(independent);config.processing.report.workspace.algorithmOptions.detrend='constant';assert.equal(evaluateHealthStandard(config.processing,'1',config.conditions,standard,true).status,'insufficient');
const outOfCondition=structuredClone(independent);outOfCondition.conditions[0].condition.windSpeed=20;assert.equal(evaluateHealthStandard(outOfCondition.processing,'1',outOfCondition.conditions,standard,true).status,'insufficient');
const shifted=structuredClone(independent);shifted.conditions[0].condition.timeShiftedForTest=true;assert.equal(evaluateHealthStandard(shifted.processing,'1',shifted.conditions,standard,true).status,'insufficient');
const badRadius=structuredClone(independent);badRadius.processing.report.records[0].object.radius_from_hub_m=99;assert.equal(evaluateHealthStandard(badRadius.processing,'1',badRadius.conditions,standard,true).status,'insufficient');
assert.throws(()=>buildHealthStandard([sources[0],sources[0]],'confirm'));assert.throws(()=>buildHealthStandard(sources.map(s=>({...s,processing:{...s.processing,published:false}})),'confirm'));
assert.equal(standardConditionEligible({status:'matched',windSpeed:8,rpm:10,timeBasis:'interval_mean'}),true);
assert.equal(standardConditionEligible({status:'matched',windSpeed:8,rpm:10,timeBasis:'unknown'}),false);
assert.equal(healthProcessingSignature(p),healthProcessingSignature(structuredClone(p)));assert.equal(healthObservations(p,'1').length,20);
const snap={processingResultId:p.id,healthScreening:detected,standardSnapshot:{id:'s'},status:'alarm'};
assert.equal(healthReportStatus(snap),'疑似损伤，待复核');assert.equal(healthReportStatus({...snap,finalDecision:{conclusion:'damaged'}}),'损伤（人工复核确认）');
assert.equal(healthReportStatus({...snap,status:'normal',healthScreening:known}),'健康（基线样本）');
console.log('PASS project health standard: known healthy membership, independent screening, speed/frequency anomalies, quality/config/conditions/geometry guards, provenance, immutable inputs and report decisions');

const lowResolution=structuredClone(independent);lowResolution.processing.report.records[0].segments[0].spectrum.resolution_hz=100;assert.equal(evaluateHealthStandard(lowResolution.processing,'1',lowResolution.conditions,standard,true).status,'insufficient');
const hidden=structuredClone(independent);const other=structuredClone(hidden.processing.report.records[0].segments[0]);other.result_id='nonrepresentative';other.features.rms_m_s*=4;other.features.half_peak_to_peak_m_s*=4;hidden.processing.report.records[0].segments.push(other);assert.equal(evaluateHealthStandard(hidden.processing,'1',hidden.conditions,standard,true).label,'疑似损伤');
console.log('PASS nonrepresentative continuous-segment anomaly and insufficient spectral resolution guards');
const synthetic:any=structuredClone(faulty.processing);synthetic.report.records.forEach((r:any)=>r.importSource={originalHeader:{source:'simulation',simulation:{hypothesis:'crack'}}});
assert.equal(evaluateHealthStandard(synthetic,'1',independent.conditions,standard,true).status,'insufficient');
assert.throws(()=>buildHealthStandard(sources.map((s,i)=>i? s:{...s,processing:synthetic}),'confirm'),/合成情景/);
const numeric=syntheticScenarioComparison(synthetic,'1',standard.variants[0]);assert.equal(numeric.comparisons.length,100);assert(numeric.comparisons.some(c=>c.outside));assert.equal(numeric.structuralDamageConfirmed,false);assert.equal(numeric.formalHealthAssessment,false);
const changed=structuredClone(synthetic);changed.report.workspace.algorithmOptions.detrend='constant';assert.equal(syntheticScenarioComparison(changed,'1',standard.variants[0]).comparisons.length,0);
assert.equal(healthReportStatus({processingResultId:'s',syntheticScenario:{},label:'损伤'}),'检测结果：待复核');
console.log('PASS synthetic isolation, no healthy baseline/publication, numeric comparison recomputed and invalidated by configuration changes');

// Detection must follow computed features, never the scenario's blade number or declared defect.
assert.equal(numeric.detection.status,detected.status);
assert.equal(numeric.detection.riskLevel,detected.riskLevel);
assert.deepEqual(numeric.comparisons,detected.comparisons);
assert.equal(numeric.detection.label,'疑似损伤');
const renumbered=structuredClone(synthetic);renumbered.report.records.forEach((r:any)=>{r.object.blade='3';r.importSource.originalHeader.simulation.hypothesis='healthy_control_derived';});
assert.deepEqual(syntheticScenarioComparison(renumbered,'3',standard.variants[0]).detection,numeric.detection);
const healthySecond:any=structuredClone(source('demo-healthy','2').processing);
healthySecond.report.records.forEach((r:any)=>r.importSource={originalHeader:{source:'simulation',simulation:{hypothesis:'crack'}}});
const healthyDetection=syntheticScenarioComparison(healthySecond,'2',standard.variants[0]);
assert.equal(healthyDetection.detection.status,'normal');assert.equal(healthyDetection.detection.label,'响应正常');assert.equal(healthyDetection.detection.outsideCount,0);
assert.equal(syntheticScenarioComparison(changed,'1',standard.variants[0]).detection.status,'insufficient');
const noPoint=structuredClone(synthetic);noPoint.report.records.pop();assert.equal(syntheticScenarioComparison(noPoint,'1',standard.variants[0]).detection.status,'insufficient');
const noQuality=structuredClone(synthetic);noQuality.report.records[0].quality_assessment.analysis_eligible=false;assert.equal(syntheticScenarioComparison(noQuality,'1',standard.variants[0]).detection.status,'insufficient');
const invalidLimits=structuredClone(standard.variants[0]);invalidLimits.slots[0].limits.rms.max=NaN;assert.equal(syntheticScenarioComparison(synthetic,'1',invalidLimits).detection.status,'insufficient');
assert.equal(healthReportStatus({syntheticScenario:{detection:numeric.detection},label:'损伤'}),'检测结果：疑似损伤');
assert.equal(healthReportStatus({syntheticScenario:{detection:healthyDetection.detection},label:'健康'}),'检测结果：响应正常');
console.log('PASS shared detector: feature-driven alarms, blade/hypothesis independence, healthy blade 2, fail-closed quality/config/threshold checks and explicit sample provenance');

// Response-only reference is explicit; legacy standards still require contemporaneous conditions.
const responseSources=sources.slice(0,3).map(s=>({...structuredClone(s),conditions:[]}));
const responseSourceJson=JSON.stringify(responseSources);
const responseStandard=buildHealthStandard(responseSources,'user declared these three blades healthy',{mode:'response_reference'});
assert.equal(JSON.stringify(responseSources),responseSourceJson);
assert.equal(responseStandard.mode,'response_reference');
assert.equal(responseStandard.policy.conditionsRequired,false);
assert.equal(responseStandard.variants[0].windRange,null);
assert.throws(()=>buildHealthStandard(responseSources,'confirm'),/两个独立批次/);
for(const s of responseSources){
 const result=evaluateHealthStandard(s.processing,s.bladeCode,[],responseStandard,false);
 assert.equal(result.status,'normal');assert.equal(result.label,'健康');assert.equal(result.baselineMember,true);
 assert.equal(result.comparisons.length,100);assert.equal(result.formalHealthAssessment,false);
 assert.match(result.scopeNote||'',/未控制风速和转速差异/);
}
const responseIndependent=evaluateHealthStandard(p,'1',[],responseStandard,true);
assert.equal(responseIndependent.label,'响应正常');assert.equal(responseIndependent.baselineMember,false);
assert.equal(healthReportStatus({...snap,status:'normal',healthScreening:responseIndependent}),'响应正常（健康参考范围内）');
assert.equal(evaluateHealthStandard(p,'1',[],responseStandard,false).status,'insufficient');
assert.equal(evaluateHealthStandard(faulty.processing,'1',[],responseStandard,true).status,'alarm');
assert.equal(evaluateHealthStandard(freq.processing,'1',[],responseStandard,true).status,'warning');
for(const blocked of [missing,config,quality,badRadius,lowResolution])assert.equal(evaluateHealthStandard(blocked.processing,'1',[],responseStandard,true).status,'insufficient');
assert.equal(evaluateHealthStandard(synthetic,'1',[],responseStandard,true).status,'insufficient');
assert.equal(evaluateHealthStandard(p,'1',[],standard,true).status,'insufficient');
assert.equal(evaluateHealthStandard(p,'1',[],{...responseStandard,mode:'unknown'},true).status,'insufficient');
const corruptStandard=structuredClone(responseStandard);corruptStandard.variants[0].slots[0].limits.rms.max=NaN;
assert.equal(evaluateHealthStandard(p,'1',[],corruptStandard,true).status,'insufficient');
assert.throws(()=>buildHealthStandard(responseSources,'confirm',{mode:'unknown' as any}),/类型无效/);
console.log('PASS explicit response reference: six guard categories, baseline resubstitution, independent anomaly screening, immutable inputs and fail-closed mode/thresholds');

// Identical geometry attached to different recording IDs is the same calculation.
const geometries=responseSources.map(s=>{
 const copy:any=structuredClone(s),g=copy.processing.report.workspace.algorithmOptions.geometry;
 g.inputOverrides={values:{hub_height_m:90},source:`review-${s.bladeCode}`};
 g.recordOverrides=Object.fromEntries(copy.processing.report.records.map((r:any)=>[r.recording_id,{values:{radius_from_hub_m:r.object.radius_from_hub_m,horizontal_distance_m:78},source:r.recording_id}]));
 return copy;
});
const geometryBefore=JSON.stringify(geometries);
assert.equal(new Set(geometries.map(s=>healthProcessingSignature(s.processing,2))).size,1);
assert.equal(new Set(geometries.map(s=>healthProcessingSignature(s.processing))).size,3);
const mapped=buildHealthStandard(geometries,'confirmed',{mode:'response_reference'});
assert.equal(mapped.variants.length,1);
assert.equal(JSON.stringify(geometries),geometryBefore);
const changedGeometry=structuredClone(geometries[1].processing);
Object.values<any>(changedGeometry.report.workspace.algorithmOptions.geometry.recordOverrides)[0].values.horizontal_distance_m=100;
assert.notEqual(healthProcessingSignature(changedGeometry,2),healthProcessingSignature(geometries[1].processing,2));
assert.equal(evaluateHealthStandard(changedGeometry,'2',[],mapped,true).status,'insufficient');
console.log('PASS geometry signature: distinct record IDs/provenance match, numerical overrides stay guarded');

// Saved legacy standards must still compare against their original, unnormalized signature.
const legacy=structuredClone(mapped),legacyProcessing:any=structuredClone(geometries[0].processing);
delete legacy.variants[0].signatureVersion;
legacy.variants[0].signature=healthProcessingSignature(legacyProcessing);
assert.equal(evaluateHealthStandard(legacyProcessing,'1',[],legacy,false).status,'normal');
legacyProcessing.syntheticScenario={id:'legacy-scenario'};
assert.equal(syntheticScenarioComparison(legacyProcessing,'1',legacy.variants[0]).comparisons.length,100);
const badSignature=structuredClone(mapped);badSignature.variants[0].signatureVersion=99;
assert.equal(evaluateHealthStandard(geometries[0].processing,'1',[],badSignature,false).status,'insufficient');
assert.equal(syntheticScenarioComparison(legacyProcessing,'1',badSignature.variants[0]).detection.status,'insufficient');
console.log('PASS legacy signature compatibility and unknown-version rejection');
