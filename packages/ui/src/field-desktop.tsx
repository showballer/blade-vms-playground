"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, AudioLines, Check, CircleHelp,
  FolderOpen, HardDrive, LoaderCircle, LockKeyhole, LogOut, Minus,
  Play, Radio, RefreshCw, Settings, ShieldCheck, Square, X,
} from "lucide-react";
import { Button, Dialog } from "./common";
import { Chart } from "./charts";
import { FieldWaveChart, FieldWaveOptions, FieldRecordingViewer, hasWave, waveBounds, waveLimit, type TimeMode, type VelocityUnit } from "./field-waveform";
import { FieldDevicePanel, FieldDeviceSnapshot } from "./field-device";
import { FieldAnalysis } from "./field-analysis";
import { FieldRotation } from "./field-rotation";
import {
  fieldCanStart, fieldDate, fieldIsActive, fieldSampleX, validateFieldConfig,
  type FieldConfig, type FieldRecording, type FieldRecordingDetail,
  type FieldRequest, type FieldRequestOptions, type FieldSession,
  type FieldStatus, type FieldWaveform, type FieldDeviceSettings,
  type FieldRealtime,
} from "./field-types";

function fieldBridge(): FieldRequest | undefined {
  if (typeof window === "undefined") return undefined;
  return (window.blade as (NonNullable<Window["blade"]> & { field?: FieldRequest }) | undefined)?.field;
}
class FieldRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function fieldCall<T>(options: FieldRequestOptions): Promise<T> {
  const bridge = fieldBridge();
  if (!bridge) throw new FieldRequestError("当前不是已集成本机采集服务的桌面程序，请使用 Windows EXE。浏览器不连接真实设备，也不加载模拟数据。", 503);
  const result = await bridge(options);
  if (result.status >= 400) {
    const data = result.data as { error?: string; detail?: string } | null;
    throw new FieldRequestError(data?.error || data?.detail || `操作失败（${result.status}）`, result.status);
  }
  return result.data as T;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作失败，请查看服务状态后重试";
const count = (value: number | undefined | null) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
const timeOf = (value?: string | number) => {
  return fieldDate(value)?.toLocaleString("zh-CN", { hour12: false }) || "—";
};
const serviceLabels: Record<FieldStatus["service"]["state"], string> = {
  missing: "采集服务未安装", starting: "正在启动采集服务", ready: "采集服务已就绪", error: "采集服务异常", stopping: "正在停止采集服务", stopped: "采集服务已停止",
};
const stateLabels: Record<FieldStatus["state"], string> = {
  idle: "等待采集", starting: "正在连接设备", acquiring: "正在采集", stopping: "正在停止并保存", error: "采集异常",
};
const blankConfig: FieldConfig = { deviceIp: "", hostIp: "", name: "", object: "", turbine: "", point: "" };

function FieldTitlebar() {
  return <div className="field-titlebar">
    <div><Activity size={14} /><span>BladeVMS</span><span className="field-title-divider" /><span className="field-title-description">旋转叶片测振与损伤检测系统</span></div>
    <div className="field-window-controls">
      <button aria-label="最小化" onClick={() => window.blade?.windowControl("minimize")}><Minus size={14} /></button>
      <button aria-label="最大化或还原" onClick={() => window.blade?.windowControl("maximize")}><Square size={11} /></button>
      <button aria-label="关闭工作台" onClick={() => window.blade?.windowControl("close")}><X size={15} /></button>
    </div>
  </div>;
}

export function FieldLoginPanel({ busy, error, available, onLogin }: {
  busy: boolean; error: string; available: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  return <main className="field-auth-shell">
    <section className="field-auth-intro">
      <div className="field-brand"><Activity size={25} /><span>BladeVMS <small>FIELD WORKSTATION</small></span></div>
      <div><span className="field-eyebrow">现场测量 · 本机运行</span><h1>从设备到数据，<br />专注每一次真实测量。</h1><p>连接设备、采集振动信号、保存原始记录。<br />采集工作无需互联网或管理服务器。</p></div>
      <div className="field-auth-features"><span><HardDrive size={16} />原始数据保存在本机</span><span><Radio size={16} />CH1 振动速度 + RSSI</span><span><ShieldCheck size={16} />本机账号独立验证</span></div>
    </section>
    <section className="field-auth-card">
      <div className="field-auth-icon"><LockKeyhole size={24} /></div>
      <h2>登录现场工作台</h2><p className="field-subtext">使用这台电脑的本机账号，不是 Web 管理端账号。</p>
      <form onSubmit={async (event) => { event.preventDefault(); try { await onLogin(username.trim(), password); } finally { setPassword(""); } }}>
        <label>账号<input autoComplete="username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} required disabled={busy} /></label>
        <label>密码<input autoComplete="current-password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /></label>
        {error && <p className="field-error" role="alert">{error}</p>}
        {!available && <p className="field-notice">请在安装好的 Windows EXE 中使用。本浏览器预览不提供本机登录与设备采集。</p>}
        <Button type="submit" variant="primary" className="full" disabled={busy || !available}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}登录工作台</Button>
      </form>
      <p className="field-auth-footnote">预制管理员账号：admin。初始密码由交付人员单独提供；首次登录必须修改密码。</p>
    </section>
  </main>;
}

export function FieldPasswordPanel({ mandatory, busy, error, onSave, onCancel }: {
  mandatory: boolean; busy: boolean; error: string;
  onSave: (currentPassword: string, newPassword: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState("");
  return <section className="field-password-card">
    <div className="field-auth-icon"><ShieldCheck size={24} /></div>
    <h2>{mandatory ? "首次登录 · 设置专属密码" : "修改本机密码"}</h2>
    <p className="field-subtext">{mandatory ? "为保护现场数据，请先更换交付初始密码，再进入工作台。" : "修改仅影响这台电脑的管理员账号，不修改 Web 管理端账号。"}</p>
    <form onSubmit={async (event) => {
      event.preventDefault(); setValidation("");
      if (next !== confirmation) { setValidation("两次输入的新密码不一致"); return; }
      if (next === current) { setValidation("新密码不能与当前密码相同"); return; }
      await onSave(current, next);
    }}>
      <label>当前密码<input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} disabled={busy} required /></label>
      <label>新密码<input type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} disabled={busy} required minLength={12} maxLength={128} /><small>12–128 位，建议同时使用大小写字母、数字和符号。</small></label>
      <label>确认新密码<input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} required minLength={12} maxLength={128} /></label>
      {(validation || error) && <p className="field-error" role="alert">{validation || error}</p>}
      <Button type="submit" variant="primary" className="full" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}保存新密码</Button>
      <Button type="button" variant="ghost" className="full" disabled={busy} onClick={onCancel}>{mandatory ? "退出登录" : "取消修改"}</Button>
    </form>
  </section>;
}

export { FieldWaveChart } from "./field-waveform";

export function FieldServicePanel({ status, busy, onAction }: {
  status: FieldStatus | null; busy: boolean;
  onAction: (action: "restartService" | "configureService" | "configureDll" | "openDataDirectory") => void;
}) {
  const service = status?.service, active = fieldIsActive(status);
  return <section className="field-card field-service-card">
    <div className="field-section-heading"><div><h2>本机采集服务</h2><p>与工作台一起运行，不依赖 Web 服务器。</p></div><Settings size={18} /></div>
    <div className={`field-service-state ${service?.state === "ready" ? "ready" : ""}`}><span className="field-status-dot" />{service ? serviceLabels[service.state] : "正在读取服务状态"}</div>
    <dl className="field-details"><div><dt>设备 SDK / DLL</dt><dd>{service ? service.dllConfigured ? "已配置" : "未配置" : "—"}</dd></div><div><dt>数据保存位置</dt><dd>本机应用数据目录</dd></div><div><dt>连接方式</dt><dd>设备网卡 · 本机 Python 服务</dd></div></dl>
    {service?.executable && <p className="field-path" title={service.executable}>{service.executable}</p>}
    {(service?.error || status?.error) && <p className="field-error" role="alert">{service?.error || status?.error}</p>}
    {service?.state === "missing" && <p className="field-notice">安装包中尚未包含可用采集服务。Windows 联调时请选择已打包的采集服务 EXE。</p>}
    {service && !service.dllConfigured && <p className="field-notice">尚未配置厂商 SDK。可以查看已保存记录，不能开始真实采集。厂商驱动需按安装说明准备。</p>}
    <div className="field-service-actions"><Button disabled={busy || active} onClick={() => onAction("configureService")}><FolderOpen size={14} />选择采集服务 EXE</Button><Button disabled={busy || active} onClick={() => onAction("configureDll")}><FolderOpen size={14} />选择设备 DLL</Button><Button disabled={busy || active} onClick={() => onAction("restartService")}><RefreshCw size={14} />重启采集服务</Button><Button disabled={busy} onClick={() => onAction("openDataDirectory")}><HardDrive size={14} />打开数据目录</Button></div>
    {active && <p className="field-subtext">采集期间不能更换或重启服务，请先停止并保存。</p>}
  </section>;
}

function realtimeNumber(value: number | null | undefined, digits = 5) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(digits)).toString() : "—";
}

function FieldRealtimePanel({ realtime }: { realtime?: FieldRealtime }) {
  const frequencies = realtime?.spectrum.frequencies || [];
  const amplitudes = realtime?.spectrum.amplitudes || [];
  const spectrum = frequencies.map((frequency, index) => [frequency, amplitudes[index] || 0]);
  const features = realtime?.features || {};
  return <section className="field-card field-realtime-card">
    <div className="field-section-heading"><div><h2>实时信号处理</h2><p>最近窗口在线计算，仅用于观察；停止后请用完整记录复核。</p></div><span className={`field-badge ${realtime?.available ? "green" : ""}`}>{realtime?.available ? "在线" : "等待数据"}</span></div>
    <div className="field-realtime-metrics"><div><span>RMS</span><strong>{realtimeNumber(features.rms)}<small>m/s</small></strong></div><div><span>峰值</span><strong>{realtimeNumber(features.peak)}<small>m/s</small></strong></div><div><span>峰峰值</span><strong>{realtimeNumber(features.peakToPeak)}<small>m/s</small></strong></div><div><span>主频</span><strong>{realtimeNumber(features.dominantHz)}<small>Hz</small></strong></div></div>
    {spectrum.length ? <Chart height={190} label="实时 FFT 频谱" option={{ animation: false, grid: { left: 54, right: 14, top: 16, bottom: 35 }, tooltip: { trigger: "axis" }, xAxis: { type: "value", name: "Hz", axisLabel: { fontSize: 9 } }, yAxis: { type: "value", name: "m/s", axisLabel: { fontSize: 9 } }, series: [{ type: "line", data: spectrum, showSymbol: false, lineStyle: { width: 1.4, color: "#2D6CC0" } }] }} /> : <p className="field-chart-empty compact"><strong>采集至少 64 点后显示实时频谱</strong></p>}
    <p className="field-chart-foot"><span>窗口 {realtime?.windowSamples || 0} 点</span><span>频率栅格 {realtime?.frequencySpacingHz ? `${realtimeNumber(realtime.frequencySpacingHz)} Hz` : "—"}</span><span>仅 CH1 速度，不含 RSSI</span></p>
  </section>;
}

export function FieldStartDialog({ config, busy, error, onClose, onStart }: {
  config: FieldConfig; busy: boolean; error: string; onClose: () => void; onStart: () => void;
}) {
  const [laser, setLaser] = useState(false), [target, setTarget] = useState(false), [capture, setCapture] = useState(false);
  return <Dialog title="开始真实采集前确认" onClose={() => { if (!busy) onClose(); }}>
    <div className="field-confirm"><div className="field-confirm-body"><p className="field-notice warning"><AlertTriangle size={17} />此操作会向真实设备发送控制指令。请先确认现场激光安全、设备状态和网卡配置。</p>
      <dl className="field-details"><div><dt>任务</dt><dd>{config.name}</dd></div><div><dt>设备 IP</dt><dd>{config.deviceIp}</dd></div><div><dt>本机设备网卡 IP</dt><dd>{config.hostIp}</dd></div></dl>
      <label><input type="checkbox" checked={target} disabled={busy} onChange={(event) => setTarget(event.target.checked)} /><span>允许将设备 DAQ 数据目标 IP 修改为 <b>{config.hostIp}</b>，并确认这不是其他电脑正在使用的采集连接。</span></label>
      <label><input type="checkbox" checked={laser} disabled={busy} onChange={(event) => setLaser(event.target.checked)} /><span>已确认现场人员与光路安全，允许开启设备激光。本次采集独占激光控制；停止时会尝试关闭激光，异常时须在现场确认设备状态。</span></label>
      <label><input type="checkbox" checked={capture} disabled={busy} onChange={(event) => setCapture(event.target.checked)} /><span>允许开始采集 CH1 振动速度及 RSSI，并将原始数据保存到本机。</span></label>
      {error && <p className="field-error" role="alert">{error}</p>}</div>
      <div className="field-form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy || !target || !laser || !capture} onClick={onStart}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}确认并开始采集</Button></div>
    </div>
  </Dialog>;
}

export function FieldRecordingList({ recordings, selectedId, busy, onSelect }: {
  recordings: FieldRecording[]; selectedId?: string; busy: boolean; onSelect: (id: string) => void;
}) {
  if (!recordings.length) return <div className="field-recordings-empty"><HardDrive size={28} /><h3>还没有真实采集记录</h3><p>完成一次采集后，记录将保存在本机。不会预置演示任务或模拟结果。</p></div>;
  return <div className="field-table-scroll" role="region" aria-label="本机采集记录，可横向滚动查看所有列" tabIndex={0}><table className="field-table"><thead><tr><th>任务 / 对象</th><th>开始时间</th><th>原始点数</th><th>采样率</th><th>保存状态</th><th>操作</th></tr></thead><tbody>{recordings.map((recording) => <tr key={recording.id} className={selectedId === recording.id ? "selected" : ""}><td><strong>{recording.name}</strong><small>{[recording.object, recording.turbine, recording.point].filter(Boolean).join(" / ") || "未填写对象信息"}</small></td><td>{timeOf(recording.startedAt)}</td><td className="mono">{count(recording.samples)}</td><td className="mono">{recording.sampleRate ? `${count(recording.sampleRate)} Hz` : "未知"}</td><td><span className={`field-badge ${recording.status === "complete" ? "green" : recording.status === "error" ? "red" : "amber"}`}>{recording.status === "complete" ? "已完成" : recording.status === "error" ? "异常记录" : "采集中 / 未完整结束"}</span></td><td><Button disabled={busy} onClick={() => onSelect(recording.id)}>查看预览</Button></td></tr>)}</tbody></table></div>;
}

export function FieldDesktopApp() {
  const [session, setSession] = useState<FieldSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<FieldStatus | null>(null);
  const [recordings, setRecordings] = useState<FieldRecording[]>([]);
  const [recordingsLoaded, setRecordingsLoaded] = useState(false);
  const [selected, setSelected] = useState<FieldRecordingDetail | null>(null);
  const [screen, setScreen] = useState<"acquisition" | "recordings" | "service" | "rotation" | "analysis">("acquisition");
  const [config, setConfig] = useState<FieldConfig>(blankConfig);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmStart, setConfirmStart] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [windowMs, setWindowMs] = useState(20), [refreshMs, setRefreshMs] = useState(500);
  const [timeMode, setTimeMode] = useState<TimeMode>("clock"), [velocityUnit, setVelocityUnit] = useState<VelocityUnit>("mm/s");
  const [scale, setScale] = useState(0.5), [paused, setPaused] = useState(false);
  const [displayWave, setDisplayWave] = useState<FieldWaveform | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(true);

  const clearSession = useCallback(() => {
    generation.current += 1; setSession(null); setStatus(null); setRecordings([]); setRecordingsLoaded(false); setSelected(null);
    setDisplayWave(undefined); setPaused(false);
    setConfirmStart(false); setChangingPassword(false); setPollError(""); setNotice("");
  }, []);
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof FieldRequestError && cause.status === 401) clearSession();
    setError(messageOf(cause));
  }, [clearSession]);
  const refreshRecordings = useCallback(async () => {
    const epoch = generation.current;
    const data = await fieldCall<{ recordings: FieldRecording[] }>({ action: "recordings" });
    if (mounted.current && epoch === generation.current) { setRecordings(data.recordings || []); setRecordingsLoaded(true); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let canceled = false;
    fieldCall<FieldSession>({ action: "session" }).then((data) => { if (!canceled && data?.user) setSession(data); }).catch((cause) => {
      if (!canceled && !(cause instanceof FieldRequestError && cause.status === 401)) setError(messageOf(cause));
    }).finally(() => { if (!canceled) setLoading(false); });
    try {
      const saved = JSON.parse(localStorage.getItem("blade-field-config-v1") || "null");
      if (saved && typeof saved === "object") setConfig(Object.fromEntries(Object.keys(blankConfig).map((key) => [key, typeof saved[key] === "string" ? saved[key] : ""])) as FieldConfig);
    } catch { /* A corrupt optional form draft never prevents local login. */ }
    return () => { canceled = true; mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!session || session.mustChangePassword) return;
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    let lastRecordingState: string | undefined;
    const epoch = generation.current;
    async function poll() {
      try {
        const next = await fieldCall<FieldStatus>({ action: "frame", windowMs });
        if (canceled || epoch !== generation.current) return;
        setStatus(next); setPollError("");
        const signature = `${next.state}:${next.recording?.id || ""}`;
        if (signature !== lastRecordingState && next.service.state === "ready") {
          lastRecordingState = signature;
          refreshRecordings().catch((cause) => { if (!canceled) setPollError(messageOf(cause)); });
        }
      } catch (cause) {
        if (canceled || epoch !== generation.current) return;
        if (cause instanceof FieldRequestError && cause.status === 401) { clearSession(); setError("本机会话已失效，请重新登录"); return; }
        setPollError(messageOf(cause));
      }
      if (!canceled) timer = setTimeout(poll, refreshMs);
    }
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [session, refreshRecordings, clearSession, windowMs, refreshMs]);
  useEffect(() => { if (!paused && status?.waveform) setDisplayWave(status.waveform); }, [status?.waveform, paused]);
  useEffect(() => { setPaused(false); setScale(status?.recording?.velocityRangeMps || 0.5); }, [status?.recording?.id, status?.recording?.velocityRangeMps]);

  async function operate(action: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(action); setError(""); setNotice("");
    try { await fn(); } catch (cause) { handleError(cause); } finally { if (mounted.current) setBusy(""); }
  }
  async function logout() {
    await operate("logout", async () => { await fieldCall({ action: "logout" }); clearSession(); });
  }
  async function savePassword(currentPassword: string, newPassword: string) {
    await operate("password", async () => {
      const next = await fieldCall<FieldSession>({ action: "changePassword", currentPassword, newPassword });
      setSession(next); setChangingPassword(false); setNotice("本机密码已更新，请妥善保存新密码。");
    });
  }
  async function serviceAction(action: "restartService" | "configureService" | "configureDll" | "openDataDirectory") {
    await operate(action, async () => {
      const response = await fieldCall<{ canceled?: boolean }>({ action });
      if (response?.canceled) return;
      setStatus(await fieldCall<FieldStatus>({ action: "status" }));
      if (action !== "openDataDirectory") setNotice(action === "restartService" ? "已请求重启采集服务，请查看最新服务状态。" : "配置已保存，请确认服务与 SDK 状态。配置不会自动开启激光或采集。");
    });
  }
  async function stopAcquisition() {
    await operate("stop", async () => {
      await fieldCall({ action: "stop" });
      const stopped = await fieldCall<FieldStatus>({ action: "status" });
      setStatus(stopped); await refreshRecordings();
      if (stopped.state === "error" || stopped.recording?.status === "error") throw new Error(`${stopped.error || stopped.recording?.error || "本次记录异常"}。请在现场确认激光已关闭，并检查本机数据，不能将异常记录视为完整采集。`);
      setNotice("已执行停止采集并尝试关闭激光，请在现场核对设备状态、记录保存状态与原始点数。");
    });
  }
  const active = fieldIsActive(status);
  const ready = fieldCanStart(status);
  const waveform = status?.waveform;
  const latestVelocity = waveform?.latest?.velocity ?? waveform?.values.at(-1);
  const latestRssi = waveform?.latest ? waveform.latest.rssi : waveform?.rssi.at(-1);
  const overrange = waveform?.overrangeCount ?? waveform?.overrange.filter(Boolean).length;
  const displayVelocity = typeof latestVelocity === "number" ? latestVelocity * (velocityUnit === "mm/s" ? 1000 : 1) : null;
  const velocityLabel = displayVelocity !== null && Number.isFinite(displayVelocity) ? Math.abs(displayVelocity) > 0 && Math.abs(displayVelocity) < 0.001 ? displayVelocity.toExponential(3) : Number(displayVelocity.toPrecision(5)).toString() : "—";

  return <div className="field-app"><FieldTitlebar />
    {loading ? <div className="field-loading"><LoaderCircle className="spin" size={25} /><p>正在打开本机工作台…</p></div> : !session ? <FieldLoginPanel available={Boolean(fieldBridge())} busy={Boolean(busy)} error={error} onLogin={async (username, password) => {
      await operate("login", async () => { clearSession(); const next = await fieldCall<FieldSession>({ action: "login", username, password }); setSession(next); });
    }} /> : session.mustChangePassword || changingPassword ? <main className="field-password-shell"><FieldPasswordPanel mandatory={session.mustChangePassword} busy={Boolean(busy)} error={error} onSave={savePassword} onCancel={() => { if (session.mustChangePassword) void logout(); else { setChangingPassword(false); setError(""); } }} /></main> : <>
      <header className="field-header"><div className="field-brand"><div className="field-brand-icon"><Activity size={19} /></div><span>BladeVMS <small>现场采集工作台</small></span></div><div className="field-header-right"><span className="field-local-label"><HardDrive size={13} />本机运行 · 无需互联网</span><span className="field-header-user"><span className="field-avatar">A</span>{session.user.name || session.user.username}</span><Button variant="ghost" disabled={Boolean(busy) || active} onClick={() => setChangingPassword(true)} aria-label="修改本机密码"><LockKeyhole size={15} /></Button><Button variant="ghost" disabled={Boolean(busy) || active} onClick={() => void logout()} title={active ? "请先停止并保存采集" : "退出本机账号"}><LogOut size={15} />退出</Button></div></header>
      {active && <div className="field-live-controls" aria-label="采集安全控制"><p><strong>{status ? stateLabels[status.state] : "采集服务运行中"}</strong> · 滚动页面或切换栏目后，仍可在此停止并保存。</p><Button type="button" variant="danger" disabled={Boolean(busy) || status?.state === "stopping"} onClick={() => void stopAcquisition()}>{busy === "stop" ? <LoaderCircle className="spin" size={15} /> : <Square size={13} />}停止并保存</Button></div>}
      <div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button className={screen === "acquisition" ? "active" : ""} onClick={() => setScreen("acquisition")}><Activity size={17} />数据采集</button><button className={screen === "recordings" ? "active" : ""} onClick={() => { setScreen("recordings"); void operate("recordings", refreshRecordings); }}><HardDrive size={17} />本机记录</button><button className={screen === "service" ? "active" : ""} onClick={() => setScreen("service")}><Settings size={17} />设备与服务</button><p>算法扩展</p><button className={screen === "rotation" ? "active" : ""} title="固定 RPM 台架模型分析" onClick={() => setScreen("rotation")}><Radio size={17} />旋转测振<span>恒转速</span></button><button className={screen === "analysis" ? "active" : ""} onClick={() => setScreen("analysis")}><AudioLines size={17} />信号处理</button><div className="field-sidebar-note"><CircleHelp size={17} /><strong>数据边界</strong><span>当前接入为 CH1 振动速度及 RSSI 回波强度；多点融合使用多条独立记录和固定 RPM 假设。</span></div></aside>
        <main className="field-content"><div className="field-page-heading"><div><span className="field-eyebrow">WINDOWS · FIELD WORKSTATION</span><h1>{screen === "acquisition" ? "数据采集" : screen === "recordings" ? "本机采集记录" : screen === "rotation" ? "旋转测振" : screen === "analysis" ? "信号处理" : "设备与本机服务"}</h1><p>{screen === "acquisition" ? "从真实设备读取，原始数据由本机采集服务独立保存。" : screen === "recordings" ? "浏览全程波形，通过概览拖动、缩放和时间区间定位。" : screen === "rotation" ? "按室内风机恒定 RPM 假设计算阶次谱、同步平均和多点融合。" : screen === "analysis" ? "基于已保存的连续原始速度计算，分析结果可追溯至记录和采样区间。" : "准备好设备驱动和采集服务后，即可在无网环境中工作。"}</p></div><span className={`field-badge ${status?.state === "acquiring" ? "green" : status?.state === "error" ? "red" : ""}`}><span className="field-status-dot" />{status ? stateLabels[status.state] : "读取状态中"}</span></div>
          {(error || pollError) && <div className="field-error field-global-message" role="alert"><AlertTriangle size={17} /><span>{error || pollError}</span></div>}
          {notice && <div className="field-success field-global-message" role="status"><Check size={17} /><span>{notice}</span></div>}
          {status?.deviceWarning && <p className="field-notice warning" role="alert">{status.deviceWarning}</p>}
          {busy === "device" && <p className="field-notice warning">设备配置操作进行中，请等待结果。自动聚焦涉及激光，请留意现场状态。</p>}
          {status?.indexWarning && <div className="field-notice warning field-global-message" role="status"><AlertTriangle size={17} /><span>本机索引提示：{status.indexWarning}</span></div>}
          {screen === "analysis" && <FieldAnalysis request={fieldCall} onError={handleError} />}
          {screen === "rotation" && <FieldRotation request={fieldCall} onError={handleError} />}
          {screen === "acquisition" && <div className="field-acquisition-grid"><div className="field-main-column">
            <section className="field-card"><div className="field-section-heading"><div><h2>采集任务</h2><p>选择本机连接设备的网卡 IP；不会自动修改电脑的网络配置。</p></div><span className="field-badge">真实设备模式</span></div>
              <form onSubmit={(event) => { event.preventDefault(); const invalid = validateFieldConfig(config); if (invalid) { setError(invalid); return; } setError(""); setConfirmStart(true); }}><fieldset disabled={Boolean(busy) || active} className="field-config-grid">{([
                ["name", "任务名称", "填写本次采集任务名称", true], ["object", "测量对象", "如叶片或试件编号", false], ["turbine", "设备 / 机组", "填写设备或机组编号", false], ["point", "测点", "填写测点名称", false], ["deviceIp", "设备 IP", "设备 IPv4 地址", true], ["hostIp", "本机设备网卡 IP", "连接设备的本机 IPv4 地址", true],
              ] as const).map(([key, label, placeholder, required]) => <label key={key}>{label}{required && <span className="field-required"> *</span>}<input value={config[key]} placeholder={placeholder} required={required} maxLength={key.endsWith("Ip") ? 15 : 120} onChange={(event) => setConfig((previous) => ({ ...previous, [key]: event.target.value }))} /></label>)}</fieldset>
                <div className="field-acquisition-actions"><p><ShieldCheck size={14} />开始前将确认目标 IP、激光与数据保存。</p><Button type="button" variant="danger" disabled={Boolean(busy) || !active || status?.state === "stopping"} onClick={() => void stopAcquisition()}>{busy === "stop" ? <LoaderCircle className="spin" size={15} /> : <Square size={13} />}停止并保存</Button><Button type="submit" variant="primary" disabled={Boolean(busy) || !ready || Boolean(pollError)}><Play size={15} />开始真实采集</Button></div>
                {active && <p className="field-inline-help">本次采集独占激光控制。停止时会尝试关闭激光并保存数据；异常时须在现场确认激光状态。</p>}
                {!ready && !active && <p className="field-inline-help">尚不能开始采集，请在“本机采集服务”中确认服务已就绪且设备 DLL 已配置。</p>}
              </form>
            </section>
            <section className="field-card field-wave-card"><div className="field-section-heading"><div><h2>CH1 · 振动速度</h2><p>固定纵轴、分段刷新；显示设置不改变原始采集数据。</p></div><span className="field-legend"><i />{velocityUnit}</span></div>
              <div className="field-wave-options"><label>时间窗<select aria-label="实时显示时间窗" value={windowMs} onChange={event => setWindowMs(Number(event.target.value))}>{[20, 100, 500, 1000].map(value => <option key={value} value={value}>{value} ms</option>)}</select></label><label>刷新间隔<select aria-label="刷新间隔" value={refreshMs} onChange={event => setRefreshMs(Number(event.target.value))}><option value={500}>0.5 秒（2 次/秒）</option><option value={1000}>1 秒</option><option value={250}>0.25 秒</option></select></label><Button disabled={!hasWave(displayWave)} onClick={() => setPaused(value => !value)}>{paused ? "恢复实时显示" : "暂停显示"}</Button></div>
              <FieldWaveOptions timeMode={timeMode} onTime={setTimeMode} unit={velocityUnit} onUnit={setVelocityUnit} scale={scale} onScale={setScale} fit={() => setScale(waveLimit(displayWave))} />
              {status?.recording?.velocityRangeMps && <Button variant="ghost" onClick={() => setScale(status.recording!.velocityRangeMps!)}>按设备量程显示</Button>}
              {paused && <p className="field-notice warning">仅暂停图表显示，采集与原始数据保存继续；指标和点数仍更新。结束采集请点“停止并保存”。</p>}
              <FieldWaveChart waveform={displayWave} unit={velocityUnit} yLimit={scale} timeMode={timeMode} />
              <div className="field-chart-foot"><span>当前窗口 {count(displayWave?.sourceSamples ?? displayWave?.values.length)} 个原始样本</span><span>实际跨度 {displayWave?.sampleRate && hasWave(displayWave) ? ((waveBounds(displayWave)[1] - waveBounds(displayWave)[0]) / displayWave.sampleRate * 1000).toFixed(3) + " ms" : "—"}</span><span>{displayWave?.representation === "envelope" ? "区间最小/最大值包络 · 保留峰值" : "逐点波形"}</span></div>
              <p className="field-subtext">实际时间由本机 DAQ 起点与采样序号推算，非硬件同步时钟。纵轴只是显示范围；放大微小幅值也会放大量化台阶。未做平滑滤波。</p>
            </section>
            <section className="field-card field-wave-card"><div className="field-section-heading"><div><h2>RSSI · 激光回波强度</h2><p>用于判断回波信号质量，不代表第二路振动。</p></div><span className="field-legend green"><i />%</span></div><FieldWaveChart waveform={displayWave} kind="rssi" timeMode={timeMode} /></section>
          </div><div className="field-right-column"><FieldRealtimePanel realtime={status?.realtime} /><section className="field-card"><div className="field-section-heading"><h2>采集指标</h2><span className="field-subtext">真实接收值</span></div><div className="field-metric-grid"><div><span>采样率</span><strong>{waveform?.sampleRate ? count(waveform.sampleRate) : "—"}<small>Hz</small></strong></div><div><span>当前振动速度</span><strong>{velocityLabel}<small>{velocityUnit}</small></strong></div><div><span>当前 RSSI</span><strong>{typeof latestRssi === "number" && Number.isFinite(latestRssi) ? latestRssi.toFixed(1) : "—"}<small>%</small></strong></div><div className={overrange ? "field-metric-warning" : ""}><span>窗口超量程点数</span><strong>{hasWave(waveform) ? count(overrange) : "—"}<small>点</small></strong></div></div></section>
            <section className="field-card"><div className="field-section-heading"><h2>当前记录</h2><HardDrive size={16} /></div>{status?.recording ? <><h3 className="field-current-name">{status.recording.name}</h3><dl className="field-details"><div><dt>原始点数</dt><dd className="mono">{count(status.recording.samples)}</dd></div><div><dt>开始时间</dt><dd>{timeOf(status.recording.startedAt)}</dd></div><div><dt>保存状态</dt><dd>{status.recording.status === "complete" ? "已完成" : status.recording.status === "error" ? "异常" : "采集中 / 未完整结束"}</dd></div></dl>{status.recording.error && <p className="field-error">{status.recording.error}</p>}</> : <p className="field-subtext">暂无本次采集记录。点击开始采集后创建真实任务，不生成预置数据。</p>}</section>
            <FieldServicePanel status={status} busy={Boolean(busy)} onAction={(action) => void serviceAction(action)} />
          </div></div>}
          {screen === "recordings" && <><section className="field-card"><div className="field-section-heading"><div><h2>真实采集记录</h2><p>未完整结束的记录保留状态标记，请勿视为完整测量。</p></div><div className="field-form-actions"><Button disabled={Boolean(busy)} onClick={() => void serviceAction("openDataDirectory")}><FolderOpen size={14} />打开数据目录</Button><Button disabled={Boolean(busy)} onClick={() => void operate("recordings", refreshRecordings)}><RefreshCw size={14} />刷新列表</Button></div></div>{recordingsLoaded ? <FieldRecordingList recordings={recordings} busy={Boolean(busy)} selectedId={selected?.recording.id} onSelect={(id) => void operate("recording", async () => { const data = await fieldCall<FieldRecordingDetail>({ action: "recording", id }); setSelected(data); })} /> : <p className="field-notice">记录列表尚未读取成功，请确认采集服务可用后刷新。服务不可用不代表本机没有保存数据。</p>}</section>
            {selected && <section className="field-card field-recording-preview"><div className="field-section-heading"><div><h2>{selected.recording.name} · 波形预览</h2><p>{timeOf(selected.recording.startedAt)} · 全程浏览与区间放大</p></div><Button variant="ghost" onClick={() => setSelected(null)}>关闭预览</Button></div>{selected.recording.error && <p className="field-error">{selected.recording.error}</p>}<FieldRecordingViewer key={selected.recording.id} detail={selected} load={fieldCall} onError={handleError} /><details className="field-recorded-settings"><summary>查看本次采集的设备配置快照</summary><FieldDeviceSnapshot settings={selected.recording.deviceSettings} /></details></section>}
          </>}
          {screen === "service" && <div className="field-settings-grid"><FieldDevicePanel deviceIp={config.deviceIp} onIp={deviceIp => setConfig(previous => ({ ...previous, deviceIp }))} status={status} disabled={Boolean(busy)} onBusy={value => setBusy(value ? "device" : "")} onError={handleError} request={request => fieldCall<FieldDeviceSettings>({ action: "device", request })} /><FieldServicePanel status={status} busy={Boolean(busy)} onAction={(action) => void serviceAction(action)} /><section className="field-card"><div className="field-section-heading"><h2>Windows 实机联调检查</h2></div><ol className="field-checklist"><li><strong>安装完整 Windows x64 工作台</strong><p>1.3.0 安装包内置 Python 运行环境、采集服务和设备 DLL，并检测 VC++ 运行库；无需另装 Python。若安装器提示重启，请先重启电脑。</p></li><li><strong>确认内置服务与 DLL 已就绪</strong><p>打开工作台会自动启动本机服务，但不会连接设备或开启激光。手动选择服务或 DLL 仅用于同事联调替换，不是首次使用的必需步骤。</p></li><li><strong>确认设备网络与安全</strong><p>填写设备 IP 与本机设备网卡 IP，检查网线、防火墙和激光作业安全。厂商要求的额外驱动按设备说明准备。</p></li><li><strong>采集、停止并核对保存结果</strong><p>检查采样率、原始点数、RSSI 与超量程状态，再从本机目录核对完整数据。页面高度不足时可纵向滚动；采集期间顶部保留停止并保存入口。</p></li></ol><div className="field-notice">本机账号独立于 Web 账号。集中管理和联网回传需要另外配置管理服务器；本页面不代表新采集记录已自动上传。</div></section></div>}
        </main>
      </div><footer className="field-statusbar"><span><span className={`field-status-dot ${status?.service.state === "ready" ? "green" : ""}`} />{status ? serviceLabels[status.service.state] : "正在读取本机状态"}</span><span>CH1 速度 + RSSI · 原始数据本机保存</span><span>Windows x64 · 无模拟采集</span></footer>
    </>}
    {confirmStart && <FieldStartDialog config={config} busy={Boolean(busy)} error={error} onClose={() => { setConfirmStart(false); setError(""); }} onStart={() => void operate("start", async () => {
      const normalized = Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value.trim()])) as FieldConfig;
      const invalid = validateFieldConfig(normalized); if (invalid) throw new Error(invalid);
      await fieldCall({ action: "start", config: { ...normalized, confirmLaser: true } });
      try { localStorage.setItem("blade-field-config-v1", JSON.stringify(normalized)); } catch { /* Saving a draft is optional; raw acquisition storage is managed by Python. */ }
      setConfig(normalized); setConfirmStart(false); setStatus(await fieldCall<FieldStatus>({ action: "status" }));
      setNotice("已向设备发送采集请求，请核对真实接收值与保存状态。");
    })} />}
  </div>;
}
