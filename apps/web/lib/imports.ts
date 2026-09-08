import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { advanceImport, createImportJob, ImportError, importView, normalizeImportRequest, type ImportJob } from "@blade/ui/import-data";
import { stableJson } from "@blade/ui/sync-data";
import { digest, HttpError, list, permission, pool, recordScope, rows, unpack, type RecordItem, type User } from "./db";
const raw = (row: RecordItem): ImportJob => typeof row.body === "string" ? JSON.parse(row.body) : row.body as unknown as ImportJob;
async function record(user: User, kind: string, id: string) {
  const scope = recordScope(user, kind);
  const [row] = await rows<RecordItem>("SELECT r.* FROM records r WHERE r.kind=? AND r.id=?" + scope.sql, [kind, id, ...scope.args]);
  if (!row) throw new HttpError(404, "导入批次不存在或不属于当前账号");
  return row;
}

export async function importEndpoint(user: User, method: string, id?: string, action?: string, body?: any) {
  permission(user, "imports", method !== "GET");
  if (method === "GET" && !action) return { status: 200, data: id ? unpack(await record(user, "imports", id)) : await list(user, "imports") };
  if (method === "GET" && id && action === "pending") return { status: 200, data: raw(await record(user, "imports", id)).items.filter((item) => item.state !== "completed").map((item) => item.input) };
  if (method !== "POST" || (id && action !== "item") || (!id && action)) throw new HttpError(405, "不支持此导入操作");
  const c = await pool().getConnection();
  try {
    await c.beginTransaction();
    if (!id) {
      const request = normalizeImportRequest(body), signature = digest(stableJson(request));
      const replay = (row?: RecordItem) => {
        if (!row || row.kind !== "imports" || row.created_by !== user.id || row.tenant !== user.tenant || raw(row).requestHash !== signature) throw new HttpError(409, "导入标识已被使用且内容不同，请新建导入批次");
        return { status: 200, data: unpack(row) };
      };
      const [existing] = await c.execute<RowDataPacket[]>("SELECT * FROM records WHERE id=?", [request.id]);
      if (existing[0]) { await c.rollback(); return replay(existing[0] as RecordItem); }
      const job = { ...createImportJob(request), requestHash: signature };
      try { await c.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'imports',?,?,?)", [job.id, user.tenant, JSON.stringify(job), user.id]); }
      catch (error) {
        if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
        await c.rollback(); const [row] = await rows<RecordItem>("SELECT * FROM records WHERE id=?", [job.id]); return replay(row);
      }
      await c.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, user.tenant, "登记任务导入", job.filename, "成功"]);
      await c.commit(); return { status: 201, data: importView(job) };
    }
    const scope = recordScope(user, "imports");
    const [found] = await c.execute<RowDataPacket[]>("SELECT r.* FROM records r WHERE r.kind='imports' AND r.id=?" + scope.sql + " FOR UPDATE", [id, ...scope.args] as any[]);
    if (!found[0]) throw new HttpError(404, "导入批次不存在或不属于当前账号");
    const job = raw(found[0] as RecordItem), index = body?.index;
    const transition = advanceImport(job, index, randomUUID());
    if (transition.replayed) {
      const scope = recordScope(user, "tasks");
      const [tasks] = await c.execute<RowDataPacket[]>("SELECT r.id FROM records r WHERE r.kind='tasks' AND r.id=?" + scope.sql, [job.items[index].taskId, ...scope.args] as any[]);
      if (!tasks.length) throw new HttpError(409, "此前导入的任务已删除或不可见；不会静默重建，请按需要新建导入批次");
    } else {
      const { id: taskId, updatedAt: _, ...task } = transition.task!;
      await c.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'tasks',?,?,?)", [taskId, user.tenant, JSON.stringify(task), user.id]);
      await c.execute("UPDATE records SET body=? WHERE id=?", [JSON.stringify(transition.job), id]);
      await c.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, user.tenant, "导入任务", `${job.filename} / ${index + 1} / ${taskId}`, "成功"]);
    }
    await c.commit(); return { status: 200, data: { ...importView(transition.job), replayed: transition.replayed } };
  } catch (error) { await c.rollback(); if (error instanceof ImportError) throw new HttpError(error.status, error.message); throw error; }
  finally { c.release(); }
}
