"use client";
import React, { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import { Download, Expand, LoaderCircle, RotateCcw } from "lucide-react";
import { Button, Dialog } from "./common";
import { analysisChartNames, finite, layerNames, valueText, type AnalysisJson } from "./field-record-analysis-data";

export const analysisColors = ["#2563eb", "#059669", "#d97706", "#9333ea", "#dc4d65", "#0891b2"];
export type AnalysisSeries = { name: string; data: (number | null)[][]; color?: string; type?: "line" | "bar"; dashed?: boolean; [key: string]: unknown };
export function lineOption(series: AnalysisSeries[], xName: string, yName: string, options: { log?: boolean; categories?: string[]; area?: AnalysisJson[] } = {}) {
  return {
    animation: false, color: analysisColors, tooltip: { trigger: "axis", confine: true, valueFormatter: (value: unknown) => valueText(value, 6) },
    legend: { top: 0, left: 0, right: 12, type: "scroll", textStyle: { color: "#52627a", fontSize: 11 } },
    grid: { left: 66, right: 30, top: 44, bottom: 80, containLabel: false },
    xAxis: { type: options.categories ? "category" : "value", data: options.categories, name: xName, nameLocation: "middle", nameGap: 30, nameTextStyle: { fontSize: 11 }, axisLabel: { hideOverlap: true, fontSize: 10 }, splitLine: { show: !options.categories, lineStyle: { color: "#edf1f6" } } },
    yAxis: { type: options.log ? "log" : "value", name: yName, nameTextStyle: { fontSize: 11 }, scale: !series.some(item => item.type === "bar"), ...(!options.log && series.some(item => item.type === "bar") ? { min: 0 } : {}), axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: "#edf1f6" } } },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 19, bottom: 10, filterMode: "none", borderColor: "#dce4ef", textStyle: { fontSize: 10 } }],
    series: series.map((item, index) => ({ type: item.type || "line", name: item.name, data: item.data, showSymbol: item.type === "bar" || item.data.length <= 25,
      symbolSize: 6, connectNulls: false, lineStyle: { width: 1.5, type: item.dashed ? "dashed" : "solid", color: item.color || analysisColors[index % analysisColors.length] },
      itemStyle: { color: item.color || analysisColors[index % analysisColors.length] }, emphasis: { focus: "series" },
      ...(index === 0 && options.area?.length ? { markArea: { silent: true, itemStyle: { color: "rgba(37,99,235,.09)" }, data: options.area } } : {}) })),
  };
}
export function AnalysisPlot({ option, label, onPick, plotRef, height = 290 }: { option: AnalysisJson; label: string; onPick?: (value: any) => void; plotRef?: React.MutableRefObject<echarts.ECharts | null>; height?: number }) {
  const root = useRef<HTMLDivElement>(null), chart = useRef<echarts.ECharts | null>(null), pick = useRef(onPick);
  const [rendering, setRendering] = useState(true); pick.current = onPick;
  useEffect(() => {
    if (!root.current) return;
    const instance = echarts.init(root.current, undefined, { renderer: "canvas" }); chart.current = instance;
    if (plotRef) plotRef.current = instance;
    const resize = new ResizeObserver(() => instance.resize()); resize.observe(root.current);
    instance.on("click", params => pick.current?.(params));
    return () => { resize.disconnect(); instance.dispose(); chart.current = null; if (plotRef) plotRef.current = null; };
  }, []);
  useEffect(() => { chart.current?.setOption(option, { notMerge: true }); setRendering(false); }, [option]);
  return <div className="fra-plot-wrap" style={{ height }}><div ref={root} className="fra-plot" role="img" aria-label={label} />{rendering && <div className="fra-plot-loading"><LoaderCircle size={18} className="spin" />正在绘图</div>}</div>;
}
export function AnalysisCard({ id, title, subtitle, option, reason, children, context, wide = false, loading = false, onPick, expandOnPlotClick = false }: {
  id: string; title?: string; subtitle?: string; option?: AnalysisJson | null; reason?: string; children?: React.ReactNode;
  context: string; wide?: boolean; loading?: boolean; expandOnPlotClick?: boolean; onPick?: (value: any) => void;
}) {
  const [full, setFull] = useState(false), chart = useRef<echarts.ECharts | null>(null);
  const [fullOption,setFullOption]=useState<AnalysisJson|null>(null);
  const openFull=()=>{setFullOption(option?{...option,dataZoom:chart.current?.getOption().dataZoom||option.dataZoom}:null);setFull(true);};
  const name = title || analysisChartNames[id] || id;
  const tagged = option || null;
  function save() {
    if (!chart.current) return;
    // Keep the interactive graph clear. Add provenance only while producing
    // its exported bitmap; the permanent on-screen source lives in the footer.
    chart.current.setOption({ graphic: [{ id: "fra-export-provenance", type: "text", left: 8, bottom: 2, silent: true, style: { text: context, fontSize: 8, fill: "#7a8ba4" } }] });
    const anchor = document.createElement("a"); anchor.href = chart.current.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
    chart.current.setOption({ graphic: [{ id: "fra-export-provenance", $action: "remove" }] });
    anchor.download = `${id}_${name}_${context.replace(/[\\/:*?"<>|]/g, "_")}.png`; anchor.click();
  }
  return <section className={`fra-card${wide ? " fra-wide" : ""}`} data-analysis-card={id}>
    <div className="fra-card-heading"><div><span className="fra-chart-code">{id}</span><h3>{name}</h3>{subtitle && <p>{subtitle}</p>}</div>{tagged && <div className="fra-card-tools"><Button type="button" variant="ghost" aria-label={`复位${id}视图`} onClick={() => chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 })}><RotateCcw size={13} /></Button><Button type="button" variant="ghost" aria-label={`全屏查看${id}`} onClick={openFull}><Expand size={13} /></Button><Button type="button" variant="ghost" aria-label={`导出${id}图片`} onClick={save}><Download size={13} /></Button></div>}</div>
    {loading ? <div className="fra-card-empty" role="status"><LoaderCircle size={20} className="spin" /><span>正在读取真实分析结果…</span></div> : tagged ? <div onClick={expandOnPlotClick?openFull:undefined}><AnalysisPlot option={tagged} label={`${id} ${name}`} plotRef={chart} onPick={onPick} /></div> : reason ? <div className="fra-card-empty"><span className="fra-empty-symbol">—</span><p>{reason}</p></div> : null}
    {children}<div className="fra-card-provenance">{context}</div>
    {full && <Dialog title={`${id} · ${name}`} wide onClose={() => setFull(false)}><div className="fra-full-chart">{tagged && <AnalysisPlot option={fullOption||tagged} label={`${id} ${name}全屏`} height={520} onPick={onPick} />}<p>{context}</p></div></Dialog>}
  </section>;
}
export function AnalysisEmpty({ title, message, children }: { title: string; message?: string; children?: React.ReactNode }) {
  return <div className="fra-empty-state"><span className="fra-empty-symbol">◇</span><strong>{title}</strong>{message && <p>{message}</p>}{children}</div>;
}
export function AnalysisStats({ items }: { items: { label: string; value: unknown; unit?: string; note?: string }[] }) {
  return <div className="fra-stats">{items.map(item => <div key={item.label}><span>{item.label}</span><strong>{typeof item.value === "string" ? item.value : valueText(item.value)}{item.unit && <small>{item.unit}</small>}</strong>{item.note && <small>{item.note}</small>}</div>)}</div>;
}
export function AnalysisRadialShape({ points, animate, scale, onSelect }: { points: { name: string; radius: number | null; amplitude: number | null }[]; animate: boolean; scale: number; onSelect: (name: string) => void }) {
  const known = points.filter(point => finite(point.radius)), maximum = Math.max(...known.map(point => point.radius!), 0);
  if (!maximum) return <AnalysisEmpty title="实际径向位置缺失" message="无法放置径向测点，已有数值结果仍可查看。" />;
  const maxAmplitude = Math.max(...known.map(point => point.amplitude || 0), 0), toX = (radius: number) => 28 + radius / maximum * 380;
  return <div className={`fra-radial-shape${animate ? " is-playing" : ""}`}>
    <svg viewBox="0 0 450 178" role="img" aria-label="按实际半径放置的测点振幅示意，说明性相位，非已识别模态振型">
      <path d="M24 70 C150 72 300 79 420 87 L420 91 C300 99 150 106 24 108 Z" fill="#edf3fb" stroke="#bdcee6" />
      <line x1="24" y1="89" x2="425" y2="89" stroke="#b2c0d4" strokeDasharray="4 4" />
      {known.map((point, index) => <g key={point.name} className="fra-radial-point" style={{ "--fra-shape-travel": `${maxAmplitude && point.amplitude !== null ? Math.min(48, point.amplitude / maxAmplitude * 32 * scale) : 0}px` } as React.CSSProperties} onClick={() => onSelect(point.name)} role="button" tabIndex={0} aria-label={`查看${point.name}点位分析`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") onSelect(point.name); }}>
        <line x1={toX(point.radius!)} y1="89" x2={toX(point.radius!)} y2={89 - (maxAmplitude && point.amplitude !== null ? point.amplitude / maxAmplitude * 38 : 0)} stroke={analysisColors[index % analysisColors.length]} strokeWidth="2" />
        <circle cx={toX(point.radius!)} cy="89" r="5" fill={point.amplitude === null ? "#cbd5e1" : analysisColors[index % analysisColors.length]} />
        <text x={toX(point.radius!)} y="132" textAnchor="middle">{point.name}</text><text x={toX(point.radius!)} y="150" textAnchor="middle" className="fra-radial-distance">{valueText(point.radius, 3)}m</text>
      </g>)}<text x="24" y="34">旋转中心</text><text x="420" y="34" textAnchor="end">径向位置</text>
    </svg><p>振幅示意 · 说明性相位 · 非已识别模态振型</p>
  </div>;
}
export const layerLabel = (layer: string) => layerNames[layer] || layer || "未标注处理层";
