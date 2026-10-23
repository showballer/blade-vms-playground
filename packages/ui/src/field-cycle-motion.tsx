"use client";
import React, { useEffect, useRef, useState } from "react";
import { Crosshair, Navigation, Radio } from "lucide-react";
import { headerLaserReadbackState } from "./field-header-laser";
import type { FieldCaptureRoute } from "./field-capture-route";
import { turntableReferenceSignature } from "./field-turntable-points";
import { FIELD_POSITION_TOLERANCE_DEG, fieldIsActive, type FieldConfig, type FieldPointCyclePoint, type FieldStatus } from "./field-types";

type Station = FieldPointCyclePoint & { stationIndex: number };
export type MotionSample = { at: number; pitch: number; yaw: number; stationary: boolean; reference: string; gapBefore?: boolean };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown, digits = 3) => finite(value) ? `${Math.abs(value) < .0005 ? 0 : Number(value.toFixed(digits))}` : "—";
const terminal = new Set(["complete", "cancelled", "error"]);
const phases: Record<string, string> = { checking: "检查设备", ready: "准备中", positioning: "核对目标", laser_on: "开启激光", laser_on_confirmed: "激光已开，准备移动", laser_off: "关闭激光", laser_off_confirmed: "激光已关闭", moving: "移动中", returning: "返回首个点位", returning_origin: "返回作业原点", origin_arrived: "已回到作业原点", arrived: "到位已确认", starting_capture: "到位，启动采集", waiting_background: "等待稳定回波基线", background_ready: "等待完整经过", partial_pass_ignored: "忽略未完整经过", waiting_blade: "等待叶片", confirming_entry: "确认叶片进入", blade_present: "叶片经过中", confirming_exit: "确认叶片离开", blade_left: "叶片已离开", saving: "保存记录", record_saved: "记录已保存", complete: "已完成", cancelled: "已停止", error: "流程异常", verifying_initial_pose: "核对首个点位姿态" };

export function cycleMotionModel(status: FieldStatus | null, route: FieldCaptureRoute | null | undefined, nowMs = Date.now(), unavailable = false) {
  const cycle = status?.pointCycle;
  const routePoints = route?.cycle?.points || [];
  const samePlan = routePoints.length > 0 && routePoints.length === cycle?.plannedStations?.length && routePoints.every((point, index) => point.pointId === cycle.plannedStations?.[index]?.pointId);
  const fromRun = !!cycle && (fieldIsActive(status) || !terminal.has(cycle.state) || !routePoints.length || samePlan);
  const raw = fromRun ? cycle?.plannedStations || [] : routePoints;
  const stations: Station[] = raw.flatMap((point, index) => finite(point.axis1AngleDeg) && finite(point.axis2AngleDeg)
    ? [{ ...point, name: point.name || `${point.radialPointName || "点位"} · ${text(point.azimuthDeg)}°`, axis1AngleDeg: point.axis1AngleDeg, axis2AngleDeg: point.axis2AngleDeg, stationIndex: index + 1 }] : []);
  const port = fromRun ? cycle?.port || "" : route?.cycle?.port || "";
  const pair = status?.turntable?.port === port ? status.turntable.feedback?.axes : undefined;
  const reference = turntableReferenceSignature(pair);
  const one = pair?.["1"], two = pair?.["2"];
  const at = one && two && finite(one.observedAt) && finite(two.observedAt) ? Math.min(one.observedAt, two.observedAt) : undefined;
  const sample: MotionSample | null = reference && one && two && finite(one.output_angle_deg) && finite(two.output_angle_deg) &&
    Math.abs(one.output_angle_deg) <= 35 && Math.abs(two.output_angle_deg) <= 180 && finite(at) && at > 0 &&
    finite(one.motor_rpm) && finite(two.motor_rpm) && one.fault === 0 && two.fault === 0 &&
    [one, two].every(axis => Number.isSafeInteger(axis.flags) && (axis.flags & 1) === 1 && (axis.flags & 16) === 0 && [0, 7, 8].includes(axis.home_phase))
    ? { at, pitch: one.output_angle_deg, yaw: two.output_angle_deg, stationary: one.motor_rpm === 0 && two.motor_rpm === 0, reference } : null;
  const age = sample ? nowMs - Math.floor(sample.at * 1000 + .001) : Infinity;
  const fresh = !!sample && status?.service.state === "ready" && !unavailable && !status.turntableWarning &&
    (fromRun || route?.generation === undefined || route.generation === status.service.generation) && age >= 0 && age <= 2000;
  const origin = fromRun && cycle?.returningToOrigin ? cycle.returnToOrigin : null;
  const target: Station | null = origin ? { ...origin, stationIndex: 0 } : (fromRun ? stations.find(point => point.pointId === cycle?.targetPointId) || stations.find(point => point.name === cycle?.currentPoint) || stations[Math.max(0, (cycle?.point || 1) - 1)] : stations[0]) || null;
  const phase = fromRun ? terminal.has(cycle!.state) ? cycle!.state : cycle!.processPhase || cycle!.state : "preview";
  const moving = fromRun && !terminal.has(cycle!.state) && (phase === "moving" || phase === "returning" || phase === "returning_origin" || !!sample && !sample.stationary);
  const acceptedArrival = fromRun && !moving && ["origin_arrived", "arrived", "starting_capture", "waiting_background", "background_ready", "partial_pass_ignored", "waiting_blade", "confirming_entry", "blade_present", "confirming_exit", "blade_left", "saving", "record_saved", "complete"].includes(phase);
  const arrived = acceptedArrival && fresh && sample!.stationary && !!target && Math.abs(sample!.pitch - target.axis1AngleDeg) <= FIELD_POSITION_TOLERANCE_DEG + 1e-9 && Math.abs(sample!.yaw - target.axis2AngleDeg) <= FIELD_POSITION_TOLERANCE_DEG + 1e-9;
  const label = phase === "preview" ? stations.length ? "计划预览" : "等待配置" : moving ? cycle?.returningToOrigin ? "返回作业原点" : "移动中" : fresh && arrived && !terminal.has(phase) ? "已到位 · " + (phases[phase] || "等待采集") : phases[phase] || "等待反馈";
  const geometry = fromRun ? cycle?.geometry : route?.cycle?.geometry;
  const rootDistanceM = target && finite(target.radiusM) && finite(target.rootRadiusM) && target.radiusM >= target.rootRadiusM ? target.radiusM - target.rootRadiusM : undefined;
  const key = JSON.stringify([status?.service.generation, port, reference, fromRun ? cycle?.sessionId : "preview", stations.map(point => [point.pointId, point.axis1AngleDeg, point.axis2AngleDeg])]);
  return { stations, target, sample, fresh, arrived, moving, phase, label, geometry, rootDistanceM, fromRun, key };
}

export function appendMotionSample(previous: readonly MotionSample[], sample: MotionSample, gap = false): MotionSample[] {
  const last = previous.at(-1);
  if (last && (sample.reference !== last.reference || sample.at <= last.at)) return [...previous];
  // Vendor motion telemetry is polled about once a second. Preserve its normal
  // jitter, but never bridge a stale interval or an explicit disconnect.
  return [...previous, { ...sample, gapBefore: gap || !!last && sample.at - last.at >= 2 }].slice(-240);
}

export function FieldCycleMotion({ status, route, config, unavailable = false }: { status: FieldStatus | null; route?: FieldCaptureRoute | null; config: FieldConfig; unavailable?: boolean }) {
  const [, tick] = useState(0), [history, setHistory] = useState<{ key: string; points: MotionSample[] }>({ key: "", points: [] });
  const gap = useRef(false);
  useEffect(() => { const timer = window.setInterval(() => tick(value => value + 1), 500); return () => window.clearInterval(timer); }, []);
  const now = Date.now();
  const model = cycleMotionModel(status, route, now, unavailable);
  const sampleKey = model.sample ? JSON.stringify([model.sample.at, model.sample.pitch, model.sample.yaw, model.sample.stationary]) : "";
  useEffect(() => {
    if (!model.fresh || !model.sample || !model.fromRun) { gap.current = true; return; }
    const sample = model.sample;
    const previous = history.key === model.key ? history.points : [];
    const last = previous.at(-1);
    // A repeated cached frame must not consume a disconnect boundary. Only a
    // genuinely new sample may resume the trace after a gap.
    if (last && (sample.reference !== last.reference || sample.at <= last.at)) return;
    setHistory({ key: model.key, points: appendMotionSample(previous, sample, gap.current) });
    gap.current = false;
  }, [model.key, sampleKey, model.fresh, model.fromRun, history]);
  const points = history.key === model.key ? history.points : [];
  const observed = model.fresh ? model.sample : null;
  const extent = [...model.stations.map(point => ({ pitch: point.axis1AngleDeg, yaw: point.axis2AngleDeg })), ...points, ...(model.target ? [{ pitch: model.target.axis1AngleDeg, yaw: model.target.axis2AngleDeg }] : []), ...(observed ? [observed] : [])];
  const range = (values: number[]) => { const lo = values.length ? Math.min(...values) : -1, hi = values.length ? Math.max(...values) : 1; const span = Math.max(2, hi - lo), center = (lo + hi) / 2; return [center - span * .65, center + span * .65]; };
  const [x0, x1] = range(extent.map(point => point.yaw)), [y0, y1] = range(extent.map(point => point.pitch));
  const x = (value: number) => 62 + (value - x0) / (x1 - x0) * 496, y = (value: number) => 210 - (value - y0) / (y1 - y0) * 178;
  const path = (items: { pitch: number; yaw: number; gapBefore?: boolean }[]) => items.map((point, index) => `${index === 0 || point.gapBefore ? "M" : "L"}${x(point.yaw).toFixed(2)},${y(point.pitch).toFixed(2)}`).join(" ");
  const planned = model.stations.map(point => ({ pitch: point.axis1AngleDeg, yaw: point.axis2AngleDeg }));
  const laser = headerLaserReadbackState(status?.laserStatus, config.deviceIp, now);
  const displayed = model.sample;
  const move = model.fromRun ? status?.pointCycle?.lastMove : undefined;
  return <section className="field-card field-cycle-motion field-servo-ui" aria-label="转盘联动轨迹" data-moving={model.moving} data-arrived={model.arrived} data-feedback={model.fresh ? "fresh" : "unknown"}>
    <div className="field-section-heading"><div><h2><Navigation size={17} />转盘轨迹与到位</h2><p>{model.target?.bladeId ? `叶片 ${model.target.bladeId} · ` : ""}{model.target?.radialPointName || model.target?.name || "尚未选择测点"}{model.target?.stationIndex ? ` · 点位 ${model.target.stationIndex}/${model.stations.length}` : ""}{model.fromRun ? ` · 第 ${status?.pointCycle?.cycle || 1}/${status?.pointCycle?.cycles || 1} 轮` : ""}</p></div><div className="field-motion-status"><span className={`field-badge ${model.phase === "error" ? "red" : model.arrived ? "green" : ""}`} role="status">{model.moving && <span className="field-motion-pulse" />}{model.label}</span><span className="field-motion-laser" data-state={laser}><Radio size={13} />{laser === "on" ? "激光已开启" : laser === "off" ? "激光已关闭" : "激光状态未知"}</span></div></div>
    <div className="field-motion-layout"><div className="field-motion-plot">
      <svg viewBox="0 0 600 258" role="img" aria-label="水平与俯仰角轨迹，虚线为计划，实线为接收到的反馈">
        {[0, .5, 1].map(fraction => <g className="field-motion-grid" key={fraction}><line x1={62} y1={32 + fraction * 178} x2={558} y2={32 + fraction * 178} /><line x1={62 + fraction * 496} y1={32} x2={62 + fraction * 496} y2={210} /><text x={54} y={36 + fraction * 178} textAnchor="end">{text(y1 - fraction * (y1 - y0), 2)}</text><text x={62 + fraction * 496} y={231} textAnchor="middle">{text(x0 + fraction * (x1 - x0), 2)}</text></g>)}
        <text className="field-motion-axis" x={62} y={17}>俯仰角 °</text><text className="field-motion-axis" x={558} y={250} textAnchor="end">水平角 ° · 设备坐标</text>
        {planned.length > 0 && <path className="field-motion-plan" data-kind="plan" d={path(planned)} />}
        {model.stations.map((point, index) => <g key={point.pointId || index} className={point === model.target ? "field-motion-station target" : "field-motion-station"} data-station={point.pointId}><circle cx={x(point.axis2AngleDeg)} cy={y(point.axis1AngleDeg)} r={point === model.target ? 7 : 4} />{model.stations.length <= 12 || point === model.target ? <text x={x(point.axis2AngleDeg) + 9} y={y(point.axis1AngleDeg) - 8}>{point.stationIndex}</text> : null}</g>)}
        {model.target?.stationIndex === 0 && <g className="field-motion-station target" data-origin="work-zero"><circle cx={x(model.target.axis2AngleDeg)} cy={y(model.target.axis1AngleDeg)} r={7} /><text x={x(model.target.axis2AngleDeg) + 9} y={y(model.target.axis1AngleDeg) - 8}>原点</text></g>}
        {points.length > 0 && <path className="field-motion-actual" data-kind="feedback" data-samples={points.length} d={path(points)} />}
        {observed && <g className="field-motion-current" data-observed-at={observed.at} data-pitch={observed.pitch} data-yaw={observed.yaw}><circle cx={x(observed.yaw)} cy={y(observed.pitch)} r={10} /><circle cx={x(observed.yaw)} cy={y(observed.pitch)} r={4} /></g>}
        {!observed && <text className="field-motion-empty" x={310} y={123} textAnchor="middle">{model.fromRun ? "等待新的两轴反馈" : "开始联动采集后显示反馈轨迹"}</text>}
      </svg>
      <div className="field-motion-legend"><span><i className="plan" />计划路线</span><span><i className="actual" />反馈轨迹</span><span><Crosshair size={12} />目标点位</span><span className="field-motion-sample-note">{points.length} 次反馈 · 间断处不连线</span></div>
    </div><div className="field-motion-readout">
      <div className="field-motion-feedback-heading"><strong>两轴角度</strong><span>{model.fresh ? "实时反馈" : displayed ? "最近反馈 · 当前待确认" : "尚未读取"}</span></div>
      <table className="field-motion-angles" aria-label="两轴当前角度与目标偏差"><thead><tr><th>轴</th><th>当前 °</th><th>目标 °</th><th>偏差 °</th></tr></thead><tbody>{([1, 2] as const).map(axis => { const actual = axis === 1 ? displayed?.pitch : displayed?.yaw, target = axis === 1 ? model.target?.axis1AngleDeg : model.target?.axis2AngleDeg; return <tr key={axis}><th>{axis === 1 ? "俯仰" : "水平"}</th><td>{text(actual)}</td><td>{text(target)}</td><td>{finite(actual) && finite(target) ? text(actual - target) : "—"}</td></tr>; })}</tbody></table>
      <dl className="field-motion-dimensions"><div><dt>距风机转轴中心</dt><dd>{text(model.target?.radiusM)}<small>m</small></dd></div><div><dt>叶片长度</dt><dd>{text(model.target?.bladeLengthM)}<small>m</small></dd></div><div><dt>圆周方位</dt><dd>{text(model.target?.azimuthDeg, 1)}<small>°</small></dd></div></dl>
      {move?.mode === "drive_internal" && <p className="field-motion-note" aria-label="本段运动参数">本段下发上限 {text(move.speedLimitRpm, 2)} rpm · {move.positionProtocol === "0x19" ? "控制器反馈定位" : "驱动器内部定位"}{finite(move.followErrorLimitDeg) ? ` · 行程保护 ${text(move.followErrorLimitDeg, 2)}°` : ""} · 到位容差0.5°</p>}
      {move?.mode === "dual_axis_timed" && <p className="field-motion-note" aria-label="本段运动参数">本段下发上限 {text(move.speedLimitRpm, 2)} rpm · {text(move.accelerationLimitDegS2, 1)} °/s²{move.adaptiveFollow === true ? " · 两轴共同减速，时间可延长" : ""}{finite(move.followErrorLimitDeg) ? ` · 跟随保护 ${text(move.followErrorLimitDeg, 2)}°` : ""}</p>}
      <p className="field-motion-note">{model.fresh ? model.arrived ? "两轴已在目标范围内且停稳。" : "按实际角度更新，到位并停稳后开始采集。" : "缺少新反馈时不确认到位。"}移动期间激光保持开启，暂停叶片进入／离开判定；到位停稳后才启用。{finite(model.geometry?.distanceM) ? ` 设备至叶轮 ${text(model.geometry.distanceM, 2)} m。` : ""}</p>
    </div></div>
  </section>;
}
