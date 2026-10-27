"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Layers3 } from "lucide-react";
import { api, saveBlob } from "./api";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { Chart } from "./charts";
import { ChartLoading } from "./chart-loading";
import { BladeTaskSelection } from "./web-blade-task-selection";
import { BladeSynthesisResults } from "./web-blade-synthesis";
import { BLADE_PASS_RECORD_LIMIT, bladePassIsDiagnostic, defaultBladePassSelection, bladePassNumber as number, bladePassReason, bladePassTasks, bladePassUnavailableReason, bladePassWaveSeries, preferredBladePassTask, selectedBladePassRecords,
  type BladePassRecording, type BladePassResult, type BladePassSource } from "./web-blade-passes-data";

type Props = { canAnalyze: boolean; refreshKey: number; preferredIds: string[]; onError: (cause: unknown) => void;
  localData?: { listRecordings: () => Promise<{ recordings: BladePassRecording[] }>; analyze: (parameters: Record<string, unknown>) => Promise<BladePassResult> } };
const token = (name: string, fallback: string) => typeof window === "undefined" ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
function chartBase() {
  return { animation: false, color: [token("--accent", "#2d6cc0"), token("--green", "#1fa971")], textStyle: { fontSize: 12 },
    tooltip: { trigger: "axis", confine: true }, grid: { left: 62, right: 22, top: 32, bottom: 72 },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 16, bottom: 8, left: 62, right: 22, brushSelect: false, showDataShadow: false }],
    yAxis: { type: "value", name: "mm/s", nameGap: 12, axisLabel: { hideOverlap: true } } };
}
const station = (angle: number | undefined) => Number.isFinite(angle) ? `${number(angle)}°` : "点位未知";
const sourceLabel = (source: BladePassSource) => `${source.radialPointName || source.radialPointId} · ${station(source.azimuthDeg)} · ${source.sessionId?.slice(0, 8) || source.recordingId.slice(0, 8)}`;

export function WebBladePasses({ canAnalyze, refreshKey, preferredIds, onError, localData }: Props) {
  const [records, setRecords] = useState<BladePassRecording[]>([]);
  const [taskKey, setTaskKey] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [includeDiagnostic, setIncludeDiagnostic] = useState(false);
  const [synthesize, setSynthesize] = useState(true), [minHz, setMinHz] = useState("20"), [maxHz, setMaxHz] = useState("2000");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BladePassResult | null>(null);
  const listTicket = useRef(0), calculationTicket = useRef(0), selection = useRef({ taskKey, selected, includeDiagnostic });
  const errorHandler = useRef(onError); errorHandler.current = onError;
  selection.current = { taskKey, selected, includeDiagnostic };
  const tasks = useMemo(() => bladePassTasks(records), [records]);
  const unavailable = useMemo(() => records.map(record => ({ record, reason: bladePassUnavailableReason(record) })).filter(item => item.reason), [records]);
  const task = tasks.find(item => item.key === taskKey);
  const chosen = selectedBladePassRecords(task, selected);
  const preferredKey = JSON.stringify(preferredIds);
  const invalidate = useCallback(() => { calculationTicket.current++; setBusy(false); setResult(null); }, []);
  const refresh = useCallback(async () => {
    const ticket = ++listTicket.current; invalidate(); setLoading(true);
    try {
      const response = localData ? await localData.listRecordings() : await api<{ recordings: BladePassRecording[] }>("rotation/recordings");
      if (ticket !== listTicket.current) return;
      const nextTasks = bladePassTasks(response.recordings);
      const next = preferredBladePassTask(nextTasks, JSON.parse(preferredKey), selection.current.taskKey);
      setRecords(response.recordings); setTaskKey(next?.key ?? "");
      setSelected(defaultBladePassSelection(next, selection.current.includeDiagnostic));
    } catch (cause) { if (ticket === listTicket.current) errorHandler.current(cause); }
    finally { if (ticket === listTicket.current) setLoading(false); }
  }, [invalidate, preferredKey, localData]);
  useEffect(() => { void refresh(); return () => { listTicket.current++; calculationTicket.current++; }; }, [refresh, refreshKey]);
  useEffect(() => { if (!canAnalyze) invalidate(); }, [canAnalyze, invalidate]);
  function selectTask(key: string) {
    invalidate(); setTaskKey(key); setSelected(defaultBladePassSelection(tasks.find(item => item.key === key), includeDiagnostic));
  }
  function selectRecords(ids: string[], checked: boolean) {
    invalidate(); setSelected(current => checked ? [...new Set([...current, ...ids])].slice(0, BLADE_PASS_RECORD_LIMIT) : current.filter(id => !ids.includes(id)));
  }
  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (!canAnalyze || !chosen.length || loading || busy) return;
    if (synthesize && (!Number.isFinite(Number(minHz)) || !Number.isFinite(Number(maxHz)) || Number(minHz) < .1 || Number(maxHz) <= Number(minHz) || Number(maxHz) > 100000)) { onError(new Error("合成频率范围应满足 0.1 ≤ 下限 < 上限 ≤ 100000 Hz。")); return; }
    const ticket = ++calculationTicket.current; setBusy(true); setResult(null);
    try {
      const parameters = {
        recordingIds: chosen.map(record => record.id), includeDiagnostic, passWindow: "detected", detrend: "constant",
        ...(synthesize ? { synthesis: { minHz: Number(minHz), maxHz: Number(maxHz) } } : {}),
      };
      const response = localData ? await localData.analyze(parameters) : await api<BladePassResult>("rotation/blade-passes", "POST", parameters);
      if (ticket === calculationTicket.current) setResult(response);
    } catch (cause) { if (ticket === calculationTicket.current) errorHandler.current(cause); }
    finally { if (ticket === calculationTicket.current) setBusy(false); }
  }
  return <div className="web-blade-passes">
    <form className="field-card blade-pass-setup" onSubmit={run}>
      <div className="field-section-heading"><div><h2><Layers3 size={18} /> 叶片有效片段</h2><p>按叶片进入与离开范围筛选，分别查看各测点的有效波形与幅值。</p></div><Button type="button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} />刷新记录</Button></div>
      <BladeTaskSelection tasks={tasks} taskKey={taskKey} selected={selected} loading={loading} includeDiagnostic={includeDiagnostic}
        onTask={selectTask} onRecords={selectRecords} onRestore={() => { invalidate(); setSelected(defaultBladePassSelection(task, includeDiagnostic)); }}
        onDiagnostic={value => { invalidate(); setIncludeDiagnostic(value); setSelected(defaultBladePassSelection(task, value)); }} />
      {!canAnalyze && <p className="blade-pass-note">当前账号可查看记录，运行分析需要分析权限。</p>}
      {!loading && !tasks.length && <p className="blade-pass-empty">{localData ? "本机尚无带完整叶片、测点和经过边界信息的采集记录。完成自动点位采集后，点击刷新记录。" : "等待桌面端上传完整点位记录，或导入桌面端导出的完整 CSV。文件需保留任务、叶片、测点与进入/离开信息。"}</p>}
      {unavailable.length > 0 && <details className="blade-pass-detail"><summary>其他历史记录中有 {unavailable.length} 条缺少分析所需信息</summary><p className="blade-pass-note">旧记录缺少任务、叶片或测点归属时，不按名称猜测合并。请检查桌面上传状态，或重新导入保留完整元信息的桌面 CSV。</p><ul>{unavailable.map(({ record, reason }) => <li key={record.id}>{record.name} · {record.id.slice(0, 8)}：{reason}</li>)}</ul></details>}
      <div className="blade-pass-advanced-fields"><label><input aria-label="合并片段并计算多点响应" type="checkbox" checked={synthesize} onChange={event => { invalidate(); setSynthesize(event.target.checked); }} />合并片段并计算多点响应</label>{synthesize && <><label>频率下限 Hz<input aria-label="合成频率下限" type="number" min={.1} max={100000} step="any" value={minHz} onChange={event => { invalidate(); setMinHz(event.target.value); }} /></label><label>频率上限 Hz<input aria-label="合成频率上限" type="number" min={.1} max={100000} step="any" value={maxHz} onChange={event => { invalidate(); setMaxHz(event.target.value); }} /></label></>}</div>
      <div className="blade-pass-runbar"><span>已选 <strong>{chosen.length}</strong> / {BLADE_PASS_RECORD_LIMIT} 条记录{chosen.some(bladePassIsDiagnostic) ? " · 含诊断数据" : ""}</span><div><Button type="submit" variant="primary" disabled={!canAnalyze || !chosen.length || loading || busy}>{busy ? "正在筛选有效片段…" : "筛选并分析"}</Button>{busy && <Button type="button" variant="ghost" onClick={invalidate}>取消等待</Button>}</div></div>
    </form>
    {busy && <ChartLoading label="正在筛选有效片段并计算幅值…" />}
    {result && <BladePassResults result={result} />}
  </div>;
}

export function BladePassResults({ result }: { result: BladePassResult }) {
  const [azimuthIndex, setAzimuthIndex] = useState(0), [recordingIndex, setRecordingIndex] = useState(0), [segmentIndex, setSegmentIndex] = useState(0);
  const viewable = result.sources.filter(source => source.rawTimeDomain || source.status === "included" && source.segments.length > 0);
  const distribution = result.amplitudeDistributions[Math.min(azimuthIndex, Math.max(0, result.amplitudeDistributions.length - 1))];
  const source = viewable[Math.min(recordingIndex, Math.max(0, viewable.length - 1))];
  const segment = source?.segments[Math.min(segmentIndex, Math.max(0, (source?.segments.length || 1) - 1))];
  const coverage = result.coverage;
  const retainedSourceSamples = result.sources.reduce((total, item) => total + (item.sourceValidSamples ?? item.validRanges.reduce((count, range) => count + range.samples, 0)), 0);
  const analysisResampled = result.sources.some(item => item.analysisSampling?.resampled || item.originalSampleRate != null && item.sampleRate < item.originalSampleRate);
  const diagnostic = result.hasDiagnostic || result.sources.some(item => item.diagnosticOnly);
  return <div className="blade-pass-results">
    <section className="field-card"><div className="field-section-heading"><div><h2>有效数据汇总{diagnostic && <span className="field-badge amber">诊断分析 · 非有效测量结论</span>}{result.hasSimulation && <span className="field-badge amber">含模拟数据</span>}</h2><p>叶片 {result.bladeId} · 任务 {result.collectionId.slice(0, 8)}</p></div><Button onClick={() => saveBlob(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), `blade-${result.bladeId}-passes.json`)}><Download size={14} />导出结果</Button></div>
      <dl className="blade-pass-metrics"><div><dt>保留原始样本</dt><dd>{retainedSourceSamples.toLocaleString()}<small> / {coverage.rawSamples.toLocaleString()}</small></dd>{analysisResampled && <p className="blade-pass-sampling-note">分析样本 {coverage.validSamples.toLocaleString()}（软件降采样）</p>}</div><div><dt>有效时长</dt><dd>{number(coverage.validSeconds)}<small> s</small></dd></div><div><dt>连续有效段</dt><dd>{coverage.segmentCount}</dd></div><div><dt>纳入 / 排除记录</dt><dd>{coverage.includedRecords}<small> / {coverage.excludedRecords}</small></dd></div></dl>
      {diagnostic && <p className="blade-pass-boundary">纳入 {coverage.includedDiagnosticRecords ?? result.sources.filter(item => item.diagnosticOnly && item.status === "included").length} 条诊断记录：保留经过边界用于分析，信号可能包含定位扰动。当前结果不能作为正式振幅、振型或损伤结论。</p>}
      <p className="blade-pass-boundary">{result.synthesis ? "片段按径向测点汇总，压缩展示保留片段边界；空间曲线为频带响应，跨点相位未知。" : "没有共同相位参考，当前结果为幅值分布，不能据此生成实测振型。"} 所有频谱、频率范围与时长均按记录的实际采样率计算；Web 同步降采样副本会采用设备与服务中设置的目标采样率。</p>
      {result.warnings.length > 0 && <details className="blade-pass-detail"><summary>数据说明 · {result.warnings.length} 项</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </section>
    {result.synthesis && <BladeSynthesisResults synthesis={result.synthesis} />}
    {distribution && <section className="field-card"><div className="field-section-heading"><div><h2>多点幅值分布</h2><p>同一圆周点位下，比较不同径向测点的有效段速度 RMS。</p></div><label className="blade-pass-inline">圆周点位<CustomSelect aria-label="幅值分布圆周点位" value={azimuthIndex} onChange={event => setAzimuthIndex(Number(event.target.value))}>{result.amplitudeDistributions.map((item, index) => <option key={item.azimuthDeg} value={index}>{station(item.azimuthDeg)}</option>)}</CustomSelect></label></div>
      <Chart height={280} label="径向测点速度 RMS 分布，非相位振型" option={{ ...chartBase(), xAxis: { type: "value", name: "测点半径 / m", nameLocation: "middle", nameGap: 30, axisLabel: { hideOverlap: true } }, series: [{ type: "line", showSymbol: true, symbolSize: 7, lineStyle: { type: "dashed" }, data: [...distribution.points].sort((a, b) => a.radiusM - b.radiusM).map(point => [point.radiusM, point.value * 1000]) }] }} />
      <div className="field-table-scroll blade-pass-values"><table className="field-table"><thead><tr><th>测点</th><th>半径 m</th><th>速度 RMS mm/s</th><th>有效样本</th></tr></thead><tbody>{distribution.points.map(point => <tr key={point.radialPointId}><td>{point.radialPointName || point.radialPointId}</td><td>{number(point.radiusM)}</td><td>{number(point.value * 1000)}</td><td>{point.validSamples.toLocaleString()}</td></tr>)}</tbody></table></div>
    </section>}
    {source && <section className="field-card"><div className="field-section-heading"><div><h2>{source.segments.length ? "有效波形与频谱" : "原始波形核对"}</h2><p>每次只展示一条记录；各有效段保留原时间，中间不连线。当前实际分析采样率 {number(source.sampleRate)} Hz，Nyquist 上限 {number(source.sampleRate / 2)} Hz。</p></div><label className="blade-pass-inline">查看记录<CustomSelect aria-label="查看有效波形记录" value={recordingIndex} onChange={event => { setRecordingIndex(Number(event.target.value)); setSegmentIndex(0); }}>{viewable.map((item, index) => <option key={item.recordingId} value={index}>{sourceLabel(item)}{item.status === "excluded" ? " · 已排除" : ""}</option>)}</CustomSelect></label></div>
      {source.reason && <p className="blade-pass-boundary">本记录已排除：{bladePassReason(source.reason)}。原始波形保留供核对。</p>}
      {source.analysisSampling && <p className="blade-pass-note">分析采样率：原记录 {number(source.analysisSampling.sourceSampleRate)} Hz → 实际分析 {number(source.analysisSampling.analysisSampleRate)} Hz{source.analysisSampling.resampled ? "（软件降采样，原始记录不变）" : "（保留原采样率）"}。配置目标 {number(source.analysisSampling.configuredTargetSampleRate)} Hz。</p>}
      {source.sampling && <p className="blade-pass-note">此记录为 Web 同步降采样副本：源采样率 {number(source.sampling.sourceSampleRate)} Hz → 实际分析采样率 {number(source.sampleRate)} Hz；上传目标 {number(source.sampling.targetSampleRate)} Hz，建议最高分析频率 {number(source.sampling.recommendedMaxFrequencyHz)} Hz。源采样率低于目标时会保留源采样率。</p>}
      {source.rawTimeDomain && <Chart height={250} label="原始波形与保留范围对照" option={{ ...chartBase(), xAxis: { type: "value", name: "原始记录时间 / s", nameLocation: "middle", nameGap: 30 },
        series: [{ name: "原始记录", type: "line", showSymbol: false, connectNulls: false, lineStyle: { color: "#94a3b8", width: 1 },
          data: source.rawTimeDomain.seconds.map((seconds, index) => [seconds, source.rawTimeDomain!.values[index] == null ? null : source.rawTimeDomain!.values[index]! * 1000]),
          markArea: { silent: true, itemStyle: { color: "rgba(45,108,192,.12)" }, data: source.validRanges.map(range => [{ xAxis: range.start / (source.originalSampleRate ?? source.sampleRate) }, { xAxis: range.end / (source.originalSampleRate ?? source.sampleRate) }]) } }] }} />}
      {source.rawTimeDomain?.rssiPercent && <Chart height={230} label="原始回波RSSI与保留范围对照" option={{ ...chartBase(), grid: { left: 62, right: 22, top: 30, bottom: 82 }, xAxis: { type: "value", name: "原始时间 / s", nameLocation: "middle", nameGap: 28 }, yAxis: { type: "value", name: "回波 / %" },
        series: [{ name: "RSSI", type: "line", showSymbol: false, connectNulls: false, lineStyle: { color: "#d18a23", width: 1 }, data: source.rawTimeDomain.seconds.map((seconds, index) => [seconds, source.rawTimeDomain!.rssiPercent![index]]),
          markArea: { silent: true, itemStyle: { color: "rgba(45,108,192,.12)" }, data: source.validRanges.map(range => [{ xAxis: range.start / (source.originalSampleRate ?? source.sampleRate) }, { xAxis: range.end / (source.originalSampleRate ?? source.sampleRate) }]) } }] }} />}
      {source.rawTimeDomain && <p className="blade-pass-note">灰色为原始记录，蓝色区域为依据进入、离开事件与筛选条件保留的片段。预览经过抽点，原始文件保持不变。</p>}
      {source.segments.length > 0 ? <>
      <Chart height={270} label="按原始记录时间显示的分段有效波形" option={{ ...chartBase(), xAxis: { type: "value", name: "原始记录时间 / s", nameLocation: "middle", nameGap: 30, axisLabel: { hideOverlap: true } }, series: bladePassWaveSeries(source) }} />
      {source.segments.some(item => item.plotFilter?.flaggedSteps) && <p className="blade-pass-note">绘图遮罩：本记录检测到 {source.segments.reduce((sum, item) => sum + (item.plotFilter?.flaggedSteps ?? 0), 0)} 个异常单步变化，已在预览中留空对应时间桶。原始样本、统计指标和频谱未过滤。</p>}
      <div className="blade-pass-spectrum-heading"><label className="blade-pass-inline">连续有效段<CustomSelect aria-label="FFT 连续有效段" value={segmentIndex} onChange={event => setSegmentIndex(Number(event.target.value))}>{source.segments.map((item, index) => <option key={`${item.start}-${item.end}`} value={index}>第 {index + 1} 段 · {number(item.durationSeconds)} s · {item.samples.toLocaleString()} 样本</option>)}</CustomSelect></label><p>频率间隔 {number(segment?.spectrum?.frequencySpacingHz)} Hz · 短片段不能通过拼接提高频率分辨率</p></div>
      {segment?.spectrum && segment.spectrum.frequencies.length > 0 ? <Chart height={260} label="单个连续有效段的 FFT 速度幅值谱" option={{ ...chartBase(), xAxis: { type: "value", name: "频率 / Hz", nameLocation: "middle", nameGap: 30, axisLabel: { hideOverlap: true } }, series: [{ type: "line", showSymbol: false, data: segment.spectrum.frequencies.map((frequency, index) => [frequency, segment.spectrum!.amplitudes[index] * 1000]) }] }} /> : <p className="blade-pass-empty">此有效段太短，暂不能计算可靠频谱。</p>}
      </> : <p className="blade-pass-empty">没有满足当前边界与筛选条件的有效段，未生成片段频谱。</p>}
    </section>}
    <section className="field-card"><details className="blade-pass-detail"><summary>记录排除与边界追溯 · {result.sources.length} 条</summary><div className="blade-pass-source-details">{result.sources.map(item => <details key={item.recordingId}><summary><span>{sourceLabel(item)}</span><strong className={item.status === "included" ? "included" : "excluded"}>{item.status === "included" ? `纳入 ${item.segments.length} 段` : "已排除"}</strong></summary><div><p>记录：{item.name} · {item.recordingId}</p><p>来源：{item.simulation ? "模拟数据" : item.source === "polytec_ivs500" ? "设备采集" : item.source === "measured" ? "实测导入" : "离线数据（来源待确认）"}</p><p>实际分析采样率：{number(item.sampleRate)} Hz{item.sampling ? `（上传目标 ${number(item.sampling.targetSampleRate)} Hz；源 ${number(item.sampling.sourceSampleRate)} Hz）` : "（按原记录或导入文件）"}</p>{item.reason && <p>排除原因：{bladePassReason(item.reason)}</p>}<p>数据类型：{item.diagnosticOnly ? "诊断模式来源，尚未确认为有效测量" : "常规采集"}</p>{item.boundaryBasis && <p>边界时钟：{item.boundaryBasis.sampleClock} · 原记录起始偏移 {item.boundaryBasis.sourceOffset.toLocaleString()} 样本</p>}<p>候选样本范围：{item.candidateRange ? `[${item.candidateRange.start}, ${item.candidateRange.end})` : "未确认"}</p><p>有效范围：{item.validRanges.length ? item.validRanges.map(range => `[${range.start}, ${range.end}) · ${range.samples} 样本`).join("；") : "无"}</p>{item.exclusions.length > 0 && <ul>{item.exclusions.map((exclusion, index) => <li key={index}>{bladePassReason(exclusion.reason)} · {exclusion.samples.toLocaleString()} 样本</li>)}</ul>}{item.provenance != null && <details><summary>原始边界依据</summary><pre>{JSON.stringify(item.provenance, null, 2)}</pre></details>}</div></details>)}</div></details></section>
  </div>;
}
