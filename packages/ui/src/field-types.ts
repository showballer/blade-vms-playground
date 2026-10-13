/** Public renderer contract. Private acquisition-service credentials and URLs remain in Electron. */
export type FieldUser = { username: string; name: string; role: string };
/** Safe account metadata only; timestamps are Unix milliseconds, never service tokens or password hashes. */
export type FieldAccountInfo = {
  mode: "local" | "unified";
  serverUrl?: string;
  username?: string;
  offline?: boolean;
  offlineUntil?: number;
  lastVerifiedAt?: number;
  onlineRequired?: boolean;
};
export type FieldSyncItem = {
  recordingId: string; name: string; captureId?: string;
  state: "recording" | "queued" | "uploading" | "synced" | "error";
  progress: number; error?: string;
};
export type FieldSyncStatus = {
  enabled: boolean; connected: boolean;
  state: "unbound" | "signed-out" | "offline" | "ready" | "syncing" | "error";
  error?: string; items: FieldSyncItem[];
};
export type FieldSession = { user: FieldUser; mustChangePassword: boolean; account?: FieldAccountInfo };
export type FieldSource = "device" | "simulation";
export type FieldSimulation = { point: "P1" | "P2" | "P3"; scenario: "baseline" | "imbalance" | "impact" | "low_return" };
export type FieldSimulationInfo = {
  points: { id: FieldSimulation["point"]; label: string; sampleRate: number; samples: number; durationSeconds: number }[];
  scenarios: { id: FieldSimulation["scenario"]; label: string; description: string }[];
  sourceFile: string; sourceSha256: string; sourceScript: string; notice: string;
};
export type FieldConfig = {
  deviceIp: string;
  hostIp: string;
  name: string;
  object: string;
  turbine: string;
  point: string;
};
export type FieldWaveform = {
  source?: string;
  sampleRate: number | null;
  unit: "m/s";
  sampleStart: number;
  sampleStride?: number;
  values: number[];
  rssi: (number | null)[];
  rssiUnit?: "%";
  overrange: boolean[];
  sampleOrigin?: number | null;
  rangeStart?: number;
  rangeEnd?: number;
  sourceSamples?: number;
  representation?: "raw" | "envelope";
  envelope?: { start: number; end: number; min: number; max: number; rssiMin: number | null; rssiMax: number | null; missing: number; overrange: number }[];
  overrangeCount?: number;
  missingRssiCount?: number;
  latest?: { velocity: number; rssi: number | null };
};
export type FieldRealtime = {
  unit?: "m/s";
  source?: string;
  recordingId?: string | null;
  computedAt?: number;
  sampleRange?: { start: number; end: number };
  timeDomain?: { times: number[]; values: number[]; unit: "m/s"; representation: "full" | "minmax-display" };
  spectrogram?: { times: number[]; frequencies: number[]; db: number[][]; unit: "dB re 1 m/s"; windowSamples: number; hopSamples: number };
  quality?: { overrangeSamples: number; missingRssiSamples: number; lowReturnSamples: number };
  available: boolean;
  sampleRate: number | null;
  sampleStart?: number;
  sampleCount: number;
  windowSamples: number;
  frequencySpacingHz?: number;
  features: { mean?: number | null; rms?: number | null; peak?: number | null; peakToPeak?: number | null; dominantHz?: number | null };
  spectrum: { frequencies: number[]; amplitudes: number[] };
  warnings: string[];
};
export type FieldDeviceSettings = {
  deviceIp: string; readAt: number; source: string; error?: string;
  fields: Record<string, { supported: boolean; writable?: boolean; value?: string | number; options?: (string | number)[]; percent?: number; error?: string }>;
};
export type FieldDeviceRequest = {
  deviceIp: string; action: "read" | "set" | "autofocus"; key?: string;
  value?: string | number; expected?: string | number; confirmChange?: true; confirmLaser?: true;
};
export type FieldRecording = {
  source?: string;
  simulation?: FieldSimulation & { position?: number; rpm?: number };
  id: string;
  name: string;
  object?: string;
  turbine?: string;
  point?: string;
  samples: number;
  sampleRate: number | null;
  startedAt: string | number;
  endedAt?: string | number;
  status: "incomplete" | "complete" | "error";
  unit?: "m/s";
  error?: string;
  sampleOrigin?: number | null;
  velocityRangeMps?: number | null;
  deviceSettings?: FieldDeviceSettings | null;
};
export type FieldRecordingDetail = {
  recording: FieldRecording;
  waveform?: FieldWaveform;
};
export type FieldStatus = {
  source?: string;
  service: {
    state: "missing" | "starting" | "ready" | "error" | "stopping" | "stopped";
    error?: string;
    executable?: string;
    dllConfigured: boolean;
    launcher?: "windows-bundle" | "python-module";
  };
  state: "idle" | "starting" | "acquiring" | "stopping" | "error";
  error?: string;
  indexWarning?: string | null;
  deviceBusy?: boolean;
  deviceWarning?: string | null;
  deviceSettings?: FieldDeviceSettings | null;
  receiver?: Record<string, unknown>;
  recording?: FieldRecording;
  waveform?: FieldWaveform;
  realtime?: FieldRealtime;
};
export type FieldRequestOptions =
  | { action: "session" | "accountInfo" | "logout" | "status" | "stop" | "recordings" | "simulation" | "openDataDirectory" | "restartService" | "configureService" | "configureDll" | "syncStatus" | "retrySync" }
  | { action: "setAutoSync"; enabled: boolean }
  | { action: "syncRecording"; id: string }
  | { action: "frame"; windowMs?: number }
  | { action: "login"; username: string; password: string }
  | { action: "changePassword"; currentPassword: string; newPassword: string }
  | { action: "bindAccount"; serverUrl: string; username: string; password: string; currentPassword: string }
  | { action: "start"; config: FieldConfig & ({ source?: "device"; confirmLaser: true } | { source: "simulation"; simulation: FieldSimulation }) }
  | { action: "recording"; id: string }
  | { action: "exportRecording"; id: string }
  | { action: "waveform"; id: string; start?: number; end?: number }
  | { action: "analysis"; id: string; parameters: Record<string, unknown> }
  | { action: "rotation"; parameters: Record<string, unknown> }
  | { action: "device"; request: FieldDeviceRequest };
export type FieldRequest = (options: FieldRequestOptions) => Promise<{ status: number; data: unknown }>;

export function validateFieldConfig(config: FieldConfig): string | null {
  if (!config.name.trim()) return "请填写采集任务名称";
  const ipv4 = (value: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split(".").every((part) => Number(part) <= 255);
  if (!ipv4(config.deviceIp.trim())) return "请填写有效的设备 IPv4 地址";
  if (!ipv4(config.hostIp.trim())) return "请填写本机设备网卡的有效 IPv4 地址";
  if (config.deviceIp.trim() === config.hostIp.trim()) return "设备 IP 与本机 IP 不能相同";
  return null;
}

/** Preserve sparse-preview spacing; never assume each displayed point is adjacent. */
export function fieldSampleX(waveform: FieldWaveform, index: number): number {
  const stride = waveform.sampleStride && waveform.sampleStride > 0 ? waveform.sampleStride : 1;
  const sample = waveform.sampleStart + index * stride;
  return waveform.sampleRate && waveform.sampleRate > 0 ? sample / waveform.sampleRate * 1000 : sample;
}

export function fieldCanStart(status: FieldStatus | null, source: FieldSource = "device"): boolean {
  return Boolean(status?.service.state === "ready" && (source === "simulation" || status.service.dllConfigured) && !status.deviceBusy && (source === "simulation" || !status.deviceWarning) && !fieldIsActive(status) && ["idle", "error"].includes(status.state));
}

export function fieldIsActive(status: FieldStatus | null): boolean {
  return Boolean(status && (["starting", "acquiring", "stopping"].includes(status.state) || status.receiver?.running === true));
}

export function fieldDate(value?: string | number): Date | null {
  if (value === undefined || value === null || value === "") return null;
  // The Python service uses Unix seconds; ISO strings support older metadata.
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
