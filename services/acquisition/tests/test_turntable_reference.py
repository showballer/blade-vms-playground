"""Known-pose reference recovery uses injected hardware; no real port is opened."""
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from blade_acquisition.service import Settings, create_app
from test_dual_axis_integration import BufferedMotor
from test_turntable import ReadyReceiver, TOKEN
from laser_fixture import FakeLaserPanel


class ReferenceMotor(BufferedMotor):
    def __init__(self):
        super().__init__()
        self.lost = {1}
        self.faults = {1: 3, 2: 0}
        self.pending = {1}
        self.phase = 0
        self.invalid_units = False
        self.bad_readback = None

    def get_feedback(self, axis):
        value = super().get_feedback(axis)
        if axis in self.lost:
            value = replace(value, output_angle_deg=None, flags=value.flags & ~1)
        if axis == 1 and self.invalid_units:
            value = replace(value, display_mode=0, command_counts_per_rev=0)
        return replace(value, fault=self.faults[axis], flags=value.flags | (16 if axis in self.pending else 0),
                       home_phase=self.phase if axis == 1 else value.home_phase)

    def set_current_reference(self, axis):
        # Real SDK STOP waits for two zero-speed samples before the reference write.
        self.stop(axis)
        super().set_current_reference(axis)
        self.lost.discard(axis)
        self.pending.discard(axis)
        self.faults[axis] = 0
        if self.limit_flags == 2: self.limit_flags = 0
        self.origins[axis] += 100
        if self.bad_readback == 'angle': self.angles[axis] = 0
        if self.bad_readback == 'reference': self.lost.add(axis)
        if self.bad_readback == 'pending': self.pending.add(axis)
        if self.bad_readback == 'fault': self.faults[axis] = 3
        if self.bad_readback == 'soft':
            self.guard_configs[axis] = replace(self.get_guard_config(axis), soft_enabled=False)
        return self.get_feedback(axis)


class TurntableReferenceTests(unittest.TestCase):
    def setUp(self):
        panel = patch('blade_acquisition.service.DevicePanel', FakeLaserPanel)
        panel.start(); self.addCleanup(panel.stop)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.motor = ReferenceMotor()
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), ReadyReceiver, lambda *a, **kw: self.motor)
        self.client = TestClient(self.app, base_url='http://127.0.0.1:8765', headers={'Authorization': f'Bearer {TOKEN}'})
        self.client.__enter__(); self.addCleanup(lambda: self.client.__exit__(None, None, None))

    def call(self, **kwargs):
        return self.client.post('/api/field/turntable', json={
            'action': 'reference', 'port': '/dev/cu.usbserial-test', 'axis': 1, 'confirmMotion': True, **kwargs})

    def test_power_loss_feedback_fault_can_capture_known_pitch_reference_without_moving(self):
        self.motor.limit_flags = 2
        other = self.motor.get_feedback(2)
        guard = self.motor.get_guard_config(2)
        reply = self.call()
        self.assertEqual(reply.status_code, 200, reply.text)
        data = reply.json()
        self.assertEqual(data['turntable']['feedback']['outputAngleDeg'], 25)
        self.assertEqual(data['turntable']['feedback']['axes']['1']['fault'], 0)
        self.assertEqual(self.motor.get_feedback(2), other)
        self.assertEqual(self.motor.get_guard_config(2), guard)
        self.assertEqual(self.motor.references, [1])
        self.assertEqual(self.motor.start_calls, 0)
        self.assertFalse(data['receiver']['running'])
        self.assertIsNone(data['turntablePreparation'])

    def test_invalid_reference_without_fault_can_also_be_established(self):
        self.motor.faults[1] = 0; self.motor.pending.clear()
        self.assertEqual(self.call().status_code, 200)

    def test_reference_requires_explicit_operator_action(self):
        self.assertEqual(self.call(confirmMotion=False).status_code, 422)
        self.assertEqual(self.motor.references, [])

    def test_existing_preloaded_or_running_trajectory_is_not_erased_by_reference(self):
        for state in (1, 2, 3, 4, 5):
            self.motor.initial_state = state
            self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.motor.references, [])
        self.assertEqual(self.motor.stop_calls, 0)

    def test_failed_capability_query_never_falls_back_to_reference_write(self):
        with patch.object(self.motor, 'probe_trajectory', side_effect=RuntimeError('read timeout')):
            self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.motor.references, [])

    def test_fault3_exception_does_not_enable_limits_or_motion(self):
        self.assertEqual(self.call(action='limits').status_code, 503)
        self.assertEqual(self.motor.references, [])

    def test_other_faults_alarms_limit_bypass_or_unknown_units_never_rezero(self):
        for flags in (1, 3, 4, 6):
            self.motor.limit_flags = flags
            self.assertEqual(self.call().status_code, 503)
        self.motor.limit_flags = 0
        for fault in (1, 2, 4, 5, 6, 7):
            self.motor.faults[1] = fault
            self.assertEqual(self.call().status_code, 503)
        self.motor.faults[1] = 3
        self.motor.alarm_code = 59
        self.assertEqual(self.call().status_code, 503)
        self.motor.alarm_code = 0; self.motor.invalid_units = True
        self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.motor.references, [])

    def test_moving_either_axis_or_homing_blocks_reference(self):
        self.motor.started = True
        for axis in (1, 2):
            self.motor.active_axis = axis
            self.assertEqual(self.call().status_code, 503)
        self.motor.started = False; self.motor.phase = 2
        self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.motor.references, [])

    def test_other_port_stop_warning_blocks_reference(self):
        self.app.state.controller._persist_pending_axes('COM7', [1, 2], 'dual_axis_timed')
        self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.motor.references, [])

    def test_verified_capture_only_releases_selected_axis_stop_latch(self):
        controller = self.app.state.controller
        controller._persist_pending_axes('/dev/cu.usbserial-test', [1, 2], 'dual_axis_timed')
        self.assertEqual(self.call().status_code, 200)
        self.assertEqual(controller._pending_turntable_axes('/dev/cu.usbserial-test'), [2])
        self.assertIsNotNone(controller.motion_guard.warning)
        self.assertEqual(self.call(axis=2).status_code, 200)
        self.assertIsNone(controller.motion_guard.warning)
        self.assertEqual(self.motor.start_calls, 0)

    def test_reference_failure_keeps_old_stop_warning(self):
        controller = self.app.state.controller
        controller._persist_pending_axes('/dev/cu.usbserial-test', [1, 2], 'dual_axis_timed')
        self.motor.bad_readback = 'fault'
        self.assertEqual(self.call().status_code, 503)
        self.assertEqual(controller._pending_turntable_axes('/dev/cu.usbserial-test'), [1, 2])
        self.assertIsNotNone(controller.motion_guard.warning)

    def test_ack_without_expected_angle_fault_clear_reference_and_protection_is_not_success(self):
        for failure in ('angle', 'reference', 'pending', 'fault', 'soft'):
            with self.subTest(failure=failure):
                self.motor.bad_readback = failure
                self.motor.lost = {1}; self.motor.faults[1] = 3; self.motor.pending = {1}
                self.assertEqual(self.call().status_code, 503)
                self.assertEqual(self.motor.start_calls, 0)


if __name__ == '__main__': unittest.main()
