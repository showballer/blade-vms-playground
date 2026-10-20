"use client";
import React, { memo, useEffect, useId, useRef, useState } from "react";
import { Activity, AudioLines, ChevronRight, HardDrive, LoaderCircle, Pause, Play, Square } from "lucide-react";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { FieldWaveChart, FieldWaveOptions, hasWave, waveBounds, waveLimit, type TimeMode, type VelocityUnit } from "./field-waveform";
import { FieldRealtimeAnalysis } from "./field-realtime";
import { FieldLaserControl } from "./field-device";
import { FieldCycleProgress } from "./field-cycle-progress";
import { FieldCycleMotion } from "./field-cycle-motion";
import type { FieldCaptureRoute } from "./field-capture-route";
import { FieldAutoCaptureList } from "./field-auto-capture-list";
import { FieldTurntableFeedback } from "./field-turntable";
import { fieldCanStart, fieldIsActive, type FieldConfig, type FieldRecording, type FieldRequestOptions, type FieldSimulation, type FieldSimulationInfo, type FieldSource, type FieldStatus } from "./field-types";

const number = (value?: number | null, digits = 5) => typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(digits)).toLocaleString("zh-CN", { maximumFractionDigits: 6 }) : "—";
type Props = {
  config: FieldConfig; onConfig: React.Dispatch<React.SetStateAction<FieldConfig>>;
  source: FieldSource; status: FieldStatus | null; busy: string; pollError: string;
  windowMs: number; onWindow: (value: number) => void;
  refreshMs: number; onRefresh: (value: number) => void;
  request: <T>(options: FieldRequestOptions) => Promise<T>;
  link?: { enabled: boolean; onEnabled: (value: boolean) => void; route: FieldCaptureRoute | null; errors: string[]; onConfigure: () => void;
    mode?: "manual" | "auto"; onMode?: (mode: "manual" | "auto") => void;
    onSelectTarget?: (key: string) => void; onStartTarget?: (key: string) => void; onConfigureTarget?: (key: string) => void;
    collectionId?: string; recordings?: readonly FieldRecording[] };
  onDeviceStart: () => void; onSimulationStart?: (simulation: FieldSimulation) => void;
  onStop: () => void; onService: () => void; onRecords: () => void;
};

export const FieldAcquisition = memo(function FieldAcquisition({ config, onConfig, source, status, busy, pollError, windowMs, onWindow, refreshMs, onRefresh, request, link, onDeviceStart, onSimulationStart, onStop, onService, onRecords }: Props) {
  const [simulation, setSimulation] = useState<FieldSimulation>({ point: "P1", scenario: "baseline" });
  const [metadata, setMetadata] = useState<FieldSimulationInfo | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [metadataRevision, setMetadataRevision] = useState(0);
  const [setupExpanded, setSetupExpanded] = useState(true);
  const [tab, setTab] = useState<"wave" | "analysis">("wave");
  const [analysisVisited, setAnalysisVisited] = useState(false);
  const selectTab = (next: "wave" | "analysis") => {
    if (next === "analysis") setAnalysisVisited(true);
    setTab(next);
  };
  const [paused, setPaused] = useState(false);
  const frozen = useRef<FieldStatus | null>(null);
  const restoredRecording = useRef<string | undefined>(undefined);
  const tabId = useId();
  const tabButtons = useRef<Partial<Record<"wave" | "analysis", HTMLButtonElement>>>({});
  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "wave" : event.key === "End" ? "analysis" : tab === "wave" ? "analysis" : "wave";
    selectTab(next); tabButtons.current[next]?.focus();
  };
  const [timeMode, setTimeMode] = useState<TimeMode>("relative");
  const [unit, setUnit] = useState<VelocityUnit>("mm/s");
  const [scale, setScale] = useState(0.5), [autoScale, setAutoScale] = useState(true);
  const active = fieldIsActive(status);
  const linked = active ? !!status?.pointCycle : !!link?.enabled;
  const linkMode = link?.mode || link?.route?.kind || "manual";
  const autoLinked = source === "device" && linked && linkMode === "auto";
  useEffect(() => { setSetupExpanded(!active); }, [active]);
  useEffect(() => {
    if (active && source === "simulation" && status?.recording?.simulation && restoredRecording.current !== status.recording.id) {
      restoredRecording.current = status.recording.id;
      setSimulation(status.recording.simulation);
    }
  }, [active, source, status?.recording?.id, status?.recording?.simulation]);
  useEffect(() => { setPaused(false); frozen.current = null; setAutoScale(true); }, [status?.recording?.id]);
  useEffect(() => {
    if (source !== "simulation" || status?.service.state !== "ready") return;
    let canceled = false;
    setMetadataError("");
    request<FieldSimulationInfo>({ action: "simulation" }).then(data => {
      if (!canceled) setMetadata(data);
    }).catch(error => { if (!canceled) setMetadataError(error instanceof Error ? error.message : "模拟数据源读取失败"); });
    return () => { canceled = true; };
  }, [source, status?.service.state, metadataRevision, request]);
  const display = paused ? frozen.current : status;
  const wave = display?.waveform;
  const actualSource = status?.recording?.source || status?.source;
  const canStart = fieldCanStart(status, source) && !pollError && (!link?.enabled || !!link.route?.cycle && link.errors.length === 0) && (source === "device" || !!metadata && !metadataError);
  const latest = status?.waveform?.latest;
  const velocity = latest?.velocity ?? status?.waveform?.values.at(-1);
  const rssi = latest ? latest.rssi : status?.waveform?.rssi.at(-1);
  const recording = status?.recording;
  const rate = status?.waveform?.sampleRate || recording?.sampleRate;
  const duration = rate && recording ? recording.samples / rate : 0;
  const update = (key: keyof FieldConfig, value: string) => onConfig(previous => ({ ...previous, [key]: value }));
  return <div className="field-capture-workspace">
    <div className="field-capture-toolbar">
      <div className="field-view-tabs" data-active={tab} role="tablist" aria-label="数据采集视图">
        <button id={`${tabId}-wave-tab`} ref={element => { if (element) tabButtons.current.wave = element; }} type="button" role="tab" tabIndex={tab === "wave" ? 0 : -1} aria-selected={tab === "wave"} aria-controls={`${tabId}-wave-panel`} onKeyDown={onTabKey} onClick={() => selectTab("wave")}><Activity size={17} /><span>实时采集波形</span></button>
        <button id={`${tabId}-analysis-tab`} ref={element => { if (element) tabButtons.current.analysis = element; }} type="button" role="tab" tabIndex={tab === "analysis" ? 0 : -1} aria-selected={tab === "analysis"} aria-controls={`${tabId}-analysis-panel`} onKeyDown={onTabKey} onClick={() => selectTab("analysis")}><AudioLines size={17} /><span>实时分析</span></button>
      </div>
      <div className="field-display-controls"><label>刷新<CustomSelect aria-label="刷新间隔" value={refreshMs} onChange={event => onRefresh(Number(event.target.value))}><option value={100}>100 ms</option><option value={250}>250 ms</option><option value={500}>500 ms</option><option value={1000}>1 秒</option></CustomSelect></label><Button variant="ghost" disabled={!hasWave(wave)} onClick={() => { if (paused) { setPaused(false); frozen.current = null; } else { frozen.current = status; setPaused(true); } }}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "恢复显示" : "暂停显示"}</Button></div>
    </div>
    <section className={`field-card field-capture-setup ${active && !setupExpanded ? "is-compact" : ""}`}>
      {active && <div className="field-capture-running-summary"><div><span className="field-badge green">正在采集</span><strong>{status?.recording?.name || config.name}</strong><span>{status?.recording?.source === "simulation" ? "模拟输入" : "设备输入"} · {number(status?.recording?.sampleRate)} Hz</span></div><button type="button" className="field-text-button" onClick={() => setSetupExpanded(value => !value)}>{setupExpanded ? "收起参数" : "查看采集参数"}<ChevronRight size={14} /></button></div>}
      <form hidden={active && !setupExpanded} onSubmit={event => { event.preventDefault(); if (active || busy || !canStart || autoLinked) return; source === "simulation" ? onSimulationStart?.(simulation) : onDeviceStart(); }}>
        <fieldset disabled={active || !!busy} className={`field-capture-inputs ${autoLinked ? "field-capture-inputs-by-point" : ""}`}>
          <label className="field-wind-farm">风场编号<input maxLength={120} aria-label="风场编号" value={config.windFarm ?? ""} onChange={event => update("windFarm", event.target.value)} placeholder="例如：WF-001" /></label>
          <label className="field-task-name">风机任务 <span className="field-required">*</span><input required maxLength={120} aria-label="任务名称" value={config.name} onChange={event => update("name", event.target.value)} placeholder={source === "simulation" ? "例如：叶片模拟采集" : "例如：1号风机叶片测量"} /></label>
          {source === "simulation" ? <>
            <label>模拟测点<CustomSelect disabled={active || !!busy} aria-label="模拟测点" value={simulation.point} onChange={event => setSimulation(previous => ({ ...previous, point: event.target.value as FieldSimulation["point"] }))}>{metadata?.points.map(item => <option key={item.id} value={item.id}>{item.label} · {number(item.sampleRate)} Hz</option>) || <option value="P1">正在读取模拟数据…</option>}</CustomSelect></label>
            <label>输入场景<CustomSelect disabled={active || !!busy} aria-label="输入场景" value={simulation.scenario} onChange={event => setSimulation(previous => ({ ...previous, scenario: event.target.value as FieldSimulation["scenario"] }))}>{metadata?.scenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>) || <option value="baseline">源文件回放</option>}</CustomSelect></label>
          </> : <><label>设备 IP<input required maxLength={15} value={config.deviceIp} onChange={event => update("deviceIp", event.target.value)} placeholder="设备 IPv4 地址" /></label><label>本机网卡 IP<input required maxLength={15} value={config.hostIp} onChange={event => update("hostIp", event.target.value)} placeholder="连接设备的网卡 IPv4 地址" /></label></>}
          {!autoLinked && <Button type="submit" variant="primary" disabled={!!busy || !canStart}>{busy === "start" ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}开始采集</Button>}
        </fieldset>
        {metadataError && source === "simulation" && <p className="field-error" role="alert">{metadataError}<Button type="button" disabled={active || !!busy} onClick={() => setMetadataRevision(value => value + 1)}>重新读取</Button></p>}
        {source === "device" && !status?.service.dllConfigured && <p className="field-capture-driver-note">请先在“设备与服务”中配置设备驱动。</p>}
        <div className="field-task-row">
          <details className="field-task-details"><summary>任务信息 <span>测量对象、风机编号与测点（可选）</span></summary><fieldset className="field-config-grid" disabled={active || !!busy}>{([["object", "测量对象"], ["turbine", "风机编号"], ["point", "测点名称"]] as const).map(([key, label]) => <label key={key}>{label}<input value={config[key]} maxLength={120} onChange={event => update(key, event.target.value)} placeholder={label} /></label>)}</fieldset></details>
          <button type="button" className="field-text-button" onClick={onService}>设备与服务<ChevronRight size={14} /></button>
        </div>
        {source === "device" && link && <section className="field-capture-link field-servo-ui" aria-label="转盘联动采集">
          <div className="field-capture-link-heading"><label className="field-turntable-toggle"><input type="checkbox" aria-label="联动转盘与测振仪" checked={linked} disabled={active || !!busy} onChange={event => link.onEnabled(event.target.checked)} />联动转盘与测振仪</label><Button type="button" variant="ghost" disabled={active || !!busy} onClick={link.onConfigure}>配置转盘点位<ChevronRight size={14} /></Button></div>
          {linked && <><div className="field-link-mode" role="group" aria-label="联动采集模式">{([["manual", "手动点位"], ["auto", "自动跟随"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={linkMode === value} disabled={active || !!busy || !link.onMode} onClick={() => link.onMode?.(value)}>{label}</button>)}</div>
            {!autoLinked && <><p className="field-route-order"><strong>{link.route?.name || "尚未配置采集路线"}</strong>{link.route?.pointNames.length ? ` · ${link.route.pointNames.length} 个点位 · ${link.route.cycle?.cycles || "—"} 轮` : ""}</p>
            {!!link.route?.pointNames.length && <p className="field-subtext">{link.route.pointNames.join(" → ")}</p>}</>}
            {!autoLinked && link.errors.length > 0 && <div className="field-link-blockers" role="status"><strong>开始前还需完成</strong><ul>{link.errors.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
            {!autoLinked && !link.errors.length && <p className="field-subtext">按配置顺序到位停稳，确认叶片进入并离开后自动换点。</p>}</>}
        </section>}
      </form>
      {autoLinked && link && <FieldAutoCaptureList targets={link.route?.targets || []} selectedTargetKey={link.route?.selectedTargetKey} collectionId={link.collectionId} recordings={link.recordings} config={config} status={status} busy={busy} pollError={pollError} onSelect={link.onSelectTarget} onStart={link.onStartTarget} onConfigure={link.onConfigureTarget} onConfigureAll={link.onConfigure} onStop={onStop} />}
    </section>
    {source === "device" && linked && <FieldCycleMotion status={status} route={link?.route} config={config} unavailable={!!pollError} />}
    <div className="field-acquisition-grid field-capture-grid">
      <section className="field-card field-capture-chart">
        {paused && <p className="field-notice warning">显示已暂停，采集和保存仍在继续。</p>}
        <div id={`${tabId}-wave-panel`} role="tabpanel" tabIndex={0} aria-labelledby={`${tabId}-wave-tab`} hidden={tab !== "wave"}>
          {tab === "wave" && <>
            <div className="field-section-heading field-capture-wave-heading"><h2>振动速度</h2><label className="field-window-picker">显示窗口<CustomSelect aria-label="实时显示时间窗" value={windowMs} onChange={event => onWindow(Number(event.target.value))}>{[20, 100, 500, 1000].map(value => <option key={value} value={value}>{value} ms</option>)}</CustomSelect></label></div>
            <FieldWaveChart waveform={wave} unit={unit} timeMode={timeMode} yLimit={autoScale ? undefined : scale} />
            <details className="field-chart-options"><summary>显示设置<span>{unit} · {autoScale ? "自动纵轴" : "固定纵轴"} · {timeMode === "relative" ? "相对时间" : "本机时间"}</span></summary><FieldWaveOptions timeMode={timeMode} onTime={setTimeMode} unit={unit} onUnit={setUnit} scale={autoScale ? waveLimit(wave) : scale} onScale={value => { setScale(value); setAutoScale(false); }} fit={() => setAutoScale(true)} /></details>
            <div className="field-rssi-heading"><h3>RSSI 回波强度</h3><span>信号质量</span></div><FieldWaveChart waveform={wave} kind="rssi" compact timeMode={timeMode} />
            <div className="field-chart-foot"><span>{(wave?.sourceSamples ?? wave?.values.length ?? 0).toLocaleString("zh-CN")} 个原始样本</span><span>窗口 {wave?.sampleRate && hasWave(wave) ? number((waveBounds(wave)[1] - waveBounds(wave)[0]) / wave.sampleRate * 1000) : "—"} ms</span><span>{wave?.representation === "envelope" ? "峰值包络" : "原始采样点"}</span><span>{actualSource === "simulation" || !wave && source === "simulation" ? "模拟数据" : "设备输入"}</span></div>
          </>}
        </div>
        <div id={`${tabId}-analysis-panel`} role="tabpanel" tabIndex={0} aria-labelledby={`${tabId}-analysis-tab`} hidden={tab !== "analysis"}>
          {analysisVisited && <FieldRealtimeAnalysis realtime={display?.realtime} paused={paused} active={tab === "analysis"} />}
        </div>
      </section>
      <aside className="field-right-column field-capture-aside">
        {status?.pointCycle && <FieldCycleProgress status={status} />}
        {source === "device" && <FieldLaserControl deviceIp={config.deviceIp} status={status} disabled={!!busy} request={request} />}
        {(recording?.turntable || status?.pointCycle) && <FieldTurntableFeedback status={status} />}
        <section className="field-card"><div className="field-section-heading"><h2>采集状态</h2><span className={`field-badge ${status?.service.state === "error" || status?.state === "error" ? "red" : active ? "green" : ""}`}>{status?.service.state === "error" || status?.state === "error" ? "异常" : active ? "接收中" : "待机"}</span></div><div className="field-metric-grid"><div><span>采样率</span><strong>{number(rate)}<small>Hz</small></strong></div><div><span>当前速度</span><strong>{number(velocity == null ? null : velocity * (unit === "mm/s" ? 1000 : 1))}<small>{unit}</small></strong></div><div><span>回波强度</span><strong>{number(rssi, 4)}<small>%</small></strong></div><div><span>窗口超量程</span><strong>{number(status?.waveform?.overrangeCount ?? status?.waveform?.overrange.filter(Boolean).length)}<small>点</small></strong></div></div></section>
        <section className="field-card field-active-record"><div className="field-section-heading"><h2>本次记录</h2><HardDrive size={17} /></div>{recording ? <><strong className="field-record-title">{recording.name}</strong><span className={`field-badge ${recording.source === "simulation" ? "amber" : ""}`}>{recording.source === "simulation" ? "模拟采集" : "设备采集"}</span><dl className="field-details"><div><dt>原始点数</dt><dd>{recording.samples.toLocaleString("zh-CN")}</dd></div><div><dt>采集时长</dt><dd>{number(duration)} 秒</dd></div><div><dt>保存状态</dt><dd>{recording.status === "complete" ? "已完整保存" : recording.status === "error" ? "记录异常" : "持续写入"}</dd></div></dl>{recording.error && <p className="field-error">{recording.error}</p>}</> : <p className="field-subtext">尚无采集记录。</p>}<Button variant="danger" className="full" disabled={!!busy || !active || status?.state === "stopping"} onClick={onStop}>{busy === "stop" ? <LoaderCircle size={15} className="spin" /> : <Square size={13} />}停止并保存</Button><button type="button" className="field-text-button" onClick={onRecords}>查看本机记录<ChevronRight size={14} /></button></section>
      </aside>
    </div>
  </div>;
});
