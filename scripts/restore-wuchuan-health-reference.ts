/** Restore reviewed response references without changing captures, dates or Huade rules. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {rows, pool, type User} from '../apps/web/lib/db';
import {objects, listMeasurementRows} from '../apps/web/lib/measurement-store';
import {processingResult, processingEndpoint} from '../apps/web/lib/measurement-processing';
import {bladeHealthEndpoint} from '../apps/web/lib/measurement-blade-health';
import {healthObservations, syntheticProcessing} from '../packages/ui/src/blade-health-standard';

const directory = path.resolve('data/task-catalog/20261110');
async function fileHash(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function compare(actual: any, expected: any, key = 'observation') {
  if (typeof expected === 'number') {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-12), key);
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', key);
    for (const name of Object.keys(expected)) {
      // Importing the same capture on another machine may assign a new record ID.
      if (name !== 'recordingId') compare(actual[name], expected[name], `${key}.${name}`);
    }
  } else assert.equal(actual, expected, key);
}
async function main() {
  let database: ReturnType<typeof pool> | undefined;
  try {
    const apply = process.argv.includes('--apply');
    const checkDatabase = apply || process.argv.includes('--check-db');
    const index = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(index.schema, 'blade-current-tasks-20261110-v1');
    for (const item of [index.reference, index.windAndHuadeConfig, ...index.tasks.flatMap((t: any) => t.archives)]) {
      assert.ok(item.path.startsWith('data/') && !item.path.split('/').includes('..'));
      assert.equal(await fileHash(item.path), item.sha256, item.path);
    }
    const fixture = JSON.parse(await readFile(index.reference.path, 'utf8'));
    assert.equal(fixture.schema, 'wuchuan-health-reference-20261110-v1');
    console.log('Three task bundles and reference configuration: checksums verified.');
    if (!checkDatabase) return;
    database = pool();
    const username = process.argv.find(v => v.startsWith('--username='))?.slice(11) || 'admin';
    const [user] = await rows<User>('SELECT id,username,name,role,tenant,active FROM users WHERE username=? AND active=1 AND deleted_at IS NULL', [username]);
    assert.ok(user && ['admin', 'analyst'].includes(user.role), 'Existing administrator or analyst required');
    const all = await objects(user);
    const plans: any[] = [];
    // Validate BOTH tasks fully before publishing anything.
    for (const task of fixture.tasks) {
      const farms = all.filter(o => o.active && o.kind === 'farm' && o.name === task.farm);
      assert.equal(farms.length, 1, `Import farm first: ${task.farm}`);
      const turbines = all.filter(o => o.active && o.kind === 'turbine' && o.parentId === farms[0].id && (o.windTurbineCode || o.code) === task.turbineCode);
      assert.equal(turbines.length, 1, `Import turbine first: ${task.turbineCode}`);
      const campaigns = all.filter(o => o.active && o.kind === 'campaign' && o.parentId === farms[0].id && [task.name, ...task.aliases].includes(o.name) && o.turbineIds?.includes(turbines[0].id));
      assert.equal(campaigns.length, 1, `Import and analyse task first: ${task.name}`);
      const context = {farmId: farms[0].id, campaignId: campaigns[0].id, turbineId: turbines[0].id};
      const workspace = await bladeHealthEndpoint(user, {action: 'workspace', context});
      assert.equal(workspace.blades.length, 3);
      const versions = [];
      for (const blade of task.blades) {
        const item = workspace.blades.find((b: any) => String(all.find(o => o.id === b.bladeId)?.code) === blade.code);
        assert.ok(item?.processingResultId, `Analyse ${task.name} / blade ${blade.code} first`);
        const version = await processingResult(user, item.processingResultId);
        assert.equal(syntheticProcessing(version), false);
        const actual = healthObservations(version, blade.code);
        assert.equal(actual.length, 20);
        assert.equal(new Set(actual.map(o => `${o.sourceHash}|${o.point}|${o.angle}`)).size, 20);
        for (const expected of blade.observations) {
          const observation = actual.find(o => o.sourceHash === expected.sourceHash && o.point === expected.point && o.angle === expected.angle);
          assert.ok(observation, `Capture differs: ${task.name}/${blade.code}/${expected.point}/${expected.angle}`);
          compare(observation, expected);
        }
        versions.push(version);
      }
      plans.push({task, context, versions, workspace});
      console.log(`${task.name}: 60 source hashes and feature rows verified.`);
    }
    const huade = all.filter(o => o.active && o.kind === 'campaign' && o.name === '化德风场B071-20');
    async function huadeDetection() {
      return Promise.all(huade.map(async c => {
        const w = await bladeHealthEndpoint(user, {action: 'workspace', context: {farmId: c.parentId, campaignId: c.id, turbineId: c.turbineIds?.[0]}});
        return w.blades.map((b: any) => ({bladeId: b.bladeId, detection: b.syntheticScenario?.detection}));
      }));
    }
    const huadeBefore = await huadeDetection();
    if (!apply) { console.log('Database check passed; no changes made.'); return; }
    const output = path.resolve('artifacts', `wuchuan-reference-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(output, {recursive: true});
    await writeFile(path.join(output, 'before.json'), JSON.stringify({plans, standards: await listMeasurementRows(user, 'measurement_health_standards'), huade: huadeBefore}, null, 2), {mode: 0o600});
    const result = [];
    for (const {task, context, versions, workspace} of plans) {
      for (const version of versions) if (!version.published) await processingEndpoint(user, {request: {action: 'publish', jobId: version.id}});
      const ids = versions.map((v: any) => v.id).sort();
      const current = workspace.standard;
      if (current?.mode !== 'response_reference' || JSON.stringify([...(current.sourceIds || [])].sort()) !== JSON.stringify(ids)) {
        await bladeHealthEndpoint(user, {action: 'publish-standard', context, mode: 'response_reference', sourceIds: ids, confirmHealthy: true, name: task.name.replace('风机测量任务', '健康响应参考'), approval: fixture.approval});
      }
      const health = await bladeHealthEndpoint(user, {action: 'evaluate', context});
      assert.equal(health.blades.length, 3);
      for (const blade of health.blades) {
        assert.equal(blade.status, 'normal');
        assert.equal(blade.healthScreening?.baselineMember, true);
        assert.equal(blade.healthScreening?.comparisons?.length, 100);
        assert.equal(blade.healthScreening.comparisons.filter((c: any) => c.outside).length, 0);
      }
      result.push({name: task.name, health});
      console.log(`${task.name}: 3 normal reference members; each 0/100 outside.`);
    }
    assert.deepEqual(await huadeDetection(), huadeBefore, 'Huade detector changed');
    await writeFile(path.join(output, 'after.json'), JSON.stringify(result, null, 2), {mode: 0o600});
    console.log(`Saved restore audit: ${output}`);
  } finally { await database?.end(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
