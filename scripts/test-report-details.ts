import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { reportDatasetFigure, reportDetails, reportTaskFigure, reportTables } from "../packages/ui/src/report-details";
import { recordDataset, type ResultDataset } from "../packages/ui/src/result-data";
import { modalResult } from "../packages/ui/src/modal-data";
import { healthDemoDamage, healthDemoMetrics } from "../packages/ui/src/health-data";
const tests: {name:string;result:string}[]=[];
function check(name:string,fn:()=>void){fn();tests.push({name,result:"pass"});console.log("PASS "+name);}
check("32 列宽表每组不超过 5 列，重复索引且完整保留全部列和值",()=>{
  const headers=Array.from({length:32},(_,i)=>"列"+i), rows=Array.from({length:8},(_,r)=>headers.map((_,i)=>`${r}:${i}`));
  const before=structuredClone({headers,rows}), groups=reportTables(headers,rows);
  assert.equal(groups.length,8);assert.ok(groups.every(g=>g.headers.length<=5));
  assert.deepEqual(groups.flatMap(g=>g.headers.slice(1)),headers.slice(1));
  rows.forEach((row,r)=>{assert.deepEqual(groups.flatMap(g=>g.rows[r].slice(1)),row.slice(1));groups.forEach(g=>assert.equal(g.rows[r][0],row[0]));});
  assert.deepEqual({headers,rows},before); assert.match(groups[7].caption!,/8 \/ 8/);
});
check("健康趋势宽表重复日期和索引，八项指标各出现一次，窄表不改变",()=>{
  const headers=["索引","日期",...Array.from({length:8},(_,i)=>"指标"+i)],rows=[["0","2026-06-01",...Array.from({length:8},(_,i)=>String(i))]];
  const groups=reportTables(headers,rows,2);assert.equal(groups.length,3);
  assert.deepEqual(groups.flatMap(g=>g.headers.slice(2)),headers.slice(2));
  groups.forEach(g=>assert.deepEqual(g.rows[0].slice(0,2),rows[0].slice(0,2)));
  assert.deepEqual(reportTables(headers.slice(0,2),[rows[0].slice(0,2)]),[{headers:headers.slice(0,2),rows:[rows[0].slice(0,2)]}]);
});
check("六指标损伤演示报告使用中文字段、明确缺失阈值，不渲染原始 JSON 数组",()=>{
  const b={object:"风机叶片A",rms:1.42,score:82,confidence:.83};
  const detail=reportDetails("损伤识别","source",[{id:"six",name:"六指标演示",taskId:"source",type:"damage",source:"demo",result:{...healthDemoDamage(b),metrics:healthDemoMetrics(b)}}])[0];
  const text=detail.parameters.join("\n"); assert.ok(text.includes("严重程度：中")); assert.ok(text.includes("监测指标 / 峰峰值：6.6 mm/s；报警阈值 未配置；未判定")); assert.ok(text.includes("结果 / 结论：演示样例")); assert.ok(!text.includes('{"key"')); assert.equal(detail.figure,undefined);
});
const task={id:"source",name:"报告源任务",sampleRate:4,samples:[.1,-2,3,-4],channels:[{no:1,type:"acceleration",unit:"m/s²"}],source:"import"};
check("原始报告图与数值导出使用同一已保存时间、幅值和实际单位",()=>{
  const before=structuredClone(task),figure=reportTaskFigure(task)!;
  assert.deepEqual(figure.option.series[0].data,recordDataset("tasks",task).rows);assert.equal(figure.option.yAxis.name,"m/s²");assert.deepEqual(task,before);
  for(const invalid of [{...task,samples:[]},{...task,sampleRate:0},{...task,samples:[NaN]}])assert.equal(reportTaskFigure(invalid),undefined);
});
const fft:ResultDataset={schema:"blade-vms/dataset-v1",title:"冻结频谱",columns:[{key:"frequency",label:"频率",unit:"Hz",type:"number"},{key:"value",label:"幅值",unit:"mm/s",type:"number"}],rows:Array.from({length:100},(_,i)=>[i/20,i===12?1.8:.05]),metadata:{type:"fft",source:"demo"}};
check("频谱绘图不从当前任务重算，报告表明确预览范围及完整数值引用",()=>{
  const details=reportDetails("FFT 频谱","source",[{id:"saved-fft",name:"已存FFT",taskId:"source",type:"fft",parameters:{nfft:4096,sourceRevision:"trusted-revision"},result:{dataset:fft},source:"demo"}]);
  assert.equal(details.length,1);assert.deepEqual(details[0].figure!.option.series[0].data,fft.rows);assert.equal(details[0].rows!.length,8);assert.match(details[0].tableNote!,/8 \/ 100/);assert.match(details[0].tableNote!,/saved-fft/);assert.ok(details[0].parameters.includes("NFFT：4096"));
});
check("旧式损伤结果展开为中文字段，只有说明的记录不补造图表",()=>{
  const detail=reportDetails("损伤识别","source",[{id:"damage",name:"损伤",taskId:"source",type:"damage",result:{location:"P3 叶尖",confidence:.83,note:"演示记录"}}])[0];
  assert.ok(detail.parameters.includes("结果 / 位置：P3 叶尖"));assert.ok(detail.parameters.includes("结果 / 置信度：0.83"));assert.equal(detail.figure,undefined);assert.equal(detail.rows,undefined);assert.ok(!detail.description.includes('{"'));
});
check("旧批处理矩阵提供可读数值表，非法矩阵不静默显示伪造数据",()=>{
  const records=[{id:"batch",name:"历史批处理",taskId:"source",type:"time",parameters:{step:"cut"},result:{columns:["时间 (s)","原始幅值 (mm/s)"],rows:[[0,-2],[.25,3]]}}];
  const detail=reportDetails("降噪与截取","source",records)[0];assert.deepEqual(detail.rows,[["0","-2"],["0.25","3"]]);assert.equal(reportDetails("原始波形","source",records).length,0);
  const invalid=reportDetails("FFT 频谱","source",[{id:"broken",name:"不完整频谱",taskId:"source",type:"fft",result:{dataset:{...fft,rows:[[0,NaN]]}}}])[0];assert.equal(invalid.figure,undefined);assert.equal(invalid.rows,undefined);assert.match(invalid.description,/矩阵无效/);
});
check("多段报告保留原任务时间和独立系列，不跨间隙连线",()=>{
  const data:ResultDataset={...fft,columns:[{key:"segment",label:"段",unit:"",type:"string"},{key:"sampleIndex",label:"索引",unit:"",type:"number"},{key:"time",label:"时间",unit:"s",type:"number"},{key:"value",label:"原始幅值",unit:"mm/s",type:"number"}],rows:[["a",0,0,1],["a",1,.25,2],["b",8,2,-1],["b",9,2.25,-2]]};
  const figure=reportDatasetFigure(data)!;assert.equal(figure.option.series.length,2);assert.deepEqual(figure.option.series[1].data,[[2,-1],[2.25,-2]]);
});
check("模态主表保留全部三阶与阻尼，跨任务结果不混入报告",()=>{
  const result=modalResult(task,{test:"free",method:"峰值拾取",damping:"半功率带宽",points:["P1","P3"],activeOrder:2,baselineId:"prototype"});
  const detail=reportDetails("模态参数","source",[{id:"modal",name:"模态",taskId:"source",type:"modal",parameters:{config:result.config},result},{id:"other",taskId:"another",type:"modal",result}]);
  assert.equal(detail.length,1);assert.deepEqual(detail[0].rows!.map(row=>row.slice(0,3)),[["1","0.6","1.2"],["2","1.8","1.8"],["3","3.5","2.1"]]);assert.match(detail[0].headers![2],/%/);
});
mkdirSync("artifacts",{recursive:true});writeFileSync("artifacts/report-core-results.json",JSON.stringify({time:new Date().toISOString(),tests},null,2));
