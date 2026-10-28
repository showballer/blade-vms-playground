'use strict';

// The package carries raw recordings only. Authentication, settings, upload queues
// and SQLite indexes remain owned by the receiving installation.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const CHUNK = /^chunk-[0-9]{8}\.bin$/;
const FILE = /^(?:manifest\.json|source-export-manifest\.json|chunk-[0-9]{8}\.bin|unpaired-rssi\.bin)$/;
const PRIVATE_KEY = /^(?:(?:local|unified)?account(?:Id|Binding)?|owner(?:Id)?|tenant(?:Id)?|user(?:Id|name)?|password(?:Hash|Salt)?|credentials?|authorization|(?:local|unified)?auth|(?:access|refresh|session)?token|cloudSync|cloudBinding|syncOrigin|uploadQueue)$/i;
const STATE = 'bundled-recordings-state.json';
const DIAGNOSTIC = 'bundled-recordings-error.json';
function fail(message) { throw Object.assign(new Error(`预置采集记录：${message}`), { code: 'BUNDLED_RECORDINGS_INVALID' }); }
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function directory(file, create = false) {
  if (create && !exists(file)) fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`不是安全目录：${file}`);
  return fs.realpathSync(file);
}
function regular(file, max = Infinity) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > max) fail(`文件类型或大小无效：${file}`);
  return stat;
}
function json(file, max = 1024 * 1024) {
  regular(file, max);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`JSON 格式无效：${file}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`JSON 内容无效：${file}`);
  return value;
}
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEY.test(key)).map(([key, item]) => [key, clean(item)]));
}
function cleanMetadata(value, filename) {
  const result = clean(value);
  // Only the live manifest participates in capture-run reconciliation. Keep the
  // source export as provenance; its fields are never enrolled by the tracker.
  if (filename === 'manifest.json') delete result.captureSessionId;
  return result;
}
function hash(file) {
  regular(file);
  const fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024), digest = createHash('sha256');
  try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function atomicJson(file, value) {
  if (exists(file)) regular(file);
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function recording(directoryPath, id, taskName, names, privateCheck = true) {
  const manifest = json(path.join(directoryPath, 'manifest.json'));
  if (manifest.id !== id || manifest.name !== taskName || manifest.status !== 'complete' || manifest.error ||
      manifest.format !== 'BLADEV01/<QidifB' || !Number.isSafeInteger(manifest.samples) || manifest.samples < 1 ||
      !Number.isSafeInteger(manifest.chunks) || manifest.chunks < 1 || !Number.isFinite(manifest.sampleRate) || manifest.sampleRate <= 0)
    fail(`记录身份、任务名或完整状态无效：${id}`);
  if (privateCheck && JSON.stringify(cleanMetadata(manifest, 'manifest.json')) !== JSON.stringify(manifest)) fail(`记录含账号或同步字段：${id}`);
  const chunks = names.filter(name => CHUNK.test(name)).sort();
  if (chunks.length !== manifest.chunks) fail(`分块数量不符：${id}`);
  let samples = 0;
  for (const [index, name] of chunks.entries()) {
    if (name !== `chunk-${String(index).padStart(8, '0')}.bin`) fail(`分块序号不连续：${id}`);
    const file = path.join(directoryPath, name), size = regular(file).size;
    if (size < 32 || (size - 32) % 29 !== 0) fail(`原始分块长度不符：${id}/${name}`);
    const header = Buffer.alloc(32), fd = fs.openSync(file, 'r');
    try { if (fs.readSync(fd, header, 0, 32, 0) !== 32) fail(`原始分块头不完整：${id}/${name}`); }
    finally { fs.closeSync(fd); }
    if (header.toString('ascii', 0, 8) !== 'BLADEV01' || header.readDoubleLE(8) !== manifest.sampleRate ||
        header.readDoubleLE(16) !== manifest.sampleOrigin || header.readBigUInt64LE(24) !== BigInt(samples))
      fail(`原始分块时间轴不连续：${id}/${name}`);
    samples += (size - 32) / 29;
  }
  if (samples !== manifest.samples) fail(`原始样本数量不符：${id}`);
  if (names.includes('source-export-manifest.json')) {
    const source = json(path.join(directoryPath, 'source-export-manifest.json'));
    if (privateCheck && JSON.stringify(clean(source)) !== JSON.stringify(source)) fail(`来源元数据含账号或同步字段：${id}`);
  }
  return manifest;
}
function packageManifest(bundleDir) {
  const manifest = json(path.join(bundleDir, 'manifest.json'), 8 * 1024 * 1024);
  if (manifest.schemaVersion !== 1 || !HASH.test(manifest.bundleId) || typeof manifest.taskName !== 'string' ||
      !manifest.taskName.trim() || manifest.taskName.length > 256 || !Array.isArray(manifest.records) ||
      manifest.records.length < 1 || manifest.records.length > 1000 ||
      Object.keys(manifest).some(key => !['schemaVersion', 'bundleId', 'taskName', 'records'].includes(key))) fail('包清单版本或结构无效');
  const ids = new Set();
  let fileCount = 0;
  for (const record of manifest.records) {
    if (!record || !ID.test(record.id) || ids.has(record.id) || !Array.isArray(record.files) || !record.files.length ||
        Object.keys(record).some(key => !['id', 'files'].includes(key))) fail('记录 ID 重复或路径无效');
    ids.add(record.id);
    const names = new Set();
    for (const file of record.files) {
      if (!file || !FILE.test(file.path) || names.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 ||
          !HASH.test(file.sha256) || Object.keys(file).some(key => !['path', 'size', 'sha256'].includes(key))) fail(`文件清单无效：${record.id}`);
      names.add(file.path); fileCount++;
    }
    if (!names.has('manifest.json')) fail(`缺少记录元数据：${record.id}`);
  }
  if (fileCount > 20000 || manifest.bundleId !== digest({ schemaVersion: 1, taskName: manifest.taskName, records: manifest.records })) fail('包清单完整性校验失败');
  return manifest;
}
function verifyFiles(base, record) {
  directory(base);
  for (const file of record.files) {
    const target = path.join(base, file.path);
    if (regular(target).size !== file.size || hash(target) !== file.sha256) fail(`文件完整性校验失败：${record.id}/${file.path}`);
  }
}

/** Build an explicitly selected, deterministic seed; never copies a profile. */
function prepareBundledRecordings({ recordingsDir, taskName, outputDir }) {
  if (typeof taskName !== 'string' || !taskName.trim() || taskName.length > 256) fail('需要精确指定任务名');
  const source = directory(recordingsDir), output = path.resolve(outputDir);
  if (output === source || output.startsWith(source + path.sep)) fail('包输出目录不能位于源记录目录中');
  if (exists(output)) fail('包输出目录已存在，未覆盖');
  const selected = [];
  for (const name of fs.readdirSync(source).sort()) {
    if (!ID.test(name)) continue;
    const dir = directory(path.join(source, name));
    const manifest = json(path.join(dir, 'manifest.json'));
    if (manifest.name !== taskName) continue;
    const names = fs.readdirSync(dir).filter(file => FILE.test(file)).sort();
    recording(dir, name, taskName, names, false);
    selected.push({ id: name, dir, names });
  }
  if (!selected.length) fail(`找不到任务：${taskName}`);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  try {
    const records = [];
    for (const entry of selected) {
      const dir = path.join(output, 'records', entry.id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const files = [];
      for (const name of entry.names) {
        const from = path.join(entry.dir, name), to = path.join(dir, name);
        regular(from);
        if (name.endsWith('.json')) {
          const before = json(from), after = cleanMetadata(before, name);
          if (JSON.stringify(before) !== JSON.stringify(after)) fs.writeFileSync(to, JSON.stringify(after, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        } else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        files.push({ path: name, size: fs.statSync(to).size, sha256: hash(to) });
      }
      recording(dir, entry.id, taskName, entry.names);
      records.push({ id: entry.id, files });
    }
    const payload = { schemaVersion: 1, taskName, records }, manifest = { ...payload, bundleId: digest(payload) };
    atomicJson(path.join(output, 'manifest.json'), manifest);
    packageManifest(output);
    return { bundleId: manifest.bundleId, taskName, recordCount: records.length,
      fileCount: records.reduce((n, r) => n + r.files.length, 0), bytes: records.reduce((n, r) => n + r.files.reduce((sum, f) => sum + f.size, 0), 0), manifestPath: path.join(output, 'manifest.json') };
  } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
}

/** Install before starting RecordingStore; it rebuilds its own SQLite index. */
function installBundledRecordings({ bundleDir, dataDir }) {
  if (!exists(bundleDir)) return { status: 'absent', imported: [], skipped: [], conflicts: [], interrupted: [] };
  let root;
  try {
    const bundle = directory(bundleDir), manifest = packageManifest(bundle);
    root = directory(dataDir, true);
    const stateFile = path.join(root, STATE);
    const state = exists(stateFile) ? json(stateFile, 8 * 1024 * 1024) : { schemaVersion: 1, records: {} };
    if (state.schemaVersion !== 1 || !state.records || typeof state.records !== 'object' || Array.isArray(state.records) ||
        Object.entries(state.records).some(([id, item]) => !ID.test(id) || !item || !['pending', 'imported', 'existing', 'conflict'].includes(item.status) || !HASH.test(item.bundleId))) fail('本机预置导入凭据无效，未重建或覆盖');
    const result = { status: 'skipped', bundleId: manifest.bundleId, taskName: manifest.taskName, imported: [], skipped: [], conflicts: [], interrupted: [] };
    const pending = manifest.records.filter(record => !state.records[record.id]);
    const recordsDir = directory(path.join(root, 'recordings'), true);
    for (const record of manifest.records.filter(record => state.records[record.id])) {
      if (state.records[record.id].status === 'pending') {
        // A crash between the durable intent and publishing must never cause a
        // deleted record to reappear. Surface it for inspection instead.
        result.interrupted.push(record.id);
      } else result.skipped.push(record.id);
    }
    if (pending.length) {
      const sourceRoot = directory(path.join(bundle, 'records'));
      // Validate every pending record before publishing any of them.
      for (const record of pending) {
        const source = path.join(sourceRoot, record.id);
        verifyFiles(source, record);
        recording(source, record.id, manifest.taskName, record.files.map(file => file.path));
      }
      for (const record of pending) {
        const target = path.join(recordsDir, record.id);
        if (exists(target)) {
          let matches = false;
          try { verifyFiles(target, record); matches = true; } catch { /* Preserve even invalid or partial existing data. */ }
          state.records[record.id] = { status: matches ? 'existing' : 'conflict', bundleId: manifest.bundleId };
          atomicJson(stateFile, state);
          (matches ? result.skipped : result.conflicts).push(record.id);
          continue;
        }
        const staging = fs.mkdtempSync(path.join(recordsDir, '.bundled-recording-'));
        let published = false, reserved = false;
        try {
          for (const file of record.files) fs.copyFileSync(path.join(sourceRoot, record.id, file.path), path.join(staging, file.path), fs.constants.COPYFILE_EXCL);
          verifyFiles(staging, record);
          state.records[record.id] = { status: 'pending', bundleId: manifest.bundleId };
          atomicJson(stateFile, state); reserved = true;
          if (exists(target)) fail(`记录在导入期间已出现，未覆盖：${record.id}`);
          fs.renameSync(staging, target); published = true;
          state.records[record.id].status = 'imported';
          atomicJson(stateFile, state);
          result.imported.push(record.id);
        } catch (error) {
          if (reserved && !published) { delete state.records[record.id]; atomicJson(stateFile, state); }
          throw error;
        } finally { if (!published) fs.rmSync(staging, { recursive: true, force: true }); }
      }
    }
    result.status = result.conflicts.length || result.interrupted.length ? 'partial' : result.imported.length ? 'installed' : 'skipped';
    if (result.interrupted.length || result.conflicts.length) atomicJson(path.join(root, DIAGNOSTIC), { at: new Date().toISOString(), ...result });
    return result;
  } catch (error) {
    error.code ||= 'BUNDLED_RECORDINGS_IMPORT_FAILED';
    try {
      root ||= directory(dataDir, true);
      error.diagnosticPath = path.join(root, DIAGNOSTIC);
      atomicJson(error.diagnosticPath, { at: new Date().toISOString(), code: error.code, message: error.message });
    } catch { /* The original failure stays actionable if even diagnostics cannot be written. */ }
    throw error;
  }
}

module.exports = { prepareBundledRecordings, installBundledRecordings };
