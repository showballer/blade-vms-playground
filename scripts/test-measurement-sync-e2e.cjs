'use strict';
// Loopback database/API acceptance. Metadata fixtures only: no waveform files,
// analysis/preview worker requests, physical devices or production tenants.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, scryptSync, createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:3210';
const prefix = 'qa-sync-catalog-';
const tenant = prefix + randomUUID(), otherTenant = prefix + randomUUID();
const accounts = [
  { id: randomUUID(), role: 'operator', tenant, label: 'owner' },
  { id: randomUUID(), role: 'operator', tenant, label: 'colleague' },
  { id: randomUUID(), role: 'analyst', tenant: otherTenant, label: 'outsider' },
];
const total = 512, fixtures = [];
const output = path.join(root, 'artifacts/sync-alignment-20261027/catalog-pagination-verification.json');
const report = { passed: false, fixtureKind: 'synthetic metadata only; no sample files', hardwareTested: false, productionDataTouched: false, checks: [] };
let db, failure;
const sha = value => createHash('sha256').update(value).digest('hex');
async function api(account, route, method = 'GET', body, expected = 200) {
  const response = await fetch(origin + '/api/v1/' + route, {
    method, headers: { 'content-type': 'application/json', ...(account.token ? { authorization: 'Bearer ' + account.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const value = await response.json();
  assert.equal(response.status, expected, route + ': ' + String(value.error || response.status));
  return value;
}
function check(text) { report.checks.push(text); console.log('PASS ' + text); }
function fixture(account, index) {
  const id = randomUUID().replaceAll('-', ''), localId = randomUUID().replaceAll('-', '');
  const recording = { id: localId, name: 'QA METADATA ONLY ' + index, originalTaskName: 'QA pagination contract',
    source: 'polytec_ivs500', unit: 'm/s', status: 'complete', samples: 1000, sampleRate: 1000, sampleOrigin: 1700000000 + index,
    startedAt: 1700000000 + index, endedAt: 1700000001 + index, diagnosticOnly: true, validMeasurement: false,
    testFixture: { synthetic: true, metadataOnly: true, noWaveform: true, purpose: 'isolated ownership and pagination test' },
    windFarm: 'QA-FARM', turbine: 'QA-TURBINE', pointCycle: { collectionId: 'QA-COLLECTION', bladeId: '2', radialPointId: 'qa-point-' + (index % 5 + 1),
      radialPointName: 'p' + (index % 5 + 1), radiusM: .16 + (index % 5) * .14, completion: 'diagnostic_pass', outcome: 'diagnostic' } };
  const body = { recording, liveState: 'stopped', uploadState: 'complete', receivedBytes: 0, totalBytes: 0, lastSeenAt: null, sequence: -1,
    fixtureOnly: true };
  const created = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString().slice(0, 23).replace('T', ' ');
  return { id, account, clientId: 'qa-metadata-client', localId, recording, body, created };
}
async function insertFixtures(list) {
  for (let offset = 0; offset < list.length; offset += 100) {
    const part = list.slice(offset, offset + 100);
    await db.execute('INSERT INTO captures(id,owner_id,tenant,client_id,local_id,body,created_at,updated_at) VALUES ' + part.map(() => '(?,?,?,?,?,?,?,?)').join(','),
      part.flatMap(f => [f.id, f.account.id, f.account.tenant, f.clientId, f.localId, JSON.stringify(f.body), f.created, f.created]));
  }
}
async function allSources(account, catalogue = false) {
  const first = await api(account, catalogue ? 'measurements' : 'measurements/sources?limit=200');
  const sources = [...first.sources], pages = [first.sources.length], seen = new Set();
  let cursor = catalogue ? first.nextSourcesCursor : first.nextCursor;
  while (cursor) {
    assert(!seen.has(cursor), 'Sources cursor must progress'); seen.add(cursor);
    assert(seen.size < 10, 'Unexpected source page count');
    const page = await api(account, 'measurements/sources?limit=200&cursor=' + encodeURIComponent(cursor));
    sources.push(...page.sources); pages.push(page.sources.length); cursor = page.nextCursor;
  }
  return { sources, pages };
}
async function allLive(account) {
  const captures = [], pages = [], seen = new Set(); let cursor = null;
  do {
    const page = await api(account, 'measurements/live?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    captures.push(...page.captures); pages.push(page.captures.length); cursor = page.nextCursor;
    if (cursor) { assert(!seen.has(cursor)); seen.add(cursor); assert(seen.size < 10); }
  } while (cursor);
  return { captures, pages };
}
async function adoptAll(account) {
  let cursor = null, linked = 0, skipped = 0; const pages = [], seen = new Set();
  do {
    const result = await api(account, 'objects/adopt', 'POST', cursor ? { cursor } : {});
    linked += result.linked; skipped += result.skipped; pages.push(result.linked); cursor = result.nextCursor;
    if (cursor) { assert(!seen.has(cursor)); seen.add(cursor); assert(seen.size < 10); }
  } while (cursor);
  return { linked, skipped, pages };
}
async function run() {
  assert(['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST), 'Only a loopback database is allowed');
  assert.equal(process.env.DB_NAME, 'blade_vms_playground');
  db = await mysql.createConnection({ host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  try {
    for (const account of accounts) {
      const username = 'qa-catalog-' + randomUUID(), password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
      await db.execute('INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,1)',
        [account.id, username, 'QA metadata contract ' + account.label, salt + ':' + scryptSync(password, salt, 64).toString('hex'), account.role, account.tenant]);
      const session = await api(account, 'session', 'POST', { username, password }); account.token = session.token;
    }
    const [owner, colleague, outsider] = accounts;
    for (let index = 0; index < total; index++) fixtures.push(fixture(owner, index));
    const foreign = [fixture(colleague, 800), fixture(outsider, 900)];
    await insertFixtures([...fixtures, ...foreign]);
    const initial = await allSources(owner, true), liveInitial = await allLive(owner);
    assert.equal(initial.sources.length, total); assert.equal(new Set(initial.sources.map(s => s.key)).size, total);
    assert.deepEqual(initial.pages, [200, 200, 112]); assert.deepEqual(liveInitial.pages, [200, 200, 112]);
    assert.equal(liveInitial.captures.length, total); assert.equal(new Set(liveInitial.captures.map(c => c.id)).size, total);
    assert(initial.sources.every(s => s.context === null), 'Historical fixtures must initially remain unlinked');
    assert.equal(initial.sources.at(-1).reference.id, fixtures[0].id, 'Oldest record beyond 500 must remain discoverable');
    check('512 records enumerate without duplicates or truncation in catalogue, source pages and live pages');
    assert.equal((await allSources(colleague)).sources.length, 1);
    assert.equal((await allLive(outsider)).captures.length, 1);
    await api(outsider, 'captures/' + fixtures[0].id, 'GET', undefined, 404);
    await api(colleague, 'captures/' + fixtures[0].id, 'GET', undefined, 404);
    check('Pagination preserves same-tenant operator ownership and cross-tenant isolation');
    const adopted = await adoptAll(owner);
    assert.equal(adopted.linked, total); assert.equal(adopted.skipped, 0); assert.deepEqual(adopted.pages, [200, 200, 112]);
    const firstSources = await allSources(owner), firstLive = await allLive(owner);
    const liveById = new Map(firstLive.captures.map(c => [c.id, c]));
    for (const source of firstSources.sources) {
      assert(source.context && source.bindingRevision); assert.deepEqual(liveById.get(source.reference.id).context, source.context);
    }
    const again = await adoptAll(owner); assert.equal(again.linked, 0);
    check('Explicit adoption processes all three pages and is idempotent; live and formal contexts agree');
    const oldest = fixtures[0], source = firstSources.sources.find(s => s.reference.id === oldest.id);
    const objectList = (await api(owner, 'objects')).objects;
    const destination = objectList.find(o => o.kind === 'position' && o.code === 'P5' && o.parentId === source.context.bladeId);
    assert(destination);
    const manualCampaign = (await api(owner, 'objects', 'POST', { kind: 'campaign', code: 'QA-MANUAL-COLLECTION', name: 'QA manually assigned task',
      parentId: source.context.farmId, turbineIds: [source.context.turbineId] })).object;
    const manual = { ...source.context, positionId: destination.id, campaignId: manualCampaign.id };
    await api(owner, 'objects/link', 'POST', { reference: source.reference, revision: source.bindingRevision, context: manual });
    const registered = await api(owner, 'captures', 'POST', { clientId: oldest.clientId, recording: oldest.recording }, 201);
    assert.equal(registered.capture.id, oldest.id); assert.equal(registered.association.reason, 'already_linked');
    await api(owner, 'captures/' + oldest.id + '/live', 'PUT', { sequence: Date.now(), sentAt: Date.now(), state: 'stopped', recording: oldest.recording });
    const completed = await api(owner, 'captures/' + oldest.id + '/complete', 'POST', {});
    assert.equal(completed.association.reason, 'already_linked');
    await adoptAll(owner);
    const finalSources = await allSources(owner), finalLive = await allLive(owner);
    const finalSource = finalSources.sources.find(s => s.reference.id === oldest.id), finalCapture = finalLive.captures.find(c => c.id === oldest.id);
    assert.deepEqual(finalSource.context, manual); assert.deepEqual(finalCapture.context, manual);
    assert.equal(finalCapture.recording.pointCycle.radialPointName, 'p1', 'Manual binding must not rewrite original acquisition metadata');
    assert.equal(finalCapture.identity.positionCode, 'P1', 'Original identity and manual destination must stay distinct');
    assert.equal(finalSources.sources.length, total); assert.equal(finalLive.captures.length, total);
    check('Manual rebind of the oldest record survives duplicate registration, terminal sync, complete retry and repeated adoption');
    report.sourcePages = initial.pages; report.livePages = liveInitial.pages; report.adoptionPages = adopted.pages;
    report.totalCaptures = total; report.manualContextPreserved = true;
    report.archiveWorkerUsed = false;
  } catch (error) { failure = error; console.error(error.stack || error.message); }
  finally {
    try {
      assert(tenant.startsWith(prefix) && otherTenant.startsWith(prefix));
      const [captures] = await db.execute('SELECT id FROM captures WHERE tenant IN (?,?)', [tenant, otherTenant]);
      const captureRoot = path.resolve(process.env.BLADE_CAPTURE_DATA_DIR || path.join(root, '.data/web-captures'));
      for (const capture of captures) { assert.match(capture.id, /^[a-f0-9]{32}$/); fs.rmSync(path.join(captureRoot, capture.id), { recursive: true, force: true }); }
      await db.execute('DELETE FROM captures WHERE tenant IN (?,?)', [tenant, otherTenant]);
      await db.execute('DELETE FROM records WHERE tenant IN (?,?)', [tenant, otherTenant]);
      await db.execute('DELETE FROM audit_logs WHERE tenant IN (?,?)', [tenant, otherTenant]);
      const analysisRoot = path.resolve(process.env.BLADE_ANALYSIS_DATA_DIR || path.join(root, '.data/web-rotation'));
      for (const account of accounts) {
        await db.execute('DELETE FROM sync_imports WHERE user_id=? AND tenant=?', [account.id, account.tenant]);
        await db.execute('DELETE FROM sessions WHERE user_id=?', [account.id]);
        await db.execute('DELETE FROM users WHERE id=? AND tenant=?', [account.id, account.tenant]);
        fs.rmSync(path.join(analysisRoot, sha(account.tenant + '\0' + account.id)), { recursive: true, force: true });
      }
      for (const table of ['captures', 'records', 'audit_logs', 'users']) {
        const [remaining] = await db.execute('SELECT COUNT(*) AS n FROM ' + table + ' WHERE tenant IN (?,?)', [tenant, otherTenant]);
        assert.equal(Number(remaining[0].n), 0, 'QA cleanup incomplete: ' + table);
      }
      report.qaCleaned = true;
    } catch (error) { failure ||= error; console.error('Cleanup: ' + error.message); }
    await db.end();
    report.passed = !failure; report.error = failure?.message || null;
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
  if (failure) process.exitCode = 1;
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
