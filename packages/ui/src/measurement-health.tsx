"use client";
import React, { useState } from "react";
import { api } from "./api";
import { Button, Card, Dialog, Select, Table } from "./common";
import { Chart } from "./charts";
import { ArrowLeft, ArrowRight, Wind, RefreshCw } from "lucide-react";
import { MeasurementDetail } from "./measurement-analysis";
import {
  ObjectFilters,
  MeasurementStatus,
  numberText,
  RiskTag,
  timeText,
  useMeasurements,
} from "./measurement-common";
import {
  contextNames,
  bladeDisplaySlots,
  measurementHistory,
  measurementAlertRank,
  isDiagnosticMeasurement,
  type MeasurementContext,
} from "./measurement-domain";
import type { ContextProps } from "./common";

export function MeasurementHealth(props: ContextProps) {
  const { data, loading, error, setError, reload } = useMeasurements();
  const [activeTurbine, setActiveTurbine] = useState(""),
    [filter, setFilter] = useState<Partial<MeasurementContext>>({}),
    [detail, setDetail] = useState<any>(null),
    [rules, setRules] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [historyFilter, setHistoryFilter] = useState<Partial<MeasurementContext>>(
      {},
    ),
    [historyPoint, setHistoryPoint] = useState(""),
    [historyAngle, setHistoryAngle] = useState("");
  const turbines = data.objects.filter(
    (o) =>
      o.kind === "turbine" &&
      (!filter.farmId || o.parentId === filter.farmId) &&
      (!filter.turbineId || o.id === filter.turbineId),
  );
  const relevant = data.results.filter(
    (r) =>
      (!filter.farmId || r.context.farmId === filter.farmId) &&
      (!filter.campaignId || r.context.campaignId === filter.campaignId),
  );
  async function open(id: string) {
    setBusy(true);
    try {
      setDetail((await api<any>(`measurements/result/${id}`)).result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pointHistory = measurementHistory(
    data.results.filter((r) => r.context.positionId === historyPoint),
  );
  const angles = [
    ...new Set(
      pointHistory.map((r) =>
        r.azimuthDeg == null ? "unknown" : String(r.azimuthDeg),
      ),
    ),
  ];
  const activeAngle = angles.includes(historyAngle)
    ? historyAngle
    : angles[0] || "";
  const history = pointHistory.filter(
    (r) =>
      (r.azimuthDeg == null ? "unknown" : String(r.azimuthDeg)) === activeAngle,
  );
  const ruleLabels: Record<string, string> = {
    windBin: "风速分箱 · m/s",
    rpmBin: "转速分箱 · rpm",
    minCampaigns: "最少正常参考批次",
    sigma: "标准差倍数",
    frequencyDropPercent: "频率下降下限 · %",
    amplitudeRisePercent: "幅值上升下限 · %",
    consecutiveCampaigns: "连续异常批次数",
  };
  const groups = turbines.map((t) => {
    const blades = data.objects
      .filter((o) => o.kind === "blade" && o.parentId === t.id)
      .sort((a, b) => a.code.localeCompare(b.code, "zh", { numeric: true }));
    const all = measurementHistory(
      relevant.filter((r) => r.context.turbineId === t.id),
    );
    const campaignId = filter.campaignId || all.at(-1)?.context.campaignId;
    const rows = all.filter((r) => r.context.campaignId === campaignId);
    const pointRows = new Map<string, any>();
    for (const r of [...rows].sort(
      (a, b) => measurementAlertRank(a) - measurementAlertRank(b),
    ))
      pointRows.set(r.context.positionId, r);
    const values = [...pointRows.values()];
    const risks = values.filter(
      (r) =>
        !isDiagnosticMeasurement(r) && (["suspected", "review"].includes(r.assessment.status) ||
        r.features.events?.length),
    );
    return { t, blades, rows, values, risks, campaignId };
  });
  const active = groups.find((g) => g.t.id === activeTurbine);
  const alerts = (active ? [active] : groups).flatMap((g) =>
    g.rows.filter(
      (r) =>
        !isDiagnosticMeasurement(r) && (["suspected", "review"].includes(r.assessment.status) ||
        r.features.events?.length),
    ),
  );
  const label = (rs: any[]) =>
    !rs.length
      ? "未测量"
      : rs.every(isDiagnosticMeasurement)
        ? "仅诊断记录，待正式测量"
      : rs.some((r) => !isDiagnosticMeasurement(r) && r.assessment.status === "suspected")
        ? "疑似异常"
        : rs.some(
              (r) =>
                !isDiagnosticMeasurement(r) && (r.assessment.status === "review" || r.features.events?.length),
            )
          ? "待复核"
          : rs.some(isDiagnosticMeasurement)
            ? "含诊断数据，待正式测量"
          : rs.some((r) => r.assessment.status === "insufficient")
            ? "待积累参考"
            : "本次未见异常";
  const tone = (rs: any[]) =>
    rs.some((r) => !isDiagnosticMeasurement(r) && r.assessment.status === "suspected")
      ? "risk"
      : rs.some(
            (r) =>
              !isDiagnosticMeasurement(r) && (r.assessment.status === "review" || r.features.events?.length),
          )
        ? "warning"
        : rs.length &&
            rs.every((r) => !isDiagnosticMeasurement(r) && r.assessment.status === "within_reference")
          ? "clear"
          : "pending";
  return (
    <div className="stack measurement-workspace health-unified">
      <header className="measurement-heading">
        <div>
          <h1>健康监测</h1>
          <p>以风机为入口，查看叶片状态与异常证据。</p>
        </div>
        <div className="measurement-actions">
          <Button disabled={loading || busy} onClick={() => void reload()}>
            <RefreshCw size={16} />
            刷新
          </Button>
          <Button
            disabled={!props.canWrite || loading || busy}
            onClick={() => setRules({ ...data.rules })}
          >
            预警规则
          </Button>
        </div>
      </header>
      <Card className="measurement-filter-card">
        <ObjectFilters
          objects={data.objects}
          value={filter}
          blade={false}
          onChange={(v) => {
            setFilter(v);
            setActiveTurbine("");
            setHistoryPoint("");
          }}
        />
        <MeasurementStatus
          loading={loading || busy}
          error={error}
          onReload={() => void reload()}
        />
      </Card>
      {!loading && !groups.length && (
        <section className="measurement-empty">
          <Wind size={36} />
          <h2>从一台风机开始</h2>
          <p>上传或导入采集记录，关联风机与叶片后，这里会显示测量概要。</p>
          <Button variant="primary" onClick={() => props.go("blade")}>
            前往旋转测振 <ArrowRight size={16} />
          </Button>
        </section>
      )}
      {!loading && groups.length > 0 && (
        <>
          <div className="measurement-overview-stats">
            <span>
              风机 <b>{groups.length}</b>
            </span>
            <span>
              已分析点位 <b>{groups.reduce((n, g) => n + g.values.length, 0)}</b>
            </span>
            <span>诊断点位 <b>{groups.reduce((n, g) => n + g.values.filter(isDiagnosticMeasurement).length, 0)}</b></span>
            <span>
              需复核点位 <b>{groups.reduce((n, g) => n + g.risks.length, 0)}</b>
            </span>
            <span>
              测量范围{" "}
              <b>
                {filter.campaignId
                  ? data.objects.find((o) => o.id === filter.campaignId)?.name
                  : "各风机最新批次"}
              </b>
            </span>
          </div>
          {!active ? (
            <div className="measurement-turbines turbine-overview">
              {groups.map((g) => (
                <button
                  key={g.t.id}
                  className="turbine-overview-card"
                  onClick={() => setActiveTurbine(g.t.id)}
                  aria-label={`查看风机 ${g.t.name}`}
                >
                  <div className="turbine-title">
                    <span className="turbine-icon">
                      <Wind size={26} />
                    </span>
                    <div>
                      <h2>{g.t.name}</h2>
                      <small>
                        {data.objects.find((o) => o.id === g.t.parentId)?.name}{" "}
                        · {g.t.code}
                      </small>
                    </div>
                    <span className={`measurement-state ${tone(g.values)}`}>
                      {label(g.values)}
                    </span>
                  </div>
                  <div className="blade-status-grid">
                    {bladeDisplaySlots(g.blades).map((slot) => {
                      const b = slot.blade;
                      const rows = g.values.filter(
                        (r) => r.context.bladeId === b?.id,
                      );
                      return (
                        <div
                          key={slot.key}
                          className={`blade-status ${tone(rows)}`}
                        >
                          <strong>{slot.name}</strong>
                          <span>{b ? label(rows) : "未配置"}</span>
                          <small>{b ? `${rows.length} / 5 点已有分析` : "尚无测量对象"}</small>
                        </div>
                      );
                    })}
                  </div>
                  <div className="turbine-card-footer">
                    <span>
                      {data.objects.find((o) => o.id === g.campaignId)?.name ||
                        "尚无测量批次"}
                    </span>
                    <strong>
                      查看叶片与点位 <ArrowRight size={15} />
                    </strong>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Card
              title={`${active.t.name} · 叶片与点位`}
              tools={
                <Button variant="ghost" onClick={() => setActiveTurbine("")}>
                  <ArrowLeft size={15} />
                  全部风机
                </Button>
              }
            >
              <p className="hint">
                {data.objects.find((o) => o.id === active.campaignId)?.name ||
                  "尚无测量批次"}{" "}
                · 点击点位查看波形证据；缺测位置保留为空。
              </p>
              <Table
                headers={[
                  "叶片",
                  "P1 · 叶根侧",
                  "P2",
                  "P3 · 叶中",
                  "P4",
                  "P5 · 叶尖侧",
                ]}
              >
                {active.blades.map((b) => (
                  <tr key={b.id}>
                    <th scope="row">{b.name}</th>
                    {[1, 2, 3, 4, 5].map((i) => {
                      const p = data.objects.find(
                        (o) =>
                          o.parentId === b.id &&
                          o.code.toUpperCase() === `P${i}`,
                      );
                      const r = active.values.find(
                        (r) => r.context.positionId === p?.id,
                      );
                      return (
                        <td key={i}>
                          {r ? (
                            <button
                              className={`measurement-cell ${tone([r])}`}
                              disabled={busy}
                              onClick={() => {
                                void open(r.id);
                                setHistoryFilter(r.context);
                                setHistoryPoint(p!.id);
                                setHistoryAngle(
                                  r.azimuthDeg == null
                                    ? "unknown"
                                    : String(r.azimuthDeg),
                                );
                              }}
                            >
                              <RiskTag
                                assessment={
                                  isDiagnosticMeasurement(r)
                                    ? { status: "insufficient", label: "诊断数据" }
                                    : r.features.events?.length &&
                                  r.assessment.status !== "suspected"
                                    ? {
                                        status: "review",
                                        label: "波形异常待复核",
                                      }
                                    : r.assessment
                                }
                              />
                              <strong>
                                频率偏移{" "}
                                {numberText(
                                  r.assessment.frequencyShiftPercent,
                                  1,
                                )}
                                %
                              </strong>
                              <small>
                                幅值比{" "}
                                {numberText(r.assessment.amplitudeRatio, 2)} ·
                                主峰{" "}
                                {numberText(
                                  r.features.peaks?.[0]?.frequencyHz,
                                  1,
                                )}{" "}
                                Hz
                              </small>
                              {!isDiagnosticMeasurement(r) && r.features.events?.length > 0 && (
                                <small>
                                  {r.features.events.length} 个波形异常区间
                                </small>
                              )}
                            </button>
                          ) : (
                            <span className="measurement-missing">
                              {p ? "未测量" : "未登记"}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Table>
            </Card>
          )}
          <Card
            title="分级预警"
            tools={
              <span className="hint">
                {alerts.length} 条 · 点击查看原始证据
              </span>
            }
          >
            {alerts.length ? (
              <Table
                headers={[
                  "级别",
                  "风机 / 叶片 / 点位",
                  "测量时间",
                  "异常依据",
                  "工况",
                  "操作",
                ]}
              >
                {alerts.map((r) => {
                  const n = contextNames(
                    r.context,
                    r.objectsSnapshot || data.objects,
                  );
                  return (
                    <tr key={r.id}>
                      <td>
                        <RiskTag
                          assessment={
                            r.features.events?.length &&
                            r.assessment.status === "insufficient"
                              ? { status: "review", label: "波形异常待复核" }
                              : r.assessment
                          }
                        />
                      </td>
                      <td>
                        {n.turbine} / {n.blade} / {n.position}
                        <small>圆周角 {numberText(r.azimuthDeg, 0)}°</small>
                      </td>
                      <td>{timeText(r.measuredAt)}</td>
                      <td>
                        {r.features.events?.length
                          ? `${r.features.events.length} 个异常区间；`
                          : ""}
                        {r.assessment.reason}
                      </td>
                      <td>
                        {numberText(r.condition?.windSpeed, 1)} m/s /{" "}
                        {numberText(r.condition?.rpm, 1)} rpm
                      </td>
                      <td>
                        <Button disabled={busy} onClick={() => void open(r.id)}>
                          查看证据
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <p className="measurement-inline-empty">
                本批次暂无正式预警。诊断记录、未测量或参考不足的点位不计为正常。
              </p>
            )}
          </Card>
        </>
      )}
      {groups.length > 0 && (
        <Card title="批次历史对比">
          <details>
            <summary>展开同点位历史</summary>
            <ObjectFilters
              objects={data.objects}
              value={{ ...historyFilter, positionId: historyPoint }}
              onChange={(v) => {
                setHistoryFilter(v);
                setHistoryPoint(v.positionId || "");
              }}
              campaign={false}
            />
            {angles.length > 0 && (
              <Select
                label="历史圆周角"
                value={activeAngle}
                options={angles.map((value) => ({
                  value,
                  label: value === "unknown" ? "未记录圆周角" : `${value}°`,
                }))}
                onChange={setHistoryAngle}
              />
            )}
            {history.length ? (
              <>
                <Chart
                  label="测量批次频率变化"
                  option={{
                    tooltip: { trigger: "axis" },
                    grid: { left: 65, right: 20, bottom: 85 },
                    xAxis: {
                      type: "category",
                      data: history.map(
                        (r) =>
                          contextNames(
                            r.context,
                            r.objectsSnapshot || data.objects,
                          ).campaign,
                      ),
                      axisLabel: { rotate: 25 },
                    },
                    yAxis: { type: "value", name: "主峰 Hz" },
                    series: [
                      {
                        name: "常规测量",
                        type: "line",
                        connectNulls: false,
                        data: history.map(
                          (r) => isDiagnosticMeasurement(r) ? null : r.features.peaks?.[0]?.frequencyHz ?? null,
                        ),
                      },
                      { name: "诊断记录", type: "scatter", symbolSize: 8,
                        itemStyle: { color: "#d97706" },
                        data: history.map((r) => isDiagnosticMeasurement(r) ? r.features.peaks?.[0]?.frequencyHz ?? null : null) },
                    ],
                    legend: { data: ["常规测量", "诊断记录"] },
                  }}
                />
                <Table
                  headers={[
                    "批次",
                    "时间",
                    "圆周角",
                    "风速 / 转速",
                    "主峰 Hz",
                    "状态",
                  ]}
                >
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {
                          contextNames(
                            r.context,
                            r.objectsSnapshot || data.objects,
                          ).campaign
                        }
                      </td>
                      <td>{timeText(r.measuredAt)}</td>
                      <td>{numberText(r.azimuthDeg, 1)}°</td>
                      <td>
                        {numberText(r.condition.windSpeed)} /{" "}
                        {numberText(r.condition.rpm)}
                      </td>
                      <td>{numberText(r.features.peaks?.[0]?.frequencyHz)}</td>
                      <td>
                        <RiskTag assessment={r.assessment} />
                      </td>
                    </tr>
                  ))}
                </Table>
                <p className="hint">
                  曲线按同点位、同圆周角显示，每批次取最近一次测量的最新分析；不同工况仅供查看。自动判据另校验频谱配置和工况分箱。
                </p>
              </>
            ) : (
              <p className="hint">选择点位后显示真实批次记录。</p>
            )}
          </details>
        </Card>
      )}
      {rules && (
        <Dialog
          title="同工况异常判据"
          onClose={() => {
            if (!busy) setRules(null);
          }}
        >
          <div className="measurement-form">
            {Object.entries(ruleLabels).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  step="any"
                  value={rules[key]}
                  onChange={(e) =>
                    setRules({ ...rules, [key]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
            <p className="hint">
              无需基线即可查看波形、幅值和频谱；自动异常比较需有足够的经人工复核正常参考。频率变化还须超过频谱分辨率。
            </p>
            {error && <p className="error">{error}</p>}
            <Button
              disabled={busy}
              variant="primary"
              onClick={async () => {
                setBusy(true);
                try {
                  await api("measurements/rules", "PUT", {
                    rules,
                    revision: data.revision,
                  });
                  setRules(null);
                  await reload();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存判据
            </Button>
          </div>
        </Dialog>
      )}
      {detail && (
        <Dialog title="点位响应与异常证据" wide onClose={() => setDetail(null)}>
          <MeasurementDetail
            key={detail.id}
            result={detail}
            canWrite={props.canWrite}
            onChanged={() => {
              setDetail(null);
              void reload();
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
