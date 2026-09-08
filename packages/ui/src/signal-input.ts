import { taskMetadata } from "./task-metadata";
import { rotationCanonical, rotationWave, rotationWorkflow } from "./rotation-data";
import { stableJson } from "./sync-data";
import { validateDataset, type ResultDataset } from "./result-data";

export const signalWorkflow = "signal-input-v1";
export type SignalRef = { kind: "tasks" | "analyses"; id: string; segmentId?: string; revision?: string };
export type SignalInput = {
  ref: SignalRef; name: string; taskId: string; unit: string; source: string;
  task: Record<string, any>; segment?: Record<string, any>;
  rows: number[][]; canonical: string;
};
export const signalKey = (ref: SignalRef) => JSON.stringify([ref.kind, ref.id, ref.segmentId || ""]);
export function signalRefs(value: unknown): SignalRef[] {
  if (!Array.isArray(value) || !value.length || value.length > 6) throw Error("请选择 1～6 个输入");
  const seen = new Set<string>();
  return value.map(ref => {
    if (!ref || !["tasks", "analyses"].includes(ref.kind) || typeof ref.id !== "string" || !ref.id || ref.id.length > 64 ||
      (ref.kind === "analyses" && (typeof ref.segmentId !== "string" || !/^\d+:\d+$/.test(ref.segmentId))) ||
      (ref.kind === "tasks" && ref.segmentId !== undefined)) throw Error("任务或已保存段标识无效");
    const key = signalKey(ref);
    if (seen.has(key)) throw Error("不能重复选择同一输入");
    seen.add(key);
    return { kind: ref.kind, id: ref.id, ...(ref.segmentId ? { segmentId: ref.segmentId } : {}), ...(ref.revision ? { revision: ref.revision } : {}) };
  });
}
/** Resolve only actual saved samples. A segment uses its historical matrix, not today's task. */
export function signalInput(ref: SignalRef, record: Record<string, any>): SignalInput {
  return resolveSignalInput(ref, record);
}
function resolveSignalInput(ref: SignalRef, record: Record<string, any>, cachedCanonical?: string): SignalInput {
  signalRefs([ref]);
  if (!record || record.id !== ref.id) throw Error("所选输入已不存在，请刷新后重选");
  if (ref.kind === "tasks") {
    const wave = rotationWave(record);
    return { ref, name: record.name + " / 整条波形", taskId: record.id, unit: wave.unit,
      source: record.source || "unknown", task: structuredClone(taskMetadata(record)), rows: wave.samples.map((v, i) => [i, i / wave.sampleRate, v]), canonical: rotationCanonical(record) };
  }
  const dataset = record.result?.dataset, m = dataset?.metadata;
  if (record.type !== "cut" || m?.workflow !== rotationWorkflow || !Array.isArray(m.segments) ||
    !Array.isArray(dataset.rows) || !dataset.rows.length || dataset.rows.length > 20000 ||
    dataset.columns?.map((c: any) => c.key).join(",") !== "segment,sampleIndex,time,value" || !m.task || !Number.isFinite(m.task.sampleRate) || m.task.sampleRate < 1)
    throw Error("此历史截取没有完整分段矩阵，不能作为信号输入");
  const index = m.segments.findIndex((s: any) => s.id === ref.segmentId), segment = m.segments[index];
  if (!segment?.keep || !Number.isInteger(segment.startIndex) || !Number.isInteger(segment.endIndex) || segment.startIndex < 0 || segment.endIndex <= segment.startIndex)
    throw Error("所选段不存在或已被排除");
  const rows = dataset.rows.filter((row: any[]) => row[0] === index + 1).map((row: any[]) => row.slice(1));
  if (rows.length !== segment.endIndex - segment.startIndex || rows.some((r: number[], i: number) => r.length !== 3 || r.some(v => !Number.isFinite(v)) ||
    r[0] !== segment.startIndex + i || Math.abs(r[1] - r[0] / m.task.sampleRate) > 1e-10)) throw Error("已保存段的采样点或时间轴不完整，不能补造数据");
  return { ref, name: `${record.name} / seg-${String(index + 1).padStart(3, "0")} · ${segment.label}`, taskId: record.taskId,
    unit: dataset.columns[3].unit || "原始单位未注明", source: m.source || "unknown", task: structuredClone(m.task), segment: structuredClone(segment), rows,
    canonical: cachedCanonical || stableJson({ id: record.id, taskId: record.taskId, name: record.name, type: record.type, dataset }) };
}
export function signalChoices(tasks: Record<string, any>[], analyses: Record<string, any>[], taskId?: string) {
  const refs: { ref: SignalRef; record: Record<string, any>; label: string }[] = tasks.filter(t => !taskId || t.id === taskId).map(t => ({ ref: { kind: "tasks", id: t.id }, record: t, label: t.name + " / 整条波形" }));
  for (const a of analyses.filter(a => a.type === "cut" && (!taskId || a.taskId === taskId))) {
    for (const [index, s] of (a.result?.dataset?.metadata?.segments || []).entries()) if (s.keep) refs.push({ ref: { kind: "analyses", id: a.id, segmentId: s.id }, record: a, label: `${a.name} / seg-${String(index + 1).padStart(3, "0")} · ${s.label}` });
  }
  const canonical = new Map<Record<string, any>, string>();
  return refs.map(choice => {
    try {
      const input = resolveSignalInput(choice.ref, choice.record, canonical.get(choice.record));
      canonical.set(choice.record, input.canonical);
      return { ...choice, key: signalKey(choice.ref), input, error: "" };
    }
    catch (e) { return { ...choice, key: signalKey(choice.ref), input: undefined, error: (e as Error).message }; }
  });
}
export async function signalRevision(input: SignalInput) {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.canonical));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function signalInputMetadata(input: SignalInput) {
  return { ref: structuredClone(input.ref), name: input.name, taskId: input.taskId, task: structuredClone(input.task), unit: input.unit, source: input.source,
    segment: input.segment ? structuredClone(input.segment) : null, sampleCount: input.rows.length,
    firstSampleIndex: input.rows[0][0], lastSampleIndex: input.rows.at(-1)![0], sourceStart: input.rows[0][1], sourceEnd: input.rows.at(-1)![1] };
}
export function signalWaveDataset(inputs: SignalInput[], alignment: string, compare = false, time = new Date().toISOString()): ResultDataset {
  signalRefs(inputs.map(input => input.ref));
  if (!["source", "relative"].includes(alignment)) throw Error("时间轴方式无效");
  if (!compare) alignment = "source";
  if (compare && inputs.length < 2) throw Error("对比至少需要两个输入");
  if (!compare && inputs.length !== 1) throw Error("单项分析只能选择一个输入");
  if (inputs.reduce((n, input) => n + input.rows.length, 0) > 20000) throw Error("一次对比最多 20000 个采样点，请使用已保存分段缩小输入；不会截断数据");
  if (compare && inputs.some(input => !input.unit || input.unit === "原始单位未注明" || input.unit !== inputs[0].unit)) throw Error("对比需要已注明且相同的单位；未执行单位或通道转换");
  if (compare && inputs.some(input => input.task.object !== inputs[0].task.object)) throw Error("请选择同一测试对象的输入");
  const column = (key: string, label: string, unit = "") => ({ key, label, unit, type: "number" as const });
  const note = "仅显示已保存的原始采样点，不重采样、不补点、不转换物理量、不执行同步算法。" + (alignment === "relative" ? "各输入首点归零仅用于观察形状，不代表同一采集时刻。" : "时间为各自原任务内的秒数，不代表共享的绝对采集时钟。");
  return { schema: "blade-vms/dataset-v1", title: compare ? "多测点波形对比" : "时域波形 · " + inputs[0].name,
    columns: compare ? [column("input", "输入编号", "1-based"), column("sampleIndex", "源采样索引", "0-based"), column("sourceTime", "原任务时间", "s"), column("time", "显示时间", "s"), column("value", "原始幅值", inputs[0].unit)] : [column("time", "原任务时间", "s"), column("value", "原始幅值", inputs[0].unit)],
    rows: inputs.flatMap((input, n) => input.rows.map(([index, t, v]) => compare ? [n + 1, index, t, alignment === "relative" ? t - input.rows[0][1] : t, v] : [t, v])),
    metadata: { workflow: signalWorkflow, type: "time", compare, alignment: compare ? alignment : "source", note,
      source: inputs.every(i => i.source === inputs[0].source) ? inputs[0].source : "mixed", demo: inputs.some(i => i.source === "demo"),
      task: structuredClone(inputs[0].task), inputs: inputs.map(signalInputMetadata), snapshotAt: time } };
}
/** Pure chart options also used by QA to prove the plotted coordinates match exported values. */
export function signalWaveOption(dataset: ResultDataset, zoom = true) {
  const compare = !!dataset.metadata.compare, inputs = dataset.metadata.inputs;
  return { animation: false, tooltip: { trigger: "axis" }, legend: { type: "scroll", top: 0 },
    grid: { left: 72, right: 25, top: 60, bottom: zoom ? 65 : 40 },
    xAxis: { type: "value", name: dataset.metadata.alignment === "relative" ? "相对起点 (s)" : "原任务时间 (s)", nameLocation: "middle", nameGap: 25 },
    yAxis: { type: "value", name: inputs[0].unit, scale: true }, dataZoom: zoom ? [{ type: "inside", filterMode: "none" }, { type: "slider", height: 15, bottom: 3, filterMode: "none" }] : [],
    series: inputs.map((input: Record<string, any>, n: number) => ({ name: `${n + 1}. ${input.task.point || "测点未注明"} · ${input.name}`, type: "line", showSymbol: false, connectNulls: false,
      data: compare ? dataset.rows.filter(r => r[0] === n + 1).map(r => [r[3], r[4]]) : dataset.rows })) };
}

/** Optional for legacy records: never invent STFT settings missing from a saved snapshot. */
export function validateSignalTimeFrequencyParameters(parameters: Record<string, any>) {
  if (parameters.windowLength !== undefined && (!Number.isInteger(parameters.windowLength) || parameters.windowLength < 16 || parameters.windowLength > 65536)) throw Error("STFT 窗长须为 16～65536 的整数");
  if (parameters.overlapPercent !== undefined && (typeof parameters.overlapPercent !== "number" || !Number.isFinite(parameters.overlapPercent) || parameters.overlapPercent < 0 || parameters.overlapPercent >= 100)) throw Error("STFT 重叠率须大于等于 0 且小于 100%");
}

export function signalRecord(request: Record<string, any>, inputs: SignalInput[], time = new Date().toISOString()): Record<string, any> {
  const p = request.parameters;
  if (p?.workflow !== signalWorkflow || request.taskId !== inputs[0]?.taskId) throw Error("信号输入与关联任务不一致");
  if (typeof p.compare !== "boolean") throw Error("请选择单项分析或多输入对比");
  if (request.type === "tf") validateSignalTimeFrequencyParameters(p);
  const refs = signalRefs(p.inputs);
  if (refs.length !== inputs.length || refs.some((ref, i) => signalKey(ref) !== signalKey(inputs[i].ref) || typeof ref.revision !== "string" || !/^[a-f0-9]{64}$/.test(ref.revision))) throw Error("信号输入需要完整修订标识");
  inputs = inputs.map((input, i) => ({ ...input, ref: refs[i] }));
  if (!["time", "fft", "tf", "filter", "env", "band", "avg", "feat"].includes(request.type) || (p.compare && request.type !== "time")) throw Error("信号分析类型无效");
  const raw = signalWaveDataset(inputs, p.alignment || "source", p.compare === true, time);
  const parameters = { ...structuredClone(p), inputs: refs, compare: p.compare === true, alignment: p.compare ? p.alignment : "source" };
  let dataset = raw;
  if (request.type !== "time") {
    if (!request.result?.dataset?.rows?.length) throw Error("演示标签缺少展示矩阵");
    dataset = { ...request.result.dataset, metadata: { ...request.result.dataset.metadata, workflow: signalWorkflow, type: request.type, source: "demo", demo: true,
      note: "固定原型演示矩阵，未根据所选输入或配置执行算法。输入快照只用于配置溯源，不代表已计算结果。", inputs: inputs.map(signalInputMetadata), task: raw.metadata.task, snapshotAt: time } };
  }
  dataset.metadata.parameters = parameters;
  validateDataset(dataset);
  return { ...request, source: dataset.metadata.source, parameters, result: { dataset, note: dataset.metadata.note } };
}
