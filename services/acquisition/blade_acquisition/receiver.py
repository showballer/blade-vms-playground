"""Polytec IVS-500 / VibroFlex SDK adapter.

The SDK owns UDP/TCP decoding. Only explicit user-confirmed start runs this adapter.
No simulator, fallback samples, second vibration channel, or algorithm is included.
"""
from __future__ import annotations

import ctypes as C
import math
import os
import queue
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
CONTROLLER, DAQ_PROTOCOL, PACKAGE_VERSION = 1, 592, 816
DAQ_SAMPLE_RATE, DAQ_MODE, DAQ_BASE_SAMPLE_RATE = 918, 920, 986
DAQ_ACTIVE_CHANNELS = 978
IQ_MODE, STARTUP_VALUE = 1058, 32


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
    # One original RSSI sample per N velocity samples (VFX base sample format).
    # Keep the original RSSI array sparse; repeating it would fabricate samples.
    rssi_sample_stride: int = 1

    def rssi_at(self, velocity_index: int) -> float | None:
        if velocity_index % self.rssi_sample_stride:
            return None
        index = velocity_index // self.rssi_sample_stride
        return self.rssi[index] if index < len(self.rssi) else None


class PolytecReceiver:
    supports_laser_persistence = True
    supports_reusable_session = True
    supports_continuous_session = True
    def __init__(self, config: ReceiverConfig):
        self.config = config
        self.api: Any = None
        self.communication = C.c_int()
        self.acquisition = C.c_int()
        self._dll_directory = None
        self.laser_observer = None
        self.laser_status = None
        self._laser_monitor_communication = None
        self._laser_monitor_failed = False
        self.reuse_session = False
        self._stream_context = None
        self._communication_open = self._acquisition_open = False
        self._daq_start_attempted = self._laser_attempted = False
        self._active_lock = threading.Lock()
        self._active_requests = queue.Queue()
        self._active_owner = None
        self._active_accepting = False

    def _request_active(self, operation: str, timeout: float):
        """Submit work to the DAQ owner, never call the SDK concurrently."""
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("连续采集请求超时必须是正数")
        request = {"operation": operation, "done": threading.Event(),
                   "deadline": time.monotonic() + timeout, "cancelled": False,
                   "queuedMonotonicNs": time.monotonic_ns()}
        with self._active_lock:
            if not self._active_accepting:
                raise RuntimeError("连续采集尚未启动或已经停止")
            if self._active_owner == threading.get_ident():
                raise RuntimeError("不能在采集回调内同步请求采集屏障")
            self._active_requests.put(request)
        if not request["done"].wait(timeout):
            request["cancelled"] = True
            raise TimeoutError("连续采集状态确认超时；未确认新的采集边界")
        if "error" in request:
            raise RuntimeError(str(request["error"])) from request["error"]
        return request["result"]

    def confirm_active_laser(self, *, timeout: float = 3.0):
        """Fresh ON readback on the owner thread; never enables an OFF laser."""
        return self._request_active("laser", timeout)

    def set_active_laser(self, enabled: bool, *, timeout: float = 3.0):
        """Diagnostic stationary/motion policy; caller must close the blade gate."""
        if type(enabled) is not bool:
            raise ValueError("Laser target must be boolean")
        return self._request_active("laser_on" if enabled else "laser_off", timeout)

    def require_continuous_support(self):
        """Check the loaded library before allowing the first positioning move."""
        if not all(callable(getattr(self.api, name, None)) for name in
                   ("PolyAvailableSamples", "PolyReadAvailableData")):
            raise RuntimeError("当前 SDK 不支持连续采集缓存边界确认，请更新本机 Polytec SDK")

    def fence_active_samples(self, *, timeout: float = 3.0):
        """Drain existing SDK samples before admitting a new stationary point.

        Drained samples still go through ``receive`` for full raw preservation.
        The caller must keep its detector disabled until the returned sampleIndex.
        This drains the SDK ring, not data still in the device/network; a fresh
        arrival transient rejection is still needed before a new entry edge.
        """
        return self._request_active("fence", timeout)

    def _end_active_requests(self, error):
        with self._active_lock:
            self._active_accepting = False
            self._active_owner = None
            while True:
                try:
                    request = self._active_requests.get_nowait()
                except queue.Empty:
                    break
                request["error"] = error
                request["done"].set()

    def validate(self) -> None:
        if not self.config.dll_path or not Path(self.config.dll_path).is_file():
            raise FileNotFoundError("未找到 Polytec SDK 动态库；请在设备与服务中选择本机 SDK，或配置 BLADE_POLYTEC_DLL。")
        extension = {"win32": ".dll", "darwin": ".dylib", "linux": ".so"}.get(sys.platform)
        if extension is None or C.sizeof(C.c_void_p) != 8:
            raise RuntimeError("真实设备采集需要受支持的 64 位系统、Python 及同架构厂商 SDK。")
        if Path(self.config.dll_path).suffix.lower() != extension:
            raise RuntimeError(f"当前系统需要 {extension} 原生 SDK；Windows DLL 不能直接在 macOS 或 Linux 中加载。")

    def _load_api(self):
        self.validate()
        dll = Path(self.config.dll_path).resolve()
        if hasattr(os, "add_dll_directory"):
            self._dll_directory = os.add_dll_directory(str(dll.parent))
        try:
            api = C.CDLL(str(dll))
        except OSError as exc:
            if self._dll_directory:
                self._dll_directory.close()
                self._dll_directory = None
            raise RuntimeError("厂商 SDK 加载失败；请检查操作系统、处理器架构及动态库依赖是否匹配。" + str(exc)) from exc
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
            "PolyHasCommand": ([C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_bool)], C.c_int),
            "PolySendGetInt16": ([C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_int16)], C.c_int),
            "PolySendGetInt32": ([C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_int32)], C.c_int),
            "PolyItemListGetAvailableItems": ([C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_char), C.c_size_t], C.c_int),
            "PolyItemListSetCurrentItem": ([C.c_int, C.c_int, C.c_int, C.c_int, C.c_char_p], C.c_int),
            "PolyChannelActivationIsChannelAvailable": ([C.c_int, C.c_int, C.c_int, C.POINTER(C.c_bool)], C.c_int),
            "PolyChannelActivationIsChannelEnabled": ([C.c_int, C.c_int, C.c_int, C.POINTER(C.c_bool)], C.c_int),
            "PolyChannelActivationEnableChannel": ([C.c_int, C.c_int, C.c_int], C.c_int),
            "PolySendGetWithTag": ([C.c_int, C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_int)], C.c_int),
            "PolyGetInt16FromPayload": ([C.c_int, C.POINTER(C.c_int16), C.POINTER(C.c_size_t), C.c_size_t], C.c_int),
            "PolyFreePayload": ([C.c_int], None),
        }
        for name, (arguments, result) in definitions.items():
            method = getattr(api, name)
            method.argtypes, method.restype = arguments, result
        # Native C API, documented in PolyDataAcquisition.h. Older SDKs can
        # still perform ordinary recordings, but cannot grant a continuous
        # stationary boundary without these nonblocking ring-buffer methods.
        for name, arguments in {
            "PolyAvailableSamples": [C.c_int, C.POINTER(C.c_size_t)],
            "PolyReadAvailableData": [C.c_int, C.c_size_t, C.POINTER(C.c_size_t)],
        }.items():
            method = getattr(api, name, None)
            if method is not None:
                method.argtypes, method.restype = arguments, C.c_int
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

    def _has_command(self, device: int, command: int) -> bool:
        value = C.c_bool()
        self._check(self.api.PolyHasCommand(self.communication.value, device, 0, command, C.byref(value)), "Check DAQ capability")
        return value.value

    def _integer(self, device: int, command: int, *, wide: bool = False) -> int:
        value = C.c_int32() if wide else C.c_int16()
        function = self.api.PolySendGetInt32 if wide else self.api.PolySendGetInt16
        self._check(function(self.communication.value, device, 0, command, C.byref(value)), f"Read device command {command}")
        return value.value

    def _check_iq_mode(self) -> None:
        if not self._has_command(CONTROLLER, IQ_MODE):
            return
        # The regular IQ setting takes effect only after reboot. Read StartUpValue,
        # as the vendor example does, rather than mistaking the pending setting.
        handle, count, value = C.c_int(), C.c_size_t(), C.c_int16()
        try:
            self._check(self.api.PolySendGetWithTag(self.communication.value, CONTROLLER, 0, IQ_MODE,
                                                  STARTUP_VALUE, C.byref(handle)), "Read active IQ mode")
            self._check(self.api.PolyGetInt16FromPayload(handle.value, C.byref(value), C.byref(count), 1), "Read IQ payload")
            if count.value != 1 or value.value != 0:
                raise RuntimeError("设备处于 IQ 原始信号模式，不能按速度波形解释；请关闭 IQ 并重启设备后重试。")
        finally:
            if handle.value:
                self.api.PolyFreePayload(handle.value)

    def _prepare_streaming(self) -> None:
        if self._has_command(SIGNAL_PROCESSING, DAQ_MODE):
            value, available = C.create_string_buffer(256), C.create_string_buffer(2048)
            self._check(self.api.PolyItemListGetCurrentItem(self.communication.value, SIGNAL_PROCESSING, 0,
                                                           DAQ_MODE, value, len(value)), "Read DAQ mode")
            if value.value != b"Streaming":
                self._check(self.api.PolyItemListGetAvailableItems(self.communication.value, SIGNAL_PROCESSING, 0,
                                                                  DAQ_MODE, available, len(available)), "Read available DAQ modes")
                if "Streaming" not in [item.strip() for item in available.value.decode().split(",")]:
                    raise RuntimeError("设备当前不支持连续采集模式。")
                self._check(self.api.PolyItemListSetCurrentItem(self.communication.value, SIGNAL_PROCESSING, 0,
                                                               DAQ_MODE, b"Streaming"), "Set streaming mode")
                self._check(self.api.PolyItemListGetCurrentItem(self.communication.value, SIGNAL_PROCESSING, 0,
                                                               DAQ_MODE, value, len(value)), "Verify streaming mode")
                if value.value != b"Streaming":
                    raise RuntimeError("连续采集模式读回不一致，未启动采集。")
        for channel in (VELOCITY, RSSI):
            available, enabled = C.c_bool(), C.c_bool()
            self._check(self.api.PolyChannelActivationIsChannelAvailable(self.communication.value, channel, 0,
                                                                        C.byref(available)), "Check DAQ channel")
            if not available.value:
                raise RuntimeError(f"设备未提供必需的采集通道 {channel}/0。")
            self._check(self.api.PolyChannelActivationIsChannelEnabled(self.communication.value, channel, 0,
                                                                      C.byref(enabled)), "Read active DAQ channel")
            if not enabled.value:
                if not self._has_command(SIGNAL_PROCESSING, DAQ_ACTIVE_CHANNELS):
                    raise RuntimeError(f"采集通道 {channel}/0 未启用，且设备不支持单通道启用；请先在设备上选择速度输出。")
                self._check(self.api.PolyChannelActivationEnableChannel(self.communication.value, channel, 0), "Enable DAQ channel")
                self._check(self.api.PolyChannelActivationIsChannelEnabled(self.communication.value, channel, 0,
                                                                          C.byref(enabled)), "Verify DAQ channel")
                if not enabled.value:
                    raise RuntimeError(f"采集通道 {channel}/0 启用后未获确认。")

    def _sample_timing(self, base_rate: float) -> tuple[float, int]:
        has_rate = self._has_command(SIGNAL_PROCESSING, DAQ_SAMPLE_RATE)
        has_base = self._has_command(SIGNAL_PROCESSING, DAQ_BASE_SAMPLE_RATE)
        if has_rate != has_base or (self.protocol == 4 and not has_rate):
            raise RuntimeError("设备缺少完整的采样时标信息，不能确定速度与 RSSI 的对应关系。")
        if not has_rate:
            return base_rate, 1  # SDK's documented fixed-rate IVS/VGO protocols.
        rate = self._integer(SIGNAL_PROCESSING, DAQ_SAMPLE_RATE, wide=True)
        reported_base = self._integer(SIGNAL_PROCESSING, DAQ_BASE_SAMPLE_RATE, wide=True)
        if reported_base <= 0 or reported_base != base_rate or rate < reported_base or rate % reported_base:
            raise RuntimeError("设备返回的速度采样率与 RSSI 基率不一致。")
        stride = rate // reported_base
        if stride > 100_000:
            raise RuntimeError("设备采样倍率超过可处理范围。")
        return float(rate), stride

    def _set_laser(self, enabled: bool) -> None:
        label = "Laser on" if enabled else "Laser off (please verify physically)"
        try:
            self._check(self.api.PolySendSetInt16(self.communication.value, SENSOR_HEAD, 0, LASER_ON, C.c_int16(int(enabled))), label)
            actual = self._integer(SENSOR_HEAD, LASER_ON)
            if actual != int(enabled):
                raise RuntimeError(f"{label}: 激光状态读回未确认。")
            self._publish_laser(actual)
        except Exception as exc:
            self._publish_laser(None, str(exc))
            raise

    def _publish_laser(self, value, error=None):
        field = {"supported": value in (0, 1), **({"value": value} if value in (0, 1) else {})}
        if error:
            field["error"] = error
        observed_at = time.time()
        snapshot = {"deviceIp": self.config.device_ip, "readAt": observed_at if field["supported"] else None,
                    "observedAt": observed_at,
                    "fields": {"laser": field}, "source": "device-readback" if field["supported"] else "unavailable"}
        self.laser_status = snapshot
        if self.laser_observer is not None:
            self.laser_observer(snapshot)

    def _read_laser_monitor(self):
        if self._laser_monitor_communication is None:
            handle = C.c_int()
            self._check(self.api.PolyOpenUdpEthernetCommunication(C.byref(handle), self.config.device_ip.encode("ascii"), 500),
                        "Open laser monitor communication")
            self._laser_monitor_communication = handle
        result = C.c_int16()
        self._check(self.api.PolySendGetInt16(self._laser_monitor_communication.value, SENSOR_HEAD, 0,
                                            LASER_ON, C.byref(result)), "Read laser monitor")
        if result.value not in (0, 1):
            raise ValueError("设备返回无效激光状态")
        self._publish_laser(result.value)
        return self.laser_status

    def _observe_laser(self):
        """The DAQ owner alone uses a separate, short-timeout read-only handle.

        The DAQ communication has a 6s command timeout and cannot be changed
        through the vendor C API. A monitor timeout must not repeat and stall
        the sample stream, so one failure disables monitoring for this run.
        """
        if self._laser_monitor_failed:
            return
        try:
            self._read_laser_monitor()
        except (OSError, RuntimeError, ValueError) as exc:
            self._laser_monitor_failed = True
            error = str(exc)
            try:
                self._close_laser_monitor()
            except (OSError, RuntimeError, ValueError) as close_error:
                error += f"；关闭状态读取连接失败：{close_error}"
            self._publish_laser(None, error)

    def _close_laser_monitor(self):
        handle, self._laser_monitor_communication = self._laser_monitor_communication, None
        if handle is not None:
            self.api.PolyCloseCommunication(handle.value)

    def _read_channel(self, channel: int, maximum: int) -> list[int]:
        count = C.c_size_t()
        self._check(self.api.PolyExtractedSampleCount(self.acquisition.value, channel, 0, C.byref(count)), "ExtractedSampleCount")
        if count.value > maximum:
            raise RuntimeError("SDK 返回的样本数超过采集缓冲容量。")
        if not count.value:
            return []
        values = (C.c_int32 * count.value)()
        self._check(self.api.PolyGetInt32Data(self.acquisition.value, channel, 0, values, count.value), "GetInt32Data")
        return list(values)

    def prepare_session(self, cancelled=lambda: False):
        """Open/configure once on either native SDK, without laser writes or DAQ start.

        The cycle owner serializes preparation, station runs, and final close.
        A retained session never grants motion permission or restores a run.
        """
        if self._stream_context is not None or cancelled():
            return
        try:
            self.api = self._load_api()
            if cancelled():
                return
            self._check(self.api.PolyOpenUdpEthernetCommunication(C.byref(self.communication), self.config.device_ip.encode("ascii"), 6000), "Open UDP")
            self._communication_open = True
            self.protocol = self._integer(SIGNAL_PROCESSING, DAQ_PROTOCOL)
            if self.protocol not in (3, 4, 5, 30):
                raise RuntimeError(f"当前 SDK 未支持此采集协议：{self.protocol}。")
            self._check_iq_mode()
            if not self._has_command(SENSOR_HEAD, LASER_ON):
                raise RuntimeError("设备未提供可确认状态的激光开关接口。")
            # Match SDK CreateDigitalDataAcquisition's transport selection.
            transport = "tcp" if self._has_command(CONTROLLER, PACKAGE_VERSION) else "udp"
            destination_warning = None
            destination = C.create_string_buffer(256)
            try:
                if transport == "udp" and self._has_command(SIGNAL_PROCESSING, DESTINATION_IP):
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
            # The SDK allocates capacity * baseSampleSize bytes. Bound its ring
            # buffer in velocity samples too; a VFX base sample may contain many
            # velocity samples and must not multiply the requested memory budget.
            anticipated_stride = 1
            if self._has_command(SIGNAL_PROCESSING, DAQ_BASE_SAMPLE_RATE):
                _, anticipated_stride = self._sample_timing(float(self._integer(SIGNAL_PROCESSING, DAQ_BASE_SAMPLE_RATE, wide=True)))
            elif self.protocol == 4:
                raise RuntimeError("VFX 设备未提供采样基率，未启动采集。")
            buffer_base_samples = max(1, self.config.buffer_capacity // anticipated_stride)
            self._check(self.api.PolyOpenDataAcquisition(C.byref(self.acquisition), self.communication.value, buffer_base_samples), "Open acquisition")
            self._acquisition_open = True
            self._check(self.api.PolyStopDataAcquisition(self.acquisition.value), "Initial stop")
            self._prepare_streaming()
            rate, velocity_max, rssi_max = C.c_double(), C.c_int32(), C.c_int32()
            self._check(self.api.PolyBaseSampleRateInHz(self.acquisition.value, C.byref(rate)), "Get sample rate")
            self._check(self.api.PolyChannelMaxValue(self.acquisition.value, VELOCITY, C.byref(velocity_max)), "Get velocity max")
            self._check(self.api.PolyChannelMaxValue(self.acquisition.value, RSSI, C.byref(rssi_max)), "Get RSSI max")
            if not math.isfinite(rate.value) or rate.value <= 0 or velocity_max.value <= 0 or rssi_max.value <= 0:
                raise RuntimeError("SDK 返回无效采样率或通道量程。")
            sample_rate, rssi_stride = self._sample_timing(rate.value)
            if rssi_stride != anticipated_stride:
                raise RuntimeError("配置过程中采样倍率发生变化，未启动采集。")
            # PolyReadData counts base samples, not velocity samples. Keep each
            # batch bounded in both time and memory even at a high VFX multiplier.
            read_base_samples = max(1, min(self.config.read_batch // rssi_stride,
                                          int(rate.value * min(0.05, self.config.timeout_ms / 2000)),
                                          buffer_base_samples))
            self.acquisition_metadata = {
                "daqProtocolType": self.protocol, "dataTransport": transport, "dataPort": 60113,
                "baseSampleRate": rate.value, "rssiSampleRate": rate.value,
                "rssiSampleStride": rssi_stride,
                "rssiAlignment": "one original RSSI sample at each base-sample boundary; intervening velocity samples have no RSSI sample",
            }
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
            self.acquisition_metadata.update(velocityRangeMps=self.velocity_range_mps,
                                             velocityRawMax=velocity_max.value, rssiRawMax=rssi_max.value,
                                             headroomDigitalOut=headroom.value)
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
            if cancelled():
                return
            self._stream_context = (sample_rate, rssi_stride, read_base_samples, scale, velocity_max.value, rssi_max.value)
            self._session_range_text = range_text
            self._session_headroom = headroom.value
        except Exception:
            self.close_session(keep_laser_on=True)
            raise

    def _verify_session_format(self):
        # Reuse the transport and channel decoder, never stale physical units.
        # A change by the front panel/another application requires a new task.
        base = C.c_double()
        self._check(self.api.PolyBaseSampleRateInHz(self.acquisition.value, C.byref(base)), "Check base sample rate")
        rate, stride = self._sample_timing(base.value)
        range_buffer = C.create_string_buffer(256)
        self._check(self.api.PolyItemListGetCurrentItem(self.communication.value, VELOCITY_DECODER_DIGITAL,
                    0, 10, range_buffer, len(range_buffer)), "Check velocity range")
        headroom = C.c_float()
        self._check(self.api.PolySendGetFloat(self.communication.value, VELOCITY_DECODER_DIGITAL, 0,
                    HEADROOM_DIGITAL_OUT, C.byref(headroom)), "Check headroom")
        if ((rate, stride) != self._stream_context[:2] or
                range_buffer.value.decode(errors="replace") != self._session_range_text or
                headroom.value != self._session_headroom):
            raise RuntimeError("点位间设备采样率或速度量程已变化，请重新开始采集")

    def confirm_session_laser(self, enabled=True):
        if self._stream_context is None or self._daq_start_attempted:
            raise RuntimeError("采集会话尚未就绪或仍在接收，不能操作激光")
        self._laser_attempted = True
        if enabled:
            # Read the real device every boundary; avoid repeatedly writing ON
            # when a continuous-laser session is already on. Never trust a UI
            # badge or stale observation after another application changes it.
            try:
                actual = self._integer(SENSOR_HEAD, LASER_ON)
                if actual not in (0, 1):
                    raise RuntimeError("设备返回无效激光状态")
                if actual == 1:
                    self._publish_laser(actual)
            except Exception as exc:
                self._publish_laser(None, str(exc))
                raise
            if actual == 1:
                return self.laser_status
        self._set_laser(enabled)
        return self.laser_status

    def close_session(self, *, keep_laser_on=False, abort=None):
        """Called only after the station receiver exited; idempotent, no motion."""
        errors = []
        def cleanup(call, label):
            try:
                result = call()
                if result is not None:
                    self._check(result, label)
            except Exception as exc:
                errors.append(str(exc))
        if self.api and self._acquisition_open:
            if self._daq_start_attempted:
                cleanup(lambda: self.api.PolyStopDataAcquisition(self.acquisition.value), "Stop acquisition")
            if self._laser_monitor_communication is not None:
                cleanup(self._close_laser_monitor, "Close laser monitor communication")
            cleanup(lambda: self.api.PolyCloseDataAcquisition(self.acquisition.value), "Close acquisition")
        if self.api and self._communication_open and self._laser_attempted and (not keep_laser_on or errors or bool(abort and abort.is_set())):
            cleanup(lambda: self._set_laser(False), "Laser off (please verify physically)")
        before_close = len(errors)
        if self.api and self._communication_open:
            cleanup(lambda: self.api.PolyCloseCommunication(self.communication.value), "Close communication")
        # A successful OFF readback survives an earlier DAQ close failure.
        # A late control-close failure/abort cannot leave a confirmed-ON badge.
        if len(errors) > before_close or (keep_laser_on and abort and abort.is_set()):
            self._publish_laser(None, "; ".join(errors) or "采集结束边界收到停止请求，需重新核查激光状态")
        self.api = None
        self._stream_context = None
        self._communication_open = self._acquisition_open = self._daq_start_attempted = False
        if self._dll_directory:
            self._dll_directory.close()
            self._dll_directory = None
        if errors:
            raise RuntimeError("; ".join(errors))

    def run(self, stop: threading.Event, ready: Callable, receive: Callable[[Batch], None],
            *, keep_laser_on: bool = False, abort: threading.Event | None = None) -> None:
        failure = None
        def cancelled():
            return stop.is_set() or bool(abort and abort.is_set())
        try:
            resumed = self._stream_context is not None
            self.prepare_session(cancelled)
            if cancelled():
                return
            if resumed:
                self._verify_session_format()
            sample_rate, rssi_stride, read_base_samples, scale, velocity_max, rssi_max = self._stream_context
            self.confirm_session_laser(True)
            if cancelled():
                return
            # SDK StartAcquisition clears its ring buffer before enabling the
            # device. Never carry stationary/moving samples into a later point.
            self._daq_start_attempted = True
            self._check(self.api.PolyStartDataAcquisition(self.acquisition.value), "Start acquisition")
            origin = time.time()
            sample_index, last_sample_at = 0, time.monotonic()

            def deliver(maximum_base_samples, expected_base_samples=None):
                nonlocal sample_index, last_sample_at
                raw = self._read_channel(VELOCITY, maximum_base_samples * rssi_stride)
                rssi_raw = self._read_channel(RSSI, maximum_base_samples)
                if (len(raw) != len(rssi_raw) * rssi_stride or
                        (expected_base_samples is not None and len(rssi_raw) != expected_base_samples)):
                    raise RuntimeError("速度与 RSSI 样本数不符合设备时标，采集已停止。")
                if not raw:
                    return
                flags = (C.c_uint8 * len(raw))()
                self._check(self.api.PolyGetOverrange(self.acquisition.value, VELOCITY, 0, flags, len(raw)), "Get overrange")
                receive(Batch(sample_index, sample_rate, origin, raw,
                              [value * scale / velocity_max for value in raw],
                              rssi_raw, [100.0 * value / rssi_max for value in rssi_raw],
                              [bool(flag) for flag in flags], rssi_sample_stride=rssi_stride))
                sample_index += len(raw)
                last_sample_at = time.monotonic()

            def service_requests():
                while not cancelled():
                    try:
                        request = self._active_requests.get_nowait()
                    except queue.Empty:
                        return
                    try:
                        request_started_ns = time.monotonic_ns()
                        if request["cancelled"] or time.monotonic() >= request["deadline"]:
                            raise TimeoutError("连续采集请求已过期；未确认新的采集边界")
                        if request["operation"] in ("laser_on", "laser_off"):
                            self._set_laser(request["operation"] == "laser_on")
                            result = self.laser_status
                        elif request["operation"] == "laser":
                            if self._laser_monitor_failed:
                                raise RuntimeError("本次采集激光读取连接已失败，不能确认激光开启")
                            try:
                                result = self._read_laser_monitor()
                            except Exception as exc:
                                self._laser_monitor_failed = True
                                self._publish_laser(None, str(exc))
                                raise
                            if result["fields"]["laser"].get("value") != 1:
                                raise RuntimeError("连续采集激光已关闭，未允许下一次移动")
                        else:
                            self.require_continuous_support()
                            # A continuous task no longer re-enters run() for
                            # each point. Preserve its one-per-point format
                            # check here, on the same SDK owner, before draining
                            # and admitting samples for the next point.
                            self._verify_session_format()
                            format_checked_ns = time.monotonic_ns()
                            before = sample_index
                            # A bounded drain catches up with queued samples;
                            # it cannot silently drop samples or wait forever
                            # when the consumer is slower than the native stream.
                            budget = max(self.config.buffer_capacity * 2, read_base_samples * rssi_stride)
                            while True:
                                if (cancelled() or request["cancelled"] or
                                        time.monotonic() >= request["deadline"]):
                                    raise TimeoutError("连续采集缓存未清空，未允许新点位判定")
                                available = C.c_size_t()
                                self._check(self.api.PolyAvailableSamples(self.acquisition.value,
                                                                         C.byref(available)), "Read available samples")
                                if available.value > max(1, self.config.buffer_capacity // rssi_stride):
                                    raise RuntimeError("SDK 缓存样本数超过已配置容量")
                                if available.value == 0:
                                    break
                                count = min(available.value, read_base_samples)
                                extracted = C.c_size_t()
                                self._check(self.api.PolyReadAvailableData(self.acquisition.value,
                                              count, C.byref(extracted)), "Drain available samples")
                                if not 0 < extracted.value <= count:
                                    raise RuntimeError("SDK 连续采集缓存排空未取得有效样本")
                                deliver(count, extracted.value)
                                if sample_index - before > budget:
                                    raise RuntimeError("连续采集缓存持续积压，未允许新点位判定")
                            result = {"sampleIndex": sample_index, "sampleRate": sample_rate,
                                      "rssiSampleStride": rssi_stride,
                                      "drainedSampleCount": sample_index - before,
                                      "completedAt": time.time(), "source": "sdk-buffer-drained",
                                      "requestQueueMs": (request_started_ns-request["queuedMonotonicNs"])/1e6,
                                      "formatCheckMs": (format_checked_ns-request_started_ns)/1e6,
                                      "drainMs": (time.monotonic_ns()-format_checked_ns)/1e6,
                                      "deviceNetworkFreshness": "unverified"}
                        if cancelled() or request["cancelled"] or time.monotonic() >= request["deadline"]:
                            raise TimeoutError("连续采集确认已取消或超时")
                        request["result"] = result
                    except Exception as exc:
                        request["error"] = exc
                        raise
                    finally:
                        request["done"].set()

            with self._active_lock:
                self._active_owner = threading.get_ident()
                self._active_accepting = True
            ready(sample_rate, origin)
            next_laser_read = time.monotonic() + 1
            while not cancelled():
                service_requests()
                if cancelled():
                    break
                code = self.api.PolyReadData(self.acquisition.value, read_base_samples, self.config.timeout_ms)
                if code != TIMEOUT:
                    self._check(code, "Read data")
                    deliver(read_base_samples)
                service_requests()
                if not cancelled() and time.monotonic() >= next_laser_read:
                    self._observe_laser()
                    next_laser_read = time.monotonic() + 1
                if time.monotonic() - last_sample_at > 10:
                    raise TimeoutError("连续 10 秒未收到有效振动样本；已停止采集，请检查设备、网卡和防火墙。")
        except Exception as exc:
            failure = exc
        finally:
            self._end_active_requests(failure or RuntimeError("连续采集已经停止，未确认新的采集边界"))
            errors = []
            if self.api and self._daq_start_attempted:
                try:
                    self._check(self.api.PolyStopDataAcquisition(self.acquisition.value), "Stop acquisition")
                    self._daq_start_attempted = False
                except Exception as exc:
                    errors.append(str(exc))
            keep = bool(keep_laser_on and not failure and not errors and not (abort and abort.is_set()))
            if not self.reuse_session or not keep:
                try:
                    self.close_session(keep_laser_on=keep, abort=abort)
                except Exception as exc:
                    errors.append(str(exc))
            if failure or errors:
                raise RuntimeError("; ".join(([str(failure)] if failure else []) + errors)) from failure
