import { taskMetadata } from "./task-metadata";
/** MAT level 4: little-endian, real double, column-major matrices.
 * Format: https://www.mathworks.com/help/pdf_doc/matlab/matfile_format.pdf
 * Serialization only: never computes or invents acquisition data.
 */
export function matMatrices(matrices: { name: string; columns: number[][] }[]): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  for (const { name, columns } of matrices) {
    if (!columns.length || !columns[0].length || columns.some((column) => column.length !== columns[0].length || column.some((value) => !Number.isFinite(value)))) throw Error("MAT 矩阵无效");
    const n = columns[0].length;
    const label = new TextEncoder().encode(name + "\0");
    const bytes = new Uint8Array(20 + label.length + n * columns.length * 8);
    const view = new DataView(bytes.buffer);
    [0, n, columns.length, 0, label.length].forEach((v, i) =>
      view.setInt32(i * 4, v, true),
    );
    bytes.set(label, 20);
    let offset = 20 + label.length;
    for (const column of columns)
      for (const value of column) {
        view.setFloat64(offset, value, true);
        offset += 8;
      }
    blocks.push(bytes);
  }
  if (!blocks.length) throw Error("没有可导出的数值矩阵");
  const result = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const block of blocks) { result.set(block, offset); offset += block.length; }
  return result;
}
export function taskMat(tasks: Record<string, any>[]): Uint8Array<ArrayBuffer> {
  const matrices: { name: string; columns: number[][] }[] = [];
  const matrix = (name: string, columns: number[][]) => { matrices.push({ name, columns }); };
  tasks.forEach((task, i) => {
    const samples = task.samples;
    if (!Array.isArray(samples) || !samples.length) return;
    if (samples.some((s) => typeof s !== "number" || !Number.isFinite(s)))
      throw Error("波形包含无效数值");
    const rate = Number(task.sampleRate);
    if (!Number.isFinite(rate) || rate <= 0) throw Error("任务采样率无效");
    matrix("wave_" + (i + 1), [samples.map((_, j) => j / rate), samples]);
    matrix("sample_rate_" + (i + 1), [[rate]]);
    matrix("is_demo_" + (i + 1), [[task.source === "demo" ? 1 : 0]]);
    // Portable numeric UTF-8 bytes: decode metadata_json_utf8_N to obtain the
    // complete metadata JSON, including Chinese labels, units and provenance.
    matrix("metadata_json_utf8_" + (i + 1), [[...new TextEncoder().encode(JSON.stringify(taskMetadata(task)))]]);
  });
  if (!matrices.length)
    throw Error("所选任务尚无保存的波形，请先导入数据或保存演示快照");
  return matMatrices(matrices);
}

/** Accept a value column or time,value rows, with an optional header. */
export function parseWaveCsv(text: string): number[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const values: number[] = [];
  for (const [index, line] of lines.entries()) {
    const cells = line
      .split(/[,;\t]/)
      .map((s) => s.trim().replace(/^"|"$/g, ""));
    const raw = cells[cells.length - 1];
    if (index === 0 && !Number.isFinite(Number(raw))) continue;
    if (!raw || !Number.isFinite(Number(raw)))
      throw Error(`第 ${index + 1} 行波形数值无效`);
    values.push(Number(raw));
  }
  if (!values.length || values.length > 20000)
    throw Error("CSV 应包含 1～20000 个波形采样点");
  return values;
}
