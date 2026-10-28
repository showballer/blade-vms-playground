// Loopback-only API/database acceptance. Every fixture belongs to a fresh QA
// tenant; existing wind farms, waveforms, accounts and analysis rows are untouched.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { pool, passwordHash, type User } from "../apps/web/lib/db";
import { listMeasurementRows } from "../apps/web/lib/measurement-store";
import { conditionWindow } from "../packages/ui/src/measurement-domain";

const root = process.cwd(), origin = "http://127.0.0.1:3210";
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
assert.equal(process.env.DB_NAME, "blade_vms_playground");
assert(["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST || ""), "Only a loopback database is allowed");
const tenant = "qa-wind-dataset-" + randomUUID(), otherTenant = "qa-wind-dataset-" + randomUUID();
type Account = User & { token: string; sessionId: string };
const accounts: Account[] = [];
const report = { passed: false, productionDataTouched: false, hardwareTouched: false, totalRows: 180123, checks: [] as string[] };
const datasetId = randomUUID(), foreignId = randomUUID(), historyId = randomUUID(), captureId = randomUUID().replaceAll("-", "");
const units = { windSpeed: "m/s", rpm: "rpm", temperatureC: "°C" };
const start = Date.parse("2025-12-23T01:00:00Z");
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const entries = Array.from({ length: report.totalRows }, (_, index) => ({ time: new Date(start + index * 1000).toISOString(), turbineCode: "QA-R018",
  windSpeed: index % 20, ...(index === 1 ? {} : { rpm: index % 10 }), temperatureC: -13 }));
async function main() {
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
let failure: unknown;
function check(name: string) { report.checks.push(name); console.log("PASS " + name); }
async function api(account: Account | null, resource: string, method = "GET", body?: unknown, expected = 200) {
  const response = await fetch(origin + "/api/v1/" + resource, { method,
    headers: { "content-type": "application/json", ...(account ? { authorization: "Bearer " + account.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  assert.equal(response.status, expected, resource + ": " + String(result.error || response.status));
  return result;
}
async function insertRecord(id: string, kind: string, body: unknown, account: Account) {
  await db.execute("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,?,?,?,?)", [id, kind, account.tenant, JSON.stringify(body), account.id]);
}
try {
  for (const [role, group] of [["analyst", tenant], ["admin", tenant], ["operator", tenant], ["viewer", tenant], ["admin", otherTenant]] as const) {
    const token = randomBytes(32).toString("base64url"), id = randomUUID(), username = "qa-wind-" + randomUUID(), sessionId = randomUUID();
    await db.execute("INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,1)",
      [id, username, "QA wind dataset " + role, passwordHash(randomBytes(24).toString("hex")), role, group]);
    await db.execute("INSERT INTO sessions(id,token_hash,user_id,kind,name,expires_at) VALUES(?,?,?,'session',?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 10 MINUTE))",
      [sessionId, createHash("sha256").update(token).digest("hex"), id, "isolated wind pagination/delete acceptance"]);
    accounts.push({ id, username, name: "QA wind dataset " + role, role, tenant: group, active: 1, token, sessionId });
  }
  const [analyst, admin, operator, viewer, outsider] = accounts;
  const farm = (await api(analyst, "objects", "POST", { kind: "farm", code: "QA-FARM", name: "QA wind dataset farm", parentId: null })).object;
  const turbine = (await api(analyst, "objects", "POST", { kind: "turbine", code: "QA-R018", name: "QA R018", parentId: farm.id })).object;
  const body = { name: "QA 180123-row paged conditions", farmId: farm.id, rows: entries, units, importedAt: new Date().toISOString() };
  await insertRecord(datasetId, "wind_datasets", body, analyst);
  await insertRecord(foreignId, "wind_datasets", { ...body, rows: entries.slice(0, 2) }, outsider);
  await insertRecord(historyId, "measurement_results", { name: "QA immutable historical conclusion", condition: { status: "matched", datasetIds: [datasetId], windSpeed: 0, rpm: 0 }, assessment: { level: "review", reason: "QA snapshot" } }, analyst);
  const captureBody = { recording: { id: randomUUID().replaceAll("-", ""), name: "QA metadata capture", status: "complete", samples: 1,
    sampleRate: 1, source: "test_fixture", diagnosticOnly: true, validMeasurement: false }, uploadState: "complete", fixtureOnly: true };
  await db.execute("INSERT INTO captures(id,owner_id,tenant,client_id,local_id,body) VALUES(?,?,?,?,?,?)",
    [captureId, analyst.id, tenant, "qa-wind-delete", captureBody.recording.id, JSON.stringify(captureBody)]);

  const first = await api(analyst, `wind-datasets/${datasetId}/rows`);
  assert.deepEqual(Object.keys(first).sort(), ["id", "name", "total", "offset", "limit", "rows", "units"].sort());
  assert.equal(first.id, datasetId); assert.equal(first.name, body.name); assert.equal(first.total, entries.length);
  assert.equal(first.offset, 0); assert.equal(first.limit, 50); assert.deepEqual(first.rows, entries.slice(0, 50)); assert.deepEqual(first.units, units);
  assert(Buffer.byteLength(JSON.stringify(first)) < 15000, "A page must not transmit the full 180k-row dataset");
  assert.equal(first.rows[0].windSpeed, 0); assert.equal(first.rows[0].rpm, 0); assert(!("rpm" in first.rows[1]), "Missing metrics remain missing");
  for (const account of [operator, viewer]) assert.deepEqual((await api(account, `wind-datasets/${datasetId}/rows?limit=1`)).rows, [entries[0]]);
  check("Default 50-row preview stays bounded for 180123 rows, with units, exact values, zeroes and missing fields preserved");

  const middle = await api(analyst, `wind-datasets/${datasetId}/rows?offset=100&limit=100`);
  assert.deepEqual(middle.rows, entries.slice(100, 200));
  const last = await api(analyst, `wind-datasets/${datasetId}/rows?offset=${entries.length - 3}&limit=50`);
  assert.deepEqual(last.rows, entries.slice(-3)); assert.equal(last.limit, 50);
  for (const offset of [entries.length, entries.length + 100, Number.MAX_SAFE_INTEGER]) {
    const empty = await api(analyst, `wind-datasets/${datasetId}/rows?offset=${offset}&limit=100`);
    assert.deepEqual(empty.rows, []); assert.equal(empty.total, entries.length); assert.equal(empty.offset, offset);
  }
  check("Middle, final short page, exact end, beyond end and huge safe offsets return the correct slice without SQL path overflow");

  for (const [timestamp, expected] of [[start - 1000, 0], [start + 900000, 900], [start + 900500, 901],
    [start + (entries.length - 1) * 1000, entries.length - 1], [start + entries.length * 1000, entries.length]] as const) {
    const jumped = await api(analyst, `wind-datasets/${datasetId}/rows?at=${encodeURIComponent(new Date(timestamp).toISOString())}&limit=3`);
    assert.equal(jumped.offset, expected); assert.equal(jumped.total, entries.length); assert.equal(jumped.limit, 3);
    assert.deepEqual(jumped.rows, entries.slice(expected, expected + 3));
  }
  assert.equal((await api(viewer, `wind-datasets/${datasetId}/rows?at=2025-12-23T01:15:00Z&limit=1`)).offset, 900);
  for (const value of ["", "not-a-time", "2025-02-30T01:00:00Z", "2025-12-23", "2025-12-23T01:00:00", "2025-12-23T25:00:00Z"])
    await api(analyst, `wind-datasets/${datasetId}/rows?at=${encodeURIComponent(value)}`, "GET", undefined, 400);
  for (const query of ["at=2025-12-23T01:00:00Z&offset=0", "at=2025-12-23T01:00:00Z&at=2025-12-23T01:00:00Z"])
    await api(analyst, `wind-datasets/${datasetId}/rows?${query}`, "GET", undefined, 400);
  await api(outsider, `wind-datasets/${datasetId}/rows?at=2025-12-23T01:00:00Z`, "GET", undefined, 404);
  check("UTC time jump finds the first row at/after a time, handles before/after coverage, rejects invalid/conflicting arguments and preserves tenant isolation");

  for (const query of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=1e2", "limit=", "limit=NaN", "limit=2&limit=3",
    "offset=-1", "offset=1.5", "offset=1e2", "offset=", "offset=NaN", "offset=9007199254740992", "offset=0&offset=1"])
    await api(analyst, `wind-datasets/${datasetId}/rows?${query}`, "GET", undefined, 400);
  await api(null, `wind-datasets/${datasetId}/rows`, "GET", undefined, 401);
  await api(null, `wind-datasets/${datasetId}`, "DELETE", undefined, 401);
  check("Invalid, fractional, duplicate, empty and oversized pagination parameters return 400; unauthenticated reads/deletes return 401");

  for (const account of [operator, viewer]) await api(account, `wind-datasets/${datasetId}`, "DELETE", undefined, 403);
  for (const [account, id] of [[outsider, datasetId], [analyst, foreignId], [admin, foreignId]] as [Account, string][]) {
    await api(account, `wind-datasets/${id}/rows`, "GET", undefined, 404);
    await api(account, `wind-datasets/${id}`, "DELETE", undefined, 404);
  }
  for (const id of [farm.id, turbine.id, historyId, randomUUID()]) {
    await api(analyst, `wind-datasets/${id}/rows`, "GET", undefined, 404);
    await api(analyst, `wind-datasets/${id}`, "DELETE", undefined, 404);
  }
  check("Operator/viewer deletion is forbidden; cross-tenant access remains hidden even from admins and wrong-kind records are not deletable");

  const [protectedBefore] = await db.execute("SELECT id,body FROM records WHERE tenant=? AND id IN (?,?,?) ORDER BY id", [tenant, farm.id, turbine.id, historyId]);
  const [captureBefore] = await db.execute("SELECT id,body FROM captures WHERE id=? AND tenant=?", [captureId, tenant]);
  const before = conditionWindow(await listMeasurementRows(analyst, "wind_datasets") as any, farm.id, "QA-R018", start, start + 2000);
  assert.equal(before.status, "matched"); assert.deepEqual(before.datasetIds, [datasetId]);
  const deleted = await api(analyst, `wind-datasets/${datasetId}`, "DELETE");
  assert.deepEqual(deleted, { deleted: true, id: datasetId });
  await api(analyst, `wind-datasets/${datasetId}/rows`, "GET", undefined, 404);
  await api(analyst, `wind-datasets/${datasetId}`, "DELETE", undefined, 404);
  assert(!(await api(analyst, "wind-datasets")).datasets.some((d: any) => d.id === datasetId));
  const after = conditionWindow(await listMeasurementRows(analyst, "wind_datasets") as any, farm.id, "QA-R018", start, start + 2000);
  assert.equal(after.status, "unmatched"); assert.deepEqual(after.datasetIds, []);
  const [protectedAfter] = await db.execute("SELECT id,body FROM records WHERE tenant=? AND id IN (?,?,?) ORDER BY id", [tenant, farm.id, turbine.id, historyId]);
  const [captureAfter] = await db.execute("SELECT id,body FROM captures WHERE id=? AND tenant=?", [captureId, tenant]);
  assert.equal(sha(protectedAfter), sha(protectedBefore)); assert.equal(sha(captureAfter), sha(captureBefore));
  const [audits] = await db.execute<any[]>("SELECT actor_id,tenant,target,result FROM audit_logs WHERE tenant=? AND action='删除风场工况' AND target=?", [tenant, datasetId]);
  assert.equal(audits.length, 1); assert.deepEqual(audits[0], { actor_id: analyst.id, tenant, target: datasetId, result: "成功" });
  assert.equal((await api(outsider, `wind-datasets/${foreignId}/rows`)).total, 2);
  check("Transactional deletion is audited once, stops fresh condition matching and preserves farm/turbine, waveform metadata, foreign data and historical conclusions");

  const adminDatasetId = randomUUID();
  await insertRecord(adminDatasetId, "wind_datasets", { ...body, rows: entries.slice(0, 1) }, admin);
  assert.deepEqual(await api(admin, `wind-datasets/${adminDatasetId}`, "DELETE"), { deleted: true, id: adminDatasetId });
  check("Same-tenant administrators retain explicit delete permission");
  report.passed = true;
} catch (error) {
  failure = error; console.error(error instanceof Error ? error.stack : String(error));
} finally {
  try {
    assert(tenant.startsWith("qa-wind-dataset-") && otherTenant.startsWith("qa-wind-dataset-"));
    for (const table of ["records", "audit_logs", "captures"])
      await db.execute(`DELETE FROM ${table} WHERE tenant IN (?,?)`, [tenant, otherTenant]);
    for (const account of accounts) {
      await db.execute("DELETE FROM sessions WHERE id=? AND user_id=?", [account.sessionId, account.id]);
      await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [account.id, account.tenant]);
    }
    const [remaining] = await db.execute<any[]>("SELECT COUNT(*) count FROM records WHERE tenant IN (?,?)", [tenant, otherTenant]);
    assert.equal(Number(remaining[0].count), 0);
  } catch (error) { failure ||= error; report.passed = false; console.error("QA cleanup failed"); }
  await db.end(); await pool().end();
  const output = path.join(root, "artifacts/wind-dataset-management-20261028");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "api-validation.json"), JSON.stringify(report, null, 2));
}
if (failure) process.exitCode = 1;
else console.log(`PASS ${report.checks.length} wind dataset API checks; QA fixtures removed, production wind data untouched`);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
