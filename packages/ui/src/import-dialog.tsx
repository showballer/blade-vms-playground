"use client";
import { useEffect, useRef, useState } from "react";
import { api, saveDataFile } from "./api";
import { Button, Dialog, Empty, Progress, Select, Table, Tabs, Tag } from "./common";
import { createImportJob, csvImportRecord, decodeImportFile, importView, normalizeImportRequest, type DecodedImport, type ImportView } from "./import-data";

export function ImportDialog({ defaults, initialMode = "new", canWrite, notify, refresh, onClose }: {
  defaults: Record<string, any>; initialMode?: "new" | "history"; canWrite: boolean; notify: (message: string) => void; refresh: () => Promise<void>; onClose: () => void;
}) {
  const [mode, setMode] = useState<string>(initialMode), [file, setFile] = useState<DecodedImport | null>(null), [filename, setFilename] = useState("");
  const [csvMetadata, setCsvMetadata] = useState<Record<string, any>>({}), [unit, setUnit] = useState("");
  const [jobs, setJobs] = useState<ImportView[]>([]), [job, setJob] = useState<ImportView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null), [itemErrors, setItemErrors] = useState<Record<number, string>>({}), [stopping, setStopping] = useState(false);
  const input = useRef<HTMLInputElement>(null), stop = useRef(false), readVersion = useRef(0), pendingCreate = useRef<ReturnType<typeof normalizeImportRequest> | null>(null);
  async function loadJobs() { try { setJobs(await api<ImportView[]>("imports")); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { void loadJobs(); return () => { readVersion.current++; }; }, []);
  let preview: ImportView | null = null, records: unknown[] = [], previewError = "";
  if (file) try {
    const channels = Array.isArray(csvMetadata.channels) ? csvMetadata.channels : [];
    records = file.format === "json" ? file.records : [csvImportRecord(file, { ...csvMetadata, channels: [{ no: channels[0]?.no ?? 1, type: channels[0]?.type ?? "other", unit }, ...channels.slice(1)] })];
    preview = importView(createImportJob(normalizeImportRequest({ id: "preview", filename, records })));
  } catch (e) { previewError = (e as Error).message; }
  async function readFile(selected: File) {
    const version = ++readVersion.current;
    setError(""); setFile(null); pendingCreate.current = null;
    try {
      if (selected.size > 1_500_000) throw Error("单个文件不能超过 1.5 MB");
      const decoded = decodeImportFile(await selected.text(), selected.name);
      if (version !== readVersion.current) return;
      setFile(decoded); setFilename(selected.name);
      if (decoded.format === "csv") {
        const metadata: Record<string, any> = { ...defaults, name: selected.name, ...decoded.metadata };
        setCsvMetadata(metadata); setUnit(metadata.channels?.[0]?.unit || "原始单位未注明");
      }
    } catch (e) { if (version === readVersion.current) setError((e as Error).message); }
  }
  async function process(current: ImportView) {
    stop.current = false; setStopping(false); setItemErrors({});
    let uncertain = false;
    try {
      for (const item of current.items) {
        if (stop.current) break;
        if (item.state !== "pending") continue;
        setActiveIndex(item.index);
        try { current = await api<ImportView>(`imports/${current.id}/item`, "POST", { index: item.index }); setJob(current); }
        catch (e) { uncertain = true; const message = (e as Error).message; setItemErrors({ [item.index]: message }); setError(`${message}；已停止后续请求。再次继续会核验服务器状态，不重复创建成功条目。`); break; }
      }
      notify(`${uncertain ? "部分请求待核验；已确认" : "导入记录："}成功 ${current.completed} 项，校验失败 ${current.invalid} 项，待处理/核验 ${current.pending} 项`);
    } finally {
      setActiveIndex(null); setBusy(false); setStopping(false); await loadJobs();
      try { await refresh(); } catch { notify("导入进度已保留，任务列表刷新失败，请稍后刷新"); }
    }
  }
  async function create() {
    if (!preview?.pending) return;
    setBusy(true); setError("");
    try {
      pendingCreate.current ||= normalizeImportRequest({ id: crypto.randomUUID(), filename, records });
      const created = await api<ImportView>("imports", "POST", pendingCreate.current); pendingCreate.current = null;
      setJob(created); setMode("history"); await process(created);
    } catch (e) { setError(`${(e as Error).message}；如未收到创建确认，可原样重试，或从“导入记录”核对已保存批次。`); setBusy(false); }
  }
  async function resume() {
    if (!job) return; setBusy(true); setError("");
    try { const fresh = await api<ImportView>(`imports/${job.id}`); setJob(fresh); await process(fresh); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  function close() { if (busy) { stop.current = true; setStopping(true); } else onClose(); }
  const display = mode === "new" ? preview : job;
  return <Dialog title="任务文件导入" wide onClose={close}>
    <p className="note-box">仅新建任务，不按文件中的 ID 覆盖已有记录，不继承账号或回传来源。有效项可以导入，校验失败项保留明细；关闭或重启后可从“导入记录”继续。重新选择文件并确认会建立新批次，重试已有批次请使用“继续导入”。</p>
    <Tabs items={[{ id: "new", name: "新文件" }, { id: "history", name: "导入记录" }]} value={mode} onChange={(next) => { if (!busy) { setMode(next); setError(""); } }} />
    {error && <p role="alert" className="error">{error}</p>}
    {mode === "new" ? <>
      <input ref={input} type="file" accept=".json,.csv" aria-label="导入任务文件" hidden onChange={(event) => { const chosen = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (chosen) void readFile(chosen); }} />
      <div className="toolbar space-top"><Button disabled={busy || !canWrite} onClick={() => input.current?.click()}>选择 JSON / CSV 文件</Button><strong>{filename || "尚未选择文件"}</strong><span className="muted">最多 50 条任务 / 20000 点每任务 / 1.5 MB</span></div>
      {file?.format === "csv" && <fieldset className="import-csv-fields" disabled={busy || !canWrite}><legend>确认 CSV 元信息（时间列需与采样率一致）</legend>
        {[...["name", "object", "turbine", "point"].map((key, index) => ({ key, label: ["任务名", "测试对象", "风机编号", "测点"][index], numeric: false })), ...["sampleRate", "rpm", "blades"].map((key, index) => ({ key, label: ["采样率 Hz", "转速 rpm", "叶片数"][index], numeric: true }))].map(({ key, label, numeric }) => <label className="form-field" key={key}><span>{label}</span><input type={numeric ? "number" : "text"} value={csvMetadata[key] ?? ""} onChange={(e) => { pendingCreate.current = null; setCsvMetadata({ ...csvMetadata, [key]: numeric ? Number(e.target.value) : e.target.value }); }} /></label>)}
        <label className="form-field"><span>幅值单位</span><input maxLength={30} value={unit} onChange={(e) => { pendingCreate.current = null; setUnit(e.target.value); }} /></label>
      </fieldset>}
      {previewError && <p role="alert" className="error">{previewError}</p>}
    </> : <div className="toolbar space-top"><Select label="导入批次" value={job?.id || ""} disabled={busy} options={[{ value: "", label: "请选择导入批次" }, ...jobs.map((job) => ({ value: job.id, label: `${job.filename} · 成功 ${job.completed}/${job.total} · ${new Date(job.createdAt).toLocaleString("zh-CN")}` }))]} onChange={async (id) => { if (!id) { setJob(null); return; } setBusy(true); try { setJob(await api<ImportView>("imports/" + id)); setItemErrors({}); setError(""); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }} /><Button disabled={busy} onClick={loadJobs}>刷新导入记录</Button></div>}
    {display ? <>
      <div className="toolbar space-top"><Tag tone="green">成功 {display.completed}</Tag><Tag tone="red">校验失败 {display.invalid}</Tag><Tag tone="amber">待处理 {display.pending}</Tag><span>共 {display.total} 项</span></div>
      <p className="muted">有效项导入进度{mode === "history" && display.pending === 0 ? "：有效项已处理，校验失败项需修正后另行导入。" : ""}</p>
      <Progress value={display.total > display.invalid ? display.completed / (display.total - display.invalid) * 100 : 0} />
      <div className="import-result-table"><Table headers={["序号", "任务 / 对象 / 测点", "波形与单位", "状态", "说明 / 结果引用"]}>{display.items.map((item) => <tr key={item.index}><td>{item.index + 1}</td><td><strong>{item.name}</strong><small>{item.object} / {item.point}</small></td><td>{item.sampleCount} 点 · {item.sampleRate ?? "—"} Hz<small>{item.duration ?? "—"} s · {item.unit}</small></td><td><Tag tone={item.state === "completed" ? "green" : item.state === "invalid" ? "red" : "gray"}>{activeIndex === item.index && busy ? "正在导入" : itemErrors[item.index] ? "状态待核验" : item.state === "completed" ? "已导入" : item.state === "invalid" ? "校验失败" : "待导入"}</Tag></td><td>{item.error && <p className="error">{item.error}</p>}{itemErrors[item.index] && <p className="error">{itemErrors[item.index]}</p>}{item.warnings.map((warning) => <p key={warning}>{warning}</p>)}{item.taskId && <small className="mono">任务 ID：{item.taskId}</small>}</td></tr>)}</Table></div>
    </> : <Empty text={mode === "new" ? "选择文件后显示逐项校验结果" : "选择导入批次查看或继续"} />}
    <div className="dialog-actions">
      {stopping && <span role="status">等待当前请求确认后停止，不撤销已成功项。</span>}
      {mode === "history" && job && <Button disabled={busy || !job.pending && !job.invalid} onClick={async () => { try { const pending = await api<unknown[]>(`imports/${job.id}/pending`); const saved = await saveDataFile({ bytes: new TextEncoder().encode(JSON.stringify(pending, null, 2)), mime: "application/json", extension: "json" }, "BladeVMS-unimported"); notify(saved ? "已导出未导入项，请修正后新建批次；不包含成功项" : "已取消导出"); } catch (e) { setError((e as Error).message); } }}>导出未导入项 JSON</Button>}
      {busy ? <Button onClick={close} disabled={stopping}>停止后续导入</Button> : <><Button onClick={onClose}>关闭</Button>{mode === "new" ? <Button variant="primary" disabled={!canWrite || !preview?.pending || !!previewError} onClick={create}>确认导入有效项 ({preview?.pending || 0})</Button> : <Button variant="primary" disabled={!canWrite || !job?.pending} onClick={resume}>继续导入 / 重试未完成项</Button>}</>}
    </div>
  </Dialog>;
}
