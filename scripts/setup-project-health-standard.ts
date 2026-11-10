/** Explicit, repeatable setup for the user's two named healthy development batches. */
import {rows,pool,type User} from '../apps/web/lib/db';
import {objects} from '../apps/web/lib/measurement-store';
import {bladeHealthWorkspace,bladeHealthEndpoint} from '../apps/web/lib/measurement-blade-health';
import {processingEndpoint} from '../apps/web/lib/measurement-processing';
import {healthStandardCatalog,publishHealthStandard} from '../apps/web/lib/measurement-health-standard';
async function main(){try{
 const apply=process.argv.includes('--apply');const username=process.argv.find(v=>v.startsWith('--username='))?.slice(11)||'admin';
 const [user]=await rows<User>('SELECT id,username,name,role,tenant,active FROM users WHERE username=? AND active=1 AND deleted_at IS NULL',[username]);if(!user||!['admin','analyst'].includes(user.role))throw Error('Use an existing analyst or administrator');
 const all=await objects(user),plans=[];
 for(const name of ['武川风场-R024-1101-第一组','武川风场-R024-1101-第二组']){
  const matches=all.filter(o=>o.active&&o.kind==='campaign'&&o.name===name);if(matches.length!==1||matches[0].turbineIds?.length!==1)throw Error('Missing or ambiguous batch: '+name);
  const c=matches[0],context={farmId:c.parentId,campaignId:c.id,turbineId:c.turbineIds![0]},w=await bladeHealthWorkspace(user,context);
  if(w.blades.length!==3||w.blades.some(b=>!b.processingResultId))throw Error('Complete all three whole-blade analyses first: '+name);
  plans.push({name,context,sourceIds:w.blades.map(b=>b.processingResultId)});
 }
 console.log(JSON.stringify({apply,plans},null,2));if(!apply)return;
 const ids=plans.flatMap(p=>p.sourceIds);
 for(const id of ids)await processingEndpoint(user,{request:{action:'publish',jobId:id}});
 const catalog=await healthStandardCatalog(user,plans[0].context);
 const already=catalog.standard?.algorithmVersion==='blade-response-envelope-1.1'&&catalog.standard.variants.every((v:any)=>v.slots.every((s:any)=>Number.isFinite(s.maximumResolutionHz)))&&JSON.stringify([...catalog.standard.sourceIds].sort())===JSON.stringify([...ids].sort());
 const standard=already?catalog.standard:(await publishHealthStandard(user,{context:plans[0].context,sourceIds:ids,name:'武川风场 R024 健康响应标准 v1',confirmHealthy:true,approval:'项目用户于2026-11-10明确确认：武川风场-R024-1101-第一组、第二组为健康叶片数据，授权按现有仓库数据及测点角度分组建立项目响应标准。保留历史增益修订、人工角度分组和估算测点标记；确认属于用户声明，不替代编码器身份核验或独立损伤样本验证。'})).standard;
 console.log('Standard published:',standard.id);
 for(const p of plans){const result=await bladeHealthEndpoint(user,{action:'evaluate',context:p.context});console.log(JSON.stringify({batch:p.name,blades:result.blades.map((b:any)=>({blade:b.name,label:b.label,status:b.status,baselineMember:b.healthScreening?.baselineMember,compared:b.healthScreening?.comparisons.length,reasons:b.reasons}))},null,2));if(result.blades.some((b:any)=>b.status!=='normal'))throw Error('Baseline self-check did not pass; inspect reasons, do not force a conclusion');}
}finally{await pool().end();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
