"use client";
import React, { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Card, Dialog, Select, Table } from "./common";
import { MeasurementStatus, PageControls, timeText, useMeasurementContext, openMeasurementWorkspace } from "./measurement-common";
import {validateWindTimeSemantics,type WindTimeSemantics} from "./measurement-conditions";
import type { MeasurementObject } from "./measurement-domain";

const columns: Record<string, string> = {
  turbineCode: "名称", time: "时间", windSpeed: "风速", powerKw: "发电机有功功率",
  rpm: "主轴转速", temperatureC: "舱外温度", windDirection: "风向",
};
const unitOptions: Record<string, { value: string; label: string }[]> = {
  windSpeed: [{ value: "m/s", label: "m/s" }, { value: "km/h", label: "km/h" }],
  powerKw: [{ value: "kW", label: "kW" }, { value: "W", label: "W" }, { value: "MW", label: "MW" }],
  rpm: [{ value: "rpm", label: "rpm（转/分）" }, { value: "rps", label: "转/秒" }],
  temperatureC: [{ value: "C", label: "摄氏度（°C）" }, { value: "F", label: "华氏度（°F）" }],
  windDirection: [{ value: "deg", label: "度（°）" }],
};
type Preview = { token: string; filename: string; encoding: string; headers: string[]; rows: string[][];
  rowCount: number; suggestedMapping: Record<string, string>; mapping: Record<string, string>;
  sourceFormat?: string; suggestedUnits?: Record<string, string>; windDirectionReference?: string };

type SavedDataset = { id: string; name: string; farmId: string; rowCount: number; start: string; end: string;
  metricCounts?: Record<string, number>; matchedRowCount?: number; matchedStart?: string; matchedEnd?: string };
type WindRow = { time: string; turbineCode: string; windSpeed?: number | null; rpm?: number | null;
  windDirection?: number | null; powerKw?: number | null; temperatureC?: number | null };
type WindPage = { id: string; name: string; total: number; offset: number; limit: number; rows: WindRow[]; units: Record<string, string> };
const metricLabels = [
  ["windSpeed", "风速", "m/s"], ["powerKw", "发电机有功功率", "kW"], ["rpm", "主轴转速", "rpm"],
  ["temperatureC", "舱外温度", "°C"], ["windDirection", "风向", "°"],
] as const;
const beijingTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function TimeSemanticsFields({value,onChange}:{value:WindTimeSemantics;onChange:(v:WindTimeSemantics)=>void}){
 const set=(key:string,next:any)=>onChange({...value,[key]:next});
 return <div className="measurement-filters wind-time-semantics">
 <Select label="时间统计口径" value={value.timeBasis} onChange={v=>set('timeBasis',v)} options={[{value:'unknown',label:'待确认'},{value:'instantaneous',label:'瞬时值'},{value:'interval_mean',label:'区间均值'}]}/>
 {value.timeBasis==='interval_mean'&&<><label>统计周期 · 秒<input type="number" min={.001} max={86400} value={value.intervalSeconds} onChange={e=>set('intervalSeconds',Number(e.target.value))}/></label><Select label="时间戳表示" value={value.timestampPosition} onChange={v=>set('timestampPosition',v)} options={[{value:'start',label:'区间开始'},{value:'center',label:'区间中心'},{value:'end',label:'区间结束'}]}/></>}
 <Select label="转速物理含义" value={value.rpmMeaning} onChange={v=>set('rpmMeaning',v)} options={[{value:'unknown',label:'待确认'},{value:'rotor',label:'叶轮／主轴转速'}]}/>
 <label>允许邻近时间差 · ms<input type="number" min={0} max={3600000} value={value.maxGapMs} onChange={e=>set('maxGapMs',Number(e.target.value))}/></label>
 <label>时钟校正 · ms<input type="number" value={value.clockOffsetMs} onChange={e=>set('clockOffsetMs',Number(e.target.value))}/></label>
 <label>时间与偏差确认依据<input maxLength={500} value={value.basis} onChange={e=>set('basis',e.target.value)}/></label>
 </div>;
}
function DatasetTiming({dataset,onClose,onSaved}:{dataset:SavedDataset;onClose:()=>void;onSaved:()=>void}){
 const [value,setValue]=useState(()=>validateWindTimeSemantics((dataset as any).timeSemantics)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <Dialog title="工况时间语义" onClose={onClose}><TimeSemanticsFields value={value} onChange={setValue}/><p className="hint">0 ms 只取有效段内的观测；区间均值仅为背景工况。修改将使既有评价待重算，旧报告不变。</p>{error&&<p className="error">{error}</p>}<Button disabled={busy} onClick={async()=>{setBusy(true);try{validateWindTimeSemantics(value);await api(`wind-datasets/${dataset.id}/timing`,'PUT',{timeSemantics:value});onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>保存时间口径</Button></Dialog>;
}

function DatasetPreview({ dataset, onClose }: { dataset: SavedDataset; onClose: () => void }) {
  const [position, setPosition] = useState<{ offset: number; at?: string }>({ offset: 0 }), [limit, setLimit] = useState(50), [retry, setRetry] = useState(0),
    [data, setData] = useState<WindPage | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setBusy(true); setError(""); setData(null);
    const cursor = position.at ? `at=${encodeURIComponent(position.at)}` : `offset=${position.offset}`;
    api<WindPage>(`wind-datasets/${encodeURIComponent(dataset.id)}/rows?${cursor}&limit=${limit}`)
      .then(value => { if (current) setData(value); })
      .catch(e => { if (current) setError((e as Error).message); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [dataset.id, position, limit, retry]);
  const total = data?.total ?? dataset.rowCount, pages = Math.max(1, Math.ceil(total / limit));
  const offset = data?.offset ?? position.offset, page = Math.min(pages - 1, Math.floor(offset / limit));
  const fields = metricLabels.filter(([key]) => !dataset.metricCounts || (dataset.metricCounts[key] || 0) > 0);
  const changePage = (next: number) => { setData(null); setBusy(true); setPosition({ offset: next }); };
  return <Dialog title="预览数据集" onClose={onClose} wide>
    <div className="wind-data-preview">
      <div className="wind-preview-toolbar">
        <div><strong>{dataset.name}</strong><p className="hint">共 {total.toLocaleString()} 条 · 时间为北京时间（UTC+8） · 缺失值显示 —</p>
          {dataset.matchedStart && dataset.matchedStart !== dataset.start && <Button className="wind-preview-jump" disabled={busy} onClick={() => {
            setData(null); setBusy(true); setPosition({ offset: 0, at: dataset.matchedStart });
          }}>跳到风速与转速齐全时段</Button>}</div>
        <Select label="每页条数" value={limit} disabled={busy} options={["20", "50", "100"]}
          onChange={value => { if (Number(value) === limit) return; setData(null); setBusy(true); setPosition({ offset: 0 }); setLimit(Number(value)); }} />
      </div>
      <div className="wind-preview-table" aria-busy={busy}>
        {busy ? <div className="wind-preview-placeholder" role="status">正在加载本页数据…</div>
          : error ? <div className="error" role="alert">{error} <Button onClick={() => setRetry(n => n + 1)}>重试</Button></div>
          : data && <Table headers={["序号", "名称", "时间", ...fields.map(([key, label, fallback]) => {
            const unit = data.units?.[key] || fallback;
            return `${label} · ${unit === "deg" ? "°" : unit}`;
          })]}>
            {data.rows.map((row, i) => <tr key={`${row.turbineCode}-${row.time}-${i}`}>
              <td>{data.offset + i + 1}</td><td>{row.turbineCode}</td><td>{beijingTime.format(new Date(row.time))}</td>
              {fields.map(([key]) => <td key={key}>{row[key] != null && Number.isFinite(row[key]) ? String(row[key]) : "—"}</td>)}
            </tr>)}
          </Table>}
        {!busy && !error && data && !data.rows.length && <p className="hint">本页没有数据。</p>}
      </div>
      {fields.some(([key]) => key === "windDirection") && <p className="hint">风向保留原始正负角度，方向基准待确认。</p>}
      <div className="wind-preview-footer">
        <span className="hint">{data?.rows.length ? `显示第 ${(data.offset + 1).toLocaleString()}–${(data.offset + data.rows.length).toLocaleString()} 条` : "每次最多加载 100 条"}</span>
        <div className="wind-dataset-actions"><span>第 {page + 1} / {pages.toLocaleString()} 页</span>
          <Button disabled={busy || offset === 0} onClick={() => changePage(0)}>首页</Button>
          <Button disabled={busy || offset === 0} onClick={() => changePage(Math.max(0, offset - limit))}>上一页</Button>
          <Button disabled={busy || !!error || offset + limit >= total} onClick={() => changePage(offset + limit)}>下一页</Button>
          <Button disabled={busy || !!error || offset + limit >= total} onClick={() => changePage((pages - 1) * limit)}>末页</Button>
        </div>
      </div>
    </div>
  </Dialog>;
}

function DeleteDataset({ dataset, onClose, onDeleted }: { dataset: SavedDataset; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function remove() {
    setBusy(true); setError("");
    try { await api(`wind-datasets/${encodeURIComponent(dataset.id)}`, "DELETE"); onDeleted(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <Dialog title="删除数据集" onClose={() => { if (!busy) onClose(); }}>
    <p className="dialog-message">删除 <strong>{dataset.name}</strong> 的全部 <strong>{dataset.rowCount.toLocaleString()}</strong> 条工况数据？</p>
    <p className="hint">删除后，新分析不再使用这些工况数据。已有测量记录和分析结果保留；需要时可重新导入源文件。</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="dialog-actions"><Button disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? "正在删除…" : "确认删除"}</Button></div>
  </Dialog>;
}

export function WindDatasets({ canWrite }: { canWrite: boolean }) {
  const [all, setAll] = useState<MeasurementObject[]>([]), [datasets, setDatasets] = useState<SavedDataset[]>([]),
    [farm, setFarm] = useState(""), [name, setName] = useState(""), [previews, setPreviews] = useState<Preview[]>([]),
    [timing,setTiming]=useState<WindTimeSemantics>(()=>validateWindTimeSemantics({})),[timingDataset,setTimingDataset]=useState<SavedDataset|null>(null),
    [units, setUnits] = useState<Record<string, string>>({}), [timezoneOffset, setTimezoneOffset] = useState("+08:00"),
    [busy, setBusy] = useState(false), [error, setError] = useState(""), [page, setPage] = useState(0), [message, setMessage] = useState(""),
    [previewDataset, setPreviewDataset] = useState<SavedDataset | null>(null), [deleteDataset, setDeleteDataset] = useState<SavedDataset | null>(null);
  const [measurementContext]=useMeasurementContext();
  async function load() {
    setBusy(true);
    try {
      const r = await api<any>("wind-datasets");
      setAll(r.objects); setDatasets(r.datasets); setError("");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function upload(files: File[]) {
    setError(""); setMessage("");
    if (files.length + previews.length > 8) { setError("一次最多选择 8 份文件，可先移除已选文件。"); return; }
    if (files.some(file => file.size > 16 * 1024 * 1024)) { setError("每份工况文件不能超过 16 MB。"); return; }
    setBusy(true);
    try {
      for (const [index, file] of files.entries()) {
        setMessage(`正在读取 ${index + 1}/${files.length}：${file.name}`);
        const response = await fetch(`/api/v1/wind-datasets/preview-file?filename=${encodeURIComponent(file.name)}`, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: file,
        });
        const value = await response.json();
        if (!response.ok) throw Error(value.error || "工况文件读取失败");
        setPreviews(current => [...current, { ...value, mapping: value.suggestedMapping }]);
        if (value.sourceFormat === "turbine-minute-v1") setUnits(current => ({ ...value.suggestedUnits, ...current }));
      }
      if (!name) setName(files.length === 1 ? files[0].name : `${files[0].name.replace(/[_-].*$/, "")} · 风场工况`);
      setMessage("已读取文件。请核对指标单位和原始时区，再导入。");
    } catch (e) { setError((e as Error).message); setMessage(""); }
    finally { setBusy(false); }
  }
  const metrics = Object.keys(unitOptions).filter(key => previews.some(p => p.mapping[key]));
  const mappingsValid = previews.length > 0 && previews.every(p => p.mapping.time && p.mapping.turbineCode && metrics.some(key => p.mapping[key]) &&
    new Set(Object.values(p.mapping).filter(Boolean)).size === Object.values(p.mapping).filter(Boolean).length);
  const ready = mappingsValid && metrics.every(key => units[key]) && farm && name.trim();
  async function save() {
    setBusy(true); setError(""); setMessage("正在合并并保存工况数据…");
    try {
      const r = await api<any>("wind-datasets/import", "POST", {
        name, farmId: farm, timezoneOffset, units,timeSemantics:timing,
        files: previews.map(p => ({ token: p.token, mapping: p.mapping })),
      });
      setPreviews([]); setUnits({}); setName("");
      await load();
      setMessage(`已保存 ${r.count.toLocaleString()} 个风机时间点，其中 ${r.matchedRowCount.toLocaleString()} 个同时有风速和转速。缺失指标保持缺失。请到健康监测重新关联工况并更新评价。`);
    } catch (e) { setError((e as Error).message); setMessage(""); }
    finally { setBusy(false); }
  }
  const shown = datasets.filter(d => !farm || d.farmId === farm);
  useEffect(() => { setPage(current => Math.min(current, Math.max(0, Math.ceil(shown.length / 20) - 1))); }, [shown.length]);
  return <div className="stack measurement-workspace">
    <header><h1>风场数据集</h1><p>按风机名称与时间导入工况数据。</p></header>
    <Card title="导入工况文件">
      <div className="measurement-filters">
        <Select label="风场" value={farm} options={all.filter(o => o.kind === "farm" && o.active).map(o => ({ value: o.id, label: o.name }))}
          disabled={busy} onChange={v => { setFarm(v); setPage(0); }} />
        <label>CSV / XLSX · 可多选<input aria-label="风场数据文件" type="file" accept=".csv,.xlsx" multiple disabled={!canWrite || busy}
          onChange={e => { const files = Array.from(e.target.files || []); if (files.length) void upload(files); e.target.value = ""; }} /></label>
      </div>
      <p className="hint">CSV 列：名称、时间、风速、发电机有功功率、主轴转速、舱外温度、风向。每份最多 16 MB / 25 万行，兼容原有分指标文件。</p>
      <MeasurementStatus loading={busy} error={error} onReload={() => void load()} />
      {message && <p role="status">{message} <Button onClick={()=>openMeasurementWorkspace("health",measurementContext.farmId===farm?measurementContext:{farmId:farm})}>前往健康监测</Button></p>}
      {!!previews.length && <div className="stack">
        <Table headers={["已选文件", "数据行", "已识别指标", ""]}>
          {previews.map(p => <tr key={p.token}><td>{p.filename}<small className="hint"> · {p.encoding}{p.sourceFormat === "turbine-minute-v1" ? " · 标准七列格式" : ""}</small></td><td>{p.rowCount.toLocaleString()}</td>
            <td>{metrics.filter(key => p.mapping[key]).map(key => columns[key]).join("、") || "待映射"}</td>
            <td><Button disabled={busy} onClick={() => setPreviews(current => current.filter(item => item.token !== p.token))}>移除</Button></td></tr>)}
        </Table>
        <div className="measurement-filters">
          <label>数据集名称<input value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
          <Select label="无时区时间按此解释" value={timezoneOffset} disabled={busy} onChange={setTimezoneOffset}
            options={[{ value: "+08:00", label: "北京时间 UTC+08:00" }, { value: "+00:00", label: "UTC+00:00" }]} />
          {metrics.map(key => <Select key={key} label={`${columns[key]}原始单位`} value={units[key] || ""} disabled={busy}
            onChange={value => setUnits(current => ({ ...current, [key]: value }))} options={[{ value: "", label: "请选择单位" }, ...unitOptions[key]]} />)}
        </div>
        <TimeSemanticsFields value={timing} onChange={setTiming}/>
        <p className="hint">标准格式预填 m/s、kW、rpm、℃、°，导入前可调整。时间默认按北京时间解释。</p>
        {metrics.includes("windDirection") && <p className="hint">风向保留原始正负角度，方向基准待确认。</p>}
        {!mappingsValid && <p className="error">每份文件需要时间、风机编号与至少一个指标，列映射不能重复。</p>}
        <div><Button variant="primary" disabled={!canWrite || busy || !ready} onClick={() => void save()}>确认单位与时区并导入</Button></div>
        <details className="measurement-advanced"><summary>查看文件预览与列映射 · {previews.length} 份</summary>
        {previews.map(p => <section key={p.token}>
          <h4>{p.filename} · 前 5 行</h4>
          <div className="measurement-filters">{Object.entries(columns).map(([key, label]) => <Select key={key} label={label} value={p.mapping[key] || ""} disabled={busy}
            options={[{ value: "", label: ["time", "turbineCode"].includes(key) ? "选择列" : "本文件不含此项" }, ...p.headers.map(header => ({ value: header, label: header }))]}
            onChange={value => setPreviews(current => current.map(item => item.token === p.token ? { ...item, mapping: { ...item.mapping, [key]: value } } : item))} />)}</div>
          <Table headers={p.headers}>{p.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</Table>
        </section>)}
        </details>
      </div>}
    </Card>
    <Card title="已保存数据集">
      <Table headers={["数据集", "风场", "时间范围", "时间点数", "风速与转速同时存在", "操作"]}>
        {shown.slice(page * 20, (page + 1) * 20).map(d => <tr key={d.id}><td>{d.name}
          {d.metricCounts && <small className="hint" style={{ display: "block" }}>{Object.keys(unitOptions).filter(key => (d.metricCounts?.[key] || 0) > 0).map(key => `${columns[key]} ${d.metricCounts?.[key].toLocaleString()}`).join(" · ")}</small>}
          <small className="hint">时间口径：{(d as any).timeSemantics?.timeBasis==='interval_mean'?`${(d as any).timeSemantics.intervalSeconds}秒区间均值`:(d as any).timeSemantics?.timeBasis==='instantaneous'?'瞬时值':'待确认'} · 已保存评价关联 {(d as any).associationSummary?.campaigns||0} 批次 / {(d as any).associationSummary?.segments||0} 段</small>
        </td><td>{all.find(o => o.id === d.farmId)?.name}</td><td>{timeText(d.start)} ～ {timeText(d.end)}</td><td>{d.rowCount.toLocaleString()}</td><td>{(d.matchedRowCount ?? d.rowCount).toLocaleString()}
          {d.matchedStart && <small className="hint" style={{ display: "block" }}>{timeText(d.matchedStart)} ～ {timeText(d.matchedEnd)}</small>}</td>
          <td><div className="wind-dataset-actions">{canWrite&&<Button disabled={busy} onClick={()=>setTimingDataset(d)}>时间口径</Button>}<Button disabled={busy} onClick={() => setPreviewDataset(d)}>预览</Button>
            {canWrite && <Button variant="danger" disabled={busy} onClick={() => setDeleteDataset(d)}>删除</Button>}</div></td></tr>)}
      </Table>
      {!shown.length && !busy && <p className="hint">尚无工况数据；波形与频谱分析可以继续，工况异常判定暂不出结论。</p>}
      <PageControls page={page} total={shown.length} onChange={setPage} />
    </Card>
    {timingDataset&&<DatasetTiming dataset={timingDataset} onClose={()=>setTimingDataset(null)} onSaved={()=>void load()}/>}
    {previewDataset && <DatasetPreview key={previewDataset.id} dataset={previewDataset} onClose={() => setPreviewDataset(null)} />}
    {deleteDataset && <DeleteDataset key={deleteDataset.id} dataset={deleteDataset} onClose={() => setDeleteDataset(null)} onDeleted={() => {
      setDatasets(current => current.filter(d => d.id !== deleteDataset.id));
      setMessage(`已删除数据集：${deleteDataset.name}`); setDeleteDataset(null);
    }} />}
  </div>;
}
