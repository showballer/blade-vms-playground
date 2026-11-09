/** Reversible local workspace migration. Raw captures and saved analyses are untouched. */
import mysql from 'mysql2/promise';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const apply=process.argv.includes('--apply');
const db=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
try {
 const [users]=await db.execute("SELECT tenant FROM users WHERE username='admin' AND active=1 AND deleted_at IS NULL");if(users.length!==1)throw Error('Expected one local admin tenant');const tenant=users[0].tenant;
 const [rows]=await db.execute("SELECT id,kind,body FROM records WHERE tenant=? AND kind IN ('measurement_objects','wind_datasets')",[tenant]);
 const records=rows.map(r=>({...r,body:typeof r.body==='string'?JSON.parse(r.body):r.body}));const objects=records.filter(r=>r.kind==='measurement_objects');
 const batches=[['1101-78m-背景塔桶-第二组_桌面端导入_2026-11-02','武川风场-R024-1101-第一组'],['第三组全流程_桌面端导入_2026-11-04','武川风场-R024-1101-第二组']].map(([old,name])=>{const matches=objects.filter(r=>r.body.kind==='campaign'&&[old,name].includes(r.body.name));if(matches.length!==1)throw Error('Missing or ambiguous Git batch '+name);return {...matches[0],name};});
 if(batches[0].body.parentId!==batches[1].body.parentId)throw Error('Batch farms differ');const farmId=batches[0].body.parentId;
 const turbines=new Set(batches.flatMap(r=>r.body.turbineIds||[]));if(turbines.size!==2)throw Error('Expected two source installations');
 const keep=new Set([farmId,...turbines,...batches.map(r=>r.id)]);for(let pass=0;pass<2;pass++)for(const r of objects)if(keep.has(r.body.parentId)&&['blade','position'].includes(r.body.kind))keep.add(r.id);
 const changes=[];for(const r of objects){const body={...r.body,active:keep.has(r.id)};const batch=batches.find(b=>b.id===r.id);if(batch)body.name=batch.name;if(r.id===farmId)body.name='户外武川风场';if(turbines.has(r.id)){body.name='R024';body.windTurbineCode='R024';}if(JSON.stringify(body)!==JSON.stringify(r.body))changes.push({...r,next:body});}
 const dataset=records.find(r=>r.kind==='wind_datasets'&&r.body.name==='户外武川风场_R024_2026-11-01（每秒区间平均值）');if(!dataset)throw Error('Confirmed interval-mean wind dataset missing');
 if(dataset.body.farmId!==farmId)changes.push({...dataset,next:{...dataset.body,farmId,previousFarmId:dataset.body.farmId,associationNote:'用户要求：与 Git 导入两批武川风场数据统一关联；保留原时标和每秒区间平均口径'}});
 console.log(JSON.stringify({apply,batches:batches.map(b=>({id:b.id,name:b.name})),activeObjects:keep.size,changes:changes.length,windDatasetId:dataset.id},null,2));
 if(apply&&changes.length){const directory=path.resolve('.data/local-dev/web-revision-backups');await mkdir(directory,{recursive:true});const backup=path.join(directory,new Date().toISOString().replaceAll(':','-')+'.json');await writeFile(backup,JSON.stringify(changes.map(({next,...r})=>r)),{mode:0o600});await db.beginTransaction();try{for(const r of changes)await db.execute('UPDATE records SET body=? WHERE id=? AND tenant=?',[JSON.stringify(r.next),r.id,tenant]);await db.commit();}catch(e){await db.rollback();throw e;}console.log('Applied; backup saved in .data/local-dev/web-revision-backups');}
}finally{await db.end();}
