"""One serial owner per joint capture; no implicit motion or hardware fallback."""
from __future__ import annotations

from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator, model_validator

from .serial_ports import SerialPort
from .turntable_driver import MotorController, MotorError
from .turntable_driver.protocol import validate_output_angle


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
    action: Literal["probe", "test", "manual_move", "recall", "prepare", "stop", "reference", "limits"] = "probe"
    testSeconds: StrictInt = Field(default=3, ge=1, le=15)
    confirmMotion: StrictBool = False
    confirmRecovery: StrictBool = False
    axis1AngleDeg: float | None = Field(default=None, allow_inf_nan=False)
    axis2AngleDeg: float | None = Field(default=None, allow_inf_nan=False)
    referenceSignature: str | None = Field(default=None, max_length=512)
    recordedPort: SerialPort | None = None

    @field_validator("axis1AngleDeg", "axis2AngleDeg", mode="before")
    @classmethod
    def recall_numeric(cls, value):
        return cls.numeric(value)

    @model_validator(mode="after")
    def recall_targets(self):
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

    @field_validator("name")
    @classmethod
    def point_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("循环点位名称不能为空")
        return value

    @field_validator("axis1AngleDeg", "axis2AngleDeg", mode="before")
    @classmethod
    def point_angle(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("循环点位角度必须是数字")
        return value

    @model_validator(mode="after")
    def point_limits(self):
        validate_output_angle(1, self.axis1AngleDeg)
        validate_output_angle(2, self.axis2AngleDeg)
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


class PointCycleConfig(BaseModel):
    """Validated parameters for a multi-point, multi-circle capture."""
    model_config = ConfigDict(extra="ignore")
    port: SerialPort
    points: list[PointCyclePoint] = Field(min_length=1, max_length=200)
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
    # Keep the laser running across point captures by default. The cycle
    # coordinator turns it off once the whole task ends or is cancelled.
    keepLaserOnBetweenPoints: StrictBool = True
    # Accepted for older clients only; never used as a microsecond debounce.
    rssiConfirmSamples: StrictInt = Field(default=3, ge=1, le=1000)
    rssiMinimumSeconds: float = Field(default=0, ge=0, le=3600, allow_inf_nan=False)

    @field_validator("dwellSeconds", "speedRpm", "rssiLeaveThresholdPercent", "rssiMinimumSeconds",
                     "rssiBaselineRatio", "rssiSmoothingMs", "rssiConfirmMs", "rssiMotionMarginMs",
                     "rssiEnterSpread", "rssiExitSpread", "rssiEnterConfirmMs", mode="before")
    @classmethod
    def cycle_numeric(cls, value):
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("循环采集参数必须是数字")
        return value

    @model_validator(mode="after")
    def bounded_total(self):
        if any(point.port != self.port for point in self.points):
            raise ValueError("点位记录串口与当前循环串口不同，请重新标定")
        if len(self.points) * self.cycles > 2000:
            raise ValueError("循环采集最多生成 2000 条独立记录")
        if self.rssiExitSpread >= self.rssiEnterSpread:
            raise ValueError("离开波动阈值必须小于进入波动阈值")
        if self.rssiMinimumSeconds > self.dwellSeconds:
            raise ValueError("RSSI 最短采集时间不能超过每点采集时长")
        return self


def test_key(config):
    return config.model_dump(exclude={"durationSeconds"})


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


def require_position_ready(value, config):
    require_ready(value)
    axis = value["axes"][str(config.axis)]
    guard = axis["guard"]
    limit = 35 if config.axis == 1 else 180
    if axis["output_angle_deg"] is None:
        raise MotorError("请先为当前轴建立参考位，角度无效时禁止定位")
    if not guard["soft_enabled"] or guard["minimum_deg"] < -limit or guard["maximum_deg"] > limit:
        raise MotorError(f"请先应用当前轴±{limit}°软限位")
    if not guard["minimum_deg"] <= config.targetAngleDeg <= guard["maximum_deg"]:
        raise MotorError("目标角度超出下位机软限位")
    if not guard["minimum_deg"] <= axis["output_angle_deg"] <= guard["maximum_deg"]:
        raise MotorError("当前位置超出软范围，请现场核查参考位")


def require_manual_position_ready(value, config):
    """Manual point marking only owns the selected axis; no DAQ preparation is needed."""
    if value["motorRpm"] != 0 or value["alarmCode"]:
        raise MotorError("当前轴仍在运动或驱动器报警")
    if value["limitFlags"] not in (None, 0):
        raise MotorError("当前轴限位触发、停止未确认或保护状态异常")
    axis = value["axes"][str(config.axis)]
    limit = 35 if config.axis == 1 else 180
    guard = axis["guard"]
    if axis["output_angle_deg"] is None:
        raise MotorError(f"轴{config.axis}尚未建立有效参考位")
    if axis["motor_rpm"] != 0 or axis["fault"] or axis["flags"] & 16:
        raise MotorError(f"轴{config.axis}反馈仍在运动或存在故障")
    if not guard["soft_enabled"] or guard["minimum_deg"] < -limit or guard["maximum_deg"] > limit:
        raise MotorError(f"请先应用轴{config.axis}±{limit}°软限位")
    if not guard["minimum_deg"] <= config.targetAngleDeg <= guard["maximum_deg"]:
        raise MotorError("目标角度超出当前轴软限位")


def require_manual_axis_ready(value, config):
    """Axis-only preflight for reference/soft-limit setup in the standalone panel."""
    if value["motorRpm"] != 0 or value["alarmCode"]:
        raise MotorError("当前轴仍在运动或驱动器报警")
    if value["limitFlags"] not in (None, 0):
        raise MotorError("当前轴限位触发、停止未确认或保护状态异常")
    axis = value["axes"][str(config.axis)]
    if axis["motor_rpm"] != 0 or axis["fault"] or axis["flags"] & 16 or axis["home_phase"] not in (0, 7, 8):
        raise MotorError(f"轴{config.axis}反馈仍在运动、回零或存在故障")


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


def position_timeout(value, config):
    distance = abs(config.targetAngleDeg - value["outputAngleDeg"])
    return max(15.0, distance / (config.speedRpm * 6) * 2 + 10)


def reference_key(value):
    """A prepared target belongs to the exact controller reference and count units."""
    fields = ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")
    return {axis: {**{key: data[key] for key in fields}, "valid": data["output_angle_deg"] is not None}
            for axis, data in value["axes"].items()}


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
