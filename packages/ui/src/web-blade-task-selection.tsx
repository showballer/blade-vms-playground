"use client";
import React, { useState } from "react";
import { Button } from "./common";
import { fieldDate } from "./field-types";
import { bladePassExecutionLabel, bladePassMetadata, bladePassNumber as number, bladePassPointGroups,
  bladePassTaskLabel, defaultBladePassSelection, type BladePassTask } from "./web-blade-passes-data";

type Props = {
  tasks: BladePassTask[]; taskKeys: string[]; selected: string[]; loading: boolean;
  onTask: (task: BladePassTask, checked: boolean) => void;
  onRecords: (task: BladePassTask, ids: string[], checked: boolean) => void;
  onRestore: () => void; onClear: () => void;
};
const angleLabel = (angle: number | null | undefined) => angle == null ? "角度未知" : `${number(angle)}°`;

export function BladeTaskSelection({ tasks, taskKeys, selected, loading, onTask, onRecords, onRestore, onClear }: Props) {
  const [query, setQuery] = useState("");
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = tasks.filter(task => terms.every(term => [bladePassTaskLabel(task), task.object,
    ...bladePassPointGroups(task).map(point => point.name)].join(" ").toLocaleLowerCase().includes(term)));
  const chosenTasks = tasks.filter(task => taskKeys.includes(task.key));
  return <>
    <fieldset className="blade-task-picker" disabled={loading}>
      <legend>1 · 选择采集任务（可多选）</legend>
      <p className="blade-pass-note">勾选任务后自动选择该任务的相关测点。同名测点按任务和叶片分别列出。</p>
      <label className="blade-task-search">查找任务或测点<input type="search" aria-label="查找任务或测点" placeholder="任务名、任务编号、风场、风机、P1 / P2…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="blade-task-options" aria-label="任务多选列表">{visible.map(task => {
        const points = bladePassPointGroups(task), checked = taskKeys.includes(task.key);
        return <label key={task.key} className={checked ? "selected" : ""}>
          <input type="checkbox" aria-label={`选择任务 ${bladePassTaskLabel(task)}`} checked={checked} onChange={event => onTask(task, event.target.checked)} />
          <span><strong>{task.name}</strong><small>叶片 {task.bladeId} · 任务 {task.collectionId.slice(0, 8)} · {[task.windFarm, task.turbine, task.object].filter(Boolean).join(" / ") || "对象信息未填写"}</small><small>{points.map(point => point.name).join("、")} · {points.length} 个测点 · {task.records.length} 条记录</small></span>
        </label>;
      })}</div>
      {!visible.length && <p className="blade-pass-empty">{loading ? "正在加载采集任务…" : tasks.length ? "没有匹配的任务，请调整搜索词。" : "暂无带完整任务、叶片和测点归属的已保存记录。"}</p>}
    </fieldset>
    <div className="blade-pass-step-heading"><div><strong>2 · 核对并多选测点</strong><span>每个任务独立选择、独立分析；更改一个任务不会清除其他任务的勾选。</span></div>
      <div className="blade-pass-step-actions"><span>已选 {chosenTasks.length} 个任务</span><Button type="button" disabled={loading || !chosenTasks.length} onClick={onRestore}>恢复自动选择</Button><Button type="button" variant="ghost" disabled={loading || !selected.length} onClick={onClear}>清空测点</Button></div>
    </div>
    {!chosenTasks.length && <p className="blade-pass-empty">请在上方勾选任务；可以同时选择多个任务，再核对各任务的测点。</p>}
    {chosenTasks.map(task => {
      const points = bladePassPointGroups(task), ids = new Set(selected), recommended = new Set(defaultBladePassSelection(task));
      const selectedCount = task.records.filter(record => ids.has(record.id)).length;
      const selectedPointCount = points.filter(point => point.records.some(record => ids.has(record.id))).length;
      return <section className="blade-task-workspace" key={task.key} data-task-key={task.key} aria-label={`任务测点 ${bladePassTaskLabel(task)}`}>
        <header><div><h3>{task.name} · 叶片 {task.bladeId}</h3><p>任务 {task.collectionId.slice(0, 8)} · {[task.windFarm, task.turbine, task.object].filter(Boolean).join(" / ") || "对象信息未填写"}</p></div><strong aria-live="polite">已选 {selectedPointCount}/{points.length} 个测点 · {selectedCount}/64 条记录</strong></header>
        <fieldset className="blade-pass-points"><legend>本任务测点（可多选）</legend>{points.map(point => {
          const count = point.records.filter(record => ids.has(record.id)).length;
          const defaults = point.records.filter(record => recommended.has(record.id)).map(record => record.id);
          return <div className={`blade-pass-point-group${count ? " selected" : ""}`} key={point.id}>
            <label><input type="checkbox" aria-label={`选择测点 ${point.name}`} checked={count > 0} onChange={event => onRecords(task, event.target.checked ? defaults : point.records.map(record => record.id), event.target.checked)} /><span><strong>{point.name}</strong><small>半径 {number(point.radius)} m · 已选 {count}/{point.records.length} 条 · {point.angles.length} 个角度</small></span></label>
            {!defaults.length && <p className="blade-pass-note">暂无确认完整经过的记录，可展开查看原始状态。</p>}
            <details><summary>选择角度与采集记录</summary><div className="blade-pass-angle-list">{point.angles.map(angle => <div className="blade-pass-angle-group" key={angle.key}><strong>{angleLabel(angle.azimuthDeg)}</strong>{angle.records.map(record => <label key={record.id}>
              <input type="checkbox" aria-label={`选择记录 ${record.id}`} checked={ids.has(record.id)} onChange={event => onRecords(task, [record.id], event.target.checked)} />
              <span>{bladePassExecutionLabel(record)} · {fieldDate(record.startedAt)?.toLocaleString("zh-CN", { hour12: false }) || "时间未知"}<small>{number(record.sampleRate)} Hz · {record.samples.toLocaleString()} 样本 · {bladePassMetadata(record)?.completion === "confirmed_pass" ? "完整经过" : "经过边界待确认"}</small></span>
            </label>)}</div>)}</div></details>
          </div>;
        })}</fieldset>
        {points.length === 1 && <p className="blade-pass-note">此任务只保存了 {points[0].name}。其他任务可在上方加入并分别查看；不同任务不会自动归并成同一任务。</p>}
        {task.records.length > 64 && <p className="blade-pass-note">每个任务最多分析 64 条记录；自动选择优先覆盖各测点及角度，每个角度使用最新的完整经过记录。</p>}
      </section>;
    })}
  </>;
}
