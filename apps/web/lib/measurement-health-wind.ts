import {digest,HttpError,pool,rows,unpack,type User,type RecordItem} from './db';
import {objects,requireAnalyst,listMeasurementRows} from './measurement-store';
import {resolveHealthWindDataset,healthWindDatasets} from '@blade/ui/measurement-health-readiness';

const kind = 'health_wind_bindings';
const scopeKeys = ['farmId','campaignId','turbineId'] as const;
function scope(context:any) {
  if (!context || scopeKeys.some(k => typeof context[k] !== 'string' || !context[k])) throw new HttpError(400,'请选择风场、批次和风机');
  return Object.fromEntries(scopeKeys.map(k => [k,context[k]]));
}
function bindingId(user:User,context:any) {return digest(JSON.stringify([kind,user.tenant,scope(context)]));}
export async function healthWindSelection(user:User,context:any,choices:any[],requested?:unknown) {
  const [saved] = await rows<RecordItem>('SELECT * FROM records WHERE id=? AND kind=? AND tenant=?',[bindingId(user,context),kind,user.tenant]);
  try {return resolveHealthWindDataset(choices,requested,saved ? unpack(saved) as {windDatasetId:string} : null);}
  catch(e) {throw new HttpError(400,(e as Error).message);}
}
export async function saveHealthWindSelection(user:User,context:any,windDatasetId:unknown) {
  requireAnalyst(user);const target=scope(context);
  const [all,datasets]=await Promise.all([objects(user),listMeasurementRows(user,'wind_datasets')]);
  const farm=all.find(o=>o.active&&o.id===target.farmId&&o.kind==='farm');
  const turbine=all.find(o=>o.active&&o.id===target.turbineId&&o.kind==='turbine'&&o.parentId===target.farmId);
  const campaign=all.find(o=>o.active&&o.id===target.campaignId&&o.kind==='campaign'&&o.parentId===target.farmId);
  if(!farm||!turbine||!campaign||campaign.turbineIds?.length&&!campaign.turbineIds.includes(turbine.id))throw new HttpError(400,'请选择同一风场、批次与风机');
  if(typeof windDatasetId!=='string')throw new HttpError(400,'请选择风场数据集，或明确取消关联');
  try {resolveHealthWindDataset(healthWindDatasets(datasets,target.farmId,turbine.windTurbineCode||turbine.code),windDatasetId);}
  catch(e){throw new HttpError(400,(e as Error).message);}
  const body=JSON.stringify({context:target,windDatasetId,updatedAt:new Date().toISOString(),updatedBy:user.id});
  await pool().execute('INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE body=?',[bindingId(user,target),kind,user.tenant,body,user.id,body]);
}
