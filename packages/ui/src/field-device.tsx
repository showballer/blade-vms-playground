"use client";
import { CustomSelect } from "./custom-select";
import React, { useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { Button, Dialog } from "./common";
import { fieldDate, fieldIsActive, type FieldDeviceRequest, type FieldDeviceSettings, type FieldStatus } from "./field-types";

export const deviceLabels: Record<string, string> = { velocityRange: "速度量程", bandwidth: "带宽", highPass: "高通滤波", ase: "ASE 滤波", laser: "激光状态", focusPosition: "聚焦位置", signalLevel: "信号强度", autofocus: "自动聚焦状态", autofocusResult: "上次自动聚焦结果" };
const valueLabel = (key: string, value: string | number | undefined) => value === undefined ? "未知" : ["ase", "laser"].includes(key) ? value === 1 ? "On" : value === 0 ? "Off" : String(value) : key === "autofocus" ? value === 1 ? "运行中" : "未运行" : key === "autofocusResult" ? value === 1 ? "找到焦点" : value === 0 ? "未找到焦点" : "未知" : String(value);

export function FieldDeviceSnapshot({ settings }: { settings?: FieldDeviceSettings | null }) {
  if (!settings) return <p className="field-subtext">此记录未保存厂商配置快照；不能用当前设备设置代替当时的设置。</p>;
  return <div className="field-device-snapshot"><p className="field-subtext">设备配置快照 · {fieldDate(settings.readAt)?.toLocaleString("zh-CN")} · {settings.deviceIp}（当次读取，不是实时激光状态）</p>
    <dl className="field-details">{Object.entries(deviceLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{settings.fields[key]?.supported ? key === "signalLevel" && settings.fields[key].percent !== undefined ? `${settings.fields[key].percent?.toFixed(1)} %` : valueLabel(key, settings.fields[key].value) : "未读取 / 不支持"}</dd></div>)}</dl></div>;
}

export function FieldDevicePanel({ deviceIp, onIp, status, disabled, onBusy, onError, request }: {
  deviceIp: string; onIp: (value: string) => void; status: FieldStatus | null; disabled: boolean;
  onBusy: (busy: boolean) => void; onError: (cause: unknown) => void;
  request: (options: FieldDeviceRequest) => Promise<FieldDeviceSettings>;
}) {
  const [snapshot, setSnapshot] = useState<FieldDeviceSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string | number>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<FieldDeviceRequest | null>(null), [consent, setConsent] = useState(false);
  const active = fieldIsActive(status);
  const blocked = busy || disabled || active || Boolean(status?.deviceBusy) || status?.service.state !== "ready";
  useEffect(() => { setSnapshot(null); setDrafts({}); setConfirm(null); setError(""); setNotice(""); }, [deviceIp]);
  async function run(options: FieldDeviceRequest) {
    setBusy(true); onBusy(true); setError(""); setNotice("");
    // Unknown on failure, never leave a prior configuration looking verified.
    setSnapshot(null);
    try {
      const result = await request(options);
      setSnapshot(result); setDrafts(Object.fromEntries(Object.entries(result.fields).filter(([, field]) => field.value !== undefined).map(([key, field]) => [key, field.value!])));
      setConfirm(null); setConsent(false);
      setNotice(options.action === "read" ? "已读取设备实际配置；没有修改参数、开启激光或开始采集。" : options.action === "autofocus" ? "聚焦流程已结束，已发送停止聚焦和关闭激光并核对读回。请现场确认光路与激光状态；开始采集后查看 RSSI。" : "该配置项已修改并读回确认。未保存为设备上电默认设置。请核对其他受联动影响的配置项。");
    } catch (cause) { setConfirm(null); setError(cause instanceof Error ? cause.message : "配置操作失败"); onError(cause); }
    finally { setBusy(false); onBusy(false); }
  }
  return <section className="field-card field-device-panel"><div className="field-section-heading"><div><h2>厂商设备配置</h2><p>先读取，后修改；不预置或自动覆盖测量条件。</p></div><span className="field-badge">停止采集后设置</span></div>
    <p className="field-notice">请先退出厂商面板及其他采集程序，确保此设备没有被其他电脑使用。这里只有本次运行参数，不修改设备 IP、串口波特率、上电配置或 User1。</p>
    <div className="field-wave-options"><label>设备 IP<input aria-label="配置设备 IP" value={deviceIp} maxLength={15} disabled={blocked} onChange={event => onIp(event.target.value)} placeholder="设备 IPv4 地址" /></label><Button disabled={blocked || !deviceIp} onClick={() => void run({ deviceIp: deviceIp.trim(), action: "read" })}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}读取实际配置</Button></div>
    {active && <p className="field-notice warning">采集中，禁止修改参数或聚焦。激光由采集流程控制；请使用“停止并保存”结束，并现场核对激光状态。</p>}
    {error && <p className="field-error" role="alert">{error}</p>}{notice && <p className="field-success" role="status">{notice}</p>}
    {snapshot && <><p className="field-subtext">上次读回：{fieldDate(snapshot.readAt)?.toLocaleString("zh-CN")} · 非持续监控，外部修改后请重新读取。</p>
      <div className="field-device-fields">{Object.entries(deviceLabels).map(([key, label]) => {
        const field = snapshot.fields[key];
        return <div className="field-device-row" key={key}><div><strong>{label}</strong><small>{field?.supported ? `读回：${key === "signalLevel" && field.percent !== undefined ? `${field.percent.toFixed(1)} %` : valueLabel(key, field.value)}` : field?.error || "设备不支持 / 未读取"}</small></div>
          {field?.supported && field.writable && <><CustomSelect aria-label={label} value={String(drafts[key] ?? "")} disabled={blocked} onChange={event => setDrafts(previous => ({ ...previous, [key]: key === "ase" ? Number(event.target.value) : event.target.value }))}>{field.options?.map(value => <option key={value} value={String(value)}>{valueLabel(key, value)}</option>)}</CustomSelect>
            <Button disabled={blocked || drafts[key] === field.value} onClick={() => { setConsent(false); setConfirm({ deviceIp, action: "set", key, value: drafts[key], expected: field.value, confirmChange: true }); }}>应用此项</Button></>}
        </div>;
      })}</div>
      <Button disabled={blocked || !snapshot.fields.autofocus?.supported || !snapshot.fields.laser?.supported} onClick={() => { setConsent(false); setConfirm({ deviceIp, action: "autofocus", confirmLaser: true }); }}>安全自动聚焦…</Button>
      <p className="field-subtext">自动聚焦会临时开启激光，结束后关闭，不自动采集；不会每次开始采集都重新聚焦。信号强度是当前激光状态下的读回，激光关闭后数值低不代表聚焦失败。实际采样率在采集时从数据流读取，不是“带宽”。</p></>}
    {confirm && <Dialog title={confirm.action === "autofocus" ? "确认自动聚焦与激光安全" : "确认修改测量参数"} onClose={() => { if (!busy) setConfirm(null); }}><div className="field-confirm"><div className="field-confirm-body">
      <p className="field-notice warning"><AlertTriangle size={17} />{confirm.action === "autofocus" ? "将临时开启真实设备激光并自动聚焦，结束后尝试关闭激光。异常时必须在现场确认，必要时使用设备物理控制关闭。" : `设备 ${deviceIp}：${deviceLabels[confirm.key!]}，${valueLabel(confirm.key!, confirm.expected)} → ${valueLabel(confirm.key!, confirm.value)}。将改变实际测量条件，不只是显示。`}</p>
      <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>{confirm.action === "autofocus" ? "已确认现场人员、目标与光路安全；允许开启激光与聚焦，结束后关闭激光，并在现场核对状态。" : "已停止采集、退出其他控制程序，确认应用此项设置并重新读取实际结果。"}</span></label>
      {error && <p className="field-error">{error}</p>}</div><div className="field-form-actions"><Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button><Button variant="primary" disabled={!consent || blocked} onClick={() => void run(confirm)}>{busy && <LoaderCircle className="spin" size={14} />}确认执行</Button></div></div></Dialog>}
  </section>;
}
