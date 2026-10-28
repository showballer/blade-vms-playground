"use client";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, AudioLines, Check,
  FolderOpen, HardDrive, Layers3, LoaderCircle, LockKeyhole, LogOut, Minus,
  Radio, RefreshCw, Settings, ShieldCheck, Square, X,
} from "lucide-react";
import { Button } from "./common";
import { FieldRecordingDialog } from "./field-recording-dialog";
import { FieldDevicePanel } from "./field-device";
import { FieldHeaderLaser } from "./field-header-laser";
import { FieldTurntableHealth } from "./field-turntable-health";
import { isTurntablePort, readSavedTurntableConnection, turntableConnectionKey } from "./field-turntable-port";
import { FieldAnalysis } from "./field-analysis";
import { WebBladePasses } from "./web-blade-passes";
import { DesktopBladeTemplateComparison, DesktopBladeTemplateSelector } from "./desktop-blade-modal";
import type { BladePassRecording, BladePassResult } from "./web-blade-passes-data";
import { FieldAcquisition, FieldCaptureStatusTags } from "./field-acquisition";
import { FieldTurntableWorkspace, autoFollowCollection, autoFollowCollectionContext } from "./field-auto-follow";
import { autoFollowStorageKey, readAutoFollowSurvey } from "./field-auto-follow-config";
import { segmentedRouteAtAzimuth } from "./field-segmented-plan";
import { positioningRouteContext, replacePositionedTarget, routeAtPositionedStation, type FieldPositionedStation } from "./field-route-position";
import { captureRouteRequestBlockers, prepareCaptureStartRoute, type FieldCaptureRoute } from "./field-capture-route";
import { moveToCapturePreset, presetPositionRequestError } from "./field-preset-position";
import { FieldBladeSummary } from "./field-blade-summary";
import { FieldTaskRecords } from "./field-recording-tasks";
import { FieldAccountPanel, FieldCloudSyncPanel, FieldBindAccountDialog, FieldUnbindAccountDialog, fieldAccountServerDefault, fieldAccountTime, type FieldBindValues, type FieldUnbindValues } from "./field-account";
import {
  fieldCaptureConfig, fieldDate, fieldIsActive, validateFieldConfig,
  type FieldConfig, type FieldRecording,
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
// Stable callbacks keep record refreshes independent of status polling renders.
const localBladeData = {
  listRecordings: () => fieldCall<{ recordings: BladePassRecording[] }>({ action: "recordings" }),
  analyze: async (parameters: Record<string, unknown>) => {
    const sync = await fieldCall<FieldSyncStatus>({ action: "syncStatus" });
    return fieldCall<BladePassResult>({ action: "bladePasses", parameters: { ...parameters, analysisSampleRate: sync.uploadSampleRate ?? 0 } });
  },
};
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
export function fieldStatusPollError(status: FieldStatus): string {
  return status.service.error || (status.service.state === "ready" ? "" : serviceLabels[status.service.state]);
}
const blankConfig: FieldConfig = { deviceIp: "", hostIp: "", name: "", windFarm: "", object: "", turbine: "", point: "" };

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
    <div className="field-service-actions"><Button disabled={busy || active || (service?.launcher === "python-module" || service?.launcher === "macos-bundle")} onClick={() => onAction("configureService")}><FolderOpen size={14} />选择采集服务 EXE</Button><Button disabled={busy || active} onClick={() => onAction("configureDll")}><FolderOpen size={14} />选择设备 SDK</Button><Button disabled={busy || active} onClick={() => onAction("restartService")}><RefreshCw size={14} />重启采集服务</Button><Button disabled={busy} onClick={() => onAction("openDataDirectory")}><HardDrive size={14} />打开数据目录</Button></div>
    {active && <p className="field-subtext">采集期间不能更换或重启服务，请先停止并保存。</p>}
  </section>;
}

export function FieldRecordingList({ recordings, selectedId, busy, onSelect, onExport, onUpload, syncedIds = [] }: {
  recordings: FieldRecording[]; selectedId?: string; busy: boolean; onSelect: (id: string) => void; onExport?: (id: string) => void; onUpload?: (id: string) => void; syncedIds?: string[];
}) {
  if (!recordings.length) return <div className="field-recordings-empty"><HardDrive size={28} /><h3>还没有采集记录</h3><p>完成采集后，可在此查看记录。</p></div>;
  return <div className="field-table-scroll" role="region" aria-label="本机采集记录，可横向滚动查看所有列" tabIndex={0}><table className="field-table"><thead><tr><th>任务 / 对象</th><th>转盘点位</th><th>开始时间</th><th>原始点数</th><th>采样率</th><th>保存状态</th><th>操作</th></tr></thead><tbody>{recordings.map((recording) => <tr key={recording.id} className={selectedId === recording.id ? "selected" : ""}><td><strong>{recording.name}</strong><span className={`field-badge ${recording.source === "simulation" ? "amber" : ""}`}>{recording.source === "simulation" ? "模拟" : "设备"}</span><small>{[recording.windFarm && `风场 ${recording.windFarm}`, recording.object, recording.turbine, recording.point].filter(Boolean).join(" / ") || "未填写对象信息"}</small></td><td>{recording.pointCycle ? <><strong>{recording.pointCycle.pointName}</strong><small>轴1 {recording.pointCycle.targetAxis1AngleDeg.toFixed(3)}° · 轴2 {recording.pointCycle.targetAxis2AngleDeg.toFixed(3)}°</small></> : "—"}</td><td>{timeOf(recording.startedAt)}</td><td className="mono">{count(recording.samples)}</td><td className="mono">{recording.sampleRate ? `${count(recording.sampleRate)} Hz` : "未知"}</td><td><span className={`field-badge ${recording.status === "complete" ? "green" : recording.status === "error" ? "red" : "amber"}`}>{recording.status === "complete" ? "已完成" : recording.status === "error" ? "异常记录" : "采集中 / 未完整结束"}</span></td><td><div className="field-record-actions"><Button disabled={busy} onClick={() => onSelect(recording.id)}>查看波形</Button>{onExport && <Button disabled={busy || recording.status !== "complete"} onClick={() => onExport(recording.id)}>导出原始数据</Button>}{onUpload && <Button disabled={busy || recording.status !== "complete" || syncedIds.includes(recording.id)} onClick={() => onUpload(recording.id)}>{syncedIds.includes(recording.id) ? "已上传 Web" : "上传至 Web"}</Button>}</div></td></tr>)}</tbody></table></div>;
}

export function FieldDesktopApp() {
  const [session, setSession] = useState<FieldSession | null>(null);
  const [syncStatus, setSyncStatus] = useState<FieldSyncStatus | null>(null);
  const [account, setAccount] = useState<FieldAccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<FieldStatus | null>(null);
  const [recordings, setRecordings] = useState<FieldRecording[]>([]);
  const [recordingsLoaded, setRecordingsLoaded] = useState(false);
  const [selected, setSelected] = useState<FieldRecording | null>(null);
  const [recordsTab, setRecordsTab] = useState<"records" | "summary">("records");
  const recordsTabId = useId();
  function recordsTabKey(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "records" : event.key === "End" ? "summary" : recordsTab === "records" ? "summary" : "records";
    setRecordsTab(next); document.getElementById(`${recordsTabId}-${next}-tab`)?.focus();
  }
  const [screen, setScreen] = useState<"acquisition" | "turntable" | "recordings" | "service" | "analysis" | "blade-passes">("acquisition");
  const [turntableVisited, setTurntableVisited] = useState(false);
  const [turntableConnection, setTurntableConnection] = useState(() => {
    try { return readSavedTurntableConnection(localStorage.getItem(turntableConnectionKey)); } catch { return ""; }
  });
  const [turntablePort, setTurntablePort] = useState(turntableConnection);
  const changeTurntableConnection = useCallback((endpoint: string) => {
    if (!isTurntablePort(endpoint)) return;
    setTurntableConnection(endpoint); setTurntablePort(endpoint);
    try { localStorage.setItem(turntableConnectionKey, JSON.stringify({ version: 1, endpoint })); } catch { /* Remain usable for this session. */ }
  }, []);
  const [linkEnabled, setLinkEnabled] = useState(false);
  const [routeMode, setRouteMode] = useState<"manual" | "auto" | "segmented">("manual");
  const [autoTargetKey, setAutoTargetKey] = useState<string>();
  const [autoCollection, setAutoCollection] = useState({ collectionId: "", collectionContext: "" });
  const [routes, setRoutes] = useState<Partial<Record<"manual" | "auto" | "segmented", FieldCaptureRoute>>>({});
  const onRoute = useCallback((route: FieldCaptureRoute) => setRoutes(previous => JSON.stringify(previous[route.kind]) === JSON.stringify(route) ? previous : { ...previous, [route.kind]: route }), []);
  const currentRoute = routes[routeMode] || null;
  const routeErrors = captureRouteRequestBlockers(currentRoute, status);
  const captureAttempt = useRef(0);
  const presetRun = useRef<AbortController | null>(null);
  const [presetRoute, setPresetRoute] = useState<FieldCaptureRoute | null>(null);
  const [positionedStation, setPositionedStation] = useState<FieldPositionedStation>();
  const positionSequence = useRef(0);
  const [presetStopping, setPresetStopping] = useState(false);
  const [turntableOperationBusy, setTurntableOperationBusy] = useState(false);
  const [stoppingCapture, setStoppingCapture] = useState(false);
  const stopPending = useRef(false);
  const [config, setConfig] = useState<FieldConfig>(blankConfig);
  const [configLoaded, setConfigLoaded] = useState(false);
  const latestPositionContext = useRef({ routes, routeMode, config });
  latestPositionContext.current = { routes, routeMode, config };
  const collectionId = autoCollection.collectionContext === autoFollowCollectionContext(config) ? autoCollection.collectionId : undefined;
  const [busy, setBusy] = useState("");
  const headerLaserBusyChanged = useCallback((value: boolean) => setBusy(previous => value ? previous || "laser" : previous === "laser" ? "" : previous), []);
  const deviceBusyChanged = useCallback((value: boolean) => setBusy(previous => value ? previous || "device" : previous === "device" ? "" : previous), []);
  const turntableHealthBusyChanged = useCallback((value: boolean) => setBusy(previous => value ? previous || "turntable-health" : previous === "turntable-health" ? "" : previous), []);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [statusPollUnavailable, setStatusPollUnavailable] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);
  const captureStarting = useRef(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [bindingAccount, setBindingAccount] = useState(false);
  const [bindingMode, setBindingMode] = useState<"bind" | "rebind">("bind");
  const [unbindingAccount, setUnbindingAccount] = useState(false);
  const [windowMs, setWindowMs] = useState(1000), [refreshMs, setRefreshMs] = useState(100);
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [screen]);
  const generation = useRef(0);
  const mounted = useRef(true);

  const clearSession = useCallback(() => {
    generation.current += 1; setSyncStatus(null); setSession(null); setStatus(null); setRecordings([]); setRecordingsLoaded(false); setSelected(null); setRecordsTab("records"); setStatusPollUnavailable(false);
    setChangingPassword(false); setBindingAccount(false); setUnbindingAccount(false); setPollError(""); setNotice(""); setTurntableVisited(false); setTurntableOperationBusy(false); setLinkEnabled(false); setRoutes({}); setAutoTargetKey(undefined); setPositionedStation(undefined); setPresetRoute(null); captureAttempt.current += 1;
  }, []);
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof FieldRequestError && cause.status === 401) clearSession();
    setError(messageOf(cause));
  }, [clearSession]);
  const handleRecordingError = useCallback((cause: unknown) => {
    // Read failures belong to the preview; an expired session still needs the
    // shared login flow. Retrying a preview must not leave a global stale error.
    if (cause instanceof FieldRequestError && cause.status === 401) handleError(cause);
  }, [handleError]);
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
    generation.current += 1; setSyncStatus(null);
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
      const survey = readAutoFollowSurvey(localStorage.getItem(autoFollowStorageKey));
      setAutoCollection({ collectionId: survey.collectionId, collectionContext: survey.collectionContext });
    } catch { /* A corrupt optional form draft never prevents local login. */ }
    setConfigLoaded(true);
    return () => { canceled = true; mounted.current = false; };
  }, [acceptSession]);
  useEffect(() => {
    if (configLoaded) try { localStorage.setItem("blade-field-config-v1", JSON.stringify(fieldCaptureConfig(config))); }
    catch { /* A failed draft save never affects raw recording storage. */ }
  }, [config, configLoaded]);
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
        const serviceError = fieldStatusPollError(next);
        setStatus(next); setStatusPollUnavailable(Boolean(serviceError)); setPollError(serviceError);
        const signature = `${next.state}:${next.recording?.id || ""}`;
        if (signature !== lastRecordingState && next.service.state === "ready") {
          lastRecordingState = signature;
          refreshRecordings().catch((cause) => { if (!canceled) setPollError(messageOf(cause)); });
        }
      } catch (cause) {
        if (canceled || epoch !== generation.current) return;
        if (cause instanceof FieldRequestError && cause.status === 401) { clearSession(); setError("本机会话已失效，请重新登录"); return; }
        setStatusPollUnavailable(true); setPollError(messageOf(cause));
      }
      if (!canceled) timer = setTimeout(poll, Math.max(20, (screen === "acquisition" && !document.hidden ? refreshMs : 1000) - (performance.now() - started)));
    }
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [session, refreshRecordings, clearSession, windowMs, refreshMs, screen]);

  useEffect(() => {
    if (!session || session.mustChangePassword) return;
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    const epoch = generation.current;
    async function pollSync() {
      try { const next = await fieldCall<FieldSyncStatus>({ action: "syncStatus" }); if (!canceled && epoch === generation.current) setSyncStatus(next); }
      catch { if (!canceled && epoch === generation.current) setSyncStatus(previous => previous ? { ...previous, connected: false, state: "error", error: "无法读取同步状态，请稍后重试。" } : null); }
      finally { if (!canceled) timer = setTimeout(pollSync, 2000); }
    }
    void pollSync(); return () => { canceled = true; clearTimeout(timer); };
  }, [session]);

  async function operate(action: string, fn: () => Promise<void>) {
    if (busy || turntableOperationBusy || stoppingCapture) return;
    setBusy(action); setError(""); setNotice("");
    try { await fn(); } catch (cause) { handleError(cause); } finally { if (mounted.current) setBusy(""); }
  }
  function openRecording(id: string) {
    if (busy || turntableOperationBusy || stoppingCapture) return;
    const recording = recordings.find(item => item.id === id);
    if (recording) { setError(""); setNotice(""); setSelected(recording); }
  }
  function exportTask(recordingIds: string[], level: "task" | "blade" | "point" = "task") {
    void operate("export-task", async () => {
      const result = await fieldCall<{ saved?: boolean; fileName?: string; recordCount?: number }>({ action: "exportTask", recordingIds, level });
      if (result.saved) setNotice(`已导出${{ task: "任务", blade: "叶片", point: "测点" }[level]}数据包 ${result.fileName}，共 ${result.recordCount} 条记录。`);
    });
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
    const replacing = bindingMode === "rebind";
    if (account?.mode !== (replacing ? "unified" : "local") || fieldIsActive(status) || status?.deviceBusy) return;
    await operate("bind", async () => {
      let next: FieldSession;
      try { next = await fieldCall<FieldSession>({ action: replacing ? "rebindAccount" : "bindAccount", ...values }); }
      catch (cause) { setError(messageOf(cause)); return; }
      acceptSession(next); setBindingAccount(false);
      if (!next.account) await refreshAccountInfo();
      setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "syncStatus" }));
      setNotice(replacing ? "已更换 Web 绑定。本机记录保留，旧账号的待上传记录保持原归属；新采集使用当前账号同步。" : "已绑定统一账号，此后使用 Web 的同一密码登录；原有记录保留在本机，未自动上传。");
    });
    await refreshAccountInfo().catch(() => {});
  }
  async function unbindAccount(values: FieldUnbindValues) {
    if (account?.mode !== "unified" || fieldIsActive(status) || status?.deviceBusy) return;
    await operate("unbind", async () => {
      let next: FieldSession;
      try { next = await fieldCall<FieldSession>({ action: "unbindAccount", ...values }); }
      catch (cause) { setError(messageOf(cause)); return; }
      acceptSession(next); setUnbindingAccount(false);
      setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "syncStatus" }));
      setNotice("已解除 Web 绑定。当前使用本机 admin，之后用刚设置的本机密码登录；采集记录保留，旧账号的待上传队列已暂停。");
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
    stopPending.current = true; captureAttempt.current += 1; setStoppingCapture(true); setError(""); setNotice("");
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

  function requestPresetPosition(targetKey?: string, azimuthDeg?: number, fromConfiguration = false, stationId?: string) {
    if (presetRun.current || captureStarting.current || busy || stoppingCapture || turntableOperationBusy || !linkEnabled && !fromConfiguration || !status || statusPollUnavailable) return;
    const selected = routes[routeMode];
    const target = routeMode !== "manual" ? selected?.targets?.find(item => item.key === (targetKey || selected?.selectedTargetKey)) : undefined;
    let route = routeMode !== "manual" ? target?.route || null : currentRoute;
    const sourceRoute = route, context = positioningRouteContext(route), taskContext = autoFollowCollectionContext(config);
    if (route && stationId !== undefined) {
      try { route = routeAtPositionedStation(route, stationId); } catch (cause) { handleError(cause); return; }
    }
    if (route?.kind === "segmented" && azimuthDeg !== undefined) {
      try { route = segmentedRouteAtAzimuth(route, azimuthDeg); } catch (cause) { handleError(cause); return; }
    }
    const invalid = presetPositionRequestError(route, status);
    if (invalid || !route) { setError(invalid); return; }
    if (target) setAutoTargetKey(target.key);
    const run = new AbortController(), epoch = generation.current;
    presetRun.current = run; setPresetStopping(false); setPresetRoute(route);
    void operate("preposition", async () => {
      const result = await moveToCapturePreset(structuredClone(route), status, fieldCall, {
        signal: run.signal, current: () => mounted.current && epoch === generation.current, onStatus: setStatus,
      });
      if (!mounted.current || epoch !== generation.current) return;
      if (result === "complete" && sourceRoute && (route.kind === "manual" || route.kind === "segmented")) {
        const latest = latestPositionContext.current, latestRoute = latest.routes[route.kind];
        const liveSelection = target ? latestRoute?.targets?.find(item => item.key === target.key)?.route : latestRoute;
        if (latest.routeMode !== route.kind || positioningRouteContext(liveSelection) !== context ||
            autoFollowCollectionContext(latest.config) !== taskContext)
          throw new Error("已完成定位，但配置已变化；请重新核对采集起点");
        const first = route.cycle!.points[0];
        setRoutes(previous => ({ ...previous, [route.kind]: replacePositionedTarget(previous[route.kind] || route, route, target?.key) }));
        setPositionedStation({ sequence: ++positionSequence.current, kind: route.kind, pointId: first.pointId!,
          targetKey: target?.key, azimuthDeg: first.azimuthDeg, port: route.cycle!.port, generation: status.service.generation });
      }
      setNotice(result === "complete" ? "已到预设位置并停稳，尚未采集。点击“开始采集”即可；位置未变化时不会重复移动。" : "已取消预定位，未开始采集。");
    }).finally(() => { if (presetRun.current === run) presetRun.current = null; if (mounted.current) { setPresetStopping(false); setPresetRoute(null); } });
  }
  function cancelPresetPosition() {
    presetRun.current?.abort(); setPresetStopping(true);
  }
  function requestCapture(targetKey?: string) {
    if (presetRun.current || captureStarting.current || busy || stoppingCapture || fieldIsActive(status) || status?.turntableBusy || turntableOperationBusy) return;
    const clientRequestedAt = Date.now() / 1000;
    let route = linkEnabled ? currentRoute : null;
    let capture = fieldCaptureConfig(config);
    if (linkEnabled && routeMode !== "manual") {
      const selected = routes[routeMode];
      const target = selected?.targets?.find(item => item.key === (targetKey || selected?.selectedTargetKey));
      if (!target) { setError("请先配置当前模式的叶片和测点。"); return; }
      setAutoTargetKey(target.key);
      targetKey = target.key;
      route = target.route;
      capture = { ...capture, turbine: capture.turbine.trim() || capture.name.trim(), point: `叶片 ${target.bladeId} · ${target.pointName}` };
    }
    const invalid = validateFieldConfig(capture) || (linkEnabled ? captureRouteRequestBlockers(route, status)[0] : "");
    if (invalid) { setError(invalid); return; }
    setError("");
    const selection = { config: capture, ...(linkEnabled && route ? { route: structuredClone(route), targetKey } : {}) };
    captureStarting.current = true;
    void operate("start", async () => {
      const attempt = ++captureAttempt.current, epoch = generation.current;
      const normalized = fieldCaptureConfig(selection.config), route = selection.route;
      const invalid = validateFieldConfig(normalized); if (invalid) throw new Error(invalid);
      let pointCycle = route?.cycle ? structuredClone(route.cycle) : undefined;
      if (route && pointCycle) {
        const latestRoute = selection.targetKey ? routes[route.kind]?.targets?.find(item => item.key === selection.targetKey)?.route : currentRoute;
        if (!linkEnabled || routeMode !== route.kind || latestRoute?.kind !== route.kind || JSON.stringify(latestRoute) !== JSON.stringify(route) ||
            autoFollowCollectionContext(config) !== autoFollowCollectionContext(normalized)) throw new Error("风机任务或采集路线已变化，请重新核对并开始。");
        // Bind the displayed reference identity. The service performs the
        // authoritative fresh checks after Start, in parallel with DAQ setup.
        // A second renderer-side probe adds latency without granting permission.
        const prepared = await prepareCaptureStartRoute(route, status, () =>
          fieldCall<FieldStatus>({ action: "turntable", request: { action: "probe", port: pointCycle!.port, axis: 1 } }));
        if (attempt !== captureAttempt.current || epoch !== generation.current) return;
        if (prepared.probed) setStatus(prepared.status);
        pointCycle = structuredClone(prepared.route.cycle!);
        if (pointCycle.mode === "automatic_stations") {
          const saved = readAutoFollowSurvey(localStorage.getItem(autoFollowStorageKey));
          const collection = autoFollowCollection(saved, autoFollowCollectionContext(normalized));
          pointCycle.collectionId = collection.collectionId;
          setAutoCollection(collection);
          try { localStorage.setItem(autoFollowStorageKey, JSON.stringify({ ...saved, ...collection })); } catch { /* Optional task draft. */ }
        }
      }
      if (attempt !== captureAttempt.current || epoch !== generation.current) return;
      await fieldCall({ action: "start", config: { ...normalized, clientRequestedAt, confirmLaser: true, ...(pointCycle ? { confirmMotion: true, pointCycle } : {}) } });
      if (attempt !== captureAttempt.current || epoch !== generation.current) return;
      const plain = fieldCaptureConfig(normalized);
      try { localStorage.setItem("blade-field-config-v1", JSON.stringify(plain)); } catch { /* Saving a draft is optional; raw acquisition storage is managed by Python. */ }
      const nextStatus = await fieldCall<FieldStatus>({ action: "status" });
      if (attempt !== captureAttempt.current || epoch !== generation.current) return;
      setConfig(plain); setStatus(nextStatus); setScreen("acquisition");
    }).finally(() => { captureStarting.current = false; });
  }
  const active = fieldIsActive(status);
  const captureError = status?.state === "error" ? status.error || status.pointCycle?.error || status.recording?.error || "" : "";
  const accountLocked = active || turntableOperationBusy || stoppingCapture || Boolean(status?.deviceBusy || status?.turntableBusy);
  const unifiedAccount = account?.mode === "unified";
  function openPassword() { if (!busy && !accountLocked) { setError(""); setChangingPassword(true); } }
  const captureControls = (active || stoppingCapture || busy === "start") && <div className="field-live-controls" aria-label="采集安全控制"><p><strong>{stoppingCapture ? "正在停止并保存" : busy === "start" ? "正在检查并启动采集" : status ? stateLabels[status.state] : "采集服务运行中"}</strong></p><Button type="button" variant="danger" disabled={stoppingCapture} onClick={() => void stopAcquisition()}>{stoppingCapture ? <LoaderCircle className="spin" size={15} /> : <Square size={13} />}停止并保存</Button></div>;
  const positionControls = busy === "preposition" && <div className="field-live-controls" aria-label="预定位控制"><p><strong>{presetStopping ? "正在停止预定位" : "正在移动到预设位置"}</strong><span>仅定位，未采集数据</span></p><Button type="button" variant="danger" disabled={presetStopping} onClick={cancelPresetPosition}><Square size={13} />停止定位</Button></div>;

  return <div className="field-app"><FieldTitlebar />
    {loading ? <div className="field-loading"><LoaderCircle className="spin" size={25} /><p>正在打开本机工作台…</p></div> : !session ? <FieldLoginPanel available={Boolean(fieldBridge())} account={account} accountUnavailable={!account} onRetry={() => void operate("account", refreshAccountInfo)} busy={Boolean(busy)} error={error} onLogin={async (username, password) => {
      await operate("login", async () => { clearSession(); const next = await fieldCall<FieldSession>({ action: "login", username, password }); acceptSession(next); });
      await refreshAccountInfo().catch(() => {});
    }} /> : session.mustChangePassword || changingPassword ? <main className="field-password-shell"><FieldPasswordPanel mandatory={session.mustChangePassword} account={account} busy={Boolean(busy)} error={error} onSave={savePassword} onCancel={() => { if (session.mustChangePassword) void logout(); else { setChangingPassword(false); setError(""); } }} /></main> : <>
      <header className="field-header"><div className="field-brand"><div className="field-brand-icon"><Activity size={19} /></div><span>BladeVMS <small>现场采集工作台</small></span></div><div className="field-header-right"><FieldHeaderLaser deviceIp={config.deviceIp} status={status} disabled={Boolean(busy) || turntableOperationBusy || stoppingCapture} pollUnavailable={statusPollUnavailable} request={fieldCall} onBusy={headerLaserBusyChanged} /><span className={`field-account-header ${account?.offline ? "offline" : ""}`} title={unifiedAccount ? `已绑定 ${account.serverUrl || "Web"}；离线有效期至 ${fieldAccountTime(account.offlineUntil)}` : "原始记录保存在本机"}><ShieldCheck size={13} />{unifiedAccount ? account.offline ? "统一账号 · 离线验证" : "统一账号" : "本机账号"}</span><span className="field-header-user"><span className="field-avatar">{(session.user.name || session.user.username).slice(0, 1).toUpperCase()}</span>{session.user.name || session.user.username}</span><Button variant="ghost" disabled={Boolean(busy) || accountLocked} onClick={openPassword} aria-label={unifiedAccount ? "修改统一密码" : "修改本机密码"}><LockKeyhole size={15} /></Button><Button variant="ghost" disabled={Boolean(busy) || active} onClick={() => void logout()} title={active ? "请先停止并保存采集" : "退出账号"}><LogOut size={15} />退出</Button></div></header>
      {screen !== "acquisition" && <>{captureControls}{positionControls}</>}
      <div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button disabled={turntableOperationBusy} className={screen === "acquisition" ? "active" : ""} onClick={() => setScreen("acquisition")}><Activity size={17} />数据采集</button><button disabled={turntableOperationBusy} className={screen === "turntable" ? "active" : ""} onClick={() => { setTurntableVisited(true); setScreen("turntable"); }}><Settings size={17} />转盘点位</button><button disabled={turntableOperationBusy} className={screen === "recordings" ? "active" : ""} onClick={() => { setScreen("recordings"); void operate("recordings", refreshRecordings); }}><HardDrive size={17} />本机记录</button><button disabled={turntableOperationBusy} className={screen === "service" ? "active" : ""} onClick={() => setScreen("service")}><Settings size={17} />设备与服务</button><p>记录分析</p><button disabled={turntableOperationBusy} className={screen === "analysis" ? "active" : ""} onClick={() => setScreen("analysis")}><AudioLines size={17} />信号处理</button><button disabled={turntableOperationBusy} className={screen === "blade-passes" ? "active" : ""} onClick={() => setScreen("blade-passes")}><Layers3 size={17} />叶片片段分析</button></aside>
        <main className="field-content" ref={contentRef}>
          <div className={`field-page-heading${screen === "acquisition" ? " field-acquisition-heading" : ""}`}>
            <div className={screen === "turntable" ? "field-turntable-heading field-servo-ui" : screen === "acquisition" ? "field-acquisition-title" : undefined}>
              <div className="field-page-title-line"><h1>{screen === "acquisition" ? "数据采集" : screen === "turntable" ? "转盘点位控制" : screen === "recordings" ? "本机记录" : screen === "analysis" ? "信号处理" : screen === "blade-passes" ? "叶片片段分析" : "设备与本机服务"}</h1>
                {screen === "acquisition" && <span className={`field-badge field-acquisition-state ${active ? "green" : status?.state === "error" ? "red" : ""}`} title={notice || undefined} role="status"><span className="field-status-dot" />{stoppingCapture ? "正在停止" : busy === "preposition" ? "正在定位" : busy === "start" ? "正在启动" : status ? stateLabels[status.state] : "读取状态中"}</span>}
              </div>
              {screen === "acquisition" && <FieldCaptureStatusTags status={status} />}
              {screen === "turntable" && <FieldTurntableHealth onConnectionChange={changeTurntableConnection} port={turntablePort} status={status} disabled={Boolean(busy) && busy !== "turntable-health" || turntableOperationBusy} pollUnavailable={statusPollUnavailable} request={fieldCall} onStatus={setStatus} onBusy={turntableHealthBusyChanged} />}
            </div>
            <div className="field-page-tools">{screen === "acquisition" ? unifiedAccount && syncStatus && <button type="button" className={`field-sync-chip ${syncStatus.state === "error" ? "is-error" : ""}`} onClick={() => setScreen("service")} title={`${syncStatus.enabled ? "自动同步已开启" : "自动同步已关闭"}；${syncStatus.items.filter(item => item.state === "synced").length} 条近期已上传 / ${syncStatus.items.filter(item => item.state !== "synced").length} 条待完成。点击查看同步设置`}><span className="field-status-dot" />Web 同步 · {syncStatus.state === "syncing" ? "同步中" : syncStatus.state === "ready" ? "已连接" : syncStatus.state === "error" ? "异常" : "未连接"}</button>
              : <span className={`field-badge ${status?.state === "acquiring" ? "green" : status?.state === "error" ? "red" : ""}`}><span className="field-status-dot" />{status ? stateLabels[status.state] : "读取状态中"}</span>}</div>
          </div>
          {(error || pollError) && <div className="field-error field-global-message" role="alert"><AlertTriangle size={17} /><span>{error || pollError}</span></div>}
          {captureError && captureError !== error && captureError !== pollError && <div className="field-error field-global-message" role="alert"><AlertTriangle size={17} /><span>上次采集异常：{captureError}。此为上次任务记录；当前设备状态请在“转盘状态”中重新检查，确认后重新开始。</span></div>}
          {busy === "export" && <div className="field-notice field-global-message" role="status"><LoaderCircle size={17} className="spin" />正在导出完整原始波形，大记录需要一些时间，请等待保存完成。</div>}
          {notice && screen !== "acquisition" && <div className="field-success field-global-message" role="status"><Check size={17} /><span>{notice}</span></div>}
          {status?.deviceWarning && <p className="field-notice warning" role="alert">{status.deviceWarning}</p>}
          {busy === "device" && <p className="field-notice warning">设备配置操作进行中，请等待结果。自动聚焦涉及激光，请留意现场状态。</p>}
          {status?.indexWarning && <div className="field-notice warning field-global-message" role="status"><AlertTriangle size={17} /><span>本机索引提示：{status.indexWarning}</span></div>}
          {screen === "analysis" && <FieldAnalysis request={fieldCall} onError={handleError} />}
          {screen === "blade-passes" && <WebBladePasses canAnalyze refreshKey={0} preferredIds={[]} onError={handleError} localData={localBladeData}
            desktopTemplateSelector={<DesktopBladeTemplateSelector value="customer-2026.7" />}
            renderTemplateComparison={synthesis => <DesktopBladeTemplateComparison synthesis={synthesis} templateId="客户模态重构 · 2026.7" />} />}
          <div hidden={screen !== "turntable"}>{turntableVisited && <FieldTurntableWorkspace connectionPort={turntableConnection || undefined} pollUnavailable={statusPollUnavailable} visible={screen === "turntable"} onPortChange={setTurntablePort} onOperationBusy={setTurntableOperationBusy} config={config} onConfig={setConfig} status={status} disabled={Boolean(busy)} request={fieldCall} onStatus={setStatus} onService={() => setScreen("service")} onRecords={() => { setScreen("recordings"); void operate("recordings", refreshRecordings); }}
            routeMode={routeMode} onRouteMode={setRouteMode} autoTargetKey={autoTargetKey} onAutoTarget={setAutoTargetKey} onRoute={onRoute} positionedStation={positionedStation} onPositionTarget={(key, angle) => requestPresetPosition(key, angle, true)} onAcquisition={() => { setLinkEnabled(true); setScreen("acquisition"); }} />}</div>
          {screen === "acquisition" && <FieldAcquisition source="device" config={config} onConfig={setConfig} status={status} busy={busy} pollError={pollError} stopping={stoppingCapture} positionStopping={presetStopping} onCancelPosition={cancelPresetPosition}
            windowMs={windowMs} onWindow={setWindowMs} refreshMs={refreshMs} onRefresh={setRefreshMs} request={fieldCall}
            link={{ enabled: linkEnabled, onEnabled: value => { setLinkEnabled(value); if (value) setTurntableVisited(true); }, route: currentRoute, errors: routeErrors,
              mode: routeMode, onMode: value => { setRouteMode(value); setTurntableVisited(true); },
              onSelectTarget: setAutoTargetKey, onStartTarget: key => requestCapture(key), onPosition: key => requestPresetPosition(key),
              onPositionStation: pointId => requestPresetPosition(undefined, undefined, false, pointId), positioningRoute: presetRoute,
              positionDisabledReason: turntableOperationBusy ? "转盘操作进行中，请等待完成" : "",
              onConfigureTarget: key => { setAutoTargetKey(key); setRouteMode(routeMode === "segmented" ? "segmented" : "auto"); setTurntableVisited(true); setScreen("turntable"); },
              collectionId, recordings,
              onConfigure: () => { setTurntableVisited(true); setScreen("turntable"); } }}
            onDeviceStart={() => requestCapture()}
            onStop={() => void stopAcquisition()}
            onService={() => setScreen("service")} onRecords={() => { setScreen("recordings"); void operate("recordings", refreshRecordings); }} />}
          {screen === "recordings" && <div className="field-records-workspace field-servo-ui">
            <div className="field-records-toolbar">
              <div className="field-view-tabs field-records-tabs" data-active={recordsTab} role="tablist" aria-label="本机记录视图">
                <button id={`${recordsTabId}-records-tab`} type="button" role="tab" tabIndex={recordsTab === "records" ? 0 : -1} aria-selected={recordsTab === "records"} aria-controls={`${recordsTabId}-records-panel`} onKeyDown={recordsTabKey} onClick={() => setRecordsTab("records")}><HardDrive size={16} />本机采集记录</button>
                <button id={`${recordsTabId}-summary-tab`} type="button" role="tab" tabIndex={recordsTab === "summary" ? 0 : -1} aria-selected={recordsTab === "summary"} aria-controls={`${recordsTabId}-summary-panel`} onKeyDown={recordsTabKey} onClick={() => setRecordsTab("summary")}><AudioLines size={16} />叶片采集汇总</button>
              </div>
              <div className="field-form-actions"><Button disabled={Boolean(busy)} onClick={() => void serviceAction("openDataDirectory")}><FolderOpen size={14} />打开数据目录</Button><Button disabled={Boolean(busy)} onClick={() => void operate("recordings", refreshRecordings)}><RefreshCw size={14} />刷新列表</Button></div>
            </div>
            <div id={`${recordsTabId}-records-panel`} role="tabpanel" aria-labelledby={`${recordsTabId}-records-tab`} tabIndex={0} hidden={recordsTab !== "records"}>
              <section className="field-card">
                {recordingsLoaded ? <FieldTaskRecords recordings={recordings} busy={Boolean(busy) || active} exporting={busy === "export-task"} onExportTask={exportTask}>{items => <FieldRecordingList recordings={items} syncedIds={syncStatus?.items.filter(item => item.state === "synced").map(item => item.recordingId)} onUpload={unifiedAccount ? id => void operate("sync", async () => { await fieldCall({ action: "syncRecording", id }); setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "syncStatus" })); setNotice("已加入 Web 上传队列，可在设备与服务查看进度。"); }) : undefined} busy={Boolean(busy)} selectedId={selected?.id} onExport={id => void operate("export", async () => { const result = await fieldCall<{ saved?: boolean; fileName?: string }>({ action: "exportRecording", id }); if (result.saved) setNotice(`已导出完整原始波形 ${result.fileName}`); })} onSelect={openRecording} />}</FieldTaskRecords> : <p className="field-notice">记录列表尚未读取成功，请确认采集服务可用后刷新。服务不可用不代表本机没有保存数据。</p>}
              </section>
            </div>
            <div id={`${recordsTabId}-summary-panel`} role="tabpanel" aria-labelledby={`${recordsTabId}-summary-tab`} tabIndex={0} hidden={recordsTab !== "summary"}>
              {recordingsLoaded ? <FieldBladeSummary recordings={recordings} syncItems={syncStatus?.items} onOpenRecording={openRecording} onExportTask={exportTask} busy={Boolean(busy) || active} exporting={busy === "export-task"} /> : <p className="field-notice">记录列表尚未读取成功，请确认采集服务可用后刷新。</p>}
            </div>
            {selected && <FieldRecordingDialog key={selected.id} recording={selected} load={fieldCall} onError={handleRecordingError} onClose={() => setSelected(null)} />}
          </div>}
          {screen === "service" && <div className="field-settings-grid"><FieldAccountPanel account={account} busy={Boolean(busy)} active={accountLocked} onBind={() => { if (!busy && !accountLocked && account?.mode === "local") { setError(""); setBindingMode("bind"); setBindingAccount(true); } }} onRebind={() => { if (!busy && !accountLocked) { setError(""); setBindingMode("rebind"); setBindingAccount(true); } }} onUnbind={() => { if (!busy && !accountLocked) { setError(""); setUnbindingAccount(true); } }} onPassword={openPassword} /><FieldCloudSyncPanel account={account} status={syncStatus} busy={Boolean(busy)} onSampleRate={sampleRate => void operate("sync", async () => { setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "setUploadSampleRate", sampleRate })); })} onAuto={enabled => void operate("sync", async () => { await fieldCall({ action: "setAutoSync", enabled }); setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "syncStatus" })); })} onRetry={() => void operate("sync", async () => { await fieldCall({ action: "retrySync" }); setSyncStatus(await fieldCall<FieldSyncStatus>({ action: "syncStatus" })); })} /><FieldDevicePanel deviceIp={config.deviceIp} hostIp={config.hostIp} onIp={deviceIp => setConfig(previous => ({ ...previous, deviceIp }))} status={status} disabled={Boolean(busy)} onBusy={deviceBusyChanged} onError={handleError} request={request => fieldCall<FieldDeviceSettings>({ action: "device", request })} calibrate={request => fieldCall<FieldRssiCalibrationResult>({ action: "rssiCalibration", request })} /><FieldServicePanel status={status} busy={Boolean(busy)} onAction={(action) => void serviceAction(action)} /><section className="field-card"><div className="field-section-heading"><h2>设备连接检查</h2></div><ol className="field-checklist"><li><strong>检查运行状态</strong><p>确认采集服务和设备驱动已就绪。</p></li><li><strong>确认设备网络与安全</strong><p>确认设备 IP、本机网卡、网络连接和激光作业安全。</p></li><li><strong>采集、停止并核对保存结果</strong><p>停止后核对原始点数、RSSI、超量程和保存状态。</p></li></ol></section></div>}
        </main>
      </div>{screen !== "acquisition" && screen !== "turntable" && <footer className="field-statusbar"><span><span className={`field-status-dot ${status?.service.state === "ready" ? "green" : ""}`} />{status ? serviceLabels[status.service.state] : "正在读取本机状态"}</span><span>原始数据保存在本机</span></footer>}
    </>}
    {bindingAccount && session && !session.mustChangePassword && account?.mode === (bindingMode === "rebind" ? "unified" : "local") && <FieldBindAccountDialog mode={bindingMode} busy={Boolean(busy)} active={accountLocked} error={error} initialServerUrl={bindingMode === "rebind" ? account.serverUrl : fieldAccountServerDefault(typeof window === "undefined" ? undefined : window.location)} initialUsername={bindingMode === "rebind" ? account.username : ""} onClose={() => { setBindingAccount(false); setError(""); }} onBind={bindAccount} />}
    {unbindingAccount && session && account?.mode === "unified" && <FieldUnbindAccountDialog busy={Boolean(busy)} active={accountLocked} error={error} onClose={() => { setUnbindingAccount(false); setError(""); }} onUnbind={unbindAccount} />}
    {status?.turntableBusy && busy !== "preposition" && !active && status.turntable?.port && status.turntable.axis && <div className="field-live-controls" aria-label="独立试转控制"><p><strong>转盘检查 / 试转进行中 · {status.turntable.port} 轴 {status.turntable.axis}</strong></p><Button type="button" variant="danger" disabled={!!busy || status.turntable.state === "test_stopping"} onClick={() => void operate("turntableStop", async () => { await fieldCall({ action: "turntable", request: { action: "stop", port: status.turntable!.port!, axis: status.turntable!.axis as 1 | 2, confirmMotion: true } }); setStatus(await fieldCall<FieldStatus>({ action: "status" })); })}>停止独立试转</Button></div>}
  </div>;
}
