import React, { useMemo, useState } from "react";
import { Chart } from "./charts";
import { CustomSelect } from "./custom-select";
import { bladePassNumber as number, type BladeSynthesis } from "./web-blade-passes-data";
import mode1Csv from "../assets/modal-templates/2026.7-modal-reconstruction/mode-1.csv?raw";
import mode2Csv from "../assets/modal-templates/2026.7-modal-reconstruction/mode-2.csv?raw";
import mode3Csv from "../assets/modal-templates/2026.7-modal-reconstruction/mode-3.csv?raw";
import mode4Csv from "../assets/modal-templates/2026.7-modal-reconstruction/mode-4.csv?raw";
import mode5Csv from "../assets/modal-templates/2026.7-modal-reconstruction/mode-5.csv?raw";

type ModeTemplate = { order: number; frequencyHz: number; points: [number, number][] };
const sourceFiles = [mode1Csv, mode2Csv, mode3Csv, mode4Csv, mode5Csv];
export const desktopBladeTemplates: ModeTemplate[] = sourceFiles.map((csv, index) => {
  const lines = csv.trim().split(/\r?\n/).slice(1);
  const points = lines.map(line => {
    const [, xOverL, , normalized] = line.split(",").map(Number);
    return [xOverL, normalized] as [number, number];
  }).filter(([x, value]) => Number.isFinite(x) && Number.isFinite(value));
  const maximum = Math.max(...points.map(([, value]) => value));
  if (points.length < 2 || maximum <= 0) throw new Error(`第 ${index + 1} 阶理论模板数据无效。`);
  return { order: index + 1, frequencyHz: [1.33, 6.17, 16.87, 23.20, 69.20][index],
    points: points.map(([x, value]) => [x, value / maximum]) as [number, number][] };
});

export function DesktopBladeTemplateSelector({ value }: { value: string }) {
  return <div className="blade-pass-template-picker">
    <label>理论模板<CustomSelect aria-label="理论模态模板" value={value} disabled>
      <option value="customer-2026.7">客户模态重构 · 2026.7</option>
    </CustomSelect></label>
    <span>版本 2026.7 · 来源：客户提供的叶片模态重构数据</span>
    <span>理论频率：1.33、6.17、16.87、23.20、69.20 Hz · 适用工况未在资料中注明</span>
  </div>;
}
function interpolate(points: [number, number][], x: number) {
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
  let index = 1;
  while (points[index][0] < x) index++;
  const [x0, y0] = points[index - 1], [x1, y1] = points[index];
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}

const chartBase = { animation: false, tooltip: { trigger: "axis", confine: true }, legend: { top: 2 },
  grid: { left: 60, right: 25, top: 68, bottom: 54 },
  xAxis: { type: "value", name: "叶片归一化位置 x/L", min: 0, max: 1, nameLocation: "middle", nameGap: 30 },
  yAxis: { type: "value", name: "归一化幅值", min: 0, max: 1.05 } };

export function DesktopBladeTemplateComparison({ synthesis, templateId }: { synthesis: BladeSynthesis; templateId: string }) {
  const [candidateIndex, setCandidateIndex] = useState(0), [order, setOrder] = useState(1);
  const candidates = [...(synthesis.candidates ?? []), ...(synthesis.bandResponses ?? [])];
  const candidate = candidates[Math.min(candidateIndex, Math.max(candidates.length - 1, 0))];
  const template = desktopBladeTemplates.find(item => item.order === order)!;
  const maxRadius = candidate ? Math.max(...candidate.points.map(point => point.radiusM)) : 0;
  const measured = candidate?.points.map(point => [maxRadius ? point.radiusM / maxRadius : 0, point.normalizedAmplitude] as [number, number]) ?? [];
  const scored = useMemo(() => candidate ? desktopBladeTemplates.map(item => {
    const pointErrors = candidate.points.map(point => {
      const xOverL = maxRadius > 0 ? point.radiusM / maxRadius : 0;
      const theory = interpolate(item.points, xOverL);
      const error = point.normalizedAmplitude - theory;
      return { point, xOverL, theory, error };
    });
    return { template: item, pointErrors, mse: pointErrors.reduce((sum, item) => sum + item.error * item.error, 0) / pointErrors.length };
  }).sort((a, b) => a.mse - b.mse) : [], [candidate, maxRadius]);
  return <section className="field-card blade-pass-template-comparison">
    <div className="field-section-heading"><div><h2>步骤 3 · 理论模态模板对比</h2><p>将所选实测候选频带的归一化空间幅值与客户理论模板逐点比较。</p></div>
      <label className="blade-pass-inline">实测候选频带<CustomSelect aria-label="模板对比实测候选频带" value={candidateIndex} onChange={event => setCandidateIndex(Number(event.target.value))}>
        {candidates.map((item, index) => <option key={`${item.frequencyHz}-${index}`} value={index}>{item.kind === "exploratory_band_response" ? "探索频带" : "候选"} · {number(item.bandHz[0])}～{number(item.bandHz[1])} Hz</option>)}
      </CustomSelect></label>
    </div>
    {!candidate ? <p className="blade-pass-empty">当前结果没有共同频带候选，暂不能与理论模板比较。</p> : <>
      <div className="blade-pass-template-toolbar"><label>对照阶次<CustomSelect aria-label="模板对比理论阶次" value={order} onChange={event => setOrder(Number(event.target.value))}>
        {desktopBladeTemplates.map(item => <option key={item.order} value={item.order}>第 {item.order} 阶 · {number(item.frequencyHz)} Hz</option>)}
      </CustomSelect></label><strong>幅值形状最相近：第 {scored[0]?.template.order} 阶 · MSE {number(scored[0]?.mse, 6)}</strong></div>
      <Chart height={300} label="实测候选空间幅值与理论模态幅值曲线对比" option={{ ...chartBase, series: [
        { name: `实测候选 ${number(candidate.frequencyHz)} Hz`, type: "line", symbolSize: 8, data: measured },
        { name: `理论第 ${template.order} 阶 · ${number(template.frequencyHz)} Hz`, type: "line", showSymbol: false,
          lineStyle: { type: "dashed" }, data: template.points },
      ] }} />
      <div className="field-table-scroll"><table className="field-table"><thead><tr><th>候选频带 Hz</th><th>理论阶次</th><th>理论频率 Hz</th><th>频率差 Hz</th><th>归一化幅值 MSE</th><th>采样测点</th></tr></thead><tbody>
        {scored.map(({ template: item, mse }, index) => <tr key={item.order}><td>{number(candidate.bandHz[0])}～{number(candidate.bandHz[1])} ({number(candidate.frequencyHz)})</td><td>第 {item.order} 阶{index === 0 ? " · 最相近" : ""}</td><td>{number(item.frequencyHz)}</td><td>{number(candidate.frequencyHz - item.frequencyHz)}</td><td>{number(mse, 6)}</td><td>{candidate.points.map(point => point.radialPointName).join("、")}</td></tr>)}
      </tbody></table></div>
      <h3>逐点幅值误差 · 理论第 {template.order} 阶</h3>
      <div className="field-table-scroll"><table className="field-table"><thead><tr><th>测点</th><th>归一化位置 x/L</th><th>实测归一化幅值</th><th>理论归一化幅值</th><th>误差（实测 - 理论）</th><th>平方误差</th></tr></thead><tbody>
        {scored.find(item => item.template.order === template.order)?.pointErrors.map(({ point, xOverL, theory, error }) => <tr key={point.radialPointId}><td>{point.radialPointName}</td><td>{number(xOverL)}</td><td>{number(point.normalizedAmplitude)}</td><td>{number(theory)}</td><td>{number(error)}</td><td>{number(error * error, 6)}</td></tr>)}
      </tbody></table></div>
      <h3>理论振型预览 · 第 {template.order} 阶</h3>
      <Chart height={250} label="理论模态模板二维幅值形状预览" option={{ ...chartBase, series: [{ name: `理论幅值形状 · ${number(template.frequencyHz)} Hz`,
        type: "line", symbolSize: 3, areaStyle: { opacity: 0.12 }, data: template.points }] }} />
      <p className="blade-pass-note">显示的是模板提供的二维理论幅值曲线，非实测振型。客户资料未包含可随桌面程序使用的叶片三维网格；MSE 按本次所选测点覆盖半径归一化为 x/L，未选到叶根或叶尖时不代表完整叶长。跨点相位和振型正负未知。</p>
      <p className="blade-pass-note">选中理论第 {template.order} 阶时，本频带 MSE 为 {number(scored.find(item => item.template.order === template.order)?.mse, 6)}；当前候选频率 {number(candidate.frequencyHz)} Hz，模板频率 {number(template.frequencyHz)} Hz。</p>
    </>}
    <small>模板 {templateId} · 来源：客户提供的 2026.7 模态重构；版本及适用工况按原始资料记录。</small>
  </section>;
}
