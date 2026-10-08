"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, scryptSync } = require("node:crypto");
const { createLocalAuth } = require("../apps/desktop/electron/local-auth.cjs");
const { createUnifiedAuth } = require("../apps/desktop/electron/unified-auth.cjs");

const DAY = 86_400_000;
const ORIGIN = "http://127.0.0.1:3210";
const status = expected => error => error instanceof Error && error.status === expected;
const json = (data, code = 200, headers) => new Response(JSON.stringify(data), { status: code, headers: { "content-type": "application/json", ...headers } });
const network = (code = "ECONNREFUSED") => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("network unavailable"), { code }) });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; }

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blade-unified-auth-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "unified.json");
  const localFile = path.join(directory, "local.json");
  const bootstrapPassword = "bootstrap-fixture-12345";
  const localPassword = "local-password-fixture-12345";
  const salt = randomBytes(32).toString("hex");
  let time = 1_800_000_000_000;
  const localAuth = createLocalAuth({ file: localFile, now: () => time,
    bootstrap: { version: 1, username: "admin", salt, hash: scryptSync(bootstrapPassword, salt, 64).toString("hex") } });
  localAuth.login("admin", bootstrapPassword);
  localAuth.changePassword(bootstrapPassword, localPassword);
  const localContents = fs.readFileSync(localFile, "utf8");
  const server = { password: "shared-Web-password-fixture-12345", handler: null,
    user: { id: "web-user-1", username: "web-admin", name: "统一管理员", role: "admin", tenant: "tenant-1", active: 1 },
    requests: [], tokens: [], passwordCalls: 0, cleanupCalls: 0 };
  async function respond(url, options) {
    if (options.method === "DELETE") { server.cleanupCalls++; return json({ ok: true }); }
    const body = JSON.parse(options.body);
    if (url.endsWith("/api/v1/account/password")) {
      server.passwordCalls++;
      if (!server.tokens.some(token => options.headers.Authorization === `Bearer ${token}`)) return json({ error: "missing token" }, 401);
      if (body.currentPassword !== server.password) return json({ error: "wrong current" }, 401);
      server.password = body.newPassword;
      return json({ ok: true, reauthenticate: true });
    }
    if (!url.endsWith("/api/v1/session")) throw Error("Unexpected test endpoint");
    if (body.username !== server.user.username || body.password !== server.password) return json({ error: "wrong credentials" }, 401);
    const token = randomBytes(32).toString("base64url"); server.tokens.push(token);
    return json({ user: { ...server.user, password_hash: "server-secret-hash-not-to-store" }, token });
  }
  const fetchImpl = async (url, options) => {
    server.requests.push({ url, options });
    return server.handler ? server.handler(url, options, respond) : respond(url, options);
  };
  const options = { file, localAuth, now: () => time, fetchImpl };
  const auth = createUnifiedAuth(options);
  return { directory, file, localFile, localAuth, localPassword, localContents, server, auth, options,
    get time() { return time; }, advance(ms) { time += ms; }, setTime(value) { time = value; },
    async bind(serverUrl = ORIGIN) { return auth.bindAccount({ serverUrl, username: server.user.username, password: server.password, currentPassword: localPassword }); },
    offline(code) { server.handler = () => { throw network(code); }; },
  };
}

test("unbound mode proxies every local method and does not infer same-name bindings", async t => {
  const f = fixture(t);
  assert.deepEqual(f.auth.info(), { mode: "local" });
  assert.deepEqual(f.auth.session(), f.localAuth.session());
  assert.deepEqual(f.auth.requireSession(), f.localAuth.requireSession());
  assert.deepEqual(f.auth.logout(), { ok: true });
  assert.throws(() => f.auth.session(), status(401));
  assert.equal((await f.auth.login("admin", f.localPassword)).user.username, "admin");
  const next = "new-local-fixture-password";
  await f.auth.changePassword(f.localPassword, next);
  f.auth.logout();
  assert.equal((await f.auth.login("admin", next)).user.username, "admin");
  assert.equal(f.server.requests.length, 0);
  assert.equal(fs.existsSync(f.file), false);
});

test("binding requires a current local session and rechecks local password before contacting Web", async t => {
  const f = fixture(t);
  f.auth.logout();
  await assert.rejects(f.bind(), status(401));
  await f.auth.login("admin", f.localPassword);
  await assert.rejects(f.auth.bindAccount({ serverUrl: ORIGIN, username: f.server.user.username, password: f.server.password, currentPassword: "wrong" }), status(401));
  assert.equal(f.server.requests.length, 0);
  assert.equal(fs.existsSync(f.file), false);
});

test("origins are exact and normalized aliases, paths and URL credentials are rejected", async t => {
  const f = fixture(t);
  for (const origin of ["http://127.1:3210", "http://2130706433", "http://0x7f000001", "http://%31%32%37.0.0.1", "http://localhost.", "HTTP://localhost", "https://x.test/path", "https://x.test/?q=1", "https://x.test/#x", "https://user:secret@x.test", "http://user:secret@115.190.201.41:3000", "http://115.190.201.41:3000/path", "http://115.190.201.41:3000?to=evil", "https://x.test\\evil", " https://x.test", "ftp://x.test", "https://x.test:99999"]) {
    await assert.rejects(f.bind(origin), status(400), origin);
  }
  assert.equal(f.server.requests.length, 0);
  await f.bind("https://web.example.test:443/");
  assert.equal(f.auth.info().serverUrl, "https://web.example.test");
  assert.ok(f.server.requests.every(request => request.options.redirect === "error" && request.options.signal instanceof AbortSignal));
});

test("remote HTTP supports binding, refreshed Web passwords and offline login without following redirects", async t => {
  const f = fixture(t);
  const origin = "http://115.190.201.41:3000";
  await f.bind(origin);
  assert.equal(f.auth.info().serverUrl, origin);
  f.auth.logout();
  f.server.password = "updated-web-password-fixture";
  await f.auth.login(f.server.user.username, f.server.password);
  assert.equal(f.auth.info().offline, false);
  const restarted = createUnifiedAuth(f.options);
  f.offline();
  const result = await restarted.login(f.server.user.username, f.server.password);
  assert.equal(result.account.offline, true);
  assert.ok(f.server.requests.every(request => request.url.startsWith(origin + "/api/v1/") && request.options.redirect === "error"));
});

test("binding stores only an independent salted verifier, preserves local credentials and cleans Web token", async t => {
  const f = fixture(t);
  const session = await f.bind();
  assert.equal(session.user.username, f.server.user.username);
  assert.equal(session.mustChangePassword, false);
  assert.equal(session.account.offline, false);
  assert.equal(session.account.lastVerifiedAt, f.time);
  assert.equal(session.account.offlineUntil, f.time + 30 * DAY);
  assert.equal(f.auth.info().syncPolicy, "login-only");
  const record = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.deepEqual(record.user, { id: "web-user-1", username: "web-admin", name: "统一管理员", role: "admin", tenant: "tenant-1" });
  assert.equal(record.hash, scryptSync(f.server.password, record.salt, 64).toString("hex"));
  for (const secret of [f.server.password, f.localPassword, "server-secret-hash-not-to-store", ...f.server.tokens]) assert.equal(fs.readFileSync(f.file, "utf8").includes(secret), false);
  assert.equal(fs.readFileSync(f.localFile, "utf8"), f.localContents);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(f.server.cleanupCalls, 1);
  assert.throws(() => f.localAuth.session(), status(401));
  const restarted = createUnifiedAuth(f.options);
  assert.throws(() => restarted.session(), status(401));
  assert.equal(restarted.info().mode, "unified");
  await assert.rejects(f.bind(), status(409));
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["local.json", "unified.json"]);
});

test("admin, analyst and operator may bind but viewer cannot", async t => {
  for (const role of ["admin", "analyst", "operator", "viewer"]) {
    const f = fixture(t); f.server.user.role = role;
    if (role === "viewer") {
      await assert.rejects(f.bind(), status(403));
      assert.equal(f.auth.info().mode, "local");
      assert.equal(fs.existsSync(f.file), false);
    } else assert.equal((await f.bind()).user.role, role);
  }
});

test("online login always contacts Web, refreshes cache from input and does not persist a bearer", async t => {
  const f = fixture(t); await f.bind();
  const old = JSON.parse(fs.readFileSync(f.file, "utf8"));
  f.auth.logout(); f.advance(DAY);
  const result = await f.auth.login(f.server.user.username, f.server.password);
  assert.equal(result.account.offline, false);
  assert.equal(result.account.lastVerifiedAt, f.time);
  const current = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.notEqual(current.salt, old.salt);
  assert.equal(f.server.requests.filter(item => item.options.method === "POST").length, 2);
  assert.equal(f.server.cleanupCalls, 2);
  for (const token of f.server.tokens) assert.equal(JSON.stringify(current).includes(token), false);
});

test("a genuine connection failure allows only the bound account and never extends the offline deadline", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout(); f.advance(DAY); f.offline();
  const deadline = f.auth.info().offlineUntil;
  const result = await f.auth.login(f.server.user.username, f.server.password);
  assert.equal(result.account.offline, true);
  assert.equal(result.account.offlineUntil, deadline);
  assert.equal(result.account.lastVerifiedAt, f.time - DAY);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).lastObservedAt, f.time);
  f.auth.logout();
  await assert.rejects(f.auth.login("admin", f.localPassword), status(401));
  await assert.rejects(f.auth.login(f.server.user.username, "wrong"), status(401));
  assert.throws(() => f.auth.session(), status(401));
});

test("401 and 403 persist revocation so an old cached password cannot succeed after restart", async t => {
  for (const code of [401, 403]) {
    const f = fixture(t); await f.bind(); f.auth.logout();
    f.server.handler = () => json({ error: "denied" }, code);
    await assert.rejects(f.auth.login(f.server.user.username, f.server.password), status(code));
    assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).onlineRequired, true);
    f.offline();
    const restarted = createUnifiedAuth(f.options);
    await assert.rejects(restarted.login(f.server.user.username, f.server.password), status(403));
    assert.throws(() => restarted.session(), status(401));
  }
});

test("identity, tenant, role and active state changes disable cache without interrupting an existing session", async t => {
  for (const change of [{ id: "other-id" }, { username: "other-name" }, { tenant: "other-tenant" }, { role: "viewer" }, { active: 0 }]) {
    const f = fixture(t); await f.bind(); Object.assign(f.server.user, change);
    await assert.rejects(f.auth.login(f.server.user.username, f.server.password), status(403));
    assert.equal(f.auth.info().onlineRequired, true);
    assert.equal(f.auth.requireSession().username, "web-admin");
    f.auth.logout(); f.offline();
    await assert.rejects(f.auth.login("web-admin", f.server.password), status(403));
  }
});

test("HTTP throttling, server errors, malformed/oversize responses, redirects and TLS failures never use cache", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout();
  const cases = [
    [() => json({ error: "throttled" }, 429), 429], [() => json({ error: "upstream" }, 503), 503],
    [() => new Response("not-json"), 502], [() => json({ user: null }), 502],
    [() => json({ padding: "x".repeat(65536) }), 502], [() => json({}, 200, { "content-length": "65537" }), 502],
    [() => { throw new TypeError("unexpected redirect"); }, 503],
    [() => { throw network("CERT_HAS_EXPIRED"); }, 503], [() => { throw new Error("application bug"); }, 503],
    [() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"user":')); controller.error(network("ECONNRESET")); } })), 502],
  ];
  for (const [handler, expected] of cases) {
    f.server.handler = handler;
    await assert.rejects(f.auth.login(f.server.user.username, f.server.password), status(expected));
    assert.throws(() => f.auth.session(), status(401));
  }
  assert.equal(f.auth.info().onlineRequired, false);
});

test("offline expiration and clock rollback survive restart and require fresh online verification", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout();
  const verifiedAt = f.time;
  f.advance(5 * DAY); f.offline();
  await f.auth.login(f.server.user.username, f.server.password); f.auth.logout();
  f.advance(-DAY);
  const restarted = createUnifiedAuth(f.options);
  await assert.rejects(restarted.login(f.server.user.username, f.server.password), status(403));
  f.setTime(verifiedAt + 30 * DAY);
  await assert.rejects(restarted.login(f.server.user.username, f.server.password), status(403));
  f.server.handler = null;
  const online = await restarted.login(f.server.user.username, f.server.password);
  assert.equal(online.account.offline, false);
  assert.equal(online.account.offlineUntil, f.time + 30 * DAY);
});

test("an observed expiry or clock rollback permanently requires online verification even after a restart and corrected clock", async t => {
  for (const reason of ["expired", "clock-rollback"]) {
    const f = fixture(t); await f.bind(); f.auth.logout(); f.offline();
    const verifiedAt = f.time;
    f.advance(DAY);
    await f.auth.login("web-admin", f.server.password); f.auth.logout();
    f.setTime(verifiedAt + (reason === "expired" ? 30 * DAY : DAY - 1));
    await assert.rejects(f.auth.login("web-admin", f.server.password), status(403));
    assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).onlineRequired, true);
    f.setTime(verifiedAt + 2 * DAY);
    const restarted = createUnifiedAuth(f.options);
    await assert.rejects(restarted.login("web-admin", f.server.password), status(403));
    f.server.handler = null;
    assert.equal((await restarted.login("web-admin", f.server.password)).account.onlineRequired, false);
    restarted.logout(); f.offline();
    assert.equal((await restarted.login("web-admin", f.server.password)).account.offline, true);
  }
});

test("the eight-second connection deadline allows offline use but a stalled response body does not", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout();
  const nativeTimeout = global.setTimeout;
  const deadlines = [];
  t.mock.method(global, "setTimeout", (callback, delay, ...args) => {
    deadlines.push(delay);
    return nativeTimeout(callback, delay === 8000 ? 8 : delay, ...args);
  });
  f.server.handler = () => new Promise(() => {});
  assert.equal((await f.auth.login("web-admin", f.server.password)).account.offline, true);
  assert.equal(f.server.requests.at(-1).options.signal.aborted, true);
  f.auth.logout();
  let bodyController;
  f.server.handler = () => new Response(new ReadableStream({ start(controller) { bodyController = controller; } }));
  await assert.rejects(f.auth.login("web-admin", f.server.password), status(503));
  bodyController.error(new Error("Test stream teardown"));
  assert.throws(() => f.auth.session(), status(401));
  assert.deepEqual(deadlines, [8000, 8000]);
});

test("password whitespace is preserved identically online, offline and during a password change", async t => {
  const f = fixture(t); f.server.password = "  shared password with spaces  "; await f.bind(); f.auth.logout(); f.offline();
  await assert.rejects(f.auth.login("web-admin", f.server.password.trim()), status(401));
  assert.equal((await f.auth.login("web-admin", f.server.password)).account.offline, true);
  f.server.handler = null;
  const old = f.server.password, next = " next shared password with spaces ";
  await f.auth.changePassword(old, next);
  assert.equal(f.server.password, next);
  f.auth.logout(); f.offline();
  assert.equal((await f.auth.login("web-admin", next)).account.offline, true);
});

test("five local offline failures lock for sixty seconds and logout cannot reset throttling", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout(); f.offline();
  for (let i = 0; i < 4; i++) await assert.rejects(f.auth.login("web-admin", "wrong"), status(401));
  await assert.rejects(f.auth.login("web-admin", "wrong"), status(429));
  const calls = f.server.requests.length;
  f.auth.logout();
  await assert.rejects(f.auth.login("web-admin", f.server.password), error => error.status === 429 && error.retryAfterSeconds === 60);
  assert.equal(f.server.requests.length, calls);
  f.advance(60_000);
  assert.equal((await f.auth.login("web-admin", f.server.password)).account.offline, true);
});

test("unified password change reauthenticates, uses an ephemeral token, refreshes cache and preserves local auth", async t => {
  const f = fixture(t); await f.bind();
  const old = f.server.password, next = "new-shared-Web-password-12345";
  const result = await f.auth.changePassword(old, next);
  assert.equal(result.account.offline, false);
  assert.equal(f.server.passwordCalls, 1);
  assert.equal(f.server.password, next);
  assert.equal(fs.readFileSync(f.localFile, "utf8"), f.localContents);
  const mutation = f.server.requests.find(item => item.url.endsWith("/account/password"));
  assert.deepEqual(JSON.parse(mutation.options.body), { currentPassword: old, newPassword: next });
  assert.match(mutation.options.headers.Authorization, /^Bearer /);
  f.auth.logout(); f.offline();
  await assert.rejects(f.auth.login("web-admin", old), status(401));
  assert.equal((await f.auth.login("web-admin", next)).account.offline, true);
});

test("lost password-update response cannot report success or leave the old offline password usable", async t => {
  const f = fixture(t); await f.bind();
  const old = f.server.password, next = "changed-but-response-lost-12345";
  f.server.handler = async (url, options, respond) => {
    const result = await respond(url, options);
    if (url.endsWith("/account/password")) throw network("ECONNRESET");
    return result;
  };
  await assert.rejects(f.auth.changePassword(old, next), error => error.status === 503 && /新密码联网登录/.test(error.message));
  assert.equal(f.server.password, next);
  assert.equal(f.auth.info().onlineRequired, true);
  assert.equal(f.auth.requireSession().username, "web-admin");
  f.auth.logout(); f.offline();
  const restarted = createUnifiedAuth(f.options);
  await assert.rejects(restarted.login("web-admin", old), status(403));
  await assert.rejects(restarted.login("web-admin", next), status(403));
  f.server.handler = null;
  assert.equal((await restarted.login("web-admin", next)).account.onlineRequired, false);
});

test("offline change and malformed new passwords never send a password mutation", async t => {
  const f = fixture(t); await f.bind();
  for (const [current, next] of [["", "x".repeat(12)], [f.server.password, "x".repeat(11)], [f.server.password, "x".repeat(129)], [f.server.password, f.server.password]]) await assert.rejects(f.auth.changePassword(current, next), status(400));
  f.offline();
  await assert.rejects(f.auth.changePassword(f.server.password, "valid-new-password-123"), status(503));
  assert.equal(f.server.passwordCalls, 0);
  assert.equal(fs.readFileSync(f.localFile, "utf8"), f.localContents);
});

test("damaged, redirected or weakened binding files fail closed without restoring local login", async t => {
  const f = fixture(t); await f.bind();
  const good = fs.readFileSync(f.file, "utf8"), parsed = JSON.parse(good);
  for (const bad of ["{", "null", "x".repeat(8193), JSON.stringify({ ...parsed, extra: "unexpected" }), JSON.stringify({ ...parsed, onlineRequired: "false" }), JSON.stringify({ ...parsed, salt: [parsed.salt] }), JSON.stringify({ ...parsed, hash: [parsed.hash] }), JSON.stringify({ ...parsed, offlineUntil: parsed.offlineUntil + 1 }), JSON.stringify({ ...parsed, user: { ...parsed.user, role: "viewer" } })]) {
    fs.writeFileSync(f.file, bad);
    assert.throws(() => createUnifiedAuth(f.options), status(500));
    assert.equal(fs.readFileSync(f.file, "utf8"), bad);
  }
  fs.unlinkSync(f.file);
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(f.directory, "missing.json"), f.file);
    assert.throws(() => createUnifiedAuth(f.options), status(500));
    fs.unlinkSync(f.file);
  }
  fs.writeFileSync(f.file, good, { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(f.file, 0o644);
    assert.throws(() => createUnifiedAuth(f.options), status(500));
  }
});

test("file corruption after startup blocks subsequent authentication, and failed cleanup does not undo login", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout();
  f.server.handler = (url, options, respond) => options.method === "DELETE" ? Promise.reject(network()) : respond(url, options);
  assert.equal((await f.auth.login("web-admin", f.server.password)).account.offline, false);
  f.auth.logout(); fs.writeFileSync(f.file, "corrupted"); f.offline();
  await assert.rejects(f.auth.login("web-admin", f.server.password), status(500));
});

test("logout cancels an in-flight login and competing authentication cannot publish a late session", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout();
  const waiting = deferred();
  f.server.handler = async (url, options, respond) => { if (options.method === "POST") await waiting.promise; return respond(url, options); };
  const pending = f.auth.login("web-admin", f.server.password);
  await assert.rejects(f.auth.login("web-admin", f.server.password), status(409));
  f.auth.logout(); waiting.resolve();
  await assert.rejects(pending, status(409));
  assert.throws(() => f.auth.session(), status(401));
});

test("failed atomic revocation writes preserve the credential file and a private marker blocks offline use after restart", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout();
  const previous = fs.readFileSync(f.file, "utf8");
  const nativeRename = fs.renameSync;
  const rename = t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === f.file) throw Object.assign(new Error("read-only destination"), { code: "EACCES" });
    return nativeRename(source, destination);
  });
  f.server.handler = () => json({ error: "revoked" }, 401);
  await assert.rejects(f.auth.login("web-admin", f.server.password), error => error.status === 500 && /离线登录已停用/.test(error.message));
  assert.equal(fs.readFileSync(f.file, "utf8"), previous);
  const marker = `${f.file}.online-required`;
  assert.equal(fs.existsSync(marker), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["local.json", "unified.json", "unified.json.online-required"]);
  rename.mock.restore();
  const restarted = createUnifiedAuth(f.options); f.offline();
  assert.equal(restarted.info().onlineRequired, true);
  await assert.rejects(restarted.login("web-admin", f.server.password), status(403));
  assert.equal(fs.existsSync(marker), true);
  f.server.handler = null;
  assert.equal((await restarted.login("web-admin", f.server.password)).account.onlineRequired, false);
  assert.equal(fs.existsSync(marker), false);
});

test("if every persistence write fails, the process forbids offline access and reports the unsaved state without changing Web", async t => {
  const f = fixture(t); await f.bind();
  const previous = fs.readFileSync(f.file, "utf8"), old = f.server.password;
  const rename = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("disk unavailable"), { code: "EIO" }); });
  await assert.rejects(f.auth.changePassword(old, "next-shared-password-12345"), error => error.status === 500 && error.message === "离线凭证失效状态无法保存，请修复本机存储后联网登录");
  assert.equal(f.server.passwordCalls, 0);
  assert.equal(f.server.password, old);
  assert.equal(fs.readFileSync(f.file, "utf8"), previous);
  assert.equal(f.auth.info().onlineRequired, true);
  assert.equal(f.auth.requireSession().username, "web-admin");
  f.auth.logout(); f.offline();
  await assert.rejects(f.auth.login("web-admin", old), status(403));
  rename.mock.restore(); f.server.handler = null;
  assert.equal((await f.auth.login("web-admin", old)).account.onlineRequired, false);
});

test("a marker that cannot be removed never reports online login success and recovers after storage is repaired", async t => {
  const f = fixture(t); await f.bind(); f.auth.logout();
  const marker = `${f.file}.online-required`;
  fs.writeFileSync(marker, JSON.stringify({ version: 1, onlineRequired: true }), { mode: 0o600 });
  const nativeUnlink = fs.unlinkSync;
  const unlink = t.mock.method(fs, "unlinkSync", target => {
    if (target === marker) throw Object.assign(new Error("marker is read-only"), { code: "EACCES" });
    return nativeUnlink(target);
  });
  await assert.rejects(f.auth.login("web-admin", f.server.password), status(500));
  assert.throws(() => f.auth.session(), status(401));
  assert.equal(f.auth.info().onlineRequired, true);
  unlink.mock.restore();
  assert.equal((await f.auth.login("web-admin", f.server.password)).account.onlineRequired, false);
  assert.equal(fs.existsSync(marker), false);
});

test("initial binding refuses to replace another binding created while Web authentication was in flight", async t => {
  const f = fixture(t), existing = fixture(t); await existing.bind();
  const contents = fs.readFileSync(existing.file, "utf8");
  f.server.handler = (url, options, respond) => {
    if (options.method === "POST") fs.writeFileSync(f.file, contents, { mode: 0o600 });
    return respond(url, options);
  };
  await assert.rejects(f.bind(), status(500));
  assert.equal(fs.readFileSync(f.file, "utf8"), contents);
  assert.throws(() => f.auth.session(), status(500));
  await assert.rejects(f.auth.login("admin", f.localPassword), status(500));
});
