import { validateDataset, datasetHeader, recordDataset, type ResultDataset } from "./result-data";
import { signalWaveOption } from "./signal-input";

type Row = Record<string, any>;
export type ReportFigure = { option: Row; caption: string };
export type ReportTable = { headers: string[]; rows: string[][]; caption?: string };
export type ReportDetail = { id: string; title: string; parameters: string[]; description: string; figure?: ReportFigure; headers?: string[]; rows?: string[][]; tables?: ReportTable[]; tableNote?: string };
/** A4-readable column groups. Repeat identifying columns; never omit/recalculate a saved value. */
export function reportTables(headers: string[], rows: string[][], contextColumns = 1): ReportTable[] {
  if (headers.length <= 5) return [{ headers, rows }];
  const context = Math.min(2, Math.max(1, contextColumns));
  const anchors = Array.from({ length: context }, (_, i) => i);
  const groups: ReportTable[] = [];
  for (let start = context; start < headers.length; start += 5 - context) {
    const indices = [...anchors, ...Array.from({ length: Math.min(5 - context, headers.length - start) }, (_, i) => start + i)];
    groups.push({ headers: indices.map(i => headers[i]), rows: rows.map(row => indices.map(i => row[i])), caption: `列分组 ${groups.length + 1} / ${Math.ceil((headers.length - context) / (5 - context))} · 原表第 ${start + 1}–${indices.at(-1)! + 1} 列；重复前 ${context} 列用于对照。` });
  }
  return groups;
}
const types: Record<string, string[]> = { 原始波形: ["time"], 降噪与截取: ["filter","order","avg","cut"], "FFT 频谱": ["fft"], 包络与时频: ["env","tf","band"], 模态参数: ["modal"], 损伤识别: ["damage"], 健康趋势与标记: ["health-trend"] };
const labels: Record<string, string> = { channel:"演示通道", window:"窗函数", nfft:"NFFT", filter:"滤波类型", low:"低截止频率 Hz", high:"高截止频率 Hz", filterOrder:"滤波阶数", filterStructure:"滤波结构", windowLength:"窗长", detrend:"趋势去除", denoise:"异常点处理", quality:"质量门禁", average:"平均次数", config:"配置", rpm:"转速 rpm", blades:"叶片数", mode:"模式", start:"起点 s", end:"终点 s", source:"来源", method:"方法", test:"测试类型", points:"测点", order:"阶次", note:"说明", startDate:"展示起日", alignment:"时间轴", compare:"多输入对比" };
Object.assign(labels, { type:"结果类型", location:"位置", confidence:"置信度", damping:"阻尼法", activeOrder:"显示阶次", baselineId:"基准引用", score:"评分", frequencies:"频率", health:"健康度", label:"损伤类型", severity:"严重程度", criterion:"判据来源", conclusion:"结论", overallGrade:"已判定指标最高等级", baseline:"基线引用", baselineSnapshot:"基线快照", thresholds:"阈值快照", rms:"RMS", frequency:"主频", modal:"一阶模态频率", peak:"峰值", peakToPeak:"峰峰值", mainAmplitude:"主频幅值", band:"频带能量", attentionRatio:"注意比例", warningRatio:"预警比例", tenant:"课题组", revision:"修订", values:"数值", status:"状态", id:"引用", name:"名称", object:"监测对象" });
const text = (value: any): string => value === undefined || value === null || value === "" ? "未填写" : typeof value === "boolean" ? value ? "是" : "否" : String(value);
labels.overlapPercent = "STFT 重叠率 %";
function parameters(value: Row, prefix = ""): string[] {
  return Object.entries(value || {}).flatMap(([key, item]): string[] => {
    if (["workflow","sampleVersion","sourceRevision","baselineRevision","inputs","segments","inputMetadata","inputSnapshot","sourceSnapshot"].includes(key)) return [];
    const label = prefix + (labels[key] || key);
    if (key === "metrics" && Array.isArray(item)) return item.map(m => `${prefix}监测指标 / ${text(m.name)}：${text(m.value)} ${text(m.unit)}；报警阈值 ${m.limit == null ? "未配置" : text(m.limit)}；${["正常","注意","预警","报警"][m.grade] || "未判定"}（演示）。`);
    if (Array.isArray(item)) return [`${label}：${item.map(v => typeof v === "object" ? JSON.stringify(v) : text(v)).join("、")}`];
    if (item && typeof item === "object") return parameters(item, label + " / ");
    return [`${label}：${text(item)}`];
  });
}
/** Draw only the already saved matrix. No spectrum generation or peak detection. */
export function reportDatasetFigure(dataset: ResultDataset): ReportFigure | undefined {
  try { validateDataset(dataset); } catch { return; }
  const c = dataset.columns, m = dataset.metadata;
  const base = { animation: false, color: ["#2D6CC0","#1FA971","#7A4DD4","#F5A623"], tooltip: { trigger: "axis" },
    legend: { type: "scroll", top: 0, textStyle: { fontSize: 12 } }, grid: { left: 75, right: 25, top: 55, bottom: 45 },
    xAxis: { type: "value", scale: true, name: c[0].unit, nameLocation: "middle", nameGap: 25 }, yAxis: { type: "value", scale: true, name: c[1]?.unit } };
  let option: Row | undefined;
  if (m.workflow === "signal-input-v1" && m.type === "time" && m.inputs?.length) option = signalWaveOption(dataset, false);
  else if (["time","frequency"].includes(c[0].key) && c.every(col => col.type === "number") && c.slice(1).every(col => col.unit === c[1].unit)) {
    option = { ...base, series: c.slice(1).map((col, i) => ({ type: "line", name: col.label, showSymbol: dataset.rows.length < 20, data: dataset.rows.map(row => [row[0],row[i+1]]) })) };
  } else if (c.map(col => col.key).join(",") === "segment,sampleIndex,time,value") {
    option = { ...base, xAxis: { ...base.xAxis, name: "s" }, yAxis: { ...base.yAxis, name: c[3].unit }, series: [...new Set(dataset.rows.map(row => row[0]))].map(id => ({ name: "seg-" + id, type: "line", showSymbol: false, data: dataset.rows.filter(row => row[0] === id).map(row => [row[2],row[3]]) })) };
  } else if (c[0].key === "band" && c[1]?.key === "energy") {
    option = { ...base, xAxis: { type: "category", data: dataset.rows.map(row => row[0]) }, series: [{ type: "bar", name: c[1].label, data: dataset.rows.map(row => row[1]) }] };
  }
  if (!option) return;
  return { option, caption: `${dataset.title}。图示全部 ${dataset.rows.length} 行已保存数据；${m.demo || m.source === "demo" ? "演示数据，不作为真实检测依据。" : "保留保存时的数值与单位。"}` };
}
export function reportTaskFigure(task: Row): ReportFigure | undefined {
  try { return reportDatasetFigure({ ...recordDataset("tasks", task), title:"原始任务波形" }); } catch { return; }
}
export function reportDetails(title: string, taskId: string, analyses: Row[]): ReportDetail[] {
  return analyses.filter(a => a.taskId === taskId && ((types[title] || []).includes(a.type) || (title === "降噪与截取" && a.parameters?.step === "cut"))).filter(a => !(title === "原始波形" && a.parameters?.step === "cut")).map(a => {
    let dataset: ResultDataset | undefined;
    try { dataset = recordDataset("analyses", a); } catch { /* Legacy text remains readable, without inventing a matrix. */ }
    const detail: ReportDetail = { id:a.id, title:a.name, parameters:parameters(a.parameters), description:a.result?.note || dataset?.metadata?.note || "此记录没有数值结果说明。" };
    if (a.result?.dataset && !dataset) detail.description += " 保存矩阵无效，报告未补造曲线或数值表。";
    for (const [i,input] of (Array.isArray(dataset?.metadata?.inputs) ? dataset.metadata.inputs : []).entries()) detail.parameters.push(`输入 ${i+1}：${input.name}；测点 ${input.task?.point || "未注明"}；${input.sampleCount} 点；${input.task?.sampleRate} Hz；单位 ${input.unit}；来源 ${input.source}。`);
    if (a.parameters?.sourceRevision) detail.parameters.push("源修订："+a.parameters.sourceRevision);
    if (a.parameters?.baselineRevision) detail.parameters.push("基准修订："+a.parameters.baselineRevision);
    if (dataset) {
      try {
        validateDataset(dataset); detail.figure=reportDatasetFigure(dataset);
        detail.headers=dataset.columns.map(datasetHeader);
        detail.rows=dataset.rows.slice(0,8).map(row=>row.map(cell=>typeof cell === "number" ? Number(cell.toPrecision(8)).toString() : cell));
        detail.tables=reportTables(detail.headers, detail.rows, dataset.columns[0].key === "index" && dataset.columns[1]?.key === "date" ? 2 : 1);
        detail.tableNote=`数值表预览前 ${detail.rows.length} / ${dataset.rows.length} 行，最多显示 8 位有效数字。完整精度与全部数据见分析记录 ${a.id} 的数值导出。`;
      } catch { detail.description += " 保存矩阵不完整，报告未补造曲线或数值表。"; }
    } else if (Array.isArray(a.result?.rows)) {
      detail.description += ` 历史矩阵共 ${a.result.rows.length} 行，完整数值见该分析的数值导出。`;
    } else if (a.result) detail.parameters.push(...parameters(Object.fromEntries(Object.entries(a.result).filter(([key]) => !["note","dataset","datasets"].includes(key))), "结果 / "));
    if (a.type === "health-trend") detail.description += ` 人工标记 ${(a.result?.annotations || []).filter((m:Row)=>m.status==='active').length} 条有效、${(a.result?.annotations || []).filter((m:Row)=>m.status==='withdrawn').length} 条已撤回。标记不改变数值，完整标记内容见分析记录 JSON。`;
    detail.description += ` 来源：${text(a.source)}。分析记录引用：${a.id}。`;
    return detail;
  });
}
