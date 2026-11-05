import assert from 'node:assert/strict';
import type { MeasurementContext, MeasurementObject } from './measurement-domain';
import { measurementFilterOptions as options, normalizeMeasurementFilters as normalize, changeMeasurementFilter as change } from './measurement-filter-options';

const object=(kind:MeasurementObject['kind'],id:string,parentId:string|null=null):MeasurementObject=>({id,kind,parentId,name:id,code:id,active:true,revision:'1'});
const objects=[object('farm','wf1'),object('farm','wf2'),object('campaign','indoor','wf1'),object('campaign','second','wf2'),object('campaign','third','wf2'),object('campaign','empty','wf2'),
 object('turbine','1303','wf1'),object('turbine','1号风机','wf2'),object('turbine','R024','wf2'),
 ...['1303','1号风机','R024'].flatMap(t=>[1,2,3].flatMap(b=>[object('blade',`${t}-b${b}`,t),...[1,2,3,4,5].map(p=>object('position',`${t}-b${b}-p${p}`,`${t}-b${b}`))]))];
const memberships:MeasurementContext[]=[['indoor','wf1','1303',[2]],['second','wf2','1号风机',[1,2,3]],['third','wf2','R024',[1,2,3]]].flatMap(([campaignId,farmId,turbineId,blades])=>(blades as number[]).flatMap(b=>[1,2,3,4,5].map(p=>({campaignId:String(campaignId),farmId:String(farmId),turbineId:String(turbineId),bladeId:`${turbineId}-b${b}`,positionId:`${turbineId}-b${b}-p${p}`}))));
const ids=(kind:MeasurementObject['kind'],v:Partial<MeasurementContext>)=>options(objects,memberships,v,kind).map(o=>o.id);
const indoor=normalize(objects,memberships,{campaignId:'indoor'});
assert.equal(indoor.farmId,'wf1');assert.equal(indoor.turbineId,'1303');assert.equal(indoor.bladeId,'1303-b2');assert.equal(indoor.positionId,'');
assert.deepEqual(ids('blade',indoor),['1303-b2'],'Other turbine blades not measured in this task are absent');
assert.equal(ids('position',indoor).length,5);
assert.equal(ids('campaign',indoor).length,4,'Changing tasks can cross farms without first clearing every child');
const third=change(objects,memberships,{...indoor,positionId:'1303-b2-p1'},'campaign','third');
assert.deepEqual(third,{campaignId:'third',farmId:'wf2',turbineId:'R024',bladeId:'',positionId:''});
const blade2=change(objects,memberships,third,'blade','R024-b2');
assert.deepEqual(ids('position',blade2),[1,2,3,4,5].map(p=>`R024-b2-p${p}`));
assert.equal(change(objects,memberships,{...blade2,positionId:'R024-b2-p3'},'blade','R024-b3').positionId,'');
assert.deepEqual(change(objects,memberships,blade2,'campaign','third'),blade2,'Compatible selections survive refresh or repeat selection');
assert.deepEqual(normalize(objects,memberships,blade2),blade2);
assert.deepEqual(change(objects,memberships,blade2,'campaign','empty'),{campaignId:'empty',farmId:'',turbineId:'',bladeId:'',positionId:''});
const single=[memberships[0]];
assert.equal(normalize(objects,single,{campaignId:'indoor'}).positionId,single[0].positionId,'A single recorded point selects itself');
// A task's position index is independent of which waveform page is loaded.
assert.equal(ids('position',{...blade2,bladeId:'R024-b3'}).length,5);
console.log('PASS batch-scoped selectors, unique defaults, compatible retention, stale child clearing, empty batches and same-number blades');
