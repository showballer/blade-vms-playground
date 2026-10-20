"""Buffered two-axis protocol data. Importing this module never accesses hardware."""
from dataclasses import dataclass
import math
import struct

from .protocol import validate_output_angle

STATES = ("空闲", "上传中", "已校验待启动", "轨迹运行", "终点收敛", "两轴停止确认", "完成", "故障", "已取消")
FAULTS = ("无", "人工停止", "参考/保护无效", "范围/制动余量不足", "限位触发", "驱动通信故障",
          "驱动器报警", "跟随误差超限", "调度超过1秒", "3秒心跳丢失", "未停在起点", "轨迹数据错误", "终点收敛超时", "路径推进超时")


@dataclass(frozen=True)
class AxisPosition:
    """Vendor 0x37 observation; sample age belongs to each individual axis."""
    angle_deg: float | None
    actual_counts: int
    motor_rpm: int
    flags: int
    sample_age_ms: int
    alarm_code: int
    guard_fault: int
    source: int  # 0=drive read, 1=controller cache, 2=read failure

    @property
    def usable(self):
        return self.angle_deg is not None and self.source != 2 and self.sample_age_ms <= 1000


def decode_axes(data: bytes) -> tuple[AxisPosition, AxisPosition]:
    if len(data) != 40:
        raise ValueError("两轴位置数据长度错误")
    axes = []
    for offset in (0, 20):
        angle, counts, rpm, flags, age, alarm, fault, source = struct.unpack_from(">iihHIHBB", data, offset)
        if source > 2:
            raise ValueError("位置来源字段错误")
        axes.append(AxisPosition(angle / 1000 if flags & 1 and source != 2 else None,
                                 counts, rpm, flags, age, alarm, fault, source))
    return tuple(axes)


@dataclass(frozen=True)
class TrajectoryPoint:
    time_s: float
    axis1_deg: float
    axis2_deg: float


@dataclass(frozen=True)
class TrajectoryStatus:
    session: int
    state: int
    fault: int
    point_count: int
    uploaded_count: int
    elapsed_s: float
    duration_s: float
    max_gap_ms: int
    last_cycle_ms: int
    axis1_deg: float
    axis2_deg: float
    error1_deg: float
    error2_deg: float

    @property
    def active(self):
        return self.state in (3, 4, 5)

    @property
    def feedback_available(self):
        return (self.state in (3, 4) or self.max_gap_ms > 0) and self.fault not in (2, 5)

    @property
    def state_text(self):
        return STATES[self.state]

    @property
    def fault_text(self):
        return FAULTS[self.fault]


def decode_status(data: bytes) -> TrajectoryStatus:
    if len(data) != 40:
        raise ValueError("轨迹状态长度错误")
    session, state, fault, count, uploaded, elapsed, duration, gap, cycle, a1, a2, e1, e2 = struct.unpack(">HBBHHIIIIiiii", data)
    if state > 8 or fault > 13 or count > 128 or uploaded > count or duration > 600000:
        raise ValueError("轨迹状态字段错误")
    return TrajectoryStatus(session, state, fault, count, uploaded, elapsed / 1000, duration / 1000,
                            gap, cycle, a1 / 1000, a2 / 1000, e1 / 1000, e2 / 1000)


def validate_points(points):
    """Validate at wire resolution before opening a write transaction."""
    points = tuple(points)
    if not 2 <= len(points) <= 128:
        raise ValueError("轨迹须为2～128点")
    normalized = []
    previous = -50
    for point in points:
        if not isinstance(point, TrajectoryPoint):
            raise ValueError("轨迹点类型错误")
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x)
               for x in (point.time_s, point.axis1_deg, point.axis2_deg)):
            raise ValueError("轨迹点必须为有限数字")
        validate_output_angle(1, point.axis1_deg)
        validate_output_angle(2, point.axis2_deg)
        ms = round(point.time_s * 1000)
        if not 0 <= ms <= 600000 or ms - previous < 50:
            raise ValueError("轨迹时间须递增至少50ms，且不超过600秒")
        normalized.append(TrajectoryPoint(ms / 1000, round(point.axis1_deg * 1000) / 1000,
                                           round(point.axis2_deg * 1000) / 1000))
        previous = ms
    if normalized[0].time_s != 0 or normalized[-1].time_s < 1:
        raise ValueError("轨迹首点时间须为0，持续至少1秒")
    return tuple(normalized)
