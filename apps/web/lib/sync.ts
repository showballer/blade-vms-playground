import { randomUUID } from "node:crypto";
import { digest, HttpError, pool, rows, type User } from "./db";
import { stableJson } from "@blade/ui/sync-data";

export type SyncBundle = {
  clientId: string; localId: string; revision: string;
  task: Record<string, any>; analyses: Record<string, any>[];
};

/** Import one immutable local revision atomically. Retrying never overwrites a server task. */
export async function importLocalRevision(user: User, bundle: SyncBundle) {
  const { clientId, localId, revision, task, analyses } = bundle;
  for (const value of [clientId, localId])
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new HttpError(400, "本机工作区或任务标识无效");
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw new HttpError(400, "回传版本标识无效");
  const key = digest(stableJson([user.id, user.tenant, clientId, localId, revision]));
  const payloadHash = digest(stableJson({ task, analyses }));
  const c = await pool().getConnection();
  try {
    await c.beginTransaction();
    try {
      await c.execute("INSERT INTO sync_imports(idempotency_key,user_id,tenant,client_id,local_id,revision,payload_hash) VALUES(?,?,?,?,?,?,?)", [key, user.id, user.tenant, clientId, localId, revision, payloadHash]);
    } catch (error) {
      await c.rollback();
      if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
      const [previous] = await rows<{ payload_hash: string; response: any }>("SELECT payload_hash,response FROM sync_imports WHERE idempotency_key=? AND user_id=? AND tenant=?", [key, user.id, user.tenant]);
      if (!previous || previous.payload_hash !== payloadHash) throw new HttpError(409, "同一回传版本的内容发生变化，请刷新本机数据后重试");
      const response = typeof previous.response === "string" ? JSON.parse(previous.response) : previous.response;
      const ids: string[] = [response.taskId, ...response.analysisIds];
      const existing = await rows("SELECT id FROM records WHERE tenant=? AND id IN (" + ids.map(() => "?").join(",") + ")", [user.tenant, ...ids]);
      if (existing.length !== ids.length) throw new HttpError(409, "此前回传记录已被删除或恢复覆盖；请保存新的本地修订后回传");
      return { ...response, created: false };
    }
    const taskId = randomUUID(), analysisIds: string[] = [];
    const syncOrigin = { clientId, localId, revision, importedAt: new Date().toISOString() };
    await c.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'tasks',?,?,?)", [taskId, user.tenant, JSON.stringify({ ...task, syncOrigin }), user.id]);
    for (const analysis of analyses) {
      const id = randomUUID(); analysisIds.push(id);
      await c.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'analyses',?,?,?)", [id, user.tenant, JSON.stringify({ ...analysis, taskId, syncOrigin }), user.id]);
    }
    const response = { taskId, analysisIds, revision, created: true };
    await c.execute("UPDATE sync_imports SET response=? WHERE idempotency_key=?", [JSON.stringify(response), key]);
    await c.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, user.tenant, "离线任务回传", task.name.slice(0, 255), "成功"]);
    await c.commit();
    return response;
  } catch (e) { await c.rollback(); throw e; }
  finally { c.release(); }
}
