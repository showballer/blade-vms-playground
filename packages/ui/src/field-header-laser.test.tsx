// Pure contracts and static markup only; no device bridge or local profile.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldHeaderLaser, headerLaserReadbackState, headerLaserWriteBlock } from "./field-header-laser";
import type { FieldLaserStatus, FieldStatus } from "./field-types";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const now = 1792500000123, ip = "192.0.2.10";
const readback: FieldLaserStatus = { deviceIp: ip, state: "on", source: "device-readback", readAt: now / 1000, busy: false };
const ready: FieldStatus = { service: { state: "ready", dllConfigured: true, generation: 5 }, state: "idle" };

check("仅当前设备三秒内真实回读可显示开关，未知不冒充关闭", () => {
  assert.equal(headerLaserReadbackState(readback, ip, now), "on");
  assert.equal(headerLaserReadbackState({ ...readback, readAt: (now + .5) / 1000 }, ip, now), "on", "Sub-millisecond server precision matches the client clock precision");
  assert.equal(headerLaserReadbackState({ ...readback, state: "off" }, ` ${ip} `, now), "off");
  assert.equal(headerLaserReadbackState(readback, ip, now + 2999), "on");
  assert.equal(headerLaserReadbackState(readback, ip, now + 3000), "unknown");
  assert.equal(headerLaserReadbackState(readback, "192.0.2.11", now), "unknown");
  assert.equal(headerLaserReadbackState(null, ip, now), "unknown");
  assert.equal(headerLaserReadbackState({ ...readback, source: "unavailable", state: "off" }, ip, now), "unknown");
  assert.equal(headerLaserReadbackState({ ...readback, error: "读取失败" }, ip, now), "unknown");
});
check("缺失、未来、非有限或错误单位时间不能作为当前设备状态", () => {
  for (const readAt of [null, 0, NaN, Infinity, now, now / 1000 + .001]) {
    assert.equal(headerLaserReadbackState({ ...readback, readAt }, ip, now), "unknown", String(readAt));
  }
  assert.equal(headerLaserReadbackState({ ...readback, state: "unknown" }, ip, now), "unknown");
  assert.equal(headerLaserReadbackState({ ...readback, busy: undefined } as unknown as FieldLaserStatus, ip, now), "unknown");
  assert.equal(headerLaserReadbackState({ ...readback, deviceIp: "bad" }, "bad", now), "unknown");
});
check("采集中及设备忙禁止写入，服务与外层状态失败也不放行", () => {
  assert.equal(headerLaserWriteBlock(ready, false), "");
  for (const state of ["starting", "acquiring", "stopping"] as const) {
    assert.equal(headerLaserWriteBlock({ ...ready, state }, false), "由采集流程控制，停止并保存后可手动开关");
  }
  assert.equal(headerLaserWriteBlock({ ...ready, receiver: { running: true } }, false), "由采集流程控制，停止并保存后可手动开关");
  for (const value of [{ ...ready, deviceBusy: true }, { ...ready, turntableBusy: true }]) assert.match(headerLaserWriteBlock(value, false), /设备正在操作/);
  assert.ok(headerLaserWriteBlock(ready, true));
  assert.match(headerLaserWriteBlock(ready, false, true), /状态未确认/);
  assert.ok(headerLaserWriteBlock(null, false));
  assert.ok(headerLaserWriteBlock({ ...ready, service: { ...ready.service, state: "stopped" } }, false));
});
check("静态首屏保持未知并只提供检查入口，不把配置快照或上一代状态视作新回读", () => {
  let calls = 0;
  const html = renderToStaticMarkup(<FieldHeaderLaser deviceIp={ip} status={{ ...ready, laserStatus: readback }} disabled={false} request={async <T,>() => { calls++; throw new Error("No real device"); }} />);
  assert.ok(html.includes('aria-label="激光状态与控制" data-state="unknown"'));
  assert.ok(html.includes('aria-label="激光状态：未知"'));
  assert.ok(html.includes('aria-label="检查激光"'));
  assert.ok(!html.includes('aria-label="开启激光"'));
  assert.ok(!html.includes('aria-label="关闭激光"'));
  assert.ok(!html.includes("确认开启激光"));
  assert.equal(calls, 0);
});
check("采集中检查入口清楚说明激光控制权，未知不会绘成关闭", () => {
  const html = renderToStaticMarkup(<FieldHeaderLaser deviceIp={ip} status={{ ...ready, state: "acquiring" }} disabled={false} request={async <T,>() => { throw new Error("No real device"); }} />);
  assert.ok(html.includes("由采集流程控制，停止并保存后可手动开关"));
  assert.ok(html.includes('data-state="unknown"'));
  assert.ok(html.includes("激光 <strong>未知</strong>"));
  assert.ok(!html.includes("已关闭"));
});
console.log(`PASS ${checks} header-laser static/pure checks; hardware not used`);
