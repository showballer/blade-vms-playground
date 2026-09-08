export const reportSections = [
  "对象信息",
  "采集参数",
  "原始波形",
  "降噪与截取",
  "FFT 频谱",
  "包络与时频",
  "模态参数",
  "损伤识别",
  "健康趋势与标记",
  "结论与建议",
];
type Row = Record<string, any>;
export type ReportSection = {
  title: string;
  text: string;
  headers?: string[];
  rows?: string[][];
};
const value = (v: unknown) =>
  v == null || v === ""
    ? "未填写"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);

/** The same section content feeds the on-screen report and Word export. */
export function reportContent(
  report: Row,
  task: Row | undefined,
  analyses: Row[] = [],
): ReportSection[] {
  const selected = Array.isArray(report.sections) ? report.sections : [];
  const t = task || {};
  const related = analyses.filter((a) => a.taskId === report.taskId);
  const table = (title: string, pairs: [string, unknown][]): ReportSection => ({
    title,
    text: "",
    headers: ["项目", "内容"],
    rows: pairs.map(([k, v]) => [k, value(v)]),
  });
  const analysisTypes: Record<string, string[]> = {
    降噪与截取: ["filter", "order", "avg", "cut"],
    "FFT 频谱": ["fft"],
    包络与时频: ["env", "tf", "band"],
    模态参数: ["modal"],
    损伤识别: ["damage"],
    健康趋势与标记: ["health-trend"],
  };
  return selected.map((title: string) => {
    if (title === "对象信息")
      return table(title, [
        ["任务名称", t.name],
        ["测试对象", t.object],
        ["风机编号", t.turbine],
        ["测点 / 方向", [t.point, t.direction].filter(Boolean).join(" / ")],
        ["工况备注", t.note],
        ["任务引用", report.taskId],
      ]);
    if (title === "采集参数")
      return table(title, [
        ["采样率 Hz", t.sampleRate],
        ["量程 ±mm/s", t.range],
        ["转速 rpm", t.rpm],
        ["叶片数", t.blades],
        ["任务时长 s", t.duration],
        [
          "数据来源",
          t.source === "demo"
            ? "演示数据，非实际测量"
            : t.source === "import"
              ? "用户导入，未经过算法校验"
              : "尚未接入采集设备",
        ],
      ]);
    if (title === "原始波形") {
      const samples = Array.isArray(t.samples) ? t.samples : [];
      return {
        title,
        text: samples.length
          ? `已保存 ${samples.length} 个采样点；按任务采样率 ${t.sampleRate} Hz 编排时间轴。数据来源：${t.source === "demo" ? "演示快照，非实际测量" : "用户导入"}。`
          : "本任务尚未保存原始采样点。请在桌面端导入波形或保存演示快照后重新生成报告；本报告不会虚构采样数据。",
        ...(samples.length
          ? {
              headers: ["采样序号", "时间 s", "幅值（任务通道单位）"],
              rows: samples
                .slice(0, 8)
                .map((s: number, i: number) => [
                  String(i),
                  (i / t.sampleRate).toFixed(6),
                  String(s),
                ]),
            }
          : {}),
      };
    }
    if (title === "结论与建议")
      return { title, text: report.conclusion || "尚未填写结论。" };
    const records = related.filter((a) =>
      (analysisTypes[title] || []).includes(a.type) || (title === "降噪与截取" && a.parameters?.step === "cut"),
    );
    return {
      title,
      text: records.length
        ? "以下为该任务已保存的配置与演示结果；未调用 Python 算法，不能作为真实检测结论。"
        : "该任务暂无此类已保存分析记录。Python 算法暂未接入，未生成检测结果。",
      ...(records.length
        ? {
            headers: ["分析记录", "参数", "结果 / 来源"],
            rows: records.map((a) => {
              const isBatch = a.parameters?.batchId && Array.isArray(a.result?.rows);
              const isRotation = a.parameters?.workflow === "rotation-segments-v1";
              const parameters = isRotation ? { config: a.parameters.config, sourceRevision: a.parameters.sourceRevision, segments: a.parameters.segments?.length, keptSamples: a.result?.dataset?.metadata?.keptSamples, excludedSamples: a.result?.dataset?.metadata?.excludedSamples, note: "逐段标注及排除索引见数值导出元信息" } : isBatch ? { batchId: a.parameters.batchId, step: a.parameters.step, settings: a.parameters.settings, inputSampleCount: a.parameters.inputSampleCount, sourceRange: a.parameters.sourceRange } : a.parameters;
              const dataset = a.result?.dataset;
              if (a.type === "health-trend" && dataset) return [a.name, `展示起日：${a.parameters.startDate}；基线：${dataset.metadata.baseline?.name || "—"}；归档时间：${dataset.metadata.snapshotAt}`, `固定 ${dataset.rows.length} 日演示趋势；原始波形快照 ${a.result.datasets?.waveform?.rows.length || 0} 点。人工标记 ${(a.result.annotations || []).filter((m: Row) => m.status === "active").length} 条有效、${(a.result.annotations || []).filter((m: Row) => m.status === "withdrawn").length} 条已撤回。标记不改变数值，不代表自动异常判定。完整趋势、波形、标记与历史说明见分析 ${a.id} 的记录 JSON / 数值导出。`];
              const modalSummary = a.parameters?.workflow === "modal-preview-v1" && dataset ? dataset.rows.map((row: (string | number)[]) => `第 ${row[0]} 阶 ${row[1]} Hz / 阻尼比 ${row[2]}% / ${row[3]}`).join("；") + "。另含所选测点频率曲线、各阶振型节点和基准频率对比子结果。" : "";
              const result = isBatch || dataset ? `${a.result.note || dataset?.metadata?.note || ""} ${modalSummary} 结果 ${(dataset?.rows || a.result.rows).length} 行，字段：${(dataset?.columns?.map((column: { label: string }) => column.label) || a.result.columns || []).join(" / ")}。完整数据见分析记录 ${a.id} 的数值导出。` : value(a.result);
              return [a.name, value(parameters), result + " / " + value(a.source)];
            }),
          }
        : {}),
    };
  });
}
