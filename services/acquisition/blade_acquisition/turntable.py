"""One serial owner per joint capture; no implicit motion or hardware fallback."""
from __future__ import annotations

from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator

from .turntable_driver import MotorController, MotorError


class TurntableConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    port: str = Field(pattern=r"^COM[1-9][0-9]{0,3}$")
    axis: StrictInt = Field(default=1, ge=1, le=2)
    speedRpm: float = Field(default=0.2, ge=0.02, le=100, allow_inf_nan=False)
    direction: Literal["forward", "reverse"] = "forward"
    durationSeconds: float = Field(default=0, ge=0, le=86400, allow_inf_nan=False)
    protocol: Literal["legacy_speed", "continuous"] = "legacy_speed"

    @field_validator("speedRpm", "durationSeconds", mode="before")
    @classmethod
    def numeric(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("转速和运行时长必须为数字")
        return value

    @property
    def signed_rpm(self):
        return self.speedRpm * (1 if self.direction == "forward" else -1)


class TurntableRequest(TurntableConfig):
    action: Literal["probe", "test", "prepare", "stop"] = "probe"
    testSeconds: StrictInt = Field(default=3, ge=1, le=15)
    confirmMotion: StrictBool = False
    confirmRecovery: StrictBool = False

    def config(self):
        return TurntableConfig(**self.model_dump(include=set(TurntableConfig.model_fields)))


def test_key(config):
    return config.model_dump(exclude={"durationSeconds"})


def start_motor(motor, config, cancel):
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
    position = motor.read_position_raw(axis)
    flags = status.pop("limit_flags")
    return {"axis": axis, "motorRpm": status["motor_rpm"],
            "outputRpm": status["output_rpm"], "runState": status["run_state"],
            "alarmCode": status["alarm_code"], "positionRaw": position,
            "limitFlags": flags, "limitActive": bool(flags & 1) if flags is not None else None,
            "stopPending": bool(flags & 2) if flags is not None else None,
            "limitBypass": bool(flags & 4) if flags is not None else None,
            "queryStartedAt": start, "observedAt": time.time()}


def require_ready(value):
    if value["motorRpm"] != 0:
        raise MotorError("转盘仍在运动，请先停止并核查现场状态")
    if value["alarmCode"]:
        raise MotorError(f"转盘驱动器报警 {value['alarmCode']}，不会自动复位")
    # Older firmware omits flags. Preserve unknown telemetry, but allow testing.
    if value["limitFlags"] not in (None, 0):
        raise MotorError("限位触发、停止未确认或限位旁路开启，不能开始联合运动")


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
                "positionUnit": "uncalibrated drive count", "cloudSync": "local_only"}


DEFAULT_MOTOR_FACTORY = MotorController
