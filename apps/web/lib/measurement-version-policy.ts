/** Whole-blade evaluation must never select a single-record analysis. */
export function wholeBladeVersion(version:any,bladeCode:string,expectedIds:string[]){
 const purpose=version.workspace?.purpose||version.report?.workspace?.purpose;
 const records=(version.report?.records||[]).filter((r:any)=>String(r.object?.blade)===bladeCode);
 const mapped=new Map((version.packageVerification?.sourceRelations||[]).map((r:any)=>[r.nativeId,r.serverId]));
 const actual=new Set(records.map((r:any)=>mapped.get(r.recording_id)||r.recording_id));
 return version.status==='complete'&&version.scope==='analysis'&&purpose==='synthesis'&&expectedIds.length>0&&expectedIds.every(id=>actual.has(id))&&actual.size===expectedIds.length;
}
