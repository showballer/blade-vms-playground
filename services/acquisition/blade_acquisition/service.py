from __future__ import annotations

import asyncio
import copy
import hmac
import ipaddress
import itertools
import json
import math
import os
import threading
import time
import uuid
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from itertools import islice
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from .receiver import Batch, PolytecReceiver, ReceiverConfig
from .rssi_handoff import RssiHandoff
from .serial_ports import SerialPort, list_turntable_ports
from .single_point import SinglePointConfig, preview_plan
from .single_point_runner import SinglePointSession
from .motion_trial import MotionTrialConfig, preview_full_circle
from .storage import DISPLAY_LIMIT, RecordingStore, atomic_json, empty_waveform, recording_rssi_stride
from .waveform import WaveformReader, make_wave
from .device import DevicePanel, WRITABLE
from .simulation import SimulationConfig, SimulationReceiver, simulation_catalog
from .turntable_driver.faults import get_fault_advice
from .turntable_driver.timing import trace_event
from .turntable import (TurntableConfig, TurntableRequest, PointCycleConfig, PointCyclePoint, MotionGuard, TelemetryWriter,
                        DEFAULT_MOTOR_FACTORY, snapshot as motor_snapshot, require_ready,
                        joint_snapshots, joint_snapshots_from_observations,
                        start_motor, renew_motor, test_key, require_position_ready,
                        position_reached, PositionProgress, ManualPositionProgress, reference_key,
                        check_position_motion,
                        reference_check, reference_change_message,
                        require_manual_position_ready, require_manual_axis_ready, require_stop_confirmed,
                        require_reference_capture_ready, require_reference_captured,
                        probe_motion_capability, station_move_plan, station_timing_plan)

MOTOR_STARTUP_SECONDS = 10.0
DAQ_READY_SECONDS = 30.0
JOINT_CYCLE_MS = 100
DEFAULT_JOINT_FOLLOW_ERROR_DEG = .75
JOINT_ARRIVAL_TOLERANCE_DEG = .1


@dataclass(frozen=True)
class Settings:
    token: str
    port: int
    data_dir: Path
    dll_path: str = ""

    @classmethod
    def from_environment(cls) -> "Settings":
        token = os.environ.get("BLADE_SERVICE_TOKEN", "")
        if len(token) < 32 or any(character.isspace() for character in token):
            raise ValueError("BLADE_SERVICE_TOKEN 必须是至少 32 字符、无空格的随机令牌，由桌面主进程传入。")
        port = int(os.environ.get("BLADE_SERVICE_PORT", "8765"))
        if not 1024 <= port <= 65535:
            raise ValueError("BLADE_SERVICE_PORT 必须在 1024 至 65535 之间。")
        data = os.environ.get("BLADE_DATA_DIR", "")
        if not data or not Path(data).is_absolute():
            raise ValueError("BLADE_DATA_DIR 必须是桌面应用专用的绝对路径。")
        return cls(token, port, Path(data), os.environ.get("BLADE_POLYTEC_DLL", ""))


class StartRequest(BaseModel):
    source: Literal["polytec_ivs500", "simulation"] = "polytec_ivs500"
    simulation: SimulationConfig | None = None
    deviceIp: str = Field(default="", max_length=15)
    hostIp: str = Field(default="", max_length=15)
    name: str = Field(min_length=1, max_length=120)
    windFarm: str = Field(default="", max_length=120)
    object: str = Field(default="", max_length=120)
    turbine: str = Field(default="", max_length=120)
    point: str = Field(default="", max_length=120)
    captureSessionId: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    confirmLaser: StrictBool = False
    turntable: TurntableConfig | None = None
    pointCycle: PointCycleConfig | None = None
    confirmMotion: StrictBool = False

    @field_validator("deviceIp", "hostIp")
    @classmethod
    def valid_address(cls, value: str) -> str:
        if value == "":
            return value
        address = ipaddress.IPv4Address(value)
        if address.is_unspecified or address.is_multicast or address.is_loopback or address.is_reserved:
            raise ValueError("设备和本机网卡必须是有效的非回环 IPv4 地址。")
        return str(address)

    @model_validator(mode="after")
    def validate_source(self):
        if self.pointCycle is not None and (self.source != "polytec_ivs500" or self.confirmMotion is not True):
            raise ValueError("多点循环任务只支持真实采集，且必须明确确认转盘运动")
        if self.pointCycle is not None and self.turntable is not None:
            raise ValueError("多点循环任务不能同时设置单点转盘任务")
        if self.turntable is not None and (self.source != "polytec_ivs500" or self.confirmMotion is not True):
            raise ValueError("联合转盘任务只支持真实采集，且必须明确确认转盘运动")
        if self.source == "polytec_ivs500":
            if not self.deviceIp or not self.hostIp or self.confirmLaser is not True:
                raise ValueError("真实设备采集必须提供有效设备/本机 IPv4 地址，并确认激光安全及允许修改设备 DAQ 目标。")
            if self.simulation is not None:
                raise ValueError("模拟参数只允许用于显式 simulation 数据源。")
        elif self.simulation is None:
            self.simulation = SimulationConfig()
        return self

    @field_validator("name", "windFarm", "object", "turbine", "point")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("name")
    @classmethod
    def name_is_not_blank(cls, value: str) -> str:
        if not value:
            raise ValueError("采集任务名称不能为空。")
        return value


class DeviceRequest(BaseModel):
    deviceIp: str = Field(min_length=7, max_length=15)
    action: str = Field(pattern="^(read|laser_read|set|autofocus|laser_on|laser_off)$")
    key: str | None = Field(default=None, max_length=32)
    value: str | int | None = None
    expected: str | int | None = None
    confirmChange: StrictBool = False
    confirmLaser: StrictBool = False

    _address = field_validator("deviceIp")(StartRequest.valid_address.__func__)

    @field_validator("value", "expected")
    @classmethod
    def bounded_value(cls, value):
        if isinstance(value, str) and (len(value) > 120 or "\x00" in value):
            raise ValueError("无效配置值")
        return value


class RssiCalibrationRequest(BaseModel):
    deviceIp: str = Field(min_length=7, max_length=15)
    hostIp: str = Field(min_length=7, max_length=15)
    state: Literal["background", "blade_on", "blade_pass"]
    durationSeconds: float = Field(default=2.0, ge=0.5, le=10.0)
    confirmLaser: StrictBool = False

    _device_address = field_validator("deviceIp", "hostIp")(StartRequest.valid_address.__func__)

    @model_validator(mode="after")
    def validate_addresses(self):
        if self.deviceIp == self.hostIp:
            raise ValueError("设备 IP 与本机网卡 IP 不能相同。")
        if self.confirmLaser is not True:
            raise ValueError("RSSI 标定需要明确确认激光安全。")
        return self


class SinglePointCapture(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    deviceIp: str = Field(min_length=7, max_length=15)
    hostIp: str = Field(min_length=7, max_length=15)
    port: SerialPort
    windFarm: str = Field(default="", max_length=120)
    object: str = Field(default="", max_length=120)
    turbine: str = Field(default="", max_length=120)
    point: str = Field(default="", max_length=120)
    captureSessionId: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    _address = field_validator("deviceIp", "hostIp")(StartRequest.valid_address.__func__)
    _text = field_validator("name", "windFarm", "object", "turbine", "point")(StartRequest.strip_text.__func__)
    _name = field_validator("name")(StartRequest.name_is_not_blank.__func__)

    @model_validator(mode="after")
    def distinct_addresses(self):
        if self.deviceIp == self.hostIp:
            raise ValueError("设备与本机网卡 IP 不能相同")
        return self


class SinglePointRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["preview", "prepare", "mark", "reset_sync", "arm", "cancel"]
    sessionId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,120}$")
    commandId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,120}$")
    config: SinglePointConfig | None = None
    capture: SinglePointCapture | None = None
    confirmLaser: StrictBool = False
    confirmStaticPoint: StrictBool = False
    confirmGeometry: StrictBool = False
    confirmMotion: StrictBool = False

    @model_validator(mode="after")
    def required_fields(self):
        if self.action != "preview" and (not self.sessionId or not self.commandId):
            raise ValueError("任务操作需要 sessionId 与 commandId")
        if self.action in {"preview", "prepare"} and self.config is None:
            raise ValueError("请填写单叶片单测点参数")
        if self.action == "prepare":
            if self.capture is None:
                raise ValueError("请填写真实采集地址、串口和任务名称")
            if not (self.confirmLaser and self.confirmStaticPoint and self.confirmGeometry):
                raise ValueError("请确认激光、静止六点方向材料测点及几何标定")
        elif self.capture is not None:
            raise ValueError("只有准备操作可以更改采集配置")
        if self.action not in {"prepare", "preview"} and self.config is not None:
            raise ValueError("准备后不能更改几何或时序配置，请取消并重新准备")
        return self


class MotionTrialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["preview"]
    config: MotionTrialConfig


class AcquisitionController:
    def __init__(self, settings: Settings, receiver_factory=PolytecReceiver, motor_factory=DEFAULT_MOTOR_FACTORY):
        self.settings = settings
        self.store = RecordingStore(settings.data_dir / "recordings")
        self.wave_reader = WaveformReader(self.store)
        self.receiver_factory = receiver_factory
        self.lock = threading.RLock()
        self.operation_lock = threading.Lock()
        self.state, self.error = "idle", None
        self.writer = None
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.device_ip = self.host_ip = ""
        self.rows: deque = deque(maxlen=250_000)
        self.device_busy = False
        self.laser_poll_busy = False
        self.device_snapshot = None
        self.laser_observation = None
        self.device_warning = None
        self.device_warning_ip = None
        self.source = "polytec_ivs500"
        self.simulation = None
        self.realtime_lock = threading.Lock()
        self.realtime_cache = None
        self.realtime_cache_key = None
        self.realtime_cache_at = 0.0
        self.motor_factory = motor_factory
        self.motion_guard = MotionGuard(settings.data_dir)
        self.turntable_busy = False
        self.turntable_snapshot = {"state": "disconnected", "feedback": None}
        self.capture_thread = None
        self.capture_stop = None
        self.turntable_test = None
        self.turntable_preparation = None
        self.test_thread = None
        self.test_stop = threading.Event()
        self.point_cycle = None
        self.rssi_handoff = None
        self.rssi_event = threading.Event()
        self.rssi_calibration_lock = threading.Lock()
        self.rssi_calibration_path = settings.data_dir / "rssi-calibration.json"
        self.observation_laser_ip = None
        self.single_point_runner = None
        # A cancel can overtake prepare over independent HTTP requests. Remember
        # it so that delayed preparation never starts a laser after cancellation.
        self.single_point_cancelled_sessions = OrderedDict()
        self.single_point_seen_sessions = set()

    def status(self) -> dict:
        with self.lock:
            return {"state": self.state, "error": self.error,
                    "receiver": {"source": self.source, "simulation": copy.deepcopy(self.simulation),
                                 "unit": "m/s", "running": bool((self.thread and self.thread.is_alive()) or
                                                                (self.capture_thread and self.capture_thread.is_alive())),
                                 "deviceIp": self.device_ip, "hostIp": self.host_ip,
                                 "dataPort": 60113 if self.source == "polytec_ivs500" else None,
                                 "sampleRate": self.writer.manifest["sampleRate"] if self.writer else None,
                                 "channels": ["CH1", "RSSI1"],
                                 "dllAvailable": bool(self.settings.dll_path and Path(self.settings.dll_path).is_file()),
                                 "dataLossAssessment": "not_applicable_simulation" if self.source == "simulation" else "unverified"},
                    "recording": copy.deepcopy(self.writer.manifest) if self.writer else None,
                    "deviceBusy": self.device_busy,
                    "deviceWarning": self.device_warning,
                    "deviceSettings": copy.deepcopy(self.device_snapshot),
                    "laserStatus": self._laser_status(),
                    "turntable": copy.deepcopy(self.turntable_snapshot),
                    "turntableBusy": self.turntable_busy,
                    "turntableWarning": self.motion_guard.warning,
                    "turntableTest": copy.deepcopy(self.turntable_test),
                    "turntablePreparation": copy.deepcopy(self.turntable_preparation),
                    "pointCycle": copy.deepcopy(self.point_cycle),
                    "singlePoint": self.single_point_runner.snapshot() if self.single_point_runner else None,
                    "indexWarning": self.store.index_error}

    def _laser_status(self, device_ip=None, *, busy=None):
        with self.lock:
            if busy is None:
                busy = bool(self.device_busy or self.turntable_busy or self.state in {"starting", "acquiring", "stopping"} or
                            (self.thread and self.thread.is_alive()) or
                            (self.capture_thread and self.capture_thread.is_alive()))
            observed = copy.deepcopy(self.laser_observation)
            selected_ip = (device_ip if device_ip is not None else (observed or {}).get("deviceIp", self.device_ip)) or ""
            if not observed or observed.get("deviceIp") != selected_ip:
                return {"deviceIp": selected_ip, "state": "unknown", "readAt": None,
                        "source": "unavailable", "busy": bool(busy)}
            if observed["state"] != "unknown" and (observed["readAt"] is None or time.time() - observed["readAt"] > 3):
                observed.update(state="unknown", source="unavailable", error="激光状态已过期，等待设备回读")
            return {**observed, "busy": bool(busy)}

    def _record_laser_snapshot(self, snapshot):
        if not isinstance(snapshot, dict):
            snapshot = {}
        field = snapshot.get("fields", {}).get("laser", {})
        value = field.get("value")
        known = field.get("supported") is True and type(value) is int and value in (0, 1)
        read_at = snapshot.get("readAt")
        read_at = float(read_at) if type(read_at) in (int, float) and math.isfinite(read_at) else None
        error = field.get("error") or snapshot.get("error")
        error_at = snapshot.get("observedAt")
        error_at = float(error_at) if type(error_at) in (int, float) and math.isfinite(error_at) else time.time()
        with self.lock:
            self.laser_observation = {"deviceIp": snapshot.get("deviceIp", ""),
                "state": ("on" if value else "off") if known else "unknown",
                "readAt": read_at, "source": "device-readback" if known else "unavailable",
                **({"error": str(error), "errorAt": error_at} if not known and error else {})}

    def _unknown_laser(self, device_ip, error=None):
        self._record_laser_snapshot({"deviceIp": device_ip, "fields": {}, "error": error,
                                     **({"observedAt": time.time()} if error else {})})

    def _device_receiver(self, config):
        receiver = self.receiver_factory(config)
        self._unknown_laser(config.device_ip)
        receiver.laser_observer = self._record_laser_snapshot
        return receiver

    def _acquire_operation(self):
        # User operations may wait briefly for a lightweight status read, never
        # queue behind another user action or an active capture.
        with self.lock:
            if self.operation_lock.acquire(blocking=False):
                return True
            polling = self.laser_poll_busy
        return bool(polling and self.operation_lock.acquire(timeout=0.6))

    def _device_command(self, config, action, key=None, value=None, expected=None, *, laser_only=False):
        try:
            panel = DevicePanel(config)
            result = (panel.run_command(action, laser_only=True) if laser_only else
                      panel.run_command(action) if key is None and value is None and expected is None else
                      panel.run_command(action, key, value, expected))
            self._record_laser_snapshot(result)
            return result
        except (OSError, RuntimeError, ValueError) as exc:
            self._unknown_laser(config.device_ip, str(exc))
            raise

    def read_laser(self, request: DeviceRequest):
        # A header poll never queues behind a capture/configuration operation.
        # The capture owner publishes readbacks through its bounded monitor handle.
        with self.lock:
            if not self.operation_lock.acquire(blocking=False):
                return self._laser_status(request.deviceIp, busy=True)
            if (self.device_busy or self.turntable_busy or self.status()["receiver"]["running"] or
                    self.state in {"starting", "acquiring", "stopping"}):
                self.operation_lock.release()
                return self._laser_status(request.deviceIp, busy=True)
            self.laser_poll_busy = True
        try:
            try:
                self._device_command(ReceiverConfig(request.deviceIp, "", self.settings.dll_path), "laser_read")
            except (OSError, RuntimeError, ValueError):
                pass  # Unknown is a valid poll result; never substitute an OFF value.
        finally:
            with self.lock:
                self.laser_poll_busy = False
                self.operation_lock.release()
        return self._laser_status(request.deviceIp)

    def motion_trial_operation(self, request: MotionTrialRequest):
        # This is not a hardware capability probe. The shipped adapter has no
        # versioned finite-trajectory command; never fall back to stop/go moves
        # or continuous velocity mode with disabled soft limits.
        preview = preview_full_circle(request.config)
        reason = "当前转盘接口尚未接入整圈连续轨迹，需要配套控制板固件及轨迹执行协议"
        preview.update(
            executionReady=False,
            capability={"supported": False, "checkedHardware": False,
                        "source": "client_protocol", "code": "trajectory_protocol_unavailable",
                        "message": reason},
            blockReasons=[reason],
        )
        return {**self.status(), "motionTrialPreview": preview}

    def single_point_operation(self, request: SinglePointRequest):
        if request.action == "preview":
            with self.lock:
                runner = self.single_point_runner
                anchor = (runner.anchor if runner and runner.state["state"] in {"awaiting_sync", "ready"}
                          and request.config == runner.config else None)
            return {**self.status(), "singlePointPreview": preview_plan(request.config, anchor)}
        if request.action == "cancel":
            with self.lock:
                runner = self.single_point_runner
                if runner and runner.request.sessionId == request.sessionId:
                    return runner.command(request)
                # No hardware side effect. Do not let a stale cancellation stop
                # a different session, but suppress a not-yet-arrived prepare.
                self.single_point_cancelled_sessions[request.sessionId] = request.commandId
                while len(self.single_point_cancelled_sessions) > 256:
                    self.single_point_cancelled_sessions.popitem(last=False)
                return self.status()
        if request.action != "prepare":
            with self.lock:
                if self.single_point_runner is None:
                    raise HTTPException(409, "请先准备单叶片单测点任务")
                return self.single_point_runner.command(request)
        if not self._acquire_operation():
            raise HTTPException(409, "设备操作进行中，请等待完成")
        try:
            with self.lock:
                if request.sessionId in self.single_point_cancelled_sessions:
                    raise HTTPException(409, "此准备任务已取消，请使用新的任务编号")
                previous = self.single_point_runner
                if previous and previous.request.sessionId == request.sessionId:
                    if previous.duplicate(request):
                        return self.status()
                    raise HTTPException(409, "同一任务已经准备过；修改参数须创建新的任务")
                if request.sessionId in self.single_point_seen_sessions:
                    raise HTTPException(409, "该任务编号已结束且已被后续任务替代，请创建新的任务")
                if len(self.single_point_seen_sessions) >= 2048:
                    raise HTTPException(409, "本次服务的单点任务编号已达上限，请停止后重新启动客户端")
                if (self.turntable_busy or self.device_busy or self.status()["receiver"]["running"] or
                        self.state in {"starting", "acquiring", "stopping"}):
                    raise HTTPException(409, "已有采集或设备操作运行，请先停止保存")
                if self.motion_guard.warning:
                    raise HTTPException(409, self.motion_guard.warning)
                if self.device_warning:
                    raise HTTPException(409, self.device_warning)
                capture = request.capture
                if self.observation_laser_ip and self.observation_laser_ip != capture.deviceIp:
                    raise HTTPException(409, "请先关闭上一台设备的观察激光")
                try:
                    receiver = self._device_receiver(ReceiverConfig(capture.deviceIp, capture.hostIp, self.settings.dll_path))
                    receiver.validate()
                except (OSError, RuntimeError, ValueError) as exc:
                    raise HTTPException(503, str(exc)) from exc
                metadata = capture.model_dump(exclude={"port"})
                metadata.update(source="polytec_ivs500", simulation=None, point=request.config.pointName,
                                turntable={"port": capture.port, "state": "preparing",
                                           "synchronization": "manual_unverified", "singlePoint": {}})
                try:
                    self.writer = self.store.create(metadata)
                except OSError as exc:
                    raise HTTPException(507, f"无法创建原始记录：{exc}") from exc
                self.source, self.simulation = "polytec_ivs500", None
                self.device_ip, self.host_ip = capture.deviceIp, capture.hostIp
                self.rows.clear()
                self.point_cycle, self.rssi_handoff = None, None
                self.turntable_preparation = None
                self.stop_event.clear()
                self.state, self.error = "starting", None
                runner = SinglePointSession(self, request, receiver)
                self.single_point_runner = runner
                self.single_point_seen_sessions.add(request.sessionId)
                self.writer.manifest["turntable"]["singlePoint"] = runner.snapshot()
                self.writer.persist()
                self.thread = threading.Thread(target=runner.run, name="blade-single-point", daemon=True)
                self.thread.start()
                return self.status()
        finally:
            self.operation_lock.release()

    def turntable_operation(self, request: TurntableRequest):
        trace_event("service_turntable_request", action=request.action, axis=request.axis,
                    targetAngleDeg=request.targetAngleDeg, axis1AngleDeg=request.axis1AngleDeg,
                    axis2AngleDeg=request.axis2AngleDeg, speedRpm=request.speedRpm,
                    accelerationDegS2=request.maxMoveAccelerationDegS2,
                    followErrorLimitDeg=request.followErrorLimitDeg)
        recovering = request.action in ("clear_trajectory_fault", "clear_guard_fault", "reset_alarm", "cancel_trajectory")
        if request.action in ("stop", "test", "manual_move", "recall", "prepare", "reference", "limits") and not request.confirmMotion:
            raise HTTPException(422, "请明确确认试转/停止，或确认已观察到实际转动并完成设置")
        with self.lock:
            testing = self.test_thread and self.test_thread.is_alive()
            if testing and request.action == "stop":
                if request.port != self.turntable_snapshot.get("port") or (not self.turntable_snapshot.get("recall") and request.axis != self.turntable_snapshot.get("axis")):
                    raise HTTPException(409, "请停止当前试转的同一端口和轴")
                self.test_stop.set()
        if testing and request.action == "stop":
            return self._stop_turntable_test()
        if not self._acquire_operation():
            raise HTTPException(409, "设备操作进行中，请等待完成")
        motor, handed_off, feedback = None, False, None
        group_recovery = False
        try:
            with self.lock:
                if self.status()["receiver"]["running"]:
                    raise HTTPException(409, "联合采集期间由任务独占转盘；请使用停止并保存")
                self.turntable_busy = True
                self.turntable_preparation = None
            if request.action in ("test", "manual_move", "recall"):
                if self.motion_guard.warning:
                    raise RuntimeError(self.motion_guard.warning)
                with self.lock:
                    self.turntable_test = None
                    self.test_stop = threading.Event()
                    self.turntable_snapshot = {"state": "positioning" if request.action in ("manual_move", "recall") else "testing", "port": request.port, "axis": 1 if request.action == "recall" else request.axis,
                                               "feedback": None, "config": request.config().model_dump()}
                    if request.action == "recall":
                        self.turntable_snapshot["recall"] = {"state": "moving", "targets": [request.axis1AngleDeg, request.axis2AngleDeg], "completedAxes": []}
                    self.test_thread = threading.Thread(target=self._run_point_recall if request.action == "recall" else self._run_turntable_test, args=(request,),
                                                        name="blade-turntable-test", daemon=True)
                    self.test_thread.start()
                    handed_off = True
                return self.status()
            if request.action == "prepare" and request.protocol != "position":
                result = self.turntable_test
                if self.motion_guard.warning or not result or not result.get("passed") or result.get("config") != test_key(request.config()):
                    raise RuntimeError("请先使用当前串口、轴、接口、转速和方向完成试转及停稳检查")
            motor = self.motor_factory(request.port, timeout=2.0, gear_ratio=50.0)
            motor.connect()
            if request.action == "stop":
                group_recovery = self._pending_motion_mode(request.port) == "dual_axis_timed"
                if self.motion_guard.warning and self.motion_guard.identity and (
                        self.motion_guard.identity[0] != request.port or
                        (not group_recovery and self.motion_guard.identity[1] != request.axis)):
                    raise RuntimeError("请选择上次未确认停止的同一端口和轴进行恢复")
                pending_axes = self._pending_turntable_axes(request.port)
                if group_recovery:
                    self._persist_pending_axes(request.port, [1, 2], "dual_axis_timed")
                    motor.stop_trajectory(wait=True, timeout=10)
                else:
                    self.motion_guard.mark(request, True, "转盘停止尚未确认")
                    if pending_axes:
                        self._persist_pending_axes(request.port, pending_axes)
                    motor.stop(request.axis)
            feedback = motor_snapshot(motor, request.axis)
            recovery = None
            if recovering:
                # Recovery never changes coordinates, resumes capture, or replays a session.
                # Read BOTH drives, not just the selected axis. All writes remain under
                # the same operation/serial owner as this fresh preflight.
                if self.motion_guard.warning and self.motion_guard.identity and self.motion_guard.identity[0] != request.port:
                    raise RuntimeError("请选择上次停止未确认的同一串口恢复")
                capability = probe_motion_capability(motor)
                trajectory = capability.get("status")
                if request.action == "cancel_trajectory":
                    if not trajectory or trajectory["state"] != 2 or trajectory["fault"] or trajectory["session"] != request.expectedTrajectorySession:
                        raise RuntimeError("待执行轨迹已变化或不再待启动，请重新检查；未发送取消命令")
                elif trajectory and trajectory["state"] in (1, 2, 3, 4):
                    raise RuntimeError("已有上传、待启动或运行轨迹，请先停止两轴")
                if request.action != "clear_trajectory_fault" and trajectory and trajectory["state"] == 5:
                    raise RuntimeError("两轴停止尚未确认，请先停止两轴")
                observations = {request.axis: feedback, 3 - request.axis: motor_snapshot(motor, 3 - request.axis)}
                for axis, observation in observations.items():
                    position = observation["axes"][str(axis)]
                    if observation["motorRpm"] or position["motor_rpm"] or position["home_phase"] not in (0, 7, 8):
                        raise RuntimeError("两轴仍在运动或回零，请先停止两轴，不能恢复故障")
                if reference_key(observations[1]) != reference_key(observations[2]):
                    raise RuntimeError("恢复前参考位读数不一致，请重新检查")
                before_reference = reference_key(feedback)
                before_guards = {axis: value["guard"] for axis, value in feedback["axes"].items()}
                if request.action == "cancel_trajectory":
                    self._persist_pending_axes(request.port, [1, 2], "dual_axis_timed")
                    motor.cancel_pending_trajectory(request.expectedTrajectorySession)
                elif request.action == "clear_trajectory_fault":
                    if not capability.get("supported"):
                        raise RuntimeError("当前固件不支持独立清除轨迹，请使用配套 v3.4 或更新固件")
                    if request.expectedTrajectorySession is not None:
                        if not trajectory or trajectory["session"] != request.expectedTrajectorySession:
                            raise RuntimeError("轨迹会话已变化，请重新检查；未清除其他轨迹")
                        motor.clear_trajectory_fault(expected_session=request.expectedTrajectorySession)
                    else:
                        motor.clear_trajectory_fault()
                elif request.action == "clear_guard_fault":
                    motor.clear_guard_fault(request.axis)
                else:
                    # Alarm reset is not an encoder reset. Refuse limit/stop-pending
                    # conditions rather than treating the reset as a universal fix.
                    selected = feedback["axes"][str(request.axis)]
                    if selected["flags"] & 16 or feedback["limitFlags"] not in (None, 0):
                        raise RuntimeError("限位或停止状态异常，请先停止并排除原因")
                    if "reset_alarm" not in get_fault_advice("drive", feedback["alarmCode"]).apis:
                        raise RuntimeError("该驱动器报警未识别或无需复位，请先核对报警码和驱动器手册")
                    if motor.reset_alarm(request.axis):
                        raise RuntimeError("驱动器报警仍存在，未恢复运动")
                feedback = motor_snapshot(motor, request.axis)
                if reference_key(feedback) != before_reference or any(
                        value["guard"] != before_guards[axis] for axis, value in feedback["axes"].items()):
                    raise RuntimeError("恢复后参考位、反馈单位或保护配置发生变化，请重新核查；未恢复运动")
                if request.action == "clear_guard_fault" and feedback["axes"][str(request.axis)]["fault"]:
                    raise RuntimeError("单轴故障未清除，未恢复运动")
                # A successful recovery may resolve an old stop warning, but only
                # after separately confirming BOTH drives stopped on this port.
                for axis in (1, 2):
                    stopped = motor_snapshot(motor, axis)
                    require_stop_confirmed(stopped, request.model_copy(update={"axis": axis}))
                    if reference_key(stopped) != before_reference:
                        raise RuntimeError("恢复后参考位读回发生变化，请重新核查")
                if self.motion_guard.warning:
                    for axis in (1, 2):
                        self._confirm_turntable_axis(request.model_copy(update={"axis": axis}))
                recovery = {"action": request.action, "axis": request.axis, "verified": True, "completedAt": time.time()}
            if request.action in ("reference", "limits"):
                if self.motion_guard.warning:
                    identity = self.motion_guard.identity
                    pending = self._pending_turntable_axes(request.port)
                    # Only a physically confirmed reference capture may repair
                    # the same axis' fault-3 stop latch. The SDK first STOPs and
                    # verifies zero speed; keep the warning until final readback.
                    if (request.action != "reference" or not identity or identity[0] != request.port or
                            (request.axis not in pending and identity[1] != request.axis)):
                        raise RuntimeError(self.motion_guard.warning)
                self.turntable_test = None
                if request.action == "reference":
                    trajectory = probe_motion_capability(motor).get("status")
                    if trajectory and trajectory["state"] in (1, 2, 3, 4, 5):
                        raise RuntimeError("控制器仍有上传、待执行或未停稳轨迹，请先取消待执行轨迹或停止两轴，再建立参考")
                    require_reference_capture_ready(feedback, request)
                    motor.set_current_reference(request.axis)
                else:
                    require_manual_axis_ready(feedback, request)
                    guard = motor.get_guard_config(request.axis)
                    limit = 35 if request.axis == 1 else 180
                    motor.set_soft_range(request.axis, -limit, limit)
                    motor.set_guard_policy(request.axis, hardware=guard.hardware_enabled, soft=True,
                                           home_direction=guard.home_direction, confirmed=guard.confirmed,
                                           home_at_end=guard.home_at_end)
                feedback = motor_snapshot(motor, request.axis)
                if request.action == "reference":
                    require_reference_captured(feedback, request)
                    if self.motion_guard.warning:
                        require_stop_confirmed(feedback, request)
                        self._confirm_turntable_axis(request)
                if request.action == "limits":
                    guard = feedback["axes"][str(request.axis)]["guard"]
                    if not guard["soft_enabled"] or guard["minimum_deg"] != -limit or guard["maximum_deg"] != limit:
                        raise RuntimeError("软限位读回不一致，禁止定位")
            if request.action == "prepare":
                if self.motion_guard.warning:
                    raise RuntimeError(self.motion_guard.warning)
                if request.protocol == "position":
                    require_position_ready(feedback, request.config())
                else:
                    require_ready(feedback)
                with self.lock:
                    self.turntable_preparation = {"config": request.config().model_dump(), "checkedAt": time.time(),
                                                  "ready": True, "references": reference_key(feedback)}
            if request.action == "stop":
                if group_recovery:
                    for axis in (1, 2):
                        stopped = motor_snapshot(motor, axis)
                        require_stop_confirmed(stopped, request.model_copy(update={"axis": axis}))
                    self.motion_guard.mark(request, False)
                require_stop_confirmed(feedback, request)
                identity = self.motion_guard.identity
                if self.motion_guard.warning and identity and identity != (request.port, request.axis):
                    raise RuntimeError("请选择上次未确认停止的同一端口和轴进行恢复")
                self._confirm_turntable_axis(request)
            elif request.confirmRecovery and not recovering:
                if self._pending_motion_mode(request.port) == "dual_axis_timed":
                    raise RuntimeError("上次双轴轨迹停止未确认，请先执行停止，两轴确认后才能恢复")
                require_ready(feedback)
                identity = self.motion_guard.identity
                if self.motion_guard.warning and identity and identity != (request.port, request.axis):
                    raise RuntimeError("请选择上次未确认停止的同一端口和轴进行恢复")
                self._confirm_turntable_axis(request)
            health = None
            if request.action == "health" or recovering:
                observations = {request.axis: feedback}
                other = 2 if request.axis == 1 else 1
                observations[other] = motor_snapshot(motor, other)
                health = {"readAt": time.time(), "readOnly": True,
                          "referenceChangedDuringRead": reference_key(observations[1]) != reference_key(observations[2]),
                          "axes": {str(axis): {key: observations[axis].get(key) for key in
                                   ("alarmCode", "runState", "limitFlags", "observedAt")}
                                   for axis in (1, 2)}}
                # Read only while the operation owner holds an idle serial port.
                # Never rewrite PA40/41/42 to make a trajectory appear faster.
                if request.action == "health" and hasattr(motor, "get_motion_profile"):
                    health["motionProfiles"] = {}
                    for axis in (1, 2):
                        try:
                            health["motionProfiles"][str(axis)] = asdict(motor.get_motion_profile(axis))
                        except MotorError as exc:
                            if getattr(exc, "status", None) != 7:
                                raise
                            health["motionProfiles"][str(axis)] = {"unavailable": "当前固件不支持读取驱动器加减速参数"}
            capability = probe_motion_capability(motor) if request.action in ("probe", "health") or recovering else None
            if health is not None:
                issues = []
                for axis in (1, 2):
                    position = feedback["axes"][str(axis)]
                    alarm = health["axes"][str(axis)]["alarmCode"]
                    if alarm:
                        issues.append(asdict(get_fault_advice("drive", alarm, motor_id=axis)))
                    if position["fault"]:
                        issues.append(asdict(get_fault_advice("guard", position["fault"], motor_id=axis)))
                    if position["output_angle_deg"] is None:
                        issues.append(asdict(get_fault_advice("trajectory", 2, motor_id=axis)))
                if (capability and capability.get("status") and capability["status"]["fault"] and
                        (capability["status"]["state"], capability["status"]["fault"]) != (8, 1)):
                    issues.append(asdict(get_fault_advice("trajectory", capability["status"]["fault"])))
                health["issues"] = issues
            with self.lock:
                self.turntable_snapshot = {"state": "prepared" if request.action == "prepare" else "stopped" if request.action == "stop" else "checked", "port": request.port,
                                           "axis": request.axis, "feedback": feedback,
                                           "connected": False, "error": None,
                                           **({"motionCapability": capability} if capability is not None else {}),
                                           **({"health": health} if health is not None else {}),
                                           **({"recovery": recovery} if recovery is not None else {}),
                                           **({"stopConfirmed": True} if request.action == "stop" else {})}
        except HTTPException:
            raise
        except Exception as exc:
            with self.lock:
                self.turntable_test = None
                self.turntable_snapshot = {"state": "error", "port": request.port, "axis": request.axis,
                                           "feedback": feedback, "error": str(exc),
                                           **({"stopConfirmed": False} if request.action == "stop" else {})}
            raise HTTPException(503, f"转盘检查/停止失败：{exc}") from exc
        finally:
            try:
                if motor is not None:
                    motor.close(stop=False)
            finally:
                if not handed_off:
                    with self.lock:
                        self.turntable_busy = False
                    self.operation_lock.release()
        # Synchronous reads/setup are complete only after the serial owner has
        # closed and released its lock. Async handoffs return from above while
        # their worker still owns the busy state and lock.
        return self.status()

    def _pending_turntable_axes(self, port):
        try:
            data = json.loads(self.motion_guard.path.read_text(encoding="utf-8"))
            if data.get("port") == port:
                return [axis for axis in data.get("pendingAxes", []) if type(axis) is int and axis in (1, 2)]
        except (OSError, ValueError, TypeError):
            pass
        return []

    def _persist_pending_axes(self, port, axes, motion_mode=None):
        motion_mode = motion_mode or self._pending_motion_mode(port)
        atomic_json(self.motion_guard.path, {"uncertain": True, "port": port,
                                            "axis": axes[0], "pendingAxes": axes, "updatedAt": time.time(),
                                            **({"motionMode": motion_mode} if motion_mode else {})})
        self.motion_guard.identity = (port, axes[0])
        self.motion_guard.warning = "仍有转盘轴停止未确认，请按当前提示逐轴读取并恢复"

    def _pending_motion_mode(self, port):
        try:
            data = json.loads(self.motion_guard.path.read_text(encoding="utf-8"))
            return data.get("motionMode") if data.get("uncertain") and data.get("port") == port else None
        except (OSError, ValueError, TypeError):
            return None

    @staticmethod
    def _motion_capability(motor):
        # A controller instance owns one serial connection. Probe once per owner;
        # unknown-command is the only firmware-level legacy fallback.
        if not hasattr(motor, "_blade_motion_capability"):
            motor._blade_motion_capability = probe_motion_capability(motor)
        return motor._blade_motion_capability

    def _execute_dual_axis_move(self, motor, configs, feedback, cancel, update, on_command=None,
                               *, acceleration=3.0, follow_error_limit=DEFAULT_JOINT_FOLLOW_ERROR_DEG):
        """Own the buffered group move until BOTH axes are verified stopped."""
        from dataclasses import asdict

        if configs[0].speedRpm > 10:
            raise ValueError("双轴轨迹换点速度不能超过10 rpm，请降低回位速度")
        if (isinstance(follow_error_limit, bool) or not isinstance(follow_error_limit, (int, float)) or
                not math.isfinite(follow_error_limit) or not .5 <= follow_error_limit <= 10):
            raise ValueError("轨迹跟随误差保护应为0.5～10°，不能关闭")
        references = reference_key(feedback)
        capability = self._motion_capability(motor)
        current = motor.get_trajectory_status()
        capability["status"] = asdict(current)
        if current.state in (1, 2, 3, 4, 5):
            raise RuntimeError("控制器已有待启动或运行中的双轴轨迹，请先停止并核查")
        if current.state == 7:
            raise RuntimeError("控制器轨迹仍处于故障状态，请先停止并核查")
        start = tuple(feedback["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2))
        targets = tuple(config.targetAngleDeg for config in configs)
        points, evidence = station_move_plan(start, targets, configs[0].speedRpm, acceleration=acceleration)
        # app(3) v3.2+: the controller may slow BOTH axes on its shared path.
        # Keep fault protection and a bounded timeout; an extended move never
        # means the blade gate may run before stopped arrival is verified.
        wait_seconds = evidence["plannedSeconds"] * 4 + 35
        evidence.update(adaptiveFollow=True, cycleMs=JOINT_CYCLE_MS,
                        followErrorLimitDeg=follow_error_limit,
                        arrivalToleranceDeg=JOINT_ARRIVAL_TOLERANCE_DEG,
                        waitTimeoutSeconds=wait_seconds)
        evidence["referenceBefore"] = copy.deepcopy(references)
        evidence["referenceChecks"] = []
        def verify_reference(value, phase, context):
            check = reference_check(references, value, phase)
            evidence["referenceChecks"].append(check)
            del evidence["referenceChecks"][:-20]
            if check["changes"]:
                # Keep the offending observation even when catch performs a
                # newer stop-confirmation snapshot and the transient disappears.
                evidence["referenceMismatch"] = {**check, "feedback": copy.deepcopy(value)}
                raise RuntimeError(reference_change_message(context, check))
        if all(position_reached(feedback, config) for config in configs):
            evidence.update(plannedSeconds=0, actualSeconds=0, state="already_at_target")
            update("holding", motionMode="dual_axis_timed", lastMove=evidence, feedback=feedback)
            return not cancel.is_set(), [1, 2], feedback
        if cancel.is_set():
            return False, [], feedback
        touched = False
        started_at = None
        try:
            # Persist the group before the first write, including a lost prepare/start ACK.
            self._persist_pending_axes(configs[0].port, [1, 2], "dual_axis_timed")
            touched = True
            update("positioning", motionMode="dual_axis_timed", lastMove=evidence,
                   connected=True, stopConfirmed=False)
            prepared = motor.prepare_trajectory(points, max_speed=configs[0].speedRpm * 6,
                                                 max_accel=evidence["accelerationLimitDegS2"],
                                                 cycle_ms=JOINT_CYCLE_MS, adaptive=True,
                                                 max_error=follow_error_limit,
                                                 tolerance=JOINT_ARRIVAL_TOLERANCE_DEG, cancel=cancel)
            if cancel.is_set():
                raise RuntimeError("双轴换点已取消")
            evidence["session"] = prepared.session
            # Uploading does not move. References may nevertheless have changed
            # between our point check and the driver's preparation snapshot.
            # Reject that change before START, not only after physical arrival.
            def validate_start(snapshots):
                nonlocal feedback
                for config, checked in zip(configs, snapshots):
                    verify_reference(checked, "before_start", "轨迹准备期间参考位或反馈计数单位已变化，未启动双轴运动")
                    require_position_ready(checked, config)
                    if any(
                            abs(checked["axes"][str(axis)]["output_angle_deg"] - start[axis - 1]) > .1
                            for axis in (1, 2)):
                        raise RuntimeError("轨迹准备期间参考位或起点已变化，未启动双轴运动")
                    feedback = checked
                if on_command:
                    on_command()

            def before_start(observations):
                # The SDK has just read and validated both drives under its
                # serial lock. Compare our original plan against those same
                # observations; do not issue another round of serial queries.
                validate_start(joint_snapshots_from_observations(observations))

            reuse_observations = getattr(motor, "trajectory_start_observer", False) is True
            evidence["startCheckSource"] = "sdk_observation" if reuse_observations else "service_snapshot"
            if not reuse_observations:
                # Keep compatibility with older injected/vendor adapters.
                validate_start(motor_snapshot(motor, config.axis) for config in configs)
            started_at = time.monotonic()
            if reuse_observations:
                motor.start_trajectory(prepared.session, cancel=cancel, before_start=before_start)
            else:
                motor.start_trajectory(prepared.session, cancel=cancel)

            last_feedback_at = -math.inf
            # Explicit local timing diagnostics sample the same cached 0x37
            # feed more often; production keeps its one-second observation.
            position_interval = .1 if os.environ.get("BLADE_TURNTABLE_TIMING_LOG") else 1.0
            def observed(status):
                nonlocal last_feedback_at, feedback
                evidence["status"] = asdict(status)
                extra = {}
                if status.state in (3, 4) and not status.fault and time.monotonic() - last_feedback_at >= position_interval:
                    query_started_at = time.time()
                    supported = getattr(motor, "_blade_axis_positions_supported", None)
                    positions = (motor.probe_axis_positions() if supported is None else
                                 motor.get_axis_positions() if supported else None)
                    received_at = time.time()
                    if supported is None:
                        motor._blade_axis_positions_supported = positions is not None
                    if positions is None:
                        # Only an explicit unsupported command may enter this
                        # path. Do not replace missing positions with 0x34 targets
                        # or resume the expensive 0x20/guard polling while moving.
                        evidence["positionFeedback"] = {"supported": False,
                            "source": "legacy-command-unsupported", "readAt": received_at}
                    else:
                        evidence["positionObservation"] = {"source": "0x37", "readAt": received_at,
                            "axes": [asdict(position) for position in positions]}
                        feedback = self._trajectory_position_feedback(feedback, positions, configs,
                                                                      query_started_at, received_at)
                        extra["feedback"] = feedback
                    last_feedback_at = time.monotonic()
                update("positioning", motionMode="dual_axis_timed", lastMove=copy.deepcopy(evidence), **extra)

            finished = motor.wait_trajectory(prepared.session,
                                             timeout=wait_seconds,
                                             cancel=cancel, on_status=observed)
            evidence.update(status=asdict(finished), state="complete",
                            actualSeconds=time.monotonic() - started_at)
            for config in configs:
                feedback = motor_snapshot(motor, config.axis)
                verify_reference(feedback, "arrival", "双轴换点最终参考位或反馈计数单位已变化")
                require_position_ready(feedback, config)
                if not position_reached(feedback, config):
                    raise RuntimeError("双轴换点最终角度或参考位核查失败")
            self.motion_guard.mark(configs[0], False)
            touched = False
            update("holding", motionMode="dual_axis_timed", lastMove=copy.deepcopy(evidence),
                   feedback=feedback, stopConfirmed=True)
            return not cancel.is_set(), [1, 2], feedback
        except Exception as exc:
            observed_fault = evidence.get("status", {})
            if observed_fault.get("fault") == 7:
                errors = [(axis, observed_fault.get(f"error{axis}_deg")) for axis in (1, 2)]
                details = [f"{'俯仰' if axis == 1 else '水平'}轴误差 {abs(error):.3f}°"
                           for axis, error in errors if isinstance(error, (int, float)) and math.isfinite(error)]
                exc = RuntimeError(f"跟随误差超限：{'，'.join(details) or '控制器已触发保护'}；"
                                   f"保护限 {follow_error_limit:g}°，本次定位已停止；"
                                   "停稳后清除旧轨迹，再重新定位，无需重新设置归零")
            evidence.update(state="cancelled" if cancel.is_set() else "error", error=str(exc))
            if started_at is not None:
                evidence["actualSeconds"] = time.monotonic() - started_at
            if touched:
                try:
                    motor.stop_trajectory(wait=True, timeout=10)
                    for config in configs:
                        feedback = motor_snapshot(motor, config.axis)
                        require_stop_confirmed(feedback, config)
                    stop_check = reference_check(references, feedback, "after_stop")
                    evidence["referenceChecks"].append(stop_check)
                    if stop_check["changes"] and "referenceMismatch" not in evidence:
                        evidence["referenceMismatch"] = stop_check
                    self.motion_guard.mark(configs[0], False)
                except Exception as stop_error:
                    evidence["stopError"] = str(stop_error)
                    self._persist_pending_axes(configs[0].port, [1, 2], "dual_axis_timed")
                    self.motion_guard.warning = f"双轴换点停止未确认：{stop_error}；请现场核查"
            update("unknown" if self.motion_guard.warning else "stopped", lastMove=copy.deepcopy(evidence),
                   feedback=feedback, stopConfirmed=not bool(self.motion_guard.warning))
            if cancel.is_set() and not self.motion_guard.warning:
                return False, [], feedback
            raise exc

    @staticmethod
    def _trajectory_position_feedback(previous, positions, configs, query_started_at, received_at):
        """Only 0x37 position fields are fresh; references/guards stay preflight observations."""
        if len(positions) != 2:
            raise RuntimeError("两轴位置反馈数量无效，已停止轨迹")
        transport_ms = (received_at - query_started_at) * 1000
        if transport_ms < 0 or not math.isfinite(transport_ms):
            raise RuntimeError("两轴位置反馈观察时间无效，已停止轨迹")
        result = copy.deepcopy(previous)
        for axis, position in enumerate(positions, 1):
            conservative_age_ms = position.sample_age_ms + transport_ms
            if (not position.usable or position.source not in (0, 1) or
                    not math.isfinite(position.angle_deg) or not position.flags & 1 or
                    position.sample_age_ms < 0 or conservative_age_ms > 1000 or
                    position.alarm_code or position.guard_fault or position.flags & 16):
                raise RuntimeError(f"轴{axis} 0x37位置反馈过期、参考无效、读取失败或存在报警，已停止轨迹")
            old = previous["axes"][str(axis)]
            if bool(position.flags & 2) != bool(old["guard"]["soft_enabled"]):
                raise RuntimeError(f"轴{axis}运动期间软限位启用状态已变化，已停止轨迹")
            result["axes"][str(axis)].update(actual_counts=position.actual_counts,
                output_angle_deg=position.angle_deg, motor_rpm=position.motor_rpm,
                flags=position.flags, fault=position.guard_fault,
                observedAt=received_at - conservative_age_ms / 1000,
                positionSampleAgeMs=position.sample_age_ms, positionSource=position.source,
                positionConservativeAgeMs=conservative_age_ms,
                referenceObservedAt=old.get("referenceObservedAt", old["observedAt"]),
                guardObservedAt=old.get("guardObservedAt", old["observedAt"]))
        selected = result["axes"][str(result["axis"])]
        result.update(motorRpm=selected["motor_rpm"], outputRpm=selected["motor_rpm"] / 50,
                      outputAngleDeg=selected["output_angle_deg"], positionRaw=selected["actual_counts"],
                      queryStartedAt=query_started_at, observedAt=received_at, positionSource="0x37")
        for config in configs:
            check_position_motion(result, config, allow_other_axis_motion=True)
        return result

    def _confirm_turntable_axis(self, request):
        remaining = [axis for axis in self._pending_turntable_axes(request.port) if axis != request.axis]
        if remaining:
            self._persist_pending_axes(request.port, remaining)
        else:
            self.motion_guard.mark(request, False)

    def _stop_turntable_test(self):
        with self.lock:
            thread = self.test_thread
            self.test_stop.set()
        if thread:
            thread.join(60)
            if thread.is_alive():
                raise HTTPException(503, "试转停止尚未确认，请现场核查转盘状态")
        if self.motion_guard.warning:
            raise HTTPException(503, self.motion_guard.warning)
        return self.status()

    def _run_turntable_test(self, request):
        """Serial owner for a bounded, cancellable test; never opens DAQ or laser."""
        config = request.config()
        motor, attempted, passed, cancelled = None, False, False, False
        errors = []
        first_position = delta = 0
        effective = None
        matched_at = None

        def update(state, feedback=None, **extra):
            with self.lock:
                self.turntable_snapshot.update(state=state, **extra)
                if feedback is not None:
                    self.turntable_snapshot["feedback"] = feedback

        try:
            motor = self.motor_factory(config.port, timeout=2.0, gear_ratio=50.0)
            motor.connect()
            feedback = motor_snapshot(motor, config.axis)
            update("checked", feedback, connected=True)
            if config.protocol == "position":
                (require_manual_position_ready if request.action == "manual_move" else require_position_ready)(feedback, config)
            else:
                require_ready(feedback)
            first_position = feedback["positionRaw"]
            if self.test_stop.is_set():
                cancelled = True
                return
            self.motion_guard.mark(config, True, "试转停止尚未确认")
            attempted = True
            effective = start_motor(motor, config, self.test_stop)
            if effective is None:
                cancelled = True
                return
            if config.protocol == "position":
                progress = ManualPositionProgress(feedback, config) if request.action == "manual_move" else PositionProgress(feedback, config)
            started = time.monotonic()
            update("positioning" if request.action == "manual_move" else "testing", effectiveRpm=effective)
            deviations = 0
            settled = 0
            while not self.test_stop.is_set():
                renew_motor(motor, config)
                feedback = motor_snapshot(motor, config.axis)
                delta = feedback["positionRaw"] - first_position
                update("positioning" if request.action == "manual_move" else "testing", feedback, positionDelta=delta)
                if feedback["alarmCode"] or feedback["limitFlags"] not in (None, 0):
                    raise RuntimeError("试转检测到报警或已反馈的限位异常")
                if config.protocol == "position":
                    progress.check(feedback, config)
                    settled = settled + 1 if position_reached(feedback, config) else 0
                    if settled >= 2:
                        passed = True
                        break
                    self.test_stop.wait(0.2)
                    continue
                matched = abs(feedback["outputRpm"] - effective) <= max(0.01, abs(effective) * 0.1)
                now = time.monotonic()
                if matched and delta != 0 and matched_at is None:
                    matched_at = now
                if matched_at is None and now - started >= MOTOR_STARTUP_SECONDS:
                    raise RuntimeError("命令已接收，但 10 秒内未同时检测到目标转速和位置变化；请检查控制轴、SON、驱动器模式和固件接口")
                if matched_at is not None:
                    deviations = 0 if matched else deviations + 1
                    if deviations >= 3:
                        raise RuntimeError("试转连续三次反馈偏离设定转速")
                    if now - matched_at >= request.testSeconds:
                        passed = True
                        break
                self.test_stop.wait(0.2)
            cancelled = self.test_stop.is_set()
        except Exception as exc:
            errors.append(str(exc))
        finally:
            if attempted:
                update("test_stopping")
                try:
                    motor.stop(config.axis)
                    feedback = motor_snapshot(motor, config.axis)
                    require_stop_confirmed(feedback, config)
                    self.motion_guard.mark(config, False)
                    update("stopped", feedback, stopConfirmed=True, connected=False)
                except Exception as exc:
                    errors.append(f"试转停止未确认：{exc}")
                    self.motion_guard.warning = errors[-1] + "；请现场核查后读取并确认恢复"
                    update("unknown", stopConfirmed=False)
            if motor:
                try:
                    motor.close(stop=False)
                except Exception as exc:
                    errors.append(f"关闭试转串口失败：{exc}")
            with self.lock:
                self.turntable_test = {"passed": passed and not cancelled and not errors,
                                       "cancelled": cancelled, "config": test_key(config),
                                       "effectiveRpm": effective, "positionDelta": delta,
                                       "testedAt": time.time(), "error": "; ".join(errors) or None}
                self.turntable_snapshot.update(connected=False, error="; ".join(errors) or None)
                if errors and self.turntable_snapshot["state"] != "unknown":
                    self.turntable_snapshot["state"] = "error"
                elif not attempted and not errors:
                    self.turntable_snapshot["state"] = "checked"
                self.turntable_busy = False
            self.operation_lock.release()

    def _run_point_recall(self, request):
        """Own the serial port for both axes; stop/cancel never queues the next axis."""
        configs = [TurntableConfig(port=request.port, axis=axis, protocol="position",
                                   targetAngleDeg=angle, speedRpm=request.speedRpm)
                   for axis, angle in ((1, request.axis1AngleDeg), (2, request.axis2AngleDeg))]
        motor, active, feedback = None, None, None
        completed, errors = [], []
        passed = False

        def update(state, **extra):
            with self.lock:
                self.turntable_snapshot.update({"state": state, "feedback": feedback, **extra})
                self.turntable_snapshot["recall"]["completedAxes"] = list(completed)
                self.turntable_snapshot["recall"].update({key: copy.deepcopy(extra[key])
                                                        for key in ("motionMode", "lastMove") if key in extra})

        def stop_active():
            nonlocal active, feedback
            if active is None:
                return
            update("test_stopping")
            motor.stop(active.axis)
            feedback = motor_snapshot(motor, active.axis)
            require_stop_confirmed(feedback, active)
            self.motion_guard.mark(active, False)
            active = None
            update("stopped", stopConfirmed=True)

        try:
            motor = self.motor_factory(request.port, timeout=2.0, gear_ratio=50.0)
            motor.connect()
            # Validate both drives and both targets before moving either axis.
            references = None
            initial_snapshots = (joint_snapshots(motor)
                                 if getattr(motor, "trajectory_start_observer", False) is True
                                 else (motor_snapshot(motor, config.axis) for config in configs))
            for config, feedback in zip(configs, initial_snapshots):
                require_position_ready(feedback, config)
                if references is None:
                    references = reference_key(feedback)
                    if request.referenceSignature is not None:
                        actual = [[references[str(axis)][key] for key in ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")] for axis in (1, 2)]
                        if json.loads(request.referenceSignature) != actual:
                            raise RuntimeError("记录后参考位或反馈单位已变化，请重新标定此点")
                elif reference_key(feedback) != references:
                    raise RuntimeError("两轴参考位或反馈单位已变化，请重新核查点位")
            capability = self._motion_capability(motor)
            update("positioning", motionCapability=capability, motionMode=capability["mode"])
            if capability["supported"]:
                passed, completed, feedback = self._execute_dual_axis_move(
                    motor, configs, feedback, self.test_stop, update,
                    acceleration=request.maxMoveAccelerationDegS2,
                    follow_error_limit=request.followErrorLimitDeg)
                return
            for config in configs:
                if self.test_stop.is_set():
                    break
                feedback = motor_snapshot(motor, config.axis)
                require_position_ready(feedback, config)
                if reference_key(feedback) != references:
                    raise RuntimeError("两轴参考位或反馈单位已变化，已取消点位回位")
                update("positioning", axis=config.axis, connected=True, stopConfirmed=False)
                if self.test_stop.is_set():
                    break
                self.motion_guard.mark(config, True, "点位回位停止尚未确认")
                active = config
                progress = PositionProgress(feedback, config)
                if start_motor(motor, config, self.test_stop) is None:
                    break
                settled = 0
                while not self.test_stop.is_set():
                    feedback = motor_snapshot(motor, config.axis)
                    update("positioning")
                    if feedback["alarmCode"] or feedback["limitFlags"] not in (None, 0):
                        raise RuntimeError(f"轴{config.axis}回位检测到驱动器报警或限位异常")
                    progress.check(feedback, config)
                    settled = settled + 1 if position_reached(feedback, config) else 0
                    if settled >= 2:
                        break
                    self.test_stop.wait(0.2)
                stop_active()
                if self.test_stop.is_set():
                    break
                if not position_reached(feedback, config):
                    raise RuntimeError(f"轴{config.axis}停止后角度偏离目标，已取消后续运动")
                completed.append(config.axis)
                update("positioning")
            if len(completed) == 2 and not self.test_stop.is_set():
                # The first axis must still be at its target after the second settles.
                for config in configs:
                    feedback = motor_snapshot(motor, config.axis)
                    require_position_ready(feedback, config)
                    if reference_key(feedback) != references or not position_reached(feedback, config):
                        raise RuntimeError("两轴最终角度或参考位核查失败，未确认到达记录点")
                passed = True
        except Exception as exc:
            errors.append(str(exc))
        finally:
            if active is not None:
                try:
                    stop_active()
                except Exception as exc:
                    errors.append(f"点位回位停止未确认：{exc}")
                    self.motion_guard.warning = errors[-1] + "；请现场核查"
            if motor:
                try:
                    motor.close(stop=False)
                except Exception as exc:
                    errors.append(f"关闭转盘串口失败：{exc}")
            cancelled = self.test_stop.is_set()
            with self.lock:
                success = passed and not errors and not cancelled
                self.turntable_snapshot.update(state="unknown" if self.motion_guard.warning else "error" if errors else "stopped",
                                               feedback=feedback, connected=False, error="; ".join(errors) or None)
                self.turntable_snapshot["recall"].update(state="complete" if success else "error" if errors else "cancelled", completedAxes=list(completed))
                self.turntable_test = {"passed": success, "cancelled": cancelled, "config": request.model_dump(),
                                       "testedAt": time.time(), "error": "; ".join(errors) or None}
                self.turntable_busy = False
            self.operation_lock.release()

    def frame(self, window_ms=None) -> dict:
        with self.lock:
            status = self.status()
            rate = status["receiver"]["sampleRate"]
            size = min(250_000, max(1, math.ceil(rate * window_ms / 1000))) if rate and window_ms else DISPLAY_LIMIT
            # Copy only the needed tail, never all 250k buffered samples for a
            # 2048-point display. No numerical work is done under this lock.
            tail = list(islice(reversed(self.rows), max(size, 4096)))
            tail.reverse()
            rows = tail[-size:]
            realtime_rows = tail[-4096:]
            origin = self.writer.manifest.get("sampleOrigin") if self.writer else None
        wave = make_wave(rows, rate, origin, rssi_stride=recording_rssi_stride(status["recording"] or {}))
        wave.update(source=status["receiver"]["source"], simulation=status["receiver"]["simulation"])
        return {**status, "waveform": wave, "realtime": self._cached_realtime(realtime_rows, rate, status)}

    def _cached_realtime(self, rows, rate, status):
        recording_id = status["recording"]["id"] if status["recording"] else None
        key = (recording_id, rows[-1][0] if rows else None)
        # All callers share one bounded calculation. Display can refresh faster
        # while FFT/STFT stays at 4 Hz; its own sample range/time stays explicit.
        with self.realtime_lock:
            now = time.monotonic()
            if self.realtime_cache is not None and self.realtime_cache_key[0] == recording_id:
                if self.realtime_cache_key == key or (self.realtime_cache.get("available") and
                        status["state"] == "acquiring" and now - self.realtime_cache_at < 0.25):
                    return self.realtime_cache
            result = self._realtime_result(rows, rate)
            count = result.get("sampleCount", len(rows))
            selected = rows[-count:] if count else []
            rssi_stride = recording_rssi_stride(status["recording"] or {})
            result.update(source=status["receiver"]["source"], recordingId=recording_id, unit="m/s",
                          computedAt=time.time(),
                          sampleRange={"start": selected[0][0] if selected else 0,
                                       "end": selected[-1][0] + 1 if selected else 0},
                          quality={"overrangeSamples": sum(bool(r[3]) for r in selected),
                                   "missingRssiSamples": sum(r[2] is None and r[0] % rssi_stride == 0 for r in selected),
                                   "lowReturnSamples": sum(r[2] is not None and r[2] < 20 for r in selected),
                                   "lowReturnThresholdPercent": 20})
            self.realtime_cache, self.realtime_cache_key, self.realtime_cache_at = result, key, now
            return result

    @staticmethod
    def _realtime_result(rows, rate):
        values = [row[1] for row in rows]
        start = rows[0][0] if rows else 0
        try:
            from .analysis import realtime_snapshot
            return realtime_snapshot(values, float(rate) if rate else float("nan"), start)
        except ImportError:
            return {"available": False, "sampleRate": rate, "sampleCount": len(values),
                    "windowSamples": 0, "features": {}, "spectrum": {"frequencies": [], "amplitudes": []},
                    "warnings": ["当前采集服务缺少 NumPy 实时分析依赖。"]}

    def realtime(self) -> dict:
        """Return bounded online metrics from a copied tail of the display buffer."""
        with self.lock:
            status = self.status()
            rate = status["receiver"]["sampleRate"]
            rows = list(islice(reversed(self.rows), 4096))
            rows.reverse()
        result = self._cached_realtime(rows, rate, status)
        return {**status, "realtime": result}

    def configure_device(self, request: DeviceRequest):
        if request.action == "laser_read":
            return self.read_laser(request)
        if request.action == "set" and (not request.confirmChange or request.key not in WRITABLE):
            raise HTTPException(422, "请明确确认修改支持的配置项。")
        if request.action in {"autofocus", "laser_on", "laser_off"} and not request.confirmLaser:
            raise HTTPException(422, "激光操作需要明确确认现场光路安全。")
        if not self._acquire_operation():
            raise HTTPException(409, "设备操作进行中，请等待完成。")
        try:
            with self.lock:
                if self.status()["receiver"]["running"]:
                    raise HTTPException(409, "采集期间不可读取控制配置或修改设备，请先停止并保存。")
                if self.observation_laser_ip and request.deviceIp != self.observation_laser_ip:
                    raise HTTPException(409, "请先关闭上一台设备的观察激光，再切换设备。")
                self.device_busy = True
                # A failed/uncertain write must not leave old values marked as verified.
                self.device_snapshot = None
            result = self._device_command(ReceiverConfig(request.deviceIp, "", self.settings.dll_path),
                                          request.action, request.key, request.value, request.expected)
            with self.lock:
                self.device_snapshot = result
                laser = result.get("fields", {}).get("laser", {})
                if request.action == "laser_on":
                    self.observation_laser_ip = request.deviceIp
                elif request.action in {"laser_off", "autofocus"}:
                    self.observation_laser_ip = None
                if result.get("deviceIp") == self.device_warning_ip and laser.get("supported") and laser.get("value") == 0:
                    self.device_warning = None
                    self.device_warning_ip = None
            return result
        except (OSError, RuntimeError, ValueError) as exc:
            if request.action == "laser_on":
                self.observation_laser_ip = request.deviceIp
            if request.action != "read":
                with self.lock:
                    self.device_warning_ip = request.deviceIp
                    self.device_warning = f"设备 {request.deviceIp} 上次修改/聚焦未确认完成。请现场确认激光关闭，然后重新读取该设备配置；确认前禁止开始采集。"
            raise HTTPException(503, f"设备配置操作未确认完成：{exc}。请重新读取配置；异常时须现场确认激光已关闭。") from exc
        finally:
            with self.lock:
                self.device_busy = False
            self.operation_lock.release()

    def calibrate_rssi(self, request: RssiCalibrationRequest) -> dict:
        """Capture a short labelled RSSI sample without creating a vibration record.

        Each labelled sample leaves the laser on so the operator can move the blade
        to the next state. The final explicit laser-off command remains available in
        the device panel.
        """
        with self.operation_lock:
            with self.lock:
                if self.turntable_busy or self.device_busy or self.status()["receiver"]["running"] or self.state in {"starting", "acquiring", "stopping"}:
                    raise HTTPException(409, "设备正在使用，请先停止采集、转盘动作或其它设备操作。")
                self.device_busy = True
            samples: list[float] = []
            sample_rate = None
            started_at = time.time()
            stop = threading.Event()
            error: Exception | None = None
            thread_error: list[Exception] = []
            ready_event = threading.Event()
            receiver = self._device_receiver(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path))
            try:
                receiver.validate()

                def ready(rate, origin):
                    nonlocal sample_rate, started_at
                    sample_rate, started_at = float(rate), float(origin)
                    ready_event.set()

                def receive(batch: Batch):
                    samples.extend(float(value) for value in batch.rssi if math.isfinite(value))

                def run_receiver():
                    try:
                        receiver.run(stop, ready, receive, keep_laser_on=True)
                    except Exception as exc:
                        thread_error.append(exc)

                thread = threading.Thread(target=run_receiver,
                                           name="blade-rssi-calibration", daemon=True)
                thread.start()
                self.capture_thread, self.capture_stop = thread, stop
                startup_deadline = time.monotonic() + DAQ_READY_SECONDS
                while thread.is_alive() and not ready_event.wait(0.02):
                    if time.monotonic() >= startup_deadline:
                        raise TimeoutError("RSSI 标定设备未在 30 秒内就绪。")
                deadline = time.monotonic() + float(request.durationSeconds)
                while time.monotonic() < deadline and thread.is_alive():
                    time.sleep(0.02)
                stop.set()
                thread.join(15)
                if thread.is_alive():
                    raise TimeoutError("RSSI 标定采集线程未在 15 秒内退出。")
                if thread_error:
                    raise thread_error[0]
                if not samples:
                    raise RuntimeError("未收到有效 RSSI 样本，请检查设备、网卡和光路。")
                self.observation_laser_ip = request.deviceIp
            except Exception as exc:
                error = exc
            finally:
                stop.set()
                with self.lock:
                    self.device_busy = bool(self.capture_thread and self.capture_thread.is_alive())
                    if not self.device_busy:
                        self.capture_thread, self.capture_stop = None, None
            if error:
                # An uncertain calibration must not leave the laser state ambiguous.
                try:
                    if self.device_busy:
                        raise RuntimeError("采集线程仍占用设备，激光状态未确认，请现场关闭激光。")
                    self._device_command(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path), "laser_off")
                    self.observation_laser_ip = None
                except Exception as cleanup_error:
                    error = RuntimeError(f"{error}；并且关闭激光失败：{cleanup_error}")
                raise HTTPException(503, str(error)) from error
            if not samples:
                raise HTTPException(503, "未收到有效 RSSI 样本，请检查设备、网卡和光路。")
            ordered = sorted(samples)
            def percentile(fraction: float) -> float:
                index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))
                return ordered[index]
            stride = max(1, math.ceil(len(samples) / 2000))
            result = {"state": request.state, "label": {"background": "无叶片 / 背景", "blade_on": "叶片停在光斑上", "blade_pass": "手动拨过叶片"}[request.state],
                      "recordedAt": time.time(), "startedAt": started_at, "durationSeconds": float(request.durationSeconds),
                      "sampleRate": sample_rate, "sampleCount": len(samples), "minimum": ordered[0],
                      "p10": percentile(0.10), "median": percentile(0.50), "mean": sum(samples) / len(samples),
                      "p90": percentile(0.90), "maximum": ordered[-1], "samples": samples[::stride]}
            with self.rssi_calibration_lock:
                try:
                    existing = json.loads(self.rssi_calibration_path.read_text("utf-8")) if self.rssi_calibration_path.exists() else {"version": 1, "states": {}}
                    if not isinstance(existing, dict) or not isinstance(existing.get("states", {}), dict):
                        existing = {"version": 1, "states": {}}
                    existing["states"][request.state] = result
                    existing["updatedAt"] = result["recordedAt"]
                    self.rssi_calibration_path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = self.rssi_calibration_path.with_suffix(".tmp")
                    temporary.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + "\n", "utf-8")
                    temporary.replace(self.rssi_calibration_path)
                except (OSError, ValueError, TypeError) as exc:
                    raise HTTPException(507, f"RSSI 标定已采集但保存失败：{exc}") from exc
            return {**result, "states": existing["states"]}

    def start(self, request: StartRequest) -> dict:
        with self.lock:
            if self.turntable_busy:
                raise HTTPException(409, "转盘检查/试转仍在进行，请先确认停稳并完成设置")
            if request.turntable and request.turntable.protocol != "position":
                raise HTTPException(409, "联合采集只支持定位停稳后记录；请在转盘点位配置定位路线，不支持连续转动期间采集")
        with self.operation_lock:
            with self.lock:
                if self.device_warning and request.source == "polytec_ivs500":
                    raise HTTPException(409, self.device_warning)
                if self.observation_laser_ip and (request.source != "polytec_ivs500" or request.deviceIp != self.observation_laser_ip):
                    raise HTTPException(409, "请先关闭观察激光，再切换设备或模拟采集。")
                if (request.turntable or request.pointCycle) and self.motion_guard.warning:
                    raise HTTPException(409, self.motion_guard.warning)
                if request.turntable:
                    preparation = self.turntable_preparation
                    if not preparation or not preparation.get("ready") or preparation["config"] != request.turntable.model_dump():
                        raise HTTPException(409, "请先完成当前参数的转盘试转、停稳检查和设置确认")
                if self.status()["receiver"]["running"]:
                    raise HTTPException(409, "已有采集运行或正在收尾，请先停止。")
                if request.pointCycle:
                    return self._start_point_cycle_locked(request)
                try:
                    receiver = (SimulationReceiver(request.simulation) if request.source == "simulation" else
                                self._device_receiver(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path)))
                    receiver.validate()
                except (OSError, RuntimeError, ValueError) as exc:
                    self.state, self.error = "error", str(exc)
                    raise HTTPException(503, str(exc)) from exc
                metadata = request.model_dump(exclude={"confirmLaser", "confirmMotion", "simulation", "turntable"})
                if request.turntable:
                    metadata["turntable"] = {"config": request.turntable.model_dump(), "state": "checking",
                                             "synchronization": "host_observation_only",
                                             "preparedReferences": copy.deepcopy(preparation.get("references"))}
                simulation = receiver.provenance() if request.source == "simulation" else None
                metadata["simulation"] = simulation
                if simulation:
                    metadata.update(deviceIp="", hostIp="", point=request.point or request.simulation.point)
                try:
                    self.writer = self.store.create(metadata)
                except OSError as exc:
                    self.state, self.error = "error", f"无法创建本地采集记录：{exc}"
                    raise HTTPException(507, self.error) from exc
                self.device_ip, self.host_ip = metadata["deviceIp"], metadata["hostIp"]
                self.source, self.simulation = request.source, simulation
                self.rows.clear()
                self.stop_event.clear()
                self.state, self.error = "starting", None
                self.turntable_preparation = None
                self.turntable_snapshot = {"state": "checking" if request.turntable else "disconnected", "feedback": None}
                self.thread = threading.Thread(target=self._run, args=(receiver, request.turntable, request), name=f"blade-{request.source}", daemon=True)
                self.thread.start()
                return self.status()

    def _start_point_cycle_locked(self, request: StartRequest) -> dict:
        """Start a server-owned multi-point capture while operation_lock is held."""
        cycle = request.pointCycle
        if cycle is None:
            raise HTTPException(422, "缺少多点循环参数")
        if self.device_warning:
            raise HTTPException(409, self.device_warning)
        try:
            receiver = self._device_receiver(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path))
            receiver.validate()
        except (OSError, RuntimeError, ValueError) as exc:
            self.state, self.error = "error", str(exc)
            raise HTTPException(503, str(exc)) from exc
        self.device_ip, self.host_ip = request.deviceIp, request.hostIp
        self.source, self.simulation = request.source, None
        self.writer = None
        self.rows.clear()
        self.stop_event.clear()
        self.state, self.error = "starting", None
        self.point_cycle = {"state": "checking", "port": cycle.port, "cycles": cycle.cycles,
                            **({"collectionId": cycle.collectionId} if cycle.collectionId else {}),
                            "sessionId": uuid.uuid4().hex, "mode": cycle.mode,
                            "laserPolicy": "continuous_during_session",
                            "returnToOrigin": cycle.returnToOrigin.model_dump() if cycle.returnToOrigin else None,
                            "geometry": cycle.geometry.model_dump() if cycle.geometry else None,
                            **({"firstStationMode": "hold_current_pose"} if cycle.startAtCurrentPose else {}),
                            "sessionState": "running",
                            "plannedStations": self._cycle_station_plan(cycle),
                            "identitySource": "operator_assigned", "identityVerified": False,
                            "coverageKind": "sparse_station_passes",
                            "nominalPeriodSeconds": cycle.nominalPeriodSeconds,
                            "dwellSeconds": cycle.dwellSeconds, "speedRpm": cycle.speedRpm,
                            "rssiTriggerEnabled": cycle.rssiTriggerEnabled,
                            "rssiLeaveThresholdPercent": cycle.rssiLeaveThresholdPercent,
                            "rssiThresholdMode": cycle.rssiThresholdMode,
                            "rssiBaselineRatio": cycle.rssiBaselineRatio,
                            "rssiConfirmMs": cycle.rssiConfirmMs,
                            "rssiMinimumSeconds": cycle.rssiMinimumSeconds,
                            "rssiEnterSpread": cycle.rssiEnterSpread, "rssiExitSpread": cycle.rssiExitSpread,
                            "rssiEnterConfirmMs": cycle.rssiEnterConfirmMs,
                            "processPhase": "checking", "processEvents": [], "processSequence": 0,
                            "latestRssi": None, "rssiSamples": 0, "rssiBelowSamples": 0,
                            "pointCount": len(cycle.points), "cycle": 0, "point": 0,
                            "completedRecords": 0, "totalRecords": len(cycle.points) * cycle.cycles,
                            "currentPoint": None, "error": None}
        self.turntable_snapshot = {"state": "checking", "port": cycle.port, "axis": 1,
                                   "feedback": None, "pointCycle": copy.deepcopy(self.point_cycle)}
        self.thread = threading.Thread(target=self._run_point_cycle, args=(request, receiver),
                                        name="blade-point-cycle", daemon=True)
        self.thread.start()
        return self.status()

    def _ready(self, rate: float, origin: float, receiver=None) -> None:
        with self.lock:
            if receiver is not None:
                if self.source == "polytec_ivs500":
                    self.observation_laser_ip = None
                self.writer.manifest["deviceSettings"] = getattr(receiver, "device_settings", None)
                self.writer.manifest["velocityRangeMps"] = getattr(receiver, "velocity_range_mps", None)
                acquisition = getattr(receiver, "acquisition_metadata", None)
                if acquisition is not None:
                    self.writer.manifest["acquisition"] = acquisition
                    self.writer.manifest.update(rssiSampleStride=acquisition["rssiSampleStride"],
                                                rssiSampleRate=acquisition["rssiSampleRate"])
            self.writer.ready(rate, origin)
            if not self.stop_event.is_set():
                self.state = "acquiring"

    def _receive(self, batch: Batch) -> None:
        with self.lock:
            self.writer.write(batch)
            # This is a display window, never the source for raw persistence.
            offset = max(0, len(batch.values) - self.rows.maxlen)
            self.rows.extend((batch.sample_start + index, batch.values[index],
                              batch.rssi_at(index),
                              batch.overrange[index]) for index in range(offset, len(batch.values)))
            cycle = self.point_cycle
            if cycle and self.rssi_handoff is not None:
                cycle.update(self.rssi_handoff.feed(batch))
                for transition in self.rssi_handoff.drain_events():
                    self._cycle_process(**transition)
                if self.rssi_handoff.trigger is not None:
                    if not self.rssi_event.is_set():
                        self.rssi_handoff.trigger["detectedAt"] = time.time()
                    self.rssi_event.set()
            elif cycle and cycle.get("state") in ("capturing", "holding"):
                valid_rssi = [float(value) for value in batch.rssi
                              if isinstance(value, (int, float)) and math.isfinite(value)]
                if valid_rssi:
                    cycle["latestRssi"] = valid_rssi[-1]
                    cycle["rssiSamples"] = int(cycle.get("rssiSamples", 0)) + len(valid_rssi)

    def _run_joint(self, receiver, config, request):
        """Legacy finite positioning: laser ON -> stopped arrival -> DAQ."""
        ready, capture_done, capture_stop = threading.Event(), threading.Event(), threading.Event()
        capture_errors, failures = [], []
        motor, telemetry, capture = None, None, None
        attempted = False
        arrived = False

        def event(kind, **data):
            with self.lock:
                samples = self.writer.manifest["samples"]
            telemetry.write(kind, {"receivedSamples": samples, **data})

        def update(state, feedback=None, **extra):
            with self.lock:
                self.turntable_snapshot.update(state=state, port=config.port, axis=config.axis, **extra)
                if feedback is not None:
                    self.turntable_snapshot["feedback"] = feedback
                self.writer.manifest["turntable"].update(self.turntable_snapshot)

        def receive_loop():
            try:
                def on_ready(rate, origin):
                    self._ready(rate, origin, receiver)
                    ready.set()
                run_kwargs = ({"keep_laser_on": True, "abort": self.stop_event}
                              if getattr(receiver, "supports_laser_persistence", False) else {})
                receiver.run(capture_stop, on_ready, self._receive, **run_kwargs)
            except Exception as exc:
                capture_errors.append(str(exc))
            finally:
                capture_done.set()

        try:
            if config.protocol != "position":
                raise RuntimeError("联合采集只支持定位停稳后记录；请在转盘点位配置定位路线")
            telemetry = TelemetryWriter(self.writer.directory)
            event("configured", config=config.model_dump())
            motor = self.motor_factory(config.port, timeout=2.0, gear_ratio=50.0)
            motor.connect()
            feedback = motor_snapshot(motor, config.axis)
            update("checked", feedback, connected=True)
            event("preflight", feedback=feedback)
            require_position_ready(feedback, config)
            references = self.writer.manifest["turntable"]["preparedReferences"]
            if reference_key(feedback) != references:
                raise RuntimeError("参考位或反馈计数单位已变化，请重新确认定位设置")
            if self.stop_event.is_set():
                return
            laser_on = self._confirm_motion_laser_on(request)
            event("laser_on_confirmed", **laser_on)
            feedback = motor_snapshot(motor, config.axis)
            require_position_ready(feedback, config)
            if reference_key(feedback) != references:
                raise RuntimeError("运动前参考位或计数单位变化，请重新确认定位设置")
            event("before_motion", feedback=feedback)
            progress = PositionProgress(feedback, config)
            if not position_reached(feedback, config):
                self.motion_guard.mark(config, True)
                attempted = True
                update("starting")
                effective = start_motor(motor, config, self.stop_event, prechecked_position=True)
                if effective is None:
                    return
                update("positioning", effectiveRpm=effective, commandAcceptedAt=time.time())
                event("accepted", effectiveRpm=effective)
            settled = 0
            while not self.stop_event.is_set():
                feedback = motor_snapshot(motor, config.axis)
                progress.check(feedback, config)
                settled = settled + 1 if position_reached(feedback, config) else 0
                update("positioning", feedback)
                event("status", feedback=feedback)
                if settled >= 2:
                    break
                self.stop_event.wait(.05)
            if self.stop_event.is_set():
                return
            require_ready(feedback)
            arrived = True
            self.motion_guard.mark(config, False)
            update("holding", feedback, stopConfirmed=True)
            event("position_reached", feedback=feedback, targetAngleDeg=config.targetAngleDeg)
            if self.stop_event.is_set():
                return
            capture = threading.Thread(target=receive_loop, name="blade-joint-receiver", daemon=True)
            self.capture_thread, self.capture_stop = capture, capture_stop
            capture.start()
            deadline = time.monotonic() + DAQ_READY_SECONDS
            while not ready.wait(.05):
                if self.stop_event.is_set():
                    return
                if capture_done.is_set():
                    raise RuntimeError("; ".join(capture_errors) or "采集未就绪即退出")
                if time.monotonic() > deadline:
                    raise RuntimeError("测振仪未在 30 秒内就绪")
            started = time.monotonic()
            while not self.stop_event.is_set():
                if capture_done.is_set():
                    raise RuntimeError("; ".join(capture_errors) or "采集意外退出")
                feedback = motor_snapshot(motor, config.axis)
                require_position_ready(feedback, config)
                if reference_key(feedback) != references or not position_reached(feedback, config):
                    raise RuntimeError("到位后角度偏移、参考位变化或再次运动，联合任务已停止")
                update("holding", feedback)
                event("status", feedback=feedback)
                if config.durationSeconds and time.monotonic() - started >= config.durationSeconds:
                    event("duration_elapsed")
                    break
                self.stop_event.wait(.2)
        except Exception as exc:
            failures.append(str(exc))
        finally:
            # A failed positioning move must be stopped immediately; do not
            # postpone an emergency stop behind SDK or receiver cleanup.
            if attempted and not arrived:
                try:
                    motor.stop(config.axis)
                    feedback = motor_snapshot(motor, config.axis)
                    require_stop_confirmed(feedback, config)
                    self.motion_guard.mark(config, False)
                    update("stopped", feedback, stopConfirmed=True)
                    event("stopped", feedback=feedback)
                    attempted = False
                except Exception as exc:
                    failures.append(f"转盘停止未确认：{exc}")
                    self.motion_guard.warning = failures[-1] + "；请现场核查"
            capture_stop.set()
            if capture:
                capture.join(20)
                if capture.is_alive():
                    failures.append("采集线程未退出，不能确认激光已关闭或数据完成")
            failures.extend(capture_errors)
            try:
                self._confirm_motion_laser_off(request)
            except Exception as exc:
                failures.append(f"采集结束关闭激光失败：{exc}")
            if attempted:
                try:
                    motor.stop(config.axis)
                    feedback = motor_snapshot(motor, config.axis)
                    require_stop_confirmed(feedback, config)
                    self.motion_guard.mark(config, False)
                    update("stopped", feedback, stoppedAt=time.time(), stopConfirmed=True)
                    event("stopped", feedback=feedback)
                except Exception as exc:
                    failures.append(f"转盘停止未确认：{exc}")
                    self.motion_guard.warning = failures[-1] + "；请现场核查后读取并确认恢复"
                    update("unknown", stopConfirmed=False, error=failures[-1])
            if motor:
                try:
                    motor.close(stop=False)
                except Exception as exc:
                    failures.append(f"关闭转盘串口失败：{exc}")
            if telemetry:
                try:
                    event("finished", errors=failures)
                    details = telemetry.finish()
                    with self.lock:
                        self.writer.manifest["turntable"]["telemetry"] = details
                except Exception as exc:
                    failures.append(f"转盘遥测持久化失败：{exc}")
            update(self.turntable_snapshot["state"] if attempted else ("error" if failures else "checked"),
                   connected=False, error="; ".join(failures) or None)
            if failures:
                raise RuntimeError("; ".join(failures))

    def _cycle_process(self, phase, **details):
        """Keep brief DAQ transitions visible across slower UI status polls."""
        with self.lock:
            cycle = self.point_cycle
            if cycle is None:
                return
            sequence = cycle.get("processSequence", 0) + 1
            event = {"sequence": sequence, "phase": phase, "at": time.time(),
                     "cycle": cycle.get("cycle", 0), "point": cycle.get("currentPoint"), **details}
            cycle.update(processPhase=phase, processSequence=sequence)
            cycle.setdefault("processEvents", []).append(event)
            del cycle["processEvents"][:-120]
            if self.writer and self.writer.manifest.get("status") == "incomplete":
                record_cycle = self.writer.manifest.get("pointCycle")
                if record_cycle is not None:
                    record_cycle.setdefault("processEvents", []).append(copy.deepcopy(event))
                    del record_cycle["processEvents"][:-120]

    def _cycle_update(self, state, **extra):
        with self.lock:
            if self.point_cycle is not None:
                self.point_cycle.update(state=state, **extra)
            self.turntable_snapshot.update(state=state, **extra)
            if (self.writer and self.writer.manifest.get("status") == "incomplete" and
                    self.writer.manifest.get("turntable")):
                self.writer.manifest["turntable"].update(self.turntable_snapshot)

    @staticmethod
    def _cycle_point_reference(point: PointCyclePoint):
        return json.loads(point.referenceSignature)

    @staticmethod
    def _cycle_station_plan(cycle):
        groups, indices = {}, {}
        for point in cycle.points:
            group = (point.bladeId, point.radialPointId)
            groups[group] = groups.get(group, 0) + 1
        plan = []
        for ordinal, point in enumerate(cycle.points, 1):
            group = (point.bladeId, point.radialPointId)
            indices[group] = indices.get(group, 0) + 1
            plan.append({"pointId": point.pointId or f"station-{ordinal}",
                         "name": point.name, "bladeId": point.bladeId,
                         "axis1AngleDeg": point.axis1AngleDeg, "axis2AngleDeg": point.axis2AngleDeg,
                         "radialPointId": point.radialPointId, "radialPointName": point.radialPointName,
                         "radiusM": point.radiusM, "azimuthDeg": point.azimuthDeg,
                         **({"rootRadiusM": point.rootRadiusM} if point.rootRadiusM is not None else {}),
                         **({"bladeLengthM": point.bladeLengthM} if point.bladeLengthM is not None else {}),
                         **({"distanceFromRootM": point.radiusM - point.rootRadiusM}
                            if point.radiusM is not None and point.rootRadiusM is not None else {}),
                         "stationIndex": indices[group], "stationCount": groups[group]})
        return plan

    def _confirm_session_laser(self, request, enabled):
        action, label = ("laser_on", "开启") if enabled else ("laser_off", "关闭")
        target = int(enabled)
        if self.capture_thread and self.capture_thread.is_alive():
            self._unknown_laser(request.deviceIp, "采集接收线程尚未关闭，禁止并发操作激光")
            with self.lock:
                self.stop_event.set()
                self.observation_laser_ip = request.deviceIp
                self.device_warning_ip = request.deviceIp
                self.device_warning = "采集接收线程尚未关闭，激光状态未知；请现场核查。"
            suffix = "未启动转盘" if enabled else "关闭状态未知，请现场核查"
            raise RuntimeError(f"采集接收线程尚未关闭，不能确认激光状态；{suffix}")
        self._cycle_process(action)
        try:
            result = self._device_command(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path),
                                          action, laser_only=True)
            laser = result.get("fields", {}).get("laser", {})
            if laser.get("supported") is not True or type(laser.get("value")) is not int or laser["value"] != target:
                raise RuntimeError(f"激光{label}未获得真实读回")
        except (OSError, RuntimeError, ValueError) as exc:
            self._unknown_laser(request.deviceIp, str(exc))
            with self.lock:
                self.observation_laser_ip = request.deviceIp
                self.device_warning_ip = request.deviceIp
                self.device_warning = f"设备 {request.deviceIp} 激光{label}未确认，请现场核查后重新读取。"
            suffix = "未启动转盘" if enabled else "请现场核查"
            raise RuntimeError(f"激光{label}未确认，{suffix}：{exc}") from exc
        with self.lock:
            self.observation_laser_ip = request.deviceIp if enabled else None
            if not enabled and self.device_warning_ip == request.deviceIp:
                self.device_warning = self.device_warning_ip = None
        evidence = {"deviceIp": request.deviceIp, "state": "on" if enabled else "off", "readAt": result.get("readAt"),
                    "confirmedAt": time.time(), "source": "device-readback"}
        self._cycle_process(f"{action}_confirmed", **evidence)
        return evidence

    def _confirm_motion_laser_off(self, request):
        return self._confirm_session_laser(request, False)

    def _confirm_motion_laser_on(self, request):
        return self._confirm_session_laser(request, True)

    def _cycle_position_laser_on(self, request, motor, cycle, point, **kwargs):
        if self.stop_event.is_set():
            raise RuntimeError("循环采集已停止")
        self._cycle_update("positioning", targetPointId=point.pointId, currentPoint=point.name,
                           targetAxis1AngleDeg=point.axis1AngleDeg, targetAxis2AngleDeg=point.axis2AngleDeg)
        laser_on = self._confirm_motion_laser_on(request)
        if self.stop_event.is_set():
            raise RuntimeError("循环采集已停止")
        result = self._cycle_move_point(motor, cycle, point, **kwargs)
        with self.lock:
            evidence = copy.deepcopy(self.point_cycle.get("lastMove") or {})
            evidence["laserOnBeforeMotion"] = laser_on
            self._cycle_update(self.point_cycle.get("state", "holding"), lastMove=evidence)
        return result

    @staticmethod
    def _point_travel_cost(current_angles: tuple[float, float], point: PointCyclePoint) -> float:
        """Return the valid mechanical travel to a point.

        Both axes are bounded output coordinates.  Axis 2 is deliberately
        treated as a linear -180..180 range: wrapping from +170 to -170 would
        cross the cable-protection boundary and is not a valid shortcut.
        """
        axis1, axis2 = current_angles
        return abs(point.axis1AngleDeg - axis1) + abs(point.axis2AngleDeg - axis2)

    def _plan_point_order(self, feedback, points: list[PointCyclePoint],
                          anchor: PointCyclePoint | None = None) -> list[PointCyclePoint]:
        """Choose a short, safe route, optionally closed at an anchor point.

        A point cycle is anchored at its first configured point (normally m01).
        The route starts at that point and includes the return leg in its cost,
        so the turntable is back at the anchor after the last measurement.
        Standalone callers retain the open-route behavior when no anchor is
        supplied.
        """
        if len(points) < 2:
            return list(points)
        axes = feedback["axes"]
        current = (axes["1"]["output_angle_deg"], axes["2"]["output_angle_deg"])
        if current[0] is None or current[1] is None:
            if anchor is None:
                return list(points)
            anchor_index = next((index for index, point in enumerate(points)
                                 if point is anchor or point.pointId == anchor.pointId), 0)
            return [points[anchor_index], *points[:anchor_index], *points[anchor_index + 1:]]
        if anchor is not None:
            anchor_index = next((index for index, point in enumerate(points)
                                 if point is anchor or point.pointId == anchor.pointId), 0)
            anchor_point = points[anchor_index]
            remaining = [(index, point) for index, point in enumerate(points)
                         if index != anchor_index]
            if len(points) <= 8:
                best = None
                for permutation in itertools.permutations(remaining):
                    pose = current
                    cost = self._point_travel_cost(pose, anchor_point)
                    pose = (anchor_point.axis1AngleDeg, anchor_point.axis2AngleDeg)
                    for _, point in permutation:
                        cost += self._point_travel_cost(pose, point)
                        pose = (point.axis1AngleDeg, point.axis2AngleDeg)
                    cost += self._point_travel_cost(pose, anchor_point)
                    key = (cost, tuple(index for index, _ in permutation))
                    if best is None or key < best[0]:
                        best = (key, [anchor_point, *[point for _, point in permutation]])
                return best[1]
            planned = [anchor_point]
            pose = (anchor_point.axis1AngleDeg, anchor_point.axis2AngleDeg)
            while remaining:
                index, point = min(remaining, key=lambda item: (
                    self._point_travel_cost(pose, item[1]), item[0]))
                planned.append(point)
                pose = (point.axis1AngleDeg, point.axis2AngleDeg)
                remaining = [(item_index, item) for item_index, item in remaining
                             if item_index != index]
            return planned
        if len(points) <= 8:
            best = None
            for permutation in itertools.permutations(enumerate(points)):
                pose = current
                cost = 0.0
                for _, point in permutation:
                    cost += self._point_travel_cost(pose, point)
                    pose = (point.axis1AngleDeg, point.axis2AngleDeg)
                key = (cost, tuple(index for index, _ in permutation))
                if best is None or key < best[0]:
                    best = (key, [point for _, point in permutation])
            return best[1]
        remaining = list(enumerate(points))
        planned = []
        while remaining:
            index, point = min(remaining, key=lambda item: (
                self._point_travel_cost(current, item[1]), item[0]))
            planned.append(point)
            current = (point.axis1AngleDeg, point.axis2AngleDeg)
            remaining = [(item_index, item) for item_index, item in remaining if item_index != index]
        return planned

    def _cycle_verify_initial_pose(self, motor, cycle: PointCycleConfig, point: PointCyclePoint, phase: str):
        """Fresh read-only acceptance of a calibrated first station, never a move.

        The requested point remains authoritative. A new read cannot redefine
        P1 or repair a changed aim by issuing another positioning command.
        """
        if self.stop_event.is_set():
            raise RuntimeError("循环采集已停止")
        feedback = motor_snapshot(motor, 1)
        require_ready(feedback)
        references = reference_key(feedback)
        actual = [[references[str(axis)][key] for key in
                   ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")]
                  for axis in (1, 2)]
        if actual != self._cycle_point_reference(point):
            raise RuntimeError("首个点位参考位或反馈计数单位已变化，请重新手动瞄准并校准")
        configs = [TurntableConfig(port=cycle.port, axis=axis, protocol="position",
                                   targetAngleDeg=angle, speedRpm=cycle.speedRpm)
                   for axis, angle in ((1, point.axis1AngleDeg), (2, point.axis2AngleDeg))]
        for config in configs:
            require_position_ready(feedback, config)
        capability = self._motion_capability(motor)
        if capability["supported"]:
            status = motor.get_trajectory_status()
            if status.state not in (0, 6, 8) or status.fault not in (0, 1):
                raise RuntimeError("控制器轨迹仍待执行、运行或存在故障，不能在首个点位原地开始采集")
        if not all(position_reached(feedback, config) for config in configs):
            raise RuntimeError("首个点位瞄准位置已变化，请重新手动瞄准并校准")
        observed = {str(axis): feedback["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2)}
        previous = (self.point_cycle or {}).get("lastMove") or {}
        checks = list(previous.get("poseChecks", [])) if previous.get("motionCommanded") is False else []
        checks.append({"phase": phase, "observedAt": feedback["observedAt"],
                       "actualAngles": observed, "referenceSignature": point.referenceSignature})
        evidence = {"mode": capability["mode"], "state": "initial_pose_verified",
                    "plannedSeconds": 0, "actualSeconds": 0, "speedLimitRpm": 0,
                    "targets": [point.axis1AngleDeg, point.axis2AngleDeg],
                    "timingBasis": "read_only_initial_pose_check", "motionCommanded": False,
                    "measurementDuringMotion": False, "poseChecks": checks}
        self._cycle_update("holding", currentPoint=point.name, feedback=feedback, lastMove=evidence,
                           firstStationMode="hold_current_pose")
        return feedback

    def _cycle_capture_pose(self, motor, cycle, point, *, check_trajectory=True):
        feedback = motor_snapshot(motor, 1)
        require_ready(feedback)
        references = reference_key(feedback)
        actual = [[references[str(axis)][key] for key in
                   ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")]
                  for axis in (1, 2)]
        if actual != self._cycle_point_reference(point):
            raise RuntimeError("采集点位参考位或反馈计数单位已变化，请重新手动瞄准并校准")
        for axis, angle in ((1, point.axis1AngleDeg), (2, point.axis2AngleDeg)):
            config = TurntableConfig(port=cycle.port, axis=axis, protocol="position",
                                     targetAngleDeg=angle, speedRpm=cycle.speedRpm)
            require_position_ready(feedback, config)
            if not position_reached(feedback, config):
                raise RuntimeError("采集点位角度已变化或尚未到位，未开启下一个点位采集")
        if check_trajectory and self._motion_capability(motor)["supported"]:
            status = motor.get_trajectory_status()
            if status.state not in (0, 6, 8) or status.fault not in (0, 1):
                raise RuntimeError("转盘轨迹未停稳或存在故障，未开启下一个点位采集")
        self._cycle_update("holding", feedback=feedback, currentPoint=point.name)
        return feedback

    def _cycle_move_point(self, motor, cycle: PointCycleConfig, point: PointCyclePoint, on_command=None,
                          source_point: PointCyclePoint | None = None):
        """Use the verified firmware path and confirm stopped arrival before capture."""
        configs = [TurntableConfig(port=cycle.port, axis=axis, protocol="position",
                                   targetAngleDeg=angle, speedRpm=cycle.speedRpm)
                   for axis, angle in ((1, point.axis1AngleDeg), (2, point.axis2AngleDeg))]
        completed, active = [], None
        feedback = None
        try:
            initial_snapshots = (joint_snapshots(motor)
                                 if getattr(motor, "trajectory_start_observer", False) is True
                                 else (motor_snapshot(motor, 1),) * 2)
            feedback = initial_snapshots[0]
            require_ready(feedback)
            references = reference_key(feedback)
            expected = self._cycle_point_reference(point)
            actual = [[references[str(axis)][key] for key in
                       ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")]
                      for axis in (1, 2)]
            if expected is not None and actual != expected:
                raise RuntimeError(f"点位 {point.name} 记录后参考位或反馈计数单位已变化")
            # Both targets must be legal before either axis receives a command.
            for config, checked in zip(configs, initial_snapshots):
                require_position_ready(checked, config)
            capability = self._motion_capability(motor)
            start_angles = tuple(feedback["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2))
            speed, timing = station_timing_plan(cycle, start_angles, point, capability["mode"], source_point)
            configs = [config.model_copy(update={"speedRpm": speed}) for config in configs]
            self._cycle_update("positioning", motionCapability=capability, motionMode=capability["mode"], feedback=feedback,
                               targetPointId=point.pointId, targetAxis1AngleDeg=point.axis1AngleDeg,
                               targetAxis2AngleDeg=point.axis2AngleDeg)
            if capability["supported"]:
                def dual_update(state, **extra):
                    if timing is not None and "lastMove" in extra:
                        extra["lastMove"] = {**extra["lastMove"], "stationTiming": timing}
                    self._cycle_update(state, currentPoint=point.name, **extra)
                return self._execute_dual_axis_move(motor, configs, feedback, self.stop_event,
                                                   dual_update, on_command,
                                                   acceleration=cycle.maxMoveAccelerationDegS2,
                                                   follow_error_limit=cycle.followErrorLimitDeg)
            planned = sum(abs(config.targetAngleDeg - feedback["axes"][str(config.axis)]["output_angle_deg"])
                          for config in configs) / (6 * speed)
            evidence = {"mode": "sequential", "plannedSeconds": planned, "speedLimitRpm": speed,
                        "targets": [config.targetAngleDeg for config in configs],
                        "timingBasis": "distance_speed_estimate", "measurementDuringMotion": False}
            if timing is not None:
                evidence["stationTiming"] = timing
            started_at = time.monotonic()
            self._cycle_update("positioning", lastMove=evidence)
            for config in configs:
                if self.stop_event.is_set():
                    return False, completed, feedback
                # Selected-axis snapshot is also essential for axis-2 progress/deadline.
                feedback = motor_snapshot(motor, config.axis)
                require_position_ready(feedback, config)
                if reference_key(feedback) != references:
                    raise RuntimeError("两轴参考位或反馈计数单位已变化，已取消循环")
                self._cycle_update("positioning", axis=config.axis, feedback=feedback,
                                   targetAngleDeg=config.targetAngleDeg, currentPoint=point.name)
                if position_reached(feedback, config):
                    completed.append(config.axis)
                    continue
                progress = PositionProgress(feedback, config)
                self.motion_guard.mark(config, True, "循环点位运动停止尚未确认")
                active = config  # Lost command replies still require an explicit stop check.
                if on_command is not None:
                    on_command()
                accepted = start_motor(motor, config, self.stop_event, prechecked_position=True)
                if accepted is None and not self.stop_event.is_set():
                    raise RuntimeError(f"轴{config.axis}定位指令未被接受")
                while not self.stop_event.is_set():
                    feedback = motor_snapshot(motor, config.axis)
                    progress.check(feedback, config)
                    self._cycle_update("positioning", axis=config.axis, feedback=feedback,
                                       positionAngleDeg=feedback["outputAngleDeg"], currentPoint=point.name)
                    if position_reached(feedback, config):
                        require_ready(feedback)
                        break
                    self.stop_event.wait(0.05)
                if self.stop_event.is_set():
                    motor.stop(config.axis)
                    feedback = motor_snapshot(motor, config.axis)
                    require_stop_confirmed(feedback, config)
                    self.motion_guard.mark(config, False)
                    active = None
                    return False, completed, feedback
                self.motion_guard.mark(config, False)
                active = None
                completed.append(config.axis)
            # A fresh pair snapshot ensures axis 1 stayed at its target while axis 2 moved.
            feedback = motor_snapshot(motor, 1)
            require_ready(feedback)
            if reference_key(feedback) != references or not all(position_reached(feedback, c) for c in configs):
                raise RuntimeError("两轴最终到位或参考位确认失败")
            evidence.update(actualSeconds=time.monotonic() - started_at, state="complete")
            self._cycle_update("holding", currentPoint=point.name, feedback=feedback, lastMove=evidence)
            return not self.stop_event.is_set(), completed, feedback
        except Exception:
            if active is not None:
                try:
                    motor.stop(active.axis)
                    feedback = motor_snapshot(motor, active.axis)
                    require_stop_confirmed(feedback, active)
                    self.motion_guard.mark(active, False)
                except Exception as stop_error:
                    self.motion_guard.warning = f"循环点位轴{active.axis}停止未确认：{stop_error}；请现场核查"
            raise

    def _capture_cycle_point(self, request: StartRequest, cycle: PointCycleConfig,
                             point: PointCyclePoint, cycle_index: int, point_index: int,
                             receiver, actual_angles: dict[str, float | None] | None = None,
                             next_point: PointCyclePoint | None = None, on_handoff=None,
                             keep_laser_on: bool = True, before_capture=None, feedback_poll=None):
        metadata = request.model_dump(exclude={"confirmLaser", "confirmMotion", "simulation", "turntable", "pointCycle"})
        metadata["point"] = point.name
        metadata["pointCycle"] = {"cycle": cycle_index, "pointIndex": point_index,
                                   **({"pointId": point.pointId} if point.pointId is not None else {}),
                                   "recordedPort": point.port, "referenceSignature": point.referenceSignature,
                                   "pointName": point.name, "cycles": cycle.cycles,
                                   "dwellSeconds": cycle.dwellSeconds,
                                   "targetAxis1AngleDeg": point.axis1AngleDeg,
                                   "targetAxis2AngleDeg": point.axis2AngleDeg,
                                   **({"actualAngles": actual_angles} if actual_angles is not None else {})}
        plan = copy.deepcopy(self.point_cycle["plannedStations"])
        station = next(item for item in plan if item["pointId"] == point.pointId) if point.pointId else next(
            item for item in plan if item["name"] == point.name)
        metadata["pointCycle"].update(
            **({"collectionId": cycle.collectionId} if cycle.collectionId else {}),
            **{key: station[key] for key in ("bladeId", "radialPointId", "radialPointName", "radiusM",
                                             "azimuthDeg", "stationIndex", "stationCount")},
            sessionId=self.point_cycle["sessionId"], mode=cycle.mode, lapIndex=cycle_index,
            laserPolicy="continuous_during_session",
            **({"firstStationMode": "hold_current_pose"} if cycle.startAtCurrentPose else {}),
            stationId=station["pointId"], plannedStations=plan,
            nominalPeriodSeconds=cycle.nominalPeriodSeconds,
            motionMode=self.point_cycle.get("motionMode", "sequential"),
            arrivalMove=copy.deepcopy(self.point_cycle.get("lastMove")),
            identitySource="operator_assigned", identityVerified=False,
            coverageKind="sparse_station_passes",
            outcome="incomplete")
        metadata["pointCycle"].update({key: station[key] for key in
            ("rootRadiusM", "bladeLengthM", "distanceFromRootM") if key in station})
        metadata["turntable"] = {"config": cycle.model_dump(exclude={"points"}),
                                  "state": "holding", "point": point.name,
                                  "motionMode": self.point_cycle.get("motionMode", "sequential"),
                                  "arrivalMove": copy.deepcopy(self.point_cycle.get("lastMove")),
                                  "cycle": cycle_index, "pointIndex": point_index,
                                  **({"pointId": point.pointId} if point.pointId is not None else {}),
                                  **({"actualAngles": actual_angles} if actual_angles is not None else {})}
        writer = self.store.create(metadata)
        travel = 0.0
        if next_point is not None:
            start_angles = tuple((actual_angles or {}).get(str(axis), angle) for axis, angle in (
                (1, point.axis1AngleDeg), (2, point.axis2AngleDeg)))
            mode = self.point_cycle.get("motionMode", "sequential")
            move_speed, timing = station_timing_plan(cycle, start_angles, next_point, mode, point)
            if timing is not None:
                travel = timing["plannedMoveSeconds"]
            elif mode == "dual_axis_timed":
                _, next_move = station_move_plan(start_angles,
                    (next_point.axis1AngleDeg, next_point.axis2AngleDeg), move_speed,
                    acceleration=cycle.maxMoveAccelerationDegS2)
                travel = next_move["plannedSeconds"]
            else:
                travel = (abs(next_point.axis1AngleDeg - start_angles[0]) +
                          abs(next_point.axis2AngleDeg - start_angles[1])) / (6 * move_speed)
        with self.lock:
            self.writer = writer
            self.rows.clear()
            self.state = "starting"
            self.rssi_event.clear()
            self.rssi_handoff = RssiHandoff(cycle, travel) if cycle.rssiTriggerEnabled else None
            self.point_cycle.update(latestRssi=None, rssiSamples=0, rssiBelowSamples=0,
                                    rssiTrigger=None, rssiBaseline=None, rssiThreshold=None,
                                    rssiSpread=None, rssiEntryMs=0, rssiBelowMs=0,
                                    signalGapCount=0, lastSignalGapReason=None,
                                    rssiPhase="waiting_blade" if cycle.rssiTriggerEnabled else None,
                                    nextPoint=next_point.name if next_point is not None else None)
            self._cycle_process("starting_capture", point=point.name)
        capture_stop, capture_done, ready = threading.Event(), threading.Event(), threading.Event()
        capture_errors = []
        capture_started_at = time.time()

        def require_capture_laser():
            with self.lock:
                observed = copy.deepcopy(self.laser_observation or {})
            if observed.get("deviceIp") != request.deviceIp:
                return
            known_off = observed.get("state") == "off" and (observed.get("readAt") or 0) >= capture_started_at
            read_failed = bool(observed.get("error") and (observed.get("errorAt") or 0) >= capture_started_at)
            if known_off or read_failed:
                reason = "采集期间已读到激光关闭" if known_off else "采集期间激光状态读取失败"
                writer.manifest["pointCycle"].update(completion="device_error", outcome="error",
                    laserError="laser_state_unconfirmed", laserErrorReason=reason)
                raise RuntimeError(f"{reason}，不能将低波动判为叶片离开；未换点")

        def receive_loop():
            try:
                def receive_batch(batch):
                    # Freeze the current point's sample boundary before motion;
                    # SDK shutdown/draining must not add moving samples to it.
                    with self.lock:
                        if not capture_stop.is_set():
                            if (cycle.mode == "automatic_stations" or cycle.routeOrder == "configured") and (
                                    batch.sample_start != writer.manifest["samples"] or
                                    batch.sample_rate != writer.manifest["sampleRate"]):
                                writer.manifest["pointCycle"].update(completion="signal_gap", outcome="incomplete")
                            self._receive(batch)
                # Every station closes DAQ before movement, but normal station
                # boundaries keep the laser on. Abort/errors still force OFF.
                run_kwargs = ({"keep_laser_on": True, "abort": self.stop_event}
                              if getattr(receiver, "supports_laser_persistence", False) else {})
                def on_ready(rate, origin):
                    self._ready(rate, origin, receiver)
                    self._cycle_process("waiting_blade" if cycle.rssiTriggerEnabled else "capturing",
                                        point=point.name)
                    ready.set()
                receiver.run(capture_stop, on_ready, receive_batch, **run_kwargs)
            except Exception as exc:
                capture_errors.append(str(exc))
            finally:
                capture_done.set()

        thread = threading.Thread(target=receive_loop, name="blade-point-receiver", daemon=True)
        self.capture_thread, self.capture_stop = thread, capture_stop
        failure = None
        try:
            if before_capture is not None:
                verified = before_capture()
                current_angles = {str(axis): verified["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2)}
                evidence = copy.deepcopy(self.point_cycle.get("lastMove"))
                writer.manifest["pointCycle"].update(actualAngles=current_angles, arrivalMove=evidence)
                writer.manifest["turntable"].update(actualAngles=current_angles, arrivalMove=evidence)
            if self.stop_event.is_set():
                raise RuntimeError("循环采集已停止，未启动接收线程或开启激光")
            thread.start()
            deadline = time.monotonic() + DAQ_READY_SECONDS
            while not ready.wait(0.05):
                if self.stop_event.is_set():
                    break
                if capture_done.is_set():
                    raise RuntimeError("该点测振仪未就绪：" + ("; ".join(capture_errors) or "采集已退出"))
                if time.monotonic() > deadline:
                    raise RuntimeError("该点测振仪未在 30 秒内就绪")
            if not ready.is_set():
                raise RuntimeError("循环采集已停止")
            with self.lock:
                self.state = "acquiring"
            self._cycle_update("holding", currentPoint=point.name, cycle=cycle_index,
                               pointIndex=point_index, dwellStartedAt=time.time())
            started = time.monotonic()
            next_feedback_at = time.monotonic()
            trigger = None
            while True:
                elapsed = time.monotonic() - started
                remaining = cycle.dwellSeconds - elapsed
                if self.stop_event.is_set():
                    raise RuntimeError("循环采集被停止")
                require_capture_laser()
                if (cycle.mode == "automatic_stations" or cycle.routeOrder == "configured") and self.rssi_handoff.status["signalGapCount"]:
                    writer.manifest["pointCycle"].update(
                        completion="signal_gap", outcome="incomplete",
                        signalGapReason=self.rssi_handoff.status["lastSignalGapReason"])
                    raise RuntimeError("RSSI 信号缺失或不连续，未自动换点；当前点位需要重新测量")
                if capture_done.is_set():
                    raise RuntimeError("该点采集提前退出：" + ("; ".join(capture_errors) or "数据流已结束"))
                if cycle.rssiTriggerEnabled and self.rssi_event.is_set():
                    with self.lock:
                        trigger = copy.deepcopy(self.rssi_handoff.trigger)
                        capture_stop.set()
                        trigger.update(observedAt=time.time(),
                                       stationarySamples=writer.manifest["samples"],
                                       nextPoint=next_point.name if next_point is not None else None,
                                       estimatedTravelSeconds=travel,
                                       boundary="raw capture frozen before motion command")
                        writer.manifest["pointCycle"]["handoff"] = trigger
                        writer.manifest["pointCycle"].update(
                            completion="confirmed_pass", outcome="observed",
                            observedSamples=trigger["observedSamples"],
                            entrySampleIndex=trigger["entrySampleIndex"],
                            exitSampleIndex=trigger["exitConfirmedSampleIndex"])
                    break
                if remaining <= 0:
                    if cycle.rssiTriggerEnabled:
                        writer.manifest["pointCycle"].update(
                            completion="missing_exit" if self.rssi_handoff.armed else "missing_entry",
                            outcome="missed")
                        raise RuntimeError(f"点位 {point.name} 等待叶片进入并离开超时，未自动换点；请检查光路或延长最长等候时间")
                    break
                if time.monotonic() >= next_feedback_at and feedback_poll is not None:
                    feedback_poll()
                    next_feedback_at = time.monotonic() + .2
                self.rssi_event.wait(min(0.01, remaining))
            capture_stop.set()
            self._cycle_process("saving", point=point.name)
            thread.join(20)
            if thread.is_alive():
                raise RuntimeError("该点测振线程未退出，不能确认数据完整保存")
            if capture_errors:
                raise RuntimeError("; ".join(capture_errors))
            require_capture_laser()
            if self.stop_event.is_set():
                raise RuntimeError("循环采集已停止，未换到下一个点位")
            with self.lock:
                # The previous station's armed/triggered gate cannot be reused
                # while moving, even though the optical source remains on.
                self.rssi_handoff = None
                self.rssi_event.clear()
                self.point_cycle.update(rssiPhase=None, latestRssi=None)
            if trigger is not None:
                trigger["receiverClosedAt"] = time.time()
                writer.manifest["pointCycle"]["handoff"].update(trigger)
                if on_handoff is not None:
                    on_handoff(trigger)
            with self.lock:
                self._cycle_process("record_saved", point=point.name)
                writer.finish(None)
            return writer
        except Exception as exc:
            failure = str(exc)
            if writer.manifest["pointCycle"].get("completion") is None:
                writer.manifest["pointCycle"].update(
                    completion="cancelled" if self.stop_event.is_set() else "device_error",
                    outcome="cancelled" if self.stop_event.is_set() else "error")
            raise
        finally:
            capture_stop.set()
            if thread.is_alive():
                thread.join(20)
            with self.lock:
                if not thread.is_alive():
                    self.capture_thread = None
                    self.capture_stop = None
                self.rssi_handoff = None
                if failure and writer.manifest.get("status") == "incomplete":
                    try:
                        writer.finish(failure)
                    except Exception:
                        pass

    def _run_point_cycle(self, request: StartRequest, first_receiver):
        cycle = request.pointCycle
        motor = None
        failures = []
        cancelled = False
        current_writer = None
        try:
            if cycle is None:
                raise RuntimeError("缺少多点循环参数")
            motor = self.motor_factory(cycle.port, timeout=2.0, gear_ratio=50.0)
            motor.connect()
            feedback = motor_snapshot(motor, 1)
            require_ready(feedback)
            capability = self._motion_capability(motor)
            self._cycle_update("checking", motionCapability=capability, motionMode=capability["mode"])
            references = reference_key(feedback)
            for point in [*cycle.points, *([cycle.returnToOrigin] if cycle.returnToOrigin else [])]:
                expected = self._cycle_point_reference(point)
                if expected is not None:
                    actual = [[references[str(axis)][key] for key in ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")]
                              for axis in (1, 2)]
                    if actual != expected:
                        raise RuntimeError(f"点位 {point.name} 参考位或反馈计数单位已变化")
                for axis, angle in ((1, point.axis1AngleDeg), (2, point.axis2AngleDeg)):
                    require_position_ready(feedback, TurntableConfig(port=cycle.port, axis=axis,
                                                                      protocol="position", targetAngleDeg=angle,
                                                                      speedRpm=cycle.speedRpm))
            anchor = cycle.points[0]
            planned_points = (list(cycle.points) if cycle.mode == "automatic_stations" or cycle.routeOrder == "configured" else
                              self._plan_point_order(feedback, cycle.points, anchor))
            planned_names = [point.name for point in planned_points]
            self._cycle_update("ready", connected=True, references=references,
                               routeStrategy=("configured-station-order" if cycle.mode == "automatic_stations" or cycle.routeOrder == "configured"
                                              else "closed-nearest-neighbor-linear-safe"),
                               plannedOrder=planned_names)
            receiver = first_receiver
            prefetched_feedback = None
            for cycle_index in range(1, cycle.cycles + 1):
                # Re-plan at the beginning of every circle from the actual
                # last pose. This prevents a fixed order from forcing a long
                # return jump between the last point of one circle and the
                # first point of the next circle.
                feedback = motor_snapshot(motor, 1)
                planned_points = (list(cycle.points) if cycle.mode == "automatic_stations" or cycle.routeOrder == "configured" else
                                  self._plan_point_order(feedback, cycle.points, anchor))
                planned_names = [point.name for point in planned_points]
                self._cycle_update("ready", cycle=cycle_index,
                                   plannedOrder=planned_names)
                for point_index, point in enumerate(planned_points, 1):
                    if self.stop_event.is_set():
                        raise RuntimeError("循环采集已停止")
                    with self.lock:
                        self.point_cycle.update(cycle=cycle_index, point=point_index,
                                                currentPoint=point.name)
                    self._cycle_update("positioning", cycle=cycle_index, point=point_index,
                                       currentPoint=point.name, targetPointId=point.pointId,
                                       targetAxis1AngleDeg=point.axis1AngleDeg, targetAxis2AngleDeg=point.axis2AngleDeg)
                    initial_hold = cycle.startAtCurrentPose and cycle_index == 1 and point_index == 1
                    if initial_hold:
                        self._cycle_process("verifying_initial_pose", point=point.name)
                        final_feedback = self._cycle_verify_initial_pose(motor, cycle, point, "worker_start")
                    elif prefetched_feedback is None:
                        self._cycle_process("positioning", point=point.name)
                        reached, _, feedback = self._cycle_position_laser_on(
                            request, motor, cycle, point,
                            on_command=lambda: self._cycle_process("moving", point=point.name))
                        if not reached:
                            raise RuntimeError(f"点位 {point.name} 未完成两轴到位确认")
                        final_feedback = motor_snapshot(motor, 1)
                    else:
                        final_feedback, prefetched_feedback = prefetched_feedback, None
                    self._cycle_process("arrived", point=point.name)
                    actual_angles = {str(axis): final_feedback["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2)}
                    next_point = (planned_points[point_index] if point_index < len(planned_points) else
                                  anchor if cycle_index < cycle.cycles or (cycle.mode != "automatic_stations" and cycle.routeOrder != "configured") else None)

                    def handoff(trigger):
                        nonlocal prefetched_feedback

                        def command_started():
                            with self.lock:
                                self._cycle_process("moving", point=next_point.name,
                                                    fromPoint=point.name)
                                trigger.setdefault("motionCommandAt", time.time())
                                trigger["motionMode"] = self.point_cycle.get("motionMode", "sequential")
                                trigger["plannedMove"] = copy.deepcopy(self.point_cycle.get("lastMove"))
                                self.writer.manifest["pointCycle"]["handoff"].update(trigger)

                        reached, _, arrival = self._cycle_position_laser_on(request, motor, cycle, next_point,
                                                                     on_command=command_started,
                                                                     source_point=point)
                        if not reached:
                            raise RuntimeError(f"换点 {next_point.name} 未完成两轴到位确认")
                        prefetched_feedback = arrival
                        with self.lock:
                            self._cycle_process("arrived", point=next_point.name)
                            trigger["arrivedAt"] = time.time()
                            trigger["completedMove"] = copy.deepcopy(self.point_cycle.get("lastMove"))
                            if "motionCommandAt" in trigger:
                                trigger["actualMoveSeconds"] = trigger["arrivedAt"] - trigger["motionCommandAt"]
                            self.writer.manifest["pointCycle"]["handoff"].update(trigger)

                    with self.lock:
                        self.point_cycle["state"] = "capturing"
                    current_writer = self._capture_cycle_point(request, cycle, point, cycle_index,
                                                              point_index, receiver, actual_angles,
                                                              next_point, handoff if next_point is not None else None,
                                                              keep_laser_on=True,
                                                              before_capture=(lambda: self._cycle_verify_initial_pose(
                                                                  motor, cycle, point, "before_daq")) if initial_hold else
                                                              (lambda: self._cycle_capture_pose(motor, cycle, point)),
                                                              feedback_poll=lambda: self._cycle_capture_pose(
                                                                  motor, cycle, point, check_trajectory=False))
                    with self.lock:
                        self.point_cycle["completedRecords"] += 1
                    self._cycle_update("ready", cycle=cycle_index, point=point_index,
                                       currentPoint=point.name,
                                       completedRecords=self.point_cycle["completedRecords"],
                                       plannedOrder=planned_names)
                    if cycle_index != cycle.cycles or point_index != len(cycle.points):
                        receiver = self._device_receiver(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path))
                        receiver.validate()
                # Historical open clients finish every circle at the first configured point. This is
                # a positioning move only; it must not create a duplicate
                # measurement record for the anchor point.
                if (cycle.mode == "automatic_stations" or cycle.routeOrder == "configured") and cycle_index == cycle.cycles:
                    continue  # The final pass returns to work zero below, not to a measurement station.
                self._cycle_update("positioning", cycle=cycle_index,
                                   point=len(planned_points), currentPoint=f"回到起点 {anchor.name}",
                                   plannedOrder=planned_names)
                if prefetched_feedback is None:
                    self._cycle_process("returning", point=anchor.name)
                    reached, _, feedback = self._cycle_position_laser_on(request, motor, cycle, anchor)
                    if not reached:
                        raise RuntimeError(f"未能回到循环起点 {anchor.name}")
                self._cycle_update("ready", cycle=cycle_index,
                                   point=len(planned_points), currentPoint=anchor.name,
                                   plannedOrder=planned_names)
            if cycle.returnToOrigin is not None:
                origin = cycle.returnToOrigin
                self._cycle_update("positioning", returningToOrigin=True)
                self._cycle_process("returning_origin", point=origin.name)
                reached, _, feedback = self._cycle_position_laser_on(
                    request, motor, cycle, origin,
                    on_command=lambda: self._cycle_process("returning_origin", point=origin.name))
                if not reached:
                    raise RuntimeError("任务采集已保存，但尚未确认返回作业原点")
                self._cycle_update("ready", returnOrigin={
                    **origin.model_dump(), "confirmedAt": time.time(),
                    "actualAngles": {str(axis): feedback["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2)}})
                self._cycle_process("origin_arrived", point=origin.name)
            # DAQ is closed. Keep the light on as an owned observation laser,
            # so the header can still read/control it after the task finishes.
            self._confirm_motion_laser_on(request)
            if self.stop_event.is_set():
                raise RuntimeError("循环采集已停止")
            self._cycle_update("complete", cycle=cycle.cycles, point=len(planned_points),
                               completedRecords=cycle.cycles * len(planned_points), currentPoint=None,
                               plannedOrder=planned_names)
        except Exception as exc:
            if self.stop_event.is_set():
                cancelled = True
            else:
                failures.append(str(exc))
                self.stop_event.set()
            if current_writer and current_writer.manifest.get("status") == "incomplete":
                try:
                    with self.lock:
                        current_writer.finish((failures[-1] if failures else "循环采集已停止"))
                except Exception as finish_error:
                    failures.append(f"记录收尾失败：{finish_error}")
        finally:
            if motor:
                try:
                    motor.close(stop=False)
                except Exception as exc:
                    failures.append(f"关闭转盘串口失败：{exc}")
            if cycle and (failures or cancelled or self.stop_event.is_set()):
                cancelled = cancelled or self.stop_event.is_set() and not failures
                try:
                    self._confirm_motion_laser_off(request)
                    self.observation_laser_ip = None
                except Exception as exc:
                    failures.append(f"采集结束关闭激光失败：{exc}")
            with self.lock:
                if not self.capture_thread or not self.capture_thread.is_alive():
                    self.capture_thread = None
                    self.capture_stop = None
                cycle_state = "error" if failures else "cancelled" if cancelled else "complete"
                self.point_cycle = {**(self.point_cycle or {}), "state": cycle_state,
                                    "sessionState": cycle_state,
                                    "error": "; ".join(failures) or ("循环采集已停止" if cancelled else None)}
                self._cycle_process(cycle_state, error=self.point_cycle["error"])
                self.turntable_snapshot.update(state="error" if failures else "stopped",
                                               connected=False, error="; ".join(failures) or None)
                self.error = "; ".join(failures) or None
                self.state = "error" if failures else "idle"

    def _run(self, receiver, turntable=None, request=None) -> None:
        failure = None
        try:
            if turntable is not None:
                self._run_joint(receiver, turntable, request)
            else:
                receiver.run(self.stop_event, lambda rate, origin: self._ready(rate, origin, receiver), self._receive)
        except Exception as exc:
            failure = str(exc)
            self.stop_event.set()
        finally:
            with self.lock:
                failure = failure or self.error
                try:
                    if self.capture_thread and self.capture_thread.is_alive():
                        self.writer.manifest["error"] = failure
                        self.writer.persist()
                    else:
                        self.writer.finish(failure)
                except Exception as exc:
                    failure = f"{failure + '; ' if failure else ''}采集数据收尾失败：{exc}"
                self.error = failure
                self.state = "error" if failure else "idle"

    def stop(self) -> dict:
        with self.lock:
            testing = self.test_thread and self.test_thread.is_alive()
            if testing:
                self.test_stop.set()
        if testing:
            return self._stop_turntable_test()
        with self.lock:
            if self.device_busy or self.turntable_busy:
                raise HTTPException(409, "设备配置/聚焦仍在进行，请等待完成并现场确认激光状态。")
        with self.operation_lock:
            with self.lock:
                thread = self.thread
                if not thread or not thread.is_alive():
                    if self.capture_thread and self.capture_thread.is_alive():
                        raise HTTPException(503, "接收线程仍未退出，请核查激光和转盘状态，不能重启采集")
                    observation_ip = self.observation_laser_ip
                else:
                    observation_ip = None
            if observation_ip:
                try:
                    self._device_command(ReceiverConfig(observation_ip, "", self.settings.dll_path), "laser_off")
                    self.observation_laser_ip = None
                except Exception as exc:
                    raise HTTPException(503, f"关闭观察激光失败：{exc}") from exc
            with self.lock:
                if not thread or not thread.is_alive():
                    return self.status()
                self.state = "stopping"
                self.stop_event.set()
            timeout = 60 if self.writer and self.writer.manifest.get("turntable") else 20
            thread.join(timeout=timeout)
            if thread.is_alive():
                with self.lock:
                    self.state = "error"
                    self.error = f"采集线程未在 {timeout} 秒内退出，记录仍未完成；请确认转盘停稳、激光已关闭并检查设备。"
                raise HTTPException(503, self.error)
            return self.status()


def create_app(settings: Settings, receiver_factory=PolytecReceiver, motor_factory=DEFAULT_MOTOR_FACTORY) -> FastAPI:
    controller = AcquisitionController(settings, receiver_factory, motor_factory)

    @asynccontextmanager
    async def lifespan(_app):
        # Idle by default: importing/starting the service never loads the SDK or touches a device.
        yield
        try:
            await asyncio.to_thread(controller.stop)
        except HTTPException:
            pass  # The persisted manifest stays incomplete; never claim a forced shutdown is complete.

    app = FastAPI(title="BladeVMS Field Acquisition", version="1.0.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.controller = controller
    analysis_lock = threading.Lock()
    allowed_origins = {f"http://127.0.0.1:{settings.port}", f"http://localhost:{settings.port}"}
    allowed_hosts = {f"127.0.0.1:{settings.port}", f"localhost:{settings.port}"}

    def origin_allowed(origin: str | None) -> bool:
        return origin is None or origin in allowed_origins

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        if request.headers.get("host") not in allowed_hosts or not origin_allowed(request.headers.get("origin")):
            return JSONResponse({"detail": "仅允许本机桌面应用访问。"}, status_code=403)
        authorization = request.headers.get("authorization", "")
        if not hmac.compare_digest(authorization, f"Bearer {settings.token}"):
            return JSONResponse({"detail": "本机服务身份校验失败。"}, status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/api/field/status")
    def status():
        return controller.status()

    @app.get("/api/field/simulation")
    def simulation():
        return simulation_catalog()

    @app.get("/api/field/frame")
    def frame(window_ms: int | None = Query(default=None, ge=1, le=1000)):
        return controller.frame(window_ms)

    @app.get("/api/field/realtime")
    def realtime():
        return controller.realtime()

    @app.post("/api/field/device")
    def device(request: DeviceRequest):
        return controller.configure_device(request)

    @app.post("/api/field/rssi-calibration")
    def rssi_calibration(request: RssiCalibrationRequest):
        return controller.calibrate_rssi(request)

    @app.get("/api/field/turntable/ports")
    def turntable_ports():
        try:
            return {"ports": list_turntable_ports()}
        except ImportError as exc:
            raise HTTPException(503, "采集服务缺少 pyserial，请更新服务包") from exc

    @app.post("/api/field/turntable")
    def turntable(request: TurntableRequest):
        return controller.turntable_operation(request)

    @app.post("/api/field/single-point")
    def single_point(request: SinglePointRequest):
        return controller.single_point_operation(request)

    @app.post("/api/field/motion-trial")
    def motion_trial(request: MotionTrialRequest):
        return controller.motion_trial_operation(request)

    @app.get("/api/field/recordings/{recording_id}/turntable-export")
    def turntable_export(recording_id: str):
        try:
            directory = controller.store.directory(recording_id)
            manifest = controller.store._read_manifest(directory)
            if manifest.get("status") != "complete":
                raise HTTPException(409, "请先停止并完整保存联合任务，再导出遥测")
            path = directory / "turntable.jsonl"
            if not manifest.get("turntable") or path.is_symlink() or not path.is_file():
                raise HTTPException(404, "该记录没有转盘遥测文件")
            def stream():
                with path.open("rb") as source:
                    while payload := source.read(65536):
                        yield payload
            return StreamingResponse(stream(), media_type="application/x-ndjson")
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "联合采集记录不存在") from exc

    @app.post("/api/field/start")
    def start(request: StartRequest):
        return controller.start(request)

    @app.post("/api/field/stop")
    def stop():
        return controller.stop()

    @app.get("/api/field/recordings")
    def recordings():
        records = controller.store.list()
        current = controller.status()["recording"]
        if current:
            records = [current] + [item for item in records if item["id"] != current["id"]]
        return {"recordings": records}

    @app.get("/api/field/recordings/{recording_id}")
    def recording(recording_id: str):
        with controller.lock:
            try:
                result = controller.store.get(recording_id)
                if controller.writer and controller.writer.id == recording_id:
                    result["recording"] = copy.deepcopy(controller.writer.manifest)
                return result
            except KeyError as exc:
                raise HTTPException(404, str(exc)) from exc
            except (OSError, ValueError) as exc:
                raise HTTPException(500, f"无法读取采集记录：{exc}") from exc

    @app.get("/api/field/recordings/{recording_id}/waveform")
    def recording_waveform(recording_id: str, start: int = Query(default=0, ge=0, le=2**53 - 1),
                           end: int | None = Query(default=None, ge=1, le=2**53 - 1)):
        if end is not None and end <= start:
            raise HTTPException(422, "结束样本必须大于起始样本。")
        with controller.lock:
            manifest = copy.deepcopy(controller.writer.manifest) if controller.writer and controller.writer.id == recording_id else None
        try:
            return controller.wave_reader.read(recording_id, start, end, manifest)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except BlockingIOError as exc:
            raise HTTPException(409, str(exc)) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(500, f"无法读取波形：{exc}") from exc

    @app.get("/api/field/recordings/{recording_id}/export")
    def recording_export(recording_id: str):
        try:
            from .csv_export import prepare_export, stream_csv
            manifest, chunks = prepare_export(controller.store, recording_id)
            return StreamingResponse(stream_csv(manifest, chunks), media_type="text/csv; charset=utf-8",
                                     headers={"Content-Disposition": f'attachment; filename="{recording_id}.csv"'})
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "原始记录不存在。") from exc
        except BlockingIOError as exc:
            raise HTTPException(409, str(exc)) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(422, f"无法导出原始记录：{exc}") from exc

    @app.post("/api/field/recordings/{recording_id}/analysis")
    def recording_analysis(recording_id: str, parameters: dict):
        # Run in FastAPI's worker pool, outside the acquisition lock. Single job
        # bounds FFT memory and never blocks the stop-acquisition operation.
        if not analysis_lock.acquire(blocking=False):
            raise HTTPException(409, "已有分析运行，请等待完成。")
        try:
            try:
                from .analysis import AnalysisRequest, read_raw, calculate
            except ImportError as exc:
                raise HTTPException(503, "当前采集服务缺少 NumPy/SciPy 分析依赖，请更新服务包。") from exc
            config = AnalysisRequest.model_validate(parameters)
            values, rate, provenance = read_raw(controller.store, recording_id, config.start, config.end)
            return calculate(values, rate, config, provenance)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "原始记录或分块不存在。") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(500, f"无法读取原始记录：{exc}") from exc
        finally:
            analysis_lock.release()

    @app.post("/api/field/rotation")
    def rotation_analysis(parameters: dict):
        # The same lock bounds all NumPy/SciPy jobs and keeps acquisition stop
        # independent from potentially expensive multi-record file reads.
        if not analysis_lock.acquire(blocking=False):
            raise HTTPException(409, "已有分析运行，请等待完成。")
        try:
            try:
                from .rotation import RotationRequest, calculate_rotation
            except ImportError as exc:
                raise HTTPException(503, "当前采集服务缺少 NumPy/SciPy 旋转分析依赖，请更新服务包。") from exc
            config = RotationRequest.model_validate(parameters)
            return calculate_rotation(controller.store, config)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "旋转分析所选记录或原始分块不存在。") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(500, f"无法读取旋转分析原始记录：{exc}") from exc
        finally:
            analysis_lock.release()

    @app.websocket("/ws/field")
    async def field_socket(socket: WebSocket):
        protocols = [item.strip() for item in socket.headers.get("sec-websocket-protocol", "").split(",")]
        valid_token = len(protocols) == 2 and protocols[0] == "blade" and hmac.compare_digest(protocols[1], settings.token)
        if (not valid_token or socket.headers.get("host") not in allowed_hosts
                or not origin_allowed(socket.headers.get("origin"))):
            await socket.close(code=1008)
            return
        await socket.accept(subprotocol="blade")
        try:
            while True:
                await socket.send_json(await asyncio.to_thread(controller.frame))
                await asyncio.sleep(0.25)
        except (WebSocketDisconnect, RuntimeError):
            return

    return app
