import assert from 'node:assert/strict';
import {reportSpatialFigure} from '../packages/ui/src/measurement-report-figure';
import {healthReportStatus,measurementReportModel,reportDate,reportNumber} from '../packages/ui/src/measurement-report-model';

const blade = {
 bladeId:'b2', name:'2', processingResultId:'version-2', status:'insufficient',
 ruleSnapshot:null, referenceSnapshot:null, coverage:{acquired:20,analyzable:19,review:1,missing:[],points:[{pointName:'P2',usableAzimuths:[0,90,180,270]}]},
 commonResponse:[{layer:'los_residual',azimuths:[0,90,180,270],points:[{point:'P2',radiusM:21.15,mean_half_peak_to_peak_m_s:.1}]}],
 conditions:[{sourceTimes:[{start:'2026-11-01T04:00:00Z',end:'2026-11-01T04:00:01Z'}],condition:{status:'matched',windSpeed:6,rpm:12,healthEligible:false,reasons:['时间平移测试副本']}}],
 reasons:['来源物理叶片身份尚未独立核验'],geometryEstimates:[{values:{radius_from_hub_m:21.15}}]
};
const report = {rows:[],objects:[],bladeAssessments:[blade],faultTests:[
 {test_only:true,sourceProcessingResultId:'old-version',context:{bladeId:'b2'},status:'warning',point:'P1'},
 {test_only:true,sourceProcessingResultId:'version-2',context:{bladeId:'b2'},status:'warning',point:'P3'},
],displacementSnapshots:[{processingResultId:'old-version',points:[{layer:'los_residual',object:{point:'P2'},mean_half_peak_to_peak_m:99}]},{processingResultId:'version-2',points:[{layer:'los_residual',object:{point:'P2'},mean_half_peak_to_peak_m:.002}]}]};
const before=JSON.stringify(report),m=measurementReportModel(report);
assert.equal(m.acquired,20);assert.equal(m.analyzable,19);assert.equal(m.blades[0].name,'叶片 2');
assert.equal(m.blades[0].status,'健康状态未核验');assert(!('test' in m.blades[0]));
assert.equal(m.blades[0].points[0].velocityMmS,100);assert.equal(m.blades[0].points[0].displacementMm,2);
assert.equal(m.blades[0].matched,1);assert(m.notes.some(v=>v.includes('时间平移')));
assert.equal(m.blades[0].shiftedConditions,true);
assert.equal(measurementReportModel({...report,bladeAssessments:[{...blade,conditions:[]}]}).blades[0].shiftedConditions,false);
assert.equal(measurementReportModel({...report,bladeAssessments:[{...blade,conditions:[],reasons:['使用时间平移关联']}]}).blades[0].shiftedConditions,true);
assert.equal(JSON.stringify(report),before);
assert.equal(healthReportStatus({...blade,status:'normal'}),'健康状态未核验');
assert.equal(healthReportStatus({...blade,status:'normal',ruleSnapshot:{},referenceSnapshot:{}}),'未触发响应预警');
assert.equal(healthReportStatus({...blade,status:'warning',ruleSnapshot:{},referenceSnapshot:{}}),'响应异常，待复核');
assert.equal(healthReportStatus({...blade,status:'normal',ruleSnapshot:{},referenceSnapshot:{},evidenceReadiness:{blockers:['身份待确认']}}),'健康状态未核验');
assert.equal(healthReportStatus({processingResultId:null,acquired:20}),'待分析');
assert.equal(healthReportStatus({processingResultId:null}),'未测量');
assert.equal(reportDate(null),'未记录');assert.equal(reportDate(''),'未记录');assert.equal(reportNumber(null),'—');assert.equal(reportNumber(NaN),'—');
assert.deepEqual(measurementReportModel({...report,faultTests:[]}),m,'legacy injected warnings must not affect report output');
assert.equal(measurementReportModel({...report,displacementSnapshots:[]}).blades[0].points[0].displacementMm,null);
assert.equal(m.sourceNotice,null,'measured reports must not be relabeled as validation data');
const validationReport={...report,bladeAssessments:[1,2,3].map(n=>({...blade,bladeId:`b${n}`,name:String(n),syntheticScenario:{dataOrigin:'synthetic',detection:{label:n===2?'疑似损伤':'响应正常'}}}))};
const validationBefore=JSON.stringify(validationReport),validationModel=measurementReportModel(validationReport);
assert.deepEqual(validationModel.blades.map((b:any)=>b.status),['检测结果：响应正常','检测结果：疑似损伤','检测结果：响应正常']);
assert.equal(validationModel.sourceNotice,'算法验证样本（叶片 1、叶片 2、叶片 3）');
const mixed=measurementReportModel({...report,bladeAssessments:[{...blade,name:'1'},validationReport.bladeAssessments[1]]});
assert.equal(mixed.sourceNotice,'算法验证样本（叶片 2）');
assert.equal(mixed.blades[0].status,'健康状态未核验');
assert.equal(JSON.stringify(validationReport),validationBefore,'presentation changes must not rewrite provenance or stored results');
console.log('PASS health report: measured coverage independent of legacy rows, no false healthy status, test/version isolation, exact chart units, immutable snapshots');

const spatialPoints=[{name:'P1',radiusM:7.05,displacementMm:1},{name:'P2',radiusM:21.15,displacementMm:2},{name:'P3',radiusM:35.25,displacementMm:1.5}];
const spatialBefore=JSON.stringify(spatialPoints),svg=reportSpatialFigure(spatialPoints,true)!;
assert.match(svg,/估算位置/);assert.match(svg,/非同步实测振型/);
assert.match(svg,/data-point="P2" data-radius-m="21.15" data-amplitude="1"/);
assert.match(svg,/data-point="P3" data-radius-m="35.25" data-amplitude="0.75"/);
assert.equal(JSON.stringify(spatialPoints),spatialBefore);
assert.equal(reportSpatialFigure(spatialPoints.map(p=>({...p,radiusM:null}))),null);
assert.equal(reportSpatialFigure(spatialPoints.map(p=>({...p,displacementMm:null}))),null);
const gap=reportSpatialFigure(spatialPoints.map((p,i)=>i===1?{...p,displacementMm:null}:p))!;
assert(!gap.includes('data-interval='),'missing amplitude must not be bridged');
const unknown=reportSpatialFigure(spatialPoints.map((p,i)=>i===1?{...p,radiusM:null}:p))!;
assert(!unknown.includes('data-interval='),'unknown position must not be interpolated');
assert(!reportSpatialFigure([{name:'<script>',radiusM:1,displacementMm:1}])!.includes('<script>'));
console.log('PASS report 3D: normalized actual displacement, missing geometry/data, no fabricated surface, immutable points, escaped labels');
