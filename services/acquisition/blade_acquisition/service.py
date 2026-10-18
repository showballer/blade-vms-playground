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
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from itertools import islice
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, StrictBool, field_validator, model_validator

from .receiver import Batch, PolytecReceiver, ReceiverConfig
from .rssi_handoff import RssiHandoff
from .storage import DISPLAY_LIMIT, RecordingStore, empty_waveform
from .waveform import WaveformReader, make_wave
from .device import DevicePanel, WRITABLE
from .simulation import SimulationConfig, SimulationReceiver, simulation_catalog
from .turntable import (TurntableConfig, TurntableRequest, PointCycleConfig, PointCyclePoint, MotionGuard, TelemetryWriter,
                        DEFAULT_MOTOR_FACTORY, snapshot as motor_snapshot, require_ready,
                        start_motor, renew_motor, test_key, require_position_ready,
                        position_reached, PositionProgress, ManualPositionProgress, reference_key,
                        require_manual_position_ready, require_manual_axis_ready, require_stop_confirmed)

MOTOR_STARTUP_SECONDS = 10.0
DAQ_READY_SECONDS = 30.0


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
    object: str = Field(default="", max_length=120)
    turbine: str = Field(default="", max_length=120)
    point: str = Field(default="", max_length=120)
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

    @field_validator("name", "object", "turbine", "point")
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
    action: str = Field(pattern="^(read|set|autofocus|laser_on|laser_off)$")
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
        self.device_snapshot = None
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
                    "turntable": copy.deepcopy(self.turntable_snapshot),
                    "turntableBusy": self.turntable_busy,
                    "turntableWarning": self.motion_guard.warning,
                    "turntableTest": copy.deepcopy(self.turntable_test),
                    "turntablePreparation": copy.deepcopy(self.turntable_preparation),
                    "pointCycle": copy.deepcopy(self.point_cycle),
                    "indexWarning": self.store.index_error}

    def turntable_operation(self, request: TurntableRequest):
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
        if not self.operation_lock.acquire(blocking=False):
            raise HTTPException(409, "设备操作进行中，请等待完成")
        motor, handed_off, feedback = None, False, None
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
                if self.motion_guard.warning and self.motion_guard.identity and self.motion_guard.identity != (request.port, request.axis):
                    raise RuntimeError("请选择上次未确认停止的同一端口和轴进行恢复")
                self.motion_guard.mark(request, True, "转盘停止尚未确认")
                motor.stop(request.axis)
            feedback = motor_snapshot(motor, request.axis)
            if request.action in ("reference", "limits"):
                if self.motion_guard.warning:
                    raise RuntimeError(self.motion_guard.warning)
                require_manual_axis_ready(feedback, request)
                self.turntable_test = None
                if request.action == "reference":
                    motor.set_current_reference(request.axis)
                else:
                    guard = motor.get_guard_config(request.axis)
                    limit = 35 if request.axis == 1 else 180
                    motor.set_soft_range(request.axis, -limit, limit)
                    motor.set_guard_policy(request.axis, hardware=guard.hardware_enabled, soft=True,
                                           home_direction=guard.home_direction, confirmed=guard.confirmed,
                                           home_at_end=guard.home_at_end)
                feedback = motor_snapshot(motor, request.axis)
                if request.action == "reference" and feedback["outputAngleDeg"] is None:
                    raise RuntimeError("下位机未返回有效参考位")
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
                require_stop_confirmed(feedback, request)
                identity = self.motion_guard.identity
                if self.motion_guard.warning and identity and identity != (request.port, request.axis):
                    raise RuntimeError("请选择上次未确认停止的同一端口和轴进行恢复")
                self.motion_guard.mark(request, False)
            elif request.confirmRecovery:
                require_ready(feedback)
                identity = self.motion_guard.identity
                if self.motion_guard.warning and identity and identity != (request.port, request.axis):
                    raise RuntimeError("请选择上次未确认停止的同一端口和轴进行恢复")
                self.motion_guard.mark(request, False)
            with self.lock:
                self.turntable_snapshot = {"state": "prepared" if request.action == "prepare" else "stopped" if request.action == "stop" else "checked", "port": request.port,
                                           "axis": request.axis, "feedback": feedback,
                                           "connected": False, "error": None,
                                           **({"stopConfirmed": True} if request.action == "stop" else {})}
            return self.status()
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
                self.turntable_snapshot.update(state=state, feedback=feedback, **extra)
                self.turntable_snapshot["recall"]["completedAxes"] = list(completed)

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
            for config in configs:
                feedback = motor_snapshot(motor, config.axis)
                require_position_ready(feedback, config)
                if references is None:
                    references = reference_key(feedback)
                    if request.referenceSignature is not None:
                        actual = [[references[str(axis)][key] for key in ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")] for axis in (1, 2)]
                        if json.loads(request.referenceSignature) != actual:
                            raise RuntimeError("记录后参考位或反馈单位已变化，请重新标定此点")
                elif reference_key(feedback) != references:
                    raise RuntimeError("两轴参考位或反馈单位已变化，请重新核查点位")
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
        wave = make_wave(rows, rate, origin)
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
            result.update(source=status["receiver"]["source"], recordingId=recording_id, unit="m/s",
                          computedAt=time.time(),
                          sampleRange={"start": selected[0][0] if selected else 0,
                                       "end": selected[-1][0] + 1 if selected else 0},
                          quality={"overrangeSamples": sum(bool(r[3]) for r in selected),
                                   "missingRssiSamples": sum(r[2] is None for r in selected),
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
        if request.action == "set" and (not request.confirmChange or request.key not in WRITABLE):
            raise HTTPException(422, "请明确确认修改支持的配置项。")
        if request.action in {"autofocus", "laser_on", "laser_off"} and not request.confirmLaser:
            raise HTTPException(422, "激光操作需要明确确认现场光路安全。")
        if not self.operation_lock.acquire(blocking=False):
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
            panel = DevicePanel(ReceiverConfig(request.deviceIp, "", self.settings.dll_path))
            result = panel.run_command(request.action, request.key, request.value, request.expected)
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
            receiver = self.receiver_factory(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path))
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
                    DevicePanel(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path)).run_command("laser_off")
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
        with self.operation_lock:
            with self.lock:
                if self.device_warning and request.source == "polytec_ivs500":
                    raise HTTPException(409, self.device_warning)
                if self.observation_laser_ip and (request.source != "polytec_ivs500" or request.deviceIp != self.observation_laser_ip):
                    raise HTTPException(409, "请先关闭观察激光，再切换设备或模拟采集。")
                if request.turntable and self.motion_guard.warning:
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
                                self.receiver_factory(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path)))
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
                self.thread = threading.Thread(target=self._run, args=(receiver, request.turntable), name=f"blade-{request.source}", daemon=True)
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
            receiver = self.receiver_factory(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path))
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
            self.writer.ready(rate, origin)
            if not self.stop_event.is_set():
                self.state = "acquiring"

    def _receive(self, batch: Batch) -> None:
        with self.lock:
            self.writer.write(batch)
            # This is a display window, never the source for raw persistence.
            offset = max(0, len(batch.values) - self.rows.maxlen)
            self.rows.extend((batch.sample_start + index, batch.values[index],
                              batch.rssi[index] if index < len(batch.rssi) else None,
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

    def _run_joint(self, receiver, config):
        """Own the motor on this coordinator thread; DAQ never waits on serial I/O."""
        ready, capture_done, capture_stop = threading.Event(), threading.Event(), threading.Event()
        capture_errors = []
        motor, telemetry, capture = None, None, None
        attempted = False
        failures = []

        def event(kind, **data):
            with self.lock:
                samples = self.writer.manifest["samples"]
            telemetry.write(kind, {"receivedSamples": samples, **data})

        def update(state, feedback=None, **extra):
            with self.lock:
                previous = self.turntable_snapshot
                self.turntable_snapshot = {**previous, "state": state, "port": config.port,
                                           "axis": config.axis, **extra}
                if feedback is not None:
                    self.turntable_snapshot["feedback"] = feedback
                self.writer.manifest["turntable"].update(self.turntable_snapshot)

        def receive_loop():
            try:
                def on_ready(rate, origin):
                    self._ready(rate, origin, receiver)
                    ready.set()
                receiver.run(capture_stop, on_ready, self._receive)
            except Exception as exc:
                capture_errors.append(str(exc))
            finally:
                capture_done.set()

        try:
            telemetry = TelemetryWriter(self.writer.directory)
            event("configured", config=config.model_dump())
            motor = self.motor_factory(config.port, timeout=2.0, gear_ratio=50.0)
            motor.connect()
            feedback = motor_snapshot(motor, config.axis)
            update("checked", feedback, connected=True)
            event("preflight", feedback=feedback)
            if config.protocol == "position":
                require_position_ready(feedback, config)
                if reference_key(feedback) != self.writer.manifest["turntable"]["preparedReferences"]:
                    raise RuntimeError("参考位或反馈计数单位已变化，请重新确认定位设置")
            else:
                require_ready(feedback)
            if self.stop_event.is_set():
                return
            capture = threading.Thread(target=receive_loop, name="blade-joint-receiver", daemon=True)
            self.capture_thread, self.capture_stop = capture, capture_stop
            capture.start()
            deadline = time.monotonic() + DAQ_READY_SECONDS
            while not ready.wait(0.05):
                if self.stop_event.is_set():
                    return
                if capture_done.is_set():
                    raise RuntimeError("; ".join(capture_errors) or "采集未就绪即退出")
                if time.monotonic() > deadline:
                    raise RuntimeError("采集未在 30 秒内就绪，未启动转盘")
            if self.stop_event.is_set():
                return
            if capture_done.is_set():
                raise RuntimeError("; ".join(capture_errors) or "采集已退出，未启动转盘")
            if config.protocol == "position":
                feedback = motor_snapshot(motor, config.axis)
                require_position_ready(feedback, config)
                if reference_key(feedback) != self.writer.manifest["turntable"]["preparedReferences"]:
                    raise RuntimeError("采集就绪期间参考位或计数单位变化，请重新确认定位设置")
                event("before_motion", feedback=feedback)
            # Persist before any motion. A crash/timeout cannot erase uncertainty.
            self.motion_guard.mark(config, True)
            attempted = True
            update("starting")
            effective = start_motor(motor, config, self.stop_event)
            if effective is None:
                return
            if config.protocol == "position":
                progress = PositionProgress(feedback, config)
            started = time.monotonic()
            update("awaiting_feedback", effectiveRpm=effective, commandAcceptedAt=time.time())
            event("accepted", effectiveRpm=effective)
            seen_running, deviations = False, 0
            settled, reached = 0, False
            while not self.stop_event.is_set():
                if capture_done.is_set():
                    raise RuntimeError("; ".join(capture_errors) or "采集意外退出")
                renew_motor(motor, config)
                feedback = motor_snapshot(motor, config.axis)
                if feedback["alarmCode"] or feedback["limitFlags"] not in (None, 0):
                    event("status", feedback=feedback)
                    update("error", feedback)
                    raise RuntimeError("转盘报警或限位触发/旁路")
                if config.protocol == "position":
                    progress.check(feedback, config)
                    settled = settled + 1 if position_reached(feedback, config) else 0
                    if settled >= 2 and not reached:
                        reached = True
                        event("position_reached", feedback=feedback, targetAngleDeg=config.targetAngleDeg)
                    update("holding" if reached else "positioning", feedback)
                    event("status", feedback=feedback)
                    age = time.monotonic() - started
                    if reached and not position_reached(feedback, config):
                        raise RuntimeError("到位后角度偏移或再次运动，联合任务已停止")
                    if config.durationSeconds and age >= config.durationSeconds:
                        if not reached:
                            raise RuntimeError("采集时长已到但定位未完成")
                        event("duration_elapsed")
                        break
                    self.stop_event.wait(0.2)
                    continue
                matched = abs(feedback["outputRpm"] - effective) <= max(0.01, abs(effective) * 0.1)
                seen_running = seen_running or matched
                update("running" if matched else "awaiting_feedback", feedback)
                event("status", feedback=feedback)
                age = time.monotonic() - started
                if age > MOTOR_STARTUP_SECONDS and not seen_running:
                    raise RuntimeError("转盘启动 10 秒后仍未达到设定速度，请检查 SON 和驱动器")
                if seen_running:
                    deviations = 0 if matched else deviations + 1
                    if deviations >= 3:
                        raise RuntimeError("转盘连续三次反馈偏离运行速度，联合任务已停止")
                if config.durationSeconds and age >= config.durationSeconds:
                    if not seen_running:
                        raise RuntimeError("自动停止时间已到，但转盘尚未达到目标转速；请先独立试转并检查 SON 和驱动器")
                    event("duration_elapsed")
                    break
                self.stop_event.wait(0.5)
        except Exception as exc:
            failures.append(str(exc))
        finally:
            if attempted:
                update("stopping")
                with self.lock:
                    self.state = "stopping"
                try:
                    # The receiver stays alive through normal motor deceleration.
                    motor.stop(config.axis)
                    feedback = motor_snapshot(motor, config.axis)
                    if feedback["motorRpm"] != 0:
                        raise RuntimeError("停止后读回仍非零速")
                    self.motion_guard.mark(config, False)
                    update("stopped", feedback, stoppedAt=time.time(), stopConfirmed=True)
                    event("stopped", feedback=feedback)
                except Exception as exc:
                    failures.append(f"转盘停止未确认：{exc}")
                    self.motion_guard.warning = failures[-1] + "；请现场核查后读取并确认恢复"
                    update("unknown", stopConfirmed=False, error=failures[-1])
            capture_stop.set()
            if capture:
                capture.join(20)
                if capture.is_alive():
                    failures.append("采集线程未退出，不能确认激光已关闭或数据完成")
            failures.extend(capture_errors)
            if motor:
                try:
                    motor.close(stop=False)
                except Exception as exc:
                    failures.append(f"关闭转盘串口失败：{exc}")
            if telemetry:
                try:
                    event("finished", errors=failures)
                except Exception as exc:
                    failures.append(f"转盘遥测收尾失败：{exc}")
                try:
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
            if self.writer and self.writer.manifest.get("turntable"):
                self.writer.manifest["turntable"].update(self.turntable_snapshot)

    @staticmethod
    def _cycle_point_reference(point: PointCyclePoint):
        if point.referenceSignature is None:
            return None
        return json.loads(point.referenceSignature)

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

    def _cycle_move_point(self, motor, cycle: PointCycleConfig, point: PointCyclePoint, on_command=None):
        """Move both axes together and wait for both position controllers.

        The serial protocol has one frame per axis, but the drive controllers
        execute accepted position commands independently.  Sending both
        frames before polling feedback makes the two axes travel concurrently;
        the old implementation waited for axis 1 to stop before commanding
        axis 2, which made every point transition unnecessarily serial.
        """
        configs = [TurntableConfig(port=cycle.port, axis=axis, protocol="position",
                                   targetAngleDeg=angle, speedRpm=cycle.speedRpm)
                   for axis, angle in ((1, point.axis1AngleDeg), (2, point.axis2AngleDeg))]
        active: list[TurntableConfig] = []
        completed = []
        try:
            feedback = motor_snapshot(motor, 1)
            require_ready(feedback)
            references = reference_key(feedback)
            expected = self._cycle_point_reference(point)
            if expected is not None:
                actual = [[references[str(axis)][key] for key in ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")]
                          for axis in (1, 2)]
                if actual != expected:
                    raise RuntimeError(f"点位 {point.name} 记录后参考位或反馈计数单位已变化")
            for config in configs:
                require_position_ready(feedback, config)
                if reference_key(feedback) != references:
                    raise RuntimeError("两轴参考位或反馈计数单位已变化，已取消循环")
            pending = []
            for config in configs:
                if self.stop_event.is_set():
                    return False, completed, feedback
                self._cycle_update("holding" if position_reached(feedback, config) else "positioning",
                                   axis=config.axis, targetAngleDeg=config.targetAngleDeg,
                                   currentPoint=point.name)
                if position_reached(feedback, config):
                    completed.append(config.axis)
                    continue
                pending.append((config, PositionProgress(feedback, config)))
            if not pending:
                return True, completed, feedback

            # Both preflight checks passed while both axes were stopped.  Keep
            # the guard armed across the pair, then issue both commands before
            # entering the feedback loop.  The controller starts each axis as
            # soon as its own command is accepted; the two serial transactions
            # are only a few milliseconds apart.
            self.motion_guard.mark(pending[-1][0], True, "循环点位运动停止尚未确认")
            if on_command is not None:
                on_command()
            for config, _ in pending:
                # Include an attempted command in cleanup even when its reply
                # is lost; failure does not prove that the axis stayed still.
                active.append(config)
                if start_motor(motor, config, self.stop_event,
                               prechecked_position=True) is None:
                    active.pop()
                    for running in active:
                        motor.stop(running.axis)
                        feedback = motor_snapshot(motor, running.axis)
                        require_stop_confirmed(feedback, running)
                    self.motion_guard.mark(pending[-1][0], False)
                    return False, completed, feedback
            settled = {config.axis: 0 for config, _ in pending}
            while not self.stop_event.is_set():
                feedback = motor_snapshot(motor, 1)
                for config, progress in pending:
                    axis_feedback = feedback["axes"][str(config.axis)]
                    if axis_feedback["fault"] or axis_feedback["flags"] & 16:
                        raise RuntimeError(f"轴{config.axis}运动检测到驱动器报警或限位异常")
                    progress.check(feedback, config, allow_other_axis_motion=True)
                    settled[config.axis] = settled[config.axis] + 1 if position_reached(feedback, config) else 0
                    self._cycle_update("holding" if settled[config.axis] >= 1 else "positioning",
                                       axis=config.axis, targetAngleDeg=config.targetAngleDeg,
                                       currentPoint=point.name, positionAngleDeg=axis_feedback["output_angle_deg"])
                if all(settled[config.axis] >= 1 for config, _ in pending):
                    break
                self.stop_event.wait(0.05)
            if self.stop_event.is_set():
                # Cancellation is different from normal controller arrival:
                # stop every axis that received a point command and confirm
                # each one before returning control to the caller.
                for config in active:
                    motor.stop(config.axis)
                    feedback = motor_snapshot(motor, config.axis)
                    require_stop_confirmed(feedback, config)
                self.motion_guard.mark(active[-1], False)
                return False, completed, feedback
            for config, _ in pending:
                if not position_reached(feedback, config):
                    raise RuntimeError(f"轴{config.axis}控制器报告到位后未保持目标角度")
                completed.append(config.axis)
            # Normal arrival already includes target angle and zero-speed
            # feedback from both position controllers.  No extra stop round
            # trip is needed between adjacent points.
            self.motion_guard.mark(pending[-1][0], False)
            return len(completed) == 2 and not self.stop_event.is_set(), completed, feedback
        except Exception:
            if active:
                failures = []
                for config in active:
                    try:
                        motor.stop(config.axis)
                        feedback = motor_snapshot(motor, config.axis)
                        require_stop_confirmed(feedback, config)
                    except Exception as stop_error:
                        failures.append(f"轴{config.axis}：{stop_error}")
                if failures:
                    self.motion_guard.warning = f"循环点位停止未确认：{'; '.join(failures)}；请现场核查"
                else:
                    self.motion_guard.mark(active[-1], False)
            raise

    def _capture_cycle_point(self, request: StartRequest, cycle: PointCycleConfig,
                             point: PointCyclePoint, cycle_index: int, point_index: int,
                             receiver, actual_angles: dict[str, float | None] | None = None,
                             next_point: PointCyclePoint | None = None, on_handoff=None,
                             keep_laser_on: bool = False):
        metadata = request.model_dump(exclude={"confirmLaser", "confirmMotion", "simulation", "turntable", "pointCycle"})
        metadata["point"] = point.name
        metadata["pointCycle"] = {"cycle": cycle_index, "pointIndex": point_index,
                                   **({"pointId": point.pointId} if point.pointId is not None else {}),
                                   "pointName": point.name, "cycles": cycle.cycles,
                                   "dwellSeconds": cycle.dwellSeconds,
                                   "targetAxis1AngleDeg": point.axis1AngleDeg,
                                   "targetAxis2AngleDeg": point.axis2AngleDeg,
                                   **({"actualAngles": actual_angles} if actual_angles is not None else {})}
        metadata["turntable"] = {"config": cycle.model_dump(exclude={"points"}),
                                  "state": "holding", "point": point.name,
                                  "cycle": cycle_index, "pointIndex": point_index,
                                  **({"pointId": point.pointId} if point.pointId is not None else {}),
                                  **({"actualAngles": actual_angles} if actual_angles is not None else {})}
        writer = self.store.create(metadata)
        travel = (max(abs(next_point.axis1AngleDeg - point.axis1AngleDeg),
                      abs(next_point.axis2AngleDeg - point.axis2AngleDeg)) / (6 * cycle.speedRpm)
                  if next_point is not None else 0.0)
        with self.lock:
            self.writer = writer
            self.rows.clear()
            self.state = "starting"
            self.rssi_event.clear()
            self.rssi_handoff = RssiHandoff(cycle, travel) if cycle.rssiTriggerEnabled else None
            self.point_cycle.update(latestRssi=None, rssiSamples=0, rssiBelowSamples=0,
                                    rssiTrigger=None, rssiBaseline=None, rssiThreshold=None,
                                    rssiSpread=None, rssiEntryMs=0, rssiBelowMs=0,
                                    rssiPhase="waiting_blade" if cycle.rssiTriggerEnabled else None,
                                    nextPoint=next_point.name if next_point is not None else None)
            self._cycle_process("starting_capture", point=point.name)
        capture_stop, capture_done, ready = threading.Event(), threading.Event(), threading.Event()
        capture_errors = []

        def receive_loop():
            try:
                def receive_batch(batch):
                    # Freeze the current point's sample boundary before motion;
                    # SDK shutdown/draining must not add moving samples to it.
                    with self.lock:
                        if not capture_stop.is_set():
                            self._receive(batch)
                run_kwargs = ({"keep_laser_on": keep_laser_on, "abort": self.stop_event}
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
        thread.start()
        failure = None
        try:
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
            while True:
                elapsed = time.monotonic() - started
                remaining = cycle.dwellSeconds - elapsed
                if self.stop_event.is_set():
                    raise RuntimeError("循环采集被停止")
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
                    # The coordinator still owns the serial port. Start the
                    # next move now, while the DAQ thread closes independently.
                    # No motion samples can enter this point's record.
                    if on_handoff is not None:
                        on_handoff(trigger)
                    break
                if remaining <= 0:
                    if cycle.rssiTriggerEnabled:
                        raise RuntimeError(f"点位 {point.name} 等待叶片进入并离开超时，未自动换点；请检查光路或延长最长等候时间")
                    break
                self.rssi_event.wait(min(0.01, remaining))
            capture_stop.set()
            self._cycle_process("saving", point=point.name)
            thread.join(20)
            if thread.is_alive():
                raise RuntimeError("该点测振线程未退出，不能确认数据完整保存")
            if capture_errors:
                raise RuntimeError("; ".join(capture_errors))
            with self.lock:
                self._cycle_process("record_saved", point=point.name)
                writer.finish(None)
            return writer
        except Exception as exc:
            failure = str(exc)
            raise
        finally:
            capture_stop.set()
            if thread.is_alive():
                thread.join(20)
            with self.lock:
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
            references = reference_key(feedback)
            for point in cycle.points:
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
            planned_points = self._plan_point_order(feedback, cycle.points, anchor)
            planned_names = [point.name for point in planned_points]
            self._cycle_update("ready", connected=True, references=references,
                               routeStrategy="closed-nearest-neighbor-linear-safe",
                               plannedOrder=planned_names)
            receiver = first_receiver
            prefetched_feedback = None
            for cycle_index in range(1, cycle.cycles + 1):
                # Re-plan at the beginning of every circle from the actual
                # last pose. This prevents a fixed order from forcing a long
                # return jump between the last point of one circle and the
                # first point of the next circle.
                feedback = motor_snapshot(motor, 1)
                planned_points = self._plan_point_order(feedback, cycle.points, anchor)
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
                                       currentPoint=point.name)
                    if prefetched_feedback is None:
                        self._cycle_process("positioning", point=point.name)
                        reached, _, feedback = self._cycle_move_point(
                            motor, cycle, point,
                            on_command=lambda: self._cycle_process("moving", point=point.name))
                        if not reached:
                            raise RuntimeError(f"点位 {point.name} 未完成两轴到位确认")
                        final_feedback = motor_snapshot(motor, 1)
                    else:
                        final_feedback, prefetched_feedback = prefetched_feedback, None
                    self._cycle_process("arrived", point=point.name)
                    actual_angles = {str(axis): final_feedback["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2)}
                    next_point = planned_points[point_index] if point_index < len(planned_points) else anchor

                    def handoff(trigger):
                        nonlocal prefetched_feedback

                        def command_started():
                            with self.lock:
                                self._cycle_process("moving", point=next_point.name,
                                                    fromPoint=point.name)
                                trigger["motionCommandAt"] = time.time()
                                self.writer.manifest["pointCycle"]["handoff"].update(trigger)

                        reached, _, arrival = self._cycle_move_point(motor, cycle, next_point,
                                                                     on_command=command_started)
                        if not reached:
                            raise RuntimeError(f"换点 {next_point.name} 未完成两轴到位确认")
                        prefetched_feedback = arrival
                        with self.lock:
                            self._cycle_process("arrived", point=next_point.name)
                            trigger["arrivedAt"] = time.time()
                            if "motionCommandAt" in trigger:
                                trigger["actualMoveSeconds"] = trigger["arrivedAt"] - trigger["motionCommandAt"]
                            self.writer.manifest["pointCycle"]["handoff"].update(trigger)

                    with self.lock:
                        self.point_cycle["state"] = "capturing"
                    current_writer = self._capture_cycle_point(request, cycle, point, cycle_index,
                                                              point_index, receiver, actual_angles,
                                                              next_point, handoff,
                                                              keep_laser_on=cycle.keepLaserOnBetweenPoints)
                    with self.lock:
                        self.point_cycle["completedRecords"] += 1
                    self._cycle_update("ready", cycle=cycle_index, point=point_index,
                                       currentPoint=point.name,
                                       completedRecords=self.point_cycle["completedRecords"],
                                       plannedOrder=planned_names)
                    if cycle_index != cycle.cycles or point_index != len(cycle.points):
                        receiver = self.receiver_factory(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path))
                        receiver.validate()
                # Finish every circle at the first configured point.  This is
                # a positioning move only; it must not create a duplicate
                # measurement record for the anchor point.
                self._cycle_update("positioning", cycle=cycle_index,
                                   point=len(planned_points), currentPoint=f"回到起点 {anchor.name}",
                                   plannedOrder=planned_names)
                if prefetched_feedback is None:
                    self._cycle_process("returning", point=anchor.name)
                    reached, _, feedback = self._cycle_move_point(motor, cycle, anchor)
                    if not reached:
                        raise RuntimeError(f"未能回到循环起点 {anchor.name}")
                self._cycle_update("ready", cycle=cycle_index,
                                   point=len(planned_points), currentPoint=anchor.name,
                                   plannedOrder=planned_names)
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
            if cycle and cycle.keepLaserOnBetweenPoints and getattr(first_receiver, "supports_laser_persistence", False):
                try:
                    DevicePanel(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path)).run_command("laser_off")
                    self.observation_laser_ip = None
                except Exception as exc:
                    failures.append(f"采集结束关闭激光失败：{exc}")
            if motor:
                try:
                    motor.close(stop=False)
                except Exception as exc:
                    failures.append(f"关闭转盘串口失败：{exc}")
            with self.lock:
                self.capture_thread = None
                self.capture_stop = None
                cycle_state = "error" if failures else "cancelled" if cancelled else "complete"
                self.point_cycle = {**(self.point_cycle or {}), "state": cycle_state,
                                    "error": "; ".join(failures) or ("循环采集已停止" if cancelled else None)}
                self._cycle_process(cycle_state, error=self.point_cycle["error"])
                self.turntable_snapshot.update(state="error" if failures else "stopped",
                                               connected=False, error="; ".join(failures) or None)
                self.error = "; ".join(failures) or None
                self.state = "error" if failures else "idle"

    def _run(self, receiver, turntable=None) -> None:
        failure = None
        try:
            if turntable is not None:
                self._run_joint(receiver, turntable)
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
                    DevicePanel(ReceiverConfig(observation_ip, "", self.settings.dll_path)).run_command("laser_off")
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
            from serial.tools.list_ports import comports
            return {"ports": [{"port": port.device, "description": port.description}
                              for port in comports() if port.device.startswith("COM")]}
        except ImportError as exc:
            raise HTTPException(503, "采集服务缺少 pyserial，请更新服务包") from exc

    @app.post("/api/field/turntable")
    def turntable(request: TurntableRequest):
        return controller.turntable_operation(request)

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
