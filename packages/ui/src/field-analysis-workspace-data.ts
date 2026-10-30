import {finite,array,type AnalysisTask,type AnalysisCatalogRecord,type AnalysisJson} from './field-record-analysis-data';
export type DesktopAlgorithmOptions={detrend:'none'|'constant'|'linear';filterKind:'none'|'lowpass'|'highpass'|'bandpass';lowHz:number|null;highHz:number|null;filterOrder:number;window:'hann'|'hamming'|'blackman'|'boxcar'};
export const desktopAlgorithmDefaults:DesktopAlgorithmOptions={detrend:'linear',filterKind:'none',lowHz:null,highHz:null,filterOrder:4,window:'hann'};
export type RecordFilters={taskName:string;windFarm:string;turbine:string;bladeId:string};
export const emptyRecordFilters:RecordFilters={taskName:'',windFarm:'',turbine:'',bladeId:''};
const taskName=(task:AnalysisTask)=>task.name||'未填写任务';
const farmName=(task:AnalysisTask)=>task.windFarm||'未填写风场';
const turbineName=(task:AnalysisTask)=>task.turbine||'未填写风机';
const bladeName=(record:AnalysisCatalogRecord)=>String(record.bladeId??'未知');
export function recordFilterChoices(tasks:AnalysisTask[],filters:RecordFilters){
 const unique=(values:string[])=>[...new Set(values)].sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
 const byTask=tasks.filter(t=>!filters.taskName||taskName(t)===filters.taskName);
 const byFarm=byTask.filter(t=>!filters.windFarm||farmName(t)===filters.windFarm);
 const byTurbine=byFarm.filter(t=>!filters.turbine||turbineName(t)===filters.turbine);
 const records=byTurbine.flatMap(task=>task.records.filter(r=>!filters.bladeId||bladeName(r)===filters.bladeId).map(r=>({...r,task})));
 return {taskNames:unique(tasks.map(taskName)),windFarms:unique(byTask.map(farmName)),turbines:unique(byFarm.map(turbineName)),
  bladeIds:unique(byTurbine.flatMap(t=>t.records.map(bladeName))),records};
}
export function changeRecordFilter(filters:RecordFilters,key:keyof RecordFilters,value:string):RecordFilters{
 const next={...filters,[key]:value};
 if(key==='taskName')return {...next,windFarm:'',turbine:'',bladeId:''};
 if(key==='windFarm')return {...next,turbine:'',bladeId:''};
 if(key==='turbine')return {...next,bladeId:''};
 return next;
}
export function workspaceStftOption(stft:AnalysisJson|null):AnalysisJson|null{
 const matrix=stft?.data;if(!matrix)return null;
 const times=array<number>(matrix.time_s),frequencies=array<number>(matrix.frequency_hz),psd=array<number[]>(matrix.psd_m2_s2_per_hz);
 const heat=frequencies.flatMap((_f,fi)=>times.map((_t,ti)=>[ti,fi,psd[fi]?.[ti]]).filter(row=>finite(row[2])));
 if(!heat.length)return null;
 return {animation:false,animationDuration:0,animationDurationUpdate:0,tooltip:{position:'top',confine:true},
  grid:{left:70,right:30,top:20,bottom:100},
  xAxis:{type:'category',data:times.map(v=>v.toFixed(4)),name:'原始时间 / s'},
  yAxis:{type:'category',data:frequencies.map(v=>v.toFixed(1)),name:'Hz'},
  visualMap:{min:0,max:heat.reduce((m,row)=>Math.max(m,row[2]!),0)||1,orient:'horizontal',left:'center',bottom:10},
  series:[{type:'heatmap',data:heat,progressive:0,animation:false,emphasis:{disabled:true}}]};
}
export function desktopRecordLabel(task:AnalysisTask,record:AnalysisCatalogRecord){
 const known=(v:unknown,fallback:string)=>v===undefined||v===null||v===''?fallback:String(v);
 return [known(task.name,'未填写任务'),known(task.turbine,'未填写风机'),'叶片'+known(record.bladeId,'未知'),known(typeof record.pointName==='string'&&/^\d+\s*(点|个样本|samples)$/.test(record.pointName)?null:record.pointName,'未填写测点'),finite(record.azimuthDeg)?record.azimuthDeg+'°':'未知角度'].join('－');
}
export function algorithmError(o:DesktopAlgorithmOptions,records:(AnalysisCatalogRecord&{sampleRate?:number})[]){
 if(!Number.isInteger(o.filterOrder)||o.filterOrder<1||o.filterOrder>12)return '滤波阶数应为1～12的整数';
 const needLow=['highpass','bandpass'].includes(o.filterKind),needHigh=['lowpass','bandpass'].includes(o.filterKind);
 if(needLow&&!(typeof o.lowHz==='number'&&o.lowHz>0)||needHigh&&!(typeof o.highHz==='number'&&o.highHz>0))return '请填写大于0的截止频率';
 if(o.filterKind==='bandpass'&&o.lowHz!>=o.highHz!)return '下限截止频率必须小于上限';
 const fs=records.map(r=>r.sampleRate).filter(finite);const max=Math.min(...fs)/2;
 if(needLow&&o.lowHz!>=max||needHigh&&o.highHz!>=max)return `截止频率必须小于所选记录的Nyquist上限 ${max} Hz`;
 return '';
}
export function workspacePointSeries(report:AnalysisJson,details:Record<string,AnalysisJson>,point:string,bladeId:string){
 let elapsed=0;const series:any[]=[];
 const records=array(report.records).filter(r=>String(r.object?.blade)===bladeId&&r.object?.point===point&&r.quality_assessment?.analysis_eligible).sort((a,b)=>(a.object.azimuth_deg??0)-(b.object.azimuth_deg??0));
 const seen=new Set<number>();
 for(const r of records){if(seen.has(r.object.azimuth_deg))continue;seen.add(r.object.azimuth_deg);const s=array(details[r.recording_id]?.segments).find(s=>s.result_id===r.representative);if(!s)continue;const lo=s.analysis_source_start??s.source_start,hi=s.analysis_source_end??s.source_end,indices=array<number>(s.source_indices),y=array<number>(s.layers?.[s.layer]),times=array<number>(s.time_s);const sourceLo=lo,sourceHi=hi;const pairs=times.flatMap((t,i)=>indices[i]>=sourceLo&&indices[i]<sourceHi?[[elapsed+t-times[0],y[i]*1000]]:[]);if(!pairs.length)continue;const origin=pairs[0][0];const data=pairs.map(([x,y])=>[x-origin+elapsed,y]);elapsed=data.at(-1)![0];series.push({name:r.object.azimuth_deg+'°',data});}
 return series;
}
