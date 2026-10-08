// Real local Web API + desktop authentication module. Uses only newly created test accounts.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';

const require = createRequire(import.meta.url);
const { createLocalAuth } = require('../apps/desktop/electron/local-auth.cjs');
const { createUnifiedAuth } = require('../apps/desktop/electron/unified-auth.cjs');
assert.equal(process.env.DB_NAME, 'blade_vms_playground', 'Only the project development database may be used');
const origin = 'http://127.0.0.1:3210';
const tag = 'qa_unified_' + randomUUID().replaceAll('-', '');
const accountId = randomUUID(), adminId = randomUUID();
const passwords = Array.from({ length: 5 }, () => randomBytes(24).toString('base64url'));
const [webPassword, nextPassword, resetPassword, localPassword, adminPassword] = passwords;
const hash = password => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); };
const directory = mkdtempSync(path.join(os.tmpdir(), 'blade-unified-e2e-'));
const localFile = path.join(directory, 'local.json'), unifiedFile = path.join(directory, 'unified.json');
let networkAvailable = true;
const transport = (...args) => {
  if (!networkAvailable) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  return fetch(...args);
};
const database = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
async function call(endpoint, data, token, method = 'POST') {
  const response = await fetch(origin + '/api/v1/' + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
}
const unavailable = async promise => { await assert.rejects(promise, error => [400, 401, 403, 409, 429, 503].includes(error.status)); };
try {
  for (const [id, username, password, role] of [[accountId, tag, webPassword, 'operator'], [adminId, tag + '_admin', adminPassword, 'admin']]) {
    await database.execute('INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,1)', [id, username, '临时统一账号验证', hash(password), role, tag]);
  }
  const initial = randomBytes(24).toString('base64url'), salt = randomBytes(32).toString('hex');
  const local = createLocalAuth({ file: localFile, bootstrap: { version: 1, username: 'admin', salt, hash: scryptSync(initial, salt, 64).toString('hex') } });
  local.login('admin', initial); local.changePassword(initial, localPassword);
  const originalLocal = readFileSync(localFile, 'utf8');
  const unified = createUnifiedAuth({ file: unifiedFile, localAuth: local, fetchImpl: transport });
  const linked = await unified.bindAccount({ serverUrl: origin, username: tag, password: webPassword, currentPassword: localPassword });
  assert.equal(linked.user.username, tag); assert.equal(linked.account.mode, 'unified');
  assert.equal(readFileSync(localFile, 'utf8'), originalLocal, 'Linking must preserve the original local credential file');
  assert.ok(passwords.every(password => !readFileSync(unifiedFile, 'utf8').includes(password)), 'No plaintext password may be persisted');
  unified.logout();
  assert.equal((await unified.login(tag, webPassword)).account.offline, false);
  unified.logout(); networkAvailable = false;
  assert.equal((await unified.login(tag, webPassword)).account.offline, true);
  console.log('PASS bind existing Web account and authenticate offline without rewriting local credentials');

  // Another Web client changes the shared password while the desktop is offline.
  const web = await call('session', { username: tag, password: webPassword });
  assert.equal(web.status, 200);
  assert.equal((await call('account/password', { currentPassword: webPassword, newPassword: nextPassword }, web.body.token)).status, 200);
  assert.equal((await call('session', undefined, web.body.token, 'GET')).status, 401);
  unified.logout();
  assert.equal((await unified.login(tag, webPassword)).account.offline, true, 'An offline desktop cannot know a remote change until it reconnects');
  unified.logout(); networkAvailable = true;
  await unavailable(unified.login(tag, webPassword));
  networkAvailable = false;
  await unavailable(unified.login(tag, webPassword));
  networkAvailable = true;
  assert.equal((await unified.login(tag, nextPassword)).account.offline, false);
  unified.logout(); networkAvailable = false;
  const restarted = createUnifiedAuth({ file: unifiedFile, localAuth: local, fetchImpl: transport });
  assert.equal((await restarted.login(tag, nextPassword)).account.offline, true);
  console.log('PASS Web password change revokes old sessions; online rejection blocks stale offline fallback; new password survives desktop restart');

  const administrator = await call('session', { username: tag + '_admin', password: adminPassword });
  assert.equal(administrator.status, 200);
  assert.equal((await call('users/' + accountId + '/password', { newPassword: resetPassword }, administrator.body.token)).status, 200);
  restarted.logout(); networkAvailable = true;
  await unavailable(restarted.login(tag, nextPassword));
  assert.equal((await restarted.login(tag, resetPassword)).account.offline, false);
  assert.equal((await restarted.changePassword(resetPassword, nextPassword)).account.offline, false);
  assert.equal((await call('session', { username: tag, password: resetPassword })).status, 401);
  assert.equal((await call('session', { username: tag, password: nextPassword })).status, 200);
  console.log('PASS desktop password change updates the same Web account password');
  assert.equal((await call('users/' + accountId, { name: '临时统一账号验证', role: 'operator', tenant: tag, active: false }, administrator.body.token, 'PUT')).status, 200);
  restarted.logout();
  await unavailable(restarted.login(tag, nextPassword));
  networkAvailable = false;
  await unavailable(restarted.login(tag, nextPassword));
  console.log('PASS administrator reset updates desktop login; disabled account cannot downgrade to offline authentication');
} finally {
  try {
    await database.execute('DELETE FROM sessions WHERE user_id IN (?,?)', [accountId, adminId]);
    await database.execute('DELETE FROM audit_logs WHERE actor_id IN (?,?) AND tenant=?', [accountId, adminId, tag]);
    await database.execute('DELETE FROM users WHERE id IN (?,?) AND tenant=?', [accountId, adminId, tag]);
  } finally { await database.end(); rmSync(directory, { recursive: true, force: true }); }
}
