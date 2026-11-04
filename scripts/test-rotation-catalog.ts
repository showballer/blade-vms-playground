import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readRotationCatalog} from '../apps/web/lib/rotation-catalog';
async function main(){
 const root=await mkdtemp(path.join(tmpdir(),'blade-catalog-'));
 try{
  const directory=path.join(root,'recordings');await mkdir(directory);
  const localId='f'.repeat(32);
  await mkdir(path.join(directory,localId));await writeFile(path.join(directory,localId,'manifest.json'),JSON.stringify({id:localId,name:'independent import',startedAt:1}));
  for(let i=0;i<140;i++){
   const id=i.toString(16).padStart(32,'0');await mkdir(path.join(directory,id));
   await writeFile(path.join(directory,id,'manifest.json'),JSON.stringify({id,cloudCaptureId:id,startedAt:i,importSource:{manifestContent:'x'.repeat(70000)}}));
  }
  assert.deepEqual((await readRotationCatalog(root,true)).recordings.map(r=>r.id),[localId]);
  await assert.rejects(readRotationCatalog(root),/目录过大/);
  assert.equal((await readRotationCatalog(path.join(root,'missing'),true)).recordings.length,0);
  console.log('PASS: native capture copies excluded before catalog size limit; genuine imports retained');
 }finally{await rm(root,{recursive:true,force:true});}
}
void main();
