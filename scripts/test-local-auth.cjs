"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, scryptSync } = require("node:crypto");
const { createLocalAuth } = require("../apps/desktop/electron/local-auth.cjs");

function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blade-local-auth-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const password = randomBytes(24).toString("base64url");
  const salt = randomBytes(32).toString("hex");
  const bootstrap = {
    version: 1, username: "admin", salt,
    hash: scryptSync(password, salt, 64).toString("hex"),
  };
  const file = path.join(directory, "credentials.json");
  const options = { file, bootstrap, ...extra };
  return { directory, file, password, bootstrap, options, auth: createLocalAuth(options) };
}

function status(expected) {
  return (error) => error instanceof Error && error.status === expected;
}

test("bootstrap creates only a salted hash, private file, and no initial session", (t) => {
  const f = fixture(t);
  assert.throws(() => f.auth.session(), status(401));
  assert.throws(() => f.auth.requireSession(), status(401));
  const raw = fs.readFileSync(f.file, "utf8");
  assert.equal(raw.includes(f.password), false);
  assert.deepEqual(JSON.parse(raw), { ...f.bootstrap, mustChangePassword: true });
  if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.directory), ["credentials.json"]);
});

test("incorrect username and password are rejected without disclosing credentials", (t) => {
  const f = fixture(t);
  for (const [username, password] of [["someone", f.password], ["admin", "incorrect"]]) {
    assert.throws(() => f.auth.login(username, password), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message, "账号或密码错误");
      assert.equal(JSON.stringify(error).includes(f.bootstrap.hash), false);
      return true;
    });
    assert.throws(() => f.auth.session(), status(401));
  }
});

test("first login is restricted until password changes; returned objects cannot mutate auth", (t) => {
  const f = fixture(t);
  const login = f.auth.login("admin", f.password);
  assert.deepEqual(login, {
    user: { username: "admin", name: "本机管理员", role: "admin" }, mustChangePassword: true,
  });
  assert.throws(() => f.auth.requireSession(), status(403));
  assert.equal(f.auth.requireSession({ allowInitial: true }).role, "admin");
  login.user.username = "other";
  login.mustChangePassword = false;
  assert.equal(f.auth.session().user.username, "admin");
  assert.equal(f.auth.session().mustChangePassword, true);
  const newPassword = randomBytes(24).toString("base64url");
  assert.equal(f.auth.changePassword(f.password, newPassword).mustChangePassword, false);
  assert.equal(f.auth.requireSession().username, "admin");
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.notEqual(saved.salt, f.bootstrap.salt);
  assert.notEqual(saved.hash, f.bootstrap.hash);
  assert.equal(saved.mustChangePassword, false);
  assert.equal(JSON.stringify(saved).includes(newPassword), false);
});

test("changed credentials survive restart, old password expires, and session does not persist", (t) => {
  const f = fixture(t);
  const newPassword = randomBytes(24).toString("base64url");
  f.auth.login("admin", f.password);
  f.auth.changePassword(f.password, newPassword);
  const before = fs.readFileSync(f.file, "utf8");
  const restarted = createLocalAuth({ file: f.file });
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.throws(() => restarted.session(), status(401));
  assert.throws(() => restarted.login("admin", f.password), status(401));
  assert.equal(restarted.login("admin", newPassword).mustChangePassword, false);
  assert.deepEqual(restarted.logout(), { ok: true });
  assert.throws(() => restarted.session(), status(401));
  assert.throws(() => restarted.changePassword(newPassword, f.password), status(401));
});

test("existing credentials are never replaced by a different bootstrap", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, "utf8");
  const restarted = createLocalAuth({ file: f.file, bootstrap: { ...f.bootstrap, hash: "0".repeat(128) } });
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(restarted.login("admin", f.password).mustChangePassword, true);
});

test("missing or malformed password fields and length boundaries are rejected", (t) => {
  const f = fixture(t);
  for (const [username, password] of [
    [undefined, undefined], [null, null], ["", f.password], [123, f.password],
    ["a".repeat(65), f.password], ["admin", ""], ["admin", {}], ["admin", "x".repeat(129)],
  ]) assert.throws(() => f.auth.login(username, password), status(400));
  f.auth.login("admin", f.password);
  for (const [current, next] of [
    [undefined, undefined], ["", "x".repeat(12)], [f.password, "x".repeat(11)],
    [f.password, "x".repeat(129)], [f.password, {}], ["x".repeat(129), "x".repeat(12)],
  ]) assert.throws(() => f.auth.changePassword(current, next), status(400));
  assert.throws(() => f.auth.changePassword(f.password, f.password), status(400));
  assert.throws(() => f.auth.changePassword("incorrect", randomBytes(12).toString("hex")), status(401));
  const twelve = randomBytes(9).toString("base64url");
  assert.equal(twelve.length, 12);
  f.auth.changePassword(f.password, twelve);
  const maximum = randomBytes(96).toString("base64url");
  assert.equal(maximum.length, 128);
  f.auth.changePassword(twelve, maximum);
  f.auth.logout();
  assert.equal(f.auth.login("admin", maximum).user.username, "admin");
});

test("five failed checks lock login for 60 seconds and logout does not reset the lock", (t) => {
  let currentTime = 10_000;
  const f = fixture(t, { now: () => currentTime });
  for (let index = 0; index < 4; index++) assert.throws(() => f.auth.login("admin", "wrong"), status(401));
  assert.throws(() => f.auth.login("admin", "wrong"), status(429));
  f.auth.logout();
  assert.throws(() => f.auth.login("admin", f.password), (error) => error.status === 429 && error.retryAfterSeconds === 60);
  currentTime += 59_999;
  assert.throws(() => f.auth.login("admin", f.password), status(429));
  currentTime += 1;
  assert.equal(f.auth.login("admin", f.password).mustChangePassword, true);
  for (let index = 0; index < 4; index++) assert.throws(() => f.auth.changePassword("wrong", "x".repeat(12)), status(401));
  assert.throws(() => f.auth.changePassword("wrong", "x".repeat(12)), status(429));
  assert.throws(() => f.auth.changePassword(f.password, "x".repeat(12)), status(429));
});

test("damaged, oversized, redirected, or invalid credential files fail closed", (t) => {
  const f = fixture(t);
  for (const content of [
    "{", "null", "[]", "x".repeat(4097),
    JSON.stringify({ ...f.bootstrap, mustChangePassword: "false" }),
    JSON.stringify({ ...f.bootstrap, hash: "invalid", mustChangePassword: false }),
    JSON.stringify({ ...f.bootstrap, username: "root", mustChangePassword: false }),
  ]) {
    fs.writeFileSync(f.file, content);
    assert.throws(() => createLocalAuth(f.options), status(500));
    assert.equal(fs.readFileSync(f.file, "utf8"), content);
  }
  fs.unlinkSync(f.file);
  fs.mkdirSync(f.file);
  assert.throws(() => createLocalAuth(f.options), status(500));
  fs.rmdirSync(f.file);
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(f.directory, "missing-target.json"), f.file);
    assert.throws(() => createLocalAuth(f.options), status(500));
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
  }
});

test("failed initial persistence creates no usable default account", (t) => {
  const f = fixture(t);
  const blocked = path.join(f.directory, "not-a-directory");
  fs.writeFileSync(blocked, "preserve");
  assert.throws(() => createLocalAuth({ file: path.join(blocked, "credentials.json"), bootstrap: f.bootstrap }), status(500));
  assert.equal(fs.readFileSync(blocked, "utf8"), "preserve");
  assert.throws(() => createLocalAuth({ file: path.join(f.directory, "new.json"), bootstrap: {} }), status(500));
  assert.equal(fs.existsSync(path.join(f.directory, "new.json")), false);
});

test("failed atomic password update preserves old credentials and initial-login restriction", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, "utf8");
  const next = randomBytes(24).toString("base64url");
  f.auth.login("admin", f.password);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(Error("simulated disk failure"), { code: "ENOSPC" }); };
  try {
    assert.throws(() => f.auth.changePassword(f.password, next), status(500));
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(f.auth.session().mustChangePassword, true);
  assert.throws(() => f.auth.requireSession(), status(403));
  assert.deepEqual(fs.readdirSync(f.directory), ["credentials.json"]);
  f.auth.logout();
  assert.throws(() => f.auth.login("admin", next), status(401));
  assert.equal(f.auth.login("admin", f.password).mustChangePassword, true);
});

test("initial publication cannot overwrite credentials created concurrently", (t) => {
  const f = fixture(t);
  const initialFile = path.join(f.directory, "raced.json");
  const competing = { ...f.bootstrap, mustChangePassword: false };
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    if (to === initialFile) fs.writeFileSync(initialFile, JSON.stringify(competing), { flag: "wx", mode: 0o600 });
    return link(from, to);
  };
  try {
    const auth = createLocalAuth({ file: initialFile, bootstrap: { ...f.bootstrap, hash: "0".repeat(128) } });
    assert.equal(auth.login("admin", f.password).mustChangePassword, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(initialFile, "utf8")), competing);
  } finally { fs.linkSync = link; }
});
