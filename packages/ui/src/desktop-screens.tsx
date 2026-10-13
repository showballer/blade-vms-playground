"use client";
import { CustomSelect } from "./custom-select";
import { useEffect, useMemo, useState } from "react";
import {
  Camera,
  Pause,
  Play,
  Square,
  Plus,
  Upload,
  Save,
  Trash2,
  RefreshCw,
  ScanLine,
  ChartNoAxesCombined,
  ShieldCheck,
} from "lucide-react";
import { api, type Item } from "./api";
import { ImportDialog } from "./import-dialog";
import { TaskMetadataDialog } from "./task-metadata-dialog";
import { playbackWindow } from "./playback";
import { BatchDialog } from "./batch-dialog";
import { createDemoSnapshot } from "./demo-snapshot";
import { signalDataset, signalFeatures } from "./signal-data";
import { signalChoices, signalKey, signalWaveDataset, signalWaveOption, signalInputMetadata, signalRevision, signalWorkflow, validateSignalTimeFrequencyParameters } from "./signal-input";
import { SignalCompare } from "./signal-compare";
import { ResultExport, SavedResultDialog } from "./result-export";
import {
  Button,
  Card,
  Select,
  Tag,
  Progress,
  Table,
  Filter,
  Tabs,
  EditDialog,
  Confirm,
  Dialog,
  Empty,
  ExportButton,
  saveRecord,
  type ContextProps,
  type Field,
} from "./common";
import {
  Chart,
  lineOption,
  stackedWave,
  spectrumOption,
  heatOption,
  waveSamples,
} from "./charts";
const taskFields: Field[] = [
  { key: "name", label: "任务名", required: true },
  { key: "object", label: "测试对象", required: true },
  { key: "turbine", label: "风机编号", required: true },
  {
    key: "point",
    label: "测点",
    type: "select",
    options: ["P1 叶根", "P2 叶中", "P3 叶尖"],
    required: true,
  },
  {
    key: "direction",
    label: "方向",
    type: "select",
    options: ["径向", "轴向", "切向"],
  },
  { key: "blades", label: "叶片数 Z", type: "number", min: 1, required: true },
  { key: "rpm", label: "转速 rpm", type: "number", min: 0, required: true },
  {
    key: "sampleRate",
    label: "采样率 Hz",
    type: "number",
    min: 1,
    required: true,
  },
  { key: "duration", label: "时长 s", type: "number", min: 0, required: true },
  {
    key: "condition",
    label: "运行状态",
    type: "select",
    options: ["稳定运行", "升速", "降速", "停机"],
  },
  { key: "note", label: "工况备注", type: "textarea" },
];
const defaultTask = {
  name: "叶片A-新工况",
  object: "风机叶片A",
  turbine: "WT-03",
  point: "P3 叶尖",
  direction: "径向",
  rpm: 15,
  blades: 3,
  sampleRate: 25600,
  range: 10,
  duration: 120,
  status: "本地",
  condition: "稳定运行",
  note: "",
  source: "demo",
};
export function Acquisition({
  data,
  refresh,
  notify,
  canWrite,
  go,
  onTaskChange,
}: ContextProps) {
  const tasks = data.tasks as Item[];
  const [selected, setSelected] = useState(tasks[0]?.id || ""),
    [form, setForm] = useState<Record<string, any>>(tasks[0] || defaultTask),
    [query, setQuery] = useState(""),
    [checked, setChecked] = useState<string[]>([]),
    [editing, setEditing] = useState<Item | Record<string, any> | null>(null),
    [deleting, setDeleting] = useState<Item | null>(null),
    [connected, setConnected] = useState(false),
    [collecting, setCollecting] = useState(false),
    [paused, setPaused] = useState(false),
    [phase, setPhase] = useState(0),
    [channel, setChannel] = useState("以太网 VibroLink"),
    [channels, setChannels] = useState(["速度", "位移", "加速度"]),
    [speed, setSpeed] = useState("1"),
    [playing, setPlaying] = useState(false),
    [focus, setFocus] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [batchMode, setBatchMode] = useState<"new" | "history" | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [importMode, setImportMode] = useState<"new" | "history" | null>(null);
  useEffect(() => {
    onTaskChange?.(form.id ? (form as Item) : undefined);
  }, [form, onTaskChange]);
  useEffect(() => {
    if (!collecting || paused) return;
    const t = setInterval(() => setPhase((v) => v + 0.18), 150);
    return () => clearInterval(t);
  }, [collecting, paused]);
  useEffect(() => { setPlaying(false); setPlayhead(null); }, [form.id]);
  useEffect(() => {
    if (!playing || !form.samples?.length) return;
    const started = Date.now(), initial = playhead ?? 0;
    const timer = setInterval(() => {
      const cursor = Math.min(form.samples.length - 1, initial + Math.floor((Date.now() - started) / 1000 * form.sampleRate * Number(speed)));
      setPlayhead(cursor);
      if (cursor === form.samples.length - 1) setPlaying(false);
    }, 100);
    return () => clearInterval(timer);
  }, [playing, speed, form.id, form.sampleRate, form.samples]);
  const savedWindow = useMemo(() => playbackWindow(form.samples || [], form.sampleRate, playhead), [form.samples, form.sampleRate, playhead]);
  const chart = useMemo(
    () => form.samples?.length && !collecting
      ? lineOption([{ name: form.source === "import" ? "导入波形（原始幅值）" : "已保存演示快照", data: savedWindow.samples }], savedWindow.times)
      : stackedWave(phase, channels.length ? channels : ["速度"], undefined, form.sampleRate),
    [phase, channels, form.samples, form.source, form.sampleRate, collecting, savedWindow],
  );
  async function save() {
    try {
      const row = await saveRecord("tasks", form, form.id);
      await refresh();
      setSelected(row.id);
      setForm(row);
      notify("任务及元信息已保存");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function snapshot() {
    try {
      const row = await saveRecord("tasks", createDemoSnapshot(form, waveSamples(phase)));
      await refresh();
      setSelected(row.id);
      setForm(row);
      notify(`演示快照已保存：${row.samples.length} 点 / ${Number(row.duration.toPrecision(6))} 秒，可以回放和导出`);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <div className="stack acquisition-screen">
      <Card>
        <div className="toolbar">
          <Select
            label="连接方式"
            options={["以太网 VibroLink", "BNC 模拟量"]}
            value={channel}
            onChange={setChannel}
          />
          <Button
            variant="primary"
            onClick={() => {
              setConnected(true);
              notify("已连接演示数据源，未访问采集设备");
            }}
          >
            连接演示
          </Button>
          <Button
            onClick={() => {
              setConnected(false);
              setCollecting(false);
            }}
          >
            断开
          </Button>
          <Tag tone={connected ? "green" : "gray"}>
            {connected ? "演示源已连接" : "设备未接入"}
          </Tag>
          <span className="divider" />
          <Select
            label="采样率"
            value={String(form.sampleRate)}
            onChange={(v) => setForm({ ...form, sampleRate: Number(v) })}
            options={[12800, 25600, 51200, 102400].map((n) => ({
              value: String(n),
              label: n + " Hz",
            }))}
          />
          <Select
            label="量程"
            value={String(form.range ?? "")}
            options={[5, 10, 20].map((n) => ({
              value: String(n),
              label: "±" + n + " mm/s",
            }))}
            onChange={(v) => setForm({ ...form, range: Number(v) })}
          />
          {["速度", "位移", "加速度"].map((c, i) => (
            <label className="check" key={c}>
              <input
                type="checkbox"
                checked={channels.includes(c)}
                onChange={(e) =>
                  setChannels(
                    e.target.checked
                      ? [...channels, c]
                      : channels.filter((x) => x !== c),
                  )
                }
              />
              <span className={"legend-dot c" + i} />
              {c}
            </label>
          ))}
          <Button
            disabled={!connected || focus}
            onClick={() => {
              setFocus(true);
              setTimeout(() => {
                setFocus(false);
                notify("演示对焦完成；真实对焦待设备接口接入");
              }, 500);
            }}
          >
            <RefreshCw size={14} className={focus ? "spin" : ""} />
            自动对焦
          </Button>
        </div>
      </Card>
      <div className="workspace-grid">
        <div className="stack">
          <Card
            className="acquisition-wave"
            title="实时波形（时域）"
            tools={
              <div className="legend">
                {form.samples?.length && !collecting ? <span className="blue-text">已保存单列波形 · 不做通道换算</span> : <>
                <span className="blue-text">━ 速度</span>
                <span className="green-text">━ 位移</span>
                <span className="orange-text">━ 加速度</span>
                </>}
              </div>
            }
          >
            <Chart
              option={chart}
              height={290}
              label={form.samples?.length && !collecting ? "已保存单列波形（原始幅值）" : "速度、位移、加速度演示波形"}
            />
            <div className="toolbar">
              <Button
                variant="success"
                disabled={!connected || collecting}
                onClick={() => {
                  setCollecting(true);
                  setPaused(false);
                }}
              >
                <Play size={14} />
                {collecting ? "演示采集中" : "开始演示"}
              </Button>
              <Button disabled={!collecting} onClick={() => setPaused(!paused)}>
                {paused ? <Play size={14} /> : <Pause size={14} />}{" "}
                {paused ? "继续" : "暂停"}
              </Button>
              <Button variant="cyan" disabled={!canWrite} onClick={snapshot}>
                <Camera size={14} />
                演示快照（400 点）
              </Button>
              <Button
                variant="danger"
                disabled={!collecting}
                onClick={() => {
                  setCollecting(false);
                  setPaused(false);
                }}
              >
                <Square size={13} />
                停止
              </Button>
              <span className="muted push">
                {playing
                  ? "历史回放"
                  : collecting
                    ? paused
                      ? "已暂停"
                      : "演示采集中"
                    : "未启动"}{" "}
                · 150ms
              </span>
            </div>
          </Card>
          <Card
            title="历史与批量管理"
            tools={
              <div className="toolbar">
              <Filter value={query} onChange={setQuery} placeholder="任务名 / 对象 / 测点"/>
              <Tag tone="gray">{tasks.length} 个任务</Tag>
              <Button
                variant="primary"
                disabled={!canWrite}
                onClick={() => setEditing(defaultTask)}
              >
                <Plus size={14} />
                新建任务
              </Button>
              </div>
            }
          >
            <Table headers={["", "任务名", "采样率", "时长", "状态", "操作"]}>
              {tasks
                .filter((t) => (t.name + t.object + t.point).includes(query))
                .map((t) => (
                  <tr
                    key={t.id}
                    className={selected === t.id ? "selected" : ""}
                    onClick={() => {
                      setSelected(t.id);
                      setForm(t);
                    }}
                  >
                    <td>
                      <input
                        aria-label={"选择 " + t.name}
                        type="checkbox"
                        checked={checked.includes(t.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          setChecked(
                            e.target.checked
                              ? [...checked, t.id]
                              : checked.filter((id) => id !== t.id),
                          )
                        }
                      />
                    </td>
                    <td title={t.object + " · " + t.point}>
                      <strong>{t.name}</strong>
                    </td>
                    <td className="mono">{t.sampleRate} Hz</td>
                    <td className="mono">{t.duration}s</td>
                    <td>
                      <Tag tone={t.status === "已归档" ? "green" : "gray"}>
                        {t.status}
                      </Tag>
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        disabled={!canWrite}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(t);
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label={"删除 " + t.name}
                        disabled={!canWrite}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(t);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
            </Table>
            {!tasks.length && <Empty />}
            <div className="toolbar space-top">
              <Button
                disabled={!canWrite}
                onClick={() => setImportMode("new")}
              >
                <Upload size={14} />
                导入 JSON / CSV
              </Button>
              <Button onClick={() => setImportMode("history")}>导入记录</Button>
              <Button
                disabled={!checked.length || !canWrite}
                onClick={async () => {
                  try {
                    for (const id of checked) {
                      const t = tasks.find((t) => t.id === id)!;
                      await saveRecord("tasks", { ...t, status: "已归档" }, id);
                    }
                    await refresh();
                    setChecked([]);
                    notify("所选任务已归档");
                  } catch (e) {
                    notify((e as Error).message);
                  }
                }}
              >
                批量归档 ({checked.length})
              </Button>
              <Button disabled={!canWrite || !checked.length} onClick={() => setBatchMode("new")}>批量处理 ({checked.length})</Button>
              <Button onClick={() => setBatchMode("history")}>批次记录</Button>
              <Button
                disabled={!selected || !form.samples?.length || collecting}
                onClick={() => {
                  if (!playing && (playhead === null || playhead >= form.samples.length - 1)) setPlayhead(0);
                  setPlaying(!playing);
                  notify(
                    playing
                      ? "已停止回放"
                      : "正在回放选中任务" +
                          (form.source === "demo" ? "（演示信号）" : ""),
                  );
                }}
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "暂停回放" : "回放"}
              </Button>
              <Select
                label="变速"
                value={speed}
                options={[
                  { value: ".5", label: "0.5×" },
                  { value: "1", label: "1×" },
                  { value: "2", label: "2×" },
                ]}
                onChange={setSpeed}
              />
              {selected ? <ResultExport path={`export/tasks/${selected}`} label="导出原始波形" includeRecord notify={notify} /> : <ExportButton
                kind="tasks"
                formats={["csv", "txt", "xlsx", "json", "mat"]}
                id={selected || undefined}
                notify={notify}
              />}
            </div>
            {!!form.samples?.length && <div className="toolbar space-top">
              <label className="playback-position">回放位置<input aria-label="回放采样位置" type="range" min={0} max={form.samples.length - 1} value={playhead ?? 0} onChange={(e) => { setPlaying(false); setPlayhead(Number(e.target.value)); }} /></label>
              <span className="mono">{((playhead ?? 0) / form.sampleRate).toFixed(4)} / {((form.samples.length - 1) / form.sampleRate).toFixed(4)} s</span>
              <Button onClick={() => { setPlaying(false); setPlayhead(null); }}>显示完整波形</Button>
            </div>}
          </Card>
        </div>
        <aside className="stack">
          <Card title="任务元信息">
            <div className="form-stack task-meta-fields">
              {taskFields.slice(0, 10).map((f) => (
                <label className="form-row" key={f.key}>
                  <span>{f.label}</span>
                  {f.options ? (
                    <CustomSelect
                      value={form[f.key] || ""}
                      disabled={!canWrite}
                      onChange={(e) =>
                        setForm({ ...form, [f.key]: e.target.value })
                      }
                    >
                      {!(f.options as string[]).includes(form[f.key] || "") && <option value={form[f.key] || ""}>{form[f.key] || "未填写"}</option>}
                      {(f.options as string[]).map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </CustomSelect>
                  ) : (
                    <input
                      disabled={!canWrite}
                      type={f.type === "number" ? "number" : "text"}
                      value={form[f.key] ?? ""}
                      min={f.min}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          [f.key]:
                            f.type === "number"
                              ? Number(e.target.value)
                              : e.target.value,
                        })
                      }
                    />
                  )}
                </label>
              ))}
              <Button
                className="full"
                variant="primary"
                disabled={!canWrite}
                onClick={save}
              >
                <Save size={14} />
                保存任务
              </Button>
              <Button className="full" disabled={!canWrite} onClick={() => setMetadataOpen(true)}>完整元信息 / 通道</Button>
            </div>
          </Card>
          <Card title="数据质量">
            <Tag tone="amber">演示指标</Tag>
            {[
              ["完整性", "99%", 99],
              ["信噪比", "28dB", 88],
              ["丢包", "0.1%", 96],
              ["采样稳定", "99.9%", 99],
            ].map(([label, value, p]) => (
              <div className="quality-row" key={label}>
                <div>
                  <span>{label}</span>
                  <span className="mono">{value}</span>
                </div>
                <Progress value={Number(p)} />
              </div>
            ))}
            <div className="quality-result">
              综合评级 <strong>良好</strong>
            </div>
          </Card>
        </aside>
      </div>
      {metadataOpen && <TaskMetadataDialog task={form} onClose={() => setMetadataOpen(false)} onSave={async (metadata) => {
        const row = await saveRecord("tasks", { ...form, ...metadata }, form.id);
        await refresh(); setSelected(row.id); setForm(row); notify("测试时间、环境和通道元信息已保存");
      }} />}
      {batchMode && <BatchDialog tasks={tasks} initialIds={checked} initialMode={batchMode} canWrite={canWrite} onClose={() => setBatchMode(null)} refresh={refresh} notify={notify} />}
      {importMode && <ImportDialog defaults={form} initialMode={importMode} canWrite={canWrite} onClose={() => setImportMode(null)} refresh={refresh} notify={notify} />}
      {editing && (
        <EditDialog
          title={editing.id ? "编辑任务" : "新建任务"}
          fields={taskFields}
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (v) => {
            const row = await saveRecord("tasks", v, editing.id);
            await refresh();
            setSelected(row.id);
            setForm(row);
            notify("任务已保存");
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="删除任务"
          message={
            "确定删除“" +
            deleting.name +
            "”？关联的分析和报告记录将保留原任务引用。"
          }
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api("records/tasks/" + deleting.id, "DELETE");
            await refresh();
            setChecked(checked.filter((id) => id !== deleting.id));
            if (selected === deleting.id) {
              const next = tasks.find((t) => t.id !== deleting.id);
              setSelected(next?.id || "");
              setForm(next || defaultTask);
              setPlaying(false);
            }
            notify("任务已删除");
          }}
        />
      )}
    </div>
  );
}
export const signalTabs = [
  { id: "time", name: "时域波形" },
  { id: "fft", name: "FFT频谱" },
  { id: "tf", name: "时频分析" },
  { id: "filter", name: "滤波降噪" },
  { id: "env", name: "包络谱" },
  { id: "band", name: "频带能量" },
  { id: "avg", name: "平均波形" },
  { id: "feat", name: "特征值" },
];
export function Signal({
  data,
  refresh,
  notify,
  canWrite,
  onTaskChange,
  initialTaskId,
}: ContextProps) {
  const [tab, setTab] = useState("fft"),
    [taskId, setTaskId] = useState(initialTaskId || data.tasks[0]?.id || ""),
    [windowFn, setWindow] = useState("Hann"),
    [nfft, setNfft] = useState("4096"),
    [filter, setFilter] = useState("带通"),
    [low, setLow] = useState(0.1),
    [high, setHigh] = useState(20),
    [detrend, setDetrend] = useState("去均值"),
    [denoise, setDenoise] = useState("Hampel"),
    [quality, setQuality] = useState(true),
    [zoom, setZoom] = useState(true),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("尚未执行演示分析"),
    [channel, setChannel] = useState("速度"),
    [filterStructure, setFilterStructure] = useState("IIR"),
    [filterOrder, setFilterOrder] = useState(4),
    [windowLength, setWindowLength] = useState(1024),
    [overlapPercent, setOverlapPercent] = useState(50),
    [compare, setCompare] = useState(false),
    [inputKey, setInputKey] = useState(""),
    [qualityDialog, setQualityDialog] = useState(false),
    [average, setAverage] = useState("8"),
    [savedResult, setSavedResult] = useState<Item | null>(null);
  const task = data.tasks.find((t: Item) => t.id === taskId);
  const choices = useMemo(() => signalChoices(data.tasks, data.analyses, taskId), [data.tasks, data.analyses, taskId]);
  const selectedKey = inputKey || signalKey({ kind: "tasks", id: taskId });
  const choice = choices.find(c => c.key === selectedKey), input = choice?.input;
  const inputError = choice?.error || (!input ? "所选输入已不存在，请重新选择任务或已保存段" : "");
  useEffect(() => {
    onTaskChange?.(task);
  }, [task, onTaskChange]);
  const option = useMemo(() => {
    switch (tab) {
      case "fft":
        return spectrumOption();
      case "tf":
        return heatOption();
      case "time":
        return input ? signalWaveOption(signalWaveDataset([input], "source"), zoom) : {};
      case "filter":
        return lineOption(
          [
            {
              name: "原始（演示）",
              color: "#CAD5E4",
              data: waveSamples(0, 400, 0).map(
                (v, i) => v + 0.2 * Math.sin(i * 1.9),
              ),
            },
            { name: "降噪参考（演示）", data: waveSamples(0, 400, 0), color: "#2D6CC0" },
          ],
          undefined,
          zoom,
        );
      case "env":
        return lineOption([
          {
            name: "包络谱（演示）",
            color: "#7A4DD4",
            data: Array.from(
              { length: 150 },
              (_, i) => Math.exp(-i / 45) * Math.abs(Math.sin(i * 0.25)),
            ),
          },
        ]);
      case "band":
        return {
          ...spectrumOption(true),
          xAxis: {
            type: "category",
            data: ["低频带\n0–10Hz", "中频带\n10–30Hz", "高频带\n30–80Hz"],
          },
          yAxis: { type: "value", name: "能量占比（%）", min: 0, max: 100, splitLine: { lineStyle: { color: "#EEF1F5" } } },
          series: [
            {
              type: "bar",
              barWidth: "45%",
              label: { show: true, position: "top", formatter: "{c}%" },
              data: [
                { value: 42, itemStyle: { color: "#1FA971" } },
                { value: 38, itemStyle: { color: "#2D6CC0" } },
                { value: 20, itemStyle: { color: "#F5A623" } },
              ],
            },
          ],
        };
      case "avg":
        return lineOption(
          [
            {
              name: "平均前",
              color: "#CAD5E4",
              data: waveSamples().map((v, i) => v + 0.12 * Math.sin(i * 2)),
            },
            { name: "平均后（演示）", data: waveSamples(), color: "#1FA971" },
          ],
          undefined,
          zoom,
        );
      default:
        return lineOption([
          {
            name: "特征趋势（演示）",
            data: [1.21, 1.28, 1.18, 1.39, 1.42, 1.58, 1.82],
          },
        ]);
    }
  }, [tab, input, zoom, channel]);
  // Keep chart navigation inside its canvas; the toolbar has its own layout row.
  const chartOption = useMemo(() => {
    const chart = option as Record<string, any>;
    if (!Object.keys(chart).length) return chart;
    const showZoom = zoom && tab !== "feat";
    const sliderBottom = tab === "tf" ? 38 : 12;
    return {
      ...chart,
      tooltip: { ...chart.tooltip, confine: true },
      ...(chart.legend ? { legend: { ...chart.legend, type: "scroll", top: 6, left: 8, right: 12 } } : {}),
      grid: {
        ...chart.grid,
        // The original-time axis also needs room for its unit below tick labels.
        bottom: showZoom ? (tab === "tf" ? 94 : tab === "time" ? 90 : 72) : chart.grid?.bottom,
      },
      dataZoom: showZoom ? [
        { type: "inside", filterMode: "none" },
        { type: "slider", filterMode: "none", height: 20, bottom: sliderBottom, brushSelect: false, showDetail: false },
      ] : [],
    };
  }, [option, tab, zoom]);
  const parameters = { channel, filterStructure, filterOrder, windowLength, ...(tab === "tf" ? { overlapPercent } : {}), window: windowFn, nfft: Number(nfft), filter, low, high, detrend, denoise, quality, average: Number(average) };
  const currentDataset = () => {
    if (!input) throw Error(inputError);
    if (tab === "tf") validateSignalTimeFrequencyParameters(parameters);
    if (tab === "time") return signalWaveDataset([input], "source");
    const dataset = signalDataset(tab, option, input.task, channel, parameters);
    dataset.metadata.inputs = [signalInputMetadata(input)];
    return dataset;
  };
  async function analyze() {
    if (
      ![low, high, filterOrder, windowLength].every(Number.isFinite) ||
      low < 0 ||
      !Number.isInteger(filterOrder) ||
      filterOrder < 1 ||
      filterOrder > 32 ||
      !Number.isInteger(windowLength) ||
      windowLength < 16
    ) {
      notify("请填写有效的滤波参数；阶数 1～32，窗长至少 16");
      return;
    }
    if (low >= high) {
      notify("低截止频率必须小于高截止频率");
      return;
    }
    setBusy(true);
    try {
      if (!input) throw Error(inputError);
      const dataset = currentDataset();
      await saveRecord("analyses", {
        name: (
          signalTabs.find((t) => t.id === tab)?.name +
          " · " +
          input.name).slice(0, 200),
        taskId,
        type: tab,
        parameters: { ...parameters, workflow: signalWorkflow, inputs: [{ ...input.ref, revision: await signalRevision(input) }], compare: false, alignment: "source" },
        result: { note: dataset.metadata.note, dataset },
        source: dataset.metadata.source,
      });
      await refresh();
      setNote(
        "输入配置与结果快照已保存 · " + new Date().toLocaleTimeString("zh-CN"),
      );
      notify(tab === "time" ? "已保存原始波形快照" : "已保存演示分析记录及所选输入来源");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="signal-layout signal-analysis-workbench">
      <Card className="signal-source">
        <div className="signal-source-fields">
          <Select
            label="数据源"
            value={taskId}
            options={data.tasks.map((t: Item) => ({
              value: t.id,
              label: t.name,
            }))}
            onChange={id => { setTaskId(id); setInputKey(""); }}
          />
          <Select label="任务 / 已保存段" value={selectedKey} options={[
            ...(!choice ? [{ value: selectedKey, label: "原选择已失效，请重选" }] : []),
            ...choices.map(c => ({ value: c.key, label: c.label + (c.error ? "（无有效波形）" : "") })),
          ]} onChange={setInputKey} />
          <Select
            label="通道"
            value={channel}
            options={["速度", "位移", "加速度"]}
            onChange={setChannel}
          />
          <Button
            className="signal-compare-button"
            onClick={() => {
              setCompare(true);
            }}
          >
            多测点对比
          </Button>
        </div>
        <div className="signal-source-context"><Tag tone="amber">{tab === "time" ? "原始幅值 · 不转换通道" : "演示结果 · 算法未接入"}</Tag>
        {input ? <p className="hint" data-testid="signal-input-summary">{input.name} · {input.task.point} · {input.task.sampleRate} Hz · {input.rows.length} 点 · {input.unit} · {input.source === "demo" ? "演示源" : input.source}。{input.segment ? "读取已保存段的历史快照，保留原任务时间。" : "读取所选任务已保存的单列波形。"}通道选择仅配置演示标签，不执行物理量转换。</p> : <p className="error" role="alert">{inputError}</p>}
        </div>
      </Card>
      <div className="stack">
        <Card className="no-pad signal-chart-card">
          <Tabs items={signalTabs} value={tab} onChange={setTab} />
          <div className="signal-chart-toolbar" aria-label="图表查看与导出">
            <div className="signal-view-actions" role="group" aria-label="图表查看">
              <Button variant="ghost" onClick={() => {
                setTab("time");
                notify("已切换至当前所选输入的时域波形");
              }}><ChartNoAxesCombined size={14} />查看原始波形</Button>
              <Button variant="ghost" onClick={() => setQualityDialog(true)}><ShieldCheck size={14} />数据质量评价</Button>
              <Button variant="ghost" className={zoom && tab !== "feat" ? "is-active" : ""} aria-pressed={zoom && tab !== "feat"} disabled={tab === "feat"} onClick={() => setZoom(!zoom)}>
                <ScanLine size={14} />{zoom && tab !== "feat" ? "关闭缩放" : "开启缩放"}
              </Button>
            </div>
            <ResultExport getData={currentDataset} disabled={!input} label="导出当前标签" notify={notify} />
          </div>
          <div className="pad signal-chart-content">
            {tab === "time" && !input ? <Empty text={inputError} /> : tab === "feat" ? (
              <>
                <div className="feature-grid">
                  {signalFeatures.map(({ name, value, unit }) => (
                    <div key={name}>
                      <span>{name}</span>
                      <strong className="mono">{name === "谱能量" || name === "信噪比" ? value : value.toFixed(2)}{unit === "dB" ? "dB" : ""}</strong>
                    </div>
                  ))}
                </div>
                <Table headers={["特征", "当前值", "基线", "变化"]}>
                  {[
                    ["RMS", "1.21 mm/s", "1.02", "+18.6%"],
                    ["峰值", "3.40 mm/s", "3.10", "+9.7%"],
                    ["主频", "0.60 Hz", "0.61", "−1.6%"],
                  ].map((r) => (
                    <tr key={r[0]}>
                      {r.map((v, i) => (
                        <td key={i}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </Table>
              </>
            ) : (
              <Chart
                option={chartOption}
                height={310}
                label={signalTabs.find((t) => t.id === tab)?.name}
              />
            )}
          </div>
          <div className="signal-chart-status" role="status">{note}</div>
        </Card>
        {tab !== "feat" && (
          <Card title="特征值" tools={<Tag tone="amber">原型演示值</Tag>}>
            <div className="toolbar">
              {[
                ["RMS", "1.21"],
                ["峰值", "3.40"],
                ["峰峰值", "6.70"],
                ["峭度", "3.10"],
                ["均值", "0.02"],
                ["主频", "0.60 Hz"],
              ].map(([name, value]) => (
                <span key={name}>
                  {name} <strong className="mono">{value}</strong>
                </span>
              ))}
            </div>
          </Card>
        )}
        <Card
          title="分析记录"
          tools={<ExportButton kind="analyses" notify={notify} />}
        >
          <Table headers={["分析任务", "类型", "数据源", "结果来源", "操作"]}>
            {data.analyses
              .filter((x: Item) => !taskId || x.taskId === taskId)
              .slice(0, 8)
              .map((a: Item) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.type}</td>
                  <td>
                    {data.tasks.find((t: Item) => t.id === a.taskId)?.name ||
                      a.taskId}
                  </td>
                  <td>
                    <Tag tone={a.source === "demo" ? "amber" : "green"}>{a.source === "demo" ? "演示" : a.source || "未注明"}</Tag>
                  </td>
                  <td><Button aria-label={`查看分析结果 ${a.name}`} onClick={() => setSavedResult(a)}>结果 / 导出</Button></td>
                </tr>
              ))}
          </Table>
          {!data.analyses.length && (
            <Empty text="执行一次演示分析后，记录将保存到数据库" />
          )}
        </Card>
      </div>
      {savedResult && <SavedResultDialog result={savedResult} notify={notify} onClose={() => setSavedResult(null)} />}
      <aside className="stack">
        <Card title="预处理与参数" className="signal-parameters-card">
          <div className="signal-preprocess-shortcuts" role="group" aria-label="快捷预处理配置">
            <Button variant="ghost" onClick={() => {
              setDetrend(detrend === "不处理" ? "去均值" : "不处理");
              notify("趋势去除配置已切换，请运行演示并保存；尚未执行真实计算");
            }}>去趋势：{detrend}</Button>
            <Button variant="ghost" onClick={() => {
              setDenoise(denoise === "Hampel" ? "中值" : "Hampel");
              notify("异常点处理配置已切换；尚未执行真实计算");
            }}>去毛刺 / 丢点</Button>
          </div>
          <div className="form-stack signal-parameter-fields">
            <Select
              label="滤波结构"
              value={filterStructure}
              options={["IIR", "FIR"]}
              onChange={setFilterStructure}
            />
            <Select
              label="滤波类型"
              options={["低通", "高通", "带通", "带阻"]}
              value={filter}
              onChange={setFilter}
            />
            <label className="form-row signal-parameter-half">
              <span>低截止 Hz</span>
              <input
                type="number"
                value={low}
                onChange={(e) => setLow(Number(e.target.value))}
                min={0}
                step={0.1}
              />
            </label>
            <label className="form-row signal-parameter-half">
              <span>高截止 Hz</span>
              <input
                type="number"
                value={high}
                onChange={(e) => setHigh(Number(e.target.value))}
                min={0}
                step={0.1}
              />
            </label>
            <Select
              label="趋势去除"
              options={["去均值", "线性趋势", "多项式", "不处理"]}
              value={detrend}
              onChange={setDetrend}
            />
            <label className="form-row signal-parameter-half">
              <span>阶数</span>
              <input
                type="number"
                min={1}
                max={32}
                value={filterOrder}
                onChange={(e) => setFilterOrder(Number(e.target.value))}
              />
            </label>
            <label className="form-row signal-parameter-half">
              <span>{tab === "tf" ? "STFT 窗长" : "窗长"}</span>
              <input
                type="number"
                min={16}
                step={16}
                value={windowLength}
                onChange={(e) => setWindowLength(Number(e.target.value))}
              />
            </label>
            {tab === "tf" && <label className="form-row">
              <span>重叠率 %</span>
              <input aria-label="STFT 重叠率 %" type="number" min={0} max={99.9} step={0.1} value={Number.isNaN(overlapPercent) ? "" : overlapPercent} onChange={e => setOverlapPercent(e.target.value === "" ? NaN : Number(e.target.value))} />
            </label>}
            <Select
              label="窗函数"
              value={windowFn}
              options={["Hann", "Hamming", "Blackman", "Rectangular"]}
              onChange={setWindow}
            />
            <Select
              label="NFFT"
              value={nfft}
              options={["1024", "2048", "4096", "8192"]}
              onChange={setNfft}
            />
            <Select
              label="异常点"
              options={["Hampel", "中值", "z-score", "人工确认"]}
              value={denoise}
              onChange={setDenoise}
            />
            {tab === "avg" && (
              <Select
                label="平均次数"
                options={["4", "8", "16", "32"]}
                value={average}
                onChange={setAverage}
              />
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={quality}
                onChange={(e) => setQuality(e.target.checked)}
              />
              启用质量门禁
            </label>
            <Button
              className="full"
              variant="primary"
              disabled={!canWrite || busy || !input}
              onClick={analyze}
            >
              {busy ? "保存中…" : tab === "time" ? "保存波形快照" : "运行演示并保存"}
            </Button>
            <Button
              onClick={() => {
                setFilter("带通");
                setLow(0.1);
                setHigh(20);
                setDetrend("去均值");
                setDenoise("Hampel");
                setQuality(true);
                setAverage("8");
                setFilterStructure("IIR");
                setFilterOrder(4);
                setWindowLength(1024);
                setOverlapPercent(50);
                setWindow("Hann");
                setNfft("4096");
                notify("已恢复默认分析参数");
              }}
            >
              重置参数
            </Button>
          </div>
        </Card>
        <Card title="处理状态">
          <div className="quality-result">
            原始数据 <strong>保留</strong>
          </div>
          <p className="hint">
            演示配置不会覆盖任务波形，历史参数可在分析记录中导出。
          </p>
        </Card>
      </aside>
      {compare && <SignalCompare tasks={data.tasks} analyses={data.analyses} initialKey={selectedKey} notify={notify} refresh={refresh} canWrite={canWrite} onClose={() => setCompare(false)} />}
      {qualityDialog && (
        <Dialog
          title="数据质量评价 · 演示"
          onClose={() => setQualityDialog(false)}
        >
          <Table headers={["指标", "演示值"]}>
            {[
              ["完整性", "99%"],
              ["信噪比", "28 dB"],
              ["丢包率", "0.1%"],
              ["综合评级", "良好"],
            ].map((row) => (
              <tr key={row[0]}>
                <td>{row[0]}</td>
                <td>{row[1]}</td>
              </tr>
            ))}
          </Table>
          <p className="hint">
            这些值来自原型演示；真实质量评价待采集和 Python 接口提供。
          </p>
        </Dialog>
      )}
    </div>
  );
}
export { Blade } from "./rotation-screen";
