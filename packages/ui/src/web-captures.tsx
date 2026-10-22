"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, CheckCircle2, Cloud, Pause, Play, Radio, RefreshCw, Waves } from "lucide-react";
import { api, ApiError, download } from "./api";
import { Button } from "./common";
import { ChartLoading } from "./chart-loading";
import { CustomSelect } from "./custom-select";
import { FieldRecordingViewer, FieldWaveChart } from "./field-waveform";
import { FieldRealtimeAnalysis } from "./field-realtime";
import { readCaptureHistory } from "./web-capture-history";
import { bladeCaptureSelection, prepareBladeCaptures } from "./web-blade-capture-selection";
import { captureLiveLabel, captureProgress, captureUploadLabel, type CaptureDetail, type CaptureFrame, type CaptureSummary } from "./capture-types";
import type { FieldRecording, FieldRecordingDetail, FieldRequestOptions } from "./field-types";
import "./web-captures.css";
import "./field-realtime.css";

const count = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—";
const time = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return "尚未接收";
  const date = new Date(typeof value === "number" && value < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
};
type View = "waveform" | "analysis" | "recording";

export function WebCaptures({ canAnalyze, onAnalyze, onAnalyzeBatch }: { canAnalyze: boolean; onAnalyze: (recording: FieldRecording) => void; onAnalyzeBatch?: (recordings: FieldRecording[]) => void }) {
  const [captures, setCaptures] = useState<CaptureSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<CaptureDetail | null>(null);
  const [displayed, setDisplayed] = useState<CaptureFrame | null>(null);
  const [view, setView] = useState<View>("waveform");
  const [paused, setPaused] = useState(false), pausedRef = useRef(false);
  const [error, setError] = useState(""), [listError, setListError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0), [history, setHistory] = useState<FieldRecordingDetail | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false), [analysisError, setAnalysisError] = useState("");
  const [historyFailed, setHistoryFailed] = useState(false), [historyRevision, setHistoryRevision] = useState(0);
  const mounted = useRef(true), preparationTicket = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; preparationTicket.current++; }; }, []);
  const historyError = useCallback((cause: unknown) => setAnalysisError(cause instanceof Error ? cause.message : "波形读取失败"), []);
  const selectedRef = useRef(""), viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => {
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<{ captures: CaptureSummary[] }>("captures");
        if (canceled) return;
        setCaptures(result.captures); setListError("");
        setSelectedId(current => result.captures.some(capture => capture.id === current) ? current : result.captures[0]?.id || "");
      } catch (cause) { if (!canceled) {
        setListError(cause instanceof Error ? cause.message : "无法读取采集列表");
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setCaptures([]); setSelectedId(""); }
      } }
      finally { if (!canceled) { setLoading(false); timer = setTimeout(poll, document.hidden ? 8000 : 3000); } }
    }
    void poll(); return () => { canceled = true; clearTimeout(timer); };
  }, [refreshKey]);
  useEffect(() => {
    selectedRef.current = selectedId;
    preparationTicket.current++; setBusy(false);
    setDetail(null); setDisplayed(null); setHistory(null); setError(""); setAnalysisError(""); setHistoryFailed(false);
    setPaused(false); pausedRef.current = false; setView("waveform");
    if (!selectedId) { setDetailLoading(false); return; }
    setDetailLoading(true);
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<CaptureDetail>(`captures/${encodeURIComponent(selectedId)}`);
        if (canceled) return;
        setDetail(next); setError("");
        if (!pausedRef.current) setDisplayed(previous => previous?.sequence === next.frame?.sequence ? previous : next.frame);
      } catch (cause) { if (!canceled) {
        setError(cause instanceof Error ? cause.message : "实时连接失败");
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          setDetail(null); setDisplayed(null); setHistory(null); setCaptures(items => items.filter(item => item.id !== selectedId));
        }
      } }
      finally { if (!canceled) { setDetailLoading(false); timer = setTimeout(poll, document.hidden ? 5000 : 1000); } }
    }
    void poll(); return () => { canceled = true; clearTimeout(timer); };
  }, [selectedId, refreshKey]);

  const capture = detail?.capture || captures.find(item => item.id === selectedId);
  const complete = capture?.uploadState === "complete";
  const selection = capture ? bladeCaptureSelection(captures, capture) : null;
  const prepareCurrentOnly = Boolean(selection?.automatic && selection.captures.length > 64);
  useEffect(() => {
    if (view !== "recording" || !complete || !selectedId) return;
    let canceled = false;
    setHistoryLoading(true); setAnalysisError(""); setHistoryFailed(false);
    void readCaptureHistory(() => api<FieldRecordingDetail>(`captures/${encodeURIComponent(selectedId)}/waveform`), { active: () => !canceled }).then(result => {
      if (!canceled) setHistory(result);
    }).catch(cause => { if (!canceled) { setHistoryFailed(true); setAnalysisError(cause instanceof Error ? cause.message : "完整记录读取失败"); } })
      .finally(() => { if (!canceled) setHistoryLoading(false); });
    return () => { canceled = true; };
  }, [view, complete, selectedId, historyRevision]);
  const historyRequest = useCallback(async <T,>(options: FieldRequestOptions): Promise<T> => {
    if (options.action !== "waveform" && options.action !== "recording") throw new Error("此页面仅支持原始波形查看。");
    const query = new URLSearchParams();
    if (options.action === "waveform") { if (options.start !== undefined) query.set("start", String(options.start)); if (options.end !== undefined) query.set("end", String(options.end)); }
    const active = () => selectedRef.current === selectedId && viewRef.current === "recording";
    const result = await readCaptureHistory(() => api<T>(`captures/${encodeURIComponent(selectedId)}/waveform?${query}`), { active });
    if (active()) setAnalysisError("");
    return result;
  }, [selectedId]);
  async function useForAnalysis() {
    if (!selectedId || !complete || !canAnalyze || busy) return;
    const id = selectedId; setBusy(true); setAnalysisError("");
    const ticket = ++preparationTicket.current;
    const active = () => mounted.current && ticket === preparationTicket.current && selectedRef.current === id;
    try {
      const batch = selection?.automatic && onAnalyzeBatch && !prepareCurrentOnly ? selection.captures : capture ? [capture] : [];
      const prepared = await prepareBladeCaptures(batch, async captureId => (await api<{ recording: FieldRecording }>(`captures/${encodeURIComponent(captureId)}/prepare-analysis`, "POST", {})).recording, active);
      if (active() && prepared?.length) {
        if (onAnalyzeBatch) onAnalyzeBatch(prepared); else onAnalyze(prepared[0]);
      }
    } catch (cause) { if (active()) setAnalysisError(cause instanceof Error ? cause.message : "准备分析失败"); }
    finally { if (active()) setBusy(false); }
  }
  async function downloadAttachment(name: "manifest.json" | "turntable.jsonl") {
    if (!selectedId || !complete || busy) return;
    const id = selectedId; setBusy(true); setAnalysisError("");
    try { await download(`captures/${encodeURIComponent(id)}/files/${name}`); }
    catch (cause) { if (selectedRef.current === id) setAnalysisError(cause instanceof Error ? cause.message : "附件下载失败"); }
    finally { setBusy(false); }
  }
  const disconnected = Boolean(error) || capture?.liveState === "offline";
  const tabs: { id: View; label: string }[] = [{ id: "waveform", label: "实时波形" }, { id: "analysis", label: "实时分析" }, { id: "recording", label: "已上传记录" }];
  return <section className="web-captures" aria-label="桌面实时采集与原始记录">
    <div className="field-card capture-selector-card">
      <div className="field-section-heading"><div><h2><Radio size={18} /> 桌面采集</h2><p>查看实时信号，选择已上传的完整记录进行分析。</p></div><Button variant="ghost" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={15} />刷新</Button></div>
      {listError && <p className="field-error" role="alert">{listError}</p>}
      {loading ? <p className="field-subtext" role="status">正在读取采集记录…</p> : !captures.length ? <div className="capture-empty"><Cloud size={26} /><div><strong>等待客户端采集</strong><p>客户端绑定此 Web 的账号后，开启自动同步并开始采集。采集中可看实时波形，停止保存后按客户端设置上传。</p></div></div> : <>
        <div className="capture-selection-row"><label>采集任务<CustomSelect aria-label="桌面采集任务" value={selectedId} onChange={event => setSelectedId(event.target.value)}>{captures.map(item => <option key={item.id} value={item.id}>{item.recording.name || "未命名采集"}{item.recording.pointCycle?.radialPointName ? ` · ${item.recording.pointCycle.radialPointName} / ${item.recording.pointCycle.azimuthDeg}°` : ""} · {item.ownerName} · {captureLiveLabel(item.liveState)} · {time(item.recording.startedAt)}</option>)}</CustomSelect></label>
          <Button variant="primary" disabled={!complete || !canAnalyze || busy} onClick={() => void useForAnalysis()} title={!canAnalyze ? "管理员或分析员可执行分析" : !complete ? "记录上传完成后可分析" : undefined}><ArrowDownToLine size={16} />{busy ? "正在准备…" : prepareCurrentOnly ? "选择当前记录用于分析" : selection?.automatic ? "选择同叶片记录" : "选择用于旋转分析"}</Button>
        </div>
        {selection?.automatic && <p className="field-subtext">本任务 · 叶片 {capture?.recording.pointCycle?.bladeId} · {selection.captures.length} 条完整点位记录{selection.pending ? ` · ${selection.pending} 条尚未上传完成` : ""}。下方可按测点、批次和点位选择分析范围。</p>}
        {prepareCurrentOnly && <p className="field-subtext">当前任务超过 64 条记录，请在上方逐条选择并加入分析工作区，再在下方分批分析。</p>}
        {capture?.recording.sampling && <p className="field-notice">降采样上传 · {capture.recording.sampling.sourceSampleRate / 1000} → {capture.recording.sampleRate! / 1000} kHz；本机全量原始记录保留。</p>}
        {capture && <div className="capture-info-grid"><div><span>采集端</span><strong>{capture.ownerName}</strong><small>{capture.tenant}</small></div><div><span>云端样本 / 采样率</span><strong>{count(capture.recording.samples)} 点</strong><small>{count(capture.recording.sampleRate)} Hz</small></div><div><span>实时连接</span><strong className={disconnected ? "capture-warning" : ""}>{error ? "连接中断" : captureLiveLabel(capture.liveState)}</strong><small>最后接收 {time(capture.lastSeenAt)}</small></div><div><span>上传记录</span><strong>{captureUploadLabel(capture.uploadState)}</strong><small>{capture.totalBytes ? `${captureProgress(capture)}% · ${(capture.receivedBytes / 1048576).toFixed(1)} / ${(capture.totalBytes / 1048576).toFixed(1)} MB` : "停止并保存后上传"}</small></div></div>}
      </>}
      {analysisError && <p className="field-error" role="alert">{analysisError}{historyFailed && view === "recording" && <Button disabled={historyLoading} onClick={() => setHistoryRevision(value => value + 1)}>重试读取</Button>}</p>}
      {capture?.error && <p className="field-error" role="alert">{capture.error}</p>}
    </div>
    {capture && <div className="capture-display-area">
      <div className="capture-view-toolbar"><div className="capture-view-tabs" role="tablist" aria-label="云端波形视图">{tabs.map(tab => <button key={tab.id} type="button" role="tab" id={`capture-${tab.id}-tab`} aria-controls={`capture-${tab.id}-panel`} aria-selected={view === tab.id} tabIndex={view === tab.id ? 0 : -1} disabled={tab.id === "recording" && !complete} onClick={() => setView(tab.id)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const available = tabs.filter(item => item.id !== "recording" || complete);
        const current = available.findIndex(item => item.id === tab.id);
        const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
        setView(available[next].id); document.getElementById(`capture-${available[next].id}-tab`)?.focus();
      }}>{tab.label}</button>)}</div>
        <div className="capture-display-actions"><span className={`field-badge ${capture.recording.source === "simulation" ? "amber" : ""}`}>{capture.recording.source === "simulation" ? "模拟数据" : "设备数据"}</span>{view !== "recording" && <Button variant="ghost" onClick={() => setPaused(value => !value)}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "恢复显示" : "暂停显示"}</Button>}</div>
      </div>
      {disconnected && <div className="field-notice warning" role="status">{error || "采集端连接已中断。"} 当前保留最后收到的画面，等待连接恢复。</div>}
      {paused && <div className="capture-paused" role="status">显示已暂停 · 画面时间 {time(displayed?.receivedAt)}</div>}
      {view === "waveform" && <section id="capture-waveform-panel" role="tabpanel" aria-labelledby="capture-waveform-tab" className="field-card capture-wave-card"><div className="field-section-heading"><h2><Waves size={17} /> CH1 振动速度</h2><span className="field-subtext">mm/s · 相对时间</span></div>{detailLoading ? <ChartLoading label="正在连接并读取波形…" /> : <FieldWaveChart waveform={displayed?.waveform} unit="mm/s" />}<div className="capture-rssi-heading">RSSI 回波强度 <span>信号质量 · %</span></div><FieldWaveChart waveform={displayed?.waveform} kind="rssi" compact /><p className="capture-preview-note">实时画面为有限显示窗口；图表按显示分辨率压缩；上传记录按客户端采样率设置保存，本机保留全量原始样本。</p></section>}
      {view === "analysis" && <div id="capture-analysis-panel" role="tabpanel" aria-labelledby="capture-analysis-tab"><FieldRealtimeAnalysis key={selectedId} realtime={displayed?.realtime} paused={paused} /></div>}
      {view === "recording" && <section id="capture-recording-panel" role="tabpanel" aria-labelledby="capture-recording-tab" className="field-card capture-history-card"><div className="field-section-heading"><h2><CheckCircle2 size={17} /> 已上传记录</h2><div className="capture-display-actions">{capture.recording.turntable && <><Button disabled={busy} onClick={() => void downloadAttachment("manifest.json")}><ArrowDownToLine size={15} />转盘元信息</Button>{capture.recording.turntable.telemetry && <Button disabled={busy} onClick={() => void downloadAttachment("turntable.jsonl")}><ArrowDownToLine size={15} />转盘遥测</Button>}</>}<span className="field-badge green">上传校验通过</span></div></div>{historyLoading ? <ChartLoading label="正在读取已上传记录…" /> : !historyFailed && history && <FieldRecordingViewer key={selectedId} detail={history} load={historyRequest} onError={historyError} />}</section>}
    </div>}
  </section>;
}
