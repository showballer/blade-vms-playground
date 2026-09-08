/** Displayed requests and downloaded examples use the same method-aware catalog. */
export type ApiExample = {
  id: string;
  method: "GET" | "POST";
  path: string;
  description: string;
  access: string;
  response: "json" | "download";
  body?: Record<string, unknown>;
};
export const apiExamples: readonly ApiExample[] = [
  { id: "tasks-list", method: "GET", path: "records/tasks", description: "查询有权访问的任务", access: "登录用户；操作员仅本人任务，其他非管理员仅本课题组。", response: "json" },
  { id: "tasks-create", method: "POST", path: "records/tasks", description: "创建任务元信息", access: "管理员、分析员、操作员可创建；访客只读。请求会写入数据，本页仅展示契约。", response: "json", body: {
    name: "叶片接口示例", object: "风机叶片A", turbine: "WT-03", point: "P3 叶尖", direction: "径向", rpm: 15, blades: 3, sampleRate: 25600, duration: 3,
    source: "demo", status: "本地", testTime: "2026-09-08T01:00:00Z", environment: "接口文档示例，非实测数据", faultType: "未标注", channels: [{ no: 1, type: "velocity", unit: "mm/s" }],
  } },
  { id: "analyses-list", method: "GET", path: "records/analyses", description: "获取有权访问的分析记录", access: "登录用户；继承任务及跨所有者结果的读取范围。", response: "json" },
  { id: "reports-list", method: "GET", path: "records/reports", description: "查询有权访问的报告", access: "登录用户；操作员只读本人任务的授权报告。", response: "json" },
  { id: "tasks-export", method: "GET", path: "export/tasks?format=csv", description: "导出任务记录 CSV", access: "登录用户；继承任务读取范围。此接口导出记录表，不是单任务原始波形。", response: "download" },
  { id: "alerts-list", method: "GET", path: "records/alerts", description: "查询有权访问的预警事件", access: "登录用户；操作员只读本人任务的关联告警。", response: "json" },
];
export function apiExample(id: string): ApiExample {
  const item = apiExamples.find(example => example.id === id);
  if (!item) throw Error("接口条目不存在");
  return item;
}
export function apiRequestSample(example: ApiExample) {
  return [
    `${example.method} /api/v1/${example.path}`,
    "Authorization: Bearer <your-token>",
    "Accept: " + (example.response === "download" ? "text/csv" : "application/json"),
    ...(example.body ? ["Content-Type: application/json", "", JSON.stringify(example.body, null, 2)] : []),
    "", "# " + example.access,
    "# Python 算法接口尚未接入；不向登记地址发送请求。",
  ].join("\n");
}
export function apiReferenceMarkdown() {
  return [
    "# BladeVMS 业务 API 速查", "",
    "本文件覆盖二次开发页列出的精选接口，不是全部 API。完整业务契约见项目根目录 API.md。",
    "浏览器使用登录会话；外部客户端使用 Bearer 令牌。示例不包含真实账号、令牌或业务记录。",
    "页面只提供 GET 读取与下载；POST 为调用示例，不会在此页执行。设备与 Python 算法尚未接入。", "",
    ...apiExamples.flatMap(example => [`## ${example.description}`, "", "```http", apiRequestSample(example), "```", ""]),
  ].join("\n");
}
/** Use an ID, not an arbitrary URL/method. This preview can never send writes. */
export async function readApiExample(id: string, transport: {
  read: (path: string, method: "GET") => Promise<unknown>;
  download: (path: string) => Promise<boolean>;
}): Promise<{ kind: "json"; data: unknown } | { kind: "download"; saved: boolean }> {
  const example = apiExample(id);
  if (example.method !== "GET") throw Error("此条目为写入接口，仅展示调用契约，不在此页执行。");
  if (example.response === "download") return { kind: "download", saved: await transport.download(example.path) };
  return { kind: "json", data: await transport.read(example.path, "GET") };
}
