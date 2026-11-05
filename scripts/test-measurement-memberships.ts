/** Local DB integration: isolated identities, removed in finally; no waveform or device access. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, run, type User } from '../apps/web/lib/db';
import { measurementMemberships } from '../apps/web/lib/measurement-memberships';

async function main() {
  assert.ok(['127.0.0.1', 'localhost'].includes(process.env.DB_HOST || ''), 'Local database only');
  const tenant = `selector-test-${randomUUID()}`, otherTenant = `${tenant}-other`, owner = randomUUID();
  const user: User = { id: owner, username: owner, name: 'selector test', role: 'operator', tenant, active: 1 };
  const context = (positionId: string) => ({ farmId: 'farm', campaignId: 'batch', turbineId: 'turbine', bladeId: 'blade', positionId });
  async function link(kind: string, id: string, point: string, t = tenant) {
    await run("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'measurement_links',?,?,?)", [randomUUID(), t, JSON.stringify({ reference: { kind, id }, context: context(point) }), owner]);
  }
  async function capture(point: string, options: any = {}) {
    const id = randomUUID().replaceAll('-', ''), t = options.tenant || tenant;
    await run('INSERT INTO captures(id,owner_id,tenant,client_id,local_id,body) VALUES(?,?,?,?,?,?)', [id, options.owner || owner, t, 'selector-test', id, JSON.stringify({ uploadState: options.uploadState || 'complete', recording: options.recording || { source: 'measured' } })]);
    await link('capture', id, point, t);
    return id;
  }
  async function task(point: string, taskOwner: string) {
    const id = randomUUID();
    await run("INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'tasks',?,?,?)", [id, tenant, JSON.stringify({ source: 'measured' }), taskOwner]);
    await link('task', id, point);
  }
  try {
    for (let i = 0; i < 205; i++) await capture(`point-${i}`);
    await capture('unfinished', { uploadState: 'uploading' });
    await capture('mock', { recording: { source: 'mock' } });
    await capture('demo', { recording: { demo: true } });
    await capture('simulation', { recording: { sourceMetadata: { simulation: true } } });
    await capture('other-owner', { owner: 'other-owner' });
    await capture('other-tenant', { tenant: otherTenant });
    const deleted = await capture('deleted');
    await run('DELETE FROM captures WHERE id=? AND tenant=?', [deleted, tenant]);
    await link('task', randomUUID(), 'orphan-task');
    await task('own-task', owner);
    await task('other-task', 'other-owner');
    const imported = { context: context('import') };
    const own = await measurementMemberships(user, [imported, imported]);
    assert.equal(own.length, 207, 'All 205 captures plus own task and deduplicated native import');
    assert.ok(own.some(c => c.positionId === 'point-204'), 'Memberships go beyond the first source page');
    for (const p of ['unfinished', 'mock', 'demo', 'simulation', 'other-owner', 'other-tenant', 'deleted', 'orphan-task', 'other-task']) {
      assert.ok(!own.some(c => c.positionId === p), `Must exclude ${p}`);
    }
    for (const role of ['analyst', 'admin'] as const) {
      const all = await measurementMemberships({ ...user, role }, [imported]);
      assert.equal(all.length, 209, `${role} may read same-tenant colleagues, never other tenants or incomplete sources`);
    }
    console.log('PASS complete membership index beyond pagination, ownership, tenant isolation, deleted sources, quality flags and deduplication');
  } finally {
    await run('DELETE FROM records WHERE tenant IN (?,?)', [tenant, otherTenant]);
    await run('DELETE FROM captures WHERE tenant IN (?,?)', [tenant, otherTenant]);
    await pool().end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
