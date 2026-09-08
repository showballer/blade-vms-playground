import { taskMetadata } from "./task-metadata";
import { validateDataset, type ResultDataset, type ResultColumn } from "./result-data";

export const signalFeatures = [
  { name: "RMS", value: 1.21, unit: "mm/s" }, { name: "峰值", value: 3.4, unit: "mm/s" },
  { name: "峰峰值", value: 6.7, unit: "mm/s" }, { name: "峭度", value: 3.1, unit: "无量纲" },
  { name: "均值", value: 0.02, unit: "mm/s" }, { name: "主频", value: 0.6, unit: "Hz" },
  { name: "谱能量", value: 842, unit: "原型未注明" }, { name: "信噪比", value: 28, unit: "dB" },
];
const titles: Record<string, string> = { time: "时域波形", fft: "FFT频谱", tf: "时频分析", filter: "滤波降噪", env: "包络谱", band: "频带能量", avg: "平均波形", feat: "特征值" };

/** Serialize the exact displayed series, not a substitute common waveform. */
export function signalDataset(tab: string, option: Record<string, any>, task: Record<string, any> | undefined, channel: string, parameters: Record<string, any>): ResultDataset {
  if (!titles[tab]) throw Error("未知的信号标签");
  const col = (key: string, label: string, unit = "", type: "number" | "string" = "number"): ResultColumn => ({ key, label, unit, type });
  let columns: ResultColumn[], rows: (string | number)[][];
  const savedWave = tab === "time" && !!task?.samples?.length;
  const selectedUnit = channel === "速度" ? "mm/s" : channel === "位移" ? "mm" : "m/s²";
  if (tab === "feat") {
    columns = [col("feature", "特征", "", "string"), col("value", "示例值"), col("unit", "单位", "", "string")];
    rows = signalFeatures.map((feature) => [feature.name, feature.value, feature.unit]);
  } else if (tab === "tf") {
    columns = [col("time", "时间", "s"), col("frequency", "频率", "Hz"), col("intensity", "演示强度", "归一化")];
    rows = option.series[0].data.map(([x, y, value]: number[]) => [Number(option.xAxis.data[x]), Number(option.yAxis.data[y]), value]);
  } else if (tab === "band") {
    columns = [col("band", "频带", "", "string"), col("energy", "能量占比", "%")];
    rows = option.series[0].data.map((cell: { value: number }, i: number) => [String(option.xAxis.data[i]).replaceAll("\n", " "), cell.value]);
  } else {
    const frequency = tab === "fft" || tab === "env";
    columns = [col(frequency ? "frequency" : "time", frequency ? "频率" : "时间", frequency ? "Hz" : "s"), ...option.series.map((series: { name?: string }, i: number) =>
      col("series_" + (i + 1), series.name || titles[tab], savedWave ? task?.channels?.[0]?.unit || "原始单位未注明" : tab === "env" ? "原型相对幅值" : tab === "time" ? selectedUnit : "mm/s"))];
    rows = option.series[0].data.map((_: unknown, i: number) => [savedWave ? i / task!.sampleRate : Number(option.xAxis.data[i]), ...option.series.map((series: { data: any[] }) => typeof series.data[i] === "number" ? series.data[i] : series.data[i].value)]);
  }
  return validateDataset({ schema: "blade-vms/dataset-v1", title: `${titles[tab]} · ${task?.name || "演示预览"}`, columns, rows,
    metadata: { type: tab, source: savedWave ? task!.source || "unknown" : "demo", demo: savedWave ? task!.source === "demo" : true,
      note: savedWave ? "所选任务已保存的单列波形，保留原始幅值及时间；通道选择不执行物理量转换。" : "当前标签显示的固定原型演示数据，未根据所选任务或配置执行算法，不用于工程判断。",
      axisSource: savedWave ? "time = saved sample index / task sampleRate" : "prototype display axes; not inferred from the selected task sampleRate or FFT configuration",
      task: task ? taskMetadata(task) : null, parameters: structuredClone(parameters), selectedChannel: channel, snapshotAt: new Date().toISOString() } });
}
