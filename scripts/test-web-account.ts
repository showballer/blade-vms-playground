/** Run against the local Web server. Creates only uniquely named temporary accounts and removes them. */
import { randomBytes, randomUUID } from "node:crypto";
import { changeAccountPassword, createManagedUser, deleteManagedUser, issueAccountToken, loginAccount, resetAccountPassword } from "../apps/web/lib/account";
import { digest, HttpError, passwordHash, passwordMatch, pool, type User } from "../apps/web/lib/db";
import type { RowDataPacket } from "mysql2/promise";

const base = process.env.ACCOUNT_TEST_ORIGIN || "http://127.0.0.1:3210";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error("Account tests require a local Web origin");
const tenant = `qa-account-${randomUUID()}`;
const users: User[] = [], checks: string[] = [], temporaryRecords: string[] = [];
const secret = () => randomBytes(24).toString("base64url");
function check(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
function passed(message: string) { checks.push(message); }
async function request(path: string, method = "GET", token = "", input?: unknown, origin = base) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), origin, ...(input === undefined ? {} : { "content-type": "application/json" }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") || "" };
}
async function status(path: string, expected: number, method = "GET", token = "", input?: unknown, origin = base) {
  const result = await request(path, method, token, input, origin);
  check(result.status === expected, `${method} ${path.replace(/[a-f0-9-]{36}/g, "[temporary-user]")} expected ${expected}, received ${result.status}`);
  return result;
}
async function fixture(role: User["role"], password: string) {
  const user: User = { id: randomUUID(), username: `qa_${randomUUID()}`, name: "Temporary credential test", role, tenant, active: 1 };
  users.push(user);
  await pool().execute("INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,?)", [user.id, user.username, user.name, passwordHash(password), role, tenant, 1]);
  return user;
}
async function login(user: User, password: string) {
  const result = await status("session", 200, "POST", "", { username: user.username, password });
  check(typeof result.data.token === "string", "Login must return a token");
  check(Object.keys(result.data.user).sort().join(",") === "active,id,name,role,tenant,username", "Login must not expose password hashes or internal fields");
  return result.data.token as string;
}
async function rejected(operation: Promise<unknown>, expected: number, label: string) {
  let rejected = false;
  try { await operation; } catch (error) { rejected = error instanceof HttpError && error.status === expected; }
  check(rejected, label); passed(label);
}
async function main() {
  const adminPassword = secret(), initial = secret();
  const admin = await fixture("admin", adminPassword), member = await fixture("analyst", initial);
  let adminToken = await login(admin, adminPassword), memberToken = await login(member, initial);
  const secondMemberToken = await login(member, initial);
  await status("account/password", 401, "POST", "", { currentPassword: initial, newPassword: secret() });
  await status("session/extra", 405, "POST", "", { username: member.username, password: initial });
  await status("session/extra", 405, "GET", memberToken);
  passed("Authentication and exact session path enforcement");

  await status("account/password", 403, "POST", memberToken, { currentPassword: initial, newPassword: secret() }, "https://untrusted.invalid");
  await status("account/password", 400, "POST", memberToken, { currentPassword: initial, newPassword: secret(), userId: admin.id });
  await status(`users/${admin.id}/password`, 403, "POST", memberToken, { newPassword: secret() });
  await status(`users/${admin.id}`, 403, "PUT", memberToken, { name: admin.name, tenant, role: "admin", active: true, password: secret() });
  passed("Origin, self-only change, and administrator reset authorization");

  await status("account/password", 400, "POST", memberToken, { currentPassword: secret(), newPassword: secret() });
  await status("session", 200, "GET", memberToken);
  await login(member, initial);
  passed("Wrong current password leaves credentials and sessions intact");
  for (const password of ["x".repeat(11), "x".repeat(129)]) {
    await status("account/password", 400, "POST", memberToken, { currentPassword: initial, newPassword: password });
    await status(`users/${member.id}/password`, 400, "POST", adminToken, { newPassword: password });
    await status("users", 400, "POST", adminToken, { username: `qa_${randomUUID()}`, name: member.name, tenant, role: "viewer", password });
  }
  passed("Password policy enforced for self change, administrator reset, and creation");

  const createdPassword = secret(), created = await status("users", 201, "POST", adminToken, { username: `qa_${randomUUID()}`, name: member.name, tenant, role: "viewer", password: createdPassword });
  check(typeof created.data.id === "string", "User creation must return ID");
  const [createdRows] = await pool().execute<RowDataPacket[]>("SELECT id,username,name,role,tenant,active FROM users WHERE id=? AND tenant=?", [created.data.id, tenant]);
  users.push(createdRows[0] as User);
  await login(users.at(-1)!, createdPassword);
  passed("Valid password creates a usable account");

  // Legacy short passwords remain accepted, but whitespace is always significant.
  const legacyPassword = randomBytes(4).toString("hex"), legacy = await fixture("viewer", legacyPassword);
  await login(legacy, legacyPassword);
  await status("session", 401, "POST", "", { username: legacy.username, password: `${legacyPassword} ` });
  const exactPassword = ` ${secret()} `, exact = await fixture("viewer", exactPassword);
  await login(exact, exactPassword);
  await status("session", 401, "POST", "", { username: exact.username, password: exactPassword.trim() });
  passed("Legacy login compatibility with exact untrimmed password matching");

  const changedPassword = secret();
  const changed = await status("account/password", 200, "POST", memberToken, { currentPassword: initial, newPassword: changedPassword });
  check(changed.data.reauthenticate === true && /blade_session=;/.test(changed.cookie), "Self change must request reauthentication and clear cookie");
  await status("session", 401, "GET", memberToken); await status("session", 401, "GET", secondMemberToken);
  await status("session", 401, "POST", "", { username: member.username, password: initial });
  memberToken = await login(member, changedPassword);
  passed("Self password change revokes every existing session and old password");

  const resetPassword = secret();
  await status(`users/${member.id}/password`, 200, "POST", adminToken, { newPassword: resetPassword });
  await status("session", 401, "GET", memberToken);
  await status("session", 401, "POST", "", { username: member.username, password: changedPassword });
  memberToken = await login(member, resetPassword);
  passed("Administrator reset revokes target sessions and requires new password");

  const apiToken = (await status("tokens", 201, "POST", adminToken, { name: "Temporary account regression" })).data.token as string;
  const secondAdminToken = await login(admin, adminPassword), ownResetPassword = secret();
  const ownReset = await status(`users/${admin.id}/password`, 200, "POST", adminToken, { newPassword: ownResetPassword });
  check(ownReset.data.reauthenticate === true, "Administrator self reset must request reauthentication");
  for (const token of [adminToken, secondAdminToken, apiToken]) await status("session", 401, "GET", token);
  adminToken = await login(admin, ownResetPassword);
  passed("Administrator self reset revokes own sessions and API tokens");

  const putPassword = secret(), oldAdminToken = adminToken;
  const edited = await status(`users/${admin.id}`, 200, "PUT", adminToken, { name: admin.name, tenant, role: "admin", active: true, password: putPassword });
  check(edited.data.reauthenticate === true, "Legacy PUT self reset must request reauthentication");
  await status("session", 401, "GET", oldAdminToken); adminToken = await login(admin, putPassword);
  passed("Existing user PUT reset no longer preserves administrator's old token");
  await status(`users/${member.id}`, 200, "PUT", adminToken, { name: member.name, tenant, role: "viewer", active: true });
  await status("session", 401, "GET", memberToken); memberToken = await login(member, resetPassword);
  await status(`users/${member.id}`, 200, "PUT", adminToken, { name: member.name, tenant, role: "viewer", active: false });
  await status("session", 401, "GET", memberToken);
  await status("session", 401, "POST", "", { username: member.username, password: resetPassword });
  passed("Role changes and disabled accounts preserve session invalidation");

  // Simulate requests that passed route authentication before another reset revoked their token.
  const stalePassword = secret(), staleAdmin = await fixture("admin", stalePassword), stale = await loginAccount(staleAdmin.username, stalePassword);
  await pool().execute("DELETE FROM sessions WHERE token_hash=?", [digest(stale.token)]);
  await rejected(resetAccountPassword(stale.user, stale.token, legacy.id, secret()), 401, "Revoked in-flight administrator cannot reset another account");
  await rejected(changeAccountPassword(stale.user, stale.token, stalePassword, secret()), 401, "Revoked in-flight self change cannot execute");
  await rejected(issueAccountToken(stale.user, stale.token, "Temporary stale token check"), 401, "Revoked in-flight session cannot mint API tokens");
  await rejected(createManagedUser(stale.user, stale.token, { username: `qa_${randomUUID()}`, name: staleAdmin.name, role: "admin", tenant, active: true, password: secret() }), 401, "Revoked in-flight administrator cannot create another account");

  const racePassword = secret(), racer = await fixture("analyst", racePassword), raceSession = await loginAccount(racer.username, racePassword);
  const races = await Promise.allSettled([
    changeAccountPassword(raceSession.user, raceSession.token, racePassword, secret()),
    changeAccountPassword(raceSession.user, raceSession.token, racePassword, secret()),
  ]);
  check(races.filter(result => result.status === "fulfilled").length === 1, "Exactly one concurrent password change must succeed");
  check(races.some(result => result.status === "rejected" && result.reason instanceof HttpError && result.reason.status === 401), "The concurrent stale session must be rejected");
  passed("Concurrent changes serialize and cannot reuse the revoked session");

  const lockPassword = secret(), locked = await fixture("viewer", lockPassword), blocker = await pool().getConnection();
  let queuedLogin: Promise<unknown> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.execute("SELECT id FROM users WHERE id=? FOR UPDATE", [locked.id]);
    await blocker.execute("UPDATE users SET password_hash=? WHERE id=?", [passwordHash(secret()), locked.id]);
    queuedLogin = rejected(loginAccount(locked.username, lockPassword), 401, "Login queued behind a password update cannot authenticate the old password");
    await blocker.commit();
  } finally { await blocker.rollback(); blocker.release(); }
  await queuedLogin;

  // Inject an audit failure only into this process's dedicated connection; prove the real DB transaction rolls back.
  const rollbackPassword = secret(), rollbackUser = await fixture("analyst", rollbackPassword), rollbackSession = await loginAccount(rollbackUser.username, rollbackPassword);
  const db = pool(), originalGetConnection = db.getConnection;
  db.getConnection = async function () {
    const connection = await originalGetConnection.call(db), execute = connection.execute;
    connection.execute = (async function (sql: unknown, ...args: unknown[]) {
      if (typeof sql === "string" && sql.startsWith("INSERT INTO audit_logs")) throw new HttpError(503, "Injected test audit failure");
      return (execute as Function).call(connection, sql, ...args);
    }) as typeof connection.execute;
    const release = connection.release;
    connection.release = () => { connection.execute = execute; connection.release = release; release.call(connection); };
    return connection;
  };
  try { await rejected(changeAccountPassword(rollbackSession.user, rollbackSession.token, rollbackPassword, secret()), 503, "Audit error rolls back the credential operation"); }
  finally { db.getConnection = originalGetConnection; }
  const [remaining] = await pool().execute<RowDataPacket[]>("SELECT u.password_hash, s.id AS session_id FROM users u LEFT JOIN sessions s ON s.user_id=u.id AND s.token_hash=? WHERE u.id=?", [digest(rollbackSession.token), rollbackUser.id]);
  check(remaining[0]?.session_id && passwordMatch(rollbackPassword, remaining[0].password_hash), "Audit failure must preserve both old credentials and session");
  passed("Password and session revocation are atomic with audit insertion");

  const deletePassword = secret(), deleteTarget = await fixture("admin", deletePassword);
  const deleteToken = await login(deleteTarget, deletePassword);
  const deleteApiToken = (await status("tokens", 201, "POST", deleteToken, { name: "Temporary delete token" })).data.token as string;
  const retainedRecord = randomUUID(); temporaryRecords.push(retainedRecord);
  await pool().execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'tasks',?,?,?)", [retainedRecord, tenant, JSON.stringify({ name: "Temporary retained account history" }), deleteTarget.id]);
  const [historyBefore] = await pool().execute<RowDataPacket[]>("SELECT id FROM audit_logs WHERE actor_id=? AND tenant=?", [deleteTarget.id, tenant]);
  for (const role of ["analyst", "operator", "viewer"] as User["role"][]) {
    const password = secret(), unauthorized = await fixture(role, password);
    await status(`users/${deleteTarget.id}`, 403, "DELETE", await login(unauthorized, password), { confirm: true });
  }
  await status(`users/${deleteTarget.id}`, 401, "DELETE", "", { confirm: true });
  await status(`users/${deleteTarget.id}`, 400, "DELETE", adminToken, { confirm: false });
  await status(`users/${deleteTarget.id}`, 400, "DELETE", adminToken, { confirm: true, eraseRecords: true });
  await status(`users/${deleteTarget.id}/extra`, 405, "DELETE", adminToken, { confirm: true });
  await status(`users/${admin.id}`, 400, "DELETE", adminToken, { confirm: true });
  await status(`users/${deleteTarget.id}`, 403, "DELETE", adminToken, { confirm: true }, "https://untrusted.invalid");
  await rejected(deleteManagedUser(stale.user, stale.token, deleteTarget.id), 401, "Revoked administrator cannot delete a user after route authentication");
  passed("User deletion rejects unauthenticated, non-admin, unconfirmed, malformed and self-delete requests");

  // Failure after the update/session revocation must restore the entire account.
  db.getConnection = async function () {
    const connection = await originalGetConnection.call(db), execute = connection.execute;
    connection.execute = (async function (sql: unknown, ...args: unknown[]) {
      if (typeof sql === "string" && sql.startsWith("INSERT INTO audit_logs")) throw new HttpError(503, "Injected delete audit failure");
      return (execute as Function).call(connection, sql, ...args);
    }) as typeof connection.execute;
    const release = connection.release;
    connection.release = () => { connection.execute = execute; connection.release = release; release.call(connection); };
    return connection;
  };
  try { await rejected(deleteManagedUser(admin, adminToken, deleteTarget.id), 503, "Audit failure rolls back account deletion"); }
  finally { db.getConnection = originalGetConnection; }
  await status("session", 200, "GET", deleteToken);
  await status("session", 200, "GET", deleteApiToken);
  const [notDeleted] = await pool().execute<RowDataPacket[]>("SELECT active,deleted_at FROM users WHERE id=?", [deleteTarget.id]);
  check(notDeleted[0]?.active === 1 && notDeleted[0].deleted_at === null, "Failed deletion must preserve the account and sessions");

  const deletion = await status(`users/${deleteTarget.id}`, 200, "DELETE", adminToken, { confirm: true });
  check(deletion.data.retainedRecords === true, "Delete response must report retained historical data");
  const [deletedRows] = await pool().execute<RowDataPacket[]>("SELECT username,active,deleted_at FROM users WHERE id=?", [deleteTarget.id]);
  check(deletedRows[0]?.username === deleteTarget.username && deletedRows[0].active === 0 && deletedRows[0].deleted_at, "Deletion must retain username and ownership identity as a disabled tombstone");
  for (const token of [deleteToken, deleteApiToken]) await status("session", 401, "GET", token);
  await status("session", 401, "POST", "", { username: deleteTarget.username, password: deletePassword });
  const visibleUsers = await status("users", 200, "GET", adminToken);
  check(!visibleUsers.data.some((user: User) => user.id === deleteTarget.id), "Deleted account must disappear from user management");
  await status(`users/${deleteTarget.id}`, 404, "DELETE", adminToken, { confirm: true });
  await status(`users/${deleteTarget.id}`, 404, "PUT", adminToken, { name: deleteTarget.name, tenant, role: "admin", active: true });
  await status(`users/${deleteTarget.id}/password`, 404, "POST", adminToken, { newPassword: secret() });
  await status("users", 409, "POST", adminToken, { username: deleteTarget.username, name: deleteTarget.name, tenant, role: "viewer", password: secret() });
  const [historyAfter] = await pool().execute<RowDataPacket[]>("SELECT id FROM audit_logs WHERE actor_id=? AND tenant=?", [deleteTarget.id, tenant]);
  const [retained] = await pool().execute<RowDataPacket[]>("SELECT created_by,body FROM records WHERE id=? AND tenant=?", [retainedRecord, tenant]);
  check(retained[0]?.created_by === deleteTarget.id &&
    (typeof retained[0].body === "string" ? JSON.parse(retained[0].body) : retained[0].body).name === "Temporary retained account history",
    "Deleted user's task content and original owner must remain");
  check(historyBefore.every(entry => historyAfter.some(next => next.id === entry.id)), "Deleted user's audit history must remain");
  const [deletionAudit] = await pool().execute<RowDataPacket[]>("SELECT id FROM audit_logs WHERE actor_id=? AND tenant=? AND action='删除用户'", [admin.id, tenant]);
  check(deletionAudit.length > 0, "Deletion must leave an administrator audit event");
  passed("Soft deletion revokes sessions/API tokens, blocks login/re-enable/name reuse, and preserves records/audits");

  const [audit] = await pool().execute<RowDataPacket[]>("SELECT action FROM audit_logs WHERE tenant=?", [tenant]);
  for (const action of ["修改统一密码", "重置统一密码", "编辑用户并重置统一密码"])
    check(audit.some(entry => entry.action === action), "Credential audit action missing");
  passed("Credential operations produce safe audit events");
}

async function run() {
try { await main(); console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks }, null, 2)); }
catch (error) { console.error(error instanceof Error ? error.message : "Account validation failed"); process.exitCode = 1; }
finally {
  for (const id of temporaryRecords) await pool().execute("DELETE FROM records WHERE id=? AND tenant=?", [id, tenant]);
  for (const user of users) {
    await pool().execute("DELETE FROM sessions WHERE user_id=?", [user.id]);
    await pool().execute("DELETE FROM audit_logs WHERE actor_id=? AND tenant=?", [user.id, tenant]);
  }
  await pool().execute("DELETE FROM users WHERE tenant=?", [tenant]);
  await pool().end();
}
}
void run();
