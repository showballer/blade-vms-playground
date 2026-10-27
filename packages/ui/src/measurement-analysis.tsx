"use client";
import React, { useEffect, useRef, useState } from "react";
import { api, saveBlob } from "./api";
import { Button, Card, Dialog, Select, Table } from "./common";
import { Chart } from "./charts";
import { ChartLoading } from "./chart-loading";
import { FieldWaveChart } from "./field-waveform";
import { MeasurementLive } from "./measurement-live";
import { MeasurementSynthesis } from "./measurement-synthesis";
import { measurementChartHeight, measurementZoomAxes } from "./measurement-chart-options";
import { Activity, FolderOpen, RefreshCw } from "lucide-react";
import { contextNames, isDiagnosticMeasurement, type MeasurementContext } from "./measurement-domain";
import {
  matchesContext,
  MeasurementStatus,
  numberText,
  ObjectFilters,
  PageControls,
  RiskTag,
  timeText,
  useMeasurements,
} from "./measurement-common";

export function MeasurementDetail({
  result,
  canWrite,
  onChanged,
}: {
  result: any;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [selectedEvent, setSelectedEvent] = useState<any>(null),
    [smooth, setSmooth] = useState(false),
    [review, setReview] = useState(false),
    [note, setNote] = useState(result.review?.note || ""),
    [status, setStatus] = useState(result.review?.status || "待复核"),
    [approved, setApproved] = useState(result.referenceApproved || false),
    [rangeStart, setRangeStart] = useState(
      result.review?.range ? String(result.review.range.startSeconds) : "",
    ),
    [rangeEnd, setRangeEnd] = useState(
      result.review?.range ? String(result.review.range.endSeconds) : "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const f = result.features,
    names = contextNames(result.context, result.objectsSnapshot || []);
  const diagnostic = isDiagnosticMeasurement(result);
  const markedRange = selectedEvent || result.review?.range;
  const events = f.events || [];
  const wave = {
    tooltip: { trigger: "axis" },
    ...measurementZoomAxes("有效时间 / s", "速度 / m/s"),
    series: [
      {
        type: "line",
        showSymbol: false,
        data: smooth ? f.stitch.smoothed : f.stitch.raw,
        lineStyle: { width: 1 },
        markArea:
          markedRange || events.length
            ? {
                silent: true,
                itemStyle: { color: "rgba(217,119,6,0.14)" },
                data: (markedRange ? [markedRange] : events).map((e: any) => [
                  { name: e.label || "人工标记", xAxis: e.startSeconds },
                  { xAxis: e.endSeconds },
                ]),
              }
            : undefined,
        markLine: {
          silent: true,
          symbol: "none",
          data: f.stitch.joins.map((j: any) => ({
            xAxis: j.compressedSeconds,
            lineStyle: { color: j.flagged ? "#dc2626" : "#98a2b3" },
            label: { formatter: "拼接边界" },
          })),
        },
      },
    ],
  };
  const spectrum = {
    tooltip: { trigger: "axis" },
    ...measurementZoomAxes("频率 / Hz", "PSD (m/s)²/Hz"),
    series: [
      {
        type: "line",
        showSymbol: false,
        data: f.spectrum.frequencies.map((hz: number, i: number) => [
          hz,
          f.spectrum.psd[i],
        ]),
        markPoint: {
          data: f.peaks.map((p: any) => ({
            coord: [
              p.frequencyHz,
              f.spectrum.psd[f.spectrum.frequencies.indexOf(p.frequencyHz)],
            ],
            value: p.frequencyHz.toFixed(2),
          })),
        },
      },
    ],
  };
  return (
    <div className="stack measurement-workspace">
      <div className="measurement-toolbar">
        <div>
          <strong>
            {names.farm} / {names.turbine} / {names.blade} / {names.position}
          </strong>
          <p>
            {names.campaign} · {timeText(result.measuredAt)} · 圆周角{" "}
            {numberText(result.azimuthDeg, 1)}°
          </p>
        </div>
        <RiskTag assessment={result.assessment} />
      </div>
      {diagnostic && <p className="measurement-diagnostic-note">诊断分析：保留原始数据属性，可核对经过区间与频谱，不参与健康判定或正常参考。</p>}
      <div className="measurement-charts">
        <Card
          title="有效片段波形"
          tools={
            <label className="inline-field">
              <input
                type="checkbox"
                checked={smooth}
                onChange={(e) => setSmooth(e.target.checked)}
              />
              展示平滑
            </label>
          }
        >
          <Chart height={measurementChartHeight} label="有效片段拼接波形" option={wave} />
          <p className="hint">
            压缩有效时间；红线标记跳变较大边界。平滑只改变展示，频谱使用各原始连续片段。
          </p>
          <div className="measurement-evidence">
            <RiskTag assessment={result.assessment} />
            <p>{result.assessment.reason}</p>
            <small>
              频率偏移 {numberText(result.assessment.frequencyShiftPercent, 1)}%
              · 幅值比 {numberText(result.assessment.amplitudeRatio, 2)}
              。同工况判据评价整次响应；橙色区间标记局部波形异常候选。
            </small>
          </div>
        </Card>
        <Card title="Welch 频谱">
          <Chart height={measurementChartHeight} label="真实 Welch 频谱" option={spectrum} />
          <p className="hint">
            Hann 窗 · 分辨率 {numberText(f.spectrum.resolutionHz)} Hz ·{" "}
            {f.spectrum.averages} 个窗；拖动可缩放。
          </p>
        </Card>
      </div>
      <Card
        title="异常波形证据"
        tools={<span className="hint">{events.length} 个自动检测区间</span>}
      >
        {events.length ? (
          <div className="measurement-event-list">
            {events.map((event: any) => (
              <button
                type="button"
                key={event.id}
                className={selectedEvent?.id === event.id ? "selected" : ""}
                onClick={() => setSelectedEvent(event)}
              >
                <strong>{event.label}</strong>
                <span>
                  {numberText(event.startSeconds)}–
                  {numberText(event.endSeconds)} s
                </span>
                <small>RMS / 局部参考 {numberText(event.rmsRatio, 1)} 倍</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="measurement-inline-empty">
            未检出符合当前规则的局部振幅突增。可在波形中人工复核标记。
          </p>
        )}
        {selectedEvent && (
          <div className="measurement-event-detail">
            <p>
              <strong>{selectedEvent.label}</strong> · {selectedEvent.rule}
            </p>
            <p>
              原始记录 {selectedEvent.sourceRecordingId} ·{" "}
              {numberText(selectedEvent.sourceStartSeconds)}–
              {numberText(selectedEvent.sourceEndSeconds)} s · 样本{" "}
              {selectedEvent.sourceStartSample}–{selectedEvent.sourceEndSample}
            </p>
            <p className="hint">
              {selectedEvent.reason}；规则评分不是损伤置信概率。
            </p>
            <Button
              disabled={!canWrite || busy}
              onClick={() => {
                setRangeStart(String(selectedEvent.startSeconds));
                setRangeEnd(String(selectedEvent.endSeconds));
                setNote(`${selectedEvent.label}：${selectedEvent.rule}`);
                setReview(true);
              }}
            >
              加入复核
            </Button>{" "}
            <Button variant="ghost" onClick={() => setSelectedEvent(null)}>
              显示全部区间
            </Button>
          </div>
        )}
      </Card>
      <Card title="响应特征与复核">
        <div className="measurement-stats">
          <span>
            有效时长 <b>{numberText(f.validSeconds)} s</b>
          </span>
          <span>
            RMS <b>{numberText(f.metrics.rmsVelocityMps, 6)} m/s</b>
          </span>
          <span>
            风速 <b>{numberText(result.condition?.windSpeed)} m/s</b>
          </span>
          <span>
            转速 <b>{numberText(result.condition?.rpm)} rpm</b>
          </span>
        </div>
        <Table
          headers={["频谱峰候选", "频率 Hz", "带内 RMS m/s", "带宽阻尼估计"]}
        >
          {f.peaks.map((p: any, i: number) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{numberText(p.frequencyHz)}</td>
              <td>{numberText(p.bandRmsVelocityMps, 6)}</td>
              <td>{numberText(p.dampingRatioEstimate, 4)}</td>
            </tr>
          ))}
        </Table>
        <p>{result.assessment?.reason}</p>
        <p className="hint">
          峰值是响应频率候选，阶次激励也可能成峰；不能单凭峰值认定固有模态或结构损伤。原始区间：
          {f.ranges
            .map(
              (r: any) =>
                `${numberText(r.startSeconds)}–${numberText(r.endSeconds)} s`,
            )
            .join("、")}
          。
        </p>
        <div className="measurement-toolbar">
          <Button disabled={!canWrite || busy} onClick={() => setReview(true)}>
            标记 / 人工复核
          </Button>
          <Button
            disabled={!canWrite || busy || diagnostic}
            onClick={async () => {
              setBusy(true);
              try {
                await api("measurements/reassess", "POST", {
                  resultId: result.id,
                });
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            按当前参考重评
          </Button>
          <Button
            onClick={() =>
              void saveBlob(
                new Blob([JSON.stringify(result, null, 2)], {
                  type: "application/json",
                }),
                `measurement-${result.id}.json`,
              )
            }
          >
            导出本次追溯
          </Button>
        </div>
        {result.review && (
          <p>
            复核：{result.review.status} · {result.review.note} ·{" "}
            {result.review.reviewer} / {timeText(result.review.reviewedAt)}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Card>
      {review && (
        <Dialog
          title="测量结果复核"
          onClose={() => {
            if (!busy) setReview(false);
          }}
        >
          <div className="measurement-form">
            <Select
              label="复核状态"
              value={status}
              options={["待复核", "已确认", "已关闭"]}
              onChange={setStatus}
            />
            <label>
              复核说明
              <textarea
                aria-label="测量复核说明"
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <label className="inline-field">
              <input
                type="checkbox"
                checked={approved && !diagnostic}
                disabled={diagnostic}
                onChange={(e) => setApproved(e.target.checked)}
              />
              复核为同工况正常参考（可选）
            </label>
            <label>
              标记开始 · 有效时间 s（可留空）
              <input
                type="number"
                min="0"
                max={f.validSeconds}
                step="any"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
              />
            </label>
            <label>
              标记结束 · 有效时间 s（可留空）
              <input
                type="number"
                min="0"
                max={f.validSeconds}
                step="any"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
              />
            </label>
            <p className="hint">
              不勾选也可分析；参考仅用于后续同点位、同工况的历史比较。
            </p>
            {error && <p className="error">{error}</p>}
            <Button
              disabled={busy || !note.trim()}
              variant="primary"
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("measurements/review", "POST", {
                    resultId: result.id,
                    referenceApproved: approved && !diagnostic,
                    status,
                    note,
                    range:
                      rangeStart === "" && rangeEnd === ""
                        ? null
                        : {
                            startSeconds:
                              rangeStart === "" ? null : Number(rangeStart),
                            endSeconds:
                              rangeEnd === "" ? null : Number(rangeEnd),
                          },
                    revision: result.review?.revision ?? null,
                  });
                  setReview(false);
                  onChanged();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存复核
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
export function MeasurementAnalysis({
  canWrite,
  refreshKey = 0,
  preferredIds = [],
  onImport,
}: {
  canWrite: boolean;
  refreshKey?: number;
  preferredIds?: string[];
  onImport?: () => void;
}) {
  const { data, loading, error, setError, reload } =
    useMeasurements(refreshKey);
  const [context, setContext] = useState<Partial<MeasurementContext>>({}),
    [selected, setSelected] = useState(""),
    [view, setView] = useState("analysis"),
    [library, setLibrary] = useState(false),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [link, setLink] = useState<any>(null),
    [binding, setBinding] = useState<Partial<MeasurementContext>>({}),
    [busy, setBusy] = useState(false),
    [chartBusy, setChartBusy] = useState(false),
    [detail, setDetail] = useState<any>(null),
    [raw, setRaw] = useState<any>(null),
    [start, setStart] = useState(""),
    [combine, setCombine] = useState(false),
    [includeDiagnostic, setIncludeDiagnostic] = useState(false),
    [batchProgress, setBatchProgress] = useState(""),
    [batchSummary, setBatchSummary] = useState<{ completed: number; failures: string[] } | null>(null),
    [windowSeconds, setWindow] = useState(0.25),
    [fadeFraction, setFade] = useState(0.05),
    [detrend, setDetrend] = useState("constant"),
    [eventRmsRatio, setEventRatio] = useState(4),
    [eventSigma, setSigma] = useState(6),
    [eventWindowMs, setEventWindow] = useState(20),
    [comparison, setComparison] = useState<any[]>([]),
    [compareBusy, setCompareBusy] = useState(false),
    [showCompare, setShowCompare] = useState(false),
    [selectionRevision, setSelectionRevision] = useState(0);
  const requestId = useRef(0),
    preferredApplied = useRef(""),
    compareId = useRef(0),
    initialized = useRef(false);
  const sources = data.sources.filter(
    (s) => s.context && matchesContext(s, context),
  );
  const source =
    data.sources.find(
      (s) => s.key === selected && (!s.context || matchesContext(s, context)),
    ) || sources[0];
  const sourceOptions =
    source && !source.context ? [source, ...sources] : sources;
  const sourceKey = source?.key || "";
  const diagnostic = isDiagnosticMeasurement(source);
  const bladeSources = data.sources.filter(s => s.context &&
    context.campaignId && context.turbineId && context.bladeId &&
    matchesContext(s, { ...context, positionId: "" }) &&
    s.metadata.status === "complete" && (includeDiagnostic || !isDiagnosticMeasurement(s)));
  const hasDiagnosticSources = sources.some(isDiagnosticMeasurement);
  const results = data.results.filter(
    (r) => r.sourceKey === sourceKey || r.sourceKeys?.includes(sourceKey),
  );
  const latest = results[0]?.id;
  const matching = source?.context
    ? data.sources.filter(
        (s) =>
          s.context &&
          Object.keys(source.context).every(
            (k) => s.context[k] === source.context[k],
          ) &&
          s.metadata.pointCycle?.azimuthDeg ===
            source.metadata.pointCycle?.azimuthDeg &&
          s.metadata.status === "complete" && (includeDiagnostic || !isDiagnosticMeasurement(s)),
      )
    : [];
  const libraryRows = data.sources.filter((s) =>
    s.name.toLowerCase().includes(query.toLowerCase()),
  );
  const blades = data.objects
    .filter((o) => o.kind === "blade" && o.parentId === context.turbineId)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const positions = data.objects
    .filter((o) => o.kind === "position" && o.parentId === context.bladeId)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  function sameContext(next: Partial<MeasurementContext>) {
    return (["farmId", "turbineId", "campaignId", "bladeId", "positionId"] as const)
      .every(key => (context[key] || "") === (next[key] || ""));
  }
  function changeContext(next: Partial<MeasurementContext>) {
    if (sameContext(next)) return;
    setSelectionRevision(value => value + 1);
    requestId.current++;
    compareId.current++;
    setShowCompare(false);
    setCompareBusy(false);
    setContext(next);
    setSelected("");
    setDetail(null);
    setRaw(null);
    setComparison([]);
    setStart("");
    setCombine(false);
    setBatchSummary(null);
  }
  function choose(s: any) {
    const nextView = s.context ? "analysis" : "raw";
    if (s.key === sourceKey && sameContext(s.context || {}) && view === nextView) {
      setLibrary(false);
      return;
    }
    setSelectionRevision(value => value + 1);
    requestId.current++;
    compareId.current++;
    setShowCompare(false);
    setCompareBusy(false);
    setSelected(s.key);
    setContext(s.context || {});
    setStart("");
    setCombine(false);
    setDetail(null);
    setRaw(null);
    setComparison([]);
    setLibrary(false);
    setView(s.context ? "analysis" : "raw");
    setBatchSummary(null);
  }
  useEffect(() => {
    const signature = preferredIds.join("|");
    if (signature && signature !== preferredApplied.current) {
      const s = data.sources.find((s) => preferredIds.includes(s.reference.id));
      if (s) {
        preferredApplied.current = signature;
        if (s.context) choose(s);
        else {
          setLibrary(true);
          setQuery(s.name);
        }
      }
    }
  }, [data.sources, preferredIds.join("|")]);
  useEffect(() => {
    if (!initialized.current && data.sources.some((s) => s.context)) {
      initialized.current = true;
      const s = data.sources.find((s) => s.context);
      setContext(s.context);
      setSelected(s.key);
    }
  }, [data.sources]);
  useEffect(() => {
    const g = ++requestId.current;
    compareId.current++;
    setComparison([]); setShowCompare(false); setCompareBusy(false);
    setDetail(null);
    setRaw(null);
    setChartBusy(false);
    if (view === "live" || view === "synthesis" || !sourceKey || (view === "analysis" && !latest))
      return;
    setChartBusy(true);
    const work =
      view === "raw"
        ? api<any>("measurements/source-waveform", "POST", {
            reference: source.reference,
          })
        : api<any>(`measurements/result/${latest}`);
    work
      .then((r) => {
        if (g === requestId.current) {
          if (view === "raw") setRaw(r.waveform || r);
          else setDetail(r.result);
        }
      })
      .catch((e) => {
        if (g === requestId.current) setError((e as Error).message);
      })
      .finally(() => {
        if (g === requestId.current) setChartBusy(false);
      });
    return () => {
      requestId.current++;
    };
  }, [sourceKey, latest, view, selectionRevision]);
  async function analyze() {
    if (!source) return;
    const g = ++requestId.current;
    setBusy(true);
    setError("");
    setView("analysis");
    try {
      const r = await api<any>("measurements/analyze", "POST", {
        ...(combine && matching.length > 1
          ? { references: matching.slice(0, 16).map((s) => s.reference) }
          : { reference: source.reference }),
        ...(start ? { measuredAt: new Date(start).toISOString() } : {}),
        parameters: {
          includeDiagnostic,
          windowSeconds,
          fadeFraction,
          detrend,
          eventWindowMs,
          eventRmsRatio,
          eventSigma,
        },
      });
      if (g === requestId.current) setDetail(r.result);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function analyzeBlade() {
    if (!bladeSources.length || bladeSources.length > 64 || busy) return;
    setBusy(true); setError(""); setBatchSummary(null); setView("analysis");
    let completed = 0;
    const failures: string[] = [];
    try {
      for (let i = 0; i < bladeSources.length; i++) {
        const item = bladeSources[i];
        setBatchProgress(`正在分析 ${i + 1}/${bladeSources.length}`);
        try {
          await api("measurements/analyze", "POST", { reference: item.reference,
            parameters: { includeDiagnostic, windowSeconds, fadeFraction, detrend, eventWindowMs, eventRmsRatio, eventSigma } });
          completed++;
        } catch (e) {
          const point = contextNames(item.context, data.objects).position;
          failures.push(`${point} · ${item.metadata.pointCycle?.azimuthDeg ?? "—"}°：${(e as Error).message}`);
        }
      }
      setBatchSummary({ completed, failures });
      await reload();
    } finally { setBusy(false); setBatchProgress(""); }
  }
  async function compare() {
    setShowCompare(true);
    setCompareBusy(true);
    setError("");
    const g = ++compareId.current;
    try {
      const candidates = data.results.filter(
        (r) =>
          matchesContext(r, { ...detail.context, positionId: "" }) &&
          r.azimuthDeg === detail?.azimuthDeg,
      );
      const rows = [
        ...new Map(
          [...candidates].reverse().map((r) => [r.context.positionId, r]),
        ).values(),
      ].slice(0, 5);
      const full = await Promise.all(
        rows.map((r) => api<any>(`measurements/result/${r.id}`)),
      );
      if (g === compareId.current)
        setComparison(
          full
            .map((r) => r.result)
            .sort((a, b) =>
              contextNames(a.context, data.objects).position.localeCompare(
                contextNames(b.context, data.objects).position,
                undefined,
                { numeric: true },
              ),
            ),
        );
    } catch (e) {
      if (g === compareId.current) setError((e as Error).message);
    } finally {
      if (g === compareId.current) setCompareBusy(false);
    }
  }
  return (
    <div className="stack measurement-workspace">
      <section className="measurement-filter-card">
        <ObjectFilters
          objects={data.objects}
          value={context}
          onChange={changeContext}
          blade={false}
          disabled={busy}
        />
        <div className="measurement-object-tabs">
          {blades.length > 0 && (
            <div className="measurement-choice-row" aria-label="选择叶片">
              <span>叶片</span>
              {blades.map((b) => (
                <button
                  type="button"
                  key={b.id}
                  disabled={busy}
                  aria-pressed={context.bladeId === b.id}
                  onClick={() =>
                    changeContext({ ...context, bladeId: b.id, positionId: "" })
                  }
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}
          {view !== "synthesis" && positions.length > 0 && (
            <div className="measurement-choice-row" aria-label="选择测点">
              <span>测点</span>
              <button
                type="button"
                disabled={busy}
                aria-pressed={!context.positionId}
                onClick={() => changeContext({ ...context, positionId: "" })}
              >
                全部
              </button>
              {positions.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  disabled={busy}
                  aria-pressed={context.positionId === p.id}
                  onClick={() =>
                    changeContext({ ...context, positionId: p.id })
                  }
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="measurement-toolbar measurement-source-toolbar">
          <span>
            {data.sources.length} 条来源 ·{" "}
            {data.sources.filter((s) => !s.context).length} 条待关联
          </span>
          <div className="measurement-heading-actions">
            <Button variant="ghost" onClick={() => setLibrary(true)}>
              <FolderOpen size={16} />
              记录与归属
            </Button>
            <Button
              variant="ghost"
              disabled={loading || busy}
              onClick={() => void reload()}
            >
              <RefreshCw size={16} />
              刷新
            </Button>
          </div>
        </div>
      </section>
      <MeasurementStatus
        loading={loading}
        error={error}
        onReload={() => void reload()}
      />
      <div className="measurement-view-tabs" aria-label="查看方式">
        {[
          { id: "analysis", label: "有效波形与频谱" },
          { id: "synthesis", label: "振幅合成" },
          { id: "live", label: "实时预览" },
          { id: "raw", label: "原始记录" },
        ].map((v) => (
          <button
            type="button"
            key={v.id}
            disabled={busy}
            aria-pressed={view === v.id}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === "synthesis" ? (
        <MeasurementSynthesis
          key={[context.farmId, context.turbineId, context.campaignId, context.bladeId].join("|")}
          context={context} objects={data.objects} sources={data.sources} canWrite={canWrite}
          includeDiagnostic={includeDiagnostic} onDiagnosticChange={setIncludeDiagnostic}
        />
      ) : view === "live" ? (
        <MeasurementLive context={context} objects={data.objects} />
      ) : (
        <>
          {source && (
            <Card className="measurement-current-record">
              <div className="measurement-record-bar">
                <Select
                  label="记录 / 圆周角"
                  value={sourceKey}
                  disabled={busy}
                  options={sourceOptions.map((s) => ({
                    value: s.key,
                    label: `${s.context ? `${contextNames(s.context, data.objects).blade} / ${contextNames(s.context, data.objects).position} · ` : ""}${s.name} · ${s.metadata.pointCycle?.azimuthDeg ?? "—"}° · ${timeText(s.measuredAt)}`,
                  }))}
                  onChange={(key) => {
                    if (key === sourceKey) return;
                    setSelected(key);
                    setDetail(null);
                    setRaw(null);
                    setStart("");
                  }}
                />
                <Button
                  variant="primary"
                  disabled={!canWrite || busy || !source.context || (diagnostic && !includeDiagnostic)}
                  onClick={() => void analyze()}
                >
                  {busy ? batchProgress || "正在分析…" : detail ? "重新分析" : "分析本次测量"}
                </Button>
                <Button disabled={!canWrite || busy || !bladeSources.length || bladeSources.length > 64}
                  onClick={() => void analyzeBlade()}>分析当前叶片（{bladeSources.length} 条）</Button>
              </div>
              {hasDiagnosticSources && <label className="measurement-diagnostic-note inline-field">
                <input type="checkbox" aria-label="纳入诊断数据分析" checked={includeDiagnostic} disabled={busy}
                  onChange={e => setIncludeDiagnostic(e.target.checked)} />
                纳入诊断数据分析（不进入健康判定或正常参考）
              </label>}
              {bladeSources.length > 64 && <p className="hint">当前叶片超过 64 条记录，请逐条选择分析，避免混合多次重复观测。</p>}
              {batchSummary && <div className="measurement-batch-summary" role="status">
                <strong>已完成 {batchSummary.completed} 条，未纳入 {batchSummary.failures.length} 条</strong>
                {batchSummary.failures.length > 0 && <details open><summary>查看未纳入原因</summary><ul>{batchSummary.failures.map((message, i) => <li key={i}>{message}</li>)}</ul></details>}
              </div>}
              <details className="measurement-advanced">
                <summary>高级分析设置</summary>
                <div className="measurement-filters">
                  <label>
                    实际测量开始时间
                    <input
                      aria-label="实际测量开始时间"
                      type="datetime-local"
                      step="1"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </label>
                  <label>
                    Welch 窗长 · s
                    <input
                      type="number"
                      min=".001"
                      max="30"
                      step=".01"
                      value={windowSeconds}
                      onChange={(e) => setWindow(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    展示平滑比例
                    <input
                      type="number"
                      min="0"
                      max=".2"
                      step=".01"
                      value={fadeFraction}
                      onChange={(e) => setFade(Number(e.target.value))}
                    />
                  </label>
                  <Select
                    label="去趋势"
                    value={detrend}
                    options={[
                      { value: "constant", label: "去均值" },
                      { value: "linear", label: "去线性趋势" },
                      { value: "none", label: "保留" },
                    ]}
                    onChange={setDetrend}
                  />
                  <label>
                    异常检测窗 · ms
                    <input
                      type="number"
                      min="5"
                      max="200"
                      value={eventWindowMs}
                      onChange={(e) => setEventWindow(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    局部 RMS 突增倍数
                    <input
                      type="number"
                      min="2"
                      max="20"
                      step=".5"
                      value={eventRmsRatio}
                      onChange={(e) => setEventRatio(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    稳健离差倍数
                    <input
                      type="number"
                      min="3"
                      max="20"
                      value={eventSigma}
                      onChange={(e) => setSigma(Number(e.target.value))}
                    />
                  </label>
                </div>
                <p className="hint">
                  文件缺少测量时间时填写实际时间。异常规则使用局部 RMS
                  与稳健离差的较高阈值；只标记候选，不自动认定损伤。
                </p>
                {matching.length > 1 && (
                  <label className="inline-field">
                    <input
                      type="checkbox"
                      checked={combine}
                      onChange={(e) => setCombine(e.target.checked)}
                    />
                    合并同测点、同圆周角的完整记录（最近{" "}
                    {Math.min(matching.length, 16)} 条）
                  </label>
                )}
              </details>
              {view === "analysis" && results.length > 1 && (
                <Select
                  label="已保存分析版本"
                  value={detail?.id || latest || ""}
                  disabled={chartBusy || busy}
                  options={results.map((r) => ({
                    value: r.id,
                    label: `${timeText(r.createdAt)} · ${r.name}`,
                  }))}
                  onChange={async (id) => {
                    const g = ++requestId.current;
                    setChartBusy(true);
                    try {
                      const r = await api<any>(`measurements/result/${id}`);
                      if (g === requestId.current) setDetail(r.result);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      if (g === requestId.current) setChartBusy(false);
                    }
                  }}
                />
              )}
              {!source.context && (
                <p className="hint">
                  此记录尚未关联对象，可查看原始波形；关联后可计算健康与频谱特征。
                </p>
              )}
            </Card>
          )}
          {!source && !loading && (
            <section className="measurement-empty">
              <Activity size={32} />
              <h2>
                {data.sources.length
                  ? "当前范围暂无已关联的测量"
                  : "还没有可分析的测量记录"}
              </h2>
              <p>上传桌面采集记录或导入文件，再选择风机、叶片和测点。</p>
              <div className="measurement-heading-actions">
                <Button
                  variant="primary"
                  disabled={!canWrite}
                  onClick={onImport}
                >
                  导入测量数据
                </Button>
                {data.sources.length > 0 && (
                  <Button onClick={() => setLibrary(true)}>
                    查看待关联记录
                  </Button>
                )}
              </div>
            </section>
          )}
          {chartBusy ? (
            <div className="measurement-charts">
              <Card title={view === "raw" ? "原始波形" : "有效片段波形"}>
                <ChartLoading />
              </Card>
              {view === "analysis" && (
                <Card title="Welch 频谱">
                  <ChartLoading />
                </Card>
              )}
            </div>
          ) : view === "raw" && raw ? (
            <Card title="原始记录波形">
              <FieldWaveChart waveform={raw.waveform || raw} />
              <p className="hint">
                保留移动过程与无效区间；图表按显示分辨率预览，未改写原始文件。
              </p>
            </Card>
          ) : view === "analysis" && detail ? (
            <>
              <MeasurementDetail
                key={detail.id}
                result={detail}
                canWrite={canWrite}
                onChanged={() => void reload()}
              />
              <Card
                title="同叶片多测点对比"
                tools={
                  <Button disabled={compareBusy} onClick={() => void compare()}>
                    {compareBusy ? "正在加载…" : "加载同批次点位"}
                  </Button>
                }
              >
                {!showCompare && (
                  <p className="hint">
                    并排查看同批次、同圆周角已分析点位的有效波形。缺失点位不补造数据。
                  </p>
                )}
                {compareBusy ? (
                  <ChartLoading />
                ) : (
                  <div className="measurement-live-grid">
                    {comparison.map((r) => (
                      <Card
                        key={r.id}
                        title={contextNames(r.context, data.objects).position}
                      >
                        <Chart
                          height={measurementChartHeight}
                          label="测点有效波形对比"
                          option={{
                            tooltip: { trigger: "axis" },
                            ...measurementZoomAxes("有效时间 / s", "速度 / m/s"),
                            series: [
                              {
                                type: "line",
                                showSymbol: false,
                                data: r.features.stitch.raw,
                              },
                            ],
                          }}
                        />
                      </Card>
                    ))}
                  </div>
                )}
                {showCompare && !compareBusy && !comparison.length && (
                  <p className="hint">没有同批次、同圆周角的已分析点位。</p>
                )}
              </Card>
            </>
          ) : source && view === "analysis" ? (
            <div className="measurement-charts">
              <Card title="有效片段波形">
                <div className="measurement-plot-empty">
                  点击“分析本次测量”，生成有效区间波形
                </div>
              </Card>
              <Card title="Welch 频谱">
                <div className="measurement-plot-empty">分析结果将在此显示</div>
              </Card>
            </div>
          ) : null}
        </>
      )}
      {library && (
        <Dialog title="记录与归属" wide onClose={() => setLibrary(false)}>
          <div className="stack">
            <div className="measurement-toolbar">
              <input
                aria-label="搜索测量记录"
                placeholder="搜索记录名称"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
              <Button
                disabled={!canWrite || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("objects/adopt", "POST", {});
                    await reload();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                按采集信息关联
              </Button>
            </div>
            <p className="hint">
              自动关联只使用记录中已有的风场、风机、叶片、点位和任务信息；信息不全的记录请单独关联。
            </p>
            <Table headers={["记录", "测量对象", "时间", "操作"]}>
              {libraryRows.slice(page * 20, page * 20 + 20).map((s) => {
                const n = s.context
                  ? contextNames(s.context, data.objects)
                  : null;
                return (
                  <tr key={s.key}>
                    <td>
                      {s.name}
                      <small>
                        {s.reference.kind === "capture"
                          ? "桌面上传"
                          : s.reference.kind === "import"
                            ? "文件导入"
                            : "历史记录"}
                      </small>
                    </td>
                    <td>
                      {n
                        ? `${n.turbine} / ${n.blade} / ${n.position}`
                        : "待关联"}
                    </td>
                    <td>{timeText(s.measuredAt)}</td>
                    <td>
                      <div className="measurement-heading-actions">
                        <Button onClick={() => choose(s)}>
                          {s.context ? "查看波形" : "查看原始波形"}
                        </Button>
                        <Button
                          disabled={!canWrite || busy}
                          onClick={() => {
                            setLink(s);
                            setBinding(s.context || {});
                          }}
                        >
                          关联对象
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
            <PageControls
              page={page}
              total={libraryRows.length}
              onChange={setPage}
            />
            {error && <p className="error">{error}</p>}
          </div>
        </Dialog>
      )}
      {link && (
        <Dialog
          title="关联测量对象"
          onClose={() => {
            if (!busy) setLink(null);
          }}
        >
          <p>{link.name}</p>
          <ObjectFilters
            objects={data.objects}
            value={binding}
            onChange={setBinding}
            disabled={busy}
          />
          <p className="hint">
            对象与批次在系统管理维护。归属变更不改写原始文件和已有报告快照。
          </p>
          {error && <p className="error">{error}</p>}
          <Button
            variant="primary"
            disabled={
              busy || Object.values(binding).filter(Boolean).length !== 5
            }
            onClick={async () => {
              setBusy(true);
              try {
                await api("objects/link", "POST", {
                  reference: link.reference,
                  context: binding,
                  revision: link.bindingRevision,
                });
                setLink(null);
                await reload();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存归属
          </Button>
        </Dialog>
      )}
    </div>
  );
}
