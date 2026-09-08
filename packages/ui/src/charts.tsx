"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart, BarChart, HeatmapChart, GaugeChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  VisualMapComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
} from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";
echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  VisualMapComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  CanvasRenderer,
  SVGRenderer,
]);
export function Chart({
  option,
  height = 260,
  label = "数据图表",
  renderer = "canvas",
}: {
  option: Record<string, any>;
  height?: number;
  label?: string;
  renderer?: "canvas" | "svg";
}) {
  const ref = useRef<HTMLDivElement>(null),
    chart = useRef<echarts.EChartsType | undefined>(undefined);
  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer });
    chart.current = c;
    const observer = new ResizeObserver(() => {
      c.resize();
      if (renderer === "svg") ref.current?.querySelector("svg")?.setAttribute("viewBox", `0 0 ${c.getWidth()} ${c.getHeight()}`);
    });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      c.dispose();
      chart.current = undefined;
    };
  }, [renderer]);
  useEffect(() => {
    chart.current?.setOption(option, true);
    if (renderer === "svg" && chart.current) ref.current?.querySelector("svg")?.setAttribute("viewBox", `0 0 ${chart.current.getWidth()} ${chart.current.getHeight()}`);
  }, [option, renderer]);
  return (
    <div
      role="img"
      aria-label={label}
      ref={ref}
      style={{ height, width: "100%" }}
    />
  );
}
const palette = ["#2D6CC0", "#1FA971", "#F5A623", "#7A4DD4", "#E5484D"];
export function waveSamples(phase = 0, n = 400, kind = 0) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return +(
      kind === 0
        ? Math.sin(Math.PI * 6 * t + phase) * 0.78 +
          0.16 * Math.sin(Math.PI * 18 * t + phase * 1.7)
        : kind === 1
          ? Math.sin(Math.PI * 2.4 * t + phase * 0.6) * 0.82
          : Math.sin(Math.PI * 14 * t + phase) * 0.5 +
            0.38 * Math.sin(Math.PI * 30 * t + phase * 1.3)
    ).toFixed(5);
  });
}
export function lineOption(
  series: { name: string; data: number[]; color?: string }[],
  labels?: string[],
  zoom = false,
) {
  return {
    animation: false,
    color: palette,
    tooltip: { trigger: "axis" },
    legend: {
      top: 0,
      right: 8,
      icon: "roundRect",
      itemWidth: 15,
      itemHeight: 3,
      textStyle: { fontSize: 11, color: "#67758a" },
    },
    grid: { left: 48, right: 20, top: 40, bottom: zoom ? 55 : 32 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: labels || series[0]?.data.map((_, i) => (i / 100).toFixed(2)),
      axisLabel: { color: "#8A95A5", fontSize: 10 },
      axisLine: { lineStyle: { color: "#DDE4ED" } },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#8A95A5", fontSize: 10 },
      splitLine: { lineStyle: { color: "#EEF1F5" } },
    },
    dataZoom: zoom
      ? [{ type: "inside" }, { type: "slider", height: 15, bottom: 4 }]
      : [],
    series: series.map((s) => ({
      name: s.name,
      type: "line",
      data: s.data,
      showSymbol: false,
      lineStyle: { width: 1.8, color: s.color },
      itemStyle: { color: s.color },
    })),
  };
}
export function stackedWave(
  phase = 0,
  channels = ["速度", "位移", "加速度"],
  samples?: number[],
  sampleRate = 100,
) {
  const names = ["速度", "位移", "加速度"];
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 100;
  return {
    animation: false,
    color: palette,
    tooltip: { trigger: "axis" },
    grid: channels.map((_, i) => ({
      left: 48,
      right: 18,
      top: 8 + i * (84 / channels.length) + "%",
      height: 70 / channels.length + "%",
    })),
    xAxis: channels.map((_, i) => ({
      type: "category",
      gridIndex: i,
      data: Array.from({ length: samples?.length || 400 }, (_, j) =>
        (j / rate).toFixed(rate >= 1000 ? 6 : 2),
      ),
      show: i === channels.length - 1,
      axisLabel: { fontSize: 10, color: "#8A95A5" },
      axisLine: { lineStyle: { color: "#E4E8EE" } },
    })),
    yAxis: channels.map((n, i) => ({
      type: "value",
      gridIndex: i,
      name: n,
      nameLocation: "middle",
      nameRotate: 0,
      nameGap: 7,
      nameTextStyle: { color: "#8A95A5", fontSize: 10, align: "right", verticalAlign: "middle" },
      min: -1.5,
      max: 1.5,
      axisLabel: { show: false },
      splitLine: { lineStyle: { color: "#EEF1F5" } },
    })),
    series: channels.map((name, i) => ({
      name,
      type: "line",
      xAxisIndex: i,
      yAxisIndex: i,
      data: samples || waveSamples(phase, 400, names.indexOf(name)),
      showSymbol: false,
      lineStyle: { width: 1.8, color: palette[names.indexOf(name)] },
    })),
  };
}
export function spectrumOption(order = false) {
  const n = order ? 4 : 100;
  return {
    animation: false,
    grid: { left: 45, right: 22, top: 30, bottom: 35 },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: Array.from({ length: n }, (_, i) =>
        order ? ["1×", "fb", "2×", "3×"][i] : (i * 0.05).toFixed(2),
      ),
      axisLabel: { fontSize: 10, color: "#8A95A5" },
      axisLine: { lineStyle: { color: "#DDE4ED" } },
    },
    yAxis: {
      type: "value",
      name: order ? "幅值" : "mm/s",
      splitLine: { lineStyle: { color: "#EEF1F5" } },
      axisLabel: { fontSize: 10, color: "#8A95A5" },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: order ? 28 : 6,
        data: Array.from({ length: n }, (_, i) => {
          const peaks = order ? [0, 1, 2, 3] : [12, 25, 48, 72],
            at = peaks.indexOf(i);
          return {
            value:
              at >= 0
                ? [1.8, 1.25, 0.8, 0.5][at]
                : 0.02 + Math.abs(Math.sin(i * 1.7)) * 0.09,
            itemStyle: {
              color:
                at >= 0
                  ? ["#E5484D", "#7A4DD4", "#F5A623", "#F5A623"][at]
                  : "#A6BAD2",
            },
            label:
              at >= 0
                ? {
                    show: true,
                    position: "top",
                    color: ["#E5484D", "#7A4DD4", "#F5A623", "#F5A623"][at],
                    fontSize: 10,
                    formatter: order
                      ? ["1×", "fb", "2×", "3×"][at]
                      : [
                          "主频 0.60 Hz",
                          "参考峰 1.25 Hz",
                          "参考峰 2.40 Hz",
                          "参考峰 3.60 Hz",
                        ][at],
                  }
                : { show: false },
          };
        }),
      },
    ],
  };
}
export function heatOption() {
  return {
    animation: false,
    grid: { left: 45, right: 30, top: 20, bottom: 55 },
    tooltip: { position: "top" },
    xAxis: {
      type: "category",
      data: Array.from({ length: 40 }, (_, i) => (i * 0.1).toFixed(1)),
      splitArea: { show: true },
      axisLabel: { color: "#8A95A5", fontSize: 10 },
    },
    yAxis: {
      type: "category",
      data: Array.from({ length: 16 }, (_, i) => i * 50),
      axisLabel: { color: "#8A95A5", fontSize: 10 },
    },
    visualMap: {
      min: 0,
      max: 1,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemHeight: 150,
      inRange: { color: ["#f6f8fb", "#453781", "#2a788e", "#7ad151", "#fde725"] },
    },
    series: [
      {
        type: "heatmap",
        data: Array.from({ length: 640 }, (_, i) => {
          const x = i % 40,
            y = Math.floor(i / 40);
          return [
            x,
            y,
            Math.max(0, Math.sin(x * 0.3 + y * 0.4) * Math.cos(y * 0.4)),
          ];
        }),
      },
    ],
  };
}
export function HealthGauge({ score }: { score: number }) {
  return (
    <Chart
      height={140}
      label={`健康度 ${score}`}
      option={{
        series: [
          {
            type: "gauge",
            startAngle: 90,
            endAngle: -270,
            min: 0,
            max: 100,
            radius: "83%",
            progress: {
              show: true,
              roundCap: true,
              width: 10,
              itemStyle: { color: score >= 90 ? "#1FA971" : "#F5A623" },
            },
            axisLine: { lineStyle: { width: 10, color: [[1, "#EEF2F7"]] } },
            pointer: { show: false },
            axisTick: { show: false },
            splitLine: { show: false },
            axisLabel: { show: false },
            title: { show: false },
            detail: {
              valueAnimation: false,
              fontSize: 30,
              fontWeight: 600,
              color: "#1F2733",
              offsetCenter: [0, 0],
              formatter: "{value}",
            },
            data: [{ value: score }],
          },
        ],
      }}
    />
  );
}
