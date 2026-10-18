"use client";
import React from "react";
import type { FieldStatus } from "./field-types";

const labels: Record<string, string> = {
  checking: "检查设备", positioning: "核对目标点位", starting_capture: "启动当前点采集", waiting_blade: "等待叶片进入",
  confirming_entry: "正在确认叶片进入", blade_present: "已确认进入 · 叶片经过中",
  confirming_exit: "正在确认叶片离开", blade_left: "已确认离开 · 准备换点",
  moving: "正在移动到点位", arrived: "已到位", capturing: "定时采集中",
  saving: "保存当前点记录", record_saved: "当前点记录已保存", returning: "返回循环起点",
  complete: "循环完成", cancelled: "已停止", error: "流程异常", signal_reset: "信号中断 · 重新等待叶片",
};
const steps = ["等待叶片", "确认进入", "叶片经过中", "确认离开", "已离开", "移动到下一点", "到位"];
const phaseStep: Record<string, number> = { waiting_blade: 0, confirming_entry: 1, blade_present: 2, confirming_exit: 3, blade_left: 4, moving: 5, returning: 5, arrived: 6 };
const value = (n?: number | null) => n == null ? "—" : n.toFixed(2);

export function FieldCycleProgress({ status }: { status: FieldStatus | null }) {
  const cycle = status?.pointCycle;
  if (!cycle) return null;
  const phase = cycle.processPhase || cycle.state;
  const log = cycle.processEvents || [];
  const last = log.at(-1);
  const terminal = ["complete", "cancelled", "error"].includes(cycle.state);
  const displayedPhase = terminal ? cycle.state : phase;
  return <section className="field-card field-cycle-progress" aria-label="叶片跟随流程">
    <div className="field-section-heading"><h3>叶片跟随流程</h3><span className={`field-badge ${cycle.state === "error" ? "red" : cycle.state === "complete" ? "green" : "amber"}`}>{labels[displayedPhase] || displayedPhase}</span></div>
    <p role="status">第 {cycle.cycle}/{cycle.cycles} 圈 · {last?.point || cycle.currentPoint || "准备中"} · 已保存 {cycle.completedRecords}/{cycle.totalRecords} 条</p>
    {cycle.rssiTriggerEnabled && <><ol className="field-cycle-steps" aria-label="跟随步骤">{steps.map((label, index) => <li key={label} aria-current={!terminal && phaseStep[phase] === index ? "step" : undefined}>{label}</li>)}</ol>
      <p className="field-subtext">最近采集 RSSI {value(cycle.latestRssi)}% · 窗内波动 {value(cycle.rssiSpread)} 个百分点</p>
      <p className="field-subtext">进入确认 {cycle.rssiEntryMs?.toFixed(0) || 0}/{cycle.rssiEnterConfirmMs ?? 20} ms · 离开确认 {cycle.rssiBelowMs?.toFixed(0) || 0}/{cycle.rssiConfirmMs ?? 30} ms</p>
      <p className="field-subtext">只有确认进入后，持续满足离开条件才会换点。信号中断重新判定，超时停止。</p></>}
    {cycle.error && <p className="field-error">{cycle.error}</p>}
    <details open><summary>动作日志 · 最近 {log.length} 条</summary><ol className="field-cycle-log" aria-label="跟随动作日志">{log.map(event => <li key={event.sequence}>
      <time>{new Date(event.at * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, fractionalSecondDigits: 3 })}</time>
      <span>{event.point || "—"} · {labels[event.phase] || event.phase}{event.sampleElapsedSeconds != null ? ` · 采样 ${event.sampleElapsedSeconds.toFixed(3)} s` : ""}{event.rssiSpread != null ? ` · 波动 ${event.rssiSpread.toFixed(2)}` : ""}{event.error ? ` · ${event.error}` : ""}</span>
    </li>)}</ol></details>
  </section>;
}
