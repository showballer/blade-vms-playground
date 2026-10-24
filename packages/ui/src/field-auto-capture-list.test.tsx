// Presentation and contract checks only. No Electron bridge or device requests.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldAcquisition } from "./field-acquisition";
import { activeAutoCaptureKey, FieldAutoCaptureList } from "./field-auto-capture-list";
import { turntableReferenceSignature } from "./field-turntable-points";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import { planSegmentedFollow } from "./field-segmented-plan";
import type { FieldAutoCaptureTarget, FieldCaptureRoute } from "./field-capture-route";
import type { FieldAxisFeedback, FieldConfig, FieldRecording, FieldStatus } from "./field-types";

let count = 0;
const check = (name: string, action: () => void) => { action(); count++; console.log(`PASS ${name}`); };
const config: FieldConfig = { name: "1号风机检修", turbine: "WT01", object: "风机叶片", point: "", deviceIp: "192.168.106.90", hostIp: "192.168.106.10" };
const axis = (limit: number): FieldAxisFeedback => ({ output_angle_deg: 0, motor_rpm: 0, actual_counts: 0, commanded_counts: 0, error_counts: 0,
  display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 3, fault: 0, origin_counts: 0, home_phase: 0, observedAt: 0,
  referenceAngleDeg: 0, guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const axes = { "1": axis(35), "2": axis(180) };
const ready: FieldStatus = { service: { state: "ready", dllConfigured: true, generation: 1 }, state: "idle", turntable: { state: "checked", port: "COM6", motionCapability: { supported: false, mode: "sequential", protocol: null, probe: "legacy-command-unsupported", status: null }, feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0, axes } } };
const target = (bladeId: string, pointId: string): FieldAutoCaptureTarget => ({ key: `${bladeId}-${pointId}`, bladeKey: bladeId, bladeId, pointId, pointName: pointId,
  radiusM: .31, stations: 4, cycles: 2, route: { kind: "auto", name: `叶片 ${bladeId} · ${pointId}`, pointNames: ["点位1", "点位2", "点位3", "点位4"], errors: [], generation: 1,
    cycle: { mode: "automatic_stations", port: "COM6", points: [0, 90, 180, 270].map((azimuthDeg, index) => ({ pointId: `${pointId}-${index}`, name: `点位${index + 1}`, bladeId, radialPointId: pointId, radiusM: .31,
      port: "COM6", referenceSignature: turntableReferenceSignature(axes), axis1AngleDeg: 0, axis2AngleDeg: 0, azimuthDeg })), cycles: 2, speedRpm: .2, dwellSeconds: 60, rssiTriggerEnabled: true } } });
const targets = [target("1", "P1"), target("1", "P2"), target("2", "P1")];
const noop = () => {};
const props = { targets, selectedTargetKey: targets[0].key, config, status: ready, busy: "", pollError: "", onSelect: noop, onStart: noop, onPosition: noop, onConfigure: noop, onConfigureAll: noop, onStop: noop };
const render = (patch: Partial<React.ComponentProps<typeof FieldAutoCaptureList>> = {}) => renderToStaticMarkup(<FieldAutoCaptureList {...props} {...patch} />);
const startButton = (html: string, blade: string, point: string) => html.match(new RegExp(`<button[^>]*aria-label="开始采集叶片 ${blade} · ${point}"[^>]*>`))?.[0] || "";

check("分段采集显示本段角度和下一等待点，完成后仍可再次人工开始", () => {
  const plan = planSegmentedFollow({ ...autoFollowDefaults, bladeId: "1" }, { pointsPerStart: 2, stepDeg: 90, startAzimuthDeg: 0 }, null, "drive_internal", "COM6");
  assert.equal(plan.errors.length, 0);
  const segment: FieldAutoCaptureTarget = { ...targets[0], stations: 2, cycles: 1,
    route: { kind: "segmented", name: "分段", pointNames: plan.points.map(point => point.name), cycle: plan.pointCycle!, errors: [], referenceMode: "read_at_start" } };
  const html = render({ segmented: true, targets: [segment], status: { ...ready, state: "idle", pointCycle: {
    executionMode: "manual_segments", state: "complete", waitingPoint: { ...plan.nextStartPoint!, confirmedAt: 1, actualAngles: { "1": 10, "2": 0 } },
    cycles: 1, pointCount: 2, point: 2, cycle: 1, completedRecords: 2, totalRecords: 2, speedRpm: 5, dwellSeconds: 60,
  } } });
  assert.match(html, /本段圆周角度/);
  assert.match(html, /0° → 90°/);
  assert.match(html, /段后等待位置/);
  assert.match(html, /已保存 · 等待于 180°/);
  assert.ok(!startButton(html, "1", "P1").includes("disabled"));
  assert.doesNotMatch(html, /新固件会预存|按编号换点|每轮覆盖全部配置点位/);
});

check("分段采集状态按整圈记录累计，正常完成与测试完成区分且都可重采", () => {
  const collectionId = "c".repeat(32), points = targets[0].route.cycle!.points;
  const plannedStations = points.map((point, index) => ({ ...point, pointId: point.pointId!, bladeId: "1", radialPointId: "P1", radialPointName: "P1",
    radiusM: .31, azimuthDeg: index * 90, stationIndex: index + 1, stationCount: 4 }));
  const records: FieldRecording[] = points.map((point, index) => ({ id: `saved-segment-${index}`, name: config.name, object: config.object, turbine: config.turbine,
    source: "polytec_ivs500", status: "complete", samples: 100, sampleRate: 1000, startedAt: 1000 + index, endedAt: 1001 + index,
    pointCycle: { ...point, pointName: point.name, pointIndex: 1, cycle: 1, dwellSeconds: 60,
      targetAxis1AngleDeg: point.axis1AngleDeg, targetAxis2AngleDeg: point.axis2AngleDeg,
      mode: "automatic_stations", executionMode: "manual_segments", collectionId, sessionId: String(index + 1).padStart(32, "0"),
      stationCount: 4, totalStationCount: 4, stationIndex: index + 1, lapIndex: 1, cycles: 1, segmentStepDeg: 90,
      segmentStationIds: [point.pointId!], plannedStations, completion: "confirmed_pass", passCompleteness: "confirmed" } }));
  for (const pointsPerStart of [1, 2]) {
    const segment: FieldAutoCaptureTarget = { ...targets[0], stations: pointsPerStart, cycles: 1, route: { ...targets[0].route, kind: "segmented",
      cycle: { ...targets[0].route.cycle!, executionMode: "manual_segments", cycles: 1, totalStationCount: 4, segmentStepDeg: 90,
        points: points.slice(0, pointsPerStart), segmentStations: points, nextWaitPoint: points[pointsPerStart] } } };
    const markup = (recordings: FieldRecording[]) => render({ segmented: true, targets: [segment], collectionId, recordings });
    assert.match(markup(records), />已完成</);
    assert.match(markup(records.slice(0, 1)), />待补采</);
    assert.match(markup([]), />待采集</);
    const diagnostic = records.map(record => ({ ...record, pointCycle: { ...record.pointCycle!, completion: "diagnostic_pass" as const } }));
    assert.match(markup(diagnostic), />测试采集完成</);
    assert.doesNotMatch(startButton(markup(diagnostic), "1", "P1"), /disabled/);
    assert.doesNotMatch(startButton(markup(records), "1", "P1"), /disabled/);
    const invalid = { ...records[3], status: "error" as const, error: "采集失败" };
    assert.match(markup([...records.slice(0, 3), invalid]), />待补采</);
  }
});

check("停止失败后的stopping状态仍可重试，仅本次停止请求进行中禁用", () => {
  const stopping: FieldStatus = { ...ready, state: "stopping", receiver: { running: true }, pointCycle: {
    state: "capturing", cycles: 1, pointCount: 4, point: 1, cycle: 1, completedRecords: 0, totalRecords: 4, speedRpm: 5, dwellSeconds: 60,
  } };
  const stopButton = (html: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button => button.includes("停止并保存")) || "";
  for (const busy of ["", "start"]) {
    const html = stopButton(render({ status: stopping, busy }));
    assert.ok(html); assert.doesNotMatch(html, /disabled/);
  }
  assert.match(stopButton(render({ status: stopping, stopping: true })), /disabled/);
});

check("多叶片测点分别分组，选择测点后共用唯一的采集按钮", () => {
  const html = render();
  assert.ok(html.includes('aria-label="叶片 1 采集测点"'));
  assert.ok(html.includes('aria-label="叶片 2 采集测点"'));
  assert.equal((html.match(/aria-label="开始采集叶片/g) || []).length, 1);
  assert.ok(html.includes("31 cm")); assert.ok(html.includes("4 个")); assert.ok(html.includes("2 轮"));
  assert.equal((html.match(/aria-label="选择叶片/g) || []).length, 3);
  assert.doesNotMatch(html, /field-auto-capture-row-actions/);
  assert.ok(startButton(html, "1", "P1")); assert.ok(!startButton(html, "1", "P1").includes("disabled"));
});
check("缺失参数只阻止该行采集，配置入口不再要求光斑校准", () => {
  const missing = { ...targets[1], route: { ...targets[1].route, cycle: null, errors: ["请先填写当前测点参数"] } };
  const html = render({ targets: [targets[0], missing] });
  const invalid = render({ targets: [targets[0], missing], selectedTargetKey: missing.key });
  assert.ok(startButton(invalid, "1", "P2").includes("disabled"));
  assert.ok(!startButton(html, "1", "P1").includes("disabled"));
  assert.ok(html.includes("待配置"));
  assert.ok(!html.includes("待校准")); assert.ok(!html.includes("去校准"));
  assert.match(invalid, /field-auto-capture-feedback[^>]*>请先填写当前测点参数/);
});
check("预定位不要求任务名或激光驱动，运行期间不能重复定位或采集", () => {
  const button = (html: string) => html.match(/<button[^>]*aria-label="移动到预设位置：叶片 1 · P1"[^>]*>/)?.[0] || "";
  const emptyTask = render({ config: { ...config, name: "" }, status: { ...ready, service: { ...ready.service, dllConfigured: false } } });
  assert.ok(button(emptyTask)); assert.ok(!button(emptyTask).includes("disabled"));
  assert.ok(startButton(emptyTask, "1", "P1").includes("disabled"));
  for (const patch of [{ status: { ...ready, turntableBusy: true } }, { pollError: "连接失败" }]) {
    const html = render(patch);
    assert.ok(button(html).includes("disabled"));
    assert.ok(startButton(html, "1", "P1").includes("disabled"));
  }
});
check("统一操作栏预定位期间可停止，启动未返回也可停止保存", () => {
  const pending = render({ busy: "preposition", onCancelPosition: noop });
  assert.match(pending, /<button(?![^>]*disabled)[^>]*aria-label="停止定位"/);
  assert.match(render({ busy: "preposition", positionStopping: true, onCancelPosition: noop }), /<button[^>]*disabled[^>]*aria-label="停止定位"/);
  assert.match(render({ busy: "start" }), /<button(?![^>]*disabled)[^>]*aria-label="停止并保存"/);
});
check("瞬时设备忙只禁用操作，不增添行内等待提示，真实异常仍显示", () => {
  const positionButton = (html: string) => html.match(/<button[^>]*aria-label="移动到预设位置：叶片 1 · P1"[^>]*>/)?.[0] || "";
  const inlineNotices = (html: string) => html.match(/<div class="field-auto-capture-feedback"[^>]*>[\s\S]*?<\/div>/g) || [];
  for (const patch of [{ turntableBusy: true }, { deviceBusy: true }]) {
    const status = { ...ready, ...patch };
    const html = render({ status, segmented: true });
    assert.match(positionButton(html), /disabled/);
    assert.match(startButton(html, "1", "P1"), /disabled/);
    assert.match(html, />待采集<\/span>/);
    assert.ok(inlineNotices(html).every(notice => !notice.includes("请等待")), "Busy polling uses disabled controls, not changing notices");
    const failed = render({ status: { ...status, deviceWarning: "激光状态读取失败" } });
    assert.ok(inlineNotices(failed).some(notice => notice.includes("激光状态读取失败")));
    const serviceFailed = render({ status: { ...status, service: { ...status.service, error: "采集服务连接失败" } } });
    assert.ok(inlineNotices(serviceFailed).some(notice => notice.includes("采集服务连接失败")));
    const sdkMissing = render({ status: { ...status, service: { ...status.service, dllConfigured: false } } });
    assert.ok(inlineNotices(sdkMissing).some(notice => notice.includes("尚未配置测振仪 SDK")));
  }
  assert.doesNotMatch(startButton(render(), "1", "P1"), /disabled/);
});
check("无光斑校准和缓存反馈的计算路线可发起新核验，仍需服务与SDK就绪", () => {
  const plan = planAutoFollow(autoFollowDefaults, null, "unknown", "COM6");
  const theoretical: FieldAutoCaptureTarget = { ...targets[0], route: { kind: "auto", name: "计算点位", pointNames: plan.points.map(point => point.name),
    cycle: plan.pointCycle!, errors: [], referenceMode: "read_at_start" } };
  const noCachedMotor: FieldStatus = { service: ready.service, state: "idle" };
  const html = render({ targets: [theoretical], status: noCachedMotor });
  assert.ok(!startButton(html, "1", "P1").includes("disabled"));
  assert.ok(html.includes("待采集"));
  assert.ok(!html.includes("待校准")); assert.ok(!html.includes("去校准"));
  const failed = structuredClone(ready); failed.turntable!.feedback!.axes!["1"].fault = 2;
  assert.ok(!startButton(render({ targets: [theoretical], status: failed }), "1", "P1").includes("disabled"), "Cached fault may request a new probe; the coordinator must reject any fault still returned");
  assert.ok(startButton(render({ targets: [theoretical], status: { ...noCachedMotor, service: { ...ready.service, dllConfigured: false } } }), "1", "P1").includes("disabled"));
});
check("服务、任务参数或轮询异常禁止请求，旧参考位可点击重新核验", () => {
  const changed = structuredClone(ready); changed.turntable!.feedback!.axes!["1"].origin_counts++;
  assert.ok(!startButton(render({ status: changed }), "1", "P1").includes("disabled"));
  for (const patch of [{ status: { ...ready, service: { ...ready.service, state: "error" as const } } }, { pollError: "服务连接已断开" }, { config: { ...config, name: "" } }]) {
    const html = render(patch); assert.ok(startButton(html, "1", "P1").includes("disabled"));
  }
});
check("当前采集身份优先于编辑选择，换点位间隙保留启动测点身份", () => {
  const cycle: NonNullable<FieldStatus["pointCycle"]> = { state: "positioning", pointCount: 4, point: 2, cycle: 1, cycles: 2, dwellSeconds: 60, speedRpm: .2, completedRecords: 1, totalRecords: 8 };
  const status: FieldStatus = { ...ready, state: "acquiring", pointCycle: cycle, recording: { id: "active", name: config.name, samples: 1000, sampleRate: 1000, startedAt: 1, status: "incomplete",
    pointCycle: { mode: "automatic_stations", bladeId: "2", radialPointId: "P1", cycle: 1, cycles: 2, pointIndex: 1, pointName: "点位2", dwellSeconds: 60, targetAxis1AngleDeg: 0, targetAxis2AngleDeg: 0 } } };
  assert.equal(activeAutoCaptureKey(targets, status, targets[0].key), targets[2].key);
  const html = render({ status });
  assert.equal((html.match(/aria-label="开始采集叶片/g) || []).length, 0);
  assert.match(html, /叶片 2 · P1/);
  assert.ok(html.includes("点位 2/4"));
  assert.equal((html.match(/>停止并保存<\/button>/g) || []).length, 1);
  assert.equal(activeAutoCaptureKey(targets, { ...status, recording: undefined }, targets[2].key), targets[2].key);
  assert.equal(activeAutoCaptureKey(targets, ready, targets[0].key), undefined);
});

const collectionId = "1".repeat(32);
function record(stationIndex: number, lapIndex: number, sessionId = "2".repeat(32), startedAt = 100): FieldRecording {
  return { id: `${sessionId}-${lapIndex}-${stationIndex}`, name: config.name, turbine: config.turbine, object: config.object, source: "polytec_ivs500", samples: 100, sampleRate: 1000, startedAt,
    status: "complete", pointCycle: { mode: "automatic_stations", collectionId, sessionId, bladeId: "1", radialPointId: "P1", radialPointName: "P1", radiusM: .31,
      completion: "confirmed_pass", cycle: lapIndex, cycles: 2, lapIndex, pointIndex: stationIndex - 1, stationIndex, stationCount: 4, azimuthDeg: (stationIndex - 1) * 90,
      pointId: `P1-${stationIndex - 1}`, pointName: `点位${stationIndex}`, dwellSeconds: 60, targetAxis1AngleDeg: 0, targetAxis2AngleDeg: 0,
      plannedStations: [0, 90, 180, 270].map((azimuthDeg, i) => ({ pointId: `P1-${i}`, bladeId: "1", radialPointId: "P1", radialPointName: "P1", radiusM: .31, azimuthDeg, stationIndex: i + 1, stationCount: 4 })) } };
}
check("完成状态要求最新批次所有圈所有站有效，重采缺口不能沿用旧完成", () => {
  const records = [1, 2].flatMap(lap => [1, 2, 3, 4].map(station => record(station, lap)));
  const complete = render({ recordings: records, collectionId });
  assert.equal((complete.match(/>已完成<\/span>/g) || []).length, 1);
  assert.ok(startButton(complete, "1", "P1"));
  const relocatedTargets = targets.map(target => target.key === targets[0].key ? { ...target, radiusM: .4 } : target);
  const relocated = render({ recordings: records, collectionId, targets: relocatedTargets });
  assert.ok(!relocated.includes(">已完成</span>"), "同ID旧半径记录不能当作新测量位置的已完成数据");
  assert.ok(relocated.includes("40 cm")); assert.ok(relocated.includes("待补采"));
  const roundedTargets = targets.map(target => target.key === targets[0].key ? { ...target, radiusM: .31 + 1e-12 } : target);
  assert.ok(render({ recordings: records, collectionId, targets: roundedTargets }).includes(">已完成</span>"), "二进制浮点噪声不改变位置归属");
  const partial = render({ recordings: records.slice(0, -1), collectionId });
  assert.ok(!partial.includes(">已完成</span>")); assert.ok(partial.includes("待补采"));
  const retry = { ...record(1, 1, "3".repeat(32), 200), status: "error" as const, error: "未确认离开" };
  const retried = render({ recordings: [...records, retry], collectionId });
  assert.ok(!retried.includes(">已完成</span>")); assert.ok(retried.includes("待补采"));
  assert.ok(!render({ recordings: records, collectionId, config: { ...config, turbine: "WT02" } }).includes(">已完成</span>"));
  const namedRecords = records.map(record => ({ ...record, turbine: config.name }));
  for (const turbine of ["", "   "]) {
    assert.ok(render({ recordings: namedRecords, collectionId, config: { ...config, turbine } }).includes(">已完成</span>"), "未单填风机编号时沿用风机任务名称归档");
  }
});
check("数据采集自动模式隐藏重复开始入口，保留普通与手动采集", () => {
  const route: FieldCaptureRoute = { ...targets[0].route, targets, selectedTargetKey: targets[0].key };
  const acquisitionProps: React.ComponentProps<typeof FieldAcquisition> = { config, onConfig: noop, source: "device", status: ready, busy: "", pollError: "", windowMs: 1000, onWindow: noop, refreshMs: 100, onRefresh: noop,
    request: async <T,>() => ({} as T), onDeviceStart: noop, onStop: noop, onService: noop, onRecords: noop,
    link: { enabled: true, onEnabled: noop, route, errors: ["另一个未校准测点不应阻塞当前行"], onConfigure: noop, mode: "auto", onMode: noop, onSelectTarget: noop, onStartTarget: noop, onConfigureTarget: noop } };
  const automatic = renderToStaticMarkup(<FieldAcquisition {...acquisitionProps} />);
  assert.ok(!automatic.includes('type="submit"'));
  assert.ok(!automatic.includes("另一个未校准测点不应阻塞当前行"));
  for (const label of ["风机任务", "风机编号", "手动点位", "自动跟随", "叶片与测点", "实时采集波形", "实时分析"]) assert.ok(automatic.includes(label), label);
  assert.ok(!automatic.includes("模拟"));
  for (const removed of ["本次记录", "叶片跟随流程", "field-capture-status", "field-capture-aside"]) assert.ok(!automatic.includes(removed), removed);
  const manual = renderToStaticMarkup(<FieldAcquisition {...acquisitionProps} link={{ ...acquisitionProps.link!, mode: "manual", route: { ...route, kind: "manual" } }} />);
  assert.ok(manual.includes("field-plain-capture-toolbar")); assert.ok(!manual.includes('aria-label="风机叶片逐点采集"'));
  assert.ok(manual.includes("移动到预设位置"));
  const ordinary = renderToStaticMarkup(<FieldAcquisition {...acquisitionProps} link={{ ...acquisitionProps.link!, enabled: false }} />);
  assert.ok(ordinary.includes("field-plain-capture-toolbar")); assert.ok(!ordinary.includes('aria-label="风机叶片逐点采集"'));
  assert.ok(!ordinary.includes("移动到预设位置"));
});
console.log(`${count} acquisition target presentation checks passed; no hardware or user data touched.`);
