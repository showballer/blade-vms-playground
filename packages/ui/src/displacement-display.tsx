"use client";
import React, {useMemo, useState} from 'react';
import {AnalysisCard, lineOption} from './field-record-analysis-charts';
import {increasingDisplacementDisplay} from './displacement-display-data';

export function DisplacementDisplay({points, loading, context}: {points: {point: string; radiusM: number | null; actualMm: number}[]; loading: boolean; context: string}) {
  const [showActual, setShowActual] = useState(false);
  const values = useMemo(() => increasingDisplacementDisplay(points), [points]);
  const option = useMemo(() => {
    if (!values.length) return null;
    const chart = lineOption([
      {name: '递增展示', color: '#2563eb', data: values.map((p, i) => [i, p.displayMm])},
      ...(showActual ? [{name: '实际计算', color: '#94a3b8', dashed: true, data: values.map((p, i) => [i, p.actualMm])}] : []),
    ], '测点', '位移振幅 / mm', {categories: values.map(p => p.point)});
    return {...chart, yAxis: {...chart.yAxis, min: 0}};
  }, [values, showActual]);
  return <AnalysisCard title="位移趋势对照" id="SYN-DISPLACEMENT-DISPLAY" option={option} context={context} loading={loading}
    reason="暂无可计算位移的测点数据"
    headerActions={<label className="fra-displacement-compare"><input type="checkbox" checked={showActual} onChange={event => setShowActual(event.target.checked)} />对照实际计算</label>}>
    {!loading && values.length > 0 && <><p className="dra-hint">P1 → P5 递增展示，独立于实际计算结果。</p>
      <div className="dra-table-wrap"><table><thead><tr><th>测点</th><th>距旋转中心 · m</th><th>实际计算 · mm</th><th>递增展示 · mm</th></tr></thead>
        <tbody>{values.map(p => <tr key={p.point}><td>{p.point}</td><td>{p.radiusM ?? '未填写'}</td><td>{p.actualMm.toFixed(6)}</td><td>{p.displayMm.toFixed(6)}</td></tr>)}</tbody></table></div></>}
  </AnalysisCard>;
}
