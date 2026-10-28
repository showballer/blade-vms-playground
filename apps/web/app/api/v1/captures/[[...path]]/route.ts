import { auth, HttpError } from "../../../../../lib/db";
import { captureBody, createCaptureService } from "../../../../../lib/captures";
import { autoLinkCapture } from "../../../../../lib/measurement-store";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function input(request: Request) {
  try { return JSON.parse((await captureBody(request)).toString("utf8")); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "请求必须为 JSON。"); }
}
async function associate(user: Parameters<typeof autoLinkCapture>[0], id: string) {
  try { return { association: await autoLinkCapture(user, id) }; }
  catch (error) { return { association: { linked: false, warning: error instanceof HttpError ? error.message : "记录已保存，测量对象关联稍后重试" } }; }
}
async function handle(request: Request, context: Context) {
  try {
    const user = await auth(request);
    const parts = (await context.params).path || [], [id, action, filename] = parts;
    const service = createCaptureService(), url = new URL(request.url);
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin && origin !== process.env.APP_ORIGIN) throw new HttpError(403, "不允许的请求来源。");
    }
    if (!parts.length) {
      if (request.method === "GET") return json(await service.list(user));
      if (request.method === "POST") {
        const result = await service.create(user, await input(request));
        return json({ ...result, ...await associate(user, result.capture.id) }, 201);
      }
    }
    if (parts.length === 1 && request.method === "GET") return json(await service.detail(user, id));
    if (parts.length === 2) {
      if (action === "live" && request.method === "PUT") {
        const payload = await input(request), result = await service.live(user, id, payload);
        return json({ ...result, ...(["stopped", "error"].includes(payload.state) ? await associate(user, id) : {}) });
      }
      if (action === "upload" && request.method === "POST") return json(await service.upload(user, id, await input(request)));
      if (["complete", "prepare-analysis"].includes(action) && request.method === "POST") {
        const body = await input(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new HttpError(400, "此操作不接受额外参数。");
        if (action === "complete") {
          const result = await service.complete(user, id);
          return json({ ...result, ...await associate(user, id) });
        }
        return json(await service.prepareAnalysis(user, id));
      }
      if (action === "archive-preview" && request.method === "GET") return json(await service.archivePreview(user, id));
      if (action === "waveform" && request.method === "GET") return json(await service.waveform(user, id, Number(url.searchParams.get("start") || 0), url.searchParams.has("end") ? Number(url.searchParams.get("end")) : undefined));
    }
    if (parts.length === 3 && action === "files" && request.method === "GET") {
      const file = await service.attachment(user, id, filename);
      return new Response(Readable.toWeb(file.stream) as ReadableStream<Uint8Array>, { headers: {
        "Cache-Control": "no-store", "Content-Type": file.mime, "Content-Length": String(file.bytes),
        "Content-Disposition": `attachment; filename="${file.filename}"`, "X-Content-Type-Options": "nosniff",
      } });
    }
    if (parts.length === 3 && action === "chunks" && request.method === "PUT") {
      if (!url.searchParams.has("offset")) throw new HttpError(400, "缺少分段偏移。");
      return json(await service.chunk(user, id, filename, Number(url.searchParams.get("offset")), await captureBody(request, 8 * 1024 * 1024)));
    }
    throw new HttpError(404, "采集接口不存在。");
  } catch (error) { return json({ error: error instanceof HttpError ? error.message : "采集操作失败，请稍后重试。" }, error instanceof HttpError ? error.status : 500); }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
