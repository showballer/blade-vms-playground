"use client";
import React, { useState } from "react";
import { CustomSelect } from "./custom-select";
import { Chart } from "./charts";
import { bladePassNumber as number, type BladeSynthesis, type BladeMergedPoint } from "./web-blade-passes-data";

const axes = {
  animation: false, tooltip: { trigger: "axis", confine: true },
  grid: { left: 65, right: 30, top: 35, bottom: 65 },
  xAxis: { type: "value", name: "测点半径 / m", nameLocation: "middle", nameGap: 30 },
  yAxis: { type: "value", name: "归一化幅值", min: 0, max: 1.1 },
};

export function BladeMergedPointSignals({ point }: { point: BladeMergedPoint }) {
  const recordingCount = new Set(point.segments.map(segment => segment.recordingId)).size;
  const angles = [...new Set(point.segments.map(segment => segment.azimuthDeg))].sort((a, b) => a - b);
  return <>
    <p className="blade-pass-note">{point.radialPointName} · 半径 {number(point.radiusM)} m · {recordingCount} 条记录 · {point.segments.length} 个有效片段 · 角度 {angles.map(angle => `${number(angle)}°`).join("、")} · 合并有效时长 {number(point.durationSeconds)} s</p>
      {point.stitchedWaveform && <Chart key={`merged-${point.radialPointId}`} height={280} label="单个径向测点多角度片段经边界基线偏置对齐后的拼接波形" option={{ ...axes,
        xAxis: { type: "value", name: "拼接有效时间 / s", nameLocation: "middle", nameGap: 30 }, yAxis: { type: "value", name: "速度 / mm/s" },
        series: [{ type: "line", showSymbol: false, data: point.stitchedWaveform.seconds.map((second, i) => [second, point.stitchedWaveform!.valuesMps[i] * 1000]),
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { type: "dotted", color: "#888" }, data: point.segments.slice(1).map(segment => ({ xAxis: segment.compressedStartSeconds })) } }],
        dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 16, bottom: 5 }] }} />}
      {point.stitchedSpectrum && <>
        <div className="blade-pass-spectrum-heading"><strong>拼接后 FFT 频谱</strong><p>
          {point.stitchInfo?.segments ?? point.segments.length} 个有效片段 · Δf {number(point.stitchedSpectrum.frequencySpacingHz)} Hz
          {point.stitchInfo?.resampledSegments ? ` · ${point.stitchInfo.resampledSegments} 段已重采样至 ${number(point.stitchInfo.sampleRate)} Hz` : ` · ${number(point.stitchInfo?.sampleRate ?? point.stitchedSpectrum.sampleRate)} Hz`}
        </p></div>
        <Chart key={`stitched-fft-${point.radialPointId}`} height={280} label="单个径向测点的多角度有效片段经边界偏置校正拼接后的 FFT 速度幅值谱" option={{
          animation: false, tooltip: { trigger: "axis", confine: true }, grid: { left: 65, right: 30, top: 35, bottom: 65 },
          xAxis: { type: "value", name: "频率 / Hz", nameLocation: "middle", nameGap: 30 },
          yAxis: { type: "value", name: "速度幅值 / mm/s" },
          series: [{ type: "line", showSymbol: false, data: point.stitchedSpectrum.frequencies.map((frequency, index) => [frequency, point.stitchedSpectrum!.amplitudesMps[index] * 1000]) }],
          dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 16, bottom: 5 }],
        }} />
        <p className="blade-pass-note">为拼接，程序将每段整体平移，使其首样本接到前一段末样本；各段内部波形不改。FFT 使用拼接后全序列、线性去趋势和 Hann 窗。拼接不能恢复各次经过之间未测到的振动相位，段边界和角度差异仍可能形成谱峰；请结合单段频谱判断。</p>
      </>}
      <p className="blade-pass-note">拼接 FFT 用于辅助观察；空间振型候选仍使用各原始连续段独立计算的谱，避免拼接边界或相位不一致影响候选判断。异常大单步变化的遮罩只用于绘图。</p>
    {!point.stitchedWaveform && <p className="blade-pass-empty">此结果缺少合并波形，请重新运行“合并片段并合成振型候选”。</p>}
    {!point.stitchedSpectrum && <p className="blade-pass-empty">此结果暂无合并频谱，可切换单条记录查看连续有效段频谱，或重新运行合并分析。</p>}
  </>;
}

export function BladeSynthesisResults({ synthesis, showMergedSignals = true }: { synthesis: BladeSynthesis; showMergedSignals?: boolean }) {
  const [pointIndex, setPointIndex] = useState(0), [candidateIndex, setCandidateIndex] = useState(0);
  const [phase, setPhase] = useState(90);
  const responses = synthesis.candidates.length ? synthesis.candidates : synthesis.bandResponses;
  const point = synthesis.mergedPoints[Math.min(pointIndex, synthesis.mergedPoints.length - 1)];
  const candidate = responses[Math.min(candidateIndex, responses.length - 1)];
  return <>
    <section className="field-card">
      <div className="field-section-heading"><div><h2>步骤 1 · 同测点多角度合并</h2><p>同一径向测点的各角度有效片段合并为一个可追溯结果，保留角度、片段边界与原始样本索引。{!showMergedSignals && "波形和频谱请在下方“有效波形与频谱”中按测点查看。"}</p></div>
        {showMergedSignals && point && <label className="blade-pass-inline">径向测点<CustomSelect aria-label="合并数据径向测点" value={pointIndex} onChange={event => setPointIndex(Number(event.target.value))}>
          {synthesis.mergedPoints.map((item, index) => <option key={item.radialPointId} value={index}>{item.radialPointName} · {number(item.durationSeconds)} s</option>)}
        </CustomSelect></label>}
      </div>
      {synthesis.qualityWarnings?.map((warning, index) => <p key={index} className="blade-pass-boundary">{warning}</p>)}
      <div className="field-table-scroll"><table className="field-table"><thead><tr><th>测点</th><th>半径 m</th><th>合并有效秒数</th><th>样本 / 片段</th></tr></thead><tbody>{synthesis.mergedPoints.map(item => <tr key={item.radialPointId}><td>{item.radialPointName}</td><td>{number(item.radiusM)}</td><td>{number(item.durationSeconds)}</td><td>{item.samples.toLocaleString()} / {item.segments.length}</td></tr>)}</tbody></table></div>
      {showMergedSignals && point && <BladeMergedPointSignals point={point} />}
    </section>
    <section className="field-card">
      <div className="field-section-heading"><div><h2>步骤 2 · 同叶片多测点组合</h2><p>将已合并的不同径向测点按半径组合，查看共同频带的无符号空间响应幅值。</p></div>
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
