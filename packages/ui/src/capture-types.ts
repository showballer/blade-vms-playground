import type { FieldRecording, FieldRealtime, FieldWaveform } from "./field-types";

/** Authenticated Web contract. Raw files and desktop credentials never enter a preview. */
export type CaptureSummary = {
  id: string;
  ownerId: string;
  ownerName: string;
  tenant: string;
  clientId: string;
  localId: string;
  recording: FieldRecording;
  liveState: "acquiring" | "stopped" | "offline" | "error";
  uploadState: "pending" | "uploading" | "complete" | "error";
  receivedBytes: number;
  totalBytes: number;
  lastSeenAt: number | null;
  createdAt: string | number;
  updatedAt: string | number;
  error?: string | null;
};
export type CaptureFrame = {
  sequence: number;
  receivedAt: number;
  state: "acquiring" | "stopped" | "error";
  recording: FieldRecording;
  waveform: FieldWaveform;
  realtime?: FieldRealtime;
};
export type CaptureDetail = { capture: CaptureSummary; frame: CaptureFrame | null };

export const captureLiveLabel = (state: CaptureSummary["liveState"]) => ({ acquiring: "采集中", stopped: "采集已停止", offline: "连接中断", error: "采集异常" })[state];
export const captureUploadLabel = (state: CaptureSummary["uploadState"]) => ({ pending: "等待完整记录", uploading: "记录上传中", complete: "记录已上传", error: "上传待重试" })[state];
export function captureProgress(capture: Pick<CaptureSummary, "receivedBytes" | "totalBytes" | "uploadState">): number {
  if (capture.uploadState === "complete") return 100;
  return capture.totalBytes > 0 ? Math.max(0, Math.min(99, Math.floor(capture.receivedBytes / capture.totalBytes * 100))) : 0;
}
