"""One serial owner per joint capture; no implicit motion or hardware fallback."""
from __future__ import annotations

from dataclasses import asdict
import hashlib
import json
import math
import os
from pathlib import Path
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator, model_validator

from .serial_ports import SerialPort
from .turntable_driver import MotorController, MotorError
from .turntable_driver.protocol import validate_output_angle
from .turntable_driver.trajectory import TrajectoryPoint


class TurntableConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    port: SerialPort
    axis: StrictInt = Field(default=1, ge=1, le=2)
    speedRpm: float = Field(default=0.2, ge=0.02, le=100, allow_inf_nan=False)
    direction: Literal["forward", "reverse"] = "forward"
    durationSeconds: float = Field(default=0, ge=0, le=86400, allow_inf_nan=False)
    protocol: Literal["legacy_speed", "continuous", "position"] = "legacy_speed"
    targetAngleDeg: float | None = Field(default=None, allow_inf_nan=False)

    @field_validator("speedRpm", "durationSeconds", "targetAngleDeg", mode="before")
    @classmethod
    def numeric(cls, value):
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("转速和运行时长必须为数字")
        return value

    @model_validator(mode="after")
    def position_target(self):
        if self.targetAngleDeg is not None:
            validate_output_angle(self.axis, self.targetAngleDeg)
        if self.protocol == "position" and self.targetAngleDeg is None:
            raise ValueError("定位模式必须提供目标角度")
        return self

    @property
    def signed_rpm(self):
        return self.speedRpm * (1 if self.direction == "forward" else -1)


class TurntableRequest(TurntableConfig):
    action: Literal["probe", "health", "test", "manual_move", "recall", "prepare", "stop", "reference", "limits", "clear_trajectory_fault", "clear_guard_fault", "reset_alarm", "cancel_trajectory"] = "probe"
    testSeconds: StrictInt = Field(default=3, ge=1, le=15)
    confirmMotion: StrictBool = False
    confirmRecovery: StrictBool = False
    axis1AngleDeg: float | None = Field(default=None, allow_inf_nan=False)
    axis2AngleDeg: float | None = Field(default=None, allow_inf_nan=False)
    referenceSignature: str | None = Field(default=None, max_length=512)
    recordedPort: SerialPort | None = None
    maxMoveAccelerationDegS2: float = Field(default=3, ge=0.1, le=120, allow_inf_nan=False)
    followErrorLimitDeg: float = Field(default=0.75, ge=0.5, le=10, allow_inf_nan=False)
    expectedTrajectorySession: StrictInt | None = Field(default=None, ge=1, le=65535)

    @field_validator("axis1AngleDeg", "axis2AngleDeg", "maxMoveAccelerationDegS2", "followErrorLimitDeg", mode="before")
    @classmethod
    def recall_numeric(cls, value):
        return cls.numeric(value)

    @model_validator(mode="after")
    def recall_targets(self):
        if self.action == "health" and self.confirmRecovery:
            raise ValueError("状态检查只读，不能同时确认恢复")
        if self.action in ("clear_trajectory_fault", "clear_guard_fault", "reset_alarm", "cancel_trajectory") and not self.confirmRecovery:
            raise ValueError("故障恢复必须由用户明确发起")
        if self.action == "cancel_trajectory" and self.expectedTrajectorySession is None:
            raise ValueError("取消待执行轨迹需要最近读取的轨迹会话号")
        if self.action == "recall":
            if self.recordedPort is None or self.referenceSignature is None:
                raise ValueError("历史点位缺少串口或参考位信息，请重新标定后回位")
            if self.recordedPort != self.port:
                raise ValueError("记录串口与当前串口不同，不能回位")
            if self.axis1AngleDeg is None or self.axis2AngleDeg is None:
                raise ValueError("点位回位需要两轴有效角度")
            validate_output_angle(1, self.axis1AngleDeg)
            validate_output_angle(2, self.axis2AngleDeg)
            if self.referenceSignature is not None:
                signature = json.loads(self.referenceSignature)
                if not isinstance(signature, list) or len(signature) != 2 or any(
                        not isinstance(axis, list) or len(axis) != 4 or any(type(value) is not int for value in axis)
                        for axis in signature):
                    raise ValueError("点位参考位签名无效")
        return self

    def config(self):
        return TurntableConfig(**self.model_dump(include=set(TurntableConfig.model_fields)))


class PointCyclePoint(BaseModel):
    """A previously marked two-axis point used by the automatic capture loop."""
    model_config = ConfigDict(extra="ignore")
    pointId: str | None = Field(default=None, min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    axis1AngleDeg: float = Field(allow_inf_nan=False)
    axis2AngleDeg: float = Field(allow_inf_nan=False)
    port: SerialPort
    referenceSignature: str = Field(min_length=1, max_length=512)
    bladeId: str | None = Field(default=None, min_length=1, max_length=80)
    radialPointId: str | None = Field(default=None, min_length=1, max_length=80)
    radialPointName: str | None = Field(default=None, min_length=1, max_length=120)
    radiusM: float | None = Field(default=None, gt=0, le=1000, allow_inf_nan=False)
    rootRadiusM: float | None = Field(default=None, ge=0, le=1000, allow_inf_nan=False)
    bladeLengthM: float | None = Field(default=None, gt=0, le=1000, allow_inf_nan=False)
    azimuthDeg: float | None = Field(default=None, ge=0, lt=360, allow_inf_nan=False)

    @field_validator("name", "pointId", "bladeId", "radialPointId", "radialPointName")
    @classmethod
    def point_name(cls, value: str) -> str:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("循环点位名称不能为空")
        return value

    @field_validator("axis1AngleDeg", "axis2AngleDeg", "radiusM", "rootRadiusM", "bladeLengthM", "azimuthDeg", mode="before")
    @classmethod
    def point_angle(cls, value):
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("循环点位角度必须是数字")
        return value

    @model_validator(mode="after")
    def point_limits(self):
        validate_output_angle(1, self.axis1AngleDeg)
        validate_output_angle(2, self.axis2AngleDeg)
        if self.radiusM is not None and self.rootRadiusM is not None:
            if self.radiusM < self.rootRadiusM:
                raise ValueError("测点半径不能位于叶根以内")
            if self.bladeLengthM is not None and self.radiusM > self.rootRadiusM + self.bladeLengthM:
                raise ValueError("测点距叶根距离不能超过叶片长度")
        if self.referenceSignature is not None:
            try:
                signature = json.loads(self.referenceSignature)
            except json.JSONDecodeError as exc:
                raise ValueError("循环点位参考位签名无效") from exc
            if not isinstance(signature, list) or len(signature) != 2 or any(
                    not isinstance(axis, list) or len(axis) != 4 or any(type(value) is not int for value in axis)
                    for axis in signature):
                raise ValueError("循环点位参考位签名无效")
        return self


class PointCycleGeometry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    distanceM: float = Field(gt=0, le=10000, allow_inf_nan=False)
    hubHeightDeltaM: float = Field(ge=-10000, le=10000, allow_inf_nan=False)
    rotationDirection: Literal["clockwise", "counterclockwise"] = "clockwise"
    axis1Sign: Literal[-1, 1] = 1
    axis2Sign: Literal[-1, 1] = 1
    anchorRadiusM: float = Field(gt=0, le=1000, allow_inf_nan=False)
    anchorAxis1AngleDeg: float = Field(ge=-35, le=35, allow_inf_nan=False)
    anchorAxis2AngleDeg: float = Field(ge=-180, le=180, allow_inf_nan=False)

    @field_validator("distanceM", "hubHeightDeltaM", "axis1Sign", "axis2Sign", "anchorRadiusM",
                     "anchorAxis1AngleDeg", "anchorAxis2AngleDeg", mode="before")
    @classmethod
    def numeric(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("几何和轴向参数必须为有限数字")
        return value

    def angles(self, radius, azimuth):
        phase = math.radians(azimuth)
        # azimuth 0 is the measured six-o'clock anchor, viewed from the laser.
        direction = -1 if self.rotationDirection == "clockwise" else 1
        x = direction * radius * math.sin(phase)
        y = self.hubHeightDeltaM - radius * math.cos(phase)
        pitch = math.degrees(math.atan2(y, math.hypot(self.distanceM, x)))
        yaw = math.degrees(math.atan2(x, self.distanceM))
        base_pitch = math.degrees(math.atan2(self.hubHeightDeltaM - self.anchorRadiusM, self.distanceM))
        return (self.anchorAxis1AngleDeg + self.axis1Sign * (pitch - base_pitch),
                self.anchorAxis2AngleDeg + self.axis2Sign * yaw)


class PointCycleConfig(BaseModel):
    """Validated parameters for a multi-point, multi-circle capture."""
    model_config = ConfigDict(extra="ignore")
    port: SerialPort
    points: list[PointCyclePoint] = Field(min_length=1, max_length=200)
    mode: Literal["legacy", "automatic_stations"] = "legacy"
    # Explicit calibrated-point contract: verify the first pose, never move to it.
    # The default preserves initial positioning for computed/legacy routes.
    startAtCurrentPose: StrictBool = False
    # Already established software zero in absolute device coordinates. This is
    # a normal positioning move, never a controller homing/reference command.
    returnToOrigin: PointCyclePoint | None = None
    routeOrder: Literal["configured", "shortest_safe"] = "shortest_safe"
    # Associates separately started radial points without reusing a run/session ID.
    collectionId: str | None = Field(default=None, min_length=32, max_length=32, pattern=r"^[a-f0-9]{32}$")
    nominalPeriodSeconds: float = Field(default=30, ge=0, le=3600, allow_inf_nan=False)
    maxMoveRpm: float = Field(default=0.6, ge=0.02, le=10, allow_inf_nan=False)
    maxMoveAccelerationDegS2: float = Field(default=3, ge=0.1, le=120, allow_inf_nan=False)
    followErrorLimitDeg: float = Field(default=0.75, ge=0.5, le=10, allow_inf_nan=False)
    geometry: PointCycleGeometry | None = None
    cycles: StrictInt = Field(default=1, ge=1, le=100)
    dwellSeconds: float = Field(default=2, ge=1, le=3600, allow_inf_nan=False)
    speedRpm: float = Field(default=0.5, ge=0.02, le=10, allow_inf_nan=False)
    # Echo handoff is opt-in: confirm entry, then stable-background exit.
    rssiTriggerEnabled: StrictBool = False
    rssiThresholdMode: Literal["adaptive", "absolute"] = "adaptive"
    rssiLeaveThresholdPercent: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    rssiBaselineRatio: float = Field(default=0.90, ge=0.5, le=0.99, allow_inf_nan=False)
    rssiSmoothingMs: float = Field(default=10, ge=2, le=100, allow_inf_nan=False)
    rssiConfirmMs: float = Field(default=30, ge=10, le=1000, allow_inf_nan=False)
    rssiEnterSpread: float = Field(default=8, gt=0, le=100, allow_inf_nan=False)
    rssiExitSpread: float = Field(default=3, ge=0, lt=100, allow_inf_nan=False)
    rssiEnterConfirmMs: float = Field(default=20, ge=10, le=1000, allow_inf_nan=False)
    rssiMotionMarginMs: float = Field(default=200, ge=0, le=5000, allow_inf_nan=False)
    # Accepted for older clients. Linked capture now keeps light on during the
    # session but closes/creates each station's DAQ and RSSI gate independently.
    keepLaserOnBetweenPoints: StrictBool = True
    # Accepted for older clients only; never used as a microsecond debounce.
    rssiConfirmSamples: StrictInt = Field(default=3, ge=1, le=1000)
    rssiMinimumSeconds: float = Field(default=0, ge=0, le=3600, allow_inf_nan=False)

    @field_validator("dwellSeconds", "speedRpm", "rssiLeaveThresholdPercent", "rssiMinimumSeconds",
                     "rssiBaselineRatio", "rssiSmoothingMs", "rssiConfirmMs", "rssiMotionMarginMs",
                     "rssiEnterSpread", "rssiExitSpread", "rssiEnterConfirmMs", "nominalPeriodSeconds",
                     "maxMoveRpm", "maxMoveAccelerationDegS2", "followErrorLimitDeg", mode="before")
    @classmethod
    def cycle_numeric(cls, value):
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("循环采集参数必须是数字")
        return value

    @model_validator(mode="after")
    def bounded_total(self):
        if 0 < self.nominalPeriodSeconds < .5:
            raise ValueError("叶轮周期须为0（手动转叶片）或不少于0.5秒")
        if self.startAtCurrentPose and self.mode != "automatic_stations":
            raise ValueError("首个点位原地等待仅适用于已校准的自动点位采集")
        if self.routeOrder == "configured" and not self.rssiTriggerEnabled:
            raise ValueError("按配置顺序换点必须确认叶片进入和离开")
        if self.collectionId is not None and self.mode != "automatic_stations":
            raise ValueError("叶片采集任务编号仅用于自动点位记录")
        if any(point.port != self.port for point in self.points):
            raise ValueError("点位记录串口与当前循环串口不同，请重新标定")
        if self.returnToOrigin is not None and self.returnToOrigin.port != self.port:
            raise ValueError("作业原点串口与当前循环串口不同，请重新读取原点")
        if len(self.points) * self.cycles > 2000:
            raise ValueError("循环采集最多生成 2000 条独立记录")
        if self.rssiExitSpread >= self.rssiEnterSpread:
            raise ValueError("离开波动阈值必须小于进入波动阈值")
        if self.rssiMinimumSeconds > self.dwellSeconds:
            raise ValueError("RSSI 最短采集时间不能超过每点采集时长")
        if self.mode == "automatic_stations":
            if not self.rssiTriggerEnabled:
                raise ValueError("自动驻留换点必须确认RSSI进入及离开，不能按定时时长换点")
            if self.geometry is None:
                raise ValueError("自动点位需要真实六点方向标定及完整几何参数")
            if self.speedRpm > self.maxMoveRpm:
                raise ValueError("自动换点转速超过配置上限")
            if not math.isclose(self.speedRpm / .02, round(self.speedRpm / .02), abs_tol=1e-8):
                raise ValueError("自动换点转速必须为 0.02 rpm 的整数倍，不能由硬件向上取整")
            groups, used, previous_group, finished_groups = {}, set(), None, set()
            for point in self.points:
                if not point.pointId or not all((point.bladeId, point.radialPointId, point.radialPointName)) or point.radiusM is None or point.azimuthDeg is None:
                    raise ValueError("自动点位必须包含叶片、径向测点、半径、方位及唯一点位编号")
                if point.pointId in used:
                    raise ValueError("自动点位编号不能重复")
                used.add(point.pointId)
                group = (point.bladeId, point.radialPointId)
                if group != previous_group:
                    if group in finished_groups:
                        raise ValueError("同一径向点的圆周点位须连续排列，不能交叉混入其他测点")
                    if previous_group is not None:
                        finished_groups.add(previous_group)
                    previous_group = group
                shape = groups.setdefault(group, {"radius": point.radiusM, "name": point.radialPointName, "angles": set()})
                if abs(shape["radius"] - point.radiusM) > 1e-9 or shape["name"] != point.radialPointName:
                    raise ValueError("同一径向测点的半径和名称必须一致")
                if point.azimuthDeg in shape["angles"]:
                    raise ValueError("同一径向点不能重复配置相同方位")
                shape["angles"].add(point.azimuthDeg)
                expected = self.geometry.angles(point.radiusM, point.azimuthDeg)
                if abs(point.axis1AngleDeg - expected[0]) > 0.002 or abs(point.axis2AngleDeg - expected[1]) > 0.002:
                    raise ValueError("自动点位角度与六点方向几何标定不一致")
        return self


def test_key(config):
    return config.model_dump(exclude={"durationSeconds"})


def probe_motion_capability(motor):
    """Read-only detection; a failed query must never be mistaken for old firmware."""
    if not hasattr(motor, "probe_trajectory"):
        # Older injected controller adapters retain their original single-axis API.
        return {"supported": False, "mode": "sequential", "protocol": None,
                "probe": "driver-unavailable", "status": None}
    status = motor.probe_trajectory()
    return {"supported": status is not None,
            "mode": "dual_axis_timed" if status is not None else "sequential",
            "protocol": "0x30-0x36" if status is not None else None,
            "probe": "confirmed" if status is not None else "legacy-command-unsupported",
            "status": asdict(status) if status is not None else None}


def station_timing_plan(cycle: PointCycleConfig, start, target: PointCyclePoint,
                        motion_mode: str, source: PointCyclePoint | None = None):
    """Budget one stopped station handoff without claiming rotor synchronization.

    Only two stations of the same operator-assigned blade/radial point provide a
    meaningful rotor interval. Initial positioning and older multi-group routes
    keep the configured ceiling. Half the nominal interval is reserved for
    observation/setup; a missed budget never raises that ceiling or bypasses RSSI.
    """
    if cycle.mode == "automatic_stations" and cycle.nominalPeriodSeconds == 0:
        speed = round(math.floor((min(cycle.speedRpm, cycle.maxMoveRpm) + 1e-10) / .02) * .02, 6)
        distances = (abs(target.axis1AngleDeg - start[0]), abs(target.axis2AngleDeg - start[1]))
        if motion_mode == "dual_axis_timed":
            _, move = station_move_plan(start, (target.axis1AngleDeg, target.axis2AngleDeg), speed,
                                        acceleration=cycle.maxMoveAccelerationDegS2)
            planned = move["plannedSeconds"]
        else:
            planned = sum(distances) / (6 * speed)
        return speed, {"sourceStationId": source.pointId if source else None, "targetStationId": target.pointId,
                       "nominalPeriodSeconds": 0, "speedLimitRpm": speed, "configuredCeilingRpm": speed,
                       "plannedMoveSeconds": planned, "timingBasis": "manual_blade_pass", "identityVerified": False}
    if (cycle.mode != "automatic_stations" or source is None or
            (source.bladeId, source.radialPointId) != (target.bladeId, target.radialPointId)):
        return cycle.speedRpm, None
    gap = (target.azimuthDeg - source.azimuthDeg) % 360 or 360
    interval = cycle.nominalPeriodSeconds * gap / 360
    budget = interval * .5
    distances = (abs(target.axis1AngleDeg - start[0]), abs(target.axis2AngleDeg - start[1]))
    travel = max(distances) if motion_mode == "dual_axis_timed" else sum(distances)
    factor = 1.5 * 1.05 if motion_mode == "dual_axis_timed" else 1
    required = max(.02, math.ceil((travel * factor / (6 * budget) - 1e-10) / .02) * .02)
    ceiling = math.floor((min(cycle.speedRpm, cycle.maxMoveRpm) + 1e-10) / .02) * .02
    speed = round(min(ceiling, required), 6)
    if motion_mode == "dual_axis_timed":
        _, move = station_move_plan(start, (target.axis1AngleDeg, target.axis2AngleDeg), speed,
                                    acceleration=cycle.maxMoveAccelerationDegS2)
        planned = move["plannedSeconds"]
    else:
        planned = travel / (6 * speed)
    return speed, {"sourceStationId": source.pointId, "targetStationId": target.pointId,
                   "azimuthGapDeg": gap, "nominalPeriodSeconds": cycle.nominalPeriodSeconds,
                   "nominalIntervalSeconds": interval, "moveBudgetSeconds": budget,
                   "requiredRpm": round(required, 6), "speedLimitRpm": speed,
                   "configuredCeilingRpm": round(ceiling, 6), "plannedMoveSeconds": planned,
                   "mayMissNextPass": planned > budget + 1e-9,
                   "timingBasis": "nominal_period_station_gap", "identityVerified": False}


def station_move_plan(start, target, speed_rpm, *, acceleration=3.0):
    """A stopped-to-stopped joint move, not optical tracking of a moving blade.

    A cubic blend bounds each axis by the same output-speed ceiling. Both axes
    finish together; duration depends on the larger distance, not their sum.
    Extra time covers millisecond/millidegree command quantization.
    """
    values = (*start, *target, speed_rpm, acceleration)
    if not all(math.isfinite(value) for value in values) or speed_rpm <= 0 or acceleration <= 0:
        raise ValueError("双轴换点参数必须为有限正速度及有效角度")
    # The upload header carries milli-degrees/s². Never plan faster than the
    # controller's quantized constraint, or silently round the requested cap up.
    acceleration = math.floor((acceleration + 1e-10) * 1000) / 1000
    if acceleration <= 0:
        raise ValueError("双轴换点加速度低于控制器精度")
    distance = max(abs(b - a) for a, b in zip(start, target))
    duration = math.ceil(max(1.0, 1.5 * distance / (6 * speed_rpm),
                             math.sqrt(6 * distance / acceleration)) * 1.05 * 1000) / 1000
    while True:
        if duration > 600:
            raise ValueError("当前距离和转速需要超过600秒，请分段设置点位")
        # Approximately one point per controller cycle avoids excessive angular
        # rounding noise. Validate the actual wire values, not only the cubic.
        segments = min(32, max(2, int(duration / .1)))
        points = []
        for index in range(segments + 1):
            fraction = index / segments
            blend = 3 * fraction ** 2 - 2 * fraction ** 3
            points.append(TrajectoryPoint(round(duration * fraction, 3),
                                          round(start[0] + (target[0] - start[0]) * blend, 3),
                                          round(start[1] + (target[1] - start[1]) * blend, 3)))
        valid = True
        for field in ("axis1_deg", "axis2_deg"):
            velocity, midpoint = 0.0, 0.0
            for before, after in zip(points, points[1:]):
                dt = after.time_s - before.time_s
                next_velocity = (getattr(after, field) - getattr(before, field)) / dt
                next_midpoint = (after.time_s + before.time_s) / 2
                if (abs(next_velocity) > speed_rpm * 6 + 1e-9 or
                        abs(next_velocity - velocity) / (next_midpoint - midpoint) > acceleration + 1e-9):
                    valid = False
                velocity, midpoint = next_velocity, next_midpoint
            if abs(velocity) / (duration - midpoint) > acceleration + 1e-9:
                valid = False
        if valid:
            break
        duration = math.ceil(duration * 1.05 * 1000) / 1000
    return points, {"mode": "dual_axis_timed", "plannedSeconds": duration,
                    "speedLimitRpm": speed_rpm, "accelerationLimitDegS2": acceleration,
                    "targets": list(target), "pointCount": len(points),
                    "timingBasis": "controller_timed_joint_move", "measurementDuringMotion": False}


def start_motor(motor, config, cancel, *, prechecked_position: bool = False):
    if config.protocol == "position":
        if prechecked_position and hasattr(motor, "move_to_angle_prechecked"):
            accepted = motor.move_to_angle_prechecked(config.axis, config.targetAngleDeg,
                                                      speed_rpm=config.speedRpm, cancel=cancel)
        else:
            accepted = motor.move_to_angle(config.axis, config.targetAngleDeg,
                                           speed_rpm=config.speedRpm, cancel=cancel)
        return accepted.output_speed_rpm if accepted is not None else None
    if config.protocol == "continuous":
        return motor.start_continuous_protocol(config.axis, config.signed_rpm, cancel=cancel)
    return motor.start_continuous(config.axis, config.signed_rpm, cancel=cancel)


def renew_motor(motor, config):
    if config.protocol == "continuous":
        motor.renew_continuous(config.axis)


def snapshot(motor, axis):
    """Queries are sequential; record the entire host observation interval."""
    start = time.time()
    status = asdict(motor.get_status(axis))
    axes = {}
    for current in (1, 2):
        feedback = motor.get_feedback(current)
        axes[str(current)] = {**asdict(feedback), "guard": asdict(motor.get_guard_config(current)),
                              "referenceAngleDeg": 25 if current == 1 else 0,
                              "observedAt": time.time()}
    position = axes[str(axis)]["actual_counts"]
    flags = status.pop("limit_flags")
    return {"axis": axis, "motorRpm": status["motor_rpm"],
            "outputRpm": status["output_rpm"], "runState": status["run_state"],
            "alarmCode": status["alarm_code"], "positionRaw": position,
            "limitFlags": flags, "limitActive": bool(flags & 1) if flags is not None else None,
            "stopPending": bool(flags & 2) if flags is not None else None,
            "limitBypass": bool(flags & 4) if flags is not None else None,
            "outputAngleDeg": axes[str(axis)]["output_angle_deg"], "axes": axes,
            "queryStartedAt": start, "observedAt": time.time()}


def require_ready(value):
    if value["motorRpm"] != 0:
        raise MotorError("转盘仍在运动，请先停止并核查现场状态")
    if value["alarmCode"]:
        raise MotorError(f"转盘驱动器报警 {value['alarmCode']}，不会自动复位")
    # Older firmware omits flags. Preserve unknown telemetry, but allow testing.
    if value["limitFlags"] not in (None, 0):
        raise MotorError("限位触发、停止未确认或限位旁路开启，不能开始联合运动")
    for axis in value["axes"].values():
        if axis["motor_rpm"] != 0 or axis["home_phase"] not in (0, 7, 8):
            raise MotorError("两轴必须停稳，且不能正在回零")
        if axis["fault"] or axis["flags"] & 16:
            raise MotorError("轴反馈存在故障或停止待确认")


def _require_position_bounds(value, config):
    """Axis 1 needs soft protection; axis 2 may use the controller's no-soft policy.

    A disabled axis-2 range is not a command to modify the controller. The
    product's absolute coordinate envelope still applies independently, while
    any enabled controller range is checked exactly as read back.
    """
    axis = value["axes"][str(config.axis)]
    guard = axis["guard"]
    limit = 35 if config.axis == 1 else 180
    if axis["output_angle_deg"] is None or not axis["flags"] & 1:
        raise MotorError("请先为当前轴建立参考位，角度无效时禁止定位")
    if not math.isfinite(axis["output_angle_deg"]) or abs(axis["output_angle_deg"]) > limit:
        raise MotorError(f"轴{config.axis}当前位置超出±{limit}°产品范围")
    if config.axis == 1 and not guard["soft_enabled"]:
        raise MotorError("请先应用当前轴±35°软限位")
    if guard["soft_enabled"]:
        lo, hi = guard["minimum_deg"], guard["maximum_deg"]
        if (not math.isfinite(lo) or not math.isfinite(hi) or not lo < hi or
                not axis["flags"] & 2 or config.axis == 1 and not -35 <= lo < hi <= 35):
            raise MotorError(f"轴{config.axis}软限位范围或反馈无效")
        if not lo <= config.targetAngleDeg <= hi:
            raise MotorError("目标角度超出下位机软限位")
        if not lo <= axis["output_angle_deg"] <= hi:
            raise MotorError("当前位置超出软范围，请现场核查参考位")


def require_position_ready(value, config):
    require_ready(value)
    _require_position_bounds(value, config)


def require_manual_position_ready(value, config):
    """Manual point marking only owns the selected axis; no DAQ preparation is needed."""
    if value["motorRpm"] != 0 or value["alarmCode"]:
        raise MotorError("当前轴仍在运动或驱动器报警")
    if value["limitFlags"] not in (None, 0):
        raise MotorError("当前轴限位触发、停止未确认或保护状态异常")
    axis = value["axes"][str(config.axis)]
    if axis["motor_rpm"] != 0 or axis["fault"] or axis["flags"] & 16:
        raise MotorError(f"轴{config.axis}反馈仍在运动或存在故障")
    _require_position_bounds(value, config)


def require_manual_axis_ready(value, config):
    """Axis-only preflight for soft-limit setup in the standalone panel."""
    if value["motorRpm"] != 0 or value["alarmCode"]:
        raise MotorError("当前轴仍在运动或驱动器报警")
    if value["limitFlags"] not in (None, 0):
        raise MotorError("当前轴限位触发、停止未确认或保护状态异常")
    axis = value["axes"][str(config.axis)]
    if axis["motor_rpm"] != 0 or axis["fault"] or axis["flags"] & 16 or axis["home_phase"] not in (0, 7, 8):
        raise MotorError(f"轴{config.axis}反馈仍在运动、回零或存在故障")


def require_reference_capture_ready(value, config):
    """Capture a physically confirmed reference, including after power loss.

    Invalid reference / guard fault 3 is the condition being repaired. It must
    not block this explicit action, but cannot relax the normal motion gates.
    The SDK sends STOP and waits for two zero-speed samples before capture.
    """
    if value["motorRpm"] != 0 or value["alarmCode"]:
        raise MotorError("当前轴仍在运动或驱动器报警，不能建立参考")
    flags = value["limitFlags"]
    selected = value["axes"][str(config.axis)]
    # A feedback fault can latch stop-pending. Active limits and bypass remain
    # disallowed; STOP plus the post-capture read must clear pending afterwards.
    if flags not in (None, 0) and not (flags == 2 and selected["fault"] == 3):
        raise MotorError("当前轴限位触发或保护状态异常，不能建立参考")
    for axis in value["axes"].values():
        if axis["motor_rpm"] != 0 or axis["home_phase"] not in (0, 7, 8):
            raise MotorError("两轴必须停稳且不能正在回零，才能建立参考")
    if selected["fault"] not in (0, 3):
        raise MotorError(f"轴{config.axis}故障码 {selected['fault']}，请先排除原因，不能用参考标定清除")
    if selected["flags"] & 16 and selected["fault"] != 3:
        raise MotorError("当前轴停止尚未确认，请先停止并重新读取反馈")
    if (selected["display_mode"] != 3 or selected["command_counts_per_rev"] <= 0 or
            not 1 <= selected["encoder_bits"] <= 32):
        raise MotorError("当前轴反馈计数单位无效，请先核对驱动器配置")


def require_reference_captured(value, config):
    """A command acknowledgment alone is not a restored coordinate system."""
    require_manual_axis_ready(value, config)
    selected = value["axes"][str(config.axis)]
    expected = 25 if config.axis == 1 else 0
    angle = selected["output_angle_deg"]
    if (angle is None or not math.isfinite(angle) or not selected["flags"] & 1 or
            abs(angle - expected) > 0.001 or selected["display_mode"] != 3 or
            selected["command_counts_per_rev"] <= 0):
        raise MotorError(f"参考位读回不一致，应为{expected:+g}°，未发送定位动作")
    if config.axis == 1 and (not selected["guard"]["soft_enabled"] or not selected["flags"] & 2):
        raise MotorError("俯仰轴参考已写入但软限位未开启，禁止定位，请检查控制板固件")
    _require_position_bounds(value, config.model_copy(update={"targetAngleDeg": expected}))


def require_stop_confirmed(value, config):
    """Confirm a stop using only the axis that received the stop command.

    The other axis may be unreferenced or report a stale feedback-validity bit;
    it is not part of stopping this axis.
    """
    if value["motorRpm"] != 0:
        raise MotorError(f"轴{config.axis}停止后速度仍为 {value['motorRpm']} rpm")
    if value["limitFlags"] is not None and value["limitFlags"] & 2:
        raise MotorError(f"轴{config.axis}仍报告停止待确认（限位标志={value['limitFlags']}）")
    axis = value["axes"][str(config.axis)]
    if axis["motor_rpm"] != 0 or axis["flags"] & 16 or axis["home_phase"] not in (0, 7, 8):
        raise MotorError(f"轴{config.axis}停止未确认：速度={axis['motor_rpm']} rpm，"
                         f"故障码={axis['fault']}，反馈标志=0x{axis['flags']:04X}，回零阶段={axis['home_phase']}")
    # A latched protection fault/alarm does not mean the motor is still moving.
    # Retain it in feedback; all motion preflights continue to reject it.


def position_reached(value, config):
    axis = value["axes"][str(config.axis)]
    return (axis["output_angle_deg"] is not None and axis["motor_rpm"] == 0 and
            abs(axis["output_angle_deg"] - config.targetAngleDeg) <= 0.1)


def check_position_motion(value, config, *, allow_other_axis_motion: bool = False):
    axis = value["axes"][str(config.axis)]
    other = value["axes"][str(3 - config.axis)]
    limit = 35 if config.axis == 1 else 180
    if (axis["output_angle_deg"] is None or abs(axis["output_angle_deg"]) > limit or
            axis["fault"] or axis["flags"] & 16 or axis["home_phase"] not in (0, 7, 8) or
            (not allow_other_axis_motion and (other["motor_rpm"] != 0 or other["flags"] & 16 or
                                               other["fault"] or other["home_phase"] not in (0, 7, 8)))):
        raise MotorError("定位反馈无效、超界、故障或另一轴意外运动，已结束当前动作")
    _require_position_bounds(value, config)


def position_timeout(value, config):
    distance = abs(config.targetAngleDeg - value["outputAngleDeg"])
    return max(15.0, distance / (config.speedRpm * 6) * 2 + 10)


def reference_key(value):
    """A prepared target belongs to the exact controller reference and count units."""
    fields = ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")
    return {axis: {**{key: data[key] for key in fields}, "valid": data["output_angle_deg"] is not None}
            for axis, data in value["axes"].items()}


def reference_check(before, value, phase):
    """Explain an exact identity comparison; never normalize or tolerate a change."""
    after = reference_key(value)
    labels = {"origin_counts": "参考计数", "display_mode": "显示计数模式",
              "command_counts_per_rev": "每转指令计数 PA11", "encoder_bits": "编码器位数 PA95",
              "valid": "参考角度有效性"}
    changes = [{"axis": int(axis), "field": field, "label": label,
                "before": before.get(axis, {}).get(field), "after": after.get(axis, {}).get(field)}
               for axis in ("1", "2") for field, label in labels.items()
               if before.get(axis, {}).get(field) != after.get(axis, {}).get(field)]
    return {"phase": phase, "observedAt": value.get("observedAt"),
            "before": {axis: dict(data) for axis, data in before.items()},
            "after": after, "changes": changes}


def reference_change_message(context, check):
    details = "；".join(f"轴{item['axis']} {item['label']}（{item['field']}）"
                        f"{item['before']}→{item['after']}" for item in check["changes"])
    return f"{context}：{details}" if details else context


class PositionProgress:
    """Separate travel deadline from a stalled drive; use feedback, never a sleep to settle."""
    def __init__(self, value, config):
        self.deadline = time.monotonic() + position_timeout(value, config)
        self.angle = value["outputAngleDeg"]
        self.progress_at = time.monotonic()
        self.other_angle = value["axes"][str(3 - config.axis)]["output_angle_deg"]
        self.references = reference_key(value)

    def check(self, value, config, *, allow_other_axis_motion: bool = False):
        check_position_motion(value, config, allow_other_axis_motion=allow_other_axis_motion)
        if reference_key(value) != self.references:
            raise MotorError("参考位或反馈计数单位已变化，已结束定位")
        other_angle = value["axes"][str(3 - config.axis)]["output_angle_deg"]
        if (not allow_other_axis_motion and self.other_angle is not None and
                (other_angle is None or abs(other_angle - self.other_angle) > 0.1)):
            raise MotorError("另一轴参考失效或角度偏移，不能继续保持单轴定位")
        now = time.monotonic()
        if abs(value["outputAngleDeg"] - self.angle) >= 0.001:
            self.angle, self.progress_at = value["outputAngleDeg"], now
        if not position_reached(value, config) and (now > self.deadline or now - self.progress_at >= 10):
            raise MotorError("定位超时或连续10秒无位置进展，请检查SON、驱动器及机构")


class ManualPositionProgress:
    """Progress guard for the standalone point-marking controller."""
    def __init__(self, value, config):
        self.deadline = time.monotonic() + position_timeout(value, config)
        self.angle = value["outputAngleDeg"]
        self.progress_at = time.monotonic()
        self.axis = config.axis
        self.reference = reference_key(value)[str(config.axis)]

    def check(self, value, config):
        axis = value["axes"][str(self.axis)]
        if axis["output_angle_deg"] is None or axis["fault"] or axis["flags"] & 16 or axis["home_phase"] not in (0, 7, 8):
            raise MotorError(f"轴{self.axis}定位反馈无效或存在故障")
        _require_position_bounds(value, config)
        if reference_key(value)[str(self.axis)] != self.reference:
            raise MotorError(f"轴{self.axis}参考位或反馈单位已变化")
        now = time.monotonic()
        if abs(value["outputAngleDeg"] - self.angle) >= 0.001:
            self.angle, self.progress_at = value["outputAngleDeg"], now
        if not position_reached(value, config) and (now > self.deadline or now - self.progress_at >= 10):
            raise MotorError("手动定位超时或连续10秒无位置进展，请检查SON、驱动器及机构")


class MotionGuard:
    """Durable uncertainty survives a service crash while the motor may still run."""
    def __init__(self, directory: Path):
        self.path = directory / "turntable-state.json"
        self.warning = None
        self.identity = None
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("uncertain") is not False:
                self.warning = "上次转盘运动未确认停止，请现场核查后读取并确认恢复"
                self.identity = (data.get("port"), data.get("axis"))
        except FileNotFoundError:
            pass
        except (OSError, ValueError, AttributeError):
            self.warning = "转盘状态文件无法验证，请现场核查后读取并确认恢复"

    def mark(self, config, uncertain, warning=None):
        from .storage import atomic_json
        atomic_json(self.path, {"uncertain": uncertain, "port": config.port,
                               "axis": config.axis, "updatedAt": time.time()})
        self.identity = (config.port, config.axis) if uncertain else None
        self.warning = warning


class TelemetryWriter:
    def __init__(self, directory):
        self.path = directory / "turntable.jsonl"
        self.stream = self.path.open("xb", buffering=0)
        self.started = time.monotonic()
        self.last_sync = 0.0
        self.count = 0
        self.hash = hashlib.sha256()

    def write(self, event, data):
        row = {"event": event, "hostTime": time.time(),
               "elapsedSeconds": time.monotonic() - self.started, **data}
        payload = (json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        if self.stream.write(payload) != len(payload):
            raise OSError("转盘遥测写入不完整")
        self.hash.update(payload)
        self.count += 1
        if event != "status" or time.monotonic() - self.last_sync >= 1:
            os.fsync(self.stream.fileno())
            self.last_sync = time.monotonic()

    def finish(self):
        try:
            os.fsync(self.stream.fileno())
        finally:
            self.stream.close()
        return {"file": "turntable.jsonl", "events": self.count, "sha256": self.hash.hexdigest(),
                "timestampBasis": "sequential host observations; not hardware synchronized",
                "positionUnit": "raw drive count; outputAngleDeg in degrees only when reference valid",
                "feedbackProtocol": "0x20/34-byte + 0x24/17-byte",
                "geometryConversion": "pending user calibration", "cloudSync": "supported"}


DEFAULT_MOTOR_FACTORY = MotorController
