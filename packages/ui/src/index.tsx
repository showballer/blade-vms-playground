"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Radio,
  AudioLines,
  HeartPulse,
  ChartSpline,
  FileText,
  Code2,
  Settings,
  Bell,
  RefreshCw,
  LogOut,
  ChevronDown,
  Monitor,
  Globe,
  Minus,
  Square,
  X,
  ShieldCheck,
  LoaderCircle,
  CloudUpload,
} from "lucide-react";
import {
  api,
  setOffline,
  isOffline,
  roleNames,
  type Bootstrap,
  type Item,
} from "./api";
import { Button, Dialog, EditDialog, Tag } from "./common";
import { Acquisition, Blade, Signal } from "./desktop-screens";
import { Health, ModalAnalysis, Reports } from "./web-screens";
import { Administration, Developer } from "./admin-screens";
import { SyncDialog } from "./sync-dialog";
import { workspaceTask } from "./workspace-context";
const nav = [
  { id: "acq", name: "数据采集", icon: Activity, platform: "desktop" },
  { id: "blade", name: "旋转测振", icon: Radio, platform: "desktop" },
  { id: "signal", name: "信号处理", icon: AudioLines, platform: "desktop" },
  { id: "health", name: "健康监测", icon: HeartPulse, platform: "web" },
  { id: "modal", name: "模态识别", icon: ChartSpline, platform: "web" },
  { id: "report", name: "报告导出", icon: FileText, platform: "web" },
  { id: "dev", name: "二次开发", icon: Code2, platform: "web" },
  { id: "admin", name: "系统管理", icon: Settings, platform: "web" },
];
export function BladeApp({ platform }: { platform: "web" | "desktop" }) {
  const [data, setData] = useState<Bootstrap | null>(null),
    [loading, setLoading] = useState(true),
    [screen, setScreen] = useState(platform === "web" ? "health" : "acq"),
    [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState(""),
    [settings, setSettings] = useState<string | null>(null),
    [account, setAccount] = useState(false),
    [syncOpen, setSyncOpen] = useState(false),
    [currentTask, setCurrentTask] = useState<Item | undefined>(),
    [navigationTaskId, setNavigationTaskId] = useState<string | undefined>(),
    [now, setNow] = useState("");
  const workspaceEpoch = useRef(0);
  const clearWorkspace = useCallback(() => {
    workspaceEpoch.current += 1;
    setData(null);
    setCurrentTask(undefined);
    setNavigationTaskId(undefined);
    setToast("");
    setAccount(false);
    setSyncOpen(false);
  }, []);
  const notify = useCallback((message: string) => setToast(message), []);
  const refresh = useCallback(async () => {
    const epoch = workspaceEpoch.current;
    const next = await api<Bootstrap>("bootstrap");
    if (epoch === workspaceEpoch.current) setData(next);
  }, []);
  useEffect(() => {
    refresh()
      .catch(() => {})
      .finally(() => setLoading(false));
    const h = window.location.hash.slice(1);
    if (
      nav.some((n) => n.id === h && n.platform === platform) ||
      (platform === "web" && h === "alerts")
    )
      setScreen(h);
  }, [refresh, platform]);
  useEffect(() => {
    const t = setInterval(
      () =>
        setNow(
          new Date().toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        ),
      1000,
    );
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(t);
  }, [toast]);
  const go = (id: string, context?: { taskId: string }) => {
    setNavigationTaskId(context?.taskId);
    setScreen(id);
    window.history.replaceState(null, "", "#" + id);
  };
  async function configure() {
    if (!window.blade) {
      if (platform === "web") go("admin");
      else notify("浏览器预览使用同源接口；服务器地址可在桌面应用中设置");
      return;
    }
    setSettings(
      window.blade ? await window.blade.settings() : "http://127.0.0.1:3210",
    );
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      clearWorkspace();
      setOffline(false);
      await api("session", "POST", { username, password });
      setPassword("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const configDialog =
    settings !== null ? (
      <EditDialog
        title="管理服务器地址"
        fields={[{ key: "url", label: "HTTP(S) 服务地址", required: true }]}
        initial={{ url: settings }}
        onClose={() => setSettings(null)}
        onSave={async (v) => {
          if (!window.blade)
            throw Error(
              "浏览器预览使用同源接口；请在 Electron 桌面应用中配置服务器",
            );
          await window.blade.settings(v.url);
          clearWorkspace();
          setOffline(false);
          notify("服务地址已更新，请重新登录");
        }}
      />
    ) : null;
  if (loading)
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" size={26} />
        <p>正在打开 BladeVMS 工作台…</p>
      </div>
    );
  if (!data)
    return (
      <div className="login-shell">
        <div className="login-intro">
          <div className="brand-icon">
            <Activity size={24} />
          </div>
          <span className="login-eyebrow">
            BLADE VIBRATION MONITORING SYSTEM
          </span>
          <h1>
            三维台架结构力学
            <br />
            特征测试系统
          </h1>
          <p>
            从振动信号到结构状态，
            <br />
            让每一次测试都有据可循。
          </p>
          <div className="login-badges">
            <Tag>任务与数据归档</Tag>
            <Tag>分析结果复核</Tag>
            <Tag>报告与追溯</Tag>
          </div>
          <small>内蒙古工业大学 · 旋转叶片测振与损伤检测</small>
        </div>
        <form className="login-card" onSubmit={login}>
          <div className="toolbar compact">
            {platform === "web" ? <Globe size={18} /> : <Monitor size={18} />}
            <span>
              {platform === "web" ? "实验室管理服务端" : "现场采集应用端"}
            </span>
          </div>
          <h2>登录工作台</h2>
          <p className="muted">使用项目账号继续</p>
          <label className="form-field">
            <span>账号</span>
            <input
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="form-field">
            <span>密码</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button className="full" variant="primary" disabled={busy}>
            {busy ? "登录中…" : "登录"}
          </Button>
          {platform === "desktop" && (
            <>
              <Button type="button" className="full" onClick={configure}>
                配置服务器地址
              </Button>
              {typeof window !== "undefined" && window.blade && (
                <Button
                  type="button"
                  className="full"
                  onClick={async () => {
                    try {
                      clearWorkspace();
                      setOffline(true);
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  离线演示工作区
                </Button>
              )}
            </>
          )}
          <div className="login-note">
            <ShieldCheck size={17} />
            <span>
              独立项目数据库 · 按角色授权
              <br />
              设备与算法尚未接入，图表使用演示数据
            </span>
          </div>
        </form>
        {configDialog}
      </div>
    );
  const canWrite = data.user.role !== "viewer";
  const canAnalyze = ["admin", "analyst"].includes(data.user.role);
  const shared = {
    data,
    refresh,
    notify,
    canWrite,
    go,
    onTaskChange: setCurrentTask,
    initialTaskId: navigationTaskId,
  };
  const activeTask = workspaceTask(data.tasks, currentTask);
  const components: Record<string, React.ReactNode> = {
    acq: <Acquisition {...shared} />,
    blade: <Blade {...shared} canWrite={canWrite} />,
    signal: <Signal {...shared} canWrite={canWrite} />,
    health: <Health {...shared} canWrite={canAnalyze} />,
    modal: <ModalAnalysis {...shared} canWrite={canAnalyze} />,
    report: <Reports {...shared} canWrite={canAnalyze} />,
    dev: <Developer {...shared} />,
    admin: <Administration {...shared} canWrite={canAnalyze} />,
    alerts: (
      <Administration {...shared} canWrite={canAnalyze} initialTab="alerts" />
    ),
  };
  return (
    <div className={"app-shell " + platform}>
      {platform === "desktop" && (
        <div className="desktop-titlebar">
          <span>
            <Activity size={14} />
            BladeVMS 现场采集端{" "}
            <small>{activeTask?.name || "未选择任务"}</small>
          </span>
          <div className="window-controls">
            <button
              aria-label="最小化窗口"
              onClick={() => window.blade?.windowControl("minimize")}
            >
              <Minus size={13} />
            </button>
            <button
              aria-label="最大化窗口"
              onClick={() => window.blade?.windowControl("maximize")}
            >
              <Square size={11} />
            </button>
            <button
              aria-label="关闭窗口"
              onClick={() => window.blade?.windowControl("close")}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon">
            <Activity size={21} />
          </div>
          <div>
            <strong>三维台架结构力学特征测试系统</strong>
            <small>
              {platform === "desktop"
                ? "现场采集应用端 · 桌面 EXE"
                : "实验室管理服务端 · Web B/S"}
            </small>
          </div>
        </div>
        <div className="header-actions">
          {platform === "desktop" && typeof window !== "undefined" && window.blade && (
            <Button onClick={() => setSyncOpen(true)}><CloudUpload size={15} />回传本机任务</Button>
          )}
          <Tag tone="amber">
            {isOffline() ? "离线演示" : "设备 / 算法未接入"}
          </Tag>
          <Button variant="ghost" aria-label="应用设置" onClick={configure}>
            <Settings size={17} />
          </Button>
          <Button
            variant="ghost"
            aria-label="刷新数据"
            onClick={() =>
              refresh()
                .then(() => notify("数据已刷新"))
                .catch((e) => notify(e.message))
            }
          >
            <RefreshCw size={17} />
          </Button>
          <Button
            variant="ghost"
            aria-label="查看告警"
            onClick={() => {
              if (platform === "web") go("alerts");
              else notify("实时设备告警待采集接口接入；历史告警请在 Web 管理端查看");
            }}
          >
            <Bell size={17} />
            {data.alerts.filter((a) => a.status !== "已关闭").length > 0 && (
              <span className="notification-dot" />
            )}
          </Button>
          <span className="divider" />
          <button className="account-button" onClick={() => setAccount(true)}>
            <span className="avatar">{data.user.name.slice(0, 1)}</span>
            {data.user.name} ({roleNames[data.user.role]})
            <ChevronDown size={13} />
          </button>
        </div>
      </header>
      <div className="app-body">
        <nav className="sidebar">
          <div className="nav-caption">
            {platform === "desktop" ? "采集与分析" : "管理与运维"}
          </div>
          {nav
            .filter((n) => n.platform === platform)
            .map((n) => (
              <button
                key={n.id}
                aria-label={n.name}
                title={n.name}
                aria-current={screen === n.id || (screen === "alerts" && n.id === "admin") ? "page" : undefined}
                className={
                  screen === n.id || (screen === "alerts" && n.id === "admin")
                    ? "active"
                    : ""
                }
                onClick={() => go(n.id)}
              >
                <n.icon size={18} />
                <span>{n.name}</span>
              </button>
            ))}
          <div className="sidebar-footer">
            <span>BladeVMS v1.0.0</span>
            <small>{isOffline() ? "本机演示工作区" : data.user.tenant}</small>
          </div>
        </nav>
        <main key={screen} className="workspace">
          {components[screen] ||
            components[platform === "web" ? "health" : "acq"]}
        </main>
      </div>
      <footer className="statusbar">
        <span>
          采样率 <b className="mono">{activeTask?.sampleRate ?? "—"} Hz</b>
        </span>
        <span>
          转速 <b className="mono">{activeTask?.rpm ?? "—"} r/min</b>
        </span>
        <span>
          数据源 <b className={activeTask?.source === "demo" ? "amber-text" : ""} data-testid="task-source">{!activeTask ? "无" : activeTask.source === "demo" ? "演示" : activeTask.source === "import" ? "导入" : "未注明"}</b>
        </span>
        <span>任务：{activeTask?.name || "无"}</span>
        <span>
          算法 <b className="muted">未接入</b>
        </span>
        <time className="push mono">{now}</time>
      </footer>
      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
      {configDialog}
      {syncOpen && <SyncDialog onClose={() => setSyncOpen(false)} refresh={refresh} notify={notify} />}
      {account && (
        <Dialog title="当前账号" onClose={() => setAccount(false)}>
          <dl className="key-values">
            <dt>账号</dt>
            <dd>{data.user.username}</dd>
            <dt>角色</dt>
            <dd>{roleNames[data.user.role]}</dd>
            <dt>课题组</dt>
            <dd>{data.user.tenant}</dd>
          </dl>
          <div className="dialog-actions">
            <Button
              variant="danger"
              onClick={async () => {
                clearWorkspace();
                try {
                  if (window.blade) await window.blade.request({ path: "session", method: "DELETE" });
                  else await api("session", "DELETE");
                } finally {
                  clearWorkspace();
                  setOffline(false);
                }
              }}
            >
              <LogOut size={14} />
              退出登录
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
