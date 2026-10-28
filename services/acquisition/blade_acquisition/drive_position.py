"""Joint controller feedback positioning for point recall and linked acquisition.

The caller owns the serial connection and the persistent two-axis motion guard.
These commands are sequential, not synchronous interpolation; neither a command
ACK nor one axis reaching its target proves the joint operation has completed.
"""
from __future__ import annotations

import json
import math
import time
from types import SimpleNamespace

from .turntable import (
    joint_snapshots, require_position_ready, require_stop_confirmed, wait_ready_snapshots,
)
from .turntable_driver import MotorError
from .turntable_driver.protocol import validate_output_angle, OUTPUT_POSITION_TOLERANCE_DEG
from .preloaded_points import point_command, completion_snapshots


class DrivePositionError(MotorError):
    def __init__(self, message, evidence):
        super().__init__(message)
        self.evidence = evidence


_REFERENCE_FIELDS = ("origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits")
_TOLERANCE = OUTPUT_POSITION_TOLERANCE_DEG
_POLL_SECONDS = .02


def _reference(value):
    return [[value["axes"][str(axis)][key] for key in _REFERENCE_FIELDS] for axis in (1, 2)]


def _signature(value):
    if isinstance(value, str):
        value = json.loads(value)
    if (not isinstance(value, (tuple, list)) or len(value) != 2 or
            any(not isinstance(row, (tuple, list)) or len(row) != 4 or
                any(type(part) is not int for part in row) for row in value)):
        raise ValueError("双轴定位必须提供完整的原参考签名")
    return [list(row) for row in value]


def _check_running_feedback(feedback, original, signature, starts, targets, follow_error_limit):
    """0x20 reads reference identity and units afresh during every joint sample."""
    for index, item in enumerate(feedback):
        axis = index + 1
        baseline = original["axes"][str(axis)]
        if [getattr(item, key) for key in _REFERENCE_FIELDS] != signature[index]:
            raise MotorError(f"轴{axis}参考位或反馈计数单位已变化")
        if (item.fault or item.home_phase not in (0, 7, 8) or
                not item.flags & 1):
            raise MotorError(f"轴{axis}反馈存在故障、参考失效或回零状态异常")
        if item.flags & 7 != baseline["flags"] & 7:
            raise MotorError(f"轴{axis}参考或保护开关已变化")
        guard = baseline["guard"]
        angle = item.output_angle_deg
        limit = 35 if axis == 1 else 180
        if angle is None or not math.isfinite(angle) or abs(angle) > limit:
            raise MotorError(f"轴{axis}实际角度无效或超出产品范围")
        if not min(starts[index], targets[index]) - follow_error_limit <= angle <= max(starts[index], targets[index]) + follow_error_limit:
            raise MotorError(f"轴{axis}明显反向或越过目标行程包络")
        if guard["soft_enabled"] and not guard["minimum_deg"] <= angle <= guard["maximum_deg"]:
            raise MotorError(f"轴{axis}实际角度超出软限位")
        channels = (guard["negative"], guard["positive"], guard["home"]) if guard["home_at_end"] else (
            guard["negative"], guard["positive"])
        if guard["hardware_enabled"] and any(ch is not None and item.active_inputs & (1 << ch)
                                            for ch in channels):
            raise MotorError(f"轴{axis}端点限位已触发")


def _stopped(value):
    return all(require_stop_confirmed(value, SimpleNamespace(axis=axis)) is None for axis in (1, 2))


def _stop_both(motor, evidence, emit, timeout_s):
    """Attempt both STOPs even if one fails; never replay a motion command."""
    errors = []
    for axis in (1, 2):
        try:
            evidence["lastStopCommand"] = {"axis": axis, "monotonicNs": time.monotonic_ns()}
            emit("stop_command_sending", axis=axis, best_effort=True)
            motor.stop(axis, wait=False)
        except Exception as exc:
            errors.append(f"轴{axis}停止请求：{exc}")
    deadline, zero_samples = time.monotonic() + timeout_s, 0
    while time.monotonic() < deadline:
        try:
            one, two = joint_snapshots(motor)
            evidence["feedback"] = one
            _stopped(one)
            # The selected-axis status (alarm/limit/RPM) is distinct in each view.
            require_stop_confirmed(two, SimpleNamespace(axis=2))
            zero_samples += 1
            if zero_samples >= 2:
                evidence["stopConfirmed"] = True
                break
        except Exception as exc:
            message = f"停止读回：{exc}"
            if message not in errors:
                errors.append(message)
            zero_samples = 0
            # A faulted SDK connection cannot be repaired by retrying telemetry.
            if getattr(motor, "_faulted", False):
                break
        time.sleep(_POLL_SECONDS)
    evidence["stopErrors"] = errors[:2] + errors[2:][-6:]
    emit("stop_confirmed" if evidence["stopConfirmed"] else "stop_unconfirmed",
         best_effort=True)


def execute_drive_position(motor, *, targets, speed_rpm, reference_signature,
                                cancel, timeout_s=15.0, observe=None, initial_snapshots=None,
                                follow_error_limit=.75, on_stopped=None, point_index=None):
    """Position both axes using the existing serial owner and fresh joint readback.

    Returns joint ``feedback`` and ``stopConfirmed`` evidence. Failures raise
    DrivePositionError carrying the same evidence after trying to stop BOTH
    axes. No references, limits, PA motion profiles or alarms are modified.
    """
    started_ns = time.monotonic_ns()
    evidence = {
        "mode": "drive_internal", "state": "checking",
        "startedMonotonicNs": started_ns, "stopConfirmed": False, "feedback": None,
        "toleranceDeg": _TOLERANCE, "motionCommanded": False, "events": [],
        "followErrorLimitDeg": follow_error_limit,
        "positionProtocol": getattr(motor, "point_position_protocol", None),
        "firstMotionSeconds": {}, "commandAckSeconds": {}, "measurementDuringMotion": False,
    }

    def emit(phase, *, best_effort=False, **details):
        event = {"phase": phase, "monotonicNs": time.monotonic_ns(),
                 "seconds": (time.monotonic_ns() - started_ns) / 1e9, **details}
        evidence["events"].append(event)
        del evidence["events"][:-128]
        if phase in ("command_sending", "wire_sending"):
            evidence["lastMotionCommand"] = dict(event)
        if observe:
            try:
                observe(dict(event))
            except Exception:
                if not best_effort:
                    raise

    deadline = time.monotonic() + timeout_s if isinstance(timeout_s, (int, float)) else 0

    def check_cancel_timeout():
        if cancel.is_set():
            raise MotorError("双轴反馈定位已取消")
        if time.monotonic() >= deadline:
            raise MotorError("双轴反馈定位超时")

    try:
        bank = point_command(motor, targets, point_index=point_index)
        if bank is not None:
            evidence.update(positionProtocol=bank['protocol'], bankId=bank['route_id'],
                            pointIndex=bank.get('index'), toleranceDeg=bank['tolerance_deg'])
        tolerance = bank['tolerance_deg'] if bank else _TOLERANCE
        if (isinstance(follow_error_limit, bool) or not isinstance(follow_error_limit, (int, float)) or
                not math.isfinite(follow_error_limit) or not .5 <= follow_error_limit <= 10):
            raise ValueError("定位行程误差上限范围0.5～10°")
        if (isinstance(speed_rpm, bool) or not isinstance(speed_rpm, (int, float)) or
                not math.isfinite(speed_rpm) or not .02 <= speed_rpm <= 10):
            raise ValueError("反馈定位速度范围0.02～10 rpm")
        if (isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float)) or
                not math.isfinite(timeout_s) or not 2 <= timeout_s <= 600):
            raise ValueError("反馈定位超时须为2～600秒")
        if not isinstance(targets, (tuple, list)) or len(targets) != 2:
            raise ValueError("双轴定位必须提供两个目标角度")
        for axis, angle in enumerate(targets, 1):
            validate_output_angle(axis, angle)
        signature = _signature(reference_signature)
        evidence.update(targets=list(targets), speedLimitRpm=speed_rpm)
        check_cancel_timeout()
        trajectory = motor.get_trajectory_status()
        if trajectory.state not in (0, 6, 8) or trajectory.fault not in (0, 1):
            raise MotorError("控制器有待执行轨迹、运行任务或故障，未启动反馈定位")
        initial = initial_snapshots
        if initial is None or len(initial) != 2 or any(
                not 0 <= time.time() - value.get("queryStartedAt", 0) <= 1.0 for value in initial):
            initial = joint_snapshots(motor)
        evidence["feedback"] = initial[0]
        initial = wait_ready_snapshots(motor, initial=initial, cancel=cancel,
            timeout_s=max(0, min(5.0, deadline - time.monotonic())),
            observe=lambda **details: emit("waiting_for_stop", **details))
        evidence["feedback"] = initial[0]
        configs = [SimpleNamespace(axis=axis, targetAngleDeg=targets[axis - 1]) for axis in (1, 2)]
        for value, config in zip(initial, configs):
            require_position_ready(value, config)
        if _reference(initial[0]) != signature:
            raise MotorError("原参考位或反馈计数单位已变化，未启动反馈定位")
        for axis in (1, 2):
            baseline = initial[0]["axes"][str(axis)]
            guard = baseline["guard"]
            channels = (guard["negative"], guard["positive"], guard["home"]) if guard["home_at_end"] else (
                guard["negative"], guard["positive"])
            if any(ch is not None and (type(ch) is not int or not 0 <= ch <= 5) for ch in channels):
                raise MotorError(f"轴{axis}限位输入配置无效")
            if guard["hardware_enabled"] and any(ch is not None and baseline["active_inputs"] & (1 << ch)
                                                for ch in channels):
                raise MotorError(f"轴{axis}端点限位已触发")
            if baseline["display_mode"] != 3 or baseline["command_counts_per_rev"] <= 0:
                raise MotorError(f"轴{axis}反馈计数单位无效")
        # Capability/freshness is required, never silently fall back to estimated pose.
        grouped = getattr(motor, "move_axes_to_angles_verified", None)
        if not callable(grouped) and bank is None:
            positions = motor.get_axis_positions()
            if len(positions) != 2 or any(not p.usable or p.source != 0 or p.motor_rpm or p.alarm_code or
                   p.guard_fault or p.flags & 16 or not math.isfinite(p.angle_deg) for p in positions):
                raise MotorError("两轴新鲜实测反馈未确认停稳，未启动反馈定位")
        check_cancel_timeout()
        starts = [initial[0]["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2)]
        distance = max(abs(target - start) for target, start in zip(targets, starts))
        if distance / (speed_rpm * 6) >= timeout_s:
            raise MotorError("反馈定位最低行程时间已超过超时上限")
        evidence["startAngles"] = starts
        emit("preflight_complete", angles=starts)
        # Do not wait for axis 1 to arrive before issuing axis 2. These are two
        # individually protected commands, not a simultaneous hardware trigger.
        if bank is not None:
            if abs(speed_rpm - bank['speed_rpm']) > .005001:
                raise MotorError("预存转速与本次任务不一致，请重新预存")
            if not all(abs(start - target) <= tolerance + 1e-9 for start, target in zip(starts, targets)):
                emit("command_sending", axis=1, pointIndex=bank.get('index'))
                check_cancel_timeout()
                evidence['motionCommanded'] = True
                emit("wire_sending", axes=[1, 2], protocol=bank['protocol'],
                     bankId=bank['route_id'], pointIndex=bank.get('index'))
                accepted = (motor.run_preloaded_point(bank['route_id'], bank['index'], token=bank['token'])
                            if bank['protocol'] == '0x43' else motor.move_axes_point(
                                bank['targets'], speed_rpm=bank['speed_rpm'], tolerance_deg=tolerance))
                evidence['boardPrepareMs'] = accepted['board_prepare_ms']
                for axis in (1, 2):
                    evidence['commandAckSeconds'][str(axis)] = (time.monotonic_ns() - started_ns) / 1e9
                emit("command_accepted", axes=[1, 2], boardPrepareMs=evidence['boardPrepareMs'])
            else:
                emit("already_at_target", angles=starts)
        elif callable(grouped):
            # Preserve the historical positioning-call timing marker, and add a
            # separate wire marker after SDK validation for honest A/B timing.
            emit("command_sending", axis=1, target=targets[0])
            def command_event(phase, **details):
                check_cancel_timeout()
                axis = str(details["axis"])
                if phase == "wire_sending":
                    evidence["motionCommanded"] = True
                    evidence.setdefault("wireCommandSeconds", {})[axis] = (time.monotonic_ns() - started_ns) / 1e9
                elif phase == "command_accepted":
                    evidence["commandAckSeconds"][axis] = (time.monotonic_ns() - started_ns) / 1e9
                emit(phase, **details)
            accepted = grouped(targets, speed_rpm=speed_rpm, cancel=cancel,
                               references=signature, start_angles=starts, observe=command_event)
            if accepted is None:
                raise MotorError("双轴反馈定位已取消，未继续运动")
            if len(accepted) != 2 or [item.motor_id for item in accepted] != [1, 2]:
                raise MotorError("双轴反馈定位应答轴不一致")
        for axis, target in (() if callable(grouped) or bank is not None else enumerate(targets, 1)):
            check_cancel_timeout()
            if abs(target - starts[axis - 1]) <= .0005:
                emit("axis_already_at_target", axis=axis)
                continue
            emit("command_sending", axis=axis, target=target)
            check_cancel_timeout()
            evidence["motionCommanded"] = True  # ACK loss still requires both STOPs.
            # The SDK reads and validates the reference/start once under its lock;
            # no second helper read followed by another identical SDK read.
            accepted = motor.move_to_angle_verified(
                axis, target, speed_rpm=speed_rpm, cancel=cancel,
                reference=signature[axis - 1], start_angle=starts[axis - 1])
            if accepted is None:
                raise MotorError("反馈定位命令取消，未继续下一轴")
            if accepted.motor_id != axis:
                raise MotorError("反馈定位应答轴不一致")
            evidence["commandAckSeconds"][str(axis)] = (time.monotonic_ns() - started_ns) / 1e9
            emit("command_accepted", axis=axis, outputSpeedRpm=accepted.output_speed_rpm)
        zero_samples = 0
        fresh = False
        while True:
            check_cancel_timeout()
            query_ns = time.monotonic_ns()
            queried_at = time.time()
            positions = motor.get_axis_positions(fresh=fresh) if bank else motor.get_axis_positions()
            received_at = time.time()
            pose_ns = time.monotonic_ns()
            if len(positions) != 2:
                raise MotorError("两轴位置反馈不完整")
            # LightCheck(2) reuses its recent point-control sample (source 1)
            # while moving. Include the host transaction in the age budget so
            # a delayed TCP reply cannot make an old control sample look fresh.
            age_ms = [p.sample_age_ms + (pose_ns - query_ns) / 1e6 for p in positions]
            readings = [{"axis": axis, "targetAngleDeg": targets[axis - 1],
                         "actualAngleDeg": p.angle_deg, "motorRpm": p.motor_rpm,
                         "flags": p.flags, "flagsHex": f"0x{p.flags:04X}",
                         "guardFault": p.guard_fault, "alarmCode": p.alarm_code,
                         "source": p.source, "sampleAgeMs": p.sample_age_ms,
                         "conservativeAgeMs": age_ms[axis - 1]}
                        for axis, p in enumerate(positions, 1)]
            evidence["lastPositionReadings"] = readings
            # Record before validation so STOP cleanup cannot replace the first
            # abnormal observation with a later, apparently healthy sample.
            emit("position_observed", axes=readings)
            for axis, p in enumerate(positions, 1):
                if (not p.usable or p.source not in (0, 1) or
                        not 0 <= p.sample_age_ms <= age_ms[axis - 1] <= 1000 or
                        not p.flags & 1 or
                        not math.isfinite(p.angle_deg) or
                        p.alarm_code or p.guard_fault):
                    raise MotorError(f"轴{axis}实测反馈过期、故障或参考无效")
                if not min(starts[axis - 1], targets[axis - 1]) - follow_error_limit <= p.angle_deg <= max(
                        starts[axis - 1], targets[axis - 1]) + follow_error_limit:
                    start, target = starts[axis - 1], targets[axis - 1]
                    reverse = (p.angle_deg - start) * (target - start) < 0
                    evidence["rejectedPosition"] = {
                        "axis": axis, "startAngleDeg": start, "targetAngleDeg": target,
                        "actualAngleDeg": p.angle_deg, "actualCounts": p.actual_counts,
                        "motorRpm": p.motor_rpm, "positionSource": p.source,
                        "conservativeAgeMs": age_ms[axis - 1],
                        "followErrorLimitDeg": follow_error_limit,
                        "reason": "reverse" if reverse else "overshoot",
                    }
                    emit("position_rejected", **evidence["rejectedPosition"])
                    reason = "反向移动" if reverse else "越过目标"
                    raise MotorError(f"轴{axis}实测位置明显反向或越过目标行程包络"
                                     f"（{reason}：起点{start:.3f}°，目标{target:.3f}°，"
                                     f"实测{p.angle_deg:.3f}°，保护限{follow_error_limit:.3f}°），已请求停止")
            angles = [p.angle_deg for p in positions]
            emit("position_sample", angles=angles, motorRpm=[p.motor_rpm for p in positions],
                 sampleAgeMs=[p.sample_age_ms for p in positions],
                 conservativeAgeMs=age_ms, sources=[p.source for p in positions],
                 queryStartedMonotonicNs=query_ns, poseReadMonotonicNs=pose_ns,
                 feedbackReadings=[{"output_angle_deg": p.angle_deg, "motor_rpm": p.motor_rpm,
                                    "actual_counts": p.actual_counts, "flags": p.flags,
                                    "fault": p.guard_fault, "positionSource": p.source} for p in positions],
                 referencePending=True)
            for axis, p in enumerate(positions, 1):
                if str(axis) not in evidence["firstMotionSeconds"] and abs(p.angle_deg - starts[axis - 1]) >= .01:
                    evidence["firstMotionSeconds"][str(axis)] = (pose_ns - started_ns) / 1e9
                    emit("first_motion_observed", axis=axis, angle=p.angle_deg,
                         queryStartedMonotonicNs=query_ns, poseReadMonotonicNs=pose_ns,
                         sampleAgeMs=p.sample_age_ms)
            # A cached zero-speed sample is not an independent stop observation.
            # Once the firmware ends the point task it returns direct source 0;
            # only then may the full independent joint check confirm arrival.
            settled = all(p.source == 0 and p.motor_rpm == 0 and not p.flags & 0x30 and abs(p.angle_deg - target) <= tolerance + 1e-9
                          for p, target in zip(positions, targets))
            if bank:
                settled = settled and all(age <= 200 and not p.flags & 0x30
                                          for p, age in zip(positions, age_ms))
                for axis, p in enumerate(positions, 1):
                    baseline = initial[0]['axes'][str(axis)]
                    guard = baseline['guard']
                    if p.flags & 7 != baseline['flags'] & 7:
                        raise MotorError(f"轴{axis}参考或保护状态发生变化")
                    if guard['soft_enabled'] and not guard['minimum_deg'] <= p.angle_deg <= guard['maximum_deg']:
                        raise MotorError(f"轴{axis}实际位置超出软范围")
            zero_samples = zero_samples + 1 if settled else 0
            board_complete = bool(bank and settled and (all(p.flags & 0x40 for p in positions) or zero_samples >= 2))
            if board_complete or bank is None and zero_samples >= 1:
                # The joint pose is the first stopped observation. Read the
                # full independent statuses/references/guards directly as the
                # second, rather than duplicate 0x20 reads just before it.
                final = (completion_snapshots(initial, positions, queried_at, received_at) if board_complete else
                         joint_snapshots(motor, stopped_positions=positions, positions_observed_ns=query_ns)
                         if callable(getattr(motor, "get_status_from_position", None)) else joint_snapshots(motor))
                final = wait_ready_snapshots(motor, initial=final, cancel=cancel,
                    timeout_s=max(0, min(5.0, deadline - time.monotonic())),
                    observe=lambda **details: emit("waiting_for_stop", **details))
                for value, config in zip(final, configs):
                    require_position_ready(value, config)
                if (_reference(final[0]) != signature or any(
                        final[0]["axes"][str(axis)]["guard"] != initial[0]["axes"][str(axis)]["guard"]
                        for axis in (1, 2))):
                    raise MotorError("定位期间参考、反馈单位或保护配置已变化")
                _check_running_feedback([SimpleNamespace(**final[0]["axes"][str(axis)]) for axis in (1, 2)],
                                        initial[0], signature, starts, targets, follow_error_limit)
                if any(abs(final[0]["axes"][str(axis)]["output_angle_deg"] - targets[axis - 1]) >
                       tolerance + 1e-9 for axis in (1, 2)):
                    raise MotorError("最终读回未确认两轴到位")
                check_cancel_timeout()
                evidence.update(feedback=final[0], stopConfirmed=True, state="complete",
                                controllerCompletionConfirmed=board_complete,
                                actualSeconds=(time.monotonic_ns() - started_ns) / 1e9,
                                actualAngles=[final[0]["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2)])
                if on_stopped is not None:
                    on_stopped(final)
                emit("arrived", angles=evidence["actualAngles"])
                return evidence
            if bank:
                # The MCU owns reference validation, control and stop confirmation.
                # No repeated full register reads between indexed point commands.
                fresh = all(p.motor_rpm == 0 and not p.flags & 0x30 and
                            abs(p.angle_deg - target) <= tolerance + 1e-9
                            for p, target in zip(positions, targets))
            else:
                feedback = tuple(motor.get_feedback(axis) for axis in (1, 2))
                _check_running_feedback(feedback, initial[0], signature, starts, targets, follow_error_limit)
            check_cancel_timeout()
            time.sleep(_POLL_SECONDS)
    except Exception as exc:
        evidence["firstAbnormalReadings"] = evidence.get("lastPositionReadings")
        evidence.update(state="error", error=str(exc), actualSeconds=(time.monotonic_ns() - started_ns) / 1e9)
        if evidence["motionCommanded"]:
            evidence["stopConfirmed"] = False
            _stop_both(motor, evidence, emit, min(5.0, timeout_s))
        emit("failed", error=str(exc), stopConfirmed=evidence["stopConfirmed"], best_effort=True)
        raise DrivePositionError(str(exc), evidence) from exc
