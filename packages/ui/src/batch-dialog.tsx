"use client";
import { useEffect, useRef, useState } from "react";
import { api, download, type Item } from "./api";
import { Button, Dialog, Empty, Progress, Select, Table, Tabs, Tag } from "./common";
import { Chart, lineOption } from "./charts";
import { ResultExport } from "./result-export";
import { batchFeatures, batchFilterMethods, batchStepNames, batchSteps, defaultBatchConfig, normalizeBatchRequest, type BatchConfig, type BatchStepKey, type BatchView } from "./batch";

export function BatchResultDialog({ result, onClose, notify }: { result: Item; onClose: () => void; notify: (message: string) => void }) {
  const rows: (string | number)[][] = result.result?.rows || [], columns: string[] = result.result?.columns || [];
  return <Dialog title="批处理结果（演示）" wide onClose={onClose}>
    <p><strong>{result.name}</strong></p>
    <p className="note-box">{result.result?.note || "算法接口未接入"}</p>
    <div className="toolbar"><Tag tone="amber">算法未接入 / 不用于工程判断</Tag><span>输入 {result.parameters?.inputSampleCount ?? "—"} 点 · 实际参与 {result.result?.inputCount ?? "—"} 点</span>
      <ResultExport path={`export/analyses/${result.id}`} notify={notify} />
      <Button className="push" onClick={async () => { try { if (await download(`export/analyses/${result.id}?format=json`)) notify("结果、参数及输入元信息已导出"); } catch (e) { notify((e as Error).message); } }}>导出结果 JSON</Button></div>
    {rows.length > 0 && <Chart label="批处理结果预览（算法为演示）" option={lineOption([{ name: columns[1] || "演示值", data: rows.map((row) => Number(row[1])) }], rows.map((row) => String(row[0])))} height={220} />}
    <div className="batch-result-table"><Table headers={columns}>{rows.slice(0, 100).map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j} className="mono">{typeof value === "number" ? Number(value.toPrecision(8)) : value}</td>)}</tr>)}</Table></div>
    <p className="muted">预览前 {Math.min(100, rows.length)} / {rows.length} 行。数值导出支持 CSV / TXT / Excel / MAT / JSON，含完整结果、配置、采样范围及输入元信息。</p>
    <div className="dialog-actions"><Button onClick={onClose}>返回批次</Button></div>
  </Dialog>;
}

export function BatchDialog({ tasks, initialIds, initialMode = "new", canWrite, onClose, refresh, notify }: {
  tasks: Item[]; initialIds: string[]; initialMode?: "new" | "history"; canWrite: boolean;
  onClose: () => void; refresh: () => Promise<void>; notify: (message: string) => void;
}) {
  const [mode, setMode] = useState<string>(initialMode), [name, setName] = useState("批处理 " + new Date().toLocaleDateString("zh-CN"));
  const [ids, setIds] = useState(initialIds.filter((id) => tasks.some((task) => task.id === id)));
  const [config, setConfig] = useState<BatchConfig>(structuredClone(defaultBatchConfig));
  const [jobs, setJobs] = useState<BatchView[]>([]), [job, setJob] = useState<BatchView | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [active, setActive] = useState(""), [result, setResult] = useState<Item | null>(null);
  const stop = useRef(false), pendingCreate = useRef<ReturnType<typeof normalizeBatchRequest> | null>(null);
  async function loadJobs() { setLoading(true); try { setJobs(await api<BatchView[]>("batches")); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }
  useEffect(() => { void loadJobs(); }, []);
  const editConfig = (key: BatchStepKey, field: string, value: unknown) => { pendingCreate.current = null; setConfig((old) => ({ ...old, [key]: { ...old[key], [field]: value } })); };
  async function create() {
    setBusy(true); setError("");
    try {
      pendingCreate.current ||= normalizeBatchRequest({ id: crypto.randomUUID(), name, taskIds: ids, config });
      const next = await api<BatchView>("batches", "POST", pendingCreate.current);
      pendingCreate.current = null; setJob(next); setMode("history"); await loadJobs();
      notify("批次及输入快照已保存，点击继续批次执行演示流程");
    } catch (e) { setError((e as Error).message + "；如未收到服务器确认，可原样重试创建。"); }
    finally { setBusy(false); }
  }
  async function open(id: string) { setLoading(true); setError(""); try { setJob(await api<BatchView>("batches/" + id)); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }
  async function run() {
    if (!job || busy) return;
    setBusy(true); setError(""); stop.current = false;
    let current = job;
    try {
      current = await api<BatchView>(`batches/${job.id}/resume`, "POST", {}); setJob(current);
      outer: for (const item of current.items) {
        for (const step of item.steps) {
          if (stop.current) break outer;
          if (step.state === "completed") continue;
          setActive(`${item.name} · ${batchStepNames[step.key]}：正在保存演示结果…`);
          current = await api<BatchView>(`batches/${job.id}/step`, "POST", { taskId: item.taskId, step: step.key }); setJob(current);
          if (current.items.find((entry) => entry.taskId === item.taskId)?.steps.find((entry) => entry.key === step.key)?.state === "failed") break;
        }
      }
    } catch (e) { setError((e as Error).message + "；已完成步骤保留，重新继续时会核验状态，不重复保存。"); }
    finally {
      if (current.completed < current.total) {
        try { current = await api<BatchView>(`batches/${current.id}/pause`, "POST", {}); setJob(current); }
        catch { setError((old) => old || "暂停请求未收到确认；本窗口已停止发送步骤，可重新打开批次核对已保存进度。"); }
      }
      setActive(current.completed === current.total ? "演示流程完成，所有结果均已保存。" : "已停止后续步骤；成功结果保留，失败项可查看原因后重试。");
      await loadJobs();
      try { await refresh(); } catch { notify("批处理已停止，但工作台刷新失败，请稍后刷新。"); }
      setBusy(false);
    }
  }
  function close() { if (busy) { stop.current = true; setActive("正在等待当前请求返回，随后停止后续步骤。"); } else onClose(); }
  const locked = busy || loading;
  const numberField = (key: BatchStepKey, field: string, label: string, value: number | null) => <label className="form-field"><span>{label}</span><input type="number" step="any" value={value ?? ""} disabled={locked || !config[key].enabled} onChange={(e) => editConfig(key, field, field === "end" && e.target.value === "" ? null : Number(e.target.value))} /></label>;
  return <>
    <Dialog title="历史任务批处理" wide onClose={close}>
      <p className="note-box">批次保留创建时的输入快照，原任务不被覆盖。降噪 / FFT / 特征为演示占位；截取按保存样本处理。关闭、刷新或重启后，可从“批次记录”继续未完成步骤。</p>
      <Tabs items={[{ id: "new", name: "新建批次" }, { id: "history", name: "批次记录" }]} value={mode} onChange={(value) => { if (!locked) { setMode(value); setError(""); } }} />
      {error && <p role="alert" className="error">{error}</p>}
      {mode === "new" ? <>
        <label className="form-field space-top"><span>批次名称</span><input maxLength={120} value={name} disabled={locked || !canWrite} onChange={(e) => { setName(e.target.value); pendingCreate.current = null; }} /></label>
        <div className="batch-task-picker" aria-label="批次任务选择">{tasks.map((task) => <label key={task.id}><input type="checkbox" aria-label={`批处理 ${task.name}`} checked={ids.includes(task.id)} disabled={locked || !canWrite || (!ids.includes(task.id) && ids.length >= 50)} onChange={(e) => { pendingCreate.current = null; setIds(e.target.checked ? [...ids, task.id] : ids.filter((id) => id !== task.id)); }} /><span>{task.name}<small>{task.samples?.length || 0} 点 · {task.sampleRate} Hz</small></span></label>)}</div>
        <div className="batch-config-grid">{batchSteps.map((key) => <fieldset key={key} disabled={locked || !canWrite}>
          <legend><label><input type="checkbox" aria-label={`启用${batchStepNames[key]}`} checked={config[key].enabled} onChange={(e) => editConfig(key, "enabled", e.target.checked)} />{batchStepNames[key]}</label></legend>
          {key === "denoise" && <><Select label="方法" value={config.denoise.method} options={batchFilterMethods} disabled={locked || !config.denoise.enabled} onChange={(v) => editConfig("denoise", "method", v)} /><div className="batch-number-pair">{numberField("denoise", "low", "低截止 Hz", config.denoise.low)}{numberField("denoise", "high", "高截止 Hz", config.denoise.high)}{numberField("denoise", "order", "阶数", config.denoise.order)}{numberField("denoise", "windowLength", "窗长（点）", config.denoise.windowLength)}</div><small>未执行真实滤波，预览保留输入幅值。</small></>}
          {key === "cut" && <>{numberField("cut", "start", "截取起点 s", config.cut.start)}{numberField("cut", "end", "截取终点 s（可留空）", config.cut.end)}<small>区间 [起点,终点)，终点留空取每个任务的数据末尾。</small></>}
          {key === "fft" && <><Select label="FFT 点数" value={config.fft.nfft} options={[256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].map(String)} disabled={locked || !config.fft.enabled} onChange={(v) => editConfig("fft", "nfft", Number(v))} /><Select label="窗函数" value={config.fft.window} options={["Hann", "Hamming", "Blackman", "矩形窗"]} disabled={locked || !config.fft.enabled} onChange={(v) => editConfig("fft", "window", v)} /><small>频谱幅值为固定演示样例。</small></>}
          {key === "features" && <>{batchFeatures.map((feature) => <label className="batch-feature" key={feature}><input type="checkbox" aria-label={`提取${feature}`} checked={config.features.names.includes(feature)} disabled={!config.features.enabled} onChange={(e) => editConfig("features", "names", e.target.checked ? [...config.features.names, feature] : config.features.names.filter((name) => name !== feature))} />{feature}</label>)}<small>特征数值为原型演示值。</small></>}
        </fieldset>)}</div>
        <div className="dialog-actions"><span className="muted">已选 {ids.length} / 50 项 · 每任务最多 20000 点 · 批次输入最多 8 MB</span><Button disabled={locked || !canWrite || !ids.length} variant="primary" onClick={create}>创建批次并保存配置</Button></div>
      </> : <>
        <div className="toolbar space-top"><Select label="批次" value={job?.id || ""} options={[{ value: "", label: "请选择批次" }, ...jobs.map((item) => ({ value: item.id, label: `${item.name}（${item.completed}/${item.total}）` }))]} disabled={locked} onChange={(id) => { if (id) void open(id); }} /><Button disabled={locked} onClick={() => void loadJobs()}>刷新批次记录</Button></div>
        {job ? <>
          <div className="toolbar space-top"><strong>{job.name}</strong><Tag tone={job.status === "completed" ? "green" : "amber"}>{job.status === "completed" ? "演示完成" : job.paused ? "已暂停" : "可继续"}</Tag><span>已完成 {job.completed} / {job.total} 步 · 失败 {job.failed} 步</span></div>
          <Progress value={job.total ? job.completed / job.total * 100 : 0} />
          <div className="batch-progress-table"><Table headers={["输入任务（创建时快照）", ...batchSteps.map((key) => batchStepNames[key])]}>{job.items.map((item) => <tr key={item.taskId}><td><strong>{item.name}</strong><small>{item.sampleCount} 点 · {item.sampleRate} Hz</small></td>{batchSteps.map((key) => {
            const step = item.steps.find((step) => step.key === key);
            return <td key={key}>{!step ? <span className="muted">未启用</span> : <><Tag tone={step.state === "completed" ? "green" : step.state === "failed" ? "red" : "gray"}>{step.state === "completed" ? "演示完成" : step.state === "failed" ? "失败" : "待处理"}</Tag><small>尝试 {step.attempts} 次</small>{step.error && <p className="error">{step.error}</p>}{step.analysisId && <Button disabled={locked} aria-label={`查看${item.name}的${batchStepNames[key]}结果`} onClick={async () => { try { setResult(await api<Item>("records/analyses/" + step.analysisId)); } catch (e) { setError((e as Error).message); } }}>查看结果</Button>}</> }</td>;
          })}</tr>)}</Table></div>
          <details className="space-top"><summary>查看已保存的流程配置</summary><pre className="batch-config-summary">{JSON.stringify(job.config, null, 2)}</pre></details>
          {active && <p role="status">{active}</p>}
          <div className="dialog-actions"><Button disabled={locked || !canWrite} onClick={() => {
            setName(job.name.slice(0, 110) + " · 新批次"); setConfig(structuredClone(job.config));
            setIds(job.items.map((item) => item.taskId).filter((id) => tasks.some((task) => task.id === id)));
            pendingCreate.current = null; setMode("new"); setError(""); setActive("");
          }}>复制配置新建批次</Button><Button disabled={loading} onClick={close}>{busy ? "暂停后续步骤" : "关闭"}</Button><Button variant="primary" disabled={locked || !canWrite || job.completed === job.total} onClick={run}>继续批次 / 重试失败项</Button></div>
        </> : <Empty text={loading ? "正在读取批次…" : "选择一份历史批次，或新建批次开始"} />}
      </>}
    </Dialog>
    {result && <BatchResultDialog result={result} onClose={() => setResult(null)} notify={notify} />}
  </>;
}
