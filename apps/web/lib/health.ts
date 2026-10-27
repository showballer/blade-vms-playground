import { randomUUID } from "node:crypto";
import { digest, HttpError, pool, recordScope, rows, unpack, type RecordItem, type User } from "./db";
import { thresholdValues, validateThresholds, type HealthConfig } from "@blade/ui/health-data";
import { validateHealthAmplitudeRules, type HealthAmplitudeConfig } from "@blade/ui/health-workspace-data";
export function healthConfigView(record: RecordItem | undefined, tenant: string): HealthConfig {
  if (!record) return { id: null, tenant, revision: "missing", status: "missing", values: null };
  const body = unpack(record), revision = digest(JSON.stringify(body));
  try { return { id: record.id, tenant, revision, status: body.attentionRatio === undefined ? "legacy" : "configured", values: thresholdValues(body) }; }
  catch { return { id: record.id, tenant, revision, status: "invalid", values: null }; }
}
export const healthConfigQuery = "SELECT * FROM records WHERE kind='settings' AND tenant=? AND (id=? OR id='thresholds') ORDER BY (id=?) DESC LIMIT 1";
export function healthConfigArgs(tenant: string) { const key = "health-thresholds-" + digest(tenant).slice(0, 40); return [tenant, key, key]; }
/** Read only the selected baseline's group thresholds, never generic settings. */
export async function healthThresholdEndpoint(user: User, method: string, baselineId: string | null, input?: Record<string, any>) {
  if (!["GET", "PUT"].includes(method)) throw new HttpError(405, "不支持此阈值操作");
  if (method === "PUT" && user.role !== "admin") throw new HttpError(403, "阈值设置需要管理员权限");
  if (!baselineId || baselineId.length > 64) throw new HttpError(400, "请选择有效基线");
  const scope = recordScope(user, "baselines");
  const [baseline] = await rows<RecordItem>("SELECT r.* FROM records r WHERE r.kind='baselines' AND r.id=?" + scope.sql, [baselineId, ...scope.args]);
  if (!baseline) throw new HttpError(404, "基线不存在");
  const tenant = baseline.tenant, key = "health-thresholds-" + digest(tenant).slice(0, 40);
  const query = healthConfigQuery;
  if (method === "GET") return healthConfigView((await rows<RecordItem>(query, [tenant, key, key]))[0], tenant);
  let values;
  try { values = validateThresholds(input?.values || {}); } catch (error) { throw new HttpError(400, (error as Error).message); }
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const [selected] = await connection.execute(query + " FOR UPDATE", [tenant, key, key]);
    const old = (selected as RecordItem[])[0], current = healthConfigView(old, tenant);
    if (input?.revision !== current.revision) throw new HttpError(409, "阈值已被其他操作更新，请刷新后重试");
    const id = old?.id || key, body = { name: "预警阈值", ...values };
    if (old) await connection.execute("UPDATE records SET body=? WHERE id=? AND tenant=?", [JSON.stringify(body), id, tenant]);
    else await connection.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'settings',?,?,?)", [id, tenant, JSON.stringify(body), user.id]);
    await connection.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, tenant, "设置健康监测阈值", id, "成功"]);
    const [saved] = await connection.execute("SELECT * FROM records WHERE id=?", [id]);
    await connection.commit();
    return healthConfigView((saved as RecordItem[])[0], tenant);
  } catch (error) {
    await connection.rollback();
    if (["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK"].includes((error as { code?: string }).code || "")) throw new HttpError(409, "阈值正被其他操作更新，请刷新后重试");
    throw error;
  } finally { connection.release(); }
}

/** Actual measurement rules are isolated from old demonstration thresholds and baselines. */
export async function healthAmplitudeEndpoint(user: User, method: string, input?: Record<string, any>) {
  if (!["GET", "PUT"].includes(method)) throw new HttpError(405, "不支持此预警规则操作");
  if (method === "PUT" && user.role !== "admin") throw new HttpError(403, "预警规则需要管理员权限");
  const key = "health-amplitude-" + digest(user.tenant).slice(0, 40);
  const query = "SELECT * FROM records WHERE kind='settings' AND id=? AND tenant=?";
  const view = (row?: RecordItem): HealthAmplitudeConfig => ({ id: row?.id || null, tenant: user.tenant,
    revision: row ? digest(JSON.stringify(row.body)) : "missing", values: row ? validateHealthAmplitudeRules(unpack(row)) : null });
  if (method === "GET") return view((await rows<RecordItem>(query, [key, user.tenant]))[0]);
  let values;
  try { values = validateHealthAmplitudeRules(input?.values); } catch (error) { throw new HttpError(400, (error as Error).message); }
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const [selected] = await connection.execute(query + " FOR UPDATE", [key, user.tenant]);
    const old = (selected as RecordItem[])[0];
    if (view(old).revision !== input?.revision) throw new HttpError(409, "预警规则已变化，请刷新后重试");
    const body = JSON.stringify({ name: "实测幅值预警规则", ...values });
    if (old) await connection.execute("UPDATE records SET body=? WHERE id=? AND tenant=?", [body, key, user.tenant]);
    else await connection.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'settings',?,?,?)", [key, user.tenant, body, user.id]);
    await connection.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, user.tenant, "设置实测幅值预警规则", key, "成功"]);
    const [saved] = await connection.execute(query, [key, user.tenant]);
    await connection.commit(); return view((saved as RecordItem[])[0]);
  } catch (error) {
    await connection.rollback();
    if (["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK"].includes((error as { code?: string }).code || "")) throw new HttpError(409, "预警规则正被其他操作更新，请刷新后重试");
    throw error;
  } finally { connection.release(); }
}
