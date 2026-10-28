"use client";
import React from "react";
import type { FieldStatus } from "./field-types";

const labels: Record<string, string> = {
  segment_capture_finished: "本段采集结束", segment_daq_stopped: "本段已停止接收数据",
  positioning_next_segment: "准备下一段等待位置", moving_next_segment: "移动到下一段起点", waiting_manual_start: "已到下一段起点 · 等待人工开始",
  start_requested: "已收到采集请求", preparing_receiver: "准备测振连接", receiver_prepared: "测振连接已就绪", waiting_samples: "等待首批测振数据",
  entry_clear_revoked: "回波再次波动，重新识别进入前沿",
  arrival_evidence_rejected: "初段回波缺少测振佐证，继续等待叶片",
  waiting_entry_clear: "到位扰动过滤 · 等待新的叶片进入", entry_clear_confirmed: "首段扰动已结束 · 等待新进入",
  checking: "检查设备", positioning: "核对目标点位", starting_capture: "启动当前点采集", waiting_blade: "已就绪 · 等待叶片进入",
  confirming_entry: "正在确认叶片进入", blade_present: "已确认进入 · 叶片经过中",
  waiting_background: "准备判定 · 等待稳定回波基线", background_ready: "回波背景已记录",
  partial_pass_ignored: "未见起始背景 · 忽略本段回波",
  pass_baseline_mismatch: "回波基线变化 · 舍弃本段并重新等待",
  confirming_exit: "正在确认叶片离开", blade_left: "已确认离开 · 准备换点",
  early_handoff_ready: "已收到提前经过 · 直接换点", finalizing_records: "整理并保存本轮记录",
  motion_stopped_before_laser_on: "两轴已停稳，准备开激光", laser_on: "开启激光", laser_on_confirmed: "激光已开启", laser_off: "关闭激光", laser_off_confirmed: "激光已关闭", moving: "正在移动到点位", arrived: "已到位", capturing: "定时采集中",
  saving: "保存当前点记录", record_saved: "当前点记录已保存", returning: "返回循环起点", returning_origin: "返回作业原点", origin_arrived: "已回到作业原点",
  complete: "循环完成", cancelled: "已停止", error: "流程异常", signal_reset: "信号中断 · 重新等待叶片",
};
const steps = ["等待叶片", "确认进入", "叶片经过中", "确认离开", "已离开", "移动到下一点", "到位"];
const phaseStep: Record<string, number> = { waiting_entry_clear: 0, entry_clear_confirmed: 0, waiting_background: 0, background_ready: 0, partial_pass_ignored: 0, waiting_blade: 0, confirming_entry: 1, blade_present: 2, confirming_exit: 3, blade_left: 4, moving: 5, returning: 5, returning_origin: 5, origin_arrived: 6, arrived: 6 };
const value = (n?: number | null) => n == null ? "—" : n.toFixed(2);

export function FieldCycleProgress({ status }: { status: FieldStatus | null }) {
  const cycle = status?.pointCycle;
  if (!cycle) return null;
  const segmented = cycle.executionMode === "manual_segments";
  const phase = cycle.processPhase || cycle.state;
  const log = cycle.processEvents || [];
  const last = log.at(-1);
  const terminal = ["complete", "cancelled", "error"].includes(cycle.state);
  const judging = !terminal && ["waiting_entry_clear", "entry_clear_confirmed", "waiting_background", "background_ready", "partial_pass_ignored", "waiting_blade", "confirming_entry", "blade_present", "confirming_exit", "blade_left"].includes(phase);
  const displayedPhase = segmented && cycle.state === "complete" && cycle.waitingPoint ? "waiting_manual_start" : terminal ? cycle.state : phase;
  return <section className="field-card field-cycle-progress field-servo-ui" aria-label="叶片跟随流程">
    <div className="field-section-heading"><h3>叶片跟随流程</h3><span className={`field-badge ${cycle.state === "error" ? "red" : cycle.state === "complete" ? "green" : "amber"}`}>{labels[displayedPhase] || displayedPhase}</span></div>
    <div className="field-cycle-summary"><p role="status">{segmented ? "本段" : `第 ${cycle.cycle}/${cycle.cycles} 轮`} · {last?.point || cycle.currentPoint || "准备中"} · 已保存 {cycle.completedRecords}/{cycle.totalRecords} 条</p><progress aria-label="循环记录保存进度" value={cycle.completedRecords} max={Math.max(1, cycle.totalRecords)} /></div>
    {cycle.rssiTriggerEnabled && <><ol className="field-cycle-steps" aria-label="跟随步骤">{steps.map((label, index) => <li key={label} aria-current={!terminal && phaseStep[phase] === index ? "step" : undefined}>{label}</li>)}</ol>
      {judging && <><p className="field-subtext">最近采集 RSSI {value(cycle.latestRssi)}% · 窗内波动 {value(cycle.rssiSpread)} 个百分点</p>
      <p className="field-subtext">进入确认 {cycle.rssiEntryMs?.toFixed(0) || 0}/{cycle.rssiEnterConfirmMs ?? 20} ms · 离开确认 {cycle.rssiBelowMs?.toFixed(0) || 0}/{cycle.rssiConfirmMs ?? 30} ms</p></>}
      {judging && cycle.rssiFreshEntryRequired && <p className="field-subtext">{cycle.rssiEntryEdgeReady ? "等待新的进入" : `首段扰动过滤 ${cycle.rssiEntryClearMs?.toFixed(0) || 0}/${cycle.rssiConfirmMs ?? 30} ms`}</p>}
      {judging && cycle.mode === "automatic_stations" && <p className="field-subtext">回波背景{cycle.rssiBackgroundReady ? "已确认" : "尚未确认"}</p>}
    </>}
    {cycle.error && <p className="field-error">{cycle.error}</p>}
    <details open><summary>动作日志 · 最近 {log.length} 条</summary><ol className="field-cycle-log" aria-label="跟随动作日志">{log.map(event => <li key={event.sequence}>
      <time>{new Date(event.at * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, fractionalSecondDigits: 3 })}</time>
      <span>{event.point || "—"} · {labels[event.phase] || event.phase}{event.sampleElapsedSeconds != null ? ` · 采样 ${event.sampleElapsedSeconds.toFixed(3)} s` : ""}{event.rssiSpread != null ? ` · 波动 ${event.rssiSpread.toFixed(2)}` : ""}{event.error ? ` · ${event.error}` : ""}</span>
    </li>)}</ol></details>
  </section>;
}
