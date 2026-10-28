import {
  audit,
  digest,
  HttpError,
  rows,
  unpack,
  type RecordItem,
  type User,
} from "./db";
import { limitedBody, rotationWorker, windUploadPreview, withWindImport } from "./rotation";
import {
  adoptSources,
  filterMeasurementAccess,
  bindMeasurement,
  listMeasurementRows,
  readMeasurementRows,
  measurementSources,
  measurementLive,
  sourceBindings,
  objects,
  prepareSource,
  replaceMeasurementRow,
  requireAnalyst,
  requireEditor,
  saveMeasurementRow,
  saveObject,
  saveWindDataset,
  windDatasetSummaries,
  validContext,
  type MeasurementSource,
} from "./measurement-store";
import {
  assessMeasurement,
  responseDistribution,
  conditionWindow,
  contextNames,
  isDiagnosticMeasurement,
  initialDamageRules,
  validateDamageRules,
  validateWindRows,
  type MeasurementObject,
} from "@blade/ui/measurement-domain";

function sourceView(s: MeasurementSource) {
  return { ...s, raw: undefined, metadata: {
    windFarm: s.raw.windFarm, turbine: s.raw.turbine, point: s.raw.point,
    pointCycle: s.raw.pointCycle || s.raw.sourceMetadata?.pointCycle,
    source: s.raw.source, status: s.raw.status,
    diagnosticOnly: isDiagnosticMeasurement(s.raw), validMeasurement: !isDiagnosticMeasurement(s.raw),
  } };
}
function validation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}
const withRevision = (r: any) => ({
  ...r,
  revision: digest(JSON.stringify(r)),
});
const rulesId = (user: User) => "mrules-" + digest(user.tenant).slice(0, 48);
export async function measurementRules(user: User) {
  const row = (await listMeasurementRows(user, "measurement_rules"))[0];
  return {
    rules: row?.rules || initialDamageRules,
    revision: row ? digest(JSON.stringify(row)) : null,
  };
}
export async function analysisResults(user: User) {
  const [results, reviews] = await Promise.all([
    readMeasurementRows(user, "measurement_results", true),
    listMeasurementRows(user, "measurement_reviews"),
  ]);
  return (await filterMeasurementAccess(user, results)).map((r) => {
    const review = reviews.find((x) => x.resultId === r.id);
    return {
      ...r,
      review: review ? withRevision(review) : null,
      referenceApproved: !isDiagnosticMeasurement(r) && review?.referenceApproved === true,
    };
  });
}
export function summarizeAnalysis(r: any) {
  const { stitch, waveform, ...features } = r.features || {};
  return { ...r, features };
}
function string(value: any, label: string, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(400, `${label}不能为空或过长`);
  return value.trim();
}
async function input(req: Request) {
  try {
    const b = JSON.parse((await limitedBody(req, 8 * 1024 * 1024)).toString());
    if (!b || Array.isArray(b) || typeof b !== "object") throw Error();
    return b;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "请求必须是 JSON 对象");
  }
}
function realStart(source: any, override: any) {
  const value =
    override ||
    source.raw.sourceSampleOrigin ||
    source.raw.sourceMetadata?.sampleOrigin ||
    source.raw.sourceStartedAt ||
    source.raw.sourceMetadata?.startedAt ||
    source.raw.testTime ||
    (source.reference.kind === "capture" ? source.raw.startedAt : null);
  const t =
    typeof value === "number"
      ? value * (value < 1e11 ? 1000 : 1)
      : Date.parse(value);
  if (!Number.isFinite(t) || t <= 0 || t > Date.now() + 86400000)
    throw new HttpError(
      400,
      "请填写实际测量开始时间，导入文件的时间不能代替测量时间",
    );
  return t;
}
/** Select only the currently bound measurement records, never a client's worker IDs. */
export function measurementSynthesisSelection(
  user: User,
  sources: MeasurementSource[],
  all: MeasurementObject[],
  b: Record<string, any>,
) {
  requireAnalyst(user);
  const allowed = new Set(["farmId", "campaignId", "turbineId", "bladeId", "positionIds", "includeDiagnostic", "minHz", "maxHz"]);
  if (Object.keys(b).some((key) => !allowed.has(key)))
    throw new HttpError(400, "振幅合成参数无效，请重新选择测量任务与叶片");
  const scope = Object.fromEntries(
    ["farmId", "campaignId", "turbineId", "bladeId"].map((key) => [key, string(b[key], key)]),
  );
  const positions = all.filter((o) => o.active && o.kind === "position" && o.parentId === scope.bladeId);
  if (!positions.length) throw new HttpError(400, "该叶片没有可用测点");
  validContext({ ...scope, positionId: positions[0].id }, all);
  if (b.positionIds !== undefined && (
    !Array.isArray(b.positionIds) || !b.positionIds.length || b.positionIds.length > 64 ||
    new Set(b.positionIds).size !== b.positionIds.length ||
    b.positionIds.some((id: unknown) => typeof id !== "string" || !positions.some((p) => p.id === id))
  )) throw new HttpError(400, "请选择当前叶片的有效测点");
  if (b.includeDiagnostic !== undefined && typeof b.includeDiagnostic !== "boolean")
    throw new HttpError(400, "诊断记录分析选项必须是布尔值");
  const minHz = b.minHz ?? 20, maxHz = b.maxHz ?? 2000;
  if ([minHz, maxHz].some((v) => typeof v !== "number" || !Number.isFinite(v) || v < .1 || v > 100000) || minHz >= maxHz)
    throw new HttpError(400, "合成频段须在 0.1～100000 Hz 内，且下限小于上限");
  const scoped = sources.filter((s) => s.tenant === user.tenant && s.context && s.bindingRevision &&
    Object.entries(scope).every(([key, value]) => s.context![key as keyof typeof s.context] === value) &&
    positions.some((p) => p.id === s.context!.positionId) &&
    (!b.positionIds || b.positionIds.includes(s.context.positionId)));
  const chosen = scoped.filter((s) => b.includeDiagnostic === true || !isDiagnosticMeasurement(s.raw));
  if (!chosen.length) throw new HttpError(400, scoped.length
    ? "所选测点只有诊断记录；如需查看诊断响应，请显式勾选纳入诊断数据"
    : "当前测量任务、叶片和测点没有可分析的已关联原始记录");
  if (chosen.length > 64) throw new HttpError(400, "单次振幅合成最多 64 条记录，请缩小测点范围或测量批次");
  return { chosen, scope, includeDiagnostic: b.includeDiagnostic === true, minHz, maxHz };
}
async function synthesize(user: User, b: Record<string, any>) {
  requireAnalyst(user);
  const [sources, all] = await Promise.all([measurementSources(user, { context: { campaignId: b.campaignId, turbineId: b.turbineId, bladeId: b.bladeId } }), objects(user)]);
  const selection = measurementSynthesisSelection(user, sources, all, b);
  const recordingIds: string[] = [];
  for (const source of selection.chosen) recordingIds.push(await prepareSource(user, source));
  const result = await rotationWorker(user, {
    action: "blade-passes",
    parameters: {
      recordingIds,
      includeDiagnostic: selection.includeDiagnostic,
      passWindow: "detected",
      detrend: "constant",
      synthesis: { minHz: selection.minHz, maxHz: selection.maxHz },
    },
  });
  const links = await sourceBindings(user, selection.chosen.map(s => s.key));
  for (const source of selection.chosen) {
    const link = links.find((l) => l.key === source.key);
    if (!link || digest(JSON.stringify(link)) !== source.bindingRevision)
      throw new HttpError(409, "计算期间记录归属已变化，请重新选择记录");
  }
  return result;
}
async function analyze(user: User, b: any) {
  requireAnalyst(user);
  const refs = b.references || [b.reference];
  if (!Array.isArray(refs) || !refs.length || refs.length > 16)
    throw new HttpError(400, "请选择 1～16 条记录");
  const [sources, all, history, datasets, ruleState] = await Promise.all([
    measurementSources(user, { references: refs }),
    objects(user),
    analysisResults(user),
    listMeasurementRows(user, "wind_datasets"),
    measurementRules(user),
  ]);
  const selected = refs.map((ref: any) =>
    sources.find(
      (x) => x.reference.kind === ref?.kind && x.reference.id === ref?.id,
    ),
  );
  if (selected.some((s: any) => !s))
    throw new HttpError(404, "原始记录不存在或无权访问");
  const chosen = selected as typeof sources;
  if (new Set(chosen.map((s) => s.key)).size !== chosen.length)
    throw new HttpError(400, "记录重复");
  const s = chosen[0],
    context = validContext(s.context, all),
    pc = s.raw.pointCycle || s.raw.sourceMetadata?.pointCycle || {};
  for (const source of chosen) {
    validContext(source.context, all);
    const cp =
      source.raw.pointCycle || source.raw.sourceMetadata?.pointCycle || {};
    if (
      Object.keys(context).some(
        (k) =>
          source.context?.[k as keyof typeof context] !==
          context[k as keyof typeof context],
      ) ||
      cp.azimuthDeg !== pc.azimuthDeg
    )
      throw new HttpError(400, "只能合并同批次、同点位、同圆周角的记录");
  }
  if (chosen.length > 1 && b.measuredAt)
    throw new HttpError(
      400,
      "多条合并须各自保留原测量时间；缺失时间的文件请逐条分析",
    );
  const times = chosen.map((source) => realStart(source, b.measuredAt));
  const measuredAt = Math.min(...times),
    measurementEnd = Math.max(
      ...chosen.map(
        (source, i) =>
          times[i] + (source.raw.samples / source.raw.sampleRate) * 1000,
      ),
    );
  const recordingIds: string[] = [];
  for (const source of chosen)
    recordingIds.push(await prepareSource(user, source));
  const parameters = b.parameters || {};
  const features = await rotationWorker(user, {
    action: "measurement-analysis",
    parameters: {
      ...parameters,
      ...(chosen.length === 1
        ? { recordingId: recordingIds[0] }
        : { recordingIds }),
    },
  });
  const links = await sourceBindings(user, chosen.map(s => s.key));
  for (const source of chosen) {
    const link = links.find((l) => l.key === source.key);
    if (!link || digest(JSON.stringify(link)) !== source.bindingRevision)
      throw new HttpError(409, "计算期间记录归属已变化，请重新选择记录");
  }
  const turbine = all.find((o) => o.id === context.turbineId)!;
  const condition = conditionWindow(
    datasets as any,
    context.farmId,
    turbine.code,
    measuredAt,
    measurementEnd,
  );
  const result: any = {
    name: s.name,
    sourceKey:
      chosen.length === 1
        ? s.key
        : "group:" +
          digest(
            chosen
              .map((s) => s.key)
              .sort()
              .join("|"),
          ),
    sourceKeys: chosen.map((s) => s.key),
    reference: s.reference,
    references: chosen.map((s) => s.reference),
    measurementEnd,
    context,
    objectsSnapshot: all.filter((o) => Object.values(context).includes(o.id)),
    measuredAt,
    measuredTimeOrigin: b.measuredAt ? "operator-confirmed" : "recorded",
    identityVerified: pc.identityVerified === true,
    pointCycleSnapshot: pc,
    createdAt: new Date().toISOString(),
    features,
    diagnosticOnly: features.diagnosticOnly === true,
    validMeasurement: features.validMeasurement !== false,
    condition,
    azimuthDeg: pc.azimuthDeg ?? pc.phaseDeg ?? null,
    angles: {
      pitchDeg:
        pc.targetAxis1AngleDeg ??
        pc.targetPitchDeg ??
        pc.target?.axis1AngleDeg ??
        pc.plannedStations?.find((p: any) => p.azimuthDeg === pc.azimuthDeg)
          ?.axis1AngleDeg ??
        null,
      yawDeg:
        pc.targetAxis2AngleDeg ??
        pc.targetYawDeg ??
        pc.target?.axis2AngleDeg ??
        pc.plannedStations?.find((p: any) => p.azimuthDeg === pc.azimuthDeg)
          ?.axis2AngleDeg ??
        null,
    },
    radiusM:
      pc.radiusM ??
      all.find((o) => o.id === context.positionId)?.radiusM ??
      null,
    referenceApproved: false,
    source: "measured",
  };
  result.assessment = assessMeasurement(result, history, ruleState.rules);
  const saved = await saveMeasurementRow(user, "measurement_results", result);
  await audit(user, "真实测量特征分析", saved.id);
  return saved;
}
function reportRows(results: any[], all: any[]) {
  // Keep all azimuths, selecting the latest calculation of the same raw record.
  const unique = [
    ...new Map(
      results
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .map((r) => [r.sourceKey, r]),
    ).values(),
  ];
  return unique.map((r) => ({
    id: r.id,
    reference: r.reference,
    sourceKeys: r.sourceKeys || [r.sourceKey],
    references: r.references,
    context: r.context,
    names: contextNames(r.context, r.objectsSnapshot || all),
    measuredAt: r.measuredAt,
    azimuthDeg: r.azimuthDeg,
    angles: r.angles,
    radiusM: r.radiusM,
    identityVerified: r.identityVerified,
    diagnosticOnly: isDiagnosticMeasurement(r),
    validMeasurement: !isDiagnosticMeasurement(r),
    pointCycleSnapshot: r.pointCycleSnapshot,
    condition: r.condition,
    metrics: r.features.metrics,
    peaks: r.features.peaks,
    validSeconds: r.features.validSeconds,
    resolutionHz: r.features.spectrum?.resolutionHz,
    parameters: r.features.parameters,
    algorithmVersion: r.features.algorithmVersion,
    provenance: r.features.provenance,
    ranges: r.features.ranges,
    boundaryBasis: r.features.boundaryBasis,
    events: r.features.events || [],
    assessment: r.assessment,
    review: r.review,
  }));
}
/** Source coverage is separate from health or proof of a full physical turn. */
export function buildMeasurementReportCoverage(sources: any[], results: any[], all: any[]) {
  const analyzed = new Set(results.flatMap((r) => r.sourceKeys || [r.sourceKey]));
  const excludedSources = sources.filter((s) => !analyzed.has(s.key)).map((s) => {
    const pc = s.raw.pointCycle || s.raw.sourceMetadata?.pointCycle || {};
    const handoff = pc.handoff || {};
    const clock = pc.continuousSession;
    let reason = "尚无成功分析结果，请先分析或核对该记录的进入离开边界";
    let reasonCode = "not_analyzed";
    // Only identify an acquisition truncation when its saved clock is explicit.
    // Never infer or clamp a missing entry into a complete observation.
    if (handoff.sampleClock === "continuous_session_raw" && clock?.sampleClock === handoff.sampleClock &&
      Number.isFinite(clock.sampleStart) && Number.isFinite(clock.sampleEndExclusive)) {
      if (Number.isFinite(handoff.entrySampleIndex) && handoff.entrySampleIndex < clock.sampleStart) {
        reason = "进入起点早于本条记录起点，缺少经过头部，未纳入完整经过分析";
        reasonCode = "pass_boundary_outside_recording";
      } else if (Number.isFinite(handoff.exitConfirmedSampleIndex) && handoff.exitConfirmedSampleIndex >= clock.sampleEndExclusive) {
        reason = "离开确认超出本条记录范围，缺少经过尾部，未纳入完整经过分析";
        reasonCode = "pass_boundary_outside_recording";
      }
    }
    return {
      key: s.key, reference: s.reference, context: s.context,
      names: contextNames(s.context, all), name: s.name,
      azimuthDeg: pc.azimuthDeg ?? pc.phaseDeg ?? null,
      diagnosticOnly: isDiagnosticMeasurement(s.raw),
      status: "not_analyzed", reason, reasonCode,
    };
  });
  return {
    coverage: {
      registeredSources: sources.length,
      analyzedSources: sources.length - excludedSources.length,
      unanalyzedSources: excludedSources.length,
      complete: sources.length > 0 && excludedSources.length === 0,
      meaning: "已关联来源的分析覆盖，不代表物理整圈连续覆盖或健康结论",
    },
    excludedSources,
  };
}
export async function measurementEndpoint(
  user: User,
  req: Request,
  path: string[],
): Promise<unknown> {
  const [resource, action, id] = path,
    method = req.method,
    url = new URL(req.url);
  if (resource === "objects") {
    if (path.length === 1 && method === "GET")
      return { objects: await objects(user) };
    if (path.length === 1 && method === "POST")
      return { object: await saveObject(user, await input(req)) };
    if (path.length === 2 && action === "link" && method === "POST")
      return bindMeasurement(user, await input(req));
    if (path.length === 2 && action === "default-points" && method === "POST") {
      requireEditor(user);
      const b = await input(req),
        all = await objects(user),
        t = all.find(
          (o) => o.id === b.turbineId && o.kind === "turbine" && o.active,
        );
      if (!t) throw new HttpError(404, "请选择风机");
      if (all.some((o) => o.parentId === t.id && o.kind === "blade"))
        throw new HttpError(409, "已有叶片，请逐项维护，避免重复生成");
      for (let i = 1; i <= 3; i++) {
        const blade = await saveObject(user, {
          kind: "blade",
          code: String(i),
          name: `叶片 ${i}`,
          parentId: t.id,
        });
        for (let j = 1; j <= 5; j++)
          await saveObject(user, {
            kind: "position",
            code: `P${j}`,
            name: `P${j}`,
            parentId: blade!.id,
          });
      }
      return { objects: await objects(user) };
    }
    if (path.length === 2 && action === "adopt" && method === "POST") {
      const b = await input(req);
      if (Object.keys(b).some(key => key !== "cursor") || (b.cursor != null && typeof b.cursor !== "string")) throw new HttpError(400, "关联分页参数无效");
      return adoptSources(user, b.cursor);
    }
  }
  if (resource === "wind-datasets") {
    if (path.length === 1 && method === "GET")
      return {
        datasets: await windDatasetSummaries(user),
        objects: await objects(user),
      };
    if (path.length === 2 && action === "preview-file" && method === "POST") {
      requireAnalyst(user);
      return windUploadPreview(user, req);
    }
    if (path.length === 2 && action === "import" && method === "POST") {
      requireAnalyst(user);
      const b = await input(req), all = await objects(user);
      if (!all.some(o => o.id === b.farmId && o.kind === "farm" && o.active)) throw new HttpError(400, "请选择风场");
      const name = string(b.name, "数据集名称");
      return withWindImport(user, { files: b.files, timezoneOffset: b.timezoneOffset, units: b.units }, async (inputRows, summary) => {
        const windRows = validation(() => validateWindRows(inputRows));
        const registered = new Set(all.filter(o => o.kind === "turbine" && o.active && o.parentId === b.farmId).map(o => o.code));
        const unknown = [...new Set(windRows.filter(r => !registered.has(r.turbineCode)).map(r => r.turbineCode))];
        if (unknown.length) throw new HttpError(400, `风机 ${unknown.slice(0, 5).join("、")} 未在该风场登记，请先维护对象`);
        const { resultToken: _, ...importSummary } = summary;
        const d = await saveWindDataset(user, { ...importSummary, name, farmId: b.farmId, rows: windRows,
          units: { windSpeed: "m/s", rpm: "rpm", windDirection: "deg", powerKw: "kW", temperatureC: "°C" },
          importedAt: new Date().toISOString() });
        return { id: d.id, count: windRows.length, ...importSummary };
      });
    }
    if (path.length === 2 && action === "preview" && method === "POST") {
      requireAnalyst(user);
      const b = await input(req);
      return rotationWorker(user, {
        action: "wind-preview",
        filename: b.filename,
        base64: b.base64,
      });
    }
    if (path.length === 1 && method === "POST") {
      requireAnalyst(user);
      const b = await input(req),
        all = await objects(user);
      if (!all.some((o) => o.id === b.farmId && o.kind === "farm" && o.active))
        throw new HttpError(400, "请选择风场");
      const windRows = validation(() => validateWindRows(b.rows));
      if (
        windRows.some(
          (r) =>
            !all.some(
              (o) =>
                o.kind === "turbine" &&
                o.active &&
                o.parentId === b.farmId &&
                o.code === r.turbineCode,
            ),
        )
      )
        throw new HttpError(400, "部分风机编号未在该风场登记，请先维护对象");
      const d = await saveWindDataset(user, {
        name: string(b.name, "数据集名称"),
        farmId: b.farmId,
        rows: windRows,
        units: {
          windSpeed: "m/s",
          rpm: "rpm",
          windDirection: "deg",
          powerKw: "kW",
          temperatureC: "°C",
        },
        metricCounts: Object.fromEntries(["windSpeed", "rpm", "windDirection", "powerKw", "temperatureC"].map(key => [key, windRows.filter(row => row[key as keyof typeof row] != null).length])),
        matchedRowCount: windRows.filter(row => row.windSpeed != null && row.rpm != null).length,
        start: windRows[0].time,
        end: windRows[windRows.length - 1].time,
        importedAt: new Date().toISOString(),
      });
      return { id: d.id, count: windRows.length };
    }
  }
  if (resource === "measurements") {
    if (path.length === 2 && action === "live" && method === "GET") {
      const params = new URL(req.url).searchParams;
      return measurementLive(user, { cursor: params.get("cursor"), limit: params.has("limit") ? Number(params.get("limit")) : 200 });
    }
    if (path.length === 2 && action === "sources" && method === "GET") {
      const params = new URL(req.url).searchParams;
      const sources = await measurementSources(user, { captureOnly: true, cursor: params.get("cursor"), limit: params.has("limit") ? Number(params.get("limit")) : 200 });
      return { sources: sources.map(sourceView), nextCursor: sources.nextCursor };
    }
    if (path.length === 1 && method === "GET") {
      const [sources, all, results, rules] = await Promise.all([
        measurementSources(user),
        objects(user),
        analysisResults(user),
        measurementRules(user),
      ]);
      return {
        sources: sources.map(sourceView),
        nextSourcesCursor: sources.nextCursor,
        objects: all,
        results: results.map(summarizeAnalysis),
        ...rules,
        limit: 5000,
      };
    }
    if (
      action === "source-waveform" &&
      path.length === 2 &&
      method === "POST"
    ) {
      const b = await input(req);
      const source = (await measurementSources(user, { references: [b.reference] })).find(
        (s) =>
          s.reference.kind === b.reference?.kind &&
          s.reference.id === b.reference?.id,
      );
      if (!source) throw new HttpError(404, "原始记录不存在或无权访问");
      return rotationWorker(user, {
        action: "measurement-waveform",
        recordingId: await prepareSource(user, source),
      });
    }
    if (action === "analyze" && path.length === 2 && method === "POST")
      return { result: await analyze(user, await input(req)) };
    if (action === "synthesis" && path.length === 2 && method === "POST")
      return synthesize(user, await input(req));
    if (action === "result" && path.length === 3 && method === "GET") {
      const [stored] = await rows<RecordItem>(
        "SELECT * FROM records WHERE kind='measurement_results' AND tenant=? AND id=?",
        [user.tenant, id],
      );
      if (
        !stored ||
        !(await filterMeasurementAccess(user, [unpack(stored)])).length
      )
        throw new HttpError(404, "分析结果不存在");
      const review = (
        await listMeasurementRows(user, "measurement_reviews")
      ).find((r) => r.resultId === id);
      return {
        result: {
          ...unpack(stored),
          review: review ? withRevision(review) : null,
          referenceApproved: !isDiagnosticMeasurement(unpack(stored)) && review?.referenceApproved === true,
        },
      };
    }
    if (action === "rules" && path.length === 2) {
      if (method === "GET") return measurementRules(user);
      if (method === "PUT") {
        requireAnalyst(user);
        const b = await input(req),
          rules = validation(() => validateDamageRules(b.rules));
        await replaceMeasurementRow(
          user,
          "measurement_rules",
          rulesId(user),
          { name: "同工况异常判据", rules },
          b.revision ?? null,
          "更新同工况判据",
        );
        return measurementRules(user);
      }
    }
    if (action === "review" && path.length === 2 && method === "POST") {
      requireAnalyst(user);
      const b = await input(req),
        r = (await analysisResults(user)).find((r) => r.id === b.resultId);
      if (!r) throw new HttpError(404, "分析结果不存在");
      if (
        typeof b.referenceApproved !== "boolean" ||
        !["待复核", "已确认", "已关闭"].includes(b.status)
      )
        throw new HttpError(400, "复核状态无效");
      const note = string(b.note, "复核说明", 2000);
      if (b.referenceApproved && isDiagnosticMeasurement(r))
        throw new HttpError(400, "诊断数据可复核，但不能设为正常健康参考");
      let range: { startSeconds: number; endSeconds: number } | null = null;
      if (b.range != null) {
        const { startSeconds, endSeconds } = b.range;
        if (
          typeof startSeconds !== "number" ||
          typeof endSeconds !== "number" ||
          !Number.isFinite(startSeconds) ||
          !Number.isFinite(endSeconds) ||
          startSeconds < 0 ||
          endSeconds <= startSeconds ||
          endSeconds > r.features.validSeconds
        )
          throw new HttpError(400, "标记区间须位于有效波形时间范围内");
        range = { startSeconds, endSeconds };
      }
      if (
        b.referenceApproved &&
        (b.status !== "已确认" ||
          r.condition.status !== "matched" ||
          !r.features.peaks.length)
      )
        throw new HttpError(400, "正常参考须已确认，并具备可用频率和匹配工况");

      await replaceMeasurementRow(
        user,
        "measurement_reviews",
        "review-" + digest(user.tenant + "|" + r.id).slice(0, 48),
        {
          resultId: r.id,
          referenceApproved: b.referenceApproved,
          note,
          range,
          status: b.status,
          reviewer: user.name,
          reviewedAt: new Date().toISOString(),
        },
        b.revision ?? null,
        "复核测量结果",
      );
      return { ok: true };
    }
    if (action === "reassess" && path.length === 2 && method === "POST") {
      requireAnalyst(user);
      const b = await input(req),
        history = await analysisResults(user),
        r = history.find((r) => r.id === b.resultId);
      if (!r) throw new HttpError(404, "分析结果不存在");
      const [stored] = await rows<RecordItem>(
        "SELECT * FROM records WHERE kind='measurement_results' AND tenant=? AND id=?",
        [user.tenant, r.id],
      );
      const {
        id: oldId,
        updatedAt,
        ownerId,
        recordTenant,
        review,
        ...copy
      } = { ...r, ...unpack(stored) };
      copy.assessment = assessMeasurement(
        r,
        history,
        (await measurementRules(user)).rules,
      );
      copy.createdAt = new Date().toISOString();
      copy.supersedes = oldId;
      copy.referenceApproved = false;
      const saved = await saveMeasurementRow(user, "measurement_results", copy);
      await audit(user, "重算异常判据", saved.id);
      return { result: saved };
    }
    if (action === "modal" && path.length === 2) {
      if (method === "GET")
        return {
          results: await listMeasurementRows(user, "measurement_modal"),
        };
      if (method === "POST") {
        requireAnalyst(user);
        const b = await input(req),
          all = await objects(user);
        const campaign = all.find(
          (o) => o.kind === "campaign" && o.id === b.campaignId,
        );
        if (!campaign?.turbineIds?.includes(b.turbineId))
          throw new HttpError(400, "风机不属于该测量批次");
        if (b.includeDiagnostic !== undefined && typeof b.includeDiagnostic !== "boolean")
          throw new HttpError(400, "纳入诊断数据分析必须是布尔值");
        const config = {
          campaignId: b.campaignId,
          turbineId: b.turbineId,
          azimuthDeg: b.azimuthDeg,
          frequencyHz: b.frequencyHz,
          bandwidthHz: b.bandwidthHz,
          includeDiagnostic: b.includeDiagnostic === true,
        };
        // Read spectra only for the authorized measurement scope selected by
        // this request. Normal result listings still omit all PSD arrays.
        const summaries = await analysisResults(user);
        const scoped = summaries.filter((r) =>
          r.context.campaignId === config.campaignId &&
          r.context.turbineId === config.turbineId &&
          r.azimuthDeg === config.azimuthDeg &&
          r.features.status === "analyzed" &&
          (config.includeDiagnostic || !isDiagnosticMeasurement(r)),
        );
        const spectrumRows = scoped.length ? await rows<RecordItem>(
          `SELECT id,kind,tenant,JSON_REMOVE(body,'$.features.stitch','$.features.waveform') AS body,created_by,updated_at FROM records WHERE kind='measurement_results' AND tenant=? AND id IN (${scoped.map(() => "?").join(",")})`,
          [user.tenant, ...scoped.map((r) => r.id)],
        ) : [];
        const spectra = new Map(spectrumRows.map((r) => [r.id, unpack(r).features?.spectrum]));
        const history = summaries.map((r) => spectra.has(r.id)
          ? { ...r, features: { ...r.features, spectrum: spectra.get(r.id) } }
          : r);
        const result = validation(() =>
          responseDistribution(history, all, config),
        );
        const record = await saveMeasurementRow(user, "measurement_modal", {
          name: campaign.name + " · 多点响应",
          createdAt: new Date().toISOString(),
          objectsSnapshot: all,
          sourceKeys: [
            ...new Set(
              result.curves.flatMap((c) =>
                c.points.flatMap((p) => {
                  const r = history.find((r) => r.id === p.resultId);
                  return r ? r.sourceKeys || [r.sourceKey] : [];
                }),
              ),
            ),
          ],
          ...result,
        });
        await audit(user, "计算多点频带响应", record.id);
        return { result: record };
      }
    }
    if (action === "reports" && path.length === 2) {
      if (method === "GET") {
        let rs = await listMeasurementRows(user, "measurement_reports");
        const campaign = url.searchParams.get("campaignId"),
          turbine = url.searchParams.get("turbineId");
        rs = rs.filter(
          (r) =>
            (!campaign || r.campaignId === campaign) &&
            (!turbine || r.turbineId === turbine),
        );
        const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        return { reports: rs.slice(offset, offset + 20), total: rs.length };
      }
      if (method === "POST") {
        requireAnalyst(user);
        const b = await input(req),
          all = await objects(user),
          campaign = all.find(
            (o) => o.kind === "campaign" && o.id === b.campaignId,
          );
        if (!campaign) throw new HttpError(400, "请选择测量批次");
        const turbineId = b.turbineId || null;
        if (turbineId && !campaign.turbineIds?.includes(turbineId))
          throw new HttpError(400, "风机不属于该批次");
        const results = (await analysisResults(user)).filter(
          (r) =>
            r.context.campaignId === campaign.id &&
            (!turbineId || r.context.turbineId === turbineId),
        );
        if (!results.length || results.length > 1000)
          throw new HttpError(400, "请选择包含 1～1000 条实测分析结果的范围");
        const relevant = all.filter(
          (o) =>
            Object.values(results[0].context).includes(o.id) ||
            campaign.turbineIds?.includes(o.id) ||
            all.some(
              (t) =>
                t.kind === "blade" &&
                campaign.turbineIds?.includes(t.parentId || "") &&
                o.parentId === t.id,
            ) ||
            (o.kind === "blade" &&
              campaign.turbineIds?.includes(o.parentId || "")),
        );
        const reportEntries = reportRows(results, all);
        const diagnosticCount = reportEntries.filter(isDiagnosticMeasurement).length;
        const reportSources = (await measurementSources(user, { context: { campaignId: campaign.id, ...(turbineId ? { turbineId } : {}) } })).filter((s) =>
          s.context?.campaignId === campaign.id && (!turbineId || s.context?.turbineId === turbineId));
        const sourceCoverage = buildMeasurementReportCoverage(reportSources, reportEntries, all);
        const record = await saveMeasurementRow(user, "measurement_reports", {
          name: campaign.name + (diagnosticCount === reportEntries.length ? " · 诊断数据复核报告" : " · 工况测量报告"),
          hasDiagnostic: diagnosticCount > 0,
          diagnosticOnly: diagnosticCount === reportEntries.length,
          diagnosticCount,
          ...sourceCoverage,
          campaignId: campaign.id,
          turbineId,
          sourceKeys: [
            ...new Set(results.flatMap((r) => r.sourceKeys || [r.sourceKey])),
          ],
          reportNumber:
            "RPT-" +
            [
              all.find((o) => o.id === campaign.parentId)?.code,
              turbineId ? all.find((o) => o.id === turbineId)?.code : "MULTI",
              campaign.code,
            ]
              .map((v) =>
                String(v || "NA")
                  .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
                  .slice(0, 30),
              )
              .join("-") +
            "-" +
            new Date().toISOString().slice(0, 10).replaceAll("-", "") +
            "-" +
            digest(JSON.stringify(results.map((r) => r.id))).slice(0, 8),
          createdAt: new Date().toISOString(),
          author: user.name,
          objects: relevant,
          rows: reportEntries,
          conclusion:
            `本报告覆盖已关联来源 ${sourceCoverage.coverage.analyzedSources}/${sourceCoverage.coverage.registeredSources} 条。` +
            (sourceCoverage.coverage.unanalyzedSources ? `另有 ${sourceCoverage.coverage.unanalyzedSources} 条尚未纳入分析，不能据此认定点位或整圈观测完整。` : "") +
            (diagnosticCount ? `含 ${diagnosticCount} 条诊断来源分析，仅用于波形和响应复核，不作为正常参考、健康或损伤结论。` : "") +
            "按已保存的进入离开范围生成。缺失点位未评价；疑似异常须结合人工复核与现场巡检。非同步逐点响应不代表带相位的固有振型。",
        });
        await audit(user, "生成工况报告", record.id);
        return { report: record };
      }
    }
  }
  throw new HttpError(405, "测量工作区操作路径或方法无效");
}
