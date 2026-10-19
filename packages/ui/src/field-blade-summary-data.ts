import type { FieldAutomaticRecord, FieldPlannedStation, FieldRecording, FieldSyncItem } from "./field-types";

export type BladeStationState = "observed" | "missing_entry" | "missing_exit" | "signal_gap" | "cancelled" | "failed" | "incomplete" | "unrecorded";
export type BladeStationSummary = {
  id: string; index: number; azimuthDeg: number | null; planned: boolean;
  state: BladeStationState; records: FieldRecording[]; samples: number;
};
export type BladeRecordGroup = {
  key: string; sessionId: string; collectionId: string | null; taskName: string; bladeId: string; radialPointId: string; radialPointName: string;
  radiusM: number | null; lapIndex: number; plannedCount: number | null; stations: BladeStationSummary[];
  observedCount: number; gapCount: number; failedCount: number; incompleteCount: number; pendingCount: number;
  recordCount: number; samples: number; uploadedCount: number; pendingUploadCount: number; failedUploadCount: number;
  unknownUploadCount: number; planConflict: boolean; hasSimulation: boolean; latestAt: number;
};
export type BladeCollectionSummary = {
  key: string; collectionId: string | null; bladeId: string; taskName: string;
  groups: BladeRecordGroup[]; pointCount: number; sessionCount: number; latestAt: number;
};
export type BladeRecordSummary = { groups: BladeRecordGroup[]; collections: BladeCollectionSummary[]; ungroupedCount: number };
type AutomaticRecord = FieldRecording & { pointCycle: NonNullable<FieldRecording["pointCycle"]> & Required<Pick<FieldAutomaticRecord,
  "sessionId" | "bladeId" | "radialPointId" | "lapIndex" | "stationIndex" | "stationCount">> & { pointId: string } };
type Session = { records: AutomaticRecord[]; plan: FieldPlannedStation[] | null; cycles: number; conflict: boolean; latestAt: number;
  collectionId: string | null; collectionConflict: boolean; taskName: string };

const id = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 180;
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const sampleCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const key = (...parts: (string | number)[]) => JSON.stringify(parts);
const collectionId = (value: unknown): string | null => typeof value === "string" && value.length === 32 && /^[a-f0-9]{32}$/.test(value) ? value : null;
// Acquisition manifests use Unix seconds; imported ISO dates use milliseconds.
const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value * 1000 : typeof value === "string" ? Date.parse(value) || 0 : 0;
const recordTime = (record: FieldRecording) => timestamp(record.endedAt) || timestamp(record.startedAt);
const realRecord = (record: FieldRecording) => record.source === "polytec_ivs500" && !record.simulation;

function automatic(record: FieldRecording): record is AutomaticRecord {
  const value = record.pointCycle;
  return value?.mode === "automatic_stations" && typeof value.sessionId === "string" && /^[a-f0-9]{32}$/.test(value.sessionId) &&
    id(value.bladeId) && id(value.radialPointId) && id(value.pointId) && integer(value.lapIndex, 100) &&
    integer(value.stationIndex, 200) && integer(value.stationCount, 200) && integer(value.cycles, 100) && value.lapIndex <= value.cycles;
}

function stationPlan(value: unknown): FieldPlannedStation[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) return null;
  const seen = new Set<string>();
  const result: FieldPlannedStation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || !id(item.pointId) || !id(item.bladeId) || !id(item.radialPointId) ||
      !id(item.radialPointName) || !finite(item.radiusM) || item.radiusM <= 0 || item.radiusM > 1000 || !finite(item.azimuthDeg) || item.azimuthDeg < 0 || item.azimuthDeg >= 360 ||
      !integer(item.stationIndex, 200) || !integer(item.stationCount, 200)) return null;
    const identity = key(item.bladeId, item.radialPointId, item.pointId);
    if (seen.has(identity)) return null;
    seen.add(identity);
    result.push({ pointId: item.pointId, bladeId: item.bladeId, radialPointId: item.radialPointId, radialPointName: item.radialPointName,
      radiusM: item.radiusM, azimuthDeg: item.azimuthDeg, stationIndex: item.stationIndex, stationCount: item.stationCount });
  }
  return result.sort((a, b) => key(a.bladeId, a.radialPointId).localeCompare(key(b.bladeId, b.radialPointId)) || a.stationIndex - b.stationIndex || a.pointId.localeCompare(b.pointId));
}

function state(record: FieldRecording): BladeStationState {
  const completion = record.pointCycle?.completion;
  if (completion === "cancelled") return "cancelled";
  // Timed-out records finish(error) too. Preserve their explicit observation gap
  // instead of conflating missing echo evidence with a device failure.
  if (["missing_entry", "missing_exit", "signal_gap"].includes(completion || "")) return completion as BladeStationState;
  if (record.status === "error" || record.error || completion === "device_error") return "failed";
  if (record.status !== "complete") return "incomplete";
  // A saved file or an RSSI value alone does not prove a confirmed passage.
  if (completion === "confirmed_pass" && sampleCount(record.samples) > 0 && realRecord(record)) return "observed";
  return "incomplete";
}

function emptyGroup(sessionId: string, bladeId: string, radialPointId: string, radialPointName: string, radiusM: number | null, lapIndex: number, session: Session): BladeRecordGroup {
  return { key: key(sessionId, bladeId, radialPointId, lapIndex), sessionId, collectionId: session.collectionConflict ? null : session.collectionId,
    taskName: session.taskName, bladeId, radialPointId, radialPointName, radiusM, lapIndex,
    plannedCount: null, stations: [], observedCount: 0, gapCount: 0, failedCount: 0, incompleteCount: 0, pendingCount: 0,
    recordCount: 0, samples: 0, uploadedCount: 0, pendingUploadCount: 0, failedUploadCount: 0, unknownUploadCount: 0,
    planConflict: session.conflict || session.collectionConflict, hasSimulation: false, latestAt: session.latestAt };
}

/** Groups saved station observations; never reconstructs identity or missing waveforms. */
export function summarizeBladeRecords(recordings: readonly FieldRecording[], syncItems: readonly FieldSyncItem[] = []): BladeRecordSummary {
  const unique = new Map<string, FieldRecording>();
  for (const record of recordings) {
    if (!record || !id(record.id)) continue;
    const previous = unique.get(record.id);
    if (!previous || recordTime(record) > recordTime(previous) || recordTime(record) === recordTime(previous) && previous.status === "incomplete" && record.status !== "incomplete") unique.set(record.id, record);
  }
  const sessions = new Map<string, Session>();
  let ungroupedCount = 0;
  // Earlier snapshots establish the original plan; contradictory later plans are visible.
  for (const record of [...unique.values()].sort((a, b) => recordTime(a) - recordTime(b) || a.id.localeCompare(b.id))) {
    if (!record.pointCycle) continue;
    if (!automatic(record)) { ungroupedCount++; continue; }
    const meta = record.pointCycle;
    const taskId = collectionId(meta.collectionId);
    let session = sessions.get(meta.sessionId);
    if (!session) { session = { records: [], plan: null, cycles: meta.cycles, conflict: false, latestAt: 0,
      collectionId: taskId, collectionConflict: meta.collectionId !== undefined && taskId === null,
      taskName: typeof record.name === "string" && record.name.trim() || "未命名采集任务" }; sessions.set(meta.sessionId, session); }
    // A malformed or contradictory task identity must never join another run.
    if (session.collectionId !== taskId || meta.collectionId !== undefined && taskId === null) session.collectionConflict = true;
    session.records.push(record);
    session.latestAt = Math.max(session.latestAt, recordTime(record));
    if (session.cycles !== meta.cycles) session.conflict = true;
    session.cycles = Math.max(session.cycles, meta.cycles);
    const plan = stationPlan(meta.plannedStations);
    if (meta.plannedStations !== undefined && !plan) session.conflict = true;
    if (plan) {
      if (session.plan && JSON.stringify(session.plan) !== JSON.stringify(plan)) session.conflict = true;
      else session.plan = plan;
      const byPoint = new Map<string, FieldPlannedStation[]>();
      for (const station of plan) {
        const pointKey = key(station.bladeId, station.radialPointId);
        byPoint.set(pointKey, [...(byPoint.get(pointKey) || []), station]);
      }
      for (const stations of byPoint.values()) if (stations.some((station, index) => station.stationCount !== stations.length || station.stationIndex !== index + 1)) session.conflict = true;
    }
  }
  const groups = new Map<string, BladeRecordGroup>();
  for (const [sessionId, session] of sessions) {
    for (const station of session.plan || []) for (let lap = 1; lap <= session.cycles; lap++) {
      const groupKey = key(sessionId, station.bladeId, station.radialPointId, lap);
      let group = groups.get(groupKey);
      if (!group) { group = emptyGroup(sessionId, station.bladeId, station.radialPointId, station.radialPointName, station.radiusM, lap, session); groups.set(groupKey, group); }
      if (group.stations.some(item => item.index === station.stationIndex) || group.radiusM !== station.radiusM) group.planConflict = true;
      group.stations.push({ id: station.pointId, index: station.stationIndex, azimuthDeg: station.azimuthDeg, planned: true, state: "unrecorded", records: [], samples: 0 });
      group.plannedCount = group.stations.length;
    }
    for (const record of session.records) {
      const meta = record.pointCycle;
      const groupKey = key(sessionId, meta.bladeId, meta.radialPointId, meta.lapIndex);
      let group = groups.get(groupKey);
      if (!group) { group = emptyGroup(sessionId, meta.bladeId, meta.radialPointId, meta.radialPointName || meta.radialPointId, finite(meta.radiusM) ? meta.radiusM : null, meta.lapIndex, session); groups.set(groupKey, group); }
      let station = group.stations.find(item => item.id === meta.pointId);
      if (!station) {
        station = { id: meta.pointId, index: meta.stationIndex, azimuthDeg: finite(meta.azimuthDeg) ? meta.azimuthDeg : null, planned: false, state: "unrecorded", records: [], samples: 0 };
        group.stations.push(station);
        if (session.plan) group.planConflict = true;
      } else if (station.index !== meta.stationIndex || station.azimuthDeg !== meta.azimuthDeg || group.radiusM !== meta.radiusM || group.plannedCount !== meta.stationCount) group.planConflict = true;
      station.records.push(record);
      group.hasSimulation ||= record.source === "simulation" || !!record.simulation;
    }
  }
  const sync = new Map(syncItems.map(item => [item.recordingId, item]));
  for (const group of groups.values()) {
    group.stations.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
    for (const station of group.stations) {
      station.records.sort((a, b) => recordTime(b) - recordTime(a) || a.id.localeCompare(b.id));
      station.state = station.records.length ? state(station.records[0]) : "unrecorded";
      station.samples = station.records.reduce((sum, record) => sum + sampleCount(record.samples), 0);
      group.samples += station.samples;
      group.recordCount += station.records.length;
      if (station.state === "observed") group.observedCount++;
      if (["missing_entry", "missing_exit", "signal_gap"].includes(station.state)) group.gapCount++;
      if (station.state === "failed") group.failedCount++;
      if (["incomplete", "cancelled"].includes(station.state)) group.incompleteCount++;
      if (station.state === "unrecorded") group.pendingCount++;
      for (const record of station.records) {
        const item = sync.get(record.id);
        if (!item) group.unknownUploadCount++;
        else if (item.state === "synced") group.uploadedCount++;
        else if (item.state === "error") group.failedUploadCount++;
        else group.pendingUploadCount++;
      }
    }
  }
  const ordered = [...groups.values()].sort((a, b) => b.latestAt - a.latestAt || a.sessionId.localeCompare(b.sessionId) || a.bladeId.localeCompare(b.bladeId, "zh-CN", { numeric: true }) || a.radialPointId.localeCompare(b.radialPointId, "zh-CN", { numeric: true }) || a.lapIndex - b.lapIndex);
  const collections = new Map<string, BladeCollectionSummary>();
  for (const group of ordered) {
    // Names are labels only. Legacy sessions and explicitly identified tasks use
    // separate namespaces, even when their UUID text happens to match.
    const collectionKey = key(group.collectionId ? "collection" : "session", group.collectionId || group.sessionId, group.bladeId);
    let collection = collections.get(collectionKey);
    if (!collection) { collection = { key: collectionKey, collectionId: group.collectionId, bladeId: group.bladeId,
      taskName: group.taskName, groups: [], pointCount: 0, sessionCount: 0, latestAt: group.latestAt }; collections.set(collectionKey, collection); }
    collection.groups.push(group);
  }
  for (const collection of collections.values()) {
    collection.pointCount = new Set(collection.groups.map(group => group.radialPointId)).size;
    collection.sessionCount = new Set(collection.groups.map(group => group.sessionId)).size;
  }
  return { groups: ordered, collections: [...collections.values()], ungroupedCount };
}

export const bladeStationLabel = (value: BladeStationState) => ({ observed: "已观测回波通过", missing_entry: "未确认进入", missing_exit: "未确认离开", signal_gap: "信号中断", cancelled: "已取消", failed: "采集失败", incomplete: "记录未完成", unrecorded: "未收到记录" })[value];
