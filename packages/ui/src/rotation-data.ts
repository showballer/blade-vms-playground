import { taskMetadata } from "./task-metadata";
import { stableJson } from "./sync-data";
import type { ResultDataset } from "./result-data";
export const rotationWorkflow = "rotation-segments-v1";
export const segmentLabels = ["叶片通过段", "手动范围", "稳定运行", "启动", "停机", "异常波动", "冲击响应"];
export const segmentQualities = ["未评价", "有效", "异常"];
export type RotationConfig = { rpm: number; blades: number; source: string; mode: "period" | "manual"; start: number; end: number };
export type RotationSegment = { id: string; startIndex: number; endIndex: number; start: number; end: number; partial: boolean; keep: boolean; label: string; quality: string; note: string };
export function rotationParameters(input: Record<string, any>) {
  if (input.source !== "手动") throw Error("键相和信号估计尚未接入，请使用手动转速");
  if (!Number.isFinite(input.rpm) || input.rpm < 0) throw Error("转速必须是非负有限数值");
  if (!Number.isInteger(input.blades) || input.blades < 1 || input.blades > 1000) throw Error("叶片数必须是 1～1000 的整数");
  const fr = input.rpm / 60, fb = fr * input.blades;
  if (!Number.isFinite(fb)) throw Error("转速与叶片数超出有效范围");
  return { rpm: input.rpm as number, blades: input.blades as number, source: "手动", fr, fb };
}
export function rotationCanonical(task: Record<string, any>) {
  const keys = ["id", "name", "object", "turbine", "point", "direction", "rpm", "blades", "sampleRate", "range", "duration", "condition", "note", "source", "samples", "channels", "testTime", "environment", "faultType"];
  return stableJson(Object.fromEntries(keys.filter(k => task[k] !== undefined).map(k => [k, task[k]])));
}
export async function rotationRevision(task: Record<string, any>) {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(rotationCanonical(task)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function rotationWave(task: Record<string, any>) {
  if (!task || !Number.isFinite(task.sampleRate) || task.sampleRate < 1 || !Array.isArray(task.samples) || !task.samples.length || task.samples.length > 20000 || task.samples.some((x: unknown) => typeof x !== "number" || !Number.isFinite(x))) throw Error("当前任务没有有效原始波形（需 1～20000 个采样点及有效采样率）");
  return { samples: task.samples as number[], sampleRate: task.sampleRate as number, duration: task.samples.length / task.sampleRate, unit: task.channels?.[0]?.unit || "原始单位未注明" };
}
const sampleCeil = (value: number) => Math.ceil(value - 1e-9);
export function generateRotationSegments(task: Record<string, any>, input: Record<string, any>): { config: RotationConfig; segments: RotationSegment[] } {
  const { samples, sampleRate, duration } = rotationWave(task), params = rotationParameters(input);
  if (!["period", "manual"].includes(input.mode)) throw Error("自动稳定段识别尚未接入，请使用手动范围或恒定转速周期边界");
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end <= input.start || input.end > duration + 1e-12) throw Error(`时间范围须在 0～${duration} 秒内，终点大于起点`);
  const config: RotationConfig = { rpm: params.rpm, blades: params.blades, source: params.source, mode: input.mode, start: input.start, end: Math.min(input.end, duration) };
  const startIndex = Math.max(0, sampleCeil(config.start * sampleRate)), endIndex = Math.min(samples.length, sampleCeil(config.end * sampleRate));
  if (endIndex <= startIndex) throw Error("所选范围内没有采样点");
  const step = config.mode === "manual" ? config.end - config.start : 1 / params.fb;
  if (!Number.isFinite(step) || step <= 0) throw Error("零转速不能按叶片通过周期分段，请使用手动时间范围");
  if (config.mode === "period" && step * sampleRate < 1 - 1e-9) throw Error("每周期不足一个采样点，不能生成有效周期边界");
  const count = Math.ceil((config.end - config.start) / step - 1e-10);
  if (count < 1 || count > 200) throw Error("一次最多生成 200 个分段，请缩小时间范围");
  const segments: RotationSegment[] = [];
  for (let i = 0; i < count; i++) {
    const start = config.start + i * step, end = Math.min(config.end, config.start + (i + 1) * step);
    const a = Math.max(startIndex, sampleCeil(start * sampleRate)), b = Math.min(endIndex, sampleCeil(end * sampleRate));
    if (b <= a) continue;
    segments.push({ id: `${a}:${b}`, startIndex: a, endIndex: b, start: a / sampleRate, end: b / sampleRate, partial: config.mode === "period" && end - start < step - 1e-10, keep: true, label: config.mode === "period" ? "叶片通过段" : "手动范围", quality: "未评价", note: "" });
  }
  if (!segments.length) throw Error("所选范围内没有可用分段");
  return { config, segments };
}
export function rotationCutDataset(task: Record<string, any>, input: Record<string, any>, chosen: RotationSegment[], revision: string, time = new Date().toISOString()): ResultDataset {
  const generated = generateRotationSegments(task, input), { samples, sampleRate, unit } = rotationWave(task);
  if (!Array.isArray(chosen) || chosen.length !== generated.segments.length) throw Error("分段列表与当前参数不一致，请重新生成");
  const segments = generated.segments.map((segment, i) => {
    const review = chosen[i];
    if (!review || review.id !== segment.id || review.startIndex !== segment.startIndex || review.endIndex !== segment.endIndex || typeof review.keep !== "boolean" || !segmentLabels.includes(review.label) || !segmentQualities.includes(review.quality) || typeof review.note !== "string" || review.note.length > 300) throw Error("分段边界或人工标注无效，请重新生成");
    return { ...segment, keep: review.keep, label: review.label, quality: review.quality, note: review.note };
  });
  if (!segments.some(s => s.keep)) throw Error("请至少保留一个分段");
  const rows: number[][] = [];
  segments.forEach((segment, i) => { if (segment.keep) for (let n = segment.startIndex; n < segment.endIndex; n++) rows.push([i + 1, n, n / sampleRate, samples[n]]); });
  const excluded = segments.filter(s => !s.keep).map(s => ({ startIndex: s.startIndex, endIndex: s.endIndex, quality: s.quality, note: s.note }));
  return { schema: "blade-vms/dataset-v1", title: "旋转测振有效段 · " + task.name,
    columns: [{ key: "segment", label: "分段编号", unit: "", type: "number" }, { key: "sampleIndex", label: "源采样索引", unit: "0-based", type: "number" }, { key: "time", label: "原任务时间", unit: "s", type: "number" }, { key: "value", label: "原始幅值", unit, type: "number" }], rows,
    metadata: { type: "cut", workflow: rotationWorkflow, source: task.source || "unknown", demo: task.source === "demo", sourceRevision: revision, task: structuredClone(taskMetadata(task)), parameters: generated.config, segments, keptSamples: rows.length, excludedSamples: excluded.reduce((n, s) => n + s.endIndex - s.startIndex, 0), excludedRanges: excluded, snapshotAt: time,
      note: "从已保存原始波形按半开采样索引区间 [startIndex,endIndex) 选择；不改幅值、不拼接时间轴、不重采样。周期边界仅按手动恒定转速推算，以所选起点为时间锚点，不代表真实转角/键相或叶片编号。段类型与质量为人工标注，未执行自动异常识别。" } };
}
export function rotationCutRecord(task: Record<string, any>, request: Record<string, any>, time = new Date().toISOString()): Record<string, any> {
  const p = request.parameters;
  if (p?.workflow !== rotationWorkflow || typeof p.sourceRevision !== "string" || !/^[0-9a-f]{64}$/.test(p.sourceRevision)) throw Error("截取记录需要当前任务修订与旋转分段参数");
  const dataset = rotationCutDataset(task, p.config, p.segments, p.sourceRevision, time);
  return { ...request, type: "cut", taskId: task.id, source: task.source || "unknown", parameters: { workflow: rotationWorkflow, sourceRevision: p.sourceRevision, config: dataset.metadata.parameters, segments: dataset.metadata.segments }, result: { dataset, note: dataset.metadata.note } };
}
export function rotationOrderDataset(task: Record<string, any> | undefined, input: Record<string, any>, option: Record<string, any>): ResultDataset {
  const parameters = rotationParameters(input), { fr, fb, blades } = parameters;
  return { schema: "blade-vms/dataset-v1", title: "阶次谱演示 · " + (task?.name || "预览"), columns: [{ key: "label", label: "频率标识", unit: "", type: "string" }, { key: "order", label: "阶次", unit: "", type: "number" }, { key: "frequency", label: "参数换算频率", unit: "Hz", type: "number" }, { key: "amplitude", label: "原型演示幅值", unit: "原型相对幅值", type: "number" }], rows: option.series[0].data.map((cell: { value: number }, i: number) => [option.xAxis.data[i], [1, blades, 2, 3][i], [fr, fb, 2 * fr, 3 * fr][i], cell.value]), metadata: { type: "order", source: "demo", demo: true, task: task ? taskMetadata(task) : null, parameters, note: "幅值为阶次图的固定原型样例，只有频率关系按手动参数换算；未执行 FFT、转速同步重采样或阶次跟踪。", snapshotAt: new Date().toISOString() } };
}
