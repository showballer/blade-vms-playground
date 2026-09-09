// Static rendering and pure presentation-contract checks. Not a device or browser test.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldLoginPanel, FieldRecordingList, FieldServicePanel, FieldWaveChart } from "./field-desktop";
import { fieldCanStart, fieldDate, fieldIsActive, fieldSampleX, validateFieldConfig, type FieldStatus, type FieldWaveform } from "./field-types";

let checks = 0;
function check(name: string, run: () => void) { run(); checks += 1; console.log("PASS " + name); }
const waveform: FieldWaveform = { sampleRate: 2000, sampleStart: 100, sampleStride: 5, unit: "m/s", values: [0.001, -0.001, 0.002], rssi: [40, null, 60], rssiUnit: "%", overrange: [false, true, false] };
const ready: FieldStatus = { service: { state: "ready", dllConfigured: true }, state: "idle" };
check("抽样步长参与时间轴，不能把抽样预览误当连续样本", () => {
  assert.equal(fieldSampleX(waveform, 0), 50);
  assert.equal(fieldSampleX(waveform, 2), 55);
});
check("未知采样率只能显示样本序号", () => {
  assert.equal(fieldSampleX({ ...waveform, sampleRate: null }, 2), 110);
  const html = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, sampleRate: null }} />);
  assert.ok(html.includes("样本序号"));
  assert.ok(!html.includes("时间 / ms"));
});
check("空波形明确等待真实数据，不绘制模拟曲线", () => {
  const html = renderToStaticMarkup(<FieldWaveChart />);
  assert.ok(html.includes("等待真实振动数据"));
  assert.ok(html.includes("不生成模拟波形"));
  assert.ok(!html.includes('class="field-wave-svg"'));
});
check("真实速度曲线标注单位和时间轴", () => {
  const html = renderToStaticMarkup(<FieldWaveChart waveform={waveform} />);
  assert.ok(html.includes("m/s"));
  assert.ok(html.includes("时间 / ms"));
  assert.ok(html.includes('d="M'));
  assert.ok(!html.includes("NaN"));
});
check("缺失 RSSI 不补零或伪造第二通道", () => {
  const html = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, rssi: [null, null, null] }} kind="rssi" />);
  assert.ok(html.includes("等待真实 RSSI 数据"));
  const actual = renderToStaticMarkup(<FieldWaveChart waveform={waveform} kind="rssi" />);
  assert.ok(!actual.includes("NaN"));
  assert.ok(actual.includes("单位百分比"));
});
check("采集启用必须同时满足服务和 DLL 就绪", () => {
  assert.equal(fieldCanStart(ready), true);
  assert.equal(fieldCanStart(null), false);
  assert.equal(fieldCanStart({ ...ready, service: { state: "missing", dllConfigured: true } }), false);
  assert.equal(fieldCanStart({ ...ready, service: { state: "ready", dllConfigured: false } }), false);
  assert.equal(fieldCanStart({ ...ready, state: "error", receiver: { running: true } }), false);
  assert.equal(fieldIsActive({ ...ready, state: "error", receiver: { running: true } }), true);
  for (const state of ["starting", "acquiring", "stopping"] as const) {
    assert.equal(fieldCanStart({ ...ready, state }), false);
    assert.equal(fieldIsActive({ ...ready, state }), true);
  }
});
check("Python Unix 秒和 ISO 日期都能显示正确年份", () => {
  assert.equal(fieldDate(1788915600)?.toISOString(), "2026-09-09T01:00:00.000Z");
  assert.equal(fieldDate("2026-09-09T01:00:00Z")?.getTime(), fieldDate(1788915600)?.getTime());
  assert.equal(fieldDate("invalid"), null);
  assert.equal(fieldDate(undefined), null);
});
check("IP 和任务验证不会使用自动预设设备地址", () => {
  const config = { name: "真实任务", object: "", turbine: "", point: "", deviceIp: "192.168.1.2", hostIp: "192.168.1.3" };
  assert.equal(validateFieldConfig(config), null);
  assert.ok(validateFieldConfig({ ...config, name: " " }));
  assert.ok(validateFieldConfig({ ...config, hostIp: "192.168.1.2" }));
  assert.ok(validateFieldConfig({ ...config, deviceIp: "999.168.1.2" }));
  assert.ok(validateFieldConfig({ ...config, hostIp: "" }));
});
check("缺失服务展示配置入口，不回退演示", () => {
  const html = renderToStaticMarkup(<FieldServicePanel status={{ ...ready, service: { state: "missing", dllConfigured: false } }} busy={false} onAction={() => {}} />);
  assert.ok(html.includes("采集服务未安装"));
  assert.ok(html.includes("选择采集服务 EXE"));
  assert.ok(html.includes("不能开始真实采集"));
});
check("登录仅预填 admin 用户名，不显示密码或离线演示入口", () => {
  const html = renderToStaticMarkup(<FieldLoginPanel busy={false} error="" available={true} onLogin={async () => {}} />);
  assert.ok(html.includes('value="admin"'));
  assert.match(html, /type="password"[^>]*value=""/);
  assert.ok(!html.includes("离线演示"));
  assert.ok(html.includes("首次登录必须修改密码"));
});
check("浏览器预览没有本机桥接时禁止登录", () => {
  const html = renderToStaticMarkup(<FieldLoginPanel busy={false} error="" available={false} onLogin={async () => {}} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*>/);
  assert.ok(html.includes("不提供本机登录与设备采集"));
});
check("记录空态不预置数据", () => {
  const html = renderToStaticMarkup(<FieldRecordingList recordings={[]} busy={false} onSelect={() => {}} />);
  assert.ok(html.includes("还没有真实采集记录"));
  assert.ok(!html.includes("<table"));
});
check("记录契约使用 samples / endedAt / status，异常不能显示完成", () => {
  const html = renderToStaticMarkup(<FieldRecordingList recordings={[{ id: "test", name: "实测记录", samples: 1200, sampleRate: 2000, startedAt: "2026-09-09T01:00:00Z", endedAt: "2026-09-09T01:00:01Z", status: "error", error: "device disconnected" }]} busy={false} onSelect={() => {}} />);
  assert.ok(html.includes("1,200"));
  assert.ok(html.includes("异常记录"));
  assert.ok(!html.includes("已完成"));
});
console.log(`Field desktop presentation checks: ${checks} passed (static/pure only).`);
