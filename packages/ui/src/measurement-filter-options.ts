import type { MeasurementContext, MeasurementObject } from './measurement-domain';

export type MeasurementFilterKind = MeasurementObject['kind'];
const keyFor = (kind: MeasurementFilterKind) => `${kind}Id` as keyof MeasurementContext;
const descendants = ['farm', 'turbine', 'blade', 'position'] as const;

/** Memberships cover all accessible records, independently of waveform pagination. */
export function measurementFilterOptions(objects: MeasurementObject[], memberships: MeasurementContext[], value: Partial<MeasurementContext>, kind: MeasurementFilterKind) {
  if (kind === 'campaign') return objects.filter(o => o.kind === kind);
  const parentKey = kind === 'turbine' ? 'farmId' : kind === 'blade' ? 'turbineId' : kind === 'position' ? 'bladeId' : null;
  const scopeKeys = descendants.slice(0, descendants.indexOf(kind)).map(keyFor);
  const memberIds = value.campaignId ? new Set(memberships
    .filter(m => m.campaignId === value.campaignId && scopeKeys.every(key => !value[key] || m[key] === value[key]))
    .map(m => m[keyFor(kind)])) : null;
  return objects.filter(o => o.kind === kind && (!parentKey || !!value[parentKey] && o.parentId === value[parentKey]) && (!memberIds || memberIds.has(o.id)));
}

export function normalizeMeasurementFilters(objects: MeasurementObject[], memberships: MeasurementContext[], value: Partial<MeasurementContext>): Partial<MeasurementContext> {
  const next = { ...value };
  if (next.campaignId && !objects.some(o => o.kind === 'campaign' && o.id === next.campaignId)) next.campaignId = '';
  for (const kind of descendants) {
    const key = keyFor(kind), options = measurementFilterOptions(objects, memberships, next, kind);
    if (!options.some(o => o.id === next[key])) next[key] = options.length === 1 ? options[0].id : '';
  }
  return next;
}

export function changeMeasurementFilter(objects: MeasurementObject[], memberships: MeasurementContext[], value: Partial<MeasurementContext>, kind: MeasurementFilterKind, id: string) {
  return normalizeMeasurementFilters(objects, memberships, { ...value, [keyFor(kind)]: id });
}

export function sameMeasurementFilters(a: Partial<MeasurementContext>, b: Partial<MeasurementContext>) {
  return ['campaign', ...descendants].every(kind => (a[keyFor(kind as MeasurementFilterKind)] || '') === (b[keyFor(kind as MeasurementFilterKind)] || ''));
}
