"use client";
import React,{useState,useEffect} from 'react';
import {Button,Card,Dialog,Table,Tag,CustomSelect} from './common';
import {api} from './api';
import {STANDARD_METRICS,type HealthStandardMode} from './blade-health-standard';
import {numberText,timeText} from './measurement-common';

export function HealthStandardEditor({context,onClose,onSaved}:{context:any;onClose:()=>void;onSaved:()=>void}){
 const [catalog,setCatalog]=useState<any>(null),[selected,setSelected]=useState<string[]>([]);
 const [name,setName]=useState(''),[mode,setMode]=useState<HealthStandardMode>('same_condition');
 const [approval,setApproval]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const responseOnly=mode==='response_reference',minimum=responseOnly?3:6;
 useEffect(()=>{let active=true;api('measurements/blade-health','POST',{action:'standard-catalog',context}).then(r=>{if(active){setCatalog(r);setName(r.defaultName||'健康响应标准');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[JSON.stringify(context)]);
 async function publish(){setBusy(true);setError('');try{await api('measurements/blade-health','POST',{action:'publish-standard',context,sourceIds:selected,name,mode,approval,confirmHealthy:confirmed});onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <Dialog title="建立健康标准" wide onClose={onClose}><div className="stack health-standard-editor">
  <label>标准名称<input value={name} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
  <label>比较方式<CustomSelect value={mode} disabled={busy} onChange={e=>setMode(e.target.value as HealthStandardMode)}>
   <option value="same_condition">同工况健康评价</option><option value="response_reference">已知健康样本响应筛查</option>
  </CustomSelect></label>
  <p>{responseOnly?'选择至少一批、三片已确认健康叶片的已发布分析。按同测点、同角度建立响应范围；无需补写缺失工况，工况差异可能影响筛查结果。':'选择至少两批、每批三片已确认健康叶片的已发布分析，并匹配真实同期风速和转速。'}原始波形和处理历史保持不变。</p>
  {!catalog&&!error&&<p role="status">正在加载健康来源…</p>}
  {catalog&&!catalog.choices.length&&<p>当前风机暂无可用整叶片分析，请先完成叶片响应分析。</p>}
  <div className="health-standard-source-list">{catalog?.choices.map((p:any)=><label key={p.id}><input type="checkbox" checked={selected.includes(p.id)} disabled={!p.published||busy} onChange={e=>setSelected(v=>e.target.checked?[...v,p.id]:v.filter(id=>id!==p.id))}/><span>{p.name} · {p.bladeName} · {p.id.slice(0,8)}<small>{timeText(p.finishedAt)} · {p.published?'已发布':'请先在分析页保存此版本'}</small></span></label>)}</div>
  <label>健康样本及分组确认依据<textarea value={approval} disabled={busy} onChange={e=>setApproval(e.target.value)} maxLength={3000} placeholder="说明哪些批次为已知健康叶片，测点及角度分组依据，以及历史修订的适用范围"/></label>
  <label className="health-standard-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>确认这些来源是已知健康样本，并已核对对象分组及历史处理标记。</label>
  <p className="hint">速度范围外扩10%；主响应峰频率外扩5%且不少于一格频率分辨率；峰值因子及峭度外扩20%。初始工程容差，检出能力需用独立损伤样本验证。</p>
  {error&&<p role="alert">{error}</p>}<Button variant="primary" disabled={busy||!confirmed||!approval.trim()||!name.trim()||selected.length<minimum} onClick={()=>void publish()}>{busy?'正在生成标准…':'发布健康标准'}</Button>
 </div></Dialog>;
}
export function HealthVerificationDialog({blade,context,identity,onClose,onSaved}:{blade:any;context:any;identity?:boolean;onClose:()=>void;onSaved:()=>void}){
 const [note,setNote]=useState(''),[evidence,setEvidence]=useState(''),[confirmed,setConfirmed]=useState(false),[conclusion,setConclusion]=useState(blade.healthScreening?.status==='normal'?'healthy':'damaged'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function save(){setBusy(true);try{await api('measurements/blade-health','POST',{action:identity?'verify-identity':'publish-decision',context,bladeId:blade.bladeId,processingResultId:blade.processingResultId,inputKey:blade.inputKey,note,evidence,confirmIdentity:confirmed,conclusion});onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <Dialog title={identity?'核验叶片身份与分组':'复核并发布结论'} onClose={onClose}><div className="stack"><p>叶片 {blade.name} · 版本 {blade.processingResultId.slice(0,8)} · {blade.standardSnapshot?.name}</p>{identity?<label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>确认记录对应的物理叶片、P1–P5及四角度分组</label>:<label>复核结论<select value={conclusion} onChange={e=>setConclusion(e.target.value)}><option value="healthy" disabled={blade.healthScreening?.status!=='normal'}>健康</option><option value="damaged" disabled={blade.healthScreening?.status==='normal'}>损伤（人工复核确认）</option><option value="inconclusive">待复核</option></select></label>}<label>{identity?'身份及分组依据':'复核说明'}<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={3000}/></label>{!identity&&<label>巡检、检测报告或其他确认依据<textarea value={evidence} onChange={e=>setEvidence(e.target.value)} maxLength={3000} placeholder="填写报告编号、检测方式与结果；系统记录当前账号及发布时间"/></label>}{error&&<p role="alert">{error}</p>}<p className="hint">复核绑定当前处理版本、健康标准和工况；任一变化须重新核验。</p><Button variant="primary" disabled={busy||!note.trim()||(identity?!confirmed:!evidence.trim())} onClick={()=>void save()}>{busy?'正在保存…':identity?'保存身份核验':'发布复核结论'}</Button></div></Dialog>;
}
export function ScenarioDetectionSummary({blade,onDetails}:{blade:any;onDetails?:()=>void}){
 const d=blade.syntheticScenario?.detection,ready=!!d&&d.status!=='insufficient';
 return <div aria-label="专项损伤检测结果"><div className="measurement-summary"><Tag tone={!ready?'gray':d.riskLevel==='high'?'red':d.riskLevel==='medium'?'amber':'green'}>{!ready?'待复核':d.riskLevel==='high'?'损伤预警 · 高风险':d.riskLevel==='medium'?'损伤预警 · 中风险':'检测通过 · 响应正常'}</Tag><span>已比较 {d?.compared||0} 项 · 超限 {d?.outsideCount||0} 项</span></div><p>{d?.reasons?.join('；')||(ready?'全部响应指标位于参考范围内。':'请重新检测当前处理版本。')}</p>{!!d?.pointEvidence?.length&&<p>异常测点：{d.pointEvidence.map((p:any)=>p.point).join('、')}</p>}{onDetails&&<Button onClick={onDetails}>查看检测依据</Button>}</div>;
}
export function HealthStandardEvidence({blade,canWrite,onIdentity,onDecision}:{blade:any;canWrite:boolean;onIdentity:()=>void;onDecision:()=>void}){
 const [onlyOutside,setOnlyOutside]=useState(true);const screening=blade.healthScreening,standard=blade.standardSnapshot;
 if(blade.syntheticScenario){
  const scenario=blade.syntheticScenario,rows=(scenario.comparisons||[]).filter((c:any)=>!onlyOutside||c.outside),d=scenario.detection;
  return <div className="stack"><Card title="专项损伤检测 · 健康响应包络">
   <ScenarioDetectionSummary blade={blade}/>
   <p>参考标准：{scenario.referenceStandardName||'已登记健康参考'} · {scenario.referenceVariantName}</p>
   <p className="hint">检测版本：{d?.algorithmVersion||'—'} · 当前整叶片版本：{blade.processingResultId?.slice(0,8)}</p>
   <details><summary>检测方法与判定规则</summary><p>逐测点、逐角度比较速度 RMS、速度半峰峰值、主响应峰频率、峰值因子和峭度，共100项指标。速度与形状特征取有效连续段最大值；频率取代表段请求频带内最强响应峰。</p><p>任一指标超限触发疑似损伤预警；同一测点/角度至少两项指标超限，或至少两个测点/角度出现超限，判为高风险。频率比较包含频率分辨率容差。该规则识别响应异常，不能单独判定裂纹类型、位置或尺寸。</p></details>
   <details><summary>数据来源与适用范围</summary><p>当前使用算法验证数据，非现场实测，预警根据当前波形特征计算。关联的分钟工况用于背景对照，波形时钟已对齐到工况日期，不代表同期现场实测；检测结果不能作为现场健康或结构损伤确诊。</p></details>
  </Card>{!!d?.pointEvidence?.length&&<Card title="异常测点分布"><Table headers={['测点','异常角度','超限项数','异常指标']}>{d.pointEvidence.map((p:any)=><tr key={p.point}><td>{p.point}</td><td>{p.angles.join(' / ')}°</td><td>{p.outsideCount}</td><td>{p.metrics.join('、')}</td></tr>)}</Table></Card>}
  <Card title="检测指标与阈值"><label><input type="checkbox" checked={onlyOutside} onChange={e=>setOnlyOutside(e.target.checked)}/>仅显示超限项</label><Table headers={['测点 / 角度','指标','本次值','参考范围','结果']}>{rows.map((c:any)=><tr key={c.recordingId+c.metric}><td>{c.point} / {c.angle}°</td><td>{c.name} · {c.unit}</td><td>{numberText(c.value,5)}</td><td>{numberText(c.min,5)} ～ {numberText(c.max,5)}</td><td>{c.outside?'超限':'范围内'}</td></tr>)}</Table>{!rows.length&&<p>{scenario.comparisons?.length?'全部指标均在参考范围内。':scenario.reason||'暂无可比较指标，请检查参考场景与处理配置。'}</p>}</Card></div>;
 }
 if(!standard)return <Card title="健康判据"><p>尚未发布健康标准。请先保存已知健康叶片的整叶片分析，再通过“健康标准”选择比较方式并建立范围。</p></Card>;
 const comparisons=(screening?.comparisons||[]).filter((c:any)=>!onlyOutside||c.outside);
 return <div className="stack"><Card title="专项损伤筛查 · 健康响应包络"><div className="measurement-summary"><Tag tone={screening?.status==='normal'?'green':screening?.status==='insufficient'?'gray':'amber'}>{screening?.label||'待分析'}</Tag><span>{standard.name} · {standard.id.slice(0,8)}</span><span>{screening?.variantName}</span></div><p>自动检测依据全部有效段的最大速度 RMS、速度半峰峰值、峰值因子及峭度，以及代表段主响应峰频率。超限定位到测点/角度，分为中、高风险；采集质量异常或不适用工况进入待复核。</p>{screening?.baselineMember&&<p className="health-standard-note">已确认健康基线样本 · 本次为基线回代检查，不是独立检出验证。</p>}{screening?.scopeNote&&<p className="hint">{screening.scopeNote}</p>}<p className="hint">“健康”表示本项目标准适用范围内的振动响应正常；超限表示疑似损伤，结构损伤由人工证据确认。</p><div className="measurement-heading-actions"><Button disabled={!canWrite} onClick={onIdentity}>核验身份与分组</Button><Button variant="primary" disabled={!canWrite||screening?.status==='insufficient'} onClick={onDecision}>复核并发布结论</Button></div>{blade.finalDecision&&<p>已发布：{blade.finalDecision.conclusion==='damaged'?'损伤':blade.finalDecision.conclusion==='healthy'?'健康':'待复核'} · {blade.finalDecision.reviewer} · {timeText(blade.finalDecision.createdAt)}<br/>{blade.finalDecision.note}<br/>依据：{blade.finalDecision.evidence}</p>}</Card><Card title="异常指标与定位"><label><input type="checkbox" checked={onlyOutside} onChange={e=>setOnlyOutside(e.target.checked)}/>仅显示超限项</label><Table headers={['测点 / 角度','指标','本次值','健康标准范围','结果']}>{comparisons.map((c:any)=><tr key={c.recordingId+c.metric}><td>{c.point} / {c.angle}°</td><td>{c.name} · {c.unit}</td><td>{numberText(c.value,5)}</td><td>{numberText(c.min,5)} ～ {numberText(c.max,5)}</td><td>{c.outside?'超限':'范围内'}</td></tr>)}</Table>{!comparisons.length&&<p>{screening?.status==='normal'?'100 项指标均在健康标准范围内。':'暂无可比较指标，请检查适用范围。'}</p>}</Card><Card title="标准范围与追溯"><p>发布人：{standard.approvedBy} · {timeText(standard.createdAt)}<br/>确认依据：{standard.approval}</p><p>{standard.validation}</p>{standard.provenanceNotes?.map((n:string)=><p className="hint" key={n}>{n}</p>)}<details><summary>查看各场景与测点阈值</summary>{standard.variants.map((v:any)=><section key={v.campaignId+v.signature}><h4>{v.name}</h4><p>风速 {v.windRange?.map((n:number)=>numberText(n,2)).join('～')||'未限定'} m/s · 主轴转速 {v.rpmRange?.map((n:number)=>numberText(n,2)).join('～')||'未限定'} rpm · {v.sources.length} 片健康叶片</p><Table headers={['测点 / 角度',...STANDARD_METRICS.map(m=>m.name+' '+m.unit)]}>{v.slots.map((s:any)=><tr key={s.point+s.angle}><td>{s.point} / {s.angle}°</td>{STANDARD_METRICS.map(m=><td key={m.key}>{numberText(s.limits[m.key].min,3)} ～ {numberText(s.limits[m.key].max,3)}</td>)}</tr>)}</Table></section>)}</details></Card></div>;
}
