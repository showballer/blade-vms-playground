"""Explicit, idle-only IVS-500 configuration via the supplied SDK C interface.

Commands and signatures follow 122/include/IO/DeviceCommunication and the
vendor DevicePanel example. No arbitrary command dispatch, saved power-up
profiles, network changes, or implicit device defaults are exposed.
"""
from __future__ import annotations

import ctypes as C
import time

from .receiver import PolytecReceiver, SENSOR_HEAD, VELOCITY_DECODER_DIGITAL

FIELDS = {
    "velocityRange": (7, 10, "item"), "bandwidth": (7, 18, "item"),
    "highPass": (7, 558, "item"), "ase": (7, 574, "switch"),
    "laser": (2, 46, "readonly"), "focusPosition": (2, 38, "readonly"),
    "signalLevel": (2, 66, "readonly"), "autofocus": (2, 64, "readonly"),
    "autofocusResult": (2, 76, "readonly"),
}
WRITABLE = {"velocityRange", "bandwidth", "highPass", "ase"}


class DevicePanel(PolytecReceiver):
    def _load_api(self):
        api = super()._load_api()
        self.bind_api(api)
        return api

    @staticmethod
    def bind_api(api):
        base = [C.c_int, C.c_int, C.c_int, C.c_int]
        definitions = {
            "PolyHasCommand": (base + [C.POINTER(C.c_bool)], C.c_int),
            "PolySendGetInt16": (base + [C.POINTER(C.c_int16)], C.c_int),
            "PolyItemListGetAvailableItems": (base + [C.POINTER(C.c_char), C.c_size_t], C.c_int),
            "PolyItemListSetCurrentItem": (base + [C.c_char_p], C.c_int),
            "PolySendGetDevInfoRange": (base + [C.POINTER(C.c_int16), C.POINTER(C.c_int16)], C.c_int),
        }
        for name, (args, result) in definitions.items():
            method = getattr(api, name)
            method.argtypes, method.restype = args, result

    def has(self, device, command):
        value = C.c_bool()
        self._check(self.api.PolyHasCommand(self.communication.value, device, 0, command, C.byref(value)), "Check command")
        return value.value

    def integer(self, device, command):
        value = C.c_int16()
        self._check(self.api.PolySendGetInt16(self.communication.value, device, 0, command, C.byref(value)), "Read device setting")
        return value.value

    def set_integer(self, device, command, value):
        self._check(self.api.PolySendSetInt16(self.communication.value, device, 0, command, C.c_int16(value)), "Set device setting")

    def item(self, device, command, available=False):
        value = C.create_string_buffer(8192)
        function = self.api.PolyItemListGetAvailableItems if available else self.api.PolyItemListGetCurrentItem
        self._check(function(self.communication.value, device, 0, command, value, len(value)), "Read item list")
        return value.value.decode("utf-8", errors="strict").strip()

    def read_field(self, key):
        device, command, kind = FIELDS[key]
        if not self.has(device, command):
            return {"supported": False, "error": "设备未提供此命令"}
        value = self.item(device, command) if kind == "item" else self.integer(device, command)
        result = {"supported": True, "value": value, "writable": key in WRITABLE}
        if kind == "item":
            result["options"] = [item.strip() for item in self.item(device, command, True).split(",") if item.strip()]
            if not result["options"] or len(result["options"]) > 128:
                raise ValueError("SDK 返回无效选项列表")
        elif kind == "switch":
            if value not in (0, 1):
                raise ValueError("SDK 返回无效开关值")
            result["options"] = [0, 1]
        if key == "signalLevel":
            lo, hi = C.c_int16(), C.c_int16()
            self._check(self.api.PolySendGetDevInfoRange(self.communication.value, device, 0, command, C.byref(lo), C.byref(hi)), "Read signal limits")
            if hi.value <= lo.value:
                raise ValueError("信号强度量程无效")
            result["percent"] = (value - lo.value) * 100 / (hi.value - lo.value)
        return result

    def snapshot(self):
        fields = {}
        deadline = time.monotonic() + 8
        for key in FIELDS:
            try:
                if time.monotonic() > deadline:
                    raise RuntimeError("读取超过时限，此项未知；未使用默认值替代")
                fields[key] = self.read_field(key)
            except (RuntimeError, ValueError) as exc:
                fields[key] = {"supported": False, "error": str(exc)}
        return {"deviceIp": self.config.device_ip, "readAt": time.time(), "fields": fields,
                "source": "device-readback", "samplingNote": "采样率在采集启动时从 SDK 数据流读取；不是带宽。"}

    def run_command(self, action="read", key=None, value=None, expected=None):
        opened = False
        try:
            self.api = self._load_api()
            self._check(self.api.PolyOpenUdpEthernetCommunication(C.byref(self.communication), self.config.device_ip.encode("ascii"), 1500), "Open settings communication")
            opened = True
            if action == "set":
                if key not in WRITABLE:
                    raise ValueError("此配置项不可修改。")
                current = self.read_field(key)
                if not current.get("supported") or value not in current.get("options", []):
                    raise ValueError("此设置当前不可用，请重新读取设备配置。")
                if current["value"] != expected:
                    raise ValueError("设备配置已变化，未覆盖；请重新读取并确认。")
                device, command, kind = FIELDS[key]
                if value != current["value"]:
                    if kind == "item":
                        self._check(self.api.PolyItemListSetCurrentItem(self.communication.value, device, 0, command, value.encode("utf-8")), "Set item")
                    else:
                        self.set_integer(device, command, value)
                verified = self.read_field(key)
                if verified.get("value") != value:
                    raise RuntimeError("设备读回与目标值不一致；配置可能已部分改变，请重新读取，勿直接开始采集。")
            elif action == "laser_on":
                if not self.has(SENSOR_HEAD, 46):
                    raise ValueError("设备不支持激光控制。")
                self.set_integer(SENSOR_HEAD, 46, 1)
                if self.integer(SENSOR_HEAD, 46) != 1:
                    raise RuntimeError("激光开启读回未确认。")
            elif action == "laser_off":
                if not self.has(SENSOR_HEAD, 46):
                    raise ValueError("设备不支持激光控制。")
                self.set_integer(SENSOR_HEAD, 46, 0)
                if self.integer(SENSOR_HEAD, 46) != 0:
                    raise RuntimeError("激光关闭读回未确认。")
            elif action == "autofocus":
                self.autofocus()
            elif action != "read":
                raise ValueError("无效设备配置操作。")
            return self.snapshot()
        finally:
            try:
                if opened:
                    self.api.PolyCloseCommunication(self.communication.value)
            finally:
                self.api = None
                if self._dll_directory:
                    self._dll_directory.close()
                    self._dll_directory = None

    def autofocus(self):
        # This is a separate, explicitly laser-confirmed operation. It never
        # opens DAQ. Stop focusing and switch laser OFF on success AND failure.
        if not self.has(SENSOR_HEAD, 64) or not self.has(SENSOR_HEAD, 46):
            raise ValueError("设备不支持安全自动聚焦控制。")
        if self.integer(SENSOR_HEAD, 64) or (self.has(SENSOR_HEAD, 174) and self.integer(SENSOR_HEAD, 174)):
            raise RuntimeError("设备正在聚焦；请先在原控制程序完成操作。")
        errors = []
        try:
            self.set_integer(SENSOR_HEAD, 46, 1)
            self.set_integer(SENSOR_HEAD, 64, 1)
            deadline = time.monotonic() + 20
            time.sleep(0.25)
            while self.integer(SENSOR_HEAD, 64):
                if time.monotonic() >= deadline:
                    raise TimeoutError("自动聚焦未在 20 秒内结束。")
                time.sleep(0.2)
            if self.has(SENSOR_HEAD, 76) and self.integer(SENSOR_HEAD, 76) != 1:
                raise RuntimeError("自动聚焦结束，但设备报告未找到焦点；请检查目标与距离。")
        except Exception as exc:
            errors.append(str(exc))
        finally:
            for command, label in ((64, "停止聚焦"), (46, "关闭激光")):
                try:
                    self.set_integer(SENSOR_HEAD, command, 0)
                    if self.integer(SENSOR_HEAD, command) != 0:
                        raise RuntimeError(f"{label}读回未确认")
                except Exception as exc:
                    errors.append(str(exc))
        if errors:
            raise RuntimeError("; ".join(errors) + "。请在现场确认聚焦和激光状态。")
