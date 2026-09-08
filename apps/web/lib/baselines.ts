import { randomUUID } from "node:crypto";
import { baselineRecordCanonical, baselineValues } from "@blade/ui/baseline-data";
import { digest, HttpError, pool, recordScope, unpack, type RecordItem, type User } from "./db";
function validate(input: Record<string, any>, previous?: Record<string, any>) {
  try { return baselineValues(input, previous); } catch (error) { throw new HttpError(400, (error as Error).message); }
}
/** Generic baseline writes all use one versioned, tenant-scoped transaction. */
export async function baselineEndpoint(user: User, method: string, id: string | undefined, input: Record<string, any>) {
  if (!["admin", "analyst"].includes(user.role)) throw new HttpError(403, "基线维护需要管理员或分析员权限");
  if (!["POST", "PUT", "DELETE"].includes(method)) throw new HttpError(405, "基线操作无效");
  if (method !== "POST" && (typeof input.revision !== "string" || !/^[0-9a-f]{64}$/.test(input.revision))) throw new HttpError(409, "修改或删除基线需要读取时的 revision，请刷新后重试");
  if (method === "DELETE" && input.confirm !== true) throw new HttpError(400, "删除基线需要明确确认；已保存分析和报告快照不会删除");
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    let old: RecordItem | undefined;
    if (method !== "POST") {
      const s = recordScope(user, "baselines"), [selected] = await connection.execute("SELECT r.* FROM records r WHERE r.kind='baselines' AND r.id=?" + s.sql + " FOR UPDATE", [id, ...s.args] as string[]);
      old = (selected as RecordItem[])[0];
      if (!old) throw new HttpError(404, "基线不存在");
      if (input.revision !== digest(baselineRecordCanonical(old.body))) throw new HttpError(409, "基线已被其他操作更新，请刷新后重新确认");
    }
    const key = old?.id || randomUUID(), tenant = old?.tenant || user.tenant;
    if (method === "DELETE") await connection.execute("DELETE FROM records WHERE id=? AND kind='baselines'", [key]);
    else {
      const value = validate(input, old?.body), version = old?.body.version;
      if (old && baselineRecordCanonical(value) === baselineRecordCanonical(Object.fromEntries(Object.entries(old.body).filter(([key]) => key !== "version")))) { await connection.commit(); return { data: unpack(old), status: 200 }; }
      value.version = Number.isSafeInteger(version) && Number(version) >= 1 ? Number(version) + 1 : 1;
      if (old) await connection.execute("UPDATE records SET body=? WHERE id=?", [JSON.stringify(value), key]);
      else await connection.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'baselines',?,?,?)", [key, tenant, JSON.stringify(value), user.id]);
    }
    await connection.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, tenant, method === "POST" ? "登记基线" : method === "DELETE" ? "删除基线" : "维护基线", key, "成功"]);
    const [saved] = await connection.execute("SELECT * FROM records WHERE id=?", [key]);
    await connection.commit();
    return { data: method === "DELETE" ? { ok: true } : unpack((saved as RecordItem[])[0]), status: method === "POST" ? 201 : 200 };
  } catch (error) {
    await connection.rollback();
    if (["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes((error as { code?: string }).code || "")) throw new HttpError(409, "基线正被其他操作更新，请刷新后重试");
    throw error;
  } finally { connection.release(); }
}
