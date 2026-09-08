import { HttpError, permission, rows, scope, type User } from "./db";

/** Date bounds use the database's displayed calendar time, not browser UTC conversion. */
export function auditFilter(params: URLSearchParams) {
  const clauses: string[] = [], args: unknown[] = [];
  const value = (key: string, max = 200) => {
    if (params.getAll(key).length > 1) throw new HttpError(400, `重复查询参数：${key}`);
    const text = (params.get(key) || "").trim();
    if (text.length > max) throw new HttpError(400, `查询参数过长：${key}`);
    return text;
  };
  // LOCATE treats %, _ and backslashes as literal text rather than SQL wildcards.
  for (const [key, column] of [["actor", "actor_name"], ["target", "target"]]) {
    const text = value(key);
    if (text) { clauses.push(`LOCATE(?,${column})>0`); args.push(text); }
  }
  for (const key of ["action", "result"]) {
    const text = value(key);
    if (text) { clauses.push(`${key}=?`); args.push(text); }
  }
  const dates = ["from", "to"].map(key => {
    const date = value(key, 10);
    const parsed = new Date(date + "T00:00:00Z");
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1000-01-01" || date > "9999-12-30" || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date))
      throw new HttpError(400, "日志日期必须为有效的 YYYY-MM-DD");
    return date;
  });
  if (dates[0] && dates[1] && dates[0] > dates[1]) throw new HttpError(400, "开始日期不能晚于结束日期");
  if (dates[0]) { clauses.push("created_at>=?"); args.push(dates[0]); }
  if (dates[1]) { clauses.push("created_at<DATE_ADD(?,INTERVAL 1 DAY)"); args.push(dates[1]); }
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", args };
}

function integer(params: URLSearchParams, key: string, fallback: number, max: number) {
  const text = params.get(key);
  if (text === null) return fallback;
  if (params.getAll(key).length > 1 || !/^[1-9]\d*$/.test(text) || Number(text) > max)
    throw new HttpError(400, `无效分页参数：${key}`);
  return Number(text);
}

export async function queryAudit(user: User, params: URLSearchParams, mode: "legacy" | "page" | "export") {
  permission(user, "logs");
  const access = scope(user), filter = auditFilter(params);
  const where = " FROM audit_logs WHERE 1=1" + access.sql + filter.sql;
  const args = [...access.args, ...filter.args];
  const page = integer(params, "page", 1, 1000000), pageSize = integer(params, "pageSize", 25, 100);
  const [count] = await rows<{ total: number }>("SELECT COUNT(*) AS total" + where, args);
  const total = Number(count.total);
  if (mode === "export" && total > 10000) throw new HttpError(413, "日志超过 10000 条，请缩小筛选范围后导出");
  const limit = mode === "page" ? pageSize : mode === "legacy" ? 500 : 10001;
  const offset = mode === "page" ? (page - 1) * pageSize : 0;
  // Only validated integers are interpolated; all filter text remains bound parameters.
  const items = await rows<Record<string, any>>("SELECT id,actor_name AS actor,action,target,result,created_at AS time" + where + ` ORDER BY created_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`, args);
  if (mode === "export" && items.length > 10000) throw new HttpError(413, "日志超过 10000 条，请缩小筛选范围后导出");
  if (mode !== "page") return items;
  const actions = await rows<{ action: string }>("SELECT DISTINCT action FROM audit_logs WHERE 1=1" + access.sql + " ORDER BY action", access.args);
  const results = await rows<{ result: string }>("SELECT DISTINCT result FROM audit_logs WHERE 1=1" + access.sql + " ORDER BY result", access.args);
  return { items, total, page, pageSize, actions: actions.map(row => row.action), results: results.map(row => row.result) };
}
