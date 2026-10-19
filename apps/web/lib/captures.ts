import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { canReadCapture, captureScope, HttpError, pool, requireCaptureAnalysis, requireCaptureWrite, type User } from "./db";
import { rotationWorker } from "./rotation";

type JsonObject = Record<string, any>;
export type CaptureFile = { name: string; bytes: number; sha256: string };
export type CaptureBody = { recording: JsonObject; liveState: "acquiring" | "stopped" | "offline" | "error";
  uploadState: "pending" | "uploading" | "complete" | "error"; receivedBytes: number; totalBytes: number;
  lastSeenAt: number | null; sequence: number; files?: CaptureFile[]; planHash?: string; error?: string };
export type CaptureRow = { id: string; owner_id: string; owner_name?: string; tenant: string; client_id: string; local_id: string;
  body: CaptureBody; created_at: string; updated_at: string };
export interface CaptureRepository {
  create(user: User, clientId: string, recording: JsonObject): Promise<CaptureRow>;
  list(user: User): Promise<CaptureRow[]>;
  get(id: string): Promise<CaptureRow | null>;
  mutate<T>(id: string, action: (row: CaptureRow) => Promise<T>): Promise<T>;
}
const decode = (row: any): CaptureRow => ({ ...row, body: typeof row.body === "string" ? JSON.parse(row.body) : row.body });
const columns = "c.*,u.name AS owner_name";
export const sqlCaptureRepository: CaptureRepository = {
  async create(user, clientId, recording) {
    const id = randomUUID().replaceAll("-", "");
    const body: CaptureBody = { recording, liveState: recording.status === "complete" ? "stopped" : "offline",
      uploadState: "pending", receivedBytes: 0, totalBytes: 0, lastSeenAt: null, sequence: -1 };
    await pool().execute("INSERT INTO captures(id,owner_id,tenant,client_id,local_id,body) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id",
      [id, user.id, user.tenant, clientId, recording.id, JSON.stringify(body)]);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT ${columns} FROM captures c LEFT JOIN users u ON u.id=c.owner_id WHERE c.owner_id=? AND c.client_id=? AND c.local_id=?`, [user.id, clientId, recording.id]);
    return decode(rows[0]);
  },
  async list(user) {
    const scope = captureScope(user);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT ${columns} FROM captures c LEFT JOIN users u ON u.id=c.owner_id WHERE 1=1${scope.sql} ORDER BY c.updated_at DESC,c.id DESC LIMIT 500`, scope.args as string[]);
    return rows.map(decode);
  },
  async get(id) {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT ${columns} FROM captures c LEFT JOIN users u ON u.id=c.owner_id WHERE c.id=?`, [id]);
    return rows[0] ? decode(rows[0]) : null;
  },
  async mutate(id, action) {
    const connection = await pool().getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT * FROM captures WHERE id=? FOR UPDATE", [id]);
      if (!rows[0]) throw new HttpError(404, "采集记录不存在。");
      const row = decode(rows[0]);
      const result = await action(row);
      await connection.execute("UPDATE captures SET body=? WHERE id=?", [JSON.stringify(row.body), id]);
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  },
};

const ID = /^[a-f0-9]{32}$/;
const FILE = /^(?:chunk-[0-9]{8}\.bin|unpaired-rssi\.bin|turntable\.jsonl)$/;
const MAX_PART = 8 * 1024 * 1024;
const LIVE_TTL = 15_000;
const invalid = (message = "采集参数无效。") => new HttpError(400, message);
function object(value: unknown): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
}
function only(value: JsonObject, names: string[]) {
  if (Object.keys(value).some(key => !names.includes(key))) throw invalid("请求含不支持的字段。");
}
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
function bounded(value: unknown, depth = 0, arrayLimit = 2048): void {
  if (depth > 12) throw invalid("采集参数嵌套过深。");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 8192) return;
  if (Array.isArray(value) && value.length <= arrayLimit) { for (const item of value) bounded(item, depth + 1, arrayLimit); return; }
  if (value && typeof value === "object" && Object.keys(value).length <= 128) {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
      bounded(item, depth + 1, arrayLimit);
    }
    return;
  }
  throw invalid(`采集预览包含无效值或数组超过 ${arrayLimit} 项。`);
}
export function validateCaptureRecording(value: unknown, complete = false): JsonObject {
  object(value); bounded(value);
  if (!ID.test(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 180 ||
      !["polytec_ivs500", "simulation"].includes(value.source) || value.unit !== "m/s" ||
      !integer(value.samples) || !["incomplete", "complete", "error"].includes(value.status)) throw invalid("采集记录编号、来源、单位或样本信息无效。");
  if (value.source === "simulation") object(value.simulation);
  if (value.source !== "simulation" && value.simulation) throw invalid("模拟数据不能标记为实测。");
  if (complete && (value.status !== "complete" || value.samples < 1 || value.format !== "BLADEV01/<QidifB" ||
      !Number.isFinite(value.sampleRate) || value.sampleRate <= 0 || !Number.isFinite(value.sampleOrigin) ||
      !integer(value.chunks, 1, 4096) || value.error)) throw invalid("只能上传已完整保存的原始采集记录。");
  const copied = JSON.parse(JSON.stringify(value));
  // Ownership is always derived from the authenticated user, never a manifest.
  for (const key of ["ownerId", "ownerName", "tenant", "clientId", "cloudCaptureId", "captureId", "sourceDirectory", "path"]) delete copied[key];
  return copied;
}
function files(value: unknown): CaptureFile[] {
  if (!Array.isArray(value) || !value.length || value.length > 4096) throw invalid("原始文件清单无效。");
  const names = new Set<string>(); let total = 0;
  const result = value.map(entry => {
    object(entry); only(entry, ["name", "bytes", "sha256"]);
    if (typeof entry.name !== "string" || !FILE.test(entry.name) || names.has(entry.name) ||
        !integer(entry.bytes, 1, 8 * 1024 ** 3) || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw invalid("文件名、大小或 SHA-256 无效。");
    names.add(entry.name); total += entry.bytes;
    return { name: entry.name, bytes: entry.bytes, sha256: entry.sha256 };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (total > 64 * 1024 ** 3) throw new HttpError(413, "单条记录原始文件合计不能超过 64 GB。");
  return result;
}
function validatePreview(waveform: unknown, realtime: unknown) {
  object(waveform);
  const numbers = (value: unknown, nullable = false, limit = 2048) => Array.isArray(value) && value.length <= limit &&
    value.every(item => nullable && item === null || typeof item === "number" && Number.isFinite(item));
  if (!numbers(waveform.values) || (waveform.rssi !== undefined && !numbers(waveform.rssi, true)) ||
      (waveform.overrange !== undefined && (!Array.isArray(waveform.overrange) || waveform.overrange.length > 2048 || waveform.overrange.some((item: unknown) => typeof item !== "boolean"))) ||
      (waveform.unit !== undefined && waveform.unit !== "m/s") ||
      (waveform.values.length && (!Number.isFinite(waveform.sampleRate) || waveform.sampleRate <= 0))) throw invalid("实时波形结构、单位或数值无效。");
  if (waveform.rssiSampleStride !== undefined || waveform.rssiSampleRate !== undefined) {
    const stride = waveform.rssiSampleStride, rate = waveform.rssiSampleRate;
    if (!integer(stride, 1, 100000) || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 ||
        !Number.isFinite(waveform.sampleRate) || waveform.sampleRate <= 0 || rate > waveform.sampleRate ||
        !Number.isFinite(rate * stride) || Math.abs(rate * stride - waveform.sampleRate) > waveform.sampleRate * 1e-9)
      throw invalid("RSSI 采样间隔或采样率无效，或与振动采样率不一致。");
  }
  if (realtime === undefined || realtime === null) return;
  object(realtime);
  if (typeof realtime.available !== "boolean") throw invalid("实时分析状态无效。");
  for (const [field, keys] of [["timeDomain", ["times", "values"]], ["spectrum", ["frequencies", "amplitudes"]], ["spectrogram", ["times", "frequencies"]]] as const) {
    if (realtime[field] === undefined) { if (realtime.available) throw invalid("实时分析结果不完整。"); continue; }
    object(realtime[field]);
    // A 4096-sample real FFT has 2049 bins, including both DC and Nyquist.
    for (const key of keys) if (!numbers(realtime[field][key], false, field === "spectrum" ? 4096 : 2048)) throw invalid("实时分析数组无效。");
  }
  if (realtime.spectrogram && (!Array.isArray(realtime.spectrogram.db) || realtime.spectrogram.db.some((row: unknown) => !numbers(row)))) throw invalid("时频分析数组无效。");
}
export function captureDataRoot() {
  const cwd = process.cwd();
  const root = path.basename(cwd) === "web" && path.basename(path.dirname(cwd)) === "apps" ? path.resolve(cwd, "../..") : cwd;
  const configured = process.env.BLADE_CAPTURE_DATA_DIR;
  if (configured && !path.isAbsolute(configured)) throw new HttpError(503, "采集存储目录必须为绝对路径。");
  return configured || path.join(root, ".data/web-captures");
}
async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); await rename(temporary, file); }
  finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
async function size(file: string) { try { return (await stat(file)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; } }
async function digestFile(file: string) {
  const digest = createHash("sha256");
  try { for await (const block of createReadStream(file, { signal: AbortSignal.timeout(60_000) })) digest.update(block); }
  catch (error) { if ((error as Error).name === "AbortError") throw new HttpError(504, "原始文件校验超时，请重试。"); throw error; }
  return digest.digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as JsonObject)[key])).join(",") + "}";
  return JSON.stringify(value);
}
function planHash(recording: JsonObject, inventory: CaptureFile[]) {
  return createHash("sha256").update(canonical({ recording, files: inventory })).digest("hex");
}
export async function captureBody(request: Request, limit = 512 * 1024) {
  if (Number(request.headers.get("content-length") || 0) > limit) throw new HttpError(413, "请求超过大小上限。");
  const reader = request.body?.getReader();
  if (!reader) throw invalid("请求不能为空。");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async () => {
    const blocks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new HttpError(413, "请求超过大小上限。");
      blocks.push(value);
    }
    return Buffer.concat(blocks);
  })();
  try { return await Promise.race([read, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, "上传请求超时。")), 60_000); })]); }
  finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}

export function createCaptureService({ repository = sqlCaptureRepository, root = captureDataRoot(), now = Date.now,
  worker = rotationWorker }: { repository?: CaptureRepository; root?: string; now?: () => number; worker?: typeof rotationWorker } = {}) {
  const directory = (id: string, section = "") => { if (!ID.test(id)) throw invalid("采集编号无效。"); return path.join(root, id, section); };
  function readable(user: User, row: CaptureRow | null): asserts row is CaptureRow {
    if (!row || !canReadCapture(user, { ownerId: row.owner_id, tenant: row.tenant })) throw new HttpError(404, "采集记录不存在或无权查看。");
  }
  function writable(user: User, row: CaptureRow) {
    requireCaptureWrite(user);
    if (row.owner_id !== user.id || row.tenant !== user.tenant) throw new HttpError(403, "只能上传当前账号自己的采集记录。");
  }
  const summary = (row: CaptureRow) => ({ id: row.id, ownerId: row.owner_id, ownerName: row.owner_name || "", tenant: row.tenant,
    clientId: row.client_id, localId: row.local_id, recording: row.body.recording,
    liveState: row.body.liveState === "acquiring" && (!row.body.lastSeenAt || now() - row.body.lastSeenAt > LIVE_TTL) ? "offline" : row.body.liveState,
    uploadState: row.body.uploadState, receivedBytes: row.body.receivedBytes, totalBytes: row.body.totalBytes,
    lastSeenAt: row.body.lastSeenAt, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.body.error ? { error: row.body.error } : {}) });
  async function get(user: User, id: string) { directory(id); const row = await repository.get(id); readable(user, row); return row; }
  async function offsets(row: CaptureRow) {
    const complete = row.body.uploadState === "complete" || await size(directory(row.id, "complete/manifest.json")) > 0;
    const folder = directory(row.id, complete ? "complete" : "incoming");
    const offsets: Record<string, number> = {}, received: string[] = [];
    for (const file of row.body.files || []) {
      const full = await size(path.join(folder, file.name));
      const amount = full || await size(path.join(folder, file.name + ".part"));
      if (amount > file.bytes) throw new HttpError(409, "暂存文件大小异常，请检查服务器存储。");
      // A crash may leave every byte on disk before SHA verification/rename.
      // Replay the final byte so a resumed sender triggers verification again.
      offsets[file.name] = !full && amount === file.bytes ? amount - 1 : amount;
      if (full === file.bytes) received.push(file.name);
    }
    return { offsets, received };
  }
  async function existingPlanHash(row: CaptureRow) {
    if (row.body.planHash) return row.body.planHash;
    const folder = row.body.uploadState === "complete" ? "complete" : "incoming";
    let plan;
    try { plan = JSON.parse(await readFile(directory(row.id, `${folder}/transfer.json`), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || folder === "complete") throw error;
      plan = JSON.parse(await readFile(directory(row.id, "complete/transfer.json"), "utf8"));
    }
    return planHash(plan.recording, plan.files);
  }
  return {
    async list(user: User) { return { captures: (await repository.list(user)).filter(row => canReadCapture(user, { ownerId: row.owner_id, tenant: row.tenant })).map(summary) }; },
    async create(user: User, input: unknown) {
      requireCaptureWrite(user); object(input); only(input, ["clientId", "recording"]);
      if (typeof input.clientId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.clientId)) throw invalid("客户端编号无效。");
      const recording = validateCaptureRecording(input.recording);
      const row = await repository.create(user, input.clientId, recording); writable(user, row);
      if (row.body.recording.source !== recording.source) throw new HttpError(409, "已登记记录的数据来源不能改变。");
      return { capture: summary(row) };
    },
    async detail(user: User, id: string) {
      const row = await get(user, id);
      let frame = null;
      try { frame = JSON.parse(await readFile(directory(id, "latest.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return { capture: summary(row), frame };
    },
    async live(user: User, id: string, input: unknown) {
      requireCaptureWrite(user); directory(id); object(input); only(input, ["sequence", "sentAt", "recording", "waveform", "realtime", "state"]); bounded(input, 0, 4096);
      if (!integer(input.sequence) || !Number.isFinite(input.sentAt) || !["acquiring", "stopped", "error"].includes(input.state)) throw invalid("实时帧序号、时间或状态无效。");
      const recording = validateCaptureRecording(input.recording); validatePreview(input.waveform, input.realtime);
      return repository.mutate(id, async row => {
        writable(user, row);
        if (recording.id !== row.local_id || recording.source !== row.body.recording.source) throw invalid("实时帧不属于该采集记录。");
        if (input.sequence <= row.body.sequence) return { ok: true, sequence: row.body.sequence };
        if (row.body.uploadState === "complete" && input.state === "acquiring") throw new HttpError(409, "完整上传的记录不能重新进入采集状态。");
        const receivedAt = now();
        await atomicJson(directory(id, "latest.json"), { ...input, recording, receivedAt });
        row.body.sequence = input.sequence; row.body.lastSeenAt = receivedAt; row.body.liveState = input.state;
        if (row.body.uploadState === "pending") row.body.recording = recording;
        return { ok: true, sequence: input.sequence };
      });
    },
    async upload(user: User, id: string, input: unknown) {
      requireCaptureWrite(user); directory(id); object(input); only(input, ["recording", "files"]);
      const recording = validateCaptureRecording(input.recording, true), inventory = files(input.files);
      if (inventory.filter(file => file.name.startsWith("chunk-")).length !== recording.chunks) throw invalid("原始分块数量与记录不符。");
      const telemetry = recording.turntable?.telemetry, telemetryFile = inventory.find(file => file.name === "turntable.jsonl");
      if (telemetry || telemetryFile || (recording.turntable && !recording.pointCycle)) {
        if (!telemetry || telemetry.file !== "turntable.jsonl" || !integer(telemetry.events, 1) ||
            !telemetryFile || telemetry.sha256 !== telemetryFile.sha256) throw invalid("转盘遥测清单、事件数量或摘要与记录不符。");
      }
      return repository.mutate(id, async row => {
        writable(user, row);
        if (recording.id !== row.local_id || recording.source !== row.body.recording.source) throw invalid("上传清单不属于该采集记录。");
        const incomingHash = planHash(recording, inventory);
        // MySQL binary JSON can reorder keys and round a double on decoding.
        // Compare a digest of the original request, never round-tripped metadata.
        if (row.body.files && await existingPlanHash(row) !== incomingHash) throw new HttpError(409, "已经开始上传的记录内容不能改变。");
        row.body.planHash = incomingHash;
        if (!row.body.files) {
          const folder = directory(id, "incoming");
          await atomicJson(path.join(folder, "transfer.json"), { recording, files: inventory });
          await atomicJson(path.join(folder, "manifest.json"), { ...recording, id, sourceLocalId: row.local_id, captureOwnerId: row.owner_id, captureTenant: row.tenant });
          row.body.recording = recording; row.body.files = inventory; row.body.uploadState = "uploading";
          row.body.liveState = "stopped"; row.body.totalBytes = inventory.reduce((sum, file) => sum + file.bytes, 0); delete row.body.error;
        }
        const progress = await offsets(row);
        row.body.receivedBytes = Object.values(progress.offsets).reduce((sum, value) => sum + value, 0);
        return { capture: summary(row), ...progress };
      });
    },
    async chunk(user: User, id: string, name: string, offset: number, bytes: Buffer) {
      requireCaptureWrite(user); directory(id);
      if (!FILE.test(name) || !integer(offset) || !bytes.length || bytes.length > MAX_PART) throw invalid("原始数据分段无效。");
      const staged = await repository.mutate(id, async row => {
        writable(user, row);
        const file = row.body.files?.find(item => item.name === name);
        if (!file) throw new HttpError(409, "请先登记完整上传清单。");
        if (offset + bytes.length > file.bytes) throw invalid("分段超出文件大小。");
        const folder = directory(id, row.body.uploadState === "complete" ? "complete" : "incoming");
        const completed = path.join(folder, name), partial = completed + ".part";
        const finished = await size(completed); let current = finished || await size(partial);
        const previousProgress = !finished && current === file.bytes ? current - 1 : current;
        if (offset > current) throw new HttpError(409, `上传偏移不连续，当前偏移为 ${current}。`);
        if (offset < current) {
          if (offset + bytes.length > current) throw new HttpError(409, "重复上传不能越过已接收范围。");
          const handle = await open(finished ? completed : partial, "r");
          try {
            const previous = Buffer.alloc(bytes.length); const read = await handle.read(previous, 0, previous.length, offset);
            if (read.bytesRead !== bytes.length || !previous.equals(bytes)) throw new HttpError(409, "重复分段与已接收数据不一致。");
          } finally { await handle.close(); }
        } else {
          if (finished || row.body.uploadState === "complete") throw new HttpError(409, "完整原始文件不可修改。");
          const handle = await open(partial, current ? "r+" : "wx", 0o600);
          try { let done = 0; while (done < bytes.length) { const result = await handle.write(bytes, done, bytes.length - done, current + done); if (!result.bytesWritten) throw Error("File write failed"); done += result.bytesWritten; } await handle.sync(); }
          finally { await handle.close(); }
          current += bytes.length;
        }
        const currentProgress = !finished && current === file.bytes ? current - 1 : current;
        row.body.receivedBytes = Math.max(0, row.body.receivedBytes + currentProgress - previousProgress);
        return { current, complete: !!finished,
          verify: !finished && current === file.bytes ? { partial, file, identity: await stat(partial) } : null };
      });
      if (!staged.verify) return { ok: true, nextOffset: staged.current, complete: staged.complete };
      // Hashing an entire raw file can take much longer than writing one part.
      // Release the row lock while hashing; full pending files are immutable.
      const pending = staged.verify;
      let digest: string | undefined;
      try { digest = await digestFile(pending.partial); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const result = await repository.mutate(id, async row => {
        writable(user, row);
        const file = row.body.files?.find(item => item.name === name);
        if (!file || file.sha256 !== pending.file.sha256 || file.bytes !== pending.file.bytes) throw new HttpError(409, "上传清单发生变化，请重新上传。");
        const folder = directory(id, row.body.uploadState === "complete" ? "complete" : "incoming"), completed = path.join(folder, name);
        // A concurrent retry may already have verified and published this file.
        if (await size(completed) === file.bytes) return { ok: true, nextOffset: file.bytes, complete: true };
        let current;
        try { current = await stat(pending.partial); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(409, "暂存文件状态已改变，请重新查询上传进度。"); throw error; }
        if (current.ino !== pending.identity.ino || current.dev !== pending.identity.dev || current.size !== pending.identity.size ||
            current.mtimeMs !== pending.identity.mtimeMs || !digest) throw new HttpError(409, "暂存文件状态已改变，请重新查询上传进度。");
        const valid = digest === file.sha256;
        if (valid) await rename(pending.partial, completed);
        else await unlink(pending.partial);
        row.body.receivedBytes = Math.max(0, row.body.receivedBytes + (valid ? 1 : 1 - file.bytes));
        return { ok: valid, nextOffset: valid ? file.bytes : 0, complete: valid };
      });
      if (!result.ok) throw new HttpError(422, "原始文件 SHA-256 不符，请从偏移 0 重新上传该文件。");
      return result;
    },
    async complete(user: User, id: string) {
      requireCaptureWrite(user); directory(id);
      const snapshot = await get(user, id); writable(user, snapshot);
      if (snapshot.body.uploadState === "complete") return { capture: summary(snapshot) };
      if (!snapshot.body.files) throw new HttpError(409, "尚未登记上传清单。");
      const expectedPlan = await existingPlanHash(snapshot);
      // Completed upload files are immutable. Validate outside the SQL row lock:
      // a long recording must not occupy a database connection for 180 seconds.
      let alreadyPublished = false;
      try { alreadyPublished = (await stat(directory(id, "complete"))).isDirectory(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!alreadyPublished && (await offsets(snapshot)).received.length !== snapshot.body.files.length) throw new HttpError(409, "原始文件尚未全部上传完成。");
      try {
        await worker(user, { action: "capture-validate", captureDirectory: directory(id, alreadyPublished ? "complete" : "incoming") });
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) {
          await repository.mutate(id, async row => {
            writable(user, row);
            if (row.body.uploadState !== "complete" && await existingPlanHash(row) === expectedPlan) { row.body.uploadState = "error"; row.body.error = error.message; }
          });
        }
        throw error;
      }
      return repository.mutate(id, async row => {
        writable(user, row);
        if (row.body.uploadState === "complete") return { capture: summary(row) };
        if (await existingPlanHash(row) !== expectedPlan) throw new HttpError(409, "上传清单发生变化，请重新核验。");
        // A previous process may have finished the atomic rename before SQL committed.
        let finalExists = false;
        try { finalExists = (await stat(directory(id, "complete"))).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const folder = directory(id, finalExists ? "complete" : "incoming");
        if (!finalExists) await rename(folder, directory(id, "complete"));
        row.body.uploadState = "complete"; row.body.receivedBytes = row.body.totalBytes; row.body.liveState = "stopped"; delete row.body.error;
        return { capture: summary(row) };
      });
    },
    async attachment(user: User, id: string, name: string) {
      const row = await get(user, id);
      if (!["manifest.json", "turntable.jsonl"].includes(name)) throw invalid("不支持的采集附件。");
      if (row.body.uploadState !== "complete") throw new HttpError(409, "原始记录尚未完整上传，不能下载附件。");
      if (name === "turntable.jsonl" && !row.body.files?.some(file => file.name === name)) throw new HttpError(404, "此记录没有转盘遥测附件。");
      const file = directory(id, `complete/${name}`), handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw invalid("采集附件无效。");
        return { stream: handle.createReadStream(), filename: `BladeVMS-${id}-${name}`,
          mime: name.endsWith("jsonl") ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8", bytes: metadata.size };
      } catch (error) { await handle.close(); throw error; }
    },
    async prepareAnalysis(user: User, id: string) {
      requireCaptureAnalysis(user); const row = await get(user, id);
      if (row.body.uploadState !== "complete") throw new HttpError(409, "原始记录尚未完整上传，不能用于分析。");
      return worker(user, { action: "capture-import", captureDirectory: directory(id, "complete") });
    },
    async waveform(user: User, id: string, start = 0, end?: number) {
      const row = await get(user, id);
      if (!integer(start) || (end !== undefined && (!integer(end, start + 1) || end > row.body.recording.samples))) throw invalid("波形范围无效。");
      if (row.body.uploadState !== "complete") throw new HttpError(409, "原始记录尚未完整上传，请查看实时预览。");
      return worker(user, { action: "capture-waveform", captureDirectory: directory(id, "complete"), start, ...(end === undefined ? {} : { end }) });
    },
  };
}
