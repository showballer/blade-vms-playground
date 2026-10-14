"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { Archive, ChevronDown, PencilLine } from "lucide-react";
import { api, type Item } from "./api";
import { Button, Card, EditDialog, Empty, Select, Table, Tag, type ContextProps } from "./common";
import { Chart, lineOption } from "./charts";
import { ResultExport, SavedResultDialog } from "./result-export";
import { recordDataset, type ResultDataset } from "./result-data";
import { healthBaselineRevision, healthTrendColumns, healthTrendDataset, healthTrendGroups, trendSeries, type TrendAnnotation } from "./health-trend-data";
import { rotationRevision } from "./rotation-data";
import type { HealthConfig } from "./health-data";

export function HealthTrends({ data, refresh, notify, go, task, baseline, config }: ContextProps & { task?: Item; baseline?: Item; config?: HealthConfig }) {
  const [startDate, setStartDate] = useState(() => new Date(Date.now() + 8 * 3600000 - 29 * 86400000).toISOString().slice(0, 10));
  const [record, setRecord] = useState<Item | null>(null), [all, setAll] = useState(false), [busy, setBusy] = useState(false);
  const [view, setView] = useState("trend"), [details, setDetails] = useState(false);
  const [curveGroup, setCurveGroup] = useState("overview");
  const [archiveControls, setArchiveControls] = useState(false);
  const archivePanelId = useId();
  const [mark, setMark] = useState<{ id: string; target: string } | null>(null), [withdraw, setWithdraw] = useState<TrendAnnotation | null>(null);
  const [playing, setPlaying] = useState(false), [speed, setSpeed] = useState("1"), [cursor, setCursor] = useState(0);
  const writable = ["admin", "analyst"].includes(data.user.role);
  const history = (data.analyses as Item[]).filter(a => a.type === "health-trend" && (all || !task || a.taskId === task.id));
  useEffect(() => { setRecord(null); setView("trend"); setPlaying(false); setCursor(0); }, [task?.id]);
  const preview = useMemo(() => {
    try { if (!task || !baseline || !config) throw Error("选择任务与有效基线并加载阈值后可预览；已有归档仍可打开。"); return { dataset: healthTrendDataset(task, baseline, config, startDate), error: "" }; }
    catch (error) { return { dataset: undefined, error: (error as Error).message }; }
  }, [task, baseline, config, startDate]);
  let dataset: ResultDataset | undefined, error = "";
  try { dataset = record ? recordDataset("analyses", record, view) : preview.dataset; error = record ? "" : preview.error; }
  catch (e) { error = (e as Error).message; }
  const annotations = (record?.result?.annotations || []) as TrendAnnotation[];
  const active = annotations.filter(a => a.status === "active" && a.target === view);
  const count = dataset?.rows.length || 0, waveform = !!record && view === "waveform", rate = Number(dataset?.metadata.task?.sampleRate || 0);
  const position = Math.min(count - 1, Math.max(0, Math.floor(cursor)));
  useEffect(() => { setPlaying(false); setCursor(0); }, [record?.id]);
  useEffect(() => {
    if (!playing || !waveform || !count || !(rate > 0)) return;
    const interval = setInterval(() => setCursor(v => Math.min(count - 1, v + rate * .05 * Number(speed))), 50);
    return () => clearInterval(interval);
  }, [playing, waveform, count, rate, speed]);
  useEffect(() => { if (cursor >= count - 1) setPlaying(false); }, [cursor, count]);
  const option = useMemo(() => {
    if (!dataset) return {};
    const rows = dataset.rows;
    if (waveform) return { animation: false, grid: { left: 55, right: 25, top: 25, bottom: 60 }, tooltip: { trigger: "axis", renderMode: "richText" },
      xAxis: { type: "value", name: "s" }, yAxis: { type: "value", name: dataset.columns[1].unit }, dataZoom: [{ type: "inside" }, { type: "slider", height: 15, bottom: 8 }],
      series: [{ type: "line", name: "归档原始幅值", data: rows, showSymbol: false, lineStyle: { width: 1.4, color: "#2D6CC0" },
        markLine: { symbol: "none", label: { formatter: "回放位置" }, data: [{ xAxis: rows[position]?.[0] }] },
        markPoint: { symbolSize: 9, label: { show: false }, itemStyle: { color: "#E5484D" }, data: active.map(a => ({ coord: rows[a.startIndex] })) },
        markArea: { silent: true, label: { show: false }, itemStyle: { color: "rgba(229,72,77,.16)" }, data: active.map(a => [{ xAxis: rows[a.startIndex][0] }, { xAxis: Number(rows[a.endIndex - 1][0]) + 1 / rate }]) },
      }] };
    const columns = healthTrendColumns(dataset, curveGroup), dateIndex = dataset.columns.findIndex(c => c.key === "date");
    const base = lineOption(columns.map(s => ({ name: s.name, color: s.color, data: rows.map(r => Number(r[s.columnIndex])) })), rows.map(r => String(r[dateIndex])));
    return { ...base, legend: { ...base.legend, type: "scroll" }, tooltip: { trigger: "axis", renderMode: "richText" }, series: base.series.map((s, i) => ({ ...s,
      markLine: i === 0 ? { silent: true, symbol: "none", lineStyle: { color: "#8B95A5", type: "dashed" }, label: { formatter: "变化率零线", position: "insideEndTop" }, data: [{ yAxis: 0 }] } : undefined,
      markPoint: { symbolSize: 10, label: { show: false }, itemStyle: { color: "#E5484D" }, data: active.filter(a => a.series === columns[i].key).map(a => ({ name: "人工标记", coord: [rows[a.startIndex][dateIndex], rows[a.startIndex][columns[i].columnIndex]] })) },
      markArea: { silent: true, label: { show: false }, itemStyle: { color: "rgba(229,72,77,.1)" }, data: active.filter(a => a.series === columns[i].key && a.endIndex - a.startIndex > 1).map(a => [{ xAxis: rows[a.startIndex][dateIndex] }, { xAxis: rows[a.endIndex - 1][dateIndex] }]) },
    })) };
  }, [dataset, waveform, annotations, position, rate, curveGroup]);
  async function openArchive(id: string) {
    setPlaying(false); setBusy(true);
    try { setRecord(id ? await api<Item>("records/analyses/" + encodeURIComponent(id)) : null); setView("trend"); setCursor(0); }
    catch (error) { notify((error as Error).message); } finally { setBusy(false); }
  }
  const sourceControls = <>
    <div className="toolbar trend-source-row">
      <Select label="趋势记录" value={record?.id || ""} disabled={busy} options={[{ value: "", label: "当前演示预览" }, ...history.map(a => ({ value: a.id, label: a.name + " · " + a.result?.dataset?.metadata?.snapshotAt }))]} onChange={openArchive} />
      <label className="inline-field"><input type="checkbox" checked={all} disabled={busy} onChange={e => { setAll(e.target.checked); setRecord(null); setView("trend"); }} />全部可见归档</label>
      <Button disabled={busy} onClick={async () => { setBusy(true); try { await refresh(); if (record) setRecord(await api<Item>("records/analyses/" + encodeURIComponent(record.id))); } catch (e) { notify((e as Error).message); } finally { setBusy(false); } }}>刷新趋势记录</Button>
    </div>
    {!record ? <div className="toolbar trend-preview-row">
      <label className="inline-field"><span>展示起日</span><input aria-label="展示起日" type="date" min="1900-01-01" max="2099-12-02" value={startDate} disabled={busy} onChange={e => setStartDate(e.target.value)} /></label>
      <Button variant="primary" disabled={!writable || busy || !preview.dataset} onClick={async () => {
        setBusy(true);
        try {
          const source = structuredClone(task!), base = structuredClone(baseline!), thresholds = structuredClone(config!);
          const [sourceRevision, baselineRevision] = await Promise.all([rotationRevision(source), healthBaselineRevision(base)]);
          const saved = await api<Item>("health/trends", "POST", { taskId: source.id, baselineId: base.id, startDate, sourceRevision, baselineRevision, configRevision: thresholds.revision });
          setRecord(saved); setView("trend"); await refresh(); notify(saved.result?.datasets?.waveform ? "趋势、来源与原始波形已归档；重复提交保留同一记录及标记" : "趋势与来源已归档；源任务无采样点，未创建波形快照");
        } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
      }}>{busy ? "处理中…" : "归档当前演示趋势"}</Button>
    </div> : <><p className="hint" data-testid="health-trend-snapshot">归档任务：{record.result?.dataset?.metadata?.task?.name} · 基线：{record.result?.dataset?.metadata?.baseline?.name} · 展示起日：{record.parameters?.startDate} · 归档时间：{record.result?.dataset?.metadata?.snapshotAt}</p>
      <div className="toolbar trend-snapshot-controls"><Select label="归档视图" value={view} disabled={busy} options={[{ value: "trend", label: "30 日演示趋势" }, ...(record.result?.datasets?.waveform ? [{ value: "waveform", label: "源任务波形快照" }] : [])]} onChange={v => { setView(v); setPlaying(false); setCursor(0); }} />
        <Button disabled={busy} onClick={() => setDetails(true)}>数据与元信息</Button>
        <Button disabled={!writable || !(data.tasks as Item[]).some(t => t.id === record.taskId)} onClick={() => go("report", { taskId: record.taskId })}>生成关联任务报告</Button>
      </div>{!record.result?.datasets?.waveform && <p className="muted">归档时源任务没有采样点，仅保留趋势，不补造波形。</p>}</>}
  </>;
  const markDisabledReason = !writable ? "当前角色没有人工标记权限" : !record ? "归档当前趋势后可添加人工信号标记" : annotations.length >= 200 ? "已达到 200 条标记上限（含撤回历史）" : undefined;
  const archiveToggle = <Button variant="ghost" className="trend-archive-toggle" aria-expanded={archiveControls} aria-controls={archivePanelId} onClick={() => setArchiveControls(!archiveControls)}><Archive size={15} aria-hidden="true" />{archiveControls ? "收起归档设置" : "归档设置与历史"}<ChevronDown size={14} className={archiveControls ? "is-open" : ""} aria-hidden="true" /></Button>;
  return <Card title="趋势跟踪与归档" className="health-trends" tools={<div className="trend-heading-tools"><Tag tone={waveform ? "blue" : "amber"}>{waveform ? "归档原始波形" : record ? "演示趋势 · 已归档" : "演示趋势 · 未归档"}</Tag>{archiveToggle}</div>}>
    {dataset && <div className="trend-chart-toolbar">
      <div className="trend-view-controls">{!waveform ? <Select label="趋势指标组" value={curveGroup} options={healthTrendGroups} onChange={setCurveGroup} /> : <span className="trend-view-label">源任务波形快照</span>}</div>
      <div className="trend-data-actions">
        <span className="trend-mark-action" title={markDisabledReason}><Button variant="ghost" disabled={!record || !writable || busy || annotations.length >= 200} onClick={() => { setPlaying(false); setMark({ id: crypto.randomUUID(), target: view }); }}><PencilLine size={15} aria-hidden="true" />添加人工信号标记</Button></span>
        <ResultExport label={record ? "导出归档数值" : "导出演示趋势"} path={record ? `export/analyses/${record.id}` : undefined} datasetKey={record ? view : undefined} getData={() => dataset!} notify={notify} />
      </div>
    </div>}
    <div id={archivePanelId} className="trend-archive-controls" role="region" aria-label="归档设置与历史" hidden={!archiveControls}>{sourceControls}</div>
    {dataset ? <>{!waveform && <><span className="sr-only" data-testid="health-trend-columns">当前显示：{healthTrendColumns(dataset, curveGroup).map(s => s.name).join("、") || "此归档没有该组指标"}</span>
      {record && healthTrendColumns(dataset).length < trendSeries.length && <p className="muted">旧归档仅有 {healthTrendColumns(dataset).length} 项趋势，缺失指标不补造；导出仍保留原始数据列。</p>}</>}
      {waveform && <div className="toolbar trend-playback-controls"><Button disabled={count < 2 || !(rate > 0)} onClick={() => { if (!playing && position >= count - 1) setCursor(0); setPlaying(!playing); }}>{playing ? "暂停归档波形" : "播放归档波形"}</Button><Select label="归档回放速度" value={speed} options={["0.5", "1", "2"]} onChange={setSpeed} />
        <input aria-label="归档回放位置" type="range" min={0} max={Math.max(0, count - 1)} value={Math.max(0, position)} onChange={e => { setPlaying(false); setCursor(Number(e.target.value)); }} />
        <span className="mono" data-testid="health-trend-cursor">{position} / {count - 1} · {(position / rate).toFixed(3)} s</span><Button onClick={() => { setPlaying(false); setCursor(0); }}>复位回放</Button></div>}
      <div className="trend-chart-surface"><Chart option={option} height={waveform ? 260 : 230} label={waveform ? "健康归档波形与人工标记" : "健康趋势与人工标记"} /></div>
    </> : <Empty text={error || "暂无趋势"} />}
    <details className="health-explanation"><summary>演示数据与标记说明</summary><p className="muted">趋势为固定 30 日变化率样例，不对应上方指标的绝对值；零线仅为变化率参考。展示日期不代表真实长期监测，未执行漂移识别或异常剔除。波形快照独立保存原任务数值，与每天趋势点没有真实时间关联。红点/红带仅表示人工标记，不改变数据。切换指标组只影响图表，导出始终包含归档全部数据列。</p></details>
    {record && <><h3>异常信号标记记录 <small>（含撤回历史）</small></h3>{annotations.length ? <div className="saved-result-table"><Table headers={["目标 / 索引范围", "类别 / 说明", "记录人 / 时间", "状态 / 操作"]}>{annotations.map(a => <tr key={a.id} data-testid={"health-annotation-" + a.id}>
      <td><button className="text-link" onClick={() => { setView(a.target); if (a.target === "trend") setCurveGroup("all"); setPlaying(false); setCursor(a.startIndex); }}>{a.target === "trend" ? trendSeries.find(s => s.key === a.series)?.name : "原始波形"} [{a.startIndex}, {a.endIndex})</button></td>
      <td>{a.label}<p>{a.note}</p></td><td>{a.actor}<br />{a.time}</td><td><Tag tone={a.status === "active" ? "red" : "gray"}>{a.status === "active" ? "有效标记" : "已撤回"}</Tag>{a.status === "active" ? <Button disabled={!writable || busy} aria-label={"撤回信号标记 " + a.id} onClick={() => setWithdraw(a)}>撤回</Button> : <p>{a.withdrawnBy} · {a.withdrawnAt}<br />原因：{a.withdrawalReason}</p>}</td>
    </tr>)}</Table></div> : <Empty text="暂无人工信号标记；告警复核与信号标记分别留痕。" />}</>}
    {mark && record && <EditDialog title={"添加人工信号标记 · " + (mark.target === "trend" ? "趋势" : "波形")} initial={{ series: mark.target === "trend" ? healthTrendColumns(dataset)[0]?.key : "value", startIndex: 0, endIndex: 1, label: "待复核", note: "" }} fields={[
      { key: "series", label: "标记曲线", type: "select", options: mark.target === "trend" ? healthTrendColumns(dataset).map(s => ({ value: s.key, label: s.name })) : [{ value: "value", label: "原始幅值" }], required: true },
      { key: "label", label: "标记类别", type: "select", options: ["待复核", "异常", "已确认"], required: true },
      { key: "startIndex", label: "起始索引（含，从 0 开始）", type: "number", min: 0, max: count - 1, required: true },
      { key: "endIndex", label: "结束索引（不含）", type: "number", min: 1, max: count, required: true },
      { key: "note", label: "标记说明（不修改原始数值）", type: "textarea", required: true },
    ]} onClose={() => setMark(null)} onSave={async values => { const saved = await api<Item>(`health/trends/${record.id}/annotations`, "POST", { ...values, ...mark }); setRecord(saved); if (mark.target === "trend") setCurveGroup(healthTrendGroups.find(g => g.keys.includes(values.series))?.value || "all"); await refresh(); notify("人工标记已保存，原始数值未改变"); }} />}
    {withdraw && record && <EditDialog title="撤回人工信号标记" initial={{ reason: "" }} fields={[{ key: "reason", label: "撤回原因（保留原标记历史）", type: "textarea", required: true }]} onClose={() => setWithdraw(null)} onSave={async values => { const saved = await api<Item>(`health/trends/${record.id}/annotations/${withdraw.id}/withdraw`, "POST", values); setRecord(saved); await refresh(); notify("标记已撤回，原说明与处置历史仍保留"); }} />}
    {details && record && <SavedResultDialog key={record.id} result={record} notify={notify} onClose={() => setDetails(false)} />}
  </Card>;
}
