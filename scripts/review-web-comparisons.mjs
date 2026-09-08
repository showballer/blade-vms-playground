import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const names = ["健康监测", "模态识别", "报告导出", "二次开发", ...["用户权限", "操作日志", "数据备份", "异常告警"].map(name => "系统管理-" + name)];
const base = "artifacts/web-prototype-current";
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const manifest = [];
for (const name of names) {
  execFileSync(process.execPath, ["scripts/compare-screens.mjs", name + ".png", "../web-prototype-current/" + name + ".png", "web", base + "/comparisons"]);
  const comparison = `${base}/comparisons/${name}.png`, metadata = JSON.parse(readFileSync(comparison + ".json", "utf8"));
  if (metadata.normalizedPixels.join() !== metadata.implementationPixels.join()) throw Error("Viewport/density mismatch: " + name);
  manifest.push({ name, ...metadata, cssViewport: metadata.implementationPixels, devicePixelRatio: 1, screenshotSha256: hash(metadata.implementation), comparison, comparisonSha256: hash(comparison), sourceSha256: hash(metadata.source) });
}
const focusRegions = [
  {name:"报告导出",label:"章节与操作",source:{left:235,top:145,width:345,height:505},current:{left:226,top:145,width:280,height:695}},
  {name:"模态识别",label:"参数与曲线",source:{left:238,top:147,width:790,height:457},current:{left:226,top:220,width:791,height:458}},
  {name:"模态识别",label:"振型与基准",source:{left:1040,top:147,width:430,height:327},current:{left:1028,top:220,width:440,height:452}},
  {name:"系统管理-数据备份",label:"快照与操作",source:{left:235,top:140,width:1220,height:340},current:{left:226,top:140,width:1240,height:340}},
  {name:"健康监测",label:"阈值与损伤",source:{left:1120,top:140,width:350,height:610},current:{left:1120,top:140,width:350,height:660}},
  {name:"健康监测",label:"趋势与操作",source:{left:230,top:490,width:880,height:315},current:{left:225,top:532,width:885,height:288}},
  {name:"系统管理-操作日志",label:"筛选与结果",source:{left:240,top:140,width:1220,height:235},current:{left:235,top:140,width:1220,height:290}},
  {name:"二次开发",label:"接口契约",source:{left:240,top:130,width:1220,height:415},current:{left:235,top:130,width:1220,height:415}},
];
const focuses=[];
for (const region of focusRegions) {
  const metadata = manifest.find(item=>item.name===region.name);
  const source = await sharp(metadata.source).extract(metadata.sourceCrop).resize({width:1484}).png().toBuffer();
  const left = await sharp(source).extract(region.source).png().toBuffer();
  const right = await sharp(metadata.implementation).extract(region.current).png().toBuffer();
  const comparison = `${base}/comparisons/focus-${region.name}-${region.label}.png`;
  await sharp({create:{width:region.source.width+region.current.width+24,height:Math.max(region.source.height,region.current.height),channels:3,background:"#dbe1ea"}}).composite([{input:left,left:0,top:0},{input:right,left:region.source.width+24,top:0}]).png().toFile(comparison);
  focuses.push({...region,comparison,comparisonSha256:hash(comparison),note:"Source left, current right; native CSS-pixel crop, no stretching."});
}
writeFileSync(`${base}/comparisons/index.json`, JSON.stringify({ generatedAt: new Date().toISOString(), note: "Source left, implementation right. Equal native-aspect dimensions do not establish visual acceptance. See design-qa.md for differences in data, state and interaction coverage.", screens: manifest, focuses }, null, 2));
console.log("Generated 8 normalized Web pairs; dimensions and hashes recorded.");
