import { randomUUID } from "node:crypto";
import { canReadCapture, HttpError, pool, recordScope, rows, unpack, type RecordItem, type User } from "./db";
import { sqlCaptureRepository } from "./captures";
import { rotationWorker } from "./rotation";

/** An annotation is a human review, never an inferred damage diagnosis. */
export async function healthObservation(user: User, input: Record<string, any>) {
  if (!["admin", "analyst"].includes(user.role)) throw new HttpError(403, "异常标记需要分析权限");
  const { kind, id } = input.reference || {};
  if (!["task", "capture", "import"].includes(kind) || typeof id !== "string" || !id || id.length > 64) throw new HttpError(400, "请选择有效记录");
  if (typeof input.note !== "string" || !input.note.trim() || input.note.length > 2000) throw new HttpError(400, "请填写不超过 2000 字的标记或复核说明");
  if (!["待复核", "已确认", "已关闭"].includes(input.status) || !["注意", "预警", "报警"].includes(input.level)) throw new HttpError(400, "标记状态或级别无效");
  let source: Record<string, any>, tenant = user.tenant;
  if (kind === "task") {
    const scope = recordScope(user, "tasks");
    const [row] = await rows<RecordItem>("SELECT r.* FROM records r WHERE r.kind='tasks' AND r.id=?" + scope.sql, [id, ...scope.args]);
    if (!row) throw new HttpError(404, "任务不存在");
    source = unpack(row); tenant = row.tenant;
  } else if (kind === "capture") {
    const row = await sqlCaptureRepository.get(id);
    if (!row || !canReadCapture(user, { ownerId: row.owner_id, tenant: row.tenant })) throw new HttpError(404, "采集记录不存在");
    source = row.body.recording; tenant = row.tenant;
  } else {
    const result = await rotationWorker(user, { action: "recordings" });
    source = result.recordings.find((r: Record<string, any>) => r.id === id);
    if (!source) throw new HttpError(404, "导入记录不存在");
  }
  const start = input.startSeconds, end = input.endSeconds;
  const hasRange = start != null && start !== "" || end != null && end !== "";
  const count = Array.isArray(source.samples) ? source.samples.length : source.samples;
  if (hasRange && (![start, end, count, source.sampleRate].every(v => typeof v === "number" && Number.isFinite(v)) || source.sampleRate <= 0 || start < 0 || end <= start || end > count / source.sampleRate)) throw new HttpError(400, "标记时间范围必须位于当前记录内，且起点小于终点");
  const recordId = randomUUID(), now = new Date().toISOString();
  const value = { name: "人工复核 · " + String(source.name).slice(0, 140), type: "health-observation", source: "manual",
    ...(kind === "task" ? { taskId: id } : {}),
    parameters: { reference: { kind, id }, ...(kind === "import" ? { importOwnerId: user.id } : {}) },
    result: { note: input.note.trim(), level: input.level, status: input.status, reviewer: user.name, reviewerId: user.id, reviewedAt: now,
      range: hasRange ? { startSeconds: start, endSeconds: end } : null,
      location: { turbine: source.turbine || "", windFarm: source.windFarm || "", point: source.point || "", pointCycle: source.pointCycle || source.sourceMetadata?.pointCycle || null } } };
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'analyses',?,?,?)", [recordId, tenant, JSON.stringify(value), user.id]);
    await connection.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, tenant, "标记健康监测异常", `${kind}:${id}`, "成功"]);
    await connection.commit();
    return { ...value, id: recordId, recordTenant: tenant };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
