"use client";
import React, { memo, useId, useMemo, useRef, useState } from "react";
import { Activity, AudioLines, ChartNoAxesCombined, Waves } from "lucide-react";
import { Chart } from "./charts";
import type { FieldRealtime } from "./field-types";

export type RealtimeView = "time" | "spectrum" | "spectrogram";
const views = [
  { id: "time", title: "时域波形", icon: AudioLines },
  { id: "spectrum", title: "FFT 频谱", icon: Activity },
  { id: "spectrogram", title: "时频分析", icon: ChartNoAxesCombined },
] as const;
const number = (value: number | null | undefined, digits = 5) => typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(digits)).toLocaleString("zh-CN", { maximumSignificantDigits: digits }) : "—";

/** Only display units change. Invalid measurements remain gaps, never zeroes. */
export function realtimePoints(x: readonly number[], y: readonly number[], factor = 1000): [number, number | null][] {
  const points: [number, number | null][] = [];
  for (let index = 0; index < x.length; index++) {
    if (!Number.isFinite(x[index])) continue;
    points.push([x[index], Number.isFinite(y[index]) ? y[index] * factor : null]);
  }
  return points;
}

export function realtimeChartOption(realtime: FieldRealtime | undefined, view: RealtimeView): Record<string, any> | null {
  if (!realtime?.available) return null;
  const axis = { axisLabel: { color: "#687a91", fontSize: 12, hideOverlap: true }, axisLine: { lineStyle: { color: "#d9e3ef" } }, axisTick: { show: false }, nameTextStyle: { color: "#687a91", fontSize: 12 }, splitLine: { lineStyle: { color: "#e8eef5", type: "dashed" } } };
  const base = { animation: false, textStyle: { fontFamily: "Inter, Microsoft YaHei, sans-serif" },
    grid: { left: 68, right: 28, top: 42, bottom: 68 },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "cross", lineStyle: { color: "#df6268", type: "dashed" } } },
    dataZoom: [{ id: "live-inside", type: "inside", filterMode: "none", throttle: 50 }, { id: "live-slider", type: "slider", height: 18, bottom: 8, borderColor: "#e1e7ef", brushSelect: false }],
  };
  if (view === "spectrogram") {
    const stft = realtime.spectrogram;
    if (!stft?.times.length || !stft.frequencies.length) return null;
    const cells: number[][] = [];
    for (let frequency = 0; frequency < stft.frequencies.length; frequency++) {
      for (let time = 0; time < stft.times.length; time++) {
        const value = stft.db[frequency]?.[time];
        if (Number.isFinite(value)) cells.push([time, frequency, value]);
      }
    }
    if (!cells.length) return null;
    return { ...base, grid: { left: 68, right: 26, top: 40, bottom: 104 },
      // A fixed physical reference keeps colors comparable across windows.
      visualMap: { min: -160, max: 0, orient: "horizontal", left: "center", bottom: 38, itemWidth: 10, itemHeight: 160, text: ["0 dB", "−160 dB"], textStyle: { color: "#687a91", fontSize: 12 }, inRange: { color: ["#440154", "#31688e", "#35b779", "#fde725"] } },
      tooltip: { trigger: "item", confine: true, formatter: (item: { value: number[] }) => {
        const [time, frequency, db] = item.value;
        return `时间 ${number(stft.times[time], 10)} s<br/>频率 ${number(stft.frequencies[frequency], 6)} Hz<br/>幅值 ${number(db, 4)} dB re 1 m/s`;
      } },
      xAxis: { ...axis, type: "category", name: "相对时间 / s", nameLocation: "middle", nameGap: 28, data: stft.times.map(value => number(value, 10)), splitLine: { show: false } },
      yAxis: { ...axis, type: "category", name: "Hz", data: stft.frequencies.map(value => number(value, 5)), splitLine: { show: false } },
      series: [{ id: "live-stft", type: "heatmap", data: cells, progressive: 0, emphasis: { disabled: true } }],
    };
  }
  const data = view === "spectrum" ? realtimePoints(realtime.spectrum.frequencies, realtime.spectrum.amplitudes)
    : realtimePoints(realtime.timeDomain?.times || [], realtime.timeDomain?.values || []);
  if (!data.some(point => point[1] !== null)) return null;
  return { ...base,
    xAxis: { ...axis, type: "value", name: view === "spectrum" ? "Hz" : "相对时间 / s", nameLocation: "middle", nameGap: 27, boundaryGap: false, scale: view === "time" },
    yAxis: { ...axis, type: "value", name: "mm/s", scale: true },
    series: [{ id: `live-${view}`, name: view === "spectrum" ? "FFT 幅值 · mm/s" : "CH1 速度 · mm/s", type: "line", data, showSymbol: false, connectNulls: false, smooth: false, lineStyle: { color: "#2d6cc0", width: 1.5 }, itemStyle: { color: "#2d6cc0" }, emphasis: { disabled: true } }],
  };
}

// Each visited view owns its chart, retaining zoom without mixing heatmap/line options.
const RealtimePlot = memo(function RealtimePlot({ realtime, view, active }: { realtime?: FieldRealtime; view: RealtimeView; active: boolean }) {
  const option = useMemo(() => realtimeChartOption(realtime, view), [realtime, view]);
  const current = views.find(item => item.id === view)!;
  return option ? <Chart key={realtime?.recordingId} active={active} height={340} label={`实时${current.title}，${view === "spectrogram" ? "dB re 1 m/s" : "毫米每秒"}`} option={option} updateMode="merge" />
    : <div className="field-chart-empty"><Waves size={28} /><strong>等待{current.title}数据</strong><span>开始采集，连续窗口达到 64 点后显示。</span></div>;
}, (previous, next) => previous.active === next.active && (!next.active || previous.realtime === next.realtime && previous.view === next.view));

export const FieldRealtimeAnalysis = memo(function FieldRealtimeAnalysis({ realtime, paused = false, active = true }: { realtime?: FieldRealtime; paused?: boolean; active?: boolean }) {
  const [view, setView] = useState<RealtimeView>("time");
  const [visited, setVisited] = useState<ReadonlySet<RealtimeView>>(() => new Set(["time"]));
  const selectView = (next: RealtimeView) => {
    setVisited(previous => previous.has(next) ? previous : new Set([...previous, next]));
    setView(next);
  };
  const prefix = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const features = realtime?.available ? realtime.features : undefined;
  const simulated = realtime?.source?.includes("simulation");
  const quality = realtime?.quality;
  const compromised = quality && (quality.overrangeSamples > 0 || quality.missingRssiSamples > 0 || quality.lowReturnSamples > 0);
  const samples = realtime?.sampleRange;
  return <section className="field-card field-realtime-analysis">
    <div className="field-section-heading"><h2>实时信号分析</h2>
      <span className={`field-badge ${paused ? "amber" : realtime?.available ? "green" : ""}`}><span className="field-status-dot" />{paused ? `${simulated ? "模拟数据 · " : ""}显示已暂停` : realtime?.available ? simulated ? "模拟数据" : "实时窗口" : "等待数据"}</span></div>
    <div className="field-live-feature-grid">
      {[["RMS", features?.rms, "mm/s"], ["峰值", features?.peak, "mm/s"], ["峰峰值", features?.peakToPeak, "mm/s"], ["主频", features?.dominantHz, "Hz"]].map(([title, value, unit]) => <div key={String(title)}><span>{title}</span><strong>{number(typeof value === "number" ? value * (unit === "mm/s" ? 1000 : 1) : undefined)}<small>{unit}</small></strong></div>)}
    </div>
    <div className="field-live-analysis-tabs" role="tablist" aria-label="实时分析类型">{views.map((item, index) => <button key={item.id} id={`${prefix}-${item.id}`} type="button" role="tab" aria-selected={view === item.id} aria-controls={`${prefix}-${item.id}-panel`} tabIndex={view === item.id ? 0 : -1} ref={element => { buttons.current[index] = element; }} onClick={() => selectView(item.id)} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); selectView(views[next].id); buttons.current[next]?.focus(); }
    }}><item.icon size={16} />{item.title}</button>)}</div>
    {views.map(item => <div key={item.id} className="field-live-analysis-plot" role="tabpanel" tabIndex={0} id={`${prefix}-${item.id}-panel`} aria-labelledby={`${prefix}-${item.id}`} hidden={view !== item.id}>
      {visited.has(item.id) && <RealtimePlot realtime={realtime} view={item.id} active={active && view === item.id} />}
    </div>)}
    <div className="field-live-analysis-foot"><span>计算窗口 <b>{number(realtime?.windowSamples, 8)}</b> 点</span><span>采样率 <b>{number(realtime?.sampleRate, 8)}</b> Hz</span><span>频率栅格 <b>{number(realtime?.frequencySpacingHz)}</b> Hz</span>{samples && <span>样本 {number(samples.start, 12)}–{number(samples.end, 12)}（不含终点）</span>}</div>
    {view === "spectrogram" && <p className="field-live-analysis-note">窗长 {realtime?.spectrogram?.windowSamples ?? "—"} 点 · 步进 {realtime?.spectrogram?.hopSamples ?? "—"} 点 · dB re 1 m/s</p>}
    {view === "time" && realtime?.timeDomain?.representation === "minmax-display" && <p className="field-live-analysis-note">显示方式：峰值包络</p>}
    {compromised && <p className="field-notice warning field-live-quality">当前窗口：超量程 {quality.overrangeSamples} 点 · RSSI 缺失 {quality.missingRssiSamples} 点 · 回波偏低 {quality.lowReturnSamples} 点</p>}
    {paused && <p className="field-live-analysis-note">显示已暂停，采集和保存仍在继续。</p>}
    {!realtime?.available && realtime?.warnings?.map((warning, index) => <p className="field-live-analysis-note" key={index}>{warning}</p>)}
  </section>;
}, (previous, next) => {
  if (previous.active !== next.active) return false;
  if (next.active === false) return true;
  if (previous.paused !== next.paused) return false;
  if (previous.realtime === next.realtime) return true;
  const a = previous.realtime, b = next.realtime;
  // HTTP/IPC returns new objects even while the service reuses its cached analysis.
  // Only skip a render when the service provides an explicit computation identity.
  return Boolean(a && b && Number.isFinite(a.computedAt) && a.computedAt === b.computedAt
    && a.recordingId === b.recordingId && a.source === b.source && a.available === b.available
    && a.sampleStart === b.sampleStart && a.windowSamples === b.windowSamples
    && a.sampleRange?.start === b.sampleRange?.start && a.sampleRange?.end === b.sampleRange?.end);
});
