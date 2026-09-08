import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const names = ["数据采集", "旋转测振", ...["时域波形", "FFT频谱", "时频分析", "滤波降噪", "包络谱", "频带能量", "平均波形", "特征值"].map(name => "信号处理-" + name)];
const base = "artifacts/prototype-current", manifest = [];
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
for (const name of names) {
  execFileSync(process.execPath, ["scripts/compare-screens.mjs", name + ".png", "../prototype-current/" + name + ".png", "desktop", base + "/comparisons"]);
  const comparison = `${base}/comparisons/${name}.png`, metadata = JSON.parse(readFileSync(comparison + ".json", "utf8"));
  if (metadata.normalizedPixels.join() !== metadata.implementationPixels.join()) throw Error("Viewport/density mismatch: " + name);
  const before = `${base}/before/${name}.png`;
  if (existsSync(before)) execFileSync(process.execPath, ["scripts/compare-screens.mjs", name + ".png", "../prototype-current/before/" + name + ".png", "desktop", base + "/before/comparisons"]);
  manifest.push({ name, ...metadata, cssViewport: metadata.implementationPixels, devicePixelRatio: 1, screenshotSha256: hash(metadata.implementation), comparison, comparisonSha256: hash(comparison), sourceSha256: hash(metadata.source), ...(existsSync(before) ? { before, beforeSha256: hash(before) } : {}) });
}
for (const [name, region] of [
  ["数据采集", { left: 1150, top: 180, width: 330, height: 700 }],
  ["旋转测振", { left: 220, top: 420, width: 930, height: 440 }],
  ["信号处理-时频分析", { left: 1160, top: 170, width: 320, height: 650 }],
  ["信号处理-滤波降噪", { left: 220, top: 205, width: 950, height: 430 }],
]) {
  const comparison = `${base}/comparisons/${name}.png`, image = sharp(comparison);
  const left = await image.clone().extract(region).toBuffer(), right = await image.clone().extract({ ...region, left: region.left + 1508 }).toBuffer();
  const focus = `${base}/comparisons/focus-${name}.png`;
  await sharp({ create: { width: region.width * 2 + 24, height: region.height, channels: 3, background: "#dbe1ea" } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: region.width + 24, top: 0 }]).png().toFile(focus);
  Object.assign(manifest.find(item => item.name === name), { focus, focusRegion: region, focusSha256: hash(focus) });
}
writeFileSync(`${base}/comparisons/index.json`, JSON.stringify({ generatedAt: new Date().toISOString(), note: "Source left, implementation right. Native source aspect preserved; no vertical stretching. Human review is recorded separately, not inferred from file generation.", screens: manifest }, null, 2));
console.log("Generated 10 normalized pairs and 4 readable detail pairs; dimensions and hashes recorded.");
