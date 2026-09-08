"use client";
import { useEffect, useMemo, useState } from "react";
import { type Item } from "./api";
import { Button, Card, Empty, Select, Table, Tag, saveRecord, type ContextProps } from "./common";
import { Chart, spectrumOption } from "./charts";
import { ResultExport, SavedResultDialog } from "./result-export";
import { stableJson } from "./sync-data";
import { generateRotationSegments, rotationCanonical, rotationCutDataset, rotationOrderDataset, rotationParameters, rotationRevision, rotationWave, rotationWorkflow, segmentLabels, segmentQualities, type RotationConfig, type RotationSegment } from "./rotation-data";
type Plan = { task: Item; config: RotationConfig; segments: RotationSegment[]; revision: string; canonical: string };
const initial = (task?: Item) => ({ rpm: task?.rpm ?? 0, blades: task?.blades ?? 1, source: "手动", mode: "period", start: 0, end: task?.samples?.length && task?.sampleRate ? task.samples.length / task.sampleRate : 0 });
export function Blade({ data, refresh, notify, canWrite, onTaskChange, initialTaskId }: ContextProps) {
  const [taskId, setTaskId] = useState(initialTaskId || data.tasks[0]?.id || "");
  const task = data.tasks.find((t: Item) => t.id === taskId);
  const [draft, setDraft] = useState(() => initial(task));
  const [plan, setPlan] = useState<Plan | null>(null), [busy, setBusy] = useState(false), [compare, setCompare] = useState(false), [saved, setSaved] = useState<Item | null>(null);
  useEffect(() => { setDraft(initial(task)); setPlan(null); setCompare(false); }, [task?.id]);
  useEffect(() => { onTaskChange?.(task); }, [task, onTaskChange]);
  let parameters: ReturnType<typeof rotationParameters> | undefined, parameterError = "", wave: ReturnType<typeof rotationWave> | undefined;
  try { parameters = rotationParameters(draft); } catch (error) { parameterError = (error as Error).message; }
  try { wave = rotationWave(task); } catch { /* Missing raw samples is shown as an explicit empty state. */ }
  const dirty = !!plan && (!task || rotationCanonical(task) !== plan.canonical || stableJson(draft) !== stableJson(plan.config));
  const result = useMemo(() => {
    if (!plan) return { dataset: undefined, error: "" };
    try { return { dataset: rotationCutDataset(plan.task, plan.config, plan.segments, plan.revision), error: "" }; }
    catch (error) { return { dataset: undefined, error: (error as Error).message }; }
  }, [plan]);
  const spectrum = useMemo(() => spectrumOption(true), []);
  const selected = plan?.segments.filter(s => s.keep) || [];
  const plot = useMemo(() => {
    if (!wave) return {};
    const series = compare && plan && !dirty ? selected.slice(0, 6).map(segment => ({ name: `段 ${plan.segments.indexOf(segment) + 1} · ${segment.label}`, type: "line", showSymbol: false, data: wave.samples.slice(segment.startIndex, segment.endIndex).map((value, i) => [i / wave.sampleRate, value]) })) : [{ name: "任务原始波形", type: "line", showSymbol: false, data: wave.samples.map((value, i) => [i / wave.sampleRate, value]), markArea: { silent: true, itemStyle: { color: "rgba(45,108,192,.10)" }, data: !dirty ? selected.map(segment => [{ xAxis: segment.start }, { xAxis: segment.end }]) : [] } }];
    return { animation: false, color: ["#2D6CC0", "#1FA971", "#7A4DD4", "#F5A623", "#E5484D", "#079AA6"], grid: { left: 55, right: 22, top: 40, bottom: 65 }, tooltip: { trigger: "axis" }, legend: { type: "scroll", top: 0, left: 55, right: 22, textStyle: { fontSize: 10 } }, xAxis: { type: "value", name: compare && !dirty ? "段内秒" : "原任务秒", nameLocation: "middle", nameGap: 27 }, yAxis: { type: "value", name: wave.unit }, dataZoom: [{ type: "inside" }, { type: "slider", height: 15, bottom: 3 }], series };
  }, [task, plan, compare, dirty]);
  function updateSegment(id: string, patch: Partial<RotationSegment>) {
    setPlan(current => current ? { ...current, segments: current.segments.map(s => s.id === id ? { ...s, ...patch } : s) } : current);
  }
  const history = data.analyses.filter((a: Item) => a.taskId === taskId && (a.type === "order" || a.parameters?.workflow === rotationWorkflow));
  return <div className="stack rotation-screen">
    <Card><div className="toolbar">
      <Select label="任务" value={taskId} options={data.tasks.map((t: Item) => ({ value: t.id, label: t.name }))} disabled={busy} onChange={setTaskId} />
      <Select label="转速来源" value={draft.source} options={["手动", "键相（未接入）", "信号估计（未接入）"]} onChange={source => setDraft({ ...draft, source })} />
      <label className="inline-field"><span>转速 n</span><input aria-label="转速 n" type="number" min={0} step="any" disabled={draft.source !== "手动"} value={draft.rpm} onChange={e => setDraft({ ...draft, rpm: Number(e.target.value) })} />rpm</label>
      <label className="inline-field"><span>叶片数 Z</span><input aria-label="叶片数 Z" type="number" min={1} max={1000} step={1} value={draft.blades} onChange={e => setDraft({ ...draft, blades: Number(e.target.value) })} /></label>
      <Tag>fᵣ = {parameters ? parameters.fr.toFixed(3) : "—"} Hz</Tag><Tag tone="purple">fᵦ = {parameters ? parameters.fb.toFixed(3) : "—"} Hz</Tag>
      <Button variant="primary" disabled={!canWrite || !task || !parameters || busy} onClick={async () => {
        setBusy(true); try { const dataset = rotationOrderDataset(task, draft, spectrum); await saveRecord("analyses", { name: task.name.slice(0, 170) + " · 演示阶次分析", taskId, type: "order", parameters: dataset.metadata.parameters, result: { dataset }, source: "demo" }); await refresh(); notify("阶次图演示数值与手动参数已保存，未执行阶次算法"); } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
      }}>保存演示分析</Button>
    </div>{parameterError && <p className="error" role="alert">{parameterError}</p>}</Card>
    <div className="workspace-grid">
      <div className="stack">
        <Card title="阶次谱 / 转速同步重采样" tools={<Tag tone="amber">固定原型幅值 · 算法未接入</Tag>}>
          <div className="rotation-chart"><Chart option={spectrum} height={250} /></div>
          <div className="toolbar"><ResultExport label="导出阶次样例" getData={() => rotationOrderDataset(task, draft, spectrum)} disabled={!parameters} notify={notify} /><span className="muted">仅频率关系随 n/Z 换算，柱高不是所选任务的计算结果。</span></div>
        </Card>
        <Card title="叶片通过波形与有效段" tools={<Tag tone={wave ? "blue" : "gray"}>{wave ? `${wave.samples.length} 点 · 原始幅值` : "未保存波形"}</Tag>}>
          {wave ? <div className="rotation-chart"><Chart option={plot} height={240} /></div> : <Empty text="当前任务没有原始采样点。请在数据采集页导入波形；此处不补造演示有效段。" />}
          <div className="toolbar">
            <Select label="截取方式" value={draft.mode} options={[{ value: "period", label: "按叶片通过周期" }, { value: "manual", label: "手动时间范围" }, { value: "stable", label: "自动稳定段（未接入）" }]} onChange={mode => setDraft({ ...draft, mode })} />
            <label className="inline-field"><span>起点 s</span><input aria-label="截取起点" type="number" step="any" min={0} value={draft.start} onChange={e => setDraft({ ...draft, start: Number(e.target.value) })} /></label>
            <label className="inline-field"><span>终点 s</span><input aria-label="截取终点" type="number" step="any" min={0} value={draft.end} onChange={e => setDraft({ ...draft, end: Number(e.target.value) })} /></label>
            <Button disabled={!wave || !parameters || draft.mode === "stable" || busy} onClick={async () => {
              setBusy(true); try { const source = structuredClone(task), generated = generateRotationSegments(source, draft); const revision = await rotationRevision(source); setPlan({ task: source, ...generated, revision, canonical: rotationCanonical(source) }); setCompare(false); notify(`已生成 ${generated.segments.length} 段候选边界，请人工确认质量与保留项`); } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
            }}>生成分段</Button>
          </div>
          {draft.mode === "stable" && <p className="hint">自动稳定段识别尚未接入。可用手动范围选择，再在段详情中标注“稳定运行”。</p>}
          <p className="muted">时间上限按实际点数 / 采样率计算：{wave?.duration ?? "—"} s。手动恒定转速仅生成候选周期边界，不做转角对齐或键相识别。</p>
          {dirty && <p role="alert" className="error">任务或参数已变化，请重新生成分段；旧选择不会用于当前导出或保存。</p>}
          {result.error && !dirty && <p role="alert" className="error">{result.error}</p>}
          <div className="toolbar space-top">
            <Button disabled={!result.dataset || dirty} onClick={() => setCompare(!compare)}>{compare ? "返回原始时间轴" : "多段对比"}</Button>
            <Button variant="primary" disabled={!canWrite || !result.dataset || dirty || busy} onClick={async () => {
              if (!plan) return; setBusy(true); try { await saveRecord("analyses", { name: plan.task.name.slice(0, 170) + " · 有效段", taskId: plan.task.id, type: "cut", parameters: { workflow: rotationWorkflow, sourceRevision: plan.revision, config: plan.config, segments: plan.segments } }); await refresh(); notify("所选原始采样点已保存为分段分析，原任务未修改"); } catch (error) { notify((error as Error).message); } finally { setBusy(false); }
            }}>截取并保存</Button>
            <ResultExport label="导出有效段" disabled={!result.dataset || dirty} getData={() => { if (!result.dataset || dirty) throw Error("请重新生成并选择有效分段"); return result.dataset; }} notify={notify} />
          </div>
          {compare && <p className="hint">最多同时绘制前 6 个保留段，各段按自身起点对齐，仅作人工对比，不代表相位同步。导出包含全部保留段及其原任务时间。</p>}
        </Card>
      </div>
      <aside className="stack">
        <Card title="周期分段结果" tools={<Tag>{plan?.segments.length || 0} 段</Tag>}>
          {!plan ? <Empty text="生成分段后可人工标注、选择与排除。" /> : <>
            <p className="muted">质量未经算法评价；将段标记为异常后，可点击下方按钮排除。原始数据不会删除。</p>
            <div className="rotation-segments"><Table headers={["保留", "区间 s / 段详情", "质量"]}>{plan.segments.map((segment, i) => <tr key={segment.id}>
              <td><input type="checkbox" aria-label={"保留分段 " + (i + 1)} checked={segment.keep} disabled={dirty || busy} onChange={e => updateSegment(segment.id, { keep: e.target.checked })} /></td>
              <td><span className="mono">{Number(segment.start.toPrecision(6))}–{Number(segment.end.toPrecision(6))}</span><small>{segment.endIndex - segment.startIndex} 点{segment.partial ? " · 不足完整周期" : ""}</small>
                <details><summary>{segment.label} · 标注</summary><select aria-label={"分段类型 " + (i + 1)} disabled={dirty || busy} value={segment.label} onChange={e => updateSegment(segment.id, { label: e.target.value })}>{segmentLabels.map(label => <option key={label}>{label}</option>)}</select><input aria-label={"分段备注 " + (i + 1)} maxLength={300} disabled={dirty || busy} placeholder="人工判断依据" value={segment.note} onChange={e => updateSegment(segment.id, { note: e.target.value })} /></details>
              </td><td><select aria-label={"分段质量 " + (i + 1)} disabled={dirty || busy} value={segment.quality} onChange={e => updateSegment(segment.id, { quality: e.target.value })}>{segmentQualities.map(quality => <option key={quality}>{quality}</option>)}</select></td>
            </tr>)}</Table></div>
            <Button className="full space-top" disabled={dirty || busy || !plan.segments.some(s => s.quality === "异常" && s.keep)} onClick={() => { setPlan({ ...plan, segments: plan.segments.map(s => s.quality === "异常" ? { ...s, keep: false } : s) }); notify("已排除人工标记的异常段，索引和原因随结果保留"); }}>剔除异常段</Button>
            <p className="muted" data-testid="rotation-selection">保留 {selected.length} / {plan.segments.length} 段 · {result.dataset?.rows.length || 0} 点</p>
          </>}
        </Card>
        <Card title="频率关系"><dl className="key-values"><dt>旋转频率 fᵣ</dt><dd>{parameters?.fr.toFixed(3) ?? "—"} Hz</dd><dt>叶片通过频率 fᵦ</dt><dd>{parameters?.fb.toFixed(3) ?? "—"} Hz</dd><dt>2 倍转频</dt><dd>{parameters ? (parameters.fr * 2).toFixed(3) : "—"} Hz</dd><dt>3 倍转频</dt><dd>{parameters ? (parameters.fr * 3).toFixed(3) : "—"} Hz</dd></dl><p className="hint">fᵣ=n/60，fᵦ=Z·fᵣ。有效段文件保留段编号、原始索引和绝对时间，不将不连续区间伪装为连续波形。</p></Card>
      </aside>
    </div>
    <Card title="已保存旋转分析与分段"><Table headers={["记录", "类型", "来源", "操作"]}>{history.map((item: Item) => <tr key={item.id}><td>{item.name}</td><td>{item.type === "cut" ? "原始分段" : "阶次演示"}</td><td>{item.source === "demo" ? "演示源" : "已保存原始数据"}</td><td><Button aria-label={"查看旋转结果 " + item.id} onClick={() => setSaved(item)}>查看结果</Button></td></tr>)}</Table>{!history.length && <Empty text="当前任务尚无旋转分析或分段结果。" />}</Card>
    {saved && <SavedResultDialog result={saved} notify={notify} onClose={() => setSaved(null)} />}
  </div>;
}
