const fs = require("node:fs");

/** Only a genuinely absent file may create a fresh workspace. Never replace damaged data. */
function readWorkspace(file, create) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return create(); throw error; }
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.tasks) || !Array.isArray(data.analyses))
    throw Error("本机工作区格式无效");
  if (data.clientId !== undefined && (typeof data.clientId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(data.clientId)))
    throw Error("本机工作区标识无效");
  if (data.syncReceipts !== undefined && !Array.isArray(data.syncReceipts)) throw Error("本机回执格式无效");
  if (data.batches !== undefined && !Array.isArray(data.batches)) throw Error("本机批次格式无效");
  if (data.imports !== undefined && !Array.isArray(data.imports)) throw Error("本机导入记录格式无效");
  return data;
}
module.exports = { readWorkspace };
