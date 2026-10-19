"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, AudioLines, Check,
  FolderOpen, HardDrive, LoaderCircle, LockKeyhole, LogOut, Minus,
  Play, Radio, RefreshCw, Settings, ShieldCheck, Square, X,
} from "lucide-react";
import { Button, Dialog } from "./common";
import { FieldRecordingViewer } from "./field-waveform";
import { FieldDevicePanel, FieldDeviceSnapshot } from "./field-device";
import { FieldAnalysis } from "./field-analysis";
import { FieldAcquisition } from "./field-acquisition";
import { FieldTurntableWorkspace } from "./field-auto-follow";
import { turntableReferenceSignature } from "./field-turntable-points";
import { FieldBladeSummary } from "./field-blade-summary";
import { FieldAccountPanel, FieldCloudSyncPanel, FieldBindAccountDialog, fieldAccountServerDefault, fieldAccountTime, type FieldBindValues } from "./field-account";
import {
  fieldCaptureConfig, fieldDate, fieldIsActive, fieldTurntableReady, validateFieldConfig,
  type FieldConfig, type FieldRecording, type FieldRecordingDetail,
  type FieldRequest, type FieldRequestOptions, type FieldSession, type FieldAccountInfo,
  type FieldStatus, type FieldDeviceSettings, type FieldRssiCalibrationResult,
  type FieldSyncStatus,
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
  if (!bridge) throw new FieldRequestError("当前不是已集成本机采集服务的桌面程序，请使用桌面工作台。浏览器预览不连接本机采集服务。", 503);
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

export function FieldLoginPanel({ busy, error, available, account, accountUnavailable = false, onRetry, onLogin }: {
  busy: boolean; error: string; available: boolean;
  account?: FieldAccountInfo | null; accountUnavailable?: boolean; onRetry?: () => void;
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const unified = account?.mode === "unified";
  const loginName = unified ? account.username || "" : username;
  return <main className="field-auth-shell">
    <section className="field-auth-intro">
      <div className="field-brand"><Activity size={25} /><span>BladeVMS <small>FIELD WORKSTATION</small></span></div>
      <div><h1>现场采集工作台</h1><p>振动信号采集与分析</p></div>
      <div className="field-auth-features"><span><HardDrive size={16} />原始数据保存在本机</span><span><Radio size={16} />CH1 振动速度 + RSSI</span><span><ShieldCheck size={16} />{unified ? "统一账号 · 支持限期离线验证" : accountUnavailable ? "正在确认账号配置" : "本机账号独立验证"}</span></div>
    </section>
    <section className="field-auth-card">
      <div className="field-auth-icon"><LockKeyhole size={24} /></div>
      <h2>登录现场工作台</h2><p className="field-subtext">{unified ? "使用与 Web 相同的账号密码；联网时验证账号，断网时在有效期内使用本机验证。" : accountUnavailable ? "请先读取账号配置，再登录工作台。" : "使用这台电脑的本机账号，不是 Web 管理端账号。"}</p>
      {unified && <div className="field-login-account"><span>已绑定 Web 服务器</span><strong>{account.serverUrl || "—"}</strong><p>{account.onlineRequired ? "本次登录需要联网验证，离线缓存不可用。" : account.offlineUntil ? `离线有效期至 ${fieldAccountTime(account.offlineUntil)}` : "尚无可用离线验证记录，请联网登录。"}</p></div>}
      <form onSubmit={async (event) => { event.preventDefault(); if (busy || !available || accountUnavailable) return; try { await onLogin(loginName.trim(), password); } finally { setPassword(""); } }}>
        <label>{unified ? "统一账号" : "账号"}<input autoComplete="username" name="username" value={loginName} onChange={(event) => setUsername(event.target.value)} readOnly={unified} required disabled={busy || accountUnavailable} /></label>
        <label>{unified ? "Web 账号密码" : "密码"}<input autoComplete="current-password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy || accountUnavailable} /></label>
        {error && <p className="field-error" role="alert">{error}</p>}
        {!available && <p className="field-notice">请在桌面应用中使用。本浏览器预览不提供本机登录与设备采集。</p>}
        <Button type="submit" variant="primary" className="full" disabled={busy || !available || accountUnavailable || !loginName}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}登录工作台</Button>
        {accountUnavailable && onRetry && <Button type="button" disabled={busy} onClick={onRetry}>重新读取账号配置</Button>}
      </form>
      <p className="field-auth-footnote">{unified ? "离线验证自上次联网成功起最多有效 30 天，到期须联网登录。账号或密码在 Web 变更后，于下次联网登录时校验；统一模式不回退旧本机账号。" : accountUnavailable ? "读取账号配置成功后显示登录方式；不会因读取失败而切换账号来源。" : "预制管理员账号：admin。初始密码由交付人员单独提供；首次登录必须修改密码。"}</p>
    </section>
  </main>;
}

export function FieldPasswordPanel({ mandatory, busy, error, account, onSave, onCancel }: {
  mandatory: boolean; busy: boolean; error: string;
  account?: FieldAccountInfo | null;
  onSave: (currentPassword: string, newPassword: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState("");
  const unified = account?.mode === "unified";
  return <section className="field-password-card">
    <div className="field-auth-icon"><ShieldCheck size={24} /></div>
    <h2>{unified ? "修改统一密码" : mandatory ? "首次登录 · 设置专属密码" : "修改本机密码"}</h2>
    <p className="field-subtext">{unified ? "需要联网修改 Web 账号密码。新密码用于 Web 与所有已绑定桌面；其他桌面在下次联网登录时校验，不会强制中断正在运行的采集。" : mandatory ? "为保护现场数据，请先更换交付初始密码，再进入工作台。" : "修改仅影响这台电脑的管理员账号，不修改 Web 管理端账号。"}</p>
    {unified && <p className="field-notice field-account-password-note">{account.offline ? "当前会话使用离线验证，请恢复网络后再保存。" : "保存时会连接已绑定的 Web 服务器验证当前密码。"} 其他桌面的旧离线凭据最多在其原有 30 天有效期内可用，联网验证后才更新。</p>}
    <form onSubmit={async (event) => {
      event.preventDefault(); setValidation("");
      if (busy) return;
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
    <div className="field-section-heading"><h2>本机采集服务</h2><Settings size={18} /></div>
    <div className={`field-service-state ${service?.state === "ready" ? "ready" : ""}`}><span className="field-status-dot" />{service ? serviceLabels[service.state] : "正在读取服务状态"}</div>
    <dl className="field-details"><div><dt>设备 SDK</dt><dd>{service ? service.dllConfigured ? "已配置" : "未配置" : "—"}</dd></div><div><dt>数据保存位置</dt><dd>本机应用数据目录</dd></div><div><dt>连接方式</dt><dd>设备网卡</dd></div></dl>
    {service?.executable && <p className="field-path" title={service.executable}>采集服务：{service.executable}</p>}
    {service?.sdkPath && <p className="field-path" title={service.sdkPath}>设备 SDK：{service.sdkPath}</p>}
    {(service?.error || status?.error) && <p className="field-error" role="alert">{service?.error || status?.error}</p>}
    {service?.state === "missing" && <p className="field-notice">未找到采集服务，请检查本机采集服务安装。</p>}
    {service && !service.dllConfigured && <p className="field-notice">尚未配置厂商 SDK。可以查看已保存记录，不能开始真实采集。厂商驱动需按安装说明准备。</p>}
    <div className="field-service-actions"><Button disabled={busy || active || service?.launcher === "python-module"} onClick={() => onAction("configureService")}><FolderOpen size={14} />选择采集服务 EXE</Button><Button disabled={busy || active} onClick={() => onAction("configureDll")}><FolderOpen size={14} />选择设备 SDK</Button><Button disabled={busy || active} onClick={() => onAction("restartService")}><RefreshCw size={14} />重启采集服务</Button><Button disabled={busy} onClick={() => onAction("openDataDirectory")}><HardDrive size={14} />打开数据目录</Button></div>
    {active && <p className="field-subtext">采集期间不能更换或重启服务，请先停止并保存。</p>}
  </section>;
}

export function FieldStartDialog({ config, busy, error, onClose, onStart }: {
  config: FieldConfig; busy: boolean; error: string; onClose: () => void; onStart: () => void;
}) {
  const [laser, setLaser] = useState(false), [target, setTarget] = useState(false), [capture, setCapture] = useState(false), [motion, setMotion] = useState(false);
  return <Dialog title="开始真实采集前确认" onClose={() => { if (!busy) onClose(); }}>
    <div className="field-confirm"><div className="field-confirm-body"><p className="field-notice warning"><AlertTriangle size={17} />此操作会向真实设备发送控制指令。请先确认现场激光安全、设备状态和网卡配置。</p>
      <dl className="field-details"><div><dt>任务</dt><dd>{config.name}</dd></div><div><dt>设备 IP</dt><dd>{config.deviceIp}</dd></div><div><dt>本机设备网卡 IP</dt><dd>{config.hostIp}</dd></div></dl>
      <label><input type="checkbox" checked={target} disabled={busy} onChange={(event) => setTarget(event.target.checked)} /><span>允许将设备 DAQ 数据目标 IP 修改为 <b>{config.hostIp}</b>，并确认这不是其他电脑正在使用的采集连接。</span></label>
      <label><input type="checkbox" checked={laser} disabled={busy} onChange={(event) => setLaser(event.target.checked)} /><span>已确认现场人员与光路安全，允许开启设备激光。本次采集独占激光控制；停止时会尝试关闭激光，异常时须在现场确认设备状态。</span></label>
      <label><input type="checkbox" checked={capture} disabled={busy} onChange={(event) => setCapture(event.target.checked)} /><span>允许开始采集 CH1 振动速度及 RSSI，并将原始数据保存到本机。</span></label>
      {config.turntable && <label><input type="checkbox" checked={motion} disabled={busy} onChange={event => setMotion(event.target.checked)} /><span>允许 {config.turntable.port} 轴 {config.turntable.axis} 以输出轴 {config.turntable.speedRpm} rpm {config.turntable.protocol === "position" ? `定位至 ${config.turntable.targetAngleDeg}°，到位后保持采集` : `${config.turntable.direction === "forward" ? "正向" : "反向"}连续转动`}。已确认参考坐标、限位与外部 SON；停止并保存将先停止转盘。{config.turntable.durationSeconds > 0 ? `约 ${config.turntable.durationSeconds} 秒后自动停止联合任务。` : "本任务需人工停止。"}</span></label>}
      {error && <p className="field-error" role="alert">{error}</p>}</div>
      <div className="field-form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy || !target || !laser || !capture || !!config.turntable && !motion} onClick={onStart}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}确认并开始采集</Button></div>
    </div>
  </Dialog>;
}

export function FieldRecordingList({ recordings, selectedId, busy, onSelect, onExport, onUpload, syncedIds = [] }: {
  recordings: FieldRecording[]; selectedId?: string; busy: boolean; onSelect: (id: string) => void; onExport?: (id: string) => void; onUpload?: (id: string) => void; syncedIds?: string[];
}) {
  if (!recordings.length) return <div className="field-recordings-empty"><HardDrive size={28} /><h3>还没有采集记录</h3><p>完成采集后，可在此查看记录。</p></div>;
  return <div className="field-table-scroll" role="region" aria-label="本机采集记录，可横向滚动查看所有列" tabIndex={0}><table className="field-table"><thead><tr><th>任务 / 对象</th><th>转盘点位</th><th>开始时间</th><th>原始点数</th><th>采样率</th><th>保存状态</th><th>操作</th></tr></thead><tbody>{recordings.map((recording) => <tr key={recording.id} className={selectedId === recording.id ? "selected" : ""}><td><strong>{recording.name}</strong><span className={`field-badge ${recording.source === "simulation" ? "amber" : ""}`}>{recording.source === "simulation" ? "模拟" : "设备"}</span><small>{[recording.object, recording.turbine, recording.point].filter(Boolean).join(" / ") || "未填写对象信息"}</small></td><td>{recording.pointCycle ? <><strong>{recording.pointCycle.pointName}</strong><small>轴1 {recording.pointCycle.targetAxis1AngleDeg.toFixed(3)}° · 轴2 {recording.pointCycle.targetAxis2AngleDeg.toFixed(3)}°</small></> : "—"}</td><td>{timeOf(recording.startedAt)}</td><td className="mono">{count(recording.samples)}</td><td className="mono">{recording.sampleRate ? `${count(recording.sampleRate)} Hz` : "未知"}</td><td><span className={`field-badge ${recording.status === "complete" ? "green" : recording.status === "error" ? "red" : "amber"}`}>{recording.status === "complete" ? "已完成" : recording.status === "error" ? "异常记录" : "采集中 / 未完整结束"}</span></td><td><div className="field-record-actions"><Button disabled={busy} onClick={() => onSelect(recording.id)}>查看波形</Button>{onExport && <Button disabled={busy || recording.status !== "complete"} onClick={() => onExport(recording.id)}>导出原始数据</Button>}{onUpload && <Button disabled={busy || recording.status !== "complete" || syncedIds.includes(recording.id)} onClick={() => onUpload(recording.id)}>{syncedIds.includes(recording.id) ? "已上传 Web" : "上传至 Web"}</Button>}</div></td></tr>)}</tbody></table></div>;
}

export function FieldDesktopApp() {
  const [session, setSession] = useState<FieldSession | null>(null);
  const [syncStatus, setSyncStatus] = useState<FieldSyncStatus | null>(null);
  const [account, setAccount] = useState<FieldAccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<FieldStatus | null>(null);
  const [recordings, setRecordings] = useState<FieldRecording[]>([]);
  const [recordingsLoaded, setRecordingsLoaded] = useState(false);
  const [selected, setSelected] = useState<FieldRecordingDetail | null>(null);
  const [screen, setScreen] = useState<"acquisition" | "turntable" | "recordings" | "service" | "analysis">("acquisition");
  const [turntableVisited, setTurntableVisited] = useState(false);
  const [turntableOperationBusy, setTurntableOperationBusy] = useState(false);
  const [stoppingCapture, setStoppingCapture] = useState(false);
  const stopPending = useRef(false);
  const [config, setConfig] = useState<FieldConfig>(blankConfig);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);
  const [confirmStart, setConfirmStart] = useState<{ config: FieldConfig; references?: string } | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [bindingAccount, setBindingAccount] = useState(false);
  const [windowMs, setWindowMs] = useState(1000), [refreshMs, setRefreshMs] = useState(100);
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [screen]);
  const generation = useRef(0);
  const mounted = useRef(true);

  const clearSession = useCallback(() => {
    generation.current += 1; setSyncStatus(null); setSession(null); setStatus(null); setRecordings([]); setRecordingsLoaded(false); setSelected(null);
    setConfirmStart(null); setChangingPassword(false); setBindingAccount(false); setPollError(""); setNotice(""); setTurntableVisited(false); setTurntableOperationBusy(false);
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
  const refreshAccountInfo = useCallback(async () => {
    const info = await fieldCall<FieldAccountInfo>({ action: "accountInfo" });
    if (mounted.current) setAccount(info);
  }, []);
  const acceptSession = useCallback((next: FieldSession) => {
    setSession(next);
    if (next.account) setAccount(next.account);
  }, []);
  useEffect(() => {
    mounted.current = true;
    let canceled = false;
    const accountRequest = fieldCall<FieldAccountInfo>({ action: "accountInfo" }).then(data => { if (!canceled) setAccount(data); }).catch(cause => {
      if (!canceled) setError(`账号配置读取失败：${messageOf(cause)}`);
    });
    const sessionRequest = fieldCall<FieldSession>({ action: "session" }).then((data) => { if (!canceled && data?.user) acceptSession(data); }).catch((cause) => {
      if (!canceled && !(cause instanceof FieldRequestError && cause.status === 401)) setError(messageOf(cause));
    });
    void Promise.allSettled([accountRequest, sessionRequest]).then(() => { if (!canceled) setLoading(false); });
    try {
      const saved = JSON.parse(localStorage.getItem("blade-field-config-v1") || "null");
      if (saved && typeof saved === "object") setConfig({ ...blankConfig, ...Object.fromEntries(Object.keys(blankConfig).map((key) => [key, typeof saved[key] === "string" ? saved[key] : ""])) });
    } catch { /* A corrupt optional form draft never prevents local login. */ }
    return () => { canceled = true; mounted.current = false; };
  }, [acceptSession]);
  useEffect(() => {
    if (!session || session.mustChangePassword) return;
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    let lastRecordingState: string | undefined;
    const epoch = generation.current;
    async function poll() {
      const started = performance.now();
      try {
        const showFrame = screen === "acquisition" && !document.hidden;
        const next = await fieldCall<FieldStatus>(showFrame ? { action: "frame", windowMs } : { action: "status" });
        if (canceled || epoch !== generation.current) return;
        setStatus(next); setPollError(next.service.error || next.error || "");
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
      if (!canceled) timer = setTimeout(poll, Math.max(20, (screen === "acquisition" && !document.hidden ? refreshMs : 1000) - (performance.now() - started)));
    }
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [session, refreshRecordings, clearSession, windowMs, refreshMs, screen]);

  useEffect(() => {
    if (!session || session.mustChangePassword) return;
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    async function pollSync() {
      try { const next = await fieldCall<FieldSyncStatus>({ action: "syncStatus" }); if (!canceled) setSyncStatus(next); }
      catch { if (!canceled) setSyncStatus(previous => previous ? { ...previous, connected: false, state: "error", error: "无法读取同步状态，请稍后重试。" } : null); }
      finally { if (!canceled) timer = setTimeout(pollSync, 2000); }
    }
    void pollSync(); return () => { canceled = true; clearTimeout(timer); };
  }, [session]);

  async function operate(action: string, fn: () => Promise<void>) {
    if (busy || turntableOperationBusy || stoppingCapture) return;
    setBusy(action); setError(""); setNotice("");
    try { await fn(); } catch (cause) { handleError(cause); } finally { if (mounted.current) setBusy(""); }
  }
  async function logout() {
    await operate("logout", async () => { await fieldCall({ action: "logout" }); clearSession(); await refreshAccountInfo(); });
  }
  async function savePassword(currentPassword: string, newPassword: string) {
    if (fieldIsActive(status) || status?.deviceBusy) { setError("请先停止并保存采集，等待设备操作结束后再修改密码。"); return; }
    await operate("password", async () => {
      const next = await fieldCall<FieldSession>({ action: "changePassword", currentPassword, newPassword });
      acceptSession(next); setChangingPassword(false); setNotice(next.account?.mode === "unified" ? "统一密码已更新。其他桌面在下次联网登录时验证新密码；正在运行的采集不受影响。" : "本机密码已更新，请妥善保存新密码。");
    });
    await refreshAccountInfo().catch(() => {});
  }
  async function bindAccount(values: FieldBindValues) {
    if (account?.mode !== "local" || fieldIsActive(status) || status?.deviceBusy) return;
    await operate("bind", async () => {
      const next = await fieldCall<FieldSession>({ action: "bindAccount", ...values });
      acceptSession(next); setBindingAccount(false);
      if (!next.account) await refreshAccountInfo();
      setNotice("已绑定统一账号，此后使用 Web 的同一密码登录；原有记录保留在本机，未自动上传。");
    });
    await refreshAccountInfo().catch(() => {});
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
    if (stopPending.current) return;
    stopPending.current = true; setStoppingCapture(true); setError(""); setNotice("");
    const epoch = generation.current;
    try {
      await fieldCall({ action: "stop" });
      const stopped = await fieldCall<FieldStatus>({ action: "status" });
      if (!mounted.current || epoch !== generation.current) return;
      setStatus(stopped); await refreshRecordings();
      if (!mounted.current || epoch !== generation.current) return;
      if (stopped.state === "error" || stopped.recording?.status === "error") throw new Error(`${stopped.error || stopped.recording?.error || "本次记录异常"}。请在现场确认激光已关闭，并检查本机数据，不能将异常记录视为完整采集。`);
      setNotice(stopped.recording?.source === "simulation" ? "模拟采集已停止，原始记录已保存。" : "已执行停止采集并尝试关闭激光，请在现场核对设备状态、记录保存状态与原始点数。");
    } catch (cause) { if (mounted.current && epoch === generation.current) handleError(cause); }
    finally { stopPending.current = false; if (mounted.current) setStoppingCapture(false); }
  }
  const active = fieldIsActive(status);
  const accountLocked = active || turntableOperationBusy || stoppingCapture || Boolean(status?.deviceBusy || status?.turntableBusy);
  const unifiedAccount = account?.mode === "unified";
  function openPassword() { if (!busy && !accountLocked) { setError(""); setChangingPassword(true); } }

  return <div className="field-app"><FieldTitlebar />
    {loading ? <div className="field-loading"><LoaderCircle className="spin" size={25} /><p>正在打开本机工作台…</p></div> : !session ? <FieldLoginPanel available={Boolean(fieldBridge())} account={account} accountUnavailable={!account} onRetry={() => void operate("account", refreshAccountInfo)} busy={Boolean(busy)} error={error} onLogin={async (username, password) => {
      await operate("login", async () => { clearSession(); const next = await fieldCall<FieldSession>({ action: "login", username, password }); acceptSession(next); });
      await refreshAccountInfo().catch(() => {});
    }} /> : session.mustChangePassword || changingPassword ? <main className="field-password-shell"><FieldPasswordPanel mandatory={session.mustChangePassword} account={account} busy={Boolean(busy)} error={error} onSave={savePassword} onCancel={() => { if (session.mustChangePassword) void logout(); else { setChangingPassword(false); setError(""); } }} /></main> : <>
      <header className="field-header"><div className="field-brand"><div className="field-brand-icon"><Activity size={19} /></div><span>BladeVMS <small>现场采集工作台</small></span></div><div className="field-header-right"><span className={`field-account-header ${account?.offline ? "offline" : ""}`} title={unifiedAccount ? `已绑定 ${account.serverUrl || "Web"}；离线有效期至 ${fieldAccountTime(account.offlineUntil)}` : "原始记录保存在本机"}><ShieldCheck size={13} />{unifiedAccount ? account.offline ? "统一账号 · 离线验证" : "统一账号" : "本机账号"}</span><span className="field-header-user"><span className="field-avatar">{(session.user.name || session.user.username).slice(0, 1).toUpperCase()}</span>{session.user.name || session.user.username}</span><Button variant="ghost" disabled={Boolean(busy) || accountLocked} onClick={openPassword} aria-label={unifiedAccount ? "修改统一密码" : "修改本机密码"}><LockKeyhole size={15} /></Button><Button variant="ghost" disabled={Boolean(busy) || active} onClick={() => void logout()} title={active ? "请先停止并保存采集" : "退出账号"}><LogOut size={15} />退出</Button></div></header>
      {(active || stoppingCapture) && <div className="field-live-controls" aria-label="采集安全控制"><p><strong>{stoppingCapture ? "正在停止并保存" : status ? stateLabels[status.state] : "采集服务运行中"}</strong></p><Button type="button" variant="danger" disabled={stoppingCapture} onClick={() => void stopAcquisition()}>{stoppingCapture ? <LoaderCircle className="spin" size={15} /> : <Square size={13} />}停止并保存</Button></div>}
      <div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button disabled={turntableOperationBusy} className={screen === "acquisition" ? "active" : ""} onClick={() => setScreen("acquisition")}><Activity size={17} />数据采集</button><button disabled={turntableOperationBusy} className={screen === "turntable" ? "active" : ""} onClick={() => { setTurntableVisited(true); setScreen("turntable"); }}><Settings size={17} />转盘点位</button><button disabled={turntableOperationBusy} className={screen === "recordings" ? "active" : ""} onClick={() => { setScreen("recordings"); void operate("recordings", refreshRecordings); }}><HardDrive size={17} />本机记录</button><button disabled={turntableOperationBusy} className={screen === "service" ? "active" : ""} onClick={() => setScreen("service")}><Settings size={17} />设备与服务</button><p>记录分析</p><button disabled={turntableOperationBusy} className={screen === "analysis" ? "active" : ""} onClick={() => setScreen("analysis")}><AudioLines size={17} />信号处理</button></aside>
        <main className="field-content" ref={contentRef}><div className="field-page-heading"><div><h1>{screen === "acquisition" ? "数据采集" : screen === "turntable" ? "转盘点位控制" : screen === "recordings" ? "本机采集记录" : screen === "analysis" ? "信号处理" : "设备与本机服务"}</h1></div><div className="field-page-tools"><span className={`field-badge ${status?.state === "acquiring" ? "green" : status?.state === "error" ? "red" : ""}`}><span className="field-status-dot" />{status ? stateLabels[status.state] : "读取状态中"}</span></div></div>
          {(error || pollError) && <div className="field-error field-global-message" role="alert"><AlertTriangle size={17} /><span>{error || pollError}</span></div>}
          {busy === "export" && <div className="field-notice field-global-message" role="status"><LoaderCircle size={17} className="spin" />正在导出完整原始波形，大记录需要一些时间，请等待保存完成。</div>}
          {notice && <div className="field-success field-global-message" role="status"><Check size={17} /><span>{notice}</span></div>}
          {status?.deviceWarning && <p className="field-notice warning" role="alert">{status.deviceWarning}</p>}
          {busy === "device" && <p className="field-notice warning">设备配置操作进行中，请等待结果。自动聚焦涉及激光，请留意现场状态。</p>}
          {status?.indexWarning && <div className="field-notice warning field-global-message" role="status"><AlertTriangle size={17} /><span>本机索引提示：{status.indexWarning}</span></div>}
          {screen === "analysis" && <FieldAnalysis request={fieldCall} onError={handleError} />}
          <div hidden={screen !== "turntable"}>{turntableVisited && <FieldTurntableWorkspace onOperationBusy={setTurntableOperationBusy} config={config} onConfig={setConfig} status={status} disabled={Boolean(busy)} request={fieldCall} onStatus={setStatus} onService={() => setScreen("service")} onRecords={() => { setScreen("recordings"); void operate("recordings", refreshRecordings); }}
            onJointStart={capture => {
              const invalid = validateFieldConfig(capture);
              const references = status?.turntable?.port === capture.turntable?.port ? turntableReferenceSignature(status?.turntable?.feedback?.axes) : null;
              if (invalid || !references) { setError(invalid || "请先读取两轴有效参考位。"); return; }
              setError(""); setConfirmStart({ config: capture, references });
            }}
            onAcquisition={() => setScreen("acquisition")} onStop={() => void stopAcquisition()} />}</div>
          {screen === "acquisition" && unifiedAccount && syncStatus && <div className="field-cloud-sync-inline" role="status"><strong>Web 同步 · {syncStatus.state === "syncing" ? "正在同步" : syncStatus.state === "ready" ? "已连接" : syncStatus.state === "offline" ? "等待联网登录" : syncStatus.state === "error" ? "同步异常" : "等待联网登录"}</strong><span>{syncStatus.enabled ? "自动同步已开启" : "自动同步已关闭"}</span><span>{syncStatus.items.filter(item => item.state === "synced").length} 条近期已上传 / {syncStatus.items.filter(item => item.state !== "synced").length} 条待完成</span><Button variant="ghost" onClick={() => setScreen("service")}>同步设置</Button></div>}
          {screen === "acquisition" && <FieldAcquisition source="device" config={config} onConfig={setConfig} status={status} busy={busy} pollError={pollError}
            windowMs={windowMs} onWindow={setWindowMs} refreshMs={refreshMs} onRefresh={setRefreshMs} request={fieldCall}
            onDeviceStart={() => { const capture = fieldCaptureConfig(config); const invalid = validateFieldConfig(capture); if (invalid) { setError(invalid); return; } setError(""); setConfirmStart({ config: capture }); }}
            onStop={() => void stopAcquisition()}
            onService={() => setScreen("service")} onRecords={() => { setScreen("recordings"); void operate("recordings", refreshRecordings); }} />}
          {screen === "recordings" && <>{recordingsLoaded && <FieldBladeSummary recordings={recordings} syncItems={syncStatus?.items} onOpenRecording={id => void operate("recording", async () => { setSelected(await fieldCall<FieldRecordingDetail>({ action: "recording", id })); })} />}<section className="field-card"><div className="field-section-heading"><div><h2>本机采集记录</h2></div><div className="field-form-actions"><Button disabled={Boolean(busy)} onClick={() => void serviceAction("openDataDirectory")}><FolderOpen size={14} />打开数据目录</Button><Button disabled={Boolean(busy)} onClick={() => void operate("recordings", refreshRecordings)}><RefreshCw size={14} />刷新列表</Button></div></div>{recordingsLoaded ? <FieldRecordingList recordings={recordings} syncedIds={syncStatus?.items.filter(item => item.state === "synced").map(item => item.recordingId)} onUpload={unifiedAccount ? id => void operate("sync", async () => { await fieldCall({ action: "syncRecording", id }); setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "syncStatus" })); setNotice("已加入 Web 上传队列，可在设备与服务查看进度。"); }) : undefined} busy={Boolean(busy)} selectedId={selected?.recording.id} onExport={id => void operate("export", async () => { const result = await fieldCall<{ saved?: boolean; fileName?: string }>({ action: "exportRecording", id }); if (result.saved) setNotice(`已导出完整原始波形 ${result.fileName}`); })} onSelect={(id) => void operate("recording", async () => { const data = await fieldCall<FieldRecordingDetail>({ action: "recording", id }); setSelected(data); })} /> : <p className="field-notice">记录列表尚未读取成功，请确认采集服务可用后刷新。服务不可用不代表本机没有保存数据。</p>}</section>
            {selected && <section className="field-card field-recording-preview"><div className="field-section-heading"><div><h2>{selected.recording.name} · 波形预览</h2><p>{timeOf(selected.recording.startedAt)} · 全程浏览与区间放大</p></div><Button variant="ghost" onClick={() => setSelected(null)}>关闭预览</Button></div>{selected.recording.error && <p className="field-error">{selected.recording.error}</p>}<FieldRecordingViewer key={selected.recording.id} detail={selected} load={fieldCall} onError={handleError} /><details className="field-recorded-settings"><summary>查看本次采集的设备配置快照</summary><FieldDeviceSnapshot settings={selected.recording.deviceSettings} /></details></section>}
          </>}
          {screen === "service" && <div className="field-settings-grid"><FieldAccountPanel account={account} busy={Boolean(busy)} active={accountLocked} onBind={() => { if (!busy && !accountLocked && account?.mode === "local") { setError(""); setBindingAccount(true); } }} onPassword={openPassword} /><FieldCloudSyncPanel account={account} status={syncStatus} busy={Boolean(busy)} onAuto={enabled => void operate("sync", async () => { await fieldCall({ action: "setAutoSync", enabled }); setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "syncStatus" })); })} onRetry={() => void operate("sync", async () => { await fieldCall({ action: "retrySync" }); setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "syncStatus" })); })} /><FieldDevicePanel deviceIp={config.deviceIp} hostIp={config.hostIp} onIp={deviceIp => setConfig(previous => ({ ...previous, deviceIp }))} status={status} disabled={Boolean(busy)} onBusy={value => setBusy(value ? "device" : "")} onError={handleError} request={request => fieldCall<FieldDeviceSettings>({ action: "device", request })} calibrate={request => fieldCall<FieldRssiCalibrationResult>({ action: "rssiCalibration", request })} /><FieldServicePanel status={status} busy={Boolean(busy)} onAction={(action) => void serviceAction(action)} /><section className="field-card"><div className="field-section-heading"><h2>设备连接检查</h2></div><ol className="field-checklist"><li><strong>检查运行状态</strong><p>确认采集服务和设备驱动已就绪。</p></li><li><strong>确认设备网络与安全</strong><p>确认设备 IP、本机网卡、网络连接和激光作业安全。</p></li><li><strong>采集、停止并核对保存结果</strong><p>停止后核对原始点数、RSSI、超量程和保存状态。</p></li></ol></section></div>}
        </main>
      </div><footer className="field-statusbar"><span><span className={`field-status-dot ${status?.service.state === "ready" ? "green" : ""}`} />{status ? serviceLabels[status.service.state] : "正在读取本机状态"}</span><span>原始数据保存在本机</span></footer>
    </>}
    {bindingAccount && session && !session.mustChangePassword && account?.mode === "local" && <FieldBindAccountDialog busy={Boolean(busy)} active={accountLocked} error={error} initialServerUrl={fieldAccountServerDefault(typeof window === "undefined" ? undefined : window.location)} onClose={() => { setBindingAccount(false); setError(""); }} onBind={bindAccount} />}
    {status?.turntableBusy && !active && status.turntable?.port && status.turntable.axis && <div className="field-live-controls" aria-label="独立试转控制"><p><strong>转盘检查 / 试转进行中 · {status.turntable.port} 轴 {status.turntable.axis}</strong></p><Button type="button" variant="danger" disabled={!!busy || status.turntable.state === "test_stopping"} onClick={() => void operate("turntableStop", async () => { await fieldCall({ action: "turntable", request: { action: "stop", port: status.turntable!.port!, axis: status.turntable!.axis as 1 | 2, confirmMotion: true } }); setStatus(await fieldCall<FieldStatus>({ action: "status" })); })}>停止独立试转</Button></div>}
    {confirmStart && <FieldStartDialog config={confirmStart.config} busy={Boolean(busy)} error={error} onClose={() => { setConfirmStart(null); setError(""); }} onStart={() => void operate("start", async () => {
      const normalized = { ...fieldCaptureConfig(confirmStart.config), ...(confirmStart.config.turntable ? { turntable: { ...confirmStart.config.turntable } } : {}) };
      const invalid = validateFieldConfig(normalized); if (invalid) throw new Error(invalid);
      if (normalized.turntable) {
        const prepared = await fieldCall<FieldStatus>({ action: "turntable", request: { ...normalized.turntable, action: "prepare", confirmMotion: true } });
        setStatus(prepared);
        if (!fieldTurntableReady(prepared, normalized.turntable)) throw new Error("转盘定位设置未通过检查，未开始采集。");
        if (!confirmStart.references || turntableReferenceSignature(prepared.turntable?.feedback?.axes) !== confirmStart.references)
          throw new Error("两轴参考位或计数单位已变化，未开始采集。请重新读取反馈并核对目标角度。");
      }
      await fieldCall({ action: "start", config: { ...normalized, confirmLaser: true, ...(normalized.turntable ? { confirmMotion: true } : {}) } });
      const plain = fieldCaptureConfig(normalized);
      try { localStorage.setItem("blade-field-config-v1", JSON.stringify(plain)); } catch { /* Saving a draft is optional; raw acquisition storage is managed by Python. */ }
      setConfig(plain); setConfirmStart(null); setStatus(await fieldCall<FieldStatus>({ action: "status" })); setScreen("acquisition");
      setNotice("已向设备发送采集请求，请核对真实接收值与保存状态。");
    })} />}
  </div>;
}
