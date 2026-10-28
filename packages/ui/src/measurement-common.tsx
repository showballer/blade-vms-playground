"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button, Select, Tag } from "./common";
import type {
  MeasurementContext,
  MeasurementObject,
} from "./measurement-domain";
export type Catalog = {
  objects: MeasurementObject[];
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
  value,
  onChange,
  position = true,
  blade = true,
  campaign = true,
  disabled = false,
}: {
  objects: MeasurementObject[];
  value: Partial<MeasurementContext>;
  onChange: (v: Partial<MeasurementContext>) => void;
  position?: boolean;
  blade?: boolean;
  campaign?: boolean;
  disabled?: boolean;
}) {
  const fields = [
    "farm",
    "turbine",
    ...(blade ? ["blade"] : []),
    ...(blade && position ? ["position"] : []),
    ...(campaign ? ["campaign"] : []),
  ] as const;
  const labels: Record<string, string> = {
    farm: "风场",
    turbine: "风机",
    blade: "叶片",
    position: "点位",
    campaign: "测量任务 / 批次",
  };
  return (
    <div className="measurement-filters">
      {fields.map((kind) => {
        const key = (kind + "Id") as keyof MeasurementContext,
          parent =
            kind === "turbine" || kind === "campaign"
              ? value.farmId
              : kind === "blade"
                ? value.turbineId
                : kind === "position"
                  ? value.bladeId
                  : undefined;
        const options = objects.filter(
          (o) =>
            o.kind === kind &&
            (kind === "farm" || (!!parent && o.parentId === parent)) &&
            (kind !== "campaign" || !value.turbineId || !o.turbineIds?.length || o.turbineIds.includes(value.turbineId)),
        );
        return (
          <Select
            key={kind}
            label={labels[kind]}
            value={value[key] || ""}
            disabled={disabled}
            options={[
              { value: "", label: "全部 / 未选择" },
              ...options.map((o) => ({
                value: o.id,
                label: o.name + (o.active ? "" : "（归档）"),
              })),
            ]}
            onChange={(v) => {
              const next = { ...value, [key]: v };
              if (kind === "farm") {
                next.turbineId = "";
                next.bladeId = "";
                next.positionId = "";
                next.campaignId = "";
              }
              if (kind === "turbine") {
                const currentCampaign = objects.find(o => o.id === next.campaignId);
                if (currentCampaign?.turbineIds?.length && !currentCampaign.turbineIds.includes(v)) next.campaignId = "";
                next.bladeId = "";
                next.positionId = "";
              }
              if (kind === "blade") next.positionId = "";
              onChange(next);
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
