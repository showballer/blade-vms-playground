import { api } from "./api";

export type AdoptionProgress = { linked: number; skipped: number; pages: number };
/** Explicit user action; old records are processed in bounded pages, never by a GET. */
export async function adoptMeasurementPages(
  onProgress?: (progress: AdoptionProgress) => void,
  request = (cursor: string | null) => api<{ linked: number; skipped: number; nextCursor?: string | null }>(
    "objects/adopt", "POST", cursor ? { cursor } : {}),
) {
  const progress: AdoptionProgress = { linked: 0, skipped: 0, pages: 0 }, seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await request(cursor);
    if (![page.linked, page.skipped].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("关联结果无效，请刷新后重试");
    progress.linked += page.linked; progress.skipped += page.skipped; progress.pages++;
    onProgress?.({ ...progress });
    cursor = page.nextCursor || null;
    if (cursor && seen.has(cursor)) throw new Error("关联分页未前进，请刷新后重试；已完成的关联会保留");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return progress;
}
