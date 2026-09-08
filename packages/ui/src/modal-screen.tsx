"use client";
import { useEffect, useMemo, useState } from "react";
import { type Item } from "./api";
import { Button, Card, Empty, Select, Table, Tag, saveRecord, type ContextProps } from "./common";
import { Chart, lineOption } from "./charts";
import { ResultExport, SavedResultDialog } from "./result-export";
import { BaselineManager } from "./baseline-manager";
import { baselineModalUsable } from "./baseline-data";
import { rotationRevision } from "./rotation-data";
import { dampingMethods, modalBaselineRevision, modalDatasetNames, modalMethods, modalOrders, modalPoints, modalResult, modalWorkflow, type ModalConfig } from "./modal-data";

export function ModalAnalysis({ data, refresh, notify, canWrite, initialTaskId, onTaskChange, go }: ContextProps) {
  const [taskId, setTaskId] = useState(initialTaskId || data.tasks[0]?.id || "");
  const tasks: Item[] = data.tasks;
  const task = tasks.find(t => t.id === taskId);
  const [config, setConfig] = useState<ModalConfig>({ test: "free", method: "峰值拾取", damping: "半功率带宽", points: ["P1", "P2", "P3"], activeOrder: 1, baselineId: "prototype" });
  const [busy, setBusy] = useState(false), [playing, setPlaying] = useState(true), [speed, setSpeed] = useState("1"), [phase, setPhase] = useState(Math.PI / 2), [saved, setSaved] = useState<Item | null>(null), [exportKey, setExportKey] = useState("parameters");
  const [manageBaselines, setManageBaselines] = useState(false);
  const baselines: Item[] = data.baselines.filter((b: Item) => task && b.object === task.object && b.recordTenant === task.recordTenant && baselineModalUsable(b));
  const baseline = baselines.find(b => b.id === config.baselineId);
  useEffect(() => { onTaskChange?.(task); }, [task, onTaskChange]);
  useEffect(() => { setConfig(c => ({ ...c, baselineId: "prototype" })); }, [taskId]);
  useEffect(() => { if (taskId && !task) setTaskId(""); }, [taskId, task]);
  const preview = useMemo(() => {
    try { return { value: modalResult(task!, config, baseline), error: "" }; }
    catch (error) { return { value: undefined, error: (error as Error).message }; }
  }, [task, config, baseline]);
  useEffect(() => {
    if (!playing || !preview.value) return;
    const timer = setInterval(() => setPhase(p => (p + .14 * Number(speed)) % (Math.PI * 2)), 100);
    return () => clearInterval(timer);
  }, [playing, speed, !!preview.value]);
  const result = preview.value, history: Item[] = data.analyses.filter((a: Item) => a.taskId === taskId && a.type === "modal");
  const selectedShape = result?.datasets.shape.rows.filter(row => row[0] === config.activeOrder) || [];
  const shape = {
    animation: false, grid: { left: 50, right: 24, top: 45, bottom: 40 }, tooltip: { trigger: "axis" }, legend: { top: 0, textStyle: { fontSize: 10 } },
    xAxis: { type: "value", min: 0, max: 1, interval: .5, axisLabel: { formatter: (value: number) => modalPoints.find(p => p.position === value)?.name || "" } },
    yAxis: { type: "value", min: -1.2, max: 1.2, name: "相对值", axisLabel: { fontSize: 10 } },
    series: [
      { name: "当前振型（演示）", type: "line", symbolSize: 8, itemStyle: { color: "#2D6CC0" }, data: selectedShape.map(row => [row[2], Number(row[3]) * Math.sin(phase)]) },
      { name: "未变形参考", type: "line", symbolSize: 5, itemStyle: { color: "#9AA6B5" }, lineStyle: { type: "dashed" }, data: selectedShape.map(row => [row[2], row[4]]) },
    ],
  };
  const pointCurve = result ? lineOption(result.datasets.points.columns.slice(1).map((c, i) => ({ name: c.label, data: result.datasets.points.rows.map(row => Number(row[i + 1])) })), result.datasets.points.rows.map(row => String(row[0]))) : {};
  const activeComparison = result?.datasets.baseline.rows.find(row => row[0] === config.activeOrder);
  return <div className="stack modal-screen">
    <Card className="modal-controls"><div className="toolbar">
      <span className="muted">测试类型</span><div className="segmented">
        <button disabled={busy} className={config.test === "free" ? "active" : ""} onClick={() => setConfig({ ...config, test: "free", method: "峰值拾取" })}>自由模态 锤击/激振器</button>
        <button disabled={busy} className={config.test === "oma" ? "active" : ""} onClick={() => setConfig({ ...config, test: "oma", method: "SSI" })}>工作模态 OMA</button>
      </div>
      <Select label="方法" value={config.method} options={modalMethods[config.test]} disabled={busy} onChange={method => setConfig({ ...config, method })} />
      <Select label="阻尼法" value={config.damping} options={dampingMethods} disabled={busy} onChange={damping => setConfig({ ...config, damping })} />
      <span className="muted">测点</span><div className="modal-point-picks">{modalPoints.map(p => <label key={p.id} className={config.points.includes(p.id) ? "picked" : ""}><input type="checkbox" aria-label={"选择模态测点 " + p.id} checked={config.points.includes(p.id)} disabled={busy} onChange={e => setConfig({ ...config, points: e.target.checked ? [...config.points, p.id] : config.points.filter(id => id !== p.id) })} />{p.name}</label>)}</div>
      <Button variant="primary" className="push" disabled={!canWrite || !result || busy} onClick={async () => {
        setBusy(true);
        try {
          const source = structuredClone(task!), baselineSnapshot = baseline ? structuredClone(baseline) : undefined, currentConfig = structuredClone(config);
          const [sourceRevision, baselineRevision] = await Promise.all([rotationRevision(source), modalBaselineRevision(baselineSnapshot)]);
          await saveRecord("analyses", { name: source.name.slice(0, 170) + " · 模态演示", taskId: source.id, type: "modal", parameters: { workflow: modalWorkflow, config: currentConfig, sourceRevision, baselineRevision } });
          await refresh(); notify("模态参数、所选测点与四类演示结果已保存，未执行识别算法");
        } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
      }}>{busy ? "保存中…" : "保存演示模态结果"}</Button>
    </div><div className="toolbar modal-context">
      <Select label="数据任务" value={taskId} options={[{ value: "", label: "请选择任务" }, ...tasks.map(t => ({ value: t.id, label: t.name }))]} disabled={busy} onChange={setTaskId} />
      <Select label="正常态基准" value={config.baselineId} options={[{ value: "prototype", label: "原型正常态样例（演示）" }, ...baselines.map(b => ({ value: b.id, label: b.name + "（已存一阶频率）" }))]} disabled={busy} onChange={baselineId => setConfig({ ...config, baselineId })} />
      <Button disabled={busy} onClick={() => setManageBaselines(true)}>基线管理</Button>
      <Tag tone="amber">识别算法未接入 · 固定样例</Tag>
    </div><details className="modal-explanation"><summary>演示数据与振型说明</summary>
      <p>P1/P2/P3 为原型演示位置，不代表所选任务具有三通道同步数据；方法与阻尼法仅保存配置。</p>
      <p>频率曲线横轴 Hz，纵轴为原型相对幅值；仅展示并导出勾选测点，不执行幅值单位换算。</p>
      <p>蓝线为示例振型，灰虚线为未变形参考，不是已测正常态振型；这里只比较基准频率。导出各阶固定振型节点，不导出播放相位。</p>
    </details>{preview.error && <p role="alert" className="error">{preview.error}</p>}</Card>
    {result ? <>
      <div className="modal-grid">
        <div className="stack">
          <Card title="模态参数表" tools={<Tag tone="amber">原型演示参数</Tag>}>
            <Table headers={["阶次", "固有频率", "阻尼比", "振型"]}>{modalOrders.map(m => <tr key={m.order} className={config.activeOrder === m.order ? "selected" : ""} data-testid={"modal-order-" + m.order}><td><button className="text-link" disabled={busy} onClick={() => { setConfig({ ...config, activeOrder: m.order }); setPhase(Math.PI / 2); }}>第 {m.order} 阶</button></td><td>{m.frequency.toFixed(2)} Hz</td><td>{m.damping}%</td><td>{m.name}</td></tr>)}</Table>
            <p className="hint">选择阶次切换振型和基准频率对比；全部三阶参数随分析保存。</p>
          </Card>
          <Card title="多测点对比 · 频率对比曲线" tools={<Tag>{config.points.length} 个演示测点</Tag>}>
            <Chart option={pointCurve} height={170} label="模态多测点频率曲线" />
            <p className="hint" data-testid="modal-baseline-comparison">{activeComparison ? `第 ${config.activeOrder} 阶 · 基准 ${Number(activeComparison[1]).toFixed(3)} Hz → 当前（演示）${Number(activeComparison[2]).toFixed(3)} Hz · 变化 ${Number(activeComparison[3]).toFixed(2)}%` : `所选基准仅保存一阶频率，不能比较第 ${config.activeOrder} 阶。`}</p>
          </Card>
        </div>
        <Card title="振型动画（二维）" tools={<Tag>第 {config.activeOrder} 阶</Tag>}>
          <Chart option={shape} height={220} label="模态振型动画" />
          <div className="toolbar"><Button variant="primary" onClick={() => setPlaying(!playing)}>{playing ? "暂停动画" : "播放动画"}</Button><Select label="动画速度" value={speed} options={["0.5", "1", "2"]} onChange={setSpeed} /><Button onClick={() => { setPlaying(false); setPhase(Math.PI / 2); }}>复位振型</Button></div>
          <p className="hint">基准频率对比 · 不比较实测振型</p>
          <Table headers={["阶次", "基准 Hz", "当前（演示）Hz", "变化 %"]}>{result.datasets.baseline.rows.map(row => <tr key={String(row[0])}>{row.map((cell, i) => <td key={i}>{i ? Number(cell).toFixed(i === 3 ? 2 : 3) : String(cell)}</td>)}</tr>)}</Table>
        </Card>
      </div>
      <Card><div className="toolbar"><Select label="当前模态导出内容" value={exportKey} options={Object.entries(modalDatasetNames).map(([value, label]) => ({ value, label }))} onChange={setExportKey} /><ResultExport label="导出当前模态数据" getData={() => result.datasets[exportKey as keyof typeof result.datasets]} notify={notify} /><span className="muted">保存与导出均包含任务、参数、测点和基准快照。</span></div></Card>
    </> : <Empty text="选择任务与至少一个测点后显示原型模态样例；不会补造实际识别结果。" />}
    <Card title="当前任务的模态历史" tools={<Button disabled={!canWrite || !task} onClick={() => go("report", { taskId })}>生成模态报告</Button>}>
      {history.length ? <Table headers={["分析记录", "测试 / 方法", "操作"]}>{history.map(a => <tr key={a.id}><td>{a.name}</td><td>{a.parameters?.config?.test || a.parameters?.test || "旧记录"} / {a.parameters?.config?.method || a.parameters?.method || "—"}</td><td><Button aria-label={"查看模态结果 " + a.id} onClick={() => setSaved(a)}>查看 / 导出</Button></td></tr>)}</Table> : <Empty text="当前任务暂无模态分析记录。" />}
    </Card>
    {manageBaselines && <BaselineManager data={data} refresh={refresh} notify={notify} purpose="modal" task={task} onClose={() => setManageBaselines(false)} onSelect={b => setConfig(c => ({ ...c, baselineId: b.id }))} />}
    {saved && <SavedResultDialog key={saved.id} result={saved} notify={notify} onClose={() => setSaved(null)} />}
  </div>;
}
