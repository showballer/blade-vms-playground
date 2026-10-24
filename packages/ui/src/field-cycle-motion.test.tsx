// Feedback-driven presentation only. No device or service is contacted.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appendMotionSample, cycleMotionModel, FieldCycleMotion } from "./field-cycle-motion";
import { FieldCycleProgress } from "./field-cycle-progress";
import type { FieldCaptureRoute } from "./field-capture-route";
import type { FieldAxisFeedback, FieldPointCyclePoint, FieldStatus } from "./field-types";

let count = 0;
const check = (label: string, run: () => void) => { run(); count++; console.log(`PASS ${label}`); };
const now = 1792500000123, at = now / 1000;
const axis = (angle: number): FieldAxisFeedback => ({ output_angle_deg: angle, motor_rpm: 0, actual_counts: 100, commanded_counts: 100, error_counts: 0, display_mode: 3,
  command_counts_per_rev: 10000, encoder_bits: 21, flags: 3, fault: 0, origin_counts: 0, home_phase: 0, observedAt: at, referenceAngleDeg: 0,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -35, maximum_deg: 35 } });
const points: FieldPointCyclePoint[] = [
  { pointId: "p-s1", name: "P1 · 0°", axis1AngleDeg: 13, axis2AngleDeg: 7, bladeId: "2", radialPointId: "p", radialPointName: "P1", radiusM: .234, rootRadiusM: .078, bladeLengthM: .78, azimuthDeg: 0 },
  { pointId: "p-s2", name: "P1 · 90°", axis1AngleDeg: 14, axis2AngleDeg: 8, bladeId: "2", radialPointId: "p", radialPointName: "P1", radiusM: .234, rootRadiusM: .078, bladeLengthM: .78, azimuthDeg: 90 },
];
const route: FieldCaptureRoute = { kind: "auto", name: "P1", pointNames: points.map(p => p.name), errors: [], generation: 2,
  cycle: { port: "COM6", points, cycles: 1, speedRpm: .2, dwellSeconds: 60 } };
const status: FieldStatus = { service: { state: "ready", dllConfigured: true, generation: 2 }, state: "acquiring", turntableBusy: true,
  turntable: { state: "holding", port: "COM6", feedback: { outputRpm: 0, motorRpm: 0, alarmCode: 0, limitFlags: null, positionRaw: 100, axes: { "1": axis(13), "2": axis(7) } } },
  pointCycle: { state: "holding", port: "COM6", mode: "automatic_stations", sessionId: "run-one", currentPoint: "P1 · 0°", targetPointId: "p-s1", cycle: 1, cycles: 1, point: 1, pointCount: 2, speedRpm: .2, dwellSeconds: 60, completedRecords: 0, totalRecords: 2,
    processPhase: "waiting_blade", plannedStations: points.map((p, i) => ({ ...p, pointId: p.pointId!, bladeId: p.bladeId!, radialPointId: p.radialPointId!, radialPointName: p.radialPointName!, radiusM: p.radiusM!, azimuthDeg: p.azimuthDeg!, stationIndex: i + 1, stationCount: 2 })) } };
check("活动任务使用下发计划而非编辑草稿，并跟随显式下一目标", () => {
  const model = cycleMotionModel(status, { ...route, cycle: { ...route.cycle!, points: [{ ...points[0], axis2AngleDeg: -90 }] } }, now);
  assert.equal(model.target?.axis2AngleDeg, 7);
  const moving = cycleMotionModel({ ...status, pointCycle: { ...status.pointCycle!, targetPointId: "p-s2", processPhase: "moving" } }, route, now);
  assert.equal(moving.target?.pointId, "p-s2"); assert.equal(moving.moving, true); assert.equal(moving.arrived, false);
});
check("到位后显示辅助背景说明，不冒充已确认进入", () => {
  const preparing: FieldStatus = { ...status, pointCycle: { ...status.pointCycle!, rssiTriggerEnabled: true,
    processPhase: "waiting_background", rssiPhase: "waiting_background", rssiBackgroundPolicy: "advisory", rssiBackgroundMs: 20,
    rssiBackgroundRequiredMs: 50, rssiBackgroundReady: false, rssiPartialPassesIgnored: 1 } };
  const markup = renderToStaticMarkup(<FieldCycleProgress status={preparing} />);
  assert.ok(markup.includes("等待稳定回波基线"));
  assert.ok(markup.includes("背景仅作辅助，不阻塞换点"));
  assert.ok(markup.includes("背景尚未确认"));
  assert.ok(!markup.includes("已确认进入 · 叶片经过中"));
  assert.equal(cycleMotionModel(preparing, route, now).arrived, true);
});
check("回原点显示作业零点目标并暂停叶片判定，不冒充首个点位", () => {
  const returning: FieldStatus = { ...status, pointCycle: { ...status.pointCycle!, returningToOrigin: true,
    returnToOrigin: { name: "作业原点", axis1AngleDeg: 2, axis2AngleDeg: -16 }, processPhase: "returning_origin", state: "positioning" } };
  const model = cycleMotionModel(returning, route, now);
  assert.equal(model.target?.name, "作业原点"); assert.equal(model.target?.axis2AngleDeg, -16);
  assert.equal(model.target?.stationIndex, 0); assert.equal(model.moving, true); assert.equal(model.arrived, false);
  const progress = renderToStaticMarkup(<FieldCycleProgress status={returning} />);
  assert.ok(progress.includes("返回作业原点")); assert.ok(!progress.includes("最近采集 RSSI"));
  const arrived: FieldStatus = { ...returning, turntable: { ...returning.turntable!, feedback: { ...returning.turntable!.feedback!,
    axes: { "1": axis(2), "2": axis(-16) } } }, pointCycle: { ...returning.pointCycle!, state: "complete", processPhase: "complete" } };
  assert.equal(cycleMotionModel(arrived, route, now).arrived, true);
});
check("只有新鲜、同串口、有效双轴且服务确认到位才显示已到位", () => {
  assert.equal(cycleMotionModel(status, route, now).arrived, true);
  const changed = (patch: Partial<FieldAxisFeedback>) => ({ ...status, turntable: { ...status.turntable!, feedback: { ...status.turntable!.feedback!, axes: { ...status.turntable!.feedback!.axes, "2": { ...axis(7), ...patch } } } } });
  assert.equal(cycleMotionModel(changed({ output_angle_deg: 7.501 }), route, now).arrived, false);
  assert.equal(cycleMotionModel(changed({ output_angle_deg: 7.5 }), route, now).arrived, true);
  for (const patch of [{ fault: 2 }, { output_angle_deg: NaN }, { flags: 16 }, { flags: 2 }, { flags: NaN }, { home_phase: 2 }, { observedAt: at - 3 }]) {
    assert.equal(cycleMotionModel(changed(patch), route, now).fresh, false);
  }
  assert.equal(cycleMotionModel(changed({ motor_rpm: .1 }), route, now).arrived, false);
  assert.equal(cycleMotionModel({ ...status, turntable: { ...status.turntable!, port: "COM7" } }, route, now).fresh, false);
  assert.equal(cycleMotionModel(status, route, now, true).fresh, false);
  assert.equal(cycleMotionModel({ ...status, pointCycle: { ...status.pointCycle!, processPhase: "positioning" } }, route, now).arrived, false);
});
check("未开始和旧记录缺角度时不制造设备轨迹或到位", () => {
  const preview = cycleMotionModel({ ...status, state: "idle", pointCycle: null }, route, now);
  assert.equal(preview.label, "计划预览"); assert.equal(preview.arrived, false);
  const unknown = cycleMotionModel({ ...status, pointCycle: { ...status.pointCycle!, plannedStations: status.pointCycle!.plannedStations!.map(p => ({ ...p, axis1AngleDeg: undefined, axis2AngleDeg: undefined })) } }, route, now);
  assert.equal(unknown.stations.length, 0); assert.equal(unknown.arrived, false);
});
check("区分距叶根与距旋转中心，旧记录不假设叶根为零", () => {
  assert.ok(Math.abs(cycleMotionModel(status, route, now).rootDistanceM! - .156) < 1e-9);
  const missing = { ...status, pointCycle: { ...status.pointCycle!, plannedStations: status.pointCycle!.plannedStations!.map(p => ({ ...p, rootRadiusM: undefined })) } };
  assert.equal(cycleMotionModel(missing, route, now).rootDistanceM, undefined);
});
check("真实采样去重、乱序不追加，间断不连线，最多240个点", () => {
  const first = cycleMotionModel(status, route, now).sample!;
  let trail = appendMotionSample([], first);
  assert.equal(appendMotionSample(trail, first).length, 1);
  assert.equal(appendMotionSample(trail, { ...first, at: first.at - 1 }).length, 1);
  assert.equal(appendMotionSample(trail, { ...first, at: first.at + 1.15 }).at(-1)?.gapBefore, false);
  trail = appendMotionSample(trail, { ...first, at: first.at + 2, pitch: 14 });
  assert.equal(trail[1].gapBefore, true);
  assert.equal(appendMotionSample(trail, { ...first, at: first.at + 2.1 }, true).at(-1)?.gapBefore, true);
  for (let i = 1; i <= 300; i++) trail = appendMotionSample(trail, { ...first, at: first.at + 3 + i / 10 });
  assert.equal(trail.length, 240);
});
check("静态渲染只输出计划与已有反馈，不发请求、不绘假反馈路径", () => {
  const html = renderToStaticMarkup(<FieldCycleMotion config={{ name: "风机", deviceIp: "192.0.2.90", hostIp: "192.0.2.10", object: "", turbine: "", point: "" }} status={null} route={route} />);
  assert.ok(html.includes('aria-label="转盘联动轨迹"'));
  assert.ok(html.includes('data-kind="plan"'));
  assert.ok(!html.includes('data-kind="feedback"'));
  assert.ok(!html.includes("测点距叶根"));
  for (const label of ["距风机转轴中心", "俯仰", "水平", "间断处不连线"]) assert.ok(html.includes(label));
});
check("移动保持激光的策略不冒充实测开关状态，到位前不显示RSSI判定计时", () => {
  const config = { name: "风机", deviceIp: "192.0.2.90", hostIp: "192.0.2.10", object: "", turbine: "", point: "" };
  const moving: FieldStatus = { ...status, pointCycle: { ...status.pointCycle!, state: "positioning", processPhase: "moving", rssiTriggerEnabled: true, rssiEntryMs: 20, rssiBelowMs: 30 } };
  const html = renderToStaticMarkup(<FieldCycleMotion config={config} status={moving} route={route} />);
  assert.ok(html.includes("移动期间激光保持开启，暂停叶片进入／离开判定"));
  assert.ok(html.includes("到位停稳后才启用"));
  assert.match(html, /class="field-motion-laser" data-state="unknown"/);
  assert.ok(html.includes("激光状态未知"), "期望常亮不能替代设备回读");
  for (const phase of ["laser_on", "laser_on_confirmed", "moving", "arrived", "starting_capture", "laser_off", "laser_off_confirmed"]) {
    const progress = renderToStaticMarkup(<FieldCycleProgress status={{ ...moving, pointCycle: { ...moving.pointCycle!, processPhase: phase } }} />);
    assert.ok(!progress.includes("最近采集 RSSI"));
    assert.ok(!progress.includes("进入确认 20/"), phase);
    assert.ok(progress.includes("停止采集并保持激光开启"));
    assert.ok(progress.includes("手动停止或异常时关闭激光"));
    assert.ok(!progress.includes("关闭激光，准备移动"));
  }
  const waiting = renderToStaticMarkup(<FieldCycleProgress status={{ ...moving, pointCycle: { ...moving.pointCycle!, state: "holding", processPhase: "waiting_blade" } }} />);
  assert.ok(waiting.includes("最近采集 RSSI")); assert.ok(waiting.includes("进入确认 20/"));
  const log = renderToStaticMarkup(<FieldCycleProgress status={{ ...moving, pointCycle: { ...moving.pointCycle!, processEvents: [
    { sequence: 1, phase: "laser_on_confirmed", at, point: "P1", cycle: 1 }, { sequence: 2, phase: "laser_off_confirmed", at: at + 1, point: "P1", cycle: 1 },
  ] } }} />);
  assert.ok(log.includes("激光已开启")); assert.ok(log.includes("激光已关闭"));
});
check("本段展示实际下发的共同减速策略和保护上限，不以草稿或默认值冒充", () => {
  const value = structuredClone(status);
  value.pointCycle!.lastMove = { mode: "dual_axis_timed", speedLimitRpm: 1.72, accelerationLimitDegS2: 30,
    adaptiveFollow: true, followErrorLimitDeg: .75, cycleMs: 100 };
  const html = renderToStaticMarkup(<FieldCycleMotion status={value} route={route} config={{ name: "任务", deviceIp: "192.0.2.90", hostIp: "192.0.2.10", object: "", turbine: "", point: "" }} />);
  for (const label of ["本段下发上限", "1.72", "30", "两轴共同减速，时间可延长", "跟随保护 0.75°"]) assert.ok(html.includes(label), label);
  value.pointCycle!.lastMove.followErrorLimitDeg = 1.5;
  const adjusted = renderToStaticMarkup(<FieldCycleMotion status={value} route={route} config={{ name: "任务", deviceIp: "192.0.2.90", hostIp: "192.0.2.10", object: "", turbine: "", point: "" }} />);
  assert.ok(adjusted.includes("跟随保护 1.5°"));
  assert.ok(!adjusted.includes("跟随保护 0.75°"));
});
check("反馈定位标明新协议，旧记录保留原执行方式", () => {
  const showing = (protocol: "0x19" | null) => renderToStaticMarkup(<FieldCycleMotion
    status={{ ...status, pointCycle: { ...status.pointCycle!, lastMove: { mode: "drive_internal", speedLimitRpm: 5, positionProtocol: protocol } } }}
    route={route} config={{ name: "任务", deviceIp: "192.0.2.20", hostIp: "192.0.2.10", object: "", turbine: "", point: "" }} />);
  assert.ok(showing("0x19").includes("控制器反馈定位"));
  assert.ok(!showing("0x19").includes("驱动器内部定位"));
  assert.ok(showing(null).includes("驱动器内部定位"));
});
console.log(`PASS ${count} feedback-driven motion checks; no hardware used`);

check("移动关灯策略按实际任务显示，开灯前不显示叶片判定", () => {
  const dark: FieldStatus = { ...status, pointCycle: { ...status.pointCycle!, laserPolicy: "off_during_motion", rssiTriggerEnabled: true, processPhase: "motion_stopped_before_laser_on" } };
  const config = { name: "任务", deviceIp: "192.0.2.90", hostIp: "192.0.2.10", object: "", turbine: "", point: "" };
  const markup = renderToStaticMarkup(<FieldCycleMotion status={dark} route={route} config={config} />);
  assert.ok(markup.includes("移动前关闭激光，到位停稳后开启"));
  assert.ok(!markup.includes("移动期间激光保持开启"));
  assert.ok(markup.includes("激光状态未知"));
  const progress = renderToStaticMarkup(<FieldCycleProgress status={dark} />);
  assert.ok(progress.includes("两轴已停稳，准备开激光"));
  assert.ok(!progress.includes("最近采集 RSSI"));
});
