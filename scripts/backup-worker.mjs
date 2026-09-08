import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// The tenant override is for isolated integration tests, not an HTTP endpoint.
export async function runBackupOnce({ tenant, now = new Date() } = {}) {
  if (process.env.DB_NAME !== "blade_vms_playground")
    throw Error("仅允许操作项目库");
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const completed = [];
  try {
    const [configs] = await db.execute(
      "SELECT id FROM records WHERE kind='settings' AND JSON_EXTRACT(body,'$.enabled')=true" +
        (tenant ? " AND tenant=?" : ""),
      tenant ? [tenant] : [],
    );
    const today = now.toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(now),
    );
    for (const item of configs) {
      await db.beginTransaction();
      try {
        // Lock the schedule so two workers cannot create the same daily backup.
        const [rows] = await db.execute(
          "SELECT * FROM records WHERE id=? FOR UPDATE",
          [item.id],
        );
        const row = rows[0];
        const config =
          row &&
          (typeof row.body === "string" ? JSON.parse(row.body) : row.body);
        if (
          !config?.enabled ||
          !Number.isInteger(config.hour) ||
          hour < config.hour ||
          config.lastRun === today
        ) {
          await db.rollback();
          continue;
        }
        const [snapshot] = await db.execute(
          "SELECT * FROM records WHERE tenant=? AND kind<>'backups'",
          [row.tenant],
        );
        const id = randomUUID();
        await db.execute(
          "INSERT INTO records(id,kind,tenant,body) VALUES(?,'backups',?,?)",
          [
            id,
            row.tenant,
            JSON.stringify({
              name: "自动业务备份 " + now.toISOString(),
              count: snapshot.length,
              snapshot,
            }),
          ],
        );
        await db.execute("UPDATE records SET body=? WHERE id=?", [
          JSON.stringify({ ...config, lastRun: today }),
          row.id,
        ]);
        await db.execute(
          "INSERT INTO audit_logs(id,actor_name,tenant,action,target) VALUES(?,?,?,?,?)",
          [randomUUID(), "备份 Worker", row.tenant, "自动业务备份", id],
        );
        await db.commit();
        completed.push({ id, tenant: row.tenant, count: snapshot.length });
      } catch (e) {
        await db.rollback();
        throw e;
      }
    }
    return completed;
  } finally {
    await db.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const backup of await runBackupOnce())
        console.log("自动备份完成：" + backup.tenant);
    } catch (e) {
      console.error("备份任务失败：" + e.message);
      if (process.argv.includes("--once")) process.exitCode = 1;
    } finally {
      running = false;
    }
  };
  await tick();
  if (!process.argv.includes("--once")) {
    const timer = setInterval(tick, 60000);
    console.log("业务备份 Worker 已启动，每分钟检查北京时间计划。");
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => {
        clearInterval(timer);
        process.exit(0);
      });
  }
}
