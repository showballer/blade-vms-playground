"use client";
import React, { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { Button, Card, Select } from "./common";
import { Chart } from "./charts";
import { ChartLoading } from "./chart-loading";
import { FieldWaveChart } from "./field-waveform";
import { captureLiveLabel, captureUploadLabel, type CaptureDetail, type MeasurementCapture, type MeasurementLivePage } from "./capture-types";
import { contextNames, isDiagnosticMeasurement, type MeasurementContext, type MeasurementObject } from "./measurement-domain";
import { captureMatchesContext, captureTaskKey, latestCapturePoints, mergeCapturePages, validPassPreview } from "./measurement-live-data";
import { timeText } from "./measurement-common";

export function MeasurementLive({ context, objects, onCatalogChange }: {
  context: Partial<MeasurementContext>;
  objects: MeasurementObject[];
  onCatalogChange?: () => void;
}) {
  const [captures, setCaptures] = useState<MeasurementCapture[]>([]),
    [liveObjects, setLiveObjects] = useState<MeasurementObject[]>([]),
    [frames, setFrames] = useState<Record<string, CaptureDetail>>({}),
    [frameErrors, setFrameErrors] = useState<Record<string, string>>({}),
    [frameWaiting, setFrameWaiting] = useState<Record<string, boolean>>({}),
    [task, setTask] = useState(""),
    [raw, setRaw] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [loadingMore, setLoadingMore] = useState(false);
  const hasPaged = useRef(false), alive = useRef(true), archiveCache = useRef(new Map<string, CaptureDetail>()),
    signature = useRef(""), onChange = useRef(onCatalogChange);
  onChange.current = onCatalogChange;
  const allObjects = [...new Map([...objects, ...liveObjects].map(o => [o.id, o])).values()];
  const filtered = captures.filter(c => captureMatchesContext(c, context, allObjects));
  const tasks = [...new Map(filtered.map(c => [captureTaskKey(c), c])).values()];
  const chosen = tasks.some(c => captureTaskKey(c) === task) ? task : tasks[0] ? captureTaskKey(tasks[0]) : "";
  const points = latestCapturePoints(filtered.filter(c => captureTaskKey(c) === chosen));
  // Upload completion must change the request even if the capture ID stays the same.
  const requestKey = points.map(c => `${c.id}:${c.uploadState}`).join("|");
  const selectedPoints = useRef(points);
  selectedPoints.current = points;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let dead = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const page = await api<MeasurementLivePage>("measurements/live?limit=200");
        if (!dead) {
          setCaptures(current => mergeCapturePages(current, page.captures));
          setLiveObjects(page.objects);
          if (!hasPaged.current) setNextCursor(page.nextCursor);
          setError("");
          // Refresh the parent task tree only for new sources, changed bindings or completion.
          const next = JSON.stringify([page.objects, page.captures.map(c => [c.id, c.context, c.uploadState])]);
          if (signature.current !== next) { signature.current = next; onChange.current?.(); }
        }
      } catch (e) { if (!dead) setError((e as Error).message); }
      finally {
        if (!dead) { setLoading(false); timer = setTimeout(poll, document.hidden ? 5000 : 2000); }
      }
    }
    void poll();
    return () => { dead = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    let dead = false, timer: ReturnType<typeof setTimeout>;
    const ids = new Set(selectedPoints.current.map(c => c.id));
    const retain = <T,>(current: Record<string, T>) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
    setFrames(retain); setFrameErrors(retain); setFrameWaiting(retain);
    if (!requestKey) return;
    async function readPoint(c: MeasurementCapture) {
        const archive = c.uploadState === "complete";
        const cached = archive && archiveCache.current.get(c.id);
        if (cached) { setFrames(current => current[c.id] === cached ? current : { ...current, [c.id]: cached }); return; }
        try {
          const detail = archiveCache.current.get(c.id) || await api<CaptureDetail>(
            archive ? `captures/${c.id}/archive-preview` : `captures/${c.id}`);
          if (dead) return;
          setCaptures(current => {
            const existing = current.find(x => x.id === c.id);
            return existing ? mergeCapturePages(current, [{ ...existing, ...detail.capture }]) : current;
          });
          if (archive && detail.frame) {
            archiveCache.current.set(c.id, { ...detail, origin: "archive" });
            if (archiveCache.current.size > 64) archiveCache.current.delete(archiveCache.current.keys().next().value!);
          }
          setFrames(current => ({ ...current, [c.id]: archive ? { ...detail, origin: "archive" } : detail }));
          setFrameErrors(current => { const next = { ...current }; delete next[c.id]; return next; });
          setFrameWaiting(current => { const next = { ...current }; delete next[c.id]; return next; });
        } catch (e) {
          if (!dead) {
            if (e instanceof ApiError && e.status === 429) {
              setFrameWaiting(current => ({ ...current, [c.id]: true }));
              return;
            }
            setFrameErrors(current => ({ ...current, [c.id]: (e as Error).message }));
            setFrames(current => { const next = { ...current }; delete next[c.id]; return next; });
            archiveCache.current.delete(c.id);
          }
        }
    }
    async function poll() {
      const selected = selectedPoints.current;
      await Promise.all(selected.filter(c => c.uploadState !== "complete").map(readPoint));
      // Archive waveform reads share the account's analysis worker. Keep them sequential.
      for (const c of selected.filter(c => c.uploadState === "complete")) {
        if (dead) break;
        await readPoint(c);
      }
      if (!dead) timer = setTimeout(poll, document.hidden ? 5000 : 1000);
    }
    void poll();
    return () => { dead = true; clearTimeout(timer); };
  }, [requestKey]);
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true); hasPaged.current = true;
    try {
      const page = await api<MeasurementLivePage>(`measurements/live?limit=200&cursor=${encodeURIComponent(nextCursor)}`);
      if (alive.current) {
        setCaptures(current => mergeCapturePages(current, page.captures));
        setLiveObjects(page.objects); setNextCursor(page.nextCursor); setError("");
      }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setLoadingMore(false); }
  }
  return <div className="stack">
    <Card title="实时点位预览" tools={<Button variant="ghost" onClick={() => setRaw(!raw)}>
      {raw ? "优先显示有效片段" : "查看原始预览"}
    </Button>}>
      {tasks.length > 0 && <Select label="采集任务" value={chosen} options={tasks.map(c => ({
        value: captureTaskKey(c), label: `${c.context ? contextNames(c.context, allObjects).campaign : c.recording.name} · ${c.ownerName}`,
      }))} onChange={setTask} />}
      {error && <p role="alert" className="error">{error}</p>}
      {!points.length && <p className="measurement-inline-empty">{loading ? "正在读取采集任务…"
        : "当前范围暂无采集记录。客户端需绑定当前 Web，并开启自动同步新采集。"}</p>}
      <p className="hint">采集中显示最近 1 秒预览；完整上传后切换为保存记录。有效片段依据客户端记录的进入、离开边界显示。</p>
      {nextCursor && <Button disabled={loadingMore} variant="ghost" onClick={() => void loadMore()}>
        {loadingMore ? "正在加载…" : "加载更早的采集任务"}
      </Button>}
    </Card>
    <div className="measurement-live-grid">
      {points.map(c => {
        const stored = frames[c.id], detail = c.uploadState === "complete" && stored?.origin !== "archive" ? undefined : stored,
          f = detail?.frame, archive = detail?.origin === "archive";
        const valid = f ? validPassPreview(f) : null;
        const diagnostic = isDiagnosticMeasurement(f?.recording || c.recording);
        const names = c.context ? contextNames(c.context, allObjects) : null;
        const hasWave = !!(f?.waveform.values.length || f?.waveform.envelope?.length);
        const showRaw = raw || diagnostic || !c.recording.pointCycle || (c.liveState === "acquiring" && !valid?.points.length);
        return <Card key={c.id}
          title={`${names?.position || c.recording.pointCycle?.radialPointName || c.recording.point || "测点"} · ${c.recording.pointCycle?.azimuthDeg ?? "—"}°`}
          tools={<span className="hint">{c.uploadState === "complete" ? "记录已上传" : captureLiveLabel(c.liveState)}</span>}>
          <p className="hint">{names?.turbine || c.recording.turbine} / 叶片 {names?.blade || c.recording.pointCycle?.bladeId || "未标注"}
            {diagnostic && " · 诊断记录"}</p>
          {frameErrors[c.id] ? <div className="measurement-plot-empty error" role="alert">{frameErrors[c.id]}</div>
            : !detail ? <ChartLoading height={210} label={frameWaiting[c.id] ? "分析服务正在处理其他任务，等待读取波形…" : c.uploadState === "complete" ? "正在加载保存记录…" : "正在加载实时波形…"} />
            : showRaw && hasWave ? <FieldWaveChart waveform={f?.waveform} compact />
            : valid?.points.length && !raw ? <Chart height={210} label={archive ? "保存记录有效片段" : "实时有效片段"} option={{
              grid: { left: 70, right: 20, top: 30, bottom: 35 }, tooltip: { trigger: "axis" },
              xAxis: { type: "value", name: "有效段内 s" }, yAxis: { type: "value", name: "m/s", scale: true },
              series: [{ type: "line", showSymbol: false, connectNulls: false, data: valid.points }],
            }} />
            : <div className="measurement-plot-empty">{c.liveState === "error" ? c.error || "采集异常，记录状态待核对"
              : f?.terminalMetadataOnly ? "采集已结束，等待记录上传后显示波形"
              : showRaw ? "等待波形数据" : valid?.reason || "等待采集帧"}</div>}
          <small className="hint">
            {archive ? "保存记录预览" : "最近 1 秒网络预览"} · {captureUploadLabel(c.uploadState)}
            {!archive && f ? ` · 最后接收 ${timeText(f.receivedAt)}` : ""}
          </small>
          {diagnostic ? <p className="hint">诊断预览保留原始信号，不作为正式健康判定依据。</p>
            : !showRaw && valid && <p className="hint">{valid.reason}</p>}
        </Card>;
      })}
    </div>
  </div>;
}
