"""Pure full-circle pointing preview; this module never operates hardware.

The rotor is assumed vertical, with its centre directly in front of the laser
in the horizontal direction.  A six-o'clock point is the phase origin.  Axis
directions and the ideal pan/tilt geometry still require physical calibration.
Analytic derivatives describe an already moving target, not a start-from-rest
motor profile.  Sampled extrema are preview values, not certified safety bounds.
"""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


SAMPLE_INTERVALS = 720


def _finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


class MotionTrialConfig(BaseModel):
    """Dimensions in metres, period in seconds, signs in the motor coordinates.

    Defaults are the dimensions and 30-second period supplied for the current
    bench setup, not a measured calibration or controller-capability evidence.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    distanceM: float = Field(default=2.86, ge=0.001, le=10000, allow_inf_nan=False)
    hubHeightDeltaM: float = Field(default=1.46, ge=-10000, le=10000, allow_inf_nan=False)
    radiusM: float = Field(default=0.31, ge=0.001, le=1000, allow_inf_nan=False)
    periodSeconds: float = Field(default=30, ge=0.5, le=3600, allow_inf_nan=False)
    rotationDirection: Literal["clockwise", "counterclockwise"] = "clockwise"
    axis1Sign: Literal[-1, 1] = 1
    axis2Sign: Literal[-1, 1] = 1

    @field_validator("distanceM", "hubHeightDeltaM", "radiusM", "periodSeconds", mode="before")
    @classmethod
    def finite_number(cls, value):
        if not _finite_number(value):
            raise ValueError("几何尺寸及周期必须为有限数字")
        return value

    @field_validator("axis1Sign", "axis2Sign", mode="before")
    @classmethod
    def direction_sign(cls, value):
        if type(value) is not int or value not in (-1, 1):
            raise ValueError("轴方向必须是整数 +1 或 -1")
        return value


def _anchor_angles(anchor):
    if anchor is None:
        return {"axis1AngleDeg": None, "axis2AngleDeg": None}
    names = {"axis1AngleDeg", "axis2AngleDeg"}
    if not isinstance(anchor, dict) or set(anchor) != names:
        raise ValueError("参考位必须提供两轴角度，不能混入未知字段")
    for name, value in anchor.items():
        if not _finite_number(value):
            raise ValueError(f"{name}必须为有限数字")
    # Mechanical/soft range, reference freshness and provenance belong to the
    # caller's real-controller check. Do not clamp or invent any of them here.
    return {name: float(value) for name, value in anchor.items()}


def _geometry(config, elapsed_phase):
    """Angles and their first/second time derivatives in the optical frame."""
    direction = 1 if config.rotationDirection == "clockwise" else -1
    omega = math.tau / config.periodSeconds
    # Six o'clock -> nine o'clock for clockwise, as viewed from the laser.
    sin_phase, cos_phase = math.sin(elapsed_phase), math.cos(elapsed_phase)
    x = -direction * config.radiusM * sin_phase
    y = config.hubHeightDeltaM - config.radiusM * cos_phase
    dx = -direction * config.radiusM * cos_phase * omega
    dy = config.radiusM * sin_phase * omega
    ddx = direction * config.radiusM * sin_phase * omega * omega
    ddy = config.radiusM * cos_phase * omega * omega
    distance = config.distanceM
    rho = math.hypot(distance, x)
    drho = x * dx / rho
    ddrho = (dx * dx + x * ddx) / rho - x * x * dx * dx / rho ** 3

    square_range = rho * rho + y * y
    numerator = rho * dy - y * drho
    numerator_rate = rho * ddy - y * ddrho
    square_range_rate = 2 * (rho * drho + y * dy)
    pitch = math.atan2(y, rho)
    pitch_rate = numerator / square_range
    pitch_acceleration = (numerator_rate * square_range - numerator * square_range_rate) / square_range ** 2
    yaw = math.atan2(x, distance)
    yaw_denominator = distance * distance + x * x
    yaw_rate = distance * dx / yaw_denominator
    yaw_acceleration = distance * (ddx * yaw_denominator - 2 * x * dx * dx) / yaw_denominator ** 2
    return {
        "pointXM": x, "pointHeightM": y,
        "pitchDeg": math.degrees(pitch), "yawDeg": math.degrees(yaw),
        "pitchVelocityDegS": math.degrees(pitch_rate),
        "yawVelocityDegS": math.degrees(yaw_rate),
        "pitchAccelerationDegS2": math.degrees(pitch_acceleration),
        "yawAccelerationDegS2": math.degrees(yaw_acceleration),
    }


def preview_full_circle(config: MotionTrialConfig, anchor=None):
    """Return one ideal 360-degree cycle, without device capability judgement.

    ``anchor`` is an optional caller-supplied six-o'clock encoder readback. It
    only translates the angles. ``anchorBound`` does not certify its validity.
    Without it, absolute encoder angles are null; only relative changes exist.
    Samples include both endpoints. The final geometric state is explicitly the
    first state again, avoiding floating-point residue in the closed path.
    """
    if not isinstance(config, MotionTrialConfig):
        raise ValueError("config必须是已校验的MotionTrialConfig")
    # Revalidate even a model made through Pydantic's validation-bypass helpers.
    config = MotionTrialConfig.model_validate(config.model_dump())
    start_angles = _anchor_angles(anchor)
    anchor_bound = anchor is not None
    base = _geometry(config, 0.0)
    trajectory = []
    for sample in range(SAMPLE_INTERVALS + 1):
        fraction = sample / SAMPLE_INTERVALS
        geometry = base if sample == SAMPLE_INTERVALS else _geometry(config, math.tau * fraction)
        value = {
            "timeSeconds": config.periodSeconds * fraction,
            "rotorPhaseDeg": 180.0 + 360.0 * fraction,
            "phaseFromSixDeg": 360.0 * fraction,
            "pointXM": geometry["pointXM"], "pointHeightM": geometry["pointHeightM"],
        }
        for axis, optical in ((1, "pitch"), (2, "yaw")):
            sign = getattr(config, f"axis{axis}Sign")
            name = f"axis{axis}AngleDeg"
            delta = sign * (geometry[f"{optical}Deg"] - base[f"{optical}Deg"])
            value[f"axis{axis}DeltaAngleDeg"] = delta
            value[name] = start_angles[name] + delta if anchor_bound else None
            value[f"axis{axis}VelocityDegS"] = sign * geometry[f"{optical}VelocityDegS"]
            value[f"axis{axis}AccelerationDegS2"] = sign * geometry[f"{optical}AccelerationDegS2"]
        trajectory.append(value)

    summaries = []
    for axis in (1, 2):
        relative = [value[f"axis{axis}DeltaAngleDeg"] for value in trajectory]
        velocity = [value[f"axis{axis}VelocityDegS"] for value in trajectory]
        acceleration = [value[f"axis{axis}AccelerationDegS2"] for value in trajectory]
        absolute = [value[f"axis{axis}AngleDeg"] for value in trajectory] if anchor_bound else None
        peak_speed = max(map(abs, velocity))
        summaries.append({
            "axis": axis, "minRelativeAngleDeg": min(relative), "maxRelativeAngleDeg": max(relative),
            "minAngleDeg": min(absolute) if absolute is not None else None,
            "maxAngleDeg": max(absolute) if absolute is not None else None,
            "peakSpeedDegS": peak_speed, "peakSpeedRpm": peak_speed / 6,
            "peakAccelerationDegS2": max(map(abs, acceleration)),
            "startVelocityDegS": velocity[0], "endVelocityDegS": velocity[-1],
        })
    end_angles = {name: trajectory[-1][name] for name in start_angles}
    return {
        "model": "ideal_full_circle_pointing", "coordinateFrame": "front_facing_centered_rotor",
        "durationSeconds": config.periodSeconds, "periodSeconds": config.periodSeconds,
        "rotorRpm": 60 / config.periodSeconds, "arcDegrees": 360,
        "rotationDirection": config.rotationDirection,
        "anchorBound": anchor_bound, "angleReference": "provided_anchor" if anchor_bound else "relative_to_six_oclock",
        "startAngles": start_angles, "endAngles": end_angles,
        "start": dict(trajectory[0]), "end": dict(trajectory[-1]),
        "sampleCount": len(trajectory), "sampleIntervalSeconds": config.periodSeconds / SAMPLE_INTERVALS,
        "extremaMethod": "sampled_analytic_derivatives", "extremaAreSafetyBounds": False,
        "axisSummaries": summaries, "trajectory": trajectory,
        "requiresRunIn": True, "requiresRunOut": True,
        "directionCalibrated": False, "hardwareCapability": "not_evaluated", "executionReady": False,
        "warnings": [
            "轨迹按设备正对且水平居中于叶轮平面计算，尺寸、轴方向及轴系安装仍需现场标定。",
            "6点起步及整圈终点具有非零理想速度，需独立规划预备加速和结束减速，不能从静止直接套用。",
            "峰值为离散采样的解析导数，未构成全路径安全上界；角度和动态限制需由执行层另行校验。",
            "几何计算不判断控制器执行能力，也不代表实测跟随精度、材料点命中或实机验收。",
        ],
    }
