import assert from 'node:assert/strict';
import {bladeHealthEndpoint} from '../apps/web/lib/measurement-blade-health';
import {processingEndpoint} from '../apps/web/lib/measurement-processing';
import {HttpError,type User} from '../apps/web/lib/db';

async function main(){
 const user={id:'rollback-test',username:'rollback-test',role:'admin',tenant:'isolated',active:1} as User;
 // These old entry points must reject before any database, cache or worker access.
 for(const action of ['fault-test','fault-test-detail']){
  await assert.rejects(bladeHealthEndpoint(user,{action}),e=>e instanceof HttpError&&e.status===410);
 }
 await assert.rejects(processingEndpoint(user,{request:{action:'extended',kind:'defect_validation',parameters:{point:'P3'}}}),e=>e instanceof HttpError&&e.status===410);
 const capability=await bladeHealthEndpoint(user,{action:'damage'});
 assert.equal(capability.enabled,true,'project envelope screening is connected; no injection endpoint is restored');
 assert.equal(capability.status,'connected');
 console.log('PASS withdrawn defect injection: old health and processing requests rejected before persistence/worker access');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
