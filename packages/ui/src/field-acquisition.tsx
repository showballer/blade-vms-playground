"use client";
import React, { memo, useEffect, useRef, useState } from "react";
import { ChevronRight, Crosshair, Pause, Play, Square } from "lucide-react";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { FieldWaveChart, FieldWaveOptions, hasWave, waveBounds, waveLimit, type TimeMode, type VelocityUnit } from "./field-waveform";
import { FieldRealtimeAnalysis } from "./field-realtime";
import { ChartLoading } from "./chart-loading";
import { FieldCycleMotion } from "./field-cycle-motion";
import type { FieldCaptureRoute } from "./field-capture-route";
import { presetPositionRequestError } from "./field-preset-position";
import { FieldAutoCaptureList } from "./field-auto-capture-list";
import { fieldStartError, fieldIsActive, fieldCaptureConfig, validateFieldConfig, type FieldConfig, type FieldRecording, type FieldRequestOptions, type FieldSimulation, type FieldSimulationInfo, type FieldSource, type FieldStatus } from "./field-types";

const number = (value?: number | null, digits = 5) => typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(digits)).toLocaleString("zh-CN", { maximumFractionDigits: 6 }) : "—";
type Props = {
  config: FieldConfig; onConfig: React.Dispatch<React.SetStateAction<FieldConfig>>;
  source: FieldSource; status: FieldStatus | null; busy: string; pollError: string; stopping?: boolean;
  windowMs: number; onWindow: (value: number) => void;
  refreshMs: number; onRefresh: (value: number) => void;
  request: <T>(options: FieldRequestOptions) => Promise<T>;
  link?: { enabled: boolean; onEnabled: (value: boolean) => void; route: FieldCaptureRoute | null; errors: string[]; onConfigure: () => void;
    mode?: "manual" | "auto" | "segmented"; onMode?: (mode: "manual" | "auto" | "segmented") => void;
    onSegmentAutoMove?: (value: boolean) => void;
    startTargetDisabledReason?: string;
    onSelectTarget?: (key: string) => void; onStartTarget?: (key: string) => void; onConfigureTarget?: (key: string) => void;
    onPosition?: (key?: string) => void;
    onPositionStation?: (pointId: string) => void; positioningRoute?: FieldCaptureRoute | null; positionDisabledReason?: string;
    collectionId?: string; recordings?: readonly FieldRecording[] };
  onDeviceStart: () => void; onSimulationStart?: (simulation: FieldSimulation) => void;
  onCancelPosition?: () => void; positionStopping?: boolean;
  onStop: () => void; onService: () => void; onRecords: () => void;
};

export const FieldAcquisition = memo(function FieldAcquisition({ config, onConfig, source, status, busy, pollError, stopping = false, positionStopping = false, onCancelPosition, windowMs, onWindow, refreshMs, onRefresh, request, link, onDeviceStart, onSimulationStart, onStop, onService, onRecords }: Props) {
  const [simulation, setSimulation] = useState<FieldSimulation>({ point: "P1", scenario: "baseline" });
  const [metadata, setMetadata] = useState<FieldSimulationInfo | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [metadataRevision, setMetadataRevision] = useState(0);
  const [paused, setPaused] = useState(false);
  const frozen = useRef<FieldStatus | null>(null);
  const restoredRecording = useRef<string | undefined>(undefined);
  const [timeMode, setTimeMode] = useState<TimeMode>("relative");
  const [unit, setUnit] = useState<VelocityUnit>("mm/s");
  const [scale, setScale] = useState(0.5), [autoScale, setAutoScale] = useState(true);
  const active = fieldIsActive(status);
  const linked = active ? !!status?.pointCycle : !!link?.enabled;
  const linkMode = link?.mode || link?.route?.kind || "manual";
  const autoLinked = source === "device" && linked && linkMode !== "manual";
  const positioningError = presetPositionRequestError(link?.route || null, status) || pollError;
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
  const startError = fieldStartError(status, source) || pollError || validateFieldConfig(fieldCaptureConfig(config)) ||
    (link?.enabled ? link.errors[0] || (!link.route?.cycle ? "请先配置采集路线" : "") : "") ||
    (source === "simulation" ? metadataError || (!metadata ? "正在读取模拟数据源" : "") : "");
  const canStart = !startError;
  const update = (key: keyof FieldConfig, value: string) => onConfig(previous => ({ ...previous, [key]: value }));
  const motionPanel = source === "device" && linked ? <FieldCycleMotion status={status} route={link?.positioningRoute || link?.route} config={config} unavailable={!!pollError}
    onPositionStation={link && (linkMode === "manual" || linkMode === "segmented") && link.onPositionStation ? point => { if (point.pointId) link.onPositionStation?.(point.pointId); } : undefined}
    positioningPointId={link?.positioningRoute?.cycle?.points[0]?.pointId}
    positionDisabledReason={positioningError || link?.positionDisabledReason || (stopping ? "正在停止，请等待完成" : busy ? "操作进行中，请等待完成" : "")} /> : null;
  return <div className="field-capture-workspace">
    <section className="field-card field-capture-setup">
      <form onSubmit={event => { event.preventDefault(); if (active || busy || !canStart || autoLinked) return; source === "simulation" ? onSimulationStart?.(simulation) : onDeviceStart(); }}>
        <fieldset disabled={active || !!busy} className={`field-capture-inputs ${autoLinked ? "field-capture-inputs-by-point" : ""}`}>
          <label className="field-wind-farm">风场编号<input maxLength={120} aria-label="风场编号" value={config.windFarm ?? ""} onChange={event => update("windFarm", event.target.value)} placeholder="例如：WF-001" /></label>
          <label className="field-task-name">风机任务 <span className="field-required">*</span><input required maxLength={120} aria-label="任务名称" value={config.name} onChange={event => update("name", event.target.value)} placeholder={source === "simulation" ? "例如：叶片模拟采集" : "例如：1号风机叶片测量"} /></label>
          {source === "simulation" ? <>
            <label>模拟测点<CustomSelect disabled={active || !!busy} aria-label="模拟测点" value={simulation.point} onChange={event => setSimulation(previous => ({ ...previous, point: event.target.value as FieldSimulation["point"] }))}>{metadata?.points.map(item => <option key={item.id} value={item.id}>{item.label} · {number(item.sampleRate)} Hz</option>) || <option value="P1">正在读取模拟数据…</option>}</CustomSelect></label>
            <label>输入场景<CustomSelect disabled={active || !!busy} aria-label="输入场景" value={simulation.scenario} onChange={event => setSimulation(previous => ({ ...previous, scenario: event.target.value as FieldSimulation["scenario"] }))}>{metadata?.scenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>) || <option value="baseline">源文件回放</option>}</CustomSelect></label>
          </> : <><label>设备 IP<input required maxLength={15} value={config.deviceIp} onChange={event => update("deviceIp", event.target.value)} placeholder="设备 IPv4 地址" /></label><label>本机网卡 IP<input required maxLength={15} value={config.hostIp} onChange={event => update("hostIp", event.target.value)} placeholder="连接设备的网卡 IPv4 地址" /></label></>}
        </fieldset>
        {!active && !autoLinked && (startError || linked && positioningError) && <p className="field-notice warning" role="status">{[...new Set([startError, linked ? positioningError : ""].filter(Boolean))].join("；")}</p>}
        {metadataError && source === "simulation" && <p className="field-error" role="alert">{metadataError}<Button type="button" disabled={active || !!busy} onClick={() => setMetadataRevision(value => value + 1)}>重新读取</Button></p>}
        {source === "device" && !status?.service.dllConfigured && <p className="field-capture-driver-note">请先在“设备与服务”中配置设备驱动。</p>}
        {source === "device" && link && <section className="field-capture-link field-servo-ui" aria-label="转盘联动采集">
          <div className="field-capture-link-heading"><label className="field-turntable-toggle"><input type="checkbox" aria-label="联动转盘与测振仪" checked={linked} disabled={active || !!busy} onChange={event => link.onEnabled(event.target.checked)} />联动转盘与测振仪</label><Button type="button" variant="ghost" disabled={active || !!busy} onClick={link.onConfigure}>配置转盘点位<ChevronRight size={14} /></Button></div>
          {linked && <><div className="field-link-mode" role="group" aria-label="联动采集模式">{([["segmented", "分段采集"], ["auto", "自动跟随"], ["manual", "手动点位"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={linkMode === value} disabled={active || !!busy || !link.onMode} onClick={() => link.onMode?.(value)}>{label}</button>)}</div>
            {!autoLinked && <><p className="field-route-order"><strong>{link.route?.name || "尚未配置采集路线"}</strong>{link.route?.pointNames.length ? ` · ${link.route.pointNames.length} 个点位 · ${link.route.cycle?.cycles || "—"} 轮` : ""}</p>
            {!!link.route?.pointNames.length && <p className="field-subtext">{link.route.pointNames.join(" → ")}</p>}</>}
            {!autoLinked && link.errors.length > 0 && <div className="field-link-blockers" role="status"><strong>开始前还需完成</strong><ul>{link.errors.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
            {!autoLinked && !link.errors.length && <p className="field-subtext">按配置顺序到位停稳，确认叶片进入并离开后自动换点。</p>}</>}
        </section>}
      </form>
      {!autoLinked && <div className="field-auto-capture-toolbar field-servo-ui field-plain-capture-toolbar">
        <div className="field-auto-capture-current"><span>当前任务</span><strong title={config.name}>{config.name || "未命名任务"}</strong><small>{config.point || (linked ? "手动点位" : "直接采集")}</small></div>
        <div className="field-auto-capture-actions">
          {source === "device" && linked ? <Button type="button" variant={busy === "preposition" ? "danger" : "outline"} disabled={busy === "preposition" ? positionStopping || !onCancelPosition : active || !!busy || !!positioningError || !link?.onPosition} title={busy === "preposition" ? undefined : positioningError || undefined} onClick={() => busy === "preposition" ? onCancelPosition?.() : link?.onPosition?.()}>{busy === "preposition" ? <Square size={18} /> : <Crosshair size={18} />}{busy === "preposition" ? "停止定位" : "移动到预设位置"}</Button> : <span />}
          <Button type="button" className="field-auto-capture-primary" variant={active || busy === "start" || stopping ? "danger" : "primary"} disabled={active || busy === "start" || stopping ? stopping : !!busy || !canStart} title={active ? undefined : startError || undefined} onClick={() => { if (active || busy === "start" || stopping) onStop(); else if (!busy && canStart) source === "simulation" ? onSimulationStart?.(simulation) : onDeviceStart(); }}>{active || busy === "start" || stopping ? <Square size={18} /> : <Play size={20} />}{active || busy === "start" || stopping ? "停止并保存" : "开始采集"}</Button>
        </div>
      </div>}
      {autoLinked && link && <FieldAutoCaptureList motionPanel={motionPanel} segmented={linkMode === "segmented"} targets={link.route?.targets || []} selectedTargetKey={link.route?.selectedTargetKey} collectionId={link.collectionId} recordings={link.recordings} config={config} status={status} busy={busy} pollError={pollError} stopping={stopping} positionStopping={positionStopping} onCancelPosition={onCancelPosition} onSelect={link.onSelectTarget} onStart={link.onStartTarget} onPosition={link.onPosition} onConfigure={link.onConfigureTarget} onConfigureAll={link.onConfigure} onAutoMove={link.onSegmentAutoMove} startDisabledReason={link.startTargetDisabledReason} onStop={onStop} />}
    </section>
    {!autoLinked && motionPanel}
    <div className="field-acquisition-grid field-capture-grid">
      <section className="field-card field-capture-chart">
        {paused && <p className="field-notice warning">显示已暂停，采集和保存仍在继续。</p>}
            <div className="field-section-heading field-capture-wave-heading"><h2>振动速度</h2><div className="field-capture-wave-controls"><label className="field-window-picker">显示窗口<CustomSelect aria-label="实时显示时间窗" value={windowMs} onChange={event => onWindow(Number(event.target.value))}>{[20, 100, 500, 1000].map(value => <option key={value} value={value}>{value} ms</option>)}</CustomSelect></label>
              <div className="field-display-controls"><label>刷新<CustomSelect aria-label="刷新间隔" value={refreshMs} onChange={event => onRefresh(Number(event.target.value))}><option value={100}>100 ms</option><option value={250}>250 ms</option><option value={500}>500 ms</option><option value={1000}>1 秒</option></CustomSelect></label><Button variant="ghost" disabled={!hasWave(wave)} onClick={() => { if (paused) { setPaused(false); frozen.current = null; } else { frozen.current = status; setPaused(true); } }}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "恢复显示" : "暂停显示"}</Button></div>
            </div></div>
            {!hasWave(wave) && ["starting", "acquiring"].includes(status?.state || "") && !pollError ? <ChartLoading label="正在等待首批测振数据…" /> : <FieldWaveChart waveform={wave} unit={unit} timeMode={timeMode} yLimit={autoScale ? undefined : scale} />}
            <details className="field-chart-options"><summary>显示设置<span>{unit} · {autoScale ? "自动纵轴" : "固定纵轴"} · {timeMode === "relative" ? "相对时间" : "本机时间"}</span></summary><FieldWaveOptions timeMode={timeMode} onTime={setTimeMode} unit={unit} onUnit={setUnit} scale={autoScale ? waveLimit(wave) : scale} onScale={value => { setScale(value); setAutoScale(false); }} fit={() => setAutoScale(true)} /></details>
            <div className="field-rssi-heading"><h3>RSSI 回波强度</h3><span>信号质量</span></div><FieldWaveChart waveform={wave} kind="rssi" compact timeMode={timeMode} />
            <div className="field-chart-foot"><span>{(wave?.sourceSamples ?? wave?.values.length ?? 0).toLocaleString("zh-CN")} 个原始样本</span><span>窗口 {wave?.sampleRate && hasWave(wave) ? number((waveBounds(wave)[1] - waveBounds(wave)[0]) / wave.sampleRate * 1000) : "—"} ms</span><span>{wave?.representation === "envelope" ? "峰值包络" : "原始采样点"}</span><span>{actualSource === "simulation" || !wave && source === "simulation" ? "模拟数据" : "设备输入"}</span></div>
      </section>
      <FieldRealtimeAnalysis realtime={display?.realtime} paused={paused} />
    </div>
  </div>;
});

export function FieldCaptureStatusTags({ status }: { status: FieldStatus | null }) {
  const wave = status?.waveform, latest = wave?.latest;
  const rate = wave?.sampleRate || status?.recording?.sampleRate;
  const velocity = latest?.velocity ?? wave?.values.at(-1), rssi = latest ? latest.rssi : wave?.rssi.at(-1);
  const overrange = wave?.overrangeCount ?? wave?.overrange.filter(Boolean).length ?? 0;
  return <div className="field-capture-metrics" aria-label="采集状态">
    <span className="field-badge" title="采样率">{number(rate ? rate / 1000 : undefined, 4)} kHz</span>
    <span className="field-badge" title="当前振动速度">{number(velocity == null ? null : velocity * 1000, 4)} mm/s</span>
    <span className="field-badge" title="RSSI 回波强度">回波 {number(rssi, 3)}%</span>
    <span className={`field-badge ${overrange ? "amber" : ""}`} title="当前显示窗口超量程样本">超量程 {overrange}</span>
  </div>;
}
