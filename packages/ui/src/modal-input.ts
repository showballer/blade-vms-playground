export const modalUnits: Record<string, string> = { velocity: 'm/s', displacement: 'm', acceleration: 'm/s^2', force: 'N' };
export function modalCsv(text: string) {
  const out: string[][] = []; let row: string[] = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(value); value = '';
      if (c !== ',') { if (row.some(v => v.trim())) out.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else value += c;
  }
  if (quoted) throw Error('CSV 引号未闭合');
  row.push(value); if (row.some(v => v.trim())) out.push(row);
  const columns = out.shift() || [];
  if (columns.length < 2 || columns.length > 17 || out.length < 32 || out.length > 2000000) throw Error('CSV 需要时间列及 1～16 个通道，32～200万行');
  const rows = out.map(r => {
    if (r.length !== columns.length || r.some(v => !v.trim() || !Number.isFinite(Number(v)))) throw Error('CSV 存在空值、非数值或不等长行');
    return r.map(Number);
  });
  return { columns, rows };
}
export function modalMappedInput(draft: any, evidence: any, calibration: string) {
  if (draft.json) return draft.json;
  if (!calibration.trim()) throw Error('请填写通道标定依据');
  return { schemaVersion: 'modal-input-1', sourceKind: 'imported_measurement',
    time_s: draft.rows.map((r: number[]) => r[draft.timeIndex]),
    channels: draft.channels.map((c: any) => {
      if (!c.pointId.trim() || !c.direction.trim() || !Number.isFinite(c.scale) || c.scale <= 0) throw Error('请填写测点、方向和正数 SI 换算系数');
      return { id: c.id, pointId: c.pointId.trim(), quantity: c.quantity, role: c.quantity === 'force' ? 'excitation' : 'response', direction: c.direction.trim(), unit: modalUnits[c.quantity], calibrationSource: calibration.trim(), values: draft.rows.map((r: number[]) => r[c.column] * c.scale) };
    }), evidence };
}
