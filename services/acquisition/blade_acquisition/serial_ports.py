"""Bounded serial names and IPv4/TCP endpoints; local-device checks before serial opens."""
from __future__ import annotations

import os
import ipaddress
import re
import stat
import sys
from typing import Annotated

from pydantic import AfterValidator


_WINDOWS_PORT = re.compile(r"COM[1-9][0-9]{0,3}")
_MAC_PORT = re.compile(r"/dev/cu\.[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")


def valid_serial_port(value: object) -> bool:
    return isinstance(value, str) and bool(_WINDOWS_PORT.fullmatch(value) or _MAC_PORT.fullmatch(value))


def validate_serial_port(value: str) -> str:
    if not valid_serial_port(value):
        raise ValueError("转盘串口须为 COM1～COM9999 或 macOS /dev/cu.* 设备")
    return value


SerialPort = Annotated[str, AfterValidator(validate_serial_port)]


def tcp_endpoint(value: object) -> tuple[str, int] | None:
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"tcp://([^:/\s]+):([1-9][0-9]{0,4})", value)
    if not match:
        return None
    try:
        host = ipaddress.IPv4Address(match[1])
    except ipaddress.AddressValueError:
        return None
    port = int(match[2])
    if not 0 < int(host) < int(ipaddress.IPv4Address('224.0.0.0')) or port > 65535:
        return None
    return str(host), port


def valid_turntable_endpoint(value: object) -> bool:
    return valid_serial_port(value) or tcp_endpoint(value) is not None


def validate_turntable_endpoint(value: str) -> str:
    if not valid_turntable_endpoint(value):
        raise ValueError("转盘连接须为 tcp://IPv4:端口、COM1～COM9999 或 macOS /dev/cu.* 设备")
    return value


TurntableEndpoint = Annotated[str, AfterValidator(validate_turntable_endpoint)]


def validate_local_serial_port(port: str) -> str:
    """Never open arbitrary files, URLs, aliases or a port for another OS."""
    validate_serial_port(port)
    if sys.platform == "win32" and _WINDOWS_PORT.fullmatch(port):
        return port
    if sys.platform == "darwin" and _MAC_PORT.fullmatch(port):
        try:
            mode = os.lstat(port).st_mode
        except OSError as exc:
            raise ValueError("转盘串口不存在或已断开，请刷新串口") from exc
        if not stat.S_ISCHR(mode):
            raise ValueError("转盘串口必须是本机真实字符设备，不能使用普通文件或符号链接")
        return port
    raise ValueError("当前系统不支持该转盘串口，请刷新并选择本机串口")


def list_turntable_ports() -> list[dict[str, str]]:
    from serial.tools.list_ports import comports
    available: dict[str, str] = {}
    for item in comports():
        try:
            port = validate_local_serial_port(item.device)
        except ValueError:
            continue
        available[port] = item.description or port
    return [{"port": port, "description": available[port]} for port in sorted(available)]
