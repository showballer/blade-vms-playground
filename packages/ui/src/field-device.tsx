"use client";
import { CustomSelect } from "./custom-select";
import React, { useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { Button, Dialog } from "./common";
import { fieldDate, fieldIsActive, type FieldDeviceRequest, type FieldDeviceSettings, type FieldRssiCalibrationRequest, type FieldRssiCalibrationResult, type FieldStatus } from "./field-types";

export function FieldLaserControl({ deviceIp, status, disabled, request }: {
  deviceIp: string; status: FieldStatus | null; disabled: boolean;
  request: <T>(options: import("./field-types").FieldRequestOptions) => Promise<T>;
}) {
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const active = fieldIsActive(status);
  const blocked = busy || disabled || active || !!status?.deviceBusy || status?.service.state !== "ready" || !deviceIp.trim();
  useEffect(() => { setConsent(false); setMessage(""); setError(""); }, [deviceIp, active]);
  async function setLaser(on: boolean) {
    setBusy(true); setError(""); setMessage("");
    try {
      await request<FieldDeviceSettings>({ action: "device", request: { deviceIp: deviceIp.trim(), action: on ? "laser_on" : "laser_off", confirmLaser: true } });
      setMessage(on ? "已开启观察激光并确认读回，保持开启直到关闭或采集结束。" : "激光已关闭并确认读回。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "激光操作失败"); }
    finally { setBusy(false); }
  }
  return <section className="field-card field-laser-control field-servo-ui" aria-label="激光手动控制"><h2>激光控制</h2><p className="field-subtext">普通采集期间激光持续开启，连续记录叶片经过及间隙的振动和 RSSI。停止采集后关闭激光。</p><label className="field-turntable-toggle"><input type="checkbox" checked={consent} disabled={blocked} onChange={event => setConsent(event.target.checked)} />已确认光路安全，允许手动开启观察激光</label><div className="field-form-actions"><Button type="button" disabled={blocked || !consent} onClick={() => void setLaser(true)}>开启激光</Button><Button type="button" disabled={blocked} onClick={() => void setLaser(false)}>关闭激光</Button></div>{active && <p className="field-subtext">采集流程正在控制激光；点击“停止并保存”结束采集并关闭激光。</p>}{message && <p role="status" className="field-success">{message}</p>}{error && <p role="alert" className="field-error">{error}</p>}</section>;
}

export const deviceLabels: Record<string, string> = { velocityRange: "速度量程", bandwidth: "带宽", highPass: "高通滤波", ase: "ASE 滤波", laser: "激光状态", focusPosition: "聚焦位置", signalLevel: "信号强度", autofocus: "自动聚焦状态", autofocusResult: "上次自动聚焦结果" };
const valueLabel = (key: string, value: string | number | undefined) => value === undefined ? "未知" : ["ase", "laser"].includes(key) ? value === 1 ? "On" : value === 0 ? "Off" : String(value) : key === "autofocus" ? value === 1 ? "运行中" : "未运行" : key === "autofocusResult" ? value === 1 ? "找到焦点" : value === 0 ? "未找到焦点" : "未知" : String(value);

export function FieldDeviceSnapshot({ settings }: { settings?: FieldDeviceSettings | null }) {
  if (!settings) return <p className="field-subtext">此记录未保存厂商配置快照；不能用当前设备设置代替当时的设置。</p>;
  return <div className="field-device-snapshot"><p className="field-subtext">设备配置快照 · {fieldDate(settings.readAt)?.toLocaleString("zh-CN")} · {settings.deviceIp}（当次读取，不是实时激光状态）</p>
    <dl className="field-details">{Object.entries(deviceLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{settings.fields[key]?.supported ? key === "signalLevel" && settings.fields[key].percent !== undefined ? `${settings.fields[key].percent?.toFixed(1)} %` : valueLabel(key, settings.fields[key].value) : "未读取 / 不支持"}</dd></div>)}</dl></div>;
}

export function FieldDevicePanel({ deviceIp, hostIp, onIp, status, disabled, onBusy, onError, request, calibrate }: {
  deviceIp: string; hostIp: string; onIp: (value: string) => void; status: FieldStatus | null; disabled: boolean;
  onBusy: (busy: boolean) => void; onError: (cause: unknown) => void;
  request: (options: FieldDeviceRequest) => Promise<FieldDeviceSettings>;
  calibrate: (options: FieldRssiCalibrationRequest) => Promise<FieldRssiCalibrationResult>;
}) {
  const [snapshot, setSnapshot] = useState<FieldDeviceSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string | number>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<FieldDeviceRequest | null>(null), [consent, setConsent] = useState(false);
  const [calibrationConsent, setCalibrationConsent] = useState(false), [calibrationBusy, setCalibrationBusy] = useState(false), [calibrationDuration, setCalibrationDuration] = useState(2);
  const [calibration, setCalibration] = useState<Record<string, FieldRssiCalibrationResult>>({});
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
      setNotice(options.action === "read" ? "已读取设备实际配置；没有修改参数、开启激光或开始采集。" : options.action === "autofocus" ? "聚焦流程已结束，已发送停止聚焦和关闭激光并核对读回。请现场确认光路与激光状态；开始采集后查看 RSSI。" : options.action === "laser_on" ? "观察激光已开启并读回确认；手动调整点位时可持续观察回波。完成后请关闭激光。" : options.action === "laser_off" ? "激光已关闭并读回确认。" : "该配置项已修改并读回确认。未保存为设备上电默认设置。请核对其他受联动影响的配置项。");
    } catch (cause) { setConfirm(null); setError(cause instanceof Error ? cause.message : "配置操作失败"); onError(cause); }
    finally { setBusy(false); onBusy(false); }
  }
  async function recordCalibration(state: FieldRssiCalibrationRequest["state"]) {
    if (!calibrationConsent || !deviceIp || !hostIp) return;
    setCalibrationBusy(true); onBusy(true); setError(""); setNotice("");
    try {
      const result = await calibrate({ deviceIp: deviceIp.trim(), hostIp: hostIp.trim(), state, durationSeconds: calibrationDuration, confirmLaser: true });
      setCalibration(result.states || { ...calibration, [state]: result });
      setNotice(`${result.label}已记录：中位 RSSI ${result.median.toFixed(2)}%，样本 ${result.sampleCount.toLocaleString("zh-CN")}。激光保持开启，可调整到下一个状态。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "RSSI 标定失败"); onError(cause); }
    finally { setCalibrationBusy(false); onBusy(false); }
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
      <section className="field-card field-device-calibration field-servo-ui" aria-label="RSSI 三状态标定"><div className="field-section-heading"><div><h3>激光回波三状态标定</h3><p>转盘不动、风机转动时分别记录三种 RSSI 状态。</p></div><label>记录秒数<input type="number" min={0.5} max={10} step={0.5} value={calibrationDuration} disabled={blocked || calibrationBusy} onChange={event => setCalibrationDuration(Math.max(0.5, Math.min(10, Number(event.target.value) || 2)))} /></label></div><label className="field-turntable-toggle"><input type="checkbox" checked={calibrationConsent} disabled={blocked || calibrationBusy} onChange={event => setCalibrationConsent(event.target.checked)} />已确认激光光路安全，允许记录并保持激光开启</label><div className="field-form-actions"><Button disabled={blocked || calibrationBusy || !calibrationConsent || !snapshot.fields.laser?.supported} onClick={() => void recordCalibration("background")}>记录无叶片/背景</Button><Button disabled={blocked || calibrationBusy || !calibrationConsent || !snapshot.fields.laser?.supported} onClick={() => void recordCalibration("blade_on")}>记录叶片停在光斑上</Button><Button disabled={blocked || calibrationBusy || !calibrationConsent || !snapshot.fields.laser?.supported} onClick={() => void recordCalibration("blade_pass")}>记录手动拨过叶片</Button></div><div className="field-calibration-results">{Object.values(calibration).map(item => <div key={item.state}><span>{item.label}</span><strong>{item.median.toFixed(2)}<small>% 中位 RSSI</small></strong><p>P10 {item.p10.toFixed(2)}% · P90 {item.p90.toFixed(2)}%</p><p>{item.sampleCount.toLocaleString("zh-CN")} 个样本</p></div>)}</div></section>
      <div className="field-form-actions"><Button disabled={blocked || !snapshot.fields.autofocus?.supported || !snapshot.fields.laser?.supported} onClick={() => { setConsent(false); setConfirm({ deviceIp, action: "autofocus", confirmLaser: true }); }}>安全自动聚焦…</Button><Button disabled={blocked || !snapshot.fields.laser?.supported} onClick={() => void run({ deviceIp, action: "laser_on", confirmLaser: true })}>开启观察激光</Button><Button disabled={blocked || !snapshot.fields.laser?.supported} onClick={() => void run({ deviceIp, action: "laser_off", confirmLaser: true })}>关闭激光</Button></div>
      <p className="field-subtext">自动聚焦会临时开启激光，结束后关闭；“开启观察激光”会在停止采集期间保持激光开启，便于手动拨动叶片观察回波。完成观察后请点击“关闭激光”；开始采集后由采集流程接管，联动移动期间保持开启，到位停稳后才判断叶片进入／离开，联动任务正常完成后回到作业原点并保持开启，手动停止或异常时关闭。</p></>}
    {confirm && <Dialog title={confirm.action === "autofocus" ? "确认自动聚焦与激光安全" : "确认修改测量参数"} onClose={() => { if (!busy) setConfirm(null); }}><div className="field-confirm"><div className="field-confirm-body">
      <p className="field-notice warning"><AlertTriangle size={17} />{confirm.action === "autofocus" ? "将临时开启真实设备激光并自动聚焦，结束后尝试关闭激光。异常时必须在现场确认，必要时使用设备物理控制关闭。" : `设备 ${deviceIp}：${deviceLabels[confirm.key!]}，${valueLabel(confirm.key!, confirm.expected)} → ${valueLabel(confirm.key!, confirm.value)}。将改变实际测量条件，不只是显示。`}</p>
      <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>{confirm.action === "autofocus" ? "已确认现场人员、目标与光路安全；允许开启激光与聚焦，结束后关闭激光，并在现场核对状态。" : "已停止采集、退出其他控制程序，确认应用此项设置并重新读取实际结果。"}</span></label>
      {error && <p className="field-error">{error}</p>}</div><div className="field-form-actions"><Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button><Button variant="primary" disabled={!consent || blocked} onClick={() => void run(confirm)}>{busy && <LoaderCircle className="spin" size={14} />}确认执行</Button></div></div></Dialog>}
  </section>;
}
