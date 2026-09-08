/** Business presentation rules only; no acquisition or diagnostic algorithm. */
export const optionalHealthLimits = ["peak", "peakToPeak", "mainAmplitude"] as const;
export type HealthThresholds = { rms: number; frequency: number; band: number; attentionRatio: number; warningRatio: number } & Partial<Record<typeof optionalHealthLimits[number], number>>;
export type HealthConfig = { id: string | null; tenant: string; revision: string; status: "missing" | "legacy" | "configured" | "invalid"; values: HealthThresholds | null };
export const defaultThresholds: HealthThresholds = { rms: 2, frequency: 5, band: .6, attentionRatio: .6, warningRatio: .8 };
export function validateThresholds(input: Record<string, unknown>): HealthThresholds {
  for (const key of ["rms", "frequency", "band"] as const)
    if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] <= 0) throw Error("阈值必须为有限正数");
  const { attentionRatio, warningRatio } = input;
  if (typeof attentionRatio !== "number" || typeof warningRatio !== "number" || !Number.isFinite(attentionRatio) || !Number.isFinite(warningRatio) || !(0 < attentionRatio && attentionRatio < warningRatio && warningRatio < 1))
    throw Error("分级比例应满足 0 < 注意 < 预警 < 1（报警）");
  const optional: Partial<Record<typeof optionalHealthLimits[number], number>> = {};
  for (const key of optionalHealthLimits) {
    if (input[key] === undefined || input[key] === null) continue;
    if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] <= 0) throw Error("峰值、峰峰值和主频幅值阈值须为有限正数，留空表示未配置");
    optional[key] = input[key];
  }
  return { rms: input.rms as number, frequency: input.frequency as number, band: input.band as number, attentionRatio, warningRatio, ...optional };
}
export function thresholdValues(input: Record<string, unknown>): HealthThresholds {
  // Old configurations have no attention ratio. Surface this as legacy, never
  // replace the entire group's configuration with a silent default.
  return validateThresholds({ ...input, attentionRatio: input.attentionRatio ?? Number((Number(input.warningRatio) * .75).toFixed(12)) });
}
export const healthLevels = ["正常", "注意", "预警", "报警"] as const;
export function healthGrade(value: number, limit: number, settings: HealthThresholds) {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) return null;
  const ratio = Math.abs(value) / limit + Number.EPSILON * 4;
  return ratio >= 1 ? 3 : ratio >= settings.warningRatio ? 2 : ratio >= settings.attentionRatio ? 1 : 0;
}
/** Explicit prototype samples, not measurements computed from the selected task. */
export function healthDemoMetrics(baseline: Record<string, any>, settings?: HealthThresholds | null) {
  const other = baseline.object !== "风机叶片A";
  const values = [
    { key: "rms", name: "RMS", unit: "mm/s", value: Number((baseline.rms * (other ? 1.05 : 1.28)).toFixed(2)) },
    { key: "frequency", name: "主频偏移", unit: "%", value: other ? -.4 : -4.2 },
    { key: "band", name: "频带能量", unit: "a.u.", value: other ? .3 : .62 },
    { key: "peak", name: "峰值", unit: "mm/s", value: other ? 1.8 : 3.4 },
    { key: "peakToPeak", name: "峰峰值", unit: "mm/s", value: other ? 3.5 : 6.6 },
    { key: "mainAmplitude", name: "主频幅值", unit: "mm/s", value: other ? .48 : .83 },
  ] as const;
  return values.map(m => ({ ...m, limit: settings?.[m.key], grade: settings ? healthGrade(m.value, settings[m.key]!, settings) : null }));
}
export function healthMetricSummary(metrics: { grade: number | null }[]) {
  const graded = metrics.flatMap(m => m.grade === null ? [] : [m.grade]);
  const grade = graded.length ? Math.max(...graded) : null;
  const complete = graded.length === metrics.length;
  return { grade, configured: graded.length, total: metrics.length, complete,
    label: grade === null ? "未判定" : grade === 0 && !complete ? "未完整判定" : healthLevels[grade] };
}
export function healthDemoDamage(baseline: Record<string, any>) {
  const other = baseline.object !== "风机叶片A";
  return { score: baseline.score, confidence: baseline.confidence, label: other ? "无明显异常（演示）" : "叶尖裂纹（疑似）",
    severity: other ? "无" : "中", location: other ? "未发现定位异常（演示）" : "P2 叶中（原型样例）",
    criterion: other ? "原型正常态样例，未执行模型推理" : "幅值 ↑ + 主频 ↓ + 模态偏移（原型样例）",
    conclusion: other ? "演示样例未见明显异常；不代表所选任务或实际叶片的安全状态。" : "演示样例频率下降伴幅值上升，建议现场巡检复核；不代表对所选任务的真实诊断。",
    source: "demo", note: "未调用采集或 Python 算法，结论与定位仅为原型样例。" };
}
export type ReviewActor = { id: string; name: string };
export function applyAlertReview(previous: Record<string, any> | null, next: Record<string, any>, actor: ReviewActor, time: string) {
  const result = { ...next };
  for (const key of ["reviewer", "reviewerId", "reviewedAt", "reviewHistory"]) delete result[key];
  for (const key of ["reviewer", "reviewerId", "reviewedAt", "reviewHistory"])
    if (previous?.[key] !== undefined) result[key] = previous[key];
  const changed = previous ? (next.status !== previous.status || (next.reviewNote || "") !== (previous.reviewNote || "")) : (next.status !== "待复核" || !!next.reviewNote);
  if (!changed) return result;
  if (typeof next.reviewNote !== "string" || !next.reviewNote.trim() || next.reviewNote.length > 2000) throw Error("复核意见不能为空且不能超过 2000 字");
  if (!["待复核", "已确认", "已关闭"].includes(next.status)) throw Error("告警状态无效");
  const entry = { status: next.status, note: next.reviewNote.trim(), actorId: actor.id, actor: actor.name, time };
  result.reviewNote = entry.note; result.reviewer = actor.name; result.reviewerId = actor.id; result.reviewedAt = time;
  result.reviewHistory = [...(Array.isArray(previous?.reviewHistory) ? previous.reviewHistory : []), entry];
  return result;
}
