/** Generate an isolated, labelled synthetic dataset. Never writes measured rows or health decisions. */
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {rows,pool,type User} from '../apps/web/lib/db';
import {listMeasurementRows} from '../apps/web/lib/measurement-store';
import {processingResult} from '../apps/web/lib/measurement-processing';
import {rotationDataDirectory} from '../apps/web/lib/rotation';
import {healthObservations,STANDARD_METRICS} from '../packages/ui/src/blade-health-standard';

const output=path.resolve(process.argv.find(s=>s.startsWith('--output='))?.slice(9)||'artifacts/R025-crack-scenario-20261110');
async function main(){try{
 const [user]=await rows<User>("SELECT id,username,name,role,tenant,active FROM users WHERE username='admin' AND active=1 AND deleted_at IS NULL");
 if(!user)throw Error('Existing local administrator required');
 const standards=await listMeasurementRows(user,'measurement_health_standards');
 const standard=standards.filter(s=>s.published&&s.turbineCode==='R024').sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
 if(!standard?.variants?.length)throw Error('Publish the two-batch healthy standard first');
 const variant=standard.variants.find((v:any)=>v.name==='武川风场-R024-1101-第二组');
 if(!variant||variant.sources.length!==3)throw Error('Expected complete second healthy baseline scenario');
 await mkdir(output,{recursive:true});
 await copyFile(path.resolve('docs/r025-crack-scenario-20261110.md'),path.join(output,'使用说明.md'));
 const sources=[];
 for(const s of variant.sources){
  const p=await processingResult(user,s.processingResultId);
  const sourceRoot=path.join(rotationDataDirectory(p.workerAccount),...(p.packageSha256?['analysis-packages',p.packageSha256]:[]));
  const records=p.report.records.map((r:any)=>({id:r.recording_id,point:r.object.point,angle:r.object.azimuth_deg,radiusM:r.object.radius_from_hub_m,sourceHash:r.source_hash,representative:r.representative,segments:r.segments.map((t:any)=>({resultId:t.result_id,start:t.source_start,end:t.source_end,layer:t.layer,basis:t.basis}))}));
  sources.push({blade:s.bladeCode,processingId:p.id,sourceRoot,workspace:p.report.workspace,records,baselineObservations:healthObservations(p,s.bladeCode)});
 }
 // Paths live only in an ignored, local runtime input; no secrets or accounts in the deliverable.
 await writeFile(path.join(output,'runtime-input.json'),JSON.stringify({sources,standard:{id:standard.id,name:standard.name,variants:standard.variants},generatedDate:'2026-11-10'}));
 const python=process.env.BLADE_ANALYSIS_PYTHON||path.resolve('services/acquisition/.venv/bin/python');
 await new Promise<void>((resolve,reject)=>{const child=spawn(python,['services/acquisition/tools/generate_crack_scenario.py',output],{stdio:'inherit',env:{...process.env,PYTHONPATH:path.resolve('services/acquisition'),OPENBLAS_NUM_THREADS:'1'}});child.on('error',reject);child.on('close',c=>c===0?resolve():reject(Error('Scenario generation failed: '+c)));});
 const comparisons:any[]=[];
 for(const s of sources){
  const report=JSON.parse(await readFile(path.join(output,'analysis',`blade-${s.blade}.json`),'utf8'));
  const observations=healthObservations({report},s.blade);
  if(observations.length!==20||observations.some((o:any)=>!o.eligible))throw Error('Synthetic source coverage/quality check failed');
  for(const o of observations){const slot=variant.slots.find((v:any)=>v.point===o.point&&v.angle===o.angle);for(const m of STANDARD_METRICS){
   const limit=slot.limits[m.key],extra=m.key==='frequency'?Math.max(0,o.resolutionHz-limit.padding):0;
   const value=o.values[m.key],min=Math.max(0,limit.min-extra),max=limit.max+extra;
   if(!Number.isFinite(value))throw Error('Missing synthetic metric');
   comparisons.push({blade:s.blade,point:o.point,angle:o.angle,metric:m.key,name:m.name,unit:m.unit,value,min,max,outside:value<min||value>max});
  }}
 }
 const summary=sources.map(s=>({blade:s.blade,scenarioTruth:s.blade==='2'?'假设裂纹':'健康对照派生',compared:comparisons.filter(c=>c.blade===s.blade).length,outliers:comparisons.filter(c=>c.blade===s.blade&&c.outside).length}));
 if(summary.find(s=>s.blade==='2')!.outliers===0||summary.filter(s=>s.blade!=='2').some(s=>s.outliers>0))throw Error('Scenario acceptance failed; inspect results without changing thresholds');
 const result={dataOrigin:'synthetic',validationMode:'synthetic_scenario_numeric_comparison',standardId:standard.id,referenceTurbine:'R024',scenarioTurbine:'R025',formalHealthAssessment:false,structuralDamageConfirmed:false,reason:'仅作响应包络数值对照；没有R025同期实测风况、现场裂纹证据或跨风机标准适用性确认，不能发布正式健康/损伤结论',summary,comparisons};
 await writeFile(path.join(output,'健康包络数值对照.json'),JSON.stringify(result,null,2));
 await writeFile(path.join(output,'健康包络数值对照.csv'),'blade,point,angle,metric,value,unit,reference_min,reference_max,outside\n'+comparisons.map(c=>[c.blade,c.point,c.angle,c.metric,c.value,c.unit,c.min,c.max,c.outside].join(',')).join('\n')+'\n');
 await writeFile(path.join(output,'生成结果.md'),'# R025 裂纹情景合成结果\n\n来源：合成数据；数值对照不作为正式健康评价。\n\n| 叶片 | 情景设定 | 对照项数 | 超限项数 |\n|---|---|---:|---:|\n'+summary.map(s=>`| ${s.blade} | ${s.scenarioTruth} | ${s.compared} | ${s.outliers} |`).join('\n')+'\n\n所有阈值沿用既有健康标准，原始健康波形未修改。叶片2的裂纹类型和位置是生成假设，算法输出为响应超限；没有现场裂纹确诊。\n');
 await new Promise<void>((resolve,reject)=>{const child=spawn(python,['services/acquisition/tools/generate_crack_scenario.py','--package-only',output],{stdio:'inherit',env:{...process.env,PYTHONPATH:path.resolve('services/acquisition')}});child.on('error',reject);child.on('close',c=>c===0?resolve():reject(Error('Packaging failed')));});
 console.log(JSON.stringify({output,summary,formalHealthAssessment:false},null,2));
}finally{await pool().end();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
