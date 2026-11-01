'use strict';
// Isolated local account, copies of real records, no production or device access.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {randomUUID,randomBytes,scryptSync,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
process.loadEnvFile(path.resolve('apps/web/.env.local'));
assert(['127.0.0.1','localhost','::1'].includes(process.env.DB_HOST));assert.equal(process.env.DB_NAME,'blade_vms_playground');
const origin='http://127.0.0.1:3210',root=process.cwd(),tenant='qa-web-revision-'+randomUUID(),id=randomUUID(),username='qa-web-'+randomUUID(),password=randomBytes(24).toString('hex');
const sha=v=>createHash('sha256').update(v).digest('hex'),out=path.resolve(root,process.env.BLADE_ANALYSIS_OUTPUT||'artifacts/measurement-modes-20261101/web'),source=path.join(root,'artifacts/measurement-modes-20261101/accepted/desktop/recordings');
const accountDir=path.join(root,'.data/web-rotation',sha(tenant+'\0'+id));fs.mkdirSync(out,{recursive:true});
const original=new Map(),checks=[];let db,token,viewerId,viewerToken;
const manifests=fs.readdirSync(source).filter(v=>/^[a-f0-9]{32}$/.test(v)).map(rid=>JSON.parse(fs.readFileSync(path.join(source,rid,'manifest.json'))));assert.equal(manifests.length,12);
for(const m of manifests)for(const name of fs.readdirSync(path.join(source,m.id)))if(name==='manifest.json'||/^chunk-.*bin$/.test(name)){const p=path.join(source,m.id,name);original.set(p,sha(fs.readFileSync(p)));}
async function response(route,method='GET',body,t=token){const r=await fetch(origin+'/api/v1/'+route,{method,headers:{'Content-Type':'application/json','Connection':'close',...(t?{Authorization:'Bearer '+t}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)});return {response:r,value:r.headers.get('Content-Type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer())};}
async function api(route,method='GET',body,t){const {response:r,value}=await response(route,method,body,t);assert.equal(r.status,200,route+': '+JSON.stringify(value).slice(0,1000));return value;}
function pass(name){checks.push(name);console.log('PASS '+name);}
async function run(){fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify({passed:false,running:true}));try{
 db=await mysql.createConnection({host:process.env.DB_HOST,port:+process.env.DB_PORT||3306,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
 const salt=randomBytes(16).toString('hex');await db.execute('INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,1)',[id,username,'Web修订真实数据核验',salt+':'+scryptSync(password,salt,64).toString('hex'),'analyst',tenant]);
 token=(await api('session','POST',{username,password},'')).token;
 fs.cpSync(source,path.join(accountDir,'recordings'),{recursive:true});await api('objects/adopt','POST',{});
 let catalog=await api('measurements');assert.equal(catalog.sources.length,12);
 const farm=catalog.objects.find(o=>o.kind==='farm'&&o.code==='wf1'),turbine=catalog.objects.find(o=>o.kind==='turbine'&&o.code==='1309'),blade=catalog.objects.find(o=>o.kind==='blade'&&o.code==='2');assert(farm&&turbine&&blade,JSON.stringify(catalog.objects));
 const campaign=(await api('objects','POST',{kind:'campaign',code:'QA-1309',name:'1309 户外三叶片验证',parentId:farm.id,turbineIds:[turbine.id]})).object;
 for(const s of catalog.sources){const pc=manifests.find(m=>m.id===s.reference.id).pointCycle;const ownBlade=catalog.objects.find(o=>o.kind==='blade'&&o.parentId===turbine.id&&o.code===pc.bladeId);assert(ownBlade);const point=catalog.objects.find(p=>p.kind==='position'&&p.parentId===ownBlade.id&&p.code===pc.radialPointName);assert(point);await api('objects/link','POST',{reference:s.reference,context:{farmId:farm.id,turbineId:turbine.id,bladeId:ownBlade.id,positionId:point.id,campaignId:campaign.id},revision:s.bindingRevision});}
 const summaries=[];
 for(const bladeCode of ['1','2','3']){
   const ownBlade=catalog.objects.find(o=>o.kind==='blade'&&o.parentId===turbine.id&&o.code===bladeCode);
   const context={farmId:farm.id,turbineId:turbine.id,bladeId:ownBlade.id,campaignId:campaign.id};
   const req=request=>api('measurements/processing','POST',{context,request});
   const c=await req({action:'catalog'});assert.equal(c.processingContract.version,'unified-analysis-2.3.0');assert.equal(c.tasks[0].measurementMode,'outdoor');assert.equal(c.tasks[0].recordingIds.length,4);
   const j=await req({action:'start',taskId:c.tasks[0].id,recordingIds:c.tasks[0].recordingIds,scope:'analysis',profile:'LOS_DIAGNOSTIC',workspace:{purpose:'synthesis',algorithmOptions:{measurementMode:'outdoor',targetBandMode:'preview'}}});
   let state;for(let i=0;i<450;i++){state=await req({action:'status',jobId:j.jobId});if(['complete','failed'].includes(state.status))break;await new Promise(r=>setTimeout(r,100));}assert.equal(state.status,'complete',state.error);
   const r=await req({action:'result',jobId:j.jobId});assert.equal(r.records.length,4);assert.equal(r.coverage.analyzableCount,4);assert.equal(r.aggregates[0].azimuth_count,4);await req({action:'publish',jobId:j.jobId});
   const waves=await req({action:'waveforms',jobId:j.jobId});assert.equal(waves.points.length,1);assert.equal(waves.points[0].preview.joins.length,3);assert.equal(waves.points[0].preview.blocks.filter(b=>b.kind==='measured_processed').length,4);
   const health=await api('measurements/blade-health','POST',{action:'evaluate',context,processingResultId:j.jobId});
   const measured=health.blades.find(b=>b.processingResultId);assert(measured);assert.equal(measured.coverage.points.length,1);assert.equal(measured.features.length,4);assert.equal(measured.status,'insufficient');
   summaries.push({blade:bladeCode,coverage:r.coverage,amplitude:r.aggregates[0].mean_half_peak_to_peak_m_s,health:measured.status});
 }
 pass('Three Web blades retain every mapped angle, four numeric inputs, three fitted joins, single-point health response without a false health conclusion');
 const packages=JSON.parse(execFileSync(path.join(root,'services/acquisition/.venv/bin/python'),['-c',`from pathlib import Path
import json,time
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.record_analysis.packages import create
m=RecordAnalysisManager(Path(${JSON.stringify(path.join(accountDir,'desktop-source'))}),recordings_dir=Path(${JSON.stringify(source)}))
t=m.catalog()['tasks'][0]
packages=[]
for blade in ('1','2','3'):
 ids=[r['id'] for r in t['records'] if r['bladeId']==blade]
 j=m.start({'taskId':t['id'],'recordingIds':ids,'workspace':{'purpose':'synthesis','algorithmOptions':{'targetBandMode':'preview'}}})
 while m.status(j['jobId'])['status'] in ('queued','running'):time.sleep(.02)
 packages.append({'blade':blade,**create(m,j['jobId'])})
print(json.dumps(packages))
m.close()`],{env:{...process.env,PYTHONPATH:path.join(root,'services/acquisition')},encoding:'utf8',timeout:120000}));
 let verifiedArrays=0;
 for(const packageInfo of packages){
 const bytes=fs.readFileSync(packageInfo.path);const route=op=>'measurements/analysis-packages?sha256='+packageInfo.sha256+'&operation='+op;
 const init=await api(route('init'),'POST',{bytes:bytes.length,recordingIds:packageInfo.recordingIds});assert.equal(init.offset,0);
 let offset=0;while(offset<bytes.length){const chunk=bytes.subarray(offset,Math.min(bytes.length,offset+4*1024*1024));const r=await fetch(origin+'/api/v1/'+route('chunk')+'&offset='+offset,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:chunk});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));offset=b.offset;}
 const verified=await api(route('complete'),'POST',{});assert.equal(verified.status,'verified');assert.equal(verified.verifiedArrays,4);verifiedArrays+=verified.verifiedArrays;
 const readback=await api('measurements/processing','POST',{request:{action:'snapshot',jobId:verified.id}});assert.equal(readback.result.processingSource,'desktop_verified');assert.equal(readback.result.report.records.length,4);
 const g=readback.result.report.aggregates[0],row=summaries.find(r=>r.blade===packageInfo.blade);assert(Math.abs(g.mean_half_peak_to_peak_m_s-row.amplitude)<1e-12);
 }
 pass('Three desktop result packages upload and verify all 12 full-precision arrays; Web recomputed amplitudes match desktop');
 for(const [p,h] of original)assert.equal(sha(fs.readFileSync(p)),h);fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify({passed:true,softwareOnly:true,checks,recordCount:12,blades:summaries,packageVerifiedArrays:verifiedArrays},null,2));
 }finally{if(db){for(const uid of [id,viewerId].filter(Boolean))await db.execute('DELETE FROM sessions WHERE user_id=?',[uid]);await db.execute('DELETE FROM audit_logs WHERE tenant=?',[tenant]);await db.execute('DELETE FROM records WHERE tenant=?',[tenant]);for(const uid of [id,viewerId].filter(Boolean))await db.execute('DELETE FROM users WHERE id=?',[uid]);await db.end();}fs.rmSync(accountDir,{recursive:true,force:true});}}
run().catch(e=>{console.error(e.stack,e.cause||'');process.exitCode=1;});
