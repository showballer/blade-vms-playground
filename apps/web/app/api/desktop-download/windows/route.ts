import { desktopWindowsDownload } from "../../../../lib/desktop-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) { return desktopWindowsDownload(request); }
export async function HEAD(request: Request) { return desktopWindowsDownload(request); }
