"""IVS-500 SDK adapter, derived from damage_detection/backend/app/polytec_receiver.py.

The SDK owns UDP decoding. Only explicit user-confirmed start runs this adapter.
No simulator, fallback samples, second vibration channel, or algorithm is included.
"""
from __future__ import annotations

import ctypes as C
import math
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

SUCCESS, TIMEOUT = 0, 2008
SENSOR_HEAD, VELOCITY_DECODER_DIGITAL, SIGNAL_PROCESSING = 2, 7, 18
VELOCITY, RSSI = 2, 3
DESTINATION_IP, LASER_ON, HEADROOM_DIGITAL_OUT = 90, 46, 224


@dataclass(frozen=True)
class ReceiverConfig:
    device_ip: str
    host_ip: str
    dll_path: str
    buffer_capacity: int = 1_000_000
    read_batch: int = 5_000
    timeout_ms: int = 1_000


@dataclass(frozen=True)
class Batch:
    sample_start: int
    sample_rate: float
    started_at: float
    velocity_raw: list[int]
    values: list[float]
    rssi_raw: list[int]
    rssi: list[float]
    overrange: list[bool]


class PolytecReceiver:
    supports_laser_persistence = True
    def __init__(self, config: ReceiverConfig):
        self.config = config
        self.api: Any = None
        self.communication = C.c_int()
        self.acquisition = C.c_int()
        self._dll_directory = None

    def validate(self) -> None:
        if not self.config.dll_path or not Path(self.config.dll_path).is_file():
            raise FileNotFoundError("未找到 Polytec DeviceCommunication.dll；请完成厂商 SDK 安装并配置 BLADE_POLYTEC_DLL。")
        if sys.platform != "win32" or C.sizeof(C.c_void_p) != 8:
            raise RuntimeError("真实设备采集要求 Windows x64 Python/服务及 x64 厂商 DLL。")

    def _load_api(self):
        self.validate()
        dll = Path(self.config.dll_path).resolve()
        if hasattr(os, "add_dll_directory"):
            self._dll_directory = os.add_dll_directory(str(dll.parent))
        try:
            api = C.CDLL(str(dll))
        except OSError as exc:
            raise RuntimeError("厂商 DLL 加载失败；检查 x64 位数、同目录依赖 DLL、厂商驱动和 VC++ 运行库。" + str(exc)) from exc
        definitions = {
            "PolyOpenUdpEthernetCommunication": ([C.POINTER(C.c_int), C.c_char_p, C.c_int], C.c_int),
            "PolyCloseCommunication": ([C.c_int], None),
            "PolyLastCommunicationStatus": ([C.POINTER(C.c_char), C.c_size_t], None),
            "PolySendGetString": ([C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_char), C.c_size_t], C.c_int),
            "PolySendGetFloat": ([C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_float)], C.c_int),
            "PolySendSetString": ([C.c_int, C.c_int, C.c_int, C.c_int, C.c_char_p], C.c_int),
            "PolyItemListGetCurrentItem": ([C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_char), C.c_size_t], C.c_int),
            "PolySendSetInt16": ([C.c_int, C.c_int, C.c_int, C.c_int, C.c_int16], C.c_int),
            "PolyOpenDataAcquisition": ([C.POINTER(C.c_int), C.c_int, C.c_size_t], C.c_int),
            "PolyCloseDataAcquisition": ([C.c_int], None),
            "PolyStartDataAcquisition": ([C.c_int], C.c_int),
            "PolyStopDataAcquisition": ([C.c_int], C.c_int),
            "PolyReadData": ([C.c_int, C.c_size_t, C.c_int], C.c_int),
            "PolyExtractedSampleCount": ([C.c_int, C.c_int, C.c_int, C.POINTER(C.c_size_t)], C.c_int),
            "PolyGetInt32Data": ([C.c_int, C.c_int, C.c_int, C.POINTER(C.c_int32), C.c_size_t], C.c_int),
            "PolyGetOverrange": ([C.c_int, C.c_int, C.c_int, C.POINTER(C.c_uint8), C.c_size_t], C.c_int),
            "PolyBaseSampleRateInHz": ([C.c_int, C.POINTER(C.c_double)], C.c_int),
            "PolyChannelMaxValue": ([C.c_int, C.c_int, C.POINTER(C.c_int32)], C.c_int),
        }
        for name, (arguments, result) in definitions.items():
            method = getattr(api, name)
            method.argtypes, method.restype = arguments, result
        return api

    def _check(self, code: int, operation: str) -> None:
        if code == SUCCESS:
            return
        message = C.create_string_buffer(2048)
        self.api.PolyLastCommunicationStatus(message, len(message))
        raise RuntimeError(f"{operation} failed ({code}): {message.value.decode(errors='replace')}")

    @staticmethod
    def _is_unsupported_destination_error(error: Exception) -> bool:
        text = str(error)
        return ("DAQ destination failed (5)" in text and
                ("Wrong attribute" in text or "wrong device command" in text.lower()))

    def _read_channel(self, channel: int) -> list[int]:
        count = C.c_size_t()
        self._check(self.api.PolyExtractedSampleCount(self.acquisition.value, channel, 0, C.byref(count)), "ExtractedSampleCount")
        if count.value > self.config.buffer_capacity:
            raise RuntimeError("SDK 返回的样本数超过采集缓冲容量。")
        if not count.value:
            return []
        values = (C.c_int32 * count.value)()
        self._check(self.api.PolyGetInt32Data(self.acquisition.value, channel, 0, values, count.value), "GetInt32Data")
        return list(values)

    def run(self, stop: threading.Event, ready: Callable, receive: Callable[[Batch], None],
            *, keep_laser_on: bool = False, abort: threading.Event | None = None) -> None:
        communication_open = acquisition_open = laser_attempted = False
        failure: Exception | None = None
        cleanup_errors: list[str] = []
        try:
            self.api = self._load_api()
            if stop.is_set():
                return
            self._check(self.api.PolyOpenUdpEthernetCommunication(C.byref(self.communication), self.config.device_ip.encode("ascii"), 6000), "Open UDP")
            communication_open = True
            destination_warning = None
            destination = C.create_string_buffer(256)
            try:
                self._check(self.api.PolySendGetString(self.communication.value, SIGNAL_PROCESSING, 0, DESTINATION_IP, destination, len(destination)), "Get DAQ destination")
                if destination.value.decode(errors="replace") != self.config.host_ip:
                    self._check(self.api.PolySendSetString(self.communication.value, SIGNAL_PROCESSING, 0, DESTINATION_IP, self.config.host_ip.encode("ascii")), "Set DAQ destination")
            except RuntimeError as exc:
                if not self._is_unsupported_destination_error(exc):
                    raise
                # Some older firmware rejects GET/SET attribute 90 although the
                # SDK exposes it. Do not prevent a compatibility capture: try a
                # direct SET, then continue if the same unsupported-command error
                # is returned. UDP reception remains the authoritative check.
                destination_warning = str(exc)
                try:
                    self._check(self.api.PolySendSetString(self.communication.value, SIGNAL_PROCESSING, 0, DESTINATION_IP, self.config.host_ip.encode("ascii")), "Set DAQ destination")
                except RuntimeError as set_error:
                    if not self._is_unsupported_destination_error(set_error):
                        raise
                    destination_warning = f"{destination_warning}; {set_error}"
            self._check(self.api.PolyOpenDataAcquisition(C.byref(self.acquisition), self.communication.value, self.config.buffer_capacity), "Open acquisition")
            acquisition_open = True
            self._check(self.api.PolyStopDataAcquisition(self.acquisition.value), "Initial stop")
            rate, velocity_max, rssi_max = C.c_double(), C.c_int32(), C.c_int32()
            self._check(self.api.PolyBaseSampleRateInHz(self.acquisition.value, C.byref(rate)), "Get sample rate")
            self._check(self.api.PolyChannelMaxValue(self.acquisition.value, VELOCITY, C.byref(velocity_max)), "Get velocity max")
            self._check(self.api.PolyChannelMaxValue(self.acquisition.value, RSSI, C.byref(rssi_max)), "Get RSSI max")
            if not math.isfinite(rate.value) or rate.value <= 0 or velocity_max.value <= 0 or rssi_max.value <= 0:
                raise RuntimeError("SDK 返回无效采样率或通道量程。")
            range_buffer = C.create_string_buffer(256)
            self._check(self.api.PolyItemListGetCurrentItem(self.communication.value, VELOCITY_DECODER_DIGITAL, 0, 10, range_buffer, len(range_buffer)), "Get velocity range")
            range_text = range_buffer.value.decode(errors="replace")
            match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(mm/s|um/s|µm/s|m/s)", range_text, re.IGNORECASE)
            if not match:
                raise RuntimeError(f"无法解析设备速度量程：{range_text!r}")
            headroom = C.c_float()
            self._check(self.api.PolySendGetFloat(self.communication.value, VELOCITY_DECODER_DIGITAL, 0, HEADROOM_DIGITAL_OUT, C.byref(headroom)), "Get headroom")
            scale = headroom.value * float(match.group(1)) * {"m/s": 1, "mm/s": 1e-3, "um/s": 1e-6}[match.group(2).lower().replace("µ", "u")]
            if not math.isfinite(scale) or scale <= 0:
                raise RuntimeError("SDK 返回无效速度换算系数。")
            self.velocity_range_mps = scale / headroom.value
            # Record read-back settings for later comparison. This is read-only;
            # optional unsupported commands never substitute invented defaults.
            from .device import DevicePanel
            try:
                panel = DevicePanel(self.config)
                panel.api, panel.communication = self.api, self.communication
                panel.bind_api(self.api)
                self.device_settings = panel.snapshot()
            except (AttributeError, RuntimeError, ValueError) as exc:
                self.device_settings = {"deviceIp": self.config.device_ip, "readAt": time.time(),
                                        "source": "unavailable", "fields": {}, "error": str(exc)}
            if destination_warning:
                self.device_settings = {**getattr(self, "device_settings", {}),
                                        "daqDestination": {"requestedHostIp": self.config.host_ip,
                                                            "status": "firmware_unsupported",
                                                            "warning": destination_warning}}
            if stop.is_set():
                return
            # Treat a timed-out laser command as uncertain, not success; cleanup still turns it off.
            laser_attempted = True
            self._check(self.api.PolySendSetInt16(self.communication.value, SENSOR_HEAD, 0, LASER_ON, C.c_int16(1)), "Laser on")
            self._check(self.api.PolyStartDataAcquisition(self.acquisition.value), "Start acquisition")
            origin = time.time()
            ready(rate.value, origin)
            sample_index, last_sample_at = 0, time.monotonic()
            while not stop.is_set():
                code = self.api.PolyReadData(self.acquisition.value, self.config.read_batch, self.config.timeout_ms)
                if code != TIMEOUT:
                    self._check(code, "Read data")
                    raw, rssi_raw = self._read_channel(VELOCITY), self._read_channel(RSSI)
                    if raw:
                        flags = (C.c_uint8 * len(raw))()
                        self._check(self.api.PolyGetOverrange(self.acquisition.value, VELOCITY, 0, flags, len(raw)), "Get overrange")
                        receive(Batch(sample_index, rate.value, origin, raw,
                                      [value * scale / velocity_max.value for value in raw],
                                      rssi_raw, [100.0 * value / rssi_max.value for value in rssi_raw],
                                      [bool(flag) for flag in flags]))
                        sample_index += len(raw)
                        last_sample_at = time.monotonic()
                if time.monotonic() - last_sample_at > 10:
                    raise TimeoutError("连续 10 秒未收到有效振动样本；已停止采集，请检查设备、网卡和防火墙。")
        except Exception as exc:
            failure = exc
        finally:
            def cleanup(call, label):
                try:
                    result = call()
                    if result is not None:
                        self._check(result, label)
                except Exception as exc:
                    cleanup_errors.append(str(exc))
            if self.api and acquisition_open:
                cleanup(lambda: self.api.PolyStopDataAcquisition(self.acquisition.value), "Stop acquisition")
            if self.api and communication_open and laser_attempted and not (keep_laser_on and not failure and not cleanup_errors and not (abort and abort.is_set())):
                cleanup(lambda: self.api.PolySendSetInt16(self.communication.value, SENSOR_HEAD, 0, LASER_ON, C.c_int16(0)), "Laser off (please verify physically)")
            if self.api and acquisition_open:
                cleanup(lambda: self.api.PolyCloseDataAcquisition(self.acquisition.value), "Close acquisition")
            if self.api and communication_open:
                cleanup(lambda: self.api.PolyCloseCommunication(self.communication.value), "Close communication")
            self.api = None
            if self._dll_directory:
                self._dll_directory.close()
                self._dll_directory = None
            if failure or cleanup_errors:
                raise RuntimeError("; ".join(([str(failure)] if failure else []) + cleanup_errors)) from failure
