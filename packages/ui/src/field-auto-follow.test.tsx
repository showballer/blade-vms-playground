// Offline contracts only. No device bridge or production Electron preload is loaded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldAutoFollow, FieldTurntableWorkspace, autoFollowAnchorFromStatus, autoFollowAnchorKey, autoFollowBlockers, readAutoFollowDraft } from "./field-auto-follow";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import type { FieldAxisFeedback, FieldConfig, FieldStatus } from "./field-types";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const axis = (angle: number, limit: number): FieldAxisFeedback => ({ output_angle_deg: angle, motor_rpm: 0, actual_counts: 0, commanded_counts: 0, error_counts: 0, display_mode: 0, command_counts_per_rev: 10000, encoder_bits: 16, flags: 0, fault: 0, origin_counts: 0, home_phase: 0, observedAt: 1792400000, referenceAngleDeg: 0, guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const ready: FieldStatus = { service: { state: "ready", dllConfigured: true, generation: 1 }, state: "idle", turntable: { state: "idle", port: "COM3", connected: true, feedback: { outputRpm: 0, motorRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0, axes: { "1": axis(10, 35), "2": axis(0, 180) } } } };
const config: FieldConfig = { name: "叶片站位采集", deviceIp: "198.51.100.10", hostIp: "198.51.100.11", object: "", turbine: "", point: "" };
const props = { config, onConfig: () => {}, status: ready, disabled: false, request: async <T,>(): Promise<T> => { throw new Error("No hardware in renderer test"); }, onStatus: () => {}, onRecords: () => {}, onService: () => {}, onManual: () => {} };

check("生产入口只有转盘手动与自动标签，没有单点、试运行与模拟开关", () => {
  const html = renderToStaticMarkup(<FieldTurntableWorkspace {...props} />);
  assert.ok(html.includes("手动控制")); assert.ok(html.includes("自动跟随"));
  assert.ok(!html.includes("单点跟随")); assert.ok(!html.includes("转速试运行")); assert.ok(!html.includes("模拟采集"));
  const source = readFileSync(new URL("./field-desktop.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes("FieldSinglePoint")); assert.ok(!source.includes("field-debug-toggle"));
  assert.ok(source.includes('source="device" showPointCycle={false}'));
  assert.ok(source.includes("FieldBladeSummary"));
});
check("默认30秒模型只生成输入，没有参考位与隐式开机请求", () => {
  const restored = readAutoFollowDraft(null);
  assert.equal(restored.draft.periodSeconds, 30); assert.equal(restored.draft.bladeId, "2");
  assert.equal(restored.draft.distanceM, 2.86); assert.equal(restored.draft.hubHeightDeltaM, 1.46); assert.equal(restored.draft.points[0].radiusM, .31);
  const html = renderToStaticMarkup(<FieldAutoFollow {...props} />);
  assert.ok(html.includes("读取两轴瞄准参考")); assert.ok(html.includes("开始前还需完成"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*?开始自动跟随/s);
  assert.ok(html.includes("不能自动识别叶片")); assert.ok(!html.includes("连续轨迹"));
});
check("仅恢复草稿字段，丢弃伪造参考和安全确认，保留用户旧周期", () => {
  const restored = readAutoFollowDraft(JSON.stringify({ port: "com3", anchor: { axis1AngleDeg: 1 }, confirmLaser: true, draft: { ...autoFollowDefaults, periodSeconds: 5, signsConfirmed: true, points: [{ id: "p2", name: "叶尖", radiusM: .6, reference: true }] } }));
  assert.equal(restored.port, "COM3"); assert.equal(restored.draft.periodSeconds, 5);
  assert.ok(!("anchor" in restored)); assert.ok(!("signsConfirmed" in restored.draft)); assert.ok(!("reference" in restored.draft.points[0]));
  assert.deepEqual(readAutoFollowDraft("corrupted"), readAutoFollowDraft(null));
});
check("首点或安装变化必须废弃参考，周期和后续测点变化可保留参考", () => {
  const key = autoFollowAnchorKey(autoFollowDefaults, "COM3");
  for (const patch of [{ distanceM: 3 }, { hubHeightDeltaM: 2 }, { direction: "counterclockwise" as const }, { axis1Sign: -1 as const }, { axis2Sign: -1 as const }, { points: [{ id: "p2", name: "P2", radiusM: .31 }] }, { points: [{ id: "p1", name: "P1", radiusM: .4 }] }]) assert.notEqual(autoFollowAnchorKey({ ...autoFollowDefaults, ...patch }, "COM3"), key);
  assert.notEqual(autoFollowAnchorKey(autoFollowDefaults, "COM4"), key);
  assert.equal(autoFollowAnchorKey({ ...autoFollowDefaults, periodSeconds: 20, points: [...autoFollowDefaults.points, { id: "p2", name: "P2", radiusM: .5 }] }, "COM3"), key);
});
check("读取锚点必须匹配串口、真实两轴参考、静止和软限位", () => {
  const anchor = autoFollowAnchorFromStatus(ready, "COM3", .31);
  assert.equal(anchor.axis1AngleDeg, 10); assert.equal(anchor.axis2AngleDeg, 0); assert.ok(anchor.referenceSignature);
  assert.throws(() => autoFollowAnchorFromStatus(ready, "COM4", .31));
  for (const patch of [{ fault: 1 }, { motor_rpm: 1 }, { motor_rpm: .01 }, { flags: 16 }, { output_angle_deg: 36 }, { output_angle_deg: null }, { guard: { soft_enabled: false, hardware_enabled: false, minimum_deg: -35, maximum_deg: 35 } }, { guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -36, maximum_deg: 35 } }]) {
    const next = structuredClone(ready); Object.assign(next.turntable!.feedback!.axes!["1"], patch);
    assert.throws(() => autoFollowAnchorFromStatus(next, "COM3", .31));
  }
});
check("计划需有效参考、全部目标在当前软限位内且设备就绪", () => {
  const anchor = autoFollowAnchorFromStatus(ready, "COM3", .31), plan = planAutoFollow(autoFollowDefaults, anchor);
  assert.deepEqual(autoFollowBlockers(config, ready, plan, anchor, "COM3"), []);
  const missingGuard = structuredClone(ready); missingGuard.turntable!.feedback!.axes!["2"].guard.soft_enabled = false;
  assert.ok(autoFollowBlockers(config, missingGuard, plan, anchor, "COM3").some(x => x.includes("软限位")));
  const narrow = structuredClone(ready); narrow.turntable!.feedback!.axes!["2"].guard.minimum_deg = -1;
  assert.ok(autoFollowBlockers(config, narrow, plan, anchor, "COM3").some(x => x.includes("超出当前软限位")));
  assert.ok(autoFollowBlockers(config, { ...ready, service: { state: "ready", dllConfigured: false } }, plan, anchor, "COM3").length > 0);
});
check("采集中禁用模式切换，停止不受外部忙状态阻塞", () => {
  const status: FieldStatus = { ...ready, state: "acquiring", pointCycle: { state: "capturing", port: "COM3", cycles: 1, dwellSeconds: 60, speedRpm: .6, pointCount: 4, cycle: 1, point: 1, completedRecords: 0, totalRecords: 4 } };
  const html = renderToStaticMarkup(<FieldTurntableWorkspace {...props} status={status} disabled />);
  assert.match(html, /role="tab"[^>]*disabled=""/);
  const button = html.match(/<button\b[^>]*>.*?<\/button>/gs)?.find(value => value.includes("停止并保存"));
  assert.ok(button && !button.includes("disabled"));
});
console.log(`PASS ${checks} automatic-follow UI checks; hardware not used`);
