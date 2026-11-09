"use client";
import React, {useMemo, useState} from 'react';
import {AnalysisCard, lineOption} from './field-record-analysis-charts';
import {increasingDisplacementDisplay} from './displacement-display-data';

export function DisplacementDisplay({points, loading, context}: {points: {point: string; radiusM: number | null; actualMm: number}[]; loading: boolean; context: string}) {
  const [showModel, setShowModel] = useState(true);
  const values = useMemo(() => increasingDisplacementDisplay(points), [points]);
  const option = useMemo(() => {
    if (!values.length) return null;
    const chart = lineOption([
      {name: '实测计算', color: '#2563eb', data: values.map(p => [p.radiusM!, p.actualMm])},
      ...(showModel ? [{name: '一阶弯曲假设拟合', color: '#d97706', dashed: true, data: values.map(p => [p.radiusM!, p.displayMm])}] : []),
    ], '距旋转中心 / m', '位移振幅 / mm');
    return {...chart, yAxis: {...chart.yAxis, min: 0}};
  }, [values, showModel]);
  return <AnalysisCard title="位移趋势对照 · 模型拟合" id="SYN-DISPLACEMENT-DISPLAY" option={option} context={context} loading={loading}
    reason="至少需要两个带有有效半径和位移的测点"
    headerActions={<label className="fra-displacement-compare"><input type="checkbox" checked={showModel} onChange={event => setShowModel(event.target.checked)} />显示递增假设拟合</label>}>
    {!loading && values.length > 0 && <><p className="dra-hint">蓝线保留实测计算值；橙色虚线为一阶弯曲形状假设下的最小二乘拟合，未修改测量数据，不参与健康评价。局部下降不单独判定为数据错误或损伤。</p>
      <div className="dra-table-wrap"><table><thead><tr><th>测点</th><th>距旋转中心 · m</th><th>实测计算 · mm</th><th>模型拟合 · mm</th><th>实测 − 拟合 · mm</th></tr></thead>
        <tbody>{values.map(p => <tr key={p.point}><td>{p.point}</td><td>{p.radiusM}</td><td>{p.actualMm.toFixed(6)}</td><td>{p.displayMm.toFixed(6)}</td><td>{(p.actualMm-p.displayMm).toFixed(6)}</td></tr>)}</tbody></table></div>
      <details><summary>拟合方法与适用范围</summary><p>形状函数 φ(u)=u²(3−u)/2，u 为测点半径除以最外侧已测半径，仅拟合一个非负幅值系数。此曲线是递增假设对照，不是识别到的模态振型，也不是叶片绝对挠度；未外推至叶根或叶尖。</p></details></>}
  </AnalysisCard>;
}
