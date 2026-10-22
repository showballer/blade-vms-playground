"""Cancellable app(5) reference recovery, with one serial owner and no DAQ."""
from __future__ import annotations

import time

from .turntable import (snapshot, probe_motion_capability, reference_key, require_stop_confirmed,
                        reference_check, reference_change_message)
from .turntable_driver.motor_controller import CommandRejected
from .turntable_driver.protocol import CMD_READ_SPEED, CMD_READ_ALARM, CMD_READ_FEEDBACK, CMD_READ_GUARD

HOMING_TIMEOUT_SECONDS = 120
WRONG_DIRECTION_DEGREES = 0.15
READ_BUSY_SECONDS = 0.6

def run_turntable_homing(service, request):
    target = 35 if request.action == "mechanical_home" else 0
    motor, attempted, feedback = None, False, None
    searched, verified, cancelled, upper_at_start = False, False, False, False
    errors = []
    before = arrived_reference = None
    starting_angle = None

    def update(phase, value=None, **extra):
        with service.lock:
            service.turntable_snapshot["homing"].update(phase=phase, **extra)
            if value is not None:
                service.turntable_snapshot["feedback"] = value

    def check_cancel():
        if service.test_stop.is_set():
            raise InterruptedError("回零已停止")

    def readback(call):
        # At the DI0 stop transition firmware can reject a READ with BUSY.
        # Retry only those read-only commands for a bounded interval. Never
        # retry a start, configuration, stop or ambiguous transport failure.
        deadline = time.monotonic() + READ_BUSY_SECONDS
        while True:
            try:
                return call()
            except CommandRejected as exc:
                if (exc.status != 6 or exc.response.command not in
                        (CMD_READ_SPEED, CMD_READ_ALARM, CMD_READ_FEEDBACK, CMD_READ_GUARD) or
                        time.monotonic() >= deadline):
                    raise
                time.sleep(0.03)

    def ready(value):
        pitch = value["axes"]["1"]
        if value["alarmCode"] or value["limitFlags"] is not None and value["limitFlags"] & 4:
            raise RuntimeError("俯仰轴驱动报警或限位旁路，请先检查转盘状态")
        if any(axis["motor_rpm"] or axis["home_phase"] not in (0, 7, 8) for axis in value["axes"].values()):
            raise RuntimeError("请先确认两轴停止且没有其他回零任务")
        valid = pitch["output_angle_deg"] is not None and bool(pitch["flags"] & 1)
        # app(5) also rebuilds an invalid reference after a latched sensor fault.
        # Allow that explicit, full homing operation only with the known dual
        # wiring/polarity and both actual inputs inactive; never simply clear a
        # live limit or use arbitrary SET_REFERENCE as a substitute.
        sensor_latch = (pitch["fault"] == 1 and not pitch["flags"] & 16 and
            limits.get("enabled") is True and limits.get("horizontal_channel") == 2 and
            limits.get("raised_channel") == 0 and limits.get("active_high") is False and
            limits.get("positive_is_up") is False and limits.get("horizontal_deg") == -29 and
            limits.get("raised_deg") == 35 and pitch["raw_inputs"] & 5 == 5 and
            not pitch["active_inputs"] & 5)
        repair = (request.action == "mechanical_home" and not valid and
                  (pitch["fault"] in (0, 3, 7) or sensor_latch))
        if pitch["fault"] and not repair or pitch["flags"] & 16 and not repair:
            raise RuntimeError(f"俯仰轴故障码 {pitch['fault']}，请先在转盘状态检查中处理")
        if pitch["display_mode"] != 3 or pitch["command_counts_per_rev"] <= 0 or not 1 <= pitch["encoder_bits"] <= 32:
            raise RuntimeError("俯仰轴反馈计数单位无效，不能机械回零")
        if request.action == "horizontal_zero" and not valid:
            raise RuntimeError("俯仰轴参考无效，请先机械回零，再回水平0°")
        if valid:
            guard = pitch["guard"]
            if (not guard["soft_enabled"] or not pitch["flags"] & 2 or
                    not guard["minimum_deg"] <= target <= guard["maximum_deg"] or
                    not guard["minimum_deg"] - .01 <= pitch["output_angle_deg"] <= guard["maximum_deg"] + .01):
                raise RuntimeError("俯仰轴当前位置或目标超出有效软限位，请先检查参考与限位")
        return valid

    def at_upper_sensor(value, limits):
        pitch = value["axes"]["1"]
        return (limits.get("enabled") and limits.get("raised_channel") == 0 and
                limits.get("raised_deg") == 35 and limits.get("active_high") is False and not limits["pending"] and
                not pitch["raw_inputs"] & 1 and pitch["active_inputs"] & 1 and
                pitch["output_angle_deg"] is not None and abs(pitch["output_angle_deg"] - target) <= .1 and
                pitch["flags"] & 1 and not pitch["flags"] & 16 and not pitch["fault"] and
                not pitch["motor_rpm"] and pitch["home_phase"] in (0, 7) and not value["alarmCode"])

    def reached(value, *, after_stop=False):
        pitch = value["axes"]["1"]
        identity = reference_key(value)
        if searched and (identity["2"] != before["2"] or any(
                identity["1"][key] != before["1"][key] for key in ("display_mode", "command_counts_per_rev", "encoder_bits"))):
            raise RuntimeError("机械回零期间反馈计数单位或水平轴参考变化，已停止")
        awaiting_reference = searched and pitch["home_phase"] in range(1, 7) and pitch["fault"] == 3
        if pitch["fault"] and not awaiting_reference or pitch["home_phase"] == 8 or value["alarmCode"]:
            raise RuntimeError(f"俯仰回零失败：保护故障 {pitch['fault']}，驱动报警 {value['alarmCode']}")
        if value["limitFlags"] is not None and value["limitFlags"] & 4:
            raise RuntimeError("回零期间限位被旁路，已停止")
        if not searched and reference_key(value) != before:
            change = reference_check(before, value, "level_return")
            update("positioning", value, referenceChange=change)
            raise RuntimeError(reference_change_message("回零定位期间参考位或反馈计数单位变化，已停止", change))
        if not searched and pitch["output_angle_deg"] is None:
            raise RuntimeError("回零定位期间参考失效，已停止")
        if not searched and pitch["home_phase"] not in (0, 7):
            raise RuntimeError("回零定位期间出现其他回零状态，已停止")
        if (not searched and pitch["output_angle_deg"] is not None and
                abs(target - pitch["output_angle_deg"]) > abs(target - starting_angle) + WRONG_DIRECTION_DEGREES):
            raise RuntimeError("回零定位实际方向与目标相反，已请求停止；请核查控制板定位执行")
        if searched and pitch["home_phase"] == 0 and not (after_stop or upper_at_start):
            raise RuntimeError("机械回零未启动或已取消，未自动重试")
        if searched and pitch["home_phase"] != 7 and not ((after_stop or upper_at_start) and pitch["home_phase"] == 0):
            return False
        if searched and (pitch["output_angle_deg"] is None or abs(pitch["output_angle_deg"] - target) > 0.1):
            raise RuntimeError("机械回零完成反馈不是+35°，请核查限位参考，未自动重试")
        guard = pitch["guard"]
        return (pitch["output_angle_deg"] is not None and pitch["flags"] & 1 and pitch["flags"] & 2 and
                guard["soft_enabled"] and guard["minimum_deg"] <= target <= guard["maximum_deg"] and
                abs(pitch["output_angle_deg"] - target) <= 0.1 and
                not value["motorRpm"] and not pitch["motor_rpm"] and not pitch["flags"] & 16)

    try:
        motor = service.motor_factory(request.port, timeout=2.0, gear_ratio=50.0)
        motor.connect()
        feedback = snapshot(motor, 1)
        update("checking", feedback)
        capability = probe_motion_capability(motor).get("status")
        if capability and capability["state"] in (1, 2, 3, 4, 5):
            raise RuntimeError("控制器仍有待执行或运行轨迹，请先取消待执行轨迹或停止两轴")
        # No mutation before the firmware answers the new capability query.
        limits = motor.get_axis1_limits()
        if limits["pending"]:
            raise RuntimeError("控制器仍有机械回零任务，请先停止并重新读取")
        if service.motion_guard.warning and (service.motion_guard.identity != (request.port, 1) or
                                             2 in service._pending_turntable_axes(request.port)):
            raise RuntimeError(service.motion_guard.warning)
        valid = ready(feedback)
        check_cancel()
        service.motion_guard.mark(request, True, "俯仰回零停止尚未确认")
        attempted = True
        before = reference_key(feedback)
        starting_angle = feedback["axes"]["1"]["output_angle_deg"]
        if request.action == "mechanical_home" and (not valid or abs(starting_angle - target) > 0.1):
            # Mechanical recovery must actually seek DI0. On the connected
            # app(5) board, a valid-reference 0x14 position command moved away
            # from +35 and a small negative command also exceeded its endpoint.
            # Never use that position-mode shortcut for mechanical homing.
            # Configuring/searching rebuilds only the pitch reference; consumers
            # invalidate old work origins through the existing reference key.
            update("configuring_limits")
            motor.configure_axis1_homing(cancel=service.test_stop)
            check_cancel()
            searched = True
            feedback = readback(lambda: snapshot(motor, 1))
            limits = motor.get_axis1_limits()
            # On an already-active DI0 the connected board can establish +35
            # during configuration's pending stop. Confirm that actual sensor
            # and reference postcondition instead of issuing another start.
            upper_at_start = at_upper_sensor(feedback, limits)
            update("seeking_limit", feedback)
            if not upper_at_start:
                try:
                    motor.start_axis1_limit_homing(request.homingSpeedDegS, cancel=service.test_stop)
                except CommandRejected as exc:
                    if exc.status != 8:
                        raise
                    feedback = readback(lambda: snapshot(motor, 1))
                    limits = motor.get_axis1_limits()
                    upper_at_start = at_upper_sensor(feedback, limits)
                    if not upper_at_start:
                        raise
        else:
            # Level return still uses its existing, valid coordinates. A repeat
            # home at +35 is a no-op and preserves its reference.
            update("positioning")
            if request.action == "horizontal_zero":
                motor.move_to_angle(1, target, speed_rpm=request.homingSpeedDegS / 6, cancel=service.test_stop)
        deadline, settled, last_renew = time.monotonic() + HOMING_TIMEOUT_SECONDS, 0, 0
        while time.monotonic() < deadline:
            check_cancel()
            # Fresh phase first: never send a homing keepalive after DONE.
            pitch = readback(lambda: motor.get_feedback(1))
            if searched and pitch.home_phase in range(1, 7) and time.monotonic() - last_renew >= 0.8:
                motor.renew_continuous(1)
                last_renew = time.monotonic()
            feedback = readback(lambda: snapshot(motor, 1))
            update("seeking_limit" if searched else "positioning", feedback,
                   controllerPhase=feedback["axes"]["1"]["home_phase"])
            if reached(feedback):
                current_reference = reference_key(feedback)
                if settled and current_reference != arrived_reference:
                    raise RuntimeError("机械回零到位确认期间参考位变化，已停止")
                arrived_reference = current_reference
                settled += 1
            else:
                settled = 0
            if settled >= 2:
                verified = True
                break
            service.test_stop.wait(0.1)
        if not verified:
            raise RuntimeError("俯仰回零120秒内未确认到位，已请求停止，未自动重试")
    except InterruptedError:
        cancelled = True
    except Exception as exc:
        errors.append(str(exc))
    finally:
        if attempted:
            update("stopping")
            try:
                motor.stop(1)
                feedback = readback(lambda: snapshot(motor, 1))
                require_stop_confirmed(feedback, request)
                service._confirm_turntable_axis(request)
                if verified and (reference_key(feedback) != arrived_reference or not reached(feedback, after_stop=True)):
                    raise RuntimeError("停止后未保持目标角度，请重新检查参考与限位")
                update("stopping", feedback, stopConfirmed=True)
            except Exception as exc:
                errors.append(f"回零停止确认：{exc}")
                service.motion_guard.warning = errors[-1] + "；请重新读取反馈并核查"
        if motor is not None:
            try:
                motor.close(stop=False)
            except Exception as exc:
                errors.append(f"关闭回零串口：{exc}")
        cancelled = cancelled or service.test_stop.is_set()
        with service.lock:
            state = "error" if errors else "cancelled" if cancelled else "complete"
            service.turntable_snapshot.update(state="error" if errors else "stopped", connected=False,
                                               error="；".join(errors) or None)
            service.turntable_snapshot["homing"].update(state=state, phase=state,
                verified=verified and not errors and not cancelled, completedAt=time.time(),
                referenceRebuilt=searched)
            service.turntable_busy = False
        service.operation_lock.release()
