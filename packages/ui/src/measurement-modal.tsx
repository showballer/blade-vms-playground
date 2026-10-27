"use client";
import React, { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Card, Select, Table } from "./common";
import { Chart } from "./charts";
import {
  ObjectFilters,
  MeasurementStatus,
  numberText,
  PageControls,
  timeText,
  useMeasurements,
} from "./measurement-common";
import { isDiagnosticMeasurement, type MeasurementContext } from "./measurement-domain";
export function MeasurementModal({ canWrite }: { canWrite: boolean }) {
  const { data, loading, error, setError, reload } = useMeasurements();
  const [filter, setFilter] = useState<Partial<MeasurementContext>>({}),
    [frequency, setFrequency] = useState(0),
    [bandwidth, setBandwidth] = useState(0),
    [azimuth, setAzimuth] = useState(""),
    [includeDiagnostic, setIncludeDiagnostic] = useState(false),
    [result, setResult] = useState<any>(null),
    [history, setHistory] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0);
  async function historyLoad() {
    try {
      setHistory((await api<any>("measurements/modal")).results);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void historyLoad();
  }, []);
  const scoped = data.results.filter(
    (r) =>
      r.context.campaignId === filter.campaignId &&
      r.context.turbineId === filter.turbineId,
  );
  const available = scoped.filter(r => includeDiagnostic || !isDiagnosticMeasurement(r));
  const angles = [
    ...new Set(
      available
        .filter((r) => typeof r.azimuthDeg === "number")
        .map((r) => r.azimuthDeg),
    ),
  ].sort((a, b) => a - b);
  const hs = history.filter(
    (r) =>
      (!filter.turbineId || r.config.turbineId === filter.turbineId) &&
      (!filter.campaignId || r.config.campaignId === filter.campaignId),
  );
  const curves =
    result?.curves.filter(
      (c: any) => !filter.bladeId || c.bladeId === filter.bladeId,
    ) || [];
  return (
    <div className="stack measurement-workspace">
      <header>
        <h1>模态识别</h1>
        <p>真实频谱候选与五点响应分布，支持同风机三叶片对比。</p>
      </header>
      <Card title="选择测量范围">
        <ObjectFilters
          objects={data.objects}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setResult(null);
            setPage(0);
          }}
          position={false}
        />
        <div className="measurement-filters">
          <Select
            label="圆周角"
            value={azimuth}
            options={[
              { value: "", label: "选择圆周角" },
              ...angles.map((a) => ({ value: String(a), label: `${a}°` })),
            ]}
            onChange={(v) => { setAzimuth(v); setResult(null); }}
          />
          <label>
            比较频率 · Hz
            <input
              aria-label="响应比较频率"
              type="number"
              min="0"
              step="any"
              value={frequency || ""}
              onChange={(e) => { setFrequency(Number(e.target.value)); setResult(null); }}
            />
          </label>
          <label>
            共同频带宽度 · Hz
            <input
              aria-label="响应比较频带宽度"
              type="number"
              min="0"
              step="any"
              value={bandwidth || ""}
              placeholder="自动按最粗频率分辨率"
              onChange={e => { setBandwidth(Number(e.target.value)); setResult(null); }}
            />
          </label>
          <Button
            variant="primary"
            disabled={
              !canWrite ||
              busy ||
              !filter.campaignId ||
              !filter.turbineId ||
              azimuth === "" ||
              frequency <= 0 || bandwidth < 0 || bandwidth >= frequency * 2
            }
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setResult(
                  (
                    await api<any>("measurements/modal", "POST", {
                      campaignId: filter.campaignId,
                      turbineId: filter.turbineId,
                      azimuthDeg: Number(azimuth),
                      frequencyHz: frequency,
                      ...(bandwidth > 0 ? { bandwidthHz: bandwidth } : {}),
                      includeDiagnostic,
                    })
                  ).result,
                );
                await historyLoad();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            计算并保存五点响应
          </Button>
        </div>
        {scoped.some(isDiagnosticMeasurement) && <label className="measurement-diagnostic-note inline-field">
          <input type="checkbox" aria-label="纳入诊断响应" checked={includeDiagnostic} disabled={busy}
            onChange={e => { setIncludeDiagnostic(e.target.checked); setResult(null); setAzimuth(""); }} />
          纳入诊断响应，仅比较幅值，不作为实测振型或健康结论
        </label>}
        <MeasurementStatus
          loading={loading || busy}
          error={error}
          onReload={() => void reload()}
        />
        <p className="hint">
          输入比较频率，或从下方频谱峰选取。所有测点在同一圆周角、同一频带内积分完整频谱；带宽留空时按最粗频率分辨率计算。逐点扫描缺少公共相位，当前提供响应幅值分布。
        </p>
        {available.length > 0 && (
          <p>
            可用频谱峰：
            {[
              ...new Set(
                available.flatMap((r) =>
                  r.features.peaks.map((p: any) => p.frequencyHz),
                ),
              ),
            ]
              .sort((a, b) => a - b)
              .slice(0, 20)
              .map((f) => (
                <Button key={f} variant="ghost" onClick={() => { setFrequency(f); setResult(null); }}>
                  {numberText(f)} Hz
                </Button>
              ))}
          </p>
        )}
      </Card>
      {result && (
        <Card
          title={`${numberText(result.config.frequencyHz)} Hz · ${result.hasDiagnostic ? "诊断" : "五点"}响应分布`}
        >
          {result.hasDiagnostic && <p className="measurement-diagnostic-note">此结果包含诊断记录，不属于正式测量或模态识别结论。缺失测点不补值。</p>}
          <p className="hint">共同频带 {numberText(result.config.bandLowHz)}–{numberText(result.config.bandHighHz)} Hz · 带宽 {numberText(result.config.bandwidthHz)} Hz。位移由同频带速度谱换算，未补足缺失数据。</p>
          <Chart
            label="五点响应幅值与三叶片对比"
            option={{
              tooltip: { trigger: "axis" },
              legend: { data: curves.map((c: any) => c.name) },
              grid: { left: 75, right: 30, top: 50, bottom: 50 },
              xAxis: { type: "category", data: ["P1", "P2", "P3", "P4", "P5"] },
              yAxis: { type: "value", name: "带内 RMS / m/s" },
              series: curves.map((c: any) => ({
                name: c.name,
                type: "line",
                connectNulls: false,
                symbolSize: 8,
                data: c.points.map((p: any) => p.amplitudeMps),
              })),
            }}
          />
          <Table
            headers={[
              "叶片",
              "点位",
              "半径 m",
              "比较频率 Hz",
              "速度 RMS m/s",
              "位移 RMS μm",
              "状态",
            ]}
          >
            {curves.flatMap((c: any) =>
              c.points.map((p: any, i: number) => (
                <tr key={c.bladeId + i}>
                  <td>{c.name}</td>
                  <td>{p.name}</td>
                  <td>{numberText(p.radiusM)}</td>
                  <td>{numberText(p.frequencyHz)}</td>
                  <td>{numberText(p.amplitudeMps, 6)}</td>
                  <td>{numberText(p.rmsDisplacementM == null ? null : p.rmsDisplacementM * 1e6, 3)}</td>
                  <td>{p.reason}</td>
                </tr>
              )),
            )}
          </Table>
          <p className="hint">
            {result.conclusion} 不同风速、转速或频谱窗参数的响应仍需人工核对。
          </p>
        </Card>
      )}
      <Card title="已保存结果">
        <Table headers={["结果", "计算时间", "频率 Hz", "圆周角", "操作"]}>
          {hs.slice(page * 20, (page + 1) * 20).map((r) => (
            <tr key={r.id}>
              <td>{r.name}{r.hasDiagnostic && <small>诊断响应</small>}</td>
              <td>{timeText(r.createdAt)}</td>
              <td>{numberText(r.config.frequencyHz)}</td>
              <td>{r.config.azimuthDeg}°</td>
              <td>
                <Button onClick={() => setResult(r)}>查看</Button>
              </td>
            </tr>
          ))}
        </Table>
        <PageControls page={page} total={hs.length} onChange={setPage} />
      </Card>
    </div>
  );
}
