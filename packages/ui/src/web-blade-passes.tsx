"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Layers3 } from "lucide-react";
import { api, saveBlob } from "./api";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { Chart } from "./charts";
import { ChartLoading } from "./chart-loading";
import { BladeSynthesisResults } from "./web-blade-synthesis";
import { BLADE_PASS_RECORD_LIMIT, bladePassMetadata, bladePassNumber as number, bladePassReason, bladePassTasks, bladePassUnavailableReason, bladePassWaveSeries, preferredBladePassTask, selectedBladePassRecords,
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
  const [detrend, setDetrend] = useState("constant"), [rssi, setRssi] = useState("");
  const [synthesize, setSynthesize] = useState(true), [minHz, setMinHz] = useState("20"), [maxHz, setMaxHz] = useState("2000");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BladePassResult | null>(null);
  const listTicket = useRef(0), calculationTicket = useRef(0), selection = useRef({ taskKey, selected });
  const errorHandler = useRef(onError); errorHandler.current = onError;
  selection.current = { taskKey, selected };
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
      setSelected(next?.records.slice(0, BLADE_PASS_RECORD_LIMIT).map(record => record.id) ?? []);
    } catch (cause) { if (ticket === listTicket.current) errorHandler.current(cause); }
    finally { if (ticket === listTicket.current) setLoading(false); }
  }, [invalidate, preferredKey, localData]);
  useEffect(() => { void refresh(); return () => { listTicket.current++; calculationTicket.current++; }; }, [refresh, refreshKey]);
  useEffect(() => { if (!canAnalyze) invalidate(); }, [canAnalyze, invalidate]);
  const pointOptions = useMemo(() => {
    const points = new Map<string, { id: string; name: string; radius: number | undefined; records: BladePassRecording[] }>();
    for (const record of task?.records ?? []) {
      const metadata = bladePassMetadata(record)!; const id = metadata.radialPointId!;
      const current = points.get(id);
      if (current) current.records.push(record);
      else points.set(id, { id, name: metadata.radialPointName || id, radius: metadata.radiusM, records: [record] });
    }
    return [...points.values()].sort((a, b) => (a.radius ?? Infinity) - (b.radius ?? Infinity));
  }, [task]);
  function selectTask(key: string) {
    invalidate(); setTaskKey(key); setSelected(tasks.find(item => item.key === key)?.records.slice(0, BLADE_PASS_RECORD_LIMIT).map(record => record.id) ?? []);
  }
  function selectRecords(ids: string[], checked: boolean) {
    invalidate(); setSelected(current => checked ? [...new Set([...current, ...ids])].slice(0, BLADE_PASS_RECORD_LIMIT) : current.filter(id => !ids.includes(id)));
  }
  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (!canAnalyze || !chosen.length || loading || busy) return;
    const rssiThresholdPercent = rssi.trim() === "" ? undefined : Number(rssi);
    if (rssiThresholdPercent !== undefined && (!Number.isFinite(rssiThresholdPercent) || rssiThresholdPercent < 0 || rssiThresholdPercent > 100)) { onError(new Error("RSSI 阈值应在 0～100% 之间。")); return; }
    if (synthesize && (!Number.isFinite(Number(minHz)) || !Number.isFinite(Number(maxHz)) || Number(minHz) < .1 || Number(maxHz) <= Number(minHz) || Number(maxHz) > 100000)) { onError(new Error("合成频率范围应满足 0.1 ≤ 下限 < 上限 ≤ 100000 Hz。")); return; }
    const ticket = ++calculationTicket.current; setBusy(true); setResult(null);
    try {
      const parameters = {
        recordingIds: chosen.map(record => record.id), detrend, ...(rssiThresholdPercent === undefined ? {} : { rssiThresholdPercent }),
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
      <div className="blade-pass-toolbar"><label>任务与叶片<CustomSelect aria-label="任务与叶片" value={taskKey} disabled={loading || !tasks.length} onChange={event => selectTask(event.target.value)}>
        {!tasks.length && <option value="">{loading ? "正在加载记录…" : "暂无完整点位记录"}</option>}
        {tasks.map(item => <option key={item.key} value={item.key}>{item.name} · 叶片 {item.bladeId} · {item.collectionId.slice(0, 8)}</option>)}
      </CustomSelect></label><div className="blade-pass-selection"><strong>{chosen.length}</strong> / {BLADE_PASS_RECORD_LIMIT} 条记录</div><Button type="submit" variant="primary" disabled={!canAnalyze || !chosen.length || loading || busy}>{busy ? "正在筛选有效片段…" : "筛选并分析"}</Button>{busy && <Button type="button" variant="ghost" onClick={invalidate}>取消等待</Button>}</div>
      {!canAnalyze && <p className="blade-pass-note">当前账号可查看记录，运行分析需要分析权限。</p>}
      {!loading && !tasks.length && <p className="blade-pass-empty">{localData ? "本机尚无带完整叶片、测点和经过边界信息的采集记录。完成自动点位采集后，点击刷新记录。" : "等待桌面端上传完整点位记录，或导入桌面端导出的完整 CSV。文件需保留任务、叶片、测点与进入/离开信息。"}</p>}
      {unavailable.length > 0 && <details className="blade-pass-detail"><summary>{unavailable.length} 条点位记录暂不能用于此分析</summary><p className="blade-pass-note">旧记录缺少任务、叶片或测点归属时，不按名称猜测合并。请检查桌面上传状态，或重新导入保留完整元信息的桌面 CSV。</p><ul>{unavailable.map(({ record, reason }) => <li key={record.id}>{record.name} · {record.id.slice(0, 8)}：{reason}</li>)}</ul></details>}
      {task && <>
        <fieldset className="blade-pass-points"><legend>选择径向测点</legend>{pointOptions.map(point => {
          const count = point.records.filter(record => selected.includes(record.id)).length;
          return <label key={point.id} className={count ? "selected" : ""}><input type="checkbox" aria-label={`选择测点 ${point.name}`} checked={count > 0} disabled={!count && chosen.length >= BLADE_PASS_RECORD_LIMIT} onChange={event => selectRecords(point.records.map(record => record.id), event.target.checked)} /><span><strong>{point.name}</strong><small>半径 {number(point.radius)} m · 已选 {count}/{point.records.length} 条</small></span></label>;
        })}</fieldset>
        <details className="blade-pass-records"><summary>批次与点位记录 · 已选 {chosen.length} / {task.records.length}</summary><div className="field-table-scroll"><table className="field-table"><thead><tr><th>选择</th><th>测点 / 批次</th><th>点位 / 轮次</th><th>原始样本</th><th>经过状态</th></tr></thead><tbody>{task.records.map(record => {
          const metadata = bladePassMetadata(record)!; const checked = selected.includes(record.id);
          const labels: Record<string, string> = { confirmed_pass: "已记录进入与离开", unconfirmed_pass: "完整性待确认", missing_entry: "缺少进入", missing_exit: "缺少离开", signal_gap: "回波中断", cancelled: "已取消", device_error: "设备异常" };
          return <tr key={record.id}><td><input type="checkbox" aria-label={`选择记录 ${record.id}`} checked={checked} disabled={!checked && chosen.length >= BLADE_PASS_RECORD_LIMIT} onChange={event => selectRecords([record.id], event.target.checked)} /></td><td><strong>{metadata.radialPointName || metadata.radialPointId}</strong><small>{metadata.sessionId?.slice(0, 8) || "批次未知"} · {record.id.slice(0, 8)}</small></td><td>{station(metadata.azimuthDeg)} · 第 {metadata.lapIndex ?? "—"} 轮</td><td>{record.samples.toLocaleString()}<small>{number(record.sampleRate)} Hz</small></td><td>{labels[metadata.completion || ""] || "边界待校验"}</td></tr>;
        })}</tbody></table></div></details>
        {task.records.length > BLADE_PASS_RECORD_LIMIT && <p className="blade-pass-note">一次最多分析 64 条记录；可在批次与点位中调整选择。</p>}
      </>}
      <div className="blade-pass-advanced-fields"><label><input aria-label="合并片段并合成振型候选" type="checkbox" checked={synthesize} onChange={event => { invalidate(); setSynthesize(event.target.checked); }} />合并片段并合成振型候选</label>{synthesize && <><label>频率下限 Hz<input aria-label="合成频率下限" type="number" min={.1} max={100000} step="any" value={minHz} onChange={event => { invalidate(); setMinHz(event.target.value); }} /></label><label>频率上限 Hz<input aria-label="合成频率上限" type="number" min={.1} max={100000} step="any" value={maxHz} onChange={event => { invalidate(); setMaxHz(event.target.value); }} /></label></>}</div>
      <details className="blade-pass-advanced"><summary>筛选与预处理设置</summary><div className="blade-pass-advanced-fields"><label>预处理<CustomSelect value={detrend} onChange={event => { invalidate(); setDetrend(event.target.value); }}><option value="constant">去均值</option><option value="linear">去线性趋势</option><option value="none">不去趋势</option></CustomSelect></label><label>RSSI 下限 · %<input aria-label="RSSI 下限百分比" type="number" min={0} max={100} step="any" placeholder="不设强度阈值" value={rssi} onChange={event => { invalidate(); setRssi(event.target.value); }} /></label></div><p className="blade-pass-note">保留原始时间和片段间隙，频谱按单个连续有效段计算。更改设置后需重新分析。</p></details>
    </form>
    {busy && <ChartLoading label="正在筛选有效片段并计算幅值…" />}
    {result && <BladePassResults result={result} />}
  </div>;
}

export function BladePassResults({ result }: { result: BladePassResult }) {
  const [azimuthIndex, setAzimuthIndex] = useState(0), [recordingIndex, setRecordingIndex] = useState(0), [segmentIndex, setSegmentIndex] = useState(0);
  const included = result.sources.filter(source => source.status === "included" && source.segments.length > 0);
  const distribution = result.amplitudeDistributions[Math.min(azimuthIndex, Math.max(0, result.amplitudeDistributions.length - 1))];
  const source = included[Math.min(recordingIndex, Math.max(0, included.length - 1))];
  const segment = source?.segments[Math.min(segmentIndex, Math.max(0, (source?.segments.length || 1) - 1))];
  const coverage = result.coverage;
  return <div className="blade-pass-results">
    <section className="field-card"><div className="field-section-heading"><div><h2>有效数据汇总{result.hasSimulation && <span className="field-badge amber">含模拟数据</span>}</h2><p>叶片 {result.bladeId} · 任务 {result.collectionId.slice(0, 8)}</p></div><Button onClick={() => saveBlob(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), `blade-${result.bladeId}-passes.json`)}><Download size={14} />导出结果</Button></div>
      <dl className="blade-pass-metrics"><div><dt>有效样本</dt><dd>{coverage.validSamples.toLocaleString()}<small> / {coverage.rawSamples.toLocaleString()}</small></dd></div><div><dt>有效时长</dt><dd>{number(coverage.validSeconds)}<small> s</small></dd></div><div><dt>连续有效段</dt><dd>{coverage.segmentCount}</dd></div><div><dt>纳入 / 排除记录</dt><dd>{coverage.includedRecords}<small> / {coverage.excludedRecords}</small></dd></div></dl>
      <p className="blade-pass-boundary">{result.synthesis ? "片段已按径向测点合并；频带空间曲线为实验候选，实测跨点相位仍未知。" : "没有共同相位参考，当前结果为幅值分布，不能据此生成实测振型。"} 所有频谱、频率范围与时长均按记录的实际采样率计算；Web 同步降采样副本会采用设备与服务中设置的目标采样率。</p>
      {result.warnings.length > 0 && <details className="blade-pass-detail"><summary>数据说明 · {result.warnings.length} 项</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </section>
    {result.synthesis && <BladeSynthesisResults synthesis={result.synthesis} />}
    {distribution && <section className="field-card"><div className="field-section-heading"><div><h2>多点幅值分布</h2><p>同一圆周点位下，比较不同径向测点的有效段速度 RMS。</p></div><label className="blade-pass-inline">圆周点位<CustomSelect aria-label="幅值分布圆周点位" value={azimuthIndex} onChange={event => setAzimuthIndex(Number(event.target.value))}>{result.amplitudeDistributions.map((item, index) => <option key={item.azimuthDeg} value={index}>{station(item.azimuthDeg)}</option>)}</CustomSelect></label></div>
      <Chart height={280} label="径向测点速度 RMS 分布，非相位振型" option={{ ...chartBase(), xAxis: { type: "value", name: "测点半径 / m", nameLocation: "middle", nameGap: 30, axisLabel: { hideOverlap: true } }, series: [{ type: "line", showSymbol: true, symbolSize: 7, lineStyle: { type: "dashed" }, data: [...distribution.points].sort((a, b) => a.radiusM - b.radiusM).map(point => [point.radiusM, point.value * 1000]) }] }} />
      <div className="field-table-scroll blade-pass-values"><table className="field-table"><thead><tr><th>测点</th><th>半径 m</th><th>速度 RMS mm/s</th><th>有效样本</th></tr></thead><tbody>{distribution.points.map(point => <tr key={point.radialPointId}><td>{point.radialPointName || point.radialPointId}</td><td>{number(point.radiusM)}</td><td>{number(point.value * 1000)}</td><td>{point.validSamples.toLocaleString()}</td></tr>)}</tbody></table></div>
    </section>}
    {source && <section className="field-card"><div className="field-section-heading"><div><h2>有效波形与频谱</h2><p>每次只展示一条记录；各有效段保留原时间，中间不连线。当前实际分析采样率 {number(source.sampleRate)} Hz，Nyquist 上限 {number(source.sampleRate / 2)} Hz。</p></div><label className="blade-pass-inline">查看记录<CustomSelect aria-label="查看有效波形记录" value={recordingIndex} onChange={event => { setRecordingIndex(Number(event.target.value)); setSegmentIndex(0); }}>{included.map((item, index) => <option key={item.recordingId} value={index}>{sourceLabel(item)}</option>)}</CustomSelect></label></div>
      {source.sampling && <p className="blade-pass-note">此记录为 Web 同步降采样副本：源采样率 {number(source.sampling.sourceSampleRate)} Hz → 实际分析采样率 {number(source.sampleRate)} Hz；上传目标 {number(source.sampling.targetSampleRate)} Hz，建议最高分析频率 {number(source.sampling.recommendedMaxFrequencyHz)} Hz。源采样率低于目标时会保留源采样率。</p>}
      <Chart height={270} label="按原始记录时间显示的分段有效波形" option={{ ...chartBase(), xAxis: { type: "value", name: "原始记录时间 / s", nameLocation: "middle", nameGap: 30, axisLabel: { hideOverlap: true } }, series: bladePassWaveSeries(source) }} />
      {source.segments.some(item => item.plotFilter?.flaggedSteps) && <p className="blade-pass-note">绘图遮罩：本记录检测到 {source.segments.reduce((sum, item) => sum + (item.plotFilter?.flaggedSteps ?? 0), 0)} 个异常单步变化，已在预览中留空对应时间桶。原始样本、统计指标和频谱未过滤。</p>}
      <div className="blade-pass-spectrum-heading"><label className="blade-pass-inline">连续有效段<CustomSelect aria-label="FFT 连续有效段" value={segmentIndex} onChange={event => setSegmentIndex(Number(event.target.value))}>{source.segments.map((item, index) => <option key={`${item.start}-${item.end}`} value={index}>第 {index + 1} 段 · {number(item.durationSeconds)} s · {item.samples.toLocaleString()} 样本</option>)}</CustomSelect></label><p>频率间隔 {number(segment?.spectrum?.frequencySpacingHz)} Hz · 短片段不能通过拼接提高频率分辨率</p></div>
      {segment?.spectrum && segment.spectrum.frequencies.length > 0 ? <Chart height={260} label="单个连续有效段的 FFT 速度幅值谱" option={{ ...chartBase(), xAxis: { type: "value", name: "频率 / Hz", nameLocation: "middle", nameGap: 30, axisLabel: { hideOverlap: true } }, series: [{ type: "line", showSymbol: false, data: segment.spectrum.frequencies.map((frequency, index) => [frequency, segment.spectrum!.amplitudes[index] * 1000]) }] }} /> : <p className="blade-pass-empty">此有效段太短，暂不能计算可靠频谱。</p>}
    </section>}
    <section className="field-card"><details className="blade-pass-detail"><summary>记录排除与边界追溯 · {result.sources.length} 条</summary><div className="blade-pass-source-details">{result.sources.map(item => <details key={item.recordingId}><summary><span>{sourceLabel(item)}</span><strong className={item.status === "included" ? "included" : "excluded"}>{item.status === "included" ? `纳入 ${item.segments.length} 段` : "已排除"}</strong></summary><div><p>记录：{item.name} · {item.recordingId}</p><p>来源：{item.simulation ? "模拟数据" : item.source === "polytec_ivs500" ? "设备采集" : item.source === "measured" ? "实测导入" : "离线数据（来源待确认）"}</p><p>实际分析采样率：{number(item.sampleRate)} Hz{item.sampling ? `（上传目标 ${number(item.sampling.targetSampleRate)} Hz；源 ${number(item.sampling.sourceSampleRate)} Hz）` : "（按原记录或导入文件）"}</p>{item.reason && <p>排除原因：{bladePassReason(item.reason)}</p>}<p>候选样本范围：{item.candidateRange ? `[${item.candidateRange.start}, ${item.candidateRange.end})` : "未确认"}</p><p>有效范围：{item.validRanges.length ? item.validRanges.map(range => `[${range.start}, ${range.end}) · ${range.samples} 样本`).join("；") : "无"}</p>{item.exclusions.length > 0 && <ul>{item.exclusions.map((exclusion, index) => <li key={index}>{bladePassReason(exclusion.reason)} · {exclusion.samples.toLocaleString()} 样本</li>)}</ul>}{item.provenance != null && <details><summary>原始边界依据</summary><pre>{JSON.stringify(item.provenance, null, 2)}</pre></details>}</div></details>)}</div></details></section>
  </div>;
}
