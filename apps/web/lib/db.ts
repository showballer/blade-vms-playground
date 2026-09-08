import mysql, {
  type RowDataPacket,
  type ResultSetHeader,
} from "mysql2/promise";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { batchView, type BatchJob } from "@blade/ui/batch";
import { importView, type ImportJob } from "@blade/ui/import-data";
import { baselineRecordCanonical } from "@blade/ui/baseline-data";
export type User = {
  id: string;
  username: string;
  name: string;
  role: "admin" | "analyst" | "operator" | "viewer";
  tenant: string;
  active: number;
};
const g = globalThis as typeof globalThis & { bladePool?: mysql.Pool };
export function pool() {
  if (process.env.DB_NAME !== "blade_vms_playground")
    throw Error("数据库配置必须指向 blade_vms_playground");
  return (g.bladePool ??= mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 5,
    timezone: "Z",
    dateStrings: true,
  }));
}
type SqlValue = string | number | boolean | null | Date | Buffer;
export async function rows<T = Record<string, unknown>>(
  sql: string,
  args: unknown[] = [],
) {
  return (
    await pool().execute<RowDataPacket[]>(sql, args as SqlValue[])
  )[0] as T[];
}
export async function run(sql: string, args: unknown[] = []) {
  return (await pool().execute<ResultSetHeader>(sql, args as SqlValue[]))[0];
}
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function passwordHash(p: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(p, salt, 64).toString("hex");
}
export function passwordMatch(p: string, h: string) {
  const [salt, hex] = h.split(":");
  if (!hex) return false;
  const actual = scryptSync(p, salt, 64),
    expected = Buffer.from(hex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function audit(
  user: User,
  action: string,
  target: string,
  result = "成功",
) {
  await run(
    "INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)",
    [
      randomUUID(),
      user.id,
      user.name,
      user.tenant,
      action,
      target.slice(0, 255),
      result,
    ],
  );
}
export function tokenFrom(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return (
    req.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("blade_session="))
      ?.slice(14) || ""
  );
}
export async function auth(req: Request) {
  const token = tokenFrom(req);
  if (!token) throw new HttpError(401, "请先登录");
  const [user] = await rows<User>(
    "SELECT u.id,u.username,u.name,u.role,u.tenant,u.active FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.active=1",
    [digest(token)],
  );
  if (!user) throw new HttpError(401, "会话已失效，请重新登录");
  return user;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function scope(user: User) {
  return user.role === "admin"
    ? { sql: "", args: [] as unknown[] }
    : { sql: " AND tenant=?", args: [user.tenant] as unknown[] };
}
/** Apply the same row policy to lists, single records, exports and bootstrap. */
export function recordScope(user: User, kind: string) {
  if (kind === "imports") return { sql: " AND r.tenant=? AND r.created_by=?", args: [user.tenant, user.id] as unknown[] };
  if (user.role === "admin") return { sql: "", args: [] as unknown[] };
  const result = { sql: " AND r.tenant=?", args: [user.tenant] as unknown[] };
  if (kind === "batches") { result.sql += " AND r.created_by=?"; result.args.push(user.id); }
  if (user.role === "operator") {
    if (kind === "tasks") {
      result.sql += " AND r.created_by=?";
      result.args.push(user.id);
    } else if (["analyses", "reports", "alerts"].includes(kind)) {
      // A cross-owner comparison (including a report snapshot of it) must not
      // reveal a colleague's waveform through the primary task owner's access.
      result.sql += " AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.body,'$.operatorRestricted')),'false') <> 'true'";
      result.sql += " AND EXISTS (SELECT 1 FROM records t WHERE t.kind='tasks' AND t.tenant=r.tenant AND t.created_by=? AND t.id=JSON_UNQUOTE(JSON_EXTRACT(r.body,'$.taskId')))";
      result.args.push(user.id);
    }
  }
  return result;
}
export const kinds = [
  "tasks",
  "alerts",
  "baselines",
  "models",
  "settings",
  "templates",
  "reports",
  "analyses",
  "backups",
  "batches",
  "imports",
] as const;
export function permission(user: User, kind: string, write = false) {
  if (user.role === "admin") return;
  if (
    ["users", "logs", "backups", "tokens", "settings", "models"].includes(kind)
  )
    throw new HttpError(403, "此操作需要管理员权限");
  if (!write) return;
  if (user.role === "viewer") throw new HttpError(403, "访客仅有查看权限");
  if (user.role === "operator" && !["tasks", "analyses", "batches", "imports"].includes(kind))
    throw new HttpError(403, "此操作需要分析员权限");
}
export type RecordItem = {
  id: string;
  kind: string;
  tenant: string;
  body: Record<string, unknown>;
  updated_at: string;
  created_by?: string;
};
export function unpack(r: RecordItem) {
  const body = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
  return {
    ...(r.kind === "batches" ? batchView(body as BatchJob) : r.kind === "imports" ? importView(body as ImportJob) : body),
    id: r.id,
    updatedAt: r.updated_at,
    ownerId: r.created_by || null,
    recordTenant: r.tenant,
    ...(r.kind === "baselines" ? { revision: digest(baselineRecordCanonical(body)) } : {}),
  };
}
export async function list(user: User, kind: string) {
  const s = recordScope(user, kind);
  return (
    await rows<RecordItem>(
      "SELECT r.* FROM records r WHERE r.kind=?" +
        s.sql +
        " ORDER BY r.created_at DESC LIMIT 1000",
      [kind, ...s.args],
    )
  ).map(unpack);
}
