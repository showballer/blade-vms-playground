"use client";
import React, { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Card, Dialog, Select, Table } from "./common";
import { MeasurementStatus, PageControls } from "./measurement-common";
import type { MeasurementObject, ObjectKind } from "./measurement-domain";
const names: Record<ObjectKind, string> = {
  farm: "风场",
  turbine: "风机",
  blade: "叶片",
  position: "点位",
  campaign: "测量批次",
};
export function MeasurementObjects({
  canWrite = true,
}: {
  canWrite?: boolean;
}) {
  const [all, setAll] = useState<MeasurementObject[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<any>(null),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    try {
      setAll((await api<any>("objects")).objects);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const visible = all
    .filter((o) => (o.name + o.code + names[o.kind]).includes(query))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.name.localeCompare(b.name, "zh", { numeric: true }),
    );
  const parentKind = editing
    ? (
        {
          turbine: "farm",
          campaign: "farm",
          blade: "turbine",
          position: "blade",
        } as any
      )[editing.kind]
    : null;
  return (
    <div className="stack measurement-workspace">
      <Card
        title="测量对象与批次"
        tools={
          <Button
            disabled={!canWrite || busy}
            onClick={() =>
              setEditing({
                kind: "farm",
                code: "",
                name: "",
                parentId: null,
                active: true,
                turbineIds: [],
              })
            }
          >
            新增对象
          </Button>
        }
      >
        <p className="hint">
          风场 → 风机 → 叶片 →
          点位；一个测量批次可以包含多台风机。归档保留历史数据。
        </p>
        <div className="measurement-toolbar">
          <input
            aria-label="搜索测量对象"
            placeholder="搜索名称或编号"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
          <Button
            disabled={!canWrite || busy}
            onClick={() =>
              void act(async () => {
                const r = await api<any>("objects/adopt", "POST", {});
                setMessage(
                  `已关联 ${r.linked} 条；${r.skipped} 条缺少完整身份信息，请手动关联。`,
                );
              })
            }
          >
            从已有记录识别对象
          </Button>
        </div>
        <MeasurementStatus
          loading={busy}
          error={error}
          onReload={() => void load()}
        />
        {message && <p role="status">{message}</p>}
        <Table headers={["类型", "编号 / 名称", "所属对象", "状态", "操作"]}>
          {visible.slice(page * 20, (page + 1) * 20).map((o) => (
            <tr key={o.id}>
              <td>{names[o.kind]}</td>
              <td>
                {o.code} · {o.name}
              </td>
              <td>{all.find((p) => p.id === o.parentId)?.name || "—"}</td>
              <td>{o.active ? "启用" : "归档"}</td>
              <td>
                <Button
                  disabled={!canWrite || busy}
                  onClick={() => setEditing(o)}
                >
                  编辑
                </Button>
                {o.kind === "turbine" &&
                  !all.some((x) => x.parentId === o.id) && (
                    <Button
                      disabled={!canWrite || busy}
                      onClick={() =>
                        void act(() =>
                          api("objects/default-points", "POST", {
                            turbineId: o.id,
                          }),
                        )
                      }
                    >
                      添加 3 叶片 × 5 空点位
                    </Button>
                  )}
              </td>
            </tr>
          ))}
        </Table>
        {!all.length && !busy && (
          <p className="hint">
            尚未登记测量对象。可新建风场，也可从已上传记录识别；不会创建虚构测量结果。
          </p>
        )}
        <PageControls page={page} total={visible.length} onChange={setPage} />
      </Card>
      {editing && (
        <Dialog
          title={editing.id ? "编辑测量对象" : "新增测量对象"}
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form
            className="measurement-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api("objects", "POST", editing);
                setEditing(null);
              });
            }}
          >
            <Select
              label="对象类型"
              value={editing.kind}
              disabled={!!editing.id || busy}
              options={Object.entries(names).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(kind) =>
                setEditing({ ...editing, kind, parentId: null, turbineIds: [] })
              }
            />
            {parentKind && (
              <Select
                label="上级对象"
                value={editing.parentId || ""}
                disabled={!!editing.id || busy}
                options={all
                  .filter((o) => o.active && o.kind === parentKind)
                  .map((o) => ({ value: o.id, label: o.name }))}
                onChange={(parentId) =>
                  setEditing({ ...editing, parentId, turbineIds: [] })
                }
              />
            )}
            {(
              [
                ["code", "编号"],
                ["name", "名称"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  required
                  maxLength={120}
                  value={editing[key] || ""}
                  disabled={busy || (key === "code" && !!editing.id)}
                  onChange={(e) =>
                    setEditing({ ...editing, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            {editing.kind === "position" && (
              <>
                <label>
                  距旋转中心 · m
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={editing.radiusM ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        radiusM:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  安装角度 · °
                  <input
                    type="number"
                    min="-360"
                    max="360"
                    step="any"
                    value={editing.installationAngleDeg ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        installationAngleDeg:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
              </>
            )}
            {editing.kind === "farm" && (
              <label>
                位置
                <input
                  value={editing.location || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, location: e.target.value })
                  }
                />
              </label>
            )}
            {editing.kind === "turbine" && (
              <label>
                型号
                <input
                  value={editing.model || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, model: e.target.value })
                  }
                />
              </label>
            )}
            {editing.kind === "campaign" && (
              <>
                <label>
                  测量日期
                  <input
                    type="date"
                    value={editing.date || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, date: e.target.value })
                    }
                  />
                </label>
                <label>
                  测量人员
                  <input
                    value={editing.operators || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, operators: e.target.value })
                    }
                  />
                </label>
                <label>
                  天气备注
                  <input
                    value={editing.weather || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, weather: e.target.value })
                    }
                  />
                </label>
                <fieldset>
                  <legend>参与风机</legend>
                  {all
                    .filter(
                      (o) =>
                        o.kind === "turbine" &&
                        o.parentId === editing.parentId &&
                        o.active,
                    )
                    .map((o) => (
                      <label key={o.id} className="inline-field">
                        <input
                          type="checkbox"
                          checked={editing.turbineIds?.includes(o.id) || false}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              turbineIds: e.target.checked
                                ? [...(editing.turbineIds || []), o.id]
                                : editing.turbineIds.filter(
                                    (id: string) => id !== o.id,
                                  ),
                            })
                          }
                        />
                        {o.name}
                      </label>
                    ))}
                </fieldset>
              </>
            )}
            {editing.id && (
              <label className="inline-field">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) =>
                    setEditing({ ...editing, active: e.target.checked })
                  }
                />
                启用
              </label>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <Button variant="primary" disabled={busy} type="submit">
              {busy ? "保存中…" : "保存"}
            </Button>
          </form>
        </Dialog>
      )}
    </div>
  );
}
