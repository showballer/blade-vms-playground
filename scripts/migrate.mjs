import mysql from "mysql2/promise";
import { randomBytes, scryptSync, randomUUID } from "node:crypto";
import { records } from "./seed-data.mjs";
if (
  process.env.DB_NAME !== "blade_vms_playground" ||
  process.env.DB_USER !== "blade_vms_app"
)
  throw Error("仅允许迁移本项目专用库");
const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const tables = [
  `CREATE TABLE IF NOT EXISTS sync_imports (idempotency_key CHAR(64) PRIMARY KEY,user_id VARCHAR(64) NOT NULL,tenant VARCHAR(100) NOT NULL,client_id VARCHAR(64) NOT NULL,local_id VARCHAR(64) NOT NULL,revision CHAR(64) NOT NULL,payload_hash CHAR(64) NOT NULL,response JSON,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX sync_user_tenant(user_id,tenant))`,
  `CREATE TABLE IF NOT EXISTS users (id VARCHAR(64) PRIMARY KEY,username VARCHAR(80) NOT NULL UNIQUE,name VARCHAR(100) NOT NULL,password_hash VARCHAR(255) NOT NULL,role VARCHAR(20) NOT NULL,tenant VARCHAR(100) NOT NULL DEFAULT '新能源A组',active BOOLEAN NOT NULL DEFAULT 1,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS sessions (id VARCHAR(64) PRIMARY KEY,token_hash CHAR(64) NOT NULL UNIQUE,user_id VARCHAR(64) NOT NULL,expires_at DATETIME NOT NULL,kind VARCHAR(20) NOT NULL DEFAULT 'session',name VARCHAR(100),created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS records (id VARCHAR(64) PRIMARY KEY,kind VARCHAR(30) NOT NULL,tenant VARCHAR(100) NOT NULL,body JSON NOT NULL,created_by VARCHAR(64),created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX records_kind_tenant(kind,tenant))`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id VARCHAR(64) PRIMARY KEY,actor_id VARCHAR(64),actor_name VARCHAR(100),tenant VARCHAR(100),action VARCHAR(100) NOT NULL,target VARCHAR(255),result VARCHAR(30) NOT NULL DEFAULT '成功',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX audit_tenant_time(tenant,created_at))`,
];
for (const t of tables) await db.query(t);
function hash(p) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(p, salt, 64).toString("hex");
}
const [users] = await db.query("SELECT id FROM users LIMIT 1");
if (!users.length) {
  if (!process.env.BOOTSTRAP_PASSWORD) throw Error("缺少 BOOTSTRAP_PASSWORD");
  for (const [username, name, role] of [
    ["admin", "系统管理员", "admin"],
    ["zhang", "张工", "analyst"],
    ["li", "李工", "operator"],
    ["guest", "访客", "viewer"],
  ])
    await db.execute(
      "INSERT INTO users (id,username,name,password_hash,role,tenant) VALUES (?,?,?,?,?,?)",
      [
        randomUUID(),
        username,
        name,
        hash(process.env.BOOTSTRAP_PASSWORD),
        role,
        "新能源A组",
      ],
    );
  for (const [kind, items] of Object.entries(records))
    for (const { id, ...body } of items)
      await db.execute(
        "INSERT INTO records (id,kind,tenant,body) VALUES (?,?,?,?)",
        [id, kind, "新能源A组", JSON.stringify(body)],
      );
  await db.execute(
    "INSERT INTO audit_logs(id,actor_name,tenant,action,target) VALUES(?,?,?,?,?)",
    [randomUUID(), "系统", "新能源A组", "初始化", "项目专用库与演示数据"],
  );
  console.log(
    "迁移和初始数据完成。初始账号：admin / zhang / li / guest；密码见本地 BOOTSTRAP_PASSWORD。",
  );
} else console.log("表结构已检查；现有用户和业务数据保留。");
console.log(
  (
    await db.query("SELECT kind,COUNT(*) AS count FROM records GROUP BY kind")
  )[0],
);
await db.end();
