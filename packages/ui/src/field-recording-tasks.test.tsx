import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldBladeSummary } from "./field-blade-summary";
import { FieldTaskRecords, groupRecordingTasks, recordingExportIds, recordingTaskKey } from "./field-recording-tasks";
import { summarizeBladeRecords } from "./field-blade-summary-data";
import type { FieldRecording } from "./field-types";

function record(n: number, blade = "1", point = "P1", lap = 1, collection = "a".repeat(32)): FieldRecording {
  return { id: n.toString(16).padStart(32, "0"), name: "同名采集任务", windFarm: "场1", turbine: "机1", object: "风机",
    source: "polytec_ivs500", startedAt: 1000 + n, endedAt: 1001 + n, status: "complete", samples: 100, sampleRate: 1000,
    pointCycle: { mode: "automatic_stations", collectionId: collection, sessionId: n.toString(16).padStart(32, "f"),
      bladeId: blade, radialPointId: point, radialPointName: point, radiusM: .3, stationCount: 1, stationIndex: 1, lapIndex: lap,
      cycles: 2, cycle: lap, pointIndex: 1, pointId: "station-1", pointName: "点位1", dwellSeconds: 5,
      targetAxis1AngleDeg: 10, targetAxis2AngleDeg: 0, completion: "confirmed_pass" } };
}
const records = [record(1), record(2, "1", "P1", 2), record(3, "1", "P2"), record(4, "2"), record(5, "2", "P1", 1, "b".repeat(32))];
const taskKey = recordingTaskKey(records[0]);
assert.equal(groupRecordingTasks(records).length, 2, "Same name must not merge task identities");
assert.equal(groupRecordingTasks([...records, records[0]]).flatMap(task => task.records).length, 5);
assert.equal(summarizeBladeRecords(records).tasks.find(task => task.collectionId === "a".repeat(32))?.key, taskKey);
assert.deepEqual(recordingExportIds(records, taskKey), records.slice(0, 4).map(r => r.id));
assert.deepEqual(recordingExportIds(records, taskKey, "1"), records.slice(0, 3).map(r => r.id));
assert.deepEqual(recordingExportIds(records, taskKey, "1", "P1"), records.slice(0, 2).map(r => r.id), "All laps included, other blades excluded");
assert.equal(groupRecordingTasks([records[0], { ...records[1], windFarm: "其他风场" }]).length, 2);
const legacy = records.slice(0, 2).map(r => ({ ...r, pointCycle: undefined }));
assert.equal(groupRecordingTasks(legacy).length, 2, "Legacy plain records cannot be guessed from names");
assert.equal(groupRecordingTasks(legacy.map(r => ({ ...r, captureSessionId: "c".repeat(32) }))).length, 1);

const table = renderToStaticMarkup(<FieldTaskRecords recordings={records} busy={false} onExportTask={() => {}}>{items => <div>{items.length} 条记录</div>}</FieldTaskRecords>);
assert.ok(table.includes("筛选采集任务")); assert.ok(table.includes("全部任务（2）"));
assert.ok(/<button[^>]*disabled[^>]*>[\s\S]*?导出任务 ZIP<\/button>/.test(table), "All-tasks filter requires explicit task selection");
const summary = renderToStaticMarkup(<FieldBladeSummary recordings={records} onExportTask={() => {}} />);
for (const label of ["导出任务 ZIP", "导出叶片 ZIP", "导出测点 ZIP", "条已保存记录，包含历史重采"]) assert.ok(summary.includes(label), label);
const busy = renderToStaticMarkup(<FieldBladeSummary recordings={records} onExportTask={() => {}} busy exporting />);
assert.ok(busy.includes("正在导出…"));
for (const match of busy.matchAll(/<button([^>]*aria-label="导出[^>]*)>/g)) assert.ok(match[1].includes("disabled"));
console.log("PASS task/blade/point export grouping, namespace isolation, all laps, legacy identities and UI states");
