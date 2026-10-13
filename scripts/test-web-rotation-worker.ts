/** Isolated server-worker contract; no database writes, HTTP listener, or device access. */
import { mkdtemp, rm, writeFile, chmod, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { rotationUpload, rotationWorker } from "../apps/web/lib/rotation";
import { HttpError } from "../apps/web/lib/db";
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "blade-web-worker-check-"));
  const previous = process.env.BLADE_ANALYSIS_DATA_DIR;
  const previousPython = process.env.BLADE_ANALYSIS_PYTHON;
  process.env.BLADE_ANALYSIS_DATA_DIR = root;
  const user = { id: "isolated-worker-check", tenant: "temporary-test" };
  const metadata = { format: "blade-vms-csv-1", source: "simulation", samples: 1001, sampleRate: 1000, position: 0.6 };
  const text = "# BladeVMS " + JSON.stringify(metadata) + "\ntime_s,velocity_m_s,RSSI_percent,overrange\n" + Array.from({ length: 1001 }, (_, i) => `${i / 1000},${0.02 * Math.sin(2 * Math.PI * 20 * i / 1000)},80,0`).join("\n");
  try {
    const request = new Request("http://127.0.0.1/api/v1/rotation/import?filename=worker-test.csv.gz&source=measured", { method: "POST", body: new Uint8Array(gzipSync(text)) });
    const imported = await rotationUpload(user, request);
    const record = imported.recordings[0];
    const result = await rotationWorker(user, { action: "rotation", parameters: { recordingIds: [record.id], rpm: 1200, positions: [0.6] } });
    const isolated = await rotationWorker({ ...user, id: "other-user" }, { action: "recordings" });
    assert.equal(record.samples, 1001);
    assert.equal(record.source, "simulation");
    assert.equal(isolated.recordings.length, 0);
    assert.ok(Math.abs(result.modeShape.points[0].amplitude - 0.02) < 0.0001);
    const running = rotationWorker(user, { action: "recordings" });
    await assert.rejects(rotationWorker(user, { action: "recordings" }), error => error instanceof HttpError && error.status === 429);
    await running;
    await assert.rejects(rotationWorker({ ...user, id: "other-user" }, { action: "rotation", parameters: { recordingIds: [record.id], rpm: 1200 } }), /记录|文件|No such file/);
    // Exercise worker termination and cleanup without waiting for the timeout.
    if (process.platform !== "win32") {
      const fake = path.join(root, "oversized-worker.py");
      await writeFile(fake, "#!/usr/bin/env python3\nimport sys,time\nsys.stdout.write('x' * (9 * 1024 * 1024))\nsys.stdout.flush()\ntime.sleep(30)\n");
      await chmod(fake, 0o700);
      process.env.BLADE_ANALYSIS_PYTHON = fake;
      const oversized = new Request("http://127.0.0.1/api/v1/rotation/import?filename=oversized.csv.gz", { method: "POST", body: new Uint8Array(gzipSync(text)) });
      await assert.rejects(rotationUpload(user, oversized), /分析结果过大/);
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries.filter(entry => entry.isDirectory())) {
        assert.ok((await readdir(path.join(root, entry.name))).every(name => !name.startsWith(".upload-")), "Terminated worker must release its upload file");
      }
      if (previousPython === undefined) delete process.env.BLADE_ANALYSIS_PYTHON;
      else process.env.BLADE_ANALYSIS_PYTHON = previousPython;
      assert.equal((await rotationWorker(user, { action: "recordings" })).recordings.length, 1, "Account lock must be released after termination");
    }
    console.log("Web upload, Python worker, simulation provenance and account isolation passed.");
  } finally {
    if (previous === undefined) delete process.env.BLADE_ANALYSIS_DATA_DIR;
    else process.env.BLADE_ANALYSIS_DATA_DIR = previous;
    if (previousPython === undefined) delete process.env.BLADE_ANALYSIS_PYTHON;
    else process.env.BLADE_ANALYSIS_PYTHON = previousPython;
    await rm(root, { recursive: true, force: true });
  }
}
void main();
