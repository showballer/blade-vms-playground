from __future__ import annotations

import asyncio
import copy
import hmac
import ipaddress
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
from .storage import DISPLAY_LIMIT, RecordingStore, empty_waveform
from .waveform import WaveformReader, make_wave
from .device import DevicePanel, WRITABLE
from .simulation import SimulationConfig, SimulationReceiver, simulation_catalog
from .turntable import (TurntableConfig, TurntableRequest, MotionGuard, TelemetryWriter,
                        DEFAULT_MOTOR_FACTORY, snapshot as motor_snapshot, require_ready,
                        start_motor, renew_motor, test_key)

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
    action: str = Field(pattern="^(read|set|autofocus)$")
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
                    "indexWarning": self.store.index_error}

    def turntable_operation(self, request: TurntableRequest):
        if request.action in ("stop", "test", "prepare") and not request.confirmMotion:
            raise HTTPException(422, "请明确确认试转/停止，或确认已观察到实际转动并完成设置")
        with self.lock:
            testing = self.test_thread and self.test_thread.is_alive()
            if testing and request.action == "stop":
                if (request.port, request.axis) != (self.turntable_snapshot.get("port"), self.turntable_snapshot.get("axis")):
                    raise HTTPException(409, "请停止当前试转的同一端口和轴")
                self.test_stop.set()
        if testing and request.action == "stop":
            return self._stop_turntable_test()
        if not self.operation_lock.acquire(blocking=False):
            raise HTTPException(409, "设备操作进行中，请等待完成")
        motor, handed_off = None, False
        try:
            with self.lock:
                if self.status()["receiver"]["running"]:
                    raise HTTPException(409, "联合采集期间由任务独占转盘；请使用停止并保存")
                self.turntable_busy = True
                self.turntable_preparation = None
            if request.action == "test":
                if self.motion_guard.warning:
                    raise RuntimeError(self.motion_guard.warning)
                with self.lock:
                    self.turntable_test = None
                    self.test_stop = threading.Event()
                    self.turntable_snapshot = {"state": "testing", "port": request.port, "axis": request.axis,
                                               "feedback": None, "config": request.config().model_dump()}
                    self.test_thread = threading.Thread(target=self._run_turntable_test, args=(request,),
                                                        name="blade-turntable-test", daemon=True)
                    self.test_thread.start()
                    handed_off = True
                return self.status()
            if request.action == "prepare":
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
            if request.action == "prepare":
                require_ready(feedback)
                with self.lock:
                    self.turntable_preparation = {"config": request.config().model_dump(), "checkedAt": time.time(),
                                                  "ready": True}
            if request.confirmRecovery or request.action == "stop":
                require_ready(feedback)
                identity = self.motion_guard.identity
                if self.motion_guard.warning and identity and identity != (request.port, request.axis):
                    raise RuntimeError("请选择上次未确认停止的同一端口和轴进行恢复")
                self.motion_guard.mark(request, False)
            with self.lock:
                self.turntable_snapshot = {"state": "prepared" if request.action == "prepare" else "checked", "port": request.port,
                                           "axis": request.axis, "feedback": feedback,
                                           "connected": False, "error": None}
            return self.status()
        except HTTPException:
            raise
        except Exception as exc:
            with self.lock:
                self.turntable_test = None
                self.turntable_snapshot = {"state": "error", "port": request.port, "axis": request.axis,
                                           "feedback": None, "error": str(exc)}
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
            started = time.monotonic()
            update("testing", effectiveRpm=effective)
            deviations = 0
            while not self.test_stop.is_set():
                renew_motor(motor, config)
                feedback = motor_snapshot(motor, config.axis)
                delta = feedback["positionRaw"] - first_position
                update("testing", feedback, positionDelta=delta)
                if feedback["alarmCode"] or feedback["limitFlags"] not in (None, 0):
                    raise RuntimeError("试转检测到报警或已反馈的限位异常")
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
                    if feedback["motorRpm"] != 0:
                        raise RuntimeError("停止后反馈仍非零速")
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
        if request.action == "autofocus" and not request.confirmLaser:
            raise HTTPException(422, "自动聚焦需要明确确认激光安全。")
        if not self.operation_lock.acquire(blocking=False):
            raise HTTPException(409, "设备操作进行中，请等待完成。")
        try:
            with self.lock:
                if self.status()["receiver"]["running"]:
                    raise HTTPException(409, "采集期间不可读取控制配置或修改设备，请先停止并保存。")
                self.device_busy = True
                # A failed/uncertain write must not leave old values marked as verified.
                self.device_snapshot = None
            panel = DevicePanel(ReceiverConfig(request.deviceIp, "", self.settings.dll_path))
            result = panel.run_command(request.action, request.key, request.value, request.expected)
            with self.lock:
                self.device_snapshot = result
                laser = result.get("fields", {}).get("laser", {})
                if result.get("deviceIp") == self.device_warning_ip and laser.get("supported") and laser.get("value") == 0:
                    self.device_warning = None
                    self.device_warning_ip = None
            return result
        except (OSError, RuntimeError, ValueError) as exc:
            if request.action != "read":
                with self.lock:
                    self.device_warning_ip = request.deviceIp
                    self.device_warning = f"设备 {request.deviceIp} 上次修改/聚焦未确认完成。请现场确认激光关闭，然后重新读取该设备配置；确认前禁止开始采集。"
            raise HTTPException(503, f"设备配置操作未确认完成：{exc}。请重新读取配置；异常时须现场确认激光已关闭。") from exc
        finally:
            with self.lock:
                self.device_busy = False
            self.operation_lock.release()

    def start(self, request: StartRequest) -> dict:
        with self.lock:
            if self.turntable_busy:
                raise HTTPException(409, "转盘检查/试转仍在进行，请先确认停稳并完成设置")
        with self.operation_lock:
            with self.lock:
                if self.device_warning and request.source == "polytec_ivs500":
                    raise HTTPException(409, self.device_warning)
                if request.turntable and self.motion_guard.warning:
                    raise HTTPException(409, self.motion_guard.warning)
                if request.turntable:
                    preparation = self.turntable_preparation
                    if not preparation or not preparation.get("ready") or preparation["config"] != request.turntable.model_dump():
                        raise HTTPException(409, "请先完成当前参数的转盘试转、停稳检查和设置确认")
                if self.status()["receiver"]["running"]:
                    raise HTTPException(409, "已有采集运行或正在收尾，请先停止。")
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
                                             "synchronization": "host_observation_only"}
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

    def _ready(self, rate: float, origin: float, receiver=None) -> None:
        with self.lock:
            if receiver is not None:
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
            # Persist before any motion. A crash/timeout cannot erase uncertainty.
            self.motion_guard.mark(config, True)
            attempted = True
            update("starting")
            effective = start_motor(motor, config, self.stop_event)
            if effective is None:
                return
            started = time.monotonic()
            update("awaiting_feedback", effectiveRpm=effective, commandAcceptedAt=time.time())
            event("accepted", effectiveRpm=effective)
            seen_running, deviations = False, 0
            while not self.stop_event.is_set():
                if capture_done.is_set():
                    raise RuntimeError("; ".join(capture_errors) or "采集意外退出")
                renew_motor(motor, config)
                feedback = motor_snapshot(motor, config.axis)
                if feedback["alarmCode"] or feedback["limitFlags"] not in (None, 0):
                    event("status", feedback=feedback)
                    update("error", feedback)
                    raise RuntimeError("转盘报警或限位触发/旁路")
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
