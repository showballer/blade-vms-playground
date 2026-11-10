"use client";
import {HealthStandardEditor,HealthVerificationDialog,HealthStandardEvidence,ScenarioDetectionSummary} from './measurement-health-standard-panel';
import {RetainedPanel} from "./retained-panel";
import React,{useEffect,useState,useRef,useCallback} from 'react';
import {api} from './api';
import {Button,Card,Dialog,Table,Tag,CustomSelect} from './common';
import {Chart} from './charts';
import {ObjectFilters,MeasurementStatus,useMeasurements,useMeasurementContext,openMeasurementWorkspace,numberText,timeText,selectedBladeProcessingResults,rememberProcessingResult} from './measurement-common';
import {SavedBladeWaveforms,BladeResponseMatrix} from "./measurement-health-response";
import {MeasurementResponse3D,responseGeometryInfo} from './measurement-response-3d';
import {DesktopAnalysisWorkspace} from './field-analysis-workspace';
import type {RecordAnalysisBridge} from './field-record-analysis';
import {HealthRuleEditor} from './unified-health-rule-editor';
import {HealthConditionSummary,healthConditionSummary} from './measurement-health-conditions';
import type {ContextProps} from './common';
import {DisplacementDisplay} from './displacement-display';

function healthTone(b:any){const d=b?.syntheticScenario?.detection;if(d)return d.status==='normal'?'green':d.status==='alarm'?'red':d.status==='warning'?'amber':'gray';return b?.label==='健康'?'green':b?.label==='损伤'?'red':['unmeasured','insufficient'].includes(b?.status)||b?.label==='证据不足'?'gray':'amber';}

export function MeasurementHealth(props:ContextProps){
 const {data,loading,error,setError}=useMeasurements();
 const [,selectionRevision]=useState(0);useEffect(()=>{const update=()=>selectionRevision(v=>v+1);window.addEventListener('blade-processing-selection',update);return()=>window.removeEventListener('blade-processing-selection',update);},[]);const [filter,setFilter]=useMeasurementContext();
 const [analyzing,setAnalyzing]=useState(''),[analysisProgress,setAnalysisProgress]=useState('');
 const [standardOpen,setStandardOpen]=useState(false),[verification,setVerification]=useState<''|'identity'|'decision'>('');
 const [activeSlot,setActiveSlot]=useState('');const [ruleOpen,setRuleOpen]=useState(false);
 const [workspace,setWorkspace]=useState<any>(null),[busy,setBusy]=useState(false),[tab,setTab]=useState('response'),[details,setDetails]=useState<any>(null),[review,setReview]=useState<any>(null),[note,setNote]=useState('');
 const scope={farmId:filter.farmId,campaignId:filter.campaignId,turbineId:filter.turbineId},key=JSON.stringify(scope);const processingResultIds=selectedBladeProcessingResults(scope,data.objects),selectionKey=JSON.stringify(processingResultIds),canWrite=props.canWrite;const latestScope=useRef(key);latestScope.current=key;
 useEffect(()=>{if(!filter.farmId&&!filter.campaignId){const s=data.sources.find(s=>s.context?.farmId);if(s)setFilter(s.context);}},[data.sources,filter.farmId,filter.campaignId]);
 async function refresh(save=false){setBusy(true);try{const r=await api('measurements/blade-health','POST',{action:save?'evaluate':'workspace',context:scope,processingResultIds});if(latestScope.current===key){setWorkspace(r);setError('');}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 useEffect(()=>{let current=true;setWorkspace(null);if(!scope.farmId||!scope.campaignId||!scope.turbineId)return;setBusy(true);api('measurements/blade-health','POST',{action:'workspace',context:scope,processingResultIds}).then(r=>{if(current){setWorkspace(r);setError('');}}).catch(e=>{if(current)setError(e.message);}).finally(()=>{if(current)setBusy(false);});return()=>{current=false;};},[key,selectionKey]);
 useEffect(()=>setActiveSlot(""),[key]);
 const blade=workspace?.blades.find((b:any)=>(b.bladeId||b.name)===activeSlot)||workspace?.blades.find((b:any)=>b.bladeId===filter.bladeId)||workspace?.blades.find((b:any)=>b.processingResultId)||workspace?.blades[0];
 const group=blade?.commonResponse?.find((g:any)=>g.layer==='los_residual')||blade?.commonResponse?.[0];const points=group?.points||[];
 async function selectWind(id:string){const own=key;setBusy(true);try{const value=await api<any>('measurements/blade-health','POST',{action:'select-wind',context:scope,windDatasetId:id,processingResultIds});if(latestScope.current===own){setWorkspace(value);setError('');}}catch(e){if(latestScope.current===own)setError((e as Error).message);}finally{if(latestScope.current===own)setBusy(false);}}
 const [displacement,setDisplacement]=useState<any>(null),[displacementError,setDisplacementError]=useState('');
 useEffect(()=>{let stale=false;const controller=new AbortController();setDisplacement(null);setDisplacementError('');const ids=(blade?.records||[]).filter((r:any)=>r.quality?.analysis_eligible&&r.representative).map((r:any)=>r.representative);if(blade?.processingResultId&&ids.length)api<any>('measurements/processing','POST',{request:{action:'extended',jobId:blade.processingResultId,kind:'point_displacement',resultIds:ids}},controller.signal).then(v=>{if(!stale)setDisplacement(v);}).catch(e=>{if(!stale)setDisplacementError(e.message);});return()=>{stale=true;controller.abort();};},[blade?.processingResultId]);
 const displacementPoints=(displacement?.points||[]).filter((p:any)=>p.layer==='los_residual').sort((a:any,b:any)=>String(a.object?.point).localeCompare(String(b.object?.point),undefined,{numeric:true})),displacementMax=Math.max(0,...displacementPoints.map((p:any)=>p.mean_half_peak_to_peak_m||0));
 const geometry=responseGeometryInfo(blade?.geometryEstimates);
 const matched=(blade?.conditions||[]).filter((c:any)=>c.condition.status==='matched');
 async function openProcessing(){if(!blade?.processingResultId)return;setBusy(true);try{setDetails((await api<any>('measurements/processing','POST',{request:{action:'snapshot',jobId:blade.processingResultId}})).result);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function analyzeBlade(){
  const own=blade;if(!own?.bladeId||analyzing)return;const requestScope=key;setAnalyzing(own.bladeId);setAnalysisProgress('准备整叶片分析');
  try{const job=await api<any>('measurements/blade-health','POST',{action:'analyze',context:scope,bladeId:own.bladeId});
   for(;;){const status=await api<any>('measurements/processing','POST',{request:{action:'status',jobId:job.jobId}});setAnalysisProgress(`整叶片分析 ${status.completed||0} / ${status.total||job.total||0}`);if(status.status==='failed'||status.status==='cancelled')throw Error(status.error||'分析已取消');if(status.status==='complete')break;await new Promise(r=>setTimeout(r,500));}
   await api('measurements/processing','POST',{request:{action:'publish',jobId:job.jobId}});rememberProcessingResult({...scope,bladeId:own.bladeId},job.jobId);
   if(latestScope.current===requestScope)await refresh(false);
  }catch(e){setError((e as Error).message);}finally{setAnalyzing('');setAnalysisProgress('');}
 }
 const readOnly:RecordAnalysisBridge=useCallback(async <T,>(o:any)=>{
  const c=o.request;if(c.action==='catalog')return {tasks:[details.task],revision:details.inputKey} as T;
  if(c.action==='start'||c.action==='status')return {jobId:details.id,status:'complete',total:details.total,completed:details.total} as T;
  if(c.action==='cancel')throw Error('已保存版本只读');
  if(c.action==='export')throw Error('请前往模态识别导出分析包');
  return api<T>('measurements/processing','POST',{request:{...c,jobId:details.id}},o.signal);
 },[details]);
 const scenarioMode=!!blade?.syntheticScenario;
 const assessmentReasons=scenarioMode?[]:[...new Set<string>([...(blade?.evidenceReadiness?.blockers||[]),...(blade?.reasons||[])])];
 const formalAssessment=<Card title={/^[1-3]$/.test(blade?.name)?`叶片 ${blade.name}`:blade?.name}>
  <div className="measurement-summary"><Tag tone={healthTone(blade)}>{blade?.syntheticScenario?'检测结果：':blade?.standardSnapshot?'项目评价：':'正式评价：'}{blade?.label==='证据不足'?'健康状态未核验':blade?.label}</Tag>{blade?.stale&&<Tag tone="amber">工况或处理已更新，旧评价待重算</Tag>}<span>整叶片版本 {blade?.processingResultId?.slice(0,8)||'—'}</span><span>本批采到 {blade?.coverage?.acquired??blade?.acquired??0} · 参与处理 {blade?.coverage?.observed??0}</span><span>评价 {blade?.assessmentId?.slice(0,8)||'尚未保存'}</span><span>{timeText(blade?.evaluatedAt)}</span></div>
  {scenarioMode&&<ScenarioDetectionSummary blade={blade} onDetails={()=>setTab('standard')}/>}
  {blade?.standardSnapshot&&<p className="health-standard-note">健康标准：{blade.standardSnapshot.name} · {blade.healthScreening?.baselineMember?'用户确认的健康基线 · 回代检查':'独立数据筛查'}{blade.finalDecision?` · 已由 ${blade.finalDecision.reviewer} 复核发布`:' · 按项目响应包络评价'}</p>}
  {blade?.processingResultId&&<HealthConditionSummary conditions={blade.conditions||[]} disabled={busy} onView={()=>setTab('condition')}/>}
  <p className="hint">关联数据集：{workspace?.windDatasets?.find((d:any)=>d.id===workspace.windDatasetId)?.name||'未关联'}</p>
  {assessmentReasons.length>0&&<details><summary>查看评价依据与适用范围</summary><p className="hint">按已发布健康标准的适用范围进行判定。</p><ul>{assessmentReasons.map(r=><li key={r}>{r}</li>)}</ul></details>}
 </Card>;
 return <div className="stack measurement-workspace blade-health-v2"><header className="measurement-heading"><div><h1>健康监测</h1><p>按风机查看每片叶片的响应、工况和证据。</p></div><div className="measurement-heading-actions"><Button disabled={busy||!scope.turbineId} onClick={()=>void refresh(false)}>刷新</Button><Button disabled={!scope.turbineId||(!scenarioMode&&!canWrite)} onClick={()=>scenarioMode?setTab('standard'):setStandardOpen(true)}>{scenarioMode?'检测标准':'健康标准'}</Button>{!scenarioMode&&<Button disabled={!canWrite||!blade?.bladeId} onClick={()=>setRuleOpen(true)}>历史预警规则</Button>}<Button variant="primary" disabled={!canWrite||busy||!scope.turbineId} onClick={()=>void refresh(true)}>{scenarioMode?'重新检测':'重新关联工况与更新评价'}</Button></div></header>
  <Card title="测量范围"><ObjectFilters objects={data.objects} memberships={data.memberships} loading={loading} value={filter} onChange={setFilter} blade={false} position={false}/><label className="measurement-wind-dataset">风场数据集<CustomSelect aria-label="健康监测风场数据集" value={workspace?.windDatasetId||''} disabled={!canWrite||busy||loading||!scope.turbineId} onChange={e=>void selectWind(e.target.value)}><option value="">未关联风场数据集</option>{(workspace?.windDatasets||[]).map((d:any)=><option key={d.id} value={d.id}>{d.name}</option>)}</CustomSelect></label><p className="hint">数据集关联按当前批次与风机保存，重新打开自动恢复；取消关联需明确选择“未关联”。</p><MeasurementStatus loading={loading||busy} error={error} onReload={()=>void refresh(false)}/></Card>
  {!workspace&&!busy&&<Card><p>请选择风场、批次与风机。</p></Card>}
  {workspace&&<><div className="blade-health-slots">{workspace.blades.map((b:any)=>{
    return <button type="button" aria-pressed={b===blade} className={`blade-health-slot ${b===blade?'active':''} `} key={b.bladeId||b.name} onClick={()=>{setActiveSlot(b.bladeId||b.name);if(b.bladeId)setFilter({...filter,bladeId:b.bladeId,positionId:''});}}>
      <div className="health-slot-title"><strong>{/^[1-3]$/.test(b.name)?`叶片 ${b.name}`:b.name}</strong><Tag tone={healthTone(b)}>{b.processingResultId?`${b.syntheticScenario?'检测结果':b.standardSnapshot?'项目评价':'正式评价'}：${b.label==='证据不足'?'健康状态未核验':b.label}`:b.label}</Tag></div>
      <span>{b.coverage?`可分析 ${b.coverage.analyzable} / ${b.coverage.observed} 条 · 待复核 ${b.coverage.review}`:b.canAnalyze?`已采到 ${b.acquired} 条 · 待整叶片分析`:'本批次无数据'}</span>
      {b.coverage&&<small>工况已匹配 {healthConditionSummary(b.conditions).matched} / {b.conditions?.length||0}</small>}
    </button>;})}</div>
   {formalAssessment}
   {!blade?.processingResultId&&blade?.canAnalyze&&<Card title="整叶片响应分析"><p>使用当前批次该叶片的全部测点与角度记录，计算与模态识别页一致的叶片响应结果。</p><Button variant="primary" disabled={!canWrite||!!analyzing||busy} onClick={()=>void analyzeBlade()}>{analyzing===blade.bladeId?analysisProgress:'开始整叶片分析'}</Button></Card>}{blade?.processingResultId&&<><nav className="measurement-tabs" aria-label="叶片健康内容">{[['response','整体响应'],['condition','工况对比'],['standard',scenarioMode?'检测依据与指标':'健康标准与核验'],['evidence','异常证据与结论'],['history','批次历史']].map(([id,label])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    <RetainedPanel key={blade.processingResultId} active={tab==='response'}><div className="blade-health-response-content"><div className="blade-health-response-overview"><Card className="blade-health-response-curve" title="各测点响应 · 平均半峰峰值"><p className="hint">共同角度 {group?.azimuths?.join(' / ')||'不足'}° · 等角度权重 · 视线速度残差</p><div className="blade-health-response-plot"><div className="blade-health-response-plot-canvas"><Chart label="各测点响应" height="100%" option={{tooltip:{trigger:'axis'},grid:{left:72,right:28,top:42,bottom:52,containLabel:true},xAxis:points.some((p:any)=>p.radiusM==null)?{type:'category',name:'测点',data:points.map((p:any)=>p.point)}:{type:'value',name:'距中心 / m',nameLocation:'middle',nameGap:30},yAxis:{type:'value',name:'半峰峰值 / mm/s',nameGap:18},series:[{type:points.length===1?'bar':'line',barMaxWidth:48,connectNulls:false,data:points.map((p:any)=>points.some((v:any)=>v.radiusM==null)?(p.mean_half_peak_to_peak_m_s==null?null:p.mean_half_peak_to_peak_m_s*1000):[p.radiusM,p.mean_half_peak_to_peak_m_s==null?null:p.mean_half_peak_to_peak_m_s*1000])}]}}/></div></div></Card><div><MeasurementResponse3D title="三维空间幅值" compact animate estimatedPositions={geometry.hasEstimatedRadius} metricLabel="位移振幅" instrumentDistanceM={geometry.instrumentDistanceM} points={points.map((p:any)=>{const matches=displacementPoints.filter((d:any)=>d.object?.point===p.point),amplitude=matches.length===1?matches[0].mean_half_peak_to_peak_m:null;return {id:p.point,name:p.point,radiusM:p.radiusM,normalizedAmplitude:amplitude==null?null:displacementMax?amplitude/displacementMax:0,displacementRmsM:null};})}/>{!displacement&&!displacementError&&<p role="status">正在计算位移振幅…</p>}{displacementError&&<p role="alert">{displacementError}</p>}<p className="hint">{displacementPoints.map((p:any)=>`${p.object.point}: ${numberText(p.mean_half_peak_to_peak_m*1000,5)} mm`).join(' · ')}</p></div></div>
    <DisplacementDisplay context={`${/^[1-3]$/.test(blade.name)?'叶片 '+blade.name:blade.name} · 整叶片版本 ${blade.processingResultId.slice(0,8)}`} loading={!displacement&&!displacementError} points={displacementPoints.flatMap((p:any)=>Number.isFinite(p.mean_half_peak_to_peak_m)?[{point:p.object.point,radiusM:p.object.radius_from_hub_m??null,actualMm:p.mean_half_peak_to_peak_m*1000}]:[])}/>
    <SavedBladeWaveforms blade={blade} bladeCode={data.objects.find(o=>o.id===blade.bladeId)?.code||""}/><BladeResponseMatrix blade={blade}/>
    <Card title="测点 × 方位覆盖"><Table headers={['测点','半径 · m','计划角度','可用角度','缺项']}>
     {blade.coverage.points.map((p:any)=><tr key={p.pointName}><td>{p.pointName}</td><td>{p.radiusM}</td><td>{p.plannedAzimuths.join(' / ')}°</td><td>{p.usableAzimuths.join(' / ')}°</td><td>{p.missingAzimuths.length?p.missingAzimuths.join(' / ')+'°':'—'}</td></tr>)}
    </Table><Button disabled={busy} onClick={()=>void openProcessing()}>查看同版本五点波形、频谱与经过证据</Button></Card></div></RetainedPanel>
    {tab==='standard'&&<HealthStandardEvidence blade={blade} canWrite={canWrite} onIdentity={()=>setVerification('identity')} onDecision={()=>setVerification('decision')}/> }
    {tab==='condition'&&<><Card title="有效经过的工况匹配">{!matched.length?<p>未匹配到覆盖有效片段的风速和转速。整体响应仍可查看；请导入同期风场数据。</p>:<Chart label="匹配风速与转速" height={320} option={{tooltip:{trigger:'axis'},legend:{data:['风速','转速']},grid:{left:70,right:75,top:40,bottom:60},xAxis:{type:'category',data:matched.map((r:any)=>`${r.point} / ${r.azimuthDeg}°`)},yAxis:[{type:'value',name:'m/s'},{type:'value',name:'rpm'}],series:[{name:'风速',type:'line',connectNulls:false,data:matched.map((r:any)=>r.condition.windSpeed)},{name:'转速',type:'line',yAxisIndex:1,connectNulls:false,data:matched.map((r:any)=>r.condition.rpm)}]}}/>}<Button onClick={()=>openMeasurementWorkspace('wind',filter)}>管理工况数据</Button></Card>
    <Card title="逐经过匹配明细"><Table headers={['测点 / 角度','有效段 UTC','风速 / 转速','匹配方式','资格']}>
      {blade.conditions.map((c:any)=><tr key={c.recordingId}><td>{c.point} / {c.azimuthDeg}°</td><td>{c.sourceTimes.map((t:any)=><div key={t.start}>{new Date(t.start).toISOString()} ～ {new Date(t.end).toISOString()}</div>)}</td><td>{numberText(c.condition.windSpeed)} m/s / {numberText(c.condition.rpm)} rpm</td><td>{c.condition.matchMethod} · {c.condition.timeBasis}</td><td>{blade.standardSnapshot&&c.condition.envelopeEligible?'平均工况响应比较可用；不用于瞬时转速、相位或阶次判断':c.condition.reasons?.join('；')||'时间匹配有效，结构资格另行核验'}</td></tr>)}
    </Table></Card></>}
    {tab==='evidence'&&(scenarioMode?<HealthStandardEvidence blade={blade} canWrite={false} onIdentity={()=>{}} onDecision={()=>{}}/>:<><Card title="证据分类"><p>数据质量事件与真实局部振动异常分开记录；整叶片损伤需要独立证据复核。</p><Table headers={['测点 / 角度','质量状态','原始标记','操作']}>
      {blade.records.map((r:any)=><tr key={r.id}><td>{r.point} / {r.azimuthDeg}°</td><td>{r.quality?.analysis_eligible?'可分析':'待复核'} · {r.issues?.join('、')}</td><td>{r.sourceQuality?.diagnostic_only?'历史诊断标记保留':'见来源'}{r.review&&<small>{r.review.status} · {r.review.reviewer} · {r.review.note}</small>}</td><td><Button onClick={()=>void openProcessing()}>查看证据</Button><Button disabled={!canWrite} onClick={()=>{setReview(r);setNote('');}}>记录人工复核</Button></td></tr>)}
    </Table></Card><Card title="专项损伤筛查与结论"><p>{blade.healthScreening?`${blade.healthScreening.label} · ${blade.healthScreening.reasons.join("；")||"各项响应在健康包络内"}`:"请先建立健康标准"}</p><Button onClick={()=>setTab("standard")}>查看判据与异常定位</Button><Button disabled={!canWrite||!blade.healthScreening||blade.healthScreening.status==='insufficient'} onClick={()=>setVerification("decision")}>复核并发布结论</Button></Card></>)}
    {tab==='history'&&<Card title="独立批次与评价版本"><Table headers={['评价时间','批次','处理版本','结论','可分析 / 采到']}>
      {workspace.history.filter((r:any)=>r.context.bladeId===blade.bladeId).map((r:any)=><tr key={r.id}><td>{timeText(r.evaluatedAt)}</td><td>{data.objects.find(o=>o.id===r.context.campaignId)?.name||r.context.campaignId}</td><td>{r.processingResultId.slice(0,8)}</td><td>{r.isScenario?(r.scenarioDetection?.label||'历史场景对照（未执行检测）'):r.label}</td><td>{r.coverage.analyzable} / {r.coverage.observed}</td></tr>)}
    </Table>{!workspace.history.length&&<p>暂无已保存评价。同源重算不增加独立测量批次数。</p>}</Card>}
   </>}
  </>}
  {details&&<Dialog title="同版本只读处理结果" wide onClose={()=>setDetails(null)}><DesktopAnalysisWorkspace key={details.id} initialBladeId={data.objects.find(o=>o.id===blade?.bladeId)?.code} platform="web" purpose="synthesis" readOnly request={readOnly} onNavigate={(_p,r)=>{if(r?.recording_id)sessionStorage.setItem('blade.analysis.focus.record.v22',r.recording_id);if(r?.processingJobId)sessionStorage.setItem('blade.analysis.focus.version.v22',JSON.stringify({scope:{farmId:filter.farmId,campaignId:filter.campaignId,turbineId:filter.turbineId,bladeId:blade?.bladeId},jobId:r.processingJobId}));openMeasurementWorkspace('blade',filter);}}/></Dialog>}
  {standardOpen&&<HealthStandardEditor context={scope} onClose={()=>setStandardOpen(false)} onSaved={()=>void refresh(true)}/> }
  {verification&&blade&&<HealthVerificationDialog key={key+blade.processingResultId+verification} blade={blade} context={scope} identity={verification==='identity'} onClose={()=>setVerification('')} onSaved={()=>void refresh(true)}/> }
  {ruleOpen&&<HealthRuleEditor choices={workspace?.referenceChoices||[]} context={{...scope,bladeId:blade?.bladeId}} onClose={()=>setRuleOpen(false)} onSaved={()=>void refresh()} onError={setError}/>}
  {review&&<Dialog title="人工复核记录" onClose={()=>setReview(null)}><p>{review.point} / {review.azimuthDeg}° · 原始质量及数据保持不变</p><label>复核说明<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={2000}/></label><Button disabled={!note.trim()||busy} onClick={async()=>{setBusy(true);try{await api('measurements/blade-review','POST',{processingResultId:blade.processingResultId,recordingId:review.id,note});setReview(null);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>保存复核</Button></Dialog>}
 </div>;
}
