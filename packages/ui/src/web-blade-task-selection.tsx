"use client";
import React, { useState } from "react";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { fieldDate } from "./field-types";
import { bladeDurationText } from "./field-blade-summary";
import { bladeRecordingTiming, bladeStationLabel, type BladeRecordGroup } from "./field-blade-summary-data";
import { activeBladePassGroup, bladePassMetadata, bladePassNumber as number, bladePassPointGroups,
  bladePassTaskLabel, bladePassUnavailableReason, defaultBladePassGroupSelection,
  type BladePassTask, type BladePassPointGroup, type BladePassGroupSelection, type BladePassRecording } from "./web-blade-passes-data";

type Props = {
  tasks: BladePassTask[]; taskKeys: string[]; selected: string[]; loading: boolean;
  groupKeys?: BladePassGroupSelection;
  onTask: (task: BladePassTask, checked: boolean) => void;
  onBlade?: (current: BladePassTask, next: BladePassTask) => void;
  onGroup?: (task: BladePassTask, point: BladePassPointGroup, group: BladeRecordGroup) => void;
  onRecords: (task: BladePassTask, ids: string[], checked: boolean) => void;
  onRestore: () => void; onClear: () => void;
};
const timeText = (milliseconds: number | null) => milliseconds === null ? "未记录" : new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
const groupMode = (group: BladeRecordGroup) => group.executionMode === "manual_segments" ? `分段累计 · ${group.sessionIds.length} 次采集` : `自动跟随 · 第 ${group.lapIndex} 轮`;
const groupStatus = (group: BladeRecordGroup) => group.planConflict ? "计划信息不一致" : group.failedCount ? "含失败记录" : group.plannedCount === null ? "缺少点位计划" :
  group.gapCount || group.incompleteCount || group.pendingCount ? "观测不完整" : group.diagnosticCount ? "采集完成（含测试）" : "计划点位已记录";
function RecordingTiming({ records }: { records: BladePassRecording[] }) {
  const at = bladeRecordingTiming(records);
  return <p className="blade-analysis-timing">采集时间：{timeText(at.startedAt)} → {at.openEnded ? "结束时间未完整记录" : timeText(at.endedAt)}<span>累计采集时长：<strong>{bladeDurationText(at.durationSeconds)}</strong>{at.partialDuration && "（部分时长未知）"}</span></p>;
}

export function BladeTaskSelection({ tasks, taskKeys, selected, groupKeys = {}, loading, onTask, onBlade, onGroup, onRecords, onRestore, onClear }: Props) {
  const [query, setQuery] = useState("");
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const collections = [...new Map(tasks.map(task => [task.collection.key, task.collection])).values()];
  const visible = collections.filter(collection => terms.every(term => [collection.taskName, collection.collectionId,
    collection.windFarm, collection.turbine, collection.measurementObject,
    ...collection.blades.flatMap(blade => blade.groups.map(group => group.radialPointName))].join(" ").toLocaleLowerCase().includes(term)));
  const chosenTasks = tasks.filter(task => taskKeys.includes(task.key));
  return <>
    <fieldset className="blade-task-picker" disabled={loading}>
      <legend>1 · 选择采集任务（可多选）</legend>
      <p className="blade-pass-note">共 {collections.length} 个任务 · {tasks.length} 个叶片</p>
      <p className="blade-pass-note">按采集任务 → 叶片 → 测点 → 观测组统计，与本机“叶片采集汇总”一致。跨任务组合需确认同一根实体叶片。</p>
      <label className="blade-task-search">查找任务或测点<input type="search" aria-label="查找任务或测点" placeholder="任务名、任务编号、风场、风机、P1 / P2…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="blade-task-options" aria-label="任务多选列表">{visible.map(collection => {
        const blades = tasks.filter(task => task.collection.key === collection.key);
        const chosen = blades.find(task => taskKeys.includes(task.key));
        return <label key={collection.key} className={chosen ? "selected" : ""}>
          <input type="checkbox" aria-label={`选择任务 ${collection.taskName} · ${collection.collectionId?.slice(0, 8) || "缺少任务归属"}`} checked={!!chosen}
            onChange={event => onTask(chosen ?? blades[0], event.target.checked)} />
          <span><strong>{collection.taskName}</strong><small>{[collection.windFarm, collection.turbine, collection.measurementObject].filter(Boolean).join(" / ") || "对象信息未填写"} · 任务 {collection.collectionId?.slice(0, 8) || "未记录"}</small>
            <small>{collection.blades.length} 个叶片 · {collection.pointCount} 个测点 · {collection.sessionCount} 次采集</small></span>
        </label>;
      })}</div>
      {!visible.length && <p className="blade-pass-empty">{loading ? "正在加载采集任务…" : tasks.length ? "没有匹配的任务，请调整搜索词。" : "暂无可按批次、叶片和测点汇总的记录。"}</p>}
    </fieldset>
    <div className="blade-pass-step-heading"><div><strong>2 · 选择叶片并多选测点</strong><span>每个任务选择一根叶片；默认使用各测点的最新观测组，可切换历史组。</span></div>
      <div className="blade-pass-step-actions"><span>已选 {chosenTasks.length} 个任务</span><Button type="button" disabled={loading || !chosenTasks.length} onClick={onRestore}>恢复自动选择</Button><Button type="button" variant="ghost" disabled={loading || !selected.length} onClick={onClear}>清空测点</Button></div>
    </div>
    {!chosenTasks.length && <p className="blade-pass-empty">请在上方勾选采集任务，再选择叶片和测点。</p>}
    {chosenTasks.map(task => {
      const points = bladePassPointGroups(task), ids = new Set(selected);
      const selectedCount = task.records.filter(record => ids.has(record.id)).length;
      const selectedPointCount = points.filter(point => point.records.some(record => ids.has(record.id))).length;
      const allRecords = tasks.filter(item => item.collection.key === task.collection.key).flatMap(item => item.records);
      return <section className="blade-task-workspace" key={task.key} data-task-key={task.key} aria-label={`任务测点 ${bladePassTaskLabel(task)}`}>
        <header><div><h3>{task.name}</h3><p>风场 {task.windFarm || "未填写"} · 风机 {task.turbine || "未填写"} · {task.collection.blades.length} 个叶片 · {task.collection.pointCount} 个测点 · {task.collection.sessionCount} 次采集</p></div>
          <strong aria-live="polite">已选 {selectedPointCount}/{points.length} 个测点 · {selectedCount}/64 条记录</strong></header>
        <RecordingTiming records={allRecords} />
        <div className="blade-analysis-tabs" role="tablist" aria-label={`${task.name} 叶片`}>{tasks.filter(item => item.collection.key === task.collection.key).map(blade =>
          <button key={blade.key} type="button" role="tab" aria-selected={blade.key === task.key} disabled={loading} tabIndex={blade.key === task.key ? 0 : -1}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const buttons = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>("[role=tab]"));
              const index = buttons.indexOf(event.currentTarget), next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next].click(); buttons[next].focus();
            }} onClick={() => { if (blade.key !== task.key) onBlade?.(task, blade); }}>
            叶片 {blade.bladeId}<small>{blade.summary.pointCount} 个测点</small></button>)}</div>
        <p className="blade-pass-note">当前叶片 {task.bladeId} · {task.summary.pointCount} 个测点 · {task.summary.sessionCount} 次采集 · {task.records.length} 条记录（含历史重采）</p>
        <fieldset className="blade-pass-points" disabled={loading}><legend>本任务测点（可多选）</legend>{points.map(point => {
          const group = activeBladePassGroup(task, point, groupKeys), groupRecords = group.stations.flatMap(station => station.records);
          const count = groupRecords.filter(record => ids.has(record.id)).length;
          const defaults = defaultBladePassGroupSelection(group), at = bladeRecordingTiming(groupRecords);
          return <div className={`blade-pass-point-group${count ? " selected" : ""}`} key={point.id}>
            <label><input type="checkbox" aria-label={`选择测点 ${point.name}`} checked={count > 0} disabled={!defaults.length && !count}
              onChange={event => onRecords(task, event.target.checked ? defaults : point.records.map(record => record.id), event.target.checked)} />
              <span><strong>{point.name}</strong><small>距中心 {group.radiusM === null ? "未记录" : `${number(group.radiusM * 100)} cm`} · 已选 {count} 条</small></span>
              <span className="blade-analysis-coverage"><strong>{group.observedCount + group.diagnosticCount} / {group.plannedCount ?? "—"}</strong><small>{groupStatus(group)}</small></span></label>
            <label className="blade-analysis-group">观测组<CustomSelect aria-label={`${point.name} 观测组`} value={group.key} onChange={event => {
              const next = point.groups.find(item => item.key === event.target.value); if (next) onGroup?.(task, point, next);
            }}>{point.groups.map((item, index) => <option key={item.key} value={item.key}>{index === 0 ? "最新 · " : ""}{groupMode(item)} · {timeText(bladeRecordingTiming(item.stations.flatMap(station => station.records)).startedAt)} · #{index + 1}</option>)}</CustomSelect></label>
            <p className="blade-pass-note">{groupMode(group)} · 共 {point.groups.length} 组<br />采集时间：{timeText(at.startedAt)} · 时长：{bladeDurationText(at.durationSeconds)}{at.partialDuration && "（部分）"}</p>
            {group.hasSimulation && <p className="blade-pass-note">含模拟数据，默认不选入实测分析。</p>}
            {!defaults.length && <p className="blade-pass-note">当前组无可自动选择的实测记录；可展开核对状态及历史记录。</p>}
            <details><summary>圆周点位与采集记录（含未采集）</summary><div className="blade-pass-angle-list">{group.stations.map(station => <div className="blade-pass-angle-group" key={station.id}>
              <strong>{station.azimuthDeg === null ? "角度未知" : `${number(station.azimuthDeg)}°`} · {bladeStationLabel(station.state)}</strong>
              {!station.records.length && <p className="blade-pass-note">计划点位 · 未收到记录</p>}
              {station.records.map((record, index) => {
                const reason = bladePassUnavailableReason(record);
                return <label key={record.id}><input type="checkbox" aria-label={`选择记录 ${record.id}`} disabled={!!reason} checked={ids.has(record.id)} onChange={event => onRecords(task, [record.id], event.target.checked)} />
                  <span>{index ? "历史重采 · " : "最近采集 · "}{fieldDate(record.startedAt)?.toLocaleString("zh-CN", { hour12: false }) || "时间未知"}<small>{number(record.sampleRate)} Hz · {record.samples.toLocaleString()} 样本 · {reason || (bladePassMetadata(record)?.completion === "confirmed_pass" ? "完整经过" : "经过边界待确认")}{record.simulation || record.source === "simulation" ? " · 模拟数据" : ""}</small></span></label>;
              })}</div>)}</div></details>
          </div>;
        })}</fieldset>
        <p className="blade-pass-note">覆盖率按当前观测组的计划点位统计；只分析勾选记录。切换观测组会替换该测点的记录，不从其他组补齐角度。</p>
      </section>;
    })}
  </>;
}
