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
import { Chart, lineOption, HealthGauge } from "./charts";
import { Signal } from "./desktop-screens";
import { defaultThresholds, healthDemoDamage, healthDemoMetrics, healthMetricSummary, healthLevels, validateThresholds, type HealthConfig } from "./health-data";
import { HealthTrends } from "./health-trends";
import { BaselineManager } from "./baseline-manager";
import { baselineHealthIssue } from "./baseline-data";
export function Health(props: ContextProps) {
  const { data, refresh, notify, canWrite, go, onTaskChange } = props;
  const [object, setObject] = useState(
      data.baselines.find((b: Item) => b.status !== "disabled")?.object || "",
    ),
    [baselineId, setBaselineId] = useState(data.baselines.find((b: Item) => b.status !== "disabled")?.id || ""),
    [edit, setEdit] = useState<"threshold" | "review" | "levels" | null>(null),
    [trace, setTrace] = useState(false),
    [saliency, setSaliency] = useState(false),
    [running, setRunning] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [manageBaselines, setManageBaselines] = useState(false);
  const [configState, setConfigState] = useState<{ baselineId: string; config?: HealthConfig; error?: string } | null>(null);
  const baseline =
    data.baselines.find(
      (b: Item) => b.id === baselineId && b.object === object && b.status !== "disabled",
    );
  const b = baseline;
  const matchingTasks = data.tasks.filter((t: Item) => t.object === object && t.recordTenant === baseline?.recordTenant);
  const task = matchingTasks.find((t: Item) => t.id === taskId) || matchingTasks[0];
  useEffect(() => { onTaskChange?.(task); }, [task, onTaskChange]);
  useEffect(() => {
    if (!baseline) return;
    let canceled = false;
    api<HealthConfig>("health/thresholds?baselineId=" + encodeURIComponent(baseline.id))
      .then(config => { if (!canceled) setConfigState({ baselineId: baseline.id, config }); })
      .catch(error => { if (!canceled) setConfigState({ baselineId: baseline.id, error: error.message }); });
    return () => { canceled = true; };
  }, [baseline?.id, data.user.id, data.settings]);
  const config = configState?.baselineId === baseline?.id ? configState?.config : undefined;
  const configError = configState?.baselineId === baseline?.id ? configState?.error : undefined;
  const settings = config?.values;
  const other = object !== "风机叶片A",
    rms = +(b?.rms * (other ? 1.05 : 1.28)).toFixed(2),
    freq = +(b?.frequency * (other ? 0.996 : 0.958)).toFixed(3);
  const alerts = data.alerts.filter((a: Item) => task && a.taskId === task.id);
  const metrics = healthDemoMetrics(b || {}, settings);
  const summary = healthMetricSummary(metrics), grade = summary.grade;
  const damage = healthDemoDamage(b || {});
  async function saveThresholds(values: Record<string, any>) {
    if (!config || !baseline) throw Error("请先加载当前组阈值");
    const response = await api<HealthConfig>("health/thresholds?baselineId=" + encodeURIComponent(baseline.id), "PUT", { revision: config.revision, values: validateThresholds(values) });
    setConfigState({ baselineId: baseline.id, config: response });
    await refresh(); notify("当前组阈值与分级规则已保存");
  }
  const baselineManager = manageBaselines && <BaselineManager data={data} refresh={refresh} notify={notify} purpose="health" task={task} onClose={() => setManageBaselines(false)} onSelect={b => { setObject(b.object); setBaselineId(b.id); }} />;
  if (baselineHealthIssue(baseline))
    return <div className="stack"><Card title="健康监测" tools={<Button onClick={() => setManageBaselines(true)}>基线管理</Button>}><Empty text="当前组暂无有效健康基线，不能显示健康度或诊断结论。请先配置基线。" /><p className="muted">{baseline ? baselineHealthIssue(baseline) : "所选基线未登记、已停用或已删除，请在基线管理中明确选择有效记录。"}</p></Card><HealthTrends {...props} />{baselineManager}</div>;
  return (
    <div className="stack health-screen">
      <Card>
        <div className="toolbar">
          <Select
            label="监测对象"
            options={
              [
                ...new Set(data.baselines.filter((b: Item) => b.status !== "disabled").map((b: Item) => b.object)),
              ] as string[]
            }
            value={object}
            onChange={(v) => {
              setObject(v);
              setBaselineId(
                data.baselines.find((b: Item) => b.object === v && b.status !== "disabled")?.id || "",
              );
            }}
          />
          <Select
            label="基线"
            options={data.baselines
              .filter((b: Item) => b.object === object && b.status !== "disabled")
              .map((b: Item) => ({ value: b.id, label: `${b.name}${data.user.role === "admin" && b.recordTenant ? " · " + b.recordTenant : ""}` }))}
            value={baselineId}
            onChange={setBaselineId}
          />
          <Select label="关联任务" value={task?.id || ""} options={matchingTasks.map((t: Item) => ({ value: t.id, label: t.name }))} onChange={setTaskId} />
          <Button onClick={() => setManageBaselines(true)}>基线管理</Button>
          <Tag tone="amber">演示监测</Tag>
          <Button
            className="push"
            variant="cyan"
            disabled={!canWrite || running || !task}
            onClick={async () => {
              setRunning(true);
              try {
                await saveRecord("analyses", {
                  name: "损伤检测演示 · " + object,
                  taskId: task.id,
                  type: "damage",
                  parameters: { object, baseline: baseline.id, baselineSnapshot: { id: baseline.id, name: baseline.name, rms: baseline.rms, frequency: baseline.frequency, modal: baseline.modal }, thresholds: config || null },
                  result: { ...damage, metrics, overallGrade: summary.label },
                  source: "demo",
                });
                await refresh();
                notify("已保存演示检测记录；未调用外部算法");
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setRunning(false);
              }
            }}
          >
            {running ? "保存中…" : "重新运行演示检测"}
          </Button>
        </div>
        {!task && <p className="muted">当前对象没有可访问任务，检测保存、溯源与报告不可用。指标与趋势仍仅为原型演示样例。</p>}
      </Card>
      <div className="workspace-grid health-grid">
        <div className="stack">
          <div className="metrics">
            <Card className="metric">
              <span>健康度</span>
              <HealthGauge score={b.score} />
              <small>/100</small>
            </Card>
            <Card
              className={"metric " + (grade === null ? "" : grade === 0 ? "good-metric" : "warning-metric")}
            >
              <span>预警级别</span>
              <strong className={grade === null ? "muted" : grade === 3 ? "red-text" : grade ? "orange-text" : "green-text"} data-testid="health-overall-grade">
                {summary.label}
              </strong>
              <small>已判定指标的最高等级 · {summary.configured}/{summary.total} 项</small>
            </Card>
            <Card className="metric">
              <span>损伤置信度</span>
              <strong className="mono">{b.confidence.toFixed(2)}</strong>
              <Progress value={b.confidence * 100} color="orange" />
              <small>演示模型输出</small>
            </Card>
          </div>
          <Card
            title="振动响应特征监测"
            tools={<span className="muted">对比正常态基线 · 演示分析</span>}
          >
            <div className="feature-summary">
              {[
                [
                  "振动幅值 (RMS)",
                  rms,
                  "mm/s",
                  `基线 ${b.rms} · 峰值 ${metrics.find(m => m.key === "peak")!.value}`,
                  other ? "+5%" : "+28%",
                  "blue",
                ],
                [
                  "频率成分（主频）",
                  freq,
                  "Hz",
                  `基线 ${b.frequency} · fb 偏移 +6%`,
                  other ? "−0.4%" : "−4.2%",
                  "red",
                ],
                [
                  "模态参数 (f1/ζ1)",
                  +(b.modal * 0.967).toFixed(3),
                  "Hz",
                  "阻尼比 1.2% → 1.6%",
                  "−3.3%",
                  "purple",
                ],
              ].map(([name, value, unit, note, change, color]) => (
                <div
                  className={"feature-summary-card " + color}
                  key={String(name)}
                >
                  <span>{name}</span>
                  <div>
                    <strong className="mono">{value}</strong>
                    <small>{unit}</small>
                    <em>{change}</em>
                  </div>
                  <small>{note}</small>
                </div>
              ))}
            </div>
            <div className="health-extra-metrics" data-testid="health-extra-metrics">
              {metrics.filter(m => ["peak", "peakToPeak", "mainAmplitude", "band"].includes(m.key)).map(m => <div key={m.key}>
                <span>{m.name}</span><strong className="mono">{m.value} <small>{m.unit}</small></strong>
              </div>)}
            </div>
            <p className="muted">a.u. 为演示任意单位；数据仅用于界面与阈值验证，未计算任务波形。</p>
          </Card>
          <HealthTrends {...props} task={task} baseline={baseline} config={config} />
          <Card title="关联任务告警复核">
            <div className="toolbar">
              <span className="muted">告警处置状态（非信号剔除）</span>
              {alerts.slice(0, 2).map((a: Item) => (
                <Tag key={a.id} tone={a.level === "预警" ? "red" : "amber"}>
                  {a.metric} · {a.status}
                </Tag>
              ))}
              <Button
                className="push"
                disabled={!canWrite || !alerts.length}
                onClick={() => setEdit("review")}
              >
                人工复核标记
              </Button>
            </div>
          </Card>
        </div>
        <aside className="stack">
          <Card title="分级预警面板">
            <Table headers={["指标", "阈值", "当前", "状态"]}>
              {metrics.map(({ key, name, unit, limit, value, grade: metricGrade }) => (
                <tr key={key} data-testid={"health-metric-" + key}>
                  <td>{name}<small className="health-metric-unit">{unit}</small></td>
                  <td className="mono">{limit ?? "—"}</td>
                  <td className="mono">{value}</td>
                  <td>
                    <Tag tone={metricGrade == null ? "gray" : metricGrade === 3 ? "red" : metricGrade ? "amber" : "green"}>
                      {metricGrade == null ? "未判定" : healthLevels[metricGrade]}
                    </Tag>
                  </td>
                </tr>
              ))}
            </Table>
            <p className="muted" data-testid="health-threshold-coverage">{summary.configured}/{summary.total} 项已判定。{!summary.complete && "未配置项不视为正常。"}</p>
            {(configError || !config || config.status === "missing" || config.status === "invalid") && <p className="muted">{configError ? `阈值读取失败：${configError}` : !config ? "正在读取当前组阈值…" : config.status === "missing" ? "当前组未配置阈值。" : "当前组阈值无效，请管理员修正。"}</p>}
            <details className="health-explanation">
              <summary>阈值与分级说明{config?.status === "legacy" ? " · 旧配置待确认" : ""}</summary>
            <p className="muted" data-testid="health-config-status">{configError ? `阈值读取失败：${configError}` : !config ? "正在读取当前组阈值…" : config.status === "missing" ? "当前组未配置阈值，不使用其他组或默认值。" : config.status === "invalid" ? "当前组阈值无效，请管理员修正。" : `${config.tenant} · ${config.status === "legacy" ? "旧配置兼容：注意比例暂为预警比例的 75%，请管理员确认。" : "已保存配置"}`}</p>
            {settings && <p className="muted">注意 ≥ {(settings.attentionRatio * 100).toFixed(0)}% · 预警 ≥ {(settings.warningRatio * 100).toFixed(0)}% · 报警 ≥ 100%（报警阈值）</p>}
              <p className="muted">未配置项不参与最高等级汇总；主频偏移按绝对值分级。</p>
            </details>
            <div className="toolbar space-top">
              <Button onClick={async () => { try { setConfigState(null); await refresh(); } catch (error) { notify((error as Error).message); } }}>刷新阈值</Button>
              <Button
                disabled={data.user.role !== "admin" || !config}
                onClick={() => setEdit("threshold")}
              >
                阈值设置
              </Button>
              <Button
                disabled={data.user.role !== "admin" || !config}
                onClick={() => setEdit("levels")}
              >
                自定义分级
              </Button>
            </div>
          </Card>
          <Card
            title="专项损伤检测算法"
            className="damage-card"
            tools={<Tag tone="amber">未接入</Tag>}
          >
            <div className="toolbar compact">
              <Tag>叶尖裂纹-CNN v3.0</Tag>
              <Tag tone="purple">特征 + XGBoost</Tag>
            </div>
            <dl className="key-values">
              <dt>损伤类型</dt>
              <dd className="orange-text">
                {damage.label}
              </dd>
              <dt>严重程度</dt>
              <dd>{damage.severity}</dd>
              <dt>置信度</dt>
              <dd>{b.confidence}</dd>
              <dt>损伤定位</dt>
              <dd>
                {damage.location}{" "}
                <button className="text-link" onClick={() => setSaliency(true)}>
                  查看显著区
                </button>
              </dd>
              <dt>判据来源</dt>
              <dd>{damage.criterion}</dd>
            </dl>
            <p className="note-box">
              {damage.conclusion}
            </p>
            <div className="toolbar">
              <Button disabled={!task} onClick={() => setTrace(true)}>一键溯源</Button>
              <Button
                disabled={!canWrite || !alerts.length}
                onClick={() => setEdit("review")}
              >
                加入复核
              </Button>
              <Button disabled={!task} onClick={() => go("report", { taskId: task.id })}>导报告</Button>
            </div>
          </Card>
        </aside>
      </div>
      {baselineManager}
      {edit === "threshold" && (
        <EditDialog
          title="预警阈值设置"
          initial={settings || defaultThresholds}
          fields={[
            {
              key: "rms",
              label: "RMS 报警阈值 mm/s",
              type: "number",
              min: 0.001,
              required: true,
            },
            {
              key: "frequency",
              label: "主频偏移绝对值 %",
              type: "number",
              min: 0.001,
              required: true,
            },
            {
              key: "band",
              label: "频带能量阈值",
              type: "number",
              min: 0.001,
              required: true,
            },
            ...[{ key: "peak", label: "峰值报警阈值 mm/s（可留空）" }, { key: "peakToPeak", label: "峰峰值报警阈值 mm/s（可留空）" }, { key: "mainAmplitude", label: "主频幅值报警阈值 mm/s（可留空）" }].map(f => ({ ...f, type: "number" as const, min: .001, emptyAsUndefined: true, placeholder: "留空表示未配置，不按正常处理" })),
          ]}
          onClose={() => setEdit(null)}
          onSave={async (v) => {
            await saveThresholds({ ...(settings || defaultThresholds), ...v });
          }}
        />
      )}
      {edit === "levels" && (
        <EditDialog
          title="分级规则"
          initial={settings || defaultThresholds}
          fields={[
            { key: "attentionRatio", label: "注意占报警阈值的比例（小于预警）", type: "number", min: .001, max: .998, required: true },
            {
              key: "warningRatio",
              label: "预警占报警阈值的比例（0~1）",
              type: "number",
              min: 0.01,
              max: 0.99,
              required: true,
            },
          ]}
          onClose={() => setEdit(null)}
          onSave={async (v) => {
            await saveThresholds({ ...(settings || defaultThresholds), ...v });
          }}
        />
      )}
      {edit === "review" && (
        <EditDialog
          title="人工复核"
          initial={{ alertId: alerts[0]?.id, status: "已确认", reviewNote: "" }}
          fields={[
            {
              key: "alertId",
              label: "预警",
              type: "select",
              options: alerts.map((a: Item) => ({
                value: a.id,
                label: a.name,
              })),
              required: true,
            },
            {
              key: "status",
              label: "复核结果",
              type: "select",
              options: ["待复核", "已确认", "已关闭"],
              required: true,
            },
            {
              key: "reviewNote",
              label: "复核意见",
              type: "textarea",
              required: true,
            },
          ]}
          onClose={() => setEdit(null)}
          onSave={async (v) => {
            if (!v.reviewNote?.trim()) throw Error("请填写复核意见");
            await saveRecord(
              "alerts",
              { status: v.status, reviewNote: v.reviewNote },
              v.alertId,
            );
            await refresh();
            notify("复核结果已保存");
          }}
        />
      )}
      {trace && task && (
        <Dialog
          title="原始任务溯源 · 波形 / 频谱"
          wide
          onClose={() => setTrace(false)}
        >
          <p className="muted">任务：{task.name} · {task.id}；频谱仍为演示样例，时域显示任务原始波形。</p>
          <Signal {...props} data={{ ...data, tasks: [task] }} initialTaskId={task.id} canWrite={false} />
        </Dialog>
      )}
      {saliency && (
        <Dialog title="损伤定位说明" onClose={() => setSaliency(false)}>
          <p className="dialog-message">
            原型样例定位为 P2
            叶中区域。显著性图依赖外部模型输出，本阶段未对接，不显示伪造的定位图。
          </p>
        </Dialog>
      )}
    </div>
  );
}
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
