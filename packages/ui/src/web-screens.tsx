"use client";
import { useEffect, useState } from "react";
import {
  Plus,
  Save,
  Printer,
  FileDown,
  CheckCircle2,
} from "lucide-react";
import { api, type Item, download } from "./api";
import { reportContent, reportSections } from "./report-data";
import { reportDetails, reportTaskFigure } from "./report-details";
import { ReportDataExport } from "./report-export";
import {
  Button,
  Card,
  Select,
  Tag,
  Progress,
  Table,
  Tabs,
  EditDialog,
  Dialog,
  Empty,
  ExportButton,
  saveRecord,
  type ContextProps,
} from "./common";
import { Chart } from "./charts";
export { Health } from "./health-workspace";
export { ModalAnalysis } from "./modal-screen";
export const sections = reportSections;
export function Reports({ data, refresh, notify, canWrite, initialTaskId, onTaskChange }: ContextProps) {
  const [taskId, setTaskId] = useState(initialTaskId || data.tasks[0]?.id || ""),
    [checked, setChecked] = useState(sections),
    [title, setTitle] = useState("旋转叶片测振与损伤检测报告"),
    [conclusion, setConclusion] = useState(
      "演示数据提示频率下降伴振动幅值升高，建议现场检查并由分析人员结合真实数据复核。",
    ),
    [template, setTemplate] = useState(data.templates[0]?.id || ""),
    [editing, setEditing] = useState(false),
    [savedId, setSavedId] = useState("");
  const [branding, setBranding] = useState({ organization: "内蒙古工业大学 新能源学院", reportNumber: "RPT-" + new Date().toISOString().slice(0,10).replaceAll("-", ""), logoData: "", logoAspect: 1 });
  const [headerDraft, setHeaderDraft] = useState<typeof branding | null>(null);
  const [batchIds, setBatchIds] = useState<string[] | null>(null);
  const [batchProgress, setBatchProgress] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const savedReport = data.reports.find((r: Item) => r.id === savedId);
  const reportDirty = !!savedReport && (title !== savedReport.name || conclusion !== savedReport.conclusion || JSON.stringify(checked) !== JSON.stringify(savedReport.sections) ||
    Object.entries(branding).some(([key, value]) => value !== (savedReport[key] ?? (key === "logoAspect" ? 1 : ""))));
  const task =
    savedReport?.taskSnapshot || data.tasks.find((t: Item) => t.id === taskId);
  useEffect(() => { onTaskChange?.(task); }, [task, onTaskChange]);
  const content = reportContent(
    { taskId, sections: checked, conclusion },
    task,
    savedReport?.analysisSnapshots || data.analyses,
  );
  const renderContent = content.map(s => ({ ...s, details: reportDetails(s.title, taskId, savedReport?.analysisSnapshots || data.analyses) }));
  const rawFigure = task ? reportTaskFigure(task) : undefined;
  async function save() {
    if (!taskId) throw Error("请选择任务");
    if (!checked.length) throw Error("至少选择一个报告章节");
    const r = await saveRecord(
      "reports",
      { name: title, taskId, sections: checked, conclusion, source: "demo", ...branding },
      savedId || undefined,
    );
    setSavedId(r.id);
    await refresh();
    return r.id;
  }
  return (
    <div className="stack">
      <Card>
        <div className="toolbar">
          <Select
            label="数据任务"
            value={taskId}
            options={data.tasks.map((t: Item) => ({
              value: t.id,
              label: t.name,
            }))}
            onChange={(v) => {
              setTaskId(v);
              setSavedId("");
            }}
          />
          <Select
            label="报告模板"
            value={template}
            options={data.templates.map((t: Item) => ({
              value: t.id,
              label: t.name,
            }))}
            onChange={(v) => {
              setTemplate(v);
              const chosen = data.templates.find((t: Item) => t.id === v);
              if (chosen) setBranding({ organization: chosen.organization || "内蒙古工业大学 新能源学院", reportNumber: chosen.reportNumber || "RPT", logoData: chosen.logoData || "", logoAspect: chosen.logoAspect || 1 });
              setChecked(
                data.templates.find((t: Item) => t.id === v)?.sections ||
                  sections,
              );
            }}
          />
          <Button disabled={!canWrite} onClick={() => setEditing(true)}>
            <Plus size={14} />
            保存为模板
          </Button>
          <Button disabled={!canWrite} onClick={() => setHeaderDraft({ ...branding })}>抬头 / Logo / 编号配置</Button>
          <Button disabled={!canWrite || !data.tasks.length} onClick={() => { setBatchIds(taskId ? [taskId] : []); setBatchProgress(""); }}>批量生成</Button>
          <Tag tone="amber">{savedReport ? reportDirty ? "历史快照 · 有未保存修改" : "已保存快照" : "实时草稿"}</Tag>
          {savedReport && <Button onClick={() => { setSavedId(""); notify("已切换为当前任务数据的新报告草稿；原报告保持不变"); }}>用当前数据新建</Button>}
        </div>
      </Card>
      <div className="report-grid">
        <Card title="内容与章节">
          <div className="report-sections">
            {sections.map((s) => (
              <label key={s} className={checked.includes(s) ? "active" : ""}>
                <input
                  type="checkbox"
                  checked={checked.includes(s)}
                  onChange={(e) =>
                    setChecked(
                      e.target.checked
                        ? sections.filter((x) => checked.includes(x) || x === s)
                        : checked.filter((x) => x !== s),
                    )
                  }
                />
                {s}
              </label>
            ))}
          </div>
          <label className="form-field space-top">
            <span>报告标题</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="form-field space-top">
            <span>结论与建议</span>
            <textarea
              rows={5}
              value={conclusion}
              onChange={(e) => setConclusion(e.target.value)}
            />
          </label>
          <Button
            className="full space-top"
            disabled={!canWrite}
            variant="primary"
            onClick={async () => {
              try {
                await save();
                notify("报告已保存");
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            <Save size={14} />
            保存报告
          </Button>
          <div className="space-top"><h3>导出报告数据</h3><ReportDataExport key={savedId || taskId} task={task} analyses={savedReport?.analysisSnapshots || data.analyses} report={savedReport} notify={notify} /></div>
        </Card>
        <div className="report-stage">
          <div className="report-preview-scroll" tabIndex={0} aria-label="报告预览，可滚动阅读完整内容">
          <article className="report-paper" id="report-print">
            <div className="paper-brand">
              {branding.logoData && <img src={branding.logoData} alt="报告单位 Logo" className="report-logo" />}
              {branding.organization || "BladeVMS"} <span>{branding.reportNumber || "检测报告"} / DEMO</span>
            </div>
            <h1>{title}</h1>
            <p className="paper-meta">
              任务：{task?.name || "未选择"} ·{" "}
              {new Date(savedReport?.generatedAt || Date.now()).toLocaleDateString("zh-CN")} · 编制：{savedReport?.author || data.user.name}
            </p>
            <div className="paper-warning">
              本报告包含原型演示数据，尚未对接测振设备及 Python 算法。
            </div>
            {renderContent.map((s, i) => (
              <section key={s.title}>
                <h3>
                  {i + 1}. {s.title}
                </h3>
                {s.text && <p className="pre-wrap">{s.text}</p>}
                {s.title === "原始波形" && rawFigure && <figure className="report-figure"><Chart renderer="svg" height={210} label="报告任务波形" option={rawFigure.option} /><figcaption>{rawFigure.caption}</figcaption></figure>}
                {s.rows && (!s.details.length || s.title === "原始波形") && (
                  <Table headers={s.headers!}>
                    {s.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </Table>
                )}
                {s.details.map(detail => <div className="report-analysis" key={detail.id}>
                  <h4>{detail.title}</h4><p className="pre-wrap">{detail.description}</p>
                  {detail.parameters.map((line,index)=><p className="report-parameter" key={index}>{line}</p>)}
                  {detail.figure && <figure className="report-figure"><Chart renderer="svg" height={210} label={`报告分析图 ${detail.id}`} option={detail.figure.option}/><figcaption>{detail.figure.caption}</figcaption></figure>}
                  {detail.tables?.map((table, group)=><div className="report-data-table" key={group}>{table.caption && <p className="report-table-caption">{table.caption}</p>}<Table headers={table.headers}>{table.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</Table></div>)}
                  {detail.rows && <p>{detail.tableNote}</p>}
                </div>)}
              </section>
            ))}
            <footer>
              三维台架结构力学特征测试系统 · 原始任务引用 {taskId}
            </footer>
          </article>
          </div>
          <div className="toolbar print-actions">
            <Button
              disabled={!canWrite && (!savedReport || reportDirty)}
              onClick={async () => {
                try {
                  const id = savedReport && !reportDirty ? savedReport.id : await save();
                  const saved = await download("export/reports/" + id + "?format=docx");
                  notify(saved ? "Word 报告已导出" : "已取消导出，报告记录已保存");
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              <FileDown size={14} />
              导出 Word
            </Button>
            <Button onClick={() => window.print()}>
              <Printer size={14} />
              打印 / 导出 PDF
            </Button>
            <Tag tone="gray">A4 版式</Tag>
          </div>
        </div>
      </div>
      <Card
        title="已保存报告"
        tools={<ExportButton kind="reports" notify={notify} />}
      >
        <Table headers={["报告", "数据任务", "章节数", "操作"]}>
          {data.reports.map((r: Item) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>
                {r.taskSnapshot?.name || data.tasks.find((t: Item) => t.id === r.taskId)?.name ||
                  r.taskId}
              </td>
              <td>{r.sections?.length}</td>
              <td>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTitle(r.name);
                    setTaskId(r.taskId);
                    setChecked(r.sections);
                    setConclusion(r.conclusion);
                    setSavedId(r.id);
                    setBranding({ organization: r.organization || "", reportNumber: r.reportNumber || "", logoData: r.logoData || "", logoAspect: r.logoAspect || 1 });
                    notify("报告已加载到预览");
                  }}
                >
                  加载
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    download("export/reports/" + r.id + "?format=docx").catch(
                      (e) => notify(e.message),
                    )
                  }
                >
                  Word
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        {!data.reports.length && <Empty text="尚未保存报告" />}
      </Card>
      {headerDraft && <Dialog title="抬头 / Logo / 编号配置" onClose={() => setHeaderDraft(null)}>
        <label className="form-field"><span>报告单位抬头</span><input maxLength={120} value={headerDraft.organization} onChange={(e) => setHeaderDraft({ ...headerDraft, organization: e.target.value })} /></label>
        <label className="form-field space-top"><span>报告编号 / 批量编号前缀</span><input maxLength={100} value={headerDraft.reportNumber} onChange={(e) => setHeaderDraft({ ...headerDraft, reportNumber: e.target.value })} /></label>
        <label className="form-field space-top"><span>单位 Logo（PNG / JPEG，不超过 250KB）</span><input type="file" accept="image/png,image/jpeg" onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 250000) throw Error("请选择不超过 250KB 的 PNG / JPEG 图片");
            const logoData = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(Error("图片读取失败")); reader.readAsDataURL(file); });
            const logoAspect = await new Promise<number>((resolve, reject) => { const picture = new Image(); picture.onload = () => resolve(picture.naturalWidth / picture.naturalHeight); picture.onerror = () => reject(Error("图片无法解码")); picture.src = logoData; });
            if (logoAspect < 0.1 || logoAspect > 10) throw Error("Logo 宽高比应为 1:10 至 10:1");
            setHeaderDraft((previous) => previous ? { ...previous, logoData, logoAspect } : null);
          } catch (error) { notify((error as Error).message); }
        }} /></label>
        {headerDraft.logoData && <div className="toolbar space-top"><img className="report-logo" src={headerDraft.logoData} alt="待应用的单位 Logo" /><Button onClick={() => setHeaderDraft({ ...headerDraft, logoData: "", logoAspect: 1 })}>移除 Logo</Button></div>}
        <p className="hint">应用到当前报告；如需复用，请再点击“保存为模板”。Logo 只随报告保存，不会发送到外部服务。</p>
        <div className="dialog-actions"><Button variant="primary" onClick={() => { setBranding(headerDraft); setHeaderDraft(null); }}>应用配置</Button></div>
      </Dialog>}
      {batchIds && <Dialog title="批量生成报告" onClose={() => { if (!batchBusy) setBatchIds(null); }}>
        <p className="hint">每个任务单独保存报告和数据快照，沿用当前章节、抬头、Logo 与结论。最多 50 个任务。</p>
        <div className="report-sections">{data.tasks.map((t: Item) => <label key={t.id}><input type="checkbox" disabled={batchBusy} checked={batchIds.includes(t.id)} onChange={(e) => setBatchIds(e.target.checked ? [...batchIds, t.id] : batchIds.filter((id) => id !== t.id))} />{t.name}</label>)}</div>
        <p role="status">{batchProgress || `已选择 ${batchIds.length} 个任务`}</p>
        <div className="dialog-actions"><Button disabled={batchBusy || !batchIds.length || batchIds.length > 50 || !checked.length} variant="primary" onClick={async () => {
          setBatchBusy(true);
          let completed = 0;
          const pending = [...batchIds];
          try {
            for (const id of pending) {
              const taskName = data.tasks.find((t: Item) => t.id === id)?.name || id;
              await saveRecord("reports", { name: `${title} / ${taskName}`.slice(0,200), taskId: id, sections: checked, conclusion, source: "demo", ...branding, reportNumber: `${branding.reportNumber}-${Date.now().toString(36)}-${String(completed + 1).padStart(3,"0")}` });
              completed++;
              setBatchIds((ids) => ids?.filter((value) => value !== id) || []);
              setBatchProgress(`已生成 ${completed} / ${pending.length} 份报告`);
            }
            await refresh();
            notify(`已保存 ${completed} 份报告，可在下方列表加载或导出`);
          } catch (error) { setBatchProgress(`已生成 ${completed} 份，剩余任务可重试：${(error as Error).message}`); await refresh(); }
          finally { setBatchBusy(false); }
        }}>{batchBusy ? "正在生成…" : "生成并保存"}</Button></div>
      </Dialog>}
      {editing && (
        <EditDialog
          title="保存报告模板"
          initial={{ name: "自定义模板" }}
          fields={[{ key: "name", label: "模板名称", required: true }]}
          onClose={() => setEditing(false)}
          onSave={async (v) => {
            if (!checked.length) throw Error("请至少选择一个章节");
            const t = await saveRecord("templates", {
              ...v,
              ...branding,
              sections: checked,
            });
            await refresh();
            setTemplate(t.id);
            notify("模板已保存");
          }}
        />
      )}
    </div>
  );
}
