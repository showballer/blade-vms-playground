import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./common";
import { FieldDeviceSnapshot } from "./field-device";
import { FieldRecordingViewer } from "./field-waveform";
import { ChartLoading } from "./chart-loading";
import { fieldDate, type FieldRecording, type FieldRecordingDetail, type FieldRequestOptions } from "./field-types";

export function FieldRecordingDialog({ recording, load, onError, onClose }: {
  recording: FieldRecording;
  load: <T>(options: FieldRequestOptions) => Promise<T>;
  onError: (cause: unknown) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<FieldRecordingDetail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => () => {
    const element = opener.current;
    if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    let cancelled = false;
    setDetail(null); setError("");
    void load<FieldRecordingDetail>({ action: "recording", id: recording.id }).then(result => {
      if (!cancelled) setDetail(result);
    }).catch(cause => {
      if (!cancelled) { setError(cause instanceof Error ? cause.message : "记录读取失败"); onError(cause); }
    });
    return () => { cancelled = true; };
  }, [recording.id, revision, load, onError]);
  return <div className="field-recording-dialog field-servo-ui"><Dialog title={`${recording.name} · 波形预览`} wide onClose={onClose}>
    <div className="field-recording-preview">
      <p className="field-subtext">{fieldDate(recording.startedAt)?.toLocaleString("zh-CN") || "—"} · 全程浏览与区间放大</p>
      {error ? <div className="field-error" role="alert">{error}<Button onClick={() => setRevision(value => value + 1)}>重新读取</Button></div>
        : !detail ? <ChartLoading label="正在读取采集记录…" />
        : <>{detail.recording.error && <p className="field-error">{detail.recording.error}</p>}
          <FieldRecordingViewer detail={detail} load={load} onError={onError} />
          <details className="field-recorded-settings"><summary>查看本次采集的设备配置快照</summary><FieldDeviceSnapshot settings={detail.recording.deviceSettings} /></details>
        </>}
    </div>
  </Dialog></div>;
}
