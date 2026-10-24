import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { checkedDriveProfile, checkedDriveProfileReply, driveProfileFastPreset, FieldDriveProfile } from "./field-drive-profile";
import type { FieldStatus } from "./field-types";

const values = { accel_ms: 100, decel_ms: 100, s_curve_ms: 0 };
const ready = (): FieldStatus => ({ service: { state: "ready", dllConfigured: true, generation: 1 }, state: "idle",
  turntable: { state: "checked", port: "COM3", motionProfile: {
    axis: 1, values, readAt: 1000, operation: "write", verified: true, temporary: true } } });

test("PA40/41/42 accept vendor integer limits and reject blank, coerced, fractional values", () => {
  assert.deepEqual(checkedDriveProfile({ accel_ms: "100", decel_ms: "100", s_curve_ms: "0" }), values);
  assert.deepEqual(checkedDriveProfile({ accel_ms: "10000", decel_ms: "1", s_curve_ms: "1000" }),
    { accel_ms: 10000, decel_ms: 1, s_curve_ms: 1000 });
  for (const [key, value] of [["accel_ms", ""], ["accel_ms", "0"], ["accel_ms", "10001"], ["accel_ms", "1.5"],
    ["accel_ms", " "], ["accel_ms", "1e2"], ["decel_ms", "-1"], ["s_curve_ms", "1001"], ["s_curve_ms", "-1"]]) {
    assert.throws(() => checkedDriveProfile({ accel_ms: "100", decel_ms: "100", s_curve_ms: "0", [key]: value }));
  }
});
test("a write succeeds only on matching selected axis, port, operation and verified values", () => {
  assert.equal(checkedDriveProfileReply(ready(), "COM3", 1, "write", values).verified, true);
  const mutations = [
    (s: FieldStatus) => { s.turntable!.port = "COM4"; },
    (s: FieldStatus) => { s.turntable!.motionProfile!.axis = 2; },
    (s: FieldStatus) => { s.turntable!.motionProfile!.operation = "read"; },
    (s: FieldStatus) => { s.turntable!.motionProfile!.readAt = NaN; },
    (s: FieldStatus) => { s.turntable!.error = "lost ACK"; },
    (s: FieldStatus) => { s.turntable!.motionProfile!.values = { ...values, accel_ms: 200 }; },
    (s: FieldStatus) => { delete s.turntable!.motionProfile; },
  ];
  for (const mutate of mutations) {
    const s = ready(); mutate(s);
    assert.throws(() => checkedDriveProfileReply(s, "COM3", 1, "write", values));
  }
});
test("both axes are visible with no invented default or write before explicit read", () => {
  let calls = 0;
  const props = { port: "COM3", status: ready(), disabled: false, onBusy() {}, onStatus() {},
    request: async <T,>() => { calls++; throw new Error("No hardware"); } };
  const html = renderToStaticMarkup(<FieldDriveProfile {...props} />);
  assert.equal(calls, 0);
  assert.match(html, /驱动器加减速设置/);
  for (const axis of ["俯仰轴", "水平轴"]) {
    assert.match(html, new RegExp(`<button(?![^>]*disabled)[^>]*aria-label="读取${axis}驱动参数"`));
    assert.match(html, new RegExp(`<button[^>]*disabled[^>]*aria-label="应用${axis}驱动参数"`));
  }
  assert.match(html, /尚未读取当前轴/);
  assert.doesNotMatch(html, /value="100"/);
  const busy = renderToStaticMarkup(<FieldDriveProfile {...props} status={{ ...ready(), turntableBusy: true }} />);
  assert.match(busy, /<button[^>]*disabled[^>]*aria-label="读取俯仰轴驱动参数"/);
});
test("optional fast preset is visible and expanded without treating it as a read or writing hardware", () => {
  let calls = 0, presetCalls = 0;
  const html = renderToStaticMarkup(<FieldDriveProfile port="COM3" status={ready()} disabled={false} expanded
    onBusy={() => {}} onStatus={() => {}} onFastPreset={() => { presetCalls++; }}
    request={async <T,>() => { calls++; throw new Error("No hardware"); }} />);
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /<button[^>]*disabled[^>]*>填入快速预设<\/button>/);
  assert.match(html, /5 rpm · 100 \/ 100 \/ 0 ms/);
  assert.doesNotMatch(html, /value="100"/);
  assert.equal(calls, 0); assert.equal(presetCalls, 0);
  assert.equal(driveProfileFastPreset.speedRpm, 5);
  assert.deepEqual(checkedDriveProfile({ accel_ms: String(driveProfileFastPreset.values.accel_ms),
    decel_ms: String(driveProfileFastPreset.values.decel_ms), s_curve_ms: String(driveProfileFastPreset.values.s_curve_ms) }), values);
});
