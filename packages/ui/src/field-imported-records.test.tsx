import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { summarizeBladeRecords, getAutoCaptureTargetState } from "./field-blade-summary-data";
import { FieldBladeSummary } from "./field-blade-summary";
import { groupRecordingTasks, recordingExportIds, recordingTaskKey } from "./field-recording-tasks";
import type { FieldRecording, FieldPlannedStation } from "./field-types";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log("PASS " + name); }

// Manifest-only fixtures match split imports: no live-session/lap/station counters.
const records: FieldRecording[] = [];
for (const bladeId of ["1", "2", "3"]) {
  const plannedStations = [1, 2, 3, 4, 5].flatMap(point => [0, 90, 180, 270].map(azimuthDeg => ({
    bladeId, radialPointId: "p" + point, radialPointName: "P" + point, radiusM: 7.05 + (point - 1) * 14.1, azimuthDeg,
  }))) as FieldPlannedStation[];
  for (const station of plannedStations) records.push({
    id: `${bladeId}-${station.radialPointId}-${station.azimuthDeg}`, name: "化德风场B071-20", windFarm: "化德风场", turbine: "020#", object: "风机叶片",
    source: "simulation", diagnosticOnly: true, validMeasurement: false, status: "complete", samples: 25000, sampleRate: 250000,
    startedAt: 1792285200 + records.length * 2, endedAt: 1792285200.1 + records.length * 2,
    pointCycle: { ...station, collectionId: "huade-020-scenario-20261018", plannedStations },
  });
}

check("60条导入清单归到1任务3叶片15测点，任务与汇总三级导出一致", () => {
  const before = JSON.stringify(records), summary = summarizeBladeRecords(records), tasks = groupRecordingTasks(records);
  assert.equal(summary.ungroupedCount, 0); assert.equal(summary.taskCount, 1); assert.equal(tasks.length, 1);
  assert.equal(summary.tasks[0].key, tasks[0].key); assert.equal(summary.groups.length, 15);
  assert.equal(summary.tasks[0].pointCount, 15); assert.equal(summary.tasks[0].blades.length, 3);
  assert.equal(recordingExportIds(records, tasks[0].key).length, 60);
  for (const blade of summary.tasks[0].blades) {
    assert.equal(blade.pointCount, 5); assert.equal(blade.sessionCount, 0);
    assert.equal(recordingExportIds(records, blade.taskKey, blade.bladeId).length, 20);
    for (const group of blade.groups) {
      assert.equal(group.executionMode, "imported"); assert.equal(group.plannedCount, 4);
      assert.equal(group.savedCount, 4); assert.equal(group.observedCount, 0); assert.equal(group.diagnosticCount, 0);
      assert.equal(group.planConflict, false); assert.equal(group.pendingCount, 0); assert.equal(group.hasSimulation, true);
      assert.equal(recordingExportIds(records, blade.taskKey, blade.bladeId, group.radialPointId).length, 4);
    }
  }
  assert.equal(JSON.stringify(records), before, "归类不得修改原记录、来源或质量标记");
  const html = renderToStaticMarkup(<FieldBladeSummary recordings={records} />);
  assert.match(html, /60 条记录/); assert.match(html, /导入归档/);
  assert.doesNotMatch(html, /模拟记录|观测不完整|0 次采集/);
});

check("部分导入按明确计划显示缺口，不把缺片段判成已保存", () => {
  const summary = summarizeBladeRecords(records.slice(0, 3));
  assert.equal(summary.groups.length, 5);
  const p1 = summary.groups.find(group => group.radialPointId === "p1")!;
  assert.equal(p1.savedCount, 3); assert.equal(p1.pendingCount, 1);
  assert.equal(summary.groups.find(group => group.radialPointId === "p5")!.pendingCount, 4);
  assert.match(renderToStaticMarkup(<FieldBladeSummary recordings={records.slice(0, 3)} />), /记录不完整/);
});

check("无计划、无半径的导入仍能归类，不虚构整圈计划", () => {
  const record = structuredClone(records[0]); delete record.pointCycle!.plannedStations; delete record.pointCycle!.radiusM;
  record.source = "split_segment_import";
  const group = summarizeBladeRecords([record]).groups[0];
  assert.equal(group.plannedCount, null); assert.equal(group.radiusM, null); assert.equal(group.stations.length, 1);
  assert.equal(group.savedCount, 1); assert.equal(group.pendingCount, 0);
  assert.match(renderToStaticMarkup(<FieldBladeSummary recordings={[record]} />), /缺少点位计划/);
});

check("同名不同任务或不同实体不合并，缺失角度和非法任务标识不强行归类", () => {
  const otherTask = structuredClone(records[0]); otherTask.id = "other-task"; otherTask.pointCycle!.collectionId = "other-import";
  const otherTurbine = { ...records[0], id: "other-turbine", turbine: "021#" };
  assert.equal(summarizeBladeRecords([records[0], otherTask, otherTurbine]).taskCount, 3);
  assert.equal(groupRecordingTasks([records[0], otherTask, otherTurbine]).length, 3);
  for (const change of [{ azimuthDeg: undefined }, { azimuthDeg: 360 }, { collectionId: "bad\nidentity" }, { radialPointId: undefined }]) {
    const record = { ...records[0], pointCycle: { ...records[0].pointCycle, ...change } };
    assert.equal(summarizeBladeRecords([record]).ungroupedCount, 1);
  }
});

check("矛盾导入计划保留原记录并显式显示冲突", () => {
  const changed = structuredClone(records[1]); changed.pointCycle!.plannedStations![1].azimuthDeg = 100;
  const group = summarizeBladeRecords([records[0], changed]).groups.find(item => item.radialPointId === "p1")!;
  assert.equal(group.planConflict, true); assert.equal(group.recordCount, 2);
  const radius = { ...records[1], pointCycle: { ...records[1].pointCycle, radiusM: 9 } };
  assert.equal(summarizeBladeRecords([records[0], radius]).groups.find(item => item.radialPointId === "p1")!.planConflict, true);
});

check("导入失败与缺少进入记录不计已保存，重试历史和导出不丢失", () => {
  const failed: FieldRecording = { ...records[0], id: "failed", status: "error", error: "读取失败", endedAt: 1792285300 };
  const result = summarizeBladeRecords([...records, failed, records[0]]);
  const group = result.groups.find(item => item.bladeId === "1" && item.radialPointId === "p1")!;
  assert.equal(group.failedCount, 1); assert.equal(group.savedCount, 3); assert.equal(group.recordCount, 5);
  assert.equal(recordingExportIds([...records, failed, records[0]], result.tasks[0].key).length, 61);
  const missing: FieldRecording = { ...records[0], pointCycle: { ...records[0].pointCycle, completion: "missing_exit" } };
  assert.equal(summarizeBladeRecords([missing]).groups.find(item => item.radialPointId === "p1")!.gapCount, 1);
});

check("导入的32位任务标识仍不能冒充自动采集完成", () => {
  const imported = records.map(record => ({ ...record, pointCycle: { ...record.pointCycle, collectionId: "a".repeat(32) } }));
  const summary = summarizeBladeRecords(imported);
  assert.equal(summary.tasks[0].key, recordingTaskKey(imported[0]));
  assert.equal(getAutoCaptureTargetState(imported, { collectionId: "a".repeat(32), bladeId: "1", radialPointId: "p1", cycles: 1, stationCount: 4 }, summary), "empty");
});
console.log(`${checks} imported-record checks passed`);
