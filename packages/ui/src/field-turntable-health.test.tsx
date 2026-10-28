import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldTurntableHealth, turntableHealthReport, turntableRecoveryOptions } from "./field-turntable-health";
import type { FieldAxisFeedback, FieldStatus } from "./field-types";

const axis = (angle: number, limit: number): FieldAxisFeedback => ({ output_angle_deg: angle, motor_rpm: 0,
  actual_counts: 0, commanded_counts: 0, error_counts: 0, display_mode: 3, command_counts_per_rev: 10000,
  encoder_bits: 21, flags: 3, fault: 0, origin_counts: 0, home_phase: 0, observedAt: 100,
  referenceAngleDeg: 0, guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const ready = (): FieldStatus => ({ service: { state: "ready", dllConfigured: true, generation: 1 }, state: "idle",
  turntable: { state: "checked", port: "COM3", feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0,
    axes: { "1": axis(12, 35), "2": axis(-16, 180) } }, health: { readAt: 100, readOnly: true, referenceChangedDuringRead: false,
    axes: { "1": { alarmCode: 0, runState: 0, limitFlags: 0, observedAt: 100 }, "2": { alarmCode: 0, runState: 0, limitFlags: 0, observedAt: 100 } } },
    motionCapability: { supported: true, mode: "dual_axis_timed", protocol: "0x30-0x36", probe: "confirmed", status: { state: 0, fault: 0 } } } });
let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
check("定位运动标志不报故障，停止待确认显示等待，真实故障仍为红色", () => {
  const value = ready();
  value.turntable!.feedback!.axes!["1"].flags |= 0x20;
  let report = turntableHealthReport(value, "COM3");
  assert.equal(report.tone, "blue");
  assert.equal(report.axes[0].stop, "定位运动中");
  value.turntable!.feedback!.axes!["1"].flags = 0x13;
  report = turntableHealthReport(value, "COM3");
  assert.equal(report.tone, "amber");
  assert.equal(report.axes[0].stop, "停机待确认");
  assert.equal(report.problems.length, 0);
  value.turntable!.feedback!.axes!["1"].fault = 8;
  assert.equal(turntableHealthReport(value, "COM3").tone, "red");
});
check("回零参考变化或读取失败只触发重新核查，不全局锁住恢复按钮", () => {
  const value = ready();
  value.turntable!.state = "error";
  value.turntable!.error = "回零定位期间参考位或反馈计数单位变化，已停止";
  delete value.turntable!.health;
  delete value.turntable!.motionCapability;
  assert.equal(turntableRecoveryOptions(value, "COM3").retry, true);
  assert.equal(turntableRecoveryOptions(value, "COM4").retry, false);
  value.turntable!.feedback!.axes!["2"].motor_rpm = 1;
  assert.equal(turntableRecoveryOptions(value, "COM3").retry, false);
  assert.equal(turntableRecoveryOptions(ready(), "COM3", true).retry, true);
  for (const state of ["starting", "acquiring", "stopping"]) {
    value.state = state as FieldStatus["state"];
    assert.equal(turntableRecoveryOptions(value, "COM3").retry, false);
  }
});
check("双轴报警与轨迹完整读取后才能显示本次无异常", () => {
  assert.equal(turntableHealthReport(ready(), "COM3").tone, "green");
  for (const kind of ["port", "health", "axis", "alarm", "referenceChanged", "service", "trajectory"]) {
    const value = ready();
    if (kind === "port") value.turntable!.port = "COM4";
    if (kind === "health") delete value.turntable!.health;
    if (kind === "axis") delete value.turntable!.feedback!.axes!["2"];
    if (kind === "alarm") delete value.turntable!.health!.axes["2"];
    if (kind === "referenceChanged") value.turntable!.health!.referenceChangedDuringRead = true;
    if (kind === "service") value.service.state = "error";
    if (kind === "trajectory") value.turntable!.motionCapability!.status = null;
    assert.notEqual(turntableHealthReport(value, "COM3").tone, "green", kind);
  }
});
check("真实故障样例分别报告轴3与轨迹7，不把零速当成可继续定位", () => {
  const value = ready();
  Object.assign(value.turntable!.feedback!.axes!["1"], { fault: 3, flags: 18, output_angle_deg: null });
  value.turntable!.motionCapability!.status = { state: 7, fault: 7, error1_deg: -1.031, error2_deg: -.004 };
  const report = turntableHealthReport(value, "COM3");
  assert.equal(report.tone, "red"); assert.equal(report.axes[0].stop, "停机待确认");
  assert.match(report.axes[0].fault, /反馈单位变化／计数不连续（3）/);
  assert.match(report.trajectoryFault, /跟随误差超限（7）/);
  assert.equal(report.axes[0].angle, "无有效角度");
  assert.deepEqual(report.errors, ["-1.031°", "-0.004°"]);
});
check("区分等待、运动、未知代码和已取消，水平轴明确关闭软范围可用", () => {
  for (const state of [1, 2]) { const value = ready(); value.turntable!.motionCapability!.status = { state, fault: 0 };
    assert.equal(turntableHealthReport(value, "COM3").tone, "amber"); }
  for (const state of [3, 4, 5]) { const value = ready(); value.turntable!.motionCapability!.status = { state, fault: 0 };
    assert.equal(turntableHealthReport(value, "COM3").tone, "blue"); }
  const value = ready(); value.turntable!.motionCapability!.status = { state: 8, fault: 1 };
  value.turntable!.feedback!.axes!["2"].guard.soft_enabled = false; value.turntable!.feedback!.axes!["2"].flags = 1;
  assert.equal(turntableHealthReport(value, "COM3").tone, "green");
  value.turntable!.feedback!.axes!["2"].fault = 99;
  assert.equal(turntableHealthReport(value, "COM3").tone, "red");
  assert.match(turntableHealthReport(value, "COM3").axes[1].fault, /未知代码（99）/);
});
check("第二轴驱动器报警和停止标记不会被第一轴零报警掩盖", () => {
  const value = ready(); value.turntable!.health!.axes["2"].alarmCode = 12;
  assert.ok(turntableHealthReport(value, "COM3").problems.some(text => text.includes("水平轴驱动器报警：12")));
  value.turntable!.health!.axes["2"].alarmCode = 0; value.turntable!.health!.axes["2"].limitFlags = 2;
  assert.equal(turntableHealthReport(value, "COM3").tone, "amber");
  value.turntable!.health!.axes["2"].limitFlags = 1;
  assert.equal(turntableHealthReport(value, "COM3").tone, "red");
});
check("新固件定位执行故障可识别，停稳且参考有效才允许清除", () => {
  const value = ready();
  Object.assign(value.turntable!.feedback!.axes!["1"], { fault: 8, home_phase: 8 });
  const report = turntableHealthReport(value, "COM3");
  assert.equal(report.tone, "red");
  assert.match(report.axes[0].fault, /定位执行异常（8）/);
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[0].guard, true);
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[0].execution, true);
  value.turntable!.feedback!.axes!["1"].output_angle_deg = 35.006;
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[0].guard, false);
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[0].execution, true, "专用确认由固件检查双限位端点余量");
  value.turntable!.feedback!.axes!["1"].flags |= 16;
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[0].guard, false);
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[0].execution, false);
});
check("静态入口不执行查询或故障恢复", () => {
  let calls = 0;
  const html = renderToStaticMarkup(<FieldTurntableHealth port="COM3" status={ready()} request={async <T,>() => { calls++; throw Error("No hardware"); }} onStatus={() => {}} onBusy={() => {}} />);
  assert.ok(html.includes('aria-label="检查转盘状态"')); assert.equal(calls, 0);
  assert.ok(!html.includes("一键恢复")); assert.ok(!html.includes("自动复位"));
});
check("恢复按故障分项，不允许无参考强清、运动中恢复或误用另一端口", () => {
  const value = ready(); value.turntable!.motionCapability!.status = { state: 7, fault: 7 };
  Object.assign(value.turntable!.feedback!.axes!["1"], { fault: 3, flags: 18, output_angle_deg: null });
  let result = turntableRecoveryOptions(value, "COM3");
  assert.equal(result.trajectory, true); assert.equal(result.axes[0].guard, false);
  Object.assign(value.turntable!.feedback!.axes!["1"], { flags: 3, output_angle_deg: 12 });
  result = turntableRecoveryOptions(value, "COM3"); assert.equal(result.axes[0].guard, true);
  value.turntable!.health!.axes["1"].alarmCode = 1;
  result = turntableRecoveryOptions(value, "COM3"); assert.equal(result.axes[0].guard, false); assert.equal(result.axes[0].alarm, true);
  value.turntable!.feedback!.axes!["2"].motor_rpm = 1;
  assert.equal(turntableRecoveryOptions(value, "COM3").trajectory, false);
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[0].alarm, false);
  assert.equal(turntableRecoveryOptions(value, "COM4").trajectory, false);
});
check("兼容未返回扩展限位标志的设备，待启动轨迹和真实停止异常仍禁用恢复", () => {
  const value = ready(); value.turntable!.feedback!.axes!["2"].fault = 2;
  value.turntable!.health!.axes["2"].limitFlags = null;
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[1].guard, true);
  value.turntable!.health!.axes["2"].alarmCode = 1;
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[1].alarm, true);
  value.turntable!.motionCapability!.status = { state: 2, fault: 0 };
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[1].alarm, false);
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[1].guard, false);
  value.turntable!.motionCapability!.status = { state: 0, fault: 0 };
  value.turntable!.feedback!.axes!["2"].flags |= 16;
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[1].alarm, false);
  value.turntable!.feedback!.axes!["2"].flags &= ~16;
  value.turntable!.health!.axes["2"].limitFlags = 2;
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[1].alarm, false);
  delete value.turntable!.health!.axes["2"];
  assert.equal(turntableRecoveryOptions(value, "COM3").axes[1].alarm, false);
});
check("只允许取消已读取且两轴静止的待启动会话，不能取消其他轨迹或伪造会话", () => {
  const value = ready();
  for (const state of [0, 1, 3, 4, 5, 6, 7, 8]) {
    value.turntable!.motionCapability!.status = { state, fault: 0, session: 42 };
    assert.equal(turntableRecoveryOptions(value, "COM3").cancelPending, false);
  }
  value.turntable!.motionCapability!.status = { state: 2, fault: 0, session: 42 };
  assert.equal(turntableRecoveryOptions(value, "COM3").cancelPending, true);
  assert.equal(turntableRecoveryOptions(value, "COM3").trajectory, false);
  assert.equal(turntableRecoveryOptions(value, "COM4").cancelPending, false);
  value.turntable!.motionCapability!.status!.fault = 7;
  assert.equal(turntableRecoveryOptions(value, "COM3").cancelPending, false);
  value.turntable!.motionCapability!.status!.fault = 0;
  for (const session of [undefined, 0, 65536, 2.5]) {
    value.turntable!.motionCapability!.status!.session = session;
    assert.equal(turntableRecoveryOptions(value, "COM3").cancelPending, false);
  }
  value.turntable!.motionCapability!.status!.session = 42;
  value.turntable!.feedback!.axes!["2"].motor_rpm = 1;
  assert.equal(turntableRecoveryOptions(value, "COM3").cancelPending, false);
});
check("驱动器加减速读取值与换点加速度分开显示，不从默认值推断", () => {
  const value = ready();
  assert.equal(turntableHealthReport(value, "COM3").axes[0].profile.acceleration, "未读取");
  value.turntable!.health!.motionProfiles = { "1": { accel_ms: 1500, decel_ms: 800, s_curve_ms: 100 }, "2": { unavailable: "固件不支持" } };
  const report = turntableHealthReport(value, "COM3");
  assert.deepEqual(report.axes[0].profile, { acceleration: "1500 ms", deceleration: "800 ms", smoothing: "100 ms", unavailable: undefined });
  assert.equal(report.axes[1].profile.acceleration, "未读取");
  assert.equal(report.axes[1].profile.unavailable, "固件不支持");
});
console.log(`${checks} health presentation checks passed; no hardware accessed.`);
