/** Single material point, manually timed, open-loop short-arc test. No persisted runtime authority. */
export type FieldSinglePointConfig = {
  bladeId: string; pointId: string; pointName: string; materialMark: string;
  distanceM: number; hubHeightDeltaM: number; radiusM: number;
  axis1Sign: 1 | -1; axis2Sign: 1 | -1;
  rotationDirection: "clockwise" | "counterclockwise";
  arcDegrees: number; nominalPeriodSeconds: number;
  maxOutputRpm: number; maxOutputAccelerationDegS2: number;
  motionRampSeconds: number; commandLatencyMs: number; axisStartSkewMs: number;
  syncUncertaintyMs: number; maxPeriodVariationPercent: number; maxSyncAgeSeconds: number;
  maxApproximationErrorMm: number; maxPredictionErrorMm: number;
  frontFacingConfirmed: boolean; motionTimingConfirmed: boolean;
};
export type FieldSinglePointAngles = { axis1AngleDeg: number; axis2AngleDeg: number };
export type FieldSinglePointPreview = {
  ready: boolean; blockReasons: string[]; warnings: string[];
  motionModel: "position_chord_approximation"; phaseLocked: false; identityConfirmed: false;
  anchorBound: boolean; periodSeconds: number; periodSource: "nominal" | "manual_marks";
  durationSeconds: number; startAngles: FieldSinglePointAngles; endAngles: FieldSinglePointAngles;
  axisMoves: { axis: 1 | 2; startAngleDeg: number; targetAngleDeg: number; deltaAngleDeg: number; speedRpm: number; estimatedDurationSeconds: number; requiredPeakSpeedRpm: number; requiredPeakAccelerationDegS2: number; hold: boolean }[];
  maxPathErrorMm: number; predictionErrorMm: number;
  errorBudget: { pathApproximationMm: number; manualSyncMm: number; periodVariationMm: number; commandTimingMm: number; axisStartSkewMm: number; totalMm: number };
  trajectory: { timeSeconds: number; rotorPhaseDeg: number; axis1AngleDeg: number; axis2AngleDeg: number; plannedAxis1AngleDeg: number; plannedAxis2AngleDeg: number; errorMm: number }[];
  scheduledStartAt?: number; dispatchAt?: number; scheduledEndAt?: number; skippedRevolutions?: number;
};
export type FieldSinglePointSync = {
  ready: boolean; blockReasons: string[]; markCount: number; periodSeconds?: number | null;
  rpm?: number | null; periodVariationPercent?: number | null; maxPeriodDeviationSeconds?: number | null;
  lastMarkAt?: number | null; phaseLocked: false; identityConfirmed: false; source: "manual_marks";
};
export type FieldSinglePointState = "preparing" | "awaiting_sync" | "ready" | "arming" | "scheduled" | "following" | "complete" | "cancelled" | "error";
export type FieldSinglePointStatus = {
  sessionId: string; state: FieldSinglePointState; config: FieldSinglePointConfig;
  anchor?: FieldSinglePointAngles; preview?: FieldSinglePointPreview; sync?: FieldSinglePointSync;
  marks?: { sequence: number; hostTime: number; receivedSamples?: number }[];
  scheduledStartAt?: number; scheduledEndAt?: number; skippedRevolutions?: number;
  recordingId?: string; error?: string; updatedAt?: number; version?: number;
  endpointReached?: boolean; endpointErrorsDeg?: Record<"1" | "2", number | null>;
  endpointToleranceDeg?: number; endpointObservedAt?: number;
  stopConfirmed?: boolean | null; pendingStopAxes?: number[];
  captureWindow?: { startSample: number; endSampleExclusive: number; receivedThroughSample: number; covered: boolean; timeBasis: string };
  captureWindowVerified?: false;
  events?: { sequence?: number; at: number; phase?: string; message?: string; error?: string }[];
  phaseLocked: false; identityConfirmed: false; motionModel: "position_chord_approximation"; quality: "manual_unverified";
};
export type FieldSinglePointCapture = { name: string; deviceIp: string; hostIp: string; port: string; windFarm?: string; object?: string; turbine?: string; point?: string; captureSessionId?: string };
export type FieldSinglePointRequest =
  | { action: "preview"; config: FieldSinglePointConfig }
  | { action: "prepare"; sessionId: string; commandId: string; config: FieldSinglePointConfig; capture: FieldSinglePointCapture; confirmStaticPoint: true; confirmGeometry: true; confirmLaser: true }
  | { action: "mark" | "reset_sync" | "cancel"; sessionId: string; commandId: string }
  | { action: "arm"; sessionId: string; commandId: string; confirmMotion: true };
