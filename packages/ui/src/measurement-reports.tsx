"use client";
import { MeasurementReportPreview } from "./measurement-report-preview";
import React, { useEffect, useState, useRef } from "react";
import { api, saveBlob } from "./api";
import { Button, Card, Dialog, Table } from "./common";
import {
  MeasurementStatus,
  ObjectFilters,
  numberText,
  PageControls,
  RiskTag,
  timeText,
  useMeasurements,
  useMeasurementContext,
  selectedBladeProcessingResults,
} from "./measurement-common";
import { isDiagnosticMeasurement, type MeasurementContext } from "./measurement-domain";
export function MeasurementReports({ canWrite }: { canWrite: boolean }) {
  const { data, loading, error, setError, reload } = useMeasurements();
  const [filter, setFilter] = useMeasurementContext();
  const
    [reports, setReports] = useState<any[]>([]),
    [page, setPage] = useState(0),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<any>(null);
  const generation=useRef(0);
  async function load() {
    const request=++generation.current;
    setBusy(true);
    try {
      const q = new URLSearchParams({
        offset: String(page * 20),
        campaignId: filter.campaignId || "",
        turbineId: filter.turbineId || "",
      });
      const r = await api<any>("measurements/reports?" + q);
      if(request===generation.current){setReports(r.reports);setTotal(r.total);setError("");}
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if(request===generation.current)setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [page, filter.campaignId, filter.turbineId]);
  async function docx(r: any) {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/measurements/report-download/${r.id}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) {
        if(response.status===401)window.dispatchEvent(new Event("blade-session-expired"));
        const e = await response.json();
        throw Error(e.error || "导出失败");
      }
      await saveBlob(await response.blob(), r.reportNumber + ".docx");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack measurement-workspace">
      <header>
        <h1>报告导出</h1>
        <p>导出健康监测的测量结果、叶片图表和结论摘要。</p>
      </header>
      <Card title="报告范围">
        <ObjectFilters
          objects={data.objects}
          memberships={data.memberships}
          loading={loading}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(0);
          }}
          blade={false}
          position={false}
        />
        <Button
          variant="primary"
          disabled={!canWrite || !filter.campaignId || !filter.turbineId || busy || loading}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const r = await api<any>("measurements/blade-report", "POST", {
                campaignId: filter.campaignId,
                processingResultIds:selectedBladeProcessingResults(filter,data.objects),
                turbineId: filter.turbineId || null,
              });
              setSelected(r.report);
              await load();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          生成测量报告
        </Button>
        <MeasurementStatus
          loading={loading || busy}
          error={error}
          onReload={() => {
            void reload();
            void load();
          }}
        />
        <p className="hint">
          选择测量批次和风机后生成报告。
        </p>
      </Card>
      <Card title="已保存报告">
        <Table headers={["编号", "名称", "生成时间", "点位记录", "操作"]}>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{r.reportNumber}</td>
              <td>{r.name}{r.staleEvaluation&&<small>工况已更新，原报告快照保留</small>}</td>
              <td>{timeText(r.createdAt)}</td>
              <td>{r.processingSnapshots?.reduce((n:number,s:any)=>n+s.records.length,0)??(r.rows?.length || 0)}{r.coverage && <small>来源 {r.coverage.analyzedSources}/{r.coverage.registeredSources} 条已分析</small>}</td>
              <td>
                <div className="measurement-toolbar"><Button onClick={() => setSelected(r)}>查看</Button>
                <Button disabled={busy} onClick={() => void docx(r)}>
                  导出 Word
                </Button></div>
              </td>
            </tr>
          ))}
        </Table>
        {error?<p role="alert">报告列表读取失败，不能据此判断没有报告。请重试。</p>:<PageControls page={page} total={total} onChange={setPage} />}
      </Card>
      {selected && (
        <Dialog title={selected.name} wide onClose={() => setSelected(null)}>
          <div className="measurement-workspace">
            {selected.bladeAssessments ? <MeasurementReportPreview report={selected}/> : <>
            <p>
              {selected.reportNumber} · {timeText(selected.createdAt)} ·{" "}
              {selected.author}
            </p>
            {selected.staleEvaluation&&<p className="hint">工况已更新 · 当前显示已保存报告</p>}
            {selected.coverage && <p className={selected.coverage.complete ? "hint" : "measurement-diagnostic-note"}>
              来源覆盖：已关联 {selected.coverage.registeredSources} 条 · 已分析 {selected.coverage.analyzedSources} 条 · 未纳入 {selected.coverage.unanalyzedSources} 条。
            </p>}
            <Table
              headers={[
                "风场 / 风机",
                "叶片 / 点位",
                "测量时间",
                "角度 / 半径",
                "主峰 / RMS",
                "风速 / 转速",
                "判定",
              ]}
            >
              {selected.rows.map((r: any) => (
                <tr key={r.id}>
                  <td>
                    {r.names.farm} / {r.names.turbine}
                  </td>
                  <td>
                    {r.names.blade} / {r.names.position}
                    {isDiagnosticMeasurement(r) && <small>诊断记录</small>}
                  </td>
                  <td>{timeText(r.measuredAt)}</td>
                  <td>
                    {numberText(r.azimuthDeg, 1)}° / {numberText(r.radiusM)} m
                  </td>
                  <td>
                    {numberText(r.peaks[0]?.frequencyHz)} Hz /{" "}
                    {numberText(r.metrics.rmsVelocityMps, 6)} m/s
                  </td>
                  <td>
                    {numberText(r.condition.windSpeed)} m/s /{" "}
                    {numberText(r.condition.rpm)} rpm
                  </td>
                  <td>
                    <RiskTag assessment={r.assessment} />
                  </td>
                </tr>
              ))}
            </Table>
            {!!selected.excludedSources?.length && <section>
              <h3>未纳入分析的来源</h3>
              <Table headers={["风机", "叶片 / 点位", "圆周角", "未纳入原因"]}>
                {selected.excludedSources.map((source: any) => <tr key={source.key}>
                  <td>{source.names?.turbine || "—"}</td>
                  <td>{source.names?.blade || "—"} / {source.names?.position || "—"}</td>
                  <td>{numberText(source.azimuthDeg, 1)}°</td>
                  <td>{source.reason}</td>
                </tr>)}
              </Table>
            </section>}
            </>}
            <div className="measurement-toolbar health-report-actions">
              <Button
                disabled={busy}
                variant="primary"
                onClick={() => void docx(selected)}
              >
                导出 Word
              </Button>
              <Button
                onClick={() =>
                  void saveBlob(
                    new Blob([JSON.stringify(selected, null, 2)], {
                      type: "application/json",
                    }),
                    selected.reportNumber + ".json",
                  )
                }
              >
                导出追溯数据
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
