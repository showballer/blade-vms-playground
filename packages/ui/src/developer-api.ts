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
  {id:"objects-list",method:"GET",path:"objects",description:"测量对象树（风场、风机、叶片、点位、批次）",access:"当前课题组；登录可读，写入服务端校验角色。",response:"json"},
  {id:"measurements-list",method:"GET",path:"measurements",description:"真实测量归属与分析结果",access:"当前课题组；原始导入文件按账号隔离。",response:"json"},
  {id:"wind-list",method:"GET",path:"wind-datasets",description:"风场工况数据集",access:"当前课题组；仅分析员和管理员可导入。",response:"json"},
  {id:"measurement-analysis",method:"POST",path:"measurements/analyze",description:"运行真实 Welch 特征分析",access:"分析员或管理员；仅已关联的实测来源，调用内置 Python worker。",response:"json",body:{reference:{kind:"import",id:"<recording-id>"},parameters:{windowSeconds:0.25,fadeFraction:0.05,detrend:"constant"}}},
  {id:"measurement-reports",method:"GET",path:"measurements/reports",description:"真实工况报告快照",access:"当前课题组；Word 导出见 API.md。",response:"json"},
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
    "# measurements/analyze 使用内置 Python 算法；登记的第三方地址不会自动调用。",
  ].join("\n");
}
export function apiReferenceMarkdown() {
  return [
    "# BladeVMS 业务 API 速查", "",
    "本文件覆盖二次开发页列出的精选接口，不是全部 API。完整业务契约见项目根目录 API.md。",
    "浏览器使用登录会话；外部客户端使用 Bearer 令牌。示例不包含真实账号、令牌或业务记录。",
    "页面只提供 GET 读取与下载；POST 为调用示例，不会在此页执行。测量频谱调用内置 Python worker，不连接现场设备。", "",
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
