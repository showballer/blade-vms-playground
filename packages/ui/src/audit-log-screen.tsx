"use client";
import { useEffect, useRef, useState } from "react";
import { api, download, type Item } from "./api";
import { Button, Card, Empty, Select, Table, Tag } from "./common";

const emptyFilters = { actor: "", target: "", action: "", result: "", from: "", to: "" };
type Filters = typeof emptyFilters;
type LogPage = { items: Item[]; total: number; page: number; pageSize: number; actions: string[]; results: string[] };
function filterParams(filters: Filters) {
  return new URLSearchParams(Object.entries(filters).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]));
}
export function AuditLogScreen({ notify }: { notify: (message: string) => void }) {
  const [draft, setDraft] = useState(emptyFilters), [applied, setApplied] = useState(emptyFilters);
  const [page, setPage] = useState<LogPage>({ items: [], total: 0, page: 1, pageSize: 25, actions: [], results: [] });
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [format, setFormat] = useState("csv"), [exporting, setExporting] = useState(false);
  const requestId = useRef(0);
  const dirty = filterParams(draft).toString() !== filterParams(applied).toString();
  const dateError = draft.from && draft.to && draft.from > draft.to ? "开始日期不能晚于结束日期" : "";
  async function load(filters: Filters, number = 1) {
    const id = ++requestId.current;
    setLoading(true); setError("");
    try {
      const params = filterParams(filters);
      params.set("paginated", "1"); params.set("page", String(number)); params.set("pageSize", "25");
      const result = await api("logs?" + params) as LogPage;
      if (id === requestId.current) { setPage(result); setApplied(filters); }
    } catch (e) { if (id === requestId.current) setError((e as Error).message); }
    finally { if (id === requestId.current) setLoading(false); }
  }
  useEffect(() => { void load(emptyFilters); return () => { requestId.current++; }; }, []);
  const textField = (key: "actor" | "target" | "from" | "to", label: string, type = "text") => <label className="field"><span>{label}</span><input type={type} aria-label={label} value={draft[key]} maxLength={200} onChange={e => setDraft({ ...draft, [key]: e.target.value })} /></label>;
  return <Card className="audit-log-screen" title="操作日志" tools={<div className="joined">
    <select aria-label="日志导出格式" value={format} disabled={exporting} onChange={e => setFormat(e.target.value)}>{["csv", "txt", "xlsx", "json"].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select>
    <Button disabled={loading || exporting || dirty || !!error || !page.total} onClick={async () => {
      setExporting(true);
      try { const params = filterParams(applied); params.set("format", format); const saved = await download("export/logs?" + params); notify(saved ? "已导出全部匹配日志" : "已取消导出"); }
      catch (e) { notify((e as Error).message); }
      finally { setExporting(false); }
    }}>{exporting ? "导出中…" : "导出查询结果"}</Button>
  </div>}>
    <form className="toolbar compact audit-filters" onSubmit={e => { e.preventDefault(); if (!dateError && !loading) void load(draft); }}>
      {textField("actor", "操作人")}{textField("from", "开始日期", "date")}{textField("to", "结束日期", "date")}
      <Select label="动作" value={draft.action} options={[{ value: "", label: "全部" }, ...Array.from(new Set([...page.actions, draft.action].filter(Boolean))).map(value => ({value, label:value}))]} onChange={action => setDraft({ ...draft, action })} />
      {textField("target", "操作对象")}
      <Select label="结果" value={draft.result} options={[{value:"",label:"全部"}, ...Array.from(new Set(["成功", "失败", ...page.results, draft.result].filter(Boolean))).map(value=>({value,label:value}))]} onChange={result => setDraft({ ...draft, result })} />
      <Button type="submit" disabled={loading || !!dateError}>{loading ? "查询中…" : "查询日志"}</Button>
      <Button type="button" disabled={loading} onClick={() => { setDraft(emptyFilters); void load(emptyFilters); }}>重置查询</Button>
    </form>
    <p className="hint">时间范围含首尾两日，按日志显示的数据库时间查询。导出包含全部匹配记录（最多 10000 条），不限当前页。</p>
    {dateError && <p role="alert" className="error">{dateError}</p>}
    {error && <p role="alert" className="error">{error}；下方保留上次成功查询结果。</p>}
    {dirty && <p role="status" className="hint">筛选条件已修改，请点击“查询日志”；下方仍为上次查询结果。</p>}
    <div aria-busy={loading}>
      <Table headers={["时间", "操作人", "动作", "对象", "结果"]}>{page.items.map(row => <tr key={row.id}><td className="mono">{row.time}</td><td>{row.actor}</td><td>{row.action}</td><td className="audit-target">{row.target}</td><td><Tag tone={row.result === "成功" ? "green" : row.result === "失败" ? "red" : "orange"}>{row.result}</Tag></td></tr>)}</Table>
      {!loading && !page.items.length && <Empty text="没有符合查询条件的日志" />}
    </div>
    <div className="toolbar space-top" aria-label="日志分页"><span role="status">共 {page.total} 条 · 第 {page.page} / {Math.max(1, Math.ceil(page.total / page.pageSize))} 页</span><Button disabled={loading || dirty || page.page <= 1} onClick={() => void load(applied, page.page - 1)}>上一页</Button><Button disabled={loading || dirty || page.page * page.pageSize >= page.total} onClick={() => void load(applied, page.page + 1)}>下一页</Button></div>
  </Card>;
}
