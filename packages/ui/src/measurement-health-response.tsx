"use client";
import React,{useEffect,useState,useRef} from 'react';
import {api} from './api';
import {Button,Card,Select,Table} from './common';
import {Chart} from './charts';
import {numberText} from './measurement-common';
export function SavedBladeWaveforms({blade,bladeCode}:{blade:any;bladeCode:string}){
 const generation=useRef(0);
 const [data,setData]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{generation.current++;setData(null);setError('');setBusy(false);},[blade.processingResultId,blade.bladeId]);
 async function load(){const token=generation.current;setBusy(true);try{const r=await api<any>('measurements/processing','POST',{request:{action:'waveforms',jobId:blade.processingResultId}});if(token===generation.current){setData({...r,processingId:blade.processingResultId});setError('');}}catch(e){if(token===generation.current)setError((e as Error).message);}finally{if(token===generation.current)setBusy(false);}}
 return <Card title="五测点有效片段排列" tools={<Button disabled={busy} onClick={()=>void load()}>{busy?'正在加载…':'加载同版本五点波形'}</Button>}><p className="hint">各角度为独立真实片段，累计有效时间上保持断线；无整圈连续振动或同步相位。</p>{error&&<p role="alert">{error}</p>}{data?.processingId===blade.processingResultId&&<div className="measurement-chart-grid">{blade.coverage.points.map((p:any)=>{
  const curves=data.curves.filter((c:any)=>String(c.object.blade)===bladeCode&&c.object.point===p.pointName).sort((a:any,b:any)=>a.object.azimuth_deg-b.object.azimuth_deg);let elapsed=0;
  const series=curves.map((c:any)=>{const start=c.time_s[0],data=c.time_s.map((t:number,i:number)=>[(elapsed+t-start)*1000,c.velocity_m_s[i]*1000]);elapsed+=c.time_s[c.time_s.length-1]-start;return {name:c.object.azimuth_deg+'°',type:'line',showSymbol:false,connectNulls:false,data};});
  return <div key={p.pointName}><strong>{p.pointName} · {p.radiusM} m</strong>{series.length?<Chart label={p.pointName+'有效片段排列'} height={250} option={{tooltip:{trigger:'axis'},legend:{top:0},grid:{left:65,right:25,top:40,bottom:65},xAxis:{type:'value',name:'有效时间 / ms'},yAxis:{type:'value',name:'mm/s'},dataZoom:[{type:'inside'},{type:'slider',bottom:15,height:20}],series}}/>:<p>缺少有效片段，不填零。</p>}</div>;
 })}</div>}</Card>;
}
export function BladeResponseMatrix({blade}:{blade:any}){
 const [metric,setMetric]=useState('amplitude');
 const angles=[...new Set<number>(blade.coverage.points.flatMap((p:any)=>p.plannedAzimuths||[]))].sort((a,b)=>a-b);
 return <Card title="方位 × 测点响应矩阵" tools={<Select label="矩阵指标" value={metric} onChange={setMetric} options={[{value:'amplitude',label:'半峰峰值 · mm/s'},{value:'rms',label:'连续段 RMS · mm/s'},{value:'peak',label:'响应峰 · Hz（非模态）'}]}/>}><Table headers={['测点',...angles.map(a=>a+'°')]}>{blade.coverage.points.map((p:any)=><tr key={p.pointName}><td>{p.pointName}</td>{angles.map(a=>{
  const matches=blade.features.filter((r:any)=>r.point===p.pointName&&r.azimuthDeg===a),values=matches.map((r:any)=>metric==='peak'?r.peaks?.[0]?.frequency_hz:metric==='rms'?r.features?.rms_m_s*1000:r.features?.half_peak_to_peak_m_s*1000).filter(Number.isFinite),v=values.length===1?values[0]:null;
  return <td key={a} className={v===null?'blade-matrix-missing':'blade-matrix-value'}>{v===null?'缺测 / 待复核':numberText(v,3)}</td>;
 })}</tr>)}</Table><p className="hint">缺项不补零；不同记录的最高响应峰不直接作为同一模态比较。</p></Card>;
}
