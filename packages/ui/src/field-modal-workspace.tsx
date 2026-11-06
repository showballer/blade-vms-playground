"use client";
import React, { useEffect, useMemo, useState } from "react";
import { Activity, Info, LoaderCircle, Play, RefreshCw } from "lucide-react";
import { Button, Card, CustomSelect } from "./common";
import { FieldModalCapture } from "./field-modal-capture";
import { FieldModalImport } from "./field-modal-import";
import { Chart } from "./charts";
import type { FieldRecording, FieldRequestOptions } from "./field-types";

type Request = <T>(options: FieldRequestOptions) => Promise<T>;
type Props = {
  view: "capture" | "analysis";
  recordings: FieldRecording[];
  request: Request;
  onStartCapture: (config: { name: string; point: string }) => void;
  captureDisabledReason?: string;
  canAnalyze?: boolean;
  allowImport?: boolean;
};
type ModalResult = { job: any; result: any };
const previewBatchId = "numerical-sample-20261106";

const methodDetails = [
  { id: "decay", name: "自由衰减", requirement: "单点连续响应；记录激励撤除后的自由衰减过程。" },
  { id: "frf", name: "FRF 半功率带宽", requirement: "同步采集校准的激励力与一个响应通道，计算频响及相干性。" },
  { id: "ssi_cov", name: "工作模态 SSI-COV", requirement: "至少两个同步响应通道及环境激励记录；先后扫描的点位不构成同步通道。" },
] as const;

function lineOption(series: any[], xName: string, yName: string) {
  return {
    animation: false,
    color: ["#1769aa", "#d47915", "#688f52"],
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 70, right: 24, top: 36, bottom: 48 },
    xAxis: { type: "value", name: xName, nameLocation: "middle", nameGap: 30 },
    yAxis: { type: "value", name: yName, nameLocation: "middle", nameGap: 52, splitLine: { lineStyle: { color: "#e5e9ec" } } },
    series,
  };
}
function pairs(x: number[] = [], y: number[] = []) { return x.map((v, i) => [v, y[i] ?? null]); }
function timestamp(value: string | number) {
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN");
}

export function FieldModalWorkspace({ view, recordings, request, onStartCapture, captureDisabledReason = "", canAnalyze = true, allowImport = false }: Props) {
  const [method, setMethod] = useState<"decay" | "frf" | "ssi_cov">("decay");
  const [recordingId, setRecordingId] = useState(previewBatchId);
  const [taskName, setTaskName] = useState(() => `叶片静止模态试验-${new Date().toLocaleDateString("sv-SE")}`);
  const [point, setPoint] = useState("P1");
  const [releaseTime, setReleaseTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [releaseNote, setReleaseNote] = useState("");
  const [stationaryNote, setStationaryNote] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ModalResult | null>(null);
  const [error, setError] = useState("");
  const [sampleMeta, setSampleMeta] = useState<any>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [catalog, setCatalog] = useState<any>({ datasets: [], jobs: [] });
  const [savedNotice, setSavedNotice] = useState('');
  const [captureActive, setCaptureActive] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  async function refreshCatalog() {
    setCatalogBusy(true);
    try { const data = await request<any>({ action: 'formalModal', request: { operation: 'catalog' } }); setCatalog({ datasets: data.datasets || [], jobs: data.jobs || [] }); }
    catch (e) { setError((e as Error).message); }
    finally { setCatalogBusy(false); }
  }
  useEffect(() => { void refreshCatalog(); }, [request, view]);
  const imported = catalog.datasets.find((d: any) => 'dataset:' + d.id === recordingId);
  const history = catalog.jobs.filter((j: any) => j.datasetId === imported?.id && j.method === method && j.status === 'complete');


  const available = useMemo(() => recordings
    .filter(record => record.status === "complete" && record.object === "叶片静止模态试验" && record.source !== "simulation" && !record.simulation)
    .sort((a, b) => {
      const time = (value: string | number) => typeof value === "number" ? value : Date.parse(value) / 1000;
      return time(b.startedAt) - time(a.startedAt);
    }), [recordings]);
  const selected = available.find(record => record.id === recordingId);
  const isNumerical = recordingId === previewBatchId;
  const modalEligible = selected?.object === "叶片静止模态试验";
  useEffect(() => {
    if (isNumerical || recordingId.startsWith("dataset:") || recordingId && available.some(record => record.id === recordingId)) return;
    setRecordingId(previewBatchId);
  }, [available, recordingId]);

  useEffect(() => {
    let stale = false;
    setPreview(null); setResult(null); setSampleMeta(null); setError(""); setPreviewBusy(false);
    if (view !== "analysis") return;
    if (isNumerical) {
      setPreviewBusy(true);
      import("./modal-preview-data").then(({ modalPreviewData }) => {
        if (stale) return;
        const sample = modalPreviewData[method];
        setSampleMeta(sample); setPreview(sample.waveform);
        setResult({ job: { id: previewBatchId, method }, result: sample.result });
      }).catch(cause => { if (!stale) setError(cause instanceof Error ? cause.message : "读取数值样本失败"); })
        .finally(() => { if (!stale) setPreviewBusy(false); });
      return () => { stale = true; };
    }
    if (imported) {
      setPreviewBusy(true);
      request<any>({ action: 'formalModal', request: { operation: 'preview', parameters: { datasetId: imported.id } } })
        .then(data => { if (!stale) setPreview(data); })
        .catch(e => { if (!stale) setError(e.message); }).finally(() => { if (!stale) setPreviewBusy(false); });
      return () => { stale = true; };
    }
    if (!selected) return;
    setPreviewBusy(true);
    request<any>({ action: "waveform", id: selected.id }).then(data => {
      if (!stale) setPreview(data.waveform);
    }).catch(cause => {
      if (!stale) setError(cause instanceof Error ? cause.message : "读取原始波形失败");
    }).finally(() => { if (!stale) setPreviewBusy(false); });
    return () => { stale = true; };
  }, [view, isNumerical, selected?.id, imported?.id, request, method, previewRevision]);

  const previewOption = useMemo(() => {
    if (preview?.channels) {
      const channels = preview.channels;
      return { ...lineOption(channels.map((channel: any) => ({ name: channel.pointId + ' · ' + (channel.unit || 'm/s'), type: "line", yAxisIndex: channel.quantity === 'force' ? 1 : 0, showSymbol: false, data: pairs(preview.time_s, channel.values) })), isNumerical ? "模型时间 / s" : "采集时间 / s", "响应"),
        yAxis: [{ type: 'value', name: '响应 / ' + (channels.find((c: any) => c.quantity !== 'force')?.unit || 'm/s') }, { type: 'value', name: '力 / N', splitLine: { show: false }, show: channels.some((c: any) => c.quantity === 'force') }] };
    }
    if (!preview?.values?.length) return lineOption([], "采样点", "速度 / (m/s)");
    const stride = preview.sampleStride || 1;
    return lineOption([{ name: "实测速度", type: "line", showSymbol: false, data: preview.values.map((v: number, i: number) => [(preview.rangeStart || 0) + i * stride, v]) }], "原始样本序号", `速度 / ${preview.unit || "m/s"}`);
  }, [preview, isNumerical]);

  const resultCharts = useMemo(() => {
    const evidence = result?.result?.evidence;
    if (!evidence) return [];
    if (result.result.method === "frf") return [
      { id: "frf-fit", title: "H1 频响函数与半功率带宽", option: lineOption([
        { name: "H1 FRF", type: "line", showSymbol: false, data: pairs(evidence.frequencyHz, evidence.frfMagnitude) },
        { name: "物理模型拟合", type: "line", showSymbol: false, data: pairs(evidence.fitFrequencyHz, evidence.fitMagnitude) },
        { name: "半功率交点", type: "line", data: (evidence.halfPowerCrossingsHz || []).map((v: number) => [v, evidence.halfPowerLevel]) },
      ], "频率 / Hz", `FRF / ${result.result.parameters?.responseQuantity === "displacement" ? "m/N" : result.result.parameters?.responseQuantity === "acceleration" ? "(m/s²)/N" : "(m/s)/N"}`) },
      { id: "frf-coherence", title: "激励力与响应相干性", option: { ...lineOption([{ name: "相干性", type: "line", showSymbol: false, data: pairs(evidence.frequencyHz, evidence.coherence) }], "频率 / Hz", "相干性 γ²"), yAxis: { type: "value", min: 0, max: 1.05, name: "相干性 γ²" } } },
    ];
    if (result.result.method === "ssi_cov") {
      const poles = evidence.candidatePoles || [];
      return [
        { id: "ssi-stability", title: "SSI-COV 频率稳定图", option: lineOption([
          { name: "稳定极点", type: "scatter", data: poles.filter((p: any) => p.stable).map((p: any) => [p.naturalFrequencyHz, p.order]) },
          { name: "未稳定极点", type: "scatter", data: poles.filter((p: any) => !p.stable).map((p: any) => [p.naturalFrequencyHz, p.order]) },
        ], "频率 / Hz", "模型阶次") },
        { id: "ssi-singular", title: "协方差 Hankel 奇异值", option: lineOption([{ name: "奇异值", type: "line", data: (evidence.singularValues || []).map((v: number, i: number) => [i + 1, v]) }], "序号", "奇异值") },
        { id: "ssi-damping", title: "SSI-COV 阻尼稳定图", option: lineOption([{ name: "候选极点", type: "scatter", data: poles.filter((p: any) => !p.exclusionReason).map((p: any) => [p.naturalFrequencyHz, p.dampingRatio * 100]) }], "固有频率 / Hz", "阻尼比 / %") },
        ...result.result.modes.filter((m: any) => m.shape).map((m: any, i: number) => ({ id: `ssi-shape-${i}`, title: `${m.demoModelMatch?.startsWith("噪声") ? "候选极点振型（待复核）" : "归一化复振型"} · ${Number(m.naturalFrequencyHz).toFixed(3)} Hz`, option: {
          ...lineOption([
            { name: "实部", type: "line", data: m.shape.nodes.map((v: any) => v.real) },
            { name: "虚部", type: "line", data: m.shape.nodes.map((v: any) => v.imag) },
          ], "测点", "归一化响应"),
          xAxis: { type: "category", name: "测点", data: m.shape.nodes.map((v: any) => v.pointId) },
        } })),
      ];
    }
    const responseUnit = evidence.inputChannel?.unit || "m/s";
    return [
      { id: "decay-fit", title: "响应与衰减拟合", option: lineOption([
        { name: isNumerical ? "合成响应" : "实测响应", type: "line", showSymbol: false, data: pairs(evidence.time_s, evidence.response) },
        { name: "单模态拟合", type: "line", showSymbol: false, lineStyle: { type: "dashed" }, data: pairs(evidence.time_s, evidence.fittedResponse) },
      ], "试验时间 / s", `响应 / ${responseUnit}`) },
      { id: "decay-envelope", title: "同相峰值与对数包络", option: lineOption([
        { name: "同相峰值", type: "scatter", data: pairs(evidence.peakTime_s, evidence.peakAmplitude?.map((v: number) => Math.log(v))) },
        { name: "回归拟合", type: "line", showSymbol: false, data: pairs(evidence.peakTime_s, evidence.fittedLogAmplitude) },
      ], "试验时间 / s", `ln(幅值 / 1 ${responseUnit})`) },
      { id: "decay-residual", title: "包络拟合残差", option: lineOption([
        { name: "对数残差", type: "scatter", data: pairs(evidence.peakTime_s, evidence.logResidual) },
      ], "试验时间 / s", "对数残差") },
    ];
  }, [result, isNumerical]);

  async function analyze() {
    if (imported) {
      setBusy(true); setResult(null); setError('');
      try {
        setResult(await request<ModalResult>({ action: 'formalModal', request: { operation: 'start', parameters: { datasetId: imported.id, method } } }));
        await refreshCatalog();
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      return;
    }
    if (method !== 'decay') { setError('请选择包含所需同步通道的采集批次；可在“模态采集”导入 CSV / JSON。'); return; }

    if (!selected || !modalEligible) { setError("自由衰减识别仅接受本页采集的叶片静止模态试验记录。"); return; }
    const release = Number(releaseTime), end = endTime ? Number(endTime) : undefined;
    if (!releaseTime.trim() || !Number.isFinite(release) || release < 0 || end !== undefined && (!Number.isFinite(end) || end <= release)) {
      setError("请填写有效的激励撤除时刻和分析结束时刻。"); return;
    }
    if (!releaseNote.trim() || !stationaryNote.trim()) { setError("请记录叶片静止条件和激励撤除过程，便于追溯试验输入。"); return; }
    setBusy(true); setResult(null); setError("");
    try {
      const dataset = await request<any>({ action: "formalModal", request: { operation: "from-recording", parameters: {
        recordingId: selected.id, startSeconds: release, ...(end !== undefined ? { endSeconds: end } : {}),
        evidence: { excitationRemoved: true, excitationRemovalSource: `${releaseNote.trim()}；叶片边界：${stationaryNote.trim()}` },
        name: selected.name,
      } } });
      const analyzed = await request<ModalResult>({ action: "formalModal", request: { operation: "start", parameters: { datasetId: dataset.id, method: "decay" } } });
      setResult(analyzed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模态识别失败");
    } finally { setBusy(false); }
  }

  return <div className="stack field-modal-workspace">
    {view === "capture" && <><Card title="试验方式">
      <div className="field-modal-methods">{methodDetails.map(item => <button key={item.id} className={method === item.id ? 'active' : ''} aria-pressed={method === item.id} disabled={captureActive} onClick={() => { setMethod(item.id); setSavedNotice(''); }}><strong>{item.name}</strong><span>{item.requirement}</span></button>)}</div>
      <p>{method === 'decay' ? '固定叶片，对测点施加小幅激励并撤除，连续记录足够多个衰减周期。' : method === 'frf' ? '固定叶片，同步记录经标定的锤击力或激振器力及响应。保留激励前背景和完整响应，多次重复以检查一致性。' : '在近似平稳环境激励下同步连续记录多个点，保留各点方向、统一采样率及公共时钟。先后扫描的数据不能代替同步数据。'}</p>
    </Card>
    </>}
    {view === "capture" && method === "decay" && <Card title="模态试验采集">
      <div className="field-modal-capture-fields">
        <label>试验任务<input value={taskName} maxLength={120} onChange={event => setTaskName(event.target.value)} /></label>
        <label>测点<CustomSelect value={point} onChange={event => setPoint(event.target.value)}>{["P1", "P2", "P3", "P4", "P5"].map(value => <option key={value}>{value}</option>)}</CustomSelect></label>
        <p>当前设备按单点连续速度通道采集。先锁止叶片并对准测点，再启动连续记录；对叶片施加一次可控的小幅激励并撤除，记录撤除时刻，待自由衰减信号记录充分后停止并保存。</p>
      </div>
      <div className="field-modal-capture-actions">
        <Button variant="primary" disabled={busy || !taskName.trim() || !!captureDisabledReason} title={captureDisabledReason || undefined} onClick={() => onStartCapture({ name: taskName.trim(), point })}><Play size={15} />开始单点采集</Button>
        {captureDisabledReason && <span className="muted">{captureDisabledReason}</span>}
      </div>
    </Card>}
    {view === "capture" && method !== "decay" && <FieldModalCapture key={method} method={method} request={request} onActive={setCaptureActive} onSaved={dataset => { setSavedNotice('已保存批次：' + dataset.name + '；请到“模态识别”选择该批次分析。'); void refreshCatalog(); }} />}
    {view === "capture" && <>
      {savedNotice && <p role="status">{savedNotice}</p>}
      <details className="field-modal-provenance"><summary>已有采集文件？导入历史批次</summary><FieldModalImport request={request} method={method} onSaved={dataset => { setSavedNotice('已保存批次：' + dataset.name + '；请到“模态识别”选择该批次分析。'); void refreshCatalog(); }} /></details>
    </>}


    {view === "analysis" && <>
    <Card className="field-modal-preview-card" title="分析批次与原始响应" tools={<Button disabled={previewBusy || !selected && !imported && !isNumerical} onClick={() => { void refreshCatalog(); setPreviewRevision(v => v + 1); }}><RefreshCw size={14} />刷新波形</Button>}>
      <div className="field-modal-preview-details">
      <div className="field-modal-batch-fields">
        <label><span className="field-modal-batch-label">数据批次{(catalogBusy || previewBusy) && <span role="status"><LoaderCircle size={14} className="spin" />加载中</span>}</span><CustomSelect aria-label="数据批次" searchable searchPlaceholder="搜索测量任务或批次" disabled={busy} value={recordingId} onChange={event => { setRecordingId(event.target.value); setResult(null); const input = catalog.datasets.find((d: any) => 'dataset:' + d.id === event.target.value); setMethod(input ? input.sourceReference?.method || (input.channels.some((c: any) => c.quantity === 'force') ? 'frf' : input.channels.length > 1 ? 'ssi_cov' : 'decay') : 'decay'); setReleaseTime(""); setEndTime(""); setReleaseNote(""); setStationaryNote(""); }}>
          <option value={previewBatchId}>武川风场 R025 风机测量任务</option>
          {catalog.datasets.map((d: any) => <option key={d.id} value={'dataset:' + d.id}>{d.name} · {d.channels.length} 通道 · {timestamp(d.createdAt)}</option>)}
          {available.map(record => <option key={record.id} value={record.id}>{record.name} · {record.point || "未标注测点"} · {timestamp(record.startedAt)}</option>)}
        </CustomSelect></label>
        {selected && <div className="field-modal-batch-meta"><span>{selected.samples.toLocaleString("zh-CN")} 点</span><span>{selected.sampleRate?.toLocaleString("zh-CN") || "未知"} Hz</span><span>{selected.sampleRate ? (selected.samples / selected.sampleRate).toFixed(2) : "—"} s</span><span>{selected.point || point}</span><span>{selected.source === "split_segment_import" ? "导入分段记录" : "本机设备记录"}</span></div>}
      </div>
      {imported && <div className="field-modal-batch-meta"><span>{imported.samples.toLocaleString()} 点</span><span>{imported.sampleRateHz.toFixed(3)} Hz</span><span>{imported.durationSeconds.toFixed(2)} s</span><span>{imported.channels.map((c: any) => `${c.pointId} · ${c.quantity} · ${c.unit} · ${c.direction}`).join('；')}</span></div>}
      {isNumerical && <p className="field-modal-empty">计算样本 · 包含自由衰减、力与响应、五测点同步响应三类输入。</p>}
      {isNumerical && sampleMeta && <div className="field-modal-batch-meta"><span>原始输入 {sampleMeta.originalSamples.toLocaleString("zh-CN")} 点</span><span>{sampleMeta.channels.length} 个通道</span><span>{Number(result?.result?.sampleRateHz).toFixed(3)} Hz</span><span>{Number(result?.result?.observationSeconds).toFixed(1)} s</span></div>}
      </div>
      {(selected || imported || isNumerical) && <div className="field-modal-preview-chart"><Chart option={previewOption} height={300} label={isNumerical ? "计算样本响应波形（显示抽样）" : "所选批次的实测原始响应"} loading={previewBusy} /></div>}
    </Card>

    <Card title="识别方法">
      <div className="field-modal-methods" role="group" aria-label="模态识别方法">
        {methodDetails.map(item => <button key={item.id} type="button" className={method === item.id ? "active" : ""} aria-pressed={method === item.id} disabled={busy} onClick={() => { setMethod(item.id); setResult(null); }}>
          <strong>{item.name}</strong><span>{item.requirement}</span>
        </button>)}
      </div>
      {isNumerical && <p className="muted">选择方法即可查看对应输入和识别结果。</p>}
    </Card>

    {imported && <Card title="批次参数识别">
      <p>{methodDetails.find(m => m.id === method)?.requirement} 运行时校验输入资格、连续性、相干性或稳定极点，不满足条件会给出原因。</p>
      <Button variant="primary" disabled={!canAnalyze || busy || previewBusy} onClick={() => void analyze()}>{busy ? '正在计算' : '分析所选批次'}</Button>
      <label className="field-modal-history">已保存分析<CustomSelect aria-label="已保存模态分析" value={result?.job?.id || ''} disabled={busy} onChange={async e => { if (!e.target.value) { setResult(null); return; } setBusy(true); setError(''); try { setResult(await request<ModalResult>({ action: 'formalModal', request: { operation: 'result', parameters: { jobId: e.target.value } } })); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }}><option value="">选择历史结果</option>{history.map((j: any) => <option key={j.id} value={j.id}>{timestamp(j.createdAt)} · {j.algorithmVersion}</option>)}</CustomSelect></label>
    </Card>}
    {selected && method !== 'decay' && <p className="field-modal-empty">当前批次是单点记录。此方法可使用“模态采集”导入的同步多通道批次进行识别。</p>}
    {selected && !modalEligible && <p className="field-modal-empty">当前批次可查看原始波形；模态参数识别仅适用于“模态采集”页采集的叶片静止自由衰减试验记录，户外旋转测量不能替代该试验。</p>}
    {method === "decay" && selected && modalEligible && <Card title="自由衰减参数识别">
      <div className="field-modal-capture-fields">
        <label>激励撤除时刻 · 记录相对秒<input type="number" min="0" step="0.01" value={releaseTime} onChange={event => setReleaseTime(event.target.value)} placeholder="例如：2.5" /></label>
        <label>分析结束时刻 · 记录相对秒<input type="number" min="0" step="0.01" value={endTime} onChange={event => setEndTime(event.target.value)} placeholder="留空使用记录末尾" /></label>
        <label>激励与撤除过程<input value={releaseNote} maxLength={500} onChange={event => setReleaseNote(event.target.value)} placeholder="如：手动拨动叶片后松手，记录释放时刻" /></label>
        <label>叶片静止与边界条件<input value={stationaryNote} maxLength={500} onChange={event => setStationaryNote(event.target.value)} placeholder="记录叶片锁止状态、支撑和测量方向" /></label>
      </div>
      <div className="field-modal-capture-actions"><Button variant="primary" disabled={!canAnalyze || busy || previewBusy} onClick={() => void analyze()}><Activity size={15} />{busy ? "正在计算" : "分析所选批次"}</Button><span className="muted">至少需要 6 个有效同相峰值；不满足时系统会拒绝输出参数。</span></div>
    </Card>}

    {error && <p className="field-error" role="alert">{error}</p>}
    {result && <>
      <Card title="识别参数">
        <div className="field-modal-result-meta"><span>输入：{result.result?.inputSamples?.toLocaleString("zh-CN")} 点</span><span>{Number(result.result?.sampleRateHz).toFixed(3)} Hz</span><span>{result.result?.algorithmVersion}</span><span>来源：{isNumerical ? "计算样本" : imported ? "同步采集文件" : "本机连续采集记录"}</span></div>
        <div className="table-scroll"><table><thead><tr><th>序号</th><th>固有频率 / Hz</th><th>阻尼比 / %</th><th>振型与说明</th></tr></thead><tbody>{result.result.modes.map((mode: any, i: number) => <tr key={i}><td>{i + 1}</td><td>{Number(mode.naturalFrequencyHz).toFixed(5)}</td><td>{(100 * Number(mode.dampingRatio)).toFixed(3)}</td><td>{isNumerical && mode.demoModelMatch ? "匹配预设模态（计算样本）" : mode.demoModelMatch || (mode.shape ? "多点复振型" : "单点输入不能得到完整振型")}</td></tr>)}</tbody></table></div>
        <details className="field-modal-provenance"><summary>查看计算质量与输入依据</summary><pre>{JSON.stringify({ source: isNumerical ? "numerical_synthesis" : imported?.sourceKind || "device_recording", inputSha256: sampleMeta?.inputSha256 || imported?.sourceSha256, channels: imported?.channels, evidence: imported?.evidence, parameters: result.result.parameters, modes: result.result.modes.map((m: any) => ({ quality: m.quality, uncertainty: m.uncertainty })) }, null, 2)}</pre></details>
      </Card>
      <div className="field-modal-charts">{resultCharts.map(chart => <Card key={chart.id} title={chart.title}><Chart option={chart.option} height={270} label={chart.title} /></Card>)}</div>
    </>}

    {allowImport && canAnalyze && <details className="field-modal-provenance"><summary>导入模态批次</summary><FieldModalImport request={request} method={method} onSaved={dataset => { void refreshCatalog(); setRecordingId('dataset:' + dataset.id); }} /></details>}
    <details className="field-modal-provenance"><summary><Info size={15} />方法适用条件</summary>
      <p>自由衰减使用固定叶片单点响应，必须从外部激励停止后开始选取分析区间。采样时钟、通道单位、源记录和所选样本区间随输入保存。</p>
      <p>FRF 需要同一采样时钟下的激励力与响应；SSI-COV 需要多个物理测点同步连续采样。当前单点激光测振仪不能通过拼接不同时间的记录补出力通道、同步相位或完整振型。</p>
    </details>
    </>}
  </div>;
}
