// Offline record fixtures only. No bridge, acquisition process or hardware.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FieldPlannedStation, FieldRecording, FieldSyncItem } from "./field-types";
import { summarizeBladeRecords } from "./field-blade-summary-data";
import { FieldBladeSummary } from "./field-blade-summary";

let checks = 0;
const check = (name: string, run: () => void) => { run(); checks++; console.log(`PASS ${name}`); };
const session = "a".repeat(32);
const plan: FieldPlannedStation[] = [1, 2, 3, 4].map((index) => ({ pointId: `p${index}`, bladeId: "2", radialPointId: "P1", radialPointName: "叶中 P1", radiusM: .31, azimuthDeg: (index - 1) * 90, stationIndex: index, stationCount: 4 }));
function recording(index = 1, values: Partial<FieldRecording> = {}, metadata: Partial<NonNullable<FieldRecording["pointCycle"]>> = {}): FieldRecording {
  return { id: `record-${index}`, name: `采集站点 ${index}`, source: "polytec_ivs500", samples: 100, sampleRate: 1000, startedAt: 1000 + index, endedAt: 1001 + index, status: "complete", unit: "m/s", ...values,
    pointCycle: { mode: "automatic_stations", sessionId: session, bladeId: "2", radialPointId: "P1", radialPointName: "叶中 P1", radiusM: .31,
      azimuthDeg: (index - 1) * 90, stationIndex: index, stationCount: 4, lapIndex: 1, cycle: 1, cycles: 1,
      pointIndex: index, pointId: `p${index}`, pointName: `站点 ${index}`, dwellSeconds: 30, targetAxis1AngleDeg: 1, targetAxis2AngleDeg: 1,
      identitySource: "operator_assigned", identityVerified: false, coverageKind: "sparse_station_passes", completion: "confirmed_pass", plannedStations: plan, ...metadata } };
}

check("同批次叶片径向测点轮次独立，所有计划站点含未创建记录都保留", () => {
  const other = plan.map(point => ({ ...point, pointId: `root-${point.pointId}`, radialPointId: "root", radialPointName: "叶根", radiusM: .1 }));
  const records = [recording(1, {}, { plannedStations: [...plan, ...other], cycles: 2 }),
    recording(2, { id: "other-session" }, { sessionId: "b".repeat(32) })];
  const result = summarizeBladeRecords(records);
  assert.equal(result.groups.length, 5);
  const group = result.groups.find(item => item.sessionId === session && item.radialPointId === "P1" && item.lapIndex === 1)!;
  assert.equal(group.plannedCount, 4); assert.equal(group.observedCount, 1); assert.equal(group.pendingCount, 3);
  assert.equal(result.groups.filter(item => item.sessionId === session).reduce((total, item) => total + item.pendingCount, 0), 15);
  assert.equal(result.groups.find(item => item.radialPointId === "root")?.radiusM, .1);
});

check("存盘完成与RSSI通过分开，回波缺口、失败、取消和未完成不能计为观测", () => {
  for (const completion of ["missing_entry", "missing_exit", "signal_gap", "cancelled", "device_error"] as const) {
    const group = summarizeBladeRecords([recording(1, {}, { completion })]).groups[0];
    assert.equal(group.observedCount, 0, completion);
    assert.equal(group.stations[0].state, completion === "device_error" ? "failed" : completion);
  }
  for (const value of [recording(1, { status: "incomplete" }), recording(1, { status: "error" }), recording(1, { error: "写入中断" }), recording(1, { samples: 0 }), recording(1, {}, { completion: undefined })]) {
    assert.equal(summarizeBladeRecords([value]).groups[0].observedCount, 0);
  }
  const mixed = summarizeBladeRecords([recording(1), recording(2, {}, { completion: "signal_gap" }), recording(3, { status: "error" }), recording(4, { status: "incomplete" })]).groups[0];
  assert.deepEqual([mixed.observedCount, mixed.gapCount, mixed.failedCount, mixed.incompleteCount, mixed.pendingCount], [1, 1, 1, 1, 0]);
  const timeout = summarizeBladeRecords([recording(1, { status: "error", error: "等待回波离开超时" }, { completion: "missing_exit" })]).groups[0];
  assert.equal(timeout.stations[0].state, "missing_exit"); assert.equal(timeout.gapCount, 1); assert.equal(timeout.failedCount, 0);
  assert.equal(summarizeBladeRecords([recording(1, { status: "error", error: "用户取消" }, { completion: "cancelled" })]).groups[0].stations[0].state, "cancelled");
});

check("重复快照不重复计数，重试保留记录且结果按最新记录", () => {
  const original = recording(1, { endedAt: 1001 }, { completion: "missing_exit" });
  const retried = recording(1, { id: "retry-record", startedAt: 2000, endedAt: 2001, samples: 50 });
  const group = summarizeBladeRecords([original, original, retried]).groups[0];
  assert.equal(group.recordCount, 2); assert.equal(group.observedCount, 1); assert.equal(group.samples, 150);
  assert.equal(group.stations[0].records[0].id, "retry-record");
  const sameId = summarizeBladeRecords([recording(1, { status: "incomplete", endedAt: undefined }), recording(1)]).groups[0];
  assert.equal(sameId.recordCount, 1); assert.equal(sameId.observedCount, 1);
  const imported = recording(1, { endedAt: "2026-01-01T00:00:00Z" }, { completion: "missing_exit" });
  const later = recording(1, { id: "later-retry", endedAt: Date.parse("2026-01-02T00:00:00Z") / 1000 });
  assert.equal(summarizeBladeRecords([imported, later]).groups[0].stations[0].records[0].id, "later-retry");
});

check("同步状态与观测状态独立，未知不能称为已上传", () => {
  const records = [1, 2, 3, 4].map(index => recording(index));
  const items = records.slice(0, 3).map((record, index) => ({ recordingId: record.id, name: record.name, state: ["synced", "queued", "error"][index], progress: index === 0 ? 100 : 0 } as FieldSyncItem));
  const group = summarizeBladeRecords(records, items).groups[0];
  assert.equal(group.observedCount, 4);
  assert.deepEqual([group.uploadedCount, group.pendingUploadCount, group.failedUploadCount, group.unknownUploadCount], [1, 1, 1, 1]);
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={records} syncItems={items} />);
  assert.ok(html.includes("1 已上传 · 1 待上传 · 1 上传异常 · 1 同步状态未知"));
});

check("矛盾计划或站点参数不能显示完整", () => {
  const changed = plan.map(point => point.stationIndex === 2 ? { ...point, azimuthDeg: 95 } : point);
  const records = [recording(1), recording(2, {}, { plannedStations: changed })];
  assert.equal(summarizeBladeRecords(records).groups[0].planConflict, true);
  assert.ok(renderToStaticMarkup(<FieldBladeSummary recordings={records} />).includes("计划信息不一致"));
  assert.equal(summarizeBladeRecords([recording(1, {}, { radiusM: .4 })]).groups[0].planConflict, true);
  for (const broken of [plan.slice(0, 1), plan.map(point => ({ ...point, stationCount: 5 })), plan.map(point => ({ ...point, stationIndex: point.stationIndex + 1 })),
    plan.map(point => ({ ...point, radiusM: 1001 })), plan.map(point => ({ ...point, azimuthDeg: -1 })), plan.map(point => ({ ...point, azimuthDeg: 360 }))]) {
    const item = recording(1, {}, { plannedStations: broken });
    assert.equal(summarizeBladeRecords([item]).groups[0].planConflict, true);
    const html = renderToStaticMarkup(<FieldBladeSummary recordings={[item]} />);
    assert.ok(!html.includes("计划站点已记录"));
  }
});

check("没有计划只展示已收记录，不从站点数量伪造方位或波形", () => {
  const result = summarizeBladeRecords([recording(1, {}, { plannedStations: undefined })]);
  assert.equal(result.groups[0].plannedCount, null); assert.equal(result.groups[0].stations.length, 1);
  assert.equal(result.groups[0].observedCount, 1); assert.equal(result.groups[0].pendingCount, 0);
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={[recording(1, {}, { plannedStations: undefined })]} />);
  assert.ok(html.includes("缺少站点计划")); assert.ok(html.includes("计划未确认"));
});

check("旧记录、缺批次和非法轮次不按相似名称跨任务合并", () => {
  const invalid = [recording(1, {}, { sessionId: undefined }), recording(2, {}, { mode: "legacy" }), recording(3, {}, { lapIndex: 101 }), recording(4, {}, { radialPointId: "" })];
  const result = summarizeBladeRecords(invalid);
  assert.equal(result.groups.length, 0); assert.equal(result.ungroupedCount, 4);
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={invalid} />);
  assert.ok(html.includes("4 条点位记录缺少有效的批次或测点信息"));
});

check("模拟与未知来源不计实测，组件不凭空显示振幅或核实身份", () => {
  for (const value of [recording(1, { source: "simulation", simulation: { point: "P1", scenario: "baseline" } }), recording(1, { source: undefined })]) {
    assert.equal(summarizeBladeRecords([value]).groups[0].observedCount, 0);
  }
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={[recording(1)]} />);
  assert.ok(html.includes("叶片编号由人工指定")); assert.ok(html.includes("不代表连续整圈测量"));
  assert.ok(!html.includes("RMS")); assert.ok(!html.includes("峰峰值"));
  assert.ok(html.includes("aria-label=\"叶片 2 叶中 P1 第 1 轮站点\""));
});

check("记录内容按文本转义，不在汇总中执行或触发采集", () => {
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={[recording(1, { name: "<script>unsafe</script>" })]} onOpenRecording={() => { throw new Error("SSR must not trigger an action"); }} />);
  assert.ok(html.includes("&lt;script&gt;unsafe&lt;/script&gt;")); assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("查看记录"));
});
console.log(`PASS ${checks} blade record summary checks; no hardware used`);
