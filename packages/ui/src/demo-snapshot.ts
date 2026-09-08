/** A finite saved demo buffer, not a hardware acquisition interval. */
export function createDemoSnapshot(task: Record<string, any>, samples: number[], now = new Date().toISOString()) {
  if (!Number.isFinite(task.sampleRate) || task.sampleRate <= 0) throw Error("快照采样率必须大于零");
  if (!samples.length || samples.length > 20000 || samples.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw Error("演示快照须包含 1～20000 个有效采样点");
  const { id: _, updatedAt: _updatedAt, ownerId: _owner, syncOrigin: _origin, ...metadata } = task;
  return { ...metadata, name: String(task.name || "任务").slice(0, 160) + " · 快照 " + new Date(now).toLocaleTimeString("zh-CN"),
    duration: samples.length / task.sampleRate, testTime: now, status: "本地", source: "demo", samples: [...samples], raw_preserved: true };
}
