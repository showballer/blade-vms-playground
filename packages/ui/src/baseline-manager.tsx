"use client";
import { useState } from "react";
import { api, type Item } from "./api";
import { Button, Dialog, Empty, Filter, Select, Table, Tag, type ContextProps } from "./common";
import { baselineHealthIssue, baselineModalUsable, baselineValues } from "./baseline-data";
const numericFields = [
  { key: "rms", label: "基线 RMS（mm/s）", max: undefined },
  { key: "frequency", label: "基线主频（Hz）", max: undefined },
  { key: "modal", label: "一阶模态频率（Hz）", max: undefined },
  { key: "score", label: "健康度（仅演示显示，0～100）", max: 100 },
  { key: "confidence", label: "置信度（仅演示显示，0～1）", max: 1 },
];
function draft(source?: Item): Record<string, string> {
  return { name: source?.name || "", object: source?.object || "", source: source?.source || "manual", status: source?.status || "active", note: source?.note || "", ...Object.fromEntries(numericFields.map(f => [f.key, source?.[f.key] == null ? "" : String(source[f.key])])) };
}
export function BaselineManager({ data, refresh, notify, onClose, onSelect, purpose, task }: Pick<ContextProps, "data" | "refresh" | "notify"> & { onClose: () => void; onSelect: (item: Item) => void; purpose: "health" | "modal"; task?: Item }) {
  const [query, setQuery] = useState(""), [status, setStatus] = useState("全部"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ original?: Item; values: Record<string, string> } | null>(null), [deleting, setDeleting] = useState<Item | null>(null), [confirmed, setConfirmed] = useState(false);
  const writable = ["admin", "analyst"].includes(data.user.role);
  const items = (data.baselines as Item[]).filter(b => (b.name + b.object + b.recordTenant).toLowerCase().includes(query.toLowerCase()) && (status === "全部" || (b.status === "disabled" ? "停用" : "启用") === status));
  function eligibility(b: Item) { return purpose === "health" ? baselineHealthIssue(b) : !baselineModalUsable(b) ? "需启用且有有效的一阶频率" : !task || b.object !== task.object || b.recordTenant !== task.recordTenant ? "需与当前任务同对象、同课题组" : ""; }
  const references = deleting ? (data.analyses as Item[]).filter(a => a.parameters?.baselineId === deleting.id || a.parameters?.config?.baselineId === deleting.id || a.parameters?.baseline === deleting.id).length : 0;
  return <Dialog title="基线管理" wide onClose={() => { if (!busy) onClose(); }}>
    <p className="note-box">这里只登记已有基线参数或演示样例，不从波形计算或训练基线，不认证为真实正常态。RMS、主频和一阶频率可分别登记；缺项保留为空。健康度/置信度仅用于演示面板，不是基线识别结果。</p>
    {editing ? <form data-testid="baseline-editor" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("");
      try {
        const input = { ...editing.values, ...Object.fromEntries(numericFields.map(f => [f.key, editing.values[f.key].trim() === "" ? null : Number(editing.values[f.key])])) };
        baselineValues(input, editing.original);
        const saved = await api<Item>("records/baselines" + (editing.original ? "/" + editing.original.id : ""), editing.original ? "PUT" : "POST", { ...input, ...(editing.original ? { revision: editing.original.revision } : {}) });
        await refresh(); setEditing(null); notify("基线登记已保存；历史分析和报告快照未改写");
        if (!eligibility(saved)) onSelect(saved);
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>
      <h3>{editing.original ? "编辑基线" : "登记基线"}</h3><p className="hint">保存到课题组：{editing.original?.recordTenant || data.user.tenant}。{!editing.original && "副本也保存到当前登录课题组，不覆盖来源。"}</p>
      <div className="form-grid">{[{ key: "name", label: "基线名称" }, { key: "object", label: "基线测试对象" }].map(f => <label className="form-field" key={f.key}><span>{f.label} *</span><input aria-label={f.label} required maxLength={200} disabled={busy} value={editing.values[f.key]} onChange={e => setEditing({ ...editing, values: { ...editing.values, [f.key]: e.target.value } })} /></label>)}
        <Select label="基线来源" value={editing.values.source} options={[{ value: "manual", label: "手工登记（未经算法确认）" }, { value: "demo", label: "演示样例" }]} disabled={busy} onChange={source => setEditing({ ...editing, values: { ...editing.values, source } })} />
        <Select label="基线状态" value={editing.values.status} options={[{ value: "active", label: "启用" }, { value: "disabled", label: "停用" }]} disabled={busy} onChange={status => setEditing({ ...editing, values: { ...editing.values, status } })} />
        {numericFields.map(f => <label className="form-field" key={f.key}><span>{f.label}</span><input aria-label={f.label} type="number" step="any" min={0} max={f.max} value={editing.values[f.key]} disabled={busy} placeholder="未登记则留空" onChange={e => setEditing({ ...editing, values: { ...editing.values, [f.key]: e.target.value } })} /></label>)}
        <label className="form-field span-2"><span>基线来源与说明</span><textarea aria-label="基线来源与说明" maxLength={2000} rows={3} disabled={busy} value={editing.values.note} onChange={e => setEditing({ ...editing, values: { ...editing.values, note: e.target.value } })} /></label>
      </div>
      {error && <p className="error" role="alert">{error} 表单内容已保留；版本冲突时请返回列表刷新并重新编辑。</p>}
      <div className="dialog-actions"><Button type="button" disabled={busy} onClick={() => { setEditing(null); setError(""); }}>返回基线列表</Button><Button variant="primary" disabled={busy}>{busy ? "保存中…" : "保存基线"}</Button></div>
    </form> : deleting ? <div data-testid="baseline-delete-confirm">
      <h3>删除基线：{deleting.name}</h3><p>课题组：{deleting.recordTenant} · 对象：{deleting.object}</p><p>当前可见分析中有 {references} 份引用。仅删除这条登记，不删除历史分析、趋势、波形或报告快照；新分析不能再选择它。若只是不再使用，建议返回列表并停用。</p>
      <label className="inline-field"><input aria-label="确认删除此基线登记" type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />确认删除此基线登记</label>{error && <p role="alert" className="error">{error}</p>}
      <div className="dialog-actions"><Button disabled={busy} onClick={() => { setDeleting(null); setError(""); }}>取消删除</Button><Button variant="danger" disabled={busy || !confirmed} onClick={async () => { setBusy(true); setError(""); try { await api("records/baselines/" + deleting.id, "DELETE", { revision: deleting.revision, confirm: true }); await refresh(); setDeleting(null); notify("基线登记已删除；历史快照保留，登记可从有效业务备份恢复"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>确认删除基线</Button></div>
    </div> : <>
      <div className="toolbar"><Filter value={query} onChange={setQuery} placeholder="搜索基线 / 对象 / 课题组" /><Select label="筛选基线状态" value={status} options={["全部", "启用", "停用"]} onChange={setStatus} />
        <Button disabled={!writable || busy} variant="primary" onClick={() => { setError(""); setEditing({ values: { ...draft(), object: task?.object || "" } }); }}>登记新基线</Button>
        <Button disabled={busy} onClick={async () => { setBusy(true); try { await refresh(); setError(""); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>刷新基线列表</Button>
      </div>{error && <p role="alert" className="error">{error}</p>}
      {items.length ? <div className="baseline-table"><Table headers={["基线 / 课题组", "参数与用途", "状态 / 来源", "操作"]}>{items.map(b => <tr key={b.id} data-testid={"baseline-" + b.id}>
        <td><strong>{b.name}</strong><p>{b.object} · {b.recordTenant}</p><small>版本：{b.version || "旧记录"}</small></td>
        <td><span>RMS {b.rms ?? "—"} mm/s · 主频 {b.frequency ?? "—"} Hz<br />一阶频率 {b.modal ?? "—"} Hz</span><p className="muted">{baselineHealthIssue(b) || "可用于健康演示面板"}；{baselineModalUsable(b) ? "可用于模态基准" : "不可用于新模态对比"}</p><details><summary>完整登记信息</summary><pre className="result-metadata">{JSON.stringify(b, null, 2)}</pre></details></td>
        <td><Tag tone={b.status === "disabled" ? "gray" : "green"}>{b.status === "disabled" ? "停用" : "启用"}</Tag><p>{b.source === "demo" ? "演示样例" : b.source === "manual" ? "手工登记，未经算法确认" : "旧记录，来源未注明"}</p></td>
        <td><div className="stack"><Button disabled={!!eligibility(b) || busy} title={eligibility(b)} onClick={() => { onSelect(b); onClose(); }}>使用此基线</Button>
          <Button disabled={!writable || busy} aria-label={"编辑基线 " + b.id} onClick={() => { setError(""); setEditing({ original: b, values: draft(b) }); }}>编辑</Button>
          <Button disabled={!writable || busy} aria-label={"复制基线 " + b.id} onClick={() => { setError(""); setEditing({ values: { ...draft(b), name: b.name.slice(0, 190) + " · 副本", status: "active" } }); }}>登记副本</Button>
          <Button disabled={!writable || busy} aria-label={"切换基线状态 " + b.id} onClick={async () => { setBusy(true); setError(""); try { await api("records/baselines/" + b.id, "PUT", { revision: b.revision, status: b.status === "disabled" ? "active" : "disabled" }); await refresh(); notify(b.status === "disabled" ? "基线已启用" : "基线已停用，历史快照未改写"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{b.status === "disabled" ? "启用" : "停用"}</Button>
          <Button variant="danger" disabled={!writable || busy} aria-label={"删除基线 " + b.id} onClick={() => { setError(""); setConfirmed(false); setDeleting(b); }}>删除登记</Button></div></td>
      </tr>)}</Table></div> : <Empty text="没有匹配的基线登记；有维护权限的用户可新建，未登记的指标不会补默认值。" />}
      <div className="dialog-actions"><Button disabled={busy} onClick={onClose}>关闭基线管理</Button></div>
    </>}
  </Dialog>;
}
