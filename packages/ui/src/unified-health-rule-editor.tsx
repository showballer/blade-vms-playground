"use client";

import React, { useState } from "react";
import { Button, CustomSelect, Dialog } from "./common";
import { api } from "./api";

const numericFields = [
  ["warningRatio", "预警倍数（>1）"],
  ["alarmRatio", "严重预警倍数"],
  ["windTolerance", "同工况风速容差 · m/s"],
  ["rpmTolerance", "同工况转速容差 · rpm"],
] as const;

export function HealthRuleEditor({ choices, context, onClose, onSaved, onError }: {
  choices: any[];
  context: any;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [rule, setRule] = useState({
    referenceResultId: "",
    warningRatio: "",
    alarmRatio: "",
    windTolerance: "",
    rpmTolerance: "",
    referenceApproval: "",
    thresholdSource: "",
  });
  const [saving, setSaving] = useState(false);
  const incomplete = !rule.referenceResultId || !rule.thresholdSource.trim()
    || !rule.referenceApproval.trim() || numericFields.some(([key]) => rule[key] === "");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || incomplete) return;
    setSaving(true);
    try {
      await api("measurements/blade-health", "POST", {
        action: "configure",
        ...rule,
        ...Object.fromEntries(numericFields.map(([key]) => [key, Number(rule[key])])),
        context,
      });
      onClose();
      onSaved();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return <Dialog title="响应变化预警规则" onClose={onClose}>
    <form onSubmit={save}>
      <div className="form-grid">
        <label className="form-field span-2">
          <span>独立正常参考版本</span>
          <CustomSelect aria-label="独立正常参考版本" value={rule.referenceResultId}
            onChange={event => setRule({ ...rule, referenceResultId: event.target.value })}>
            <option value="">选择独立测量批次</option>
            {choices.filter(choice => choice.context.campaignId !== context.campaignId).map(choice =>
              <option key={choice.id} value={choice.id}>{choice.name} · {choice.finishedAt}</option>)}
          </CustomSelect>
        </label>
        {numericFields.map(([key, label]) => <label className="form-field" key={key}>
          <span>{label}</span>
          <input type="number" step="any" value={rule[key]}
            onChange={event => setRule({ ...rule, [key]: event.target.value })} />
        </label>)}
        <label className="form-field span-2">
          <span>参考复核依据</span>
          <input value={rule.referenceApproval}
            onChange={event => setRule({ ...rule, referenceApproval: event.target.value })} />
        </label>
        <label className="form-field span-2">
          <span>预警阈值来源</span>
          <input value={rule.thresholdSource}
            onChange={event => setRule({ ...rule, thresholdSource: event.target.value })} />
        </label>
      </div>
      <div className="dialog-actions">
        <Button type="button" onClick={onClose}>取消</Button>
        <Button type="submit" variant="primary" disabled={saving || incomplete}>
          {saving ? "正在保存…" : "保存规则版本"}
        </Button>
      </div>
    </form>
  </Dialog>;
}
