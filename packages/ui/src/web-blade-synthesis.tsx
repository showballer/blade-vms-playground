"use client";
import React, { useState } from "react";
import { CustomSelect } from "./custom-select";
import { Chart } from "./charts";
import { bladePassNumber as number, type BladeSynthesis } from "./web-blade-passes-data";

const axes = {
  animation: false, tooltip: { trigger: "axis", confine: true },
  grid: { left: 65, right: 30, top: 35, bottom: 65 },
  xAxis: { type: "value", name: "测点半径 / m", nameLocation: "middle", nameGap: 30 },
  yAxis: { type: "value", name: "归一化幅值", min: 0, max: 1.1 },
};

export function BladeSynthesisResults({ synthesis }: { synthesis: BladeSynthesis }) {
  const [pointIndex, setPointIndex] = useState(0), [candidateIndex, setCandidateIndex] = useState(0);
  const [phase, setPhase] = useState(90);
  const responses = synthesis.candidates.length ? synthesis.candidates : synthesis.bandResponses;
  const point = synthesis.mergedPoints[Math.min(pointIndex, synthesis.mergedPoints.length - 1)];
  const candidate = responses[Math.min(candidateIndex, responses.length - 1)];
  return <>
    <section className="field-card">
      <div className="field-section-heading"><div><h2>多角度有效数据合并</h2><p>按所选记录顺序压缩无效时间，保留角度、片段边界与原始样本索引。</p></div>
        {point && <label className="blade-pass-inline">径向测点<CustomSelect aria-label="合并数据径向测点" value={pointIndex} onChange={event => setPointIndex(Number(event.target.value))}>
          {synthesis.mergedPoints.map((item, index) => <option key={item.radialPointId} value={index}>{item.radialPointName} · {number(item.durationSeconds)} s</option>)}
        </CustomSelect></label>}
      </div>
      {synthesis.qualityWarnings?.map((warning, index) => <p key={index} className="blade-pass-boundary">{warning}</p>)}
      <div className="field-table-scroll"><table className="field-table"><thead><tr><th>测点</th><th>半径 m</th><th>合并有效秒数</th><th>样本 / 片段</th></tr></thead><tbody>{synthesis.mergedPoints.map(item => <tr key={item.radialPointId}><td>{item.radialPointName}</td><td>{number(item.radiusM)}</td><td>{number(item.durationSeconds)}</td><td>{item.samples.toLocaleString()} / {item.segments.length}</td></tr>)}</tbody></table></div>
      {point && point.segments.length > 0 && <Chart key={`merged-${point.radialPointId}`} height={280} label="各角度有效片段按压缩时间并排显示，边界不连线" option={{ ...axes,
        xAxis: { type: "value", name: "压缩有效时间 / s", nameLocation: "middle", nameGap: 30 }, yAxis: { type: "value", name: "速度 / mm/s" },
        series: point.segments.map(segment => {
          const curve = segment.plotTimeDomain ?? segment.timeDomain;
          return { name: `${segment.azimuthDeg}° · ${segment.recordingId.slice(0, 8)}`, type: "line", showSymbol: false, connectNulls: false,
            data: curve.seconds.map((second, index) => [segment.compressedStartSeconds + second - segment.originalStartSeconds,
              curve.values[index] == null ? null : curve.values[index]! * 1000]),
            markLine: { silent: true, symbol: "none", label: { show: true, formatter: `${segment.azimuthDeg}°` }, lineStyle: { type: "dotted", color: "#94a3b8" }, data: [{ xAxis: segment.compressedStartSeconds }] } };
        }), dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 16, bottom: 5 }] }} />}
      {point?.independentSpectrum && <>
        <div className="blade-pass-spectrum-heading"><strong>连续片段独立计算的 Welch 功率谱</strong><p>{point.independentSpectrum.segmentCount} 个有效片段 · 频率网格 {number(point.independentSpectrum.frequencySpacingHz)} Hz</p></div>
        <Chart key={`independent-spectrum-${point.radialPointId}`} height={260} label="独立连续段 Welch 功率谱，未跨拼接边界计算" option={{ ...axes,
          xAxis: { type: "value", name: "频率 / Hz", nameLocation: "middle", nameGap: 30 },
          yAxis: { type: "value", name: "(mm/s)²/Hz" },
          series: [{ type: "line", showSymbol: false, data: point.independentSpectrum.frequencies.map((frequency, index) => [frequency, point.independentSpectrum!.psdMps2PerHz[index] * 1e6]) }],
          dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 16, bottom: 5 }] }} />
      </>}
      <p className="blade-pass-note">压缩时间只用于并排查看，各段不平移基线、不跨边界计算频谱；角度间的空白时间与相位不能靠拼接恢复。</p>
      {point && <details className="blade-pass-detail"><summary>片段来源与时间映射 · {point.segments.length} 段</summary><div className="field-table-scroll"><table className="field-table"><thead><tr><th>角度</th><th>原始记录</th><th>原始时间 s</th><th>压缩时间 s</th></tr></thead><tbody>{point.segments.map(segment => <tr key={segment.segmentId}><td>{segment.azimuthDeg}°</td><td>{segment.recordingId.slice(0, 8)}</td><td>{number(segment.originalStartSeconds)}～{number(segment.originalEndSeconds)}</td><td>{number(segment.compressedStartSeconds)}～{number(segment.compressedEndSeconds)}</td></tr>)}</tbody></table></div></details>}
    </section>
    <section className="field-card">
      <div className="field-section-heading"><div><h2>多测点频带响应 · 实验</h2><p>共同频带的无符号空间响应幅值，按最大径向幅值归一化。</p></div>
        {candidate && <label className="blade-pass-inline">候选频带<CustomSelect aria-label="振型候选频带" value={candidateIndex} onChange={event => setCandidateIndex(Number(event.target.value))}>
          {responses.map((item, index) => <option key={item.frequencyHz} value={index}>{item.kind === "exploratory_band_response" ? "探索频带" : "候选"} · {number(item.bandHz[0])}～{number(item.bandHz[1])} Hz</option>)}
        </CustomSelect></label>}
      </div>
      {synthesis.reason && <p className="blade-pass-boundary">{synthesis.reason}{synthesis.bandResponses.length > 0 && " 以下提供预设频带的探索曲线。"}</p>}
      {candidate ? <>
        <Chart key={`shape-${candidate.kind}-${candidate.frequencyHz}`} height={300} label="无符号频带响应空间振型候选，实测相位未知" option={{ ...axes, series: [{ type: "line", symbolSize: 8, lineStyle: { type: "dashed" },
          data: candidate.points.map(item => [item.radiusM, item.normalizedAmplitude]) }] }} />
        <div className="field-table-scroll"><table className="field-table"><thead><tr><th>测点</th><th>半径 m</th><th>频带位移 RMS μm</th><th>归一化幅值</th><th>有效角度</th><th>角度幅值最大/最小</th></tr></thead><tbody>{candidate.points.map(item => <tr key={item.radialPointId}><td>{item.radialPointName}</td><td>{number(item.radiusM)}</td><td>{number(item.displacementRmsM * 1e6)}</td><td>{number(item.normalizedAmplitude)}</td><td>{item.stationCount}</td><td>{number(item.stationAmplitudeRatio)}×</td></tr>)}</tbody></table></div>
        <label className="blade-pass-inline">同相假设下周期预览 · {phase}°<input aria-label="同相假设周期相位" type="range" min={0} max={360} step={5} value={phase} onChange={event => setPhase(Number(event.target.value))} /></label>
        <Chart height={240} label="同相假设的合成周期预览，非实测模态运动" option={{ ...axes, yAxis: { type: "value", name: "假设相位归一位移", min: -1.1, max: 1.1 },
          series: [{ type: "line", symbolSize: 8, data: candidate.points.map(item => [item.radiusM, item.normalizedAmplitude * Math.sin(phase * Math.PI / 180)]) }] }} />
        <ul>{candidate.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </> : <p className="blade-pass-empty">{synthesis.reason}</p>}
      <p className="blade-pass-boundary">实测空间相位与节点正负未知。同相预览是合成假设，候选曲线尚不能用于确认模态或判断叶片损伤。</p>
      <details className="blade-pass-detail"><summary>合成依据与假设</summary><ul>{synthesis.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></details>
    </section>
  </>;
}
