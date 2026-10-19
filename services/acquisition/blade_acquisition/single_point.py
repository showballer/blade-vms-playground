"""Pure planning for one manually identified blade/material point.

No I/O or clock reads belong here.  The current controller accepts one position
move from rest, not a stream of moving setpoints.  A short arc can therefore only
be an explicitly bounded, unverified position-profile approximation.  Manual
marks never establish measured rotor phase or independently verified identity.
"""
from __future__ import annotations

import math
import statistics
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator


class SinglePointConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bladeId: str = Field(default="A", min_length=1, max_length=80, strict=True)
    pointId: str = Field(default="P1", min_length=1, max_length=80, strict=True)
    pointName: str = Field(default="P1", min_length=1, max_length=120, strict=True)
    materialMark: str = Field(min_length=1, max_length=120, strict=True)
    distanceM: float = Field(ge=0.001, le=10000, allow_inf_nan=False)
    hubHeightDeltaM: float = Field(ge=-10000, le=10000, allow_inf_nan=False)
    radiusM: float = Field(ge=0.001, le=1000, allow_inf_nan=False)
    axis1Sign: Literal[-1, 1] = 1
    axis2Sign: Literal[-1, 1] = 1
    rotationDirection: Literal["clockwise", "counterclockwise"] = "clockwise"
    arcDegrees: float = Field(default=10, ge=0.1, le=30, allow_inf_nan=False)
    nominalPeriodSeconds: float = Field(default=30, ge=0.5, le=3600, allow_inf_nan=False)
    maxOutputRpm: float = Field(default=2, ge=0.02, le=10, allow_inf_nan=False)
    maxOutputAccelerationDegS2: float = Field(default=30, gt=0, le=5000, allow_inf_nan=False)
    motionRampSeconds: float = Field(default=0.1, ge=0.001, le=10, allow_inf_nan=False)
    commandLatencyMs: float = Field(default=100, ge=0, le=5000, allow_inf_nan=False)
    axisStartSkewMs: float = Field(default=100, ge=0, le=5000, allow_inf_nan=False)
    syncUncertaintyMs: float = Field(default=150, ge=0, le=5000, allow_inf_nan=False)
    maxPeriodVariationPercent: float = Field(default=5, gt=0, le=20, allow_inf_nan=False)
    # Covers the next 30-second revolution plus its short-arc window; this does
    # not relax the separate period-drift, pointing-error or motion constraints.
    maxSyncAgeSeconds: float = Field(default=45, gt=0, le=300, allow_inf_nan=False)
    maxApproximationErrorMm: float = Field(default=5, gt=0, le=1000, allow_inf_nan=False)
    maxPredictionErrorMm: float = Field(default=10, gt=0, le=1000, allow_inf_nan=False)
    frontFacingConfirmed: StrictBool = False
    motionTimingConfirmed: StrictBool = False

    @field_validator("bladeId", "pointId", "pointName", "materialMark")
    @classmethod
    def nonblank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("叶片、测点和材料标记不能为空")
        return value

    @field_validator("distanceM", "hubHeightDeltaM", "radiusM", "axis1Sign", "axis2Sign",
                     "arcDegrees", "nominalPeriodSeconds", "maxOutputRpm",
                     "maxOutputAccelerationDegS2", "motionRampSeconds", "commandLatencyMs",
                     "axisStartSkewMs", "syncUncertaintyMs", "maxPeriodVariationPercent",
                     "maxSyncAgeSeconds", "maxApproximationErrorMm", "maxPredictionErrorMm",
                     mode="before")
    @classmethod
    def numeric(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("测量参数必须为有限数字")
        return value


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name}必须为有限数字")
    return float(value)


def estimate_manual_sync(mark_times, config: SinglePointConfig):
    """Estimate a period from 5–10 *same blade* server-monotonic marks.

    Never infer blade identity using mod-3.  Caller owns identity instructions,
    session scope and timestamp capture; browser wall clocks are not inputs.
    """
    times = [_number(value, "人工同步时间") for value in mark_times]
    if any(not 0 <= value <= 1e12 for value in times) or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("人工同步标记必须使用严格递增的非负本机单调时间")
    if len(times) > 10:
        raise ValueError("每次同步最多保留10次标记，请清除后重新同步")
    reasons = []
    if len(times) < 5:
        reasons.append("至少标记同一叶片连续5次经过6点方向")
    intervals = [b - a for a, b in zip(times, times[1:])]
    period = statistics.median(intervals) if intervals else config.nominalPeriodSeconds
    deviation = max((abs(value - period) for value in intervals), default=0.0)
    variation = 100 * deviation / period
    if not 0.5 <= period <= 3600:
        reasons.append("人工标记得到的周期超出0.5～3600秒范围")
    # A 3-blade every-blade sequence must not accidentally appear to be a good
    # same-blade sequence merely because its intervals are regular.
    if abs(period - config.nominalPeriodSeconds) / config.nominalPeriodSeconds > 0.25:
        reasons.append("标记周期与人工预估相差超过25%，请核实是否标记了同一叶片并更新预估")
    if variation > config.maxPeriodVariationPercent:
        reasons.append("人工标记周期波动超过允许范围，请稳定转速并重新同步")
    return {
        "ready": not reasons, "blockReasons": reasons, "markCount": len(times),
        "periodSeconds": period, "rpm": 60 / period,
        "periodVariationPercent": variation, "maxPeriodDeviationSeconds": deviation,
        "lastMarkAt": times[-1] if times else None,
        "source": "manual_marks", "phaseLocked": False, "identityConfirmed": False,
    }


def _world_angles(config, phase_degrees):
    phase = math.radians(phase_degrees)
    direction = 1 if config.rotationDirection == "clockwise" else -1
    x = direction * config.radiusM * math.sin(phase)
    y = config.hubHeightDeltaM + config.radiusM * math.cos(phase)
    yaw = math.atan2(x, config.distanceM)
    pitch = math.atan2(y, math.hypot(config.distanceM, x))
    return math.degrees(pitch), math.degrees(yaw), x, y


def _profile_position(distance, speed, ramp, time_seconds):
    """Assumed symmetric trapezoid/triangle, not a claim about PA40 units."""
    if distance == 0 or speed <= 0:
        return 0.0, 0.0
    acceleration = speed / ramp
    if distance >= speed * ramp:
        ramp_time = ramp
        cruise_time = distance / speed - ramp
        peak = speed
    else:
        ramp_time = math.sqrt(distance / acceleration)
        cruise_time = 0.0
        peak = acceleration * ramp_time
    duration = 2 * ramp_time + cruise_time
    t = max(0.0, time_seconds)
    if t < ramp_time:
        position = 0.5 * acceleration * t * t
    elif t < ramp_time + cruise_time:
        position = 0.5 * peak * ramp_time + peak * (t - ramp_time)
    elif t < duration:
        position = distance - 0.5 * acceleration * (duration - t) ** 2
    else:
        position = distance
    return position, duration


def preview_plan(config: SinglePointConfig, anchor=None, sync=None, *, prediction_revolutions=1):
    """Return an inspectable plan.  ``ready`` authorizes no hardware by itself.

    Anchor must come from prepare's stationary reference-checked device readback.
    The service additionally binds it to port/reference signature/session and
    validates the driver's actual guards immediately before any motion.
    """
    turns = _number(prediction_revolutions, "预测圈数")
    if not 0 <= turns <= 1e9:
        raise ValueError("预测圈数超出允许范围")
    reasons = []
    if not config.frontFacingConfirmed:
        reasons.append("尚未确认正对叶轮平面、两轴方向及6点材料标记的几何标定")
    if not config.motionTimingConfirmed:
        reasons.append("尚未确认实际运动斜坡、命令延迟和两轴启动时间差")
    if anchor is None:
        reasons.append("尚未准备并读取6点测点的两轴位置")
        anchor = {"axis1AngleDeg": 0.0, "axis2AngleDeg": 0.0}
        anchor_bound = False
    else:
        anchor_bound = True
    start = {name: _number(anchor[name], name) for name in ("axis1AngleDeg", "axis2AngleDeg")}
    if sync is None:
        reasons.append("尚未完成同一叶片的人工同步")
        period = config.nominalPeriodSeconds
        deviation = 0.0
    else:
        period = _number(sync["periodSeconds"], "同步周期")
        deviation = _number(sync["maxPeriodDeviationSeconds"], "周期波动")
        if not 0.5 <= period <= 3600 or deviation < 0:
            raise ValueError("同步估计范围无效")
        if not sync.get("ready"):
            reasons.extend(sync.get("blockReasons") or ["人工同步尚未就绪"])
    duration = period * config.arcDegrees / 360
    if duration <= 2 * config.motionRampSeconds:
        reasons.append("短弧时长不足以容纳已配置的加速和减速过程")
    base_pitch, base_yaw, _, _ = _world_angles(config, 180)
    def target(phase):
        pitch, yaw, x, y = _world_angles(config, phase)
        return (start["axis1AngleDeg"] + config.axis1Sign * (pitch - base_pitch),
                start["axis2AngleDeg"] + config.axis2Sign * (yaw - base_yaw), x, y)
    final = target(180 + config.arcDegrees)
    end = {"axis1AngleDeg": final[0], "axis2AngleDeg": final[1]}
    moves = []
    for index in (1, 2):
        name = f"axis{index}AngleDeg"
        # Match output angle protocol resolution.  Endpoint limits below apply
        # to both ideal geometry and the actual quantized command.
        delta = math.copysign(math.floor(abs(end[name] - start[name]) * 1000 + 0.5) / 1000,
                              end[name] - start[name])
        hold = delta == 0
        denominator = max(duration - config.motionRampSeconds, duration / 2)
        required_speed = abs(delta) / denominator / 6
        # Current driver converts output rpm through a 50:1 motor with integer
        # motor rpm.  Keep a conservative representable 0.02-rpm step.
        speed = max(0.02, math.floor(required_speed / 0.02 + 0.5) * 0.02) if not hold else 0.0
        acceleration = speed * 6 / config.motionRampSeconds
        _, estimated_duration = _profile_position(abs(delta), speed * 6, config.motionRampSeconds, duration)
        if not hold and (required_speed > config.maxOutputRpm or speed > config.maxOutputRpm):
            reasons.append(f"轴{index}所需输出转速超过配置上限")
        if not hold and acceleration > config.maxOutputAccelerationDegS2:
            reasons.append(f"轴{index}所需加速度超过配置上限")
        moves.append({
            "axis": index, "startAngleDeg": start[name], "targetAngleDeg": start[name] + delta,
            "deltaAngleDeg": delta, "speedRpm": speed,
            "estimatedDurationSeconds": estimated_duration,
            "requiredPeakSpeedRpm": required_speed,
            "requiredPeakAccelerationDegS2": acceleration, "hold": hold,
        })
    trajectory, max_error = [], 0.0
    for sample in range(257):
        t = duration * sample / 256
        phase = 180 + config.arcDegrees * sample / 256
        exact1, exact2, x, y = target(phase)
        planned = []
        for move in moves:
            position, _ = _profile_position(abs(move["deltaAngleDeg"]), move["speedRpm"] * 6,
                                             config.motionRampSeconds, t)
            planned.append(move["startAngleDeg"] + math.copysign(position, move["deltaAngleDeg"]))
        pitch = math.radians(base_pitch + (planned[0] - start["axis1AngleDeg"]) / config.axis1Sign)
        yaw = math.radians(base_yaw + (planned[1] - start["axis2AngleDeg"]) / config.axis2Sign)
        planned_x = config.distanceM * math.tan(yaw)
        planned_y = math.hypot(config.distanceM, planned_x) * math.tan(pitch)
        error = 1000 * math.hypot(planned_x - x, planned_y - y)
        max_error = max(max_error, error)
        trajectory.append({"timeSeconds": t, "rotorPhaseDeg": phase,
                           "axis1AngleDeg": exact1, "axis2AngleDeg": exact2,
                           "plannedAxis1AngleDeg": planned[0], "plannedAxis2AngleDeg": planned[1],
                           "errorMm": error})
    for index, limit in ((1, 35), (2, 180)):
        name = f"axis{index}AngleDeg"
        actual = moves[index - 1]
        if any(abs(value[name]) > limit for value in trajectory) or abs(actual["targetAngleDeg"]) > limit:
            reasons.append(f"轴{index}轨迹超出±{limit}°机械限制")
    # r * omega * dt is a conservative arc-length bound on phase timing error;
    # do not advertise the model's sampled path deviation as measured accuracy.
    speed_mm_s = 1000 * config.radiusM * 2 * math.pi / period
    budget = {
        "pathApproximationMm": max_error,
        "manualSyncMm": speed_mm_s * config.syncUncertaintyMs / 1000,
        "periodVariationMm": speed_mm_s * deviation * (turns + duration / period),
        "commandTimingMm": speed_mm_s * config.commandLatencyMs / 1000,
        "axisStartSkewMm": speed_mm_s * config.axisStartSkewMs / 1000,
    }
    budget["totalMm"] = sum(budget.values())
    if max_error > config.maxApproximationErrorMm:
        reasons.append("定位近似轨迹偏差超过允许值，不能按该短弧试跟")
    if budget["totalMm"] > config.maxPredictionErrorMm:
        reasons.append("人工同步、周期波动和运动时序的总预测误差超过测点允许值")
    return {
        "ready": not reasons, "blockReasons": list(dict.fromkeys(reasons)),
        "warnings": ["人工同步仅作预测，叶片身份与同一材料点命中尚未独立验证",
                     "单次双轴定位近似，不是闭环连续轨迹；预测误差不等于实测精度",
                     "运动斜坡为现场输入模型，不从PA40参数推定实际轨迹"],
        "motionModel": "position_chord_approximation", "phaseLocked": False,
        "identityConfirmed": False, "anchorBound": anchor_bound,
        "periodSeconds": period, "periodSource": "manual_marks" if sync else "nominal",
        "durationSeconds": duration, "startAngles": start, "endAngles": end,
        "axisMoves": moves, "maxPathErrorMm": max_error,
        "predictionErrorMm": budget["totalMm"], "errorBudget": budget,
        "trajectory": trajectory,
    }


def schedule_follow(config: SinglePointConfig, anchor, sync, now, ready_in_seconds=0):
    """Reserve the next feasible *same blade* revolution; never chase a late one."""
    now = _number(now, "当前单调时间")
    ready_in = _number(ready_in_seconds, "准备耗时")
    if not 0 <= now <= 1e12 or not 0 <= ready_in <= 3600:
        raise ValueError("单调时间或准备耗时超出允许范围")
    if sync is None or sync.get("lastMarkAt") is None:
        plan = preview_plan(config, anchor, sync)
        plan.update(scheduledStartAt=None, dispatchAt=None, scheduledEndAt=None, skippedRevolutions=0)
        return plan
    last = _number(sync["lastMarkAt"], "最后同步标记")
    period = _number(sync["periodSeconds"], "同步周期")
    if period <= 0:
        raise ValueError("同步周期必须为正数")
    latency = config.commandLatencyMs / 1000
    turns = max(1, math.floor((now + ready_in + latency - last) / period) + 1)
    start = last + turns * period
    dispatch = start - latency
    plan = preview_plan(config, anchor, sync, prediction_revolutions=turns)
    if last > now:
        plan["blockReasons"].append("同步标记来自未来或其他时基，请重新同步")
    # Both the moment of arming and the future reservation must remain fresh.
    if now - last > config.maxSyncAgeSeconds or start + plan["durationSeconds"] - last > config.maxSyncAgeSeconds:
        plan["blockReasons"].append("人工同步已过期，预约前需重新标记目标叶片")
    if dispatch <= now + ready_in:
        plan["blockReasons"].append("预约时序不足，禁止追赶已错过的叶片")
    plan["ready"] = not plan["blockReasons"]
    plan.update(scheduledStartAt=start, dispatchAt=dispatch,
                scheduledEndAt=start + plan["durationSeconds"], skippedRevolutions=turns - 1)
    return plan
