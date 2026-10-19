"""One explicitly armed, bounded short-arc trial using one continuous real DAQ.

The drive accepts one position command per axis. This is an open-loop chord
approximation, not a streaming position servo or a verified blade identity.
"""
from __future__ import annotations

import copy
import hashlib
import inspect
import math
import threading
import time
from collections import OrderedDict

from fastapi import HTTPException

from .single_point import estimate_manual_sync, preview_plan, schedule_follow
from .storage import atomic_json
from .turntable import (TelemetryWriter, TurntableConfig, reference_key,
                        require_position_ready, require_ready, require_stop_confirmed,
                        snapshot as motor_snapshot, start_motor)

MAX_SESSION_SECONDS = 900.0
DAQ_READY_SECONDS = 30.0
MAX_SAMPLE_AGE_SECONDS = 0.5
TERMINAL_STATES = {"complete", "cancelled", "error"}


class MotionDeadline:
    """Driver checks this after feedback/alarm reads and before the wire write."""
    def __init__(self, stopped, clock, deadline):
        self.stopped, self.clock, self.deadline = stopped, clock, deadline

    def is_set(self):
        return self.stopped.is_set() or self.clock() >= self.deadline


def request_fingerprint(request):
    return hashlib.sha256(request.model_dump_json(exclude={"commandId"}).encode()).hexdigest()


class SinglePointSession:
    def __init__(self, controller, request, receiver):
        self.controller, self.request, self.receiver = controller, request, receiver
        self.config = request.config
        self.port = request.capture.port
        self.now = time.monotonic
        self.created_monotonic, self.created_epoch = self.now(), time.time()
        self.marks = []
        self.commands = OrderedDict()
        self.command_limit = 512
        self.arm_requested = threading.Event()
        self.telemetry = None
        self.feedback = None
        self.references = None
        self.anchor = None
        self.capture_done = threading.Event()
        self.capture_ready = threading.Event()
        self.capture_stop = threading.Event()
        self.capture_errors = []
        self.capture_ready_at = None
        self.last_batch_at = None
        self.cancelled = False
        self.state = {
            "sessionId": request.sessionId, "state": "preparing", "config": self.config.model_dump(),
            "anchor": None, "preview": None, "sync": None, "marks": [], "events": [],
            "error": None, "version": 0, "updatedAt": self.created_epoch,
            "phaseLocked": False, "identityConfirmed": False,
            "motionModel": "position_chord_approximation", "quality": "manual_unverified",
            "recordingId": controller.writer.id, "captureSessionId": request.capture.captureSessionId,
            "stopConfirmed": None, "pendingStopAxes": [],
            "timeBasis": "server reception time; not hardware synchronized",
        }
        self.commands[request.commandId] = request_fingerprint(request)

    def epoch(self, monotonic):
        return self.created_epoch + monotonic - self.created_monotonic

    def snapshot(self):
        return copy.deepcopy(self.state)

    def _sync(self):
        return estimate_manual_sync(self.marks, self.config)

    def _public_sync(self, sync):
        result = copy.deepcopy(sync)
        if result.get("lastMarkAt") is not None:
            result["lastMarkAt"] = self.epoch(result["lastMarkAt"])
        return result

    def _public_plan(self, plan):
        result = copy.deepcopy(plan)
        for key in ("scheduledStartAt", "dispatchAt", "scheduledEndAt"):
            if result.get(key) is not None:
                result[key] = self.epoch(result[key])
        return result

    def event(self, kind, **data):
        c = self.controller
        with c.lock:
            now = time.time()
            data = copy.deepcopy(data)
            # Store inputs plus bounded summaries; the deterministic 257-point
            # preview is regenerated for the UI and need not bloat each event.
            if isinstance(data.get("preview"), dict):
                data["preview"].pop("trajectory", None)
            item = {"event": kind, "at": now, "hostTime": now,
                    "receivedSamples": c.writer.manifest["samples"], **data}
            self.state["events"].append(item)
            del self.state["events"][:-120]
            self.state["version"] += 1
            self.state["updatedAt"] = now
            saved = self.snapshot()
            if isinstance(saved.get("preview"), dict):
                saved["preview"].pop("trajectory", None)
            c.writer.manifest["turntable"]["singlePoint"] = saved
            if self.telemetry:
                self.telemetry.write(kind, {"singlePointSessionId": self.request.sessionId, **item})

    def update(self, state=None, **changes):
        with self.controller.lock:
            if state:
                self.state["state"] = state
            self.state.update(changes)
            self.event("single_point_state", state=self.state["state"], **changes)

    def duplicate(self, request, *, enforce_capacity=True):
        fingerprint = request_fingerprint(request)
        if request.commandId in self.commands:
            if self.commands[request.commandId] != fingerprint:
                raise HTTPException(409, "同一命令编号不能用于不同操作")
            return True
        if enforce_capacity and len(self.commands) >= self.command_limit:
            raise HTTPException(409, "本次任务操作次数已达上限，请停止保存后重新准备")
        return False

    def command(self, request):
        c = self.controller
        with c.lock:
            if request.sessionId != self.request.sessionId:
                raise HTTPException(409, "任务已变化，请刷新当前单点任务")
            if self.duplicate(request, enforce_capacity=request.action != "cancel"):
                return c.status()
            if request.action == "cancel":
                if len(self.commands) < self.command_limit:
                    self.commands[request.commandId] = request_fingerprint(request)
                if self.state["state"] not in TERMINAL_STATES:
                    self.cancelled = True
                    c.stop_event.set()
                    self.event("single_point_cancel_requested")
                return c.status()
            if self.state["state"] not in {"awaiting_sync", "ready"}:
                raise HTTPException(409, "当前阶段不能标记、重置同步或再次启动跟随")
            if c.stop_event.is_set() or self.capture_done.is_set() or not self.capture_ready.is_set():
                raise HTTPException(409, "真实采集未就绪或正在停止")
            if request.action == "reset_sync":
                self.marks.clear()
                self.state["marks"] = []
                self.update("awaiting_sync", sync=self._public_sync(self._sync()))
                self.event("single_point_sync_reset")
            elif request.action == "mark":
                now = self.now()
                if len(self.marks) >= 10:
                    raise HTTPException(409, "本次已标记10次，请重置同步后重新标记")
                if self.marks and now - self.marks[-1] < 0.25:
                    raise HTTPException(409, f"标记过于接近，请只在目标 {self.config.bladeId} 叶片经过基准方向时标记一次")
                self.marks.append(now)
                self.state["marks"].append({"sequence": len(self.state["marks"]) + 1,
                                            "hostTime": self.epoch(now),
                                            "receivedSamples": c.writer.manifest["samples"]})
                sync = self._sync()
                plan = preview_plan(self.config, self.anchor, sync)
                self.update("ready" if sync["ready"] and plan["ready"] else "awaiting_sync",
                            sync=self._public_sync(sync), preview=plan)
                self.event("single_point_manual_mark", mark=self.state["marks"][-1],
                           identityConfirmed=False)
            elif request.action == "arm":
                if request.confirmMotion is not True:
                    raise HTTPException(422, "请明确确认执行一次短弧运动")
                if self.last_batch_at is None or self.now() - self.last_batch_at > MAX_SAMPLE_AGE_SECONDS:
                    raise HTTPException(409, "近期未收到有效真实样本，不能启动跟随")
                sync = self._sync()
                plan = schedule_follow(self.config, self.anchor, sync, self.now())
                if not plan["ready"]:
                    raise HTTPException(409, "；".join(plan["blockReasons"]))
                self.update("arming", preview=self._public_plan(plan))
                self.arm_requested.set()
            else:
                raise HTTPException(422, "不支持的单点操作")
            self.commands[request.commandId] = request_fingerprint(request)
            return c.status()

    def _axis_config(self, axis, target, speed=0.2):
        return TurntableConfig(port=self.port, axis=axis, protocol="position",
                               targetAngleDeg=target, speedRpm=speed)

    def _angle_tolerance(self):
        distance = math.hypot(self.config.distanceM, abs(self.config.hubHeightDeltaM) + self.config.radiusM)
        return min(0.01, math.degrees(math.atan2(self.config.maxApproximationErrorMm / 1000, distance)))

    def _record_feedback(self, feedback):
        c = self.controller
        with c.lock:
            self.feedback = feedback
            c.turntable_snapshot.update(state=self.state["state"], feedback=feedback,
                                        connected=True, port=self.port, axis=1)
            c.writer.manifest["turntable"].update(c.turntable_snapshot)
            if self.telemetry:
                self.telemetry.write("status", {"singlePointSessionId": self.request.sessionId,
                                                "receivedSamples": c.writer.manifest["samples"],
                                                "feedback": feedback})

    def _stationary(self, motor, *, bind=False):
        feedback = motor_snapshot(motor, 1)
        require_ready(feedback)
        anchors = {f"axis{axis}AngleDeg": feedback["axes"][str(axis)]["output_angle_deg"] for axis in (1, 2)}
        for axis in (1, 2):
            value = anchors[f"axis{axis}AngleDeg"]
            if value is None:
                raise RuntimeError(f"轴{axis}尚未建立有效参考位")
            require_position_ready(feedback, self._axis_config(axis, value))
        if bind:
            self.anchor, self.references = anchors, reference_key(feedback)
        else:
            if reference_key(feedback) != self.references:
                raise RuntimeError("准备后参考位或反馈计数单位已变化，请重新标定")
            # No repositioning is implicit: the operator prepares the six-o'clock point.
            for axis in (1, 2):
                if abs(anchors[f"axis{axis}AngleDeg"] - self.anchor[f"axis{axis}AngleDeg"]) > self._angle_tolerance():
                    raise RuntimeError("准备后瞄准角度已改变，请重新对准六点方向并准备")
        self._record_feedback(feedback)
        return feedback

    def _capture(self):
        c = self.controller
        try:
            def ready(rate, origin):
                c._ready(rate, origin, self.receiver)
                self.capture_ready_at = self.now()
                self.capture_ready.set()
            def receive(batch):
                c._receive(batch)
                if batch.values:
                    self.last_batch_at = self.now()
            self.receiver.run(self.capture_stop, ready, receive)
        except Exception as exc:
            self.capture_errors.append(str(exc))
        finally:
            self.capture_done.set()

    def _check_capture(self):
        if self.capture_done.is_set():
            raise RuntimeError("；".join(self.capture_errors) or "真实采集已意外退出")
        if self.now() - self.created_monotonic > MAX_SESSION_SECONDS:
            raise RuntimeError("单点准备/采集超过15分钟，已停止，请重新准备")
        reference = self.last_batch_at if self.last_batch_at is not None else self.capture_ready_at
        if reference is not None and self.now() - reference > MAX_SAMPLE_AGE_SECONDS:
            raise RuntimeError("真实波形超过500毫秒未收到有效批次，已停止本次单点任务")

    def _wait_until(self, deadline):
        c = self.controller
        while not c.stop_event.is_set():
            self._check_capture()
            remaining = deadline - self.now()
            if remaining <= 0:
                return True
            c.stop_event.wait(min(0.01, remaining))
        return False

    def _schedule(self, motor):
        feedback = self._stationary(motor)
        sync = self._sync()
        plan = schedule_follow(self.config, self.anchor, sync, self.now(), ready_in_seconds=0.1)
        if not plan["ready"]:
            raise RuntimeError("；".join(plan["blockReasons"]))
        for move in plan["axisMoves"]:
            require_position_ready(feedback, self._axis_config(move["axis"], move["targetAngleDeg"],
                                                              max(0.02, move["speedRpm"])))
        public_plan = self._public_plan(plan)
        self.update("scheduled", preview=public_plan,
                    scheduledStartAt=public_plan["scheduledStartAt"],
                    dispatchAt=public_plan["dispatchAt"], scheduledEndAt=public_plan["scheduledEndAt"])
        # Feedback transactions are not interruptible. Stop querying before the
        # dispatch deadline and never send a late command to catch up.
        while plan["dispatchAt"] - self.now() > 0.5 and not self.controller.stop_event.is_set():
            self._check_capture()
            self._stationary(motor)
            self.controller.stop_event.wait(min(0.1, max(0, plan["dispatchAt"] - self.now() - 0.5)))
        if not self._wait_until(plan["dispatchAt"]):
            return None
        delay_ms = max(0, (self.now() - plan["dispatchAt"]) * 1000)
        # Timing budget must include dispatch scheduling error, never silently add it.
        if delay_ms > self.config.commandLatencyMs:
            raise RuntimeError("指令发送错过预约时刻，已取消本次短弧；不会追赶补发")
        if self.now() - sync["lastMarkAt"] > self.config.maxSyncAgeSeconds:
            raise RuntimeError("人工同步已过期，未启动转盘")
        return plan

    def _follow(self, motor, plan, attempted):
        c = self.controller
        self.update("following")
        first_command_at = None
        for move in plan["axisMoves"]:
            if move["hold"]:
                continue
            if c.stop_event.is_set():
                return
            self._check_capture()
            now = self.now()
            if first_command_at is None and (now - plan["dispatchAt"]) * 1000 > self.config.commandLatencyMs:
                raise RuntimeError("运动准备写盘后已错过指令时序预算，未补发运动")
            if first_command_at is not None and (now - first_command_at) * 1000 > self.config.axisStartSkewMs:
                raise RuntimeError("两轴指令间隔超出设置预算，已停止本次短弧")
            config = self._axis_config(move["axis"], move["targetAngleDeg"], move["speedRpm"])
            # Even a lost reply can have moved the axis. Include it in stop cleanup first.
            attempted.append(config)
            c.motion_guard.mark(config, True, "单点短弧运动尚未确认停止")
            c._persist_pending_axes(self.port, [item.axis for item in attempted])
            command_at = self.now()
            first_command_at = first_command_at or command_at
            deadline = min(command_at + self.config.commandLatencyMs / 1000,
                           plan["dispatchAt"] + self.config.commandLatencyMs / 1000 if len(attempted) == 1
                           else first_command_at + self.config.axisStartSkewMs / 1000)
            motion_cancel = MotionDeadline(c.stop_event, self.now, deadline)
            if motion_cancel.is_set():
                if c.stop_event.is_set():
                    return
                raise RuntimeError("运动状态写盘后超过指令发送时限，未发送运动")
            result = start_motor(motor, config, motion_cancel, prechecked_position=True)
            returned_at = self.now()
            self.event("single_point_motion_command", axis=config.axis, targetAngleDeg=config.targetAngleDeg,
                       requestedRpm=config.speedRpm, acceptedRpm=result,
                       commandSentAt=self.epoch(command_at), commandReturnedAt=self.epoch(returned_at))
            if result is None:
                if c.stop_event.is_set():
                    return
                raise RuntimeError("反馈或报警读取超过指令发送时限，未发送迟到运动")
            if (returned_at - command_at) * 1000 > self.config.commandLatencyMs:
                raise RuntimeError("转盘指令返回耗时超出命令延迟预算，已停止本次短弧")
            if len(attempted) == 1 and (returned_at - plan["dispatchAt"]) * 1000 > self.config.commandLatencyMs:
                raise RuntimeError("首轴实际启动时序超出预约预算，已停止本次短弧")
            if len(attempted) > 1 and (returned_at - first_command_at) * 1000 > self.config.axisStartSkewMs:
                raise RuntimeError("两轴实际指令启动差超出设置预算，已停止本次短弧")
            if abs(result - config.speedRpm) > 0.000001:
                raise RuntimeError("实际接受转速与预测轨迹不一致，已停止本次短弧")
        if not attempted:
            raise RuntimeError("短弧未产生可执行运动，请调整参数")
        deadline = plan["scheduledEndAt"]
        while not c.stop_event.is_set() and self.now() < deadline:
            self._check_capture()
            feedback = motor_snapshot(motor, 1)
            self._record_feedback(feedback)
            if reference_key(feedback) != self.references:
                raise RuntimeError("运动中参考位或反馈计数单位改变")
            for axis in (1, 2):
                data = feedback["axes"][str(axis)]
                guard = data["guard"]
                angle = data["output_angle_deg"]
                if (angle is None or data["fault"] or data["flags"] & 16 or data["home_phase"] not in (0, 7, 8)
                        or not guard["soft_enabled"] or not guard["minimum_deg"] <= angle <= guard["maximum_deg"]):
                    raise RuntimeError(f"轴{axis}运动反馈或软限位异常")
                move = plan["axisMoves"][axis - 1]
                if move["hold"] and (data["motor_rpm"] != 0 or abs(angle - move["startAngleDeg"]) > self._angle_tolerance()):
                    raise RuntimeError(f"未命令运动的轴{axis}发生角度漂移或意外运动")
            if feedback["alarmCode"] or feedback["limitFlags"] not in (None, 0):
                raise RuntimeError("短弧运动出现驱动器报警或限位异常")
            c.stop_event.wait(min(0.05, max(0, deadline - self.now())))
        self.event("single_point_arc_window_ended", cancelled=c.stop_event.is_set())
        if not c.stop_event.is_set():
            feedback = motor_snapshot(motor, 1)
            self._record_feedback(feedback)
            errors = {str(move["axis"]): abs(feedback["axes"][str(move["axis"])]["output_angle_deg"] - move["targetAngleDeg"])
                      if feedback["axes"][str(move["axis"])]["output_angle_deg"] is not None else None
                      for move in plan["axisMoves"]}
            reached = reference_key(feedback) == self.references and all(
                errors[str(move["axis"])] is not None and errors[str(move["axis"])] <= self._angle_tolerance() and
                feedback["axes"][str(move["axis"])]["motor_rpm"] == 0
                for move in plan["axisMoves"])
            self.update(endpointReached=reached, endpointErrorsDeg=errors,
                        endpointObservedAt=time.time(), endpointToleranceDeg=self._angle_tolerance())
            if not reached:
                raise RuntimeError("短弧窗口已结束，但两轴未在预测终点停稳；本次不能视为完成")
            self._check_capture()
            with c.lock:
                manifest = c.writer.manifest
                rate, origin = manifest["sampleRate"], manifest["sampleOrigin"]
            first = max(0, math.floor((self.epoch(plan["scheduledStartAt"]) - origin) * rate))
            end = math.ceil((self.epoch(plan["scheduledEndAt"]) - origin) * rate)
            # Allow one bounded transport flush after the finite motion has
            # already reached zero speed; never extend the commanded arc.
            flush_deadline = self.now() + MAX_SAMPLE_AGE_SECONDS
            while c.writer.manifest["samples"] < end and self.now() < flush_deadline and not c.stop_event.is_set():
                self._check_capture()
                c.stop_event.wait(0.01)
            self._check_capture()
            with c.lock:
                available = c.writer.manifest["samples"]
            covered = available >= end and end > first
            self.update(captureWindow={"startSample": first, "endSampleExclusive": end,
                                       "receivedThroughSample": available, "covered": covered,
                                       "timeBasis": "host DAQ origin plus sample index; alignment unverified"},
                        captureWindowVerified=False)
            if not covered and not c.stop_event.is_set():
                raise RuntimeError("原始样本未覆盖预约短弧时间窗，本次采集未完成")

    def _stop_axes(self, motor, attempted, failures):
        c = self.controller
        pending, send_failed, last_errors = {item.axis for item in attempted}, set(), {}
        # Send every stop before waiting on either axis. One slow axis must not
        # postpone the other axis's stop request.
        for config in attempted:
            try:
                if "wait" in inspect.signature(motor.stop).parameters:
                    motor.stop(config.axis, wait=False)
                else:
                    motor.stop(config.axis)
            except Exception as exc:
                send_failed.add(config.axis)
                last_errors[config.axis] = str(exc)
        deadline = self.now() + 10
        while pending - send_failed:
            for config in attempted:
                if config.axis not in pending or config.axis in send_failed:
                    continue
                try:
                    feedback = motor_snapshot(motor, config.axis)
                    require_stop_confirmed(feedback, config)
                    self._record_feedback(feedback)
                    self.event("single_point_axis_stopped", axis=config.axis, feedback=feedback)
                    pending.remove(config.axis)
                except Exception as exc:
                    last_errors[config.axis] = str(exc)
            if self.now() >= deadline:
                break
            if pending - send_failed:
                time.sleep(0.05)
        pending = sorted(pending)
        for axis in pending:
            failures.append(f"轴{axis}停止未确认：{last_errors.get(axis, '停止确认超时')}")
        if pending:
            config = next(item for item in attempted if item.axis == pending[0])
            c.motion_guard.mark(config, True, "单点短弧停止未确认，请逐轴检查恢复")
            atomic_json(c.motion_guard.path, {"uncertain": True, "port": self.port,
                                             "axis": pending[0], "pendingAxes": pending,
                                             "updatedAt": time.time()})
        elif attempted:
            c.motion_guard.mark(attempted[-1], False)
        self.state.update(stopConfirmed=not pending if attempted else None, pendingStopAxes=pending)

    def run(self):
        c = self.controller
        motor, capture, attempted, failures = None, None, [], []
        completed = False
        try:
            self.telemetry = TelemetryWriter(c.writer.directory)
            self.event("single_point_preparing", config=self.config.model_dump(),
                       clockMapping={"epoch": self.created_epoch, "monotonic": self.created_monotonic})
            if c.stop_event.is_set():
                return
            motor = c.motor_factory(self.port, timeout=0.3, gear_ratio=50.0)
            motor.connect()
            self._stationary(motor, bind=True)
            self.update(anchor=self.anchor, references=self.references,
                        preview=preview_plan(self.config, self.anchor))
            if c.stop_event.is_set():
                return
            capture = threading.Thread(target=self._capture, name="blade-single-point-receiver", daemon=True)
            c.capture_thread, c.capture_stop = capture, self.capture_stop
            capture.start()
            deadline = self.now() + DAQ_READY_SECONDS
            while not self.capture_ready.wait(0.02):
                if c.stop_event.is_set():
                    return
                self._check_capture()
                if self.now() >= deadline:
                    raise RuntimeError("真实采集未在30秒内就绪，未启动转盘")
            self._check_capture()
            self.update("awaiting_sync", sync=self._public_sync(self._sync()))
            next_probe = self.now() + 1
            while not c.stop_event.is_set() and not self.arm_requested.wait(0.02):
                self._check_capture()
                if self.now() >= next_probe:
                    self._stationary(motor)
                    next_probe = self.now() + 1
                    with c.lock:
                        if self.marks and self.now() - self.marks[-1] > self.config.maxSyncAgeSeconds and self.state["state"] == "ready":
                            expired = self._public_sync(self._sync())
                            expired.update(ready=False, blockReasons=["人工同步已过期，请重新标记目标叶片"])
                            self.update("awaiting_sync", sync=expired)
            if c.stop_event.is_set():
                return
            plan = self._schedule(motor)
            if plan is not None:
                self._follow(motor, plan, attempted)
                completed = not c.stop_event.is_set()
        except Exception as exc:
            failures.append(str(exc))
            c.stop_event.set()
        finally:
            if attempted:
                try:
                    self._stop_axes(motor, attempted, failures)
                except Exception as exc:
                    failures.append(f"停止状态保存失败：{exc}")
                    c.motion_guard.warning = "单点停止状态无法保存，请现场核查后逐轴恢复"
                    self.state.update(stopConfirmed=False, pendingStopAxes=[item.axis for item in attempted])
            self.capture_stop.set()
            if capture:
                capture.join(20)
                if capture.is_alive():
                    failures.append("采集线程仍未退出，激光和记录完成状态未确认")
            failures.extend(self.capture_errors)
            if motor:
                try:
                    motor.close(stop=False)
                except Exception as exc:
                    failures.append(f"关闭转盘串口失败：{exc}")
            with c.lock:
                terminal = "error" if failures else "complete" if completed else "cancelled"
                error = "；".join(failures) or None
                try:
                    self.update(terminal, error=error)
                    self.event("single_point_finished", errors=failures, amplitudeValidated=False,
                               targetHitVerified=False)
                    if self.telemetry:
                        c.writer.manifest["turntable"]["telemetry"] = self.telemetry.finish()
                    if capture and capture.is_alive():
                        c.writer.manifest["error"] = error
                        c.writer.persist()
                    else:
                        c.writer.finish(error)
                except Exception as exc:
                    error = f"{error + '；' if error else ''}记录收尾失败：{exc}"
                    self.state.update(state="error", error=error)
                c.error, c.state = error, "error" if error else "idle"
                c.turntable_snapshot.update(state="unknown" if self.state["pendingStopAxes"] else "error" if error else "stopped",
                                            connected=False, error=error)
                if not capture or not capture.is_alive():
                    c.capture_thread = None
                    c.capture_stop = None
