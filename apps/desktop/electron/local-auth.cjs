"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");

const USER = Object.freeze({ username: "admin", name: "本机管理员", role: "admin" });
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;
const MAX_PASSWORD_LENGTH = 128;

function authError(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra);
}

function validHashRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.version === 1 && value.username === USER.username
    && typeof value.salt === "string" && /^[a-f0-9]{64}$/.test(value.salt)
    && typeof value.hash === "string" && /^[a-f0-9]{128}$/.test(value.hash);
}

function readCredentials(file) {
  // Only ENOENT at initial creation is recoverable. A damaged or redirected file
  // must never cause the shipped bootstrap password to become valid again.
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 4096) throw Error("Invalid credentials");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!validHashRecord(value) || typeof value.mustChangePassword !== "boolean") {
    throw Error("Invalid credentials");
  }
  return {
    version: 1, username: USER.username, salt: value.salt,
    hash: value.hash, mustChangePassword: value.mustChangePassword,
  };
}

function writeCredentials(file, value, initial = false) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // An exclusive hard link publishes a complete first record without ever
    // replacing credentials created by another process. Updates use atomic rename.
    if (initial) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the original error. */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* It may already have been renamed. */ }
  }
}

function validPassword(value, minimum = 1) {
  return typeof value === "string" && value.length >= minimum
    && value.length <= MAX_PASSWORD_LENGTH;
}

function matches(password, credentials) {
  // Salt is intentionally the hex string, matching bootstrap generation.
  const candidate = scryptSync(password, credentials.salt, 64);
  return timingSafeEqual(candidate, Buffer.from(credentials.hash, "hex"));
}

/** Offline authentication; sessions and throttling are deliberately process-local. */
function createLocalAuth({ file, bootstrap, now = Date.now } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof now !== "function") {
    throw authError(500, "本机认证配置无效");
  }
  let credentials;
  try {
    try {
      credentials = readCredentials(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!validHashRecord(bootstrap)) throw Error("Invalid bootstrap");
      const initial = {
        version: 1, username: USER.username, salt: bootstrap.salt,
        hash: bootstrap.hash, mustChangePassword: true,
      };
      try { writeCredentials(file, initial, true); }
      catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; }
      credentials = readCredentials(file);
    }
  } catch {
    throw authError(500, "本机账号文件不可用，请联系管理员；不会重置为初始密码");
  }

  let authenticated = false;
  let failures = 0;
  let lockedUntil = 0;

  function checkThrottle() {
    const timestamp = Number(now());
    if (!Number.isFinite(timestamp)) throw authError(500, "本机认证时钟不可用");
    if (lockedUntil > timestamp) {
      throw authError(429, "密码尝试次数过多，请稍后重试", {
        retryAfterSeconds: Math.ceil((lockedUntil - timestamp) / 1000),
      });
    }
    if (lockedUntil) { failures = 0; lockedUntil = 0; }
    return timestamp;
  }

  function rejectPassword(timestamp) {
    failures += 1;
    if (failures >= MAX_FAILURES) {
      lockedUntil = timestamp + LOCK_MS;
      throw authError(429, "密码尝试次数过多，请 60 秒后重试", { retryAfterSeconds: 60 });
    }
    throw authError(401, "账号或密码错误");
  }

  function response() {
    return { user: { ...USER }, mustChangePassword: credentials.mustChangePassword };
  }

  function requireSession({ allowInitial = false } = {}) {
    if (!authenticated) throw authError(401, "请先登录本机账号");
    if (credentials.mustChangePassword && !allowInitial) {
      throw authError(403, "首次登录请先修改初始密码");
    }
    return { ...USER };
  }

  return Object.freeze({
    login(username, password) {
      const timestamp = checkThrottle();
      if (typeof username !== "string" || !username.length || username.length > 64
        || !validPassword(password)) {
        throw authError(400, "请提供有效账号和密码，密码最多 128 个字符");
      }
      // Derive even for an incorrect username; do not distinguish the failures.
      const passwordMatches = matches(password, credentials);
      if (!passwordMatches || username !== USER.username) rejectPassword(timestamp);
      failures = 0;
      lockedUntil = 0;
      authenticated = true;
      return response();
    },
    logout() {
      authenticated = false;
      return { ok: true };
    },
    session() {
      requireSession({ allowInitial: true });
      return response();
    },
    requireSession,
    changePassword(currentPassword, newPassword) {
      requireSession({ allowInitial: true });
      const timestamp = checkThrottle();
      if (!validPassword(currentPassword) || !validPassword(newPassword, 12)) {
        throw authError(400, "当前密码不能为空，新密码须为 12–128 个字符");
      }
      if (!matches(currentPassword, credentials)) rejectPassword(timestamp);
      if (matches(newPassword, credentials)) throw authError(400, "新密码不能与当前密码相同");
      const salt = randomBytes(32).toString("hex");
      const next = {
        version: 1, username: USER.username, salt,
        hash: scryptSync(newPassword, salt, 64).toString("hex"),
        mustChangePassword: false,
      };
      try { writeCredentials(file, next); }
      catch { throw authError(500, "密码未能保存，请检查本机存储后重试"); }
      // Never acknowledge a new password or unlock protected features until the
      // replacement record has been successfully committed to disk.
      credentials = next;
      failures = 0;
      lockedUntil = 0;
      return response();
    },
  });
}

module.exports = { createLocalAuth };
