"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, LoaderCircle, Power, RefreshCw } from "lucide-react";
import { Button } from "./common";
import { fieldIsActive, type FieldDeviceSettings, type FieldLaserStatus, type FieldRequestOptions, type FieldStatus } from "./field-types";

type Props = {
  deviceIp: string; status: FieldStatus | null; disabled: boolean; pollUnavailable?: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>; onBusy?: (busy: boolean) => void;
};
type Snapshot = { value: FieldLaserStatus; scope: string };
const validIp = (ip: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every(part => Number(part) <= 255);
const acquisitionTitle = "由采集流程控制，停止并保存后可手动开关";

/** Only a fresh device readback may describe the laser as on or off. */
export function headerLaserReadbackState(value: FieldLaserStatus | null | undefined, deviceIp: string, nowMs = Date.now()): FieldLaserStatus["state"] {
  if (!validIp(deviceIp.trim()) || !value || value.deviceIp !== deviceIp.trim() || value.source !== "device-readback" || value.error ||
      !["on", "off"].includes(value.state) || typeof value.busy !== "boolean" || typeof value.readAt !== "number" ||
      !Number.isFinite(value.readAt) || value.readAt <= 0 || !Number.isFinite(nowMs)) return "unknown";
  // Python timestamps retain sub-millisecond precision; Date.now() does not.
  // Compare at the same precision so a just-completed read is not briefly
  // classified as future data and left with a stale warning.
  const age = nowMs - Math.floor(value.readAt * 1000 + .001);
  return age >= 0 && age < 3000 ? value.state : "unknown";
}

export function headerLaserWriteBlock(status: FieldStatus | null, disabled: boolean, pollUnavailable = false): string {
  if (fieldIsActive(status)) return acquisitionTitle;
  if (status?.deviceBusy || status?.turntableBusy) return "设备正在操作，完成后可手动开关";
  if (disabled) return "当前操作进行中，请稍后手动开关";
  if (pollUnavailable || !status || status.service.state !== "ready") return "设备状态未确认，请先恢复连接";
  return "";
}

export function FieldHeaderLaser({ deviceIp, status, disabled, pollUnavailable = false, request, onBusy }: Props) {
  const ip = deviceIp.trim(), ready = status?.service.state === "ready";
  const scope = JSON.stringify([ip, status?.service.generation, ready]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [reading, setReading] = useState(false), [writing, setWriting] = useState(false);
  const [readError, setReadError] = useState(""), [commandError, setCommandError] = useState("");
  const [, tick] = useState(0);
  const alive = useRef(false), readVersion = useRef(0), readFlight = useRef<Promise<void> | null>(null), writeFlight = useRef(false);
  const latest = useRef({ ip, scope, ready, status, disabled, pollUnavailable, request });
  latest.current = { ip, scope, ready, status, disabled, pollUnavailable, request };
  const busyCallback = useRef(onBusy); busyCallback.current = onBusy;
  const previousScope = useRef(scope);
  if (previousScope.current !== scope) { previousScope.current = scope; readVersion.current++; }
  const view = ready && !pollUnavailable && snapshot?.scope === scope ? headerLaserReadbackState(snapshot.value, ip) : "unknown";
  const blocked = headerLaserWriteBlock(status, disabled, pollUnavailable) || (snapshot?.scope === scope && snapshot.value.busy ? "设备正在操作，完成后可手动开关" : "");
  const error = commandError || readError;
  const label = view === "on" ? "关闭激光" : view === "off" ? "开启激光" : "检查激光";
  const stateText = view === "on" ? "已开启" : view === "off" ? "已关闭" : "未知";
  const messageId = useId();

  function currentReadback() {
    const current = latest.current;
    return current.ready && !current.pollUnavailable && snapshot?.scope === current.scope
      ? headerLaserReadbackState(snapshot.value, current.ip) : "unknown";
  }
  function inScope(expected: string) { return alive.current && latest.current.scope === expected; }

  function readLaser(duringWrite = false): Promise<void> {
    const current = latest.current;
    if (!current.ready || !validIp(current.ip) || writeFlight.current && !duringWrite) return Promise.resolve();
    if (readFlight.current) return readFlight.current;
    const requestedScope = current.scope, version = readVersion.current;
    setReading(true);
    // Deferring one microtask installs the single-flight promise even if a
    // request implementation throws synchronously.
    const task = Promise.resolve().then(async () => {
      try {
        const value = await current.request<FieldLaserStatus>({ action: "device", request: { deviceIp: current.ip, action: "laser_read" } });
        if (!inScope(requestedScope) || version !== readVersion.current || latest.current.pollUnavailable) return;
        const accepted = value && typeof value === "object" ? value : null;
        setSnapshot(accepted ? { value: accepted, scope: requestedScope } : null); tick(value => value + 1);
        setReadError(typeof accepted?.error === "string" && accepted.error || (headerLaserReadbackState(accepted, current.ip) === "unknown" ? "尚未取得有效的激光状态回读" : ""));
      } catch (cause) {
        if (inScope(requestedScope) && version === readVersion.current) {
          setSnapshot(null); setReadError(cause instanceof Error ? cause.message : "激光状态读取失败");
        }
      } finally {
        if (readFlight.current === task) readFlight.current = null;
        if (alive.current) setReading(false);
      }
    });
    readFlight.current = task;
    return task;
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; readVersion.current++; if (writeFlight.current) busyCallback.current?.(false); };
  }, []);
  useEffect(() => {
    setSnapshot(null); setReadError(""); setCommandError("");
    void readLaser();
    const timer = window.setInterval(() => { tick(value => value + 1); void readLaser(); }, 1000);
    return () => window.clearInterval(timer);
  }, [scope]);
  useEffect(() => { if (pollUnavailable) { setSnapshot(null); readVersion.current++; } }, [pollUnavailable]);
  useEffect(() => {
    if (!snapshot || snapshot.scope !== scope || typeof snapshot.value.readAt !== "number") return;
    const remaining = snapshot.value.readAt * 1000 + 3000 - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => tick(value => value + 1), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [snapshot, scope]);

  async function command(on: boolean) {
    const current = latest.current;
    if (writeFlight.current || !validIp(current.ip) || headerLaserWriteBlock(current.status, current.disabled, current.pollUnavailable) ||
        currentReadback() !== (on ? "off" : "on")) return;
    const requestedScope = current.scope, generation = current.status?.service.generation, initialReadback = snapshot?.value;
    writeFlight.current = true; readVersion.current++; setWriting(true); setSnapshot(null); setReadError(""); setCommandError(""); busyCallback.current?.(true);
    try {
      if (readFlight.current) await readFlight.current;
      if (!inScope(requestedScope) || latest.current.pollUnavailable) return;
      const checked = await latest.current.request<FieldStatus>({ action: "status" });
      if (!inScope(requestedScope) || latest.current.pollUnavailable) return;
      // The parent becomes disabled because this command owns its busy flag.
      // Re-check the latest actual status, not that self-imposed UI lock.
      const reason = headerLaserWriteBlock(latest.current.status, false, latest.current.pollUnavailable) ||
        headerLaserWriteBlock(checked, false, latest.current.pollUnavailable);
      if (checked.service.generation !== generation || reason) throw new Error(reason || "采集服务已变化，请重新检查激光");
      const checkedState = headerLaserReadbackState(checked.laserStatus, current.ip);
      const checkedIsNewer = checkedState !== "unknown" && checked.laserStatus!.readAt! >= (initialReadback?.readAt ?? -Infinity);
      const freshState = checkedIsNewer ? checkedState : headerLaserReadbackState(initialReadback, current.ip);
      if (freshState === "unknown") throw new Error("激光状态已过期，请重新检查");
      if (checkedIsNewer && checked.laserStatus!.busy) throw new Error("设备正在操作，完成后可手动开关");
      if (freshState === (on ? "on" : "off")) return;
      await latest.current.request<FieldDeviceSettings>({ action: "device", request: { deviceIp: current.ip, action: on ? "laser_on" : "laser_off", confirmLaser: true } });
    } catch (cause) {
      if (inScope(requestedScope)) { setSnapshot(null); setCommandError(cause instanceof Error ? cause.message : "激光操作失败"); }
    } finally {
      if (inScope(requestedScope)) await readLaser(true);
      writeFlight.current = false;
      if (alive.current) { setWriting(false); busyCallback.current?.(false); }
    }
  }

  function act() {
    if (writeFlight.current) return;
    if (view === "unknown") { setCommandError(""); void readLaser(); return; }
    if (blocked || !validIp(ip)) return;
    void command(view === "off");
  }

  return <div className="field-header-laser field-servo-ui" aria-label="激光状态与控制" data-state={view}>
    <span className="field-header-laser-state" role="status" aria-live="polite" aria-label={`激光状态：${stateText}`} aria-describedby={error ? messageId : undefined}>
      <span className="field-header-laser-dot" aria-hidden="true" />激光 <strong>{stateText}</strong>
    </span>
    <Button type="button" variant="ghost" className="field-header-laser-action" aria-label={label}
      disabled={writing || !ready || !validIp(ip) || view !== "unknown" && !!blocked}
      title={blocked || error || (view === "unknown" ? "只读取设备状态，不会开启激光" : label)} onClick={act}>
      {reading || writing ? <LoaderCircle size={14} className="spin" /> : view === "unknown" ? <RefreshCw size={14} /> : <Power size={14} />}
      {writing ? "处理中…" : label}
    </Button>
    {error && <span className="field-header-laser-error" title={error}><AlertCircle size={14} aria-hidden="true" /><span className="field-header-laser-message" id={messageId} role="alert">{error}</span></span>}
  </div>;
}
