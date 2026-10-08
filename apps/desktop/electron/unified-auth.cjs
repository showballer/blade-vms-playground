"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");

const OFFLINE_MS = 30 * 24 * 60 * 60 * 1000;
const RESPONSE_LIMIT = 64 * 1024;
const FILE_LIMIT = 8192;
const ROLES = new Set(["admin", "analyst", "operator"]);
const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const password = (value, minimum = 1) => typeof value === "string" && value.length >= minimum && value.length <= 128;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

function serverOrigin(value) {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value || /[\\\x00-\x20\x7f]/.test(value)) throw fail(400, "请输入有效的 HTTP 或 HTTPS Web 源地址");
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:?#@]+)(?::([0-9]+))?\/?$/.exec(value);
  if (!match) throw fail(400, "服务地址须为源地址，不能包含账号、路径、查询或片段");
  let parsed;
  try { parsed = new URL(value); } catch { throw fail(400, "Web 服务地址无效"); }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.hostname) throw fail(400, "Web 服务地址无效");
  // Keep the entered destination unambiguous (no shortened/numeric IP aliases,
  // escaped hostnames or trailing-dot names), including when HTTP is selected.
  if (parsed.hostname !== match[2].toLowerCase() || parsed.hostname.endsWith(".")) throw fail(400, "请填写完整、标准的 Web 主机地址");
  return parsed.origin;
}

function validUser(value) {
  return keys(value, ["id", "username", "name", "role", "tenant"]) && text(value.id, 128) &&
    text(value.username, 80) && text(value.name, 200) && text(value.tenant, 128) && ROLES.has(value.role);
}

function readBinding(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > FILE_LIMIT || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error("Invalid binding file");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!keys(value, ["version", "serverUrl", "user", "salt", "hash", "lastVerifiedAt", "offlineUntil", "lastObservedAt", "onlineRequired"]) ||
      value.version !== 1 || serverOrigin(value.serverUrl) !== value.serverUrl || !validUser(value.user) ||
      typeof value.salt !== "string" || !/^[a-f0-9]{64}$/.test(value.salt) ||
      typeof value.hash !== "string" || !/^[a-f0-9]{128}$/.test(value.hash) ||
      !timestamp(value.lastVerifiedAt) || !timestamp(value.offlineUntil) || !timestamp(value.lastObservedAt) ||
      value.offlineUntil - value.lastVerifiedAt !== OFFLINE_MS || value.lastObservedAt < value.lastVerifiedAt ||
      value.lastObservedAt >= value.offlineUntil || typeof value.onlineRequired !== "boolean") throw Error("Invalid binding record");
  return value;
}

function writeBinding(file, value, initial = false) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    if (initial) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* Preserve failure. */ } }
    try { fs.unlinkSync(temporary); } catch { /* Atomic rename already removed it. */ }
  }
}

function matches(value, record) {
  return timingSafeEqual(scryptSync(value, record.salt, 64), Buffer.from(record.hash, "hex"));
}

function transportFailure(error) {
  if (!error || typeof error !== "object") return false;
  if (NETWORK_CODES.has(error.code)) return true;
  if (Array.isArray(error.errors) && error.errors.length) return error.errors.every(transportFailure);
  return error.cause ? transportFailure(error.cause) : false;
}

async function limitedJson(response) {
  const length = response.headers?.get?.("content-length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > RESPONSE_LIMIT)) throw fail(502, "Web 认证响应大小无效");
  if (!response.body?.getReader) throw fail(502, "Web 认证响应为空或格式无效");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw fail(502, "Web 认证响应超过 64 KB 限制");
      chunks.push(Buffer.from(value));
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const result = JSON.parse(content);
    if (!object(result)) throw Error("Invalid JSON object");
    return result;
  } catch (error) {
    if (error?.status) throw error;
    // A response was received: even a truncated/malformed body never falls back.
    throw fail(502, "Web 认证响应不完整或格式无效，请联网重试");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Explicit account binding; an independently salted offline verifier is the
 * only password-related persisted data. Web bearer tokens remain call-local.
 */
function createUnifiedAuth({ file, localAuth, now = Date.now, fetchImpl = global.fetch } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof now !== "function" || typeof fetchImpl !== "function" ||
      !["login", "logout", "session", "requireSession", "changePassword"].every(key => typeof localAuth?.[key] === "function")) throw fail(500, "统一账号配置无效");
  let binding = null;
  try { binding = readBinding(file); }
  catch (error) { if (error.code !== "ENOENT") throw fail(500, "统一账号文件不可用；不会回退本机账号或重置绑定"); }
  const revocationFile = `${file}.online-required`;
  function revocationPending() {
    try { fs.lstatSync(revocationFile); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw fail(500, "离线凭证失效标记不可用，请修复本机存储后联网登录"); }
  }
  if (revocationPending()) {
    if (!binding) throw fail(500, "统一账号绑定文件缺失；不会回退本机账号或重置绑定");
    binding.onlineRequired = true;
  }
  let active = null, busy = false, epoch = 0, failures = 0, lockedUntil = 0;
  let clockHighWater = binding?.lastObservedAt ?? 0;
  let storageFailed = false;

  function clock() {
    const value = now();
    if (!timestamp(value) || !timestamp(value + OFFLINE_MS)) throw fail(500, "本机认证时钟不可用");
    const rolledBack = value < clockHighWater;
    clockHighWater = Math.max(clockHighWater, value);
    return { value, rolledBack };
  }
  function throttle() {
    const stamp = clock();
    if (lockedUntil > stamp.value) throw fail(429, "密码尝试次数过多，请稍后重试", { retryAfterSeconds: Math.ceil((lockedUntil - stamp.value) / 1000) });
    if (lockedUntil) { failures = 0; lockedUntil = 0; }
    return stamp;
  }
  function rejectPassword(stamp) {
    if (++failures >= 5) {
      lockedUntil = stamp + 60_000;
      throw fail(429, "密码尝试次数过多，请 60 秒后重试", { retryAfterSeconds: 60 });
    }
    throw fail(401, "统一账号或密码错误");
  }
  function unchangedIdentity(a, b) {
    return a.id === b.id && a.username === b.username && a.tenant === b.tenant;
  }
  function loadCurrent() {
    if (!binding) return;
    try {
      const current = readBinding(file);
      if (current.serverUrl !== binding.serverUrl || !unchangedIdentity(current.user, binding.user)) throw Error("Binding identity changed");
      binding = { ...current, onlineRequired: current.onlineRequired || storageFailed || revocationPending() };
      clockHighWater = Math.max(clockHighWater, current.lastObservedAt);
    } catch { throw fail(500, "统一账号文件不可用；不会回退本机账号或重置绑定"); }
  }
  function save(next, initial = false, onlineVerified = false) {
    try {
      writeBinding(file, next, initial);
      // Clear the independent fail-closed marker only after a freshly verified
      // password has been durably written. Offline use cannot clear it.
      if (onlineVerified) {
        try { fs.unlinkSync(revocationFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    catch {
      if (binding) {
        binding = { ...binding, onlineRequired: true }; storageFailed = true;
        let marked = false;
        try { writeBinding(revocationFile, { version: 1, onlineRequired: true }); marked = true; } catch { /* Keep the in-process prohibition even when all persistence fails. */ }
        throw fail(500, marked
          ? "统一账号缓存无法保存，离线登录已停用，请修复本机存储后联网登录"
          : "离线凭证失效状态无法保存，请修复本机存储后联网登录", { storage: true });
      }
      else {
        try { fs.lstatSync(file); storageFailed = true; } catch (error) { if (error.code !== "ENOENT") storageFailed = true; }
      }
      throw fail(500, "统一账号信息未能安全保存，请检查本机存储后联网重试", { storage: true });
    }
    binding = next;
    if (onlineVerified) storageFailed = false;
  }
  function invalidate() {
    // Rewrite even when the in-memory prohibition is already set: an earlier
    // disk failure may have left only volatile state, and mutations must wait
    // for a persisted prohibition before changing the Web password.
    if (binding) save({ ...binding, onlineRequired: true });
  }
  function account(offline = active?.offline ?? false) {
    if (!binding) return { mode: "local" };
    return { mode: "unified", serverUrl: binding.serverUrl, username: binding.user.username,
      offline, offlineUntil: binding.offlineUntil, lastVerifiedAt: binding.lastVerifiedAt,
      onlineRequired: binding.onlineRequired || storageFailed, syncPolicy: "login-only" };
  }
  function response() {
    return { user: { username: active.user.username, name: active.user.name, role: active.user.role },
      mustChangePassword: false, account: account(active.offline) };
  }
  function localMode() {
    if (storageFailed && !binding) throw fail(500, "统一账号绑定状态不确定，请重新打开应用核实；不会回退本机账号");
    return !binding;
  }
  function publish(user, offline, requestEpoch) {
    if (epoch !== requestEpoch) throw fail(409, "本次登录已取消，请重新登录");
    active = { user: { ...user }, offline };
    failures = 0; lockedUntil = 0;
    return response();
  }
  async function operation(callback) {
    if (busy) throw fail(409, "账号验证进行中，请等待完成");
    busy = true;
    try { return await callback(epoch); } finally { busy = false; }
  }
  async function request(origin, route, body, token, method = "POST", timeoutMs = 8000) {
    const controller = new AbortController();
    let timedOut = false, receivedResponse = false, timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(fail(503, "Web 认证连接超时", { transport: !receivedResponse })); }, timeoutMs);
    });
    try {
      return await Promise.race([(async () => {
        let reply;
        try {
          reply = await fetchImpl(`${origin}${route}`, { method, redirect: "error", signal: controller.signal,
            headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        } catch (error) {
          throw fail(503, "无法连接 Web 认证服务，请检查网络与服务地址", { transport: timedOut || transportFailure(error) });
        }
        receivedResponse = true;
        if (!Number.isInteger(reply.status) || reply.status < 100 || reply.status > 599) throw fail(502, "Web 认证响应状态无效");
        if (reply.status < 200 || reply.status >= 300) {
          void reply.body?.cancel?.().catch(() => {});
          const messages = { 401: "统一账号或密码错误", 403: "统一账号无权使用桌面采集", 429: "Web 账号尝试次数过多，请稍后联网重试" };
          throw fail(reply.status, messages[reply.status] || "Web 认证服务返回错误，请联网重试", { invalidates: [401, 403].includes(reply.status) });
        }
        return limitedJson(reply);
      })(), deadline]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function discardToken(origin, token) {
    try { await request(origin, "/api/v1/session", undefined, token, "DELETE", 2000); }
    catch { /* A failed cleanup never invalidates a verified login or stores a bearer token. */ }
  }
  async function authenticate(origin, username, secret, expected, keepToken = false) {
    const data = await request(origin, "/api/v1/session", { username, password: secret });
    const validToken = text(data.token, 4096) && /^[A-Za-z0-9_-]{20,4096}$/.test(data.token);
    let retained = false;
    try {
      const raw = data.user;
      if (!object(raw) || ![0, 1].includes(raw.active) || !text(raw.id, 128) || !text(raw.username, 80) ||
          !text(raw.name, 200) || !text(raw.tenant, 128) || typeof raw.role !== "string" || !validToken) throw fail(502, "Web 账号响应缺少有效身份信息，请联网重试");
      const user = Object.fromEntries(["id", "username", "name", "role", "tenant"].map(key => [key, raw[key]]));
      if (raw.active !== 1 || !ROLES.has(user.role)) throw fail(403, "该统一账号无权使用桌面采集，请联系管理员", { invalidates: true });
      if (expected && !unchangedIdentity(expected, user)) throw fail(403, "Web 账号身份或所属组织已改变，请联系管理员重新核实绑定", { invalidates: true });
      retained = keepToken;
      return { user, token: data.token };
    } finally { if (validToken && !retained) await discardToken(origin, data.token); }
  }
  function verified(origin, user, secret, stamp, initial = false) {
    const salt = randomBytes(32).toString("hex");
    save({ version: 1, serverUrl: origin, user, salt, hash: scryptSync(secret, salt, 64).toString("hex"),
      lastVerifiedAt: stamp, offlineUntil: stamp + OFFLINE_MS, lastObservedAt: stamp, onlineRequired: false }, initial, true);
    clockHighWater = stamp;
  }

  return Object.freeze({
    async login(username, secret) {
      if (localMode()) return localAuth.login(username, secret);
      return operation(async requestEpoch => {
        loadCurrent();
        const stamp = throttle();
        if (!text(username, 80) || !password(secret)) throw fail(400, "请提供有效统一账号和密码，密码最多 128 个字符");
        try {
          const identity = await authenticate(binding.serverUrl, username, secret, binding.user);
          if (epoch !== requestEpoch) throw fail(409, "本次登录已取消，请重新登录");
          verified(binding.serverUrl, identity.user, secret, clock().value);
          return publish(identity.user, false, requestEpoch);
        } catch (error) {
          if (error.invalidates) invalidate();
          if (error.status === 401) rejectPassword(stamp.value);
          if (!error.transport) throw error;
          if (epoch !== requestEpoch) throw fail(409, "本次登录已取消，请重新登录");
          const current = clock();
          if (binding.onlineRequired) throw fail(403, "统一账号已要求联网验证，旧离线密码不能继续使用");
          if (stamp.rolledBack || current.rolledBack || current.value < binding.lastObservedAt) {
            invalidate();
            throw fail(403, "检测到本机时钟倒退，请校准时间后联网登录");
          }
          if (current.value >= binding.offlineUntil) {
            invalidate();
            throw fail(403, "离线登录期限已过，请联网使用 Web 账号重新登录");
          }
          const correct = matches(secret, binding);
          if (username !== binding.user.username || !correct) rejectPassword(current.value);
          save({ ...binding, lastObservedAt: current.value });
          return publish(binding.user, true, requestEpoch);
        }
      });
    },
    session() {
      if (localMode()) return localAuth.session();
      if (!active) throw fail(401, "请先登录统一账号");
      return response();
    },
    requireSession(options) {
      if (localMode()) return localAuth.requireSession(options);
      if (!active) throw fail(401, "请先登录统一账号");
      return { username: active.user.username, name: active.user.name, role: active.user.role };
    },
    logout() {
      epoch += 1; active = null;
      return localAuth.logout();
    },
    info() { localMode(); return { ...account() }; },
    async bindAccount({ serverUrl, username, password: secret, currentPassword } = {}) {
      return operation(async requestEpoch => {
        if (binding) throw fail(409, "本机已绑定统一账号，不允许自动替换或回退本机账号");
        localMode();
        localAuth.requireSession();
        if (!text(username, 80) || !password(secret) || !password(currentPassword)) throw fail(400, "请提供 Web 账号密码和当前本机密码");
        const origin = serverOrigin(serverUrl);
        localAuth.login("admin", currentPassword);
        const identity = await authenticate(origin, username, secret);
        if (epoch !== requestEpoch) throw fail(409, "本次绑定已取消，请重新登录");
        verified(origin, identity.user, secret, clock().value, true);
        localAuth.logout();
        return publish(identity.user, false, requestEpoch);
      });
    },
    async changePassword(currentPassword, newPassword) {
      if (localMode()) return localAuth.changePassword(currentPassword, newPassword);
      return operation(async requestEpoch => {
        if (!active) throw fail(401, "请先登录统一账号");
        loadCurrent();
        const stamp = throttle();
        if (!password(currentPassword) || !password(newPassword, 12)) throw fail(400, "当前密码不能为空，新密码须为 12–128 个字符");
        if (currentPassword === newPassword) throw fail(400, "新密码不能与当前密码相同");
        let identity;
        try { identity = await authenticate(binding.serverUrl, binding.user.username, currentPassword, binding.user, true); }
        catch (error) {
          if (error.invalidates) invalidate();
          if (error.status === 401) rejectPassword(stamp.value);
          throw error;
        }
        let mutationStarted = false;
        try {
          if (epoch !== requestEpoch) throw fail(409, "本次改密已取消，请重新登录");
          // Disable the old offline verifier BEFORE sending a potentially
          // successful mutation whose response may be lost in transit.
          invalidate();
          mutationStarted = true;
          const result = await request(binding.serverUrl, "/api/v1/account/password", { currentPassword, newPassword }, identity.token);
          if (result.ok !== true || result.reauthenticate !== true) throw fail(502, "改密响应格式无效");
          const updated = await authenticate(binding.serverUrl, binding.user.username, newPassword, binding.user);
          verified(binding.serverUrl, updated.user, newPassword, clock().value);
          return publish(updated.user, false, requestEpoch);
        } catch (error) {
          if (!mutationStarted || error.storage) throw error;
          throw fail(503, "Web 密码更新或重新登录未确认完成；请使用新密码联网登录核实，本机旧离线密码已停用");
        } finally { await discardToken(binding.serverUrl, identity.token); }
      });
    },
  });
}

module.exports = { createUnifiedAuth };
