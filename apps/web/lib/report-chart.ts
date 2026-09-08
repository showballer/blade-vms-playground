import * as echarts from "echarts";
import sharp from "sharp";

export async function reportFigurePng(option: Record<string, any>): Promise<Buffer> {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 1000, height: 340 });
  try {
    chart.setOption({ ...option, animation:false, backgroundColor:"#FFFFFF", textStyle:{fontFamily:"Microsoft YaHei, PingFang SC, Arial, sans-serif",fontSize:16},
      tooltip:{show:false},dataZoom:[],legend:{...option.legend,type:"plain",textStyle:{fontSize:22}},
      xAxis:{...option.xAxis,axisLabel:{fontSize:22},nameTextStyle:{fontSize:22}},yAxis:{...option.yAxis,axisLabel:{fontSize:22},nameTextStyle:{fontSize:22}} });
    return await sharp(Buffer.from(chart.renderToSVGString())).png().toBuffer();
  } finally { chart.dispose(); }
}

/** Render saved waveform samples only; no FFT/filtering/acquisition is performed.
 * ECharts server rendering: https://echarts.apache.org/handbook/en/how-to/cross-platform/server/
 */
export async function reportWaveformPng(task: Record<string, any>): Promise<Buffer | null> {
  if (!Array.isArray(task.samples) || !task.samples.length) return null;
  const rate = Number(task.sampleRate);
  if (!Number.isFinite(rate) || rate <= 0 || task.samples.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v)))
    throw Error("报告波形或采样率无效");
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 1000, height: 300 });
  try {
    chart.setOption({
      animation: false,
      backgroundColor: "#FFFFFF",
      grid: { left: 65, right: 45, top: 25, bottom: 45 },
      xAxis: { type: "value", name: "s", nameLocation: "end", axisLabel: { color: "#5A6677", fontSize: 14 }, splitLine: { show: false } },
      yAxis: { type: "value", scale: true, axisLabel: { color: "#5A6677", fontSize: 14 }, splitLine: { lineStyle: { color: "#E4E8EE" } } },
      series: [{ type: "line", showSymbol: task.samples.length < 20, symbolSize: 5, lineStyle: { color: "#2D6CC0", width: 2 }, itemStyle: { color: "#2D6CC0" }, data: task.samples.map((value: number, i: number) => [i / rate, value]) }],
    });
    return await sharp(Buffer.from(chart.renderToSVGString())).png().toBuffer();
  } finally { chart.dispose(); }
}
