"use client";
import React, {useMemo, useState} from 'react';
import {CustomSelect} from './common';
import {AnalysisCard, lineOption} from './field-record-analysis-charts';
import {increasingDisplacementDisplay} from './displacement-display-data';
import {valueText} from './field-record-analysis-data';

export type DisplacementAmplitudePoint = {
  point: string;
  radiusM: number | null;
  actualMm: number | null;
  angleCount: number;
  plannedAngleCount: number;
};
export type DisplacementAmplitudeView = 'fit' | 'actual' | 'compare';

export function displacementAmplitudeRows(points: readonly DisplacementAmplitudePoint[]) {
  const fitted = increasingDisplacementDisplay(points.flatMap(p =>
    p.actualMm != null && Number.isFinite(p.actualMm) && p.actualMm >= 0
      ? [{point: p.point, radiusM: p.radiusM, actualMm: p.actualMm}] : []));
  const values = new Map(fitted.map(p => [p.point, p.displayMm]));
  // Keep missing measurements explicit instead of filling them with a fitted value.
  return points.map(p => ({...p, displayMm: values.get(p.point) ?? null}));
}

export function displacementAmplitudeOption(
  rows: ReturnType<typeof displacementAmplitudeRows>,
  view: DisplacementAmplitudeView,
) {
  const categorical = rows.some(p => p.radiusM == null || !Number.isFinite(p.radiusM));
  const ordered = categorical ? rows : [...rows].sort((a, b) => a.radiusM! - b.radiusM!);
  const makeSeries = (fit: boolean) => ({
    name: fit ? '递增拟合' : '实测计算',
    color: fit ? '#2563eb' : '#d97706',
    dashed: !fit && view === 'compare',
    data: ordered.map((p, i) => [categorical ? i : p.radiusM!, fit ? p.displayMm : p.actualMm]),
  });
  const series = view === 'compare' ? [makeSeries(true), makeSeries(false)] : [makeSeries(view === 'fit')];
  if (!series.some(s => s.data.some(pair => pair[1] != null && Number.isFinite(pair[1])))) return null;
  const option = lineOption(series, categorical ? '测点' : '距旋转中心 / m', '平均位移振幅 / mm',
    categorical ? {categories: ordered.map(p => p.point)} : {});
  return {
    ...option,
    yAxis: {...option.yAxis, min: 0},
    xAxis: categorical ? option.xAxis : {...option.xAxis, min: 'dataMin', max: 'dataMax'},
    series: option.series.map(s => ({...s, label: {
      show: true, position: 'top', formatter: (v: {dataIndex: number}) => ordered[v.dataIndex]?.point || '',
    }})),
    tooltip: {trigger: 'axis', renderMode: 'richText', confine: true, formatter: (items: {dataIndex: number}[]) => {
      const p = ordered[items[0]?.dataIndex];
      if (!p) return '';
      return `${p.point} · ${p.radiusM == null ? '半径未填写' : p.radiusM + ' m'}\n递增拟合：${valueText(p.displayMm, 6)} mm\n实测计算：${valueText(p.actualMm, 6)} mm`;
    }},
  };
}

/** Presentation-only fit. Never passed back to processing, health assessment or raw exports. */
export function DisplacementAmplitude({points, loading, context, reason, children}: {
  points: DisplacementAmplitudePoint[];
  loading: boolean;
  context: string;
  reason?: string;
  children?: React.ReactNode;
}) {
  const [view, setView] = useState<DisplacementAmplitudeView>('fit');
  const rows = useMemo(() => displacementAmplitudeRows(points), [points]);
  const option = useMemo(() => displacementAmplitudeOption(rows, view), [rows, view]);
  const label = view === 'fit' ? '递增拟合' : view === 'actual' ? '实测计算' : '拟合与实测对照';
  return <AnalysisCard id="SYN-AMPLITUDE" title="叶片各测点平均位移振幅"
    context={`${context} · ${label}`} loading={loading} option={option} expandOnPlotClick
    subtitle={view === 'actual' ? '各角度位移半峰峰值等权平均 · mm' : '递增拟合用于趋势展示 · mm'}
    reason={reason || (view === 'fit' ? '至少需要两个带有效半径和位移的测点；可切换实测计算查看已有数据。' : '没有可计算位移的有效连续段')}
    headerActions={<label className="fra-displacement-view">显示
      <CustomSelect aria-label="位移振幅显示方式" value={view} onChange={e => setView(e.target.value as DisplacementAmplitudeView)}>
        <option value="fit">递增拟合</option><option value="actual">实测计算</option><option value="compare">拟合与实测对照</option>
      </CustomSelect>
    </label>}>
    {!loading && <>
      <div className="dra-table-wrap"><table>
        <thead><tr><th>测点 / 半径</th><th>递增拟合 · mm</th><th>实测计算 · mm</th><th>使用 / 计划角度</th></tr></thead>
        <tbody>{rows.map(p => <tr key={p.point}>
          <td>{p.point} / {p.radiusM == null ? '半径未填写' : `${p.radiusM} m`}</td>
          <td>{valueText(p.displayMm, 6)}</td><td>{valueText(p.actualMm, 6)}</td>
          <td>{p.angleCount} / {p.plannedAngleCount || '未知'}{p.plannedAngleCount && p.angleCount !== p.plannedAngleCount ? ' · 覆盖不完整' : ''}</td>
        </tr>)}</tbody>
      </table></div>
      <details><summary>各角度实测计算与拟合方法</summary>
        <p className="dra-hint">递增曲线沿用一阶弯曲形状的最小二乘拟合，仅用于趋势展示；实测计算、宽频响应和健康评价保持原值。</p>
        <p className="dra-hint">φ(u)=u²(3−u)/2，u 为半径除以最外侧已测半径。拟合一个非负幅值系数，不外推叶根或叶尖。</p>
        {children}
      </details>
    </>}
  </AnalysisCard>;
}
