import { taskMetadata } from "./task-metadata";
import { matMatrices } from "./data-export";

export type ResultColumn = { key: string; label: string; unit: string; type: "number" | "string" };
export type ResultDataset = {
  schema: "blade-vms/dataset-v1";
  title: string;
  columns: ResultColumn[];
  rows: (string | number)[][];
  metadata: Record<string, any>;
};
export const resultFormats = ["csv", "txt", "xlsx", "mat", "json"] as const;

/** One bounded rectangular dataset; no re-analysis, missing-value coercion or truncation. */
export function validateDataset(value: ResultDataset): ResultDataset {
  if (!value || value.schema !== "blade-vms/dataset-v1" || typeof value.title !== "string" ||
      !value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata) ||
      !Array.isArray(value.columns) || !value.columns.length || value.columns.length > 32 ||
      !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 20000)
    throw Error("没有可导出的完整结果数据（须为 1～20000 行、1～32 列）");
  const keys = new Set<string>();
  for (const column of value.columns) {
    if (!column || typeof column.key !== "string" || !column.key || keys.has(column.key) ||
        typeof column.label !== "string" || column.label.length > 300 || typeof column.unit !== "string" || column.unit.length > 300 || !["number", "string"].includes(column.type))
      throw Error("结果列定义无效或重复");
    keys.add(column.key);
  }
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== value.columns.length || row.some((cell, i) =>
      value.columns[i].type === "number" ? typeof cell !== "number" || !Number.isFinite(cell) : typeof cell !== "string"))
      throw Error("结果包含缺失、非有限数值或与列类型不符的数据；未导出文件");
    if (row.some((cell) => typeof cell === "string" && cell.length > 30000)) throw Error("单个结果文本超过 30000 字符，请使用原记录 JSON 导出");
  }
  return value;
}

/** Only saved values and snapshots are exported; never rebuild old results from the current task. */
export function recordDataset(kind: string, record: Record<string, any>, datasetKey?: string | null): ResultDataset {
  if (kind === "tasks") {
    if (datasetKey) throw Error("任务原始波形不支持分析子结果选择");
    const samples = record.samples, rate = record.sampleRate;
    if (!Array.isArray(samples) || !samples.length || !Number.isFinite(rate) || rate <= 0)
      throw Error("所选任务尚无有效的已保存波形");
    return validateDataset({ schema: "blade-vms/dataset-v1", title: record.name,
      columns: [{ key: "time", label: "时间", unit: "s", type: "number" }, { key: "value", label: "原始幅值", unit: record.channels?.[0]?.unit || "原始单位未注明", type: "number" }],
      rows: samples.map((value: number, i: number) => [i / rate, value]),
      metadata: { task: taskMetadata(record), source: record.source || "unknown", note: "已保存单列波形，保留原始幅值；未做通道转换或算法计算。" } });
  }
  if (kind !== "analyses") throw Error("数值结果导出仅支持任务波形和分析记录");
  const result = record.result || {}, { rows, dataset, datasets, ...summary } = result;
  const analysis = { ...record, result: summary };
  if (datasetKey) {
    if (!datasets || typeof datasets !== "object" || Array.isArray(datasets) || !Object.hasOwn(datasets, datasetKey)) throw Error("该历史分析没有所选子结果，不能回退为其他数据");
    const selected = datasets[datasetKey];
    return validateDataset({ ...selected, metadata: { ...selected?.metadata, analysis, datasetKey } });
  }
  if (dataset) return validateDataset({ ...dataset, metadata: { ...dataset.metadata, analysis } });
  // Compatibility for batch results saved before the common dataset contract.
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(result.columns))
    throw Error("此历史分析只保存了说明，没有结果矩阵；可导出记录 JSON，不能补造数值结果");
  return validateDataset({ schema: "blade-vms/dataset-v1", title: record.name,
    columns: result.columns.map((label: string, i: number) => ({ key: "column_" + (i + 1), label, unit: result.columnUnits?.[i] ?? label.match(/\(([^()]*)\)$/)?.[1] ?? "", type: typeof rows[0][i] === "number" ? "number" : "string" })),
    rows, metadata: { analysis, source: record.source || "unknown", note: result.note || "", inputMetadataAvailable: !!record.parameters?.inputMetadata } });
}

export function datasetHeader(column: ResultColumn) {
  return column.unit && !column.label.endsWith(`(${column.unit})`) ? `${column.label} (${column.unit})` : column.label;
}
function envelope(dataset: ResultDataset) {
  return { schema: dataset.schema, title: dataset.title, columns: dataset.columns, rowCount: dataset.rows.length, metadata: dataset.metadata };
}
/** Numeric negative cells stay numeric. Untrusted text cannot become spreadsheet formulas. */
export function delimitedCell(value: unknown) {
  let text = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  if (typeof value !== "number" && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function datasetText(dataset: ResultDataset, delimiter: "," | "\t") {
  validateDataset(dataset);
  // Two explicitly documented metadata records precede the rectangular data table.
  return "\uFEFF" + [
    ["# BladeVMS dataset-v1", "数值表从第 4 行开始；元信息 JSON 在第 2 行"],
    ["# metadata_json", JSON.stringify(envelope(dataset))],
    dataset.columns.map(datasetHeader), ...dataset.rows,
  ].map((row) => row.map(delimitedCell).join(delimiter)).join("\r\n");
}
export function datasetMat(dataset: ResultDataset) {
  validateDataset(dataset);
  const indices = dataset.columns.flatMap((column, i) => column.type === "number" ? [i] : []);
  if (!indices.length) throw Error("此结果没有数值列，不能导出 MAT 数值矩阵");
  const textColumns = dataset.columns.flatMap((column, i) => column.type === "string" ? [{ columnIndex: i, values: dataset.rows.map((row) => row[i]) }] : []);
  const metadata = { ...envelope(dataset), numericColumnIndices: indices, textColumns, indexBase: 0, encoding: "UTF-8", matrix: "values", layout: "rows = result rows; columns = numericColumnIndices order" };
  return matMatrices([
    { name: "values", columns: indices.map((i) => dataset.rows.map((row) => row[i] as number)) },
    { name: "numeric_column_indices", columns: [indices] },
    { name: "metadata_json_utf8", columns: [[...new TextEncoder().encode(JSON.stringify(metadata))]] },
  ]);
}
export async function datasetFile(dataset: ResultDataset, format: string) {
  validateDataset(dataset);
  let bytes: Uint8Array<ArrayBuffer>, mime: string;
  if (format === "mat") { bytes = datasetMat(dataset); mime = "application/octet-stream"; }
  else if (format === "csv" || format === "txt" || format === "json") {
    bytes = new TextEncoder().encode(format === "json" ? JSON.stringify(dataset, null, 2) : datasetText(dataset, format === "csv" ? "," : "\t"));
    mime = format === "json" ? "application/json;charset=utf-8" : format === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8";
  } else if (format === "xlsx") {
    // Loaded only when requested; also works in the sandboxed offline renderer.
    const ExcelJS = (await import("exceljs")).default;
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("结果数据", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(dataset.columns.map(datasetHeader));
    for (const row of dataset.rows) sheet.addRow(row);
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: dataset.rows.length + 1, column: dataset.columns.length } };
    sheet.columns.forEach((column) => { column.width = 24; });
    const metadataSheet = book.addWorksheet("元信息");
    metadataSheet.addRow(["内容", "分片序号（从 1 开始）", "值"]);
    metadataSheet.addRow(["读取方法", "", "按序拼接 metadata_json 各片后解析 JSON；数值在结果数据页，未执行算法计算。"]);
    const metadata = JSON.stringify(envelope(dataset));
    let part = 1;
    for (let i = 0; i < metadata.length;) {
      let end = Math.min(i + 15000, metadata.length);
      if (end < metadata.length && /[\uD800-\uDBFF]/.test(metadata[end - 1])) end--;
      metadataSheet.addRow(["metadata_json", part++, metadata.slice(i, end)]); i = end;
    }
    metadataSheet.columns = [{ width: 24 }, { width: 24 }, { width: 90 }];
    for (const s of [sheet, metadataSheet]) {
      s.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      s.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D6CC0" } };
      s.getRow(1).height = 24;
    }
    // Copy the library buffer into a regular ArrayBuffer-backed Uint8Array for Blob/Response.
    bytes = new Uint8Array(await book.xlsx.writeBuffer());
    mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else throw Error("不支持的数值结果导出格式");
  return { bytes, mime, extension: format };
}
