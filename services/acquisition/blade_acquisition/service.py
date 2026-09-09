from __future__ import annotations

import asyncio
import copy
import hmac
import ipaddress
import math
import os
import threading
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool, field_validator

from .receiver import Batch, PolytecReceiver, ReceiverConfig
from .storage import DISPLAY_LIMIT, RecordingStore, empty_waveform
from .waveform import WaveformReader, make_wave
from .device import DevicePanel, WRITABLE


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
    deviceIp: str = Field(min_length=7, max_length=15)
    hostIp: str = Field(min_length=7, max_length=15)
    name: str = Field(min_length=1, max_length=120)
    object: str = Field(default="", max_length=120)
    turbine: str = Field(default="", max_length=120)
    point: str = Field(default="", max_length=120)
    confirmLaser: StrictBool

    @field_validator("deviceIp", "hostIp")
    @classmethod
    def valid_address(cls, value: str) -> str:
        address = ipaddress.IPv4Address(value)
        if address.is_unspecified or address.is_multicast or address.is_loopback or address.is_reserved:
            raise ValueError("设备和本机网卡必须是有效的非回环 IPv4 地址。")
        return str(address)

    @field_validator("confirmLaser")
    @classmethod
    def explicit_laser_permission(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("必须确认激光安全及允许修改设备 DAQ 目标后才能开始。")
        return value

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
    def __init__(self, settings: Settings, receiver_factory=PolytecReceiver):
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

    def status(self) -> dict:
        with self.lock:
            return {"state": self.state, "error": self.error,
                    "receiver": {"source": "polytec_ivs500", "running": bool(self.thread and self.thread.is_alive()),
                                 "deviceIp": self.device_ip, "hostIp": self.host_ip, "dataPort": 60113,
                                 "sampleRate": self.writer.manifest["sampleRate"] if self.writer else None,
                                 "channels": ["CH1", "RSSI1"],
                                 "dllAvailable": bool(self.settings.dll_path and Path(self.settings.dll_path).is_file()),
                                 "dataLossAssessment": "unverified"},
                    "recording": copy.deepcopy(self.writer.manifest) if self.writer else None,
                    "deviceBusy": self.device_busy,
                    "deviceWarning": self.device_warning,
                    "deviceSettings": copy.deepcopy(self.device_snapshot),
                    "indexWarning": self.store.index_error}

    def frame(self, window_ms=None) -> dict:
        with self.lock:
            status = self.status()
            rate = status["receiver"]["sampleRate"]
            size = min(250_000, max(1, math.ceil(rate * window_ms / 1000))) if rate and window_ms else DISPLAY_LIMIT
            rows = list(self.rows)[-size:]
            origin = self.writer.manifest.get("sampleOrigin") if self.writer else None
        wave = make_wave(rows, rate, origin)
        return {**status, "waveform": wave}

    def configure_device(self, request: DeviceRequest):
        if request.action == "set" and (not request.confirmChange or request.key not in WRITABLE):
            raise HTTPException(422, "请明确确认修改支持的配置项。")
        if request.action == "autofocus" and not request.confirmLaser:
            raise HTTPException(422, "自动聚焦需要明确确认激光安全。")
        if not self.operation_lock.acquire(blocking=False):
            raise HTTPException(409, "设备操作进行中，请等待完成。")
        try:
            with self.lock:
                if self.thread and self.thread.is_alive():
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
        with self.operation_lock:
            with self.lock:
                if self.device_warning:
                    raise HTTPException(409, self.device_warning)
                if self.thread and self.thread.is_alive():
                    raise HTTPException(409, "已有采集运行或正在收尾，请先停止。")
                receiver = self.receiver_factory(ReceiverConfig(request.deviceIp, request.hostIp, self.settings.dll_path))
                try:
                    receiver.validate()
                except (OSError, RuntimeError) as exc:
                    self.state, self.error = "error", str(exc)
                    raise HTTPException(503, str(exc)) from exc
                metadata = request.model_dump(exclude={"confirmLaser"})
                try:
                    self.writer = self.store.create(metadata)
                except OSError as exc:
                    self.state, self.error = "error", f"无法创建本地采集记录：{exc}"
                    raise HTTPException(507, self.error) from exc
                self.device_ip, self.host_ip = request.deviceIp, request.hostIp
                self.rows.clear()
                self.stop_event.clear()
                self.state, self.error = "starting", None
                self.thread = threading.Thread(target=self._run, args=(receiver,), name="blade-polytec", daemon=True)
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

    def _run(self, receiver) -> None:
        failure = None
        try:
            receiver.run(self.stop_event, lambda rate, origin: self._ready(rate, origin, receiver), self._receive)
        except Exception as exc:
            failure = str(exc)
            self.stop_event.set()
        finally:
            with self.lock:
                failure = failure or self.error
                try:
                    self.writer.finish(failure)
                except Exception as exc:
                    failure = f"{failure + '; ' if failure else ''}采集数据收尾失败：{exc}"
                self.error = failure
                self.state = "error" if failure else "idle"

    def stop(self) -> dict:
        with self.lock:
            if self.device_busy:
                raise HTTPException(409, "设备配置/聚焦仍在进行，请等待完成并现场确认激光状态。")
        with self.operation_lock:
            with self.lock:
                thread = self.thread
                if not thread or not thread.is_alive():
                    return self.status()
                self.state = "stopping"
                self.stop_event.set()
            thread.join(timeout=20)
            if thread.is_alive():
                with self.lock:
                    self.state = "error"
                    self.error = "采集线程未在 20 秒内退出，记录仍未完成；请确认设备激光已关闭并检查 SDK。"
                raise HTTPException(503, self.error)
            return self.status()


def create_app(settings: Settings, receiver_factory=PolytecReceiver) -> FastAPI:
    controller = AcquisitionController(settings, receiver_factory)

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

    @app.get("/api/field/frame")
    def frame(window_ms: int | None = Query(default=None, ge=1, le=1000)):
        return controller.frame(window_ms)

    @app.post("/api/field/device")
    def device(request: DeviceRequest):
        return controller.configure_device(request)

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
                await socket.send_json(controller.frame())
                await asyncio.sleep(0.25)
        except (WebSocketDisconnect, RuntimeError):
            return

    return app
