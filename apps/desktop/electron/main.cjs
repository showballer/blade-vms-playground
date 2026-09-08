const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID, createHash } = require("node:crypto");
const { rotationCanonical, rotationCutRecord } = require("./rotation-data.cjs");
const { modalRecord, modalBaselineCanonical } = require("./modal-data.cjs");
const { signalWorkflow, signalRefs, signalInput, signalRecord } = require("./signal-input.cjs");
const { validateTaskMetadata } = require("./task-metadata.cjs");
const { createSyncService } = require("./sync.cjs");
const { readWorkspace } = require("./workspace.cjs");
const { offlineBatchRequest } = require("./batches.cjs");
const { batchView } = require("./batch.cjs");
const { offlineImportRequest } = require("./imports.cjs");
const { importView } = require("./import-data.cjs");
let win,
  settings,
  token = "",
  workspace;
const configPath = () =>
  path.join(app.getPath("userData"), "blade-settings.json");
const workspacePath = () =>
  path.join(app.getPath("userData"), "blade-offline.json");
function writeAtomic(file, data) {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function trusted(event) {
  const url = event.senderFrame?.url || "";
  if (
    event.sender !== win?.webContents ||
    !(url.startsWith("file://") || url.startsWith("http://127.0.0.1:5210/"))
  )
    throw Error("不可信窗口");
}
function validatePath(p) {
  if (
    typeof p !== "string" ||
    p.length > 1000 ||
    p.includes("..") ||
    !/^((session|bootstrap|health|records|users|logs|tokens|backups|export|batches|imports)(\/|\?|$)|sync\/tasks$)/.test(
      p,
    )
  )
    throw Error("无效接口路径");
  return p;
}
function persistSettings() {
  const encrypted =
    token && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token).toString("base64")
      : undefined;
  writeAtomic(configPath(), { url: settings.url, token: encrypted });
}
async function request(options, connection = { url: settings.url, token }) {
  const p = validatePath(options.path);
  if (!["GET", "POST", "PUT", "DELETE"].includes(options.method))
    throw Error("无效请求方法");
  const url = new URL("/api/v1/" + p, connection.url);
  try {
  const response = await fetch(url, {
    method: options.method,
    headers: {
      "Content-Type": "application/json",
      ...(connection.token ? { Authorization: "Bearer " + connection.token } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const data = await response.json();
  if (p === "session" && options.method === "POST" && response.ok) {
    if (settings.url !== connection.url || token !== connection.token)
      return { status: 409, data: { error: "服务器或登录账号已变化，请重新登录。" } };
    token = data.token;
    persistSettings();
    delete data.token;
  }
  return { status: response.status, data };
  } finally {
    if (p === "session" && options.method === "DELETE" && settings.url === connection.url && token === connection.token) {
      // Even an unreachable server must not leave a supposedly logged-out token on this machine.
      token = "";
      persistSettings();
    }
  }
}
function offlineRequest({ path: p, method, body }) {
  validatePath(p);
  if (!["GET", "POST", "PUT", "DELETE"].includes(method))
    return { status: 405, data: { error: "不支持此操作" } };
  if (p === "bootstrap" && method === "GET") return { status: 200, data: { ...workspace, batches: (workspace.batches || []).map(batchView), imports: (workspace.imports || []).map(importView) } };
  if (p === "imports" || p.startsWith("imports/")) return offlineImportRequest(workspace, { path: p, method, body }, (next) => { writeAtomic(workspacePath(), next); workspace = next; });
  if (p === "batches" || p.startsWith("batches/")) return offlineBatchRequest(workspace, { path: p, method, body }, (next) => { writeAtomic(workspacePath(), next); workspace = next; });
  if (p === "session" && method === "DELETE")
    return { status: 200, data: { ok: true } };
  const [resource, kind, id, extra] = p.split("/");
  if (extra !== undefined || resource !== "records" || !["tasks", "analyses"].includes(kind))
    return { status: 403, data: { error: "离线演示仅支持本机任务与分析记录" } };
  const items = (workspace[kind] ||= []);
  if (method === "GET") {
    const data = id ? items.find((x) => x.id === id) : items;
    return data ? { status: 200, data } : { status: 404, data: { error: "本机记录不存在" } };
  }
  if ((method === "POST" && id) || (["PUT", "DELETE"].includes(method) && !id))
    return { status: 405, data: { error: "记录操作路径无效" } };
  const index = items.findIndex((x) => x.id === id);
  if (method === "PUT" && kind === "analyses" && items[index]?.parameters?.workflow === signalWorkflow) return { status: 405, data: { error: "信号结果快照不可改写，请重新保存新的分析记录" } };
  if (method !== "POST" && index < 0)
    return { status: 404, data: { error: "本机记录不存在" } };
  let data;
  if (method === "POST" || method === "PUT") {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return { status: 400, data: { error: "请输入有效记录" } };
    data = method === "PUT" ? { ...items[index], ...body } : { ...body };
    if (method === "PUT" && items[index].importOrigin) data.importOrigin = items[index].importOrigin;
    else delete data.importOrigin;
    const invalid = validateOfflineRecord(kind, data);
    if (invalid) return { status: 400, data: { error: invalid } };
    if (kind === "analyses" && data.parameters?.workflow === signalWorkflow) {
      try {
        const inputs = signalRefs(data.parameters.inputs).map(ref => signalInput(ref, workspace[ref.kind].find(record => record.id === ref.id)));
        for (const input of inputs) if (typeof input.ref.revision === "string" && /^[a-f0-9]{64}$/.test(input.ref.revision) && input.ref.revision !== createHash("sha256").update(input.canonical).digest("hex")) return { status: 409, data: { error: "所选任务或分段已变化，请刷新后重新确认信号输入" } };
        data = signalRecord(data, inputs);
        if (JSON.stringify(data).length > 1_800_000) return { status: 413, data: { error: "结果快照过大，请缩小分段范围" } };
      } catch (error) { return { status: 400, data: { error: error.message } }; }
    }
    if (kind === "analyses" && data.type === "modal") {
      const task = workspace.tasks.find(task => task.id === data.taskId);
      const baseline = data.parameters?.config?.baselineId === "prototype" ? undefined : workspace.baselines?.find(b => b.id === data.parameters?.config?.baselineId);
      try {
        for (const [revision, current] of [[data.parameters?.sourceRevision, task && createHash("sha256").update(rotationCanonical(task)).digest("hex")], [data.parameters?.baselineRevision, createHash("sha256").update(modalBaselineCanonical(baseline)).digest("hex")]]) {
          if (typeof revision === "string" && /^[0-9a-f]{64}$/.test(revision) && revision !== current) return { status: 409, data: { error: "任务或正常态基准已变化，请刷新后重新确认模态配置" } };
        }
        data = modalRecord(task, data, baseline);
      } catch (error) { return { status: 400, data: { error: error.message } }; }
    }
    if (kind === "analyses" && data.type === "cut") {
      const task = workspace.tasks.find(task => task.id === data.taskId);
      try {
        if (task && typeof data.parameters?.sourceRevision === "string" && /^[0-9a-f]{64}$/.test(data.parameters.sourceRevision) && data.parameters.sourceRevision !== createHash("sha256").update(rotationCanonical(task)).digest("hex")) return { status: 409, data: { error: "源任务已变化，请刷新并重新生成分段" } };
        data = rotationCutRecord(task, data);
      } catch (error) { return { status: 400, data: { error: error.message } }; }
    }
    if (kind === "tasks") data.raw_preserved = Array.isArray(data.samples) && data.samples.length > 0;
  }
  // Persist a copy before replacing memory, so a disk failure cannot appear successful.
  function commit(nextItems) {
    const next = { ...workspace, [kind]: nextItems };
    writeAtomic(workspacePath(), next);
    workspace = next;
  }
  if (method === "POST") {
    const item = {
      ...data,
      id: randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    commit([item, ...items]);
    return { status: 201, data: item };
  }
  if (method === "PUT") {
    const item = {
      ...data,
      id,
      updatedAt: new Date().toISOString(),
    };
    commit(items.map((old, i) => i === index ? item : old));
    return { status: 200, data: item };
  }
  if (method === "DELETE") {
    commit(items.filter((_, i) => i !== index));
    return { status: 200, data: { ok: true } };
  }
  return { status: 405, data: { error: "不支持此操作" } };
}
function validateOfflineRecord(kind, data) {
  const validText = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 300;
  if (!validText(data.name)) return "名称不能为空且不能超过 300 字";
  if (JSON.stringify(data).length > 1_800_000) return "记录超过本机存储大小限制";
  if (kind === "tasks") {
    if (!["object", "turbine", "point"].every((key) => validText(data[key])))
      return "请填写测试对象、风机编号和测点";
    if (!["rpm", "blades", "sampleRate", "duration"].every((key) => Number.isFinite(data[key]) && data[key] >= 0) || data.sampleRate < 1 || !Number.isInteger(data.blades) || data.blades < 1)
      return "采样率必须大于等于 1，叶片数必须为正整数，转速和时长不能为负数";
    if (data.samples !== undefined && (!Array.isArray(data.samples) || data.samples.length > 20000 || data.samples.some((v) => typeof v !== "number" || !Number.isFinite(v))))
      return "波形数据必须是最多 20000 个有限数值的数组";
    const metadataError = validateTaskMetadata(data);
    if (metadataError) return metadataError;
  } else if (!workspace.tasks.some((task) => task.id === data.taskId)) {
    return "分析记录关联的本机任务不存在";
  }
  return null;
}
app.whenReady().then(() => {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  try {
    settings = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (settings.token && safeStorage.isEncryptionAvailable())
      token = safeStorage.decryptString(Buffer.from(settings.token, "base64"));
  } catch {
    settings = { url: "http://127.0.0.1:3210" };
  }
  try {
    workspace = readWorkspace(workspacePath(), () => ({
      ...require("./demo-data.json"),
      user: {
        id: "offline-local",
        username: "offline",
        name: "本机用户",
        role: "admin",
        tenant: "本机演示工作区",
      },
    }));
    if (!workspace.clientId) {
      const next = { ...workspace, clientId: randomUUID() };
      writeAtomic(workspacePath(), next);
      workspace = next;
    }
  } catch {
    dialog.showErrorBox("无法打开本机工作区", "未覆盖已有的 blade-offline.json。请检查用户目录的读取/写入权限，或从有效备份恢复该文件后重新启动。");
    app.quit();
    return;
  }
  const sync = createSyncService({
    getWorkspace: () => workspace,
    commitWorkspace: (next) => { writeAtomic(workspacePath(), next); workspace = next; },
    getConnection: () => ({ url: settings.url, token }),
    request,
  });
  win = new BrowserWindow({
    width: 1520,
    height: 1000,
    minWidth: 900,
    minHeight: 640,
    title: "BladeVMS 现场工作台",
    frame: false,
    backgroundColor: "#F5F7FA",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith("http://127.0.0.1:5210/"))
      event.preventDefault();
  });
  ipcMain.handle("blade:request", async (event, options) => {
    trusted(event);
    try {
      return await request(options);
    } catch (e) {
      return {
        status: 503,
        data: { error: "无法连接管理服务器，请检查地址或使用离线演示。" },
      };
    }
  });
  ipcMain.handle("blade:offline", (event, options) => {
    trusted(event);
    return offlineRequest(options);
  });
  ipcMain.handle("blade:sync", (event, options) => {
    trusted(event);
    return sync(options);
  });
  ipcMain.handle("blade:settings", (event, url) => {
    trusted(event);
    if (url !== undefined) {
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw Error("请输入有效的 HTTP(S) 服务地址");
      settings.url = parsed.origin;
      token = "";
      persistSettings();
    }
    return settings.url;
  });
  ipcMain.handle("blade:save-data", async (event, options) => {
    trusted(event);
    if (!options || !["csv", "txt", "xlsx", "mat", "json"].includes(options.format) ||
        !(options.bytes instanceof Uint8Array) || !options.bytes.byteLength || options.bytes.byteLength > 16_000_000)
      throw Error("结果文件须为 CSV/TXT/XLSX/MAT/JSON，且大小不超过 16 MB");
    // Renderer supplies bytes, never a filesystem path. Each write requires the
    // native chooser; do not rely on Chromium's automatic-download permission.
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `BladeVMS-result.${options.format}`,
      filters: [{ name: options.format.toUpperCase(), extensions: [options.format] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, options.bytes);
    return { path: result.filePath };
  });
  ipcMain.handle("blade:download", async (event, p) => {
    trusted(event);
    validatePath(p);
    if (!p.startsWith("export/")) throw Error("仅允许导出接口");
    const res = await fetch(new URL("/api/v1/" + p, settings.url), {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!res.ok) throw Error((await res.json()).error || "导出失败");
    const filename =
      res.headers
        .get("content-disposition")
        ?.match(/filename="([^"]+)"/)?.[1] || "BladeVMS-export.json";
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.basename(filename),
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, Buffer.from(await res.arrayBuffer()));
    return { path: result.filePath };
  });
  ipcMain.on("blade:window", (event, action) => {
    trusted(event);
    if (action === "minimize") win.minimize();
    if (action === "maximize")
      win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === "close") win.close();
  });
  if (process.env.BLADE_DEV_URL === "http://127.0.0.1:5210")
    win.loadURL(process.env.BLADE_DEV_URL);
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
});
app.on("window-all-closed", () => app.quit());
