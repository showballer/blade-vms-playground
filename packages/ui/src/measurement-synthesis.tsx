"use client";
import React, { useEffect, useRef, useState } from "react";
import { api, saveBlob } from "./api";
import { Button, Card, Select, Table, Tag } from "./common";
import { Chart } from "./charts";
import { ChartLoading } from "./chart-loading";
import { contextNames, isDiagnosticMeasurement, type MeasurementContext, type MeasurementObject } from "./measurement-domain";
import { matchesContext, numberText } from "./measurement-common";
import { measurementChartHeight, measurementZoomAxes } from "./measurement-chart-options";
import { bladePassReason, type BladePassResult } from "./web-blade-passes-data";
import { MeasurementResponse3D } from "./measurement-response-3d";

/** This view shares the original blade-passes synthesis algorithm. It never
 * reconstructs a measured phase or fills a missing radial point/azimuth. */
export function MeasurementSynthesis({ context, objects, sources, canWrite, includeDiagnostic, onDiagnosticChange }: {
  context: Partial<MeasurementContext>;
  objects: MeasurementObject[];
  sources: any[];
  canWrite: boolean;
  includeDiagnostic: boolean;
  onDiagnosticChange: (value: boolean) => void;
}) {
  const positions = objects.filter(o => o.kind === "position" && o.parentId === context.bladeId)
    .sort((a, b) => (a.radiusM ?? Infinity) - (b.radiusM ?? Infinity) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const [omitted, setOmitted] = useState<string[]>([]),
    [minHz, setMinHz] = useState("20"), [maxHz, setMaxHz] = useState("2000"),
    [busy, setBusy] = useState(false), [error, setError] = useState(""),
    [result, setResult] = useState<BladePassResult | null>(null);
  const generation = useRef(0);
  const scoped = sources.filter(s => s.context && context.campaignId && context.turbineId && context.bladeId &&
    matchesContext(s, { ...context, positionId: "" }));
  const selectedPositions = positions.filter(p => !omitted.includes(p.id));
  const eligible = scoped.filter(s => selectedPositions.some(p => p.id === s.context.positionId) &&
    s.metadata.status === "complete" && (includeDiagnostic || !isDiagnosticMeasurement(s)));
  const hasDiagnostic = scoped.some(isDiagnosticMeasurement);
  const names = contextNames(context, objects);
  const scopeRevision = scoped.map(s => `${s.key}:${s.bindingRevision}:${s.metadata.status}`).sort().join("|");
  const selection = selectedPositions.map(p => p.id).join("|");
  useEffect(() => {
    generation.current++;
    setResult(null); setError(""); setBusy(false);
    return () => { generation.current++; };
  }, [scopeRevision, selection, includeDiagnostic, minHz, maxHz]);
  const ready = Boolean(context.farmId && context.campaignId && context.turbineId && context.bladeId);
  const validBand = Number.isFinite(Number(minHz)) && Number.isFinite(Number(maxHz)) &&
    Number(minHz) >= 0.1 && Number(maxHz) > Number(minHz) && Number(maxHz) <= 100000;
  async function run() {
    if (!ready || !eligible.length || !validBand || busy) return;
    const ticket = ++generation.current;
    setBusy(true); setError(""); setResult(null);
    try {
      const next = await api<BladePassResult>("measurements/synthesis", "POST", {
        farmId: context.farmId, campaignId: context.campaignId, turbineId: context.turbineId,
        bladeId: context.bladeId, positionIds: selectedPositions.map(p => p.id),
        includeDiagnostic, minHz: Number(minHz), maxHz: Number(maxHz),
      });
      if (ticket === generation.current) setResult(next);
    } catch (e) {
      if (ticket === generation.current) setError((e as Error).message);
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  return <div className="stack measurement-synthesis">
    <Card title="同叶片振幅合成" tools={<Button variant="primary" disabled={!canWrite || !ready || !eligible.length || !validBand || busy} onClick={() => void run()}>
      {busy ? "正在合成…" : result ? "重新合成" : "合成当前叶片"}
    </Button>}>
      <p>{ready ? `${names.turbine} / 叶片 ${names.blade} · ${names.campaign}` : "请先选择风机、测量任务和叶片。"}</p>
      <p className="hint">同一测点的多个圆周角有效片段合并查看，再比较不同测点的频带响应。缺失角度和测点保留缺测。</p>
      <div className="measurement-choice-row" aria-label="参与合成的测点">
        <span>测点</span>
        {positions.map(p => {
          const count = scoped.filter(s => s.context.positionId === p.id && s.metadata.status === "complete" && (includeDiagnostic || !isDiagnosticMeasurement(s))).length;
          return <button key={p.id} type="button" aria-pressed={!omitted.includes(p.id)} disabled={busy}
            onClick={() => setOmitted(current => current.includes(p.id) ? current.filter(id => id !== p.id) : [...current, p.id])}>
            {p.name} · {count} 条
          </button>;
        })}
      </div>
      {hasDiagnostic && <label className="measurement-diagnostic-note inline-field">
        <input type="checkbox" aria-label="合成纳入诊断数据" checked={includeDiagnostic} disabled={busy} onChange={e => onDiagnosticChange(e.target.checked)} />
        纳入诊断数据合成（保留诊断属性，不用于健康结论）
      </label>}
      {ready && !eligible.length && <p className="measurement-inline-empty">当前没有可合成的完整记录。{hasDiagnostic && !includeDiagnostic ? "这批记录包含诊断数据，可勾选上方选项查看实验响应。" : "请选择有数据的测点。"}</p>}
      <details className="measurement-advanced"><summary>合成频段设置</summary>
        <div className="measurement-filters">
          <label>最低频率 · Hz<input aria-label="合成最低频率" type="number" min="0.1" max="100000" step="any" value={minHz} disabled={busy} onChange={e => setMinHz(e.target.value)} /></label>
          <label>最高频率 · Hz<input aria-label="合成最高频率" type="number" min="0.1" max="100000" step="any" value={maxHz} disabled={busy} onChange={e => setMaxHz(e.target.value)} /></label>
        </div>
        {!validBand && <p className="error">频段需满足 0.1 Hz ≤ 最低频率 &lt; 最高频率 ≤ 100 kHz。</p>}
        <p className="hint">各连续有效片段独立计算 Welch 频谱，在共同频段积分比较幅值，不跨拼接边界计算频谱。</p>
      </details>
    </Card>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <div className="measurement-charts"><Card title="多角度有效波形"><ChartLoading /></Card><Card title="多测点振幅响应"><ChartLoading /></Card></div>}
    {result && <MeasurementSynthesisResult result={result} expectedPoints={selectedPositions.map(p => {
      const metadata = scoped.find(source => source.context.positionId === p.id)?.metadata.pointCycle;
      return { id: metadata?.radialPointId || p.id, name: p.name, radiusM: metadata?.radiusM ?? p.radiusM };
    })} />}
  </div>;
}

type ExpectedSynthesisPoint = { id: string; name: string; radiusM?: number };
export function MeasurementSynthesisResult({ result, expectedPoints = [] }: { result: BladePassResult; expectedPoints?: ExpectedSynthesisPoint[] }) {
  const synthesis = result.synthesis;
  const [pointId, setPointId] = useState(""), [candidateIndex, setCandidateIndex] = useState(0), [normalized, setNormalized] = useState(false);
  if (!synthesis) return <p className="measurement-inline-empty">当前记录未形成可合成的有效片段。</p>;
  const points = synthesis.mergedPoints;
  const displayPoints = expectedPoints.length ? expectedPoints.map(expected => ({
    ...expected, merged: points.find(point => point.radialPointId === expected.id),
  })) : points.map(point => ({ id: point.radialPointId, name: point.radialPointName, radiusM: point.radiusM, merged: point }));
  const point = points.find(p => p.radialPointId === pointId) || points[0];
  const responses = synthesis.candidates.length ? synthesis.candidates : synthesis.bandResponses;
  const candidate = responses[Math.min(candidateIndex, responses.length - 1)];
  const rejected = result.sources.filter(s => s.status !== "included");
  return <div className="stack">
    <div className="measurement-toolbar">
      <span>{result.coverage.includedRecords} / {result.coverage.selectedRecords} 条记录纳入 · {points.length} 个测点 · {numberText(result.coverage.validSeconds)} s 有效数据</span>
      <div className="measurement-heading-actions">
        {result.hasDiagnostic && <Tag tone="orange">含诊断数据</Tag>}
        <Button onClick={() => saveBlob(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), `叶片振幅合成-${result.collectionId}.json`)}>导出合成结果</Button>
      </div>
    </div>
    {result.hasDiagnostic && <p className="measurement-diagnostic-note">诊断数据仅用于检查经过片段和响应分布，不作为正常参考或健康结论。</p>}
    <Card title="多测点振幅响应" tools={candidate && <Select label="响应幅值" value={normalized ? "normalized" : "displacement"} onChange={v => setNormalized(v === "normalized")} options={[
      { value: "displacement", label: "频带位移 RMS · μm" }, { value: "normalized", label: "归一化幅值" },
    ]} />}>
      {candidate && <Select label="共同频带" value={candidateIndex} onChange={v => setCandidateIndex(Number(v))} options={responses.map((r, i) => ({
        value: String(i), label: `${numberText(r.bandHz[0], 1)}–${numberText(r.bandHz[1], 1)} Hz${r.kind === "exploratory_band_response" ? " · 探索频带" : " · 共同谱峰"}`,
      }))} />}
      {candidate ? <>
        <div className="measurement-charts measurement-amplitude-views">
        <MeasurementResponse3D bandHz={candidate.bandHz} points={displayPoints.map(p => {
          const value = candidate.points.find(c => c.radialPointId === p.id);
          return { id: p.id, name: p.name, radiusM: p.radiusM ?? null,
            normalizedAmplitude: value?.normalizedAmplitude ?? null,
            displacementRmsM: value?.displacementRmsM ?? null };
        })} />
        <div className="measurement-response-curve"><h3>测点 RMS 大小 · 非负值</h3>
        <Chart height={measurementChartHeight} label="叶根到叶尖多测点振幅合成" option={{
          animation: false, tooltip: { trigger: "axis", confine: true },
          ...measurementZoomAxes("距风机中心 / m", normalized ? "归一化幅值" : "频带位移 RMS / μm"),
          yAxis: { ...measurementZoomAxes("", normalized ? "归一化 RMS" : "频带位移 RMS / μm").yAxis, min: 0 },
          series: [{ type: "line", showSymbol: true, symbolSize: 8, connectNulls: false,
            data: displayPoints.map(p => {
              const value = candidate.points.find(c => c.radialPointId === p.id);
              return [p.radiusM ?? null, value ? normalized ? value.normalizedAmplitude : value.displacementRmsM * 1e6 : null];
            }) }],
        }} />
        </div>
        </div>
        <Table headers={["测点", "半径 / m", "位移 RMS / μm", "归一化幅值", "本频带有效圆周角数"]}>
          {displayPoints.map(p => {
            const value = candidate.points.find(candidatePoint => candidatePoint.radialPointId === p.id);
            return <tr key={p.id}><td>{p.name}</td><td>{numberText(p.radiusM)}</td><td>{value ? numberText(value.displacementRmsM * 1e6, 6) : "缺测"}</td><td>{numberText(value?.normalizedAmplitude)}</td><td>{value?.stationCount ?? 0}</td></tr>;
          })}
        </Table>
      </> : <div className="measurement-plot-empty">{synthesis.reason || "有效测点或共同频带证据不足，暂不能形成多测点响应。"}</div>}
      {synthesis.reason && candidate && <p className="hint">{synthesis.reason}</p>}
      <p className="hint">原始速度的正负表示沿激光方向的运动方向；RMS 表示频带振动大小，不能当作位移极值。不同测点分次采集、空间相位未知，无法据此还原整片的上下振动。</p>
      {!!candidate?.warnings.length && <details className="measurement-advanced"><summary>频带证据与限制</summary><ul>{candidate.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
    </Card>
    <Card title="单测点多角度合成" tools={point && <Select label="查看测点" value={point.radialPointId} onChange={setPointId}
      options={points.map(p => ({ value: p.radialPointId, label: `${p.radialPointName} · ${numberText(p.durationSeconds)} s` }))} />}>
      <Table headers={["测点", "半径 / m", "有效圆周角", "有效时长 / s", "有效片段数"]}>
        {displayPoints.map(p => <tr key={p.id}><td>{p.name}</td><td>{numberText(p.radiusM)}</td><td>{[...new Set(p.merged?.segments.map(s => s.azimuthDeg) || [])].sort((a, b) => a - b).map(a => `${a}°`).join("、") || "缺测"}</td><td>{numberText(p.merged?.durationSeconds)}</td><td>{p.merged?.segments.length ?? 0}</td></tr>)}
      </Table>
      {point && <div className="measurement-charts">
        <Card title={`${point.radialPointName} · 多角度有效波形（有符号速度）`}>
          <Chart height={measurementChartHeight} label="多角度有效片段合成波形" option={{
            animation: false, tooltip: { trigger: "axis", confine: true },
            ...measurementZoomAxes("压缩有效时间 / s", "速度 / mm/s"),
            series: point.segments.map((segment, index) => {
              const curve = segment.plotTimeDomain || segment.timeDomain;
              return { name: `${segment.azimuthDeg}°`, type: "line", showSymbol: false, connectNulls: false,
                data: curve.seconds.map((s, i) => [segment.compressedStartSeconds + s - segment.originalStartSeconds,
                  curve.values[i] == null ? null : curve.values[i]! * 1000]),
                markLine: { silent: true, symbol: "none", label: { formatter: `${segment.azimuthDeg}°` },
                  lineStyle: { type: "dotted", color: "#94a3b8" }, data: [{ xAxis: segment.compressedStartSeconds },
                    ...(index === 0 ? [{ yAxis: 0, label: { formatter: "速度零线", position: "insideEndTop" }, lineStyle: { color: "#64748b", type: "dashed" } }] : [])] },
              };
            }),
          }} />
          <p className="hint">保留速度正负值；合并所选圆周角的有效片段、去除无效等待时间，片段之间不连线。光束方向的正负不等同于画面上的上下方向。</p>
        </Card>
        <Card title={`${point.radialPointName} · 独立片段 Welch 频谱`}>
          {point.independentSpectrum ? <Chart height={measurementChartHeight} label="合成测点独立片段 Welch 频谱" option={{
            animation: false, tooltip: { trigger: "axis", confine: true },
            ...measurementZoomAxes("频率 / Hz", "PSD (mm/s)²/Hz"),
            series: [{ type: "line", showSymbol: false, data: point.independentSpectrum.frequencies.map((f, i) => [f, point.independentSpectrum!.psdMps2PerHz[i] * 1e6]) }],
          }} /> : <div className="measurement-plot-empty">连续有效数据不足，暂不能计算 Welch 频谱。</div>}
          <p className="hint">各片段分别计算功率谱后汇总，不将拼接边界当成振动。</p>
        </Card>
      </div>}
      {point && <details className="measurement-advanced"><summary>片段来源与时间映射 · {point.segments.length} 段</summary>
        <Table headers={["圆周角", "来源记录", "原始时间 / s", "压缩时间 / s"]}>
          {point.segments.map(s => <tr key={s.segmentId}><td>{s.azimuthDeg}°</td><td>{result.sources.find(source => source.recordingId === s.recordingId)?.name || s.sourceRecordingId || s.recordingId}</td><td>{numberText(s.originalStartSeconds)}–{numberText(s.originalEndSeconds)}</td><td>{numberText(s.compressedStartSeconds)}–{numberText(s.compressedEndSeconds)}</td></tr>)}
        </Table>
      </details>}
    </Card>
    {(rejected.length > 0 || result.warnings.length > 0 || synthesis.qualityWarnings?.length) && <Card title="覆盖与质量检查">
      {rejected.length > 0 && <Table headers={["未纳入测点", "圆周角", "原因"]}>{rejected.map((s, i) => <tr key={`${s.recordingId}-${i}`}><td>{s.radialPointName}</td><td>{s.azimuthDeg}°</td><td>{bladePassReason(s.reason || "无完整有效片段")}</td></tr>)}</Table>}
      {(result.warnings.length > 0 || synthesis.qualityWarnings?.length) && <details className="measurement-advanced"><summary>分析说明与限制</summary>
        <ul>{[...new Set([...result.warnings, ...(synthesis.qualityWarnings || [])])].map((w, i) => <li key={i}>{w}</li>)}</ul>
      </details>}
    </Card>}
  </div>;
}
