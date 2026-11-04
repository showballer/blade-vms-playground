import {finite,array,type AnalysisTask,type AnalysisCatalogRecord,type AnalysisJson} from './field-record-analysis-data';
export type DesktopAlgorithmOptions={measurementMode?:'indoor'|'outdoor';detrend:'none'|'constant'|'linear';filterKind:'none'|'lowpass'|'highpass'|'bandpass';lowHz:number|null;highHz:number|null;filterOrder:number;window:'hann'|'hamming'|'blackman'|'boxcar';geometry?:{direction:'los'|'axial_equivalent';uprightAssumption:boolean;minAbsProjection:number|null;maxProjectionGain:number|null;distanceMeaning:string;inputOverrides:any;recordOverrides?:Record<string,any>;observationModel?:string;axialDominanceDeclared?:boolean;instrumentSign?:number|null;signSource?:string|null};targetBandMode?:'preview'|'custom'|'none';targetBandHz?:number[]|null;targetBandSource?:string|null};
export const desktopAlgorithmDefaults:DesktopAlgorithmOptions={measurementMode:'indoor',detrend:'linear',filterKind:'none',lowHz:null,highHz:null,filterOrder:4,window:'hann',targetBandMode:'preview',targetBandHz:null,targetBandSource:null};
export function normalizedAlgorithmOptions(saved:Partial<DesktopAlgorithmOptions>):DesktopAlgorithmOptions{
 const mode=saved.targetBandMode||(saved.targetBandHz?'custom':'preview');
 return {...desktopAlgorithmDefaults,...saved,targetBandMode:mode,...(mode!=='custom'?{targetBandHz:null,targetBandSource:null}:{targetBandSource:saved.targetBandSource||'用户指定的响应统计频带；非已确认模态频带'})};
}
export function previewBandForRates(rates:number[]){
 const known=rates.filter(v=>Number.isFinite(v)&&v>0);if(!known.length)return null;
 const nyquist=Math.min(...known)/2;return {band:[Math.min(100,nyquist*.1),Math.min(20000,nyquist)],nyquist};
}
export function responseBandMessage(plan:AnalysisJson){
 const reasons:Record<string,string>={BAND_DISABLED:'已关闭频带统计，原始波形和频谱仍可查看',NO_ELIGIBLE_OBSERVATION:'没有通过质量检查的连续段，请先查看原始记录与复核原因',BAND_ABOVE_NYQUIST:'指定频带超过采样率允许的上限，请缩小范围或使用宽频预览',NO_RESOLVED_FREQUENCY_BINS:'当前有效时长与谱窗不能分辨此频带，请扩大范围或采集更长的连续数据',TARGET_BAND_NOT_CONFIGURED:'此历史版本未配置频带；返回当前配置可使用宽频预览'};
 return reasons[plan?.targetBandReason]||'共同频带内无可比实测结果';
}
export type RecordFilters={taskName:string;windFarm:string;turbine:string;bladeId:string};
export const emptyRecordFilters:RecordFilters={taskName:'',windFarm:'',turbine:'',bladeId:''};
export function workspaceHistory(jobs:AnalysisJson[],taskId:string|undefined,purpose:'signal'|'synthesis',selectedIds:string[]){
 const ids=new Set(selectedIds);
 return jobs.filter(j=>j.status==='complete'&&j.taskId===taskId&&(!j.workspacePurpose||j.workspacePurpose===purpose)&&
  (purpose==='signal'?array<string>(j.recordingIds).some(id=>ids.has(id)):
   array<string>(j.recordingIds).length>0&&array<string>(j.recordingIds).every(id=>ids.has(id))));
}
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
 // dB reference is 1 (mm/s)^2/Hz. Color clipping only; source powers remain unchanged.
 const heat=frequencies.flatMap((_f,fi)=>times.map((_t,ti)=>[ti,fi,finite(psd[fi]?.[ti])?10*Math.log10(Math.max(psd[fi][ti]*1e6,1e-30)):null]).filter(row=>finite(row[2])));
 if(!heat.length)return null;
 const max=heat.reduce((v,row)=>Math.max(v,row[2]!),-Infinity),min=max-80;
 const energy=psd.map(row=>row.reduce((a,v)=>a+(finite(v)&&v>0?v:0),0)),total=energy.reduce((a,v)=>a+v,0);let sum=0,end=frequencies.length-1;
 for(let i=0;i<energy.length;i++){sum+=energy[i];if(total&&sum>=total*.95){end=Math.min(frequencies.length-1,Math.max(8,Math.ceil(i*1.2)));break;}}
 return {animation:false,tooltip:{confine:true,renderMode:'richText',formatter:(p:any)=>`原始时间 ${times[p.value[0]].toFixed(5)} s\n频率 ${frequencies[p.value[1]].toFixed(1)} Hz\nPSD ${p.value[2].toFixed(1)} dB re 1 (mm/s)²/Hz`},
  grid:{left:76,right:50,top:40,bottom:100},
  xAxis:{type:'category',data:times.map(v=>v.toFixed(4)),name:'原始时间 / s',nameLocation:'middle',nameGap:25,axisLabel:{hideOverlap:true}},
  yAxis:{type:'category',data:frequencies.map(v=>v.toFixed(1)),name:'频率 / Hz',axisLabel:{hideOverlap:true}},
  dataZoom:[{type:'inside',yAxisIndex:0,startValue:0,endValue:end,filterMode:'none'},{type:'slider',yAxisIndex:0,right:5,width:14,startValue:0,endValue:end,filterMode:'none'}],
  visualMap:{min,max,calculable:true,orient:'horizontal',left:'center',bottom:8,text:['PSD · dB re 1 (mm/s)²/Hz',''],precision:1,inRange:{color:['#edf3fa','#8ab9df','#2766ac','#f3bf53','#bd3628']}},
  series:[{type:'heatmap',data:heat,progressive:0,animation:false,emphasis:{disabled:true}}]};
}
export function desktopRecordLabel(task:AnalysisTask,record:AnalysisCatalogRecord){
 const known=(v:unknown,fallback:string)=>v===undefined||v===null||v===''?fallback:String(v);
 return [known(task.name,'未填写任务'),known(task.windFarm,'未填写风场'),known(task.turbine,'未填写风机'),'叶片'+known(record.bladeId,'未知'),known(typeof record.pointName==='string'&&/^\d+\s*(点|个样本|samples)$/.test(record.pointName)?null:record.pointName,'未填写测点'),finite(record.azimuthDeg)?record.azimuthDeg+'°':'未知角度'].join('－');
}
export function algorithmError(o:DesktopAlgorithmOptions,records:(AnalysisCatalogRecord&{sampleRate?:number})[]){
 if((o.targetBandMode==='custom'||!o.targetBandMode&&o.targetBandHz)&&(!o.targetBandHz||!o.targetBandHz.every(Number.isFinite)||!(o.targetBandHz[0]>=0&&o.targetBandHz[1]>o.targetBandHz[0])))return '请填写有效频带：下限不小于0，上限大于下限';
 if(o.geometry?.direction==='axial_equivalent'&&(!(Number(o.geometry.minAbsProjection)>0)||!(Number(o.geometry.maxProjectionGain)>=1)))return '轴向换算需明确投影门槛和几何假设';
 if(!Number.isInteger(o.filterOrder)||o.filterOrder<1||o.filterOrder>12)return '滤波阶数应为1～12的整数';
 const needLow=['highpass','bandpass'].includes(o.filterKind),needHigh=['lowpass','bandpass'].includes(o.filterKind);
 if(needLow&&!(typeof o.lowHz==='number'&&o.lowHz>0)||needHigh&&!(typeof o.highHz==='number'&&o.highHz>0))return '请填写大于0的截止频率';
 if(o.filterKind==='bandpass'&&o.lowHz!>=o.highHz!)return '下限截止频率必须小于上限';
 const fs=records.map(r=>r.sampleRate).filter(finite);const max=Math.min(...fs)/2;
 if(needLow&&o.lowHz!>=max||needHigh&&o.highHz!>=max)return `截止频率必须小于所选记录的Nyquist上限 ${max} Hz`;
 return '';
}
export function workspaceAzimuthColor(angle:number,planned:number[]){
 const palette=['#2563eb','#059669','#dc4d65','#9333ea','#0891b2'];
 const order=planned.length?planned:[0,90,180,270];
 return palette[Math.max(0,order.indexOf(angle))%palette.length];
}
export function workspacePreviewSeries(preview:AnalysisJson,planned:number[]){
 return array(preview?.series).map(b=>{
  const gap=b.kind==='display_gap',measured=b.kind==='measured_processed';
  return {name:gap?`${b.left_azimuth_deg}°→${b.right_azimuth_deg}° 未拟合`:measured?`${b.azimuth_deg??b.azimuth??'实测'}°`:'拟合接缝',
   data:array<number>(b.time_s).map((x,j)=>[x,gap||!finite(b.values_m_s?.[j])?null:b.values_m_s[j]*1000]),
   dashed:!measured,displayOnlyGap:gap,color:gap?'#94a3b8':measured?workspaceAzimuthColor(b.azimuth_deg??b.azimuth,planned):'#d97706'};
 });
}
export function workspacePointSeries(report:AnalysisJson,details:Record<string,AnalysisJson>,point:string,bladeId:string){
 const records=array(report.records).filter(r=>String(r.object?.blade)===bladeId&&r.object?.point===point);
 const coverage=array(report.coverage?.points).find(p=>String(p.bladeId)===bladeId&&p.pointName===point);
 const planned=[...new Set([...array<number>(coverage?.plannedAzimuths),...records.map(r=>r.object.azimuth_deg).filter(finite)])].sort((a,b)=>a-b);
 const cores=new Map<number,number[][]>();
 for(const r of records){
  const angle=r.object.azimuth_deg;if(!r.quality_assessment?.analysis_eligible||!finite(angle)||cores.has(angle))continue;
  const s=array(details[r.recording_id]?.segments).find(s=>s.result_id===r.representative);if(!s)continue;
  const lo=s.analysis_source_start??s.source_start,hi=s.analysis_source_end??s.source_end,indices=array<number>(s.source_indices),y=array<number>(s.layers?.[s.layer]),times=array<number>(s.time_s);
  const pairs=times.flatMap((t,i)=>indices[i]>=lo&&indices[i]<hi?[[t,y[i]*1000]]:[]);
  if(pairs.length)cores.set(angle,pairs);
 }
 if(!cores.size)return [];
 // Display spacing only: missing angles have null values, never synthetic
 // samples or an inferred physical duration. Unfitted real cores stay apart.
 const total=[...cores.values()].reduce((sum,pairs)=>sum+pairs.at(-1)![0]-pairs[0][0],0),gap=Math.max(total*.08,.000001);
 let elapsed=0;const series:any[]=[];
 for(const angle of planned){
  const pairs=cores.get(angle),color=workspaceAzimuthColor(angle,planned);
  if(!pairs){series.push({name:`${angle}° 待复核／缺失`,data:[[elapsed,null],[elapsed+gap,null]],color:'#94a3b8',dashed:true,displayOnlyGap:true});elapsed+=gap;continue;}
  const data=pairs.map(([x,y])=>[elapsed+x-pairs[0][0],y]);
  series.push({name:angle+'°',data,color});elapsed=data.at(-1)![0]+gap/4;
 }
 return series;
}
