import assert from 'node:assert/strict';
import {healthWindDatasets,resolveHealthWindDataset} from '../packages/ui/src/measurement-health-readiness';

const datasets=[
  {id:'r024',farmId:'wuchuan',rows:[{turbineCode:'R024'}]},
  {id:'r001',farmId:'wuchuan',rows:[{turbineCode:'R001'}]},
  {id:'mixed',farmId:'wuchuan',rows:[{turbineCode:'R024'},{turbineCode:'R001'}]},
  {id:'other-farm',farmId:'huade',rows:[{turbineCode:'R001'}]},
  {id:'empty',farmId:'wuchuan',rows:[]},
];
const choices=healthWindDatasets(datasets,'wuchuan','R001');
assert.deepEqual(choices.map(d=>d.id),['r001','mixed']);
assert.equal(resolveHealthWindDataset(choices,undefined).id,'');
assert.equal(resolveHealthWindDataset(choices,undefined,{windDatasetId:'r024'}).source,'unavailable');
assert.throws(()=>resolveHealthWindDataset(choices,'r024'),/当前风场、风机/);
assert.equal(resolveHealthWindDataset(choices,'mixed').id,'mixed');
assert.equal(resolveHealthWindDataset(choices,undefined,{windDatasetId:''}).id,'');
assert.equal(resolveHealthWindDataset(healthWindDatasets(datasets,'huade','R001'),undefined).id,'other-farm');
assert.deepEqual(healthWindDatasets([{farmId:'wuchuan'}],'wuchuan','R001'),[]);
console.log('PASS health wind selection: exact farm/turbine, mixed dataset, stale selection, explicit clearing, no foreign fallback');
