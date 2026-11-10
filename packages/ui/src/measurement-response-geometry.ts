export type Response3DPoint = {
  id: string;
  name: string;
  radiusM: number | null;
  normalizedAmplitude: number | null;
  displacementRmsM: number | null;
  highlighted?: boolean;
};

type LocatedPoint = Response3DPoint & { radiusM: number };
export type ResponseEnvelopeInterval = { from: LocatedPoint; to: LocatedPoint };
export const finiteRadius = (r: unknown): r is number => typeof r === "number" && Number.isFinite(r) && r >= 0;
export const finiteAmplitude = (a: unknown): a is number => typeof a === "number" && Number.isFinite(a) && a >= 0;

export function responseGeometryInfo(corrections: { values?: Record<string, unknown> }[] = []) {
  const distances = [...new Set(corrections.map(c => c.values?.horizontal_distance_m).filter(finiteRadius))];
  return { instrumentDistanceM: distances.length === 1 ? distances[0] : undefined,
    hasEstimatedRadius: corrections.some(c => finiteRadius(c.values?.radius_from_hub_m)) };
}

/** Only bridge adjacent measured points. Unknown positions cannot be placed in
 * the ordering, so that case deliberately supplies point markers without a mesh. */
export function responseEnvelopeIntervals(points: Response3DPoint[]): ResponseEnvelopeInterval[] {
  if (points.some(p => !finiteRadius(p.radiusM))) return [];
  const ordered = [...points].sort((a, b) => a.radiusM! - b.radiusM!) as LocatedPoint[];
  const duplicate = new Set(ordered.filter((p, i) => ordered.some((q, j) => i !== j && Math.abs(p.radiusM - q.radiusM) < 1e-9)).map(p => p.id));
  return ordered.slice(1).flatMap((to, i) => {
    const from = ordered[i];
    return !duplicate.has(from.id) && !duplicate.has(to.id) && to.radiusM > from.radiusM &&
      finiteAmplitude(from.normalizedAmplitude) && finiteAmplitude(to.normalizedAmplitude)
      ? [{ from, to }] : [];
  });
}

/** No root constraint, no extrapolation and no interpolation across missing data. */
export function interpolateResponseEnvelope(points: Response3DPoint[], radiusM: number): number | null {
  if (!finiteRadius(radiusM)) return null;
  const exact = points.filter(p => finiteRadius(p.radiusM) && Math.abs(p.radiusM - radiusM) < 1e-9);
  if (exact.length) return exact.length === 1 && finiteAmplitude(exact[0].normalizedAmplitude) ? exact[0].normalizedAmplitude : null;
  const interval = responseEnvelopeIntervals(points).find(({ from, to }) => radiusM > from.radiusM && radiusM < to.radiusM);
  if (!interval) return null;
  const { from, to } = interval;
  const t = (radiusM - from.radiusM) / (to.radiusM - from.radiusM);
  return from.normalizedAmplitude! * (1 - t) + to.normalizedAmplitude! * t;
}

/** Shared by the live viewer and static report. Perspective only; input values remain unchanged. */
export function responseProjection(extent: number, amplitudeExtent = 1, yaw = -25, elevation = 30, gain = .18, includeNegative = true) {
  const scaleRadius = extent || 1;
  const az = yaw * Math.PI / 180, el = elevation * Math.PI / 180;
  const rawProject = (x: number, y: number, z: number) => {
    const u = (x - .5) * Math.cos(az) - y * Math.sin(az);
    const depth = (x - .5) * Math.sin(az) + y * Math.cos(az);
    return [u, depth * Math.sin(el) - z * Math.cos(el)];
  };
  const corners = [0, 1].flatMap(x => [-.14, .14].flatMap(y => [includeNegative ? -gain * amplitudeExtent : 0, gain * amplitudeExtent].map(z => rawProject(x, y, z))));
  const minU = Math.min(...corners.map(p => p[0])), maxU = Math.max(...corners.map(p => p[0]));
  const minV = Math.min(...corners.map(p => p[1])), maxV = Math.max(...corners.map(p => p[1]));
  const scale = Math.min(850, 820 / Math.max(.01, maxU - minU), 280 / Math.max(.01, maxV - minV));
  const project = (radius: number, y: number, amplitude: number) => {
    const [u, v] = rawProject(radius / scaleRadius, y, amplitude * gain);
    return [500 + scale * (u - (minU + maxU) / 2), 205 + scale * (v - (minV + maxV) / 2)];
  };
  const width = (radius: number) => .075 - .035 * radius / scaleRadius;
  const polygon = (a: number, b: number, va: number, vb: number) => [project(a, -width(a), va), project(a, width(a), va), project(b, width(b), vb), project(b, -width(b), vb)].map(p => p.join(',')).join(' ');
  return {project, polygon};
}
