"use client";
import React, { useEffect, useRef, useState } from "react";
import { Cable, LoaderCircle } from "lucide-react";
import { Button, CustomSelect } from "./common";
import { isTurntablePort, isTurntableTcpEndpoint, normalizeTurntablePort } from "./field-turntable-port";
import { fieldIsActive, type FieldRequestOptions, type FieldStatus } from "./field-types";

export function turntableConnectionEndpoint(mode: string, address: string, port: string, serial: string): string {
  if (mode === "tcp") {
    const value = `tcp://${address.trim()}:${port.trim()}`;
    if (!isTurntableTcpEndpoint(value)) throw new Error("请输入有效的IPv4地址和1～65535的端口");
    return value;
  }
  const value = normalizeTurntablePort(serial);
  if (mode !== "serial" || !isTurntablePort(value) || isTurntableTcpEndpoint(value)) throw new Error("请输入有效的本机转盘串口");
  return value;
}

export function FieldTurntableConnection({ port, status, disabled, request, onStatus, onBusy, onConnectionChange }: {
  port: string; status: FieldStatus | null; disabled: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>; onStatus: (status: FieldStatus) => void; onBusy: (busy: boolean) => void;
  onConnectionChange: (endpoint: string) => void;
}) {
  const [mode, setMode] = useState("tcp"), [address, setAddress] = useState("192.168.10.50"), [tcpPort, setTcpPort] = useState("5000"), [serial, setSerial] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const alive = useRef(false), inFlight = useRef(false), latest = useRef({ port, generation: status?.service.generation });
  latest.current = { port, generation: status?.service.generation };
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusy(false); }; }, [onBusy]);
  useEffect(() => {
    if (isTurntableTcpEndpoint(port)) {
      const match = /^tcp:\/\/([^:]+):(\d+)$/.exec(port)!;
      setMode("tcp"); setAddress(match[1]); setTcpPort(match[2]);
    } else if (isTurntablePort(port)) { setSerial(port); setMode("serial"); }
    setError(""); setNotice("");
  }, [port]);
  const blocked = disabled || pending || status?.service.state !== "ready" || fieldIsActive(status) || !!status?.deviceBusy || !!status?.turntableBusy;
  async function connect() {
    if (blocked || inFlight.current) return;
    let endpoint;
    try { endpoint = turntableConnectionEndpoint(mode, address, tcpPort, serial); }
    catch (cause) { setError((cause as Error).message); return; }
    const generation = status?.service.generation;
    inFlight.current = true; setPending(true); setError(""); setNotice(""); onBusy(true);
    onConnectionChange(endpoint);
    try {
      const result = await request<FieldStatus>({ action: "turntable", request: { action: "health", port: endpoint, axis: 1 } });
      if (!alive.current || latest.current.port !== endpoint || latest.current.generation !== generation || result.service.generation !== generation) return;
      onStatus(result);
      if (result.turntable?.port !== endpoint || result.turntable.health?.readOnly !== true || result.turntable.error)
        throw new Error(result.turntable?.error || "未收到转盘的有效反馈");
      setNotice("连接检查完成，已读取转盘反馈");
    } catch (cause) {
      if (alive.current && latest.current.generation === generation) setError(cause instanceof Error ? cause.message : "转盘连接失败");
    } finally {
      inFlight.current = false;
      if (alive.current) { setPending(false); onBusy(false); }
    }
  }
  return <section className="field-work-origin field-turntable-connection" aria-label="转盘连接设置">
    <h3>转盘连接</h3>
    <div className="field-turntable-connection-fields">
      <label>连接方式<CustomSelect aria-label="转盘连接方式" disabled={blocked} value={mode} onChange={event => setMode(event.target.value)}>
        <option value="tcp">网口 TCP</option><option value="serial">USB 串口</option>
      </CustomSelect></label>
      {mode === "tcp" ? <><label>设备地址<input aria-label="转盘设备地址" disabled={blocked} value={address} onChange={event => setAddress(event.target.value)} placeholder="192.168.10.50" /></label>
        <label>端口<input aria-label="转盘TCP端口" type="number" min="1" max="65535" step="1" disabled={blocked} value={tcpPort} onChange={event => setTcpPort(event.target.value)} /></label></>
        : <label className="field-turntable-connection-serial">本机串口<input aria-label="转盘USB串口" disabled={blocked} value={serial} onChange={event => setSerial(event.target.value)} placeholder="COM6 或 /dev/cu.usbserial-…" /></label>}
      <Button type="button" disabled={blocked} onClick={() => void connect()}>{pending ? <LoaderCircle size={15} className="spin" /> : <Cable size={15} />}连接并检查</Button>
    </div>
    <p className="field-subtext">手动控制、自动跟随和采集联动共用此连接。</p>
    {notice && <p className="field-notice" role="status">{notice}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
