import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
const db = "blade_vms_playground",
  user = "blade_vms_app",
  container = "starlight-mysql";
function sql(query) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "sh",
      "-c",
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N',
    ],
    { input: query, encoding: "utf8" },
  ).trim();
}
if (existsSync("apps/web/.env.local")) {
  console.log("项目环境文件已存在；不覆盖密码、不修改数据库。");
  process.exit(0);
}
if (
  sql(
    `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${db}'`,
  ) !== "0"
)
  throw Error("目标数据库已存在，请检查归属；未作修改。");
if (sql(`SELECT COUNT(*) FROM mysql.user WHERE User='${user}'`) !== "0")
  throw Error("目标用户已存在，请检查归属；未作修改。");
mkdirSync("artifacts", { recursive: true });
const before = execFileSync(
  "docker",
  ["ps", "--format", "{{.ID}} {{.Names}} {{.Status}}"],
  { encoding: "utf8" },
);
writeFileSync("artifacts/docker-before.txt", before);
const schemasBefore = sql("SHOW DATABASES;");
writeFileSync("artifacts/databases-before.txt", schemasBefore);
const password = randomBytes(24).toString("hex");
const adminPassword = randomBytes(12).toString("base64url");
sql(
  `CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'; GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES ON \`${db}\`.* TO '${user}'@'%';`,
);
writeFileSync(
  "apps/web/.env.local",
  `DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_NAME=${db}\nDB_USER=${user}\nDB_PASSWORD=${password}\nBOOTSTRAP_PASSWORD=${adminPassword}\nAPP_ORIGIN=http://127.0.0.1:3210\n`,
  { mode: 0o600 },
);
writeFileSync("artifacts/databases-after.txt", sql("SHOW DATABASES;"));
writeFileSync(
  "artifacts/db-grants.txt",
  sql(`SHOW GRANTS FOR '${user}'@'%';`).replace(/IDENTIFIED BY.*/g, ""),
);
console.log(
  `已创建 ${db} 及专用用户 ${user}。密码仅写入 apps/web/.env.local (0600)。未重启任何容器。`,
);
