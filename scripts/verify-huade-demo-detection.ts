/** Verify the customer's saved scenario through the real health endpoint; no waveform mutations. */
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {rows,pool,type User} from '../apps/web/lib/db';
import {objects} from '../apps/web/lib/measurement-store';
import {bladeHealthEndpoint} from '../apps/web/lib/measurement-blade-health';
import {processingResult} from '../apps/web/lib/measurement-processing';
import {syntheticScenarioComparison} from '../packages/ui/src/synthetic-scenario-comparison';
import {listMeasurementRows} from '../apps/web/lib/measurement-store';
async function main(){try{
 const [user]=await rows<User>("SELECT id,username,name,role,tenant,active FROM users WHERE username='admin' AND active=1 AND deleted_at IS NULL");assert(user);
 const all=await objects(user),campaign=all.find(o=>o.active&&o.kind==='campaign'&&o.name==='化德风场B071-20')!;assert(campaign?.turbineIds?.length===1);
 const context={farmId:campaign.parentId,campaignId:campaign.id,turbineId:campaign.turbineIds[0]};
 const w=await bladeHealthEndpoint(user,{action:process.argv.includes('--save')?'evaluate':'workspace',context});assert.equal(w.blades.length,3);
 const registry=(await listMeasurementRows(user,'measurement_synthetic_imports')).find(r=>r.context?.campaignId===campaign.id)!;assert(registry);
 const summary=[];
 for(const b of w.blades){
  const code=all.find(o=>o.id===b.bladeId)!.code,d=b.syntheticScenario?.detection;assert(d);
  assert.equal(d.compared,100);assert.equal(d.status,code==='2'?'alarm':'normal');assert.equal(d.outsideCount,code==='2'?31:0);
  assert.equal(b.label,code==='2'?'疑似损伤':'响应正常');assert.equal(b.conditions.filter((c:any)=>c.condition.status==='matched').length,20);
  assert.equal(b.structuralDamageConfirmed,false);assert.equal(b.finalDecision,null);assert.equal(b.standardSnapshot,null);assert.equal(b.healthScreening,null);
  const p=await processingResult(user,b.processingResultId),renumbered=structuredClone(p);
  for(const r of renumbered.report.records){r.object.blade='9';r.importSource.originalHeader.simulation.hypothesis='ignored_in_detection';}
  assert.deepEqual(syntheticScenarioComparison(renumbered,'9',registry.referenceVariant).detection,d);
  summary.push({blade:b.name,label:b.label,status:d.status,risk:d.riskLevel,compared:d.compared,outside:d.outsideCount,affected:d.affected,points:d.pointEvidence,algorithmVersion:d.algorithmVersion,processingResultId:b.processingResultId,assessmentId:b.assessmentId,matched:20});
 }
 const report={name:campaign.name,context,mode:'scenario_validation',blades:summary,checks:{actualCurrentFeatures:true,numberAndHypothesisIndependent:true,formalPublicationDisabled:true},saved:process.argv.includes('--save')};
 await mkdir('artifacts/化德风场B071-20_20261018',{recursive:true});await writeFile('artifacts/化德风场B071-20_20261018/损伤检测核验.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await pool().end();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
