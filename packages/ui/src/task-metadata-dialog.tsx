"use client";
import { CustomSelect } from "./custom-select";
import { useState } from "react";
import { Button, Dialog, Tag } from "./common";
import { validateTaskMetadata, type TaskChannel } from "./task-metadata";

const signals = [{ value: "velocity", label: "速度" }, { value: "displacement", label: "位移" }, { value: "acceleration", label: "加速度" }, { value: "keyphasor", label: "键相" }, { value: "other", label: "其他 / 原始幅值" }];
function localDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
export function TaskMetadataDialog({ task, onClose, onSave }: {
  task: Record<string, any>; onClose: () => void; onSave: (metadata: Record<string, any>) => Promise<void>;
}) {
  const [testTime, setTestTime] = useState(localDate(task.testTime));
  const [environment, setEnvironment] = useState(task.environment || "");
  const [faultType, setFaultType] = useState(task.faultType || "");
  const [note, setNote] = useState(task.note || "");
  const [channels, setChannels] = useState<TaskChannel[]>(task.channels || []);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Dialog title="完整任务元信息" onClose={() => !busy && onClose()}>
    <form onSubmit={async (e) => {
      e.preventDefault(); setError(""); setBusy(true);
      try {
        const metadata = { testTime: testTime ? new Date(testTime).toISOString() : "", environment, faultType, note, channels };
        const invalid = validateTaskMetadata(metadata);
        if (invalid) throw Error(invalid);
        await onSave(metadata); onClose();
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>
      <fieldset disabled={busy} className="metadata-fields">
        <div className="form-grid">
          <label className="form-field"><span>测试时间（本机时区）</span><input type="datetime-local" step="1" value={testTime} onChange={(e) => setTestTime(e.target.value)} /></label>
          <label className="form-field"><span>故障类型</span><input placeholder="如：正常 / 叶尖裂纹 / 未标注" maxLength={2000} value={faultType} onChange={(e) => setFaultType(e.target.value)} /></label>
          <label className="form-field span-2"><span>测试环境</span><input placeholder="如：现场，风速 8 m/s，温度 20℃" maxLength={2000} value={environment} onChange={(e) => setEnvironment(e.target.value)} /></label>
          <label className="form-field span-2"><span>工况备注</span><textarea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        <h3>通道编号 / 信号类型 / 单位</h3>
        <p className="muted">通道描述用于追溯，不执行单位换算。当前波形导入为单列幅值，请确认其对应通道；不要把描述数量当作已保存的波形通道数。</p>
        {channels.map((ch, i) => <div className="toolbar space-top" key={i}>
          <input aria-label={`通道 ${i + 1} 编号`} type="number" min={1} max={256} step={1} value={ch.no} onChange={(e) => setChannels(channels.map((c, j) => j === i ? { ...c, no: Number(e.target.value) } : c))} style={{ width: 80 }} required />
          <CustomSelect aria-label={`通道 ${i + 1} 类型`} value={ch.type} onChange={(e) => setChannels(channels.map((c, j) => j === i ? { ...c, type: e.target.value } : c))}>{signals.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</CustomSelect>
          <input aria-label={`通道 ${i + 1} 单位`} placeholder="单位" maxLength={30} value={ch.unit} onChange={(e) => setChannels(channels.map((c, j) => j === i ? { ...c, unit: e.target.value } : c))} style={{ width: 120 }} required />
          <Button type="button" aria-label={`移除通道 ${i + 1}`} onClick={() => setChannels(channels.filter((_, j) => j !== i))}>移除</Button>
        </div>)}
        <div className="toolbar space-top"><Button type="button" disabled={channels.length >= 16} onClick={() => { const used = new Set(channels.map((c) => c.no)); let no = 1; while (used.has(no)) no++; setChannels([...channels, { no, type: "other", unit: "" }]); }}>添加通道描述</Button><Tag tone={task.samples?.length ? "green" : "gray"}>原始采样点：{task.samples?.length || 0} · {task.samples?.length ? "已保留" : "尚无波形"}</Tag></div>
      </fieldset>
      {error && <div role="alert" className="error">{error}</div>}
      <div className="dialog-actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy}>{busy ? "保存中…" : "保存元信息"}</Button></div>
    </form>
  </Dialog>;
}
