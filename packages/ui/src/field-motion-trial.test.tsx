// Offline UI contracts. No production bridge, hardware or acquisition service.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldMotionTrial, FieldMotionTrialChart, motionTrialDefaults, motionTrialInputError, readMotionTrialDraft } from "./field-motion-trial";
import { FieldSinglePoint } from "./field-single-point";
import type { FieldMotionTrialConfig, FieldMotionTrialPreview } from "./field-motion-trial-types";
import type { FieldConfig, FieldStatus } from "./field-types";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const request = async <T,>(): Promise<T> => { throw new Error("Static rendering must never call a service"); };
const ready: FieldStatus = { service: { state: "ready", dllConfigured: true }, state: "idle" };
const capture: FieldConfig = { name: "界面验收", deviceIp: "198.51.100.10", hostIp: "198.51.100.11", object: "", turbine: "", point: "" };

check("默认几何为用户提供的当前模型，30秒一圈对应2rpm", () => {
  assert.deepEqual(motionTrialDefaults, { distanceM: 2.86, hubHeightDeltaM: 1.46, radiusM: .31, periodSeconds: 30, rotationDirection: "clockwise", axis1Sign: 1, axis2Sign: 1 });
  assert.equal(motionTrialInputError(motionTrialDefaults), null);
  const html = renderToStaticMarkup(<FieldMotionTrial request={request} onTurntable={() => {}} />);
  assert.match(html, /叶轮转速 2 rpm/);
  assert.ok(html.includes("应用30秒模型"));
  assert.ok(html.includes("从激光器一侧面向叶轮观察；顺时针依次为6点→9点→12点→3点→6点"));
  assert.ok(html.includes("尚未读取现场6点参考位"));
  assert.ok(html.includes("不连接串口、不启动激光或采集"));
});
check("尺寸、周期和方向边界与后端一致，异常输入不能提交", () => {
  const invalid = [{ distanceM: .0009 }, { distanceM: 10000.1 }, { radiusM: 0 }, { radiusM: 1001 }, { hubHeightDeltaM: 10001 }, { hubHeightDeltaM: -10001 }, { periodSeconds: .49 }, { periodSeconds: 3601 }, { distanceM: NaN }, { radiusM: Infinity }, { axis1Sign: 0 }, { axis2Sign: true }, { rotationDirection: "unknown" }];
  for (const value of invalid) assert.ok(motionTrialInputError({ ...motionTrialDefaults, ...value } as FieldMotionTrialConfig), JSON.stringify(value));
  for (const value of [{ distanceM: .001 }, { distanceM: 10000 }, { radiusM: .001 }, { radiusM: 1000 }, { hubHeightDeltaM: -10000 }, { periodSeconds: .5 }, { periodSeconds: 3600 }, { axis1Sign: -1 }, { rotationDirection: "counterclockwise" }]) assert.equal(motionTrialInputError({ ...motionTrialDefaults, ...value } as FieldMotionTrialConfig), null);
});
check("草稿不恢复参考位、执行能力、确认状态或伪造方向", () => {
  const saved = readMotionTrialDraft(JSON.stringify({ ...motionTrialDefaults, periodSeconds: 8, anchor: { axis1AngleDeg: 30 }, executionReady: true, confirmMotion: true, axis1Sign: true, rotationDirection: "invalid" }));
  assert.equal(saved.periodSeconds, 8); assert.equal(saved.axis1Sign, 1); assert.equal(saved.rotationDirection, "clockwise");
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(motionTrialDefaults).sort());
  assert.deepEqual(readMotionTrialDraft("broken"), motionTrialDefaults);
  assert.equal(readMotionTrialDraft(JSON.stringify({ ...motionTrialDefaults, periodSeconds: 5 })).periodSeconds, 5);
  assert.ok(Number.isNaN(readMotionTrialDraft('{"periodSeconds":null}').periodSeconds));
});
check("真实执行始终禁用，停止控制只提供转盘页入口", () => {
  const html = renderToStaticMarkup(<FieldMotionTrial request={request} onTurntable={() => {}} />);
  const button = html.match(/<button[^>]*>启动整圈试运行<\/button>/)?.[0];
  assert.ok(button?.includes('disabled=""'));
  assert.ok(html.includes("当前控制协议尚未支持整圈轨迹"));
  assert.ok(html.includes("查看转盘状态与停止控制"));
  assert.ok(!html.includes("已检测到硬件不支持"));
});
check("采集或设备忙时不能切换模式，初始模式保留原采集入口", () => {
  for (const patch of [{ state: "acquiring" }, { deviceBusy: true }, { turntableBusy: true }]) {
    const html = renderToStaticMarkup(<FieldSinglePoint config={capture} onConfig={() => {}} status={{ ...ready, ...patch } as FieldStatus} request={request} onStatus={() => {}} onTurntable={() => {}} onRecords={() => {}} />);
    const tab = html.match(/<button[^>]*role="tab"[^>]*>转速试运行<\/button>/)?.[0];
    assert.ok(tab?.includes('disabled=""'));
    assert.ok(html.includes("准备并开始记录"));
  }
});
check("曲线是完整两轴相对角度轨迹，标题不冒充实测反馈", () => {
  const preview = { durationSeconds: 30, trajectory: [0, 15, 30].map((timeSeconds, index) => ({ timeSeconds, axis1DeltaAngleDeg: index === 1 ? 10 : 0, axis2DeltaAngleDeg: 0 })) } as FieldMotionTrialPreview;
  const html = renderToStaticMarkup(<FieldMotionTrialChart preview={preview} />);
  assert.equal((html.match(/<polyline /g) || []).length, 2);
  assert.ok(html.includes("相对6点参考位"));
  assert.ok(html.includes("理想目标曲线；尚未下发指令，也没有实测运动反馈"));
});
console.log(`PASS ${checks} motion-trial UI checks; no hardware used`);
