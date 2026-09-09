from __future__ import annotations

import asyncio
import copy
import hmac
import ipaddress
import os
import threading
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool, field_validator

from .receiver import Batch, PolytecReceiver, ReceiverConfig
from .storage import DISPLAY_LIMIT, RecordingStore, empty_waveform


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


class AcquisitionController:
    def __init__(self, settings: Settings, receiver_factory=PolytecReceiver):
        self.settings = settings
        self.store = RecordingStore(settings.data_dir / "recordings")
        self.receiver_factory = receiver_factory
        self.lock = threading.RLock()
        self.operation_lock = threading.Lock()
        self.state, self.error = "idle", None
        self.writer = None
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.device_ip = self.host_ip = ""
        self.rows: deque = deque(maxlen=DISPLAY_LIMIT)

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
                    "indexWarning": self.store.index_error}

    def frame(self) -> dict:
        with self.lock:
            status = self.status()
            wave = empty_waveform()
            if self.rows:
                rows = list(self.rows)
                wave.update(sampleRate=status["receiver"]["sampleRate"], sampleStart=rows[0][0],
                            values=[row[1] for row in rows], rssi=[row[2] for row in rows],
                            overrange=[row[3] for row in rows])
            return {**status, "waveform": wave}

    def start(self, request: StartRequest) -> dict:
        with self.operation_lock:
            with self.lock:
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

    def _ready(self, rate: float, origin: float) -> None:
        with self.lock:
            self.writer.ready(rate, origin)
            if not self.stop_event.is_set():
                self.state = "acquiring"

    def _receive(self, batch: Batch) -> None:
        with self.lock:
            self.writer.write(batch)
            # This is a display window, never the source for raw persistence.
            offset = max(0, len(batch.values) - DISPLAY_LIMIT)
            self.rows.extend((batch.sample_start + index, batch.values[index],
                              batch.rssi[index] if index < len(batch.rssi) else None,
                              batch.overrange[index]) for index in range(offset, len(batch.values)))

    def _run(self, receiver) -> None:
        failure = None
        try:
            receiver.run(self.stop_event, self._ready, self._receive)
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
    def frame():
        return controller.frame()

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
