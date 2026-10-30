/** Match only real segment times. SCADA averages are context, never keyphasor data. */
export type WindTimeSemantics={timeBasis:'instantaneous'|'interval_mean'|'unknown';intervalSeconds:number;timestampPosition:'start'|'center'|'end';timezone:string;clockOffsetMs:number;maxGapMs:number;rpmMeaning:'rotor'|'unknown';basis:string};
export function validateWindTimeSemantics(input:any):WindTimeSemantics{
 const v={timeBasis:'unknown',intervalSeconds:60,timestampPosition:'start',timezone:'+08:00',clockOffsetMs:0,maxGapMs:0,rpmMeaning:'unknown',basis:'',...input};
 if(!['instantaneous','interval_mean','unknown'].includes(v.timeBasis)||!['start','center','end'].includes(v.timestampPosition)||!['rotor','unknown'].includes(v.rpmMeaning)||!/^([+-](?:0\d|1[0-4]):[0-5]\d|UTC|Z)$/.test(v.timezone))throw Error('工况时间或转速语义无效');
 for(const [k,min,max] of [['intervalSeconds',.001,86400],['clockOffsetMs',-86400000,86400000],['maxGapMs',0,3600000]] as const)if(typeof v[k]!=='number'||!Number.isFinite(v[k])||v[k]<min||v[k]>max)throw Error('工况时间范围无效');
 if(typeof v.basis!=='string'||v.basis.length>500||(v.clockOffsetMs!==0&&!v.basis.trim()))throw Error('时间偏移必须填写校准依据');
 return v;
}
export function matchSegmentConditions(datasets:any[],farmId:string,turbineCode:string,segments:{start:number;end:number}[]){
 const valid=segments.filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>=s.start);
 const begin=valid.length?Math.min(...valid.map(s=>s.start)):0,end=valid.length?Math.max(...valid.map(s=>s.end)):0;
 const base:any={status:'unmatched',datasetIds:[],samples:0,availableSamples:0,conflictingSamples:0,start:new Date(begin).toISOString(),end:new Date(end).toISOString(),segments:[],timeBasis:'unknown',matchMethod:'none',healthEligible:false,synchronousRpm:false,reasons:[]};
 if(!valid.length)return {...base,reasons:['缺少有效片段绝对时间']};
 const candidates=datasets.filter(d=>d.farmId===farmId).flatMap(d=>{
   const explicit=!!d.timeSemantics;let sem;try{sem=validateWindTimeSemantics(d.timeSemantics||{timeBasis:'instantaneous'});}catch{return [];}
   return (d.rows||[]).filter((r:any)=>r.turbineCode===turbineCode).map((r:any)=>({r,sem,explicit,datasetId:d.id,time:Date.parse(r.time)+sem.clockOffsetMs}));
 });
 const fields=['windSpeed','rpm','powerKw','temperatureC','windDirection'];const used=new Set<string>();let unknown=false,averaged=false,nearest=false;const conflictTimes=new Set<number>(),sampleTimes=new Set<number>(),windTimes=new Set<number>(),rpmTimes=new Set<number>(),observations:Record<string,number[]>={};
 for(const span of valid){
   const matched:any={start:new Date(span.start).toISOString(),end:new Date(span.end).toISOString(),fields:{},fieldMatches:{},ambiguousFields:[],datasetIds:[],method:'none',maxGapMs:0};
   for(const field of fields){
    const available=candidates.filter(c=>Number.isFinite(c.r[field])&&c.sem.timeBasis!=='unknown');
    const inside=available.filter(c=>{if(c.sem.timeBasis==='interval_mean'){const duration=c.sem.intervalSeconds*1000,left=c.time-(c.sem.timestampPosition==='end'?duration:c.sem.timestampPosition==='center'?duration/2:0);return left<span.end&&left+duration>span.start;}return c.time>=span.start&&c.time<=span.end;});
    let chosen=inside;if(!chosen.length){const distances=available.filter(c=>c.sem.timeBasis==='instantaneous').map(c=>({c,gap:Math.max(span.start-c.time,c.time-span.end,0)})).filter(x=>x.c.sem.maxGapMs>0&&x.gap<=x.c.sem.maxGapMs);const gap=distances.reduce((min,x)=>Math.min(min,x.gap),Infinity);chosen=distances.filter(x=>x.gap===gap).map(x=>x.c);if(new Set(chosen.map(c=>c.time)).size>1&&new Set(chosen.map(c=>c.r[field])).size>1){matched.ambiguousFields.push(field);chosen=[];}if(chosen.length){nearest=true;matched.maxGapMs=Math.max(matched.maxGapMs,gap);matched.method='nearest';}}
    const groups=new Map<number,typeof chosen>();for(const c of chosen)groups.set(c.time,[...(groups.get(c.time)||[]),c]);
    // Never select a winner among conflicting observations at the same timestamp.
    const clean=[...groups.values()].filter(items=>{const conflict=fields.some(f=>new Set(items.map(c=>c.r[f]).filter(Number.isFinite)).size>1)||new Set(items.map(c=>JSON.stringify([c.sem.timeBasis,c.sem.timeBasis==='interval_mean'?c.sem.intervalSeconds:0,c.sem.timestampPosition]))).size>1;if(conflict)conflictTimes.add(items[0].time);return !conflict;}).flat();
    if(!clean.length)continue;
    const weights=clean.map(c=>{if(c.sem.timeBasis!=='interval_mean')return 1;averaged=true;const dur=c.sem.intervalSeconds*1000,left=c.time-(c.sem.timestampPosition==='end'?dur:c.sem.timestampPosition==='center'?dur/2:0);return Math.max(0,Math.min(span.end,left+dur)-Math.max(span.start,left));});
    const denominator=weights.reduce((a,b)=>a+b,0);if(!denominator)continue;
    matched.fieldMatches[field]={datasetIds:[...new Set(clean.map(c=>c.datasetId))],timeBasis:[...new Set(clean.map(c=>c.sem.timeBasis))],maxGapMs:matched.maxGapMs,sourceTimes:clean.slice(0,100).map(c=>({time:new Date(c.time).toISOString(),clockOffsetMs:c.sem.clockOffsetMs,basis:c.sem.basis})),sourceCount:clean.length};
    matched.fields[field]=clean.reduce((sum,c,i)=>sum+c.r[field]*weights[i],0)/denominator;
    observations[field]=[...(observations[field]||[]),...clean.map(c=>c.r[field])];for(const c of clean){if(field==="windSpeed")windTimes.add(c.time);if(field==="rpm")rpmTimes.add(c.time);if(field==="windSpeed"||field==="rpm")sampleTimes.add(c.time);used.add(c.datasetId);matched.datasetIds.push(c.datasetId);if(!c.explicit||c.sem.rpmMeaning!=='rotor')unknown=true;}
    matched.method=averaged?'interval_overlap':matched.method==='nearest'?'nearest':'exact_window';
   }
   matched.datasetIds=[...new Set(matched.datasetIds)];matched.status=Number.isFinite(matched.fields.windSpeed)&&Number.isFinite(matched.fields.rpm)?'matched':'unmatched';base.segments.push(matched);
 }
 const complete=base.segments.filter((s:any)=>s.status==='matched');base.matchedSegments=complete.length;base.samples=complete.length?[...windTimes].filter(t=>rpmTimes.has(t)).length||complete.length:0;base.availableSamples=base.segments.filter((s:any)=>Object.keys(s.fields).length).length;base.conflictingSamples=conflictTimes.size;base.datasetIds=[...used];
 if(complete.length===valid.length){base.status='matched';for(const field of fields){const values=complete.map((s:any)=>s.fields[field]).filter(Number.isFinite);if(values.length){base[field]=values.reduce((a:number,b:number)=>a+b,0)/values.length;if(field==='windSpeed'||field==='rpm')base[field==='rpm'?'rpmRange':'windRange']=(observations[field]||values).reduce((bounds:number[],v:number)=>[Math.min(bounds[0],v),Math.max(bounds[1],v)],[Infinity,-Infinity]);}}}
 base.timeBasis=averaged?'interval_mean':unknown?'unknown':'instantaneous';base.matchMethod=averaged?'interval_overlap':nearest?'nearest':'exact_window';base.healthEligible=base.status==='matched'&&!averaged&&!unknown&&!conflictTimes.size;base.reasons=[...(base.status!=='matched'?['部分有效片段缺少同时可用的风速和转速']:[]),...(averaged?['区间均值仅作为背景工况，不代表瞬时转速']:[]),...(unknown?['来源时间或转速物理语义尚未确认']:[]),...(conflictTimes.size?['存在冲突观测，未采用冲突值']:[])];return base;
}
export function processingSegmentTimes(record:any){
 const epoch=(v:any)=>typeof v==='number'?v* (v<1e11?1000:1):Date.parse(v);
 const start=epoch((typeof record.sample_origin === "number" ? record.sample_origin : record.sample_origin?.unixTime??record.sample_origin?.epochSeconds)??record.started_at);
 const fs=record.sample_rate_hz;if(!Number.isFinite(start)||!(fs>0))return [];
 return (record.segments||[]).filter((s:any)=>Number.isFinite(s.source_start)&&Number.isFinite(s.source_end)&&s.source_end>s.source_start).map((s:any)=>({start:start+s.source_start/fs*1000,end:start+s.source_end/fs*1000,resultId:s.result_id}));
}
export function windDatasetRevisionInput(datasets:any[],farmId:string){return datasets.filter(d=>d.farmId===farmId).map(d=>[d.id,d.timingUpdatedAt||d.importedAt||null,d.timeSemantics||null,d.rowCount??d.rows?.length??0]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));}
