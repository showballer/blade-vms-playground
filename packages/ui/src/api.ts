import { taskMat } from "./data-export";
import { datasetFile, recordDataset } from "./result-data";
export type Item = { id: string; name: string; [key: string]: any };
export type User = {
  id: string;
  username: string;
  name: string;
  role: "admin" | "analyst" | "operator" | "viewer";
  tenant: string;
};
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "ApiError"; }
}
export type Bootstrap = {
  user: User;
  tasks: Item[];
  alerts: Item[];
  baselines: Item[];
  models: Item[];
  settings: Item[];
  templates: Item[];
  reports: Item[];
  analyses: Item[];
};
export type LocalSyncTask = {
  id: string; name: string; object: string; revision: string;
  analysisCount: number; sampleCount: number; updatedAt: string | null;
  receipt: { taskId: string; importedAt: string } | null;
};
export type LocalSyncStatus = {
  server: string; user: User | null; connectionError: string | null;
  tasks: LocalSyncTask[];
};
declare global {
  interface Window {
    blade?: {
      request: (options: {
        path: string;
        method: string;
        body?: unknown;
      }) => Promise<{ status: number; data: any }>;
      download: (
        path: string,
      ) => Promise<{ canceled?: boolean; path?: string }>;
      saveData?: (options: { format: string; bytes: Uint8Array }) => Promise<{ canceled?: boolean; path?: string }>;
      settings: (url?: string) => Promise<string>;
      offline: (options: {
        path: string;
        method: string;
        body?: unknown;
      }) => Promise<{ status: number; data: any }>;
      sync: (options: { action: "status" } | {
        action: "upload"; taskId: string; revision: string;
        server: string; userId: string; tenant: string;
      }) => Promise<{ status: number; data: any }>;
      windowControl: (action: "minimize" | "maximize" | "close") => void;
      version: string;
    };
  }
}
let offline = false;
export function setOffline(v: boolean) {
  offline = v;
}
export function isOffline() {
  return offline;
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (typeof window !== "undefined" && window.blade) {
    const res = await (offline ? window.blade.offline : window.blade.request)({
      path,
      method,
      body,
    });
    if (res.status >= 400) throw new ApiError(res.data.error || "请求失败", res.status);
    return res.data;
  }
  const res = await fetch("/api/v1/" + path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "请求失败", res.status);
  return data;
}
export async function download(path: string): Promise<boolean> {
  if (window.blade && !offline) {
    const result = await window.blade.download(path);
    return !result.canceled;
  }
  if (window.blade && offline) {
    const [route, query] = path.split("?");
    const [, kind, id] = route.split("/");
    const result = await api("records/" + kind + (id ? "/" + id : ""));
    const data = Array.isArray(result) ? result : [result];
    const format = new URLSearchParams(query).get("format") || "json";
    if (new URLSearchParams(query).get("view") === "data") {
      if (!id) throw Error("请选择单个任务或分析记录导出数值结果");
      const file = await datasetFile(recordDataset(kind, data[0], new URLSearchParams(query).get("dataset")), format);
      return saveDataFile(file, `BladeVMS-offline-${kind}`);
    }
    if (format === "mat" && kind === "tasks") {
      return saveDataFile({ bytes: taskMat(data), mime: "application/octet-stream", extension: "mat" }, "BladeVMS-offline");
    }
    if (!["csv", "txt", "json"].includes(format))
      throw Error("离线工作区支持 CSV、TXT 和 JSON 导出");
    const keys = [...new Set(data.flatMap(Object.keys))];
    const esc = (v: unknown) => {
      let s = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
      if (/^[=+@\-]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    const content =
      format === "json"
        ? JSON.stringify(data, null, 2)
        : "\uFEFF" +
          [keys, ...data.map((r) => keys.map((k) => r[k]))]
            .map((r) => r.map(esc).join(format === "txt" ? "\t" : ","))
            .join("\r\n");
    return saveDataFile({ bytes: new TextEncoder().encode(content), mime: "text/plain;charset=utf-8", extension: format }, "BladeVMS-offline");
  }
  const res = await fetch("/api/v1/" + path, { credentials: "same-origin" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "导出失败");
  }
  const blob = await res.blob();
  const name =
    res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ||
    "BladeVMS-export";
  saveBlob(blob, name);
  return true;
}
export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export async function saveDataFile(file: { bytes: Uint8Array<ArrayBuffer>; mime: string; extension: string }, name = "BladeVMS-result") {
  if (window.blade) {
    if (!window.blade.saveData) throw Error("当前桌面版本缺少原生结果保存能力，请更新客户端");
    const result = await window.blade.saveData({ format: file.extension, bytes: file.bytes });
    return !result.canceled;
  }
  saveBlob(new Blob([file.bytes], { type: file.mime }), `${name}.${file.extension}`);
  return true;
}
export const roleNames = {
  admin: "管理员",
  analyst: "分析员",
  operator: "操作员",
  viewer: "访客",
};
