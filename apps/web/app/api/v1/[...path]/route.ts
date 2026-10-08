import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  auth,
  audit,
  digest,
  HttpError,
  kinds,
  list,
  permission,
  pool,
  rows,
  run,
  scope,
  recordScope,
  tokenFrom,
  unpack,
  type RecordItem,
  type User,
} from "../../../../lib/db";
import ExcelJS from "exceljs";
import { taskMat } from "@blade/ui/data-export";
import { datasetFile, recordDataset } from "@blade/ui/result-data";
import { validateTaskMetadata } from "@blade/ui/task-metadata";
import { reportSections } from "@blade/ui/report-data";
import { reportDocx } from "../../../../lib/report-docx";
import { importLocalRevision } from "../../../../lib/sync";
import { batchEndpoint } from "../../../../lib/batches";
import { importEndpoint } from "../../../../lib/imports";
import { healthThresholdEndpoint } from "../../../../lib/health";
import { archiveHealthTrend, annotateHealthTrend } from "../../../../lib/health-trends";
import { baselineEndpoint } from "../../../../lib/baselines";
import { queryAudit } from "../../../../lib/audit-query";
import { applyAlertReview, thresholdValues } from "@blade/ui/health-data";
import { rotationCanonical, rotationCutRecord } from "@blade/ui/rotation-data";
import { modalConfig, modalRecord, modalBaselineCanonical } from "@blade/ui/modal-data";
import { signalWorkflow, signalRefs, signalInput, signalRecord, type SignalInput } from "@blade/ui/signal-input";
import { changeAccountPassword, createManagedUser, issueAccountToken, loginAccount, newAccountPassword, passwordInput, resetAccountPassword, updateManagedUser } from "../../../../lib/account";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const loginAttempts = new Map<string, { n: number; at: number }>();
const passwordAttempts = new Map<string, { n: number; at: number }>();
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
function str(v: unknown, max = 200) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new HttpError(400, "请填写有效内容");
  return v.trim();
}
async function body(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > 2_000_000)
    throw new HttpError(413, "请求内容过大");
  try {
    const text = await req.text();
    if (text.length > 2_000_000) throw new HttpError(413, "请求内容过大");
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error();
    return v as Record<string, any>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "请求必须为 JSON 对象");
  }
}
function validKind(kind: string) {
  if (!(kinds as readonly string[]).includes(kind))
    throw new HttpError(404, "未知资源");
}
function validate(kind: string, data: Record<string, any>) {
  const allowed: Record<string, string[]> = {
    tasks: [
      "name",
      "object",
      "turbine",
      "point",
      "direction",
      "rpm",
      "blades",
      "sampleRate",
      "range",
      "duration",
      "status",
      "condition",
      "note",
      "source",
      "samples",
      "channels",
      "segments",
      "testTime",
      "environment",
      "faultType",
      "raw_preserved",
    ],
    alerts: [
      "name",
      "object",
      "taskId",
      "metric",
      "value",
      "threshold",
      "level",
      "status",
      "note",
      "source",
      "reviewNote",
      "reviewer",
    ],
    baselines: [
      "name",
      "object",
      "rms",
      "frequency",
      "modal",
      "score",
      "confidence",
    ],
    models: [
      "name",
      "category",
      "version",
      "endpoint",
      "status",
      "description",
      "previousVersion",
    ],
    settings: [
      "name",
      "rms",
      "frequency",
      "band",
      "peak",
      "peakToPeak",
      "mainAmplitude",
      "warningRatio",
      "attentionRatio",
      "enabled",
      "hour",
      "lastRun",
    ],
    templates: ["name", "sections", "organization", "reportNumber", "logoData", "logoAspect"],
    reports: ["name", "taskId", "sections", "conclusion", "format", "source", "organization", "reportNumber", "logoData", "logoAspect"],
    analyses: ["name", "taskId", "type", "parameters", "result", "source"],
    backups: ["name", "snapshot", "count"],
  };
  if (!allowed[kind]) throw new HttpError(404, "未知资源");
  const out = Object.fromEntries(
    Object.entries(data).filter(([k]) => allowed[kind].includes(k)),
  );
  str(out.name);
  if (JSON.stringify(out).length > 1_800_000)
    throw new HttpError(413, "数据过大");
  if (kind === "tasks") {
    for (const key of ["object", "turbine", "point"]) str(out[key]);
    for (const key of ["rpm", "blades", "sampleRate", "duration"])
      if (
        !Number.isFinite(out[key]) ||
        out[key] < 0 ||
        (key === "blades" && (out[key] < 1 || !Number.isInteger(out[key]))) ||
        (key === "sampleRate" && out[key] < 1)
      )
        throw new HttpError(400, "采样参数必须是有效正数");
    if (
      out.samples !== undefined &&
      (!Array.isArray(out.samples) ||
        out.samples.length > 20000 ||
        out.samples.some(
          (v: unknown) => typeof v !== "number" || !Number.isFinite(v),
        ))
    )
      throw new HttpError(400, "波形数据必须是最多 20000 个有限数值的数组");
    const metadataError = validateTaskMetadata(out);
    if (metadataError) throw new HttpError(400, metadataError);
    out.raw_preserved = Array.isArray(out.samples) && out.samples.length > 0;
  }
  if (kind === "settings") {
    if ("attentionRatio" in out) {
      try { thresholdValues(out); } catch (error) { throw new HttpError(400, (error as Error).message); }
    }
    if (
      "warningRatio" in out &&
      (!Number.isFinite(out.warningRatio) ||
        out.warningRatio <= 0 ||
        out.warningRatio >= 1)
    )
      throw new HttpError(400, "预警比例必须在 0 与 1 之间");
    if (
      "hour" in out &&
      (!Number.isInteger(out.hour) || out.hour < 0 || out.hour > 23)
    )
      throw new HttpError(400, "备份小时应为 0~23");
    for (const k of ["rms", "frequency", "band"])
      if (k in out && (!Number.isFinite(out[k]) || out[k] <= 0))
        throw new HttpError(400, "阈值必须为正数");
    for (const k of ["peak", "peakToPeak", "mainAmplitude"])
      if (out[k] != null && (!Number.isFinite(out[k]) || out[k] <= 0))
        throw new HttpError(400, "扩展阈值必须为正数或留空");
  }
  if (kind === "models") {
    if (
      !["模态识别", "损伤识别", "机器学习", "信号处理"].includes(out.category)
    )
      throw new HttpError(400, "模型类别无效");
    try {
      const url = new URL(out.endpoint);
      if (!["http:", "https:"].includes(url.protocol)) throw Error();
    } catch {
      throw new HttpError(400, "服务端点必须是 HTTP(S) 地址");
    }
    out.status = ["已登记", "停用", "未接入"].includes(out.status)
      ? out.status
      : "已登记";
  }
  if (kind === "alerts" && !["待复核", "已确认", "已关闭"].includes(out.status))
    throw new HttpError(400, "告警状态无效");
  if (
    ["reports", "templates"].includes(kind) &&
    (!Array.isArray(out.sections) ||
      !out.sections.length ||
      out.sections.some(
        (s: unknown) => typeof s !== "string" || !reportSections.includes(s),
      ))
  )
    throw new HttpError(400, "请选择有效的报告章节");
  if (["reports", "templates"].includes(kind)) {
    for (const key of ["organization", "reportNumber"])
      if (key in out && (typeof out[key] !== "string" || out[key].length > 120))
        throw new HttpError(400, "报告抬头和编号不能超过 120 字");
    if (out.logoData) {
      if (typeof out.logoData !== "string" || out.logoData.length > 350000 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(out.logoData))
        throw new HttpError(400, "Logo 必须为不超过 250KB 的 PNG 或 JPEG 图片");
      const bytes = Buffer.from(out.logoData.split(",")[1], "base64");
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!(out.logoData.startsWith("data:image/png;") ? isPng : isJpeg))
        throw new HttpError(400, "Logo 文件内容与图片格式不一致");
      if (!Number.isFinite(out.logoAspect) || out.logoAspect < 0.1 || out.logoAspect > 10)
        throw new HttpError(400, "Logo 宽高比应为 1:10 至 10:1");
    }
  }
  return out;
}
async function withReportSnapshot(
  user: User,
  kind: string,
  data: Record<string, any>,
  previous?: Record<string, any>,
) {
  if (kind === "analyses") {
    const task = unpack(await record(user, "tasks", str(data.taskId, 64)));
    authorizeAnalysis(user, data);
    if (data.parameters?.workflow === signalWorkflow) {
      let refs;
      try { refs = signalRefs(data.parameters.inputs); } catch (e) { throw new HttpError(400, (e as Error).message); }
      const inputs: SignalInput[] = [], sourceTasks: RecordItem[] = [];
      for (const ref of refs) {
        const source = await record(user, ref.kind, ref.id), sourceData = unpack(source);
        const parent = ref.kind === "tasks" ? source : await record(user, "tasks", str(sourceData.taskId, 64));
        if (sourceTasks.length && parent.tenant !== sourceTasks[0].tenant) throw new HttpError(400, "请选择同一课题组的输入");
        let input;
        try { input = signalInput(ref, sourceData); } catch (e) { throw new HttpError(400, (e as Error).message); }
        if (typeof ref.revision === "string" && /^[a-f0-9]{64}$/.test(ref.revision) && ref.revision !== digest(input.canonical)) throw new HttpError(409, "所选任务或分段已变化，请刷新后重新确认信号输入");
        inputs.push(input); sourceTasks.push(parent);
      }
      try {
        const result: Record<string, any> = { ...signalRecord(data, inputs), operatorRestricted: sourceTasks.some(t => t.created_by !== sourceTasks[0].created_by) };
        if (JSON.stringify(result).length > 1_800_000) throw new HttpError(413, "结果快照过大，请缩小分段范围");
        return result;
      } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, (e as Error).message); }
    }
    if (data.type === "modal") {
      let config;
      try { config = modalConfig(data.parameters?.config); } catch (error) { throw new HttpError(400, (error as Error).message); }
      const baseline = config.baselineId === "prototype" ? undefined : unpack(await record(user, "baselines", config.baselineId));
      for (const [revision, current] of [[data.parameters?.sourceRevision, digest(rotationCanonical(task))], [data.parameters?.baselineRevision, digest(modalBaselineCanonical(baseline))]]) {
        if (typeof revision === "string" && /^[0-9a-f]{64}$/.test(revision) && revision !== current) throw new HttpError(409, "任务或正常态基准已变化，请刷新后重新确认模态配置");
      }
      try { return modalRecord(task, data, baseline); } catch (error) { throw new HttpError(400, (error as Error).message); }
    }
    if (data.type === "cut") {
      if (typeof data.parameters?.sourceRevision === "string" && /^[0-9a-f]{64}$/.test(data.parameters.sourceRevision) && data.parameters.sourceRevision !== digest(rotationCanonical(task))) throw new HttpError(409, "源任务已变化，请刷新并重新生成分段");
      let result;
      try { result = rotationCutRecord(task, data); } catch (error) { throw new HttpError(400, (error as Error).message); }
      return result;
    }
  }
  if (kind === "alerts" && data.taskId) await record(user, "tasks", str(data.taskId, 64));
  if (kind !== "reports") return data;
  if (previous?.taskSnapshot) {
    if (data.taskId !== previous.taskId) throw new HttpError(400, "已保存报告不能更换源任务，请新建报告");
    return { ...data, taskSnapshot: previous.taskSnapshot, analysisSnapshots: previous.analysisSnapshots || [],
      operatorRestricted: previous.operatorRestricted === true, generatedAt: previous.generatedAt,
      author: previous.author, editedAt: new Date().toISOString() };
  }
  const task = unpack(await record(user, "tasks", str(data.taskId, 64)));
  const analyses = (await list(user, "analyses")).filter(
    (a) => a.taskId === data.taskId,
  );
  return {
    ...data,
    taskSnapshot: task,
    analysisSnapshots: analyses,
    operatorRestricted: analyses.some(a => a.operatorRestricted === true),
    generatedAt: new Date().toISOString(),
    author: user.name,
  };
}
async function record(user: User, kind: string, id: string) {
  const s = recordScope(user, kind);
  const [item] = await rows<RecordItem>(
    "SELECT r.* FROM records r WHERE r.kind=? AND r.id=?" + s.sql,
    [kind, id, ...s.args],
  );
  if (!item) throw new HttpError(404, "记录不存在");
  return item;
}
const basicAnalysisTypes = ["time", "fft", "tf", "filter", "env", "band", "avg", "feat", "order", "cut"];
function authorizeAnalysis(user: User, data: Record<string, any>) {
  if (![...basicAnalysisTypes, "modal", "damage"].includes(data.type)) throw new HttpError(400, "分析类型无效");
  if (user.role === "operator" && !basicAnalysisTypes.includes(data.type)) throw new HttpError(403, "操作员仅可保存本人任务的基础分析");
}
async function handle(req: Request, ctx: Context) {
  try {
    const path = (await ctx.params).path;
    const [resource, kind, id] = path;
    const method = req.method;
    if (resource === "session" && (path.length !== 1 || !["GET", "POST", "DELETE"].includes(method)))
      throw new HttpError(405, "会话操作路径或方法无效");
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.get("origin");
      const expected = process.env.APP_ORIGIN || "http://127.0.0.1:3210";
      if (
        origin &&
        origin !== expected &&
        origin !== new URL(req.url).origin &&
        origin !== "http://127.0.0.1:5210"
      )
        throw new HttpError(403, "不允许的请求来源");
    }
    if (resource === "health" && path.length === 1 && method === "GET")
      return json({
        ok: true,
        system: "BladeVMS",
        database: (await rows("SELECT 1 AS ok"))[0],
        integrations: "not-connected",
      });
    if (resource === "session" && method === "POST") {
      const b = await body(req);
      const username = str(b.username, 80),
        password = passwordInput(b.password);
      const key = username;
      const savedAttempt = loginAttempts.get(key);
      const attempt = savedAttempt && Date.now() - savedAttempt.at < 60000 ? savedAttempt : undefined;
      if (loginAttempts.size > 1000) for (const [name, value] of loginAttempts) if (Date.now() - value.at >= 60000) loginAttempts.delete(name);
      if (attempt && Date.now() - attempt.at < 60000 && attempt.n >= 10)
        throw new HttpError(429, "尝试过于频繁，请一分钟后重试");
      let session;
      try { session = await loginAccount(username, password); }
      catch (error) {
        if (error instanceof HttpError && error.status === 401)
          loginAttempts.set(key, { n: (attempt?.n || 0) + 1, at: Date.now() });
        throw error;
      }
      loginAttempts.delete(key);
      const { token } = session;
      const res = json(session);
      res.cookies.set("blade_session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: new URL(req.url).protocol === "https:",
        maxAge: 43200,
        path: "/",
      });
      return res;
    }
    const user = await auth(req);
    if (resource === "account") {
      if (path.length !== 2 || kind !== "password" || method !== "POST") throw new HttpError(405, "账号操作路径或方法无效");
      const b = await body(req);
      if (Object.keys(b).some(key => !["currentPassword", "newPassword"].includes(key))) throw new HttpError(400, "本人改密只接受当前密码和新密码");
      const attempt = passwordAttempts.get(user.id);
      if (attempt && Date.now() - attempt.at < 60_000 && attempt.n >= 5) throw new HttpError(429, "改密尝试过于频繁，请一分钟后重试");
      try {
        const result = await changeAccountPassword(user, tokenFrom(req), b.currentPassword, b.newPassword);
        passwordAttempts.delete(user.id);
        const response = json(result); response.cookies.delete("blade_session"); return response;
      } catch (error) {
        if (error instanceof HttpError && error.message === "当前密码不正确") {
          if (passwordAttempts.size > 1000) for (const [key, entry] of passwordAttempts) if (Date.now() - entry.at >= 60_000) passwordAttempts.delete(key);
          passwordAttempts.set(user.id, { n: attempt && Date.now() - attempt.at < 60_000 ? attempt.n + 1 : 1, at: Date.now() });
        }
        throw error;
      }
    }
    if (resource === "health") {
      if (kind === "trends" && method === "POST") {
        if (path.length === 2) { const result = await archiveHealthTrend(user, await body(req)); return json(result.record, result.created ? 201 : 200); }
        if (path.length === 4 && path[3] === "annotations") return json(await annotateHealthTrend(user, id, await body(req)));
        if (path.length === 6 && path[3] === "annotations" && path[5] === "withdraw") return json(await annotateHealthTrend(user, id, await body(req), path[4]));
      }
      if (kind !== "thresholds" || path.length !== 2) throw new HttpError(405, "健康监测操作路径无效");
      return json(await healthThresholdEndpoint(user, method, new URL(req.url).searchParams.get("baselineId"), method === "PUT" ? await body(req) : undefined));
    }
    if (resource === "imports") {
      if (path.length > 3) throw new HttpError(405, "导入操作路径无效");
      const result = await importEndpoint(user, method, kind, id, method === "POST" ? await body(req) : undefined);
      return json(result.data, result.status);
    }
    if (resource === "batches") {
      if (path.length > 3) throw new HttpError(405, "批次操作路径无效");
      const result = await batchEndpoint(user, method, kind, id, method === "POST" ? await body(req) : undefined);
      return json(result.data, result.status);
    }
    if (resource === "sync" && kind === "tasks" && method === "POST" && path.length === 2) {
      permission(user, "tasks", true);
      const b = await body(req);
      if (!b.task || typeof b.task !== "object" || Array.isArray(b.task) || !Array.isArray(b.analyses) || b.analyses.length > 50)
        throw new HttpError(400, "回传需包含一份任务及最多 50 份关联分析");
      const task = validate("tasks", b.task);
      const analyses = b.analyses.map((item: Record<string, any>) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpError(400, "分析记录格式无效");
        if (item.taskId !== b.localId) throw new HttpError(400, "回传分析必须属于当前本机任务");
        permission(user, "analyses", true);
        const analysis = validate("analyses", item); authorizeAnalysis(user, analysis); return analysis;
      });
      const result = await importLocalRevision(user, { clientId: b.clientId, localId: b.localId, revision: b.revision, task, analyses });
      return json(result, result.created ? 201 : 200);
    }
    if (resource === "session") {
      if (method === "GET") return json({ user });
      if (method === "DELETE") {
        await run("DELETE FROM sessions WHERE token_hash=?", [
          digest(tokenFrom(req)),
        ]);
        const res = json({ ok: true });
        res.cookies.delete("blade_session");
        return res;
      }
    }
    if (resource === "bootstrap" && method === "GET") {
      const data: Record<string, unknown> = { user };
      for (const k of kinds) {
        if (k === "backups") continue;
        try { permission(user, k); } catch (e) {
          if (!(e instanceof HttpError) || e.status !== 403) throw e;
          data[k] = []; continue;
        }
        data[k] = await list(user, k);
      }
      return json(data);
    }
    if (resource === "records") {
      if (path.length > 3 || (method === "POST" && id) || (["PUT", "DELETE"].includes(method) && !id)) throw new HttpError(405, "记录操作路径无效");
      validKind(kind);
      permission(user, kind, method !== "GET");
      if (method === "GET")
        return json(
          id ? unpack(await record(user, kind, id)) : await list(user, kind),
        );
      if (kind === "backups") throw new HttpError(405, "请使用备份接口");
      if (kind === "baselines") { const result = await baselineEndpoint(user, method, id, await body(req)); return json(result.data, result.status); }
      if (kind === "batches") throw new HttpError(405, "请使用批处理接口，不能直接改写批次状态");
      if (kind === "imports") throw new HttpError(405, "请使用导入接口，不能直接改写导入状态");
      if (method === "POST") {
        let b = await withReportSnapshot(
            user,
            kind,
            validate(kind, await body(req)),
          );
        const key = randomUUID();
        if (kind === "alerts") {
          try { b = applyAlertReview(null, b, user, new Date().toISOString()); } catch (error) { throw new HttpError(400, (error as Error).message); }
        }
        await run(
          "INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,?,?,?,?)",
          [key, kind, user.tenant, JSON.stringify(b), user.id],
        );
        await audit(user, "新增 " + kind, b.name);
        return json({ ...b, id: key }, 201);
      }
      if (kind === "alerts" && method === "PUT") {
        const patch = await body(req), s = recordScope(user, kind);
        const connection = await pool().getConnection();
        try {
          await connection.beginTransaction();
          const [selected] = await connection.execute("SELECT r.* FROM records r WHERE r.kind='alerts' AND r.id=?" + s.sql + " FOR UPDATE", [id, ...s.args] as string[]);
          const old = (selected as RecordItem[])[0];
          if (!old) throw new HttpError(404, "记录不存在");
          const previous = unpack(old);
          let value = validate(kind, { ...previous, ...patch });
          if (value.taskId && (await record(user, "tasks", str(value.taskId, 64))).tenant !== old.tenant) throw new HttpError(400, "预警与任务必须属于同一组");
          try { value = applyAlertReview(previous, value, user, new Date().toISOString()); }
          catch (error) { throw new HttpError(400, (error as Error).message); }
          await connection.execute("UPDATE records SET body=? WHERE id=?", [JSON.stringify(value), id]);
          await connection.execute("INSERT INTO audit_logs(id,actor_id,actor_name,tenant,action,target,result) VALUES(?,?,?,?,?,?,?)", [randomUUID(), user.id, user.name, old.tenant, "更新 / 复核 alerts", id, "成功"]);
          await connection.commit();
          return json({ ...value, id });
        } catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      }
      const old = await record(user, kind, id);
      if (method === "PUT" && kind === "analyses" && unpack(old).parameters?.workflow === signalWorkflow) throw new HttpError(405, "信号结果快照不可改写，请重新保存新的分析记录");
      if (kind === "analyses" && old.body.type === "health-trend") throw new HttpError(405, "健康趋势快照不可改写或删除，请使用人工标记与撤回接口");
      if (user.role === "operator" && kind === "analyses" && old.created_by !== user.id) throw new HttpError(403, "只能修改本人保存的基础分析");
      if (user.role === "operator" && kind === "analyses") authorizeAnalysis(user, unpack(old));
      if (method === "PUT") {
        const b = await withReportSnapshot(
          user,
          kind,
          validate(kind, { ...unpack(old), ...(await body(req)) }),
          unpack(old),
        );
        const origin = unpack(old).syncOrigin;
        if (origin) b.syncOrigin = origin;
        const importOrigin = unpack(old).importOrigin;
        if (importOrigin) b.importOrigin = importOrigin;
        await run("UPDATE records SET body=? WHERE id=?", [
          JSON.stringify(b),
          id,
        ]);
        await audit(user, "更新 " + kind, b.name);
        return json({ ...b, id });
      }
      if (method === "DELETE") {
        await run("DELETE FROM records WHERE id=?", [id]);
        await audit(user, "删除 " + kind, String(unpack(old).name));
        return json({ ok: true });
      }
    }
    if (resource === "users") {
      permission(user, "users", true);
      if (method === "POST" && path.length === 3 && id === "password") {
        const b = await body(req);
        if (Object.keys(b).some(key => key !== "newPassword")) throw new HttpError(400, "重置密码只接受新密码");
        const result = await resetAccountPassword(user, tokenFrom(req), kind, b.newPassword);
        const response = json(result); if (result.reauthenticate) response.cookies.delete("blade_session"); return response;
      }
      if (!((method === "GET" || method === "POST") && path.length === 1) && !(method === "PUT" && path.length === 2))
        throw new HttpError(405, "用户操作路径或方法无效");
      if (method === "GET")
        return json(
          await rows(
            "SELECT id,username,name,role,tenant,active,created_at FROM users ORDER BY created_at",
          ),
        );
      const b = await body(req);
      const role = b.role;
      if (!["admin", "analyst", "operator", "viewer"].includes(role))
        throw new HttpError(400, "角色无效");
      if (method === "POST") {
        if (b.active !== undefined && typeof b.active !== "boolean")
          throw new HttpError(400, "启用状态必须为布尔值");
        return json(await createManagedUser(user, tokenFrom(req), {
          username: str(b.username, 80), name: str(b.name, 100), role,
          tenant: str(b.tenant, 100), active: b.active !== false,
          password: newAccountPassword(b.password),
        }), 201);
      }
      if (method === "PUT") {
        const uid = kind;
        if (typeof b.active !== "boolean")
          throw new HttpError(400, "启用状态必须为布尔值");
        const name = str(b.name, 100),
          tenant = str(b.tenant, 100);
        const password = b.password === undefined || b.password === "" ? undefined : newAccountPassword(b.password);
        const result = await updateManagedUser(user, tokenFrom(req), uid, { name, role, tenant, active: b.active, password });
        const response = json(result); if (result.reauthenticate) response.cookies.delete("blade_session"); return response;
      }
    }
    if (resource === "logs") {
      permission(user, "logs");
      if (method !== "GET" || path.length !== 1) throw new HttpError(405, "日志仅支持列表查询");
      const params = new URL(req.url).searchParams;
      if (params.has("paginated") && (params.getAll("paginated").length !== 1 || params.get("paginated") !== "1")) throw new HttpError(400, "paginated 须为 1");
      return json(await queryAudit(user, params, params.has("paginated") ? "page" : "legacy"));
    }
    if (resource === "tokens") {
      permission(user, "tokens", true);
      if (!((method === "GET" || method === "POST") && path.length === 1) && !(method === "DELETE" && path.length === 2))
        throw new HttpError(405, "令牌操作路径或方法无效");
      if (method === "GET")
        return json(
          await rows(
            "SELECT id,name,created_at,expires_at FROM sessions WHERE kind='api' AND user_id=?",
            [user.id],
          ),
        );
      if (method === "POST") {
        const b = await body(req);
        return json(await issueAccountToken(user, tokenFrom(req), str(b.name, 100)), 201);
      }
      if (method === "DELETE") {
        await run(
          "DELETE FROM sessions WHERE id=? AND kind='api' AND user_id=?",
          [kind, user.id],
        );
        await audit(user, "撤销 API 令牌", kind);
        return json({ ok: true });
      }
    }
    if (resource === "backups") {
      permission(user, "backups", true);
      if (method === "GET")
        return json(
          (await list(user, "backups")).map(({ snapshot, ...r }) => r),
        );
      if (method === "POST" && !kind) {
        const items = await rows<RecordItem>(
          "SELECT * FROM records WHERE kind<>'backups' AND tenant=?",
          [user.tenant],
        );
        const key = randomUUID(),
          data = {
            name: "业务备份 " + new Date().toISOString(),
            snapshot: items,
            count: items.length,
          };
        await run(
          "INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,'backups',?,?,?)",
          [key, user.tenant, JSON.stringify(data), user.id],
        );
        await audit(user, "创建业务备份", key);
        return json({ id: key, name: data.name, count: data.count }, 201);
      }
      if (method === "POST" && kind === "restore") {
        const b = await body(req);
        if (b.confirm !== "恢复业务数据")
          throw new HttpError(400, "恢复确认文字不正确");
        const item = await record(user, "backups", str(b.id, 64));
        const snapshot = unpack(item).snapshot as RecordItem[];
        if (
          !Array.isArray(snapshot) ||
          snapshot.some(
            (r) =>
              r.tenant !== item.tenant ||
              r.kind === "backups" ||
              !(kinds as readonly string[]).includes(r.kind),
          )
        )
          throw new HttpError(400, "备份结构不正确");
        const c = await pool().getConnection();
        try {
          await c.beginTransaction();
          await c.execute(
            "DELETE FROM records WHERE tenant=? AND kind<>'backups'",
            [item.tenant],
          );
          for (const r of snapshot)
            await c.execute(
              "INSERT INTO records(id,kind,tenant,body,created_by) VALUES(?,?,?,?,?)",
              [
                r.id,
                r.kind,
                r.tenant,
                JSON.stringify(r.body),
                r.created_by || null,
              ],
            );
          await c.commit();
        } catch (e) {
          await c.rollback();
          throw e;
        } finally {
          c.release();
        }
        await audit(user, "恢复业务备份", item.id);
        return json({ ok: true, count: snapshot.length });
      }
    }
    if (resource === "export" && method === "GET") {
      permission(user, kind);
      const url = new URL(req.url);
      const fmt = url.searchParams.get("format") || "json";
      const valueView = url.searchParams.get("view") === "data";
      if (valueView && (!id || !["tasks", "analyses"].includes(kind) || fmt === "docx"))
        throw new HttpError(400, "数值导出须选择单个任务或分析，格式为 CSV/TXT/XLSX/MAT/JSON");
      if (!["csv", "txt", "json", "xlsx", "docx", "mat"].includes(fmt))
        throw new HttpError(400, "不支持的导出格式");
      if (fmt === "docx" && (kind !== "reports" || !id))
        throw new HttpError(400, "请选择一份报告导出 Word");
      if (fmt === "mat" && kind !== "tasks" && !valueView)
        throw new HttpError(400, "MAT 仅用于导出任务波形");
      let data: Record<string, any>[];
      if (kind === "logs") {
        if (path.length !== 2) throw new HttpError(405, "日志导出仅支持查询结果");
        const records = await queryAudit(user, url.searchParams, "export") as Record<string, any>[];
        data = records.map(({ actor, time, action, target, result }) => ({ actor_name: actor, action, target, result, created_at: time }));
      }
      else {
        validKind(kind);
        data = id
          ? [unpack(await record(user, kind, id))]
          : await list(user, kind);
      }
      if (!valueView) await audit(user, "导出 " + kind, fmt);
      const filename = `BladeVMS-${kind}-${new Date().toISOString().slice(0, 10)}`;
      const headers = (ext: string, type: string) => ({
        "Content-Type": type,
        "Content-Disposition": `attachment; filename="${filename}.${ext}"`,
        "Cache-Control": "no-store",
      });
      if (valueView) {
        try {
          const file = await datasetFile(recordDataset(kind, data[0], url.searchParams.get("dataset")), fmt);
          await audit(user, "导出数值 " + kind, `${id} / ${fmt} / ${url.searchParams.get("dataset") || "default"}`);
          return new Response(file.bytes, { headers: headers(file.extension, file.mime) });
        } catch (e) { throw new HttpError(400, (e as Error).message); }
      }
      if (fmt === "mat") {
        try {
          return new Response(taskMat(data), {
            headers: headers("mat", "application/octet-stream"),
          });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (fmt === "docx") {
        const r = data[0] || {};
        const task = r.taskSnapshot || unpack(await record(user, "tasks", r.taskId));
        const bytes = await reportDocx(r, task, r.analysisSnapshots || (await list(user, "analyses")), user.name);
        return new Response(new Uint8Array(bytes), { headers: headers("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document") });
      }
      if (fmt === "xlsx") {
        const wb = new ExcelJS.Workbook(),
          sheet = wb.addWorksheet("数据");
        const keys = [...new Set(data.flatMap(Object.keys))].filter(
          (k) => k !== "snapshot",
        );
        sheet.addRow(keys);
        for (const r of data)
          sheet.addRow(
            keys.map((k) =>
              typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k],
            ),
          );
        sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        sheet.getRow(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF2D6CC0" },
        };
        sheet.columns.forEach((c) => (c.width = 22));
        return new Response(new Uint8Array(await wb.xlsx.writeBuffer()), {
          headers: headers(
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ),
        });
      }
      if (["csv", "txt"].includes(fmt)) {
        const keys = [...new Set(data.flatMap(Object.keys))].filter(
          (k) => k !== "snapshot",
        );
        const esc = (v: unknown) => {
          let t = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
          if (/^[=+@\-]/.test(t)) t = "'" + t;
          return '"' + t.replaceAll('"', '""') + '"';
        };
        const text =
          "\uFEFF" +
          [keys, ...data.map((r) => keys.map((k) => r[k]))]
            .map((row) => row.map(esc).join(fmt === "txt" ? "\t" : ","))
            .join("\r\n");
        return new Response(text, {
          headers: headers(fmt, "text/plain; charset=utf-8"),
        });
      }
      return new Response(JSON.stringify(data, null, 2), {
        headers: headers("json", "application/json; charset=utf-8"),
      });
    }
    throw new HttpError(404, "接口不存在");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if ((e as { code?: string }).code === "ER_DUP_ENTRY")
      return json({ error: "名称或账号已经存在" }, 409);
    console.error("Blade API error", e);
    return json({ error: "服务暂不可用，请稍后重试" }, 500);
  }
}
export const GET = handle,
  POST = handle,
  PUT = handle,
  DELETE = handle;
