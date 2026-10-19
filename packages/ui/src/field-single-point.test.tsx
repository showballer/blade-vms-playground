// Offline UI contract checks only; never imports the acquisition service or accesses hardware.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldSinglePoint, FieldSinglePointPreviewCard, readSinglePointDraft, singlePointDefaults, singlePointDraftForStorage, singlePointInputError, singlePointIsRunning, singlePointStateLabel } from "./field-single-point";
import type { FieldConfig, FieldStatus } from "./field-types";
import type { FieldSinglePointConfig, FieldSinglePointPreview, FieldSinglePointStatus } from "./field-single-point-types";

let checks = 0;
function check(label: string, run: () => void) { run(); checks++; console.log(`PASS ${label}`); }
const config: FieldSinglePointConfig = { ...singlePointDefaults, distanceM: 2, radiusM: 0.6, hubHeightDeltaM: 0.8, materialMark: "A叶片根侧圆点", frontFacingConfirmed: true, motionTimingConfirmed: true };
const capture: FieldConfig = { name: "离线 UI 验证", deviceIp: "198.51.100.10", hostIp: "198.51.100.11", object: "", turbine: "", point: "" };
const preview: FieldSinglePointPreview = { ready: true, blockReasons: [], warnings: [], motionModel: "position_chord_approximation", phaseLocked: false, identityConfirmed: false, anchorBound: true, periodSeconds: 5, periodSource: "manual_marks", durationSeconds: 0.278, startAngles: { axis1AngleDeg: 10, axis2AngleDeg: -1 }, endAngles: { axis1AngleDeg: 10.1, axis2AngleDeg: -1.1 }, axisMoves: [], maxPathErrorMm: 0.5, predictionErrorMm: 4, errorBudget: { pathApproximationMm: 0.5, manualSyncMm: 2, periodVariationMm: 0.5, commandTimingMm: 0.5, axisStartSkewMm: 0.5, totalMm: 4 }, trajectory: [] };
const session: FieldSinglePointStatus = { sessionId: "ui-only", state: "ready", config, anchor: { axis1AngleDeg: 10, axis2AngleDeg: -1 }, preview, sync: { ready: true, blockReasons: [], markCount: 5, periodSeconds: 5, rpm: 12, periodVariationPercent: 0.2, phaseLocked: false, identityConfirmed: false, source: "manual_marks" }, marks: [{ sequence: 1, hostTime: 1792400000 }], phaseLocked: false, identityConfirmed: false, motionModel: "position_chord_approximation", quality: "manual_unverified" };
const ready: FieldStatus = { service: { state: "ready", dllConfigured: true }, state: "idle" };
const render = (status: FieldStatus, disabled = false) => renderToStaticMarkup(<FieldSinglePoint config={capture} onConfig={() => {}} status={status} disabled={disabled} request={async <T,>() => { throw new Error("SSR must never call a device"); }} onStatus={() => {}} onTurntable={() => {}} onRecords={() => {}} />);

check("首次进入使用本次30秒模型，未填写材料标记或核对条件仍不能准备", () => {
  assert.ok(singlePointInputError(singlePointDefaults));
  assert.equal(singlePointDefaults.nominalPeriodSeconds, 30);
  assert.equal(singlePointDefaults.maxSyncAgeSeconds, 45);
  assert.equal(singlePointDefaults.arcDegrees, 20);
  assert.deepEqual([singlePointDefaults.maxOutputRpm, singlePointDefaults.maxOutputAccelerationDegS2, singlePointDefaults.motionRampSeconds, singlePointDefaults.commandLatencyMs, singlePointDefaults.axisStartSkewMs, singlePointDefaults.syncUncertaintyMs, singlePointDefaults.maxApproximationErrorMm, singlePointDefaults.maxPredictionErrorMm], [.6, 10, .15, 100, 100, 150, 2, 5]);
  const html = render(ready);
  for (const label of ["静止准备", "目标叶片过点同步", "一次短弧", "材料标记", "本机设备网卡 IP", "允许预测总误差", "准备并开始记录"]) assert.ok(html.includes(label), label);
  assert.match(html, /<input[^>]*aria-label="设备至叶轮平面距离 · m"[^>]*value="2.86"/);
  assert.ok(html.includes("应用30秒模型"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^<]*(?:<[^>]*>.*?)*准备并开始记录/s);
  assert.ok(!html.includes('value="250"'));
});
check("草稿只保留输入，不恢复参考位、同步、会话或现场确认", () => {
  const saved = singlePointDraftForStorage(config, "COM3");
  assert.equal("frontFacingConfirmed" in saved.config, false);
  assert.equal("motionTimingConfirmed" in saved.config, false);
  const restored = readSinglePointDraft(JSON.stringify({ ...saved, prepared: true, sync: { ready: true }, anchor: session.anchor, sessionId: "stale", config: { ...saved.config, frontFacingConfirmed: true, motionTimingConfirmed: true, confirmLaser: true, anchor: session.anchor } }));
  assert.equal(restored.config.frontFacingConfirmed, false);
  assert.equal(restored.config.motionTimingConfirmed, false);
  assert.equal(restored.config.distanceM, 2);
  assert.equal("anchor" in restored.config, false);
  assert.equal("confirmLaser" in restored.config, false);
  assert.equal(readSinglePointDraft('{"config":{"distanceM":null}}').config.distanceM, NaN);
  assert.equal(readSinglePointDraft("not JSON").port, "");
  const older = readSinglePointDraft(JSON.stringify({ config: { ...config, nominalPeriodSeconds: 5, maxSyncAgeSeconds: 15, axis1Sign: -1 }, port: "COM3" }));
  assert.equal(older.config.nominalPeriodSeconds, 5); assert.equal(older.config.maxSyncAgeSeconds, 15); assert.equal(older.config.axis1Sign, -1); assert.equal(older.port, "COM3");
});
check("尺寸和误差预算必须有效，超过30度不能启动单次短弧", () => {
  assert.equal(singlePointInputError(config), null);
  for (const change of [{ distanceM: 0 }, { radiusM: -1 }, { arcDegrees: 31 }, { maxPredictionErrorMm: 0 }, { motionRampSeconds: 0 }, { syncUncertaintyMs: -1 }, { distanceM: 0.0001 }, { radiusM: 1001 }, { hubHeightDeltaM: 10001 }, { arcDegrees: 0.09 }, { nominalPeriodSeconds: 0.49 }, { nominalPeriodSeconds: 3601 }, { maxOutputRpm: 10.01 }, { maxOutputAccelerationDegS2: 5001 }, { motionRampSeconds: 0.0009 }, { commandLatencyMs: 5001 }, { maxPeriodVariationPercent: 0 }, { maxSyncAgeSeconds: 301 }, { maxPredictionErrorMm: 1001 }]) assert.ok(singlePointInputError({ ...config, ...change }), JSON.stringify(change));
});
check("服务同步就绪不自动恢复运动确认，停止不被外部busy锁定", () => {
  const html = render({ ...ready, state: "acquiring", singlePoint: session }, true);
  assert.ok(html.includes("不代表相位锁定或自动识别叶片"));
  assert.ok(html.includes("波形有效不等于跟随成功"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*?预约下一次经过并跟随/s);
  const stop = html.match(/<button[^>]*>.*?停止转盘并结束记录<\/button>/s)?.[0].split("<button").at(-1);
  assert.ok(stop && !stop.includes("disabled"), "A stop must remain available during another pending operation");
  assert.ok(!html.match(/<input[^>]*aria-label="确认单次短弧运动"[^>]*>/)?.[0].includes('checked=""'));
  assert.match(html, /<button[^>]*disabled=""[^>]*>应用30秒模型<\/button>/);
});
check("设备参考只读、真实终止状态不显示跟随已验证", () => {
  const html = render({ ...ready, singlePoint: { ...session, state: "complete" } });
  assert.ok(html.includes("短弧执行已结束，命中与振幅仍待核验"));
  assert.equal(singlePointIsRunning({ ...session, state: "error" }), false);
  assert.equal(singlePointIsRunning({ ...session, state: "following" }), true);
  assert.ok(!html.includes('aria-label="轴1参考角"'));
});
check("未确认停止、无运动取消及覆盖检查不混淆成命中成功", () => {
  assert.equal(singlePointStateLabel({ ...session, state: "cancelled", stopConfirmed: null }), "准备已取消（未启动跟随）");
  assert.equal(singlePointStateLabel({ ...session, state: "cancelled", stopConfirmed: false }), "停止未确认");
  assert.equal(singlePointStateLabel({ ...session, state: "cancelled", stopConfirmed: true }), "转盘已停止");
  assert.equal(singlePointStateLabel({ ...session, state: "cancelled", stopConfirmed: undefined }), "停止状态待核对");
  const html = render({ ...ready, singlePoint: { ...session, state: "error", stopConfirmed: false, pendingStopAxes: [2], endpointReached: true, captureWindowVerified: false, captureWindow: { startSample: 0, endSampleExclusive: 100, receivedThroughSample: 100, covered: true, timeBasis: "host" } } });
  for (const label of ["停止未确认", "反馈已到达", "覆盖预约时间窗", "材料点命中 / 振幅", "未验证", "核对转盘状态"]) assert.ok(html.includes(label), label);
});
check("预览未绑定参考位和超差原因完整呈现", () => {
  const html = renderToStaticMarkup(<FieldSinglePointPreviewCard preview={{ ...preview, ready: false, anchorBound: false, blockReasons: ["预测误差超限"], warnings: ["需要实测运动参数"] }} />);
  assert.ok(html.includes("尚未绑定真实两轴参考位"));
  assert.ok(html.includes("预测误差超限"));
  assert.ok(html.includes("需要实测运动参数"));
});
console.log(`PASS ${checks} single-point UI checks; no hardware used`);
