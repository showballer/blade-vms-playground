"""Recovery endpoints use injected hardware only, never real serial or laser."""
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from blade_acquisition.service import Settings, create_app
from blade_acquisition.turntable_driver import MotorError
from blade_acquisition.turntable_driver.motor_controller import MotionProfile
from test_dual_axis_integration import BufferedMotor
from test_turntable import ReadyReceiver, TOKEN
from laser_fixture import FakeLaserPanel

class RecoveryMotor(BufferedMotor):
    def __init__(self):
        super().__init__()
        self.guard_faults = {1: 3, 2: 0}
        self.alarms = {1: 0, 2: 0}
        self.recoveries = []
        self.fail_recovery = self.change_recovery_reference = self.move_other_after_recovery = False
        self.pitch_reference_cleared = False
        self.keep_pitch_reference = False

    def get_feedback(self, axis):
        actual = replace(super().get_feedback(axis), fault=self.guard_faults[axis])
        return replace(actual, flags=actual.flags & ~1, output_angle_deg=None) if axis == 1 and self.pitch_reference_cleared else actual

    def clear_axis1_reference(self):
        self.recoveries.append(('reference', 1))
        if self.fail_recovery: raise MotorError('configuration reply lost')
        self.pitch_reference_cleared = not self.keep_pitch_reference
        self.guard_faults[1] = 0
        self.guard_configs[1] = replace(self.get_guard_config(1), minimum_deg=-29,
                                       maximum_deg=35, hardware_enabled=False)
        self.initial_state = 0
        if self.change_recovery_reference: self.origins[2] += 1
        return self.get_feedback(1)

    def get_status(self, axis):
        value = super().get_status(axis)
        rpm = 1 if axis == 2 and self.move_other_after_recovery and self.recoveries else value.motor_rpm
        return replace(value, alarm_code=self.alarms[axis], motor_rpm=rpm)

    def clear_trajectory_fault(self, **kwargs):
        if "expected_session" in kwargs:
            assert kwargs["expected_session"] == 42
        self.recoveries.append(('trajectory', 1))
        if self.fail_recovery: raise MotorError('requires v3.4 firmware')
        self.initial_state = 0
        return self.status(0)

    def clear_guard_fault(self, axis):
        self.recoveries.append(('guard', axis))
        if not self.reference_valid: raise MotorError('参考无效')
        self.guard_faults[axis] = 0
        if self.change_recovery_reference: self.origins[axis] += 1
        return self.get_feedback(axis)

    def reset_alarm(self, axis):
        self.recoveries.append(('alarm', axis)); self.alarms[axis] = 0
        return 0

    def cancel_pending_trajectory(self, session):
        self.recoveries.append(('cancel', session))
        if self.fail_recovery: raise MotorError('stop reply lost')
        self.initial_state = 8
        return self.status(8)

    def status(self, state):
        return replace(super().status(state), fault=1 if state == 8 else 0)

class TurntableRecoveryTests(unittest.TestCase):
    def setUp(self):
        panel = patch('blade_acquisition.service.DevicePanel', FakeLaserPanel)
        panel.start(); self.addCleanup(panel.stop)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.motor = RecoveryMotor()
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), ReadyReceiver, lambda *a, **kw: self.motor)
        self.controller = self.app.state.controller
        self.client = TestClient(self.app, base_url='http://127.0.0.1:8765', headers={'Authorization': f'Bearer {TOKEN}'})
        self.client.__enter__(); self.addCleanup(lambda: self.client.__exit__(None, None, None))

    def call(self, action, **kwargs):
        return self.client.post('/api/field/turntable', json={'action': action, 'port': 'COM6', 'axis': 1, 'confirmRecovery': True, **kwargs})

    def test_recovery_requires_explicit_action_not_read_only_health(self):
        for action in ('clear_guard_fault', 'clear_trajectory_fault', 'reset_alarm', 'clear_axis1_reference'):
            self.assertEqual(self.call(action, confirmRecovery=False).status_code, 422)
        self.assertEqual(self.call('health').status_code, 422)
        self.assertEqual(self.motor.recoveries, [])

    def test_explicit_pitch_reference_clear_preserves_yaw_and_never_starts_motion(self):
        before = self.motor.get_feedback(2)
        reply = self.call('clear_axis1_reference')
        self.assertEqual(reply.status_code, 200, reply.text)
        value = reply.json()['turntable']
        self.assertEqual(value['recovery']['action'], 'clear_axis1_reference')
        self.assertTrue(value['recovery']['verified'])
        self.assertIsNone(value['feedback']['axes']['1']['output_angle_deg'])
        self.assertFalse(value['feedback']['axes']['1']['flags'] & 1)
        self.assertEqual(self.motor.get_feedback(2), before)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(self.motor.references, [])

    def test_reference_clear_cannot_target_yaw_or_request_motion(self):
        for changes in ({'axis': 2}, {'confirmMotion': True}):
            self.assertEqual(self.call('clear_axis1_reference', **changes).status_code, 422)
        self.assertEqual(self.motor.recoveries, [])

    def test_reference_clear_requires_stationary_terminal_controller_and_readback(self):
        for state in (1, 2, 3, 4, 5):
            self.motor.initial_state = state
            self.assertEqual(self.call('clear_axis1_reference').status_code, 503)
        self.assertEqual(self.motor.recoveries, [])
        self.motor.initial_state = 0
        self.motor.keep_pitch_reference = True
        self.assertEqual(self.call('clear_axis1_reference').status_code, 503)
        self.motor.keep_pitch_reference = False
        self.motor.change_recovery_reference = True
        self.assertEqual(self.call('clear_axis1_reference').status_code, 503)

    def test_reference_clear_does_not_hide_partial_failure_or_uncertain_stop(self):
        self.motor.fail_recovery = True
        reply = self.call('clear_axis1_reference')
        self.assertEqual(reply.status_code, 503)
        self.assertNotIn('recovery', self.controller.status()['turntable'])
        self.assertEqual(self.motor.start_calls, 0)
        self.motor.fail_recovery = False
        self.motor.move_other_after_recovery = True
        reply = self.call('clear_axis1_reference')
        self.assertEqual(reply.status_code, 503)

    def test_health_includes_namespaced_advice_without_recovery(self):
        self.motor.alarms[2] = 59
        reply = self.call('health', confirmRecovery=False)
        self.assertEqual(reply.status_code, 200, reply.text)
        issues = reply.json()['turntable']['health']['issues']
        self.assertEqual({(i['domain'], i['code'], i['motor_id']) for i in issues}, {('guard', 3, 1), ('drive', 59, 2)})
        self.assertEqual(self.motor.recoveries, [])
        self.assertEqual(self.motor.start_calls, 0)

    def test_health_reads_both_drive_profiles_without_modifying_motion_or_reference(self):
        reads = []
        def profile(axis):
            reads.append(axis)
            return MotionProfile(1500 if axis == 1 else 500, 1500, 100)
        self.motor.get_motion_profile = profile
        reply = self.call('health', confirmRecovery=False)
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(reads, [1, 2])
        self.assertEqual(reply.json()['turntable']['health']['motionProfiles']['2'],
                         {'accel_ms': 500, 'decel_ms': 1500, 's_curve_ms': 100})
        self.assertEqual(self.motor.references, [])
        self.assertEqual(self.motor.recoveries, [])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertEqual(self.motor.stop_calls, 0)

    def test_failed_profile_read_is_not_a_successful_health_check(self):
        self.motor.get_motion_profile = lambda axis: (_ for _ in ()).throw(MotorError('profile read timeout'))
        reply = self.call('health', confirmRecovery=False)
        self.assertEqual(reply.status_code, 503)
        self.assertEqual(self.motor.start_calls, 0)

    def test_axis_recovery_keeps_origin_and_never_restarts(self):
        before = dict(self.motor.origins)
        response = self.call('clear_guard_fault')
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body['turntable']['recovery']['verified'])
        self.assertEqual(body['turntable']['feedback']['axes']['1']['fault'], 0)
        self.assertEqual(self.motor.origins, before)
        self.assertEqual(self.motor.start_calls, 0)
        self.assertFalse(body['receiver']['running'])

    def test_already_clear_recovery_refreshes_without_rewriting_guards_or_resetting_drive(self):
        self.motor.guard_faults = {1: 0, 2: 0}
        for action in ('clear_guard_fault', 'reset_alarm', 'clear_trajectory_fault'):
            with self.subTest(action=action):
                response = self.call(action)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()['turntable']['recovery']['verified'])
        self.assertEqual(self.motor.recoveries, [])
        self.assertEqual(self.motor.start_calls, 0)

    def test_previous_homing_error_does_not_prevent_fresh_recovery(self):
        self.controller.turntable_snapshot = {'state': 'error', 'port': 'COM6',
            'error': '回零定位期间参考位或反馈计数单位变化，已停止'}
        self.motor.guard_faults[1] = 8
        response = self.call('clear_guard_fault')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.motor.recoveries, [('guard', 1)])
        self.assertEqual(self.motor.start_calls, 0)

    def test_trajectory_clear_keeps_axis_fault_visible(self):
        self.motor.initial_state = 7
        response = self.call('clear_trajectory_fault')
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()['turntable']
        self.assertEqual(data['motionCapability']['status']['state'], 0)
        self.assertEqual(data['feedback']['axes']['1']['fault'], 3)
        self.assertEqual(self.motor.recoveries, [('trajectory', 1)])
        self.assertEqual(self.motor.start_calls, 0)

    def test_clear_origin_failure_matches_observed_session_and_does_not_restart(self):
        self.motor.initial_state = 7
        self.motor.guard_faults = {1: 0, 2: 0}
        before = dict(self.motor.origins)
        rejected = self.call('clear_trajectory_fault', expectedTrajectorySession=43)
        self.assertEqual(rejected.status_code, 503)
        self.assertEqual(self.motor.recoveries, [])
        reply = self.call('clear_trajectory_fault', expectedTrajectorySession=42)
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(reply.json()['turntable']['motionCapability']['status']['state'], 0)
        self.assertEqual(self.motor.origins, before)
        self.assertEqual(self.motor.references, [])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertFalse(reply.json()['receiver']['running'])

    def test_recovery_releases_old_stop_warning_only_after_both_axis_checks(self):
        self.motor.initial_state = 7
        self.controller._persist_pending_axes('COM6', [1, 2], 'dual_axis_timed')
        response = self.call('clear_trajectory_fault')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.controller.motion_guard.warning)
        # Confirmed stop does not erase the remaining protection fault.
        self.assertEqual(response.json()['turntable']['feedback']['axes']['1']['fault'], 3)
        self.assertEqual(self.motor.references, [])

    def test_no_recovery_during_active_or_prepared_trajectory(self):
        for state in (1, 2, 3, 4):
            self.motor.initial_state = state
            for action in ('clear_guard_fault', 'clear_trajectory_fault', 'reset_alarm'):
                self.assertEqual(self.call(action).status_code, 503)
        self.assertEqual(self.motor.recoveries, [])

    def test_other_moving_axis_blocks_selected_recovery(self):
        self.motor.started = True; self.motor.active_axis = 2
        self.assertEqual(self.call('clear_guard_fault').status_code, 503)
        self.assertEqual(self.motor.recoveries, [])

    def test_concurrent_operation_is_rejected(self):
        self.controller.operation_lock.acquire()
        try: self.assertEqual(self.call('clear_trajectory_fault').status_code, 409)
        finally: self.controller.operation_lock.release()
        self.assertEqual(self.motor.recoveries, [])

    def test_reference_loss_or_change_is_not_success(self):
        self.motor.reference_valid = False
        self.assertEqual(self.call('clear_guard_fault').status_code, 503)
        self.motor.reference_valid = True; self.motor.change_recovery_reference = True
        self.assertEqual(self.call('clear_guard_fault').status_code, 503)
        self.assertEqual(self.motor.start_calls, 0)

    def test_second_axis_motion_after_recovery_is_rejected(self):
        self.motor.move_other_after_recovery = True
        response = self.call('clear_guard_fault')
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn('停止后速度', response.text)

    def test_driver_reset_targets_selected_alarm_not_other_faults(self):
        self.motor.alarms[2] = 1
        response = self.call('reset_alarm', axis=2)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.motor.recoveries, [('alarm', 2)])
        self.assertEqual(response.json()['turntable']['feedback']['axes']['1']['fault'], 3)
        self.assertEqual(self.motor.start_calls, 0)
        self.motor.alarms[2] = 234
        self.assertEqual(self.call('reset_alarm', axis=2).status_code, 503)
        self.assertEqual(len(self.motor.recoveries), 1)

    def test_unsupported_clear_does_not_rewrite_reference(self):
        self.motor.initial_state = 7; self.motor.fail_recovery = True
        response = self.call('clear_trajectory_fault')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.motor.references, [])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertNotIn('recovery', self.controller.status()['turntable'])

    def test_pending_cancel_requires_session_and_preserves_references_without_starting(self):
        self.assertEqual(self.call('cancel_trajectory').status_code, 422)
        for state, session in ((0, 42), (3, 42), (2, 43)):
            self.motor.initial_state = state
            self.assertEqual(self.call('cancel_trajectory', expectedTrajectorySession=session).status_code, 503)
        self.assertEqual(self.motor.recoveries, [])
        self.motor.initial_state = 2
        before = dict(self.motor.origins)
        reply = self.call('cancel_trajectory', expectedTrajectorySession=42)
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(reply.json()['turntable']['motionCapability']['status']['state'], 8)
        self.assertEqual(reply.json()['turntable']['recovery']['action'], 'cancel_trajectory')
        self.assertFalse(any(i['domain'] == 'trajectory' for i in reply.json()['turntable']['health']['issues']))
        self.assertEqual(self.motor.origins, before)
        self.assertEqual(self.motor.references, [])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertIsNone(self.controller.motion_guard.warning)

    def test_lost_cancel_reply_keeps_two_axis_stop_warning(self):
        self.motor.initial_state = 2; self.motor.fail_recovery = True
        reply = self.call('cancel_trajectory', expectedTrajectorySession=42)
        self.assertEqual(reply.status_code, 503)
        self.assertIsNotNone(self.controller.motion_guard.warning)
        self.assertEqual(self.controller._pending_turntable_axes('COM6'), [1, 2])

if __name__ == '__main__': unittest.main()
