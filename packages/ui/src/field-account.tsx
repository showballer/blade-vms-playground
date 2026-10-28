"use client";
import React, { memo, useState } from "react";
import { CloudUpload, Link, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Unlink, WifiOff } from "lucide-react";
import { Button, Dialog } from "./common";
import { CustomSelect } from "./custom-select";
import type { FieldAccountInfo, FieldSyncStatus } from "./field-types";

export type FieldBindValues = { serverUrl: string; username: string; password: string; currentPassword: string };
export type FieldUnbindValues = { currentPassword: string; newLocalPassword: string };
export function fieldAccountServerDefault(location?: { protocol: string; hostname: string; port: string }): string {
  if (location?.protocol === "file:") return "http://115.190.201.41:3000";
  return location?.protocol === "http:" && ["127.0.0.1", "localhost"].includes(location.hostname) && location.port === "5210" ? "http://127.0.0.1:3210" : "";
}
export function fieldAccountUsesPlainHttp(value?: string): boolean {
  try {
    const url = new URL(value || "");
    return url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch { return false; }
}
const plainHttpNotice = "当前地址使用 HTTP，账号、密码和会话信息将明文传输，请仅在可信网络中使用。";
export function fieldAccountTime(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime())
    ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚无验证记录";
}

export const FieldAccountPanel = memo(function FieldAccountPanel({ account, busy, active, onBind, onPassword, onRebind, onUnbind }: {
  account: FieldAccountInfo | null; busy: boolean; active: boolean; onBind: () => void; onPassword: () => void;
  onRebind?: () => void; onUnbind?: () => void;
}) {
  const unified = account?.mode === "unified";
  return <section className="field-card field-account-card">
    <div className="field-section-heading"><div><h2>账号与密码</h2><p>{unified ? "Web 与已绑定桌面共用同一账号密码。" : "可将本机工作区绑定到 Web 账号，统一登录密码。"}</p></div><ShieldCheck size={18} /></div>
    {unified ? <>
      <div className={`field-account-state ${account.offline ? "offline" : ""}`}>{account.offline ? <WifiOff size={17} /> : <Link size={17} />}<strong>{account.offline ? "统一账号 · 离线验证" : "已绑定统一账号"}</strong></div>
      <dl className="field-details field-account-details"><div><dt>Web 服务器</dt><dd>{account.serverUrl || "—"}</dd></div><div><dt>绑定账号</dt><dd>{account.username || "—"}</dd></div><div><dt>上次联网验证</dt><dd>{fieldAccountTime(account.lastVerifiedAt)}</dd></div><div><dt>离线有效期至</dt><dd>{account.offlineUntil ? fieldAccountTime(account.offlineUntil) : "需先联网验证"}</dd></div></dl>
      {fieldAccountUsesPlainHttp(account.serverUrl) && <p className="field-notice warning">{plainHttpNotice}</p>}
      <p className="field-subtext">离线验证最多有效 30 天；到期或账号要求重新验证时，需联网登录。当前使用 Web 账号密码登录。</p>
      {account.onlineRequired && <p className="field-notice warning">此账号下次登录需要联网验证，不能使用离线缓存登录。</p>}
      <div className="field-account-actions"><Button disabled={busy || active} onClick={onPassword}><LockKeyhole size={15} />修改统一密码</Button><Button disabled={busy || active || !onRebind} onClick={onRebind}><RefreshCw size={15} />更换绑定</Button><Button disabled={busy || active || !onUnbind} onClick={onUnbind}><Unlink size={15} />解除绑定</Button></div>
      <p className="field-inline-help">更换或解除绑定需验证当前账号密码。本机记录保留；旧账号的待上传记录不会自动转给新账号。</p>
      <p className="field-inline-help">修改统一密码需要联网。Web 改密或禁用会在桌面下次联网登录时校验；不会强制中断已经运行的采集。</p>
    </> : <>
      <p className="field-subtext">当前使用独立本机账号。首次绑定需要验证当前本机密码及 Web 账号密码；成功后由该 Web 账号接管本机工作区登录。</p>
      <p className="field-notice">原有采集记录保留在本机，不会因绑定自动上传。绑定后使用 Web 的同一密码，可在有效期内离线登录。</p>
      <div className="field-account-actions"><Button variant="primary" disabled={busy || active || !account} onClick={onBind}><Link size={15} />绑定 Web 账号</Button><Button disabled={busy || active || !account} onClick={onPassword}><LockKeyhole size={15} />修改本机密码</Button></div>
    </>}
    {active && <p className="field-subtext">请先停止并保存采集，再绑定账号或修改密码。</p>}
  </section>;
});

export function FieldCloudSyncPanel({ account, status, busy, onAuto, onRetry, onSampleRate }: {
  account: FieldAccountInfo | null; status: FieldSyncStatus | null; busy: boolean;
  onAuto: (enabled: boolean) => void; onRetry: () => void;
  onSampleRate?: (sampleRate: number) => void;
}) {
  const bound = account?.mode === "unified";
  const labels = { unbound: "待绑定账号", "signed-out": "等待登录", offline: "等待联网登录", ready: "已连接 Web", syncing: "正在同步", error: "同步待重试" };
  const states = { recording: "采集中", queued: "等待上传", uploading: "上传中", synced: "已同步", error: "等待重试" };
  const pending = status?.items.filter(item => item.state !== "synced") || [];
  return <section className="field-card field-account-card">
    <div className="field-section-heading"><div><h2>Web 数据同步</h2><p>开启自动同步后可在 Web 查看实时预览；各点记录保存后按所选采样率上传。</p></div><CloudUpload size={18} /></div>
    <div className="field-account-state"><CloudUpload size={17} /><strong>{status ? labels[status.state] : "读取同步状态中"}</strong></div>
    <div className="field-account-actions"><span>自动同步新采集</span><button type="button" className="field-debug-toggle" role="switch" aria-label="自动同步新采集" aria-checked={Boolean(status?.enabled)} disabled={busy || !bound || !status} onClick={() => onAuto(!status?.enabled)}><span /></button></div>
    <label className="field-upload-sampling">上传采样率<CustomSelect aria-label="上传采样率" value={status?.uploadSampleRate ?? 50000} disabled={busy || !status || !onSampleRate} onChange={event => onSampleRate?.(Number(event.target.value))}>
      <option value={0}>原始采样率 · 全量上传</option>{[10000, 20000, 25000, 30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000].map(rate => <option key={rate} value={rate}>{rate / 1000} kHz{rate === 50000 ? " · 推荐" : ""}</option>)}
    </CustomSelect></label>
    <p className="field-subtext">本机始终保存全量原始数据。上传副本先低通滤波再降采样；50 kHz 相比 250 kHz 减少约 80% 波形数据，建议用于 20 kHz 以下的分析。源采样率更低时保持原样。设置对尚未开始处理的上传生效，续传沿用原设置。</p>
    <p className="field-subtext">{bound ? "关闭自动同步后，新采集不会发送实时预览，已排队记录仍会继续上传。历史记录可在本机记录中上传；断线后联网登录继续同步。包含换点过程的整段原始档案保留在本机，Web 同步各测点记录。" : "请先绑定 Web 账号。本机采集和保存可独立使用。"}</p>
    {status?.error && <p className="field-notice warning" role="status">{status.error}</p>}
    {pending.length > 0 && <div className="field-table-scroll"><table className="field-table"><thead><tr><th>待同步记录</th><th>状态</th></tr></thead><tbody>{pending.slice(-5).reverse().map(item => <tr key={item.recordingId}><td><strong>{item.name}</strong>{item.error && <small>{item.error}</small>}</td><td>{states[item.state]}{item.state === "uploading" && ` ${item.progress}%`}</td></tr>)}</tbody></table></div>}
    {bound && <p className="field-inline-help">此处保留最近 200 条已同步记录摘要，完整记录以 Web 为准。</p>}
    {bound && <div className="field-account-actions"><span className="field-subtext">待同步 {pending.length} 条 · 近期已同步 {status?.items.filter(item => item.state === "synced").length || 0} 条</span><Button disabled={busy || !status || !status.connected} onClick={onRetry}><RefreshCw size={14} />重试同步</Button></div>}
  </section>;
}

export function FieldBindAccountDialog({ busy, error, active = false, initialServerUrl = "", initialUsername = "", mode = "bind", onClose, onBind }: {
  busy: boolean; error: string; active?: boolean; initialServerUrl?: string;
  initialUsername?: string; mode?: "bind" | "rebind";
  onClose: () => void; onBind: (values: FieldBindValues) => Promise<void>;
}) {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const disabled = busy || active;
  const replacing = mode === "rebind";
  return <Dialog title={replacing ? "更换 Web 绑定" : "绑定 Web 统一账号"} onClose={() => { if (!busy) onClose(); }}>
    <form className="field-account-bind-form" onSubmit={async event => {
      event.preventDefault(); if (disabled) return;
      try { await onBind({ serverUrl: serverUrl.trim(), username: username.trim(), password, currentPassword }); }
      finally { setPassword(""); setCurrentPassword(""); }
    }}>
      <div className="field-account-bind-body">
        <p className="field-notice">{replacing ? "验证当前绑定账号后，使用下方新 Web 账号登录。本机记录保留，旧账号的待上传数据仍属于旧账号，不会自动转给新账号。" : "绑定后，该 Web 账号将接管本机工作区登录；原始记录保留、不自动上传。旧本机密码不再用于登录，后续可在账号与密码中更换或解除绑定。"}</p>
        <label>{replacing ? "当前绑定账号密码" : "当前本机密码"}<input aria-label={replacing ? "当前绑定账号密码" : "绑定时的当前本机密码"} name="currentPassword" type="password" autoComplete="section-current current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required maxLength={128} disabled={disabled} /></label>
        <label>Web 服务器地址<input aria-label="Web 服务器地址" name="serverUrl" type="url" autoComplete="url" placeholder="https://blade.example.com" value={serverUrl} onChange={event => setServerUrl(event.target.value)} required maxLength={2048} disabled={disabled} /><small>支持 HTTP 或 HTTPS 地址；本机开发可使用 http://127.0.0.1:3210。</small></label>
        {fieldAccountUsesPlainHttp(serverUrl) && <p className="field-notice warning">{plainHttpNotice}</p>}
        <label>{replacing ? "新的 Web 账号" : "Web 账号"}<input aria-label="绑定的 Web 账号" name="username" autoComplete="section-web username" value={username} onChange={event => setUsername(event.target.value)} required maxLength={80} disabled={disabled} /></label>
        <label>{replacing ? "新的 Web 账号密码" : "Web 当前密码"}<input aria-label="绑定的 Web 密码" name="password" type="password" autoComplete="section-web current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={128} disabled={disabled} /></label>
        <p className="field-subtext">{replacing ? "新 Web 账号须联网验证。" : "首次绑定必须联网。"}后续使用 Web 同一密码登录，联网验证后最多可离线使用 30 天。</p>
        {active && <p className="field-notice warning">采集仍在运行，请停止并保存后再绑定。</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="field-form-actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={disabled}>{busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}{busy ? "正在验证并绑定…" : replacing ? "确认更换绑定" : "确认绑定并使用统一账号"}</Button></div>
    </form>
  </Dialog>;
}

export function FieldUnbindAccountDialog({ busy, active, error, onClose, onUnbind }: {
  busy: boolean; active: boolean; error: string; onClose: () => void; onUnbind: (values: FieldUnbindValues) => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newLocalPassword, setNewLocalPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState("");
  const disabled = busy || active;
  return <Dialog title="解除 Web 绑定" onClose={() => { if (!busy) onClose(); }}>
    <form className="field-account-bind-form" onSubmit={async event => {
      event.preventDefault(); if (disabled) return;
      if (newLocalPassword !== confirmation) { setValidation("两次输入的本机密码不一致"); return; }
      setValidation("");
      try { await onUnbind({ currentPassword, newLocalPassword }); }
      finally { setCurrentPassword(""); setNewLocalPassword(""); setConfirmation(""); }
    }}>
      <div className="field-account-bind-body">
        <p className="field-notice">解除后使用本机 admin 和下方设置的密码登录。本机采集记录继续保留，旧 Web 的已上传数据和待上传队列保持原归属。</p>
        <label>当前绑定账号密码<input aria-label="解绑时的当前账号密码" name="currentPassword" type="password" autoComplete="section-current current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required maxLength={128} disabled={disabled} /></label>
        <label>本机 admin 新密码<input aria-label="解绑后的本机密码" name="newLocalPassword" type="password" autoComplete="section-local new-password" value={newLocalPassword} onChange={event => setNewLocalPassword(event.target.value)} required minLength={12} maxLength={128} disabled={disabled} /><small>12～128 个字符，解除绑定后使用此密码离线登录。</small></label>
        <label>再次输入本机密码<input aria-label="确认解绑后的本机密码" name="confirmation" type="password" autoComplete="section-local new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required minLength={12} maxLength={128} disabled={disabled} /></label>
        {active && <p className="field-subtext">请先停止并保存采集，再解除绑定。</p>}
        {(validation || error) && <p className="field-error" role="alert">{validation || error}</p>}
      </div>
      <div className="field-form-actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={disabled}>{busy ? <LoaderCircle size={16} className="spin" /> : <Unlink size={16} />}{busy ? "正在验证并解除…" : "确认解除绑定"}</Button></div>
    </form>
  </Dialog>;
}
