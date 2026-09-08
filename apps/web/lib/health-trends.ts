import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { digest, HttpError, pool, recordScope, unpack, type RecordItem, type User } from "./db";
import { healthConfigArgs, healthConfigQuery, healthConfigView } from "./health";
import { rotationCanonical } from "@blade/ui/rotation-data";
import { addTrendAnnotation, healthBaselineCanonical, healthTrendRecord, healthTrendWorkflow, healthTrendSampleVersion, trendStartDate, withdrawTrendAnnotation } from "@blade/ui/health-trend-data";

function writer(user: User) { if (!["admin", "analyst"].includes(user.role)) throw new HttpError(403, "趋势归档和人工标记需要管理员或分析员权限"); }
function checked<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw new HttpError((error as { status?: number }).status || 400, (error as Error).message); }
}
async function locked(connection: PoolConnection, user: User, kind: string, id: unknown) {
  if (typeof id !== "string" || !id || id.length > 64) throw new HttpError(400, "请选择有效记录");
  const s = recordScope(user, kind);
  const [selected] = await connection.execute("SELECT r.* FROM records r WHERE r.kind=? AND r.id=?" + s.sql + " FOR UPDATE", [kind, id, ...s.args] as string[]);
  const record = (selected as RecordItem[])[0];
  if (!record) throw new HttpError(404, "记录不存在");
  return record;
}
async function log(connection: PoolConnection, user: User, tenant: string, action: string, target: string) {
  await connection.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, tenant, action, target, "成功"]);
}
async function transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool().getConnection();
  try { await connection.beginTransaction(); const result = await fn(connection); await connection.commit(); return result; }
  catch (error) {
    await connection.rollback();
    if (["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes((error as { code?: string }).code || "")) throw new HttpError(409, "趋势记录正被其他操作更新，请重试");
    throw error;
  } finally { connection.release(); }
}
/** Derive an immutable snapshot from authorized stored sources, never client matrices. */
export async function archiveHealthTrend(user: User, input: Record<string, any>) {
  writer(user);
  checked(() => trendStartDate(input.startDate));
  for (const key of ["sourceRevision", "baselineRevision", "configRevision"]) {
    if (typeof input[key] !== "string" || !(key === "configRevision" && input[key] === "missing") && !/^[0-9a-f]{64}$/.test(input[key])) throw new HttpError(400, "归档需要有效的任务、基线与阈值修订");
  }
  return transaction(async connection => {
    const taskRow = await locked(connection, user, "tasks", input.taskId), baselineRow = await locked(connection, user, "baselines", input.baselineId);
    const task = unpack(taskRow), baseline = unpack(baselineRow);
    if (taskRow.tenant !== baselineRow.tenant || task.object !== baseline.object) throw new HttpError(400, "任务与基线须属于同一课题组、同一对象");
    const [thresholdRows] = await connection.execute(healthConfigQuery + " FOR UPDATE", healthConfigArgs(taskRow.tenant));
    const config = healthConfigView((thresholdRows as RecordItem[])[0], taskRow.tenant);
    if (input.sourceRevision !== digest(rotationCanonical(task)) || input.baselineRevision !== digest(healthBaselineCanonical(baseline)) || input.configRevision !== config.revision) throw new HttpError(409, "任务、基线或阈值已变化，请刷新后重新确认归档");
    const id = "ht-" + digest(JSON.stringify([healthTrendSampleVersion, user.id, taskRow.tenant, task.id, baseline.id, input.startDate, input.sourceRevision, input.baselineRevision, input.configRevision])).slice(0, 60);
    const [existing] = await connection.execute("SELECT * FROM records WHERE id=? FOR UPDATE", [id]);
    const old = (existing as RecordItem[])[0];
    if (old) {
      if (old.kind !== "analyses" || old.tenant !== taskRow.tenant || old.created_by !== user.id || old.body.type !== "health-trend") throw new HttpError(409, "归档标识冲突");
      return { record: unpack(old), created: false };
    }
    const body = checked(() => healthTrendRecord(task, baseline, config, input));
    await connection.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'analyses',?,?,?)", [id, taskRow.tenant, JSON.stringify(body), user.id]);
    await log(connection, user, taskRow.tenant, "归档健康演示趋势", id);
    const [saved] = await connection.execute("SELECT * FROM records WHERE id=?", [id]);
    return { record: unpack((saved as RecordItem[])[0]), created: true };
  });
}
export async function annotateHealthTrend(user: User, id: string, input: Record<string, any>, annotationId?: string) {
  writer(user);
  return transaction(async connection => {
    const old = await locked(connection, user, "analyses", id);
    if (old.body.type !== "health-trend" || (old.body.parameters as Record<string, unknown>)?.workflow !== healthTrendWorkflow) throw new HttpError(400, "此记录不是可标记的健康趋势归档");
    const result = checked(() => annotationId === undefined ? addTrendAnnotation(old.body, input, user, new Date().toISOString()) : withdrawTrendAnnotation(old.body, annotationId, input.reason, user, new Date().toISOString()));
    if (result.changed) {
      await connection.execute("UPDATE records SET body=? WHERE id=?", [JSON.stringify(result.record), id]);
      await log(connection, user, old.tenant, annotationId === undefined ? "添加健康趋势人工标记" : "撤回健康趋势人工标记", id + "/" + (annotationId || input.id));
    }
    const [saved] = await connection.execute("SELECT * FROM records WHERE id=?", [id]);
    return unpack((saved as RecordItem[])[0]);
  });
}
