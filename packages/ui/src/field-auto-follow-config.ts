import { autoFollowDefaults, type AutoFollowDraft } from "./field-auto-follow-plan";
import { normalizeTurntablePort } from "./field-turntable-port";

export const autoFollowStorageKey = "blade-auto-follow-draft-v1";
export type AutoFollowPoint = AutoFollowDraft["points"][number];
export type AutoFollowBlade = { id: string; name: string; points: AutoFollowPoint[]; lengthM?: number; rootReservePercent?: number; tipReservePercent?: number };
export type AutoFollowHeights = { hubHeightM: number; laserHeightM: number };
export type AutoFollowSettings = Omit<AutoFollowDraft, "bladeId" | "points" | "activePointId">;
export type AutoFollowSurvey = {
  version: 3; settings: AutoFollowSettings; blades: AutoFollowBlade[];
  selectedBladeId: string; selectedPointId: string; port: string;
  collectionId: string; collectionContext: string; heights?: AutoFollowHeights;
};
const { bladeId: defaultBlade, points: defaultPoints, activePointId: defaultPoint, ...settings } = autoFollowDefaults;
export function defaultAutoFollowSurvey(): AutoFollowSurvey {
  return { version: 3, settings: { ...settings }, blades: [{ id: "blade-legacy", name: defaultBlade,
    points: defaultPoints.map(point => ({ ...point })) }], selectedBladeId: "blade-legacy", selectedPointId: defaultPoint,
    port: "", collectionId: "", collectionContext: "" };
}
const pointsFrom = (points: unknown): AutoFollowPoint[] => Array.isArray(points) ? points.slice(0, 40).map(point => ({
  id: typeof point?.id === "string" ? point.id : "", name: typeof point?.name === "string" ? point.name : "",
  radiusM: typeof point?.radiusM === "number" ? point.radiusM : NaN,
})) : [];
const validHeight = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10000;

/** Both values are measured above the same ground reference; missing measurements stay unknown. */
export function autoFollowHeightDelta(heights: AutoFollowHeights): number {
  return validHeight(heights?.hubHeightM) && validHeight(heights?.laserHeightM)
    ? Number((heights.hubHeightM - heights.laserHeightM).toPrecision(12)) : NaN;
}

function heightsFrom(value: unknown): AutoFollowHeights {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { hubHeightM: validHeight(saved.hubHeightM) ? saved.hubHeightM : NaN,
    laserHeightM: validHeight(saved.laserHeightM) ? saved.laserHeightM : NaN };
}
function bladeDimensionsFrom(value: unknown, legacy: boolean): Pick<AutoFollowBlade, "lengthM" | "rootReservePercent" | "tipReservePercent"> {
  const result: Pick<AutoFollowBlade, "lengthM" | "rootReservePercent" | "tipReservePercent"> = {};
  if (!value || typeof value !== "object") return result;
  const saved = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(saved, "lengthM")) {
    const length = saved.lengthM;
    result.lengthM = typeof length === "number" && Number.isFinite(length) && length > 0 ? length : NaN;
    // Old lengths were root-to-tip. Convert their dimension once; never move
    // saved points, regenerate their IDs, or apply the old offset to new routes.
    if (legacy && Object.prototype.hasOwnProperty.call(saved, "rootRadiusM")) {
      const root = saved.rootRadiusM;
      result.lengthM = typeof root === "number" && Number.isFinite(root) && root >= 0
        ? Number((result.lengthM + root).toPrecision(12)) : NaN;
    }
  }
  for (const key of ["rootReservePercent", "tipReservePercent"] as const) {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) continue;
    const percent = saved[key];
    result[key] = typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent < 100 ? percent : NaN;
  }
  return result;
}

/** Five equally spaced radii within the unreserved center-to-tip interval. */
export function generateAutoFollowBladePoints(lengthM: number, rootReservePercent = 10, tipReservePercent = 10,
  makeId: () => string = () => globalThis.crypto.randomUUID()): AutoFollowPoint[] {
  if (!Number.isFinite(lengthM) || lengthM <= 0 || lengthM > 1000) throw new Error("请填写有效叶片长度：转轴中心到叶尖的距离（大于0、不超过1000米）");
  if (![rootReservePercent, tipReservePercent].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 100))
    throw new Error("叶根和叶尖预留比例应为0%至小于100%的有效数值");
  if (rootReservePercent + tipReservePercent >= 100) throw new Error("叶根和叶尖预留比例之和必须小于100%");
  const start = rootReservePercent / 100, span = (100 - rootReservePercent - tipReservePercent) / 100;
  const radii = Array.from({ length: 5 }, (_, index) => Number((lengthM * (start + span * index / 4)).toPrecision(12)));
  if (radii.some(radius => !Number.isFinite(radius) || radius < .001 || radius > 1000))
    throw new Error("生成测点距风机转轴中心应在0.001～1000米范围内，请调整叶片长度或预留比例");
  if (radii.some((radius, index) => index > 0 && radius <= radii[index - 1]))
    throw new Error("预留区间过小，无法区分五个测点的位置，请调整预留比例");
  const ids = new Set<string>();
  return radii.map((radiusM, index) => {
    const id = makeId();
    if (typeof id !== "string" || !id.trim() || id.length > 80 || ids.has(id)) throw new Error("测点编号生成失败，请重新生成测点");
    ids.add(id);
    return { id, name: `P${index + 1}`, radiusM };
  });
}
export const autoFollowTargetKey = (bladeId: string, pointId: string) => JSON.stringify([bladeId, pointId]);

/** v1's single blade migrates without deleting its points or restoring device calibration. */
export function readAutoFollowSurvey(raw: string | null): AutoFollowSurvey {
  const result = defaultAutoFollowSurvey();
  try {
    const saved = JSON.parse(raw || "null");
    if (!saved || typeof saved !== "object") return result;
    if (Object.prototype.hasOwnProperty.call(saved, "heights")) result.heights = heightsFrom(saved.heights);
    const values = [2, 3].includes(saved.version) ? saved.settings : saved.draft;
    if (values && typeof values === "object") for (const key of Object.keys(result.settings) as (keyof AutoFollowSettings)[]) {
      if (!(key in values)) continue;
      if (typeof result.settings[key] === "number") Object.assign(result.settings, { [key]: typeof values[key] === "number" ? values[key] : NaN });
      else Object.assign(result.settings, { [key]: typeof values[key] === "string" ? values[key] : "" });
    }
    if ([2, 3].includes(saved.version) && Array.isArray(saved.blades)) {
      result.blades = saved.blades.slice(0, 12).map((blade: Record<string, unknown>) => ({
        id: typeof blade?.id === "string" ? blade.id : "", name: typeof blade?.name === "string" ? blade.name : "",
        points: pointsFrom(blade?.points), ...bladeDimensionsFrom(blade, saved.version !== 3),
      }));
      result.selectedBladeId = typeof saved.selectedBladeId === "string" ? saved.selectedBladeId : "";
      result.selectedPointId = typeof saved.selectedPointId === "string" ? saved.selectedPointId : "";
    } else if (saved.draft && typeof saved.draft === "object") {
      result.blades = [{ id: "blade-legacy", name: typeof saved.draft.bladeId === "string" ? saved.draft.bladeId : defaultBlade,
        points: Array.isArray(saved.draft.points) ? pointsFrom(saved.draft.points) : result.blades[0].points, ...bladeDimensionsFrom(saved.draft, true) }];
      result.selectedPointId = typeof saved.draft.activePointId === "string" ? saved.draft.activePointId : result.blades[0].points[0]?.id || "";
    }
    const blade = result.blades.find(item => item.id === result.selectedBladeId) || result.blades[0];
    result.selectedBladeId = blade?.id || "";
    result.selectedPointId = blade?.points.some(point => point.id === result.selectedPointId) ? result.selectedPointId : blade?.points[0]?.id || "";
    result.port = typeof saved.port === "string" ? normalizeTurntablePort(saved.port) : "";
    if (typeof saved.collectionId === "string" && saved.collectionId.length === 32 && /^[a-f0-9]{32}$/.test(saved.collectionId) && typeof saved.collectionContext === "string") {
      result.collectionId = saved.collectionId; result.collectionContext = saved.collectionContext;
    }
  } catch { /* Optional configuration cannot resume acquisition or restore a hardware anchor. */ }
  return result;
}
export function surveyDraft(survey: AutoFollowSurvey, bladeKey = survey.selectedBladeId, pointId = survey.selectedPointId): AutoFollowDraft {
  const blade = survey.blades.find(item => item.id === bladeKey);
  return { ...survey.settings, ...(survey.heights !== undefined ? { hubHeightDeltaM: autoFollowHeightDelta(survey.heights) } : {}),
    bladeId: blade?.name || "", points: blade?.points || [], activePointId: pointId };
}
export function selectSurveyTarget(survey: AutoFollowSurvey, key: string): AutoFollowSurvey {
  for (const blade of survey.blades) for (const point of blade.points) if (autoFollowTargetKey(blade.id, point.id) === key)
    return { ...survey, selectedBladeId: blade.id, selectedPointId: point.id };
  return survey;
}
export function surveyIdentityErrors(survey: AutoFollowSurvey): string[] {
  const errors: string[] = [];
  if (!survey.blades.length) errors.push("请添加至少一个叶片和测点");
  const bladeIds = new Set<string>(), bladeNames = new Set<string>();
  for (const blade of survey.blades) {
    const name = blade.name.trim().normalize("NFC");
    if (!blade.id || bladeIds.has(blade.id)) errors.push("叶片标识重复，请重新添加重复叶片");
    if (!name || name.length > 80) errors.push("请填写有效的叶片编号（最多80字）");
    else if (bladeNames.has(name)) errors.push("同一风机的叶片编号不能重复");
    bladeIds.add(blade.id); bladeNames.add(name);
    const ids = new Set<string>(), names = new Set<string>();
    for (const point of blade.points) {
      if (!point.id || ids.has(point.id)) errors.push(`叶片 ${name} 的测点标识重复`);
      const pointName = point.name.trim().normalize("NFC");
      if (pointName && names.has(pointName)) errors.push(`叶片 ${name} 的测点名称不能重复`);
      ids.add(point.id); names.add(pointName);
    }
  }
  return [...new Set(errors)];
}
