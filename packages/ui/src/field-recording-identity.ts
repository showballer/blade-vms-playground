import type { FieldRecording } from "./field-types";

const importId = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 180 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** Import manifests carry opaque collection IDs, not acquisition-session UUIDs. */
export function importedCollectionId(record: FieldRecording): string | null {
  const meta = record.pointCycle;
  return (record.source === "split_segment_import" || record.source === "simulation") &&
    meta && meta.mode === undefined && importId(meta.collectionId) ? meta.collectionId : null;
}

export function recordingCollectionId(record: FieldRecording): string | null {
  const value = record.pointCycle?.collectionId;
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value) ? value : importedCollectionId(record);
}
