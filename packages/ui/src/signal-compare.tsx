"use client";
import { useMemo, useState } from "react";
import { Button, Dialog, Empty, Select, Table, saveRecord } from "./common";
import { Chart } from "./charts";
import { ResultExport } from "./result-export";
import { signalChoices, signalWaveDataset, signalWaveOption, signalRevision, signalWorkflow, type SignalInput } from "./signal-input";
import type { Item } from "./api";

export function SignalCompare({ tasks, analyses, initialKey, notify, refresh, canWrite, onClose }: {
  tasks: Item[]; analyses: Item[]; initialKey: string; notify: (s: string) => void; refresh: () => Promise<unknown>; canWrite: boolean; onClose: () => void;
}) {
  const choices = useMemo(() => signalChoices(tasks, analyses), [tasks, analyses]);
  const [keys, setKeys] = useState([initialKey]), [alignment, setAlignment] = useState("source"), [query, setQuery] = useState(""), [busy, setBusy] = useState(false);
  const state = useMemo(() => {
    try {
      const inputs = keys.map(key => {
        const choice = choices.find(c => c.key === key);
        if (!choice?.input) throw Error(choice?.error || "所选输入已不存在，请取消该项并重选");
        return choice.input;
      });
      const dataset = signalWaveDataset(inputs, alignment, true);
      const groups = inputs.map(input => tasks.find(t => t.id === input.taskId)?.recordTenant);
      if (new Set(groups).size > 1) throw Error("请选择同一课题组的输入");
      return { inputs, dataset, error: "" };
    } catch (e) { return { inputs: [] as SignalInput[], dataset: undefined, error: (e as Error).message }; }
  }, [keys, choices, alignment, tasks]);
  return <Dialog title="多测点波形对比" wide onClose={onClose}>
    <div className="toolbar"><input aria-label="搜索对比输入" placeholder="搜索任务、测点或分段" value={query} onChange={e => setQuery(e.target.value)} />
      <Select label="对比时间轴" value={alignment} options={[{ value: "source", label: "原任务时间" }, { value: "relative", label: "各输入起点归零（非同步）" }]} onChange={setAlignment} />
      <span>已选 {keys.length} / 6 项</span><Button onClick={() => setKeys([])}>清空选择</Button></div>
    <div className="signal-compare-inputs"><Table headers={["选择", "任务 / 已保存段", "测点", "采样率 / 点数", "单位 / 来源"]}>
      {choices.filter(c => (c.label + c.input?.task.point).toLowerCase().includes(query.toLowerCase())).map(c => <tr key={c.key}>
        <td><input type="checkbox" aria-label={`对比输入 ${c.key}`} checked={keys.includes(c.key)} disabled={!keys.includes(c.key) && (!c.input || keys.length >= 6)} onChange={e => setKeys(e.target.checked ? [...keys, c.key] : keys.filter(k => k !== c.key))} /></td>
        <td>{c.label}{c.error && <small className="error">{c.error}</small>}</td><td>{c.input?.task.point || "—"}</td>
        <td>{c.input ? `${c.input.task.sampleRate} Hz / ${c.input.rows.length} 点` : "无波形"}</td><td>{c.input?.unit || "—"} / {c.input?.source === "demo" ? "演示" : c.input?.source || "未知"}</td>
      </tr>)}
    </Table></div>
    {state.dataset ? <Chart option={signalWaveOption(state.dataset)} height={280} label="多测点对比波形" /> : <Empty text={state.error} />}
    <p className="note-box" data-testid="signal-compare-note">{state.dataset?.metadata.note || state.error} 一次最多 6 个输入、合计 20000 点；可选择已保存段缩小范围。不同单位不能直接叠加。</p>
    <div className="dialog-actions"><ResultExport label="导出对比数据" disabled={!state.dataset} getData={() => { if (!state.dataset) throw Error(state.error); return state.dataset; }} notify={notify} />
      <Button variant="primary" disabled={!canWrite || busy || !state.dataset} onClick={async () => {
        const inputs = state.inputs, preview = state.dataset;
        if (!preview) return;
        setBusy(true);
        try {
          const refs = await Promise.all(inputs.map(async input => ({ ...input.ref, revision: await signalRevision(input) })));
          await saveRecord("analyses", { name: ("多测点对比 · " + inputs[0].task.name).slice(0, 200), taskId: inputs[0].taskId, type: "time", parameters: { workflow: signalWorkflow, inputs: refs, compare: true, alignment }, result: { dataset: preview } });
          await refresh(); notify("对比快照已保存；可在首个输入任务的分析记录中查看和导出");
        } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
      }}>{busy ? "保存中…" : "保存对比快照"}</Button><Button onClick={onClose}>关闭</Button></div>
  </Dialog>;
}
