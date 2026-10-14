import { desktopDownloadHeaders, desktopDownloadInfo } from "../../../lib/desktop-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await desktopDownloadInfo(), { headers: desktopDownloadHeaders });
}
