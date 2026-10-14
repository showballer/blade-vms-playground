"use client";
import { useEffect, useState } from "react";
import {
  Plus,
  KeyRound,
  Download,
  RotateCcw,
  ShieldCheck,
  Copy,
  BookOpen,
  Trash2,
} from "lucide-react";
import { api, download, saveBlob, roleNames, type Item } from "./api";
import { apiExamples, apiExample, apiRequestSample, apiReferenceMarkdown, readApiExample, type ApiExample } from "./developer-api";
import { AuditLogScreen } from "./audit-log-screen";
import { AccountPasswordDialog } from "./account-password-dialog";
import {
  Button,
  Card,
  Tag,
  Table,
  Tabs,
  Select,
  Filter,
  EditDialog,
  Confirm,
  Dialog,
  Empty,
  ExportButton,
  saveRecord,
  type ContextProps,
  type Field,
} from "./common";
const adminTabs = [
  { id: "users", name: "用户与权限" },
  { id: "logs", name: "操作日志" },
  { id: "backup", name: "数据备份" },
  { id: "alerts", name: "异常告警" },
];
const userFields: Field[] = [
  { key: "username", label: "登录账号", required: true },
  { key: "name", label: "显示名称", required: true },
  {
    key: "role",
    label: "角色",
    type: "select",
    options: Object.entries(roleNames).map(([value, label]) => ({
      value,
      label,
    })),
    required: true,
  },
  { key: "tenant", label: "课题组", required: true },
  {
    key: "password",
    label: "统一密码（12–128 位）",
    type: "password",
    required: true,
  },
  { key: "active", label: "启用用户", type: "checkbox" },
];
export function RolePermissionMatrix() {
  return <div className="space-top">
    <h3>角色权限矩阵</h3>
    <Table headers={["角色", "数据范围 / 实时查看", "采集上传 / 文件导入", "分析 / 复核", "报告 / 导出", "用户 / 系统管理"]}>
      {[
        ["管理员", "全部课题组", "可上传、导入", "全部分析与复核", "生成、查看、导出", "可管理"],
        ["分析员", "所属课题组", "可上传、导入", "旋转、模态、损伤与复核", "生成、查看、导出", "无"],
        ["操作员", "本人采集与任务", "采集上传、任务文件导入", "本人任务基础分析；不可复核", "本人任务查看、导出", "无"],
        ["访客", "所属课题组", "只读", "只读", "查看、导出", "无"],
      ].map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}
    </Table>
    <p className="hint">权限由服务端校验。操作员不能执行旋转、模态或损伤分析，不能生成报告或复核告警；访客不能绑定桌面采集。删除账号保留历史采集、任务、分析与审计记录，登录账号名不能重复使用。</p>
  </div>;
}

export function DeleteUserDialog({ user, onClose, onDelete }: {
  user: Item; onClose: () => void; onDelete: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Dialog title="删除用户" onClose={() => { if (!busy) onClose(); }}>
    <p className="dialog-message">删除 <strong>{user.name}（{user.username}）</strong> 后，该账号从用户列表移除，不能再登录，服务器会话和令牌立即失效。历史采集、任务、分析及审计记录保留，账号名不能重新注册。</p>
    <p className="hint">已绑定的离线桌面将在下次联网登录时校验账号状态；不会远程中断正在运行的采集。若只需暂时停用，请取消并使用“禁用”。</p>
    <label className="inline-field"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我确认删除此账号并保留历史数据</label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="dialog-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="danger" disabled={busy || !confirmed} onClick={async () => {
      if (!confirmed || busy) return;
      setBusy(true); setError("");
      try { await onDelete(); onClose(); }
      catch (cause) { setError((cause as Error).message); setBusy(false); }
    }}>{busy ? "正在删除…" : "确认删除账号"}</Button></div>
  </Dialog>;
}
export function Administration({
  data,
  refresh,
  notify,
  canWrite,
  initialTab = "users",
  onReauthenticate,
}: ContextProps & { initialTab?: string; onReauthenticate?: () => void }) {
  const [tab, setTab] = useState(initialTab),
    [users, setUsers] = useState<Item[]>([]),
    [backups, setBackups] = useState<Item[]>([]),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState<Item | Record<string, any> | null>(null),
    [resettingPassword, setResettingPassword] = useState<Item | null>(null),
    [deletingUser, setDeletingUser] = useState<Item | null>(null),
    [review, setReview] = useState<Item | null>(null),
    [restore, setRestore] = useState<Item | null>(null),
    [schedule, setSchedule] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const admin = data.user.role === "admin";
  useEffect(() => {
    setTab(initialTab);
    setQuery("");
  }, [initialTab]);
  async function load() {
    if (!admin) return;
    setLoading(true);
    try {
      const [u, b] = await Promise.all([
        api("users"),
        api("backups"),
      ]);
      setUsers(u);
      setBackups(b);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [tab, data]);
  const config = data.settings.find(
    (s: Item) => s.id === "backup-schedule",
  ) || { name: "业务数据自动备份", enabled: false, hour: 2 };
  return (
    <div className="stack">
      <Card className="no-pad">
        <Tabs
          items={adminTabs}
          value={tab}
          onChange={(v) => {
            setTab(v);
            setQuery("");
          }}
        />
      </Card>
      {!admin && tab !== "alerts" ? (
        <Card title="权限提示">
          <p>
            当前角色为{roleNames[data.user.role as keyof typeof roleNames]}
            。用户、审计和备份管理仅管理员可访问。
          </p>
          {tab === "users" && <RolePermissionMatrix />}
        </Card>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          {tab === "users" && (
            <Card
              title="用户与权限（RBAC）"
              tools={
                <Button
                  variant="primary"
                  onClick={() =>
                    setEditing({
                      username: "",
                      name: "",
                      role: "analyst",
                      tenant: data.user.tenant,
                      active: true,
                      password: "",
                    })
                  }
                >
                  <Plus size={14} />
                  新增用户
                </Button>
              }
            >
              <div className="toolbar compact">
                <Filter
                  value={query}
                  onChange={setQuery}
                  placeholder="搜索姓名 / 账号 / 课题组"
                />
              </div>
              <Table headers={["用户", "角色", "课题组", "状态", "操作"]}>
                {users
                  .filter((u) =>
                    (u.name + u.username + u.tenant).includes(query),
                  )
                  .map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.name}</strong>
                        <small>{u.username}</small>
                      </td>
                      <td>{roleNames[u.role as keyof typeof roleNames]}</td>
                      <td>{u.tenant}</td>
                      <td>
                        <Tag tone={u.active ? "green" : "gray"}>
                          {u.active ? "启用" : "禁用"}
                        </Tag>
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setEditing({
                              ...u,
                              active: !!u.active,
                              password: "",
                            })
                          }
                        >
                          编辑权限
                        </Button>
                        <Button variant="ghost" onClick={() => setResettingPassword(u)}><KeyRound size={14} />重置密码</Button>
                        <Button
                          variant="ghost"
                          disabled={u.id === data.user.id}
                          onClick={async () => {
                            try {
                              await api("users/" + u.id, "PUT", {
                                ...u,
                                active: !u.active,
                              });
                              await load();
                              notify(u.active ? "用户已禁用" : "用户已启用");
                            } catch (e) {
                              notify((e as Error).message);
                            }
                          }}
                        >
                          {u.active ? "禁用" : "启用"}
                        </Button>
                        <Button variant="ghost" disabled={u.id === data.user.id} aria-label={`删除账号 ${u.username}`} onClick={() => setDeletingUser(u)}><Trash2 size={14} />删除</Button>
                      </td>
                    </tr>
                  ))}
              </Table>
              <RolePermissionMatrix />
            </Card>
          )}
          {tab === "logs" && <AuditLogScreen notify={notify} />}
          {tab === "backup" && (
            <Card
              title="业务数据备份"
              tools={
                <Button
                  variant="primary"
                  onClick={async () => {
                    try {
                      const r = await api("backups", "POST", {});
                      await load();
                      notify("备份成功，共 " + r.count + " 条业务记录");
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  立即备份
                </Button>
              }
            >
              <div className="backup-summary">
                <div>
                  <span className="muted">上次备份</span>
                  <h3>{backups[0]?.name || "尚无备份"}</h3>
                </div>
                <Button onClick={() => setSchedule(true)}>
                  自动备份：
                  {config.enabled ? "每日 " + config.hour + ":00" : "关闭"}
                </Button>
              </div>
              <p className="hint">
                仅备份本课题组的任务、参数、预警、模型登记、模板和报告记录。不会操作其他数据库、账号或系统日志。真实原始波形未接入。
              </p>
              <Table headers={["备份名称", "记录数", "操作"]}>
                {backups.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td>{b.count}</td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          download(
                            "export/backups/" + b.id + "?format=json",
                          ).catch((e) => notify(e.message))
                        }
                      >
                        <Download size={14} />
                        下载
                      </Button>
                      <Button variant="ghost" onClick={() => setRestore(b)}>
                        <RotateCcw size={14} />
                        恢复
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
              {!backups.length && (
                <Empty text="点击立即备份，创建第一份业务快照" />
              )}
            </Card>
          )}
          {tab === "alerts" && (
            <Card
              title="异常告警"
              tools={<ExportButton kind="alerts" notify={notify} />}
            >
              <div className="toolbar compact">
                <Filter
                  value={query}
                  onChange={setQuery}
                  placeholder="搜索告警 / 对象"
                />
              </div>
              {data.alerts
                .filter((a: Item) => (a.name + a.object).includes(query))
                .map((a: Item) => (
                  <div
                    className={
                      "alert-row " + (a.status === "已关闭" ? "closed" : "")
                    }
                    key={a.id}
                  >
                    <span
                      className={
                        "status-dot " +
                        (a.level === "信息" ? "green" : "orange")
                      }
                    />
                    <div>
                      <strong>{a.name}</strong>
                      <small>
                        {a.object} · {a.metric}　{a.value} / {a.threshold}　
                        {a.source === "demo" ? "演示事件" : ""}
                      </small>
                      {a.reviewNote && (
                        <small>
                          复核：{a.reviewNote} · {a.reviewer} · {a.reviewedAt ? new Date(a.reviewedAt).toLocaleString("zh-CN") : "历史记录未记时"}
                        </small>
                      )}
                      {!!a.reviewHistory?.length && <details className="review-history"><summary>复核历史（{a.reviewHistory.length}）</summary><ol>{a.reviewHistory.map((entry: Item, i: number) => <li key={i}>{entry.status} · {entry.actor} · {new Date(entry.time).toLocaleString("zh-CN")}<p>{entry.note}</p></li>)}</ol></details>}
                    </div>
                    <Tag tone={a.status === "已关闭" ? "green" : "amber"}>
                      {a.status}
                    </Tag>
                    <Button disabled={!canWrite} onClick={() => setReview(a)}>
                      处理
                    </Button>
                  </div>
                ))}
              {!data.alerts.length && <Empty text="当前无告警" />}
            </Card>
          )}
        </>
      )}
      {editing && (
        <EditDialog
          title={editing.id ? "编辑用户与权限" : "新增用户"}
          fields={
            editing.id
              ? userFields.filter((f) => f.key !== "username" && f.key !== "password")
              : userFields
          }
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (v) => {
            const result = await api<{ reauthenticate?: boolean }>(
              "users" + (editing.id ? "/" + editing.id : ""),
              editing.id ? "PUT" : "POST",
              v,
            );
            if (result.reauthenticate) { onReauthenticate?.(); return; }
            await load();
            notify("用户已保存");
          }}
        />
      )}
      {resettingPassword && <AccountPasswordDialog mode="reset" username={resettingPassword.username} onClose={() => setResettingPassword(null)} onSave={async ({ newPassword }) => {
        const result = await api<{ reauthenticate: boolean }>("users/" + resettingPassword.id + "/password", "POST", { newPassword });
        setResettingPassword(null);
        if (result.reauthenticate) { onReauthenticate?.(); return; }
        notify("统一密码已重置；已绑定桌面下次联网登录请使用新密码。");
        await load();
      }} />}
      {deletingUser && <DeleteUserDialog user={deletingUser} onClose={() => setDeletingUser(null)} onDelete={async () => {
        await api("users/" + deletingUser.id, "DELETE", { confirm: true });
        setUsers(previous => previous.filter(user => user.id !== deletingUser.id));
        notify("用户已删除；历史数据和审计记录已保留。");
      }} />}
      {review && (
        <EditDialog
          title="告警处理"
          initial={review}
          fields={[
            {
              key: "status",
              label: "状态",
              type: "select",
              options: ["待复核", "已确认", "已关闭"],
              required: true,
            },
            {
              key: "reviewNote",
              label: "处置 / 复核意见",
              type: "textarea",
              required: true,
            },
          ]}
          onClose={() => setReview(null)}
          onSave={async (v) => {
            if (!v.reviewNote?.trim()) throw Error("请填写处置意见");
            await saveRecord(
              "alerts",
              { status: v.status, reviewNote: v.reviewNote },
              review.id,
            );
            await refresh();
            notify("处理结果已保存");
          }}
        />
      )}
      {restore && (
        <EditDialog
          title="恢复业务数据"
          initial={{ confirm: "" }}
          fields={[
            {
              key: "confirm",
              label:
                "将覆盖此备份所属课题组的当前业务记录。请输入：恢复业务数据",
              required: true,
            },
          ]}
          onClose={() => setRestore(null)}
          onSave={async (v) => {
            await api("backups/restore", "POST", {
              id: restore.id,
              confirm: v.confirm,
            });
            await refresh();
            await load();
            notify("业务数据已恢复");
          }}
        />
      )}
      {schedule && (
        <EditDialog
          title="自动业务备份"
          initial={config}
          fields={[
            {
              key: "enabled",
              label: "启用每日备份（需启动备份 Worker）",
              type: "checkbox",
            },
            {
              key: "hour",
              label: "每天运行时间（北京时间 0~23）",
              type: "number",
              min: 0,
              max: 23,
              required: true,
            },
          ]}
          onClose={() => setSchedule(false)}
          onSave={async (v) => {
            await saveRecord(
              "settings",
              { ...config, ...v },
              "backup-schedule",
            );
            await refresh();
            notify("备份计划已保存");
          }}
        />
      )}
    </div>
  );
}
const modelFields: Field[] = [
  { key: "name", label: "模型名称", required: true },
  {
    key: "category",
    label: "类别",
    type: "select",
    options: ["模态识别", "损伤识别", "机器学习", "信号处理"],
    required: true,
  },
  { key: "version", label: "版本", required: true },
  { key: "endpoint", label: "服务端点（本阶段只登记）", required: true },
  { key: "description", label: "说明", type: "textarea" },
];
export function Developer({ data, refresh, notify }: ContextProps) {
  const [editing, setEditing] = useState<Item | Record<string, any> | null>(
      null,
    ),
    [tokens, setTokens] = useState<Item[]>([]),
    [tokenDialog, setTokenDialog] = useState(false),
    [newToken, setNewToken] = useState(""),
    [selectedId, setSelectedId] = useState(apiExamples[0].id),
    [reading, setReading] = useState(false),
    [preview, setPreview] = useState<{ endpoint: ApiExample; response: string } | null>(null);
  const selected = apiExample(selectedId);
  const admin = data.user.role === "admin";
  async function loadTokens() {
    if (admin)
      try {
        setTokens(await api("tokens"));
      } catch (e) {
        notify((e as Error).message);
      }
  }
  useEffect(() => {
    void loadTokens();
  }, []);
  const sample = apiRequestSample(selected);
  return (
    <div className="stack">
      <Card
        title="开放数据接口与算法扩展"
        tools={
          <Button
            onClick={() =>
              saveBlob(
                new Blob(
                  [apiReferenceMarkdown()],
                  { type: "text/markdown" },
                ),
                "BladeVMS-API-quick-reference.md",
              )
            }
          >
            <BookOpen size={14} />
            接口速查文档
          </Button>
        }
      >
        <div className="api-grid">
          <div>
            <h3>已实现 · 管理业务 API</h3>
            {apiExamples.map((endpoint) => (
              <button
                className={"endpoint " + (selectedId === endpoint.id ? "active" : "")}
                key={endpoint.id}
                aria-pressed={selectedId === endpoint.id}
                onClick={() => setSelectedId(endpoint.id)}
              >
                <Tag tone={endpoint.method === "GET" ? "green" : "blue"}>{endpoint.method}</Tag>
                <span className="mono">/api/v1/{endpoint.path}</span>
                <small>{endpoint.description}</small>
              </button>
            ))}
          </div>
          <div>
            <h3>调用契约</h3>
            <pre>{sample}</pre>
            <Button
              disabled={reading || selected.method !== "GET"}
              onClick={async () => {
                setReading(true);
                try {
                  const result = await readApiExample(selected.id, { read: api, download });
                  if (result.kind === "download") {
                    notify(result.saved ? "接口导出成功" : "已取消导出");
                    return;
                  }
                  setPreview({ endpoint: selected, response: JSON.stringify(result.data, null, 2) });
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setReading(false);
                }
              }}
            >
              {reading ? "读取中…" : selected.method !== "GET" ? "写入接口 · 仅展示契约" : selected.response === "download" ? "下载当前数据" : "读取当前数据"}
            </Button>
          </div>
        </div>
      </Card>
      <div className="workspace-grid">
        <Card
          title="算法模型管理"
          tools={
            <Button
              variant="primary"
              disabled={!admin}
              onClick={() =>
                setEditing({
                  name: "",
                  category: "损伤识别",
                  version: "v1.0",
                  endpoint: "https://algo.example.invalid/model",
                  description: "",
                  status: "已登记",
                })
              }
            >
              <Plus size={14} />
              接入算法模型
            </Button>
          }
        >
          <p className="hint">
            维护模型名称、类别、版本和服务端点。本阶段只保存配置，不执行外部模型、不测试外部连接。
          </p>
          <Table headers={["算法模型", "类别", "当前版本", "状态", "操作"]}>
            {data.models.map((m: Item) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.name}</strong>
                  <small className="ellipsis" title={m.endpoint}>
                    {m.endpoint}
                  </small>
                </td>
                <td>{m.category}</td>
                <td className="mono">{m.version}</td>
                <td>
                  <Tag tone={m.status === "停用" ? "gray" : "amber"}>
                    {m.status}
                  </Tag>
                </td>
                <td>
                  <Button
                    variant="ghost"
                    disabled={!admin}
                    onClick={() => setEditing(m)}
                  >
                    配置
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!admin}
                    onClick={async () => {
                      try {
                        await saveRecord(
                          "models",
                          {
                            ...m,
                            status: m.status === "停用" ? "已登记" : "停用",
                          },
                          m.id,
                        );
                        await refresh();
                        notify("模型登记状态已更新");
                      } catch (e) {
                        notify((e as Error).message);
                      }
                    }}
                  >
                    {m.status === "停用" ? "启用登记" : "停用"}
                  </Button>
                  {m.previousVersion && (
                    <Button
                      variant="ghost"
                      disabled={!admin}
                      onClick={async () => {
                        try {
                          await saveRecord(
                            "models",
                            {
                              ...m,
                              version: m.previousVersion,
                              previousVersion: m.version,
                            },
                            m.id,
                          );
                          await refresh();
                          notify("登记版本已回滚");
                        } catch (e) {
                          notify((e as Error).message);
                        }
                      }}
                    >
                      回滚版本
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
        <aside className="stack">
          <Card title="访问令牌" tools={<KeyRound size={17} />}>
            <p className="hint">
              令牌有效期 30 天，继承所属账号当前权限。仅创建时显示一次。
            </p>
            <Button
              className="full"
              variant="primary"
              disabled={!admin}
              onClick={() => setTokenDialog(true)}
            >
              创建 API 令牌
            </Button>
            {tokens.map((t) => (
              <div className="token-row" key={t.id}>
                <div>
                  {t.name}
                  <small>到期：{t.expires_at}</small>
                </div>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api("tokens/" + t.id, "DELETE");
                      await loadTokens();
                      notify("令牌已撤销");
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  撤销
                </Button>
              </div>
            ))}
          </Card>
          <Card title="系统 / 算法版本">
            <dl className="key-values">
              <dt>管理平台</dt>
              <dd>v1.0.0</dd>
              <dt>模型登记</dt>
              <dd>{data.models.length} 个</dd>
              <dt>算法服务</dt>
              <dd>
                <Tag tone="gray">未接入</Tag>
              </dd>
            </dl>
            <Button
              className="full space-top"
              onClick={() =>
                notify("当前为本地开发版本 v1.0.0；未配置远程更新源")
              }
            >
              检查更新
            </Button>
          </Card>
        </aside>
      </div>
      {editing && (
        <EditDialog
          title={editing.id ? "模型接入配置" : "登记算法模型"}
          fields={modelFields}
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (v) => {
            await saveRecord(
              "models",
              {
                ...v,
                status: v.status || "已登记",
                previousVersion:
                  editing.id && editing.version !== v.version
                    ? editing.version
                    : v.previousVersion,
              },
              editing.id,
            );
            await refresh();
            notify("模型配置已保存，外部连接未执行");
          }}
        />
      )}
      {tokenDialog && (
        <EditDialog
          title="创建 API 令牌"
          fields={[{ key: "name", label: "用途名称", required: true }]}
          initial={{ name: "科研数据访问" }}
          onClose={() => setTokenDialog(false)}
          onSave={async (v) => {
            const r = await api("tokens", "POST", v);
            setNewToken(r.token);
            await loadTokens();
          }}
        />
      )}
      {newToken && (
        <Dialog
          title="请保存令牌（仅显示一次）"
          onClose={() => setNewToken("")}
        >
          <pre className="token-value">{newToken}</pre>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(newToken);
                notify("令牌已复制");
              } catch {
                notify("请选中文字手动复制");
              }
            }}
          >
            <Copy size={14} />
            复制
          </Button>
        </Dialog>
      )}
      {preview && (
        <Dialog
          title={`接口返回 · ${preview.endpoint.method} /api/v1/${preview.endpoint.path}`}
          wide
          onClose={() => setPreview(null)}
        >
          <pre className="response-json">{preview.response}</pre>
        </Dialog>
      )}
    </div>
  );
}
