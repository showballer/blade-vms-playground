// Real CSV → Python preview/merge → Web validation/storage → paged readback.
// All API/database fixtures are confined to a fresh loopback QA tenant.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { validateWindRows } from "../packages/ui/src/measurement-domain";

const root = process.cwd(), origin = "http://127.0.0.1:3210";
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
assert.equal(process.env.DB_NAME, "blade_vms_playground");
assert(["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST || ""), "Only a loopback database is allowed");
assert(process.argv[2], "Usage: tsx --tsconfig apps/web/tsconfig.json scripts/test-wind-minute-api.ts /path/to/006#_20261018_20261018_minute.csv");
const source = path.resolve(process.argv[2]);
const tenant = "qa-wind-minute-" + randomUUID(), id = randomUUID(), sessionId = randomUUID();
const token = randomBytes(32).toString("base64url"), hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const report: Record<string, any> = { passed: false, sourceFilesUnchanged: false, productionDataTouched: false, hardwareTouched: false, checks: [] };
function check(name: string) { report.checks.push(name); console.log("PASS " + name); }
async function api(resource: string, method = "GET", body?: unknown) {
  const response = await fetch(origin + "/api/v1/" + resource, { method,
    headers: { authorization: "Bearer " + token, ...(body instanceof Buffer ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const result = await response.json();
  assert.equal(response.status, 200, resource + ": " + String(result.error || response.status));
  return result;
}
async function main() {
  const bytes = await readFile(source), beforeHash = hash(bytes);
  // The provided source has exactly seven unquoted fields per row. Parse the
  // original independently of the application's Python mapper for comparisons.
  const lines = new TextDecoder("gb18030").decode(bytes).trim().split(/\r?\n/);
  assert.deepEqual(lines.shift()!.split(","), ["名称", "时间", "风速", "发电机有功功率", "主轴转速", "舱外温度", "风向"]);
  const expected = lines.map(line => {
    const parts = line.split(","); assert.equal(parts.length, 7);
    const [turbineCode, time, windSpeed, powerKw, rpm, temperatureC, windDirection] = parts;
    return { turbineCode, time: new Date(time.replace(" ", "T") + "+08:00").toISOString(),
      windSpeed: Number(windSpeed), powerKw: Number(powerKw), rpm: Number(rpm), temperatureC: Number(temperatureC), windDirection: Number(windDirection) };
  });
  assert.equal(expected.length, 1440); assert(expected.every(row => row.turbineCode === "006#"));
  assert.equal(expected.filter(row => row.powerKw < 0).length, 4); assert.equal(expected.filter(row => row.windDirection < 0).length, 1435);
  const pure = validateWindRows(expected);
  assert.deepEqual(pure, expected);
  for (const windDirection of [-360, -91.279999, 0, 360]) assert.equal(validateWindRows([{ ...expected[0], windDirection }])[0].windDirection, windDirection);
  for (const windDirection of [-360.01, 360.01, NaN, Infinity]) assert.throws(() => validateWindRows([{ ...expected[0], windDirection }]));
  check("Web validation preserves signed direction and negative power exactly; only directions outside -360..360 are rejected");

  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  let failure: unknown;
  try {
    await db.execute("INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,1)",
      [id, "qa-wind-minute-" + randomUUID(), "QA signed minute CSV", "no-login-random-" + randomBytes(32).toString("hex"), "analyst", tenant]);
    await db.execute("INSERT INTO sessions(id,token_hash,user_id,kind,name,expires_at) VALUES(?,?,?,'session',?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 10 MINUTE))",
      [sessionId, hash(token), id, "isolated actual minute CSV acceptance"]);
    const farm = (await api("objects", "POST", { kind: "farm", code: "QA-MINUTE", name: "QA minute CSV farm", parentId: null })).object;
    await api("objects", "POST", { kind: "turbine", code: "006#", name: "006#", parentId: farm.id });
    const preview = await api("wind-datasets/preview-file?filename=" + encodeURIComponent(path.basename(source)), "POST", bytes);
    const units = { windSpeed: "m/s", rpm: "rpm", powerKw: "kW", temperatureC: "C", windDirection: "deg" };
    assert.equal(preview.rowCount, 1440); assert.equal(preview.sourceFormat, "turbine-minute-v1");
    assert.equal(preview.windDirectionReference, "unspecified"); assert.deepEqual(preview.suggestedUnits, units);
    assert.equal(preview.sha256, beforeHash); assert.equal(preview.rows.length, 5);
    assert.deepEqual(preview.suggestedMapping, { time: "时间", turbineCode: "名称", windSpeed: "风速", rpm: "主轴转速",
      windDirection: "风向", powerKw: "发电机有功功率", temperatureC: "舱外温度" });
    check("Real GB18030 source previews 1440 rows and maps all seven columns, preserving 006# and unspecified direction reference");

    const imported = await api("wind-datasets/import", "POST", { name: "QA actual 006# minute source", farmId: farm.id, timezoneOffset: "+08:00", units,
      files: [{ token: preview.token, mapping: preview.suggestedMapping }] });
    assert.equal(imported.count, 1440); assert.equal(imported.matchedRowCount, 1440);
    assert.equal(imported.windDirectionReference, "unspecified");
    assert.equal(imported.sources[0].sourceFormat, "turbine-minute-v1");
    assert.equal(imported.sources[0].windDirectionReference, "unspecified");
    assert.deepEqual(imported.sourceUnits, units);
    const datasets = (await api("wind-datasets")).datasets;
    assert.equal(datasets.length, 1);
    const saved = datasets[0];
    assert.equal(saved.id, imported.id); assert.equal(saved.rowCount, 1440); assert.equal(saved.matchedRowCount, 1440);
    assert(!("rows" in saved)); assert.equal(saved.windDirectionReference, "unspecified");
    assert.equal(saved.sources[0].sourceFormat, "turbine-minute-v1"); assert.equal(saved.sources[0].windDirectionReference, "unspecified");
    assert.deepEqual(saved.sourceUnits, units);
    assert.deepEqual(saved.metricCounts, { windSpeed: 1440, rpm: 1440, windDirection: 1440, powerKw: 1440, temperatureC: 1440 });
    assert.equal(saved.start, "2026-10-17T16:00:00.000Z"); assert.equal(saved.end, "2026-10-18T15:59:00.000Z");
    check("Python merge and Web storage retain source format, signed-direction reference, source units, coverage and all metric counts");

    const observed = [];
    for (let offset = 0; offset < 1440; offset += 100) {
      const page = await api(`wind-datasets/${imported.id}/rows?offset=${offset}&limit=100`);
      assert.equal(page.total, 1440); assert.equal(page.offset, offset); assert(page.rows.length <= 100);
      assert.equal(page.units.windDirection, "deg"); observed.push(...page.rows);
    }
    assert.deepEqual(observed, expected);
    assert.equal(observed.filter(row => row.powerKw < 0).length, 4);
    assert.equal(observed.filter(row => row.windDirection < 0).length, 1435);
    assert.equal(observed[0].windDirection, -91.279999);
    const jumped = await api(`wind-datasets/${imported.id}/rows?at=${encodeURIComponent("2026-10-18T04:00:00.000Z")}&limit=1`);
    assert.equal(jumped.offset, 720); assert.deepEqual(jumped.rows, [expected[720]]);
    report.rows = 1440; report.negativePowerRows = 4; report.negativeDirectionRows = 1435;
    report.sourceSha256 = beforeHash; report.windDirectionReference = saved.windDirectionReference;
    report.sourceFormat = saved.sources[0].sourceFormat; report.sourceUnits = saved.sourceUnits;
    report.sourceFilesUnchanged = hash(await readFile(source)) === beforeHash; assert.equal(report.sourceFilesUnchanged, true);
    check("Paged API readback equals all 1440 original rows: four negative powers and 1435 signed directions unchanged, with correct UTC+8 conversion");
    await api("wind-datasets/" + imported.id, "DELETE");
    report.passed = true;
  } catch (error) {
    failure = error; console.error(error instanceof Error ? error.stack : String(error));
  } finally {
    try {
      assert(tenant.startsWith("qa-wind-minute-"));
      await db.execute("DELETE FROM records WHERE tenant=?", [tenant]);
      await db.execute("DELETE FROM audit_logs WHERE tenant=?", [tenant]);
      await db.execute("DELETE FROM sessions WHERE id=? AND user_id=?", [sessionId, id]);
      await db.execute("DELETE FROM users WHERE id=? AND tenant=?", [id, tenant]);
      const key = hash(`${tenant}\0${id}`);
      await rm(path.join(process.env.BLADE_ANALYSIS_DATA_DIR || path.join(root, ".data/web-rotation"), key), { recursive: true, force: true });
      report.qaCleanupComplete = true;
    } catch (error) { failure ||= error; report.passed = false; console.error("QA cleanup failed"); }
    await db.end();
    const output = path.join(root, "artifacts/wind-minute-adaptation-20261028");
    await mkdir(output, { recursive: true }); await writeFile(path.join(output, "http-validation.json"), JSON.stringify(report, null, 2));
  }
  if (failure) process.exitCode = 1;
  else console.log("PASS real minute CSV HTTP acceptance; QA data removed and source unchanged");
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
