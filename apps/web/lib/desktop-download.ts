import { open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

type Environment = Record<string, string | undefined>;
type DownloadSource = { kind: "file"; path: string; version: string | null; filename: string } | { kind: "remote"; url: string; version: string | null; filename: string | null };
export type DesktopDownloadInfo = { version: string | null; filename: string | null; size: number | null; available: boolean; url: string | null };
const downloadPath = "/api/desktop-download/windows";
const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function filename(value: string | undefined) {
  return value && value.length <= 180 && !/[\\/\x00-\x1f\x7f]/.test(value) && /\.exe$/i.test(value) ? value : null;
}

/** Only deployment configuration selects a file. Request parameters never select filesystem paths. */
function source(env: Environment, cwd: string): DownloadSource | null {
  const configuredVersion = env.BLADE_DESKTOP_WINDOWS_VERSION?.trim();
  const version = configuredVersion && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(configuredVersion) ? configuredVersion : null;
  if (env.BLADE_DESKTOP_WINDOWS_URL?.trim()) {
    try {
      const url = new URL(env.BLADE_DESKTOP_WINDOWS_URL.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      const name = env.BLADE_DESKTOP_WINDOWS_FILENAME || decodeURIComponent(url.pathname.split("/").at(-1) || "");
      if (env.BLADE_DESKTOP_WINDOWS_FILENAME && !filename(name)) return null;
      return { kind: "remote", url: url.toString(), version, filename: filename(name) };
    } catch { return null; }
  }
  const configuredPath = env.BLADE_DESKTOP_WINDOWS_PATH?.trim();
  if (configuredPath) {
    if (!path.isAbsolute(configuredPath)) return null;
    const name = filename(env.BLADE_DESKTOP_WINDOWS_FILENAME || path.basename(configuredPath));
    return name ? { kind: "file", path: configuredPath, filename: name, version } : null;
  }
  // This is the existing full 1.3.0 installer, not a package of the current source changes.
  // Installers are runtime files: do not trace/copy a 157 MB local release into Next's bundle.
  const root = path.basename(cwd) === "web" && path.basename(path.dirname(cwd)) === "apps"
    ? path.resolve(/* turbopackIgnore: true */ cwd, "../..") : cwd;
  return { kind: "file", path: path.join(/* turbopackIgnore: true */ root, "apps/desktop/release/full-1.3.0/BladeVMS-Setup-1.3.0-x64.exe"), filename: "BladeVMS-Setup-1.3.0-x64.exe", version: "1.3.0" };
}

async function remoteSize(url: string): Promise<{ available: boolean; size: number | null }> {
  try {
    const signal = AbortSignal.timeout(5_000);
    let response = await fetch(url, { method: "HEAD", redirect: "follow", cache: "no-store", signal });
    if ([405, 501].includes(response.status)) {
      response = await fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "follow", cache: "no-store", signal });
    }
    const total = response.status === 206 ? response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1] : response.headers.get("content-length");
    const parsedSize = total && /^\d+$/.test(total) ? Number(total) : null;
    await response.body?.cancel();
    return { available: response.ok, size: Number.isSafeInteger(parsedSize) && Number(parsedSize) > 0 ? parsedSize : null };
  } catch { return { available: false, size: null }; }
}

export async function desktopDownloadInfo(env: Environment = process.env, cwd = process.cwd()): Promise<DesktopDownloadInfo> {
  const target = source(env, cwd);
  if (!target) return { version: null, filename: null, size: null, available: false, url: null };
  let available = false, size: number | null = null;
  if (target.kind === "remote") ({ available, size } = await remoteSize(target.url));
  else {
    try {
      const handle = await open(/* turbopackIgnore: true */ target.path, "r");
      try {
        const file = await handle.stat();
        if (file.isFile() && Number.isSafeInteger(file.size) && file.size > 0) { available = true; size = file.size; }
      } finally { await handle.close(); }
    } catch { /* Missing/unreadable runtime installer is unavailable, never a dead local link. */ }
  }
  return { version: target.version, filename: target.filename, size, available, url: available ? downloadPath : null };
}

function byteRange(value: string, size: number): { start: number; end: number } | null {
  if (value.length > 200) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || !match[1] && !match[2]) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start
    ? { start, end: Math.min(end, size - 1) } : null;
}

function unavailable(request: Request, status = 404) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "Windows 客户端安装包暂不可用，请联系管理员更新下载配置。" }),
    { status, headers: { ...noStore, "Content-Type": "application/json; charset=utf-8" } });
}

export async function desktopWindowsDownload(request: Request, env: Environment = process.env, cwd = process.cwd()): Promise<Response> {
  const target = source(env, cwd);
  if (!target) return unavailable(request);
  if (target.kind === "remote") return new Response(null, { status: 307, headers: { ...noStore, Location: target.url } });
  let file;
  try {
    file = await open(/* turbopackIgnore: true */ target.path, "r");
    const details = await file.stat();
    if (!details.isFile() || !Number.isSafeInteger(details.size) || details.size <= 0) { await file.close(); return unavailable(request); }
    const modified = details.mtime.toUTCString();
    const fallback = target.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(target.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = new Headers({ ...noStore, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`, "Content-Length": String(details.size), "Accept-Ranges": "bytes", "Last-Modified": modified });
    // Per HTTP semantics, Range is ignored on HEAD. If-Range dates prevent mixing old and new releases.
    const rangeHeader = request.headers.get("range"), ifRange = request.headers.get("if-range");
    const useRange = request.method !== "HEAD" && rangeHeader && (!ifRange || ifRange === modified);
    const range = useRange ? byteRange(rangeHeader, details.size) : { start: 0, end: details.size - 1 };
    if (!range) {
      await file.close(); headers.set("Content-Range", `bytes */${details.size}`); headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    if (useRange) { headers.set("Content-Range", `bytes ${range.start}-${range.end}/${details.size}`); headers.set("Content-Length", String(range.end - range.start + 1)); }
    if (request.method === "HEAD") { await file.close(); return new Response(null, { headers }); }
    if (request.signal.aborted) { await file.close(); return new Response(null, { status: 499 }); }
    const stream = file.createReadStream({ start: range.start, end: range.end, autoClose: true, highWaterMark: 64 * 1024 });
    const abort = () => stream.destroy();
    request.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => request.signal.removeEventListener("abort", abort));
    // Count bytes, not chunks, in the Web Stream queue so slow clients cannot buffer the full installer.
    const body = Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>;
    return new Response(body, { status: useRange ? 206 : 200, headers });
  } catch {
    await file?.close().catch(() => {});
    return unavailable(request);
  }
}

export const desktopDownloadHeaders = noStore;
