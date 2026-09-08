/** Persistent workflow only. No acquisition or Python/FFT/filter implementation lives here. */
export const batchSteps = ["denoise", "cut", "fft", "features"] as const;
export type BatchStepKey = typeof batchSteps[number];
export const batchStepNames: Record<BatchStepKey, string> = { denoise: "降噪", cut: "截取", fft: "FFT", features: "特征提取" };
export const batchFilterMethods = ["滑动平均", "中值", "低通", "高通", "带通", "带阻", "小波"];
export const batchFeatures = ["RMS", "峰值", "峰峰值", "峭度", "均值"];
export type BatchConfig = {
  denoise: { enabled: boolean; method: string; low: number; high: number; order: number; windowLength: number };
  cut: { enabled: boolean; start: number; end: number | null };
  fft: { enabled: boolean; nfft: number; window: string };
  features: { enabled: boolean; names: string[] };
};
export const defaultBatchConfig: BatchConfig = {
  denoise: { enabled: true, method: "滑动平均", low: 0.1, high: 20, order: 4, windowLength: 16 },
  cut: { enabled: true, start: 0, end: null },
  fft: { enabled: true, nfft: 4096, window: "Hann" },
  features: { enabled: true, names: ["RMS", "峰值", "峭度"] },
};
export type BatchStep = { key: BatchStepKey; state: "pending" | "completed" | "failed"; attempts: number; analysisId?: string; error?: string; finishedAt?: string };
export type BatchItem = { taskId: string; name: string; input: Record<string, any>; sourceTenant?: string; steps: BatchStep[] };
export type BatchJob = { id: string; name: string; config: BatchConfig; items: BatchItem[]; paused: boolean; createdAt: string; updatedAt: string; requestHash?: string; source: "demo" };
export type BatchView = Omit<BatchJob, "items" | "requestHash"> & {
  items: (Omit<BatchItem, "input" | "sourceTenant"> & { sampleCount: number; sampleRate: number })[];
  completed: number; total: number; failed: number; status: "completed" | "paused" | "failed" | "ready";
};
export class BatchError extends Error { constructor(message: string, public status = 400) { super(message); } }
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const validId = (value: any) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
export function normalizeBatchRequest(body: any) {
  if (!body || !validId(body.id) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120)
    throw new BatchError("请输入批次名称（最多 120 字）和有效批次标识");
  if (!Array.isArray(body.taskIds) || !body.taskIds.length || body.taskIds.length > 50 || body.taskIds.some((id: any) => !validId(id)) || new Set(body.taskIds).size !== body.taskIds.length)
    throw new BatchError("批次须选择 1～50 个不重复的任务");
  const c = body.config;
  if (!c || batchSteps.some((key) => !c[key] || typeof c[key].enabled !== "boolean") || !batchSteps.some((key) => c[key].enabled)) throw new BatchError("请至少选择一个处理步骤");
  if (c.denoise.enabled && (!batchFilterMethods.includes(c.denoise.method) || ![c.denoise.low, c.denoise.high, c.denoise.order, c.denoise.windowLength].every(Number.isFinite) || c.denoise.low < 0 || c.denoise.high <= c.denoise.low || !Number.isInteger(c.denoise.order) || c.denoise.order < 1 || c.denoise.order > 32 || !Number.isInteger(c.denoise.windowLength) || c.denoise.windowLength < 1 || c.denoise.windowLength > 20000))
    throw new BatchError("降噪参数无效：截止频率递增，阶数 1～32，窗长 1～20000");
  if (c.cut.enabled && (!Number.isFinite(c.cut.start) || c.cut.start < 0 || (c.cut.end !== null && (!Number.isFinite(c.cut.end) || c.cut.end <= c.cut.start)))) throw new BatchError("截取起点须非负，终点须大于起点；终点留空表示数据末尾");
  if (c.fft.enabled && (![256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].includes(c.fft.nfft) || !["Hann", "Hamming", "Blackman", "矩形窗"].includes(c.fft.window))) throw new BatchError("请选择有效的 FFT 点数和窗函数");
  if (c.features.enabled && (!Array.isArray(c.features.names) || !c.features.names.length || new Set(c.features.names).size !== c.features.names.length || c.features.names.some((v: any) => !batchFeatures.includes(v)))) throw new BatchError("请选择不重复的有效特征项");
  // Discard unknown fields; disabled steps receive known defaults, not arbitrary payloads.
  const config = copy(defaultBatchConfig);
  for (const key of batchSteps) {
    const target = config[key] as any;
    target.enabled = c[key].enabled;
    if (target.enabled) for (const field of Object.keys(target)) target[field] = copy(c[key][field]);
  }
  return { id: body.id as string, name: body.name.trim(), taskIds: [...body.taskIds] as string[], config };
}
export function createBatchJob(request: ReturnType<typeof normalizeBatchRequest>, tasks: Record<string, any>[], now = new Date().toISOString()): BatchJob {
  if (tasks.length !== request.taskIds.length || tasks.some((task, index) => task.id !== request.taskIds[index])) throw new BatchError("所选任务不完整或不可见", 404);
  const job: BatchJob = { id: request.id, name: request.name, config: copy(request.config), createdAt: now, updatedAt: now, paused: true, source: "demo",
    items: tasks.map(({ _batchTenant, ...task }) => ({ taskId: task.id, name: task.name, input: copy(task), sourceTenant: _batchTenant,
      steps: batchSteps.filter((key) => request.config[key].enabled).map((key) => ({ key, state: "pending", attempts: 0 })) })) };
  if (new TextEncoder().encode(JSON.stringify(job)).length > 8_000_000) throw new BatchError("批次输入快照超过 8 MB，请减少所选任务", 413);
  return job;
}
export function batchView(job: BatchJob): BatchView {
  const { items, requestHash: _, ...info } = job;
  const steps = items.flatMap((item) => item.steps);
  const completed = steps.filter((s) => s.state === "completed").length, failed = steps.filter((s) => s.state === "failed").length;
  return { ...info, items: items.map(({ input, sourceTenant: _, ...item }) => ({ ...item, sampleCount: input.samples?.length || 0, sampleRate: input.sampleRate })), completed, total: steps.length, failed,
    status: completed === steps.length ? "completed" : job.paused ? "paused" : failed ? "failed" : "ready" };
}
export function setBatchPaused(job: BatchJob, paused: boolean) { return { ...job, paused, updatedAt: new Date().toISOString() }; }

export function advanceBatch(job: BatchJob, taskId: string, key: BatchStepKey, analysisId: string, blockedReason?: string) {
  if (!batchSteps.includes(key)) throw new BatchError("未知批处理步骤");
  const itemIndex = job.items.findIndex((item) => item.taskId === taskId);
  if (itemIndex < 0) throw new BatchError("任务不属于当前批次", 404);
  const oldItem = job.items[itemIndex], stepIndex = oldItem.steps.findIndex((step) => step.key === key);
  if (stepIndex < 0) throw new BatchError("当前批次未配置此步骤");
  if (oldItem.steps[stepIndex].state === "completed") return { job, replayed: true, analysis: null };
  if (job.paused) throw new BatchError("批次已暂停，请先继续批次", 409);
  if (oldItem.steps.slice(0, stepIndex).some((step) => step.state !== "completed")) throw new BatchError("请先完成该任务的前置步骤", 409);
  const next = copy(job), item = next.items[itemIndex], step = item.steps[stepIndex];
  step.attempts++; next.updatedAt = new Date().toISOString();
  try {
    if (blockedReason) throw Error(blockedReason);
    const input = item.input, rate = input.sampleRate, samples: number[] = input.samples;
    if (!Number.isFinite(rate) || rate <= 0 || !Array.isArray(samples) || !samples.length || samples.length > 20000 || samples.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw Error("该批次输入快照没有有效波形，请先保存/导入波形，再新建批次");
    const c = next.config;
    let start = 0, end = samples.length;
    if (c.cut.enabled && key !== "denoise") {
      start = Math.ceil(c.cut.start * rate);
      end = c.cut.end === null ? samples.length : Math.ceil(c.cut.end * rate);
      if (start >= samples.length || end > samples.length || end <= start) throw Error("截取范围超出该任务已保存波形，或没有包含采样点；请调整配置后新建批次");
    }
    if (key === "denoise" && ["低通", "高通", "带通", "带阻"].includes(c.denoise.method) && c.denoise.high >= rate / 2) throw Error("降噪截止频率必须小于该任务采样率的一半；请调整配置后新建批次");
    const inputSamples = samples.slice(start, end);
    const unit = input.channels?.[0]?.unit || "原始单位";
    let columns: string[], rows: (string | number)[][], note: string;
    if (key === "denoise" || key === "cut") {
      columns = ["时间(s)", `幅值(${unit})`]; rows = inputSamples.map((value, i) => [(start + i) / rate, value]);
      note = key === "denoise" ? "降噪接口未接入：此占位预览保留输入幅值，未执行真实降噪。" : "按 [起点,终点) 采样索引截取，保留绝对时间和原始幅值。" + (c.denoise.enabled ? "前置降噪仅为占位预览。" : "");
    } else if (key === "fft") {
      columns = ["频率(Hz)", "示例幅值"];
      const fixture = [0.01, 0.12, 0.9, 0.28, 0.07, 0.05, 0.03, 0.01];
      rows = fixture.map((value, i) => [i * rate / c.fft.nfft, value]);
      note = "FFT 接口未接入：固定演示幅值，不是所选波形的频谱；频率刻度按采样率/FFT 点数展示。";
    } else {
      const fixture: Record<string, number> = { RMS: 1.21, "峰值": 3.4, "峰峰值": 6.7, "峭度": 3.1, "均值": 0.02 };
      columns = ["特征", "示例值"];
      rows = c.features.names.map((name) => [name, fixture[name]]);
      note = "特征接口未接入：固定原型演示值，不是所选波形的计算结果。";
    }
    const { samples: _, ...inputMetadata } = input;
    const analysis = { id: analysisId, name: `${next.name} · ${item.name} · ${batchStepNames[key]}`.slice(0, 190), taskId, type: ({ denoise: "filter", cut: "time", fft: "fft", features: "feat" } as const)[key], source: "demo",
      parameters: { batchId: next.id, step: key, settings: copy(c[key]), inputMetadata, inputSampleCount: samples.length, sourceRange: { startIndex: start, endExclusive: end }, pipeline: copy(c) },
      result: { demo: true, note, columns, rows, inputCount: inputSamples.length }, updatedAt: next.updatedAt };
    step.state = "completed"; step.analysisId = analysisId; step.finishedAt = next.updatedAt; delete step.error;
    return { job: next, replayed: false, analysis };
  } catch (error) {
    step.state = "failed"; step.error = (error as Error).message; step.finishedAt = next.updatedAt;
    return { job: next, replayed: false, analysis: null };
  }
}
