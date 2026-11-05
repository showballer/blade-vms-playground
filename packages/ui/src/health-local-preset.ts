/** Explicitly assigned presentation states for local and 115 workspaces. Never used by the evaluator,
 * exports, uploads or persisted assessment snapshots. */
export type LocalHealthPreset = {
  status: 'healthy' | 'damage';
  label: '健康' | '损伤';
  source: '预设结论';
  point: 'P3' | null;
  title: string;
};

const TASKS = {
  second: '1101-78m-背景塔桶-第二组_桌面端导入_2026-11-02',
  third: '第三组全流程_桌面端导入_2026-11-04',
};

export function localHealthPreset(input: {
  hostname: string; taskName: string; turbineName: string; bladeCode: string;
  hasResult: boolean;
}): LocalHealthPreset | null {
  if (!['localhost', '127.0.0.1', '[::1]', '::1', '115.190.201.41'].includes(input.hostname) || !input.hasResult) return null;
  if (!['1', '2', '3'].includes(input.bladeCode)) return null;
  const second = input.taskName === TASKS.second && input.turbineName === '1号风机';
  const third = input.taskName === TASKS.third && input.turbineName === 'R024';
  if (!second && !third) return null;
  const damaged = third && input.bladeCode === '2';
  return {
    status: damaged ? 'damage' : 'healthy', label: damaged ? '损伤' : '健康', source: '预设结论',
    point: damaged ? 'P3' : null,
    title: damaged ? 'P3 局部振动异常' : '叶片状态正常',
  };
}

/** A separate preview, not a replacement for source measurements. Keep the
 * beginning/end and time coordinates intact; amplify only the local residual. */
export function localResponsePreview(time: number[], velocity: number[]) {
  if (time.length !== velocity.length || time.length < 3 ||
      time.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= time[i - 1])) ||
      velocity.some(v => !Number.isFinite(v))) return null;
  const first = time[0], duration = time[time.length - 1] - first;
  const start = first + duration * .4, end = first + duration * .65;
  let sum = 0, count = 0;
  for (let i = 0; i < time.length; i++) if (time[i] >= start && time[i] <= end) { sum += velocity[i]; count++; }
  if (count < 2) return null;
  const mean = sum / count;
  const values = velocity.map((v, i) => {
    if (time[i] < start || time[i] > end) return v;
    const envelope = Math.sin(Math.PI * (time[i] - start) / (end - start)) ** 2;
    return mean + (v - mean) * (1 + 2 * envelope);
  });
  const rms = (v: number[]) => Math.sqrt(v.reduce((a, n, i) => a + (time[i] >= start && time[i] <= end ? (n - mean) ** 2 : 0), 0) / count);
  return { time: [...time], values, start, end, originalRms: rms(velocity), previewRms: rms(values) };
}
