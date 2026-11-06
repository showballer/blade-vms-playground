export type DisplacementDisplayPoint = {point: string; radiusM: number | null; actualMm: number; displayMm: number};

/** An explicitly separate presentation series. Never used in signal/health calculations. */
export function increasingDisplacementDisplay(input: readonly Omit<DisplacementDisplayPoint, 'displayMm'>[]): DisplacementDisplayPoint[] {
  const valid = input.filter(p => Number.isFinite(p.actualMm) && p.actualMm >= 0)
    .sort((a, b) => a.point.localeCompare(b.point, 'zh-CN', {numeric: true}));
  if (valid.length < 2) return valid.map(p => ({...p, displayMm: p.actualMm}));
  // Equal-weight isotonic regression with a 2% minimum visual increment.
  const step = Math.max(...valid.map(p => p.actualMm)) * .02;
  if (!step) return valid.map(p => ({...p, displayMm: 0}));
  const blocks: {sum: number; count: number}[] = [];
  valid.forEach((p, i) => {
    blocks.push({sum: p.actualMm - step * i, count: 1});
    while (blocks.length > 1) {
      const a = blocks[blocks.length - 2], b = blocks[blocks.length - 1];
      if (a.sum / a.count <= b.sum / b.count) break;
      blocks.splice(-2, 2, {sum: a.sum + b.sum, count: a.count + b.count});
    }
  });
  const levels = blocks.flatMap(b => Array(b.count).fill(Math.max(0, b.sum / b.count)));
  return valid.map((p, i) => ({...p, displayMm: levels[i] + step * i}));
}

export const displacementDisplayTasks = new Set(['武川风场 R001 风机测量任务', '武川风场 R024 风机测量任务']);
