"use client";
import React,{useEffect,useState} from 'react';
import {api} from './api';
import {Button,Card,CustomSelect,Table,Tag} from './common';
import {Chart} from './charts';
import {numberText,timeText} from './measurement-common';

export function MeasurementFaultValidation({blade,context,summary,canWrite,onSaved}:{blade:any;context:any;summary:any;canWrite:boolean;onSaved:()=>void}) {
 const [data,setData]=useState<any>(null),[point,setPoint]=useState('P3'),[angle,setAngle]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const currentKey=JSON.stringify([context,blade.bladeId,blade.processingResultId]);
 useEffect(()=>{let stale=false;const controller=new AbortController();setData(null);setError('');setAngle('');setBusy(false);
  if(summary?.id){setBusy(true);api<any>('measurements/blade-health','POST',{action:'fault-test-detail',testId:summary.id},controller.signal).then(v=>{if(!stale){setData(v);setPoint(v.point);}}).catch(e=>{if(!stale)setError(e.message);}).finally(()=>{if(!stale)setBusy(false);});}
  return()=>{stale=true;controller.abort();};
 },[summary?.id,currentKey]);
 useEffect(()=>{const first=data?.result?.items?.find((i:any)=>i.available);setAngle(first?String(first.object.azimuth_deg):'');},[data?.id]);
 async function run(){setBusy(true);setError('');try{const result=await api<any>('measurements/blade-health','POST',{action:'fault-test',context,bladeId:blade.bladeId,processingResultId:blade.processingResultId,point});setData(result);onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const items=data?.result?.items||[],selected=items.find((i:any)=>i.available&&String(i.object.azimuth_deg)===angle),plot=selected?.plot,detected=selected?.detection;
 return <Card title="缺陷注入与预警验证 · 测试副本"><p className="hint">复制本叶片一个测点的有效连续波形，注入局部响应增强。原始记录与正式评价保持独立；测试超限仅验证预警流程，不证明现场叶片已有结构损伤。</p>
  <div className="measurement-fault-actions"><label>注入测点<CustomSelect aria-label="缺陷测试测点" value={point} disabled={busy} onChange={e=>setPoint(e.target.value)}>{blade.coverage.points.map((p:any)=><option key={p.pointName} value={p.pointName}>{p.pointName}</option>)}</CustomSelect></label><Button variant="primary" disabled={!canWrite||busy} onClick={()=>void run()}>{busy?'正在处理…':'运行缺陷注入测试'}</Button></div>
  {error&&<p role="alert">{error}</p>}
  {data&&<><div className="measurement-fault-banner" role="status"><Tag tone={data.status==='warning'?'red':'blue'}>{data.label}</Tag><span>{data.point} · {timeText(data.createdAt)}</span><span>来源版本 {data.sourceProcessingResultId.slice(0,8)}</span></div><p>{data.name}</p>
   <Table headers={['角度','原样对照','注入后检测','持续窗口数','持续区间最大 RMS 倍率']}>
    {items.map((i:any)=><tr key={i.resultId}><td>{i.object.azimuth_deg}°</td><td>{i.available?(i.control.status==='normal'?'未触发阈值':'对照待复核'):'不可用'}</td><td>{i.available?(i.detection.suspectedDamage?'疑似损伤预警（测试）':'未触发阈值'):i.reason}</td><td>{i.detection?.maxConsecutiveWindows??'—'}</td><td>{numberText(i.detection?.maxSustainedRmsRatio,2)}</td></tr>)}
   </Table>
   <nav className="measurement-tabs" aria-label="缺陷测试波形角度">{items.filter((i:any)=>i.available).map((i:any)=><button key={i.resultId} className={String(i.object.azimuth_deg)===angle?'active':''} onClick={()=>setAngle(String(i.object.azimuth_deg))}>{i.object.azimuth_deg}°</button>)}</nav>
   {plot&&<Chart label="原样与缺陷测试副本波形" height={340} option={{tooltip:{trigger:'axis'},legend:{data:['原样对照','缺陷测试副本']},grid:{left:85,right:30,top:50,bottom:65},xAxis:{type:'value',name:'片段时间 / ms'},yAxis:{type:'value',name:'速度 / mm/s'},dataZoom:[{type:'inside'},{type:'slider',bottom:8,height:20}],series:[{name:'原样对照',type:'line',showSymbol:false,lineStyle:{color:'#64748b',width:1},data:plot.time_s.map((t:number,i:number)=>[t*1000,plot.reference_m_s[i]*1000])},{name:'缺陷测试副本',type:'line',showSymbol:false,lineStyle:{color:'#dc4457',width:1.5},data:plot.time_s.map((t:number,i:number)=>[t*1000,plot.test_m_s[i]*1000]),markArea:{silent:true,itemStyle:{color:'rgba(220,68,87,.09)'},data:detected.events.map((e:any)=>[{xAxis:e.start_seconds*1000},{xAxis:e.end_seconds*1000}])}}]}}/>}
   {detected&&<details><summary>算法依据与测试来源</summary><p>按原采样连续波形计算，图形抽稀只用于展示。滑动窗去均值后，RMS 和峰峰值均达到原样的 1.8 倍且连续至少 3 窗，触发测试预警；持续区间 RMS 达到 3 倍为高等级响应异常。阈值仅用于工程测试，未经过现场损伤样本标定。</p><p>注入模型为局部残差增益和短时振荡，不是物理裂纹模型。原样只作为本次注入试验的配对对照，不认定为健康基线。</p><pre>{JSON.stringify({algorithm:data.result.algorithmVersion,artifactId:data.result.artifactId,test_only:true,sourceHash:selected.sourceHash,sourceRange:selected.sourceRange,injection:selected.injection,policy:detected.policy,events:detected.events},null,2)}</pre></details>}
  </>}
 </Card>;
}
