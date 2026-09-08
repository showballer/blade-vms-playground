import { taskMetadata } from "./task-metadata";
import { stableJson } from "./sync-data";
import type { ResultColumn, ResultDataset } from "./result-data";

export const modalWorkflow = "modal-preview-v1";
export const modalMethods: Record<string, string[]> = { free: ["峰值拾取", "LSCF / PolyMAX", "ERA"], oma: ["SSI", "FDD"] };
export const dampingMethods = ["半功率带宽", "曲线拟合", "时域衰减"];
export const modalPoints = [{ id: "P1", name: "P1 叶根", position: 0 }, { id: "P2", name: "P2 叶中", position: .5 }, { id: "P3", name: "P3 叶尖", position: 1 }];
export const modalOrders = [{ order: 1, frequency: .6, damping: 1.2, name: "一阶弯曲" }, { order: 2, frequency: 1.8, damping: 1.8, name: "二阶弯曲" }, { order: 3, frequency: 3.5, damping: 2.1, name: "三阶弯曲" }];
export type ModalConfig = { test: "free" | "oma"; method: string; damping: string; points: string[]; activeOrder: number; baselineId: string };
export const modalDatasetNames: Record<string, string> = { parameters: "模态参数", points: "多测点频率曲线", shape: "各阶振型节点", baseline: "基准频率对比" };
export function modalConfig(input: Record<string, any>): ModalConfig {
  if (!input || !["free", "oma"].includes(input.test) || !modalMethods[input.test].includes(input.method)) throw Error("测试类型与模态方法不匹配");
  if (!dampingMethods.includes(input.damping)) throw Error("请选择有效的阻尼法");
  if (!Array.isArray(input.points) || !input.points.length || input.points.length > 3 || new Set(input.points).size !== input.points.length || input.points.some((p: unknown) => !modalPoints.some(point => point.id === p))) throw Error("请选择至少一个有效且不重复的演示测点");
  if (!Number.isInteger(input.activeOrder) || input.activeOrder < 1 || input.activeOrder > 3) throw Error("请选择第 1～3 阶振型");
  if (typeof input.baselineId !== "string" || !input.baselineId || input.baselineId.length > 64) throw Error("请选择正常态基准");
  return { test: input.test, method: input.method, damping: input.damping, points: modalPoints.filter(p => input.points.includes(p.id)).map(p => p.id), activeOrder: input.activeOrder, baselineId: input.baselineId };
}
export function modalBaselineCanonical(baseline?: Record<string, any>) {
  return stableJson(baseline ? Object.fromEntries(["id", "name", "object", "modal", "source", "status", "note", "version"].filter(key => baseline[key] !== undefined).map(key => [key, baseline[key]])) : { id: "prototype", frequencies: [.61, 1.82, 3.55] });
}
export async function modalBaselineRevision(baseline?: Record<string, any>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(modalBaselineCanonical(baseline))))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Fixed prototype results only. Task data are provenance, never an input to a hidden algorithm. */
export function modalResult(task: Record<string, any>, input: Record<string, any>, baseline?: Record<string, any>, time = new Date().toISOString()) {
  if (!task?.id) throw Error("请选择有效数据任务");
  const config = modalConfig(input);
  if (config.baselineId !== "prototype" && (!baseline || baseline.status === "disabled" || baseline.id !== config.baselineId || baseline.object !== task.object || baseline.recordTenant !== task.recordTenant || !Number.isFinite(baseline.modal) || baseline.modal <= 0)) throw Error("正常态基准须启用、属于相同对象与课题组，并保存有效的一阶模态频率");
  const baselineSnapshot = config.baselineId === "prototype" ? { id: "prototype", name: "原型正常态样例", frequencies: [.61, 1.82, 3.55], demo: true } : { id: baseline!.id, name: baseline!.name, object: baseline!.object, frequencies: [baseline!.modal], demo: baseline!.source === "demo", source: baseline!.source || "legacy-unverified", version: baseline!.version || null, registrationNote: baseline!.note || "", note: "存储的基准频率，不代表已执行识别；现有基线仅记录一阶频率" };
  const note = "固有频率、阻尼、测点曲线和振型节点均为固定原型样例，未根据所选任务、方法或阻尼法执行计算。P1/P2/P3 为演示位置，不代表该任务具有三通道同步数据；不用于工程判断。";
  const metadata = { type: "modal", workflow: modalWorkflow, source: "demo", demo: true, task: structuredClone(taskMetadata(task)), parameters: structuredClone(config), baseline: baselineSnapshot, note, snapshotAt: time };
  const col = (key: string, label: string, unit = "", type: "number" | "string" = "number"): ResultColumn => ({ key, label, unit, type });
  const dataset = (key: string, columns: ResultColumn[], rows: (string | number)[][]): ResultDataset => ({ schema: "blade-vms/dataset-v1", title: modalDatasetNames[key] + " · " + task.name, columns, rows, metadata: { ...structuredClone(metadata), datasetKey: key } });
  const points = modalPoints.filter(p => config.points.includes(p.id));
  const curves = [[.4, .7, .6, .9, .8], [.36, .58, .49, .72, .64], [.3, .48, .4, .58, .51]];
  const shapes = [[.15, .55, 1], [.2, -.8, .65], [.3, .6, -.9]];
  const comparisons = baselineSnapshot.frequencies.map((f, i) => {
    // A bounded decimal avoids JSON database double reserialization changing the final digit.
    const delta = Number(((modalOrders[i].frequency - f) / f * 100).toFixed(8));
    if (!Number.isFinite(delta)) throw Error("基准频率与演示频率比值超出可比较范围");
    return [i + 1, f, modalOrders[i].frequency, delta];
  });
  const datasets = {
    parameters: dataset("parameters", [col("order", "阶次"), col("frequency", "固有频率（演示）", "Hz"), col("damping", "阻尼比（演示）", "%"), col("shape", "振型说明", "", "string")], modalOrders.map(m => [m.order, m.frequency, m.damping, m.name])),
    points: dataset("points", [col("frequency", "频率", "Hz"), ...points.map(p => col(p.id, p.name, "原型相对幅值"))], [.2, .4, .6, .8, 1].map((f, i) => [f, ...points.map(p => curves[modalPoints.indexOf(p)][i])])),
    shape: dataset("shape", [col("order", "阶次"), col("point", "演示测点", "", "string"), col("position", "归一化位置", "0～1"), col("relative", "振型节点（演示）", "相对值"), col("reference", "未变形参考", "相对值")], modalOrders.flatMap(m => points.map(p => [m.order, p.name, p.position, shapes[m.order - 1][modalPoints.indexOf(p)], 0]))),
    baseline: dataset("baseline", [col("order", "阶次"), col("baseline", "基准频率", "Hz"), col("current", "当前频率（演示）", "Hz"), col("delta", "相对频率变化", "%")], comparisons),
  };
  return { config, datasets, dataset: datasets.parameters, note };
}
export function modalRecord(task: Record<string, any>, request: Record<string, any>, baseline?: Record<string, any>): Record<string, any> {
  const p = request.parameters;
  if (p?.workflow !== modalWorkflow || ![p.sourceRevision, p.baselineRevision].every(v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) throw Error("模态演示记录需要当前任务、基准修订与有效参数");
  const result = modalResult(task, p.config, baseline);
  return { ...request, taskId: task.id, type: "modal", source: "demo", parameters: { workflow: modalWorkflow, config: result.config, sourceRevision: p.sourceRevision, baselineRevision: p.baselineRevision }, result: { dataset: result.dataset, datasets: result.datasets, note: result.note } };
}
