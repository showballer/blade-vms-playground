import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseWaveCsv, taskMat } from "../packages/ui/src/data-export";
import { reportContent } from "../packages/ui/src/report-data";
import { download, setOffline } from "../packages/ui/src/api";
import { validateTaskMetadata } from "../packages/ui/src/task-metadata";
import { playbackWindow } from "../packages/ui/src/playback";
import { createDemoSnapshot } from "../packages/ui/src/demo-snapshot";
import { workspaceTask } from "../packages/ui/src/workspace-context";

const tests: { name: string; result: string }[] = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  tests.push({ name, result: "pass" });
  console.log("PASS " + name);
}
async function main() {
await check("工作区底栏不保留无权/已删除任务，仍允许当前任务本地配置预览", () => {
  const previous = { id: "previous-user-task", name: "上个账号任务", sampleRate: 25600 };
  const own = { id: "own-task", name: "本账号任务", sampleRate: 100 };
  assert.equal(workspaceTask([], previous), undefined);
  assert.equal(workspaceTask([own], previous), own);
  assert.equal(workspaceTask([own]), own);
  const edited = { ...own, sampleRate: 200 };
  assert.equal(workspaceTask([own], edited), edited);
  assert.equal(workspaceTask([], edited), undefined);
});
await check("演示快照按实际点数/采样率保存时长，不继承旧任务标识和回传来源", () => {
  const samples = [1, -2, 3, -4];
  const source = { id: "old-task", name: "原任务", sampleRate: 25600, duration: 120, source: "import", ownerId: "someone", syncOrigin: { localId: "old" } };
  const snapshot = createDemoSnapshot(source, samples, "2026-09-07T01:00:00Z");
  assert.equal(snapshot.duration, 4 / 25600); assert.equal(snapshot.source, "demo");
  assert.equal(snapshot.id, undefined); assert.equal(snapshot.ownerId, undefined); assert.equal(snapshot.syncOrigin, undefined);
  assert.equal(snapshot.testTime, "2026-09-07T01:00:00Z"); assert.equal(source.duration, 120);
  samples[0] = 99; assert.equal(snapshot.samples[0], 1);
  assert.throws(() => createDemoSnapshot({ ...source, sampleRate: 0 }, samples));
});
await check("CSV 接受 BOM、标题、空行和时间/幅值列", () => {
  assert.deepEqual(parseWaveCsv("\uFEFF时间,幅值\r\n0,1\r\n\r\n0.01,-2\r\n"), [1, -2]);
  assert.deepEqual(parseWaveCsv("1\n2\n3"), [1, 2, 3]);
});
await check("CSV 不把空值当零、不截断非法值或超长数据", () => {
  for (const input of ["time,value\n0,", "v\n1\nbad", "", Array(20001).fill("1").join("\n")]) assert.throws(() => parseWaveCsv(input));
});
await check("MAT 缺少波形或无效采样率时明确拒绝", () => {
  assert.throws(() => taskMat([{ sampleRate: 100 }]));
  assert.throws(() => taskMat([{ sampleRate: 0, samples: [1] }]));
  assert.throws(() => taskMat([{ sampleRate: 100, samples: [NaN] }]));
});
await check("MAT 按实际采样率导出时间与幅值矩阵", () => {
  const bytes = taskMat([{ sampleRate: 100, samples: [4, 5], source: "import" }]);
  const view = new DataView(bytes.buffer);
  const offset = 20 + view.getInt32(16, true);
  assert.equal(view.getInt32(4, true), 2);
  assert.equal(view.getInt32(8, true), 2);
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => view.getFloat64(offset + i * 8, true)), [0, 0.01, 4, 5]);
});
await check("元信息拒绝重复通道、非法单位和无时区时间", () => {
  const channel = { no: 1, type: "velocity", unit: "mm/s" };
  assert.equal(validateTaskMetadata({ channels: [channel], testTime: "2026-09-07T09:00:00+08:00" }), null);
  for (const metadata of [{ channels: [channel, channel] }, { channels: [{ ...channel, no: 0 }] }, { channels: [{ ...channel, unit: "" }] }, { testTime: "2026-09-07T09:00:00" }, { testTime: 12 }, { environment: 12 }]) assert.ok(validateTaskMetadata(metadata));
});
await check("历史回放保留真实幅值、绝对时间和游标窗口", () => {
  const samples = [0, 2, -3, 4, 8];
  assert.deepEqual(playbackWindow(samples, 100, 3, 2), { samples: [-3, 4], times: ["0.020000", "0.030000"], start: 2, end: 4 });
  assert.deepEqual(playbackWindow(samples, 100, null).samples, samples);
  assert.equal(playbackWindow(samples, 100, 999).end, 5);
  assert.deepEqual(samples, [0, 2, -3, 4, 8]);
});
await check("MAT 完整元信息 UTF-8 可还原中文、通道和原始保留状态", () => {
  const task = { id: "qa", name: "叶尖测试", sampleRate: 100, samples: [2, -3], environment: "风速 8m/s", channels: [{ no: 2, type: "velocity", unit: "mm/s" }], testTime: "2026-09-07T01:00:00Z", raw_preserved: false };
  const bytes = taskMat([task]); const view = new DataView(bytes.buffer); let p = 0; let restored;
  while (p < bytes.length) {
    const rows = view.getInt32(p + 4, true), cols = view.getInt32(p + 8, true), nameSize = view.getInt32(p + 16, true);
    const name = new TextDecoder().decode(bytes.slice(p + 20, p + 20 + nameSize - 1));
    const start = p + 20 + nameSize;
    if (name === "metadata_json_utf8_1") restored = JSON.parse(new TextDecoder().decode(Uint8Array.from({ length: rows * cols }, (_, i) => view.getFloat64(start + i * 8, true))));
    p = start + rows * cols * 8;
  }
  assert.equal(restored.name, task.name); assert.equal(restored.environment, task.environment);
  assert.deepEqual(restored.channels, task.channels); assert.equal(restored.testTime, task.testTime);
  assert.equal(restored.raw_preserved, true); assert.equal(restored.sample_count, 2); assert.equal(restored.samples, undefined);
});
await check("报告只包含选中章节和关联任务分析", () => {
  const sections = reportContent({ taskId: "a", sections: ["对象信息", "FFT 频谱", "结论与建议"], conclusion: "QA conclusion" }, { name: "任务 A", object: "叶片 A" }, [
    { taskId: "a", type: "fft", name: "本任务 FFT", parameters: { nfft: 4096 }, source: "demo" },
    { taskId: "b", type: "fft", name: "其他任务 FFT" },
  ]);
  assert.equal(sections.length, 3);
  assert.equal(sections[1].rows?.length, 1);
  assert.equal(sections[1].rows?.[0][0], "本任务 FFT");
  assert.equal(sections[2].text, "QA conclusion");
  assert.ok(!JSON.stringify(sections).includes("[object Object]"));
});
await check("报告没有原始数据时不伪造波形", () => {
  const sections = reportContent({ sections: ["原始波形"] }, {});
  assert.equal(sections[0].rows, undefined);
  assert.match(sections[0].text, /尚未保存/);
});
await check("报告包含批处理截取记录，大量结果行使用摘要而不是挤入报告单元格", () => {
  const sections = reportContent({ taskId: "qa-task", sections: ["降噪与截取"] }, {}, [{ id: "qa-cut", taskId: "qa-task", name: "QA 截取", type: "time", source: "demo", parameters: { batchId: "qa-batch", step: "cut", settings: { start: 0, end: 1 } }, result: { note: "算法未接入", columns: ["时间", "幅值"], rows: Array.from({ length: 20000 }, (_, i) => [i, i + 1]) } }]);
  assert.equal(sections[0].rows?.length, 1);
  assert.match(sections[0].rows![0][2], /20000 行/);
  assert.match(sections[0].rows![0][2], /qa-cut/);
  assert.ok(JSON.stringify(sections).length < 1500);
});
await check("取消原生下载可被界面区分，避免虚假成功提示", async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { blade: { download: async () => ({ canceled: true }) } } });
    setOffline(false);
    assert.equal(await download("export/tasks?format=json"), false);
    Object.defineProperty(globalThis, "window", { configurable: true, value: { blade: { download: async () => ({ path: "test.json" }) } } });
    assert.equal(await download("export/tasks?format=json"), true);
  } finally {
    if (before) Object.defineProperty(globalThis, "window", before);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/core-test-results.json", JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
