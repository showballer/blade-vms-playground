"use client";
import { CustomSelect } from "./custom-select";
import React, { useCallback, useRef, useState } from "react";
import { FileUp, FolderInput, LoaderCircle, CheckCircle2 } from "lucide-react";
import { Button, type ContextProps } from "./common";
import { api } from "./api";
import { FieldRotation } from "./field-rotation";
import type { FieldRecording, FieldRequestOptions } from "./field-types";
import "./field-styles.css";
import "./web-rotation.css";
import "./field-bending-view.css";

export function WebRotation({ canWrite, notify }: Pick<ContextProps, "canWrite" | "notify">) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0), [preferredIds, setPreferredIds] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null), [source, setSource] = useState("offline");
  const [quantity, setQuantity] = useState(""), [unit, setUnit] = useState("");
  const [imported, setImported] = useState<{ name: string; points: number; samples: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const onError = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : "操作失败，请重试。"), []);
  const request = useCallback(async <T,>(options: FieldRequestOptions): Promise<T> => {
    if (options.action === "recordings") return api<T>("rotation/recordings");
    if (options.action === "rotation") {
      setError("");
      return api<T>("rotation/analyze", "POST", options.parameters);
    }
    throw new Error("Web 旋转工作台仅支持离线数据读取和分析。");
  }, []);
  async function importFile(event: React.FormEvent) {
    event.preventDefault(); if (!file || !canWrite) return;
    setBusy(true); setError(""); setImported(null);
    try {
      if (file.size > (/\.xlsx$/i.test(file.name) ? 16 : 128) * 1024 * 1024) throw new Error("XLSX 上限 16 MB；CSV / CSV.GZ 上限 128 MB。");
      const query = new URLSearchParams({ filename: file.name, source, quantity, unit });
      const response = await fetch("/api/v1/rotation/import?" + query.toString(), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: file });
      const result = await response.json() as { error?: string; recordings?: FieldRecording[] };
      if (!response.ok || !result.recordings) throw new Error(result.error || "数据导入失败。");
      setPreferredIds(result.recordings.map(record => record.id));
      setImported({ name: file.name, points: result.recordings.length, samples: result.recordings.reduce((sum, record) => sum + record.samples, 0) });
      setRefreshKey(key => key + 1); setFile(null); if (input.current) input.current.value = "";
      notify(`已导入 ${result.recordings.length} 个测点，原文件与质量标签已保留。`);
    } catch (cause) { onError(cause); }
    finally { setBusy(false); }
  }
  return <div className="web-rotation-workspace">
    <header className="rotation-page-heading"><div><h1>旋转测振</h1><p>实测与离线数据分析 · 阶次谱 · 同步平均 · 多点振型重构</p></div><span className="field-badge">恒转速分析</span></header>
    <section className="field-card rotation-import-card"><div className="field-section-heading"><div><h2><FolderInput size={18} /> 数据导入</h2><p>导入多测点文件或桌面采集记录。</p></div><span className="field-badge">XLSX / CSV / GZ</span></div>
      <form onSubmit={importFile}>
        <div className="rotation-import-grid"><label className="rotation-file-picker"><FileUp size={24} /><span>{file ? file.name : "选择数据文件"}<small>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "XLSX ≤ 16 MB · CSV/GZ ≤ 128 MB"}</small></span><input ref={input} type="file" aria-label="旋转分析数据文件" accept=".xlsx,.csv,.csv.gz" disabled={busy || !canWrite} onChange={event => { setFile(event.target.files?.[0] || null); setError(""); }} /></label>
          <label>数据来源<CustomSelect value={source} disabled={busy || !canWrite} onChange={event => setSource(event.target.value)}><option value="offline">离线数据（来源待确认）</option><option value="measured">实测数据</option><option value="simulation">模拟数据</option></CustomSelect></label>
          <Button type="submit" variant="primary" disabled={!file || busy || !canWrite}>{busy ? <LoaderCircle size={16} className="spin" /> : <FileUp size={16} />}{busy ? "正在校验并导入…" : "导入并选择测点"}</Button>
        </div>
        <details className="rotation-format-help"><summary>文件格式与单位说明</summary><p>时间列使用 <code>time_s</code>（秒），信号列使用 <code>velocity_m_s</code> / <code>velocity_mm_s</code> 或 <code>displacement_m</code> / <code>displacement_mm</code> / <code>displacement_um</code>。同事提供的 Pn_xL 工作簿会读取每张测点表、位置与转速；CSV 可直接使用桌面的“导出完整 CSV”。</p><p>若信号列仅命名为 <code>value</code>，请在下方明确物理量和单位。带单位列名优先。位移通过差分换算为速度，换算方法与源文件一同保留。</p>
          <div className="rotation-unit-fields"><label>value 列物理量<CustomSelect value={quantity} disabled={busy || !canWrite} onChange={event => { setQuantity(event.target.value); setUnit(""); }}><option value="">请选择物理量</option><option value="velocity">速度</option><option value="displacement">位移</option></CustomSelect></label><label>value 列单位<CustomSelect value={unit} disabled={busy || !canWrite || !quantity} onChange={event => setUnit(event.target.value)}><option value="">请选择单位</option>{(quantity === "velocity" ? ["m/s", "mm/s"] : quantity === "displacement" ? ["m", "mm", "μm"] : []).map(value => <option key={value}>{value}</option>)}</CustomSelect></label></div>
          <p>原文件及质量标签完整保留；低回波样本不会被静默剔除。文件中已标记为模拟的数据始终显示为模拟，不能改为实测。XLSX 每测点 64～100 万点、合计不超过 200 万点；CSV/GZ 单点最多 800 万点，解压后不超过 512 MB。</p></details>
      </form>
      {!canWrite && <p className="field-notice">当前账号为只读权限，请使用具备分析权限的账号导入或计算。</p>}
      {imported && <p className="rotation-import-success" role="status"><CheckCircle2 size={17} />{imported.name} · 已保存 {imported.points} 个测点、{imported.samples.toLocaleString()} 个原始样本，已自动选择。</p>}
    </section>
    {error && <div className="field-error" role="alert">{error}<Button variant="ghost" onClick={() => setError("")}>关闭</Button></div>}
    <FieldRotation request={request} onError={onError} refreshKey={refreshKey} preferredIds={preferredIds} canAnalyze={canWrite && !busy} emptyText="还没有可分析的数据。先在上方导入实测 CSV 或多测点 XLSX，再选择测点和分析参数。" />
  </div>;
}
