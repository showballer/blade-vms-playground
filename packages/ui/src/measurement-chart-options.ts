/** Compact labels and reserved space for both the axis title and zoom handles. */
export function measurementTick(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude < 0.001 || magnitude >= 100000) return value.toExponential(2);
  return Number(value.toPrecision(5)).toString();
}

export const measurementChartHeight = "clamp(340px, 38vh, 460px)";

export function measurementZoomAxes(xName: string, yName: string) {
  return {
    grid: { left: 74, right: 24, top: 42, bottom: 92, containLabel: true },
    xAxis: {
      type: "value", name: xName, nameLocation: "middle", nameGap: 28,
      axisLabel: { formatter: measurementTick, hideOverlap: true },
    },
    yAxis: {
      type: "value", name: yName, scale: true,
      axisLabel: { formatter: measurementTick, hideOverlap: true },
    },
    dataZoom: [
      { type: "inside", filterMode: "none" },
      // ECharts draws a move handle below the slider. A bottom of zero clips it.
      { type: "slider", height: 24, bottom: 18, left: 74, right: 24,
        moveHandleSize: 7, labelFormatter: measurementTick, filterMode: "none" },
    ],
  };
}
