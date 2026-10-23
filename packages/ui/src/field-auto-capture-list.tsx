"use client";
import React, { memo, useMemo } from "react";
import { ChevronRight, Crosshair, LoaderCircle, Play, Square } from "lucide-react";
import { Button } from "./common";
import { captureRouteRequestBlockers, type FieldAutoCaptureTarget } from "./field-capture-route";
import { presetPositionRequestError } from "./field-preset-position";
import { getAutoCaptureTargetState, summarizeBladeRecords } from "./field-blade-summary-data";
import { fieldStartError, fieldCaptureConfig, fieldIsActive, validateFieldConfig, type FieldConfig, type FieldRecording, type FieldStatus } from "./field-types";

type Props = {
  targets: readonly FieldAutoCaptureTarget[]; selectedTargetKey?: string; collectionId?: string;
  recordings?: readonly FieldRecording[]; config: FieldConfig; status: FieldStatus | null;
  busy: string; pollError: string; stopping?: boolean; onSelect?: (key: string) => void; onStart?: (key: string) => void;
  onConfigure?: (key: string) => void; onConfigureAll: () => void; onStop: () => void;
  onPosition?: (key: string) => void;
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

export const FieldAutoCaptureList = memo(function FieldAutoCaptureList({ targets, selectedTargetKey, collectionId, recordings = noRecords,
  config, status, busy, pollError, stopping = false, onSelect, onStart, onConfigure, onConfigureAll, onStop, onPosition }: Props) {
  const active = fieldIsActive(status);
  const activeKey = activeAutoCaptureKey(targets, status, selectedTargetKey);
  const disabled = active || !!busy || !!status?.turntableBusy || !!status?.deviceBusy;
  const configError = validateFieldConfig(fieldCaptureConfig(config));
  const serviceError = fieldStartError(status);
  const ready = !serviceError && !pollError && !configError;
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
      bladeId: target.bladeId, radialPointId: target.pointId, cycles: target.cycles, stationCount: target.stations, radiusM: target.radiusM,
      windFarm: config.windFarm || "", turbine: config.turbine.trim() || config.name.trim(), measurementObject: config.object }, summary)]));
  }, [recordings, collectionId, targets, config.windFarm, config.turbine, config.name, config.object]);
  const cycle = status?.pointCycle;
  return <section className="field-auto-capture-list field-servo-ui" aria-label="风机叶片逐点采集">
    <div className="field-auto-capture-heading"><div><h3>叶片与测点</h3><p>可先移动到预设位置。开始采集时先读取转盘参考位，已到位则直接采集。</p></div><span className="field-badge">{groups.length} 个叶片 · {targets.length} 个测点</span></div>
    {!targets.length ? <div className="field-auto-capture-empty"><p>请先配置叶片和测点，填写测量尺寸与转盘串口。</p><Button type="button" disabled={disabled} onClick={onConfigureAll}>配置自动跟随<ChevronRight size={14} /></Button></div> : <>
      {!active && configError && <p className="field-auto-capture-notice" role="status">{configError}</p>}
      {groups.map(group => <section key={group.key} className="field-auto-capture-blade" aria-label={`叶片 ${group.bladeId || "待设置"} 采集测点`}>
        <div className="field-auto-capture-blade-heading"><h4>叶片 {group.bladeId || "待设置"}</h4><span>{group.targets.length} 个测点</span></div>
        <div className="field-auto-capture-scroll" role="region" tabIndex={0} aria-label={`叶片 ${group.bladeId || "待设置"} 测点表，可横向滚动`}><table aria-label={`叶片 ${group.bladeId || "待设置"} 测点采集状态`}>
          <thead><tr><th scope="col">测点</th><th scope="col">距风机旋转中心</th><th scope="col">圆周点位</th><th scope="col">采集轮数</th><th scope="col">采集状态</th><th scope="col">操作</th></tr></thead>
          <tbody>{group.targets.map(target => {
            const running = activeKey === target.key;
            const configured = !!target.route.cycle;
            const blockers = captureRouteRequestBlockers(target.route, status);
            const archived = saved.get(target.key);
            const label = running ? status?.state === "stopping" ? "正在停止" : "正在采集" : archived === "complete" ? "已完成" : archived === "partial" ? "待补采" : !configured ? "待配置" : blockers.length ? "未就绪" : "待采集";
            const startDisabled = disabled || !ready || !configured || !!blockers.length || !onStart;
            const reason = pollError || serviceError || configError || blockers[0];
            const positionError = presetPositionRequestError(target.route, status) || pollError;
            return <tr key={target.key} aria-current={running ? "true" : undefined} data-selected={selectedTargetKey === target.key || undefined}>
              <th scope="row"><button type="button" className="field-auto-capture-point" aria-label={`选择叶片 ${target.bladeId} 测点 ${target.pointName}`} aria-pressed={selectedTargetKey === target.key} disabled={disabled || !onSelect} onClick={() => onSelect?.(target.key)}>{target.pointName || "未命名测点"}</button></th>
              <td className="mono">{radius(target.radiusM)}</td><td>{target.stations} 个</td><td>{target.cycles} 轮</td>
              <td><span className={`field-badge ${running || archived === "complete" ? "green" : archived === "partial" ? "amber" : ""}`}>{label}</span>{running && cycle && <span className="field-auto-capture-progress" role="status">{cycle.cycle > 0 && cycle.point > 0 ? `第 ${cycle.cycle}/${cycle.cycles} 轮 · 点位 ${Math.min(cycle.pointCount, cycle.point)}/${cycle.pointCount}` : "正在准备当前测点"}</span>}{!active && (reason || positionError) && <span className="field-inline-help" role="status">{[...new Set([reason, positionError].filter(Boolean))].join("；")}</span>}</td>
              <td><div className="field-auto-capture-actions">{running ? <Button type="button" variant="danger" disabled={stopping} onClick={onStop}><Square size={12} />停止并保存</Button> : <><Button type="button" disabled={disabled || !!positionError || !onPosition} title={positionError || "先定位到此测点的第一个圆周点位，不开始采集"} aria-label={`移动到预设位置：叶片 ${target.bladeId} 测点 ${target.pointName}`} onClick={() => onPosition?.(target.key)}>{busy === "preposition" && selectedTargetKey === target.key ? <LoaderCircle size={14} className="spin" /> : <Crosshair size={14} />}移动到预设位置</Button><Button type="button" variant="primary" disabled={startDisabled} title={reason} aria-label={`开始采集叶片 ${target.bladeId} 测点 ${target.pointName}`} onClick={() => onStart?.(target.key)}>{busy === "start" && selectedTargetKey === target.key ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{archived === "complete" ? "重新采集" : "开始采集"}</Button><Button type="button" variant="ghost" disabled={disabled || !onConfigure} onClick={() => onConfigure?.(target.key)}>配置测点<ChevronRight size={13} /></Button></>}</div></td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>)}
      <p className="field-auto-capture-footnote">每次只采集一个叶片测点。叶片进入并离开当前点位后，转盘按计算速度移至下一点位等待；原始记录按风机任务、叶片、测点和轮次分别保存。每轮覆盖全部配置点位，可能跨叶轮实际多圈。</p>
    </>}
  </section>;
});
