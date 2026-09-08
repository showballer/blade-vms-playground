import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { apiExamples, apiExample, apiReferenceMarkdown, apiRequestSample, readApiExample } from "../packages/ui/src/developer-api";

const results: { name: string; result: string }[] = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); results.push({ name, result: "pass" }); console.log("PASS " + name); }
async function main() {
await check("同路径 GET 与 POST 使用不同 ID 且仅选中一项", () => {
  assert.equal(new Set(apiExamples.map(e => e.id)).size, apiExamples.length);
  const samePath = apiExamples.filter(e => e.path === "records/tasks");
  assert.equal(samePath.length, 2);
  for (const e of samePath) assert.equal(apiExamples.filter(candidate => candidate.id === e.id).length, 1);
  assert.equal(apiExample("tasks-create").method, "POST");
});
await check("请求示例保持实际方法、JSON 正文和下载类型", () => {
  for (const e of apiExamples) assert.ok(apiRequestSample(e).startsWith(`${e.method} /api/v1/${e.path}\n`));
  const post = apiRequestSample(apiExample("tasks-create"));
  assert.ok(post.includes("Content-Type: application/json"));
  assert.ok(post.includes(JSON.stringify(apiExample("tasks-create").body, null, 2)));
  assert.ok(apiRequestSample(apiExample("tasks-export")).includes("Accept: text/csv"));
});
await check("每个 JSON 预览恰好发送一次显式 GET", async () => {
  for (const e of apiExamples.filter(e => e.method === "GET" && e.response === "json")) {
    const calls: unknown[] = [];
    const data = [{ id: "test-id", name: e.id }];
    const result = await readApiExample(e.id, { read: async (...args) => { calls.push(args); return data; }, download: async () => { throw Error("unexpected download"); } });
    assert.deepEqual(calls, [[e.path, "GET"]]); assert.deepEqual(result, { kind: "json", data });
  }
});
await check("写入条目和未知条目均在调用网络前拒绝", async () => {
  let calls = 0;
  const transport = { read: async () => { calls++; }, download: async () => { calls++; return true; } };
  await assert.rejects(readApiExample("tasks-create", transport), /仅展示调用契约/);
  await assert.rejects(readApiExample("https:\/\/example.invalid", transport), /接口条目不存在/);
  assert.equal(calls, 0);
});
await check("文件下载使用独立通道并保留取消状态", async () => {
  for (const saved of [true, false]) {
    const calls: string[] = [];
    const result = await readApiExample("tasks-export", { read: async () => { throw Error("Unexpected JSON read"); }, download: async path => { calls.push(path); return saved; } });
    assert.deepEqual(calls, ["export/tasks?format=csv"]);
    assert.deepEqual(result, { kind: "download", saved });
  }
});
await check("请求和保存异常直接返回，不报告虚假成功", async () => {
  const transport = { read: async () => { throw Error("forbidden"); }, download: async () => { throw Error("disk error"); } };
  await assert.rejects(readApiExample("tasks-list", transport), /forbidden/);
  await assert.rejects(readApiExample("tasks-export", transport), /disk error/);
});
await check("下载速查包含全部条目契约，与当前选中状态无关", () => {
  const text = apiReferenceMarkdown();
  assert.ok(text.includes("不是全部 API")); assert.ok(text.includes("API.md"));
  for (const e of apiExamples) assert.ok(text.includes(apiRequestSample(e)));
  assert.equal(text.match(/```http/g)?.length, apiExamples.length);
  assert.ok(text.includes("<your-token>")); assert.ok(!text.includes("BOOTSTRAP_PASSWORD"));
});
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/developer-api-core-results.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
