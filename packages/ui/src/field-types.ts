/** Public renderer contract. Service credentials and URLs remain in Electron. */
export type FieldUser = { username: string; name: string; role: string };
export type FieldSession = { user: FieldUser; mustChangePassword: boolean };
export type FieldConfig = {
  deviceIp: string;
  hostIp: string;
  name: string;
  object: string;
  turbine: string;
  point: string;
};
export type FieldWaveform = {
  sampleRate: number | null;
  unit: "m/s";
  sampleStart: number;
  sampleStride?: number;
  values: number[];
  rssi: (number | null)[];
  rssiUnit?: "%";
  overrange: boolean[];
};
export type FieldRecording = {
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
};
export type FieldRecordingDetail = {
  recording: FieldRecording;
  waveform?: FieldWaveform;
};
export type FieldStatus = {
  service: {
    state: "missing" | "starting" | "ready" | "error" | "stopping" | "stopped";
    error?: string;
    executable?: string;
    dllConfigured: boolean;
  };
  state: "idle" | "starting" | "acquiring" | "stopping" | "error";
  error?: string;
  indexWarning?: string | null;
  receiver?: Record<string, unknown>;
  recording?: FieldRecording;
  waveform?: FieldWaveform;
};
export type FieldRequestOptions =
  | { action: "session" | "logout" | "status" | "frame" | "stop" | "recordings" | "openDataDirectory" | "restartService" | "configureService" | "configureDll" }
  | { action: "login"; username: string; password: string }
  | { action: "changePassword"; currentPassword: string; newPassword: string }
  | { action: "start"; config: FieldConfig & { confirmLaser: true } }
  | { action: "recording"; id: string };
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

export function fieldCanStart(status: FieldStatus | null): boolean {
  return Boolean(status?.service.state === "ready" && status.service.dllConfigured && !fieldIsActive(status) && ["idle", "error"].includes(status.state));
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
