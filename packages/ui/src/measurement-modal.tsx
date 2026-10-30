"use client";
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api,saveBlob} from './api';
import {Button,Card,Select} from './common';
import {FieldRecordAnalysis,type RecordAnalysisBridge} from './field-record-analysis';
import {ObjectFilters,MeasurementStatus,useMeasurements,useMeasurementContext,openMeasurementWorkspace,rememberProcessingResult} from './measurement-common';
import type {MeasurementContext} from './measurement-domain';

export function MeasurementModal({canWrite}:{canWrite:boolean}){
 const {data,loading,error,setError}=useMeasurements();const [filter,setFilter]=useMeasurementContext();
 const [publishedId,setPublishedId]=useState<string|null>(null),[exporting,setExporting]=useState(false);
 const [core,setCore]=useState('full');
 const [profile,setProfile]=useState('LOS_DIAGNOSTIC'),[background,setBackground]=useState('linear'),[filterKind,setFilterKind]=useState('none'),[cutoff,setCutoff]=useState(''),[edge,setEdge]=useState('');
 const [applied,setApplied]=useState<{profile:string;config:any}>({profile:'LOS_DIAGNOSTIC',config:{}});
 const [confirmed,setConfirmed]=useState(false),[reason,setReason]=useState(''),[composition,setComposition]=useState<any>(null);
 const scope={farmId:filter.farmId,campaignId:filter.campaignId,turbineId:filter.turbineId,bladeId:filter.bladeId};
 const config={...(core==='10ms'?{core_window_seconds:.01}:{}),...(filterKind==='none'?{background}:{background,filter:{kind:filterKind,cutoffs_hz:cutoff.split(',').map(Number),order:4,edge_guard_seconds:Number(edge)}})};
 const configKey=JSON.stringify(applied),scopeKey=JSON.stringify(scope),latest=useRef({scope,confirmed,reason,config:applied.config,profile:applied.profile});latest.current={scope,confirmed,reason,config:applied.config,profile:applied.profile};
 useEffect(()=>{if(!filter.farmId){const source=data.sources.find(s=>s.context?.farmId&&s.context?.campaignId);if(source)setFilter(source.context);}},[data.sources,filter.farmId]);
 useEffect(()=>{setPublishedId(null);setConfirmed(false);setReason('');setComposition(null);if(!scope.farmId||!scope.turbineId||!scope.campaignId)return;let stale=false;api<any>('measurements/processing','POST',{context:scope,request:{action:'catalog'}}).then(r=>{if(!stale)setComposition(r.composition);}).catch(e=>{if(!stale){setError(e.message);setComposition({failed:true});}});return()=>{stale=true;};},[scopeKey]);
 const request:RecordAnalysisBridge=useCallback(async <T,>(options:any)=>{
  const state=latest.current,body={context:state.scope,compositionMode:state.confirmed?'diagnostic_group':undefined,compositionReason:state.reason,request:options.request.action==='start'?{...options.request,config:state.config,profile:state.profile}:options.request};
  if(options.request.action==='export'){
   const response=await fetch('/api/v1/measurements/processing',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(!response.ok){const e=await response.json();throw Error(e.error||'导出失败');}
   const filename=decodeURIComponent(response.headers.get('Content-Disposition')?.split("filename*=UTF-8''")[1]||'analysis.zip');
   await saveBlob(await response.blob(),filename);return {saved:true,fileName:filename} as T;
  }
  const value=await api<any>('measurements/processing','POST',body);if(options.request.action==='result'&&!options.request.recordingId&&value.processingResultId){rememberProcessingResult(state.scope,value.processingResultId);setPublishedId(value.processingResultId);}return value as T;
 },[]);
 const ready=!!scope.farmId&&!!scope.campaignId&&!!scope.turbineId;
 return <div className="stack measurement-workspace web-modal-workspace"><header className="measurement-heading"><div><h1>模态识别</h1><p>信号处理、真实分段拼接与多点响应；正式模态按数据及算法资格开放。</p></div><div className="measurement-heading-actions"><Button disabled={!publishedId||exporting} onClick={async()=>{if(!publishedId)return;setExporting(true);try{await request({action:"recordAnalysis",request:{action:"export",jobId:publishedId,kind:"analysis"}});}catch(e){setError((e as Error).message);}finally{setExporting(false);}}}>{exporting?"正在导出…":"导出分析包"}</Button><Button onClick={()=>openMeasurementWorkspace('blade',filter)}>查看原始采集</Button></div></header>
  <Card title="分析范围"><ObjectFilters objects={data.objects} value={filter} onChange={setFilter} position={false}/><MeasurementStatus loading={loading} error={error} onReload={()=>window.location.reload()}/>
   {composition?.required&&<div className="measurement-diagnostic-note"><strong>本范围涉及多个原始采集任务</strong><p>保留每个原始任务与记录；实体未独立核验时，仅建立业务诊断展示组，不升级健康资格。</p><label className="inline-field"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>建立业务诊断展示组</label><label>分组依据<input aria-label="跨任务分组依据" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label><details><summary>查看来源任务</summary>{composition.groups.map((g:string)=><p key={g}>{g}</p>)}</details></div>}
  </Card>
  <details className="measurement-advanced web-processing-settings"><summary>处理设置 · Web重算</summary><div className="measurement-filters"><Select label="处理来源" value="web" onChange={()=>{}} options={[{value:'web',label:'Web重算 · 共享参考引擎'}]}/><Select label="处理方案" value={profile} disabled={!canWrite} onChange={setProfile} options={[{value:'LOS_DIAGNOSTIC',label:'视线残差诊断'},{value:'RAW_REVIEW',label:'原始视线复核'}]}/><Select label="分析核心" value={core} disabled={!canWrite} onChange={setCore} options={[{value:"full",label:"完整有效段"},{value:"10ms",label:"共同 10 ms 核心（Web重算）"}]}/><Select label="经验背景" value={background} disabled={!canWrite} onChange={setBackground} options={['none','constant','linear'].map(v=>({value:v,label:{none:'不扣除',constant:'去均值',linear:'线性去趋势'}[v]||v}))}/><Select label="滤波" value={filterKind} disabled={!canWrite} onChange={setFilterKind} options={[{value:'none',label:'不滤波'},{value:'lowpass',label:'低通'},{value:'highpass',label:'高通'},{value:'bandpass',label:'带通'}]}/>{filterKind!=='none'&&<><label>截止频率 Hz（带通用逗号分隔）<input value={cutoff} onChange={e=>setCutoff(e.target.value)}/></label><label>滤波边缘排除 · 秒<input type="number" min={0} value={edge} onChange={e=>setEdge(e.target.value)}/></label></>}</div><Button disabled={!canWrite||filterKind!=='none'&&(!cutoff.trim()||!edge.trim())} onClick={()=>setApplied({profile,config})}>应用设置并计算</Button><p className="hint">每次变更单独保存处理版本；不修改原始记录。未提供 original_core / common10ms 分析包，当前仅开放 Web 重算。</p></details>
  {!ready?<Card title="请选择风场、测量批次和风机"><p>选择后读取已关联的真实记录。</p></Card>:composition===null?<p role="status">正在核验来源…</p>:composition.failed?<Card><p>来源核验失败，请检查上方错误后重试。</p><Button onClick={()=>window.location.reload()}>重新读取</Button></Card>:composition.required&&(!confirmed||!reason.trim())?<p>确认诊断分组及依据后可继续；原始数据不改变。</p>:<FieldRecordAnalysis key={scopeKey+confirmed+configKey} mode="web" request={request} onSource={meta=>{const m=meta as any;sessionStorage.setItem('blade.measurement-source.v1',m.sourceKey||'');openMeasurementWorkspace('blade',m.context||filter);}} onAcquisition={()=>openMeasurementWorkspace('blade',filter)}/>}
 </div>;
}
