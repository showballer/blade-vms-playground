"use client";
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
  selectedProcessingResult,
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
      if(request===generation.current){setReports(r.reports);setTotal(r.total);}
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
        <p>按测量批次生成工况报告，保留对象、点位与算法结果快照。</p>
      </header>
      <Card title="报告范围">
        <ObjectFilters
          objects={data.objects}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(0);
          }}
          blade={false}
        />
        <Button
          variant="primary"
          disabled={!canWrite || !filter.campaignId || busy || loading}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const r = await api<any>("measurements/blade-report", "POST", {
                campaignId: filter.campaignId,
                processingResultId:selectedProcessingResult(filter),
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
          生成逐叶片报告
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
          请选择批次与风机。报告保存三片叶片的覆盖、处理及评价版本；未测和缺项明确列出。
        </p>
      </Card>
      <Card title="已保存报告">
        <Table headers={["编号", "名称", "生成时间", "点位记录", "操作"]}>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{r.reportNumber}</td>
              <td>{r.name}{r.staleEvaluation&&<small>工况已更新，原报告快照保留</small>}</td>
              <td>{timeText(r.createdAt)}</td>
              <td>{r.processingSnapshots?.reduce((n:number,s:any)=>n+s.records.length,0)??r.rows.length}{r.coverage && <small>来源 {r.coverage.analyzedSources}/{r.coverage.registeredSources} 条已分析</small>}</td>
              <td>
                <Button onClick={() => setSelected(r)}>查看</Button>
                <Button disabled={busy} onClick={() => void docx(r)}>
                  导出 Word
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        <PageControls page={page} total={total} onChange={setPage} />
      </Card>
      {selected && (
        <Dialog title={selected.name} wide onClose={() => setSelected(null)}>
          <div className="measurement-workspace">
            <p>
              {selected.reportNumber} · {timeText(selected.createdAt)} ·{" "}
              {selected.author}
            </p>
            <p>{selected.conclusion}</p>{selected.staleEvaluation&&<p className="measurement-diagnostic-note">工况已更新。本报告保持生成时的快照；需要当前结论时请更新评价并生成新报告。</p>}
            {selected.bladeAssessments&&<Table headers={["叶片","结论","可分析 / 采到","处理 / 评价版本","主要依据"]}>{selected.bladeAssessments.map((b:any)=><tr key={b.bladeId||b.name}><td>{b.name}</td><td>{b.label}</td><td>{b.coverage?`${b.coverage.analyzable} / ${b.coverage.observed}`:"未测"}</td><td>{b.processingResultId?.slice(0,8)||"—"} / {b.assessmentId?.slice(0,8)||"—"}</td><td>{b.reasons?.join("；")}</td></tr>)}</Table>}
            {selected.snapshotHash&&<p className="hint">快照校验 {selected.snapshotHash} · 生成后不随工况或处理版本修改</p>}
            {selected.coverage && <p className={selected.coverage.complete ? "hint" : "measurement-diagnostic-note"}>
              来源覆盖：已关联 {selected.coverage.registeredSources} 条 · 已分析 {selected.coverage.analyzedSources} 条 · 未纳入 {selected.coverage.unanalyzedSources} 条。
              {!selected.coverage.complete && " 存在缺失观测，不能视为完整一圈。"}
            </p>}
            {(selected.hasDiagnostic || selected.rows.some(isDiagnosticMeasurement)) && <p className="measurement-diagnostic-note">
              含诊断数据：相关波形与频谱仅用于复核，不计为正式健康结论或正常参考。
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
            <div className="measurement-toolbar">
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
