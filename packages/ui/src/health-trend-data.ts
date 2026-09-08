import { stableJson } from "./sync-data";
import { taskMetadata } from "./task-metadata";
import { recordDataset, validateDataset, type ResultDataset } from "./result-data";
import type { HealthConfig, ReviewActor } from "./health-data";
export const healthTrendWorkflow = "health-trend-v1";
export const healthTrendSampleVersion = "multi-indicator-demo-v2";
export const trendSeries = [
  { key: "amplitude", name: "幅值变化 %", color: "#2D6CC0" },
  { key: "frequency", name: "频率变化 %", color: "#E5484D" },
  { key: "modal", name: "模态变化 %", color: "#7A4DD4" },
  { key: "band", name: "频带能量变化 %", color: "#DC8D1C" },
  { key: "peak", name: "峰值变化 %", color: "#168975" },
  { key: "peakToPeak", name: "峰峰值变化 %", color: "#AD5F92" },
  { key: "mainAmplitude", name: "主频幅值变化 %", color: "#517F9B" },
  { key: "damping", name: "阻尼比变化 %", color: "#87652F" },
];
export const healthTrendGroups = [
  { value: "overview", label: "主要趋势", keys: ["amplitude", "frequency", "modal", "band"] },
  { value: "amplitudes", label: "幅值指标", keys: ["amplitude", "peak", "peakToPeak", "mainAmplitude"] },
  { value: "modal", label: "模态参数", keys: ["modal", "damping"] },
  { value: "all", label: "全部指标", keys: trendSeries.map(s => s.key) },
];
/** Use stored column keys, never array positions or a regenerated demo matrix. */
export function healthTrendColumns(dataset?: ResultDataset, group = "all") {
  const keys = healthTrendGroups.find(g => g.value === group)?.keys || [];
  return trendSeries.flatMap(s => {
    const columnIndex = dataset?.columns.findIndex(c => c.key === s.key && c.type === "number" && c.unit === "%") ?? -1;
    return columnIndex >= 0 && keys.includes(s.key) ? [{ ...s, columnIndex }] : [];
  });
}
export type TrendAnnotation = { id: string; target: "trend" | "waveform"; series: string; startIndex: number; endIndex: number; label: string; note: string; status: "active" | "withdrawn"; actorId: string; actor: string; time: string; withdrawnBy?: string; withdrawnById?: string; withdrawnAt?: string; withdrawalReason?: string };
export function healthBaselineCanonical(b: Record<string, any>) {
  return stableJson(Object.fromEntries(["id", "name", "object", "rms", "frequency", "modal", "score", "confidence", "source", "status", "note", "version"].filter(key => b[key] !== undefined).map(key => [key, b[key]])));
}
export async function healthBaselineRevision(b: Record<string, any>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(healthBaselineCanonical(b))))].map(v => v.toString(16).padStart(2, "0")).join("");
}
export function trendStartDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "2099-12-02") throw Error("展示起日须在 1900-01-01～2099-12-02 内");
  const stamp = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) throw Error("展示起日不是有效日期");
  return { date: value, stamp };
}
export function healthTrendDataset(task: Record<string, any>, baseline: Record<string, any>, config: HealthConfig, startDate: string, time = new Date().toISOString()): ResultDataset {
  if (!task?.id || !baseline?.id || task.object !== baseline.object || task.recordTenant !== baseline.recordTenant) throw Error("请选择同课题组、同对象的任务与基线");
  if (baseline.status === "disabled") throw Error("基线已停用，不能用于新趋势归档");
  if (![baseline.rms, baseline.frequency, baseline.modal].every(v => Number.isFinite(v) && v > 0)) throw Error("基线幅值/频率/模态值须为有效正数");
  if (!config || config.tenant !== baseline.recordTenant || !["configured", "legacy", "missing"].includes(config.status)) throw Error("请先加载有效的当前组阈值状态，缺失配置可归档为未判定");
  const { stamp } = trendStartDate(startDate);
  return validateDataset({ schema: "blade-vms/dataset-v1", title: "健康趋势演示 · " + task.name,
    columns: [{ key: "index", label: "展示日期索引", type: "number", unit: "0-based" }, { key: "date", label: "展示日期", type: "string", unit: "YYYY-MM-DD" }, ...trendSeries.map(s => ({ key: s.key, label: s.name.replace(" %", ""), type: "number" as const, unit: "%" }))],
    rows: Array.from({ length: 30 }, (_, i) => [i, new Date(stamp + i * 86400000).toISOString().slice(0, 10), ...[i * .85 + Math.sin(i * .7) * 2, -i * .14 + Math.sin(i * .65), -i * .11 + Math.cos(i * .8), i * .45 + Math.sin(i * .55) * 1.5, i * .65 + Math.sin(i * .6) * 2.5, i * .7 + Math.sin(i * .5) * 2, i * .55 + Math.sin(i * .75) * 1.8, i * .9 + Math.sin(i * .4)].map(v => Number(v.toFixed(8)))]),
    metadata: { type: "health-trend", workflow: healthTrendWorkflow, sampleVersion: healthTrendSampleVersion, source: "demo", demo: true, task: structuredClone(taskMetadata(task)), baseline: JSON.parse(healthBaselineCanonical(baseline)), thresholds: structuredClone(config), startDate, snapshotAt: time, note: "八条变化曲线为固定的 30 日原型样例（幅值/RMS、频率、模态频率、频带能量、峰值、峰峰值、主频幅值、阻尼比）。日期是用户选择的展示日期，不代表真实长期监测，也不由所选任务或基线计算。百分比样例不对应当前指标绝对值，零线仅为变化率参考，不是实测基线。不执行自动漂移识别、预警触发或异常剔除。归档波形另保留源任务已存幅值；人工标记不会修改数值。" } });
}
export function healthTrendRecord(task: Record<string, any>, baseline: Record<string, any>, config: HealthConfig, input: Record<string, any>, time = new Date().toISOString()): Record<string, any> {
  const dataset = healthTrendDataset(task, baseline, config, input.startDate, time);
  const datasets: Record<string, ResultDataset> = { trend: dataset };
  if (Array.isArray(task.samples) && task.samples.length) datasets.waveform = structuredClone(recordDataset("tasks", task));
  return { name: task.name.slice(0, 150) + " · 健康趋势归档 · " + input.startDate, taskId: task.id, type: "health-trend", source: "demo", parameters: { workflow: healthTrendWorkflow, sampleVersion: healthTrendSampleVersion, startDate: input.startDate, sourceRevision: input.sourceRevision, baselineRevision: input.baselineRevision, configRevision: input.configRevision, baselineId: baseline.id }, result: { dataset, datasets, annotations: [], note: dataset.metadata.note } };
}
function annotationInput(record: Record<string, any>, input: Record<string, any>) {
  if (!input || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw Error("标记需要有效的重试标识");
  if (!["trend", "waveform"].includes(input.target)) throw Error("标记对象须为归档趋势或归档波形");
  const dataset = record.result?.datasets?.[input.target] as ResultDataset | undefined;
  if (!dataset || record.parameters?.workflow !== healthTrendWorkflow) throw Error("归档中没有对应数值，不能补造标记位置");
  if (!Number.isInteger(input.startIndex) || !Number.isInteger(input.endIndex) || input.startIndex < 0 || input.endIndex <= input.startIndex || input.endIndex > dataset.rows.length) throw Error("标记范围须为有效的半开索引区间 [起点,终点)");
  if (!(input.target === "trend" ? healthTrendColumns(dataset).some(s => s.key === input.series) : input.series === "value")) throw Error("请选择归档中实际存在的标记曲线");
  if (!["待复核", "异常", "已确认"].includes(input.label)) throw Error("请选择有效标记类别");
  if (typeof input.note !== "string" || !input.note.trim() || input.note.length > 1000) throw Error("标记说明不能为空且不能超过 1000 字");
  return { id: input.id, target: input.target as "trend" | "waveform", series: input.series as string, startIndex: input.startIndex as number, endIndex: input.endIndex as number, label: input.label as string, note: input.note.trim() };
}
export function addTrendAnnotation(record: Record<string, any>, input: Record<string, any>, actor: ReviewActor, time: string) {
  const value = annotationInput(record, input), annotations = (record.result?.annotations || []) as TrendAnnotation[];
  const old = annotations.find(a => a.id === value.id);
  if (old) {
    if (old.status !== "active" || old.actorId !== actor.id || stableJson(annotationInput(record, old)) !== stableJson(value)) throw Object.assign(Error("相同标记 ID 已用于其他内容或已撤回"), { status: 409 });
    return { record, changed: false };
  }
  if (annotations.length >= 200) throw Error("一份归档最多保留 200 条标记（含撤回记录）");
  const annotation: TrendAnnotation = { ...value, status: "active", actorId: actor.id, actor: actor.name, time };
  return { record: { ...record, result: { ...record.result, annotations: [...annotations, annotation] } }, changed: true };
}
export function withdrawTrendAnnotation(record: Record<string, any>, id: string, reason: unknown, actor: ReviewActor, time: string) {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) throw Error("撤回原因不能为空且不能超过 1000 字");
  const annotations = (record.result?.annotations || []) as TrendAnnotation[], old = annotations.find(a => a.id === id);
  if (!old) throw Object.assign(Error("标记不存在"), { status: 404 });
  if (old.status === "withdrawn") {
    if (old.withdrawnById !== actor.id || old.withdrawalReason !== reason.trim()) throw Object.assign(Error("该标记已撤回，不能改写历史原因"), { status: 409 });
    return { record, changed: false };
  }
  return { record: { ...record, result: { ...record.result, annotations: annotations.map(a => a.id === id ? { ...a, status: "withdrawn", withdrawnBy: actor.name, withdrawnById: actor.id, withdrawnAt: time, withdrawalReason: reason.trim() } : a) } }, changed: true };
}
