"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowRight, ChevronRight, ClipboardCheck, RefreshCw, Settings2, Wind } from "lucide-react";
import { api, type Item } from "./api";
import { Button, Card, Dialog, EditDialog, Select, Table, Tag, type ContextProps } from "./common";
import { Chart, lineOption } from "./charts";
import { ChartLoading } from "./chart-loading";
import type { CaptureSummary } from "./capture-types";
import { comparableHealthRecord, validateHealthAmplitudeRules, healthMeasurementState, healthPassMeasurement, healthRecords, healthTaskMeasurement, latestHealthRecords,
  type HealthAmplitudeConfig, type HealthMeasurement, type HealthRecord } from "./health-workspace-data";
import { bladePassWaveSeries, type BladePassResult } from "./web-blade-passes-data";

const number = (v: number | undefined, digits = 3) => v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const date = (v: number) => v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "测量时间未记录";
const pointLabel = (r: HealthRecord) => `${r.point || "测点未注明"}${r.angle == null ? "" : ` · ${number(r.angle)}°`}`;

export function Health({ data, refresh, notify, canWrite, go }: ContextProps) {
  const [captures, setCaptures] = useState<CaptureSummary[]>([]), [imports, setImports] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true), [errors, setErrors] = useState<string[]>([]), [revision, setRevision] = useState(0);
  const [config, setConfig] = useState<HealthAmplitudeConfig>(), [editRules, setEditRules] = useState(false);
  const [turbineKey, setTurbineKey] = useState(""), [taskKey, setTaskKey] = useState("");
  const [selected, setSelected] = useState<string | null>(null), [comparison, setComparison] = useState("");
  const [metrics, setMetrics] = useState<Record<string, HealthMeasurement>>({}), [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState("");
  const [review, setReview] = useState<Item | null>(null);
  const [mark, setMark] = useState<HealthRecord | null>(null);
  const ticket = useRef(0);
  useEffect(() => {
    let active = true; setLoading(true); setErrors([]); setBusy(false); setProgress(""); setMetrics({}); setAnalysisErrors({});
    void Promise.allSettled([
      api<{ captures: CaptureSummary[] }>("captures"), api<{ recordings: Item[] }>("rotation/recordings"), api<HealthAmplitudeConfig>("health/amplitude-thresholds"),
    ]).then(([a, b, c]) => {
      if (!active) return;
      setCaptures(a.status === "fulfilled" ? a.value.captures : []);
      setImports(b.status === "fulfilled" ? b.value.recordings : []);
      setConfig(c.status === "fulfilled" ? c.value : undefined);
      setErrors([a, b, c].flatMap((r, i) => r.status === "rejected" ? [`${["上传记录", "导入记录", "预警规则"][i]}读取失败：${r.reason?.message || "请重试"}`] : []));
      setLoading(false);
    });
    return () => { active = false; ticket.current++; };
  }, [revision, data.user.id]);
  const records = useMemo(() => healthRecords(data.tasks, captures, imports, data.user.tenant), [data.tasks, captures, imports, data.user.tenant]);
  const turbines = useMemo(() => [...new Map(records.map(r => [r.turbineKey, r])).values()], [records]);
  const turbine = turbines.find(r => r.turbineKey === turbineKey) || turbines[0];
  const turbineRecords = records.filter(r => r.turbineKey === turbine?.turbineKey);
  const tasks = [...new Map([...turbineRecords].reverse().map(r => [r.taskKey, r])).values()].sort((a, b) => b.timestamp - a.timestamp);
  const task = tasks.find(r => r.taskKey === taskKey) || tasks[0];
  const current = latestHealthRecords(turbineRecords.filter(r => r.taskKey === task?.taskKey));
  const chosen = records.find(r => r.key === selected);
  const measurement = useCallback((r: HealthRecord) => metrics[r.key] || healthTaskMeasurement(r), [metrics]);
  const settings = useCallback((r: HealthRecord) => r.tenant === config?.tenant ? config.values : null, [config]);
  const state = (r: HealthRecord) => healthMeasurementState(r, measurement(r), settings(r));
  const states = current.map(state), analyzed = current.filter(r => measurement(r) && !r.quality).length;
  const grades = states.flatMap(s => s.grade == null ? [] : [s.grade]);
  const highest = grades.length ? Math.max(...grades) : null;
  const overall = highest == null ? "待评估" : highest > 0 ? ["", "注意", "预警", "报警"][highest] : "已分析幅值未超限";
  const relatedTaskIds = new Set(current.filter(r => r.kind === "task").map(r => r.id));
  const alerts = (data.alerts as Item[]).filter(a => a.source !== "demo" && a.source !== "simulation" && relatedTaskIds.has(a.taskId));
  const abnormal = current.filter(r => (state(r).grade ?? 0) > 0);
  const blades = [...new Set(current.map(r => r.blade))].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const history = chosen ? turbineRecords.filter(r => r.timestamp > 0 && r.timestamp < chosen.timestamp && comparableHealthRecord(chosen, r)).sort((a, b) => a.timestamp - b.timestamp) : [];
  const compared = history.find(r => r.key === comparison);
  const observations = (data.analyses as Item[]).filter(a => a.type === "health-observation" && current.some(r => a.recordTenant === r.tenant && a.parameters?.reference?.kind === r.kind && a.parameters?.reference?.id === r.id && (r.kind !== "import" || a.parameters?.importOwnerId === data.user.id)));
  const pointObservations = chosen ? (data.analyses as Item[]).filter(a => a.type === "health-observation" && a.recordTenant === chosen.tenant && a.parameters?.reference?.kind === chosen.kind && a.parameters?.reference?.id === chosen.id && (chosen.kind !== "import" || a.parameters?.importOwnerId === data.user.id)) : [];
  const activeMetric = chosen ? measurement(chosen) : null;
  const compareMetric = compared ? measurement(compared) : null;
  function changeSelection(kind: "turbine" | "task", key: string) {
    if (kind === "turbine") { setTurbineKey(key); setTaskKey(""); } else setTaskKey(key);
    setSelected(null); setComparison("");
  }
  async function analyze(targets: HealthRecord[]) {
    if (busy || !canWrite) return;
    const batch = targets.filter(r => !r.quality && r.kind !== "task" && !metrics[r.key]);
    if (!batch.length) return;
    const run = ++ticket.current; setBusy(true);
    try {
      // One native record at a time keeps task/leaf boundaries and memory bounded.
      for (const [index, r] of batch.entries()) {
        if (ticket.current !== run) return;
        setProgress(`正在分析 ${index + 1}/${batch.length} · ${pointLabel(r)}`);
        try {
          let id = r.analysisId || r.id;
          if (r.kind === "capture" && !r.analysisId) id = (await api<{ recording: { id: string } }>(`captures/${encodeURIComponent(r.id)}/prepare-analysis`, "POST", {})).recording.id;
          if (ticket.current !== run) return;
          const result = await api<BladePassResult>("rotation/blade-passes", "POST", { recordingIds: [id], detrend: "constant" });
          const value = result.hasSimulation ? null : healthPassMeasurement(result.sources[0]);
          if (ticket.current !== run) return;
          if (!value) throw Error("没有可用于健康分析的有效叶片片段，请核对经过边界与信号质量。");
          setMetrics(previous => ({ ...previous, [r.key]: value }));
          setAnalysisErrors(previous => { const next = { ...previous }; delete next[r.key]; return next; });
        } catch (cause) {
          if (ticket.current !== run) return;
          setAnalysisErrors(previous => ({ ...previous, [r.key]: cause instanceof Error ? cause.message : "分析失败" }));
        }
      }
    } finally { if (ticket.current === run) { setBusy(false); setProgress(""); } }
  }
  const runnable = current.filter(r => !r.quality && r.kind !== "task" && !metrics[r.key]);
  return <div className="health-workspace" data-testid="health-workspace">
    <header className="health-page-heading"><div><h1><Wind size={25} />健康监测</h1><p>按风机查看测量结果、叶片异常与历史变化</p></div><div className="toolbar"><Button variant="ghost" disabled={loading || busy} onClick={() => { void refresh().catch(e => notify(e.message)); setRevision(v => v + 1); }}><RefreshCw size={15} />刷新</Button><Button disabled={!config || data.user.role !== "admin"} onClick={() => setEditRules(true)}><Settings2 size={15} />预警规则</Button></div></header>
    {errors.length > 0 && <div className="health-load-error" role="alert">{errors.map(e => <p key={e}>{e}</p>)}</div>}
    <Card className="health-selector"><Select label="风机" value={turbine?.turbineKey || ""} disabled={loading || !turbines.length} options={turbines.map(r => ({ value: r.turbineKey, label: `${r.windFarm ? r.windFarm + " / " : ""}${r.turbine || "风机未注明"}${r.tenant !== data.user.tenant ? " · " + r.tenant : ""}` }))} onChange={key => changeSelection("turbine", key)} /><Select label="测量任务 / 时间" value={task?.taskKey || ""} disabled={loading || !tasks.length} options={tasks.map(r => ({ value: r.taskKey, label: `${r.taskName} · ${date(r.timestamp)}` }))} onChange={key => changeSelection("task", key)} /><Button variant="primary" disabled={busy || loading || !canWrite || !runnable.length} onClick={() => void analyze(current)}><Activity size={16} />{busy ? "分析中…" : "分析本次测量"}</Button></Card>
    {loading ? <ChartLoading label="正在读取风机与测量记录…" /> : !records.length ? <section className="health-empty-state"><div className="health-empty-icon"><Wind size={42} /></div><h2>当前 Web 尚无真实测量记录</h2><p>桌面本机记录需上传至当前 Web，或在旋转测振中导入数据，才会显示在这里。</p><Button variant="primary" onClick={() => go("blade")}>前往旋转测振 <ArrowRight size={16} /></Button><div className="health-empty-steps"><span>01 · 上传或导入</span><ChevronRight size={16} /><span>02 · 选择风机</span><ChevronRight size={16} /><span>03 · 分析与复核</span></div></section> : <>
      <div className="health-overview"><Card><span>本次评估</span><strong className={highest && highest > 0 ? "orange-text" : ""}>{overall}</strong><small>基于已分析幅值；模态与损伤尚未评估</small></Card><Card><span>已分析 / 已同步记录</span><strong>{analyzed}<small> / {current.length}</small></strong><small>按各测点最新圆周位置记录统计</small></Card><Card><span>幅值异常</span><strong>{abnormal.length}</strong><small>异常记录可查看具体判据</small></Card><Card><span>数据待核查</span><strong>{current.filter(r => r.quality).length}</strong><small>未完成、诊断测试或信息不足</small></Card></div>
      {busy && <p className="health-analysis-progress" role="status">{progress}</p>}
    {current.some(r => analysisErrors[r.key]) && <div className="health-load-error" role="alert">{current.filter(r => analysisErrors[r.key]).map(r => <p key={r.key}>{pointLabel(r)}：{analysisErrors[r.key]}</p>)}</div>}
      <Card title="叶片与测点" tools={<span className="muted">点击测点查看圆周位置与分析依据</span>} className="health-blades">
        {blades.map(blade => {
          const rows = current.filter(r => r.blade === blade).sort((a, b) => (a.radius ?? Infinity) - (b.radius ?? Infinity) || a.point.localeCompare(b.point, "zh-CN", { numeric: true })), points = [...new Set(rows.map(r => r.pointId || r.key))];
          return <div className="health-blade-row" key={blade || "unknown"}><div className="health-blade-name"><Wind size={20} /><strong>{blade ? `叶片 ${blade}` : "叶片未注明"}</strong><small>{points.length} 个已同步测点</small></div><div className="health-point-grid">{points.map(point => {
            const entries = rows.filter(r => (r.pointId || r.key) === point).sort((a, b) => (a.angle ?? 0) - (b.angle ?? 0));
            const worst = [...entries].sort((a, b) => (state(b).grade ?? -1) - (state(a).grade ?? -1))[0];
            const n = entries.filter(r => measurement(r) && !r.quality).length, s = state(worst);
            const label = n === 0 ? entries.some(r => !r.quality) ? "待分析" : "数据待核查" : s.grade != null && s.grade > 0 ? s.label : n < entries.length ? "部分已分析" : "已分析";
            return <button key={point} type="button" className={`health-point ${s.tone}`} onClick={() => { setSelected(entries[0].key); setComparison(""); }} aria-label={`查看叶片 ${blade || "未注明"} ${entries[0].point || "测点未注明"}`}><div><strong>{entries[0].point || "测点未注明"}</strong><span className={`health-point-dot ${s.tone}`} /></div><span>{entries[0].radius == null ? "半径未记录" : `距中心 ${number(entries[0].radius)} m`}</span><div><small>{entries.length} 个圆周位置</small><b>{label}</b></div></button>;
          })}</div></div>;
        })}
        <p className="health-footnote">这里只统计已同步的测点，不将未测数据视为正常。诊断测试记录保留查看，不参与健康判定。</p>
      </Card>
      <Card title="异常与待复核" tools={<Tag tone={abnormal.length || alerts.length || observations.length ? "amber" : "gray"}>{abnormal.length + alerts.length + observations.length} 条</Tag>}>
        {abnormal.length + alerts.length + observations.length === 0 ? <div className="health-quiet"><ClipboardCheck size={22} /><span>{analyzed ? grades.length ? "已分析数据暂无已配置幅值阈值异常；未分析项尚不能判定。" : "已有测量指标，尚未配置幅值阈值，不判定是否超限。" : "暂无分析结论，完成分析后在此查看异常依据。"}</span></div> : <Table headers={["位置 / 记录", "判据", "状态", "操作"]}>{abnormal.map(r => <tr key={r.key}><td>叶片 {r.blade || "—"} · {pointLabel(r)}</td><td>RMS {number(measurement(r)?.rms)} mm/s · 峰值 {number(measurement(r)?.peak)} mm/s</td><td><Tag tone={state(r).tone}>{state(r).label}</Tag></td><td><Button onClick={() => setSelected(r.key)}>查看依据</Button></td></tr>)}{observations.map(a => <tr key={a.id}><td>{a.name}</td><td>{a.result.note}</td><td><Tag tone="amber">{a.result.level} · {a.result.status}</Tag></td><td><Button onClick={() => setSelected(`${a.parameters.reference.kind}:${a.parameters.reference.id}`)}>查看记录</Button></td></tr>)}{alerts.map(a => <tr key={a.id}><td>{a.name}</td><td>{a.metric} · {a.value} / {a.threshold}</td><td><Tag tone="amber">{a.level} · {a.status}</Tag></td><td><Button disabled={!canWrite} onClick={() => setReview(a)}>人工复核</Button></td></tr>)}</Table>}
      </Card>
      <details className="health-history"><summary>历史测量记录 <span>{tasks.length} 次任务</span></summary><Table headers={["测量任务", "最近测量时间", "已同步记录", "操作"]}>{tasks.map(t => <tr key={t.taskKey}><td>{t.taskName}</td><td>{date(t.timestamp)}</td><td>{turbineRecords.filter(r => r.taskKey === t.taskKey).length}</td><td><Button onClick={() => changeSelection("task", t.taskKey)}>查看本次</Button></td></tr>)}</Table><p className="health-footnote">进入测点详情，可比较相同测点、半径、圆周角度及转速的历史记录。</p></details>
    </>}
    {chosen && <Dialog wide title={`叶片 ${chosen.blade || "未注明"} · ${chosen.point || "测点未注明"}`} onClose={() => { setSelected(null); setComparison(""); }}>
      <div className="health-detail-context"><span>{chosen.turbine || "风机未注明"} · {chosen.taskName}</span><span>{date(chosen.timestamp)}</span><Tag tone={state(chosen).tone}>{state(chosen).label}</Tag></div>
      <div className="health-detail-toolbar"><Select label="圆周位置 / 记录" value={chosen.key} options={records.filter(r => r.taskKey === chosen.taskKey && r.blade === chosen.blade && r.pointId === chosen.pointId).map(r => ({ value: r.key, label: `${pointLabel(r)} · ${date(r.timestamp)}` }))} onChange={key => { setSelected(key); setComparison(""); }} /><Button variant="primary" disabled={busy || !canWrite || !!chosen.quality || !!activeMetric || chosen.kind === "task"} onClick={() => void analyze([chosen])}>{busy ? "分析中…" : "分析此记录"}</Button></div>
      {chosen.quality && <p className="health-load-error">{chosen.quality}，本条不参与健康结论。</p>}
      {analysisErrors[chosen.key] && <p className="health-load-error" role="alert">{analysisErrors[chosen.key]}</p>}
      {busy && <ChartLoading label={progress} />}
      <div className="health-detail-values">{[["速度 RMS", activeMetric?.rms, "mm/s"], ["速度峰值", activeMetric?.peak, "mm/s"], ["速度峰峰值", activeMetric?.peakToPeak, "mm/s"], ["信号主频", activeMetric?.frequency, "Hz"]].map(([label, value, unit]) => <div key={String(label)}><span>{label}</span><strong>{number(value as number | undefined)} <small>{unit}</small></strong></div>)}</div>
      {activeMetric && <p className="health-footnote">{activeMetric.note} · 有效时长 {number(activeMetric.seconds)} s</p>}
      {activeMetric?.source ? <><Chart label="叶片有效段速度波形" height={240} option={{ animation: false, tooltip: { trigger: "axis" }, grid: { left: 60, right: 22, bottom: 50 }, xAxis: { type: "value", name: "s" }, yAxis: { type: "value", name: "mm/s" }, dataZoom: [{ type: "inside" }, { type: "slider", height: 16 }], series: bladePassWaveSeries(activeMetric.source) }} />{activeMetric.source.segments.some(s => s.spectrum) && <Chart label="连续有效段频谱" height={220} option={{ animation: false, tooltip: { trigger: "axis" }, grid: { left: 60, right: 22, bottom: 40 }, xAxis: { type: "value", name: "Hz" }, yAxis: { type: "value", name: "mm/s" }, series: activeMetric.source.segments.filter(s => s.spectrum).map((s, i) => ({ name: `有效段 ${i + 1}`, type: "line", showSymbol: false, data: s.spectrum!.frequencies.map((f, j) => [f, s.spectrum!.amplitudes[j] * 1000]) })) }} />}</> : <div className="health-detail-empty">{chosen.kind === "task" ? "本条未包含可用于叶片频谱分析的有效段结果。" : "分析此记录后显示真实有效波形与频谱。"}</div>}
      <div className="health-review-heading"><strong>异常标记与人工复核</strong><Button disabled={!canWrite} onClick={() => setMark(chosen)}>标记 / 复核</Button></div>
      {pointObservations.length > 0 && <Table headers={["范围", "级别 / 状态", "说明", "复核人 / 时间"]}>{pointObservations.map(a => <tr key={a.id}><td>{a.result.range ? `${number(a.result.range.startSeconds)}～${number(a.result.range.endSeconds)} s` : "整条记录"}</td><td>{a.result.level} · {a.result.status}</td><td>{a.result.note}</td><td>{a.result.reviewer} · {new Date(a.result.reviewedAt).toLocaleString("zh-CN")}</td></tr>)}</Table>}
      <div className="health-pending-analysis"><div><strong>模态参数</strong><Tag tone="gray">未分析</Tag><p>暂无经过验证的模态识别结果。</p></div><div><strong>专项损伤检测</strong><Tag tone="gray">未接入</Tag><p>幅值超限仅提示异常，不直接判定裂纹或损伤位置。</p></div></div>
      <details className="health-history"><summary>历史测量对比 <span>{history.length} 条同条件记录</span></summary>{history.length ? <><Select label="对比记录" value={comparison} options={[{ value: "", label: "请选择历史测量" }, ...history.map(r => ({ value: r.key, label: `${r.taskName} · ${date(r.timestamp)}` }))]} onChange={setComparison} />{compared && <><Button disabled={busy || !canWrite || !!compareMetric || compared.kind === "task"} onClick={() => void analyze([compared])}>分析对比记录</Button><Table headers={["指标", "对比记录", "当前记录", "变化"]}>{(["rms", "peak", "peakToPeak"] as const).map((key, i) => <tr key={key}><td>{["速度 RMS", "速度峰值", "速度峰峰值"][i]} · mm/s</td><td>{number(compareMetric?.[key])}</td><td>{number(activeMetric?.[key])}</td><td>{compareMetric && activeMetric && compareMetric[key] !== 0 ? `${number((activeMetric[key] / compareMetric[key] - 1) * 100, 1)}%` : "—"}</td></tr>)}</Table></>}
        {history.filter(r => measurement(r)).length + (activeMetric ? 1 : 0) >= 2 && <Chart label="真实测量速度 RMS 历史" height={220} option={lineOption([{ name: "速度 RMS · mm/s", color: "#2d6cc0", data: [...history, chosen].sort((a, b) => a.timestamp - b.timestamp).filter(r => measurement(r)).map(r => measurement(r)!.rms) }], [...history, chosen].sort((a, b) => a.timestamp - b.timestamp).filter(r => measurement(r)).map(r => date(r.timestamp)))} />}</> : <p className="health-footnote">暂无同测点、半径、圆周角度及转速的历史记录，不生成趋势。</p>}</details>
      <div className="dialog-actions"><Button onClick={() => setSelected(null)}>关闭</Button></div>
    </Dialog>}
    {mark && <EditDialog title={`标记 / 复核 · ${pointLabel(mark)}`} initial={{ level: "注意", status: "待复核", note: "", startSeconds: "", endSeconds: "" }} fields={[
      { key: "level", label: "人工判定级别", type: "select", options: ["注意", "预警", "报警"] },
      { key: "status", label: "复核状态", type: "select", options: ["待复核", "已确认", "已关闭"] },
      { key: "startSeconds", label: "区间起点 · s（留空标记整条记录）", type: "number", min: 0, emptyAsUndefined: true },
      { key: "endSeconds", label: "区间终点 · s", type: "number", min: 0, emptyAsUndefined: true },
      { key: "note", label: "异常说明 / 复核意见", type: "textarea", required: true },
    ]} onClose={() => setMark(null)} onSave={async values => { await api("health/observations", "POST", { ...values, reference: { kind: mark.kind, id: mark.id } }); await refresh(); notify("标记已保存，原始波形未修改"); }} />}
    {review && <EditDialog title="人工复核" initial={{ status: review.status, reviewNote: review.reviewNote || "" }} fields={[{ key: "status", label: "复核状态", type: "select", options: ["待复核", "已确认", "已关闭"] }, { key: "reviewNote", label: "复核意见", type: "textarea", required: true }]} onClose={() => setReview(null)} onSave={async values => { await api(`records/alerts/${review.id}`, "PUT", { ...review, ...values }); await refresh(); notify("复核结果已保存"); }} />}
    {editRules && <EditDialog title="预警规则 · 当前课题组" initial={config?.values || { rms: "", attentionRatio: .6, warningRatio: .8 }} fields={[
      { key: "rms", label: "速度 RMS 报警阈值 · mm/s", type: "number", min: .000001, emptyAsUndefined: true },
      { key: "peak", label: "速度峰值报警阈值 · mm/s（可留空）", type: "number", min: .000001, emptyAsUndefined: true },
      { key: "peakToPeak", label: "速度峰峰值报警阈值 · mm/s（可留空）", type: "number", min: .000001, emptyAsUndefined: true },
      { key: "attentionRatio", label: "注意 / 报警阈值比例", type: "number", min: .001, max: .999, required: true },
      { key: "warningRatio", label: "预警 / 报警阈值比例", type: "number", min: .001, max: .999, required: true },
    ]} onClose={() => setEditRules(false)} onSave={async values => {
      const normalized = { ...values }; for (const key of ["rms", "peak", "peakToPeak"]) if (normalized[key] === "") delete normalized[key];
      setConfig(await api<HealthAmplitudeConfig>("health/amplitude-thresholds", "PUT", { revision: config?.revision, values: validateHealthAmplitudeRules(normalized) })); notify("预警规则已保存");
    }} />}
  </div>;
}
