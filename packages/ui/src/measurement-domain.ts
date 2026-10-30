import {matchSegmentConditions} from "./measurement-conditions";
/** Shared contracts for real measurements. Object IDs never replace raw provenance. */
export type ObjectKind = "farm" | "turbine" | "blade" | "position" | "campaign";
export type MeasurementObject = {
  id: string;
  kind: ObjectKind;
  name: string;
  code: string;
  parentId: string | null;
  active: boolean;
  revision: string;
  location?: string;
  model?: string;
  radiusM?: number;
  installationAngleDeg?: number;
  date?: string;
  operators?: string;
  weather?: string;
  turbineIds?: string[];
};
export type MeasurementContext = {
  farmId: string;
  turbineId: string;
  bladeId: string;
  positionId: string;
  campaignId: string;
};
export type MeasurementReference = {
  kind: "task" | "capture" | "import";
  id: string;
};
export type WindRow = {
  time: string;
  turbineCode: string;
  windSpeed?: number;
  rpm?: number;
  windDirection?: number;
  powerKw?: number;
  temperatureC?: number;
};
export type ConditionSummary = {
  status: "matched" | "unmatched";
  datasetIds: string[];
  samples: number;
  availableSamples?: number;
  conflictingSamples?: number;
  windSpeed?: number;
  windRange?: [number, number];
  rpm?: number;
  rpmRange?: [number, number];
  start: string;
  end: string;
};
export type DamageRules = {
  windBin: number;
  rpmBin: number;
  minCampaigns: number;
  sigma: number;
  frequencyDropPercent: number;
  amplitudeRisePercent: number;
  consecutiveCampaigns: number;
};
export const initialDamageRules: DamageRules = {
  windBin: 2,
  rpmBin: 1,
  minCampaigns: 3,
  sigma: 2,
  frequencyDropPercent: 5,
  amplitudeRisePercent: 25,
  consecutiveCampaigns: 2,
};
export function validateDamageRules(input: any): DamageRules {
  const out = {} as DamageRules;
  for (const [key, min, max, integer] of [
    ["windBin", 0.1, 20, false],
    ["rpmBin", 0.1, 100, false],
    ["minCampaigns", 3, 100, true],
    ["sigma", 1, 10, false],
    ["frequencyDropPercent", 0.1, 50, false],
    ["amplitudeRisePercent", 1, 1000, false],
    ["consecutiveCampaigns", 1, 10, true],
  ] as const) {
    const v = input?.[key];
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (integer && !Number.isInteger(v))
    )
      throw Error(`判据 ${key} 超出允许范围`);
    out[key] = v;
  }
  return out;
}
/** Preserve blade numbers when a turbine has only a partial set of configured blades. */
export function bladeDisplaySlots(blades: MeasurementObject[]) {
  const numbered = new Map<number, MeasurementObject>();
  let custom = false;
  for (const blade of blades) {
    const match = [blade.code, blade.name].map(value => String(value).trim().match(/^(?:叶片\s*|B|blade[\s_-]*)?([1-3])$/i)).find(Boolean);
    const number = match ? Number(match[1]) : 0;
    if (!number || numbered.has(number)) custom = true;
    else numbered.set(number, blade);
  }
  if (custom) return [
    ...blades.map(blade => ({ key: blade.id, name: blade.name, blade: blade as MeasurementObject | null })),
    ...Array.from({ length: Math.max(0, 3 - blades.length) }, (_, i) => ({ key: `unconfigured-${i}`, name: "未配置叶片", blade: null })),
  ];
  return [1, 2, 3].map(number => {
    const blade = numbered.get(number) || null;
    return { key: blade?.id || `blade-slot-${number}`, name: blade?.name || `叶片 ${number}`, blade };
  });
}
export function contextNames(
  context: Partial<MeasurementContext>,
  objects: MeasurementObject[],
) {
  const map = new Map(objects.map((o) => [o.id, o]));
  return Object.fromEntries(
    (["farm", "turbine", "blade", "position", "campaign"] as const).map((k) => [
      k,
      map.get(context[`${k}Id`] || "")?.name || "待补充",
    ]),
  ) as Record<"farm" | "turbine" | "blade" | "position" | "campaign", string>;
}
export function conditionWindow(
  rows: { id: string; farmId: string; rows: WindRow[] }[],
  farmId: string,
  turbineCode: string,
  start: number,
  end: number,
): ConditionSummary {
  return matchSegmentConditions(rows,farmId,turbineCode,[{start,end}]);
}

export function validateWindRows(input: any): WindRow[] {
  if (!Array.isArray(input) || !input.length || input.length > 250000)
    throw Error("每个数据集需要 1～250000 行");
  const seen = new Set<string>();
  return input
    .map((r, i) => {
      if (
        !r ||
        typeof r.time !== "string" ||
        !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(r.time) ||
        !Number.isFinite(Date.parse(r.time))
      )
        throw Error(`第 ${i + 1} 行时间须包含时区`);
      if (
        typeof r.turbineCode !== "string" ||
        !r.turbineCode.trim() ||
        r.turbineCode.length > 120
      )
        throw Error(`第 ${i + 1} 行缺少风机编号`);
      for (const [key, min, max] of [
        ["windSpeed", 0, 150],
        ["rpm", 0, 10000],
        // Some exports carry a signed direction/offset; retain it until the
        // source reference is confirmed instead of assuming absolute azimuth.
        ["windDirection", -360, 360],
        ["powerKw", -100000, 100000],
        ["temperatureC", -100, 100],
      ] as const) {
        if (r[key] == null) continue;
        if (
          typeof r[key] !== "number" ||
          !Number.isFinite(r[key]) ||
          r[key] < min ||
          r[key] > max
        )
          throw Error(`第 ${i + 1} 行 ${key} 超出范围`);
      }
      const row: WindRow = {
        time: new Date(r.time).toISOString(),
        turbineCode: r.turbineCode.trim(),
        ...(r.windSpeed != null ? { windSpeed: r.windSpeed } : {}),
        ...(r.rpm != null ? { rpm: r.rpm } : {}),
        ...(r.windDirection != null ? { windDirection: r.windDirection } : {}),
        ...(r.powerKw != null ? { powerKw: r.powerKw } : {}),
        ...(r.temperatureC != null ? { temperatureC: r.temperatureC } : {}),
      };
      if (!["windSpeed", "rpm", "windDirection", "powerKw", "temperatureC"].some(key => r[key] != null))
        throw Error(`第 ${i + 1} 行缺少工况指标`);
      const key = row.turbineCode + "|" + row.time;
      if (seen.has(key)) throw Error(`第 ${i + 1} 行风机与时间重复`);
      seen.add(key);
      return row;
    })
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
/** A recalculation must not turn one measurement into several historical visits. */
/** Preserve diagnostic provenance across desktop uploads, imported sources and saved results. */
export function isDiagnosticMeasurement(value: any): boolean {
  const candidates = [value, value?.features, value?.metadata, value?.sourceMetadata,
    value?.raw, value?.raw?.sourceMetadata];
  return candidates.some((item) => item && (
    item.diagnosticOnly === true || item.validMeasurement === false ||
    item.pointCycle?.completion === "diagnostic_pass" ||
    item.pointCycle?.outcome === "diagnostic" ||
    item.pointCycle?.diagnosticOnly === true || item.pointCycle?.validMeasurement === false
  ));
}
/** A local waveform alert must not disappear behind another azimuth's quiet result. */
export function measurementAlertRank(result: any) {
  if (isDiagnosticMeasurement(result)) return 2;
  const rank: Record<string, number> = {
    suspected: 4,
    review: 3,
    insufficient: 2,
    within_reference: 1,
  };
  return Math.max(
    rank[result.assessment?.status] || 0,
    result.features?.events?.length ? 3 : 0,
  );
}
export function measurementHistory(results: any[]) {
  const newest = [...results].sort(
    (a, b) =>
      a.measuredAt - b.measuredAt ||
      String(a.createdAt).localeCompare(String(b.createdAt)),
  );
  return [
    ...new Map(
      newest.map((r) => [
        JSON.stringify([
          r.context?.campaignId,
          r.context?.positionId,
          r.azimuthDeg ?? null,
        ]),
        r,
      ]),
    ).values(),
  ].sort((a, b) => a.measuredAt - b.measuredAt);
}

/** Standard slot comes from the saved point label; UUIDs remain in raw provenance. */
export function canonicalPositionCode(id: unknown, name: unknown) {
  for (const value of [name, id]) {
    if (typeof value === "string" && /^P[1-5]$/i.test(value.trim()))
      return value.trim().toUpperCase();
  }
  return typeof id === "string" ? id.trim() : "";
}

/** Rule output is a risk flag, never a trained-model probability or damage location. */
export function assessMeasurement(
  current: any,
  history: any[],
  rules: DamageRules,
) {
  const unavailable = (reason: string) => ({
    status: "insufficient",
    label: "证据不足",
    reason,
    referenceIds: [] as string[],
    frequencyShiftPercent: null,
    amplitudeRatio: null,
  });
  const track=current.features?.frequencyTrack;
  if((current.features?.peaks?.length||0)>1&&!(typeof track?.id==="string"&&track.validated===true))return unavailable("存在多个响应峰，尚无经核验的同一候选跟踪；不比较最高峰换峰");
  const selectedPeak=(r:any)=>track?r.features?.peaks?.find((p:any)=>p.candidateId===track.id):r.features?.peaks?.length===1?r.features.peaks[0]:null;
  const frequency = selectedPeak(current)?.frequencyHz,
    amplitude = current.features?.metrics?.rmsVelocityMps;
  const condition = current.condition;
  if (condition?.healthEligible === false) return unavailable("时间语义或工况匹配资格不足");
  if (isDiagnosticMeasurement(current))
    return { ...unavailable("诊断记录可查看波形和频谱，不能用于健康结论或正常参考"), label: "诊断数据" };
  if (!current.context || !condition || condition.status !== "matched")
    return unavailable("缺少相匹配的风速、转速工况");
  if (
    !(frequency > 0 && amplitude >= 0) ||
    current.features?.status !== "analyzed"
  )
    return unavailable("缺少可用频率或幅值结果");
  const same = (r: any) =>
    ["farmId", "turbineId", "bladeId", "positionId"].every(
      (k) => r.context?.[k] === current.context[k],
    ) && r.azimuthDeg === current.azimuthDeg;
  const bin = (v: number, step: number) => Math.floor(v / step);
  const comparable = (r: any) =>
    !isDiagnosticMeasurement(r) &&
    (!track || r.features?.frequencyTrack?.id===track.id && r.features?.frequencyTrack?.validated===true) &&
    same(r) &&
    r.features?.algorithmVersion === current.features?.algorithmVersion &&
    r.features?.parameters?.detrend === current.features?.parameters?.detrend &&
    r.features?.parameters?.windowSeconds ===
      current.features?.parameters?.windowSeconds &&
    r.condition?.status === "matched" &&
    bin(r.condition.windSpeed, rules.windBin) ===
      bin(condition.windSpeed, rules.windBin) &&
    bin(r.condition.rpm, rules.rpmBin) === bin(condition.rpm, rules.rpmBin) &&
    r.features?.status === "analyzed";
  const older = measurementHistory(history).filter(
    (r) =>
      r.measuredAt < current.measuredAt &&
      r.context?.campaignId !== current.context.campaignId &&
      comparable(r),
  );
  const refs = [
    ...new Map(
      older
        .filter((r) => r.referenceApproved)
        .sort((a, b) => a.measuredAt - b.measuredAt)
        .map((r) => [r.context.campaignId, r]),
    ).values(),
  ].filter(
    (r: any) =>
      selectedPeak(r)?.frequencyHz > 0 &&
      r.features.metrics.rmsVelocityMps > 0,
  ) as any[];
  if (refs.length < rules.minCampaigns)
    return unavailable(
      `同工况已复核参考仅 ${refs.length} 个批次，至少需要 ${rules.minCampaigns} 个`,
    );
  const fs = refs.map((r) => selectedPeak(r).frequencyHz),
    mean = fs.reduce((a, b) => a + b, 0) / fs.length,
    sd = Math.sqrt(
      fs.reduce((s, f) => s + (f - mean) ** 2, 0) / (fs.length - 1),
    );
  const rms =
    refs.reduce((s, r) => s + r.features.metrics.rmsVelocityMps, 0) /
    refs.length;
  const test = (r: any) => {
    const f = selectedPeak(r)?.frequencyHz;
    const df = Math.max(
      r.features.spectrum?.resolutionHz || 0,
      selectedPeak(r)?.uncertaintyHz || 0,
      ...refs.map((x) => Math.max(x.features.spectrum?.resolutionHz || 0,selectedPeak(x)?.uncertaintyHz || 0)),
    );
    return (
      f > 0 &&
      mean - f >
        Math.max(
          rules.sigma * sd,
          df,
          (mean * rules.frequencyDropPercent) / 100,
        ) &&
      r.features.metrics.rmsVelocityMps >
        rms * (1 + rules.amplitudeRisePercent / 100)
    );
  };
  const recent = [
    ...new Map(
      older
        .sort((a, b) => a.measuredAt - b.measuredAt)
        .map((r) => [r.context.campaignId, r]),
    ).values(),
  ].sort((a: any, b: any) => b.measuredAt - a.measuredAt) as any[];
  let consecutive = test(current) ? 1 : 0;
  if (consecutive)
    for (const r of recent) {
      if (!test(r)) break;
      consecutive++;
    }
  const suspect = consecutive >= rules.consecutiveCampaigns;
  return {
    status: suspect ? "suspected" : consecutive ? "review" : "within_reference",
    label: suspect
      ? "疑似异常，需复核"
      : consecutive
        ? "单批次异常，待复核"
        : "本次未触发组合判据",
    reason: "同工况频率下降与幅值上升组合；不等同于结构损伤确诊",
    referenceIds: refs.map((r) => r.id),
    frequencyShiftPercent: (frequency / mean - 1) * 100,
    amplitudeRatio: amplitude / rms,
    referenceFrequencyHz: mean,
    standardDeviationHz: sd,
    consecutiveCampaigns: consecutive,
    thresholds: rules,
  };
}

/** Unsigned multi-point response at one frequency, not an identified mode shape. */
export function responseDistribution(
  results: any[],
  objects: MeasurementObject[],
  config: {
    campaignId: string;
    turbineId: string;
    azimuthDeg: number;
    frequencyHz: number;
    bandwidthHz?: number;
    includeDiagnostic?: boolean;
  },
) {
  if (
    !Number.isFinite(config.frequencyHz) ||
    config.frequencyHz <= 0 ||
    !Number.isFinite(config.azimuthDeg)
  )
    throw Error("请选择有效的频率和圆周角");
  const inScope = results.filter(
    (r) =>
      r.context.campaignId === config.campaignId &&
      r.context.turbineId === config.turbineId &&
      r.azimuthDeg === config.azimuthDeg &&
      r.features.status === "analyzed",
  );
  const candidates = measurementHistory(inScope.filter((r) => config.includeDiagnostic === true || !isDiagnosticMeasurement(r)));
  const resolutions = candidates.map(r => Number(r.features.spectrum?.resolutionHz)).filter(v => Number.isFinite(v) && v > 0);
  const bandwidthHz = config.bandwidthHz ?? (resolutions.length ? Math.max(...resolutions) : NaN);
  if (!Number.isFinite(bandwidthHz) || bandwidthHz <= 0 || bandwidthHz >= 2 * config.frequencyHz)
    throw Error("比较频带宽度必须大于 0，且频带下限必须高于 0 Hz；缺少频谱时请先分析记录");
  const bandLowHz = config.frequencyHz - bandwidthHz / 2;
  const bandHighHz = config.frequencyHz + bandwidthHz / 2;
  const blades = objects
    .filter((o) => o.kind === "blade" && o.parentId === config.turbineId)
    .sort((a, b) => a.code.localeCompare(b.code, "zh", { numeric: true }));
  const curves = blades.map((blade) => ({
    bladeId: blade.id,
    name: blade.name,
    points: [1, 2, 3, 4, 5].map((i) => {
      const position = objects.find(
        (o) =>
          o.kind === "position" &&
          o.parentId === blade.id &&
          o.code.toUpperCase() === `P${i}`,
      );
      const r = position
        ? candidates
            .filter((r) => r.context.positionId === position.id)
            .sort((a, b) =>
              String(b.createdAt).localeCompare(String(a.createdAt)),
            )[0]
        : null;
      const spectrum = r?.features.spectrum;
      const frequencies: number[] = spectrum?.frequencies || [];
      const psd: number[] = spectrum?.psd || [];
      const resolutionHz = Number(spectrum?.resolutionHz);
      let missingReason = "";
      let velocityPower = 0, displacementPower = 0;
      if (r) {
        if (spectrum?.completeBins !== true || frequencies.length < 2 || frequencies.length !== psd.length)
          missingReason = "缺少完整频谱，请重新分析";
        else if (!Number.isFinite(resolutionHz) || resolutionHz <= 0 || resolutionHz > bandwidthHz * (1 + 1e-9))
          missingReason = "频率分辨率不足，请加宽共同频带或重新分析";
        else if (bandLowHz < frequencies[0] || bandHighHz > frequencies[frequencies.length - 1])
          missingReason = "频带超出实测频谱范围";
        else {
          for (let index = 0; index < frequencies.length; index++) {
            const hz = frequencies[index], density = psd[index];
            if (!Number.isFinite(hz) || !Number.isFinite(density) || density < 0 ||
                (index > 0 && Math.abs(hz - frequencies[index - 1] - resolutionHz) > resolutionHz * 1e-6)) {
              missingReason = "频谱数据无效，请重新分析";
              break;
            }
            // Integrate each Welch bin only over its overlap with the shared band.
            const overlapHz = Math.max(0, Math.min(bandHighHz, hz + resolutionHz / 2) - Math.max(bandLowHz, hz - resolutionHz / 2));
            if (overlapHz > 0) {
              if (hz <= 0) { missingReason = "频带包含直流分量，请提高比较频率"; break; }
              velocityPower += density * overlapHz;
              displacementPower += density * overlapHz / (2 * Math.PI * hz) ** 2;
            }
          }
        }
      }
      const amplitudeMps = r && !missingReason ? Math.sqrt(velocityPower) : null;
      return {
        positionId: position?.id || null,
        name: position?.name || `P${i}`,
        radiusM: r?.radiusM ?? position?.radiusM ?? null,
        resultId: r?.id || null,
        diagnosticOnly: r ? isDiagnosticMeasurement(r) : false,
        frequencyHz: amplitudeMps !== null ? config.frequencyHz : null,
        bandwidthHz,
        resolutionHz: Number.isFinite(resolutionHz) ? resolutionHz : null,
        amplitudeMps,
        rmsVelocityMps: amplitudeMps,
        rmsDisplacementM: amplitudeMps !== null ? Math.sqrt(displacementPower) : null,
        condition: r?.condition || null,
        reason: !position
          ? "未登记"
          : !r
            ? position && inScope.some((item) => item.context.positionId === position.id && isDiagnosticMeasurement(item))
              ? "仅有诊断数据，未纳入"
              : "未分析"
            : missingReason
              ? missingReason
              : isDiagnosticMeasurement(r) ? "诊断响应" : "已计算",
      };
    }),
  }));
  if (!curves.some((c) => c.points.some((p) => p.amplitudeMps !== null)))
    throw Error("当前范围没有可计算的完整频谱：" + [...new Set(curves.flatMap(c => c.points).filter(p => p.resultId).map(p => p.reason))].join("；"));
  const max = Math.max(
    ...curves.flatMap((c) => c.points.map((p) => p.amplitudeMps || 0)),
  );
  const used = curves.flatMap((c) => c.points).filter((p) => p.resultId && p.amplitudeMps !== null);
  const hasDiagnostic = used.some((p) => p.diagnosticOnly);
  return {
    config: { ...config, bandwidthHz, bandLowHz, bandHighHz },
    curves: curves.map((c) => ({
      ...c,
      points: c.points.map((p) => ({
        ...p,
        normalizedAmplitude:
          p.amplitudeMps === null ? null : max > 0 ? p.amplitudeMps / max : 0,
      })),
    })),
    phaseAvailable: false,
    hasDiagnostic,
    diagnosticOnly: used.length > 0 && used.every((p) => p.diagnosticOnly),
    validMeasurement: !hasDiagnostic,
    status: "response_distribution",
    conclusion:
      (hasDiagnostic ? "含诊断数据，仅用于响应比较，不作为有效测量或健康结论。" : "") +
      "同批次同圆周角、同一频带的完整 PSD 积分响应；缺失点不补值。异步测点没有共同相位参考，不能认定为带符号的固有振型。",
  };
}
