"use client";
import React, { useEffect, useState } from "react";
import { Button } from "./common";
import { CustomSelect } from "./custom-select";
import { fieldIsActive, fieldTurntableMatches, fieldTurntableReady, type FieldConfig, type FieldRequestOptions, type FieldStatus, type FieldTurntableConfig } from "./field-types";

export const turntableLabels: Record<string, string> = { disconnected: "未启用", checking: "检查转盘", checked: "已读取反馈", testing: "独立试转中", test_stopping: "试转结束，确认停稳", prepared: "设置完成，可开始采集", starting: "发送运动命令", awaiting_feedback: "等待速度反馈", running: "实际转动", stopping: "确认停稳", stopped: "已确认停止", unknown: "停止未确认", error: "转盘异常" };
const initial: FieldTurntableConfig = { port: "", axis: 1, speedRpm: 0.2, direction: "forward", durationSeconds: 0, protocol: "legacy_speed" };
export function FieldTurntableSetup({ config, onConfig, status, disabled, request }: {
  config: FieldConfig; onConfig: React.Dispatch<React.SetStateAction<FieldConfig>>; status: FieldStatus | null; disabled: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>;
}) {
  const [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [recovery, setRecovery] = useState(false);
  const [consent, setConsent] = useState(false), [observed, setObserved] = useState(false), [testSeconds, setTestSeconds] = useState(3);
  const value = config.turntable || initial;
  const locked = disabled || busy || fieldIsActive(status) || !!status?.turntableBusy;
  const valid = /^COM[1-9][0-9]{0,3}$/.test(value.port) && value.speedRpm >= 0.02 && value.speedRpm <= 100 && value.durationSeconds >= 0 && value.durationSeconds <= 86400;
  const current = status?.turntable?.port === value.port && status.turntable.axis === value.axis;
  const feedback = current ? status?.turntable?.feedback : undefined;
  const test = status?.turntableTest;
  const tested = !!test?.passed && fieldTurntableMatches(test.config, value, false);
  const prepared = fieldTurntableReady(status, value);
  useEffect(() => { setConsent(false); setObserved(false); }, [value.port, value.axis, value.speedRpm, value.direction, value.protocol, test?.testedAt]);
  const stopLocked = disabled || busy || fieldIsActive(status) || !valid;
  const change = (next: Partial<FieldTurntableConfig>) => onConfig(previous => ({ ...previous, turntable: { ...value, ...next } }));
  const run = async (options: FieldRequestOptions) => {
    setError(""); setBusy(true);
    try {
      const result = await request<{ ports?: { port: string; description: string }[] }>(options);
      if (result.ports) setPorts(result.ports);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "转盘操作失败"); }
    finally { setBusy(false); }
  };
  return <section className="field-turntable-setup">
    <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={!!config.turntable} onChange={event => onConfig(previous => ({ ...previous, turntable: event.target.checked ? { ...initial } : undefined }))} />联动连续转盘</label>
    {config.turntable && <>
      <p className="field-subtext">先读取工况，再独立试转并确认停稳；确认设置后开始联合采集。试转不打开激光，也不创建振动记录。</p>
      <fieldset disabled={locked} className="field-config-grid">
        <label>转盘串口<input required aria-label="转盘串口" list="field-turntable-ports" placeholder="例如 COM6" value={value.port} onChange={event => change({ port: event.target.value.trim().toUpperCase() })} /><datalist id="field-turntable-ports">{ports.map(port => <option key={port.port} value={port.port}>{port.description}</option>)}</datalist></label>
        <label>控制轴<CustomSelect aria-label="转盘控制轴" value={value.axis} onChange={event => change({ axis: Number(event.target.value) as 1 | 2 })}><option value={1}>轴 1</option><option value={2}>轴 2</option></CustomSelect></label>
        <label>控制器接口<CustomSelect aria-label="转盘控制器接口" value={value.protocol || "legacy_speed"} onChange={event => change({ protocol: event.target.value as FieldTurntableConfig["protocol"] })}><option value="legacy_speed">旧版速度接口（0x10 / 0x05）</option><option value="continuous">连续旋转接口（0x17 / 心跳）</option></CustomSelect></label>
        <label>输出轴转速（rpm）<input required aria-label="转盘输出轴转速" type="number" min={0.02} max={100} step={0.01} value={value.speedRpm} onChange={event => change({ speedRpm: Number(event.target.value) })} /></label>
        <label>方向<CustomSelect aria-label="转盘方向" value={value.direction} onChange={event => change({ direction: event.target.value as FieldTurntableConfig["direction"] })}><option value="forward">正向</option><option value="reverse">反向</option></CustomSelect></label>
        <label>自动停止（秒，0 为人工停止）<input required aria-label="转盘自动停止时长" type="number" min={0} max={86400} step={1} value={value.durationSeconds} onChange={event => change({ durationSeconds: Number(event.target.value) })} /></label>
      </fieldset>
      <div className="field-turntable-actions">
        <Button type="button" disabled={locked} onClick={() => void run({ action: "turntablePorts" })}>刷新串口</Button>
        <Button type="button" disabled={locked || !valid || !!status?.turntableWarning && !recovery} onClick={() => void run({ action: "turntable", request: { action: "probe", port: value.port, axis: value.axis, confirmRecovery: recovery } })}>1. 读取转盘工况</Button>
        <Button type="button" variant="danger" disabled={stopLocked} onClick={() => void run({ action: "turntable", request: { action: "stop", port: value.port, axis: value.axis, confirmMotion: true } })}>停止试转 / 核查停稳</Button>
      </div>
      <div className="field-turntable-check" aria-live="polite">
        <div className="field-section-heading"><h3>采集前转盘检查</h3><span className={`field-badge ${prepared ? "green" : tested ? "amber" : ""}`}>{prepared ? "设置已确认" : status?.turntableBusy ? "检查 / 试转中" : tested ? "试转通过，待确认" : "待检查"}</span></div>
        <dl className="field-details">
          <div><dt>最近读取</dt><dd>{feedback?.observedAt ? new Date(feedback.observedAt * 1000).toLocaleTimeString("zh-CN") : "未读取当前轴"}{current && status?.turntable ? ` · ${turntableLabels[status.turntable.state] || status.turntable.state}` : ""}</dd></div>
          <div><dt>实际输出轴转速</dt><dd>{feedback?.outputRpm ?? "—"} rpm（设定 {value.speedRpm} rpm / {value.speedRpm * 6}°/秒）</dd></div>
          <div><dt>驱动器报警 / 运行状态码</dt><dd>{feedback ? `${feedback.alarmCode === 0 ? "无报警" : `报警 ${feedback.alarmCode}`} / ${feedback.runState ?? "—"}` : "未读取"}</dd></div>
          <div><dt>限位反馈</dt><dd>{!feedback ? "未读取" : feedback.limitFlags == null ? "固件未提供（允许测试）" : feedback.limitFlags === 0 ? "未触发" : `异常 (${feedback.limitFlags})`}</dd></div>
          <div><dt>原始位置 / 试转变化量</dt><dd>{feedback?.positionRaw ?? "—"} / {current && status?.turntableBusy ? status.turntable?.positionDelta ?? "—" : tested ? test?.positionDelta : "—"}</dd></div>
        </dl>
        {current && status?.turntable?.error && <p className="field-error" role="alert">{status.turntable.error}</p>}
        {test && fieldTurntableMatches(test.config, value, false) && <p className={tested ? "field-success" : "field-notice warning"}>{tested ? "目标转速、位置变化和停止反馈均已验证。请再确认现场转盘实际转动。" : test.cancelled ? "试转已取消，请重新试转完成检查。" : test.error || "试转未通过。"}</p>}
      </div>
      <div className="field-turntable-test">
        <label>达到目标速度后试转时长<CustomSelect aria-label="独立试转时长" disabled={locked} value={testSeconds} onChange={event => setTestSeconds(Number(event.target.value))}><option value={3}>3 秒</option><option value={5}>5 秒</option><option value={10}>10 秒</option></CustomSelect></label>
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={consent} onChange={event => setConsent(event.target.checked)} />允许当前轴按设定方向和转速独立试转</label>
        <Button type="button" disabled={locked || !valid || !consent || !!status?.turntableWarning || !feedback || feedback.motorRpm !== 0 || !!feedback.alarmCode || feedback.limitFlags != null && feedback.limitFlags !== 0} onClick={() => { setObserved(false); void run({ action: "turntable", request: { ...value, action: "test", testSeconds, confirmMotion: true } }); }}>2. 开始短时试转（自动停止）</Button>
        <p className="field-subtext">0.2 rpm 仅为 1.2°/秒；3 秒约 3.6°，不会转完一圈。启动等待最多 10 秒，之后按选定时长试转；可随时点击停止。请选择与已安装固件一致的接口，不会自动切换接口重发运动。请退出占用串口的控制器软件。</p>
        <label className="field-turntable-toggle"><input type="checkbox" disabled={locked || !tested} checked={observed} onChange={event => setObserved(event.target.checked)} />已观察到转盘实际转动、方向正确且停稳，采集参数已设置完成</label>
        <Button type="button" variant="primary" disabled={locked || !valid || !tested || !observed || !!status?.turntableWarning} onClick={() => void run({ action: "turntable", request: { ...value, action: "prepare", confirmMotion: true } })}>3. 确认设置，允许联合采集</Button>
        {!prepared && <p className="field-subtext">联合采集暂未放行。更改串口、轴、接口、转速或方向需重新试转；只更改采集时长需重新确认设置。</p>}
      </div>
      {status?.turntableWarning && <><p className="field-error">{status.turntableWarning}</p><label className="field-turntable-toggle"><input type="checkbox" disabled={locked} checked={recovery} onChange={event => setRecovery(event.target.checked)} />已在现场确认转盘停稳，允许读取同一轴并恢复联合任务</label></>}
      <p className="field-subtext">输出轴 50:1；仅连续定速，不校正叶片相位。停止并保存将结束转盘和采集。联合记录与遥测保存在本机，暂不上传 Web。</p>
      {error && <p className="field-error" role="alert">{error}</p>}
    </>}
  </section>;
}

export function FieldTurntableFeedback({ status }: { status: FieldStatus | null }) {
  const value = status?.turntable, feedback = value?.feedback;
  if (!value || value.state === "disconnected") return null;
  return <section className="field-card"><h2>转盘状态</h2><p>{turntableLabels[value.state] || value.state}{value.port ? ` · ${value.port}` : ""}{value.axis ? ` · 轴 ${value.axis}` : ""}</p><dl className="field-details">
    <div><dt>实际输出轴转速</dt><dd>{feedback?.outputRpm ?? "—"} rpm</dd></div>
    <div><dt>限位反馈</dt><dd>{feedback?.limitFlags == null ? "未提供（允许测试）" : feedback.limitFlags === 0 ? "未触发" : `保护异常 (${feedback.limitFlags})`}</dd></div>
    <div><dt>驱动器报警</dt><dd>{feedback?.alarmCode ?? "—"}</dd></div>
    <div><dt>原始位置计数</dt><dd>{feedback?.positionRaw ?? "—"}</dd></div>
  </dl><p className="field-subtext">位置尚未标定为机械角度；状态为最近一次读取反馈。</p>{value.error && <p className="field-error">{value.error}</p>}</section>;
}
