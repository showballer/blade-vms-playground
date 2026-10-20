import React, { useMemo, useState } from "react";
import type { FieldRecording, FieldSyncItem } from "./field-types";
import { bladeStationLabel, bladeRecordingTiming, summarizeBladeRecords, type BladeRecordGroup, type BladeStationState } from "./field-blade-summary-data";

const number = (value: number) => value.toLocaleString("zh-CN");
const timeText = (milliseconds: number | null) => milliseconds === null ? "未记录" : new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
export function bladeDurationText(seconds: number | null): string {
  if (seconds === null) return "未知";
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3600000), minutes = Math.floor(millis % 3600000 / 60000), rest = millis % 60000 / 1000;
  return `${hours ? `${hours} 小时 ` : ""}${minutes ? `${minutes} 分 ` : ""}${rest.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 秒`;
}
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
  return "计划点位已记录";
}
function uploadLabel(group: BladeRecordGroup) {
  if (!group.recordCount) return "尚无记录";
  const parts = [];
  if (group.uploadedCount) parts.push(`${group.uploadedCount} 已上传`);
  if (group.pendingUploadCount) parts.push(`${group.pendingUploadCount} 待上传`);
  if (group.failedUploadCount) parts.push(`${group.failedUploadCount} 上传异常`);
  if (group.unknownUploadCount) parts.push(`${group.unknownUploadCount} 同步状态未知`);
  return parts.join(" · ");
}

export function FieldBladeSummary({ recordings, syncItems = [], onOpenRecording }: {
  recordings: readonly FieldRecording[];
  syncItems?: readonly FieldSyncItem[];
  onOpenRecording?: (id: string) => void;
}) {
  const summary = useMemo(() => summarizeBladeRecords(recordings, syncItems), [recordings, syncItems]);
  const [visible, setVisible] = useState(12);
  const totals = summary.groups.reduce((sum, group) => ({ observed: sum.observed + group.observedCount,
    gaps: sum.gaps + group.gapCount, pending: sum.pending + group.pendingCount,
    failures: sum.failures + group.failedCount + group.incompleteCount }), { observed: 0, gaps: 0, pending: 0, failures: 0 });
  return <section className="field-card field-servo-ui field-blade-summary" aria-label="叶片采集汇总">
    <div className="field-section-heading"><div><h2>叶片采集汇总</h2><p>按风机任务、叶片和测点归档，每次采集保留独立记录。</p></div>
      <span className="field-badge">{number(summary.taskCount)} 个任务 · {number(summary.collections.length)} 个叶片</span></div>
    {!summary.groups.length ? <div className="field-blade-empty">暂无可汇总的自动跟随记录。采集并保存点位数据后会显示在这里。</div> : <>
      <dl className="field-blade-totals">
        <div><dt>已观测点位</dt><dd>{number(totals.observed)}</dd></div>
        <div><dt>回波缺口</dt><dd>{number(totals.gaps)}</dd></div>
        <div><dt>失败或未完成</dt><dd>{number(totals.failures)}</dd></div>
        <div><dt>未收到记录</dt><dd>{number(totals.pending)}</dd></div>
      </dl>
      <div className="field-blade-tasks">{summary.tasks.slice(0, visible).map(task => <section className="field-blade-task" key={task.key} aria-label={task.taskName}>
        <div className="field-blade-task-heading"><div><h3>{task.taskName}</h3><p>{task.windFarm && `风场 ${task.windFarm} · `}{task.turbine && `${task.turbine} · `}{task.blades.length} 个叶片 · {task.pointCount} 个测点 · {task.sessionCount} 次采集{task.collectionId ? ` · 任务 ${task.collectionId.slice(0, 8)}` : " · 历史采集批次"}</p>
          <RecordingTiming records={task.blades.flatMap(blade => blade.groups.flatMap(group => group.stations.flatMap(station => station.records)))} /></div></div>
        {task.blades.map(collection => <section className="field-blade-collection" key={collection.key} aria-label={`${collection.taskName} · 叶片 ${collection.bladeId}`}>
        <div className="field-blade-collection-heading"><h4>叶片 {collection.bladeId}</h4><span>{collection.pointCount} 个测点 · {collection.sessionCount} 次采集</span></div>
        <div className="field-blade-groups">{collection.groups.map(group => <details className="field-blade-group" key={group.key}>
        <summary>
          <div className="field-blade-identity"><strong>叶片 {group.bladeId} · {group.radialPointName}</strong><span>{group.radiusM === null ? "半径未记录" : `半径 ${(group.radiusM * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} cm`} · 第 {group.lapIndex} 轮 · 批次 {group.sessionId.slice(0, 8)}</span></div>
          <div className="field-blade-count"><strong>{group.observedCount}<span> / {group.plannedCount ?? "—"}</span></strong><span>观测 / 计划点位</span></div>
          <div className="field-blade-record-count"><strong>{number(group.samples)}</strong><span>样本 · {group.recordCount} 条记录</span></div>
          <div className="field-blade-state"><span className={`field-badge ${group.failedCount || group.planConflict ? "red" : group.gapCount || group.incompleteCount || group.pendingCount || group.plannedCount === null ? "amber" : "green"}`}>{groupLabel(group)}</span><span>{uploadLabel(group)}</span></div>
        </summary>
        <div className="field-blade-detail">
          <RecordingTiming records={group.stations.flatMap(station => station.records)} />
          {group.hasSimulation && <p className="field-blade-notice">本组含模拟数据，未计为实测回波观测。</p>}
          {group.planConflict && <p className="field-blade-notice">同批次记录的点位计划或位置不一致，请核对原始记录；汇总不视为完整。</p>}
          <div className="field-table-scroll"><table aria-label={`叶片 ${group.bladeId} ${group.radialPointName} 第 ${group.lapIndex} 轮点位`}>
            <thead><tr><th>点位</th><th>方位角</th><th>观测结果</th><th>记录样本</th><th>采集时间</th><th>采集时长</th><th>原始记录</th></tr></thead>
            <tbody>{group.stations.map(station => <tr key={station.id}>
              <td>点位 {station.index}{!station.planned && <small>计划未确认</small>}</td>
              <td className="mono">{station.azimuthDeg === null ? "—" : `${station.azimuthDeg.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}°`}</td>
              <td><span className={`field-badge ${stationTone(station.state)}`}>{bladeStationLabel(station.state)}</span></td>
              <td className="mono">{station.records.length ? number(station.samples) : "—"}</td>
              <td>{station.records.length ? <div className="field-blade-record-times">{station.records.map((record, index) => {
                const timing = bladeRecordingTiming([record]);
                return <div key={record.id}>{station.records.length > 1 && <strong>记录 {index + 1} · </strong>}开始 {timeText(timing.startedAt)}<small>结束 {timeText(timing.endedAt)}</small></div>;
              })}</div> : "—"}</td>
              <td className="mono">{station.records.length ? <div className="field-blade-record-times">{station.records.map((record, index) => <div key={record.id}>{station.records.length > 1 && `记录 ${index + 1} · `}{bladeDurationText(bladeRecordingTiming([record]).durationSeconds)}</div>)}</div> : "—"}</td>
              <td>{station.records.length ? <div className="field-blade-record-links">{station.records.map((record, index) => onOpenRecording
                ? <button type="button" className="btn ghost" key={record.id} onClick={() => onOpenRecording(record.id)} title={record.name}>{station.records.length > 1 ? `记录 ${index + 1}` : "查看记录"}</button>
                : <span key={record.id}>{record.name}</span>)}</div> : <span className="muted">未收到记录</span>}</td>
            </tr>)}</tbody>
          </table></div>
          {group.stations.some(station => station.records.length > 1) && <p className="field-blade-note">同一点位保留全部记录；观测结果按最近一条记录显示，样本数为记录合计。</p>}
          {group.pendingCount > 0 && <p className="field-blade-note">未收到记录的点位可能尚未采集、采集中断或尚未同步，不能仅据此判断设备故障。</p>}
        </div>
      </details>)}</div></section>)}
      </section>)}</div>
      {visible < summary.tasks.length && <button type="button" className="btn outline field-blade-more" onClick={() => setVisible(value => value + 12)}>显示更多（剩余 {summary.tasks.length - visible} 个任务）</button>}
      <p className="field-blade-note">采集时长按已保存样本数 ÷ 采样率计算，记录之间的换点间隔不计入；采集时间显示本机记录的开始与结束时间。</p>
      <p className="field-blade-note">RSSI 用于识别回波进入和离开，叶片编号由人工指定。点位记录不代表连续整圈测量，也不等于已核实叶片身份。</p>
    </>}
    {summary.ungroupedCount > 0 && <p className="field-blade-note">{summary.ungroupedCount} 条点位记录缺少有效的批次或测点信息，仍可在原始记录列表查看。</p>}
  </section>;
}
