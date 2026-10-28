import type { CaptureFrame, MeasurementCapture } from "./capture-types";
import { canonicalPositionCode, isDiagnosticMeasurement, type MeasurementContext, type MeasurementObject } from "./measurement-domain";

/** Binding is authoritative; raw identity is only a fallback for a new, unbound capture. */
export function captureMatchesContext(c: MeasurementCapture, context: Partial<MeasurementContext>, objects: MeasurementObject[]) {
  const raw = c.recording.pointCycle;
  const identity = c.identity || { farmCode: c.recording.windFarm, turbineCode: c.recording.turbine,
    bladeCode: raw?.bladeId, positionCode: canonicalPositionCode(raw?.radialPointId, raw?.radialPointName), campaignCode: raw?.collectionId };
  const fields = { farmId: "farmCode", turbineId: "turbineCode", bladeId: "bladeCode", positionId: "positionCode", campaignId: "campaignCode" } as const;
  return (Object.keys(fields) as (keyof MeasurementContext)[]).every(key => {
    if (!context[key]) return true;
    if (c.context) return c.context[key] === context[key];
    const object = objects.find(o => o.id === context[key]);
    return !!object && identity[fields[key]] === object.code;
  });
}
export const captureTaskKey = (c: MeasurementCapture) => c.context
  ? JSON.stringify([c.tenant, c.context.campaignId, c.context.turbineId])
  : JSON.stringify([c.ownerId, c.clientId, c.recording.pointCycle?.collectionId || c.localId]);

const captureTime = (c: MeasurementCapture) => typeof c.updatedAt === "number" ? c.updatedAt : Date.parse(c.updatedAt);
export function mergeCapturePages(current: MeasurementCapture[], incoming: MeasurementCapture[]) {
  const byId = new Map(current.map(c => [c.id, c]));
  for (const capture of incoming) {
    const previous = byId.get(capture.id);
    // A late list response must not reopen a completed upload or roll back a fresher detail read.
    if (previous && ((previous.uploadState === "complete" && capture.uploadState !== "complete") || captureTime(previous) > captureTime(capture))) {
      byId.set(capture.id, { ...previous, context: capture.context, bindingRevision: capture.bindingRevision, identity: capture.identity });
    } else byId.set(capture.id, capture);
  }
  return [...byId.values()].sort((a, b) => captureTime(b) - captureTime(a) || b.id.localeCompare(a.id));
}
/** One current view per radial point, without silently dropping the other blades after five cards. */
export function latestCapturePoints(captures: MeasurementCapture[]) {
  const byPoint = new Map<string, MeasurementCapture>();
  for (const capture of [...captures].sort((a, b) =>
    Number(b.liveState === "acquiring") - Number(a.liveState === "acquiring") || captureTime(b) - captureTime(a))) {
    const pc = capture.recording.pointCycle;
    const key = capture.context ? capture.context.bladeId + ":" + capture.context.positionId
      : JSON.stringify([pc?.bladeId, pc?.radialPointId || capture.localId]);
    if (!byPoint.has(key)) byPoint.set(key, capture);
  }
  return [...byPoint.values()];
}

const stable = (value: any): string => JSON.stringify(value, function(_key, item) {
  return item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});

/** Interpret global source gates only with an explicit, validated source-to-local mapping. */
function previewRange(frame: CaptureFrame): [number, number] | null {
  const r = frame.recording, cycle = r.pointCycle as any, h = cycle?.handoff;
  if (!h || !Number.isSafeInteger(r.samples) || r.samples <= 0 || !r.sampleRate || r.sampleRate !== frame.waveform.sampleRate) return null;
  const gates = [h.entrySampleIndex, h.entryConfirmedSampleIndex, h.exitSampleIndex, h.exitConfirmedSampleIndex];
  if (!gates.every(Number.isSafeInteger)) return null;
  const [entry, confirmed, end, exit] = gates;
  if (entry < 0 || entry > confirmed || confirmed >= end || end > exit) return null;
  if (!h.sampleClock || h.sampleClock === "recording_local") return exit < r.samples ? [confirmed + 1, end] : null;
  if (h.sampleClock !== "continuous_session_raw") return null;
  const link = cycle.continuousSession, sampling = r.sampling as any;
  if (link?.sampleClock !== "continuous_session_raw" || !Number.isSafeInteger(link.sampleStart) || link.sampleStart < 0 ||
      !Number.isSafeInteger(link.sampleEndExclusive) || link.sampleEndExclusive <= link.sampleStart ||
      !Number.isFinite(link.sampleRate) || link.sampleRate <= 0 || entry < link.sampleStart || exit >= link.sampleEndExclusive) return null;
  const count = link.sampleEndExclusive - link.sampleStart;
  let up = 1, down = 1;
  if (count !== r.samples || link.sampleRate !== r.sampleRate) {
    const m = sampling?.pointCycleIndexMapping;
    if (sampling?.version !== 2 || sampling.kind !== "anti_alias_lowpass" || sampling.sourceSamples !== count ||
        sampling.sourceSampleRate !== link.sampleRate || sampling.targetSampleRate !== r.sampleRate || r.sampleRate >= link.sampleRate ||
        m?.version !== 1 || m.sourceClock !== "continuous_session_raw" || m.targetClock !== "recording_local" || m.sourceOffset !== link.sampleStart ||
        !Number.isSafeInteger(m.numerator) || !Number.isSafeInteger(m.denominator) || m.numerator <= 0 || m.denominator <= 0 ||
        Math.abs(m.numerator / m.denominator - r.sampleRate / link.sampleRate) > 1e-12 || stable(sampling.sourceHandoff) !== stable(h)) return null;
    up = m.numerator; down = m.denominator;
    if ((BigInt(count) * BigInt(up) + BigInt(down) - 1n) / BigInt(down) !== BigInt(r.samples)) return null;
  }
  const start = Number((BigInt(confirmed + 1 - link.sampleStart) * BigInt(up) + BigInt(down) - 1n) / BigInt(down));
  const finish = Number(BigInt(end - link.sampleStart) * BigInt(up) / BigInt(down));
  return start < finish && finish <= r.samples ? [start, finish] : null;
}
/** Display only: never infer a blade boundary from a sparse network preview. */
export function validPassPreview(frame: CaptureFrame, threshold = 0) {
  const w = frame.waveform,
    pc = frame.recording.pointCycle as any,
    h = pc?.handoff;
  const unavailable = (reason: string) => ({
    points: [] as [number, number | null][],
    complete: false,
    reason,
  });
  if (isDiagnosticMeasurement(frame.recording)) return unavailable("诊断记录：请查看原始预览，或在分析页选择纳入诊断数据");
  if (frame.terminalMetadataOnly) return unavailable("采集已结束，正在等待完整记录上传");
  if (
    pc?.completion !== "confirmed_pass" ||
    pc?.outcome !== "observed" ||
    h?.reason !== "blade_left" ||
    pc?.diagnosticOnly ||
    pc?.validMeasurement === false
  )
    return unavailable("等待完整进入、离开边界");
  const range = previewRange(frame);
  if (!range || typeof w.sampleRate !== "number" || !Number.isFinite(w.sampleRate) || w.sampleRate <= 0)
    return unavailable("有效边界或采样时钟不一致");
  const [start, end] = range, points: [number, number | null][] = [];
  if (w.envelope?.length) {
    for (const b of w.envelope)
      if (b.start >= start && b.end <= end) {
        const good =
          b.missing === 0 &&
          b.overrange === 0 &&
          b.rssiMin != null &&
          b.rssiMin >= threshold;
        points.push(
          [(b.start - start) / w.sampleRate, good ? b.min : null],
          [(b.end - start) / w.sampleRate, good ? b.max : null],
        );
      }
  } else {
    const stride = w.sampleStride || 1;
    const rssiStride = Number.isSafeInteger(w.rssiSampleStride) && w.rssiSampleStride! > 0 ? w.rssiSampleStride! : 1;
    w.values.forEach((v, i) => {
      const sample = w.sampleStart + i * stride;
      // A sparse RSSI channel does not measure every velocity sample. Do not
      // invent a value, or confuse an unmeasured position with a missing packet.
      const rssi = w.rssi[i], sampled = sample % rssiStride === 0;
      const quality = rssi == null ? !sampled : Number.isFinite(rssi) && rssi >= threshold;
      if (sample >= start && sample < end)
        points.push([
          (sample - start) / w.sampleRate!,
          !w.overrange[i] &&
          Number.isFinite(v) &&
          quality
            ? v
            : null,
        ]);
    });
  }
  const from = w.rangeStart ?? w.sampleStart,
    to = w.rangeEnd ?? w.sampleStart + w.values.length * (w.sampleStride || 1);
  const complete = from <= start && to >= end;
  return {
    points,
    complete,
    reason: points.length
      ? complete
        ? "完整经过预览 · 显示已压缩"
        : "部分有效区间 · 完整波形等待上传"
      : "预览窗口已越过有效区间，等待完整记录上传",
  };
}
