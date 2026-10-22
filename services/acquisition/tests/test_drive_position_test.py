"""Bounded diagnostic sequencing and fail-closed cleanup; no device/network I/O."""
from dataclasses import asdict
import threading
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

from blade_acquisition.drive_position import DrivePositionError, execute_drive_position
from blade_acquisition.turntable_driver.motor_controller import (
    GuardConfig, MotionAccepted, PositionFeedback,
)
from blade_acquisition.turntable_driver.trajectory import AxisPosition


SIGNATURE = [[100, 3, 10000, 21], [200, 3, 10000, 21]]


class Clock:
    now = 100.0

    def sleep(self, seconds):
        self.now += seconds

    def monotonic(self):
        return self.now

    def monotonic_ns(self):
        return int(self.now * 1e9)


class PositionMotor:
    def __init__(self):
        self.angles = [5., 0.]
        self.start = list(self.angles)
        self.rpm = [0, 0]
        self.targets = {}
        self.commands = []
        self.stops = []
        self.sample = 0
        self.state = 0
        self.trajectory_fault = 0
        self.reject_axis = None
        self.on_command = None
        self.on_sample = None
        self.reference_delta = 0
        self.guard_changed = False
        self.alarm = 0
        self.feedback_fault = 0
        self.source = 0
        self.sample_age = 1
        self.never_arrive = False
        self.ignore_stops = False
        self.fail_stop_axis = None
        self.sample_offset = [0., 0.]

    def get_trajectory_status(self):
        return SimpleNamespace(state=self.state, fault=self.trajectory_fault)

    def guard(self, axis):
        return GuardConfig(None, None, None, False, 0, False, False, axis == 1,
                           -35 if axis == 1 else -180, 35 if axis == 1 else 180,
                           self.guard_changed)

    def get_feedback(self, axis):
        index = axis - 1
        return PositionFeedback(
            int(self.angles[index] * 1000), 0, 0, 3, 10000, 21, self.angles[index],
            3 if axis == 1 else 1, 0, 0, 0, self.feedback_fault,
            axis * 100 + self.reference_delta, self.rpm[index])

    def get_axis_positions(self):
        if self.targets:
            self.sample += 1
            fraction = .5 if self.never_arrive or self.sample == 1 else 1
            for axis, target in self.targets.items():
                self.angles[axis - 1] = self.start[axis - 1] + (target - self.start[axis - 1]) * fraction
                self.rpm[axis - 1] = 25 if fraction < 1 else 0
            if self.on_sample:
                self.on_sample()
        return tuple(AxisPosition(angle + self.sample_offset[index], int(angle * 1000),
                                  self.rpm[index], 3 if index == 0 else 1,
                                  self.sample_age, self.alarm, self.feedback_fault,
                                  self.source[index] if isinstance(self.source, tuple) else self.source)
                     for index, angle in enumerate(self.angles))

    def move_to_angle_verified(self, axis, target, *, speed_rpm, cancel, reference, start_angle):
        from blade_acquisition.turntable_driver.motor_controller import MotorController
        self.move_relative = lambda a, delta, **kw: self.move_native(a, start_angle + delta, **kw)
        import threading
        self._lock = threading.RLock()
        return MotorController.move_to_angle_verified(self, axis, target, speed_rpm=speed_rpm,
            cancel=cancel, reference=reference, start_angle=start_angle)

    def move_native(self, axis, target, *, speed_rpm, cancel, stop_before=False):
        self.commands.append(axis)
        if self.reject_axis == axis:
            raise RuntimeError("drive rejected command")
        self.targets[axis] = target
        self.rpm[axis - 1] = 25
        if self.on_command:
            self.on_command(axis)
        return MotionAccepted(axis, target - self.start[axis - 1], speed_rpm)

    def stop(self, axis, *, wait=False):
        self.stops.append(axis)
        if axis == self.fail_stop_axis:
            raise RuntimeError("lost STOP reply")
        if not self.ignore_stops:
            self.rpm[axis - 1] = 0
            self.targets.pop(axis, None)

    def snapshots(self):
        axes = {str(axis): {**asdict(self.get_feedback(axis)), "guard": asdict(self.guard(axis)),
                           "observedAt": 1.} for axis in (1, 2)}
        return tuple({
            "axis": axis, "motorRpm": self.rpm[axis - 1], "outputRpm": self.rpm[axis - 1] / 50,
            "runState": 0, "alarmCode": self.alarm, "positionRaw": 0, "limitFlags": 0,
            "limitActive": False, "stopPending": False, "limitBypass": False,
            "outputAngleDeg": self.angles[axis - 1], "axes": axes,
            "queryStartedAt": 1., "observedAt": 1.,
        } for axis in (1, 2))


class DrivePositionTests(unittest.TestCase):
    def setUp(self):
        self.motor, self.clock, self.cancel = PositionMotor(), Clock(), threading.Event()
        for target, value in (
            ("blade_acquisition.drive_position.joint_snapshots", lambda motor: motor.snapshots()),
            ("blade_acquisition.drive_position.time.monotonic", self.clock.monotonic),
            ("blade_acquisition.drive_position.time.monotonic_ns", self.clock.monotonic_ns),
            ("blade_acquisition.drive_position.time.sleep", self.clock.sleep),
        ):
            mocked = patch(target, value)
            mocked.start()
            self.addCleanup(mocked.stop)

    def run_move(self, **kwargs):
        args = dict(targets=(14., -9.), speed_rpm=5, reference_signature=SIGNATURE,
                    cancel=self.cancel, timeout_s=2)
        args.update(kwargs)
        return execute_drive_position(self.motor, **args)

    def failed(self, pattern, **kwargs):
        with self.assertRaisesRegex(DrivePositionError, pattern) as caught:
            self.run_move(**kwargs)
        return caught.exception.evidence

    def test_both_commands_precede_first_motion_read_and_joint_arrival(self):
        seen = []
        result = self.run_move(observe=seen.append)
        self.assertEqual(self.motor.commands, [1, 2])
        self.assertEqual(self.motor.stops, [])
        self.assertTrue(result["stopConfirmed"])
        self.assertEqual(result["actualAngles"], [14, -9])
        self.assertEqual(result["toleranceDeg"], .5)
        phases = [event["phase"] for event in seen]
        first_sample = phases.index("position_sample")
        self.assertEqual(phases[:first_sample].count("command_accepted"), 2)
        self.assertEqual(phases.count("position_sample"), 2)
        self.assertEqual(set(result["firstMotionSeconds"]), {"1", "2"})
        self.assertEqual(result["feedback"]["axes"]["2"]["motor_rpm"], 0)

    def grouped_motor(self):
        from blade_acquisition.turntable_driver.motor_controller import MotorController
        self.motor.gear_ratio = 50
        self.motor._lock = threading.RLock()
        def request(frame):
            axis = frame[3]
            delta = struct.unpack('>i', frame[9:13])[0] / 1000
            self.motor.move_native(axis, self.motor.angles[axis-1] + delta,
                                   speed_rpm=5, cancel=self.cancel)
            return SimpleNamespace(data=frame[9:13])
        self.motor._request = request
        self.motor._data = lambda packet, _: packet.data
        self.motor.move_axes_to_angles_verified = lambda *a, **kw: MotorController.move_axes_to_angles_verified(self.motor, *a, **kw)

    def test_grouped_sdk_path_confirms_real_joint_stop_and_records_wire_times(self):
        self.grouped_motor()
        result = self.run_move()
        self.assertTrue(result['stopConfirmed'])
        self.assertEqual(self.motor.commands, [1, 2])
        self.assertEqual(set(result['wireCommandSeconds']), {'1', '2'})
        self.assertEqual(result['actualAngles'], [14, -9])

    def test_grouped_partial_failure_cancels_both_axes_without_retry(self):
        self.grouped_motor()
        self.motor.reject_axis = 2
        result = self.failed('drive rejected')
        self.assertTrue(result['stopConfirmed'])
        self.assertEqual(self.motor.commands, [1, 2])
        self.assertEqual(self.motor.stops, [1, 2])

    def test_grouped_reference_change_after_first_ack_prevents_second_axis(self):
        self.grouped_motor()
        self.motor.on_command = lambda axis: setattr(self.motor, 'reference_delta', 1)
        result = self.failed('轴2下发前参考')
        self.assertTrue(result['stopConfirmed'])
        self.assertEqual(self.motor.commands, [1])

    def test_pending_or_faulted_trajectory_is_read_only_rejection(self):
        for state, fault in ((1, 0), (2, 0), (3, 0), (5, 0), (7, 7)):
            with self.subTest(state=state):
                self.motor.state, self.motor.trajectory_fault = state, fault
                self.failed("待执行轨迹")
                self.assertEqual(self.motor.commands + self.motor.stops, [])

    def test_bad_reference_or_alarm_does_not_move(self):
        self.motor.reference_delta = 1
        self.failed("原参考")
        self.motor.reference_delta, self.motor.alarm = 0, 17
        self.failed("报警")
        self.assertEqual(self.motor.commands + self.motor.stops, [])

    def test_second_axis_rejected_stops_both_without_retry(self):
        self.motor.reject_axis = 2
        result = self.failed("drive rejected")
        self.assertEqual(self.motor.commands, [1, 2])
        self.assertEqual(self.motor.stops, [1, 2])
        self.assertTrue(result["stopConfirmed"])
        self.assertEqual(result["state"], "error")

    def test_reference_changes_during_move_stop_both(self):
        self.motor.on_sample = lambda: setattr(self.motor, "reference_delta", 1)
        result = self.failed("参考位")
        self.assertEqual(self.motor.stops, [1, 2])
        self.assertTrue(result["stopConfirmed"])

    def test_reference_change_between_axis_commands_prevents_second_command(self):
        self.motor.on_command = lambda axis: setattr(self.motor, "reference_delta", 1)
        result = self.failed("下发前参考")
        self.assertEqual(self.motor.commands, [1])
        self.assertEqual(self.motor.stops, [1, 2])
        self.assertTrue(result["stopConfirmed"])

    def test_cancel_between_commands_stops_both(self):
        self.motor.on_command = lambda axis: self.cancel.set()
        result = self.failed("取消")
        self.assertEqual(self.motor.commands, [1])
        self.assertTrue(result["stopConfirmed"])
        self.assertEqual(self.motor.stops, [1, 2])

    def test_cancel_before_preflight_is_read_only(self):
        self.cancel.set()
        result = self.failed("取消")
        self.assertFalse(result["motionCommanded"])
        self.assertEqual(self.motor.stops + self.motor.commands, [])

    def test_timeout_stops_both_and_never_reports_arrival(self):
        self.motor.never_arrive = True
        result = self.failed("超时")
        self.assertTrue(result["stopConfirmed"])
        self.assertNotIn("arrived", [event["phase"] for event in result["events"]])

    def test_stopped_one_axis_is_not_joint_completion(self):
        self.motor.on_sample = lambda: self.motor.rpm.__setitem__(1, 12)
        result = self.failed("超时")
        self.assertEqual(self.motor.stops, [1, 2])
        self.assertTrue(result["stopConfirmed"])

    def test_zero_rpm_outside_point_five_tolerance_is_not_arrival(self):
        self.motor.on_sample = lambda: self.motor.angles.__setitem__(1, -8.499)
        result = self.failed("超时")
        self.assertTrue(result["stopConfirmed"])

    def test_gross_reverse_motion_is_stopped(self):
        self.motor.on_sample = lambda: self.motor.angles.__setitem__(0, 4.)
        self.failed("明显反向")
        self.assertEqual(self.motor.stops, [1, 2])

    def test_rejected_overshoot_is_preserved_before_stop_replaces_feedback(self):
        # Match the failed P2 move: the first returned pose was already outside
        # the permitted segment. A STOP sample must not erase that evidence.
        self.motor.angles[0] = self.motor.start[0] = 5.184
        self.motor.on_sample = lambda: self.motor.angles.__setitem__(0, 10.)
        result = self.failed('越过目标：起点5.184°，目标8.863°，实测10.000°',
                             targets=(8.862676, 0))
        rejected = result['rejectedPosition']
        self.assertEqual(rejected['reason'], 'overshoot')
        self.assertEqual(rejected['actualAngleDeg'], 10)
        self.assertEqual(rejected['targetAngleDeg'], 8.862676)
        self.assertTrue(result['stopConfirmed'])
        self.assertEqual(self.motor.stops, [1, 2])
        self.assertIn('position_rejected', [event['phase'] for event in result['events']])
        self.assertNotIn('arrived', [event['phase'] for event in result['events']])

    def test_small_overshoot_can_correct_but_does_not_relax_final_arrival(self):
        self.motor.angles[0] = self.motor.start[0] = 5.354
        def sample():
            if self.motor.sample == 1:
                self.motor.angles[0] = 9.366
                self.motor.rpm[0] = -54
        self.motor.on_sample = sample
        result = self.run_move(targets=(8.862676, 0), follow_error_limit=.8)
        self.assertEqual(result['followErrorLimitDeg'], .8)
        self.assertEqual(result['toleranceDeg'], .5)
        self.assertTrue(result['stopConfirmed'])
        self.assertEqual(result['actualAngles'], [8.863, 0])
        self.assertEqual(self.motor.stops, [])

    def test_configured_envelope_still_stops_real_overshoot(self):
        self.motor.angles[0] = self.motor.start[0] = 5.354
        self.motor.on_sample = lambda: self.motor.angles.__setitem__(0, 9.366)
        result = self.failed('保护限0.500°', targets=(8.862676, 0), follow_error_limit=.5)
        self.assertEqual(result['rejectedPosition']['followErrorLimitDeg'], .5)
        self.assertEqual(self.motor.stops, [1, 2])

    def test_stopped_overshoot_inside_motion_limit_is_not_arrival(self):
        self.motor.on_sample = lambda: (self.motor.angles.__setitem__(0, 14.503), self.motor.rpm.__setitem__(0, 0))
        result = self.failed('超时', follow_error_limit=.8)
        self.assertEqual(self.motor.stops, [1, 2])
        self.assertNotIn('arrived', [event['phase'] for event in result['events']])

    def test_invalid_motion_limits_never_send_a_command(self):
        for limit in (.49, 10.01, True, float('nan')):
            self.failed('定位行程误差上限', follow_error_limit=limit)
        self.assertEqual(self.motor.commands + self.motor.stops, [])

    def test_stale_or_failed_source_during_move_is_stopped(self):
        for key, value in (("sample_age", 1001), ("source", 2), ("alarm", 12), ("feedback_fault", 3)):
            with self.subTest(key=key):
                self.motor = PositionMotor()
                self.motor.on_sample = lambda: setattr(self.motor, key, value)
                self.failed("实测反馈")
                self.assertEqual(self.motor.stops, [1, 2])

    def test_recent_control_samples_allow_motion_but_direct_readback_confirms_arrival(self):
        self.motor.on_sample = lambda: setattr(self.motor, "source", (1, 0) if self.motor.sample <= 2 else 0)
        self.motor.sample_age = 150
        seen = []
        result = self.run_move(observe=seen.append)
        samples = [event for event in seen if event["phase"] == "position_sample"]
        self.assertEqual([event["sources"] for event in samples], [[1, 0], [1, 0], [0, 0]])
        self.assertEqual(samples[0]["sampleAgeMs"], [150, 150])
        self.assertEqual(samples[0]["conservativeAgeMs"], [150, 150])
        self.assertTrue(result["stopConfirmed"])
        self.assertEqual(self.motor.stops, [])

    def test_cached_zero_speed_at_target_cannot_complete_a_point_task(self):
        self.motor.on_sample = lambda: setattr(self.motor, "source", 1)
        result = self.failed("超时")
        self.assertTrue(result["stopConfirmed"])
        self.assertNotIn("arrived", [event["phase"] for event in result["events"]])
        self.assertEqual(self.motor.stops, [1, 2])

    def test_control_sample_age_includes_transport_delay(self):
        def delayed():
            self.motor.source = 1
            self.motor.sample_age = 200
            self.clock.sleep(.85)
        self.motor.on_sample = delayed
        result = self.failed("实测反馈过期")
        self.assertTrue(result["stopConfirmed"])
        self.assertEqual(self.motor.stops, [1, 2])

    def test_cached_preflight_cannot_authorize_a_motion_command(self):
        self.motor.source = 1
        result = self.failed("新鲜实测反馈未确认停稳")
        self.assertFalse(result["motionCommanded"])
        self.assertEqual(self.motor.commands + self.motor.stops, [])

    def test_guard_changed_at_end_cannot_succeed(self):
        self.motor.on_sample = lambda: setattr(self.motor, "guard_changed", True)
        result = self.failed("保护配置已变化")
        self.assertTrue(result["stopConfirmed"])

    def test_lost_stop_reply_still_attempts_other_axis_and_reports_unknown(self):
        self.motor.reject_axis = 2
        self.motor.fail_stop_axis = 1
        result = self.failed("drive rejected")
        self.assertFalse(result["stopConfirmed"])
        self.assertEqual(self.motor.stops, [1, 2])
        self.assertTrue(any("lost STOP reply" in error for error in result["stopErrors"]))

    def test_callback_failure_after_command_cannot_leave_motion_running(self):
        def observe(event):
            if event["phase"] == "command_accepted":
                raise RuntimeError("observer failed")
        result = self.failed("observer failed", observe=observe)
        self.assertEqual(self.motor.commands, [1])
        self.assertTrue(result["stopConfirmed"])

    def test_bounded_parameters_and_travel_rejected_before_motion(self):
        for args in ({"speed_rpm": 11}, {"targets": (36, 0)}, {"targets": (float("nan"), 0)},
                     {"reference_signature": None},
                     {"timeout_s": 0}, {"speed_rpm": .02}):
            with self.subTest(args=args):
                self.failed(".", **args)
                self.assertEqual(self.motor.commands + self.motor.stops, [])

    def test_fresh_initial_pair_is_reused_but_final_pair_is_independent(self):
        import time
        initial = self.motor.snapshots()
        for value in initial:
            value["queryStartedAt"] = time.time()
        with patch("blade_acquisition.drive_position.joint_snapshots",
                   side_effect=lambda motor: motor.snapshots()) as read:
            result = self.run_move(initial_snapshots=initial)
        self.assertTrue(result["stopConfirmed"])
        self.assertEqual(read.call_count, 1, "Only the independent final pair is read again")

    def test_only_fully_checked_arrival_pair_is_offered_for_immediate_next_capture(self):
        checked = Mock()
        result = self.run_move(on_stopped=checked)
        checked.assert_called_once()
        pair = checked.call_args.args[0]
        self.assertIs(pair[0], result["feedback"])
        self.assertEqual(pair[1]["axis"], 2)
        checked.reset_mock()
        self.motor.reference_delta = 1
        self.failed("原参考", on_stopped=checked)
        checked.assert_not_called()

    def test_stale_initial_pair_is_never_used_to_authorize_motion(self):
        initial = self.motor.snapshots()
        self.motor.alarm = 7
        self.failed("报警", initial_snapshots=initial)
        self.assertEqual(self.motor.commands, [])

    def test_final_nonzero_speed_cannot_pass_arrival_confirmation(self):
        calls = 0
        def read(motor):
            nonlocal calls
            calls += 1
            if calls == 2:
                motor.rpm[1] = 7
            return motor.snapshots()
        with patch("blade_acquisition.drive_position.joint_snapshots", side_effect=read):
            result = self.failed("运动|停稳")
        self.assertNotIn("arrived", [event["phase"] for event in result["events"]])
        self.assertEqual(self.motor.stops, [1, 2])

    def test_sdk_verified_move_reads_reference_once_and_preserves_alarm_check(self):
        from blade_acquisition.turntable_driver.motor_controller import MotorController, DriveAlarm
        motor = MotorController("COM6")
        motor.get_feedback = Mock(return_value=self.motor.get_feedback(1))
        motor.read_alarm = Mock(return_value=9)
        motor._request = Mock()
        with self.assertRaises(DriveAlarm):
            motor.move_to_angle_verified(1, 14, speed_rpm=5, cancel=self.cancel,
                                        reference=SIGNATURE[0], start_angle=5)
        motor.get_feedback.assert_called_once_with(1)
        motor.read_alarm.assert_called_once_with(1)
        motor._request.assert_not_called()

    def test_already_at_target_is_read_only_and_confirms_stop(self):
        result = self.run_move(targets=(5, 0))
        self.assertTrue(result["stopConfirmed"])
        self.assertFalse(result["motionCommanded"])
        self.assertEqual(self.motor.commands + self.motor.stops, [])


if __name__ == "__main__":
    unittest.main()
