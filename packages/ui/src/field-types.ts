import { isTurntablePort } from "./field-turntable-port";
import type { FieldSinglePointRequest, FieldSinglePointStatus, FieldSinglePointPreview } from "./field-single-point-types";
import type { FieldMotionTrialRequest, FieldMotionTrialPreview } from "./field-motion-trial-types";
/** Shared final angle acceptance; reference, zero-speed and fault checks remain mandatory. */
export const FIELD_POSITION_TOLERANCE_DEG = .5;
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
  uploadSampleRate?: number;
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
  windFarm?: string;
  object: string;
  turbine: string;
  point: string;
  turntable?: FieldTurntableConfig;
};
export type FieldTurntableConfig = { port: string; axis: 1 | 2; speedRpm: number; direction: "forward" | "reverse"; durationSeconds: number; protocol?: "legacy_speed" | "continuous" | "position"; targetAngleDeg?: number };
export type FieldAutoFollowGeometry = {
  distanceM: number; hubHeightDeltaM: number; rotationDirection: "clockwise" | "counterclockwise";
  axis1Sign: 1 | -1; axis2Sign: 1 | -1; anchorRadiusM: number;
  pitchAngleScale?: number; yawAngleScale?: number;
  anchorAxis1AngleDeg: number; anchorAxis2AngleDeg: number;
};
export type FieldPointCyclePoint = { pointId?: string; name: string; axis1AngleDeg: number; axis2AngleDeg: number; port?: string; referenceSignature?: string;
  bladeId?: string; radialPointId?: string; radialPointName?: string; radiusM?: number; azimuthDeg?: number; rootRadiusM?: number; bladeLengthM?: number };
export type FieldPlannedStation = { pointId: string; bladeId: string; radialPointId: string; radialPointName: string; radiusM: number; azimuthDeg: number; stationIndex: number; stationCount: number;
  name?: string; axis1AngleDeg?: number; axis2AngleDeg?: number; rootRadiusM?: number; bladeLengthM?: number; distanceFromRootM?: number };
export type FieldSegmentExecution = {
  executionMode?: "continuous" | "manual_segments";
  segmentedAutoMove?: boolean;
  segmentStepDeg?: number; totalStationCount?: number;
  segmentStationIds?: string[];
};
export type FieldAutomaticRecord = FieldSegmentExecution & {
  recordedPort?: string; referenceSignature?: string;
  mode?: "automatic_stations" | "legacy"; collectionId?: string; sessionId?: string; bladeId?: string; radialPointId?: string; radialPointName?: string;
  radiusM?: number; azimuthDeg?: number; stationIndex?: number; stationCount?: number; lapIndex?: number;
  identitySource?: "operator_assigned"; identityVerified?: false; coverageKind?: "sparse_station_passes" | "manual_segment_passes";
  passCompleteness?: "confirmed" | "unconfirmed"; completenessReason?: string | null;
  completion?: "unconfirmed_pass" | "confirmed_pass" | "diagnostic_pass" | "missing_entry" | "missing_exit" | "signal_gap" | "cancelled" | "device_error";
  plannedStations?: FieldPlannedStation[]; nominalPeriodSeconds?: number;
};
export type FieldPointCycleConfig = FieldSegmentExecution & {
  /** Captures only this segment, then stops DAQ and positions here for the next manual Start. */
  nextWaitPoint?: FieldPointCyclePoint;
  /** Complete circular plan retained for archive coverage across manual segments. */
  segmentStations?: FieldPointCyclePoint[];
  port: string; points: FieldPointCyclePoint[]; cycles: number; dwellSeconds: number; speedRpm: number;
  startAtCurrentPose?: boolean;
  /** Absolute controller coordinates of the existing work zero; return only on normal completion. */
  returnToOrigin?: FieldPointCyclePoint;
  /** Joint-trajectory acceleration limit in output degrees/s²; older clients default to 3. */
  maxMoveAccelerationDegS2?: number;
  /** In-motion joint following-error limit in degrees; omitted older settings default to 0.75. Arrival tolerance is separate. */
  followErrorLimitDeg?: number;
  /** nominalPeriodSeconds=0 means real blade passes are operator-driven, without a nominal phase schedule. */
  mode?: "automatic_stations" | "legacy"; routeOrder?: "configured" | "shortest_safe"; collectionId?: string; nominalPeriodSeconds?: number; maxMoveRpm?: number; geometry?: FieldAutoFollowGeometry;
  rssiTriggerEnabled?: boolean; rssiThresholdMode?: "adaptive" | "absolute"; rssiLeaveThresholdPercent?: number;
  rssiBaselineRatio?: number; rssiSmoothingMs?: number; rssiConfirmMs?: number; rssiMotionMarginMs?: number; rssiMinimumSeconds?: number;
  rssiEnterSpread?: number; rssiExitSpread?: number; rssiEnterConfirmMs?: number;
  /** Light stays on during motion and normal completion; stopped arrival starts blade detection. Errors/cancellation switch it off. */
  keepLaserOnBetweenPoints?: boolean;
  diagnosticDetectBeforeSettled?: boolean; diagnosticAngleWindowDeg?: number;
  motionLaserPolicy?: "continuous" | "off_during_motion";
};
export type FieldCycleProcessEvent = { sequence: number; phase: string; at: number; cycle: number; point?: string | null; fromPoint?: string; sampleIndex?: number | null; sampleElapsedSeconds?: number | null; rssiSpread?: number | null; error?: string | null };
export type FieldBladePoint = {
  pointId?: string;
  name: string;
  bladeIndex: number;
  bladePointIndex: 1 | 2 | 3;
  circleIndex: number;
  circleStepDeg: number;
  recordedAt: number;
  axis1AngleDeg: number | null;
  axis2AngleDeg: number | null;
  axis1RawCounts: number | null;
  axis2RawCounts: number | null;
  referenceSignature?: string;
  references?: string;
  port?: string;
};
export type FieldAxisFeedback = {
  output_angle_deg: number | null; motor_rpm: number; actual_counts: number; commanded_counts: number;
  error_counts: number; display_mode: number; command_counts_per_rev: number; encoder_bits: number;
  flags: number; fault: number; origin_counts: number; home_phase: number; observedAt: number;
  referenceAngleDeg: number; guard: { soft_enabled: boolean; hardware_enabled: boolean; minimum_deg: number; maximum_deg: number };
};
export type FieldMotionMode = "dual_axis_timed" | "sequential" | "drive_internal";
export type FieldTurntableMotionCapability = {
  supported: boolean; mode: FieldMotionMode; pointMode?: "drive_internal" | null; preloadedPoints?: boolean; protocol: "0x30-0x36" | null;
  probe: "confirmed" | "legacy-command-unsupported" | "driver-unavailable";
  status: Record<string, unknown> | null;
};
export type FieldTurntableMove = {
  mode: FieldMotionMode; plannedSeconds?: number; actualSeconds?: number; speedLimitRpm?: number;
  positionProtocol?: "0x19" | "0x43" | "0x1A" | null; toleranceDeg?: number; bankId?: number; pointIndex?: number;
  accelerationLimitDegS2?: number; targets?: [number, number]; pointCount?: number;
  adaptiveFollow?: boolean; cycleMs?: number; followErrorLimitDeg?: number;
  arrivalToleranceDeg?: number; waitTimeoutSeconds?: number;
  timingBasis?: "controller_timed_joint_move"; measurementDuringMotion?: false;
  session?: number; status?: Record<string, unknown>; state?: string; error?: string; stopError?: string;
};
export type FieldTurntableHomingAction = "mechanical_home" | "horizontal_zero";
export type FieldTurntableHoming = { action: FieldTurntableHomingAction; state: "running" | "complete" | "cancelled" | "error"; phase: string; targetAngleDeg: number; speedDegS: number; effectiveRpm: number; verified?: boolean; referenceRebuilt?: boolean; stopConfirmed?: boolean };
export type FieldTurntableRecoveryAction = "clear_trajectory_fault" | "clear_guard_fault" | "clear_axis1_reference" | "reset_alarm" | "cancel_trajectory";
export type FieldDriveMotionProfile = { accel_ms: number; decel_ms: number; s_curve_ms: number };
export type FieldDriveProfileRead = { axis: 1 | 2; values: FieldDriveMotionProfile; readAt: number; operation: "read" | "write"; verified: true; temporary: true };
export type FieldTurntableFaultAdvice = { domain: string; code: number | string; title: string; steps: string[]; motor_id: number | null; detail?: string; execution_unknown?: boolean };
export type FieldTurntableHealthRead = {
  issues?: FieldTurntableFaultAdvice[];
  motionProfiles?: Record<string, { accel_ms?: number; decel_ms?: number; s_curve_ms?: number; unavailable?: string }>;
  readAt: number; readOnly: true; referenceChangedDuringRead: boolean;
  axes: Record<string, { alarmCode: number | null; runState: number | null; limitFlags: number | null; observedAt: number }>;
};
export type FieldTurntableStatus = { preloadedRoute?: { mode: "preloaded"; pointCount: number; bankId: number; speedRpm: number; toleranceDeg: number; reused: boolean; uploadElapsedMs: number } | null; homing?: FieldTurntableHoming; motionProfile?: FieldDriveProfileRead; recovery?: { action: FieldTurntableRecoveryAction; axis: number; verified: true; completedAt: number }; health?: FieldTurntableHealthRead; state: string; port?: string; axis?: number; connected?: boolean; effectiveRpm?: number; positionDelta?: number; motionCapability?: FieldTurntableMotionCapability; motionMode?: FieldMotionMode; lastMove?: FieldTurntableMove; recall?: { state: "moving" | "complete" | "cancelled" | "error"; targets: [number, number]; completedAxes: number[]; motionMode?: FieldMotionMode; lastMove?: FieldTurntableMove }; feedback?: { outputRpm: number; motorRpm: number; runState?: number; alarmCode: number; limitFlags: number | null; positionRaw: number; outputAngleDeg?: number | null; axes?: Record<string, FieldAxisFeedback>; observedAt?: number }; error?: string };
/** A probe releases the serial port afterwards; capability is not a live connection indicator. */
export function fieldTurntableMotionMode(turntable: FieldTurntableStatus | undefined, port: string): FieldMotionMode | "unknown" {
  if (!port || turntable?.port !== port) return "unknown";
  const capability = turntable.motionCapability;
  if (capability?.supported && capability.mode === "dual_axis_timed" && capability.protocol === "0x30-0x36" && capability.probe === "confirmed") return capability.pointMode === "drive_internal" ? "drive_internal" : "dual_axis_timed";
  if (capability?.supported === false && capability.mode === "sequential" && capability.probe === "legacy-command-unsupported") return "sequential";
  return "unknown";
}
export type FieldWaveform = {
  source?: string;
  sampleRate: number | null;
  unit: "m/s";
  sampleStart: number;
  sampleStride?: number;
  values: number[];
  rssi: (number | null)[];
  rssiUnit?: "%";
  rssiSampleStride?: number;
  rssiSampleRate?: number;
  overrange: boolean[];
  sampleOrigin?: number | null;
  rangeStart?: number;
  rangeEnd?: number;
  sourceSamples?: number;
  representation?: "raw" | "envelope";
  envelope?: { start: number; end: number; min: number; max: number; rssiMin: number | null; rssiMax: number | null; missing: number; overrange: number }[];
  overrangeCount?: number;
  missingRssiCount?: number;
  latest?: { velocity: number; rssi: number | null; rssiSampleIndex?: number | null };
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
export type FieldLaserStatus = {
  deviceIp: string; state: "on" | "off" | "unknown"; readAt: number | null;
  source: "device-readback" | "unavailable"; error?: string; busy: boolean;
};
export type FieldDeviceRequest = {
  deviceIp: string; action: "read" | "set" | "autofocus" | "laser_on" | "laser_off" | "laser_read"; key?: string;
  value?: string | number; expected?: string | number; confirmChange?: true; confirmLaser?: true;
};
export type FieldRssiCalibrationRequest = { deviceIp: string; hostIp: string; state: "background" | "blade_on" | "blade_pass"; durationSeconds: number; confirmLaser: true };
export type FieldRssiCalibrationResult = { state: FieldRssiCalibrationRequest["state"]; label: string; recordedAt: number; startedAt: number; durationSeconds: number; sampleRate: number | null; sampleCount: number; minimum: number; p10: number; median: number; mean: number; p90: number; maximum: number; samples: number[]; states?: Record<string, FieldRssiCalibrationResult> };
export type FieldRecording = {
  diagnosticOnly?: boolean;
  validMeasurement?: boolean;
  sampling?: { kind: "anti_alias_lowpass"; sourceSampleRate: number; sourceSamples: number; targetSampleRate: number; recommendedMaxFrequencyHz: number };
  captureSessionId?: string;
  turntable?: FieldTurntableStatus & { config: FieldTurntableConfig; telemetry?: { events: number; file: string; sha256: string; cloudSync: string } };
  source?: string;
  simulation?: FieldSimulation & { position?: number; rpm?: number };
  id: string;
  name: string;
  windFarm?: string;
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
  pointCycle?: FieldAutomaticRecord & { cycle: number; pointIndex: number; pointId?: string; pointName: string; cycles: number; dwellSeconds: number; targetAxis1AngleDeg: number; targetAxis2AngleDeg: number; actualAngles?: Record<string, number | null> };
};
export type FieldRecordingDetail = {
  recording: FieldRecording;
  waveform?: FieldWaveform;
};
export type FieldStatus = {
  source?: string;
  service: {
    generation?: number;
    state: "missing" | "starting" | "ready" | "error" | "stopping" | "stopped";
    error?: string;
    executable?: string;
    dllConfigured: boolean;
    sdkPath?: string;
    launcher?: "windows-bundle" | "macos-bundle" | "python-module";
  };
  state: "idle" | "starting" | "acquiring" | "stopping" | "error";
  error?: string;
  indexWarning?: string | null;
  deviceBusy?: boolean;
  deviceWarning?: string | null;
  turntable?: FieldTurntableStatus;
  turntableBusy?: boolean;
  singlePoint?: FieldSinglePointStatus | null;
  singlePointPreview?: FieldSinglePointPreview;
  motionTrialPreview?: FieldMotionTrialPreview;
  turntableWarning?: string | null;
  turntableTest?: { passed: boolean; cancelled?: boolean; config: Omit<FieldTurntableConfig, "durationSeconds">; effectiveRpm?: number; positionDelta: number; testedAt: number; error?: string | null } | null;
  turntablePreparation?: { ready: boolean; config: FieldTurntableConfig; checkedAt: number } | null;
  pointCycle?: FieldSegmentExecution & { movingToWaitPoint?: boolean; nextWaitPoint?: FieldPointCyclePoint; waitingPoint?: FieldPointCyclePoint & { confirmedAt: number; actualAngles: Record<string, number> }; diagnosticDetectBeforeSettled?: boolean; diagnosticAngleWindowDeg?: number; laserPolicy?: "continuous_during_session" | "off_during_motion"; returningToOrigin?: boolean; returnToOrigin?: FieldPointCyclePoint | null; returnOrigin?: FieldPointCyclePoint & { confirmedAt: number; actualAngles: Record<string, number> }; sessionId?: string; mode?: "automatic_stations" | "legacy"; plannedStations?: FieldPlannedStation[]; geometry?: FieldAutoFollowGeometry; targetPointId?: string; targetAxis1AngleDeg?: number; targetAxis2AngleDeg?: number; state: "checking" | "ready" | "positioning" | "holding" | "capturing" | "complete" | "cancelled" | "error"; port?: string; cycles: number; dwellSeconds: number; speedRpm: number; pointCount: number; cycle: number; point: number; currentPoint?: string | null; completedRecords: number; totalRecords: number; routeStrategy?: string; motionMode?: FieldMotionMode; lastMove?: FieldTurntableMove; plannedOrder?: string[]; error?: string | null; rssiTriggerEnabled?: boolean; rssiLeaveThresholdPercent?: number | null; rssiConfirmSamples?: number; rssiMinimumSeconds?: number; latestRssi?: number | null; rssiSamples?: number; rssiBelowSamples?: number; rssiThresholdMode?: "adaptive" | "absolute"; rssiBaselineRatio?: number; rssiConfirmMs?: number; rssiBaseline?: number | null; rssiThreshold?: number | null; rssiFreshEntryRequired?: boolean; rssiEntryEdgeReady?: boolean; rssiEntryClearMs?: number; rssiBackgroundPolicy?: "advisory" | "required" | "disabled"; rssiBackgroundReady?: boolean; rssiBackgroundMs?: number; rssiBackgroundRequiredMs?: number; rssiBackgroundMean?: number | null; rssiPartialPassesIgnored?: number; rssiPhase?: "waiting_entry_clear" | "entry_clear_confirmed" | "waiting_background" | "background_ready" | "partial_pass_ignored" | "waiting_blade" | "confirming_entry" | "blade_present" | "confirming_exit" | "blade_left" | null; rssiSpread?: number | null; rssiEntryMs?: number; rssiEnterSpread?: number; rssiExitSpread?: number; rssiEnterConfirmMs?: number; processPhase?: string; processEvents?: FieldCycleProcessEvent[]; rssiBelowMs?: number; rssiSlope?: number | null; predictedLeaveSeconds?: number | null; requiredLeadSeconds?: number; nextPoint?: string | null; rssiTrigger?: "blade_left" | null } | null;
  deviceSettings?: FieldDeviceSettings | null;
  laserStatus?: FieldLaserStatus | null;
  receiver?: Record<string, unknown>;
  recording?: FieldRecording;
  waveform?: FieldWaveform;
  realtime?: FieldRealtime;
};
export type FieldRequestOptions =
  | { action: "session" | "accountInfo" | "logout" | "status" | "stop" | "recordings" | "simulation" | "openDataDirectory" | "restartService" | "configureService" | "configureDll" | "syncStatus" | "retrySync" | "turntablePorts" }
  | { action: "setAutoSync"; enabled: boolean }
  | { action: "setUploadSampleRate"; sampleRate: number }
  | { action: "syncRecording"; id: string }
  | { action: "frame"; windowMs?: number }
  | { action: "login"; username: string; password: string }
  | { action: "changePassword"; currentPassword: string; newPassword: string }
  | { action: "bindAccount"; serverUrl: string; username: string; password: string; currentPassword: string }
  | { action: "rebindAccount"; serverUrl: string; username: string; password: string; currentPassword: string }
  | { action: "unbindAccount"; currentPassword: string; newLocalPassword: string }
  | { action: "start"; config: FieldConfig & { clientRequestedAt?: number } & ({ source?: "device"; confirmLaser: true; confirmMotion?: true; pointCycle?: FieldPointCycleConfig } | { source: "simulation"; simulation: FieldSimulation }) }
  | { action: "recording"; id: string }
  | { action: "exportRecording"; id: string }
  | { action: "exportTask"; recordingIds: string[]; level: "task" | "blade" | "point" }
  | { action: "waveform"; id: string; start?: number; end?: number }
  | { action: "analysis"; id: string; parameters: Record<string, unknown> }
  | { action: "rotation"; parameters: Record<string, unknown> }
  | { action: "bladePasses"; parameters: Record<string, unknown> }
  | { action: "device"; request: FieldDeviceRequest }
  | { action: "rssiCalibration"; request: FieldRssiCalibrationRequest }
  | { action: "singlePoint"; request: FieldSinglePointRequest }
  | { action: "motionTrial"; request: FieldMotionTrialRequest }
  | { action: "turntable"; request: { action: "read_motion_profile" | "set_motion_profile" | "probe" | "health" | "test" | "manual_move" | "recall" | "prepare" | "stop" | "reference" | "limits" | FieldTurntableRecoveryAction | FieldTurntableHomingAction; homingSpeedDegS?: number; port: string; axis: 1 | 2; speedRpm?: number; direction?: FieldTurntableConfig["direction"]; durationSeconds?: number; protocol?: FieldTurntableConfig["protocol"]; targetAngleDeg?: number; axis1AngleDeg?: number; axis2AngleDeg?: number; maxMoveAccelerationDegS2?: number; followErrorLimitDeg?: number; referenceSignature?: string; recordedPort?: string; preloadPoints?: [number, number][]; preloadReturnPoint?: [number, number]; directPositionOnly?: boolean; testSeconds?: number; confirmMotion?: true; confirmRecovery?: boolean; expectedTrajectorySession?: number; motionProfile?: FieldDriveMotionProfile; expectedMotionProfile?: FieldDriveMotionProfile } };

export function fieldTurntableMatches(a: FieldTurntableConfig | Omit<FieldTurntableConfig, "durationSeconds"> | undefined, b: FieldTurntableConfig, duration = true) {
  return !!a && a.port === b.port && a.axis === b.axis && a.speedRpm === b.speedRpm && a.direction === b.direction &&
    (a.protocol || "legacy_speed") === (b.protocol || "legacy_speed") && (b.protocol !== "position" || a.targetAngleDeg === b.targetAngleDeg) && (!duration || "durationSeconds" in a && a.durationSeconds === b.durationSeconds);
}
export function fieldTurntableReady(status: FieldStatus | null, config?: FieldTurntableConfig) {
  return !config || !!status?.turntablePreparation?.ready && !status.turntableWarning && !status.turntableBusy &&
    fieldTurntableMatches(status.turntablePreparation.config, config);
}

/** Ordinary acquisition never inherits motion instructions from a form draft. */
export function fieldCaptureConfig(config: FieldConfig): FieldConfig {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  return { name: text(config.name), deviceIp: text(config.deviceIp), hostIp: text(config.hostIp),
    ...(config.windFarm !== undefined ? { windFarm: text(config.windFarm) } : {}),
    object: text(config.object), turbine: text(config.turbine), point: text(config.point) };
}
export type FieldRequest = (options: FieldRequestOptions) => Promise<{ status: number; data: unknown }>;

export function validateFieldConfig(config: FieldConfig): string | null {
  if (!config.name.trim()) return "请填写采集任务名称";
  if (config.windFarm !== undefined && (typeof config.windFarm !== "string" || config.windFarm.length > 120 || config.windFarm.includes("\0"))) return "风场编号最多120字，不能包含空字符";
  const ipv4 = (value: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split(".").every((part) => Number(part) <= 255);
  if (!ipv4(config.deviceIp.trim())) return "请填写有效的设备 IPv4 地址";
  if (!ipv4(config.hostIp.trim())) return "请填写本机设备网卡的有效 IPv4 地址";
  if (config.deviceIp.trim() === config.hostIp.trim()) return "设备 IP 与本机 IP 不能相同";
  if (config.turntable) {
    const t = config.turntable;
    if (t.protocol === "position" && (typeof t.targetAngleDeg !== "number" || !Number.isFinite(t.targetAngleDeg) || Math.abs(t.targetAngleDeg) > (t.axis === 1 ? 35 : 180))) return "请输入当前轴范围内的目标角度：轴1±35°，轴2±180°。";
    if (t.protocol !== undefined && !["legacy_speed", "continuous", "position"].includes(t.protocol)) return "请选择有效的转盘固件接口。";
    if (!isTurntablePort(t.port) || ![1, 2].includes(t.axis) || !["forward", "reverse"].includes(t.direction) ||
        !Number.isFinite(t.speedRpm) || t.speedRpm < 0.02 || t.speedRpm > 100 ||
        !Number.isFinite(t.durationSeconds) || t.durationSeconds < 0 || t.durationSeconds > 86400) return "请核对转盘串口、轴号、转速（0.02～100 rpm）与运行时长（0～86400 秒）";
  }
  return null;
}

/** Preserve sparse-preview spacing; never assume each displayed point is adjacent. */
export function fieldSampleX(waveform: FieldWaveform, index: number): number {
  const stride = waveform.sampleStride && waveform.sampleStride > 0 ? waveform.sampleStride : 1;
  const sample = waveform.sampleStart + index * stride;
  return waveform.sampleRate && waveform.sampleRate > 0 ? sample / waveform.sampleRate * 1000 : sample;
}

export function fieldCanStart(status: FieldStatus | null, source: FieldSource = "device"): boolean {
  return !fieldStartError(status, source);
}

export function fieldStartError(status: FieldStatus | null, source: FieldSource = "device"): string {
  if (!status || status.service.state !== "ready") return "本机采集服务尚未就绪，请在设备与服务中检查";
  if (status.service.error) return status.service.error;
  if (source !== "simulation" && !status.service.dllConfigured) return "尚未配置测振仪 SDK，请在设备与服务中选择设备 SDK";
  if (status.deviceBusy) return "设备配置正在进行，请等待完成";
  if (status.turntableBusy) return "转盘操作尚未结束，请等待完成或停止";
  if (source !== "simulation" && status.deviceWarning) return status.deviceWarning;
  if (fieldIsActive(status)) return "采集或数据保存尚未结束，请先停止并保存";
  if (!["idle", "error"].includes(status.state)) return "本机采集服务当前无法开始新任务";
  return "";
}

export function fieldIsActive(status: FieldStatus | null): boolean {
  return Boolean(status && (["starting", "acquiring", "stopping"].includes(status.state) || status.receiver?.running === true));
}

/** Allow an explicit recovery request to obtain fresh server-side preflight.
 * A failed operation or missing health report is not a global recovery lock.
 * This is only request availability, never permission to bypass device checks.
 */
export function fieldCanRequestTurntableRecovery(status: FieldStatus | null, port: string): boolean {
  const controller = status?.turntable?.port === port ? status.turntable : undefined;
  if (!controller || !isTurntablePort(port) || status?.service.state !== "ready" ||
      fieldIsActive(status) || status?.deviceBusy || status?.turntableBusy) return false;
  const state = controller.motionCapability?.status?.state;
  if (typeof state === "number" && [1, 2, 3, 4, 5].includes(state)) return false;
  return ["1", "2"].every(axis => {
    const value = controller.feedback?.axes?.[axis];
    return !value || (value.motor_rpm === 0 && [0, 7, 8].includes(value.home_phase));
  });
}

export function fieldDate(value?: string | number): Date | null {
  if (value === undefined || value === null || value === "") return null;
  // The Python service uses Unix seconds; ISO strings support older metadata.
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
