import { auth, audit, HttpError, permission } from "../../../../../lib/db";
import { limitedBody, rotationUpload, rotationWorker } from "../../../../../lib/rotation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function handle(request: Request, context: Context) {
  try {
    const user = await auth(request);
    const route = (await context.params).path.join("/");
    if (request.method === "GET" && route === "recordings") return json(await rotationWorker(user, { action: "recordings" }));
    if (request.method !== "POST") throw new HttpError(405, "不支持的旋转分析操作。");
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin && origin !== process.env.APP_ORIGIN) throw new HttpError(403, "不允许的请求来源。");
    permission(user, "analyses", true);
    if (route === "import") {
      const result = await rotationUpload(user, request);
      await audit(user, "导入旋转分析数据", `${result.filename} · ${result.recordings.length} 个测点`);
      return json(result, 201);
    }
    if (route === "analyze") {
      const text = await limitedBody(request, 64 * 1024);
      let parameters: unknown;
      try { parameters = JSON.parse(text.toString("utf8")); } catch { throw new HttpError(400, "分析参数必须为 JSON。"); }
      const result = await rotationWorker(user, { action: "rotation", parameters });
      await audit(user, "执行旋转分析", `${result.rpm} RPM · ${result.modeShape.points.length} 个测点`);
      return json(result);
    }
    throw new HttpError(404, "旋转分析接口不存在。");
  } catch (error) {
    return json({ error: error instanceof HttpError ? error.message : "旋转分析操作失败，请稍后重试。" }, error instanceof HttpError ? error.status : 500);
  }
}
export const GET = handle;
export const POST = handle;
