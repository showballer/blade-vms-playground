"use client";
import React,{useEffect,useState,useRef} from 'react';
import {api} from './api';
import {Button,Card,Dialog,Table,Tag} from './common';
import {Chart} from './charts';
import {ObjectFilters,MeasurementStatus,useMeasurements,useMeasurementContext,openMeasurementWorkspace,numberText,timeText,selectedProcessingResult} from './measurement-common';
import {SavedBladeWaveforms,BladeResponseMatrix} from "./measurement-health-response";
import {MeasurementResponse3D} from './measurement-response-3d';
import {FieldRecordAnalysis,type RecordAnalysisBridge} from './field-record-analysis';
import type {ContextProps} from './common';

export function MeasurementHealth(props:ContextProps){
 const {data,loading,error,setError}=useMeasurements();const [filter,setFilter]=useMeasurementContext();
 const [activeSlot,setActiveSlot]=useState('');
 const [workspace,setWorkspace]=useState<any>(null),[busy,setBusy]=useState(false),[tab,setTab]=useState('response'),[details,setDetails]=useState<any>(null),[review,setReview]=useState<any>(null),[note,setNote]=useState('');
 const scope={farmId:filter.farmId,campaignId:filter.campaignId,turbineId:filter.turbineId},key=JSON.stringify(scope);const processingResultId=selectedProcessingResult(scope),canWrite=props.canWrite;const latestScope=useRef(key);latestScope.current=key;
 useEffect(()=>{if(!filter.farmId){const s=data.sources.find(s=>s.context?.farmId);if(s)setFilter(s.context);}},[data.sources,filter.farmId]);
 async function refresh(save=false){setBusy(true);try{const r=await api('measurements/blade-health','POST',{action:save?'evaluate':'workspace',context:scope,processingResultId});if(latestScope.current===key){setWorkspace(r);setError('');}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 useEffect(()=>{let current=true;setWorkspace(null);if(!scope.farmId||!scope.campaignId||!scope.turbineId)return;setBusy(true);api('measurements/blade-health','POST',{action:'workspace',context:scope,processingResultId}).then(r=>{if(current)setWorkspace(r);}).catch(e=>{if(current)setError(e.message);}).finally(()=>{if(current)setBusy(false);});return()=>{current=false;};},[key]);
 useEffect(()=>setActiveSlot(""),[key]);
 const blade=workspace?.blades.find((b:any)=>(b.bladeId||b.name)===activeSlot)||workspace?.blades.find((b:any)=>b.bladeId===filter.bladeId)||workspace?.blades.find((b:any)=>b.processingResultId)||workspace?.blades[0];
 const group=blade?.commonResponse?.find((g:any)=>g.layer==='los_residual')||blade?.commonResponse?.[0];const points=group?.points||[],max=Math.max(0,...points.map((p:any)=>p.mean_half_peak_to_peak_m_s||0));
 const matched=(blade?.conditions||[]).filter((c:any)=>c.condition.status==='matched');
 async function openProcessing(){if(!blade?.processingResultId)return;setBusy(true);try{setDetails((await api<any>('measurements/processing','POST',{request:{action:'snapshot',jobId:blade.processingResultId}})).result);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const readOnly:RecordAnalysisBridge=async <T,>(o:any)=>{
  const c=o.request;if(c.action==='catalog')return {tasks:[details.task],revision:details.inputKey} as T;
  if(c.action==='start'||c.action==='status')return {jobId:details.id,status:'complete',total:details.total,completed:details.total} as T;
  if(c.action==='cancel')throw Error('已保存版本只读');
  if(c.action==='export')throw Error('请前往模态识别导出分析包');
  return api<T>('measurements/processing','POST',{request:{...c,jobId:details.id}});
 };
 return <div className="stack measurement-workspace blade-health-v2"><header className="measurement-heading"><div><h1>健康监测</h1><p>按风机查看每片叶片的响应、工况和证据。</p></div><div className="measurement-heading-actions"><Button disabled={busy||!scope.turbineId} onClick={()=>void refresh(false)}>刷新</Button><Button variant="primary" disabled={!canWrite||busy||!scope.turbineId} onClick={()=>void refresh(true)}>重新关联工况与更新评价</Button></div></header>
  <Card title="测量范围"><ObjectFilters objects={data.objects} value={filter} onChange={setFilter} blade={false} position={false}/><MeasurementStatus loading={loading||busy} error={error} onReload={()=>void refresh(false)}/></Card>
  {!workspace&&!busy&&<Card><p>请选择风场、批次与风机。</p></Card>}
  {workspace&&<><div className="blade-health-slots">{workspace.blades.map((b:any)=><button className={`blade-health-slot ${b===blade?'active':''}`} key={b.bladeId||b.name} onClick={()=>{setActiveSlot(b.bladeId||b.name);if(b.bladeId)setFilter({...filter,bladeId:b.bladeId,positionId:''});}}><strong>{/^[1-3]$/.test(b.name)?`叶片 ${b.name}`:b.name}</strong><Tag tone={b.status==='unmeasured'?'gray':'amber'}>{b.label}</Tag><span>{b.coverage?`可分析 ${b.coverage.analyzable} / 采到 ${b.coverage.observed} · 待复核 ${b.coverage.review}`:'本批次无数据'}</span></button>)}</div>
   <Card title={/^[1-3]$/.test(blade?.name)?`叶片 ${blade.name}`:blade?.name}><div className="measurement-summary"><Tag tone="amber">{blade?.label}</Tag>{blade?.stale&&<Tag tone="amber">工况或处理已更新，旧评价待重算</Tag>}<span>处理版本 {blade?.processingResultId?.slice(0,8)||'—'}</span><span>评价 {blade?.assessmentId?.slice(0,8)||'尚未保存'}</span><span>{timeText(blade?.evaluatedAt)}</span></div><ul className="blade-health-reasons">{blade?.reasons?.slice(0,2).map((r:string)=><li key={r}>{r}</li>)}</ul>{blade?.reasons?.length>2&&<details><summary>其他评价依据 · {blade.reasons.length-2} 项</summary><ul>{blade.reasons.slice(2).map((r:string)=><li key={r}>{r}</li>)}</ul></details>}</Card>
   {blade?.processingResultId&&<><nav className="measurement-tabs" aria-label="叶片健康内容">{[['response','整体响应'],['condition','工况对比'],['evidence','异常证据与结论'],['history','批次历史']].map(([id,label])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    {tab==='response'&&<><div className="measurement-chart-grid"><Card title="五点空间响应 · 平均半峰峰值"><p className="hint">共同角度 {group?.azimuths?.join(' / ')||'不足'}° · 等角度权重 · 视线速度残差</p><Chart label="五点空间响应" height={320} option={{tooltip:{trigger:'axis'},grid:{left:72,right:30,top:25,bottom:65},xAxis:{type:'value',name:'距中心 / m'},yAxis:{type:'value',name:'半峰峰值 / mm/s'},series:[{type:'line',connectNulls:false,data:points.map((p:any)=>[p.radiusM,p.mean_half_peak_to_peak_m_s==null?null:p.mean_half_peak_to_peak_m_s*1000])}]}}/></Card><Card title="三维空间幅值"><MeasurementResponse3D metricLabel="半峰峰值" points={points.map((p:any)=>({id:p.point,name:p.point,radiusM:p.radiusM,normalizedAmplitude:p.mean_half_peak_to_peak_m_s==null?null:max?p.mean_half_peak_to_peak_m_s/max:0,displacementRmsM:null}))}/></Card></div>
    <SavedBladeWaveforms blade={blade} bladeCode={data.objects.find(o=>o.id===blade.bladeId)?.code||""}/><BladeResponseMatrix blade={blade}/>
    <Card title="测点 × 方位覆盖"><Table headers={['测点','半径 · m','计划角度','可用角度','缺项']}>
     {blade.coverage.points.map((p:any)=><tr key={p.pointName}><td>{p.pointName}</td><td>{p.radiusM}</td><td>{p.plannedAzimuths.join(' / ')}°</td><td>{p.usableAzimuths.join(' / ')}°</td><td>{p.missingAzimuths.length?p.missingAzimuths.join(' / ')+'°':'—'}</td></tr>)}
    </Table><Button disabled={busy} onClick={()=>void openProcessing()}>查看同版本五点波形、频谱与经过证据</Button></Card></>}
    {tab==='condition'&&<><Card title="有效经过的工况匹配">{!matched.length?<p>未匹配到覆盖有效片段的风速和转速。整体响应仍可查看；请导入同期风场数据。</p>:<Chart label="匹配风速与转速" height={320} option={{tooltip:{trigger:'axis'},legend:{data:['风速','转速']},grid:{left:70,right:75,top:40,bottom:60},xAxis:{type:'category',data:matched.map((r:any)=>`${r.point} / ${r.azimuthDeg}°`)},yAxis:[{type:'value',name:'m/s'},{type:'value',name:'rpm'}],series:[{name:'风速',type:'line',connectNulls:false,data:matched.map((r:any)=>r.condition.windSpeed)},{name:'转速',type:'line',yAxisIndex:1,connectNulls:false,data:matched.map((r:any)=>r.condition.rpm)}]}}/>}<Button onClick={()=>openMeasurementWorkspace('wind',filter)}>管理工况数据</Button></Card>
    <Card title="逐经过匹配明细"><Table headers={['测点 / 角度','有效段 UTC','风速 / 转速','匹配方式','资格']}>
      {blade.conditions.map((c:any)=><tr key={c.recordingId}><td>{c.point} / {c.azimuthDeg}°</td><td>{c.sourceTimes.map((t:any)=><div key={t.start}>{new Date(t.start).toISOString()} ～ {new Date(t.end).toISOString()}</div>)}</td><td>{numberText(c.condition.windSpeed)} m/s / {numberText(c.condition.rpm)} rpm</td><td>{c.condition.matchMethod} · {c.condition.timeBasis}</td><td>{c.condition.reasons?.join('；')||'时间匹配有效，结构资格另行核验'}</td></tr>)}
    </Table></Card></>}
    {tab==='evidence'&&<><Card title="证据分类"><p>数据质量事件与真实局部振动异常分开记录；整叶片损伤需要独立证据复核。</p><Table headers={['测点 / 角度','质量状态','原始标记','操作']}>
      {blade.records.map((r:any)=><tr key={r.id}><td>{r.point} / {r.azimuthDeg}°</td><td>{r.quality?.analysis_eligible?'可分析':'待复核'} · {r.issues?.join('、')}</td><td>{r.sourceQuality?.diagnostic_only?'历史诊断标记保留':'见来源'}{r.review&&<small>{r.review.status} · {r.review.reviewer} · {r.review.note}</small>}</td><td><Button onClick={()=>void openProcessing()}>查看证据</Button><Button disabled={!canWrite} onClick={()=>{setReview(r);setNote('');}}>记录人工复核</Button></td></tr>)}
    </Table></Card><Card title="专项结构损伤判定"><p>尚无满足工况、参考批次、实体核验及已验收算法的判定输入。本批次结论为证据不足，不输出损伤概率或确诊。</p><p>建议：复核缺项；补充同期工况、正常参考与现场巡检证据。</p></Card></>}
    {tab==='history'&&<Card title="独立批次与评价版本"><Table headers={['评价时间','批次','处理版本','结论','可分析 / 采到']}>
      {workspace.history.filter((r:any)=>r.context.bladeId===blade.bladeId).map((r:any)=><tr key={r.id}><td>{timeText(r.evaluatedAt)}</td><td>{data.objects.find(o=>o.id===r.context.campaignId)?.name||r.context.campaignId}</td><td>{r.processingResultId.slice(0,8)}</td><td>{r.label}</td><td>{r.coverage.analyzable} / {r.coverage.observed}</td></tr>)}
    </Table>{!workspace.history.length&&<p>暂无已保存评价。同源重算不增加独立测量批次数。</p>}</Card>}
   </>}
  </>}
  {details&&<Dialog title="同版本只读处理结果" wide onClose={()=>setDetails(null)}><FieldRecordAnalysis key={details.id} mode="web" readOnly request={readOnly} onAcquisition={()=>openMeasurementWorkspace('blade',filter)}/></Dialog>}
  {review&&<Dialog title="人工复核记录" onClose={()=>setReview(null)}><p>{review.point} / {review.azimuthDeg}° · 原始质量及数据保持不变</p><label>复核说明<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={2000}/></label><Button disabled={!note.trim()||busy} onClick={async()=>{setBusy(true);try{await api('measurements/blade-review','POST',{processingResultId:blade.processingResultId,recordingId:review.id,note});setReview(null);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>保存复核</Button></Dialog>}
 </div>;
}
