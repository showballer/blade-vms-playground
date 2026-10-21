import React, { useMemo, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { fieldDate, type FieldRecording } from "./field-types";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
// Match the task namespace used by the blade summary; never group by display name.
export function recordingTaskKey(record: FieldRecording): string {
  const cycle = record.pointCycle;
  const [kind, id] = identifier(cycle?.collectionId) ? ["collection", cycle.collectionId]
    : identifier(cycle?.sessionId) ? ["session", cycle.sessionId]
    : identifier(record.captureSessionId) ? ["capture", record.captureSessionId] : ["record", record.id];
  return JSON.stringify([kind, id, JSON.stringify([text(record.windFarm), text(record.turbine), text(record.object)])]);
}
export type RecordingTask = { key: string; name: string; windFarm: string; turbine: string; records: FieldRecording[]; latestAt: number };
export function recordingExportIds(records: readonly FieldRecording[], taskKey: string, bladeId?: string, pointId?: string): string[] {
  return [...new Set(records.filter(record => recordingTaskKey(record) === taskKey &&
    (bladeId === undefined || record.pointCycle?.bladeId === bladeId) &&
    (pointId === undefined || record.pointCycle?.radialPointId === pointId)).map(record => record.id))];
}
export function groupRecordingTasks(recordings: readonly FieldRecording[]): RecordingTask[] {
  const unique = new Map<string, FieldRecording>();
  for (const record of recordings) unique.set(record.id, record);
  const tasks = new Map<string, RecordingTask>();
  for (const record of unique.values()) {
    const key = recordingTaskKey(record);
    const at = fieldDate(record.endedAt)?.getTime() || fieldDate(record.startedAt)?.getTime() || 0;
    let task = tasks.get(key);
    if (!task) { task = { key, name: text(record.name) || "未命名采集任务", windFarm: text(record.windFarm),
      turbine: text(record.turbine), records: [], latestAt: at }; tasks.set(key, task); }
    task.records.push(record); task.latestAt = Math.max(task.latestAt, at);
  }
  return [...tasks.values()].sort((a, b) => b.latestAt - a.latestAt || a.key.localeCompare(b.key));
}
export function FieldTaskRecords({ recordings, busy, exporting, onExportTask, children }: {
  recordings: readonly FieldRecording[]; busy: boolean; exporting?: boolean;
  onExportTask: (recordingIds: string[]) => void; children: (records: FieldRecording[]) => React.ReactNode;
}) {
  const tasks = useMemo(() => groupRecordingTasks(recordings), [recordings]);
  const [selectedKey, setSelectedKey] = useState("");
  const selected = tasks.find(task => task.key === selectedKey);
  return <>
    {tasks.length > 0 && <div className="field-task-export-toolbar">
      <label>采集任务<CustomSelect aria-label="筛选采集任务" value={selected?.key || ""} disabled={busy} onChange={event => setSelectedKey(event.target.value)}>
        <option value="">全部任务（{tasks.length}）</option>
        {tasks.map(task => <option key={task.key} value={task.key}>{task.name} · {[task.windFarm, task.turbine].filter(Boolean).join(" / ") || "未填写风机"} · {task.records.length} 条 · {fieldDate(task.records[0].startedAt)?.toLocaleString("zh-CN", { hour12: false }) || task.records[0].id.slice(0, 8)}</option>)}
      </CustomSelect></label>
      <Button disabled={busy || !selected} title={selected ? "导出该任务全部已保存记录，按叶片和测点分类" : "请先选择一个采集任务"} onClick={() => selected && onExportTask(selected.records.map(record => record.id))}>
        {exporting ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{exporting ? "正在导出…" : "导出任务 ZIP"}
      </Button>
      <span className="field-task-export-hint">{selected ? `${selected.records.length} 条记录 · ` : "选择任务后整体导出 · "}包含原始波形、点位信息和转盘反馈</span>
    </div>}
    {children(selected ? selected.records : [...recordings])}
  </>;
}
