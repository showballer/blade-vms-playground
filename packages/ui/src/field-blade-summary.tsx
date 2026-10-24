import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FieldRecording, FieldSyncItem } from "./field-types";
import { ChevronDown, Download, LoaderCircle } from "lucide-react";
import { CustomSelect } from "./custom-select";
import { groupRecordingTasks, recordingExportIds } from "./field-recording-tasks";
import { bladeStationLabel, bladeRecordingTiming, summarizeBladeRecords, type BladeRecordGroup, type BladeStationState } from "./field-blade-summary-data";

const number = (value: number) => value.toLocaleString("zh-CN");
const timeText = (milliseconds: number | null) => milliseconds === null ? "未记录" : new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
export function bladeDurationText(seconds: number | null): string {
  if (seconds === null) return "未知";
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3600000), minutes = Math.floor(millis % 3600000 / 60000), rest = millis % 60000 / 1000;
  return `${hours ? `${hours} 小时 ` : ""}${minutes ? `${minutes} 分 ` : ""}${rest.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 秒`;
}
const groupRecords = (group: BladeRecordGroup) => group.stations.flatMap(station => station.records);
function RecordingTiming({ records }: { records: readonly FieldRecording[] }) {
  const timing = bladeRecordingTiming(records);
  return <div className="field-blade-timing">
    <span>采集时间：{timeText(timing.startedAt)} → {timing.openEnded ? "结束时间未完整记录" : timeText(timing.endedAt)}</span>
    <span>累计采集时长：<strong>{bladeDurationText(timing.durationSeconds)}</strong>{timing.partialDuration && "（部分记录时长未知）"}</span>
  </div>;
}
const stationTone = (state: BladeStationState) => state === "observed" ? "green" : state === "failed" ? "red" : state === "unrecorded" ? "" : "amber";
function groupLabel(group: BladeRecordGroup) {
  if (group.planConflict) return "计划信息不一致";
  if (group.failedCount) return "含失败记录";
  if (group.plannedCount === null) return "缺少点位计划";
  if (group.gapCount || group.incompleteCount || group.pendingCount) return "观测不完整";
  if (group.diagnosticCount) return group.diagnosticCount === group.plannedCount ? "测试采集完成" : "采集完成（含测试）";
  return "计划点位已记录";
}
const groupTone = (group: BladeRecordGroup) => group.failedCount || group.planConflict ? "red" : group.diagnosticCount || group.gapCount || group.incompleteCount || group.pendingCount || group.plannedCount === null ? "amber" : "green";
function uploadLabel(group: BladeRecordGroup) {
  if (!group.recordCount) return "尚无记录";
  const parts = [];
  if (group.uploadedCount) parts.push(`${group.uploadedCount} 已上传`);
  if (group.pendingUploadCount) parts.push(`${group.pendingUploadCount} 待上传`);
  if (group.failedUploadCount) parts.push(`${group.failedUploadCount} 上传异常`);
  if (group.unknownUploadCount) parts.push(`${group.unknownUploadCount} 同步状态未知`);
  return parts.join(" · ");
}
const groupMode = (group: BladeRecordGroup) => group.executionMode === "manual_segments" ? `分段累计 · ${group.sessionIds.length} 次采集` : `自动跟随 · 第 ${group.lapIndex} 轮`;
type Props = {
  recordings: readonly FieldRecording[]; syncItems?: readonly FieldSyncItem[];
  onOpenRecording?: (id: string) => void;
  onExportTask?: (recordingIds: string[], level?: "task" | "blade" | "point") => void;
  busy?: boolean; exporting?: boolean;
};
function ExportButton({ label, ariaLabel, ids, level, busy, exporting, onExportTask }: Pick<Props, "busy" | "exporting" | "onExportTask"> & {
  label: string; ariaLabel: string; ids: string[]; level: "task" | "blade" | "point";
}) {
  return onExportTask ? <button type="button" className="btn outline" disabled={busy || exporting || !ids.length} aria-label={ariaLabel}
    title={`导出全部 ${ids.length} 条已保存记录，包含历史重采`} onClick={() => onExportTask(ids, level)}>
    {exporting ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{exporting ? "正在导出…" : label}
  </button> : null;
}
function StationRecords({ group, onOpenRecording }: { group: BladeRecordGroup } & Pick<Props, "onOpenRecording">) {
  const [history, setHistory] = useState<string[]>([]);
  const tableId = useId();
  return <div className="field-table-scroll" role="region" tabIndex={0} aria-label={`${group.radialPointName} 圆周点位记录，可横向滚动`}><table aria-label={`叶片 ${group.bladeId} ${group.radialPointName} ${group.executionMode === "manual_segments" ? "分段累计" : `第 ${group.lapIndex} 轮`}点位`}>
    <thead><tr><th>圆周点位</th><th>观测结果</th><th>最近采集时间</th><th>采集时长</th><th>记录</th></tr></thead>
    <tbody>{group.stations.map(station => {
      const latest = station.records[0], timing = bladeRecordingTiming(latest ? [latest] : []), expanded = history.includes(station.id);
      const detailId = `${tableId}-${station.index}`;
      return <React.Fragment key={station.id}><tr>
        <td><strong>{station.azimuthDeg === null ? "角度未记录" : `${station.azimuthDeg.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}°`}</strong><small>点位 {station.index}{!station.planned && " · 计划未确认"}</small></td>
        <td><span className={`field-badge ${stationTone(station.state)}`}>{bladeStationLabel(station.state)}</span></td>
        <td className="field-blade-date" title={latest ? `结束 ${timeText(timing.endedAt)}` : undefined}>{latest ? timeText(timing.startedAt) : "—"}</td>
        <td className="mono">{latest ? bladeDurationText(timing.durationSeconds) : "—"}</td>
        <td><div className="field-blade-record-links">{latest ? onOpenRecording ? <button type="button" className="btn ghost" onClick={() => onOpenRecording(latest.id)} title={latest.name}>查看波形</button> : <span>{latest.name}</span> : <span className="muted">未收到记录</span>}
          {station.records.length > 1 && <button type="button" className="btn ghost" aria-expanded={expanded} aria-controls={detailId} aria-label={`查看 ${station.azimuthDeg ?? station.index}° 历史记录`} onClick={() => setHistory(previous => expanded ? previous.filter(id => id !== station.id) : [...previous, station.id])}>历史 {station.records.length}<ChevronDown size={12} /></button>}
        </div></td>
      </tr>{expanded && <tr className="field-blade-history" id={detailId}><td colSpan={5}><div className="field-blade-history-heading">全部记录 · 最新在前</div><div className="field-blade-history-list">{station.records.map(record => {
        const at = bladeRecordingTiming([record]);
        return <div key={record.id}><span><strong>{timeText(at.startedAt)}</strong><small>结束 {timeText(at.endedAt)}</small></span><span>{bladeDurationText(at.durationSeconds)}<small>{number(record.samples)} 样本</small></span><span title={record.error}>{record.status === "complete" ? "保存完成" : record.status === "error" ? "保存异常" : "未完成"}</span>{onOpenRecording ? <button type="button" className="btn ghost" onClick={() => onOpenRecording(record.id)} title={record.name}>查看波形</button> : <span>{record.name}</span>}</div>;
      })}</div></td></tr>}</React.Fragment>;
    })}</tbody>
  </table></div>;
}
function PointSummary({ groups, exportIds, busy, exporting, onExportTask, onOpenRecording }: {
  groups: BladeRecordGroup[]; exportIds: string[];
} & Pick<Props, "busy" | "exporting" | "onExportTask" | "onOpenRecording">) {
  const [selected, setSelected] = useState("");
  const group = groups.find(item => item.key === selected) || groups[0];
  const records = groupRecords(group), timing = bladeRecordingTiming(records), tone = groupTone(group);
  return <details className="field-blade-point" aria-label={`叶片 ${group.bladeId} · ${group.radialPointName}`}>
    <summary>
      <div className="field-blade-point-name"><strong>{group.radialPointName}</strong><span>{group.radiusM === null ? "距中心未记录" : `距中心 ${(group.radiusM * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} cm`}</span></div>
      <div className="field-blade-coverage"><div><strong>{group.observedCount + group.diagnosticCount} / {group.plannedCount ?? "—"}</strong><span className={`field-badge ${tone}`}>{groupLabel(group)}</span></div><span>{selected ? "当前观测组" : "最新观测组"} · {groupMode(group)}{groups.length > 1 && ` · 共 ${groups.length} 组`}</span></div>
      <div className="field-blade-point-time"><span>采集时间</span><strong>{timeText(timing.startedAt)}</strong></div>
      <div className="field-blade-point-duration"><span>采集时长</span><strong>{bladeDurationText(timing.durationSeconds)}{timing.partialDuration && "（部分）"}</strong></div>
      <ChevronDown size={16} className="field-blade-point-chevron" aria-hidden="true" />
    </summary>
    <div className="field-blade-detail">
      <div className="field-blade-detail-toolbar">
        {groups.length > 1 ? <label>观测组<CustomSelect aria-label={`${group.radialPointName} 观测组`} value={group.key} onChange={event => setSelected(event.target.value)}>{groups.map((item, index) => <option key={item.key} value={item.key}>{index === 0 ? "最新 · " : ""}{groupMode(item)} · {timeText(bladeRecordingTiming(groupRecords(item)).startedAt)} · #{index + 1}</option>)}</CustomSelect></label> : <strong>{groupMode(group)}</strong>}
        <ExportButton label="导出测点 ZIP" ariaLabel={`导出叶片 ${group.bladeId} 测点 ${group.radialPointId}全部数据`} ids={exportIds} level="point" busy={busy} exporting={exporting} onExportTask={onExportTask} />
      </div>
      <div className="field-blade-group-meta"><span>{group.recordCount} 条记录 · {number(group.samples)} 样本</span><span>{uploadLabel(group)}</span></div>
      {group.executionMode === "manual_segments" && <p className="field-blade-note">同计划的分段累计覆盖；不代表同一物理圈的连续波形。</p>}
      {group.hasSimulation && <p className="field-blade-notice">本组含模拟数据，未计为实测回波观测。</p>}
      {!!group.diagnosticCount && <p className="field-blade-notice">{group.diagnosticCount} 个点位为未停稳判定测试记录，已计入采集覆盖；可能包含运动扰动，未计为正常测量观测。</p>}
      {group.planConflict && <p className="field-blade-notice">记录的点位计划或位置不一致，请核对原始记录；汇总不视为完整。</p>}
      <StationRecords key={group.key} group={group} onOpenRecording={onOpenRecording} />
    </div>
  </details>;
}

export function FieldBladeSummary({ recordings, syncItems = [], onOpenRecording, onExportTask, busy = false, exporting = false }: Props) {
  const summary = useMemo(() => summarizeBladeRecords(recordings, syncItems), [recordings, syncItems]);
  const exportTasks = useMemo(() => new Map(groupRecordingTasks(recordings).map(task => [task.key, task.records.map(record => record.id)])), [recordings]);
  const [taskKey, setTaskKey] = useState("");
  const [bladeKey, setBladeKey] = useState("");
  const task = summary.tasks.find(item => item.key === taskKey) || summary.tasks[0];
  const blade = task?.blades.find(item => item.key === bladeKey) || task?.blades[0];
  useEffect(() => {
    if (task && task.key !== taskKey) setTaskKey(task.key);
    if (blade && blade.key !== bladeKey) setBladeKey(blade.key);
  }, [task, blade, taskKey, bladeKey]);
  const points = useMemo(() => {
    const map = new Map<string, BladeRecordGroup[]>();
    for (const group of blade?.groups || []) { const items = map.get(group.radialPointId) || []; items.push(group); map.set(group.radialPointId, items); }
    return [...map.values()].map(items => items.sort((a, b) => b.latestAt - a.latestAt || a.key.localeCompare(b.key)))
      .sort((a, b) => a[0].radialPointName.localeCompare(b[0].radialPointName, "zh-CN", { numeric: true }));
  }, [blade]);
  const tabId = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function tabKey(event: React.KeyboardEvent, index: number) {
    if (!task || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const length = task.blades.length;
    const next = event.key === "Home" ? 0 : event.key === "End" ? length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + length) % length;
    setBladeKey(task.blades[next].key); tabs.current[next]?.focus();
  }
  return <section className="field-card field-servo-ui field-blade-summary" aria-label="叶片采集汇总">
    <div className="field-section-heading"><h2>叶片采集汇总</h2><span className="field-badge">{number(summary.taskCount)} 个任务 · {number(summary.collections.length)} 个叶片</span></div>
    {!task || !blade ? <div className="field-blade-empty">暂无可汇总的自动跟随或分段采集记录。</div> : <section className="field-blade-task" aria-label={task.taskName}>
      <div className="field-blade-task-picker"><label>采集任务<CustomSelect aria-label="选择汇总任务" value={task.key} onChange={event => { setTaskKey(event.target.value); setBladeKey(""); }}>{summary.tasks.map(item => <option key={item.key} value={item.key}>{item.taskName} · {[item.windFarm, item.turbine].filter(Boolean).join(" / ") || "未填写风机"} · {timeText(item.latestAt || null)}</option>)}</CustomSelect></label>
        <ExportButton label="导出任务 ZIP" ariaLabel={`导出任务 ${task.taskName}`} ids={exportTasks.get(task.key) || []} level="task" busy={busy} exporting={exporting} onExportTask={onExportTask} />
      </div>
      <div className="field-blade-task-meta"><span>{[task.windFarm && `风场 ${task.windFarm}`, task.turbine && `风机 ${task.turbine}`, `${task.blades.length} 个叶片`, `${task.pointCount} 个测点`, `${task.sessionCount} 次采集`].filter(Boolean).join(" · ")}</span><RecordingTiming records={task.blades.flatMap(item => item.groups.flatMap(groupRecords))} /></div>
      <div className="field-blade-tabs" role="tablist" aria-label="选择汇总叶片">{task.blades.map((item, index) => <button key={item.key} ref={element => { tabs.current[index] = element; }} type="button" role="tab" id={`${tabId}-tab-${index}`} aria-selected={blade.key === item.key} aria-controls={`${tabId}-panel`} tabIndex={blade.key === item.key ? 0 : -1} onKeyDown={event => tabKey(event, index)} onClick={() => setBladeKey(item.key)}>叶片 {item.bladeId}<span>{item.pointCount} 个测点</span></button>)}</div>
      <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-tab-${task.blades.indexOf(blade)}`} className="field-blade-collection" key={blade.key}>
        <div className="field-blade-collection-heading"><span>{blade.pointCount} 个测点 · {blade.sessionCount} 次采集</span><ExportButton label="导出叶片 ZIP" ariaLabel={`导出叶片 ${blade.bladeId}全部数据`} ids={recordingExportIds(recordings, task.key, blade.bladeId)} level="blade" busy={busy} exporting={exporting} onExportTask={onExportTask} /></div>
        <div className="field-blade-points">{points.map(groups => <PointSummary key={groups[0].radialPointId} groups={groups} exportIds={recordingExportIds(recordings, task.key, blade.bladeId, groups[0].radialPointId)} busy={busy} exporting={exporting} onExportTask={onExportTask} onOpenRecording={onOpenRecording} />)}</div>
      </div>
      <details className="field-blade-explanation"><summary>统计说明</summary><p>已采集 / 计划点位按当前所选观测组统计，测试记录单独标注；重采记录可展开“历史”查看。分段采集仅累计相同坐标计划，其他批次和轮次分别展示。</p><p>采集时长按已保存样本数 ÷ 采样率计算，不含换点间隔。叶片编号由人工指定；点位记录不代表连续整圈测量，也不等于已核实叶片身份。</p></details>
    </section>}
    {summary.ungroupedCount > 0 && <p className="field-blade-note">{summary.ungroupedCount} 条点位记录缺少有效的批次或测点信息，仍可在原始记录列表查看。</p>}
  </section>;
}
