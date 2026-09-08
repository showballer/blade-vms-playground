"use client";
import { useState } from "react";
import { download, saveDataFile, type Item } from "./api";
import { Button, Dialog, Select, Table } from "./common";
import { datasetFile, datasetHeader, recordDataset, resultFormats, type ResultDataset } from "./result-data";

export function ResultExport({ getData, path, notify, label = "导出数值结果", includeRecord = false, disabled = false, datasetKey }: {
  getData?: () => ResultDataset; path?: string; notify: (message: string) => void; label?: string; includeRecord?: boolean; disabled?: boolean; datasetKey?: string;
}) {
  const [format, setFormat] = useState<string>("csv"), [busy, setBusy] = useState(false);
  return <div className="joined result-export"><select aria-label={`${label}格式`} value={format} disabled={busy} onChange={(e) => setFormat(e.target.value)}>{resultFormats.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}{includeRecord && path && <option value="record-json">任务记录 JSON</option>}</select>
    <Button disabled={busy || disabled} onClick={async () => {
      setBusy(true);
      try {
        if (path) { const saved = await download(`${path}${path.includes("?") ? "&" : "?"}${format === "record-json" ? "format=json" : `view=data&format=${format}${datasetKey ? "&dataset=" + encodeURIComponent(datasetKey) : ""}`}`); notify(saved ? "所选数据与元信息已导出" : "已取消导出"); }
        else if (getData) { const dataset = getData(), file = await datasetFile(dataset, format); const saved = await saveDataFile(file, `BladeVMS-${dataset.metadata.type || "result"}`); notify(saved ? "当前标签完整数据与元信息已导出" : "已取消导出"); }
      } catch (error) { notify((error as Error).message); }
      finally { setBusy(false); }
    }}>{busy ? "正在生成…" : label}</Button></div>;
}
export function SavedResultDialog({ result, notify, onClose }: { result: Item; notify: (message: string) => void; onClose: () => void }) {
  const keys = Object.keys(result.result?.datasets || {}).slice(0, 16);
  const [datasetKey, setDatasetKey] = useState(keys[0] || "");
  let dataset: ResultDataset | undefined, error = "";
  try { dataset = recordDataset("analyses", result, datasetKey); } catch (e) { error = (e as Error).message; }
  return <Dialog title="已保存分析结果" wide onClose={onClose}><h3>{result.name}</h3>
    <p className="note-box">{dataset?.metadata.note || result.result?.note || "算法未接入"}</p>
    {keys.length > 0 && <Select label="已保存子结果" value={datasetKey} options={keys.map(key => ({ value: key, label: result.result.datasets[key]?.title || key }))} onChange={setDatasetKey} />}
    {dataset ? <><ResultExport path={`export/analyses/${result.id}`} datasetKey={datasetKey} notify={notify} /><div className="saved-result-table"><Table headers={dataset.columns.map(datasetHeader)}>{dataset.rows.slice(0, 100).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{typeof cell === "number" ? Number(cell.toPrecision(8)) : cell}</td>)}</tr>)}</Table></div>
      <p className="muted">预览前 {Math.min(100, dataset.rows.length)} / {dataset.rows.length} 行；导出全部行。历史结果使用保存时的快照，不随当前任务或参数改变。</p>
      <details><summary>保存的参数与来源</summary><pre className="result-metadata">{JSON.stringify(dataset.metadata, null, 2)}</pre></details></> : <p role="alert" className="error">{error}</p>}
    <div className="dialog-actions"><Button onClick={async () => { try { await download(`export/analyses/${result.id}?format=json`); } catch (e) { notify((e as Error).message); } }}>导出记录 JSON</Button><Button onClick={onClose}>关闭</Button></div>
  </Dialog>;
}
