import type { CaptureFrame } from "./capture-types";
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
  if (
    pc?.completion !== "confirmed_pass" ||
    pc?.outcome !== "observed" ||
    h?.reason !== "blade_left" ||
    pc?.diagnosticOnly ||
    pc?.validMeasurement === false
  )
    return unavailable("等待完整进入、离开边界");
  const [entry, confirmed, end, exit] = [
    h.entrySampleIndex,
    h.entryConfirmedSampleIndex,
    h.exitSampleIndex,
    h.exitConfirmedSampleIndex,
  ];
  if (
    ![entry, confirmed, end, exit].every(Number.isInteger) ||
    entry < 0 ||
    !(
      entry <= confirmed &&
      confirmed < end &&
      end <= exit &&
      exit < frame.recording.samples
    ) ||
    typeof w.sampleRate !== "number" ||
    !Number.isFinite(w.sampleRate) ||
    w.sampleRate <= 0
  )
    return unavailable("有效边界或采样率不可用");
  const start = confirmed + 1,
    points: [number, number | null][] = [];
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
    w.values.forEach((v, i) => {
      const sample = w.sampleStart + i * stride;
      if (sample >= start && sample < end)
        points.push([
          (sample - start) / w.sampleRate!,
          !w.overrange[i] &&
          Number.isFinite(v) &&
          typeof w.rssi[i] === "number" &&
          w.rssi[i]! >= threshold
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
