import { stableJson } from "./sync-data";
export const baselineFields = ["name", "object", "rms", "frequency", "modal", "score", "confidence", "source", "status", "note"] as const;
export function baselineRecordCanonical(value: Record<string, any>) {
  return stableJson(Object.fromEntries([...baselineFields, "version"].filter(key => value[key] !== undefined).map(key => [key, value[key]])));
}
/** Manual business registration, not a baseline-estimation algorithm. Missing values stay missing. */
export function baselineValues(input: Record<string, any>, previous?: Record<string, any>) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("请填写有效基线记录");
  const value: Record<string, any> = {};
  for (const key of baselineFields) {
    const v = Object.hasOwn(input, key) ? input[key] : previous?.[key];
    if (v !== undefined && v !== null) value[key] = v;
  }
  for (const key of ["name", "object"]) {
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 200) throw Error("基线名称和测试对象不能为空且不能超过 200 字");
    value[key] = value[key].trim();
  }
  for (const key of ["rms", "frequency", "modal"]) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0)) throw Error("已填写的 RMS、主频和一阶模态频率须为有限正数；未登记的项请留空");
  for (const [key, max] of [["score", 100], ["confidence", 1]] as const) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > max)) throw Error("演示健康度须为 0～100，演示置信度须为 0～1；未登记的项请留空");
  if (!previous) { value.source ??= "manual"; value.status ??= "active"; }
  if (value.source !== undefined && !["manual", "demo"].includes(value.source)) throw Error("基线来源须为手工登记或演示样例");
  if (value.status !== undefined && !["active", "disabled"].includes(value.status)) throw Error("基线状态须为启用或停用");
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 2000)) throw Error("基线说明不能超过 2000 字");
  if (value.note !== undefined) value.note = value.note.trim();
  return value;
}
export function baselineHealthIssue(b?: Record<string, any>) {
  if (!b) return "未选择基线";
  if (b.status === "disabled") return "基线已停用";
  if (![b.rms, b.frequency, b.modal].every(v => Number.isFinite(v) && v > 0)) return "健康监测缺少有效的 RMS、主频或一阶模态频率";
  if (!Number.isFinite(b.score) || b.score < 0 || b.score > 100 || !Number.isFinite(b.confidence) || b.confidence < 0 || b.confidence > 1) return "健康面板缺少有效的演示健康度或置信度";
  return "";
}
export function baselineModalUsable(b: Record<string, any>) { return b.status !== "disabled" && Number.isFinite(b.modal) && b.modal > 0; }
