"use client";
import React, { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Card, Select, Table } from "./common";
import { MeasurementStatus, PageControls, timeText } from "./measurement-common";
import type { MeasurementObject } from "./measurement-domain";

const columns: Record<string, string> = {
  time: "时间", turbineCode: "风机编号", windSpeed: "风速", rpm: "轮毂转速",
  windDirection: "风向", powerKw: "有功功率", temperatureC: "外界温度",
};
const unitOptions: Record<string, { value: string; label: string }[]> = {
  windSpeed: [{ value: "m/s", label: "m/s" }, { value: "km/h", label: "km/h" }],
  rpm: [{ value: "rpm", label: "rpm（转/分）" }, { value: "rps", label: "转/秒" }],
  windDirection: [{ value: "deg", label: "度（°）" }],
  powerKw: [{ value: "kW", label: "kW" }, { value: "W", label: "W" }, { value: "MW", label: "MW" }],
  temperatureC: [{ value: "C", label: "摄氏度（°C）" }, { value: "F", label: "华氏度（°F）" }],
};
type Preview = { token: string; filename: string; encoding: string; headers: string[]; rows: string[][];
  rowCount: number; suggestedMapping: Record<string, string>; mapping: Record<string, string> };

export function WindDatasets({ canWrite }: { canWrite: boolean }) {
  const [all, setAll] = useState<MeasurementObject[]>([]), [datasets, setDatasets] = useState<any[]>([]),
    [farm, setFarm] = useState(""), [name, setName] = useState(""), [previews, setPreviews] = useState<Preview[]>([]),
    [units, setUnits] = useState<Record<string, string>>({}), [timezoneOffset, setTimezoneOffset] = useState("+08:00"),
    [busy, setBusy] = useState(false), [error, setError] = useState(""), [page, setPage] = useState(0), [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    try {
      const r = await api<any>("wind-datasets");
      setAll(r.objects); setDatasets(r.datasets); setError("");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function upload(files: File[]) {
    setError(""); setMessage("");
    if (files.length + previews.length > 8) { setError("一次最多选择 8 份文件，可先移除已选文件。"); return; }
    if (files.some(file => file.size > 16 * 1024 * 1024)) { setError("每份工况文件不能超过 16 MB。"); return; }
    setBusy(true);
    try {
      for (const [index, file] of files.entries()) {
        setMessage(`正在读取 ${index + 1}/${files.length}：${file.name}`);
        const response = await fetch(`/api/v1/wind-datasets/preview-file?filename=${encodeURIComponent(file.name)}`, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: file,
        });
        const value = await response.json();
        if (!response.ok) throw Error(value.error || "工况文件读取失败");
        setPreviews(current => [...current, { ...value, mapping: value.suggestedMapping }]);
      }
      if (!name) setName(files.length === 1 ? files[0].name : `${files[0].name.replace(/[_-].*$/, "")} · 风场工况`);
      setMessage("已读取文件。请核对指标单位和原始时区，再导入。");
    } catch (e) { setError((e as Error).message); setMessage(""); }
    finally { setBusy(false); }
  }
  const metrics = Object.keys(unitOptions).filter(key => previews.some(p => p.mapping[key]));
  const mappingsValid = previews.length > 0 && previews.every(p => p.mapping.time && p.mapping.turbineCode && metrics.some(key => p.mapping[key]) &&
    new Set(Object.values(p.mapping).filter(Boolean)).size === Object.values(p.mapping).filter(Boolean).length);
  const ready = mappingsValid && metrics.every(key => units[key]) && farm && name.trim();
  async function save() {
    setBusy(true); setError(""); setMessage("正在合并并保存工况数据…");
    try {
      const r = await api<any>("wind-datasets/import", "POST", {
        name, farmId: farm, timezoneOffset, units,
        files: previews.map(p => ({ token: p.token, mapping: p.mapping })),
      });
      setPreviews([]); setUnits({}); setName("");
      await load();
      setMessage(`已保存 ${r.count.toLocaleString()} 个风机时间点，其中 ${r.matchedRowCount.toLocaleString()} 个同时有风速和转速。缺失指标保持缺失。`);
    } catch (e) { setError((e as Error).message); setMessage(""); }
    finally { setBusy(false); }
  }
  const shown = datasets.filter(d => !farm || d.farmId === farm);
  return <div className="stack measurement-workspace">
    <header><h1>风场数据集</h1><p>按风机与时间关联真实工况，支持各指标分别导出的文件。</p></header>
    <Card title="导入工况文件">
      <div className="measurement-filters">
        <Select label="风场" value={farm} options={all.filter(o => o.kind === "farm" && o.active).map(o => ({ value: o.id, label: o.name }))}
          disabled={busy} onChange={v => { setFarm(v); setPage(0); }} />
        <label>CSV / XLSX · 可多选<input aria-label="风场数据文件" type="file" accept=".csv,.xlsx" multiple disabled={!canWrite || busy}
          onChange={e => { const files = Array.from(e.target.files || []); if (files.length) void upload(files); e.target.value = ""; }} /></label>
      </div>
      <p className="hint">每份最多 16 MB / 25 万行。中文列名、UTF-8 与 GB18030 均可识别；多文件仅按相同风机和相同时间合并，不补齐转速、风速或温度。</p>
      <MeasurementStatus loading={busy} error={error} onReload={() => void load()} />
      {message && <p role="status">{message}</p>}
      {!!previews.length && <div className="stack">
        <Table headers={["已选文件", "数据行", "已识别指标", ""]}>
          {previews.map(p => <tr key={p.token}><td>{p.filename}<small className="hint"> · {p.encoding}</small></td><td>{p.rowCount.toLocaleString()}</td>
            <td>{metrics.filter(key => p.mapping[key]).map(key => columns[key]).join("、") || "待映射"}</td>
            <td><Button disabled={busy} onClick={() => setPreviews(current => current.filter(item => item.token !== p.token))}>移除</Button></td></tr>)}
        </Table>
        <div className="measurement-filters">
          <label>数据集名称<input value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
          <Select label="无时区时间按此解释" value={timezoneOffset} disabled={busy} onChange={setTimezoneOffset}
            options={[{ value: "+08:00", label: "北京时间 UTC+08:00" }, { value: "+00:00", label: "UTC+00:00" }]} />
          {metrics.map(key => <Select key={key} label={`${columns[key]}原始单位`} value={units[key] || ""} disabled={busy}
            onChange={value => setUnits(current => ({ ...current, [key]: value }))} options={[{ value: "", label: "请选择单位" }, ...unitOptions[key]]} />)}
        </div>
        <p className="hint">文件未标明单位时，请按设备导出的单位选择。已有时区的时间保留原时区含义；系统统一保存为 UTC。只在风速、转速同时存在的时间范围内进行工况匹配。</p>
        {!mappingsValid && <p className="error">每份文件需要时间、风机编号与至少一个指标，列映射不能重复。</p>}
        <div><Button variant="primary" disabled={!canWrite || busy || !ready} onClick={() => void save()}>确认单位与时区并导入</Button></div>
        <details className="measurement-advanced"><summary>查看文件预览与列映射 · {previews.length} 份</summary>
        {previews.map(p => <section key={p.token}>
          <h4>{p.filename} · 前 5 行</h4>
          <div className="measurement-filters">{Object.entries(columns).map(([key, label]) => <Select key={key} label={label} value={p.mapping[key] || ""} disabled={busy}
            options={[{ value: "", label: ["time", "turbineCode"].includes(key) ? "选择列" : "本文件不含此项" }, ...p.headers.map(header => ({ value: header, label: header }))]}
            onChange={value => setPreviews(current => current.map(item => item.token === p.token ? { ...item, mapping: { ...item.mapping, [key]: value } } : item))} />)}</div>
          <Table headers={p.headers}>{p.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</Table>
        </section>)}
        </details>
      </div>}
    </Card>
    <Card title="已保存数据集">
      <Table headers={["数据集", "风场", "时间范围", "时间点数", "风速与转速同时存在"]}>
        {shown.slice(page * 20, (page + 1) * 20).map(d => <tr key={d.id}><td>{d.name}
          {d.metricCounts && <small className="hint" style={{ display: "block" }}>{Object.keys(unitOptions).filter(key => d.metricCounts[key] > 0).map(key => `${columns[key]} ${d.metricCounts[key].toLocaleString()}`).join(" · ")}</small>}
        </td><td>{all.find(o => o.id === d.farmId)?.name}</td><td>{timeText(d.start)} ～ {timeText(d.end)}</td><td>{d.rowCount.toLocaleString()}</td><td>{(d.matchedRowCount ?? d.rowCount).toLocaleString()}
          {d.matchedStart && <small className="hint" style={{ display: "block" }}>{timeText(d.matchedStart)} ～ {timeText(d.matchedEnd)}</small>}</td></tr>)}
      </Table>
      {!shown.length && !busy && <p className="hint">尚无工况数据；波形与频谱分析可以继续，工况异常判定暂不出结论。</p>}
      <PageControls page={page} total={shown.length} onChange={setPage} />
    </Card>
  </div>;
}
