import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";

assert.equal(process.env.DB_NAME, "blade_vms_playground", "Only the isolated project schema may be tested");
const base = "http://127.0.0.1:3210/api/v1/";
const tag = "qa_admin_contract_" + randomUUID().replaceAll("-", "");
const password = randomBytes(24).toString("base64url");
const results = [];
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
let root;
async function call(path, method = "GET", data, token = root) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}) }, body: data !== undefined ? JSON.stringify(data) : undefined });
  return { status: response.status, body: await response.json() };
}
async function check(name, fn) {
  try { await fn(); results.push({ name, result: "pass" }); console.log("PASS " + name); }
  catch (error) { results.push({ name, result: "fail", message: error.message }); console.error("FAIL " + name + ": " + error.message); }
}
function user(suffix, extra = {}) { return { username: tag + suffix, name: "QA 管理契约 " + suffix, role: "viewer", tenant: tag, password, ...extra }; }
async function userRow(username) { const [rows] = await db.execute("SELECT id,active FROM users WHERE username=? AND tenant=?", [username, tag]); return rows[0]; }
try {
  const login = await call("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD }, null);
  assert.equal(login.status, 200); root = login.body.token;
  for (const state of [false, true, undefined]) {
    await check("创建用户保留启用状态 " + String(state), async () => {
      const draft = user("_" + String(state), state === undefined ? {} : { active: state });
      assert.equal((await call("users", "POST", draft)).status, 201);
      const stored = await userRow(draft.username);
      assert.equal(Number(stored.active), state === false ? 0 : 1);
      const session = await call("session", "POST", { username: draft.username, password }, null);
      assert.equal(session.status, state === false ? 401 : 200);
    });
  }
  for (const active of ["false", 0, null]) {
    await check("拒绝非布尔启用状态 " + JSON.stringify(active), async () => {
      const draft = user("_invalid_" + String(active), { active });
      assert.equal((await call("users", "POST", draft)).status, 400);
      assert.equal(await userRow(draft.username), undefined, "Invalid request must not create a user");
    });
  }
  const disabled = await userRow(tag + "_false");
  await check("停用账号经管理员启用后才能登录", async () => {
    assert.ok(disabled);
    assert.equal((await call("users/" + disabled.id, "PUT", user("_false", { active: true }))).status, 200);
    const login = await call("session", "POST", { username: tag + "_false", password }, null);
    assert.equal(login.status, 200);
    assert.equal((await call("users/" + disabled.id, "PUT", user("_false", { active: false }))).status, 200);
    assert.equal((await call("bootstrap", "GET", undefined, login.body.token)).status, 401, "Disabling revokes existing sessions");
    assert.equal((await call("session", "POST", { username: tag + "_false", password }, null)).status, 401);
  });
  // Use a separate admin to keep all API tokens and potential invalid-route
  // writes within this test tenant. Never revoke the user's existing tokens.
  const adminDraft = user("_admin", { role: "admin", active: true });
  assert.equal((await call("users", "POST", adminDraft)).status, 201);
  const adminLogin = await call("session", "POST", { username: adminDraft.username, password }, null);
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.body.token;
  const malformed = [
    ["users/unexpected", "GET"], ["users/unexpected", "POST"],
    ["users", "PUT"], ["users/unexpected/nested", "PUT"], ["users/unexpected", "DELETE"],
    ["tokens/unexpected", "GET"], ["tokens/unexpected", "POST"],
    ["tokens", "DELETE"], ["tokens/unexpected/nested", "DELETE"], ["tokens/unexpected", "PUT"],
  ];
  for (let i = 0; i < malformed.length; i++) {
    const [path, method] = malformed[i];
    await check("管理接口拒绝非法方法/路径 " + method + " " + path, async () => {
      const data = method === "GET" ? undefined : path.startsWith("users") ? user("_malformed_" + i, { active: true }) : { name: tag + " token " + i };
      const before = (await call("tokens", "GET", undefined, adminToken)).body.length;
      assert.equal((await call(path, method, data, adminToken)).status, 405);
      assert.equal((await call("tokens", "GET", undefined, adminToken)).body.length, before);
      assert.equal(await userRow(tag + "_malformed_" + i), undefined);
    });
  }
  await check("管理员本人令牌创建、读取、撤销及失效", async () => {
    const created = await call("tokens", "POST", { name: tag + " own token" }, adminToken);
    assert.equal(created.status, 201);
    assert.equal((await call("bootstrap", "GET", undefined, created.body.token)).status, 200);
    const list = await call("tokens", "GET", undefined, adminToken);
    const item = list.body.find(row => row.name === tag + " own token");
    assert.ok(item); assert.equal(item.token, undefined, "List must never reveal token plaintext");
    assert.equal((await call("tokens/" + item.id, "DELETE", undefined, adminToken)).status, 200);
    assert.equal((await call("bootstrap", "GET", undefined, created.body.token)).status, 401);
  });
  for (const role of ["analyst", "operator", "viewer"]) {
    const draft = user("_role_" + role, { role, active: true });
    assert.equal((await call("users", "POST", draft)).status, 201);
    const login = await call("session", "POST", { username: draft.username, password }, null);
    assert.equal(login.status, 200);
    await check(role + " 不能管理用户或令牌，初始化不泄露设置/模型", async () => {
      for (const [path, method, body] of [["users", "GET"], ["users", "POST", user("_forbidden_" + role)], ["tokens", "GET"], ["tokens", "POST", { name: "forbidden" }]]) assert.equal((await call(path, method, body, login.body.token)).status, 403);
      const bootstrap = await call("bootstrap", "GET", undefined, login.body.token);
      assert.equal(bootstrap.status, 200);
      assert.deepEqual(bootstrap.body.models, []); assert.deepEqual(bootstrap.body.settings, []);
      assert.equal(await userRow(tag + "_forbidden_" + role), undefined);
    });
  }
} finally {
  // The exact random tenant and account prefix resolve all test-created users,
  // including a user accidentally created by the bug being reproduced.
  const [users] = await db.execute("SELECT id,username FROM users WHERE tenant=?", [tag]);
  for (const user of users) {
    assert.ok(user.username.startsWith(tag));
    await db.execute("DELETE FROM sessions WHERE user_id=?", [user.id]);
    await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [user.id, tag]);
  }
  if (root) await call("session", "DELETE");
  await db.end();
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/admin-contract-results.json", JSON.stringify({ at: new Date().toISOString(), results, cleanedUsers: users.length, auditRetained: true }, null, 2));
}
if (results.some(result => result.result === "fail")) process.exitCode = 1;
