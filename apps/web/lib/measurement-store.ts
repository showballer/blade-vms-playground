export const measurementKinds = [
  "measurement_objects",
  "measurement_links",
  "measurement_results",
  "measurement_reviews",
  "measurement_rules",
  "measurement_modal",
  "measurement_reports",
  "wind_datasets",
] as const;
import { randomUUID } from "node:crypto";
import {
  audit,
  digest,
  HttpError,
  pool,
  rows,
  unpack,
  recordScope,
  type RecordItem,
  type User,
} from "./db";
import { sqlCaptureRepository, createCaptureService } from "./captures";
import { rotationWorker } from "./rotation";
import { healthTime, isHealthDemo } from "@blade/ui/health-workspace-data";
import type {
  MeasurementContext,
  MeasurementObject,
  MeasurementReference,
} from "@blade/ui/measurement-domain";
import { canonicalPositionCode } from "@blade/ui/measurement-domain";

export function requireAnalyst(user: User) {
  if (!["admin", "analyst"].includes(user.role))
    throw new HttpError(403, "此操作需要分析权限");
}
export function requireEditor(user: User) {
  if (user.role === "viewer") throw new HttpError(403, "当前账号只读");
}
export async function readMeasurementRows(user: User, kind: string, summary = false) {
  // Materialize only IDs/timestamps before reading large JSON bodies. Sorting
  // waveform/PSD JSON in MySQL can exhaust its sort buffer with just a few rows.
  const body = summary
    ? "JSON_REMOVE(r.body,'$.features.stitch','$.features.waveform','$.features.spectrum.frequencies','$.features.spectrum.psd')"
    : "r.body";
  const selected = await rows<RecordItem & { sort_created_at: Date | string }>(
    `SELECT r.id,r.kind,r.tenant,${body} AS body,r.created_by,r.updated_at,recent.created_at AS sort_created_at
     FROM (SELECT id,created_at FROM records WHERE kind=? AND tenant=? ORDER BY created_at DESC,id DESC LIMIT 5000) AS recent
     INNER JOIN records r ON r.id=recent.id`,
    [kind, user.tenant],
  );
  return selected.sort((a, b) => new Date(b.sort_created_at).getTime() - new Date(a.sort_created_at).getTime() || b.id.localeCompare(a.id)).map(unpack);
}
export async function listMeasurementRows(user: User, kind: string) {
  const listed = await readMeasurementRows(user, kind);
  return [
    "measurement_results",
    "measurement_reports",
    "measurement_modal",
  ].includes(kind)
    ? filterMeasurementAccess(user, listed)
    : listed;
}
/** Operators may not gain access to a colleague's waveform through an aggregate. */
export async function filterMeasurementAccess(user: User, records: any[]) {
  if (user.role !== "operator" || !records.length) return records;
  const keys = new Set((await measurementSources(user)).map((s) => s.key));
  return records.filter((r) => {
    const sources = r.sourceKeys || (r.sourceKey ? [r.sourceKey] : []);
    return sources.length > 0 && sources.every((key: string) => keys.has(key));
  });
}
export async function saveMeasurementRow(
  user: User,
  kind: string,
  body: Record<string, any>,
  id: string = randomUUID(),
) {
  await pool().execute(
    "INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,?,?,?,?)",
    [id, kind, user.tenant, JSON.stringify(body), user.id],
  );
  return { ...body, id, recordTenant: user.tenant };
}
/** Serialize imports on the farm row, including duplicate checks, without a table lock. */
export async function saveWindDataset(user: User, body: Record<string, any>) {
  const c = await pool().getConnection(),
    id = randomUUID();
  try {
    await c.beginTransaction();
    const [farms] = await c.execute(
      "SELECT * FROM records WHERE id=? AND kind='measurement_objects' AND tenant=? FOR UPDATE",
      [body.farmId, user.tenant],
    );
    const farm = (farms as RecordItem[])[0];
    if (!farm || unpack(farm).kind !== "farm" || !unpack(farm).active)
      throw new HttpError(400, "风场不存在或已归档");
    const [found] = await c.execute(
      "SELECT * FROM records WHERE kind='wind_datasets' AND tenant=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.farmId'))=?",
      [user.tenant, body.farmId],
    );
    const keys = new Set(
      (found as RecordItem[]).flatMap((d) =>
        unpack(d).rows.map((r: any) => r.turbineCode + "|" + r.time),
      ),
    );
    if (body.rows.some((r: any) => keys.has(r.turbineCode + "|" + r.time)))
      throw new HttpError(409, "已有同风机、同时间的工况数据，不重复覆盖");
    await c.execute(
      "INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,?,?,?,?)",
      [id, "wind_datasets", user.tenant, JSON.stringify(body), user.id],
    );
    await c.execute(
      "INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)",
      [
        randomUUID(),
        user.id,
        user.name,
        user.tenant,
        "导入风场工况",
        id,
        "成功",
      ],
    );
    await c.commit();
    return { ...body, id };
  } catch (error) {
    await c.rollback();
    throw error;
  } finally {
    c.release();
  }
}
export async function objects(user: User): Promise<MeasurementObject[]> {
  return (await listMeasurementRows(user, "measurement_objects")).map(
    (row) => ({ ...row, revision: digest(JSON.stringify(row)) }),
  ) as MeasurementObject[];
}
export function validContext(
  context: any,
  all: MeasurementObject[],
): MeasurementContext {
  if (!context || typeof context !== "object")
    throw new HttpError(400, "请完整选择风场、批次、风机、叶片和点位");
  const map = new Map(all.filter((o) => o.active).map((o) => [o.id, o]));
  for (const k of ["farm", "campaign", "turbine", "blade", "position"] as const)
    if (map.get(context[k + "Id"])?.kind !== k)
      throw new HttpError(400, `${k} 对象不存在或已归档`);
  if (
    map.get(context.campaignId)!.parentId !== context.farmId ||
    map.get(context.turbineId)!.parentId !== context.farmId ||
    map.get(context.bladeId)!.parentId !== context.turbineId ||
    map.get(context.positionId)!.parentId !== context.bladeId
  )
    throw new HttpError(400, "对象层级不一致");
  if (!map.get(context.campaignId)!.turbineIds?.includes(context.turbineId))
    throw new HttpError(400, "该风机尚未加入测量批次");
  return Object.fromEntries(
    ["farmId", "campaignId", "turbineId", "bladeId", "positionId"].map((k) => [
      k,
      context[k],
    ]),
  ) as MeasurementContext;
}
export async function saveObject(user: User, input: any) {
  requireEditor(user);
  const all = await objects(user),
    old = input.id ? all.find((o) => o.id === input.id) : undefined;
  if (input.id && !old) throw new HttpError(404, "对象不存在");
  if (old && old.revision !== input.revision)
    throw new HttpError(409, "对象已变化，请刷新");
  const { kind, code, name } = input;
  if (
    !["farm", "turbine", "blade", "position", "campaign"].includes(kind) ||
    typeof code !== "string" ||
    !code.trim() ||
    code.length > 100 ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 120
  )
    throw new HttpError(400, "请填写有效的对象类型、编号和名称");
  if (
    old &&
    (kind !== old.kind || code !== old.code || input.parentId !== old.parentId)
  )
    throw new HttpError(
      400,
      "已有对象的类型、编号与归属不可改写，请新建对象，历史归属保留",
    );
  const parentId = kind === "farm" ? null : input.parentId;
  const parentKind = (
    {
      turbine: "farm",
      campaign: "farm",
      blade: "turbine",
      position: "blade",
    } as Record<string, string>
  )[kind];
  if (
    kind !== "farm" &&
    !all.some((o) => o.id === parentId && o.kind === parentKind && o.active)
  )
    throw new HttpError(400, "请选择有效的上级对象");
  if (
    input.active === false &&
    all.some((o) => o.active && o.parentId === old?.id)
  )
    throw new HttpError(409, "先归档下级对象，再归档当前对象");
  const body: any = {
    kind,
    code: code.trim(),
    name: name.trim(),
    parentId,
    active: input.active !== false,
  };
  for (const k of ["location", "model", "date", "operators", "weather"])
    if (input[k] != null) {
      if (typeof input[k] !== "string" || input[k].length > 1000)
        throw new HttpError(400, "对象说明过长");
      body[k] = input[k];
    }
  for (const k of ["radiusM", "installationAngleDeg"])
    if (input[k] != null && input[k] !== "") {
      if (
        typeof input[k] !== "number" ||
        !Number.isFinite(input[k]) ||
        (k === "radiusM" && (input[k] < 0 || input[k] > 1000)) ||
        (k === "installationAngleDeg" && Math.abs(input[k]) > 360)
      )
        throw new HttpError(400, "点位距离或角度无效");
      body[k] = input[k];
    }
  if (kind === "campaign") {
    const ids = input.turbineIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 500 ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) =>
          !all.some(
            (o) =>
              o.id === id &&
              o.kind === "turbine" &&
              o.parentId === parentId &&
              o.active,
          ),
      )
    )
      throw new HttpError(400, "测量批次至少包含一台本风场风机");
    body.turbineIds = ids;
  }
  const id =
    old?.id ||
    "obj-" +
      digest(JSON.stringify([user.tenant, kind, parentId, body.code])).slice(
        0,
        48,
      );
  if (old)
    await replaceMeasurementRow(
      user,
      "measurement_objects",
      id,
      body,
      input.revision,
      "更新测量对象",
    );
  else {
    try {
      await saveMeasurementRow(user, "measurement_objects", body, id);
    } catch (error) {
      if ((error as any).code === "ER_DUP_ENTRY")
        throw new HttpError(409, "同一上级下的编号已存在");
      throw error;
    }
  }
  if (!old) await audit(user, "新增测量对象", id);
  return (await objects(user)).find((o) => o.id === id);
}
export type MeasurementSource = {
  key: string;
  reference: MeasurementReference;
  name: string;
  raw: any;
  measuredAt: number;
  tenant: string;
  context: MeasurementContext | null;
  bindingRevision: string | null;
};
export const sourceKey = (user: User, reference: MeasurementReference) =>
  `${reference.kind}:${reference.kind === "import" ? user.id + ":" : ""}${reference.id}`;
export async function measurementSources(user: User) {
  const s = recordScope(user, "tasks");
  const [tasks, captures, imports, bindings] = await Promise.all([
    rows<RecordItem>(
      "SELECT r.* FROM records r WHERE r.kind='tasks'" +
        s.sql +
        " ORDER BY updated_at DESC LIMIT 1000",
      s.args,
    ).then((rs) =>
      rs.map((r) => ({
        raw: unpack(r),
        tenant: r.tenant,
        kind: "task" as const,
        id: r.id,
      })),
    ),
    sqlCaptureRepository.list(user).then((rs) =>
      rs
        .filter((r) => r.body.uploadState === "complete")
        .map((r) => ({
          raw: r.body.recording,
          tenant: r.tenant,
          kind: "capture" as const,
          id: r.id,
        })),
    ),
    rotationWorker(user, { action: "recordings" }).then((rs) =>
      rs.recordings.map((r: any) => ({
        raw: r,
        tenant: user.tenant,
        kind: "import" as const,
        id: r.id,
      })),
    ),
    listMeasurementRows(user, "measurement_links"),
  ]);
  const importedCaptureIds = new Set(captures.map((r) => r.id));
  return [...tasks, ...captures, ...imports]
    .filter(
      (r) =>
        r.tenant === user.tenant &&
        !isHealthDemo(r.raw) &&
        !(r.kind === "import" && importedCaptureIds.has(r.raw.cloudCaptureId)),
    )
    .map((r) => {
      const reference = { kind: r.kind, id: r.id },
        key = sourceKey(user, reference),
        link = bindings.find((b) => b.key === key);
      return {
        key,
        reference,
        name: r.raw.name || "未命名记录",
        raw: r.raw,
        measuredAt: healthTime(
          r.raw.sourceSampleOrigin ??
            r.raw.sourceMetadata?.sampleOrigin ??
            r.raw.testTime ??
            r.raw.sourceStartedAt ??
            r.raw.sourceMetadata?.startedAt ??
            r.raw.startedAt,
        ),
        tenant: r.tenant,
        context: link?.context || null,
        bindingRevision: link ? digest(JSON.stringify(link)) : null,
      };
    }) as MeasurementSource[];
}
export async function bindMeasurement(user: User, input: any) {
  requireEditor(user);
  const [all, sources] = await Promise.all([
    objects(user),
    measurementSources(user),
  ]);
  const source = sources.find(
    (s) =>
      s.reference.kind === input.reference?.kind &&
      s.reference.id === input.reference?.id,
  );
  if (!source) throw new HttpError(404, "记录不存在或不属于当前课题组");
  const context = validContext(input.context, all),
    id = "link-" + digest(user.tenant + "|" + source.key).slice(0, 48),
    body = {
      name: source.name,
      key: source.key,
      reference: source.reference,
      context,
    };
  if (input.revision !== source.bindingRevision)
    throw new HttpError(409, "记录归属已变化，请刷新");
  await replaceMeasurementRow(
    user,
    "measurement_links",
    id,
    body,
    input.revision,
    "关联测量对象",
  );
  return { context };
}
/** Reconcile known labels only on an explicit user action; never rewrite raw files. */
export async function adoptSources(user: User) {
  requireEditor(user);
  let all = await objects(user);
  const sources = await measurementSources(user);
  let linked = 0,
    skipped = 0;
  async function ensure(
    kind: string,
    code: string,
    parentId: string | null,
    extra: any = {},
  ) {
    const prior = all.find(
      (o) => o.kind === kind && o.code === code && o.parentId === parentId,
    );
    if (prior) return prior;
    const result = await saveObject(user, {
      kind,
      code,
      name: code,
      parentId,
      ...extra,
    });
    all = await objects(user);
    return result!;
  }
  for (const s of sources) {
    if (s.context) continue;
    const metadata = s.raw.sourceMetadata || {};
    const pc = s.raw.pointCycle || metadata.pointCycle;
    const farmCode = s.raw.windFarm || metadata.windFarm;
    const turbineCode = s.raw.turbine || metadata.turbine;
    if (
      !farmCode ||
      !turbineCode ||
      !pc?.bladeId ||
      !pc?.radialPointId ||
      !pc?.collectionId
    ) {
      skipped++;
      continue;
    }
    const farm = await ensure("farm", farmCode, null),
      turbine = await ensure("turbine", turbineCode, farm.id),
      blade = await ensure("blade", pc.bladeId, turbine.id),
      position = await ensure(
        "position",
        canonicalPositionCode(pc.radialPointId, pc.radialPointName),
        blade.id,
        {
          name: pc.radialPointName || pc.radialPointId,
          radiusM: pc.radiusM,
        },
      );
    const campaign = await ensure("campaign", pc.collectionId, farm.id, {
      name: s.raw.originalTaskName || metadata.originalTaskName || s.name,
      turbineIds: [turbine.id],
      date: s.measuredAt
        ? new Date(s.measuredAt).toISOString().slice(0, 10)
        : "",
    });
    if (!campaign.turbineIds?.includes(turbine.id)) {
      const updated = await saveObject(user, {
        ...campaign,
        turbineIds: [...(campaign.turbineIds || []), turbine.id],
      });
      Object.assign(campaign, updated);
      all = await objects(user);
    }
    await replaceMeasurementRow(
      user,
      "measurement_links",
      "link-" + digest(user.tenant + "|" + s.key).slice(0, 48),
      {
        name: s.name,
        key: s.key,
        reference: s.reference,
        context: {
          farmId: farm.id,
          turbineId: turbine.id,
          bladeId: blade.id,
          positionId: position.id,
          campaignId: campaign.id,
        },
      },
      null,
      "迁移测量对象关联",
    );
    linked++;
  }
  return { linked, skipped };
}
export async function prepareSource(user: User, s: MeasurementSource) {
  if (s.reference.kind === "import") return s.reference.id;
  if (s.reference.kind === "capture")
    return (await createCaptureService().prepareAnalysis(user, s.reference.id))
      .recording.id;
  throw new HttpError(
    400,
    "旧任务请先导出带单位的原始波形，再在旋转测振导入；不会用摘要或演示值代替原始数据",
  );
}

/** Compare revisions under a database lock; two editors cannot silently overwrite. */
export async function replaceMeasurementRow(
  user: User,
  kind: string,
  id: string,
  body: Record<string, any>,
  revision: string | null,
  action: string,
) {
  const c = await pool().getConnection();
  try {
    await c.beginTransaction();
    const [found] = await c.execute(
      "SELECT * FROM records WHERE id=? AND kind=? AND tenant=? FOR UPDATE",
      [id, kind, user.tenant],
    );
    const prior = (found as RecordItem[])[0];
    if ((prior ? digest(JSON.stringify(unpack(prior))) : null) !== revision)
      throw new HttpError(409, "内容已变化，请刷新后重试");
    if (prior)
      await c.execute("UPDATE records SET body=? WHERE id=? AND tenant=?", [
        JSON.stringify(body),
        id,
        user.tenant,
      ]);
    else
      await c.execute(
        "INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,?,?,?,?)",
        [id, kind, user.tenant, JSON.stringify(body), user.id],
      );
    await c.execute(
      "INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)",
      [randomUUID(), user.id, user.name, user.tenant, action, id, "成功"],
    );
    await c.commit();
  } catch (error) {
    await c.rollback();
    if ((error as any).code === "ER_DUP_ENTRY")
      throw new HttpError(409, "内容已创建，请刷新后重试");
    throw error;
  } finally {
    c.release();
  }
}
