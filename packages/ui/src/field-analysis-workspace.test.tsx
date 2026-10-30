import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopAnalysisWorkspace } from "./field-analysis-workspace";
import { lineOption } from "./field-record-analysis-charts";
import { ResponseBandFields, ResponseCoverage } from "./unified-analysis-controls";
import { normalizedAlgorithmOptions,previewBandForRates,responseBandMessage } from "./field-analysis-workspace-data";
import { modalInputReason } from "./formal-modal-workspace";
import { desktopAlgorithmDefaults, desktopRecordLabel, algorithmError, workspacePointSeries, emptyRecordFilters, recordFilterChoices, changeRecordFilter, workspaceStftOption } from "./field-analysis-workspace-data";
import type { AnalysisTask } from "./field-record-analysis-data";

const task: AnalysisTask = { id: "task", name: "10241804-叶片2-P1至P5", turbine: "1303", windFarm: "wf1", recordingIds: ["record"], plannedPoints: [], records: [] };
const record = { id: "record", bladeId: "2", pointName: "P1", azimuthDeg: 0, sampleRate: 4000 };
assert.equal(desktopRecordLabel(task, record), "10241804-叶片2-P1至P5－wf1－1303－叶片2－P1－0°");
assert.ok(desktopRecordLabel(task, { ...record, pointName: "135000点" }).includes("未填写测点"));
assert.ok(desktopRecordLabel(task, { ...record, azimuthDeg: undefined }).endsWith("未知角度"));
assert.equal(algorithmError(desktopAlgorithmDefaults, [record]), "");
assert.deepEqual(previewBandForRates([250000])?.band,[100,20000]);
assert.deepEqual(previewBandForRates([250000,1000])?.band,[50,500]);
assert.equal(normalizedAlgorithmOptions({}).targetBandMode,'preview');
assert.equal(normalizedAlgorithmOptions({targetBandHz:[40,60]}).targetBandMode,'custom');
assert.equal(algorithmError(normalizedAlgorithmOptions({targetBandMode:'custom',targetBandHz:[40,60],targetBandSource:''}),[record]),'');
assert.ok(responseBandMessage({targetBandReason:'NO_RESOLVED_FREQUENCY_BINS'}).includes('有效时长'));
const previewMarkup=renderToStaticMarkup(<ResponseBandFields options={desktopAlgorithmDefaults} onChange={()=>{}} sampleRates={[250000]}/>);
assert.ok(previewMarkup.includes('宽频响应预览')&&!previewMarkup.includes('aria-label="目标频带下限"')&&!previewMarkup.includes('aria-label="目标频带来源"'));
const customMarkup=renderToStaticMarkup(<ResponseBandFields options={normalizedAlgorithmOptions({targetBandMode:'custom',targetBandHz:[100,20000]})} onChange={()=>{}} sampleRates={[250000]}/>);
assert.ok(customMarkup.includes('频带备注（选填）')&&customMarkup.includes('aria-label="目标频带下限"'));
assert.ok(modalInputReason({channels:[{role:'response'}],evidence:{}},'decay').includes('激励停止'));
assert.equal(modalInputReason({channels:[{role:'response'}],evidence:{excitationRemoved:true,excitationRemovalSource:'actual recorded experiment'}},'decay'),'');
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
const marked=lineOption([{name:'原始速度',data:[[0,0],[1,1]]}],'时间','mm/s',{area:Array.from({length:100},(_,i)=>[{name:'回波疑点',xAxis:i/100},{xAxis:(i+1)/100}])});
assert.equal(marked.series[0].markArea?.label.show,false,'Dense quality ranges must not print overlapping canvas labels');
assert.equal(marked.series[0].markArea?.data.length,100,'Hide labels without dropping source quality intervals');

// Repeated sources stay selectable without a button per record. Independent
// comparison groups retain their own supplied counts and weights.
const coverageReport={coverage:{points:[{bladeId:'2',pointName:'P3',radiusM:.44,plannedAzimuths:[0,90,180,270],observedAzimuths:[0,90,180,270],usableAzimuths:[0,180,270],missingAzimuths:[90]}]},
 records:Array.from({length:16},(_,i)=>({recording_id:String(i).padStart(32,'0'),object:{blade:'2',point:'P3',azimuth_deg:[0,90,180,270][i%4]},quality_assessment:{analysis_eligible:i%4!==1}})),
 aggregates:[{blade:'2',point:'P3',layer:'los_residual',azimuth_count:3,azimuth_results:[{azimuth_deg:0,pass_count:1},{azimuth_deg:180,pass_count:1},{azimuth_deg:270,pass_count:1}]},
 {blade:'2',point:'P3',layer:'los_residual',azimuth_count:1,azimuth_results:[{azimuth_deg:0,pass_count:2}]}]};
const coverage=renderToStaticMarkup(<ResponseCoverage report={coverageReport} onSource={()=>{throw Error('Render must not navigate');}}/>);
assert.ok(coverage.includes('16 条记录')&&coverage.includes('可分析 12')&&coverage.includes('待复核 4'));
assert.ok(coverage.includes('2 组独立统计权重'));
assert.ok(!coverage.includes('<dialog'));assert.equal((coverage.match(/>查看来源与权重<\/button>/g)||[]).length,1);
assert.equal((coverage.match(/>查看原始记录<\/button>/g)||[]).length,0);
assert.equal((coverage.match(/<button /g)||[]).length,1,'Show one detail action instead of sixteen source buttons');

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
assert.ok(signal.includes("旋转测振") && signal.includes("有效信号") && signal.includes("原始记录"));
assert.ok(signal.includes("算法配置") && signal.includes("开始分析"));
assert.ok(['任务','风场','风机','叶片'].every(label=>signal.includes('原始记录'+label)));
assert.ok(!signal.includes('导出分析结果')&&!synthesis.includes('导出分析结果'));
assert.ok(synthesis.includes('导出汇总')&&synthesis.includes('导出真实处理结果')&&synthesis.includes('保存此版本'));
const readOnly=renderToStaticMarkup(<DesktopAnalysisWorkspace purpose="synthesis" request={request} readOnly/>);assert.ok(readOnly.includes('查看已保存结果'));assert.ok(!readOnly.includes('分析去趋势'));
assert.ok(!signal.includes('aria-label="起始样本"') && !signal.includes('aria-label="STFT窗长"'));
assert.ok(synthesis.includes("叶片响应分析") && synthesis.includes("合成分析风场") && synthesis.includes("合成分析叶片"));
assert.ok(!synthesis.includes("信号记录视图"));
console.log("PASS desktop archive3: identity, Nyquist validation, true core boundaries and independent page scopes");
