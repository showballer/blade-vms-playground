"use client";
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {api,saveBlob} from './api';
import {Button,Card,CustomSelect,Dialog} from './common';
import {AnalysisCard,AnalysisLoading,lineOption} from './field-record-analysis-charts';
import {useMeasurements,useMeasurementContext,ObjectFilters,selectedProcessingResult} from './measurement-common';
import {valueText,layerNames} from './field-record-analysis-data';

const names:Record<string,string>={decay:'自由衰减／对数减量',frf:'FRF 半功率带宽',ssi_cov:'工作模态 SSI-COV'};
const units:Record<string,string>={velocity:'m/s',displacement:'m',acceleration:'m/s^2',force:'N'};
export function modalInputReason(input:any,method:string):string{
 if(!input)return '先选择真实连续输入。';
 const channels=input.channels||[],evidence=input.evidence||{},responses=channels.filter((c:any)=>c.role==='response');
 if(method==='decay'&&(responses.length!==1||evidence.excitationRemoved!==true||!evidence.excitationRemovalSource))return '当前输入未提供激励停止后的连续衰减实验记录，可先进行叶片响应分析。';
 if(method==='frf'&&(!channels.some((c:any)=>c.role==='excitation'&&c.quantity==='force')||responses.length!==1))return 'FRF 需要同步采集的激励力和响应；当前输入缺少对应通道。';
 if(method==='ssi_cov'&&(channels.length<2||responses.length!==channels.length||evidence.synchronization!=='common_sample_clock'||!evidence.clockSource||evidence.ambientExcitationAssumption!==true||!evidence.excitationAssumptionSource))return 'SSI-COV 需要真实同步多通道及环境激励记录，不能合并先后采集的点位代替。';
 return '';
}
// CSV is a single regular clock with explicit mapped physical channels. Separate
// angle files cannot be concatenated into synchronized modal observations.
function csvRows(text:string){const out:string[][]=[];let row:string[]=[],v='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){v+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===','||c==='\n'||c==='\r')){row.push(v);v='';if(c!==','){if(row.some(x=>x.trim()))out.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}}else v+=c;}if(quoted)throw Error('CSV引号未闭合');row.push(v);if(row.some(x=>x.trim()))out.push(row);return out;}
export function FormalModalWorkspace({canWrite,onResponse}:{canWrite:boolean;onResponse?:()=>void}){
 const {data}=useMeasurements();const [context,setContext]=useMeasurementContext();
 const [processing,setProcessing]=useState<any[]>([]),[sourceJob,setSourceJob]=useState(''),[segments,setSegments]=useState<any[]>([]),[sourceSegment,setSourceSegment]=useState(''),[startSeconds,setStartSeconds]=useState(''),[endSeconds,setEndSeconds]=useState('');
 const [catalog,setCatalog]=useState<any>({datasets:[],jobs:[]}),[method,setMethod]=useState('decay'),[datasetId,setDatasetId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<any>(null),[job,setJob]=useState<any>(null),[draft,setDraft]=useState<any>(null),[name,setName]=useState(''),[calibration,setCalibration]=useState(''),[clock,setClock]=useState(''),[excitation,setExcitation]=useState(''),[ambient,setAmbient]=useState('');
 const [loadingInputs,setLoadingInputs]=useState(false),[nativeDecay,setNativeDecay]=useState(false),[nativeExperiment,setNativeExperiment]=useState('');
 const [referenceId,setReferenceId]=useState(''),[comparison,setComparison]=useState<any>(null),[checkedInput,setCheckedInput]=useState(''),[loadingResult,setLoadingResult]=useState(false);
 const token=useRef(0),active=useRef(''),importFile=useRef<HTMLInputElement>(null);
 const [nativeOpen,setNativeOpen]=useState(false),[loadingVersions,setLoadingVersions]=useState(false),[loadingSegments,setLoadingSegments]=useState(false),[nativeSaving,setNativeSaving]=useState(false),[nativeError,setNativeError]=useState('');
 const sourceContext={farmId:context.farmId,campaignId:context.campaignId,turbineId:context.turbineId,bladeId:context.bladeId};
 const sourceKey=JSON.stringify(sourceContext);
 const post=<T,>(v:any)=>api<T>('measurements/formal-modal','POST',v);
 async function refresh(){setLoadingInputs(true);try{setCatalog(await post({action:'catalog'}));setError('');}catch(e){setError((e as Error).message);}finally{setLoadingInputs(false);}}
 useEffect(()=>{
  let stale=false;setProcessing([]);setSourceJob('');setSegments([]);setSourceSegment('');setNativeError('');setLoadingVersions(false);
  if(!nativeOpen)return;
  if(!sourceContext.farmId||!sourceContext.campaignId||!sourceContext.turbineId){setNativeError('请先选择风场、测量批次和风机。');return;}
  setLoadingVersions(true);
  api<any>('measurements/processing','POST',{context:sourceContext,request:{action:'history'}}).then(v=>{
   if(stale)return;const versions=(v.results||[]).filter((r:any)=>r.status==='complete');setProcessing(versions);
   const preferred=selectedProcessingResult(sourceContext);setSourceJob(versions.find((r:any)=>r.id===preferred)?.id||versions[0]?.id||'');
  }).catch(e=>{if(!stale)setNativeError(e.message);}).finally(()=>{if(!stale)setLoadingVersions(false);});
  return()=>{stale=true;};
 },[nativeOpen,sourceKey]);
 useEffect(()=>{
  let stale=false;setSegments([]);setSourceSegment('');setStartSeconds('');setEndSeconds('');setNativeDecay(false);setNativeExperiment('');setLoadingSegments(false);
  if(!nativeOpen||!sourceJob)return;
  setLoadingSegments(true);setNativeError('');
  api<any>('measurements/processing','POST',{request:{action:'result',jobId:sourceJob}}).then(r=>{
   if(stale)return;const available=r.records.flatMap((v:any)=>v.segments.filter((s:any)=>s.status?.analysis_state==='ready'&&s.status?.summary_eligible!==false).map((s:any)=>({...s,point:v.object?.point,angle:v.object?.azimuth_deg})));
   setSegments(available);setSourceSegment(available[0]?.result_id||'');
  }).catch(e=>{if(!stale)setNativeError(e.message);}).finally(()=>{if(!stale)setLoadingSegments(false);});
  return()=>{stale=true;};
 },[nativeOpen,sourceKey,sourceJob]);
 useEffect(()=>{void refresh();return()=>{token.current++;};},[]);
 async function read(file:File){setError('');try{if(file.size>20*1024*1024)throw Error('单份输入上限20 MiB');const text=await file.text();setName(file.name);if(/\.json$/i.test(file.name)){const data=JSON.parse(text);setDraft({json:data});return;}const rows=csvRows(text.replace(/^\uFEFF/,'')),columns=rows.shift()!;if(columns.length<2||rows.length<32||rows.length>2000000||columns.length>17)throw Error('CSV需时间列及1～16个物理通道，32～200万行');const data=rows.map(r=>{if(r.length!==columns.length||r.some(x=>!x.trim()||!Number.isFinite(Number(x))))throw Error('CSV存在空值、非数值或不等长行');return r.map(Number);});setDraft({columns,timeIndex:0,rows:data,channels:columns.slice(1).map((c,i)=>({column:i+1,id:'ch'+(i+1),pointId:c,quantity:'velocity',role:'response',direction:'unknown'}))});}catch(e){setError((e as Error).message);}}
 async function importData(){setBusy(true);setError('');try{const data=draft.json||{schemaVersion:'modal-input-1',sourceKind:'imported_measurement',time_s:draft.rows.map((r:number[])=>r[draft.timeIndex]),channels:draft.channels.map((c:any)=>({...c,unit:units[c.quantity],calibrationSource:calibration,values:draft.rows.map((r:number[])=>r[c.column])})),evidence:{synchronization:'common_sample_clock',clockSource:clock,excitationRemoved:!!excitation.trim(),excitationRemovalSource:excitation,ambientExcitationAssumption:!!ambient.trim(),excitationAssumptionSource:ambient}};const saved=await post<any>({action:'import',name,context,dataset:data});chooseDataset(saved.id);setDraft(null);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function start(){setCheckedInput(datasetId+':'+method);if(inputReason){setError('');setResult(null);return;}const id=++token.current;setBusy(true);setResult(null);setError('');try{const v=await post<any>({action:'start',method,datasetId});active.current=v.id;setJob(v);for(;;){if(token.current!==id)return;const s=await post<any>({action:'status',id:v.id});setJob(s);if(s.status==='complete'){setResult(s.result);break;}if(['failed','cancelled'].includes(s.status))throw Error(s.error||'已取消');await new Promise(r=>setTimeout(r,400));}await refresh();}catch(e){if(token.current===id)setError((e as Error).message);}finally{if(token.current===id)setBusy(false);}}
 async function openSaved(id:string){setResult(null);setJob(id?{id}:null);setError('');if(!id)return;setLoadingResult(true);try{const r=await post<any>({action:'result',id});setJob(r);setResult(r.result);setMethod(r.method);setDatasetId(r.datasetId);}catch(e){setJob(null);setError((e as Error).message);}finally{setLoadingResult(false);}}
 function chooseDataset(id:string){setDatasetId(id);setJob(null);setResult(null);setCheckedInput('');setError('');}
 async function exportResult(){if(!job)return;const r=await fetch('/api/v1/measurements/formal-modal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'export',id:job.id})});if(!r.ok)throw Error((await r.json()).error);await saveBlob(await r.blob(),'模态参数识别_'+job.id.slice(0,8)+'.zip');}
 const selectedInput=catalog.datasets.find((v:any)=>v.id===datasetId),facts=selectedInput?.evidence||{};const requirements=[['真实连续样本',selectedInput?selectedInput.samples+' 个 / '+valueText(selectedInput.durationSeconds)+' s':'未选择'],['测量通道',selectedInput?selectedInput.channels.map((c:any)=>c.pointId+' / '+c.direction+' / '+c.unit).join('；'):'待提供'],['方法条件',method==='decay'?(facts.excitationRemoved?'已声明撤除激励：'+facts.excitationRemovalSource:'需提供激励撤除证据'):method==='frf'?(selectedInput?.channels.some((c:any)=>c.role==='excitation'&&c.quantity==='force')?'已有力通道；同钟相干及带宽在计算时核验':'缺少同步力通道'):(facts.synchronization==='common_sample_clock'&&facts.ambientExcitationAssumption?'已声明同钟及环境激励；稳定图在计算时核验':'需提供同步多通道和环境激励证据')]];
 const inputReason=modalInputReason(selectedInput,method);
 const e=result?.evidence||{},chartContext=`${names[method]} · ${result?.algorithmVersion||''} · ${job?.id||''}`;
 const cards=useMemo(()=>{
  if(!result)return [];
  const pairs=(x:any[],y:any[])=>x?.map((v,i)=>[v,y?.[i]??null])||[];
  if(result.method==='decay')return [{id:'MOD-DECAY',title:'实测衰减与单模态拟合',option:lineOption([{name:'实测',data:pairs(e.time_s,e.response)},{name:'拟合',data:pairs(e.time_s,e.fittedResponse)}],'真实时间 / s','输入物理量（SI）')},{id:'MOD-ENVELOPE',title:'同相峰值与对数包络',option:lineOption([{name:'ln(实测峰值)',data:pairs(e.peakTime_s,e.peakAmplitude?.map((v:number)=>Math.log(v)))},{name:'回归',data:pairs(e.peakTime_s,e.fittedLogAmplitude)}],'真实时间 / s','ln 幅值')},{id:'MOD-RESIDUAL',title:'对数包络残差',option:lineOption([{name:'残差',data:pairs(e.peakTime_s,e.logResidual)}],'真实时间 / s','对数残差')}];
  if(result.method==='frf')return [{id:'MOD-FRF',title:'H1 FRF 与物理模型拟合',option:lineOption([{name:'实测H1',data:pairs(e.frequencyHz,e.frfMagnitude)},{name:'拟合',data:pairs(e.fitFrequencyHz,e.fitMagnitude)},{name:'半功率水平',data:(e.halfPowerCrossingsHz||[]).map((f:number)=>[f,e.halfPowerLevel])}],'频率 / Hz','|响应 / N|')},{id:'MOD-COHERENCE',title:'力—响应相干性',option:lineOption([{name:'相干性',data:pairs(e.frequencyHz,e.coherence)}],'频率 / Hz','γ²')}];
  const poles=e.candidatePoles||e.poles||[];return [{id:'MOD-STABILITY',title:'SSI-COV 稳定图',option:{...lineOption([{name:'稳定极点',data:poles.filter((p:any)=>p.stable).map((p:any)=>[p.naturalFrequencyHz,p.order])},{name:'未稳定极点',data:poles.filter((p:any)=>!p.stable).map((p:any)=>[p.naturalFrequencyHz,p.order])}],'频率 / Hz','模型阶次'),series:[{type:'scatter',name:'稳定极点',data:poles.filter((p:any)=>p.stable).map((p:any)=>[p.naturalFrequencyHz,p.order])},{type:'scatter',name:'未稳定极点',data:poles.filter((p:any)=>!p.stable).map((p:any)=>[p.naturalFrequencyHz,p.order])}]}},{id:'MOD-SVD',title:'协方差 Hankel 奇异值',option:lineOption([{name:'奇异值',data:(e.singularValues||[]).map((v:number,i:number)=>[i+1,v])}],'序号','奇异值')},{id:'MOD-DAMPING',title:'SSI-COV 阻尼稳定图',option:{...lineOption([], '固有频率 / Hz','阻尼比 / %'),series:[{type:'scatter',name:'候选极点',data:poles.filter((p:any)=>p.exclusionReason==null).map((p:any)=>[p.naturalFrequencyHz,p.dampingRatio*100])},{type:'scatter',name:'稳定簇',data:(result.modes||[]).map((p:any)=>[p.naturalFrequencyHz,p.dampingRatio*100])}]}} ];
 },[result]);
 return <div className="stack desktop-analysis-workspace formal-modal-workspace"><Card title="测量对象"><ObjectFilters objects={data.objects} value={context} onChange={setContext} position={false}/></Card><Card title="模态参数识别"><div className="dra-object-grid"><label>方法<CustomSelect value={method} disabled={busy||loadingResult} onChange={e=>{setMethod(e.target.value);setResult(null);setJob(null);setCheckedInput('');}}>{Object.entries(names).map(([id,n])=><option key={id} value={id}>{n}</option>)}</CustomSelect></label><label>真实连续输入<CustomSelect value={datasetId} disabled={busy||loadingInputs||loadingResult} onChange={e=>chooseDataset(e.target.value)}><option value="">选择输入</option>{catalog.datasets.map((d:any)=><option key={d.id} value={d.id}>{d.name} · {d.channels.length}通道 · {valueText(d.durationSeconds)}s</option>)}</CustomSelect></label><label>历史版本<CustomSelect value={job?.id||''} disabled={busy||loadingInputs||loadingResult} onChange={e=>void openSaved(e.target.value)}><option value="">当前输入</option>{catalog.jobs.filter((j:any)=>j.status==='complete').map((j:any)=><option key={j.id} value={j.id}>{names[j.method]} · {j.finishedAt} · {j.published?'已保存':'未发布'}</option>)}</CustomSelect></label></div><div className="formal-modal-toolbar">
 <div className="formal-modal-utility">
  <Button disabled={loadingInputs||busy} onClick={()=>void refresh()}>{loadingInputs?'正在读取…':'刷新输入'}</Button>
  <Button disabled={!canWrite||busy} onClick={()=>importFile.current?.click()}>导入 CSV / JSON</Button>
  <input ref={importFile} type="file" hidden aria-label="导入模态测量文件" accept=".csv,.json" onChange={e=>{const f=e.target.files?.[0];if(f)void read(f);e.target.value='';}}/>
 </div>
 <div className="formal-modal-actions">
  <Button variant="primary" disabled={!canWrite||!datasetId||busy||loadingInputs||loadingResult} onClick={()=>void start()}>{busy?'正在识别…':'检查并识别'}</Button>
  {busy&&<Button onClick={async()=>{token.current++;await post({action:'cancel',id:active.current});setBusy(false);setError('已取消，计算进程已终止');}}>取消</Button>}
  <Button disabled={!canWrite||!result||busy||job?.published} onClick={async()=>setJob(await post({action:'save',id:job.id}))}>保存此版本</Button>
  <Button disabled={!result||busy} onClick={()=>void exportResult().catch(e=>setError(e.message))}>导出参数与证据</Button>
 </div>
</div><>{!datasetId&&<div className="formal-modal-guidance"><p role="status">先选择模态输入：可使用已保存的真实连续段，也可导入测量 CSV / JSON；不要求重复上传。</p><Button disabled={busy} onClick={()=>setNativeOpen(true)}>从已保存数据选取</Button></div>}</><>{selectedInput&&!!inputReason&&<div className="modal-input-assessment" data-modal-assessment={checkedInput===datasetId+':'+method?'checked':'pending'} role="status">
 <div><strong>{checkedInput===datasetId+':'+method?'条件检查未通过':'数据已选入，待检查识别条件'}</strong><span>{valueText(selectedInput.durationSeconds*1000,3)} ms · {selectedInput.channels.length} 个通道 · {names[method]}</span></div>
 <p>{inputReason}</p>
 {checkedInput===datasetId+':'+method&&<p className="hint">{method==='decay'?'需要在敲击或其他外部激励停止后，连续测量自然衰减过程。当前的经过短片段仍可用于波形、频谱和叶片响应分析。':method==='frf'?'需要同一采样时钟下的激励力与响应，已有的单通道速度片段不能代替力通道。':'需要同一时钟下同时记录多个响应通道；五个点先后采集的数据可用于空间响应比较。'}</p>}
 {onResponse&&<div className="dra-actions"><Button onClick={onResponse}>前往叶片响应分析</Button></div>}
 </div>}</><details className="dra-provenance"><summary>输入资格与补采条件</summary><table><tbody>{requirements.map(([k,v])=><tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table></details>{error&&<p role="alert" className="dra-warning">{error}</p>}</Card>
 {nativeOpen&&<Dialog title="选择已保存的连续段" wide onClose={()=>setNativeOpen(false)}>
  <div className="stack modal-native-picker" data-native-modal-input>
   {loadingVersions&&<p role="status">正在读取当前叶片的处理版本…</p>}
   {!loadingVersions&&!nativeError&&!processing.length&&<div className="dra-warning"><p>当前选择下没有已完成的处理版本。先在“叶片响应分析”点击“开始分析”，完成后再返回选取。</p>{onResponse&&<Button onClick={onResponse}>前往叶片响应分析</Button>}</div>}
   {nativeError&&<p role="alert" className="dra-warning">{nativeError}</p>}
   {!!processing.length&&<div className="dra-object-grid">
    <label>处理版本<CustomSelect aria-label="模态来源处理版本" value={sourceJob} disabled={loadingVersions||nativeSaving} onChange={e=>setSourceJob(e.target.value)}>
     {processing.map(p=><option key={p.id} value={p.id}>{p.name} · {p.processingSource==='desktop_verified'?'桌面已核验':'Web 重算'} · {new Date(p.finishedAt).toLocaleString('zh-CN')}</option>)}
    </CustomSelect></label>
    <label>真实连续段<CustomSelect aria-label="模态来源连续段" value={sourceSegment} disabled={loadingSegments||nativeSaving||!segments.length} onChange={e=>setSourceSegment(e.target.value)}>
     <option value="">{loadingSegments?'正在读取连续段…':'选择连续段'}</option>
     {segments.map(s=><option key={s.result_id} value={s.result_id}>{s.point} / {s.angle}° · {valueText(s.features?.observation_seconds,6)} s · {layerNames[s.layer]||'速度数据'}</option>)}
    </CustomSelect></label>

   </div>}
   {loadingSegments&&<p role="status">正在读取真实连续段…</p>}
   {!loadingVersions&&!loadingSegments&&!!sourceJob&&!segments.length&&!nativeError&&<p className="dra-warning">此版本没有通过质量检查的连续段，请在叶片响应分析中核对待复核或越界原因。</p>}
   {!!segments.length&&<>
    <p className="hint" data-native-source>来源、单位和真实样本范围自动继承；独立标定状态保留为未核验。</p>
    <details className="dra-provenance modal-native-advanced" data-native-advanced><summary>高级设置（可选）</summary>
     <div className="dra-object-grid">
      <label>区间开始 · 核心相对秒<input aria-label="模态核心区间开始" type="number" disabled={nativeSaving} value={startSeconds} onChange={e=>setStartSeconds(e.target.value)} placeholder="留空使用完整有效段"/></label>
      <label>区间结束 · 核心相对秒<input aria-label="模态核心区间结束" type="number" disabled={nativeSaving} value={endSeconds} onChange={e=>setEndSeconds(e.target.value)} placeholder="留空使用完整有效段"/></label>
     </div>
     {method==='decay'&&<><label className="modal-native-experiment"><input aria-label="来源为自由衰减实验" type="checkbox" checked={nativeDecay} onChange={e=>setNativeDecay(e.target.checked)}/>这段数据来自激励停止后的自由衰减实验</label>{nativeDecay&&<label>实验过程记录<input aria-label="模态输入撤除激励" value={nativeExperiment} onChange={e=>setNativeExperiment(e.target.value)} placeholder="实际激励停止的时刻、方式及记录依据"/></label>}</>}
    </details>
   </>}
   {!!segments.length&&<div className="modal-native-footer"><Button variant="primary" disabled={!canWrite||!sourceSegment||busy||nativeSaving||loadingSegments} onClick={async()=>{
    setNativeSaving(true);setNativeError('');
    try{const r=await post<any>({action:'from-segment',processingResultId:sourceJob,resultId:sourceSegment,...(startSeconds?{startSeconds:Number(startSeconds)}:{}),...(endSeconds?{endSeconds:Number(endSeconds)}:{}),evidence:{excitationRemoved:nativeDecay&&!!nativeExperiment.trim(),...(nativeDecay&&nativeExperiment.trim()?{excitationRemovalSource:nativeExperiment}:{})},name:'真实连续段 '+sourceSegment.slice(0,8)});chooseDataset(r.id);await refresh();setNativeOpen(false);}
    catch(e){setNativeError((e as Error).message);}finally{setNativeSaving(false);}
   }}>{nativeSaving?'正在保存输入…':'使用此连续段'}</Button></div>}

  </div>
 </Dialog>}
 {draft&&<Card title="实测输入映射"><label>输入名称<input value={name} onChange={e=>setName(e.target.value)}/></label>{draft.json?<p>读取 modal-input-1；服务端将重新校验时钟、物理量、标定与同步证据。</p>:<><div className="dra-object-grid"><label>时间列（秒）<CustomSelect value={draft.timeIndex} onChange={e=>setDraft({...draft,timeIndex:Number(e.target.value),channels:draft.columns.flatMap((c:string,i:number)=>i===Number(e.target.value)?[]:[{column:i,id:"ch"+i,pointId:c,quantity:"velocity",role:"response",direction:"unknown"}])})}>{draft.columns.map((c:string,i:number)=><option key={i} value={i}>{c}</option>)}</CustomSelect></label><label>标定依据<input value={calibration} onChange={e=>setCalibration(e.target.value)}/></label><label>同步时钟依据<input value={clock} onChange={e=>setClock(e.target.value)}/></label><label>撤除激励的记录（衰减法）<input value={excitation} onChange={e=>setExcitation(e.target.value)}/></label><label>环境激励和平稳性依据（SSI）<input value={ambient} onChange={e=>setAmbient(e.target.value)}/></label></div>{draft.channels.map((c:any,i:number)=><div className="dra-object-grid" key={i}><label>列{draft.columns[c.column]} · 测点<input value={c.pointId} onChange={e=>setDraft({...draft,channels:draft.channels.map((v:any,j:number)=>j===i?{...v,pointId:e.target.value}:v)})}/></label><label>物理量<CustomSelect value={c.quantity} onChange={e=>setDraft({...draft,channels:draft.channels.map((v:any,j:number)=>j===i?{...v,quantity:e.target.value,role:e.target.value==='force'?'excitation':'response'}:v)})}>{Object.entries(units).map(([k,u])=><option key={k} value={k}>{k} · {u}</option>)}</CustomSelect></label><label>测量方向<input value={c.direction} onChange={e=>setDraft({...draft,channels:draft.channels.map((v:any,j:number)=>j===i?{...v,direction:e.target.value}:v)})}/></label></div>)}</>}<Button disabled={busy||!canWrite} onClick={()=>void importData()}>校验并保存输入</Button><Button onClick={()=>setDraft(null)}>取消导入</Button></Card>}
 {(busy||loadingResult)&&!result&&<AnalysisLoading label={loadingResult?"正在读取模态参数与图表…":"正在计算模态参数与图表…"}/>}
 {result&&<><Card title="识别参数"><p>{result.status==='complete'?'频率、阻尼和实测复振型已识别':'部分识别：频率与阻尼可用，振型或相位条件不足'} · {result.algorithmVersion}</p><div className="dra-table-wrap"><table><thead><tr><th>阶次</th><th>固有频率 Hz</th><th>衰减频率 Hz</th><th>阻尼比 · %</th><th>衰减率 1/s</th><th>时间常数 s</th><th>振型 / 相位</th><th>置信与稳定证据</th></tr></thead><tbody>{result.modes.map((m:any,i:number)=><tr key={i}><td>{i+1}<small>{m.status}</small></td><td>{valueText(m.naturalFrequencyHz)}</td><td title={m.dampedFrequencyHz==null?'本方法没有独立估计此字段':''}>{valueText(m.dampedFrequencyHz)}</td><td>{valueText(m.dampingRatio*100)}</td><td>{valueText(m.decayRatePerSecond)}</td><td>{valueText(m.timeConstantSeconds)}</td><td>{m.shape?<details><summary>实测复振型</summary><pre>{JSON.stringify(m.shape,null,2)}</pre></details>:m.shapeReason}</td><td><details><summary>查看</summary><pre>{JSON.stringify({quality:m.quality,uncertainty:m.uncertainty},null,2)}</pre></details></td></tr>)}</tbody></table></div><p className="hint">数值识别不等同于健康或损伤结论。多模型阶次稳定性不冒充独立重复试验置信区间。</p></Card><div className="dra-signal-grid">{cards.map(c=><AnalysisCard key={c.id} {...c} context={chartContext} expandOnPlotClick/>)}</div>{result.modes.some((m:any)=>m.shape)&&<div className="dra-signal-grid">{result.modes.filter((m:any)=>m.shape).map((m:any,i:number)=><AnalysisCard key={i} id={'MOD-SHAPE-'+i} title={'实测复振型 · '+valueText(m.naturalFrequencyHz)+' Hz'} context={chartContext} subtitle={'参考节点 '+m.shape.referenceNode+' · '+m.shape.normalization} option={lineOption([{name:'实部',data:m.shape.nodes.map((n:any,j:number)=>[j,n.real])},{name:'虚部',data:m.shape.nodes.map((n:any,j:number)=>[j,n.imag])}],'实测节点序号','复振型（归一化）')} expandOnPlotClick/>)}</div>}<Card title="已保存版本比较"><div className="formal-modal-comparison"><CustomSelect aria-label="模态参考版本" value={referenceId} onChange={e=>setReferenceId(e.target.value)}><option value="">选择参考版本</option>{catalog.jobs.filter((j:any)=>j.status==='complete'&&j.id!==job.id).map((j:any)=><option key={j.id} value={j.id}>{names[j.method]} · {j.finishedAt}</option>)}</CustomSelect><Button disabled={!referenceId} onClick={async()=>{try{setComparison(await post({action:'compare',id:job.id,referenceId}));}catch(e){setError((e as Error).message);}}}>对比频率、阻尼与 MAC</Button></div>{comparison&&<><p>{comparison.limitations.join('；')||'同节点及方向；工况适用性仍需结合已保存工况核对'}</p><pre>{JSON.stringify(comparison,null,2)}</pre></>}</Card><details><summary>生效方案与完整方法证据</summary><pre>{JSON.stringify({parameters:result.parameters,inputSamples:result.inputSamples,sampleRateHz:result.sampleRateHz,sourceSha256:job.sourceSha256||job.result?.sourceSha256},null,2)}</pre></details></>}
 </div>;
}
