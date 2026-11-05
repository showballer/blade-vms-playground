"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button, Select, Tag } from "./common";
import { changeMeasurementFilter, measurementFilterOptions, normalizeMeasurementFilters, sameMeasurementFilters, type MeasurementFilterKind } from './measurement-filter-options';
import type {
  MeasurementContext,
  MeasurementObject,
} from "./measurement-domain";
const contextStorage = "blade.measurement-context.v2";
export function readMeasurementContext(): Partial<MeasurementContext> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(sessionStorage.getItem(contextStorage) || "{}"); } catch { return {}; }
}
export function publishMeasurementContext(value: Partial<MeasurementContext>) {
  try { sessionStorage.setItem(contextStorage, JSON.stringify(value)); } catch { /* State remains usable without storage. */ }
  window.dispatchEvent(new Event("blade-measurement-context"));
}
export function useMeasurementContext(): [Partial<MeasurementContext>, (value: Partial<MeasurementContext>) => void] {
  const [value, setValue] = useState<Partial<MeasurementContext>>({});
  useEffect(() => {
    const update = () => setValue(readMeasurementContext());
    update(); window.addEventListener("blade-measurement-context", update);
    return () => window.removeEventListener("blade-measurement-context", update);
  }, []);
  return [value, next => { setValue(next); publishMeasurementContext(next); }];
}
export function openMeasurementWorkspace(screen: "blade" | "modal" | "health" | "wind" | "report", context: Partial<MeasurementContext>) {
  publishMeasurementContext(context); window.location.hash = screen;
}
function processingSelectionKey(context:Partial<MeasurementContext>,purpose:string){return 'blade.processing-result.v2:'+JSON.stringify([purpose,context.farmId,context.campaignId,context.turbineId,context.bladeId]);}
export function rememberProcessingResult(context:Partial<MeasurementContext>,id:string,purpose='synthesis'){
 try{sessionStorage.setItem(processingSelectionKey(context,purpose),id);window.dispatchEvent(new Event('blade-processing-selection'));}catch{}
}
export function selectedProcessingResult(context:Partial<MeasurementContext>,purpose='synthesis'):string|undefined{
 if(typeof window==='undefined')return;try{return sessionStorage.getItem(processingSelectionKey(context,purpose))||undefined;}catch{return;}
}
export function selectedBladeProcessingResults(context:Partial<MeasurementContext>,objects:MeasurementObject[]){
 return Object.fromEntries(objects.filter(o=>o.kind==='blade'&&o.parentId===context.turbineId).flatMap(o=>{const id=selectedProcessingResult({...context,bladeId:o.id});return id?[[o.id,id]]:[];}));
}

export type Catalog = {
  objects: MeasurementObject[];
  memberships?: MeasurementContext[];
  sources: any[];
  results: any[];
  rules: any;
  revision: string | null;
  nextSourcesCursor?: string | null;
};
export const numberText = (v: unknown, d = 3) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—";
export const timeText = (t: any) =>
  t ? new Date(t).toLocaleString("zh-CN") : "未记录";
export function useMeasurements(refreshKey = 0) {
  const [data, setData] = useState<Catalog>({
      objects: [],
      sources: [],
      results: [],
      rules: {},
      revision: null,
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0), sourcePage = useRef<string | null>(null), paging = useRef(false), hasPaged = useRef(false), mounted = useRef(true);
  const load = useCallback(async (options?: { quiet?: boolean }) => {
    const g = ++generation.current;
    if (!options?.quiet) setLoading(true);
    setError("");
    try {
      const next = await api<Catalog>("measurements");
      if (g === generation.current) {
        if (!options?.quiet || !hasPaged.current) {
          sourcePage.current = next.nextSourcesCursor || null; hasPaged.current = false;
          setData(next);
        } else {
          // A quiet live refresh updates the head without discarding pages already loaded by the user.
          setData(current => ({ ...next, nextSourcesCursor: sourcePage.current,
            sources: [...new Map([...current.sources, ...next.sources].map(s => [s.key, s])).values()] }));
        }
      }
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }, []);
  const loadMore = useCallback(async () => {
    if (!sourcePage.current || paging.current) return;
    const g = generation.current, cursor = sourcePage.current;
    paging.current = true; setLoadingMore(true);
    try {
      const next = await api<{ sources: any[]; nextCursor: string | null }>(`measurements/sources?limit=200&cursor=${encodeURIComponent(cursor)}`);
      if (g === generation.current && sourcePage.current === cursor) {
        sourcePage.current = next.nextCursor; hasPaged.current = true;
        setData(current => ({ ...current, nextSourcesCursor: next.nextCursor,
          sources: [...new Map([...current.sources, ...next.sources].map(s => [s.key, s])).values()] }));
        setError("");
      }
    } catch (e) { if (g === generation.current) setError((e as Error).message); }
    finally { paging.current = false; if (mounted.current) setLoadingMore(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [load, refreshKey]);
  return { data, loading, error, setError, reload: load, loadMore, loadingMore, hasMoreSources: !!data.nextSourcesCursor };
}
export function MeasurementStatus({
  loading,
  error,
  onReload,
}: {
  loading: boolean;
  error: string;
  onReload: () => void;
}) {
  return (
    <>
      {loading && (
        <p role="status" className="measurement-loading">
          正在加载测量数据…
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error} <Button onClick={onReload}>重试</Button>
        </div>
      )}
    </>
  );
}
export function ObjectFilters({
  objects,
  memberships,
  loading = false,
  value,
  onChange,
  position = true,
  blade = true,
  campaign = true,
  disabled = false,
}: {
  objects: MeasurementObject[];
  memberships?: MeasurementContext[];
  loading?: boolean;
  value: Partial<MeasurementContext>;
  onChange: (v: Partial<MeasurementContext>) => void;
  position?: boolean;
  blade?: boolean;
  campaign?: boolean;
  disabled?: boolean;
}) {
  // Only reconcile when a complete catalog arrives. User changes are normalized
  // below in one update; retained hidden pages must not rewrite shared selection.
  useEffect(() => {
    if (loading || !memberships) return;
    const next = normalizeMeasurementFilters(objects, memberships, value);
    if (!sameMeasurementFilters(value, next)) onChange(next);
  }, [objects, memberships, loading]);
  const fields = [
    ...(campaign ? ["campaign"] : []),
    "farm",
    "turbine",
    ...(blade ? ["blade"] : []),
    ...(blade && position ? ["position"] : []),
  ] as const;
  const labels: Record<string, string> = {
    farm: "风场",
    turbine: "风机",
    blade: "叶片",
    position: "点位",
    campaign: "测量批次",
  };
  return (
    <div className="measurement-filters">
      {fields.map((kind) => {
        const key = (kind + "Id") as keyof MeasurementContext;
        const options = measurementFilterOptions(objects, memberships || [], value, kind as MeasurementFilterKind);
        return (
          <Select
            key={kind}
            label={labels[kind]}
            value={value[key] || ""}
            disabled={disabled || loading || (kind !== 'campaign' && options.length <= 1)}
            options={[
              { value: "", label: "全部 / 未选择" },
              ...options.map((o) => ({
                value: o.id,
                label: o.name + (o.active ? "" : "（归档）"),
              })),
            ]}
            onChange={(v) => {
              onChange(changeMeasurementFilter(objects, memberships || [], value, kind as MeasurementFilterKind, v));
            }}
          />
        );
      })}
    </div>
  );
}
export const matchesContext = (
  row: any,
  context: Partial<MeasurementContext>,
) =>
  Object.entries(context).every(
    ([key, value]) => !value || row.context?.[key] === value,
  );
export function RiskTag({ assessment }: { assessment: any }) {
  const status = assessment?.status;
  return (
    <Tag
      tone={
        status === "suspected"
          ? "red"
          : status === "review"
            ? "amber"
            : status === "within_reference"
              ? "green"
              : "gray"
      }
    >
      {assessment?.label || "未分析"}
    </Tag>
  );
}
export function PageControls({
  page,
  total,
  size = 20,
  onChange,
}: {
  page: number;
  total: number;
  size?: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="measurement-pagination">
      <span>
        共 {total} 条 · 第 {page + 1} 页
      </span>
      <Button disabled={!page} onClick={() => onChange(page - 1)}>
        上一页
      </Button>
      <Button
        disabled={(page + 1) * size >= total}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}
