"use client";
import React,{useEffect,useState,useRef} from 'react';
import {api} from './api';
import {Button,Card,Select,Table} from './common';
import {Chart} from './charts';
import {workspacePreviewSeries} from './field-analysis-workspace-data';
import {numberText} from './measurement-common';
export function SavedBladeWaveforms({blade,bladeCode}:{blade:any;bladeCode:string}){
 const generation=useRef(0),controller=useRef<AbortController|null>(null);
 const [data,setData]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{generation.current++;setData(null);setError('');setBusy(false);return()=>{generation.current++;controller.current?.abort();};},[blade.processingResultId,blade.bladeId]);
 async function load(){controller.current?.abort();controller.current=new AbortController();const token=++generation.current;setBusy(true);try{const r=await api<any>('measurements/processing','POST',{request:{action:'waveforms',jobId:blade.processingResultId}},controller.current.signal);if(token===generation.current){setData({...r,processingId:blade.processingResultId});setError('');}}catch(e){if(token===generation.current)setError((e as Error).message);}finally{if(token===generation.current)setBusy(false);}}
 return <Card title="各测点多角度拼接" tools={<><Button disabled={busy} onClick={()=>void load()}>{busy?'正在加载…':'加载同版本波形'}</Button>{busy&&<Button onClick={()=>{generation.current++;controller.current?.abort();setBusy(false);}}>取消读取</Button>}</>}><p className="hint">实测段保持原值，虚线仅为展示接缝。</p>{busy&&<p role="status">正在读取保存版本与五点波形…</p>}{error&&<p role="alert">本版本读取失败，原结果仍保留。{error}</p>}{data?.processingId===blade.processingResultId&&<div className="measurement-chart-grid">{blade.coverage.points.map((p:any)=>{
  const curves=data.curves.filter((c:any)=>String(c.object.blade)===bladeCode&&c.object.point===p.pointName).sort((a:any,b:any)=>a.object.azimuth_deg-b.object.azimuth_deg);let elapsed=0;
  const fallback=curves.map((c:any)=>{const start=c.time_s[0],data=c.time_s.map((t:number,i:number)=>[(elapsed+t-start)*1000,c.velocity_m_s[i]*1000]);elapsed+=c.time_s[c.time_s.length-1]-start;return {name:c.object.azimuth_deg+'°',type:'line',showSymbol:false,connectNulls:false,data};});
  const saved=data.points?.find((v:any)=>String(v.bladeId)===bladeCode&&v.pointName===p.pointName),blocks=saved?.preview?.series;
  const series=blocks?.length?workspacePreviewSeries(saved.preview,p.plannedAzimuths||[]).map(s=>({...s,type:'line',showSymbol:false,connectNulls:false,lineStyle:{type:s.dashed?'dashed':'solid',color:s.color},itemStyle:{color:s.color},data:s.data.map(([t,v])=>[t!*1000,v])})):fallback;
  return <div key={p.pointName}><strong>{p.pointName}{p.radiusM==null?' · 距离未填写':` · ${p.radiusM} m`}</strong>{saved?.reason&&<p className="hint">{String(saved.reason).includes('JOIN_PREVIEW_UNSUPPORTED')?'接缝未通过拟合保护，保留真实独立片段。':saved.reason}</p>}{series.length?<Chart label={p.pointName+'有效片段排列'} height={250} option={{tooltip:{trigger:'axis'},legend:{top:0},grid:{left:65,right:25,top:40,bottom:65},xAxis:{type:'value',name:'展示累计时间 / ms'},yAxis:{type:'value',name:'mm/s'},dataZoom:[{type:'inside'},{type:'slider',bottom:15,height:20}],series}}/>:<p>缺少有效片段，不填零。</p>}</div>;
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
