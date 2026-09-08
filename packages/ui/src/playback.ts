/** Display a stored waveform window without resampling or changing amplitudes. */
export function playbackWindow(samples: number[], sampleRate: number, cursor: number | null, size = 1000) {
  const end = cursor === null ? samples.length : Math.min(samples.length, Math.max(1, Math.floor(cursor) + 1));
  const start = cursor === null ? 0 : Math.max(0, end - size);
  return { samples: samples.slice(start, end), times: samples.slice(start, end).map((_, i) => ((start + i) / sampleRate).toFixed(6)), start, end };
}
