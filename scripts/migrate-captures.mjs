// Explicit schema-only migration. Never creates accounts or rewrites recordings.
import mysql from "mysql2/promise";
if (process.env.DB_NAME !== "blade_vms_playground" || process.env.DB_USER !== "blade_vms_app") throw Error("仅允许迁移本项目专用库");
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
try {
  await db.query(`CREATE TABLE IF NOT EXISTS captures (
    id CHAR(32) PRIMARY KEY, owner_id VARCHAR(64) NOT NULL, tenant VARCHAR(100) NOT NULL,
    client_id VARCHAR(64) NOT NULL, local_id CHAR(32) NOT NULL, body JSON NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY capture_owner_client_local (owner_id,client_id,local_id),
    INDEX capture_tenant_updated (tenant,updated_at), INDEX capture_owner_updated (owner_id,updated_at)
  )`);
  console.log("采集记录表结构已检查；现有账号、记录和文件均保留。");
} finally { await db.end(); }
