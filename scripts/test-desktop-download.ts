import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopDownloadInfo, desktopWindowsDownload } from "../apps/web/lib/desktop-download";

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "blade-download-test-"));
  const payload = Buffer.alloc(256 * 1024); for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  const installer = path.join(directory, "BladeVMS-Setup-9.8.7-x64.exe");
  const env = { BLADE_DESKTOP_WINDOWS_PATH: installer, BLADE_DESKTOP_WINDOWS_VERSION: "9.8.7" };
  const request = (headers: Record<string, string> = {}, method = "GET") => new Request("http://localhost/api/desktop-download/windows", { method, headers });
  const server = createServer((req, res) => {
    if (req.url === "/missing.exe") { res.writeHead(404).end(); return; }
    if (req.url === "/range-only.exe" && req.method === "HEAD") { res.writeHead(405).end(); return; }
    if (req.url === "/range-only.exe") { assert.equal(req.headers.range, "bytes=0-0"); res.writeHead(206, { "Content-Range": `bytes 0-0/${payload.length}`, "Content-Length": "1" }).end(payload.subarray(0, 1)); return; }
    res.writeHead(200, { "Content-Length": String(payload.length) }); res.end(req.method === "HEAD" ? undefined : payload);
  });
  try {
    await writeFile(installer, payload);
    const metadata = await desktopDownloadInfo(env);
    assert.deepEqual(metadata, { version: "9.8.7", filename: path.basename(installer), size: payload.length, available: true, url: "/api/desktop-download/windows" });
    assert.equal(JSON.stringify(metadata).includes(directory), false);
    assert.equal((await desktopDownloadInfo({ BLADE_DESKTOP_WINDOWS_PATH: installer })).version, null);
    assert.equal((await desktopDownloadInfo({ BLADE_DESKTOP_WINDOWS_PATH: installer, BLADE_DESKTOP_WINDOWS_VERSION: "latest" })).version, null);

    const full = await desktopWindowsDownload(request(), env);
    assert.equal(full.status, 200); assert.equal(full.headers.get("content-length"), String(payload.length));
    assert.equal(full.headers.get("accept-ranges"), "bytes"); assert.match(full.headers.get("content-disposition")!, /attachment; filename=.*\.exe/);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload);
    for (const [header, first, last] of [["bytes=3-8", 3, 8], ["bytes=-5", payload.length - 5, payload.length - 1], [`bytes=${payload.length - 3}-`, payload.length - 3, payload.length - 1], [`bytes=${payload.length - 2}-${payload.length + 100}`, payload.length - 2, payload.length - 1]] as const) {
      const result = await desktopWindowsDownload(request({ Range: header }), env);
      assert.equal(result.status, 206); assert.equal(result.headers.get("content-range"), `bytes ${first}-${last}/${payload.length}`);
      assert.equal(result.headers.get("content-length"), String(last - first + 1));
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), payload.subarray(first, last + 1));
    }
    for (const header of ["bytes=-0", "bytes=20-10", `bytes=${payload.length}-`, "bytes=0-1,3-4", "bytes=", "bytes=999999999999999999999-"]) {
      const result = await desktopWindowsDownload(request({ Range: header }), env);
      assert.equal(result.status, 416); assert.equal(result.headers.get("content-range"), `bytes */${payload.length}`);
      assert.equal((await result.arrayBuffer()).byteLength, 0);
    }
    const head = await desktopWindowsDownload(request({ Range: "bytes=0-4" }, "HEAD"), env);
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(payload.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const current = await desktopWindowsDownload(request({ Range: "bytes=0-4", "If-Range": head.headers.get("last-modified")! }), env);
    assert.equal(current.status, 206); await current.body?.cancel();
    const outdated = await desktopWindowsDownload(request({ Range: "bytes=0-4", "If-Range": "Mon, 01 Jan 1990 00:00:00 GMT" }), env);
    assert.equal(outdated.status, 200); assert.equal(outdated.headers.get("content-length"), String(payload.length)); await outdated.body?.cancel();
    const cancellation = await desktopWindowsDownload(request(), env), reader = cancellation.body!.getReader();
    assert.equal((await reader.read()).value!.byteLength <= 64 * 1024, true); await reader.cancel();
    const controller = new AbortController(); controller.abort();
    assert.equal((await desktopWindowsDownload(new Request("http://localhost/api/desktop-download/windows", { signal: controller.signal }), env)).status, 499);

    const missingEnv = { ...env, BLADE_DESKTOP_WINDOWS_PATH: path.join(directory, "missing.exe") };
    assert.deepEqual(await desktopDownloadInfo(missingEnv), { version: "9.8.7", filename: "missing.exe", size: null, available: false, url: null });
    const missing = await desktopWindowsDownload(new Request(`http://localhost/api/desktop-download/windows?path=${encodeURIComponent(installer)}`), missingEnv);
    assert.equal(missing.status, 404); assert.equal((await missing.text()).includes(directory), false);
    for (const invalid of [{ BLADE_DESKTOP_WINDOWS_PATH: "relative.exe" }, { ...env, BLADE_DESKTOP_WINDOWS_FILENAME: "bad\r\nname.exe" }, { ...env, BLADE_DESKTOP_WINDOWS_PATH: directory }]) assert.equal((await desktopDownloadInfo(invalid)).available, false);

    const defaultLocation = path.join(directory, "apps/desktop/release/full-1.3.0/BladeVMS-Setup-1.3.0-x64.exe");
    await mkdir(path.dirname(defaultLocation), { recursive: true }); await writeFile(defaultLocation, payload);
    for (const cwd of [directory, path.join(directory, "apps/web")]) {
      const fallback = await desktopDownloadInfo({ BLADE_DESKTOP_WINDOWS_VERSION: "99.99.99" }, cwd);
      assert.equal(fallback.version, "1.3.0"); assert.equal(fallback.available, true);
    }
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/installer.exe`, remoteEnv = { BLADE_DESKTOP_WINDOWS_URL: url, BLADE_DESKTOP_WINDOWS_VERSION: "4.5.6", BLADE_DESKTOP_WINDOWS_FILENAME: "客户端-4.5.6.exe", BLADE_DESKTOP_WINDOWS_PATH: "ignored-relative.exe" };
    assert.deepEqual(await desktopDownloadInfo(remoteEnv), { version: "4.5.6", filename: "客户端-4.5.6.exe", size: payload.length, available: true, url: "/api/desktop-download/windows" });
    for (const method of ["GET", "HEAD"]) { const redirect = await desktopWindowsDownload(request({}, method), remoteEnv); assert.equal(redirect.status, 307); assert.equal(redirect.headers.get("location"), url); }
    assert.equal((await desktopDownloadInfo({ ...remoteEnv, BLADE_DESKTOP_WINDOWS_URL: `http://127.0.0.1:${port}/range-only.exe` })).size, payload.length);
    const unreachable = await desktopDownloadInfo({ ...remoteEnv, BLADE_DESKTOP_WINDOWS_URL: `http://127.0.0.1:${port}/missing.exe` });
    assert.equal(unreachable.available, false); assert.equal(unreachable.url, null);
    for (const badUrl of ["file:///private/package.exe", "javascript:alert(1)", "https://user:password@example.invalid/package.exe"]) assert.equal((await desktopDownloadInfo({ BLADE_DESKTOP_WINDOWS_URL: badUrl })).available, false);
    console.log("PASS desktop download metadata, exact configured version, missing files, streaming, HEAD, ranges, If-Range, cancellation, fixed paths and remote redirects");
  } finally {
    await new Promise<void>(resolve => server.listening ? server.close(() => resolve()) : resolve());
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
