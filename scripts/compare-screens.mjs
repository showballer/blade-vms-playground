import sharp from "sharp";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
const root = path.resolve(import.meta.dirname, "..");
const [sourceName, implementationName, kind = "desktop", outputDirectory = "artifacts/comparisons"] =
  process.argv.slice(2);
if (!sourceName || !implementationName)
  throw Error(
    "Usage: node scripts/compare-screens.mjs source.png implementation.png [web|desktop] [output-directory]",
  );
const source = path.resolve(root, "../原型/原型-截图", sourceName);
const implementation = path.resolve(
  root,
  "artifacts/screenshots",
  implementationName,
);
const metadata = await sharp(source).metadata();
// Remove supplied screenshot's outer stage and, for Web, its illustrated browser chrome.
// Keep real application content; these are visual comparisons, not pixel-equality assertions.
const left = Math.round(metadata.width * 0.008),
  top =
    kind === "web"
      ? Math.round(metadata.width * 0.066)
      : Math.round(metadata.height * 0.012);
const width = metadata.width - left * 2,
  height = metadata.height - top - Math.round(metadata.height * 0.012);
const rendered = await sharp(implementation).metadata();
const normalized = await sharp(source)
  .extract({ left, top, width, height })
  .resize({ width: rendered.width })
  .png()
  .toBuffer();
const m = await sharp(normalized).metadata();
const output = path.resolve(root, outputDirectory, sourceName);
mkdirSync(path.dirname(output), { recursive: true });
await sharp({
  create: {
    width: rendered.width * 2 + 24,
    height: Math.max(m.height, rendered.height),
    channels: 3,
    background: "#dbe1ea",
  },
})
  .composite([
    { input: normalized, left: 0, top: 0 },
    { input: implementation, left: rendered.width + 24, top: 0 },
  ])
  .png()
  .toFile(output);
writeFileSync(
  output + ".json",
  JSON.stringify(
    {
      source,
      implementation,
      sourcePixels: [metadata.width, metadata.height],
      sourceCrop: { left, top, width, height },
      normalizedPixels: [m.width, m.height],
      implementationPixels: [rendered.width, rendered.height],
      arrangement:
        "source left, implementation right; density normalization only, no vertical stretching",
    },
    null,
    2,
  ),
);
console.log(output);
