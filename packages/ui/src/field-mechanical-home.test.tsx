import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldMechanicalHome } from "./field-mechanical-home";
import type { FieldRequestOptions, FieldStatus } from "./field-types";

const ready = (): FieldStatus => ({ service: { state: "ready", dllConfigured: false, generation: 1 }, state: "idle" });
const markup = (status = ready(), port = "/dev/cu.usbserial-110", disabled = false) => renderToStaticMarkup(
  <FieldMechanicalHome port={port} status={status} disabled={disabled} request={async <T,>(_o: FieldRequestOptions) => { throw new Error("render must not issue commands"); }} onStatus={() => {}} onBusy={() => {}} />);
const button = (html: string, text: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*?${text}</button>`))?.[0] || "";

test("mechanical and level reference controls remain separate from the work origin, with no render-time I/O", () => {
  const html = markup();
  assert.match(html, /俯仰轴参考/);
  assert.match(html, /机械回零/); assert.match(html, /回水平 0°/);
  assert.match(html, /清除俯仰轴参考/); assert.match(html, /title="清除后须机械回零/);
  assert.match(html, /水平轴参考/); assert.match(html, /确认水平轴为 0°/);
  assert.match(html, /\+35°/); assert.doesNotMatch(html, /机械回零向上寻找|日常采集无需清除|设备坐标：/);
  assert.match(html, /回零速度 · °\/s/); assert.match(html, /value="0.6"/);
  assert.doesNotMatch(button(html, "机械回零"), /disabled/);
  assert.doesNotMatch(html, /待校准|需要确认|type="checkbox"/);
});

test("clearing pitch reference can request fresh checks after a reference error without a prior health report", () => {
  assert.match(button(markup(), "清除俯仰轴参考"), /disabled/);
  const status = ready();
  const pose = { output_angle_deg: null, motor_rpm: 0, actual_counts: 90, commanded_counts: 0, error_counts: 0,
    display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 21, flags: 0, fault: 3, origin_counts: 0,
    home_phase: 8, observedAt: 1, referenceAngleDeg: 0,
    guard: { soft_enabled: false, hardware_enabled: false, minimum_deg: -180, maximum_deg: 180 } };
  status.turntable = { state: "checked", port: "COM7", health: { readOnly: true, readAt: 1, referenceChangedDuringRead: false, axes: {} },
    feedback: { axes: { "1": { ...pose }, "2": { ...pose } }, outputRpm: 0, motorRpm: 0, alarmCode: 0, limitFlags: null, positionRaw: 0 } };
  assert.doesNotMatch(button(markup(status, "COM7"), "清除俯仰轴参考"), /disabled/);
  status.turntable!.feedback!.axes!["2"].motor_rpm = 1;
  assert.match(button(markup(status, "COM7"), "清除俯仰轴参考"), /disabled/);
  status.turntable!.feedback!.axes!["2"].motor_rpm = 0;
  status.turntable!.health!.referenceChangedDuringRead = true;
  assert.doesNotMatch(button(markup(status, "COM7"), "清除俯仰轴参考"), /disabled/);
  delete status.turntable!.health;
  status.turntable!.state = "error";
  status.turntable!.error = "回零定位期间参考位或反馈计数单位变化，已停止";
  assert.doesNotMatch(button(markup(status, "COM7"), "清除俯仰轴参考"), /disabled/);
  assert.doesNotMatch(button(markup(status, "COM7"), "确认水平轴为 0°"), /disabled/);
  status.turntable!.motionCapability = { supported: true, mode: "dual_axis_timed", protocol: "0x30-0x36", probe: "confirmed", status: { state: 3 } };
  assert.match(button(markup(status, "COM7"), "清除俯仰轴参考"), /disabled/);
});

test("horizontal reference waits for actual stationary feedback and never depends on a valid old reference", () => {
  assert.match(button(markup(), "确认水平轴为 0°"), /disabled/);
  const status = ready();
  const yaw = { output_angle_deg: null, motor_rpm: 0, actual_counts: 90, commanded_counts: 0, error_counts: 0,
    display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 21, flags: 0, fault: 0, origin_counts: 0,
    home_phase: 0, observedAt: 1, referenceAngleDeg: 0,
    guard: { soft_enabled: false, hardware_enabled: false, minimum_deg: -180, maximum_deg: 180 } };
  status.turntable = { state: "checked", port: "COM7", feedback: { axes: { "2": yaw },
    outputRpm: 0, motorRpm: 0, alarmCode: 0, limitFlags: null, positionRaw: 90 } };
  assert.doesNotMatch(button(markup(status, "COM7"), "确认水平轴为 0°"), /disabled/);
  yaw.motor_rpm = 1;
  assert.match(button(markup(status, "COM7"), "确认水平轴为 0°"), /disabled/);
  yaw.motor_rpm = 0; yaw.flags = 16;
  assert.match(button(markup(status, "COM7"), "确认水平轴为 0°"), /disabled/);
  yaw.flags = 0; yaw.fault = 8;
  assert.match(button(markup(status, "COM7"), "确认水平轴为 0°"), /disabled/);
});

test("busy capture and disconnected service block movement, while active homing exposes an enabled stop", () => {
  for (const status of [{ ...ready(), state: "acquiring" }, { ...ready(), deviceBusy: true },
    { ...ready(), turntableBusy: true }, { ...ready(), service: { ...ready().service, state: "stopped" } }] as FieldStatus[])
    assert.match(button(markup(status), "机械回零"), /disabled/);
  assert.match(button(markup(ready(), ""), "机械回零"), /disabled/);
  assert.match(button(markup(ready(), "COM7", true), "机械回零"), /disabled/);
  const status = ready();
  status.turntableBusy = true;
  status.turntable = { port: "/dev/cu.usbserial-110", state: "homing", homing: { action: "mechanical_home", state: "running",
    phase: "seeking_limit", targetAngleDeg: 35, speedDegS: .6, effectiveRpm: .1 } };
  const html = markup(status);
  assert.match(html, /寻找机械限位/);
  assert.match(button(html, "机械回零"), /disabled/);
  const stop = html.match(/<button[^>]*>(?:(?!<button)[\s\S])*?停止回零<\/button>/)?.[0];
  assert.ok(stop); assert.doesNotMatch(stop, /disabled/);
});

test("a failed readback never says completed; verified completion shows the actual reference target", () => {
  const status = ready();
  status.turntable = { port: "/dev/cu.usbserial-110", state: "error", error: "限位通信失败", homing: { action: "mechanical_home", state: "error",
    phase: "error", targetAngleDeg: 35, speedDegS: .6, effectiveRpm: .1, verified: false } };
  assert.match(markup(status), /限位通信失败/); assert.doesNotMatch(markup(status), /已完成/);
  status.turntable.homing = { ...status.turntable.homing!, state: "complete", phase: "complete", verified: true };
  status.turntable.error = undefined;
  assert.match(markup(status), /已完成 · 俯仰 35°/);
});
