import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { rotationUpload, rotationWorker } from "../apps/web/lib/rotation";
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "measurement-worker-")),
    previous = process.env.BLADE_ANALYSIS_DATA_DIR;
  process.env.BLADE_ANALYSIS_DATA_DIR = root;
  const user = { id: "isolated-qa", tenant: "measurement-qa" };
  try {
    const meta = {
      format: "blade-vms-csv-1",
      name: "isolated numerical fixture",
      source: "measured",
      sampleRate: 1000,
      samples: 4000,
    };
    const csv =
      "# BladeVMS " +
      JSON.stringify(meta) +
      "\ntime_s,velocity_m_s\n" +
      Array.from(
        { length: 4000 },
        (_, i) =>
          `${i / 1000},${0.002 * Math.sin((2 * Math.PI * 50 * i) / 1000) + 0.001 * Math.sin((2 * Math.PI * 120 * i) / 1000)}`,
      ).join("\n");
    const upload = await rotationUpload(
      user,
      new Request("http://localhost/api?filename=qa.csv&source=measured", {
        method: "POST",
        body: csv,
      }),
    );
    const recordingId = upload.recordings[0].id;
    const catalogs = await Promise.all([
      rotationWorker(user, { action: "recordings" }),
      rotationWorker(user, { action: "recordings" }),
    ]);
    assert.deepEqual(catalogs[0], catalogs[1]);
    const overlapping = await Promise.all([
      rotationWorker(user, { action: "recordings" }),
      rotationWorker(user, {
        action: "measurement-analysis",
        parameters: { recordingId, windowSeconds: 1 },
      }),
    ]);
    assert.equal(overlapping[1].peaks[0].frequencyHz, 50);
    const r = await rotationWorker(user, {
      action: "measurement-analysis",
      parameters: { recordingId, windowSeconds: 1 },
    });
    assert.equal(r.status, "analyzed");
    assert.equal(r.peaks[0].frequencyHz, 50);
    assert.equal(r.peaks[1].frequencyHz, 120);
    assert.ok(
      Math.abs(
        r.metrics.rmsVelocityMps - Math.sqrt((0.002 ** 2 + 0.001 ** 2) / 2),
      ) < 1e-8,
    );
    assert.equal(r.phaseAvailable, false);
    assert.equal(r.spectrum.resolutionHz, 1);
    const second = await rotationUpload(
      user,
      new Request(
        "http://localhost/api?filename=qa-second.csv&source=measured",
        {
          method: "POST",
          body: csv.replace(
            "isolated numerical fixture",
            "isolated second pass",
          ),
        },
      ),
    );
    const merged = await rotationWorker(user, {
      action: "measurement-analysis",
      parameters: {
        recordingIds: [recordingId, second.recordings[0].id],
        windowSeconds: 1,
      },
    });
    assert.equal(merged.stitch.joins.length, 1);
    assert.equal(merged.peaks[0].frequencyHz, 50);
    assert.equal(merged.spectrum.resolutionHz, 1);
    assert.equal(merged.validSamples, 8000);
    const zero = await rotationWorker(user, {
      action: "measurement-analysis",
      parameters: { recordingId, fadeFraction: 0 },
    });
    assert.deepEqual(zero.stitch.raw, zero.stitch.smoothed);
    await assert.rejects(
      rotationWorker(user, {
        action: "measurement-analysis",
        parameters: { recordingId, windowSeconds: -1 },
      }),
    );
    await assert.rejects(
      rotationWorker(
        { ...user, id: "other" },
        { action: "measurement-analysis", parameters: { recordingId } },
      ),
    );
    const wind = await rotationWorker(user, {
      action: "wind-preview",
      filename: "conditions.csv",
      base64: Buffer.from(
        "time,turbineCode,windSpeed,rpm\n2026-10-27T02:00:00Z,T1,3,12",
      ).toString("base64"),
    });
    assert.equal(wind.rows.length, 1);
    const gbk = await rotationUpload(
      user,
      new Request("http://localhost/api?filename=vendor.csv&source=measured", {
        method: "POST",
        body: new Uint8Array(
          iconv.encode(
            "# NR-X100\n# 设备导出：现场测试\n# Sampling cycle: 1 ms\ntime(s),velocity(mm/s)\n" +
              Array.from(
                { length: 1000 },
                (_, i) =>
                  `${i / 1000},${Math.sin((2 * Math.PI * 30 * i) / 1000)}`,
              ).join("\n"),
            "gb18030",
          ),
        ),
      }),
    );
    assert.equal(gbk.recordings[0].sampleRate, 1000);
    console.log(
      "PASS real worker: known frequencies, RMS, resolution, no fake phase, parameter/account guards, wind preview, vendor comment header",
    );
  } finally {
    if (previous === undefined) delete process.env.BLADE_ANALYSIS_DATA_DIR;
    else process.env.BLADE_ANALYSIS_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
void main();
