import type { CaptureSummary } from "./capture-types";
import type { FieldRecording } from "./field-types";

export function hasBladePassMetadata(record: FieldRecording): boolean {
  const source = (record as FieldRecording & { sourceMetadata?: { pointCycle?: unknown } }).sourceMetadata;
  return record.pointCycle !== undefined || source?.pointCycle !== undefined;
}

/** Only prepare records from the selected acquisition client and task, never by name. */
export function bladeCaptureSelection(captures: readonly CaptureSummary[], selected: CaptureSummary) {
  const point = selected.recording.pointCycle;
  if (point?.mode !== "automatic_stations" || !point.collectionId || !point.bladeId) {
    return { automatic: false, captures: selected.uploadState === "complete" ? [selected] : [], pending: 0 };
  }
  const latest = [selected, ...captures.filter(item => item.id !== selected.id)];
  const related = latest.filter(item => item.ownerId === selected.ownerId && item.clientId === selected.clientId &&
    item.recording.pointCycle?.mode === "automatic_stations" && item.recording.pointCycle.collectionId === point.collectionId && item.recording.pointCycle.bladeId === point.bladeId);
  return { automatic: true, captures: related.filter(item => item.uploadState === "complete"),
    pending: related.filter(item => item.uploadState !== "complete").length };
}

export async function prepareBladeCaptures(captures: readonly CaptureSummary[], prepare: (id: string) => Promise<FieldRecording>, active: () => boolean) {
  const prepared: FieldRecording[] = [];
  for (const item of captures) {
    if (!active()) return null;
    const recording = await prepare(item.id);
    if (!active()) return null;
    prepared.push(recording);
  }
  return active() ? prepared : null;
}
