/** Portable, additive demo restore. Default verifies the bundle without changing data. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import {rows,pool,digest,type User} from '../apps/web/lib/db';
import {objects,saveObject,listMeasurementRows,saveMeasurementRow,saveWindDataset,measurementSources,bindMeasurement} from '../apps/web/lib/measurement-store';
import {rotationDataDirectory} from '../apps/web/lib/rotation';
import {saveHealthWindSelection} from '../apps/web/lib/measurement-health-wind';
import {processingEndpoint} from '../apps/web/lib/measurement-processing';
import {bladeHealthEndpoint} from '../apps/web/lib/measurement-blade-health';
const directory=path.resolve('data/customer-demo/20261110');
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
async function main(){try{
 const apply=process.argv.includes('--apply');
 const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
 assert.equal(manifest.schema,'customer-demo-20261110-v1');
 for(const f of [...manifest.files,...manifest.archives]){
  assert.equal(path.basename(f.file),f.file);
  const data=await readFile(path.join(directory,f.file));assert.equal(data.length,f.bytes);assert.equal(sha(data),f.sha256,f.file);
 }
 const config=JSON.parse(await readFile(path.join(directory,'settings.json'),'utf8'));
 assert.equal(config.registration.dataOrigin,'synthetic');assert.equal(config.registration.recordingIds.length,60);
 const records:any[]=[];const entries=new Set<string>();
 // Validate every archive before any filesystem or database mutation.
 for(const a of manifest.archives){
  const zip=await JSZip.loadAsync(await readFile(path.join(directory,a.file)),{checkCRC32:true});
  for(const f of Object.values(zip.files)){
   if(f.dir)continue;
   assert.match(f.name,/^[a-f0-9]{32}\/(manifest\.json|chunk-00000000\.bin|split-source\.csv\.gz)$/);
   assert(!entries.has(f.name));entries.add(f.name);
   const rid=f.name.split('/')[0];assert(config.registration.recordingIds.includes(rid));
   if(f.name.endsWith('/manifest.json')){const m=JSON.parse(await f.async('string'));assert.equal(m.id,rid);assert.equal(m.source,'simulation');assert.equal(m.turbine,'020#');records.push(m);}
  }
 }
 assert.equal(records.length,60);assert.equal(entries.size,180);
 for(const rid of config.registration.recordingIds)for(const name of ['manifest.json','chunk-00000000.bin','split-source.csv.gz'])assert(entries.has(rid+'/'+name));
 console.log(JSON.stringify({apply,batch:config.name,recordings:records.length,windDatasets:config.datasets.map((d:any)=>({name:d.name,rows:d.rows.length}))},null,2));
 if(!apply)return;
 const username=process.argv.find(v=>v.startsWith('--username='))?.slice(11)||'admin';
 const [user]=await rows<User>('SELECT id,username,name,role,tenant,active FROM users WHERE username=? AND active=1 AND deleted_at IS NULL',[username]);
 assert(user&&['admin','analyst'].includes(user.role),'Existing administrator or analyst required');
 let all=await objects(user);
 async function ensure(kind:string,code:string,parentId:string|null,extra:any={}){
  const found=all.filter(o=>o.kind===kind&&o.code===code&&o.parentId===parentId);assert(found.length<=1,'Ambiguous object '+code);
  if(found[0]){assert(found[0].active,'Archived object '+code);return found[0];}
  const o=(await saveObject(user,{kind,code,parentId,name:code,...extra}))!;all=await objects(user);return o;
 }
 // Existing recordings must be byte-identical; never overwrite a conflicting capture.
 const target=path.join(rotationDataDirectory(user),'recordings');
 for(const a of manifest.archives){
  const zip=await JSZip.loadAsync(await readFile(path.join(directory,a.file)));
  for(const f of Object.values(zip.files)){
   if(f.dir)continue;const dest=path.join(target,f.name);
   try{await stat(dest);assert.equal(sha(await readFile(dest)),sha(await f.async('nodebuffer')),'Existing capture differs: '+f.name);}
   catch(e){if((e as any).code!=='ENOENT')throw e;}
  }
 }
 for(const a of manifest.archives){
  const zip=await JSZip.loadAsync(await readFile(path.join(directory,a.file)));
  for(const f of Object.values(zip.files)){
   if(f.dir)continue;const dest=path.join(target,f.name);await mkdir(path.dirname(dest),{recursive:true});
   try{await writeFile(dest,await f.async('nodebuffer'),{flag:'wx'});}catch(e){if((e as any).code!=='EEXIST')throw e;}
  }
 }
 const farm=await ensure('farm','huade-scenario',null,{name:'化德风场'});
 const turbine=await ensure('turbine','020#',farm.id,{name:'20号风机（020#）'});
 const campaign=await ensure('campaign','r025-crack-scenario-20261110',farm.id,{name:config.name,date:'2026-10-18',turbineIds:[turbine.id],weather:'客户演示场景；叶片响应为构造数据，与实测分钟工况作场景关联。'});
 assert.equal(campaign.name,config.name);assert.deepEqual(campaign.turbineIds,[turbine.id],'Existing batch must already use 020#; migrate old R025 batch separately');
 const context={farmId:farm.id,campaignId:campaign.id,turbineId:turbine.id};
 const registrations=await listMeasurementRows(user,'measurement_synthetic_imports');
 const existing=registrations.find(r=>r.ownerId===user.id&&r.context?.campaignId===campaign.id);
 if(existing){assert.deepEqual([...existing.recordingIds].sort(),[...config.registration.recordingIds].sort());assert.deepEqual(existing.referenceVariant,config.registration.referenceVariant);}
 else await saveMeasurementRow(user,'measurement_synthetic_imports',{...config.registration,ownerId:user.id,context},'scenario-'+digest(user.tenant+'|'+user.id+'|'+campaign.id).slice(0,48));
 const scopes=[];
 for(const code of ['1','2','3']){
  const blade=await ensure('blade',code,turbine.id,{name:'叶片 '+code});
  for(const m of records.filter(r=>r.pointCycle.bladeId===code)){
   const point=await ensure('position',m.point,blade.id,{radiusM:m.pointCycle.radiusM});
   const reference={kind:'import' as const,id:m.id};const [s]=await measurementSources(user,{references:[reference]});assert(s);
   const desired={...context,bladeId:blade.id,positionId:point.id};
   if(Object.entries(desired).some(([k,v])=>(s.context as any)?.[k]!==v))await bindMeasurement(user,{reference,revision:s.bindingRevision,context:desired});
  }
  scopes.push({...context,bladeId:blade.id,code});
 }
 const windIds=new Map<string,string>();
 for(const d of config.datasets){
  const matches=all.filter(o=>o.active&&o.kind==='farm'&&o.name===d.farm);assert(matches.length<=1,'Ambiguous farm');
  const f=matches[0]||await ensure('farm',d.farm==='化德风场'?'huade-scenario':'wuchuan-demo',null,{name:d.farm});
  for(const code of new Set<string>(d.rows.map((r:any)=>r.turbineCode)))await ensure('turbine',code,f.id);
  const candidates=(await listMeasurementRows(user,'wind_datasets')).filter(w=>w.farmId===f.id&&w.sources?.some((s:any)=>d.sources.some((t:any)=>t.sha256===s.sha256)));
  assert(candidates.length<=1,'Duplicate wind datasets');let wind=candidates[0];
  if(wind){assert.deepEqual(wind.rows,d.rows);assert.deepEqual(wind.timeSemantics,d.timeSemantics);}
  else{const {farm:_,...body}=d;wind=await saveWindDataset(user,{...body,farmId:f.id,importedAt:new Date().toISOString()});}
  windIds.set(f.id,wind.id);
 }
 await saveHealthWindSelection(user,context,windIds.get(farm.id));
 for(const c of all.filter(o=>o.active&&o.kind==='campaign'&&['武川风场-R024-1101-第一组','武川风场-R024-1101-第二组'].includes(o.name))){
  if(c.parentId&&windIds.has(c.parentId)&&c.turbineIds?.length===1)await saveHealthWindSelection(user,{farmId:c.parentId,campaignId:c.id,turbineId:c.turbineIds[0]},windIds.get(c.parentId));
 }
 for(const item of scopes){
  const {code,...scope}=item;
  const catalog=await processingEndpoint(user,{context:scope,request:{action:'catalog'}});
  const task=catalog.tasks.find((t:any)=>t.recordingIds.length===20&&t.recordingIds.every((id:string)=>config.registration.recordingIds.includes(id)));assert(task);
  const start=await processingEndpoint(user,{context:scope,request:{action:'start',taskId:task.id,recordingIds:task.recordingIds,scope:'analysis',profile:'LOS_DIAGNOSTIC',workspace:{purpose:'synthesis',algorithmOptions:config.workspaces.find((w:any)=>w.blade===code).workspace.algorithmOptions}}});
  const deadline=Date.now()+300000;
  for(;;){const s=await processingEndpoint(user,{request:{action:'status',jobId:start.jobId}});if(s.status==='complete')break;assert(!['failed','cancelled'].includes(s.status),s.error);assert(Date.now()<deadline,'Processing timeout');await new Promise(r=>setTimeout(r,500));}
  await processingEndpoint(user,{request:{action:'publish',jobId:start.jobId}});
 }
 const result=await bladeHealthEndpoint(user,{action:'evaluate',context});assert.equal(result.blades.length,3);
 for(const b of result.blades){const code=all.find(o=>o.id===b.bladeId)!.code;assert.equal(b.syntheticScenario?.detection?.outsideCount,code==='2'?31:0);assert.equal(b.conditions.filter((c:any)=>c.condition.status==='matched').length,20);assert.equal(b.structuralDamageConfirmed,false);}
 console.log('Restored: 化德60条记录、两份风场数据；三片叶片工况20/20，超限0/31/0。');
}finally{await pool().end();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
