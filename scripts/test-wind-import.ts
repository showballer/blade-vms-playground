import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { limitedBody, windUploadPreview, withWindImport } from "../apps/web/lib/rotation";
import { conditionWindow, validateWindRows } from "../packages/ui/src/measurement-domain";

const user = { id: "wind-import-qa", tenant: "isolated-wind-import-qa" };
const units = { windSpeed: "m/s", rpm: "rpm", powerKw: "kW", temperatureC: "C" };
const timezoneOffset = "+08:00";
const report: Record<string, unknown> = { assumptions: { timezoneOffset, units }, sourceFilesUnchanged: true };

async function main() {
  let canceled = false;
  const waitingBody = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const waitingRequest = new Request("http://localhost/upload", { method: "POST", body: waitingBody, duplex: "half" } as RequestInit);
  await assert.rejects(limitedBody(waitingRequest, 16 * 1024 * 1024, 20), /上传超时/);
  assert(canceled);
  // Full-window summaries must not spread >100k entries into Math.min/max.
  const timestamp = Date.parse("2025-12-23T01:00:00Z");
  const partial = validateWindRows([{ time: new Date(timestamp).toISOString(), turbineCode: "R018", windSpeed: 0, temperatureC: -13 }]);
  assert.equal(conditionWindow([{ id: "wind", farmId: "farm", rows: partial }], "farm", "R018", timestamp, timestamp).status, "unmatched");
  const rpm = validateWindRows([{ time: new Date(timestamp).toISOString(), turbineCode: "R018", rpm: 6.9 }]);
  assert.equal(conditionWindow([{ id: "wind", farmId: "farm", rows: partial }, { id: "rpm", farmId: "farm", rows: rpm }], "farm", "R018", timestamp, timestamp).samples, 1);
  const conflict = conditionWindow([{ id: "a", farmId: "farm", rows: [{ ...partial[0], rpm: 6 }] }, { id: "b", farmId: "farm", rows: [{ ...partial[0], rpm: 7 }] }], "farm", "R018", timestamp, timestamp);
  assert.equal(conflict.status, "unmatched"); assert.equal(conflict.conflictingSamples, 1);
  const many = Array.from({ length: 250000 }, (_, i) => ({ time: new Date(timestamp + i * 1000).toISOString(), turbineCode: "R018", windSpeed: i % 20, rpm: 7 }));
  const large = conditionWindow([{ id: "many", farmId: "farm", rows: validateWindRows(many) }], "farm", "R018", timestamp, timestamp + 250000000);
  assert.equal(large.samples, 250000); assert.deepEqual(large.windRange, [0, 19]);
  assert.throws(() => validateWindRows([{ time: new Date(timestamp).toISOString(), turbineCode: "R018" }]));
  assert.throws(() => validateWindRows([{ ...partial[0], temperatureC: "-13" }]));

  const temp = await mkdtemp(path.join(os.tmpdir(), "blade-wind-import-"));
  const previous = process.env.BLADE_ANALYSIS_DATA_DIR;
  process.env.BLADE_ANALYSIS_DATA_DIR = temp;
  try {
    const folder = process.argv[2] ? path.resolve(process.argv[2]) : null;
    const sources = folder ? await Promise.all((await readdir(folder)).filter(file => file.endsWith(".csv")).sort().map(async filename => ({ filename, bytes: await readFile(path.join(folder, filename)) }))) : [
      { filename: "wind.csv", bytes: Buffer.from("风机,时间,风速\nR018,2025-12-23 09:00:00,7.6\nR018,2025-12-23 09:00:01,0\n") },
      { filename: "rpm.csv", bytes: Buffer.from("风机,时间,轮毂转速\nR018,2025-12-23 09:00:01,6.9\n") },
    ];
    const staged: any[] = [];
    for (const source of sources) {
      const p = await windUploadPreview(user, new Request(`http://localhost/api/wind?filename=${encodeURIComponent(source.filename)}`, { method: "POST", body: new Uint8Array(source.bytes) }));
      assert.ok(p.rows.length <= 5); assert.ok(JSON.stringify(p).length < 5000);
      assert.equal(p.sha256, createHash("sha256").update(source.bytes).digest("hex"));
      staged.push(p);
    }
    report.files = staged;
    const payload = { files: staged.map(p => ({ token: p.token, mapping: p.suggestedMapping })), units, timezoneOffset };
    await assert.rejects(withWindImport({ ...user, id: "other-user" }, payload, async () => null), /过期/);
    await assert.rejects(withWindImport({ ...user, tenant: "other-tenant" }, payload, async () => null), /过期/);
    await assert.rejects(withWindImport(user, { ...payload, units: {} }, async () => null), /原始单位/);
    await assert.rejects(withWindImport(user, payload, async () => { throw new Error("expected validation failure"); }), /expected validation failure/);
    let savedRows = 0;
    report.summary = await withWindImport(user, payload, async (input, summary) => {
      const rows = validateWindRows(input);
      savedRows = rows.length;
      const complete = rows.filter(row => row.rpm != null && row.windSpeed != null);
      assert.equal(complete.length, summary.matchedRowCount);
      assert.equal(rows.filter(row => row.rpm != null).length, summary.metricCounts.rpm);
      const condition = conditionWindow([{ id: "real-input", farmId: "farm", rows }], "farm", "R018", Date.parse(summary.start), Date.parse(summary.end));
      assert.equal(condition.samples, complete.length);
      assert.equal(conditionWindow([{ id: "real-input", farmId: "farm", rows }], "farm", "R018", Date.parse("2026-10-24T00:00:00Z"), Date.parse("2026-10-25T00:00:00Z")).status, "unmatched");
      if (folder) {
        assert.equal(rows.length, 186000);
        assert.equal(complete.length, 10800);
        assert.deepEqual(summary.metricCounts, { windSpeed: 183600, rpm: 10800, windDirection: 0, powerKw: 151200, temperatureC: 183600 });
        assert.ok(!("rpm" in rows[0]));
        assert.equal(rows[0].powerKw, 353);
        assert.equal(complete[0].rpm, 6.94);
        assert.equal(summary.matchedStart, "2025-12-23T01:10:00.000Z");
        assert.equal(summary.matchedEnd, "2025-12-23T04:09:59.000Z");
      }
      return { ...summary, resultToken: undefined, condition };
    });
    assert.ok(savedRows > 0);
    await assert.rejects(withWindImport(user, payload, async () => null), /过期/);
    if (folder) for (const source of sources) assert.deepEqual(await readFile(path.join(folder, source.filename)), source.bytes);
    const output = path.resolve("artifacts/wind-import-20261028");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, folder ? "real-files-validation.json" : "fixture-validation.json"), JSON.stringify(report, null, 2));
    console.log(`PASS wind imports: ${sources.length} files, ${savedRows} exact timestamp rows; bounded previews, explicit units/timezone, missing preserved, conflict rejection, account isolation, retry and cleanup; no database writes`);
  } finally {
    if (previous === undefined) delete process.env.BLADE_ANALYSIS_DATA_DIR;
    else process.env.BLADE_ANALYSIS_DATA_DIR = previous;
    await rm(temp, { recursive: true, force: true });
  }
}
void main();
