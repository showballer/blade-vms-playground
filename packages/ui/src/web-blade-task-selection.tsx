"use client";
import React from "react";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { fieldDate } from "./field-types";
import { bladePassExecutionLabel, bladePassIsDiagnostic, bladePassMetadata, bladePassNumber as number,
  bladePassPointGroups, bladePassRecordLabel, defaultBladePassSelection, type BladePassTask } from "./web-blade-passes-data";

type Props = {
  tasks: BladePassTask[]; taskKey: string; selected: string[]; loading: boolean; includeDiagnostic: boolean;
  onTask: (key: string) => void; onRecords: (ids: string[], checked: boolean) => void;
  onRestore: () => void; onDiagnostic: (include: boolean) => void;
};
export function BladeTaskSelection({ tasks, taskKey, selected, loading, includeDiagnostic, onTask, onRecords, onRestore, onDiagnostic }: Props) {
  const task = tasks.find(item => item.key === taskKey), points = bladePassPointGroups(task);
  const collections = [...new Map(tasks.map(item => [item.taskKey, item])).values()];
  const blades = tasks.filter(item => item.taskKey === task?.taskKey);
  const ids = new Set(selected), recommended = new Set(defaultBladePassSelection(task, includeDiagnostic));
  const diagnostics = task?.records.filter(bladePassIsDiagnostic).length ?? 0;
  return <div className="blade-task-selection">
    <div className="blade-task-context">
      <label>采集任务<CustomSelect searchable searchPlaceholder="搜索任务、风场或风机" aria-label="采集任务" value={task?.taskKey ?? ""} disabled={loading || !tasks.length} onChange={event => onTask(tasks.find(item => item.taskKey === event.target.value)?.key ?? "")}>
        {!tasks.length && <option value="">{loading ? "正在加载记录…" : "暂无叶片采集任务"}</option>}
        {collections.map(item => <option key={item.taskKey} value={item.taskKey}>{item.name} · {[item.windFarm, item.turbine].filter(Boolean).join(" / ") || "对象未填写"} · {item.collectionId.slice(0, 8)}</option>)}
      </CustomSelect></label>
      {task && <div className="blade-task-context-note"><span>与叶片采集汇总使用相同任务归属</span><strong>{task.records.length} 条原始记录</strong><small>{fieldDate(task.latestAt / 1000)?.toLocaleString("zh-CN", { hour12: false }) || ""}</small></div>}
    </div>
    {task && <>
      <div className="blade-task-blades" role="group" aria-label="选择叶片">{blades.map(blade => <button type="button" key={blade.key} aria-pressed={blade.key === taskKey} className={blade.key === taskKey ? "selected" : ""} onClick={() => onTask(blade.key)}><strong>叶片 {blade.bladeId}</strong><span>{bladePassPointGroups(blade).length} 个测点</span></button>)}</div>
      {diagnostics > 0 && <div className="blade-task-diagnostic"><label><input type="checkbox" aria-label="纳入诊断数据分析" checked={includeDiagnostic} onChange={event => onDiagnostic(event.target.checked)} />纳入诊断数据分析<span className="field-badge amber">{diagnostics} 条</span></label><p>这些记录保留了经过边界，但采集时启用了诊断模式，尚未确认为有效测量。结果用于流程与信号检查。</p></div>}
      <div className="blade-pass-step-heading"><div><strong>选择测点与圆周片段</strong><span>每个角度默认选择最近一次完整经过，可展开调整。</span></div><Button type="button" disabled={loading} onClick={onRestore}>恢复推荐选择</Button></div>
      <div className="blade-pass-point-grid">{points.map(point => {
        const count = point.records.filter(record => ids.has(record.id)).length;
        const defaults = point.records.filter(record => recommended.has(record.id)).map(record => record.id);
        return <section className={`blade-pass-point-group${count ? " selected" : ""}`} key={point.id} aria-label={`测点 ${point.name}`}>
          <label className="blade-point-choice"><input type="checkbox" aria-label={`选择测点 ${point.name}`} checked={count > 0} disabled={!count && !defaults.length} onChange={event => onRecords(event.target.checked ? defaults : point.records.map(record => record.id), event.target.checked)} /><span><strong>{point.name}</strong><small>距中心 {number(point.radius == null ? undefined : point.radius * 100)} cm</small></span><b>已选 {count}/{point.records.length}</b></label>
          <div className="blade-pass-angle-chips">{point.angles.map(angle => <span className={angle.records.some(record => ids.has(record.id)) ? "selected" : ""} key={angle.key}>{angle.azimuthDeg == null ? "未知" : `${number(angle.azimuthDeg)}°`}</span>)}</div>
          <details><summary>角度与原始记录</summary><div className="blade-pass-angle-list">{point.angles.map(angle => <div className="blade-pass-angle-group" key={angle.key}><strong>{angle.azimuthDeg == null ? "角度未知" : `${number(angle.azimuthDeg)}°`}</strong>{angle.records.map(record => <label key={record.id}>
            <input type="checkbox" aria-label={`选择记录 ${record.id}`} checked={ids.has(record.id)} disabled={!includeDiagnostic && bladePassIsDiagnostic(record)} onChange={event => onRecords([record.id], event.target.checked)} />
            <span>{bladePassRecordLabel(record)}<small>{bladePassExecutionLabel(record)} · {fieldDate(record.startedAt)?.toLocaleString("zh-CN", { hour12: false }) || "时间未知"}</small><small>{record.samples.toLocaleString()} 样本 · {number(record.sampleRate)} Hz</small></span>
          </label>)}</div>)}</div></details>
        </section>;
      })}</div>
      {task.records.length > 64 && <p className="blade-pass-note">单次最多分析 64 条记录；推荐选择均衡覆盖各测点及角度。</p>}
    </>}
  </div>;
}
