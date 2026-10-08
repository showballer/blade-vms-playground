import { randomBytes, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { digest, HttpError, passwordHash, passwordMatch, pool, type User } from "./db";

type CredentialUser = User & { password_hash: string };
export function passwordInput(value: unknown, max = 200) {
  if (typeof value !== "string" || !value.length || value.length > max) throw new HttpError(400, "请填写有效密码");
  return value;
}
export function newAccountPassword(value: unknown) {
  const password = passwordInput(value, 128);
  if (password.length < 12) throw new HttpError(400, "新密码须为 12–128 位");
  return password;
}
function passwordMatches(value: string, hash: string) {
  // Match the desktop's offline verifier exactly; never silently trim credentials.
  return passwordMatch(value, hash);
}
function publicUser(user: User): User {
  return { id: user.id, username: user.username, name: user.name, role: user.role, tenant: user.tenant, active: user.active };
}
async function transaction<T>(operation: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function credentialAudit(connection: PoolConnection, actor: User, action: string, target: string) {
  await connection.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)",
    [randomUUID(), actor.id, actor.name, actor.tenant, action, target.slice(0, 255), "成功"]);
}
async function requireCurrentSession(connection: PoolConnection, actorId: string, token: string) {
  const [sessions] = await connection.execute<RowDataPacket[]>("SELECT id FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>UTC_TIMESTAMP() FOR UPDATE", [digest(token), actorId]);
  if (!sessions.length) throw new HttpError(401, "会话已失效，请重新登录");
}

/** Serialize signing in against password changes so an old verification cannot mint a new token after reset. */
export async function loginAccount(username: string, password: string) {
  return transaction(async connection => {
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT id,username,name,role,tenant,active,password_hash FROM users WHERE username=? FOR UPDATE", [username]);
    const user = rows[0] as CredentialUser | undefined;
    if (!user?.active || !passwordMatches(password, user.password_hash)) throw new HttpError(401, "用户名或密码不正确");
    const token = randomBytes(32).toString("base64url");
    await connection.execute("INSERT INTO sessions(id,token_hash,user_id,expires_at) VALUES(?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 12 HOUR))", [randomUUID(), digest(token), user.id]);
    await credentialAudit(connection, user, "登录", user.username);
    return { user: publicUser(user), token };
  });
}

export async function changeAccountPassword(actor: User, token: string, current: unknown, next: unknown) {
  const currentPassword = passwordInput(current), newPassword = newAccountPassword(next);
  return transaction(async connection => {
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT id,username,name,role,tenant,active,password_hash FROM users WHERE id=? FOR UPDATE", [actor.id]);
    const user = rows[0] as CredentialUser | undefined;
    if (!user?.active) throw new HttpError(401, "账号已失效，请重新登录");
    await requireCurrentSession(connection, user.id, token);
    if (!passwordMatches(currentPassword, user.password_hash)) throw new HttpError(400, "当前密码不正确");
    if (passwordMatches(newPassword, user.password_hash)) throw new HttpError(400, "新密码不能与当前密码相同");
    await connection.execute("UPDATE users SET password_hash=? WHERE id=?", [passwordHash(newPassword), user.id]);
    await connection.execute("DELETE FROM sessions WHERE user_id=?", [user.id]);
    await credentialAudit(connection, user, "修改统一密码", user.username);
    return { ok: true, reauthenticate: true };
  });
}

async function managedUsers(connection: PoolConnection, actor: User, token: string, targetId: string) {
  // Lock both rows in a stable order, and re-check privileges inside the same transaction.
  const [rows] = await connection.execute<RowDataPacket[]>("SELECT id,username,name,role,tenant,active FROM users WHERE id IN (?,?) ORDER BY id FOR UPDATE", [actor.id, targetId]);
  const administrator = rows.find(row => row.id === actor.id) as User | undefined;
  if (!administrator?.active || administrator.role !== "admin") throw new HttpError(403, "此操作需要管理员权限");
  await requireCurrentSession(connection, administrator.id, token);
  const target = rows.find(row => row.id === targetId) as User | undefined;
  if (!target) throw new HttpError(404, "用户不存在");
  return { administrator, target };
}

export async function resetAccountPassword(actor: User, token: string, targetId: string, value: unknown) {
  const password = newAccountPassword(value);
  return transaction(async connection => {
    const { administrator, target } = await managedUsers(connection, actor, token, targetId);
    await connection.execute("UPDATE users SET password_hash=? WHERE id=?", [passwordHash(password), target.id]);
    await connection.execute("DELETE FROM sessions WHERE user_id=?", [target.id]);
    await credentialAudit(connection, administrator, "重置统一密码", target.username);
    return { ok: true, reauthenticate: actor.id === target.id };
  });
}

export async function issueAccountToken(actor: User, currentToken: string, name: string) {
  return transaction(async connection => {
    const { administrator } = await managedUsers(connection, actor, currentToken, actor.id);
    const token = "bv_" + randomBytes(32).toString("base64url");
    await connection.execute("INSERT INTO sessions(id,token_hash,user_id,kind,name,expires_at) VALUES(?,?,?,'api',?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 DAY))",
      [randomUUID(), digest(token), administrator.id, name]);
    await credentialAudit(connection, administrator, "创建 API 令牌", name);
    return { token, expiresIn: "30 天" };
  });
}

export async function createManagedUser(actor: User, token: string, data: { username: string; name: string; role: User["role"]; tenant: string; active: boolean; password: string }) {
  const hash = passwordHash(newAccountPassword(data.password));
  return transaction(async connection => {
    const { administrator } = await managedUsers(connection, actor, token, actor.id);
    const id = randomUUID();
    await connection.execute("INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,?)",
      [id, data.username, data.name, hash, data.role, data.tenant, data.active ? 1 : 0]);
    await credentialAudit(connection, administrator, "新增用户", data.username);
    return { id };
  });
}

export async function updateManagedUser(actor: User, token: string, targetId: string, data: { name: string; role: User["role"]; tenant: string; active: boolean; password?: string }) {
  const hash = data.password === undefined ? undefined : passwordHash(newAccountPassword(data.password));
  return transaction(async connection => {
    const { administrator, target } = await managedUsers(connection, actor, token, targetId);
    if (targetId === actor.id && (!data.active || data.role !== "admin")) throw new HttpError(400, "不能禁用或降级当前管理员");
    await connection.execute("UPDATE users SET name=?,role=?,tenant=?,active=?" + (hash ? ",password_hash=?" : "") + " WHERE id=?",
      [data.name, data.role, data.tenant, data.active ? 1 : 0, ...(hash ? [hash] : []), targetId]);
    const revoke = Boolean(hash) || targetId !== actor.id || data.role !== target.role || data.tenant !== target.tenant || data.active !== Boolean(target.active);
    if (revoke) await connection.execute("DELETE FROM sessions WHERE user_id=?", [targetId]);
    await credentialAudit(connection, administrator, hash ? "编辑用户并重置统一密码" : "编辑用户", target.username);
    return { ok: true, reauthenticate: revoke && targetId === actor.id };
  });
}
