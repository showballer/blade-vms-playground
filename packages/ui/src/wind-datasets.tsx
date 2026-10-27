"use client";
import React, { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Card, Select, Table } from "./common";
import {
  MeasurementStatus,
  PageControls,
  timeText,
} from "./measurement-common";
import { validateWindRows, type MeasurementObject } from "./measurement-domain";
const columns = {
  time: "时间（带时区）",
  turbineCode: "风机编号",
  windSpeed: "风速 · m/s",
  rpm: "转速 · rpm",
  windDirection: "风向 · °（可选）",
  powerKw: "功率 · kW（可选）",
};
export function WindDatasets({ canWrite }: { canWrite: boolean }) {
  const [all, setAll] = useState<MeasurementObject[]>([]),
    [datasets, setDatasets] = useState<any[]>([]),
    [farm, setFarm] = useState(""),
    [name, setName] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState(0),
    [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    try {
      const r = await api<any>("wind-datasets");
      setAll(r.objects);
      setDatasets(r.datasets);
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
  async function upload(file: File) {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      if (file.size > 4 * 1024 * 1024)
        throw Error("请选择小于 4 MB 的 CSV / XLSX");
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const p = await api<any>("wind-datasets/preview", "POST", {
        filename: file.name,
        base64,
      });
      setPreview(p);
      setName(file.name);
      setMapping(
        Object.fromEntries(
          Object.keys(columns).map((k) => [k, p.headers.includes(k) ? k : ""]),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function mapped() {
    if (!preview) throw Error("请先预览文件");
    for (const key of ["time", "turbineCode", "windSpeed", "rpm"])
      if (!mapping[key]) throw Error("请映射时间、风机编号、风速和转速列");
    const used = Object.values(mapping).filter(Boolean);
    if (new Set(used).size !== used.length)
      throw Error("不同字段不能映射同一列");
    return validateWindRows(
      preview.rows.map((cells: string[]) =>
        Object.fromEntries(
          Object.entries(mapping)
            .filter(([, v]) => v)
            .map(([key, column]) => {
              const cell = cells[preview.headers.indexOf(column)];
              if (!["time", "turbineCode"].includes(key) && !cell.trim()) {
                if (["powerKw", "windDirection"].includes(key))
                  return [key, undefined];
                throw Error("必填数值列中存在空单元格");
              }
              return [
                key,
                ["time", "turbineCode"].includes(key) ? cell : Number(cell),
              ];
            }),
        ),
      ),
    );
  }
  const shown = datasets.filter((d) => !farm || d.farmId === farm);
  return (
    <div className="stack measurement-workspace">
      <header>
        <h1>风场数据集</h1>
        <p>导入实测风速和转速，按测量时间窗关联工况。</p>
      </header>
      <Card title="导入工况文件">
        <div className="measurement-filters">
          <Select
            label="风场"
            value={farm}
            options={all
              .filter((o) => o.kind === "farm" && o.active)
              .map((o) => ({ value: o.id, label: o.name }))}
            onChange={(v) => {
              setFarm(v);
              setPage(0);
            }}
          />
          <label>
            CSV / XLSX
            <input
              aria-label="风场数据文件"
              type="file"
              accept=".csv,.xlsx"
              disabled={!canWrite || busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <p className="hint">
          首行为列名，时间使用例如 2026-10-27T09:00:00+08:00；Excel
          时间请保存为文本。风速 m/s、转速 rpm、功率
          kW。先在系统管理登记对应风机编号。
        </p>
        <MeasurementStatus
          loading={busy}
          error={error}
          onReload={() => void load()}
        />
        {message && <p role="status">{message}</p>}
        {preview && (
          <>
            <div className="measurement-filters">
              <label>
                数据集名称
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              {Object.entries(columns).map(([key, label]) => (
                <Select
                  key={key}
                  label={label}
                  value={mapping[key] || ""}
                  options={[
                    { value: "", label: "选择列" },
                    ...preview.headers.map((h: string) => ({
                      value: h,
                      label: h,
                    })),
                  ]}
                  disabled={busy}
                  onChange={(v) => setMapping({ ...mapping, [key]: v })}
                />
              ))}
            </div>
            <p>预览前 5 行 · 共 {preview.rowCount} 行</p>
            <Table headers={preview.headers}>
              {preview.rows.slice(0, 5).map((r: string[], i: number) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </Table>
            <Button
              variant="primary"
              disabled={!canWrite || busy || !farm}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const r = await api<any>("wind-datasets", "POST", {
                    name,
                    farmId: farm,
                    rows: mapped(),
                  });
                  setMessage(`已保存 ${r.count} 行真实工况数据`);
                  setPreview(null);
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认列映射并导入
            </Button>
          </>
        )}
      </Card>
      <Card title="已保存数据集">
        <Table headers={["数据集", "风场", "时间范围", "行数"]}>
          {shown.slice(page * 20, (page + 1) * 20).map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>{all.find((o) => o.id === d.farmId)?.name}</td>
              <td>
                {timeText(d.start)} ～ {timeText(d.end)}
              </td>
              <td>{d.rowCount}</td>
            </tr>
          ))}
        </Table>
        {!shown.length && !busy && (
          <p className="hint">
            尚无工况数据；波形与频谱分析可以继续，工况异常判定暂不出结论。
          </p>
        )}
        <PageControls page={page} total={shown.length} onChange={setPage} />
      </Card>
    </div>
  );
}
