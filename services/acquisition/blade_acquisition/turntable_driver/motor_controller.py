"""不依赖 Tkinter 的同步电机 API。单位均为减速器输出轴；STM32 换算脉冲。"""

from __future__ import annotations

from dataclasses import dataclass
import math
import struct
import threading
import time
import warnings

from .protocol import (
    CMD_MOVE_OUTPUT_RELATIVE, CMD_READ_PA, CMD_READ_SPEED, CMD_READ_POSITION,
    CMD_READ_ALARM, CMD_RESET_ALARM, CMD_STOP, CMD_SET_MOTION_PROFILE, CMD_START, CMD_SET_SPEED,
    CMD_ROTATE_CONTINUOUS, CMD_ROTATE_KEEPALIVE,
    CMD_READ_FEEDBACK, CMD_READ_GUARD, CMD_SET_ZERO, CMD_CONFIG_GUARD,
    build_soft_range, validate_output_angle,
    Response, ResponseParser, build_request, build_move_output_relative,
    build_motion_profile,
)


class MotorError(RuntimeError):
    """电机 API 基础异常。"""


class CommunicationError(MotorError):
    """通信异常：运动是否执行可能未知，禁止自动重发运动。"""


class CommandRejected(MotorError):
    def __init__(self, response: Response):
        self.response = response
        self.status = response.status
        super().__init__(f"Motor {response.device_id}: {response.status_text}")


class DriveAlarm(MotorError):
    def __init__(self, motor_id: int, alarm_code: int):
        self.motor_id, self.alarm_code = motor_id, alarm_code
        super().__init__(f"Motor {motor_id}: 驱动器报警 Err {alarm_code}")


@dataclass(frozen=True)
class MotorStatus:
    motor_id: int
    motor_rpm: int
    output_rpm: float
    run_state: int
    alarm_code: int
    limit_flags: int | None = None


@dataclass(frozen=True)
class MotionAccepted:
    """仅表示运动命令已接收，不表示已经开始或完成。"""
    motor_id: int
    output_angle_deg: float
    output_speed_rpm: float


@dataclass(frozen=True)
class MotionProfile:
    accel_ms: int
    decel_ms: int
    s_curve_ms: int


@dataclass(frozen=True)
class PositionFeedback:
    actual_counts: int
    commanded_counts: int
    error_counts: int
    display_mode: int
    command_counts_per_rev: int
    encoder_bits: int
    output_angle_deg: float | None
    flags: int
    raw_inputs: int
    active_inputs: int
    home_phase: int
    fault: int
    origin_counts: int
    motor_rpm: int

    @property
    def counts_per_motor_rev(self) -> int | None:
        if self.display_mode in (2, 3):
            return self.command_counts_per_rev or None
        if self.display_mode in (0, 1) and 10 <= self.encoder_bits <= 32:
            return 1 << self.encoder_bits
        return None


@dataclass(frozen=True)
class GuardConfig:
    negative: int | None
    positive: int | None
    home: int | None
    active_high: bool
    home_direction: int
    confirmed: bool
    hardware_enabled: bool
    soft_enabled: bool
    minimum_deg: float
    maximum_deg: float
    home_at_end: bool


class MotorController:
    """共享一条 PC 串口控制两轴。不发送 SON 或限位旁路命令。

    单次事务用锁串行化；复合动作请由调用方统一调度，不要多个线程操作同一轴。
    timeout 是单条通信的等待上限，不是机械运动时间。
    serial_factory 仅用于注入串口适配器/测试替身。
    """

    def __init__(self, port: str, *, timeout: float = 2.0,
                 gear_ratio: float = 50.0, serial_factory=None):
        if not port:
            raise ValueError("串口名不能为空")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout 必须为正数")
        if not math.isfinite(gear_ratio) or gear_ratio <= 0:
            raise ValueError("gear_ratio 必须为正数")
        self.port_name, self.timeout, self.gear_ratio = port, timeout, gear_ratio
        self._factory = serial_factory
        self._port = None
        self._parser = ResponseParser()
        self._lock = threading.RLock()
        self._faulted = False

    @staticmethod
    def _axis(motor_id: int) -> None:
        if type(motor_id) is not int or motor_id not in (1, 2):
            raise ValueError("motor_id 只能是整数 1 或 2")

    def connect(self) -> MotorController:
        """仅连接，不使能、不运动。重复调用不会重置已连接端口。"""
        with self._lock:
            if self._port is not None:
                if self._faulted:
                    raise CommunicationError("通信状态不确定，请先 close() 再重新连接")
                return self
            factory = self._factory
            if factory is None:
                try:
                    from serial import Serial
                except ImportError as exc:
                    raise CommunicationError("请先安装 pyserial") from exc
                factory = Serial
            port = None
            try:
                port = factory(self.port_name, baudrate=115200, bytesize=8, parity="N",
                               stopbits=1, timeout=0, write_timeout=self.timeout)
                port.reset_input_buffer()
            except Exception as exc:
                if port is not None:
                    try:
                        port.close()
                    except Exception:
                        pass
                raise CommunicationError(f"连接失败: {exc}") from exc
            self._port = port
            self._parser.reset()
            self._faulted = False
            return self

    def _request(self, frame: bytes) -> Response:
        with self._lock:
            if self._port is None:
                raise CommunicationError("串口未连接，请先 connect()")
            if self._faulted:
                raise CommunicationError("上次通信结果不确定，请关闭并重连；不要自动重发运动")
            expected = (frame[3], frame[4], struct.unpack(">H", frame[5:7])[0])
            try:
                self._port.reset_input_buffer()
                self._parser.reset()
                if self._port.write(frame) != len(frame):
                    raise CommunicationError("串口写入不完整，执行结果未知")
                deadline = time.monotonic() + self.timeout
                while time.monotonic() < deadline:
                    data = self._port.read(min(self._port.in_waiting, 4096))
                    for packet in self._parser.feed(data):
                        if (packet.device_id, packet.command, packet.parameter) != expected:
                            continue
                        if not packet.ok:
                            # STM32's RS485 error response does not prove that
                            # the drive never executed the last write/trigger.
                            if packet.status in (1, 2, 3, 5):
                                self._faulted = True
                            raise CommandRejected(packet)
                        return packet
                    time.sleep(0.005)
                raise CommunicationError("等待 STM32 应答超时；执行结果未知，未自动重发")
            except CommandRejected:
                raise
            except Exception as exc:
                self._faulted = True
                if isinstance(exc, CommunicationError):
                    raise
                raise CommunicationError(f"串口通信失败: {exc}") from exc

    def _data(self, packet: Response, minimum: int) -> bytes:
        if len(packet.data) < minimum:
            self._faulted = True
            raise CommunicationError("应答数据长度错误，请重连并核查执行状态")
        return packet.data

    def _speed(self, motor_id: int) -> tuple[int, int]:
        self._axis(motor_id)
        packet = self._request(build_request(motor_id, CMD_READ_SPEED))
        # 只取既有的转速和运行状态，兼容末尾扩展字段，不管理限位。
        return struct.unpack(">hH", self._data(packet, 4)[:4])

    def read_alarm(self, motor_id: int) -> int:
        self._axis(motor_id)
        packet = self._request(build_request(motor_id, CMD_READ_ALARM))
        return struct.unpack(">H", self._data(packet, 2)[:2])[0]

    def get_status(self, motor_id: int) -> MotorStatus:
        self._axis(motor_id)
        packet = self._request(build_request(motor_id, CMD_READ_SPEED))
        data = self._data(packet, 4)
        rpm, run_state = struct.unpack(">hH", data[:4])
        alarm = self.read_alarm(motor_id)
        return MotorStatus(motor_id, rpm, rpm / self.gear_ratio, run_state, alarm,
                           data[4] if len(data) >= 5 else None)

    def start_continuous(self, motor_id: int, signed_output_rpm: float, *, cancel=None) -> float | None:
        """Start firmware velocity mode. Each acceptance is checked; never retry motion.

        0x10 only caches a motor-rpm setpoint; 0x05 applies it. This is not an
        in-motion speed update API. External SON remains controlled by hardware.
        """
        self._axis(motor_id)
        if not math.isfinite(signed_output_rpm) or not 0.02 <= abs(signed_output_rpm) <= 100:
            raise ValueError("输出轴转速须为 ±0.02～100 rpm（50:1）")
        magnitude = int(math.floor(abs(signed_output_rpm) * self.gear_ratio + 0.5))
        if not 1 <= magnitude <= 5000:
            raise ValueError("电机转速须为 1～5000 rpm")
        target = magnitude if signed_output_rpm > 0 else -magnitude
        if cancel is not None and cancel.is_set():
            return None
        status = self.get_status(motor_id)
        if status.motor_rpm != 0 or status.alarm_code or status.limit_flags not in (None, 0):
            raise MotorError("启动前必须静止、无报警，且无已反馈的限位触发/旁路")
        for command, data in ((CMD_SET_SPEED, struct.pack(">h", target)), (CMD_START, b"")):
            if cancel is not None and cancel.is_set():
                return None
            packet = self._request(build_request(motor_id, command, data))
            if struct.unpack(">h", self._data(packet, 2)[:2])[0] != target:
                self._faulted = True
                raise CommunicationError("速度应答与请求不符，运动状态未知；未自动重发")
        return target / self.gear_ratio

    def start_continuous_protocol(self, motor_id: int, signed_output_rpm: float, *, cancel=None) -> float | None:
        """Explicit 0x17 interface; caller owns periodic 0x18 renewal. No fallback."""
        self._axis(motor_id)
        if not math.isfinite(signed_output_rpm) or not 0.02 <= abs(signed_output_rpm) <= 100:
            raise ValueError("输出轴转速须为 ±0.02～100 rpm（50:1）")
        raw = int(math.floor(abs(signed_output_rpm) * 6000 + 0.5))
        if signed_output_rpm < 0:
            raw = -raw
        target = int(math.floor(abs(raw) * self.gear_ratio / 6000 + 0.5)) * (1 if raw > 0 else -1)
        if cancel is not None and cancel.is_set():
            return None
        status = self.get_status(motor_id)
        if status.motor_rpm or status.alarm_code or status.limit_flags not in (None, 0):
            raise MotorError("启动前必须静止、无报警，且无已反馈的限位触发/旁路")
        if cancel is not None and cancel.is_set():
            return None
        packet = self._request(build_request(motor_id, CMD_ROTATE_CONTINUOUS, struct.pack(">i", raw)))
        if struct.unpack(">h", self._data(packet, 2)[:2])[0] != target:
            self._faulted = True
            raise CommunicationError("连续旋转应答速度与请求不符，运动状态未知；未自动重发")
        return target / self.gear_ratio

    def renew_continuous(self, motor_id: int) -> None:
        """Renew only an existing motion; rejected renewal never restarts it."""
        self._axis(motor_id)
        packet = self._request(build_request(motor_id, CMD_ROTATE_KEEPALIVE, parameter=0x4352))
        self._data(packet, 2)

    def read_pa(self, motor_id: int, parameter: int) -> int:
        self._axis(motor_id)
        if type(parameter) is not int or not 0 <= parameter < 128:
            raise ValueError("PA 参数编号范围为 0～127")
        packet = self._request(build_request(motor_id, CMD_READ_PA, parameter=parameter))
        return struct.unpack(">H", self._data(packet, 2)[:2])[0]

    def read_position_raw(self, motor_id: int) -> int:
        """驱动器反馈原始位置计数；不是输出角度，也不是已建立的机械绝对零点。"""
        self._axis(motor_id)
        packet = self._request(build_request(motor_id, CMD_READ_POSITION))
        return struct.unpack(">i", self._data(packet, 4)[:4])[0]

    def get_feedback(self, motor_id: int) -> PositionFeedback:
        self._axis(motor_id)
        packet = self._request(build_request(motor_id, CMD_READ_FEEDBACK))
        values = list(struct.unpack(">iiiHHHiHBBBBih", self._data(packet, 34)[:34]))
        # Only P3-32=3 with a nonzero PA11 has a verified output-coordinate scale.
        values[6] = values[6] / 1000 if values[7] & 1 and values[3] == 3 and values[4] > 0 else None
        return PositionFeedback(*values)

    def get_guard_config(self, motor_id: int) -> GuardConfig:
        self._axis(motor_id)
        packet = self._request(build_request(motor_id,CMD_READ_GUARD))
        neg,pos,home,high,direction,confirmed,hw,soft,lo,hi,end = struct.unpack(">BBBBbBBBiiB", self._data(packet,17)[:17])
        return GuardConfig(None if neg==255 else neg,None if pos==255 else pos,None if home==255 else home,
                           bool(high),direction,bool(confirmed),bool(hw),bool(soft),lo/1000,hi/1000,bool(end))

    def set_soft_range(self, motor_id: int, minimum_deg: float, maximum_deg: float) -> GuardConfig:
        frame = build_soft_range(motor_id,minimum_deg,maximum_deg)
        self.stop(motor_id)
        self._request(frame)
        return self.get_guard_config(motor_id)

    def set_guard_policy(self, motor_id: int, *, hardware: bool, soft: bool,
                         home_direction: int = 0, confirmed: bool = False,
                         home_at_end: bool = False) -> GuardConfig:
        flags = int(hardware) | (int(soft) << 1) | (int(confirmed) << 2) | (int(home_at_end) << 3)
        frame = build_request(motor_id, CMD_CONFIG_GUARD, bytes((flags, home_direction & 255)), parameter=3)
        self.stop(motor_id)
        self._request(frame)
        return self.get_guard_config(motor_id)

    def set_current_zero(self, motor_id: int) -> PositionFeedback:
        """人工捕获参考：电机1须位于+25°传感器姿态，电机2为0°；不清编码器数据。"""
        self._axis(motor_id)
        self.stop(motor_id)
        self._request(build_request(motor_id,CMD_SET_ZERO,parameter=0x5A52))
        feedback=self.get_feedback(motor_id)
        if feedback.output_angle_deg is None:
            raise MotorError("零点未建立或反馈单位已变化")
        return feedback

    def set_current_reference(self, motor_id: int) -> PositionFeedback:
        """捕获人工参考；电机1为+25°，电机2为0°。需人工确认真实姿态。"""
        return self.set_current_zero(motor_id)

    def move_to_angle(self, motor_id: int, angle_deg: float, *, speed_rpm: float = 0.2,
                      cancel=None, stop_before: bool = True) -> MotionAccepted | None:
        """Move to an output angle.

        ``stop_before`` remains enabled for public/manual commands.  Automatic
        point cycles can disable it after their preflight has already verified
        that both axes are stationary; this avoids waiting for a redundant stop
        confirmation before every point transition.
        """
        validate_output_angle(motor_id, angle_deg)
        if isinstance(speed_rpm, bool) or not math.isfinite(speed_rpm) or not 0.02 <= speed_rpm <= 100:
            raise ValueError("速度必须为0.02～100 rpm")
        if stop_before:
            self.stop(motor_id)
        feedback = self.get_feedback(motor_id)
        if feedback.output_angle_deg is None:
            raise MotorError("未建立可信零点，禁止坐标定位")
        delta = round((angle_deg-feedback.output_angle_deg)*1000)/1000
        if delta == 0:
            return MotionAccepted(motor_id,0,speed_rpm)
        if cancel is not None and cancel.is_set():
            return None
        return self.move_relative(motor_id, delta, speed_rpm=speed_rpm, cancel=cancel,
                                  stop_before=stop_before)

    def move_to_angle_prechecked(self, motor_id: int, angle_deg: float, *,
                                 speed_rpm: float = 0.2, cancel=None) -> MotionAccepted | None:
        """Position move for callers that already verified zero speed and faults."""
        return self.move_to_angle(motor_id, angle_deg, speed_rpm=speed_rpm,
                                  cancel=cancel, stop_before=False)

    def reset_alarm(self, motor_id: int) -> int:
        """故障排除后由调用方显式调用；返回复位后报警码，不自动重启运动。"""
        self._axis(motor_id)
        self._request(build_request(motor_id, CMD_RESET_ALARM))
        return self.read_alarm(motor_id)

    def stop(self, motor_id: int, *, wait: bool = True, timeout: float = 10.0) -> None:
        """发送通信停止；wait=True 时等待连续两次读到零速，不是硬件急停。"""
        self._axis(motor_id)
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("停止确认 timeout 必须为正数")
        if self._faulted and self._port is not None:
            # A stop is the only permitted best-effort write after uncertain
            # communication. It is never represented as a confirmed stop.
            self._port.write(build_request(motor_id, CMD_STOP))
            raise CommunicationError("已尝试发送停止，但串口结果不确定，无法确认停稳")
        self._request(build_request(motor_id, CMD_STOP))
        if not wait:
            return
        deadline, zero_samples = time.monotonic() + timeout, 0
        while time.monotonic() < deadline:
            rpm, _ = self._speed(motor_id)
            zero_samples = zero_samples + 1 if rpm == 0 else 0
            if zero_samples >= 2:
                return
            time.sleep(0.1)
        raise MotorError("停止确认超时；未发送后续运动，请检查机构并使用硬件急停")

    def move_relative(self, motor_id: int, angle_deg: float, *, speed_rpm: float = 0.2,
                      stop_timeout: float = 10.0, cancel=None,
                      stop_before: bool = True) -> MotionAccepted | None:
        """输出轴相对转动；正角度正向，负角度反向。"""
        self._axis(motor_id)
        frame = build_move_output_relative(motor_id, speed_rpm, angle_deg)
        requested_speed, requested_angle = struct.unpack(">Hi", frame[7:13])
        motor_speed = int(math.floor(requested_speed / 100.0 * self.gear_ratio + 0.5))
        if not 1 <= motor_speed <= 5000:
            raise ValueError("按减速比换算后的电机速度必须为 1～5000 rpm")
        if stop_before:
            self.stop(motor_id, timeout=stop_timeout)
        alarm = self.read_alarm(motor_id)
        if alarm:
            raise DriveAlarm(motor_id, alarm)
        if cancel is not None and cancel.is_set():
            return None
        packet = self._request(frame)
        accepted = struct.unpack(">i", self._data(packet, 4)[:4])[0]
        if accepted != requested_angle:
            self._faulted = True
            raise CommunicationError("运动应答角度与请求不符，实际动作未知，请检查并停止")
        return MotionAccepted(motor_id, accepted / 1000.0, requested_speed / 100.0)

    def rotate_forward(self, motor_id: int, angle_deg: float, *, speed_rpm: float = 0.2) -> MotionAccepted:
        if not math.isfinite(angle_deg) or angle_deg <= 0:
            raise ValueError("angle_deg 必须为正数")
        return self.move_relative(motor_id, angle_deg, speed_rpm=speed_rpm)

    def rotate_reverse(self, motor_id: int, angle_deg: float, *, speed_rpm: float = 0.2) -> MotionAccepted:
        if not math.isfinite(angle_deg) or angle_deg <= 0:
            raise ValueError("angle_deg 必须为正数")
        return self.move_relative(motor_id, -angle_deg, speed_rpm=speed_rpm)

    def get_motion_profile(self, motor_id: int) -> MotionProfile:
        return MotionProfile(*(self.read_pa(motor_id, p) for p in (40, 41, 42)))

    def set_motion_profile(self, motor_id: int, *, accel_ms: int = 1500,
                           decel_ms: int = 1500, s_curve_ms: int = 100) -> MotionProfile:
        self._axis(motor_id)
        frame = build_motion_profile(motor_id, accel_ms, decel_ms, s_curve_ms)
        self.stop(motor_id)
        self._request(frame)
        actual = self.get_motion_profile(motor_id)
        if actual != MotionProfile(accel_ms, decel_ms, s_curve_ms):
            raise MotorError(f"加减速参数读回不一致: {actual}")
        return actual

    def close(self, *, stop: bool = True) -> None:
        """默认向两轴发送停止后关闭；失败仍关闭端口，但抛出异常报告不确定状态。"""
        with self._lock:
            if self._port is None:
                return
            failures = []
            try:
                if stop:
                    for axis in (1, 2):
                        try:
                            if self._faulted:
                                self._port.write(build_request(axis, CMD_STOP))
                                raise CommunicationError("仅尝试发送停止，无法确认应答")
                            self.stop(axis)
                        except Exception as exc:
                            failures.append(f"Motor {axis}: {exc}")
            finally:
                try:
                    self._port.close()
                except Exception as exc:
                    failures.append(f"关闭串口失败: {exc}")
                finally:
                    self._port = None
                    self._parser.reset()
            if failures:
                raise CommunicationError("端口已关闭，但停止未确认：" + "; ".join(failures))

    def __enter__(self) -> MotorController:
        return self.connect()

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        try:
            self.close()
        except MotorError as close_error:
            if exc_type is None:
                raise
            warnings.warn(str(close_error), RuntimeWarning)
        return False
