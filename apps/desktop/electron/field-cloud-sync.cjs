'use strict';

// Only Electron's main process owns this queue and the transient Web session.
// Raw recordings are immutable inputs: sync never modifies the acquisition store.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const ID = /^[a-f0-9]{32}$/;
const FILE = /^(?:chunk-[0-9]{8}\.bin|unpaired-rssi\.bin|turntable\.jsonl)$/;
const SHA = /^[a-f0-9]{64}$/;
const BLOCK = 4 * 1024 * 1024;
const MAX_PENDING = 1800, MAX_HISTORY = 200, MAX_QUEUE_BYTES = 9 * 1024 * 1024;
const MAX_FILES = 4096, MAX_FILE_BYTES = 8 * 1024 ** 3, MAX_RECORD_BYTES = 64 * 1024 ** 3, JSON_LIMIT = 512 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const scope = context => context ? JSON.stringify([context.serverUrl, context.user.id, context.user.tenant]) : '';
const clone = value => JSON.parse(JSON.stringify(value));

function createFieldCloudSync({ file, dataDir, auth, getLive, prepareUpload, fetchImpl = global.fetch, now = Date.now, intervalMs = 1000 } = {}) {
  if (!path.isAbsolute(file || '') || !path.isAbsolute(dataDir || '') || !auth?.cloudSession || !auth?.cloudBinding || typeof fetchImpl !== 'function') throw Error('Invalid cloud sync configuration');
  const validRate = value => Number.isInteger(value) && (value === 0 || value >= 10000 && value <= 100000);
  let saved = { version: 1, clientId: randomUUID(), enabled: true, uploadSampleRate: 50000, items: [] };
  let storeError = '', transientError = '', paused = true, disposed = false, activeId = null;
  let worker = null, liveWork = null, generation = 0, timer = null, liveSequence = 0;
  const controllers = new Set();
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024 || (process.platform !== 'win32' && stat.mode & 0o077)) throw Error('invalid queue file');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!plain(parsed) || parsed.version !== 1 || !/^[a-f0-9-]{36}$/.test(parsed.clientId) || typeof parsed.enabled !== 'boolean' || !Array.isArray(parsed.items) || parsed.items.length > 2000) throw Error('invalid queue');
    if (parsed.uploadSampleRate !== undefined && !validRate(parsed.uploadSampleRate)) throw Error('invalid upload sampling');
    parsed.uploadSampleRate ??= 50000;
    for (const item of parsed.items) {
      if (!plain(item) || !ID.test(item.recordingId) || typeof item.owner !== 'string' || item.owner.length > 2500 || !['recording', 'queued', 'uploading', 'synced', 'error'].includes(item.state) || typeof item.manual !== 'boolean') throw Error('invalid queue item');
      if (item.captureId && !/^[A-Za-z0-9_-]{1,128}$/.test(item.captureId)) throw Error('invalid capture');
      if (item.files && (!Array.isArray(item.files) || item.files.length > MAX_FILES || item.files.some(f => !FILE.test(f.name) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || !SHA.test(f.sha256)))) throw Error('invalid file plan');
      if (item.uploadSampleRate !== undefined && !validRate(item.uploadSampleRate)) throw Error('invalid upload sampling');
      // Existing checksummed transfers must resume with their original bytes.
      if (item.planHash && item.uploadSampleRate === undefined) item.uploadSampleRate = 0;
      item.retryAt = 0; item.attempts = 0;
      if (item.state === 'uploading') item.state = 'queued';
    }
    saved = parsed;
  } catch (error) { if (error.code !== 'ENOENT') storeError = '同步队列不可用，已暂停同步；本机采集不受影响。请检查同步队列文件与权限。'; }

  const planDirectory = `${file}.plans`;
  function compactHistory() {
    const complete = saved.items.filter(item => item.state === 'synced').sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    const retained = new Set(complete.slice(0, MAX_HISTORY));
    saved.items = saved.items.filter(item => item.state !== 'synced' || retained.has(item));
    for (const item of saved.items) if (item.state === 'synced') { delete item.recording; delete item.files; }
  }
  function checkpoint(items = saved.items) {
    return { version: 1, clientId: saved.clientId, enabled: saved.enabled, uploadSampleRate: saved.uploadSampleRate, items: items.map(item => {
      const minimal = {};
      for (const key of ['recordingId', 'name', 'owner', 'manual', 'state', 'captureId', 'progress', 'totalBytes', 'sentBytes', 'attempts', 'retryAt', 'finishedAt', 'planHash', 'uploadSampleRate']) {
        if (item[key] !== undefined) minimal[key] = item[key];
      }
      if (item.error) minimal.error = String(item.error).slice(0, 240);
      return minimal;
    }) };
  }
  function atomicSave(target, content) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    let fd;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, target);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
  }
  function persist() {
    if (storeError) throw fail(storeError, 503);
    compactHistory();
    const content = JSON.stringify(checkpoint());
    if (Buffer.byteLength(content) > MAX_QUEUE_BYTES) throw fail('同步队列超过容量限制，请先完成待同步记录。', 413);
    try { atomicSave(file, content); }
    catch {
      storeError = '同步队列未能保存，已暂停同步；原始记录仍保留在本机。';
      throw fail(storeError, 503);
    }
  }
  compactHistory();
  function context() {
    if (paused || disposed || storeError) return null;
    try { return auth.cloudSession(); } catch { return null; }
  }
  function owned(item, ctx = auth.cloudBinding()) { return item.owner === scope(ctx); }
  function safeDirectory(id) {
    if (!ID.test(id)) throw fail('无效采集记录编号');
    const directory = path.join(dataDir, id), root = fs.realpathSync(dataDir);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(directory)) !== root) throw fail('采集记录目录不安全');
    return directory;
  }
  function safeFile(directory, name, maximum = Number.MAX_SAFE_INTEGER) {
    const target = path.join(directory, name), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(target)) !== fs.realpathSync(directory)) throw fail('原始记录文件无效');
    if (stat.size > maximum) throw fail('采集文件超过同步大小限制，请分段采集或检查元数据。', 413);
    return { target, stat };
  }
  function manifest(id) {
    const directory = safeDirectory(id);
    const { target } = safeFile(directory, 'manifest.json', 1024 * 1024);
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!plain(value) || value.id !== id || !['incomplete', 'complete', 'error'].includes(value.status) || !Number.isSafeInteger(value.samples) || value.samples < 0) throw fail('本机采集元数据无效');
    return value;
  }
  function assertCurrent(ctx, stamp) {
    if (stamp !== generation || !context() || context().token !== ctx.token || scope(context()) !== scope(ctx)) throw fail('同步已暂停', 499);
  }
  async function request(ctx, route, options = {}) {
    const stamp = generation, controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
    try {
      assertCurrent(ctx, stamp);
      const jsonBody = options.binary ? undefined : JSON.stringify(options.body || {});
      if (jsonBody && Buffer.byteLength(jsonBody) > JSON_LIMIT) throw fail('同步元数据超过 512 KiB 限制，请缩小记录或联系管理员。', 413);
      const response = await fetchImpl(`${ctx.serverUrl}/api/v1/captures${route}`, {
        method: options.method || 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': options.binary ? 'application/octet-stream' : 'application/json' },
        body: options.binary || jsonBody,
      });
      assertCurrent(ctx, stamp);
      if ([401, 403].includes(response.status)) {
        auth.clearCloudSession();
        throw fail('Web 登录已过期或无同步权限，请重新联网登录；本机采集不受影响。', response.status);
      }
      if (!response.ok) { void response.body?.cancel?.().catch(() => {}); throw fail(response.status >= 500 ? 'Web 同步服务暂时不可用，稍后自动重试。' : `Web 同步请求未通过校验（${response.status}），请重试或检查记录。`, response.status); }
      const reader = response.body?.getReader();
      if (!reader) throw fail('Web 同步响应无效', 502);
      let bytes = 0; const chunks = [];
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1024 * 1024) { await reader.cancel(); throw fail('Web 同步响应过大', 502); } chunks.push(Buffer.from(part.value)); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!plain(result)) throw fail('Web 同步响应无效', 502);
      assertCurrent(ctx, stamp);
      return result;
    } catch (error) {
      if (error.status) throw error;
      throw fail('连接 Web 失败，已保留本机队列，联网后自动重试。', 503);
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  async function ensureCapture(item, ctx) {
    if (item.captureId) return;
    const result = await request(ctx, '', { body: { clientId: saved.clientId, recording: item.recording } });
    if (typeof result.capture?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.capture.id)) throw fail('Web 未返回有效采集编号', 502);
    item.captureId = result.capture.id; persist();
  }
  async function hashFile(target) {
    const hash = createHash('sha256');
    for await (const bytes of fs.createReadStream(target, { highWaterMark: 256 * 1024 })) { if (disposed || paused) throw fail('同步已暂停', 499); hash.update(bytes); }
    return hash.digest('hex');
  }
  async function prepare(item) {
    let recording = manifest(item.recordingId);
    if (recording.status !== 'complete') {
      if (item.recordingId === activeId && recording.status === 'incomplete') return null;
      throw fail('该记录尚未完整保存，不能上传原始数据。', 409);
    }
    let directory = safeDirectory(item.recordingId);
    // Freeze the rate before the first plan so retry/restart cannot mix chunks.
    if (item.uploadSampleRate === undefined) { item.uploadSampleRate = saved.uploadSampleRate; persist(); }
    if (item.uploadSampleRate && recording.sampleRate > item.uploadSampleRate) {
      if (typeof prepareUpload !== 'function') throw fail('当前采集服务不支持上传降采样，请升级或选择原始采样率。', 422);
      const prepared = await prepareUpload(item.recordingId, item.uploadSampleRate);
      const cacheRoot = path.join(path.dirname(dataDir), 'upload-cache');
      if (!plain(prepared?.recording) || prepared.recording.id !== item.recordingId ||
          prepared.recording.sampleRate !== item.uploadSampleRate || typeof prepared.directory !== 'string' ||
          path.dirname(prepared.directory) !== cacheRoot || fs.lstatSync(prepared.directory).isSymbolicLink() ||
          path.dirname(fs.realpathSync(prepared.directory)) !== fs.realpathSync(cacheRoot)) throw fail('上传副本校验失败', 409);
      directory = prepared.directory; recording = prepared.recording;
    }
    const names = fs.readdirSync(directory);
    if (names.some(name => /^chunk-.*\.part$/.test(name))) throw fail('原始分块尚未完整保存', 409);
    const selected = names.filter(name => FILE.test(name)).sort();
    if (selected.length > MAX_FILES) throw fail('采集文件超过 4096 个同步限制，请分段采集。', 413);
    const totalBytes = selected.reduce((sum, name) => sum + safeFile(directory, name, MAX_FILE_BYTES).stat.size, 0);
    if (totalBytes > MAX_RECORD_BYTES) throw fail('单条记录超过 64 GiB 同步限制，请分段采集。', 413);
    const chunks = selected.filter(name => name.startsWith('chunk-'));
    if (chunks.length !== recording.chunks || chunks.some((name, index) => name !== `chunk-${String(index).padStart(8, '0')}.bin`)) throw fail('原始分块缺失或顺序不完整', 409);
    const files = []; let samples = 0;
    for (const name of selected) {
      const { target, stat } = safeFile(directory, name, MAX_FILE_BYTES);
      if (name.startsWith('chunk-')) {
        if (stat.size < 32 || (stat.size - 32) % 29) throw fail('原始分块字节长度不完整', 409);
        const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const header = Buffer.alloc(32); await handle.read(header, 0, 32, 0);
          if (header.toString('ascii', 0, 8) !== 'BLADEV01' || header.readDoubleLE(8) !== recording.sampleRate || header.readBigUInt64LE(24) !== BigInt(samples)) throw fail('原始分块头或样本序号不连续', 409);
        } finally { await handle.close(); }
        samples += (stat.size - 32) / 29;
      }
      files.push({ name, bytes: stat.size, sha256: await hashFile(target) });
      const after = fs.statSync(target);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw fail('原始文件发生变化，请停止写入后重试', 409);
    }
    if (samples !== recording.samples || samples < 1) throw fail('采集样本总数不一致或为空', 409);
    if (recording.unpairedRssiSamples > 0 && !selected.includes('unpaired-rssi.bin')) throw fail('缺少未配对 RSSI 原始文件', 409);
    const telemetry = recording.turntable?.telemetry, telemetryFile = files.find(part => part.name === 'turntable.jsonl');
    if (telemetry || telemetryFile || (recording.turntable && !recording.pointCycle)) {
      if (!plain(telemetry) || telemetry.file !== 'turntable.jsonl' || !Number.isSafeInteger(telemetry.events) || telemetry.events < 1 ||
          !telemetryFile || telemetryFile.bytes < 1 || telemetry.sha256 !== telemetryFile.sha256) throw fail('转盘遥测文件缺失或与记录摘要不一致，不能上传不完整的联合记录。', 409);
    }
    const planHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    if (item.planHash && item.planHash !== planHash) throw fail('原始文件与上次同步校验结果不一致，请检查本机记录。', 409);
    // Keep the per-file checksums in a separate bounded private checkpoint;
    // no raw directory is modified and the main queue never grows with file count.
    atomicSave(path.join(planDirectory, `${item.recordingId}.json`), JSON.stringify({ version: 1, recordingId: item.recordingId, files }));
    item.planHash = planHash;
    item.recording = recording; item.name = String(recording.name || item.recordingId).slice(0, 120);
    item.files = files; item.totalBytes = files.reduce((sum, part) => sum + part.bytes, 0); persist();
    return directory;
  }
  async function upload(item, ctx) {
    item.state = 'uploading'; item.error = ''; persist();
    const directory = await prepare(item);
    if (!directory) return;
    item.state = 'uploading'; item.error = ''; persist();
    await ensureCapture(item, ctx);
    const plan = await request(ctx, `/${item.captureId}/upload`, { body: { recording: item.recording, files: item.files } });
    if (!Array.isArray(plan.received) || plan.received.some(name => !item.files.some(f => f.name === name))) throw fail('Web 分块确认列表无效', 502);
    const offsets = plain(plan.offsets) ? plan.offsets : {};
    item.sentBytes = 0;
    for (const part of item.files) {
      if (plan.received.includes(part.name)) { item.sentBytes += part.bytes; continue; }
      let offset = offsets[part.name] || 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > part.bytes) throw fail('Web 分块续传位置无效', 502);
      item.sentBytes += offset;
      const { target, stat } = safeFile(directory, part.name);
      if (stat.size !== part.bytes) throw fail('原始文件大小发生变化', 409);
      const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        while (offset < part.bytes) {
          const buffer = Buffer.alloc(Math.min(BLOCK, part.bytes - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (bytesRead !== buffer.length) throw fail('原始分块读取不完整', 409);
          const result = await request(ctx, `/${item.captureId}/chunks/${part.name}?offset=${offset}`, { method: 'PUT', binary: buffer });
          if (result.ok !== true || result.nextOffset !== offset + buffer.length) throw fail('Web 分块写入未确认', 502);
          offset += buffer.length; item.sentBytes += buffer.length; persist();
        }
      } finally { await handle.close(); }
    }
    const finished = await request(ctx, `/${item.captureId}/complete`, { timeoutMs: 190000 });
    if (finished.capture?.id !== item.captureId || finished.capture?.uploadState !== 'complete') throw fail('Web 原始数据校验未确认', 502);
    item.state = 'synced'; item.error = ''; item.progress = 100; item.finishedAt = now(); item.retryAt = 0;
    persist();
    try { fs.unlinkSync(path.join(planDirectory, `${item.recordingId}.json`)); } catch { /* An orphaned checksum plan is harmless. */ }
    if (path.dirname(directory) === path.join(path.dirname(dataDir), 'upload-cache')) {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  function recordFailure(item, error) {
    if (error.status === 499) return;
    item.error = error.message || '同步暂时失败，本机记录已保留。'; item.state = activeId === item.recordingId ? 'recording' : 'error';
    item.attempts = (item.attempts || 0) + 1;
    item.retryAt = now() + Math.min(60000, 1000 * 2 ** Math.min(item.attempts, 6));
    // Invalid/mutated local data needs deliberate retry, not repeated network I/O.
    if ([400, 409, 413, 422].includes(error.status)) item.retryAt = Number.MAX_SAFE_INTEGER;
    transientError = item.error;
    try { persist(); } catch { /* A queue failure never propagates into capture. */ }
  }
  function pump() {
    if (worker || !context() || !saved.items.some(item => owned(item) && item.state !== 'synced' && (item.retryAt || 0) <= now() && item.recordingId !== activeId)) return;
    worker = (async () => {
      for (const item of saved.items) {
        const ctx = context(); if (!ctx) break;
        if (!owned(item, ctx) || item.state === 'synced' || (item.retryAt || 0) > now()) continue;
        try {
          if (item.recordingId === activeId) continue;
          await upload(item, ctx);
          transientError = '';
        } catch (error) { recordFailure(item, error); }
      }
    })().catch(error => { transientError = error.message || '同步暂时失败'; }).finally(() => { worker = null; });
  }
  function boundedWaveform(value) {
    if (!plain(value) || !Array.isArray(value.values)) return undefined;
    if (value.representation === 'envelope' && Array.isArray(value.envelope) && value.envelope.length && value.envelope.length <= 1000) {
      const envelope = { values: [], rssi: [], overrange: [], unit: 'm/s', rssiUnit: '%', representation: 'envelope',
        envelope: value.envelope.map(item => ({ ...item })) };
      for (const key of ['source', 'sampleRate', 'sampleStart', 'sampleStride', 'sampleOrigin', 'rangeStart', 'rangeEnd',
        'sourceSamples', 'overrangeCount', 'missingRssiCount', 'rssiSampleStride', 'rssiSampleRate', 'latest']) {
        if (value[key] !== undefined) envelope[key] = value[key];
      }
      return envelope;
    }
    if (!value.values.length) return undefined;
    const stride = Math.max(1, Math.ceil(value.values.length / 2048));
    const indexes = value.values.map((_, index) => index).filter(index => index % stride === 0);
    const waveform = { source: value.source, sampleRate: value.sampleRate, unit: 'm/s', sampleStart: value.sampleStart,
      sampleStride: (value.sampleStride || 1) * stride, sampleOrigin: value.sampleOrigin,
      values: indexes.map(i => value.values[i]), rssi: indexes.map(i => value.rssi?.[i] ?? null),
      overrange: indexes.map(i => Boolean(value.overrange?.[i])), rssiUnit: '%' };
    // RSSI timing describes the original acquisition, not display decimation.
    // Keep only a complete, consistent pair; malformed optional metadata must
    // not change samples or prevent a legacy-compatible live preview.
    const rssiStride = value.rssiSampleStride, rssiRate = value.rssiSampleRate;
    if (Number.isSafeInteger(rssiStride) && rssiStride >= 1 && rssiStride <= 100000 &&
        typeof rssiRate === 'number' && Number.isFinite(rssiRate) && rssiRate > 0 &&
        typeof value.sampleRate === 'number' && Number.isFinite(value.sampleRate) && value.sampleRate > 0 &&
        rssiRate <= value.sampleRate && Number.isFinite(rssiRate * rssiStride) &&
        Math.abs(rssiRate * rssiStride - value.sampleRate) <= value.sampleRate * 1e-9) {
      waveform.rssiSampleStride = rssiStride;
      waveform.rssiSampleRate = rssiRate;
    }
    return waveform;
  }
  function live() {
    if (liveWork || !activeId || !context() || typeof getLive !== 'function') return;
    const item = saved.items.find(item => item.recordingId === activeId && owned(item));
    if (!item || (item.retryAt || 0) > now()) return;
    const id = activeId, stamp = generation;
    liveWork = (async () => {
      const ctx = context(); if (!ctx) return;
      await ensureCapture(item, ctx);
      if (id !== activeId || stamp !== generation) return;
      const snapshot = await getLive();
      if (!context() || id !== activeId || stamp !== generation || snapshot?.recording?.id !== id) return;
      const waveform = boundedWaveform(snapshot.waveform);
      if (!waveform) return;
      const sequence = Math.max(now(), liveSequence + 1); liveSequence = sequence;
      const payload = { sequence, sentAt: now(), recording: snapshot.recording, waveform,
        state: ['acquiring', 'starting', 'stopping'].includes(snapshot.state) ? 'acquiring' : snapshot.state === 'error' ? 'error' : 'stopped' };
      // Reuse the service's already computed FFT/STFT, never compute from the
      // display preview. Omit optional analysis only if it exceeds transport bounds.
      if (plain(snapshot.realtime)) {
        payload.realtime = { ...snapshot.realtime };
        if (Buffer.byteLength(JSON.stringify(payload)) > 480 * 1024) delete payload.realtime;
      }
      const acknowledged = await request(ctx, `/${item.captureId}/live`, { method: 'PUT', body: payload });
      if (id !== activeId || stamp !== generation) return;
      if (acknowledged.ok !== true || acknowledged.sequence !== sequence) throw fail('Web 实时画面接收未确认', 502);
      item.error = ''; item.retryAt = 0; item.attempts = 0;
    })().catch(error => { if (id === activeId && stamp === generation && item.state !== 'synced') recordFailure(item, error); }).finally(() => { liveWork = null; });
  }
  function wake() { pump(); live(); }
  function pause() {
    paused = true; generation++;
    for (const controller of controllers) controller.abort();
  }
  function resume() {
    if (paused) for (const item of saved.items) if ((item.retryAt || 0) !== Number.MAX_SAFE_INTEGER) item.retryAt = 0;
    paused = false;
    if (context()) transientError = '';
    wake();
  }
  function status() {
    const binding = auth.cloudBinding(), ctx = context();
    const items = saved.items.filter(item => owned(item, binding)).map(item => ({ recordingId: item.recordingId, name: item.name,
      state: item.state, captureId: item.captureId, error: item.error || undefined,
      progress: item.state === 'synced' ? 100 : item.totalBytes ? Math.max(0, Math.min(99, Math.round((item.sentBytes || 0) / item.totalBytes * 100))) : 0 }));
    let state = !binding ? 'unbound' : paused ? 'signed-out' : !ctx ? 'offline' : worker || liveWork ? 'syncing' : 'ready';
    if (storeError || (ctx && transientError)) state = 'error';
    return { enabled: saved.enabled, uploadSampleRate: saved.uploadSampleRate, connected: Boolean(ctx), state, error: storeError || transientError || undefined, items };
  }
  function track(recording, manual = false) {
    if (!plain(recording) || !ID.test(recording.id)) throw fail('无效采集记录');
    const binding = auth.cloudBinding();
    if (!binding) { if (manual) throw fail('请先绑定 Web 账号', 409); return status(); }
    // The setting affects enrollment only; queued work always remains resumable.
    if (!manual && !saved.enabled) return status();
    let item = saved.items.find(candidate => candidate.recordingId === recording.id && owned(candidate, binding));
    if (!item) {
      compactHistory();
      if (saved.items.filter(item => item.state !== 'synced').length >= MAX_PENDING) throw fail('本机待同步队列已满，请先完成待同步记录', 409);
      item = { recordingId: recording.id, name: String(recording.name || recording.id).slice(0, 120), owner: scope(binding),
        manual, recording: clone(recording), state: recording.status === 'complete' ? 'queued' : 'recording', attempts: 0, retryAt: 0 };
      if (Buffer.byteLength(JSON.stringify(checkpoint([...saved.items, item]))) > MAX_QUEUE_BYTES) throw fail('同步队列超过容量限制，请先完成待同步记录。', 413);
      saved.items.push(item);
    } else if (manual && item.state !== 'synced') { item.manual = true; item.state = 'queued'; item.retryAt = 0; item.error = ''; }
    persist(); wake(); return status();
  }
  // Only the main-process run journal may call this method. The run owner
  // remains fixed even while the user switches accounts or goes offline.
  function observeRecording(recording, { owner, active = false } = {}) {
    if (!plain(recording) || !ID.test(recording.id) || !['incomplete', 'complete', 'error'].includes(recording.status)) throw fail('无效采集记录');
    const binding = auth.cloudBinding();
    if (!binding || owner !== scope(binding)) return false;
    if (storeError) throw fail(storeError, 503);
    let item = saved.items.find(candidate => candidate.recordingId === recording.id && candidate.owner === owner);
    const enrolled = !item, previous = item ? { ...item } : null, previousActiveId = activeId;
    if (active && recording.status === 'incomplete') activeId = recording.id;
    else if (activeId === recording.id) activeId = null;
    if (item?.state === 'synced') return true;
    if (!item) {
      compactHistory();
      if (saved.items.filter(candidate => candidate.state !== 'synced').length >= MAX_PENDING) throw fail('本机待同步队列已满，请先完成待同步记录', 409);
      item = { recordingId: recording.id, name: String(recording.name || recording.id).slice(0, 120), owner,
        manual: false, recording: clone(recording), state: 'recording', attempts: 0, retryAt: 0 };
      if (Buffer.byteLength(JSON.stringify(checkpoint([...saved.items, item]))) > MAX_QUEUE_BYTES) throw fail('同步队列超过容量限制，请先完成待同步记录。', 413);
      saved.items.push(item);
    } else if (item.state !== 'recording') {
      // Polling must not reset retry/backoff, interrupt an upload, or re-enroll
      // synced history. Explicit Retry is the only reset after an error.
      return true;
    }
    item.recording = clone(recording);
    if (recording.status === 'complete') { item.state = 'queued'; item.retryAt = 0; item.error = ''; }
    else if (!active) {
      item.state = 'error'; item.retryAt = Number.MAX_SAFE_INTEGER;
      item.error = '该记录未完整保存，已保留在本机，不能按完整记录自动上传。';
    }
    // Active samples are not stored in the queue file. Persist only enrollment
    // and terminal transitions, not every live frame or manifest sample count.
    try { if (enrolled || item.state !== 'recording') persist(); }
    catch (error) {
      // Accepted means durable. A failed save must not leave a queued item in
      // memory that a later poll could mistake for a persisted enrollment.
      if (enrolled) {
        const index = saved.items.indexOf(item);
        if (index >= 0) saved.items.splice(index, 1);
      } else {
        for (const key of Object.keys(item)) if (!(key in previous)) delete item[key];
        Object.assign(item, previous);
      }
      activeId = previousActiveId;
      throw error;
    }
    wake(); return true;
  }
  timer = setInterval(wake, intervalMs); timer.unref?.();
  return Object.freeze({
    status, resume, pause, observeRecording,
    setEnabled(enabled) { if (typeof enabled !== 'boolean') throw fail('自动同步设置无效'); saved.enabled = enabled; persist(); wake(); return status(); },
    setUploadSampleRate(rate) {
      if (!validRate(rate)) throw fail('上传采样率应为 10～100 kHz，或选择原始采样率');
      saved.uploadSampleRate = rate;
      for (const item of saved.items) if (item.state === 'error' && !item.planHash) item.uploadSampleRate = rate;
      persist(); return status();
    },
    started(recording) { activeId = recording?.id || null; try { return track(recording); } catch (error) { transientError = error.message || '新采集未能加入同步队列'; throw error; } },
    finished(recording) {
      if (!recording?.id) return status();
      if (activeId === recording.id) activeId = null;
      const item = saved.items.find(candidate => candidate.recordingId === recording.id && owned(candidate));
      if (item && item.state !== 'synced') { item.recording = clone(recording); item.state = 'queued'; item.retryAt = 0; persist(); wake(); }
      return status();
    },
    uploadRecording(id) { const recording = manifest(id); if (recording.status !== 'complete') throw fail('请先停止并完整保存记录', 409); return track(recording, true); },
    retry() { transientError = ''; for (const item of saved.items) if (owned(item) && item.state !== 'synced') { item.retryAt = 0; item.attempts = 0; item.error = ''; } persist(); wake(); return status(); },
    dispose() { disposed = true; pause(); clearInterval(timer); },
    async settled() { await Promise.all([worker, liveWork]); },
  });
}
module.exports = { createFieldCloudSync };
