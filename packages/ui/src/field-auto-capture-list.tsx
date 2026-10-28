"use client";
import React, { memo, useId, useMemo, useRef } from "react";
import { ChevronRight, Crosshair, LoaderCircle, Play, Square } from "lucide-react";
import { Button } from "./common";
import { captureRouteRequestBlockers, type FieldAutoCaptureTarget } from "./field-capture-route";
import { presetPositionRequestError } from "./field-preset-position";
import { getAutoCaptureTargetState, summarizeBladeRecords } from "./field-blade-summary-data";
import { fieldStartError, fieldCaptureConfig, fieldIsActive, validateFieldConfig, type FieldConfig, type FieldRecording, type FieldStatus } from "./field-types";

type Props = {
  segmented?: boolean;
  targets: readonly FieldAutoCaptureTarget[]; selectedTargetKey?: string; collectionId?: string;
  recordings?: readonly FieldRecording[]; config: FieldConfig; status: FieldStatus | null;
  busy: string; pollError: string; stopping?: boolean; onSelect?: (key: string) => void; onStart?: (key: string) => void;
  onConfigure?: (key: string) => void; onConfigureAll: () => void; onStop: () => void;
  onPosition?: (key: string) => void; onCancelPosition?: () => void; positionStopping?: boolean;
  onAutoMove?: (value: boolean) => void;
  startDisabledReason?: string;
  motionPanel?: React.ReactNode;
};
const noRecords: readonly FieldRecording[] = [];
const radius = (value: number) => Number.isFinite(value) && value > 0 ? `${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} cm` : "待设置";

/** The worker's recording takes precedence over any idle editor selection. */
export function activeAutoCaptureKey(targets: readonly FieldAutoCaptureTarget[], status: FieldStatus | null, selectedKey?: string): string | undefined {
  if (!fieldIsActive(status) || !status?.pointCycle) return undefined;
  const record = status.recording?.pointCycle;
  if (record?.mode === "automatic_stations" && record.bladeId && record.radialPointId) {
    const matches = targets.filter(target => target.bladeId === record.bladeId && target.pointId === record.radialPointId);
    if (matches.length === 1) return matches[0].key;
  }
  // Between stations there is no open recording. The acquisition coordinator
  // retains the started target for the entire run, including these gaps.
  return targets.some(target => target.key === selectedKey) ? selectedKey : undefined;
}

export const FieldAutoCaptureList = memo(function FieldAutoCaptureList({ segmented = false, targets, selectedTargetKey, collectionId, recordings = noRecords,
  config, status, busy, pollError, stopping = false, positionStopping = false, onSelect, onStart, onConfigureAll, onStop, onPosition, onCancelPosition, onAutoMove, startDisabledReason, motionPanel }: Props) {
  const active = fieldIsActive(status);
  const activeKey = activeAutoCaptureKey(targets, status, selectedTargetKey);
  const selected = targets.find(target => target.key === (active ? activeKey : selectedTargetKey)) || (!active ? targets[0] : undefined);
  const canStop = active || stopping || busy === "start";
  const disabled = active || !!busy || !!status?.turntableBusy || !!status?.deviceBusy;
  const configError = validateFieldConfig(fieldCaptureConfig(config));
  const serviceError = fieldStartError(status);
  const serviceNotice = fieldStartError(status ? { ...status, turntableBusy: false, deviceBusy: false } : status);
  const blockers = selected ? captureRouteRequestBlockers(selected.route, status) : ["请选择叶片和测点"];
  const positionError = presetPositionRequestError(selected?.route || null, status) || pollError;
  const reason = pollError || serviceError || configError || blockers[0] || startDisabledReason;
  const notice = pollError || serviceNotice || configError || blockers[0] || startDisabledReason || (positionError === "请等待当前任务结束" ? "" : positionError);
  const startDisabled = disabled || !!reason || !selected?.route.cycle || !onStart;
  const groups = useMemo(() => {
    const byBlade = new Map<string, { key: string; bladeId: string; targets: FieldAutoCaptureTarget[] }>();
    for (const target of targets) {
      const group = byBlade.get(target.bladeKey) || { key: target.bladeKey, bladeId: target.bladeId, targets: [] };
      group.targets.push(target); byBlade.set(target.bladeKey, group);
    }
    return [...byBlade.values()];
  }, [targets]);
  const saved = useMemo(() => {
    const summary = summarizeBladeRecords(recordings);
    return new Map(targets.map(target => [target.key, getAutoCaptureTargetState(recordings, { collectionId,
      bladeId: target.bladeId, radialPointId: target.pointId, cycles: target.cycles,
      stationCount: target.route.cycle?.executionMode === "manual_segments" ? target.route.cycle.totalStationCount ?? 0 : target.stations, radiusM: target.radiusM,
      windFarm: config.windFarm || "", turbine: config.turbine.trim() || config.name.trim(), measurementObject: config.object }, summary)]));
  }, [recordings, collectionId, targets, config.windFarm, config.turbine, config.name, config.object]);
  const cycle = status?.pointCycle;
  const completedPoint = cycle?.waitingPoint || cycle?.nextWaitPoint;
  const completedForSelection = !!selected && completedPoint?.bladeId === selected.bladeId && completedPoint.radialPointId === selected.pointId;
  const autoMove = selected?.route.cycle?.segmentedAutoMove !== false;
  const selectedBlade = groups.find(group => group.key === selected?.bladeKey) || groups[0];
  const tabId = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function selectBlade(index: number) {
    if (!disabled && onSelect && groups[index]?.targets[0]) onSelect(groups[index].targets[0].key);
  }
  function tabKey(event: React.KeyboardEvent, index: number) {
    if (disabled || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + groups.length) % groups.length;
    selectBlade(next); tabs.current[next]?.focus();
  }
  const progress = canStop ? stopping || status?.state === "stopping" ? "正在停止并保存" : busy === "start" || status?.state === "starting" ? "正在准备采集" : cycle ? `点位 ${Math.min(cycle.pointCount, cycle.point)}/${cycle.pointCount}` : "正在采集"
    : busy === "preposition" ? "正在定位" : segmented && completedForSelection && cycle?.state === "complete"
      ? cycle.waitingPoint ? `已保存 · 等待于 ${cycle.waitingPoint.azimuthDeg}°` : `已保存 · 待定位至 ${cycle.nextWaitPoint?.azimuthDeg}°`
      : "选择下方测点";
  const targetLabel = selected ? `叶片 ${selected.bladeId} · ${selected.pointName}` : "请选择测点";
  return <section className="field-auto-capture-list field-servo-ui" aria-label="风机叶片逐点采集">
    <div className="field-auto-capture-toolbar">
      <div className="field-auto-capture-current"><span>当前采集</span><strong title={targetLabel}>{targetLabel}</strong><small role="status">{progress}</small></div>
      <div className="field-auto-capture-action-group">
      {segmented && <label className="field-auto-move-toggle"><input type="checkbox" aria-label="自动移动" checked={autoMove} disabled={disabled || !onAutoMove} onChange={event => onAutoMove?.(event.target.checked)} />自动移动<span>采集完成后移到下一角度，等待手动开始</span></label>}
      <div className="field-auto-capture-actions">
        <Button type="button" className="field-auto-capture-position" variant={busy === "preposition" ? "danger" : "outline"}
          disabled={busy === "preposition" ? positionStopping || !onCancelPosition : disabled || !!positionError || !selected || !onPosition}
          title={busy === "preposition" ? undefined : positionError || undefined}
          aria-label={busy === "preposition" ? "停止定位" : `移动到预设位置：${targetLabel}`}
          onClick={() => busy === "preposition" ? onCancelPosition?.() : selected && onPosition?.(selected.key)}>
          {busy === "preposition" ? <Square size={18} /> : <Crosshair size={18} />}{busy === "preposition" ? "停止定位" : "移动到预设位置"}
        </Button>
        <Button type="button" className="field-auto-capture-primary" variant={canStop ? "danger" : "primary"} disabled={canStop ? stopping : startDisabled}
          title={canStop ? undefined : reason} aria-label={canStop ? "停止并保存" : `开始采集${targetLabel}`}
          onClick={() => canStop ? onStop() : selected && onStart?.(selected.key)}>
          {canStop ? stopping ? <LoaderCircle size={20} className="spin" /> : <Square size={18} /> : <Play size={20} />}{canStop ? "停止并保存" : "开始采集"}
        </Button>
      </div>
      </div>
    </div>
    <div className="field-auto-capture-feedback" role={!active && notice ? "status" : undefined}>{!active && notice ? notice : "\u00a0"}</div>
    <div className={`field-auto-capture-layout${motionPanel ? " has-motion" : ""}`}>
    <div className="field-auto-capture-points">
    <div className="field-auto-capture-heading"><h3>叶片与测点</h3><span className="field-badge">{groups.length} 个叶片 · {targets.length} 个测点</span></div>
    {!targets.length ? <div className="field-auto-capture-empty"><Button type="button" disabled={disabled} onClick={onConfigureAll}>配置{segmented ? "分段采集" : "自动跟随"}<ChevronRight size={14} /></Button></div> : <>
    <div className="field-blade-tabs field-auto-capture-blade-tabs" role="tablist" aria-label="选择采集叶片">{groups.map((group, index) => <button key={group.key} ref={element => { tabs.current[index] = element; }} type="button" role="tab" id={`${tabId}-tab-${index}`} aria-selected={selectedBlade?.key === group.key} aria-controls={`${tabId}-panel`} tabIndex={selectedBlade?.key === group.key ? 0 : -1} disabled={disabled || !onSelect} onKeyDown={event => tabKey(event, index)} onClick={() => selectBlade(index)}>叶片 {group.bladeId || "待设置"}<span>{group.targets.length} 个测点</span></button>)}</div>
    {selectedBlade && [selectedBlade].map(group => <section key={group.key} id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-tab-${groups.indexOf(group)}`} className="field-auto-capture-blade" aria-label={`叶片 ${group.bladeId || "待设置"} 采集测点`}>
      <div className="field-auto-capture-scroll" role="region" tabIndex={0} aria-label={`叶片 ${group.bladeId || "待设置"} 测点表，可横向滚动`}><table aria-label={`叶片 ${group.bladeId || "待设置"} 测点采集状态`}>
        <colgroup>{["point", "radius", "angles", "next", "state"].map(column => <col key={column} className={`field-auto-capture-col-${column}`} />)}</colgroup>
        <thead><tr><th scope="col">测点</th><th scope="col">距风机旋转中心</th><th scope="col">{segmented ? "本段圆周角度" : "圆周点位"}</th><th scope="col">{segmented ? "段后等待位置" : "采集轮数"}</th><th scope="col">状态</th></tr></thead>
        <tbody>{group.targets.map(target => {
          const running = activeKey === target.key, isSelected = selected?.key === target.key;
          const configured = !!target.route.cycle, targetBlockers = captureRouteRequestBlockers(target.route, status), archived = saved.get(target.key);
          const label = running ? status?.state === "stopping" ? "正在停止" : "正在采集" : !configured ? "待配置" : targetBlockers.length ? "未就绪" : archived === "complete" ? "已完成" : archived === "diagnostic_complete" ? "测试采集完成" : archived === "configuration_changed" ? "配置已变更" : archived === "partial" ? "待补采" : "待采集";
          const savedNotice = archived === "configuration_changed" ? "上一轮记录已完整保存；圆周点位数量、采集轮数或测点半径已调整，当前配置尚未采集。" : undefined;
          return <tr key={target.key} aria-current={running ? "true" : undefined} data-selected={isSelected || undefined}
            data-selectable={!disabled && !!onSelect || undefined} onClick={() => { if (!disabled) onSelect?.(target.key); }}>
            <th scope="row"><button type="button" className="field-auto-capture-point" aria-label={`选择叶片 ${target.bladeId} 测点 ${target.pointName}`} aria-pressed={isSelected} disabled={disabled || !onSelect} onClick={event => { event.stopPropagation(); if (!disabled) onSelect?.(target.key); }}><span className="field-auto-capture-radio" aria-hidden="true" />{target.pointName || "未命名测点"}</button></th>
            <td className="mono">{radius(target.radiusM)}</td><td>{segmented ? target.route.cycle?.points.map(point => `${point.azimuthDeg}°`).join(" → ") || "待配置" : `${target.stations} 个`}</td><td>{segmented ? `${target.route.cycle?.nextWaitPoint?.azimuthDeg ?? "—"}°` : `${target.cycles} 轮`}</td>
            <td><span title={targetBlockers[0] || savedNotice} className={`field-badge ${running || archived === "complete" ? "green" : archived === "partial" || archived === "diagnostic_complete" || archived === "configuration_changed" ? "amber" : ""}`}>{label}</span></td>
          </tr>;
        })}</tbody>
      </table></div>
    </section>)}</>}
    </div>
    {motionPanel}
    </div>
  </section>;
});
