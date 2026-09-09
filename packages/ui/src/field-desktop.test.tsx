// Static rendering and pure presentation-contract checks. Not a device or browser test.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldLoginPanel, FieldPasswordPanel, FieldRecordingList, FieldServicePanel, FieldStartDialog, FieldWaveChart } from "./field-desktop";
import { fieldCanStart, fieldDate, fieldIsActive, fieldSampleX, validateFieldConfig, type FieldStatus, type FieldWaveform } from "./field-types";
import { clampWaveRange, formatWaveTime, waveBounds } from "./field-waveform";
import { FieldDeviceSnapshot } from "./field-device";

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
check("采集确认正文与操作区分离，三个安全条件仍须逐项确认", () => {
  const html = renderToStaticMarkup(<FieldStartDialog config={{ name: "窗口适配测试", deviceIp: "192.168.1.2", hostIp: "192.168.1.3", object: "", turbine: "", point: "" }} busy={false} error="" onClose={() => {}} onStart={() => {}} />);
  assert.ok(html.includes('class="field-confirm-body"'));
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
  assert.ok(!html.includes('checked=""'));
  assert.ok(html.includes('</label></div><div class="field-form-actions">'), "操作区必须位于可滚动的确认正文外");
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^]*?确认并开始采集<\/button>/);
  assert.ok(html.includes('aria-label="关闭弹窗"'));
});
check("窄屏记录表保留所有列并提供键盘可聚焦的横向滚动区域", () => {
  const html = renderToStaticMarkup(<FieldRecordingList recordings={[{ id: "long", name: "户外叶片采集任务".repeat(10), startedAt: "2026-09-09T01:00:00Z", samples: 500000, sampleRate: 218750, status: "incomplete" }]} busy={false} onSelect={() => {}} />);
  assert.ok(html.includes('role="region"'));
  assert.ok(html.includes('tabindex="0"'));
  assert.ok(html.includes("可横向滚动查看所有列"));
  for (const column of ["任务 / 对象", "开始时间", "原始点数", "采样率", "保存状态", "操作"]) assert.ok(html.includes(column));
  assert.ok(html.includes("查看预览"));
});
check("低高度密码页保留三项输入、保存及退出登录入口", () => {
  const html = renderToStaticMarkup(<FieldPasswordPanel mandatory busy={false} error="" onSave={async () => {}} onCancel={() => {}} />);
  assert.equal((html.match(/type="password"/g) || []).length, 3);
  assert.equal((html.match(/minLength="12"/g) || []).length, 2);
  assert.ok(html.includes("保存新密码"));
  assert.ok(html.includes("退出登录"));
});
check("全程浏览平移和缩放限制在已采集区间", () => {
  assert.deepEqual(clampWaveRange(-100, 100, 1000), [0, 200]);
  assert.deepEqual(clampWaveRange(900, 1200, 1000), [700, 1000]);
  assert.deepEqual(clampWaveRange(5, 5, 1000), [5, 6]);
  assert.deepEqual(waveBounds({ ...waveform, rangeStart: 0, rangeEnd: 900 }), [0, 900]);
});
check("实际时间使用 sampleOrigin 而非任务创建时间，未知起点不伪造", () => {
  const wave = { ...waveform, sampleOrigin: 1700000000 };
  assert.ok(formatWaveTime(1000, wave, "clock").endsWith(".500"));
  assert.equal(formatWaveTime(1000, { ...wave, sampleOrigin: null }, "clock"), "500");
});
check("固定纵轴不按微小噪声自动跳动，超显示范围明确提示", () => {
  const small = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, values: [0, 0.000016785, 0] }} yLimit={0.5} unit="mm/s" />);
  assert.ok(small.includes("500"));
  const large = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, values: [1, 0, -1] }} yLimit={0.5} />);
  assert.ok(large.includes("这不等于设备超量程"));
});
check("包络按实际区间定位，不伪造连续原始采样点", () => {
  const html = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, values: [], rssi: [], rangeStart: 0, rangeEnd: 10000, representation: "envelope", envelope: [{ start: 0, end: 10000, min: -1, max: 9, rssiMin: 79, rssiMax: 83, missing: 1, overrange: 0 }] }} />);
  assert.ok(html.includes('class="field-wave-svg'));
  assert.ok(html.includes('d="M'));
  assert.ok(!html.includes("NaN"));
});
check("设备操作进行中禁止启动，旧记录无配置不填默认值", () => {
  assert.equal(fieldCanStart({ ...ready, deviceBusy: true }), false);
  const html = renderToStaticMarkup(<FieldDeviceSnapshot />);
  assert.ok(html.includes("不能用当前设备设置代替"));
  assert.ok(!html.includes("10 kHz"));
});
console.log(`Field desktop presentation checks: ${checks} passed (static/pure only).`);
