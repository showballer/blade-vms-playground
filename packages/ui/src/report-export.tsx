"use client";
import { useState } from "react";
import { Select } from "./common";
import { ResultExport } from "./result-export";
import { recordDataset } from "./result-data";
type Row = Record<string, any>;
type Choice = { value: string; label: string; kind: string; record: Row; datasetKey?: string };

/** Both the graph and the download use the loaded report's snapshots, never current record IDs. */
export function ReportDataExport({ task, analyses, report, notify }: { task?: Row; analyses: Row[]; report?: Row; notify: (message: string) => void }) {
  const [selected, setSelected] = useState("task");
  const choices: Choice[] = [
    ...(task ? [{ value:"task", label:"原始任务波形", kind:"tasks", record:task, datasetKey:undefined as string|undefined }] : []),
    ...analyses.filter(a => a.taskId === task?.id).flatMap((a): Choice[] => {
      const keys = Object.keys(a.result?.datasets || {});
      return keys.length ? keys.map(key => ({ value:a.id+":"+key, label:a.name+" / "+a.result.datasets[key].title, kind:"analyses", record:a, datasetKey:key })) : [{ value:a.id, label:a.name, kind:"analyses", record:a, datasetKey:undefined }];
    }),
  ];
  const chosen = choices.find(c => c.value === selected);
  const getData = () => {
    if (!chosen) throw Error("请选择要导出的报告数据");
    const dataset = recordDataset(chosen.kind, chosen.record, chosen.datasetKey);
    return { ...dataset, metadata:{ ...dataset.metadata, report:{ id:report?.id || null, name:report?.name || "未保存草稿", generatedAt:report?.generatedAt || null, frozen:!!report?.taskSnapshot } } };
  };
  let error = "";
  try { getData(); } catch(e) { error = (e as Error).message; }
  return <div className="report-data-export">
    <Select label="报告数据" value={selected} options={choices.map(({value,label})=>({value,label}))} onChange={setSelected} />
    <ResultExport getData={getData} disabled={!!error} label="导出报告数据" notify={notify}/>
    <p className="muted">{error || (report?.taskSnapshot ? "导出此报告保存时的完整数据和元信息，不读取后来修改的任务或分析。" : "导出当前草稿引用的数据；保存报告后将固定为历史快照。")}</p>
  </div>;
}
