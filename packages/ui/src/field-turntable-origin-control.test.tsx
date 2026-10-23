// Pure return-to-origin guards and static markup. No IPC, profile, or hardware.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldTurntableOriginControl, checkedOriginReturnMotion, originReturnArrivalError, originReturnTargetError, originStopError, originTrajectoryRecoverySession } from "./field-turntable-origin-control";
import { createWorkOrigin } from "./field-turntable-origin";
import type { FieldAxisFeedback, FieldStatus } from "./field-types";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const axis = (angle: number, limit: number, origin: number): FieldAxisFeedback => ({ output_angle_deg: angle, motor_rpm: 0,
  actual_counts: 0, commanded_counts: 0, error_counts: 0, display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17,
  flags: 3, fault: 0, origin_counts: origin, home_phase: 0, observedAt: 1000, referenceAngleDeg: 0,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const ready = (): FieldStatus => ({ service: { state: "ready", dllConfigured: true, generation: 2 }, state: "idle", turntableBusy: false,
  turntable: { state: "checked", port: "COM3", connected: false, motionCapability: { supported: true, mode: "dual_axis_timed", protocol: "0x30-0x36", probe: "confirmed", status: { state: 0, fault: 0 } },
    feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0, axes: { "1": axis(25, 35, 10), "2": axis(-5, 180, 20) } } } });
const original = ready(), origin = createWorkOrigin(original, "COM3");
const changed = (mutate: (status: FieldStatus) => void) => { const value = ready(); mutate(value); return value; };

check("回原点使用有效配置，按控制器精度向下取整且不回退固定低速", () => {
  assert.deepEqual(checkedOriginReturnMotion({ speedRpm: 5, maxMoveAccelerationDegS2: 30 }),
    { speedRpm: 5, maxMoveAccelerationDegS2: 30, followErrorLimitDeg: .75 });
  assert.deepEqual(checkedOriginReturnMotion({ speedRpm: .231, maxMoveAccelerationDegS2: 3.14159, followErrorLimitDeg: 1.23459 }),
    { speedRpm: .22, maxMoveAccelerationDegS2: 3.141, followErrorLimitDeg: 1.234 });
  for (const speedRpm of [NaN, Infinity, 0, .019, 10.001, true, "5", null])
    assert.throws(() => checkedOriginReturnMotion({ speedRpm: speedRpm as number, maxMoveAccelerationDegS2: 30 }));
  for (const acceleration of [NaN, Infinity, 0, .099, 120.001, true, "30", null])
    assert.throws(() => checkedOriginReturnMotion({ speedRpm: 5, maxMoveAccelerationDegS2: acceleration as number }));
  for (const limit of [NaN, Infinity, 0, .499, 10.001, true, "1", null])
    assert.throws(() => checkedOriginReturnMotion({ speedRpm: 5, maxMoveAccelerationDegS2: 30, followErrorLimitDeg: limit as number }));
});

check("公共光学原点回位保持绝对姿态，匹配参考且当前与目标都在真实范围", () => {
  const next = changed(value => { value.turntable!.feedback!.axes!["1"].output_angle_deg = 20; value.turntable!.feedback!.axes!["2"].output_angle_deg = 3; });
  const before = structuredClone(next);
  assert.equal(originReturnTargetError(origin, next, "COM3"), "");
  assert.deepEqual(next, before); assert.equal(origin.axis1AngleDeg, 25); assert.equal(origin.axis2AngleDeg, -5);
  const narrow = structuredClone(next); narrow.turntable!.feedback!.axes!["1"].guard.maximum_deg = 22;
  assert.match(originReturnTargetError(origin, narrow, "COM3"), /超出当前软限位/);
  const horizontalUnbounded = structuredClone(next); horizontalUnbounded.turntable!.feedback!.axes!["2"].guard.soft_enabled = false; horizontalUnbounded.turntable!.feedback!.axes!["2"].flags = 1;
  assert.equal(originReturnTargetError(origin, horizontalUnbounded, "COM3"), "");
});
check("fresh probe发现参考、代际、端口、故障或未停稳时拒绝回位", () => {
  assert.match(originReturnTargetError(null, original, "COM3"), /重新设置归零/);
  assert.match(originReturnTargetError(origin, original, "COM4"), /重新设置归零/);
  for (const mutate of [
    (value: FieldStatus) => { value.service.generation = 3; },
    (value: FieldStatus) => { value.turntable!.feedback!.axes!["2"].origin_counts++; },
    (value: FieldStatus) => { value.turntable!.feedback!.axes!["1"].fault = 2; },
    (value: FieldStatus) => { value.turntable!.feedback!.axes!["2"].motor_rpm = .01; },
    (value: FieldStatus) => { value.turntable!.feedback!.axes!["1"].guard.soft_enabled = false; },
    (value: FieldStatus) => { value.turntableBusy = true; },
    (value: FieldStatus) => { value.state = "acquiring"; },
    (value: FieldStatus) => { value.turntable!.state = "stopped"; },
  ]) assert.ok(originReturnTargetError(origin, changed(mutate), "COM3"));
});
check("到位须fresh停稳无故障且两轴误差不超过0.5度，任务complete字样不能代替核验", () => {
  assert.equal(originReturnArrivalError(origin, original, "COM3"), "");
  const within = changed(value => { value.turntable!.feedback!.axes!["1"].output_angle_deg = 25.5; value.turntable!.feedback!.axes!["2"].output_angle_deg = -5.5; });
  assert.equal(originReturnArrivalError(origin, within, "COM3"), "");
  const outside = structuredClone(within); outside.turntable!.feedback!.axes!["2"].output_angle_deg = -5.501;
  assert.match(originReturnArrivalError(origin, outside, "COM3"), /轴2.*超过0.5/);
  const moving = structuredClone(within); moving.turntable!.feedback!.axes!["1"].motor_rpm = .01;
  assert.ok(originReturnArrivalError(origin, moving, "COM3"));
  const completeOnly = changed(value => { value.turntable!.state = "stopped"; value.turntable!.recall = { state: "complete", targets: [25, -5], completedAxes: [1, 2] }; });
  assert.ok(originReturnArrivalError(origin, completeOnly, "COM3"));
});
check("恢复设备坐标后仍能回公共原点，无原点禁用，保存坐标待fresh核验时仍可操作", () => {
  let calls = 0;
  const props = { port: "COM3", status: original, disabled: false, origin: null,
    request: async <T,>() => { calls++; throw new Error("No hardware"); }, onOrigin: () => {}, onStatus: () => {}, onBusy: () => {} };
  const restored = renderToStaticMarkup(<FieldTurntableOriginControl {...props} opticalOrigin={origin} />);
  assert.match(restored, /<button(?![^>]*disabled)[^>]*aria-label="回到原点"/);
  assert.ok(restored.includes("设备坐标 · 光学零点已保留"));
  const missing = renderToStaticMarkup(<FieldTurntableOriginControl {...props} opticalOrigin={null} />);
  assert.match(missing, /<button(?=[^>]*disabled)(?=[^>]*aria-label="回到原点")[^>]*>/);
  const stale = renderToStaticMarkup(<FieldTurntableOriginControl {...props} status={changed(value => { value.service.generation = 3; })} opticalOrigin={origin} />);
  assert.match(stale, /<button(?![^>]*disabled)[^>]*aria-label="回到原点"/);
  assert.ok(stale.includes("作业原点已保存 · 待核验"));
  assert.equal(calls, 0);
});
check("停止核验不要求运动软限位就绪，仍严格确认两轴实际停止和无故障", () => {
  const limitsOff = changed(value => { value.turntable!.feedback!.axes!["1"].guard.soft_enabled = false; });
  assert.equal(originStopError(limitsOff, "COM3", 2), "", "Stopped controls may be unlocked to repair limits");
  assert.ok(originStopError(limitsOff, "COM4", 2));
  assert.ok(originStopError(limitsOff, "COM3", 3));
  for (const patch of [{ motor_rpm: .01 }, { flags: 19 }, { fault: 2 }]) {
    const moving = structuredClone(limitsOff); Object.assign(moving.turntable!.feedback!.axes!["2"], patch);
    assert.ok(originStopError(moving, "COM3", 2));
  }
});
check("故障轨迹提供就地清除入口，保留原点且不把清故障视为允许运动", () => {
  const failed = changed(value => { value.turntable!.motionCapability!.status = { state: 7, fault: 7, session: 42 }; });
  assert.equal(originTrajectoryRecoverySession(failed, "COM3"), 42);
  assert.match(originReturnTargetError(origin, failed, "COM3"), /清除旧轨迹.*无需重新设置归零/);
  let calls = 0;
  const html = renderToStaticMarkup(<FieldTurntableOriginControl port="COM3" status={failed}
    disabled={false} origin={origin} request={async <T,>() => { calls++; throw new Error("No hardware"); }}
    onOrigin={() => { throw new Error("Origin must remain unchanged"); }} onStatus={() => {}} onBusy={() => {}} />);
  assert.ok(html.includes("清除旧轨迹")); assert.ok(html.includes("原点坐标已保留"));
  assert.equal(calls, 0);
  for (const mutate of [
    (value: FieldStatus) => { value.turntable!.motionCapability!.status!.state = 3; },
    (value: FieldStatus) => { value.turntable!.motionCapability!.status!.fault = 2; },
    (value: FieldStatus) => { value.turntable!.motionCapability!.status!.session = 0; },
    (value: FieldStatus) => { value.state = "acquiring"; },
    (value: FieldStatus) => { value.turntableBusy = true; },
  ]) {
    const other = structuredClone(failed); mutate(other);
    assert.equal(originTrajectoryRecoverySession(other, "COM3"), null);
  }
  assert.equal(originTrajectoryRecoverySession(failed, "COM4"), null);
});
console.log(`PASS ${checks} return-origin pure/markup checks; hardware not used`);
