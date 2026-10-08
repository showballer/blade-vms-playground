import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { HttpError, type User } from "./db";

const globalState = globalThis as typeof globalThis & { bladeRotationWorkers?: { active: number; users: Set<string> } };
const workers = globalState.bladeRotationWorkers ??= { active: 0, users: new Set<string>() };
export const rotationFileLimit = 128 * 1024 * 1024;
function projectRoot() {
  // Python and user data are runtime installations, not JavaScript bundle assets.
  // Keep Turbopack from following a local virtualenv symlink outside the project.
  for (const root of [process.cwd(), path.resolve(/* turbopackIgnore: true */ process.cwd(), "../..")]) {
    if (existsSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ root, "services/acquisition/blade_acquisition/web_rotation.py"))) return root;
  }
  throw new HttpError(503, "未找到旋转分析服务，请部署 services/acquisition 并配置 Python 分析环境。");
}

/** Each job owns a short-lived process. The Web session never exposes service tokens or paths. */
async function withWorker<T>(user: Pick<User, "id" | "tenant">, operation: (service: string, python: string, data: string) => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(`${user.tenant}\0${user.id}`).digest("hex");
  if (workers.users.has(key)) throw new HttpError(409, "当前账号已有导入或分析在运行，请稍后重试。");
  if (workers.active >= 2) throw new HttpError(429, "分析服务繁忙，请稍后重试。");
  const root = projectRoot();
  const service = path.join(/* turbopackIgnore: true */ root, "services/acquisition");
  const bundled = path.join(/* turbopackIgnore: true */ service, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = process.env.BLADE_ANALYSIS_PYTHON || (existsSync(/* turbopackIgnore: true */ bundled) ? bundled : process.platform === "win32" ? "python" : "python3");
  const data = path.join(/* turbopackIgnore: true */ process.env.BLADE_ANALYSIS_DATA_DIR || path.join(/* turbopackIgnore: true */ root, ".data/web-rotation"), key);
  workers.active++; workers.users.add(key);
  try {
    await mkdir(data, { recursive: true, mode: 0o700 });
    return await operation(service, python, data);
  } finally { workers.active--; workers.users.delete(key); }
}

function runWorker(service: string, python: string, data: string, payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn(/* turbopackIgnore: true */ python, ["-m", "blade_acquisition.web_rotation", data], {
        cwd: service, shell: false, windowsHide: true,
        env: { ...process.env, PYTHONPATH: service, PYTHONIOENCODING: "utf-8", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", bytes = 0, settled = false;
      let stopping: Error | undefined;
      const timeout = setTimeout(() => stop(new HttpError(504, "导入或分析超过 180 秒，请缩小文件或分析区间后重试。")), 180_000);
      function stop(error: Error) {
        if (settled || stopping) return;
        stopping = error;
        // Keep the account lock and upload file until stdio and the process close.
        // In particular, Windows cannot unlink an input file still held by Python.
        child.kill("SIGKILL");
      }
      function finish(error?: Error, value?: unknown) {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        if (error) reject(error); else resolve(value);
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) stop(new HttpError(413, "分析结果过大，请减少测点或每转重采样点数。"));
        else if (!stopping) output += chunk;
      });
      // Drain diagnostics, but never return environment paths or raw tracebacks to a browser.
      child.stderr.resume();
      child.on("error", () => { stopping ??= new HttpError(503, "Python 分析环境不可用，请检查 BLADE_ANALYSIS_PYTHON 和采集服务依赖。"); });
      child.stdin.on("error", () => { /* close/error below provides the actual process result */ });
      child.on("close", code => {
        if (settled) return;
        if (stopping) { finish(stopping); return; }
        try {
          const response = JSON.parse(output);
          if (code === 0 && response.ok) finish(undefined, response.data);
          else if (code === 2 && response.ok === false) finish(new HttpError(400, String(response.error).slice(0, 1200)));
          else finish(new HttpError(503, "旋转分析服务未能完成计算，请检查 Python 环境及依赖。"));
        } catch { finish(new HttpError(503, "旋转分析服务不可用，请检查 Python 环境和 numpy、scipy、pydantic 依赖。")); }
      });
      child.stdin.end(JSON.stringify(payload));
    });
}

export async function rotationWorker(user: Pick<User, "id" | "tenant">, payload: Record<string, unknown>): Promise<any> {
  return withWorker(user, (service, python, data) => runWorker(service, python, data, payload));
}

export async function rotationUpload(user: Pick<User, "id" | "tenant">, request: Request) {
  const query = new URL(request.url).searchParams;
  const filename = path.basename(query.get("filename") || "");
  if (!/\.(xlsx|csv|csv\.gz)$/i.test(filename)) throw new HttpError(400, "请选择 XLSX、CSV 或 CSV.GZ 数据文件。");
  const limit = /\.xlsx$/i.test(filename) ? 16 * 1024 * 1024 : rotationFileLimit;
  if (Number(request.headers.get("content-length") || 0) > limit) throw new HttpError(413, "文件超过大小上限（XLSX 16 MB，CSV / CSV.GZ 128 MB）。");
  return withWorker(user, async (service, python, data) => {
    const inputFile = path.join(data, `.upload-${randomUUID()}`);
    const file = await open(inputFile, "wx", 0o600);
    try {
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError(400, "上传文件不能为空。");
      let length = 0, timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; void reader.cancel("上传超时"); }, 180_000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) { await reader.cancel(); throw new HttpError(413, "文件超过大小上限（XLSX 16 MB，CSV / CSV.GZ 128 MB）。"); }
          let offset = 0;
          while (offset < value.byteLength) {
            const written = await file.write(value, offset, value.byteLength - offset);
            if (!written.bytesWritten) throw new HttpError(500, "文件写入失败。");
            offset += written.bytesWritten;
          }
        }
      } finally { clearTimeout(timeout); }
      if (timedOut) throw new HttpError(504, "上传超过 180 秒，请检查网络后重试。");
      if (!length) throw new HttpError(400, "上传文件不能为空。");
      await file.close();
      const result = await runWorker(service, python, data, { action: "import", filename, inputFile, options: { source: query.get("source") || "offline", quantity: query.get("quantity") || "", unit: query.get("unit") || "" } });
      return { filename, ...result };
    } finally { await file.close().catch(() => undefined); await unlink(inputFile).catch(() => undefined); }
  });
}

export async function limitedBody(request: Request, limit: number): Promise<Buffer> {
  if (Number(request.headers.get("content-length") || 0) > limit) throw new HttpError(413, "请求参数过大。");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求内容不能为空。");
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new HttpError(413, "请求参数过大。"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
