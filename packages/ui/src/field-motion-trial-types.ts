export type FieldMotionTrialConfig = {
  distanceM: number; hubHeightDeltaM: number; radiusM: number; periodSeconds: number;
  rotationDirection: "clockwise" | "counterclockwise"; axis1Sign: 1 | -1; axis2Sign: 1 | -1;
};
export type FieldMotionTrialPreview = {
  durationSeconds: number; rotorRpm: number; anchorBound: boolean;
  startAngles: { axis1AngleDeg: number | null; axis2AngleDeg: number | null };
  endAngles: { axis1AngleDeg: number | null; axis2AngleDeg: number | null };
  trajectory: { timeSeconds: number; rotorPhaseDeg: number; axis1DeltaAngleDeg: number; axis2DeltaAngleDeg: number; axis1AngleDeg: number | null; axis2AngleDeg: number | null; axis1VelocityDegS: number; axis2VelocityDegS: number; axis1AccelerationDegS2: number; axis2AccelerationDegS2: number }[];
  axisSummaries: { axis: 1 | 2; minRelativeAngleDeg: number; maxRelativeAngleDeg: number; minAngleDeg: number | null; maxAngleDeg: number | null; peakSpeedDegS: number; peakSpeedRpm: number; peakAccelerationDegS2: number }[];
  requiresRunIn: true; executionReady: false; warnings: string[]; blockReasons: string[];
  capability: { supported: false; checkedHardware: false; source: "client_protocol"; code: "trajectory_protocol_unavailable"; message: string };
};
export type FieldMotionTrialRequest = { action: "preview"; config: FieldMotionTrialConfig };
