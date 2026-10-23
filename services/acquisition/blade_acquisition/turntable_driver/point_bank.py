"""v3.9.4 RAM point banks (vendor lazer_check 2ec1b1b).

No hardware access here. RUN carries only slot, token and point index;
speed/tolerance belong to BEGIN, angles to POINT. Never retry a RUN.
"""
import math
import struct

from .protocol import build_request, validate_output_angle

TOLERANCE = .2
CAPACITY = 16
SLOTS = 6


def identity(slot, token=1):
    if type(slot) is not int or not 1 <= slot <= SLOTS:
        raise ValueError("点位库编号须为1～6（库5、6需要v3.9.4固件）")
    if type(token) is not int or not 1 <= token <= 0xFFFFFFFF:
        raise ValueError("点位库令牌须为非零uint32")


def normalize_points(points):
    result = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("预存点位需要两轴角度")
        for axis, angle in enumerate(point, 1):
            validate_output_angle(axis, angle)
        result.append(tuple(round(angle * 1000) / 1000 for angle in point))
    if not result:
        raise ValueError("至少需要一个预存点位")
    return tuple(result)


def upload_frames(points, *, slot, token, speed_rpm, tolerance_deg=TOLERANCE):
    identity(slot, token)
    points = normalize_points(points)
    if len(points) > CAPACITY:
        raise ValueError("每个点位库最多16个点")
    for value, lo, hi, label in ((speed_rpm, .01, 100, "转速"), (tolerance_deg, .01, .5, "到位容差")):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lo <= value <= hi:
            raise ValueError(f"{label}必须为{lo}～{hi}的有限数字")
    frames = [build_request(1, 0x40, struct.pack(">IHHB", token,
        math.floor(speed_rpm * 100 + .5), math.floor(tolerance_deg * 1000 + .5), len(points)), parameter=slot)]
    frames.extend(build_request(1, 0x41, struct.pack(">IBii", token, index,
        *(round(angle * 1000) for angle in point)), parameter=slot) for index, point in enumerate(points))
    frames.append(build_request(1, 0x42, struct.pack(">I", token), parameter=slot))
    return frames


def run_frame(slot, token, index):
    identity(slot, token)
    if type(index) is not int or not 0 <= index < CAPACITY:
        raise ValueError("点位编号须为0～15")
    return build_request(1, 0x43, struct.pack(">IB", token, index), parameter=slot)


def status_frame(slot):
    identity(slot)
    return build_request(1, 0x44, parameter=slot)


def decode_status(data):
    if len(data) != 11:
        raise ValueError("点位库状态长度错误")
    token, speed, tolerance, count, loaded, ready = struct.unpack(">IHHBBB", data)
    if count > CAPACITY or loaded > count or ready > 1 or speed > 10000:
        raise ValueError("点位库状态字段错误")
    if ready and (not token or not speed or not count or loaded != count or not 10 <= tolerance <= 500):
        raise ValueError("点位库就绪状态无效")
    return dict(token=token, speed_rpm=speed / 100, tolerance_deg=tolerance / 1000,
                count=count, loaded=loaded, ready=bool(ready))
