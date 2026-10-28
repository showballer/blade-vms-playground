import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./db";

// Keep this read-only compatibility normalization aligned with storage.py.
export function normalizeImportedMetadata(value: Record<string, any>) {
  let manifest = value;
  const original = manifest.originalTaskName, suffix = " [未停稳判定测试]";
  if (typeof original === "string") manifest = { ...manifest, name: original };
  else if (manifest.diagnosticOnly === true && manifest.pointCycle?.diagnosticDetection?.enabled === true &&
    typeof manifest.name === "string" && manifest.name.endsWith(suffix)) {
    const name = manifest.name.slice(0, -suffix.length);
    manifest = { ...manifest, name, originalTaskName: name };
  }
  const cycle = manifest.pointCycle, evidence = cycle?.diagnosticDetection, handoff = cycle?.handoff, trigger = evidence?.trigger;
  if (cycle?.completion === "diagnostic_pass" && !("passCompleteness" in cycle) &&
    cycle.recordPreparation === "deferred_from_continuous_raw" && manifest.diagnosticOnly === true && manifest.validMeasurement === false &&
    evidence?.enabled === true && handoff && trigger && [handoff, trigger].every(item => item.passCompleteness === "confirmed" && item.sampleClock === "continuous_session_raw") &&
    handoff.completenessReason === trigger.completenessReason) {
    const restored = { ...cycle, passCompleteness: "confirmed" };
    if (!("completenessReason" in restored) && typeof handoff.completenessReason === "string") restored.completenessReason = handoff.completenessReason;
    manifest = { ...manifest, pointCycle: restored };
  }
  return manifest;
}

/** Read only atomic manifests. A catalogue read must never acquire an analysis
 * worker, recover raw files, create a directory, or rewrite the SQLite index. */
export async function readRotationCatalog(data: string) {
  const directory = path.join(data, "recordings");
  let entries;
  try {
    for (const location of [data, directory]) {
      const stat = await lstat(location);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(503, "导入记录目录无效，请检查服务端数据配置。");
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error.code === "ENOENT") return { recordings: [] };
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "无法读取导入记录目录，请检查服务端存储权限。");
  }
  const candidates = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9a-f]{32}$/.test(entry.name));
  let recordings: Record<string, any>[] = [];
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = await Promise.all(candidates.slice(index, index + 8).map(async entry => {
      const location = path.join(directory, entry.name, "manifest.json");
      let file;
      try {
        const stat = await lstat(location);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid metadata");
        file = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await file.stat();
        if (!opened.isFile() || opened.size > 1024 * 1024) throw new Error("Invalid metadata");
        const manifest = JSON.parse(await file.readFile("utf8"));
        if (!manifest || typeof manifest !== "object" || manifest.id !== entry.name) throw new Error("Invalid metadata");
        return normalizeImportedMetadata(manifest);
      } catch (error: any) {
        // Imports create a directory before atomically publishing the manifest.
        if (error.code === "ENOENT") return null;
        // A corrupt entry stays visible; never pretend the whole catalogue is empty.
        return { id: entry.name, name: "待检查的采集记录", samples: 0, sampleRate: null, startedAt: 0,
          endedAt: null, status: "incomplete", diagnosticOnly: true, validMeasurement: false, error: "采集元数据不可读取，请检查此记录。", unit: "m/s" };
      } finally { await file?.close(); }
    }));
    recordings.push(...batch.filter((item): item is Record<string, any> => item !== null));
    recordings.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0) || a.id.localeCompare(b.id));
    recordings = recordings.slice(0, 1000); // Same import-catalogue limit as RecordingStore.list().
    if (Buffer.byteLength(JSON.stringify(recordings)) > 8 * 1024 * 1024) throw new HttpError(413, "导入记录目录过大，请缩小查询范围。");
  }
  return { recordings };
}
