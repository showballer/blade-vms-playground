"use client";
import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button, Dialog } from "./common";

export function AccountPasswordDialog({ mode, username, onClose, onSave }: {
  mode: "change" | "reset"; username: string; onClose: () => void;
  onSave: (input: { currentPassword: string; newPassword: string }) => Promise<void>;
}) {
  const [currentPassword, setCurrent] = useState(""), [newPassword, setNew] = useState(""), [confirmPassword, setConfirm] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Dialog title={mode === "change" ? "修改统一密码" : "重置统一密码"} onClose={() => { if (!busy) onClose(); }}>
    <p className="dialog-message">账号：<strong>{username}</strong>。此密码同时用于 Web 和已绑定的桌面账号。更新后，Web 登录会话将失效；桌面下次联网登录需使用新密码。已进行的桌面采集不会因此中断。</p>
    <p className="muted" style={{ lineHeight: 1.8, marginBottom: 18 }}>尚未获知重置且离线授权未过期的桌面，可能暂时仍使用旧密码；重新联网验证或离线授权到期后，需要重新登录。</p>
    <form onSubmit={async event => {
      event.preventDefault(); setError("");
      if (newPassword.length < 12 || newPassword.length > 128) { setError("新密码须为 12–128 位"); return; }
      if (newPassword !== confirmPassword) { setError("两次输入的新密码不一致"); return; }
      setBusy(true);
      try { await onSave({ currentPassword, newPassword }); setCurrent(""); setNew(""); setConfirm(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "密码更新失败，请重试"); }
      finally { setBusy(false); }
    }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        {mode === "change" && <label className="form-field"><span>当前密码</span><input type="password" required maxLength={200} autoComplete="current-password" value={currentPassword} onChange={event => setCurrent(event.target.value)} /></label>}
        <label className="form-field"><span>新密码（12–128 位）</span><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={newPassword} onChange={event => setNew(event.target.value)} /></label>
        <label className="form-field"><span>确认新密码</span><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirm(event.target.value)} /></label>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="dialog-actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}{busy ? "正在更新…" : mode === "change" ? "修改密码并重新登录" : "确认重置密码"}</Button></div>
    </form>
  </Dialog>;
}
