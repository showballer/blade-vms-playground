"""Prove optical/motion ordering with an in-memory C API and fake hardware only."""
import copy
import ctypes as C
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.device import DevicePanel
from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable import PointCycleConfig
from test_automatic_stations import automatic_config
from test_device import FakeAPI
from test_dual_axis_integration import BufferedMotor
from test_rssi_handoff import batch, blade_values
from test_service import START, TOKEN
from test_turntable import FakeMotor


class LaserMotionInterlockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.events, self.receiver_open = [], False
        self.fail_off_number = None
        self.off_writes = 0
        self.fail_on_number = None
        self.on_writes = 0
        self.gates = []
        self.background_only_after = None
        self.late_abort = False
        self.observed_laser_problem = None
        self.cleanup_failure = False
        self.background_only = False
        owner = self
        class API(FakeAPI):
            def PolySendSetInt16(api, handle, device, number, command, value):
                if command == 46 and value.value == 0:
                    self.off_writes += 1
                    owner.events.append(("off_write", owner.off_writes))
                    if owner.off_writes == owner.fail_off_number:
                        return 2008
                if command == 46 and value.value == 1:
                    owner.on_writes += 1
                    owner.events.append(("on_write", owner.on_writes))
                    if owner.on_writes == owner.fail_on_number:
                        return 2008
                return super(API, api).PolySendSetInt16(handle, device, number, command, value)
            def PolySendGetInt16(api, handle, device, number, command, result):
                answer = super(API, api).PolySendGetInt16(handle, device, number, command, result)
                if command == 46:
                    owner.events.append(("laser_readback", api.integers[46]))
                return answer
        self.api = API()
        self.api.integers[46] = 0
        class Motor(FakeMotor):
            def move_to_angle(motor, axis, target, speed_rpm, cancel=None):
                self.assertFalse(self.receiver_open, "motion must wait for the DAQ owner to close")
                self.assertEqual(self.api.integers[46], 1, "motion requires actual ON")
                self.assertIsNone(self.controller.rssi_handoff, "no previous or new station gate may run while moving")
                self.assertFalse(self.controller.rssi_event.is_set())
                last_on = max(index for index, event in enumerate(self.events) if event == ("laser_readback", 1))
                last_daq = max((index for index, event in enumerate(self.events) if event[0] == "daq_open"), default=-1)
                self.assertGreater(last_on, last_daq, "do not infer ON from a command ACK")
                self.events.append(("move", axis, target))
                return super(Motor, motor).move_to_angle(axis, target, speed_rpm, cancel)
        self.motor = Motor()
        class Receiver:
            supports_laser_persistence = True
            def __init__(receiver, config):
                receiver.config = config
            def validate(receiver):
                pass
            def run(receiver, stop, ready, receive, **kwargs):
                self.assertTrue(kwargs["keep_laser_on"], "linked capture must keep light on across normal station boundaries")
                self.assertFalse(self.controller.rssi_handoff.armed, "each station must begin with a new, unarmed gate")
                self.gates.append(self.controller.rssi_handoff)
                self.receiver_open = True
                self.api.integers[46] = 1
                self.events.append(("daq_open", copy.deepcopy(self.motor.angles)))
                receiver.laser_observer({"deviceIp": receiver.config.device_ip, "readAt": time.time(),
                    "fields": {"laser": {"supported": True, "value": 1}}})
                ready(1000, 1700000000)
                background = self.background_only or self.background_only_after is not None and len(self.gates) > self.background_only_after
                receive(batch([80] * 900 if background else
                              [80] * 700 + blade_values(100) + [80] * 100))
                if self.observed_laser_problem == "off":
                    self.api.integers[46] = 0
                    receiver.laser_observer({"deviceIp": receiver.config.device_ip, "readAt": time.time(),
                        "fields": {"laser": {"supported": True, "value": 0}}})
                elif self.observed_laser_problem == "error":
                    self.controller._unknown_laser(receiver.config.device_ip, "fixture SDK laser read timeout")
                stop.wait(3)
                if kwargs["abort"].is_set():
                    self.api.integers[46] = 0
                    self.events.append(("receiver_off",))
                else:
                    self.events.append(("receiver_kept_on",))
                receive(batch([1] * 100, start=900))  # Shutdown samples stay outside the frozen record.
                self.receiver_open = False
                self.events.append(("receiver_closed",))
                if self.late_abort:
                    self.controller.stop_event.set()
                if self.cleanup_failure:
                    raise RuntimeError("receiver late cleanup unconfirmed")
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), Receiver,
                              lambda *args, **kwargs: self.motor)
        self.controller = self.app.state.controller
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()
        real_panel = DevicePanel
        def panel(config):
            self.assertFalse(self.receiver_open, "a settings SDK connection must not compete with a live DAQ owner")
            value = real_panel(config)
            value._load_api = lambda: self.api
            return value
        self.panel = patch("blade_acquisition.service.DevicePanel", side_effect=panel)
        self.panel.start()

    def tearDown(self):
        self.controller.stop_event.set()
        if self.controller.thread:
            self.controller.thread.join(5)
        self.client.__exit__(None, None, None)
        self.panel.stop()
        self.temp.cleanup()

    def run_cycle(self, config):
        response = self.client.post("/api/field/start", json={**START, "confirmMotion": True, "pointCycle": config})
        self.assertEqual(response.status_code, 200, response.text)
        self.controller.thread.join(8)
        self.assertFalse(self.controller.thread.is_alive())
        return self.controller.status()

    def test_every_initial_handoff_and_lap_move_keeps_light_on_but_never_runs_a_gate(self):
        config = automatic_config(azimuths=(90, 180), cycles=2, keepLaserOnBetweenPoints=False)
        for point in config["points"]:
            point.update(rootRadiusM=.1, bladeLengthM=.6)
        result = self.run_cycle(config)
        self.assertEqual(result["state"], "idle", result)
        records = sorted(self.controller.store.list(), key=lambda record: record["startedAt"])
        self.assertEqual(len(records), 4)
        events = [event[0] for event in self.events]
        self.assertLess(events.index("laser_readback"), events.index("move"))
        self.assertLess(events.index("move"), events.index("daq_open"))
        self.assertEqual(self.api.integers[46], 1)
        self.assertEqual(sum(event[0] == "off_write" for event in self.events), 0)
        self.assertEqual(len({id(gate) for gate in self.gates}), 4)
        # Older clients omit optical calibration. The normalized status and
        # saved records must explicitly retain identity scales, not omit them.
        expected_geometry = {**config["geometry"], "pitchAngleScale": 1, "yawAngleScale": 1}
        for record in records:
            meta = record["pointCycle"]
            self.assertEqual(record["samples"], 900)
            self.assertEqual(meta["completion"], "confirmed_pass")
            self.assertEqual(meta["laserPolicy"], "continuous_during_session")
            self.assertFalse(record["turntable"]["config"]["keepLaserOnBetweenPoints"])
            self.assertEqual(meta["handoff"]["stationarySamples"], record["samples"])
            self.assertEqual(meta["arrivalMove"]["laserOnBeforeMotion"]["state"], "on")
            if "motionCommandAt" in meta["handoff"]:
                self.assertLessEqual(meta["handoff"]["receiverClosedAt"], meta["handoff"]["motionCommandAt"])
                self.assertLessEqual(meta["handoff"]["completedMove"]["laserOnBeforeMotion"]["confirmedAt"], meta["handoff"]["motionCommandAt"])
            self.assertAlmostEqual(meta["distanceFromRootM"], .4)
            self.assertEqual(meta["rootRadiusM"], .1)
            self.assertEqual(meta["bladeLengthM"], .6)
            self.assertEqual(meta["plannedStations"][0]["axis1AngleDeg"], config["points"][0]["axis1AngleDeg"])
            self.assertEqual(record["turntable"]["config"]["geometry"], expected_geometry)
        self.assertEqual(result["pointCycle"]["geometry"], expected_geometry)

    def test_calibrated_targets_and_saved_geometry_survive_the_motion_interlock(self):
        config = automatic_config(azimuths=(90, 180))
        pitch_scale, yaw_scale = .896932, .950153
        config["geometry"] = {**config["geometry"], "pitchAngleScale": pitch_scale,
                              "yawAngleScale": yaw_scale}
        # This fixture's anchor is zero, so the corrected target is the
        # uncalibrated angle times its axis scale. Do not recalculate using the
        # production geometry helper: this also catches applying a scale twice.
        for point in config["points"]:
            point["axis1AngleDeg"] *= pitch_scale
            point["axis2AngleDeg"] *= yaw_scale
        original = copy.deepcopy(config)
        result = self.run_cycle(config)
        self.assertEqual(result["state"], "idle", result)
        self.assertEqual(config, original)
        self.assertEqual(result["pointCycle"]["geometry"], original["geometry"])
        self.assertEqual([event[1] for event in self.events if event[0] == "daq_open"],
                         [{1: point["axis1AngleDeg"], 2: point["axis2AngleDeg"]}
                          for point in original["points"]])
        records = self.controller.store.list()
        self.assertEqual(len(records), 2)
        for record in records:
            self.assertEqual(record["pointCycle"]["completion"], "confirmed_pass")
            self.assertEqual(record["turntable"]["config"]["geometry"], original["geometry"])
        self.assertEqual(len({id(gate) for gate in self.gates}), 2)
        self.assertEqual(sum(event[0] == "off_write" for event in self.events), 0)

    def test_calibrated_first_hold_does_not_reposition_or_turn_off_before_start(self):
        result = self.run_cycle(automatic_config(azimuths=(0,), startAtCurrentPose=True))
        self.assertEqual(result["state"], "idle", result)
        self.assertEqual(self.events[0][0], "daq_open")
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(self.events[-1], ("laser_readback", 1))

    def origin_config(self, config, pitch=2, yaw=-1):
        return {"name": "作业原点", "port": config["port"], "axis1AngleDeg": pitch,
                "axis2AngleDeg": yaw, "referenceSignature": config["points"][0]["referenceSignature"]}

    def test_normal_task_returns_to_existing_zero_after_all_laps_without_an_extra_record(self):
        config = automatic_config(azimuths=(0, 90), cycles=2, startAtCurrentPose=True,
                                  nominalPeriodSeconds=0, speedRpm=1, maxMoveRpm=1)
        config["returnToOrigin"] = self.origin_config(config)
        result = self.run_cycle(config)
        self.assertEqual(result["state"], "idle", result.get("error"))
        self.assertEqual(result["pointCycle"]["state"], "complete")
        self.assertEqual(self.motor.angles, {1: 2, 2: -1})
        self.assertEqual(result["pointCycle"]["returnOrigin"]["actualAngles"], {"1": 2, "2": -1})
        records = self.controller.store.list()
        self.assertEqual(len(records), 4)
        self.assertTrue(all(record["status"] == "complete" and record["samples"] == 900 for record in records))
        self.assertEqual(len(self.gates), 4)
        events = [event[0] for event in self.events]
        last_close = max(index for index, event in enumerate(events) if event == "receiver_closed")
        self.assertIn("move", events[last_close + 1:])
        self.assertNotIn("daq_open", events[last_close + 1:])
        self.assertNotIn("off_write", events)
        self.assertEqual(self.api.integers[46], 1)
        self.assertFalse(result["receiver"]["running"])
        self.assertEqual(self.controller.observation_laser_ip, START["deviceIp"])
        self.assertEqual(self.motor.references, [], "returning cannot rewrite hardware references")

    def test_invalid_saved_zero_blocks_before_capture_or_motion(self):
        config = automatic_config(azimuths=(0,), startAtCurrentPose=True)
        config["returnToOrigin"] = self.origin_config(config)
        config["returnToOrigin"]["referenceSignature"] = "[[1,3,10000,17],[0,3,10000,17]]"
        result = self.run_cycle(config)
        self.assertEqual(result["state"], "error")
        self.assertIn("参考位", result["error"])
        self.assertEqual(self.controller.store.list(), [])
        self.assertEqual(self.motor.start_calls, 0)

    def test_return_failure_or_cancel_keeps_saved_data_but_never_claims_returned(self):
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled):
                self.events.clear()
                config = automatic_config(azimuths=(0,), startAtCurrentPose=True)
                config["returnToOrigin"] = self.origin_config(config)
                before = len(self.controller.store.list())
                original = self.controller._cycle_move_point
                def move(motor, cycle, point, **kwargs):
                    if point.name == "作业原点":
                        if cancelled:
                            self.controller.stop_event.set()
                        raise RuntimeError("fixture return interrupted")
                    return original(motor, cycle, point, **kwargs)
                with patch.object(self.controller, "_cycle_move_point", side_effect=move):
                    result = self.run_cycle(config)
                self.assertEqual(result["pointCycle"]["state"], "cancelled" if cancelled else "error")
                self.assertNotIn("returnOrigin", result["pointCycle"])
                self.assertEqual(len(self.controller.store.list()) - before, 1)
                self.assertEqual(self.api.integers[46], 0)

    def test_unconfirmed_on_blocks_initial_move_station_handoff_and_lap_return(self):
        for phase, azimuths, cycles, fail_number, expected_records in (
                ("initial", (90, 180), 1, 1, 0),
                ("handoff", (90, 180), 1, 2, 1),
                ("next_lap", (90,), 2, 2, 1)):
            with self.subTest(phase=phase):
                self.events.clear()
                self.motor = type(self.motor)()
                self.fail_on_number, self.on_writes = fail_number, 0
                self.api.integers[46] = 1
                before = len(self.controller.store.list())
                result = self.run_cycle(automatic_config(azimuths=azimuths, cycles=cycles))
                self.assertEqual(result["state"], "error", result)
                self.assertIn("激光开启未确认", result["error"])
                self.assertEqual(len(self.controller.store.list()) - before, expected_records)
                self.assertEqual(sum(event[0] == "daq_open" for event in self.events), expected_records)
                # Only the first positioning leg can have happened before a handoff failure.
                self.assertLessEqual(self.motor.start_calls, 2 if phase != "initial" else 0)
                self.controller.stop_event.clear()

    def test_receiver_shutdown_error_prevents_handoff_even_if_final_off_recovery_succeeds(self):
        self.cleanup_failure = True
        result = self.run_cycle(automatic_config(azimuths=(0, 90), startAtCurrentPose=True))
        self.assertEqual(result["state"], "error", result)
        self.assertIn("receiver late cleanup", result["error"])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(sum(event[0] == "daq_open" for event in self.events), 1)
        self.assertEqual(self.api.integers[46], 0)

    def test_next_station_cannot_inherit_previous_armed_gate_or_shutdown_samples(self):
        self.background_only_after = 1
        result = self.run_cycle(automatic_config(azimuths=(0, 90, 180), startAtCurrentPose=True))
        self.assertEqual(result["state"], "error", result)
        self.assertIn("等待叶片进入并离开超时", result["error"])
        records = sorted(self.controller.store.list(), key=lambda record: record["startedAt"])
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["pointCycle"]["completion"], "confirmed_pass")
        self.assertEqual(records[1]["pointCycle"]["completion"], "missing_entry")
        self.assertEqual([record["samples"] for record in records], [900, 900])
        self.assertEqual(len(self.gates), 2)
        self.assertIsNot(self.gates[0], self.gates[1])
        self.assertEqual(self.api.integers[46], 0)

    def test_known_off_or_true_sdk_read_failure_cannot_confirm_a_blade_exit(self):
        for failure in ("off", "error"):
            with self.subTest(failure=failure):
                self.observed_laser_problem = failure
                previous_ids = {record["id"] for record in self.controller.store.list()}
                result = self.run_cycle(automatic_config(azimuths=(0, 90), startAtCurrentPose=True))
                self.assertEqual(result["state"], "error", result)
                self.assertIn("不能将低波动判为叶片离开", result["error"])
                self.assertEqual(self.motor.start_calls, 0)
                records = [record for record in self.controller.store.list() if record["id"] not in previous_ids]
                self.assertEqual(len(records), 1)
                self.assertEqual(records[0]["pointCycle"]["completion"], "device_error")
                self.assertEqual(records[0]["pointCycle"]["laserError"], "laser_state_unconfirmed")
                self.assertEqual(self.api.integers[46], 0)

    def test_late_abort_after_keep_on_boundary_never_hands_off_and_finally_confirms_off(self):
        self.late_abort = True
        result = self.run_cycle(automatic_config(azimuths=(0, 90), startAtCurrentPose=True))
        self.assertEqual(result["pointCycle"]["state"], "cancelled", result)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(self.api.integers[46], 0)
        self.assertEqual(sum(event[0] == "off_write" for event in self.events), 1)

    def test_failed_error_cleanup_off_is_unknown_with_warning_and_never_claims_closed(self):
        self.fail_off_number = 1
        self.cleanup_failure = True
        result = self.run_cycle(automatic_config(azimuths=(0,), startAtCurrentPose=True))
        self.assertEqual(result["state"], "error", result)
        self.assertIn("激光关闭未确认", result["error"])
        self.assertEqual(result["laserStatus"]["state"], "unknown")
        self.assertTrue(result["deviceWarning"])
        self.assertEqual(self.api.integers[46], 1)
        self.fail_off_number = None  # Permit the isolated fixture to clean up at teardown.

    def test_live_receiver_prevents_a_second_sdk_connection_and_motion(self):
        class Active:
            def is_alive(self):
                return True
        self.controller.capture_thread = Active()
        with self.assertRaisesRegex(RuntimeError, "接收线程尚未关闭"):
            self.controller._confirm_motion_laser_off(type("Request", (), START)())
        self.controller.capture_thread = None
        self.assertEqual(self.events, [])
        self.assertEqual(self.controller.status()["laserStatus"]["state"], "unknown")
        self.assertTrue(self.controller.stop_event.is_set(), "the active owner must be told to finish and turn off")
        self.assertIn("采集接收线程尚未关闭", self.controller.status()["deviceWarning"])

    def test_stop_during_before_capture_pose_probe_never_starts_receiver_or_laser(self):
        original = self.controller._cycle_verify_initial_pose
        def check(motor, cycle, point, phase):
            result = original(motor, cycle, point, phase)
            if phase == "before_daq":
                self.controller.stop_event.set()
            return result
        with patch.object(self.controller, "_cycle_verify_initial_pose", side_effect=check):
            result = self.run_cycle(automatic_config(azimuths=(0,), startAtCurrentPose=True))
        self.assertEqual(result["pointCycle"]["state"], "cancelled", result)
        self.assertFalse(any(event[0] in ("daq_open", "move") for event in self.events))

    def test_old_velocity_joint_is_explicitly_rejected_without_record_or_device_io(self):
        response = self.client.post("/api/field/start", json={**START, "confirmMotion": True,
            "turntable": {"port": "COM6", "axis": 1, "speedRpm": .2, "protocol": "continuous"}})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("定位停稳", response.json()["detail"])
        self.assertEqual(self.events, [])
        self.assertEqual(self.controller.store.list(), [])

    def test_capture_publishes_fresh_encoder_observations_without_moving_or_extra_sdk(self):
        self.background_only = True
        config = automatic_config(azimuths=(0,), startAtCurrentPose=True)
        response = self.client.post("/api/field/start", json={**START, "confirmMotion": True, "pointCycle": config})
        self.assertEqual(response.status_code, 200, response.text)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            status = self.controller.status()
            if status["state"] == "acquiring":
                break
            time.sleep(.01)
        first = status["turntable"]["feedback"]["axes"]["1"]["observedAt"]
        time.sleep(.25)
        status = self.controller.status()
        self.assertGreater(status["turntable"]["feedback"]["axes"]["1"]["observedAt"], first)
        self.assertEqual(status["pointCycle"]["targetPointId"], config["points"][0]["pointId"])
        self.assertEqual(status["pointCycle"]["targetAxis1AngleDeg"], 0)
        self.assertEqual(status["pointCycle"]["targetAxis2AngleDeg"], 0)
        self.assertEqual(self.events, [("daq_open", {1: 0.0, 2: 0.0})])
        self.assertEqual(self.client.post("/api/field/stop").status_code, 200)
        self.assertEqual(self.motor.start_calls, 0)

    def test_root_distance_is_optional_and_bounded_by_the_configured_blade(self):
        base = automatic_config(azimuths=(0,))
        point = base["points"][0]
        for changes in ({"rootRadiusM": True}, {"rootRadiusM": -1}, {"rootRadiusM": float("inf")},
                        {"bladeLengthM": 0}, {"bladeLengthM": "1"}, {"rootRadiusM": .6},
                        {"rootRadiusM": .1, "bladeLengthM": .2}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                PointCycleConfig(**{**base, "points": [{**point, **changes}]})
        parsed = PointCycleConfig(**base)
        station = self.controller._cycle_station_plan(parsed)[0]
        self.assertNotIn("distanceFromRootM", station)
        self.assertNotIn("rootRadiusM", station)

    def test_dual_axis_status_publishes_actual_intermediate_feedback_and_rejects_reference_change(self):
        for change_reference in (False, True):
            with self.subTest(change_reference=change_reference):
                motor = BufferedMotor()
                cycle = PointCycleConfig(**automatic_config(azimuths=(90,)))
                target = cycle.points[0]
                observed = []
                def wait(session, **kwargs):
                    motor.angles = {1: target.axis1AngleDeg / 2, 2: target.axis2AngleDeg / 2}
                    if change_reference:
                        motor.origins[1] += 1
                    kwargs["on_status"](motor.status(3))
                    motor.angles = {1: target.axis1AngleDeg, 2: target.axis2AngleDeg}
                    return motor.status(6)
                motor.wait_trajectory = wait
                original = self.controller._cycle_update
                def update(state, **extra):
                    if extra.get("feedback") and state == "positioning":
                        observed.append(copy.deepcopy(extra["feedback"]))
                    original(state, **extra)
                with patch.object(self.controller, "_cycle_update", side_effect=update):
                    if change_reference:
                        with self.assertRaisesRegex(RuntimeError, "参考位"):
                            self.controller._cycle_move_point(motor, cycle, target)
                        self.assertIn("group_stop", motor.calls)
                    else:
                        self.controller._cycle_move_point(motor, cycle, target)
                        mid = next(item for item in observed if item["axes"]["2"]["output_angle_deg"] != 0)
                        self.assertAlmostEqual(mid["axes"]["2"]["output_angle_deg"], target.axis2AngleDeg / 2)
                        self.assertIsInstance(mid["axes"]["2"]["observedAt"], float)
