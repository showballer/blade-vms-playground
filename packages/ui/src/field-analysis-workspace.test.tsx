import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopAnalysisWorkspace } from "./field-analysis-workspace";
import { desktopAlgorithmDefaults, desktopRecordLabel, algorithmError, workspacePointSeries, emptyRecordFilters, recordFilterChoices, changeRecordFilter, workspaceStftOption } from "./field-analysis-workspace-data";
import type { AnalysisTask } from "./field-record-analysis-data";

const task: AnalysisTask = { id: "task", name: "10241804-叶片2-P1至P5", turbine: "1303", windFarm: "wf1", recordingIds: ["record"], plannedPoints: [], records: [] };
const record = { id: "record", bladeId: "2", pointName: "P1", azimuthDeg: 0, sampleRate: 4000 };
assert.equal(desktopRecordLabel(task, record), "10241804-叶片2-P1至P5－1303－叶片2－P1－0°");
assert.ok(desktopRecordLabel(task, { ...record, pointName: "135000点" }).includes("未填写测点"));
assert.ok(desktopRecordLabel(task, { ...record, azimuthDeg: undefined }).endsWith("未知角度"));
assert.equal(algorithmError(desktopAlgorithmDefaults, [record]), "");
assert.ok(algorithmError({ ...desktopAlgorithmDefaults, filterKind: "lowpass", highHz: 2000 }, [record]).includes("Nyquist"));
assert.ok(algorithmError({ ...desktopAlgorithmDefaults, filterKind: "bandpass", lowHz: 100, highHz: 80 }, [record]).includes("下限"));

const tasks:AnalysisTask[]=[
 { ...task, id:'farm1', records:[record,{...record,id:'blade3',bladeId:'3'}] },
 { ...task, id:'farm2', windFarm:'wf2', records:[{...record,id:'other-farm'}] },
 { ...task, id:'turbine2', turbine:'1304', records:[{...record,id:'other-turbine'}] },
 { ...task, id:'task2', name:'另一个任务', records:[{...record,id:'other-task'}] },
];
assert.equal(recordFilterChoices(tasks,emptyRecordFilters).records.length,5);
const scoped={taskName:task.name,windFarm:'wf1',turbine:'1303',bladeId:'2'};
assert.deepEqual(recordFilterChoices(tasks,scoped).records.map(r=>r.id),['record'],'Same-number blades from other farms, turbines or tasks cannot leak into the selector');
assert.deepEqual(recordFilterChoices(tasks,scoped).windFarms,['wf1','wf2']);
assert.deepEqual(recordFilterChoices(tasks,scoped).bladeIds,['2','3']);
assert.deepEqual(changeRecordFilter(scoped,'taskName','另一个任务'),{taskName:'另一个任务',windFarm:'',turbine:'',bladeId:''});
assert.deepEqual(changeRecordFilter(scoped,'windFarm','wf2'),{...scoped,windFarm:'wf2',turbine:'',bladeId:''});
assert.equal(recordFilterChoices(tasks,{...scoped,bladeId:'missing'}).records.length,0);
assert.deepEqual(recordFilterChoices([{...task,windFarm:undefined,turbine:undefined,records:[{...record,bladeId:undefined}]}],emptyRecordFilters).bladeIds,['未知']);
const stft=workspaceStftOption({data:{time_s:[.1,.2],frequency_hz:[0,100],psd_m2_s2_per_hz:[[1,2],[3,4]]}})!;
assert.equal(stft.animation,false);assert.equal(stft.series[0].progressive,0);assert.equal(stft.series[0].emphasis.disabled,true);
assert.deepEqual(stft.series[0].data,[[0,0,1],[1,0,2],[0,1,3],[1,1,4]]);
assert.equal(workspaceStftOption(null),null);

// Plot the true analysis core using absolute source indices, not the pad or gap.
const series = workspacePointSeries({ records: [{ recording_id: "record", representative: "result", object: { blade: "2", point: "P1", azimuth_deg: 0 }, quality_assessment: { analysis_eligible: true } }] }, {
  record: { segments: [{ result_id: "result", source_start: 100, source_end: 105, analysis_source_start: 101, analysis_source_end: 104, source_indices: [100, 101, 102, 103, 104], layer: "los_residual", layers: { los_residual: [9, .001, -.001, .002, 9] }, time_s: [.1, .101, .102, .103, .104] }] },
}, "P1", "2");
assert.equal(series.length, 1);
assert.deepEqual(series[0].data.map((v: number[]) => v[1]), [1, -1, 2]);
assert.equal(series[0].data[0][0], 0);

let calls = 0;
const request = async () => { calls++; throw Error("SSR must not read hardware or start analysis"); };
const signal = renderToStaticMarkup(<DesktopAnalysisWorkspace purpose="signal" request={request} />);
const synthesis = renderToStaticMarkup(<DesktopAnalysisWorkspace purpose="synthesis" request={request} />);
assert.equal(calls, 0);
assert.ok(signal.includes("原始记录分析") && signal.includes("有效信号") && signal.includes("原始记录"));
assert.ok(signal.includes("算法配置") && signal.includes("开始分析"));
assert.ok(['任务','风场','风机','叶片'].every(label=>signal.includes('原始记录'+label)));
assert.ok(!signal.includes('导出分析结果')&&!synthesis.includes('导出分析结果'));
assert.ok(synthesis.includes('导出汇总'));
assert.ok(!signal.includes('aria-label="起始样本"') && !signal.includes('aria-label="STFT窗长"'));
assert.ok(synthesis.includes("叶片合成分析") && synthesis.includes("合成分析风场") && synthesis.includes("合成分析叶片"));
assert.ok(!synthesis.includes("信号记录视图"));
console.log("PASS desktop archive3: identity, Nyquist validation, true core boundaries and independent page scopes");
