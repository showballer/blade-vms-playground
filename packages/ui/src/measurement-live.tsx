"use client";
import React, { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Card, Select } from "./common";
import { Chart } from "./charts";
import { FieldWaveChart } from "./field-waveform";
import type { CaptureSummary, CaptureDetail } from "./capture-types";
import type {
  MeasurementContext,
  MeasurementObject,
} from "./measurement-domain";
import { validPassPreview } from "./measurement-live-data";
import { timeText } from "./measurement-common";
const taskKey = (c: CaptureSummary) =>
  JSON.stringify([
    c.ownerId,
    c.clientId,
    c.recording.pointCycle?.collectionId || c.localId,
  ]);
export function MeasurementLive({
  context,
  objects,
}: {
  context: Partial<MeasurementContext>;
  objects: MeasurementObject[];
}) {
  const [captures, setCaptures] = useState<CaptureSummary[]>([]),
    [frames, setFrames] = useState<Record<string, CaptureDetail>>({}),
    [task, setTask] = useState(""),
    [raw, setRaw] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const codes = Object.fromEntries(
    Object.entries(context)
      .filter(([, v]) => v)
      .map(([k, v]) => [k, objects.find((o) => o.id === v)?.code]),
  );
  const filtered = captures.filter(
    (c) =>
      (!codes.farmId || c.recording.windFarm === codes.farmId) &&
      (!codes.turbineId || c.recording.turbine === codes.turbineId) &&
      (!codes.bladeId || c.recording.pointCycle?.bladeId === codes.bladeId) &&
      (!codes.positionId ||
        c.recording.pointCycle?.radialPointName === codes.positionId) &&
      (!codes.campaignId ||
        c.recording.pointCycle?.collectionId === codes.campaignId),
  );
  const tasks = [...new Map(filtered.map((c) => [taskKey(c), c])).values()];
  const chosen = tasks.some((c) => taskKey(c) === task)
    ? task
    : tasks[0]
      ? taskKey(tasks[0])
      : "";
  const points = [
    ...new Map(
      [...filtered.filter((c) => taskKey(c) === chosen)]
        .reverse()
        .map((c) => [
          JSON.stringify([
            c.recording.pointCycle?.bladeId,
            c.recording.pointCycle?.radialPointId || c.localId,
          ]),
          c,
        ]),
    ).values(),
  ].slice(0, 5);
  const ids = points.map((c) => c.id).join(",");
  useEffect(() => {
    let dead = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const r = await api<{ captures: CaptureSummary[] }>("captures");
        if (!dead) {
          setCaptures(r.captures);
          setError("");
        }
      } catch (e) {
        if (!dead) setError((e as Error).message);
      } finally {
        if (!dead) {
          setLoading(false);
          timer = setTimeout(poll, 3000);
        }
      }
    }
    void poll();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let dead = false,
      timer: ReturnType<typeof setTimeout>;
    setFrames({});
    if (!ids) return;
    async function poll() {
      try {
        const all = await Promise.all(
          ids
            .split(",")
            .map(
              async (id) =>
                [id, await api<CaptureDetail>(`captures/${id}`)] as const,
            ),
        );
        if (!dead) {
          setFrames(Object.fromEntries(all));
          setError("");
        }
      } catch (e) {
        if (!dead) setError((e as Error).message);
      } finally {
        if (!dead) timer = setTimeout(poll, document.hidden ? 5000 : 1000);
      }
    }
    void poll();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [ids]);
  return (
    <div className="stack">
      <Card
        title="实时点位预览"
        tools={
          <Button variant="ghost" onClick={() => setRaw(!raw)}>
            {raw ? "返回有效片段" : "查看原始连续流"}
          </Button>
        }
      >
        {tasks.length > 0 && (
          <Select
            label="采集任务"
            value={chosen}
            options={tasks.map((c) => ({
              value: taskKey(c),
              label: `${c.recording.name} · ${c.ownerName}`,
            }))}
            onChange={setTask}
          />
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!points.length && (
          <p className="measurement-inline-empty">
            {loading
              ? "正在连接采集端…"
              : "当前范围没有在线采集任务。客户端绑定当前 Web 后可在此查看。"}
          </p>
        )}
        <p className="hint">
          默认只显示已确认进入、离开的有效区间。网络预览可能不覆盖整次经过；完整记录上传后可分析频谱。
        </p>
      </Card>
      <div className="measurement-live-grid">
        {points.map((c) => {
          const f = frames[c.id]?.frame;
          const valid = f ? validPassPreview(f) : null;
          return (
            <Card
              key={c.id}
              title={`${c.recording.pointCycle?.radialPointName || c.recording.point || "测点"} · ${c.recording.pointCycle?.azimuthDeg ?? "—"}°`}
              tools={
                <span className="hint">
                  {c.liveState === "acquiring"
                    ? "采集中"
                    : c.liveState === "offline"
                      ? "连接中断"
                      : "已停止"}
                </span>
              }
            >
              <p className="hint">
                {c.recording.turbine} / 叶片{" "}
                {c.recording.pointCycle?.bladeId || "未标注"}
              </p>
              {raw ? (
                <FieldWaveChart waveform={f?.waveform} compact />
              ) : valid?.points.length ? (
                <Chart
                  height={210}
                  label="实时有效片段"
                  option={{
                    grid: { left: 70, right: 20, top: 30, bottom: 35 },
                    tooltip: { trigger: "axis" },
                    xAxis: { type: "value", name: "有效段内 s" },
                    yAxis: { type: "value", name: "m/s", scale: true },
                    series: [
                      {
                        type: "line",
                        showSymbol: false,
                        connectNulls: false,
                        data: valid.points,
                      },
                    ],
                  }}
                />
              ) : (
                <div className="measurement-plot-empty">
                  {valid?.reason || "等待采集帧"}
                </div>
              )}
              <small className="hint">
                {!raw && valid?.reason} · 最后接收{" "}
                {f ? timeText(f.receivedAt) : "—"}
              </small>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
