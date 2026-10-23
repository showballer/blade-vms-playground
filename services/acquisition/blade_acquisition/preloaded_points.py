"""Capture route ownership for the controller's volatile, indexed point bank.

One radial measurement uses one bank (up to 16 circular positions). The work
origin is a separate absolute move, not a seventeenth measurement position.
Six banks are retained on demand; bank 5/6 need v3.9.4 firmware.
"""
import copy
import json
import math
import secrets

from .turntable import TurntableConfig, require_position_ready
from .turntable_driver import MotorError
from .turntable_driver.point_bank import CAPACITY, SLOTS, normalize_points
from .turntable_driver.protocol import OUTPUT_POSITION_TOLERANCE_DEG as TOLERANCE


class PreloadedPointsCache:
    def __init__(self):
        self.records = {}  # LRU process memory; never a durable proof of board state

    def prepare(self, motor, *, port, points, origin, speed, feedback, cancel):
        motor._blade_preloaded_route = None
        probe = getattr(motor, "probe_preloaded_routes", None)
        if not callable(probe):
            return None
        status = probe()
        if status is None:  # explicit UNKNOWN_COMMAND only
            self.records.clear()
            return None
        points = normalize_points(points)
        origin = normalize_points([origin])[0] if origin is not None else None
        if len(points) > CAPACITY:
            raise ValueError("一个测点最多预存16个圆周点位，请将圆周点位间隔设为22.5°或更大")
        if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not .02 <= speed <= 10:
            raise ValueError("点位预存转速范围0.02～10 rpm")
        # Bank speed has 0.01 rpm resolution. Never round a user's ceiling up.
        speed = math.floor((speed + 1e-10) * 100) / 100
        # Whole-route validation before BEGIN: no partial route can initiate motion.
        for angles in (*points, *((origin,) if origin is not None else ())):
            for axis, angle in enumerate(angles, 1):
                require_position_ready(feedback, TurntableConfig(port=port, axis=axis,
                    protocol="position", targetAngleDeg=angle, speedRpm=speed))
        identity = {str(axis): {key: feedback["axes"][str(axis)][key] for key in
                    ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits", "guard")}
                    for axis in (1, 2)}
        key = json.dumps([port, points, origin, speed, TOLERANCE, identity], sort_keys=True)
        record = self.records.get(key)
        # Each distinct radial route occupies one bank. A seventh replaces the
        # least recently selected bank only while the service owns an idle device.
        occupied = {r['route_id'] for r in self.records.values()}
        slot = (record['route_id'] if record else next((i for i in range(1, SLOTS + 1) if i not in occupied),
                next(iter(self.records.values()))['route_id'] if self.records else 1))
        if slot != 1:
            status = motor.get_preloaded_route(slot)
        reused = bool(record and record['key'] == key and status['ready'] and all(
            status[field] == record[field] for field in
            ('token', 'speed_rpm', 'tolerance_deg', 'count', 'loaded')))
        if not reused:
            self.records = {k: r for k, r in self.records.items() if r['route_id'] != slot}
            token = secrets.randbits(32) or 1
            while token == status['token']:
                token = secrets.randbits(32) or 1
            record = motor.preload_route(points, route_id=slot, speed_rpm=speed,
                                         tolerance_deg=TOLERANCE, token=token, cancel=cancel)
            record = dict(record, key=key, port=port, origin=origin)
        self.records.pop(key, None)
        self.records[key] = copy.deepcopy(record)
        if cancel.is_set():
            raise MotorError("预存已取消，未执行点位移动")
        motor._blade_preloaded_route = copy.deepcopy(record)
        return {"mode": "preloaded", "pointCount": len(points), "bankId": record['route_id'],
                "speedRpm": record['speed_rpm'], "toleranceDeg": record['tolerance_deg'],
                "reused": reused, "uploadElapsedMs": 0 if reused else record['upload_elapsed_ms']}


def point_command(motor, targets, *, point_index=None):
    record = getattr(motor, "_blade_preloaded_route", None)
    if record is None:
        return None
    target = normalize_points([targets])[0]
    if point_index is not None:
        if (type(point_index) is not int or not 0 <= point_index < len(record['points']) or
                record['points'][point_index] != target):
            raise MotorError("点位编号与预存坐标不一致，未发送运动")
        return dict(protocol="0x43", index=point_index, targets=target, **record)
    try:
        index = tuple(record['points']).index(target)
    except ValueError:
        if record.get('origin') != target:
            raise MotorError("目标不属于本次预存点位，未发送运动")
        return dict(protocol="0x1A", targets=target, **record)
    return dict(protocol="0x43", index=index, targets=target, **record)


def completion_snapshots(initial, positions, queried_at, received_at):
    """Reuse direct completion evidence. Reference/guard timestamps stay original.

    The sealed bank binds references/units/guard configuration; the MCU rejects
    invalidated banks and guards the move. These fields are NOT falsely refreshed
    by a 0x37 position read.
    """
    result = copy.deepcopy(initial)
    for value in result:
        for axis, position in enumerate(positions, 1):
            item = value['axes'][str(axis)]
            age = position.sample_age_ms / 1000 + max(0, received_at - queried_at)
            item.update(referenceObservedAt=item.get('referenceObservedAt', item.get('observedAt')),
                        guardObservedAt=item.get('guardObservedAt', item.get('observedAt')),
                        output_angle_deg=position.angle_deg, actual_counts=position.actual_counts,
                        motor_rpm=position.motor_rpm, flags=position.flags, fault=position.guard_fault,
                        observedAt=received_at - age, positionSource=position.source,
                        positionSampleAgeMs=position.sample_age_ms)
        selected = positions[value['axis'] - 1]
        value.update(outputAngleDeg=selected.angle_deg, motorRpm=selected.motor_rpm,
                     outputRpm=selected.motor_rpm / 50, positionRaw=selected.actual_counts,
                     alarmCode=selected.alarm_code, queryStartedAt=queried_at, observedAt=received_at,
                     positionSource="0x37", controllerCompletionConfirmed=True)
    return result
