export type DisplacementDisplayPoint = {point: string; radiusM: number | null; actualMm: number; displayMm: number};

/** Least-squares cantilever first-bending shape assumption, never a measurement correction.
 * u=r/r_max, phi=u²(3-u)/2. The fitted scale is nonnegative; original values survive unchanged.
 * r_max is the outermost measured radius, not an asserted blade length or blade-tip amplitude.
 */
export function increasingDisplacementDisplay(input: readonly Omit<DisplacementDisplayPoint, 'displayMm'>[]): DisplacementDisplayPoint[] {
  const valid = input.filter(p => Number.isFinite(p.actualMm) && p.actualMm >= 0 && p.radiusM != null && Number.isFinite(p.radiusM) && p.radiusM >= 0)
    .sort((a,b) => a.radiusM! - b.radiusM! || a.point.localeCompare(b.point, 'zh-CN', {numeric:true}));
  if (valid.length < 2 || valid.at(-1)!.radiusM === 0) return [];
  const radius=valid.at(-1)!.radiusM!;
  const shape=valid.map(p => {const u=p.radiusM!/radius;return u*u*(3-u)/2;});
  const denominator=shape.reduce((sum,v)=>sum+v*v,0);
  const scale=shape.reduce((sum,v,i)=>sum+v*valid[i].actualMm,0)/denominator;
  return valid.map((p,i)=>({...p,displayMm:scale*shape[i]}));
}
