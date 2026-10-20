import { fieldDate, type FieldAutomaticRecord, type FieldPlannedStation, type FieldRecording, type FieldSyncItem } from "./field-types";

export type BladeStationState = "observed" | "missing_entry" | "missing_exit" | "signal_gap" | "cancelled" | "failed" | "incomplete" | "unrecorded";
export type BladeStationSummary = {
  id: string; index: number; azimuthDeg: number | null; planned: boolean;
  state: BladeStationState; records: FieldRecording[]; samples: number;
};
export type BladeRecordGroup = {
  key: string; sessionId: string; collectionId: string | null; taskName: string; bladeId: string; radialPointId: string; radialPointName: string;
  windFarm: string; turbine: string; measurementObject: string;
  radiusM: number | null; lapIndex: number; plannedCount: number | null; stations: BladeStationSummary[];
  observedCount: number; gapCount: number; failedCount: number; incompleteCount: number; pendingCount: number;
  recordCount: number; samples: number; uploadedCount: number; pendingUploadCount: number; failedUploadCount: number;
  unknownUploadCount: number; planConflict: boolean; hasSimulation: boolean; latestAt: number;
};
export type BladeCollectionSummary = {
  key: string; taskKey: string; collectionId: string | null; bladeId: string; taskName: string; windFarm: string; turbine: string; measurementObject: string;
  groups: BladeRecordGroup[]; pointCount: number; sessionCount: number; latestAt: number;
};
export type BladeTaskSummary = {
  key: string; collectionId: string | null; taskName: string; windFarm: string; turbine: string; measurementObject: string;
  blades: BladeCollectionSummary[]; pointCount: number; sessionCount: number; latestAt: number;
};
export type BladeRecordSummary = { groups: BladeRecordGroup[]; collections: BladeCollectionSummary[]; tasks: BladeTaskSummary[]; taskCount: number; ungroupedCount: number };
type AutomaticRecord = FieldRecording & { pointCycle: NonNullable<FieldRecording["pointCycle"]> & Required<Pick<FieldAutomaticRecord,
  "sessionId" | "bladeId" | "radialPointId" | "lapIndex" | "stationIndex" | "stationCount">> & { pointId: string } };
type Session = { records: AutomaticRecord[]; plan: FieldPlannedStation[] | null; cycles: number; conflict: boolean; latestAt: number;
  collectionId: string | null; collectionConflict: boolean; taskName: string; windFarm: string; turbine: string; measurementObject: string };

const id = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 180;
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const sampleCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const key = (...parts: (string | number)[]) => JSON.stringify(parts);
const collectionId = (value: unknown): string | null => typeof value === "string" && value.length === 32 && /^[a-f0-9]{32}$/.test(value) ? value : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const objectScope = (value: Pick<BladeRecordGroup, "windFarm" | "turbine" | "measurementObject">) => key(value.windFarm, value.turbine, value.measurementObject);
// Acquisition manifests use Unix seconds; imported ISO dates use milliseconds.
const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value * 1000 : typeof value === "string" ? Date.parse(value) || 0 : 0;
const recordTime = (record: FieldRecording) => timestamp(record.endedAt) || timestamp(record.startedAt);
export type BladeRecordingTiming = {
  startedAt: number | null; endedAt: number | null; openEnded: boolean;
  durationSeconds: number | null; partialDuration: boolean;
};
/** Signal duration is samples/rate; inter-record motion gaps are not acquired data. */
export function bladeRecordingTiming(records: readonly FieldRecording[]): BladeRecordingTiming {
  const unique = new Map<string, FieldRecording>();
  for (const record of records) {
    const old = unique.get(record.id);
    if (!old || recordTime(record) >= recordTime(old)) unique.set(record.id, record);
  }
  let startedAt: number | null = null, endedAt: number | null = null;
  let duration = 0, durations = 0, openEnded = false;
  for (const record of unique.values()) {
    const start = fieldDate(record.startedAt)?.getTime() ?? null;
    const end = fieldDate(record.endedAt)?.getTime() ?? null;
    if (start !== null) startedAt = Math.min(startedAt ?? start, start);
    if (end !== null && (start === null || end >= start)) endedAt = Math.max(endedAt ?? end, end);
    else openEnded = true;
    if (Number.isSafeInteger(record.samples) && record.samples >= 0 &&
        (record.samples === 0 || typeof record.sampleRate === "number" && Number.isFinite(record.sampleRate) && record.sampleRate > 0)) {
      const seconds = record.samples === 0 ? 0 : record.samples / record.sampleRate!;
      if (Number.isFinite(seconds) && Number.isFinite(duration + seconds)) { duration += seconds; durations++; }
    }
  }
  return { startedAt, endedAt, openEnded, durationSeconds: durations ? duration : null,
    partialDuration: durations > 0 && durations < unique.size };
}

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
  return { key: key(sessionId, objectScope(session), bladeId, radialPointId, lapIndex), sessionId, collectionId: session.collectionConflict ? null : session.collectionId,
    windFarm: session.windFarm, turbine: session.turbine, measurementObject: session.measurementObject,
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
  const sessionScopes = new Map<string, Set<string>>();
  let ungroupedCount = 0;
  // Earlier snapshots establish the original plan; contradictory later plans are visible.
  for (const record of [...unique.values()].sort((a, b) => recordTime(a) - recordTime(b) || a.id.localeCompare(b.id))) {
    if (!record.pointCycle) continue;
    if (!automatic(record)) { ungroupedCount++; continue; }
    const meta = record.pointCycle;
    const taskId = collectionId(meta.collectionId);
    const scope = { windFarm: text(record.windFarm), turbine: text(record.turbine), measurementObject: text(record.object) };
    const sessionKey = key(meta.sessionId, objectScope(scope));
    const scopes = sessionScopes.get(meta.sessionId) || new Set<string>();
    scopes.add(objectScope(scope)); sessionScopes.set(meta.sessionId, scopes);
    let session = sessions.get(sessionKey);
    if (!session) { session = { records: [], plan: null, cycles: meta.cycles, conflict: false, latestAt: 0,
      collectionId: taskId, collectionConflict: meta.collectionId !== undefined && taskId === null,
      taskName: text(record.name) || "未命名采集任务", ...scope }; sessions.set(sessionKey, session); }
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
  for (const [sessionKey, session] of sessions) {
    const sessionId = session.records[0].pointCycle.sessionId;
    // Never pool contradictory imported wind-turbine identities, even when a
    // copied manifest reuses both the collection and session identifiers.
    if ((sessionScopes.get(sessionId)?.size || 0) > 1) session.conflict = true;
    for (const station of session.plan || []) for (let lap = 1; lap <= session.cycles; lap++) {
      const groupKey = key(sessionKey, station.bladeId, station.radialPointId, lap);
      let group = groups.get(groupKey);
      if (!group) { group = emptyGroup(sessionId, station.bladeId, station.radialPointId, station.radialPointName, station.radiusM, lap, session); groups.set(groupKey, group); }
      if (group.stations.some(item => item.index === station.stationIndex) || group.radiusM !== station.radiusM) group.planConflict = true;
      group.stations.push({ id: station.pointId, index: station.stationIndex, azimuthDeg: station.azimuthDeg, planned: true, state: "unrecorded", records: [], samples: 0 });
      group.plannedCount = group.stations.length;
    }
    for (const record of session.records) {
      const meta = record.pointCycle;
      const groupKey = key(sessionKey, meta.bladeId, meta.radialPointId, meta.lapIndex);
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
    const taskKey = key(group.collectionId ? "collection" : "session", group.collectionId || group.sessionId, objectScope(group));
    const collectionKey = key(taskKey, group.bladeId);
    let collection = collections.get(collectionKey);
    if (!collection) { collection = { key: collectionKey, taskKey, collectionId: group.collectionId, bladeId: group.bladeId,
      windFarm: group.windFarm, turbine: group.turbine, measurementObject: group.measurementObject,
      taskName: group.taskName, groups: [], pointCount: 0, sessionCount: 0, latestAt: group.latestAt }; collections.set(collectionKey, collection); }
    collection.groups.push(group);
  }
  for (const collection of collections.values()) {
    collection.pointCount = new Set(collection.groups.map(group => group.radialPointId)).size;
    collection.sessionCount = new Set(collection.groups.map(group => group.sessionId)).size;
  }
  const tasks = new Map<string, BladeTaskSummary>();
  for (const collection of collections.values()) {
    let task = tasks.get(collection.taskKey);
    if (!task) { task = { key: collection.taskKey, collectionId: collection.collectionId, taskName: collection.taskName,
      windFarm: collection.windFarm, turbine: collection.turbine, measurementObject: collection.measurementObject, blades: [], pointCount: 0, sessionCount: 0,
      latestAt: collection.latestAt }; tasks.set(collection.taskKey, task); }
    task.blades.push(collection);
    task.pointCount += collection.pointCount;
  }
  for (const task of tasks.values()) {
    task.blades.sort((a, b) => a.bladeId.localeCompare(b.bladeId, "zh-CN", { numeric: true }));
    task.sessionCount = new Set(task.blades.flatMap(blade => blade.groups.map(group => group.sessionId))).size;
  }
  return { groups: ordered, collections: [...collections.values()], tasks: [...tasks.values()], taskCount: tasks.size, ungroupedCount };
}

export type AutoCaptureTarget = {
  collectionId: string | null | undefined; bladeId: string; radialPointId: string;
  cycles: number; stationCount: number; windFarm?: string; turbine?: string; measurementObject?: string; radiusM?: number;
};

/** Saved-data status only; the active worker's point-cycle status belongs to the caller. */
export function getAutoCaptureTargetState(recordings: readonly FieldRecording[], target: AutoCaptureTarget,
  summary: BladeRecordSummary = summarizeBladeRecords(recordings)): "complete" | "partial" | "empty" {
  if (!collectionId(target.collectionId)) return "empty";
  if (target.radiusM !== undefined && (!finite(target.radiusM) || target.radiusM < .001 || target.radiusM > 1000)) return "empty";
  const candidates = summary.groups.filter(group => group.collectionId === target.collectionId &&
    group.bladeId === target.bladeId && group.radialPointId === target.radialPointId &&
    (target.windFarm === undefined || group.windFarm === text(target.windFarm)) &&
    (target.turbine === undefined || group.turbine === text(target.turbine)) &&
    (target.measurementObject === undefined || group.measurementObject === text(target.measurementObject)));
  const recorded = candidates.filter(group => group.recordCount > 0);
  if (!recorded.length) return "empty";
  // Missing object filters must not silently choose between contradictory wind
  // turbines whose imported manifests happen to reuse an identifier.
  if (new Set(recorded.map(objectScope)).size !== 1 || !integer(target.cycles, 100) || !integer(target.stationCount, 200)) return "partial";
  const ordered = [...recorded].sort((a, b) => b.latestAt - a.latestAt || a.sessionId.localeCompare(b.sessionId));
  if (new Set(ordered.filter(group => group.latestAt === ordered[0].latestAt).map(group => group.sessionId)).size > 1) return "partial";
  const latestSession = ordered[0].sessionId;
  const latest = candidates.filter(group => group.sessionId === latestSession);
  if (latest.length !== target.cycles) return "partial";
  for (let lap = 1; lap <= target.cycles; lap++) {
    const group = latest.find(item => item.lapIndex === lap);
    if (!group || group.planConflict || group.plannedCount !== target.stationCount || group.observedCount !== target.stationCount ||
      group.stations.length !== target.stationCount || group.pendingCount || group.gapCount || group.failedCount || group.incompleteCount) return "partial";
    // Check the latest session rather than reviving an older session whose
    // radius matches an edited-back value. A reused ID does not prove that
    // observations belong to the newly configured physical location.
    if (target.radiusM !== undefined && (group.radiusM === null || !finite(group.radiusM) || Math.abs(group.radiusM - target.radiusM) > 1e-9)) return "partial";
  }
  return "complete";
}

export const bladeStationLabel = (value: BladeStationState) => ({ observed: "已观测回波通过", missing_entry: "未确认进入", missing_exit: "未确认离开", signal_gap: "信号中断", cancelled: "已取消", failed: "采集失败", incomplete: "记录未完成", unrecorded: "未收到记录" })[value];
