import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
const targets = [
  ["数据采集", "desktop-acquisition-final", "desktop"],
  ["旋转测振", "desktop-blade-final", "desktop"],
  ...["时域波形", "FFT频谱", "时频分析", "滤波降噪", "包络谱", "频带能量", "平均波形", "特征值"].map((name) => ["信号处理-" + name, "signal-" + name + "-final", "desktop"]),
  ["健康监测", "web-health-final", "web"],
  ["模态识别", "web-modal-final", "web"],
  ["报告导出", "web-report-layout-fixed", "web"],
  ["二次开发", "web-developer-final", "web"],
  ...["用户权限", "操作日志", "数据备份", "异常告警"].map((name) => ["系统管理-" + name, "admin-" + (name === "用户权限" ? "用户与权限" : name) + "-final", "web"]),
];
for (const [source, screen, kind] of targets) {
  execFileSync(process.execPath, ["scripts/compare-screens.mjs", source + ".png", screen + ".png", kind]);
}
// Focus views preserve full pixel density for reading the source and implementation controls.
for (const [name, regions] of [
  ["信号处理-FFT频谱", [{ left: 210, top: 65, width: 650, height: 160 }, { left: 1040, top: 130, width: 420, height: 600 }]],
  ["报告导出", [{ left: 220, top: 60, width: 1000, height: 200 }]],
  ["健康监测", [{ left: 210, top: 125, width: 950, height: 370 }]],
]) {
  const metadata = JSON.parse(readFileSync("artifacts/comparisons/" + name + ".png.json", "utf8"));
  for (const [index, region] of regions.entries()) {
    const image = sharp("artifacts/comparisons/" + name + ".png");
    const left = await image.clone().extract(region).toBuffer();
    const right = await image.clone().extract({ ...region, left: region.left + metadata.implementationPixels[0] + 24 }).toBuffer();
    await sharp({ create: { width: region.width * 2 + 24, height: region.height, channels: 3, background: "#dbe1ea" } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: region.width + 24, top: 0 }]).png().toFile(`artifacts/comparisons/focus-${name}-${index + 1}.png`);
  }
}
writeFileSync("artifacts/comparisons/index.json", JSON.stringify(targets, null, 2));
console.log(`Generated ${targets.length} full-view comparisons and 4 focused views.`);
