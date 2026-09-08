"use client";
import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog, Tag } from "./common";
import { isOffline, roleNames, type LocalSyncStatus } from "./api";

export function SyncDialog({ onClose, refresh, notify }: {
  onClose: () => void; refresh: () => Promise<void>; notify: (message: string) => void;
}) {
  const [status, setStatus] = useState<LocalSyncStatus | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [username, setUsername] = useState(""), [password, setPassword] = useState("");
  const [error, setError] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string; revision: string }>>({});
  const [progress, setProgress] = useState("");
  const stop = useRef(false);
  const identity = useRef("");

  async function load() {
    setLoading(true);
    setConfirmed(false);
    try {
      const response = await window.blade!.sync({ action: "status" });
      if (response.status >= 400) throw Error(response.data.error);
      const next: LocalSyncStatus = response.data;
      const nextIdentity = `${next.server}/${next.user?.id}/${next.user?.tenant}`;
      if (identity.current && identity.current !== nextIdentity) { setResults({}); setSelected([]); }
      identity.current = nextIdentity;
      setStatus(next);
      setSelected((ids) => ids.filter((id) => next.tasks.some((task) => task.id === id)));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      // This authenticates the server bridge without leaving the offline workspace.
      const response = await window.blade!.request({ path: "session", method: "POST", body: { username, password } });
      if (response.status >= 400) throw Error(response.data.error || "登录失败");
      setPassword(""); setResults({}); setSelected([]);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function close() {
    if (busy) { stop.current = true; setProgress("已请求停止，将在当前请求返回后停止后续回传。"); }
    else onClose();
  }
  async function upload() {
    if (!status?.user || !confirmed || !selected.length || busy) return;
    const target = status, tasks = status.tasks.filter((task) => selected.includes(task.id));
    setBusy(true); setError(""); stop.current = false;
    let successes = 0, failures = 0;
    try {
      for (const [index, task] of tasks.entries()) {
        if (stop.current) break;
        setProgress(`正在回传 ${index + 1} / ${tasks.length}：${task.name}`);
        try {
          const response = await window.blade!.sync({ action: "upload", taskId: task.id, revision: task.revision,
            server: target.server, userId: target.user!.id, tenant: target.user!.tenant });
          if (response.status >= 400) throw Error(response.data.error || "回传失败");
          successes++;
          setResults((old) => ({ ...old, [task.id]: { ok: true, revision: task.revision,
            text: response.data.warning || (response.data.created ? "已回传，服务器已新建记录" : "服务器已确认同一修订，未重复创建") } }));
          setSelected((ids) => ids.filter((id) => id !== task.id));
        } catch (e) {
          failures++;
          setResults((old) => ({ ...old, [task.id]: { ok: false, revision: task.revision, text: (e as Error).message } }));
        }
      }
      setProgress(`${stop.current ? "已停止后续回传；" : ""}成功 ${successes} 项，失败 ${failures} 项。未成功的任务仍保留选中，可重新确认后重试。`);
      await load();
      if (!isOffline() && successes) {
        try { await refresh(); } catch { notify("回传已成功，但页面刷新失败，请手动刷新服务器数据。"); }
      }
    } finally { setBusy(false); }
  }
  const locked = busy || loading;
  return <Dialog title="回传本机任务" wide onClose={close}>
    <p className="note-box">仅回传所选任务及其关联分析，不包含账号配置。每个本地修订在服务器另建记录，不覆盖服务器任务，也不删除本机数据。采集与算法仍未接入。</p>
    <section className="sync-target" aria-label="回传目标">
      <div><span className="muted">目标服务器</span><strong>{status?.server || "正在读取…"}</strong></div>
      <div><span className="muted">接收账号 / 课题组</span><strong>{status?.user ? `${status.user.username}（${roleNames[status.user.role]}） / ${status.user.tenant}` : "未登录"}</strong></div>
    </section>
    {status && !status.user && <form onSubmit={login} className="sync-login">
      <p className="muted">{status.connectionError} 登录后仍留在本机工作区。</p>
      <div className="toolbar">
        <label className="form-field"><span>服务器账号</span><input required autoComplete="username" value={username} disabled={locked} onChange={(e) => setUsername(e.target.value)} /></label>
        <label className="form-field"><span>服务器密码</span><input required type="password" autoComplete="current-password" value={password} disabled={locked} onChange={(e) => setPassword(e.target.value)} /></label>
        <Button disabled={locked} variant="primary">登录回传账号</Button>
      </div>
    </form>}
    {status?.user?.role === "viewer" && <p role="alert" className="error">访客没有回传权限，请使用操作员、分析员或管理员账号。</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="toolbar sync-toolbar">
      <strong>本机任务（{status?.tasks.length || 0}）</strong>
      <span className="muted">已选 {selected.length} / 50 项</span>
      <Button className="push" disabled={locked} onClick={() => { setError(""); void load(); }}>刷新回传列表</Button>
    </div>
    <div className="sync-task-list">
      <table>
        <thead><tr><th>选择</th><th>任务 / 对象</th><th>数据范围</th><th>回传状态</th></tr></thead>
        <tbody>{status?.tasks.map((task) => <tr key={task.id}>
          <td><input type="checkbox" aria-label={`回传 ${task.name}`} checked={selected.includes(task.id)}
            disabled={locked || task.analysisCount > 50 || (!selected.includes(task.id) && selected.length >= 50)}
            onChange={(e) => { setConfirmed(false); setSelected((ids) => e.target.checked ? [...ids, task.id] : ids.filter((id) => id !== task.id)); }} /></td>
          <td><strong>{task.name}</strong><small>{task.object}</small><small>修订 {task.revision.slice(0, 12)}</small></td>
          <td>{task.sampleCount} 个采样点<small>{task.analysisCount} 份关联分析</small></td>
          <td>{results[task.id]?.revision === task.revision ? <span className={results[task.id].ok ? "green-text" : "error"}>{results[task.id].text}</span> : task.analysisCount > 50 ? <span className="error">分析超过 50 份，请先整理</span> : task.receipt ? <><Tag tone="green">已有本机回执</Tag><small>服务器任务 {task.receipt.taskId}</small><small>可勾选重试，由服务器核验去重</small></> : <Tag tone="gray">此账号尚无当前修订回执</Tag>}</td>
        </tr>)}</tbody>
      </table>
      {loading && <p className="empty">正在核对服务器和本机记录…</p>}
      {!loading && status?.tasks.length === 0 && <p className="empty">暂无本机任务，请先在离线工作区创建或导入。</p>}
    </div>
    <label className="sync-confirm"><input type="checkbox" checked={confirmed} disabled={locked || !status?.user || status.user.role === "viewer" || !selected.length}
      onChange={(e) => setConfirmed(e.target.checked)} />我确认将所选任务及关联分析发送至以上服务器账号和课题组。</label>
    {progress && <p role="status" className="sync-progress">{progress}</p>}
    <div className="dialog-actions">
      <Button onClick={close}>{busy ? "停止后续回传" : "关闭"}</Button>
      <Button variant="primary" disabled={locked || !confirmed || !selected.length || !status?.user || status.user.role === "viewer"} onClick={upload}>确认回传 {selected.length} 项</Button>
    </div>
  </Dialog>;
}
