"use client";
import React, {useState} from 'react';
import {Button, CustomSelect} from './common';
import type {RecordAnalysisBridge, RecordAnalysisCommand} from './field-record-analysis-data';

type ImportFile = {fileId:string;fileName:string;bladeId:string;azimuthDeg:number|string|null;pointName?:string;radiusM?:number|null;samples?:number;sampleRate?:number;error?:string;selected:boolean};
type ImportStage = {token:string;files:ImportFile[];defaults?:{name?:string;windFarm?:string;turbine?:string}};
type PointMapping = {key:string;name:string;radiusM:string};
export function importPointMappings(files:ImportFile[]):PointMapping[] {
 return [...new Set(files.filter(f=>!f.error).map(f=>f.pointName||''))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).map(key=>{
  const radii=[...new Set(files.filter(f=>!f.error&&(f.pointName||'')===key).map(f=>f.radiusM).filter(v=>typeof v==='number'&&Number.isFinite(v)&&v>0))];
  return {key,name:key,radiusM:radii.length===1?String(radii[0]):''};
 });
}
export function importFileMappings(files:ImportFile[], points:PointMapping[]) {
 return files.filter(f=>f.selected&&!f.error).map(f=>{
  const point=points.find(p=>p.key===(f.pointName||''));
  return {fileId:f.fileId,bladeId:f.bladeId,azimuthDeg:f.azimuthDeg==null||f.azimuthDeg===''?null:Number(f.azimuthDeg),pointName:point?.name.trim()||'',radiusM:!point?.radiusM.trim()?null:Number(point.radiusM)};
 });
}
export function OutdoorSegmentImport({request,onImported}:{request:RecordAnalysisBridge;onImported:(id:string)=>void}) {
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[stage,setStage]=useState<ImportStage|null>(null);
 const [form,setForm]=useState({name:'',windFarm:'',turbine:''}),[points,setPoints]=useState<PointMapping[]>([]);
 const call=<T,>(value:RecordAnalysisCommand)=>request<T>({action:'recordAnalysis',request:value});
 async function select(kind:string) {
  setBusy(true);setError('');
  try {
   const v=await call<ImportStage&{canceled?:boolean}>({action:'import_select',kind});
   if(!v.canceled) {
    const files=v.files.map(f=>({...f,selected:!f.error}));
    setStage({...v,files});setPoints(importPointMappings(files));
    setForm(current=>({name:current.name||v.defaults?.name||'',windFarm:current.windFarm||v.defaults?.windFarm||'',turbine:current.turbine||v.defaults?.turbine||''}));
   }
  } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
 }
 async function save() {
  if(!stage)return;
  setBusy(true);setError('');
  try {
   const v=await call<{taskId:string}>({action:'import_commit',token:stage.token,...form,files:importFileMappings(stage.files,points)});
   setOpen(false);setStage(null);setPoints([]);setForm({name:'',windFarm:'',turbine:''});onImported(v.taskId);
  } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
 }
 function updateFile(id:string,key:keyof ImportFile,value:unknown) {setStage(s=>s?{...s,files:s.files.map(f=>f.fileId===id?{...f,[key]:value}:f)}:s);}
 function updatePoint(key:string,field:'name'|'radiusM',value:string) {setPoints(v=>v.map(p=>p.key===key?{...p,[field]:value}:p));}
 const selected=importFileMappings(stage?.files||[],points);
 const incomplete=!selected.length||selected.some(f=>!f.pointName||!f.bladeId?.trim()||f.azimuthDeg==null||!Number.isFinite(f.azimuthDeg)||f.azimuthDeg<0||f.azimuthDeg>=360||(f.radiusM!=null&&(!Number.isFinite(f.radiusM)||f.radiusM<=0)));
 return <><Button onClick={()=>setOpen(true)}>导入户外分段</Button>{open&&<div className="outdoor-import-backdrop"><section className="outdoor-import-dialog" role="dialog" aria-modal="true" aria-label="导入户外分段" aria-busy={busy}>
  <header><div><h2>导入户外分段</h2><p>一次选择多个测点数据包，按叶片、测点和角度归入同一个任务。</p></div><Button disabled={busy} onClick={()=>setOpen(false)}>关闭</Button></header>
  <div className="dra-actions"><Button disabled={busy} onClick={()=>void select('folder')}>选择文件夹</Button><Button disabled={busy} onClick={()=>void select('zip')}>选择 ZIP（可多选）</Button><span role="status">{busy?'正在处理…':stage?`${selected.length} 条记录 · ${new Set(selected.map(f=>f.bladeId)).size} 个叶片 · ${new Set(selected.map(f=>f.pointName)).size} 个测点`:'manifest JSON + CSV.GZ'}</span></div>
  <div className="dra-algorithm-grid">{([['name','任务名称'],['windFarm','风场'],['turbine','风机']] as const).map(([key,label])=><label key={key}>{label}<input aria-label={'户外'+label} disabled={busy} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}<label>测量模式<CustomSelect value="outdoor" disabled><option value="outdoor">户外测量</option></CustomSelect></label></div>
  {stage&&<><div className="dra-table-wrap outdoor-import-points"><table><thead><tr><th>来源测点</th><th>导入测点</th><th>距旋转中心 · m（可选）</th><th>已选记录</th></tr></thead><tbody>{points.map(p=><tr key={p.key}><td>{p.key||'未识别'}</td><td><input aria-label={(p.key||'未识别')+' 导入测点'} disabled={busy} value={p.name} onChange={e=>updatePoint(p.key,'name',e.target.value)}/></td><td><input aria-label={(p.key||'未识别')+' 距旋转中心'} type="number" min={0} step="any" placeholder="未知可留空" disabled={busy} value={p.radiusM} onChange={e=>updatePoint(p.key,'radiusM',e.target.value)}/></td><td>{stage.files.filter(f=>f.selected&&!f.error&&(f.pointName||'')===p.key).length}</td></tr>)}</tbody></table></div>
  <details className="outdoor-import-detail"><summary>查看 {stage.files.length} 个分段文件</summary><div className="dra-table-wrap outdoor-import-files"><table><thead><tr><th>选择</th><th>文件</th><th>测点</th><th>叶片</th><th>角度 · °</th><th>样本 / 采样率</th><th>检查</th></tr></thead><tbody>{stage.files.map(f=><tr key={f.fileId}><td><input type="checkbox" aria-label={'导入 '+f.fileName} disabled={busy||!!f.error} checked={f.selected} onChange={e=>updateFile(f.fileId,'selected',e.target.checked)}/></td><td>{f.fileName}</td><td>{points.find(p=>p.key===(f.pointName||''))?.name||'未填写'}</td><td><input aria-label={f.fileName+' 叶片'} disabled={busy||!!f.error||/\d+号叶片[_\s-]*\d+(?:\.\d+)?度/.test(f.fileName)} value={f.bladeId||''} onChange={e=>updateFile(f.fileId,'bladeId',e.target.value)}/></td><td><input aria-label={f.fileName+' 角度'} type="number" min={0} max={359.999} disabled={busy||!!f.error||/\d+号叶片[_\s-]*\d+(?:\.\d+)?度/.test(f.fileName)} value={f.azimuthDeg??''} onChange={e=>updateFile(f.fileId,'azimuthDeg',e.target.value)}/></td><td>{f.samples?.toLocaleString()} / {f.sampleRate} Hz</td><td>{f.error||'可导入'}</td></tr>)}</tbody></table></div></details></>}
  {error&&<p role="alert" className="dra-warning">{error}</p>}<footer className="dra-actions"><Button variant="primary" disabled={busy||incomplete||!form.name.trim()||!form.windFarm.trim()||!form.turbine.trim()} onClick={()=>void save()}>建立户外任务</Button></footer>
 </section></div>}</>;
}
