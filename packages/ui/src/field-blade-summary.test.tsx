// Offline record fixtures only. No bridge, acquisition process or hardware.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FieldPlannedStation, FieldRecording, FieldSyncItem } from "./field-types";
import { bladeRecordingTiming, getAutoCaptureTargetState, summarizeBladeRecords } from "./field-blade-summary-data";
import { bladeDurationText, FieldBladeSummary } from "./field-blade-summary";

let checks = 0;
const check = (name: string, run: () => void) => { run(); checks++; console.log(`PASS ${name}`); };
const session = "a".repeat(32);
const plan: FieldPlannedStation[] = [1, 2, 3, 4].map((index) => ({ pointId: `p${index}`, bladeId: "2", radialPointId: "P1", radialPointName: "叶中 P1", radiusM: .31, azimuthDeg: (index - 1) * 90, stationIndex: index, stationCount: 4 }));
function recording(index = 1, values: Partial<FieldRecording> = {}, metadata: Partial<NonNullable<FieldRecording["pointCycle"]>> = {}): FieldRecording {
  return { id: `record-${index}`, name: `采集点位 ${index}`, source: "polytec_ivs500", samples: 100, sampleRate: 1000, startedAt: 1000 + index, endedAt: 1001 + index, status: "complete", unit: "m/s", ...values,
    pointCycle: { mode: "automatic_stations", sessionId: session, bladeId: "2", radialPointId: "P1", radialPointName: "叶中 P1", radiusM: .31,
      azimuthDeg: (index - 1) * 90, stationIndex: index, stationCount: 4, lapIndex: 1, cycle: 1, cycles: 1,
      pointIndex: index, pointId: `p${index}`, pointName: `点位 ${index}`, dwellSeconds: 30, targetAxis1AngleDeg: 1, targetAxis2AngleDeg: 1,
      identitySource: "operator_assigned", identityVerified: false, coverageKind: "sparse_station_passes", completion: "confirmed_pass", plannedStations: plan, ...metadata } };
}

check("同批次叶片径向测点轮次独立，所有计划点位含未创建记录都保留", () => {
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

check("背景辅助片段照常归档但不计作完整经过", () => {
  const value = recording(1, {}, { completion: "unconfirmed_pass", passCompleteness: "unconfirmed", completenessReason: "missing_initial_background" });
  const group = summarizeBladeRecords([value]).groups[0];
  assert.equal(group.recordCount, 1); assert.equal(group.observedCount, 0); assert.equal(group.incompleteCount, 1);
  assert.equal(group.stations[0].state, "unconfirmed_pass");
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={[value]} />);
  assert.ok(html.includes("完整性待确认"));
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

check("矛盾计划或点位参数不能显示完整", () => {
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
    assert.ok(!html.includes("计划点位已记录"));
  }
});

check("没有计划只展示已收记录，不从点位数量伪造方位或波形", () => {
  const result = summarizeBladeRecords([recording(1, {}, { plannedStations: undefined })]);
  assert.equal(result.groups[0].plannedCount, null); assert.equal(result.groups[0].stations.length, 1);
  assert.equal(result.groups[0].observedCount, 1); assert.equal(result.groups[0].pendingCount, 0);
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={[recording(1, {}, { plannedStations: undefined })]} />);
  assert.ok(html.includes("缺少点位计划")); assert.ok(html.includes("计划未确认"));
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
  assert.ok(html.includes("aria-label=\"叶片 2 叶中 P1 第 1 轮点位\""));
});

check("记录内容按文本转义，不在汇总中执行或触发采集", () => {
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={[recording(1, { name: "<script>unsafe</script>" })]} onOpenRecording={() => { throw new Error("SSR must not trigger an action"); }} />);
  assert.ok(html.includes("&lt;script&gt;unsafe&lt;/script&gt;")); assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("查看波形"));
});
const task = "c".repeat(32);
function pointRecord(point: string, run: string, index = 1, collection: string | undefined = task, blade = "2") {
  const pointPlan = plan.map(station => ({ ...station, bladeId: blade, pointId: `${point}-s${station.stationIndex}`,
    radialPointId: point, radialPointName: point, radiusM: point === "P1" ? .31 : .5 }));
  return recording(index, { id: `${run}-${point}-${index}`, name: "叶片检测任务" }, { ...pointPlan[index - 1],
    collectionId: collection, sessionId: run, plannedStations: pointPlan });
}

check("同任务分别启动的P1和P2集中展示，仍保留各自批次计划", () => {
  const records = [pointRecord("P1", "a".repeat(32)), pointRecord("P2", "b".repeat(32))];
  const summary = summarizeBladeRecords(records);
  assert.equal(summary.collections.length, 1);
  const collection = summary.collections[0];
  assert.equal(collection.taskName, "叶片检测任务"); assert.equal(collection.collectionId, task);
  assert.equal(collection.pointCount, 2); assert.equal(collection.sessionCount, 2); assert.equal(collection.groups.length, 2);
  assert.deepEqual(new Set(collection.groups.map(group => group.radialPointId)), new Set(["P1", "P2"]));
  assert.ok(collection.groups.every(group => group.plannedCount === 4 && group.pendingCount === 3));
  assert.ok(collection.groups.every(group => group.stations.every(station => station.id.startsWith(group.radialPointId))));
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={records} />);
  assert.equal((html.match(/class="field-blade-task"/g) || []).length, 1);
  assert.ok(html.includes('aria-label="叶片 2 · P1"')); assert.ok(html.includes("2 个测点 · 2 次采集"));
  assert.ok(html.includes("叶片 2 · P1")); assert.ok(html.includes("叶片 2 · P2"));
  assert.equal((html.match(/class="field-blade-point"/g) || []).length, 2);
});

check("同测点重采另建批次，完整重采不覆盖原批次缺口", () => {
  const original = pointRecord("P1", "a".repeat(32)); original.pointCycle!.completion = "missing_exit";
  const retried = [1, 2, 3, 4].map(index => pointRecord("P1", "b".repeat(32), index));
  const collection = summarizeBladeRecords([original, ...retried]).collections[0];
  assert.equal(collection.pointCount, 1); assert.equal(collection.sessionCount, 2); assert.equal(collection.groups.length, 2);
  const first = collection.groups.find(group => group.sessionId === "a".repeat(32))!;
  assert.equal(first.gapCount, 1); assert.equal(first.pendingCount, 3); assert.equal(first.observedCount, 0);
  const second = collection.groups.find(group => group.sessionId === "b".repeat(32))!;
  assert.equal(second.observedCount, 4); assert.equal(second.pendingCount, 0);
  assert.equal(collection.groups.reduce((sum, group) => sum + group.recordCount, 0), 5);
});

check("历史记录按各自批次展示，不按同名任务或UUID文本混合", () => {
  const oldA = pointRecord("P1", task); delete oldA.pointCycle!.collectionId;
  const oldB = pointRecord("P2", "b".repeat(32)); delete oldB.pointCycle!.collectionId;
  const current = pointRecord("P1", "d".repeat(32));
  const summary = summarizeBladeRecords([oldA, oldB, current]);
  assert.equal(summary.collections.length, 3); assert.equal(new Set(summary.collections.map(collection => collection.key)).size, 3);
  assert.equal(summary.collections.filter(collection => collection.collectionId === null).length, 2);
  assert.ok(summary.groups.every(group => !group.planConflict));
});

check("不合法或相互矛盾的任务编号隔离，不与其他采集批次合并", () => {
  for (const invalid of ["same-name", "A".repeat(32), "a".repeat(31), "a".repeat(33), "a".repeat(32) + "\n", "g".repeat(32), "", null, 123]) {
    const records = [pointRecord("P1", "a".repeat(32)), pointRecord("P2", "b".repeat(32))];
    for (const record of records) (record.pointCycle as any).collectionId = invalid;
    const summary = summarizeBladeRecords(records);
    assert.equal(summary.collections.length, 2, String(invalid));
    assert.ok(summary.groups.every(group => group.collectionId === null && group.planConflict));
  }
  const first = pointRecord("P1", "a".repeat(32));
  const contradictory = pointRecord("P1", "a".repeat(32), 2, "d".repeat(32));
  const other = pointRecord("P2", "b".repeat(32));
  const summary = summarizeBladeRecords([first, contradictory, other]);
  assert.equal(summary.collections.length, 2);
  assert.ok(summary.groups.find(group => group.sessionId === "a".repeat(32))!.planConflict);
});

check("同名的不同任务以及不同叶片始终分开", () => {
  const records = [pointRecord("P1", "a".repeat(32)), pointRecord("P2", "b".repeat(32), 1, "d".repeat(32)),
    pointRecord("P1", "e".repeat(32), 1, task, "3")];
  const summary = summarizeBladeRecords(records);
  assert.equal(new Set(summary.collections.map(collection => collection.taskName)).size, 1);
  assert.equal(summary.collections.length, 3); assert.equal(new Set(summary.collections.map(collection => collection.key)).size, 3);
  assert.equal(summary.collections.filter(collection => collection.collectionId === task).length, 2);
  assert.equal(summary.tasks.length, 2);
  assert.equal(summary.tasks.find(item => item.collectionId === task)?.blades.length, 2);
});

check("风机任务为外层，多个叶片的同名点位独立归档", () => {
  const records = [pointRecord("P1", "a".repeat(32), 1, task, "2"), pointRecord("P2", "b".repeat(32), 1, task, "2"),
    pointRecord("P1", "d".repeat(32), 1, task, "1")].map(item => ({ ...item, name: "风机一检修", turbine: "FJ-001", object: "风机" }));
  const summary = summarizeBladeRecords(records);
  assert.equal(summary.taskCount, 1); assert.equal(summary.tasks[0].turbine, "FJ-001");
  assert.equal(summary.tasks[0].pointCount, 3); assert.equal(summary.tasks[0].sessionCount, 3);
  assert.deepEqual(summary.tasks[0].blades.map(item => item.bladeId), ["1", "2"]);
  assert.deepEqual(summary.tasks[0].blades.map(item => item.pointCount), [1, 2]);
  assert.ok(summary.tasks[0].blades.every(blade => blade.groups.every(group => group.bladeId === blade.bladeId)));
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={records} />);
  assert.equal((html.match(/class="field-blade-task"/g) || []).length, 1);
  assert.equal((html.match(/class="field-blade-collection"/g) || []).length, 1, "Only the selected blade panel is rendered");
  assert.ok(html.includes("1 个任务 · 2 个叶片")); assert.ok(html.includes("FJ-001 · 2 个叶片 · 3 个测点 · 3 次采集"));
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
});

check("复用任务或批次编号也不能跨风机和对象合并", () => {
  const first = { ...pointRecord("P1", "a".repeat(32)), turbine: "FJ-001", object: "风机" };
  const second = { ...pointRecord("P2", "b".repeat(32)), turbine: "FJ-002", object: "风机" };
  const differentObject = { ...pointRecord("P2", "d".repeat(32)), turbine: "FJ-001", object: "另一测量对象" };
  const summary = summarizeBladeRecords([first, second, differentObject]);
  assert.equal(summary.taskCount, 3); assert.equal(summary.collections.length, 3);
  assert.equal(new Set(summary.tasks.map(item => item.key)).size, 3);
  const duplicateSession = { ...pointRecord("P1", "a".repeat(32), 2), turbine: "FJ-002", object: "风机" };
  const corrupted = summarizeBladeRecords([first, duplicateSession]);
  assert.equal(corrupted.groups.length, 2); assert.equal(corrupted.taskCount, 2);
  assert.equal(new Set(corrupted.groups.map(group => group.key)).size, 2);
  assert.ok(corrupted.groups.every(group => group.planConflict && group.recordCount === 1 && group.observedCount === 1));
  assert.deepEqual(new Set(corrupted.groups.map(group => group.turbine)), new Set(["FJ-001", "FJ-002"]));
});

check("未记录风机身份的旧数据不并入已明确风机的任务", () => {
  const known = { ...pointRecord("P1", "a".repeat(32)), turbine: "FJ-001", object: "风机" };
  const unknown = pointRecord("P2", "b".repeat(32));
  const summary = summarizeBladeRecords([known, unknown]);
  assert.equal(summary.taskCount, 2); assert.equal(summary.tasks.find(item => item.turbine === "")?.pointCount, 1);
  const equivalentWhitespace = { ...pointRecord("P2", "d".repeat(32)), turbine: " FJ-001 ", object: " 风机 " };
  assert.equal(summarizeBladeRecords([known, equivalentWhitespace]).taskCount, 1);
});

check("点位状态仅取最新独立批次，回波缺口和重采失败不能显示已完成", () => {
  const target = { collectionId: task, bladeId: "2", radialPointId: "P1", cycles: 1, stationCount: 4 };
  assert.equal(getAutoCaptureTargetState([], target), "empty");
  const complete = [1, 2, 3, 4].map(index => pointRecord("P1", "a".repeat(32), index));
  assert.equal(getAutoCaptureTargetState(complete, target), "complete");
  assert.equal(getAutoCaptureTargetState(complete, { ...target, radialPointId: "P2" }), "empty");
  assert.equal(getAutoCaptureTargetState(complete, { ...target, cycles: 2 }), "partial");
  assert.equal(getAutoCaptureTargetState(complete, { ...target, stationCount: 5 }), "partial");
  const tiedRetry = pointRecord("P1", "b".repeat(32), 4); tiedRetry.pointCycle!.completion = "missing_exit";
  assert.equal(getAutoCaptureTargetState([...complete, tiedRetry], target), "partial");
  for (const completion of ["missing_entry", "missing_exit", "signal_gap", "cancelled", "device_error"] as const) {
    const retry = pointRecord("P1", "b".repeat(32)); retry.endedAt = 2000; retry.pointCycle!.completion = completion;
    assert.equal(getAutoCaptureTargetState([...complete, retry], target), "partial", completion);
  }
  const newerComplete = [1, 2, 3, 4].map(index => ({ ...pointRecord("P1", "c".repeat(32), index), endedAt: 3000 + index }));
  const incomplete = pointRecord("P1", "b".repeat(32)); incomplete.endedAt = 2000;
  assert.equal(getAutoCaptureTargetState([...complete, incomplete, ...newerComplete], target), "complete");
});

check("手改半径不能复用同ID旧位置的完成状态，浮点噪声与旧调用保持兼容", () => {
  const target = { collectionId: task, bladeId: "2", radialPointId: "P1", cycles: 1, stationCount: 4 };
  const complete = [1, 2, 3, 4].map(index => pointRecord("P1", "a".repeat(32), index));
  const originals = JSON.stringify(complete);
  const radiusM = complete[0].pointCycle!.radiusM!;
  assert.equal(getAutoCaptureTargetState(complete, target), "complete", "Old callers can omit radius");
  assert.equal(getAutoCaptureTargetState(complete, { ...target, radiusM }), "complete");
  assert.equal(getAutoCaptureTargetState(complete, { ...target, radiusM: radiusM + 5e-10 }), "complete");
  assert.equal(getAutoCaptureTargetState(complete, { ...target, radiusM: radiusM + 1e-6 }), "partial");
  for (const radiusM of [NaN, Infinity, 0, -.3, 1001]) {
    assert.equal(getAutoCaptureTargetState(complete, { ...target, radiusM }), "empty");
  }
  // An older matching run cannot hide the latest run at a different radius.
  const movedPlan = plan.map(point => ({ ...point, radiusM: .4 }));
  const moved = [1, 2, 3, 4].map(index => recording(index, { id: "moved-" + index, endedAt: 3000 + index },
    { collectionId: task, sessionId: "b".repeat(32), radiusM: .4, plannedStations: movedPlan }));
  assert.equal(getAutoCaptureTargetState([...complete, ...moved], { ...target, radiusM: .4 }), "complete");
  assert.equal(getAutoCaptureTargetState([...complete, ...moved], { ...target, radiusM }), "partial");
  const missingRadius = complete.map(item => ({ ...item, pointCycle: { ...item.pointCycle!, radiusM: undefined, plannedStations: undefined } }));
  assert.notEqual(getAutoCaptureTargetState(missingRadius, { ...target, radiusM }), "complete");
  assert.equal(JSON.stringify(complete), originals, "Historical manifests remain unchanged");
});

check("点位完成状态逐圈检查并隔离风机、叶片、测点与任务", () => {
  const target = { collectionId: task, bladeId: "2", radialPointId: "P1", cycles: 2, stationCount: 4, turbine: "FJ-001", measurementObject: "风机" };
  const records = [1, 2].flatMap(lap => [1, 2, 3, 4].map(index => {
    const item = pointRecord("P1", "a".repeat(32), index);
    return { ...item, id: `${item.id}-lap${lap}`, turbine: "FJ-001", object: "风机", pointCycle: { ...item.pointCycle!, lapIndex: lap, cycles: 2 } };
  }));
  assert.equal(getAutoCaptureTargetState(records, target), "complete");
  assert.equal(getAutoCaptureTargetState(records, target, summarizeBladeRecords(records)), "complete");
  assert.equal(getAutoCaptureTargetState(records.slice(0, 4), target), "partial");
  for (const changed of [{ turbine: "FJ-002" }, { measurementObject: "塔架" }, { bladeId: "3" }, { radialPointId: "P2" }, { collectionId: "d".repeat(32) }, { collectionId: null }]) {
    assert.equal(getAutoCaptureTargetState(records, { ...target, ...changed }), "empty");
  }
  const other = records.map(item => ({ ...item, id: `${item.id}-other`, turbine: "FJ-002", pointCycle: { ...item.pointCycle!, sessionId: "d".repeat(32) } }));
  assert.equal(getAutoCaptureTargetState([...records, ...other], target), "complete");
  assert.equal(getAutoCaptureTargetState([...records, ...other], { ...target, turbine: undefined }), "partial");
});

check("采集时长累加去重后的原始样本，换点间隔不计入且缺失信息不伪造", () => {
  const first = recording(1, { startedAt: 100, endedAt: 110, samples: 2000, sampleRate: 1000 });
  const second = recording(2, { startedAt: 200, endedAt: 220, samples: 4500, sampleRate: 1500 });
  const timing = bladeRecordingTiming([first, first, second]);
  assert.deepEqual(timing, { startedAt: 100000, endedAt: 220000, openEnded: false, durationSeconds: 5, partialDuration: false });
  const incomplete = recording(3, { startedAt: "2026-10-20T01:00:00Z", endedAt: undefined, sampleRate: null });
  const partial = bladeRecordingTiming([first, incomplete]);
  assert.equal(partial.openEnded, true); assert.equal(partial.durationSeconds, 2); assert.equal(partial.partialDuration, true);
  assert.equal(bladeRecordingTiming([incomplete]).durationSeconds, null);
  assert.equal(bladeRecordingTiming([recording(1, { startedAt: "bad", endedAt: "bad", sampleRate: 0 })]).startedAt, null);
  assert.equal(bladeDurationText(3661.25), "1 小时 1 分 1.25 秒");
  assert.equal(bladeDurationText(null), "未知");
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={[first, second]} />);
  for (const label of ["累计采集时长", "5 秒", "<th>最近采集时间</th>", "<th>采集时长</th>", "结束"]) assert.ok(html.includes(label), label);
});

check("同名风机按风场隔离归档和完成状态，旧记录没有风场仍可查看", () => {
  const collectionId = "c".repeat(32);
  const records = [1,2,3,4].map(index => recording(index, { windFarm: "WF-001", turbine: "WT01" }, { collectionId }));
  const other = recording(1, { id: "other-farm", windFarm: "WF-002", turbine: "WT01" }, { collectionId, sessionId: "b".repeat(32) });
  const summary = summarizeBladeRecords([...records, other]);
  assert.equal(summary.tasks.length, 2);
  assert.deepEqual(new Set(summary.tasks.map(task => task.windFarm)), new Set(["WF-001", "WF-002"]));
  const target = { collectionId, bladeId: "2", radialPointId: "P1", cycles: 1, stationCount: 4, turbine: "WT01" };
  assert.equal(getAutoCaptureTargetState([...records, other], { ...target, windFarm: "WF-001" }), "complete");
  assert.equal(getAutoCaptureTargetState([...records, other], { ...target, windFarm: "WF-002" }), "partial");
  assert.equal(summarizeBladeRecords([recording()]).tasks[0].windFarm, "");
  assert.ok(renderToStaticMarkup(<FieldBladeSummary recordings={records} />).includes("风场 WF-001"));
});


const segmentTask = "d".repeat(32);
const segmentPlan = plan.map((station, index) => ({ ...station, axis1AngleDeg: index + 1, axis2AngleDeg: index - 1 }));
function segmentRecord(index: number, values: Partial<FieldRecording> = {}, metadata: Partial<NonNullable<FieldRecording["pointCycle"]>> = {}): FieldRecording {
  const station = segmentPlan[index - 1];
  return recording(index, { id: `segment-${index}`, ...values }, { collectionId: segmentTask,
    executionMode: "manual_segments", coverageKind: "manual_segment_passes", segmentStepDeg: 90, totalStationCount: 4,
    sessionId: index.toString(16).padStart(32, "0"), segmentStationIds: [station.pointId], plannedStations: segmentPlan,
    recordedPort: "COM3", referenceSignature: "reference-a", targetAxis1AngleDeg: station.axis1AngleDeg,
    targetAxis2AngleDeg: station.axis2AngleDeg, ...metadata });
}
check("分段单点跨四次启动累计整圈，保留原批次身份与采集时长", () => {
  const records = [1, 2, 3, 4].map(index => segmentRecord(index));
  const summary = summarizeBladeRecords(records), group = summary.groups[0];
  assert.equal(summary.groups.length, 1); assert.equal(group.executionMode, "manual_segments");
  assert.equal(group.observedCount, 4); assert.equal(group.pendingCount, 0); assert.equal(group.planConflict, false);
  assert.equal(group.recordCount, 4); assert.equal(group.sessionIds.length, 4);
  assert.equal(summary.tasks[0].sessionCount, 4); assert.equal(summary.collections[0].sessionCount, 4);
  assert.equal(getAutoCaptureTargetState(records, { collectionId: segmentTask, bladeId: "2", radialPointId: "P1", cycles: 1, stationCount: 4 }), "complete");
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={records} />);
  assert.ok(html.includes("分段累计 · 4 次采集")); assert.ok(html.includes("计划点位已记录"));
  assert.ok(!html.includes("观测不完整")); assert.ok(html.includes("不代表同一物理圈的连续波形"));
});
check("分段两点跨零角度也可累计，各点重采只更新最新状态且保留全部记录", () => {
  const records = [4, 1, 2, 3].map(index => segmentRecord(index, {}, { sessionId: (index === 4 || index === 1 ? "a" : "b").repeat(32), segmentStationIds: index === 4 || index === 1 ? ["p4", "p1"] : ["p2", "p3"] }));
  const summary = summarizeBladeRecords(records);
  assert.equal(summary.groups[0].observedCount, 4); assert.equal(summary.groups[0].planConflict, false);
  assert.equal(summary.tasks[0].sessionCount, 2);
  const retry = segmentRecord(2, { id: "segment-retry", startedAt: 2000, endedAt: 2001, status: "error" }, { sessionId: "e".repeat(32), completion: "missing_exit" });
  const failed = summarizeBladeRecords([...records, retry]).groups[0];
  assert.equal(failed.recordCount, 5); assert.equal(failed.observedCount, 3); assert.equal(failed.gapCount, 1);
  assert.equal(failed.stations[1].records.length, 2);
  const fixed = { ...retry, id: "segment-retry-ok", endedAt: 2002, status: "complete" as const, pointCycle: { ...retry.pointCycle!, completion: "confirmed_pass" as const } };
  const recovered = summarizeBladeRecords([...records, retry, fixed]).groups[0];
  assert.equal(recovered.recordCount, 6); assert.equal(recovered.observedCount, 4); assert.equal(recovered.gapCount, 0);
});
check("分段计划、参考位、任务和测点不可跨组补齐，缺关键元数据不能声称整圈完整", () => {
  const records = [1, 2, 3, 4].map(index => segmentRecord(index));
  const changedPlan = segmentPlan.map(station => ({ ...station, axis1AngleDeg: station.axis1AngleDeg + 1 }));
  for (const patch of [
    { plannedStations: changedPlan, targetAxis1AngleDeg: changedPlan[3].axis1AngleDeg },
    { referenceSignature: "reference-b" }, { collectionId: "f".repeat(32) },
    { totalStationCount: 6 }, { plannedStations: plan }, { segmentStationIds: ["not-in-plan"] },
    { targetAxis1AngleDeg: 999 }, { collectionId: undefined },
  ]) {
    const changed = [...records.slice(0, 3), segmentRecord(4, {}, patch)];
    const groups = summarizeBladeRecords(changed).groups;
    assert.ok(groups.every(group => group.planConflict || group.observedCount < 4), JSON.stringify(patch));
  }
  const rename = records.map(record => ({ ...record, pointCycle: { ...record.pointCycle!, plannedStations: record.pointCycle!.plannedStations!.map(station => ({ ...station, radialPointName: `renamed ${record.id}` })) } }));
  assert.equal(summarizeBladeRecords(rename).groups[0].planConflict, false, "Display names do not change physical coordinates");
  for (const patch of [{ referenceSignature: "reference-b" }, { segmentStationIds: ["not-in-plan"] }]) {
    const contradictory = segmentRecord(1, { id: "contradictory-retry", endedAt: 3000 }, patch);
    const groups = summarizeBladeRecords([...records, contradictory]).groups;
    assert.ok(groups.every(group => group.planConflict), "Same raw session cannot hide changed reference or invalid metadata in another group");
  }
  const otherPoint = segmentRecord(1, { id: "other-point" }, { radialPointId: "P2", plannedStations: segmentPlan.map(station => ({ ...station, radialPointId: "P2" })) });
  const mixed = summarizeBladeRecords([...records, otherPoint]);
  assert.equal(mixed.groups.length, 2); assert.equal(mixed.groups.find(group => group.radialPointId === "P2")?.pendingCount, 3);
  const continuous = segmentRecord(1, { id: "continuous" }, { executionMode: "continuous", sessionId: "f".repeat(32) });
  assert.equal(summarizeBladeRecords([...records, continuous]).groups.length, 2);
});

console.log(`PASS ${checks} blade record summary checks; no hardware used`);
