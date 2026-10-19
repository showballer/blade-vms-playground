"""LightCheck 精简上位机使用的二进制协议。"""

from __future__ import annotations

from dataclasses import dataclass
import math
import struct


HEADER = b"\xAA\x55"
MAX_FRAME_SIZE = 64

CMD_WRITE_PA = 0x01
CMD_START = 0x05
CMD_SET_SPEED = 0x10
CMD_STOP = 0x06
CMD_READ_PA = 0x02
CMD_READ_SPEED = 0x07
CMD_READ_POSITION = 0x08
CMD_READ_ALARM = 0x09
CMD_RESET_ALARM = 0x0A
CMD_MOVE_RELATIVE = 0x11
CMD_MOVE_OUTPUT_RELATIVE = 0x14
CMD_SET_MOTION_PROFILE = 0x15
CMD_LIMIT_DEBUG = 0x16
CMD_ROTATE_CONTINUOUS = 0x17
CMD_ROTATE_KEEPALIVE = 0x18
CMD_READ_FEEDBACK = 0x20
CMD_CONFIG_GUARD = 0x21
CMD_SET_ZERO = 0x22
CMD_READ_GUARD = 0x24
CMD_TRAJECTORY_BEGIN = 0x30
CMD_TRAJECTORY_POINT = 0x31
CMD_TRAJECTORY_SEAL = 0x32
CMD_TRAJECTORY_START = 0x33
CMD_TRAJECTORY_STATUS = 0x34
CMD_TRAJECTORY_STOP = 0x35
CMD_TRAJECTORY_KEEPALIVE = 0x36


STATUS_TEXT = {
    0x00: "成功",
    0x01: "超时",
    0x02: "CRC 错误",
    0x03: "驱动器无响应",
    0x04: "参数非法",
    0x05: "RS485 通信错误",
    0x06: "设备忙",
    0x07: "未知命令",
    0x08: "限位触发/断线或尚未确认停止，禁止启动",
    0x09: "超出软范围或命令不允许绕过保护",
    0x0A: "未建立可信参考位或未确认回零配置",
}


def validate_output_angle(axis: int, angle: float) -> None:
    if type(axis) is not int or axis not in (1, 2):
        raise ValueError("轴号必须为整数 1 或 2")
    limit = 35 if axis == 1 else 180
    if isinstance(angle, bool) or not math.isfinite(angle) or not -limit <= angle <= limit:
        raise ValueError(f"轴{axis}坐标必须在±{limit}°内")


def build_soft_range(axis: int, minimum: float, maximum: float) -> bytes:
    validate_output_angle(axis, minimum)
    validate_output_angle(axis, maximum)
    if not minimum < maximum or not minimum <= 0 <= maximum:
        raise ValueError("软范围须包含零点")
    return build_request(axis, CMD_CONFIG_GUARD, struct.pack(">ii", round(minimum * 1000), round(maximum * 1000)), parameter=2)


def crc16_modbus(data: bytes | bytearray) -> int:
    crc = 0xFFFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def append_crc(data: bytes | bytearray) -> bytes:
    raw = bytes(data)
    crc = crc16_modbus(raw)
    return raw + bytes((crc & 0xFF, crc >> 8))


def verify_crc(frame: bytes | bytearray) -> bool:
    if len(frame) < 2:
        return False
    expected = frame[-2] | (frame[-1] << 8)
    return crc16_modbus(frame[:-2]) == expected


def build_request(device_id: int, command: int, data: bytes = b"", parameter: int = 0) -> bytes:
    if device_id not in (1, 2):
        raise ValueError("电机编号只能是 1 或 2")
    payload = bytes((device_id, command)) + struct.pack(">H", parameter) + data
    if len(payload) + 5 > MAX_FRAME_SIZE:
        raise ValueError("协议帧过长")
    return append_crc(HEADER + bytes((len(payload) + 2,)) + payload)


def validate_trajectory_session(session: int) -> None:
    if type(session) is not int or not 1 <= session <= 65535:
        raise ValueError("轨迹会话号必须为1～65535")


def build_trajectory_begin(session: int, count: int, *, cycle_ms: int = 250,
                           max_speed: float = 3.6, max_accel: float = 3,
                           max_error: float = 0.75, tolerance: float = 0.1) -> bytes:
    validate_trajectory_session(session)
    if type(count) is not int or not 2 <= count <= 128 or type(cycle_ms) is not int or not 250 <= cycle_ms <= 500:
        raise ValueError("轨迹须为2～128点，控制周期250～500ms")
    values = (max_speed, max_accel, max_error, tolerance)
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in values):
        raise ValueError("轨迹约束必须为有限数字")
    v, a, e, tol = (round(x * 1000) for x in values)
    if not 1 <= v <= 60000 or not 1 <= a <= 120000 or not 500 <= e <= 10000 or not 50 <= tol <= 1000 or tol >= e:
        raise ValueError("轨迹速度≤60°/秒，加速度≤120°/秒²，误差0.5～10°，容差0.05～1°且小于误差限")
    return build_request(1, CMD_TRAJECTORY_BEGIN, struct.pack(">HHiiii", count, cycle_ms, v, a, e, tol), parameter=session)


def build_trajectory_point(session: int, index: int, time_ms: int, axis1: float, axis2: float) -> bytes:
    validate_trajectory_session(session)
    if type(index) is not int or not 0 <= index < 128 or type(time_ms) is not int or not 0 <= time_ms <= 600000:
        raise ValueError("轨迹序号须为0～127，时间须为0～600000ms")
    validate_output_angle(1, axis1)
    validate_output_angle(2, axis2)
    return build_request(1, CMD_TRAJECTORY_POINT, struct.pack(">HIii", index, time_ms,
                         round(axis1 * 1000), round(axis2 * 1000)), parameter=session)


def build_limit_debug(device_id: int, action: int) -> bytes:
    """0=恢复保护，1=申请旁路（须停稳），2=续期；下位机5秒未续期恢复保护。"""
    if action not in (0, 1, 2):
        raise ValueError("无效的限位调试操作")
    return build_request(device_id, CMD_LIMIT_DEBUG, bytes((action,)), parameter=0x4C44)


def build_move_relative(device_id: int, speed_rpm: int, pulses: int) -> bytes:
    if not 1 <= speed_rpm <= 5000:
        raise ValueError("速度范围必须是 1～5000 rpm")
    if not -(2**31) <= pulses <= 2**31 - 1 or pulses == 0:
        raise ValueError("脉冲数超出 int32 范围或为零")
    return build_request(device_id, CMD_MOVE_RELATIVE, struct.pack(">hi", speed_rpm, pulses))


def build_write_pa(device_id: int, parameter: int, value: int, save: bool = False) -> bytes:
    """构造 PA 参数写入帧；默认临时生效，避免频繁写驱动器 EEPROM。"""
    if not 0 <= parameter < 128:
        raise ValueError("PA 参数编号必须在 0～127 之间。")
    if not -32768 <= value <= 65535:
        raise ValueError("PA 参数值超出 16 位范围。")
    data = bytes((1 if save else 0,)) + struct.pack(">H", value & 0xFFFF)
    return build_request(device_id, CMD_WRITE_PA, data=data, parameter=parameter)


def build_move_output_relative(device_id: int, output_speed_rpm: float, output_angle_deg: float) -> bytes:
    """使用物理输出轴单位构造运动帧：0.01 rpm、0.001°。"""
    if not math.isfinite(output_speed_rpm) or not math.isfinite(output_angle_deg):
        raise ValueError("输出轴速度和角度必须是有限数字。")
    speed_centi = int(math.floor(output_speed_rpm * 100.0 + 0.5))
    angle_magnitude = int(math.floor(abs(output_angle_deg) * 1000.0 + 0.5))
    angle_millideg = angle_magnitude if output_angle_deg >= 0 else -angle_magnitude
    if not 1 <= speed_centi <= 65535:
        raise ValueError("输出轴速度必须在 0.01～655.35 rpm 之间。")
    if angle_millideg == 0 or not -(2**31) <= angle_millideg <= 2**31 - 1:
        raise ValueError("输出轴角度小于 0.001°或超出协议范围。")
    return build_request(device_id, CMD_MOVE_OUTPUT_RELATIVE, struct.pack(">Hi", speed_centi, angle_millideg))


def build_motion_profile(device_id: int, accel_ms: int, decel_ms: int, s_curve_ms: int) -> bytes:
    """设置P100S内部位置模式的PA40、PA41、PA42，均为临时写入。"""
    if not 1 <= accel_ms <= 10000 or not 1 <= decel_ms <= 10000:
        raise ValueError("PA40/PA41必须在 1～10000 ms 之间。")
    if not 0 <= s_curve_ms <= 1000:
        raise ValueError("PA42必须在 0～1000 ms 之间。")
    return build_request(device_id, CMD_SET_MOTION_PROFILE, struct.pack(">HHH", accel_ms, decel_ms, s_curve_ms))


@dataclass(frozen=True)
class Response:
    device_id: int
    command: int
    status: int
    parameter: int
    data: bytes
    raw: bytes

    @property
    def ok(self) -> bool:
        return self.status == 0

    @property
    def status_text(self) -> str:
        return STATUS_TEXT.get(self.status, f"未知状态 0x{self.status:02X}")


def parse_response(frame: bytes) -> Response | None:
    if len(frame) < 10 or frame[:2] != HEADER or len(frame) != frame[2] + 3:
        return None
    if frame[2] < 7 or frame[2] > MAX_FRAME_SIZE - 3 or not verify_crc(frame):
        return None
    return Response(
        device_id=frame[3],
        command=frame[4],
        status=frame[5],
        parameter=struct.unpack(">H", frame[6:8])[0],
        data=frame[8:-2],
        raw=frame,
    )


class ResponseParser:
    """处理串口半包、粘包、噪声和 CRC 错帧。"""

    def __init__(self) -> None:
        self.buffer = bytearray()

    def reset(self) -> None:
        self.buffer.clear()

    def feed(self, data: bytes) -> list[Response]:
        self.buffer.extend(data)
        if len(self.buffer) > 4096:
            del self.buffer[:-4096]

        packets: list[Response] = []
        while True:
            start = self.buffer.find(HEADER)
            if start < 0:
                self.buffer[:] = b"\xAA" if self.buffer[-1:] == b"\xAA" else b""
                break
            if start:
                del self.buffer[:start]
            if len(self.buffer) < 3:
                break

            length = self.buffer[2]
            if length < 7 or length > MAX_FRAME_SIZE - 3:
                del self.buffer[0]
                continue

            total = length + 3
            if len(self.buffer) < total:
                # 若错误长度挡在合法完整帧前，优先恢复到后续合法帧。
                recovered = False
                search_from = 1
                while True:
                    nested = self.buffer.find(HEADER, search_from)
                    if nested < 0 or len(self.buffer) < nested + 3:
                        break
                    nested_total = self.buffer[nested + 2] + 3
                    if (10 <= nested_total <= MAX_FRAME_SIZE and
                            len(self.buffer) >= nested + nested_total and
                            verify_crc(self.buffer[nested:nested + nested_total])):
                        del self.buffer[:nested]
                        recovered = True
                        break
                    search_from = nested + 1
                if recovered:
                    continue
                break

            candidate = bytes(self.buffer[:total])
            packet = parse_response(candidate)
            if packet is None:
                del self.buffer[0]
            else:
                packets.append(packet)
                del self.buffer[:total]
        return packets
