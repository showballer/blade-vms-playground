import {digest} from './db';
import {windDatasetRevisionInput} from '@blade/ui/measurement-conditions';

export function selectedWindRevision(datasets:any[],farmId:string,windDatasetId:string) {
 return digest(JSON.stringify([windDatasetId??'legacy_auto',windDatasetRevisionInput(datasets.filter(d=>d.id===windDatasetId),farmId)]));
}
/** Older reports used a whole-farm revision; preserve their original comparison contract. */
export function reportWindIsStale(report:any,datasets:any[],currentWindDatasetId:string) {
 if(!report.windRevision||!report.context?.farmId)return false;
 const selected=report.windRevisionMode==='selected-v1'||report.bladeAssessments?.some((b:any)=>Object.hasOwn(b,'windDatasetId'));
 const revision=selected?selectedWindRevision(datasets,report.context.farmId,currentWindDatasetId):digest(JSON.stringify(windDatasetRevisionInput(datasets,report.context.farmId)));
 return revision!==report.windRevision;
}
