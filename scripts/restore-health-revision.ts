/** Restore wind associations against the receiving database's own IDs. */
import {rows,pool,type User} from '../apps/web/lib/db';
import {objects,listMeasurementRows} from '../apps/web/lib/measurement-store';
import {bladeHealthEndpoint} from '../apps/web/lib/measurement-blade-health';

async function main(){
 const apply=process.argv.includes('--apply');
 const usernameArg=process.argv.find(v=>v.startsWith('--username='));const username=usernameArg?.slice('--username='.length)||'admin';
 try{
  const [user]=await rows<User>('SELECT id,username,name,role,tenant,active FROM users WHERE username=? AND active=1 AND deleted_at IS NULL',[username]);
  if(!user||!['admin','analyst'].includes(user.role))throw Error('Use an existing admin or analyst account in the target database');
  const all=await objects(user),datasets=await listMeasurementRows(user,'wind_datasets');
  const plans=[];
  for(const name of ['武川风场-R024-1101-第一组','武川风场-R024-1101-第二组']){
   const campaigns=all.filter(o=>o.active&&o.kind==='campaign'&&o.name===name);
   if(campaigns.length!==1||campaigns[0].turbineIds?.length!==1)throw Error('Missing or ambiguous imported batch: '+name);
   const campaign=campaigns[0],context={farmId:campaign.parentId,campaignId:campaign.id,turbineId:campaign.turbineIds![0]};
   const choices=datasets.filter(d=>d.farmId===context.farmId&&d.name==='户外武川风场_R024_2026-11-01（每秒区间平均值）');
   if(choices.length!==1)throw Error('Import and associate the confirmed wind dataset first: '+name);
   const state=await bladeHealthEndpoint(user,{action:'workspace',context,windDatasetId:choices[0].id});
   if(state.blades.some((b:any)=>!b.processingResultId))throw Error('Run whole-blade analysis for all three blades first: '+name);
   plans.push({name,context,datasetId:choices[0].id,state});
  }
  console.log(JSON.stringify({apply,plans:plans.map(p=>({batch:p.name,windDatasetId:p.datasetId,matched:p.state.blades.map((b:any)=>({blade:b.name,matched:b.evidenceReadiness?.matched,total:b.conditions.length}))}))},null,2));
  if(!apply)return;
  for(const p of plans){
   await bladeHealthEndpoint(user,{action:'select-wind',context:p.context,windDatasetId:p.datasetId});
   await bladeHealthEndpoint(user,{action:'evaluate',context:p.context});
  }
  console.log('Restored wind associations and evaluations; source recordings unchanged.');
 }finally{await pool().end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
