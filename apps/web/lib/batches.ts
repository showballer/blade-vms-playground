import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { advanceBatch, BatchError, batchView, createBatchJob, normalizeBatchRequest, setBatchPaused, type BatchJob, type BatchStepKey } from "@blade/ui/batch";
import { stableJson } from "@blade/ui/sync-data";
import { digest, HttpError, list, permission, pool, recordScope, rows, unpack, type RecordItem, type User } from "./db";
const raw = (row: RecordItem): BatchJob => typeof row.body === "string" ? JSON.parse(row.body) : row.body as unknown as BatchJob;

export async function batchEndpoint(user: User, method: string, id?: string, action?: string, body?: any) {
  permission(user, "batches", method !== "GET");
  if (method === "GET" && !action) {
    if (!id) return { status: 200, data: await list(user, "batches") };
    const scope = recordScope(user, "batches");
    const [row] = await rows<RecordItem>("SELECT r.* FROM records r WHERE r.kind='batches' AND r.id=?" + scope.sql, [id, ...scope.args]);
    if (!row) throw new HttpError(404, "批次不存在或不可见");
    return { status: 200, data: unpack(row) };
  }
  if (method !== "POST" || (id && !["step", "pause", "resume"].includes(action || "")) || (!id && action)) throw new HttpError(405, "不支持此批次操作");
  const c = await pool().getConnection();
  try {
    await c.beginTransaction();
    if (!id) {
      const request = normalizeBatchRequest(body), signature = digest(stableJson(request));
      const [existing] = await c.execute<RowDataPacket[]>("SELECT * FROM records WHERE id=?", [request.id]);
      const replay = (row: any) => {
        if (!row || row.kind !== "batches" || row.created_by !== user.id || row.tenant !== user.tenant || raw(row).requestHash !== signature) throw new HttpError(409, "批次标识已使用，请重新创建批次");
        return { status: 200, data: unpack(row) };
      };
      if (existing[0]) { await c.rollback(); return replay(existing[0]); }
      const scope = recordScope(user, "tasks");
      const tasks: Record<string, any>[] = [];
      for (const taskId of request.taskIds) {
        const [found] = await c.execute<RowDataPacket[]>("SELECT r.* FROM records r WHERE r.kind='tasks' AND r.id=?" + scope.sql, [taskId, ...scope.args] as any[]);
        if (!found[0]) throw new HttpError(404, "所选任务不存在或不可见");
        tasks.push({ ...unpack(found[0] as RecordItem), _batchTenant: found[0].tenant });
      }
      const job = { ...createBatchJob(request, tasks), requestHash: signature };
      try {
        await c.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'batches',?,?,?)", [job.id, user.tenant, JSON.stringify(job), user.id]);
      } catch (e) {
        if ((e as { code?: string }).code !== "ER_DUP_ENTRY") throw e;
        await c.rollback();
        const [row] = await rows<RecordItem>("SELECT * FROM records WHERE id=?", [job.id]);
        return replay(row);
      }
      await c.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, user.tenant, "创建批处理", job.name, "成功"]);
      await c.commit();
      return { status: 201, data: batchView(job) };
    }
    const scope = recordScope(user, "batches");
    const [found] = await c.execute<RowDataPacket[]>("SELECT r.* FROM records r WHERE r.kind='batches' AND r.id=?" + scope.sql + " FOR UPDATE", [id, ...scope.args] as any[]);
    if (!found[0]) throw new HttpError(404, "批次不存在或不可见");
    let job = raw(found[0] as RecordItem);
    let replayed = false;
    if (action === "pause" || action === "resume") job = setBatchPaused(job, action === "pause");
    else {
      if (!body || typeof body.taskId !== "string" || typeof body.step !== "string") throw new HttpError(400, "请选择批次中的任务及步骤");
      const item = job.items.find((item) => item.taskId === body.taskId);
      const oldStep = item?.steps.find((step) => step.key === body.step);
      if (oldStep?.state === "completed") {
        const [records] = await c.execute<RowDataPacket[]>("SELECT id FROM records WHERE id=? AND kind='analyses'", [oldStep.analysisId || ""]);
        if (!records.length) throw new HttpError(409, "此步骤结果已被删除，请新建批次；不会静默重建历史结果");
      }
      const taskScope = recordScope(user, "tasks");
      const [tasks] = await c.execute<RowDataPacket[]>("SELECT r.id FROM records r WHERE r.kind='tasks' AND r.id=?" + taskScope.sql, [body.taskId, ...taskScope.args] as any[]);
      const transition = advanceBatch(job, body.taskId, body.step as BatchStepKey, randomUUID(), tasks.length ? undefined : "原任务已删除或不可见，未执行此步骤");
      job = transition.job; replayed = transition.replayed;
      if (transition.analysis) {
        const { id: analysisId, ...analysis } = transition.analysis;
        await c.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'analyses',?,?,?)", [analysisId, item!.sourceTenant || found[0].tenant, JSON.stringify(analysis), user.id]);
      }
    }
    if (!replayed) {
      await c.execute("UPDATE records SET body=? WHERE id=?", [JSON.stringify(job), id]);
      await c.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, found[0].tenant, "批处理 " + action, job.name, action === "step" && job.items.find((item) => item.taskId === body.taskId)?.steps.find((step) => step.key === body.step)?.state === "failed" ? "失败" : "成功"]);
    }
    await c.commit();
    return { status: 200, data: { ...batchView(job), replayed } };
  } catch (e) {
    await c.rollback();
    if (e instanceof BatchError) throw new HttpError(e.status, e.message);
    throw e;
  } finally { c.release(); }
}
