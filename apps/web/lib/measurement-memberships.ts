import { captureScope, recordScope, rows, type User } from './db';
import { isHealthDemo } from '@blade/ui/health-workspace-data';
import type { MeasurementContext } from '@blade/ui/measurement-domain';

type MembershipRow = { context: MeasurementContext | string; quality: any };
const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;

/** The selector index contains identities only, never waveforms or paged sources. */
export async function measurementMemberships(user: User, imports: { context: MeasurementContext | null }[]) {
  const captures = captureScope(user), tasks = recordScope(user, 'tasks');
  const quality = (body: string, path: string) => `JSON_OBJECT(
    'source',JSON_EXTRACT(${body},'${path}.source'),
    'demo',JSON_EXTRACT(${body},'${path}.demo'),
    'simulation',JSON_EXTRACT(${body},'${path}.simulation'),
    'sourceMetadata',JSON_EXTRACT(${body},'${path}.sourceMetadata'))`;
  const [captureRows, taskRows] = await Promise.all([
    rows<MembershipRow>(`SELECT DISTINCT JSON_EXTRACT(l.body,'$.context') AS context, ${quality('c.body', '$.recording')} AS quality
      FROM records l JOIN captures c ON c.id=JSON_UNQUOTE(JSON_EXTRACT(l.body,'$.reference.id')) AND c.tenant=l.tenant
      WHERE l.kind='measurement_links' AND l.tenant=? AND JSON_UNQUOTE(JSON_EXTRACT(l.body,'$.reference.kind'))='capture'
      AND JSON_UNQUOTE(JSON_EXTRACT(c.body,'$.uploadState'))='complete' ${captures.sql}`, [user.tenant, ...captures.args]),
    rows<MembershipRow>(`SELECT DISTINCT JSON_EXTRACT(l.body,'$.context') AS context, ${quality('r.body', '$')} AS quality
      FROM records l JOIN records r ON r.id=JSON_UNQUOTE(JSON_EXTRACT(l.body,'$.reference.id')) AND r.kind='tasks' AND r.tenant=l.tenant
      WHERE l.kind='measurement_links' AND l.tenant=? AND JSON_UNQUOTE(JSON_EXTRACT(l.body,'$.reference.kind'))='task' ${tasks.sql}`, [user.tenant, ...tasks.args]),
  ]);
  const contexts = [...captureRows, ...taskRows].filter(r => !isHealthDemo(json(r.quality))).map(r => json(r.context));
  // Native imports have already passed the worker's account and quality filter.
  contexts.push(...imports.map(s => s.context));
  const keys = ['campaignId', 'farmId', 'turbineId', 'bladeId', 'positionId'] as const;
  return [...new Map(contexts.filter(c => c && keys.every(key => typeof c[key] === 'string' && c[key]))
    .map(c => { const context = Object.fromEntries(keys.map(key => [key, c[key]])) as MeasurementContext; return [JSON.stringify(context), context]; })).values()];
}
