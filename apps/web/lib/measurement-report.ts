import { buildBladeReportDocx } from './measurement-report-docx';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  WidthType,
} from "docx";
import { audit, HttpError, type User } from "./db";
import { listMeasurementRows } from "./measurement-store";
const n = (v: any, d = 3) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "未提供";
const p = (text: string) => new Paragraph({ text });
export async function measurementReportDocx(user: User, id: string) {
  const report = (await listMeasurementRows(user, "measurement_reports")).find(
    (r) => r.id === id,
  );
  if (!report) throw new HttpError(404, "报告不存在");
  if (Array.isArray(report.bladeAssessments)) {
    const buffer = await buildBladeReportDocx(report);
    await audit(user, "导出叶片测量分析报告", id);
    return {buffer, filename: report.reportNumber + ".docx"};
  }
  const cells = (values: string[]) =>
    new TableRow({
      children: values.map((text) => new TableCell({ children: [p(text)] })),
    });
  const children: any[] = [
    new Paragraph({ text: report.name, heading: HeadingLevel.TITLE }),
    p(`报告编号：${report.reportNumber}`),
    p(`生成：${report.createdAt} · 编制：${report.author}`),
    p(`测量记录：${report.rows.length} 条`),
  ];
  if (report.coverage)
    children.push(p(`来源覆盖：已关联 ${report.coverage.registeredSources} 条，已分析 ${report.coverage.analyzedSources} 条，未纳入 ${report.coverage.unanalyzedSources} 条。`));
  if (report.excludedSources?.length) {
    children.push(new Paragraph({ text: "未纳入分析的来源", heading: HeadingLevel.HEADING_1 }));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [cells(["风机 / 叶片 / 点位", "圆周角°", "原因", "原始记录"]),
        ...report.excludedSources.map((s: any) => cells([
          `${s.names.turbine} / ${s.names.blade} / ${s.names.position}`,
          n(s.azimuthDeg, 1), `${s.reason}${s.reasonCode ? `（${s.reasonCode}）` : ""}`, `${s.reference.kind}:${s.reference.id}`,
        ]))],
    }));
  }
  const groups = new Map<string, any[]>();
  for (const r of report.rows) {
    const k = r.context.turbineId + "|" + r.context.bladeId;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  for (const records of groups.values()) {
    const names = records[0].names;
    children.push(
      new Paragraph({
        text: `${names.farm} / ${names.turbine} / ${names.blade}`,
        heading: HeadingLevel.HEADING_1,
      }),
      p(`测量批次：${names.campaign}`),
    );
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          cells([
            "点位",
            "圆周角° / 半径m",
            "主峰Hz / RMS m/s",
            "频率偏移% / 幅值比",
            "风速m/s / 转速rpm",
            "状态",
          ]),
          ...records.map((r) =>
            cells([
              r.names.position,
              `${n(r.azimuthDeg, 1)} / ${n(r.radiusM)}`,
              `${n(r.peaks[0]?.frequencyHz)} / ${n(r.metrics.rmsVelocityMps, 6)}`,
              `${n(r.assessment.frequencyShiftPercent, 1)} / ${n(r.assessment.amplitudeRatio, 2)}`,
              `${n(r.condition.windSpeed)} / ${n(r.condition.rpm)}`,
              r.diagnosticOnly ? "待复核" : r.assessment.label,
            ]),
          ),
        ],
      }),
    );
    for (const r of records)
      for (const e of r.events || [])
        children.push(
          p(
            `波形异常候选：${r.names.position} / ${n(r.azimuthDeg, 1)}°，${e.label}，有效时间 ${n(e.startSeconds)}–${n(e.endSeconds)} s；原始记录 ${e.sourceRecordingId}，样本 ${e.sourceStartSample}–${e.sourceEndSample}；规则 ${e.rule}。${e.reason}。`,
          ),
        );
    const missing = ["P1", "P2", "P3", "P4", "P5"].filter(
      (code) =>
        !records.some((r) =>
          report.objects.some(
            (o: any) =>
              o.id === r.context.positionId && o.code.toUpperCase() === code,
          ),
        ),
    );
    children.push(
      p(
        `叶片结论：${records.some((r) => !r.diagnosticOnly && r.assessment.status === "suspected") ? "响应异常，待复核" : records.every((r) => !r.diagnosticOnly && r.assessment.status === "within_reference") ? "未触发响应预警" : "健康状态未核验"}。缺失点：${missing.join("、") || "无"}。`,
      ),
    );
  }
  // Enumerate registered but unmeasured blades; silence must not look like healthy.
  for (const blade of report.objects.filter(
    (o: any) =>
      o.kind === "blade" &&
      (!report.turbineId || o.parentId === report.turbineId),
  ))
    if (!report.rows.some((r: any) => r.context.bladeId === blade.id))
      children.push(
        p(
          `${report.objects.find((o: any) => o.id === blade.parentId)?.name || "风机"} / ${blade.name}：未测量。`,
        ),
      );
  const buffer = await Packer.toBuffer(
    new Document({ sections: [{ children }] }),
  );
  await audit(user, "导出真实工况报告", id);
  return { buffer, filename: report.reportNumber + ".docx" };
}
