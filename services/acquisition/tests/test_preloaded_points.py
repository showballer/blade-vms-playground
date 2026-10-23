"""Indexed protocol/ownership tests. In-memory controller only; no hardware I/O."""
import copy
import json
import struct
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from blade_acquisition.drive_position import execute_drive_position, DrivePositionError
from blade_acquisition.preloaded_points import PreloadedPointsCache
from blade_acquisition.turntable import TurntableRequest
from blade_acquisition.turntable_driver.motor_controller import MotorController, MotorStatus, CommunicationError, CommandRejected
from blade_acquisition.turntable_driver.trajectory import TrajectoryStatus
from blade_acquisition.turntable_driver.protocol import Response
from blade_acquisition.turntable_driver.point_bank import upload_frames, run_frame, status_frame
from test_drive_position_test import PositionMotor, SIGNATURE


class BankMotor(PositionMotor):
    trajectory_start_observer = True
    preload_route = MotorController.preload_route
    get_preloaded_route = MotorController.get_preloaded_route
    probe_preloaded_routes = MotorController.probe_preloaded_routes
    run_preloaded_point = MotorController.run_preloaded_point
    move_axes_point = MotorController.move_axes_point

    def __init__(self):
        super().__init__()
        self._lock = threading.RLock()
        self._faulted = False
        self.banks = {}
        self.wire = []
        self.fail_run = False
        self.bad_ack = False
        self.completion_bit = True
        self.position_reads = 0
        self.cancel_after_ack = None
        self.max_slot = 6
        self.drive_internal_position = True

    def _request(self, frame):
        self.wire.append(frame)
        cmd, slot, data = frame[4], struct.unpack('>H', frame[5:7])[0], frame[7:-2]
        if slot > self.max_slot and cmd in (0x40, 0x41, 0x42, 0x43, 0x44):
            raise CommandRejected(Response(1, cmd, 4, slot, b'', b''))
        state = self.banks.setdefault(slot, dict(token=0, speed=0, tolerance=0, points=[], loaded=0, count=0, ready=0))
        if cmd == 0x40:
            token, speed, tolerance, count = struct.unpack('>IHHB', data)
            state.update(token=token, speed=speed, tolerance=tolerance, count=count, points=[], loaded=0, ready=0)
        elif cmd == 0x41:
            token, index, one, two = struct.unpack('>IBii', data)
            assert token == state['token'] and index == state['loaded']
            state['points'].append((one/1000, two/1000)); state['loaded'] += 1
        elif cmd == 0x42:
            assert state['loaded'] == state['count']
            state['ready'] = 1
        elif cmd in (0x43, 0x1A):
            if cmd == 0x43:
                token, index = struct.unpack('>IB', data)
                assert token == state['token'] and state['ready']
                target = state['points'][index]
            else:
                speed, one, two, tolerance = struct.unpack('>HiiH', data)
                target = one/1000, two/1000
            self.start = list(self.angles); self.targets = dict(enumerate(target, 1)); self.sample = 0
            if self.cancel_after_ack:
                self.cancel_after_ack.set()
            if self.fail_run:
                raise CommunicationError('RUN ack lost')
            return SimpleNamespace(data=b'?' if self.bad_ack else struct.pack('>II', 11, 12))
        return SimpleNamespace(data=struct.pack('>IHHBBB', state['token'], state['speed'], state['tolerance'],
            state['count'], state['loaded'], state['ready']))

    def get_axis_positions(self, *, fresh=False):
        self.position_reads += 1
        positions = super().get_axis_positions()
        return tuple(replace(p, flags=p.flags | (0x20 if p.motor_rpm else 0x40 if self.completion_bit else 0)) for p in positions)

    def snapshots(self):
        result = super().snapshots()
        for item in result:
            item.update(queryStartedAt=time.time(), observedAt=time.time())
        return result

    def connect(self):
        return self

    def close(self, stop=False):
        pass

    def get_guard_config(self, axis):
        return self.guard(axis)

    def get_status(self, axis):
        return MotorStatus(axis, self.rpm[axis - 1], self.rpm[axis - 1] / 50, 0, self.alarm, 0)

    def probe_trajectory(self):
        return TrajectoryStatus(1, 0, 0, 0, 0, 0, 0, 0, 0, *self.angles, 0, 0)

    def get_trajectory_status(self):
        return self.probe_trajectory()


class PreloadedPointsTests(unittest.TestCase):
    def setUp(self):
        self.motor = BankMotor()
        self.cache = PreloadedPointsCache()
        self.cancel = threading.Event()
        self.points = [(10., -9.), (14., 9.)]
        self.addCleanup(patch.stopall)
        patch('blade_acquisition.drive_position.joint_snapshots', side_effect=lambda motor, **kw: motor.snapshots()).start()

    def prepare(self, **overrides):
        args = dict(port='tcp://192.168.10.50:5000', points=self.points, origin=(5., 0.), speed=5.,
                    feedback=self.motor.snapshots()[0], cancel=self.cancel)
        args.update(overrides)
        return self.cache.prepare(self.motor, **args)

    def move(self, targets=None, **overrides):
        args = dict(targets=targets or self.points[0], speed_rpm=5., reference_signature=SIGNATURE,
                    cancel=self.cancel, timeout_s=2., initial_snapshots=self.motor.snapshots())
        args.update(overrides)
        return execute_drive_position(self.motor, **args)

    def test_six_banks_are_independent_and_reselected_without_reupload(self):
        for number in range(1, 7):
            summary = self.prepare(points=[(number, 0.)])
            self.assertEqual(summary['bankId'], number)
        count = sum(f[4] == 0x40 for f in self.motor.wire)
        summary = self.prepare(points=[(1., 0.)])
        self.assertTrue(summary['reused'])
        self.assertEqual(summary['bankId'], 1)
        self.assertEqual(sum(f[4] == 0x40 for f in self.motor.wire), count)
        summary = self.prepare(points=[(7., 0.)])
        self.assertEqual(summary['bankId'], 2, 'replace least recently selected bank; never truncate a route')

    def test_full_16_points_plus_separate_origin(self):
        self.prepare(points=[(i, 0.) for i in range(16)])
        self.assertEqual(self.motor.banks[1]['count'], 16)
        before = len(self.motor.wire)
        with self.assertRaisesRegex(ValueError, '16'):
            self.prepare(points=[(i, 0.) for i in range(17)])
        self.assertTrue(all(f[4] == 0x44 for f in self.motor.wire[before:]), 'no partial upload')

    def test_four_bank_firmware_reports_upgrade_without_overwriting_another_bank(self):
        self.motor.max_slot = 4
        for number in range(1, 5):
            self.prepare(points=[(number, 0.)])
        before = copy.deepcopy(self.motor.banks)
        self.motor.wire.clear()
        with self.assertRaisesRegex(Exception, 'v3.9.4'):
            self.prepare(points=[(5., 0.)])
        self.assertEqual(self.motor.banks, before)
        self.assertEqual([f[4] for f in self.motor.wire], [0x44, 0x44])

    def test_duplicate_coordinates_keep_explicit_point_identity(self):
        self.prepare(points=[self.points[0], self.points[0]])
        result = self.move(point_index=1)
        self.assertEqual(result['pointIndex'], 1)
        self.assertEqual(self.motor.wire[-1][11], 1)
        self.motor.wire.clear()
        with self.assertRaisesRegex(DrivePositionError, '编号与预存坐标'):
            self.move(self.points[1], point_index=1)
        self.assertEqual(self.motor.wire, [])

    def test_bank_speed_never_rounds_above_user_ceiling(self):
        summary = self.prepare(speed=.235)
        self.assertEqual(summary['speedRpm'], .23)
        self.assertEqual(self.motor.banks[1]['speed'], 23)

    def test_upload_never_moves_and_run_has_only_identity_and_index(self):
        self.prepare()
        self.assertEqual([f[4] for f in self.motor.wire], [0x44, 0x40, 0x41, 0x41, 0x42])
        self.assertFalse(self.motor.targets)
        self.motor.wire.clear()
        result = self.move()
        self.assertEqual([f[4] for f in self.motor.wire], [0x43])
        self.assertEqual(len(self.motor.wire[0][7:-2]), 5)
        self.assertEqual(result['positionProtocol'], '0x43')
        self.assertEqual(result['boardPrepareMs'], [11, 12])
        self.assertTrue(result['controllerCompletionConfirmed'])
        self.assertEqual(result['actualAngles'], list(self.points[0]))
        self.assertEqual(self.motor.stops, [])
        self.assertEqual(self.motor.commands, [])

    def test_preposition_then_start_does_not_repeat_motion(self):
        self.prepare(); self.move()
        self.motor.wire.clear()
        self.assertTrue(self.prepare()['reused'])
        result = self.move()
        self.assertFalse(result['motionCommanded'])
        self.assertNotIn(0x43, [f[4] for f in self.motor.wire])
        result = self.move(self.points[1])
        self.assertEqual(result['pointIndex'], 1)

    def test_origin_uses_explicit_absolute_command_not_a_bank_slot(self):
        self.prepare(); self.move()
        self.motor.wire.clear()
        result = self.move((5., 0.))
        self.assertEqual([f[4] for f in self.motor.wire], [0x1A])
        self.assertEqual(result['positionProtocol'], '0x1A')

    def test_mismatched_target_has_no_motion_fallback(self):
        self.prepare(); self.motor.wire.clear()
        with self.assertRaisesRegex(DrivePositionError, '不属于'):
            self.move((13., 1.))
        self.assertFalse(self.motor.wire)

    def test_power_reset_overwrite_speed_reference_and_geometry_revalidate(self):
        self.prepare()
        self.motor.banks.clear()
        self.assertFalse(self.prepare()['reused'])
        self.motor.banks[1]['token'] += 1
        self.assertFalse(self.prepare()['reused'])
        self.assertFalse(self.prepare(speed=4)['reused'])
        self.motor.reference_delta = 100
        self.assertFalse(self.prepare()['reused'])
        self.assertFalse(self.prepare(points=[(9., -9.)])['reused'])

    def test_lost_or_malformed_ack_never_retries_or_falls_back(self):
        for mode in ('fail_run', 'bad_ack'):
            with self.subTest(mode=mode):
                self.motor = BankMotor(); self.prepare(); self.motor.wire.clear()
                setattr(self.motor, mode, True)
                with self.assertRaises(DrivePositionError): self.move()
                self.assertEqual([f[4] for f in self.motor.wire], [0x43])
                self.assertEqual(self.motor.stops, [1, 2])

    def test_cached_zero_speed_cannot_confirm_completion(self):
        self.prepare(); self.motor.source = 1
        with self.assertRaisesRegex(DrivePositionError, '超时'):
            self.move()
        self.assertEqual(self.motor.stops, [1, 2])

    def test_no_completion_bit_requires_two_direct_stop_samples(self):
        self.prepare(); self.motor.completion_bit = False
        result = self.move()
        self.assertTrue(result['stopConfirmed'])
        self.assertEqual(self.motor.position_reads, 3)  # moving, stopped, independently stopped

    def test_cancel_after_run_ack_stops_both_and_no_next_point(self):
        self.prepare(); self.motor.cancel_after_ack = self.cancel
        with self.assertRaisesRegex(DrivePositionError, '取消'): self.move()
        self.assertEqual(self.motor.stops, [1, 2])
        self.assertEqual(sum(f[4] == 0x43 for f in self.motor.wire), 1)

    def test_old_firmware_fallback_only_for_explicit_unknown_command(self):
        motor = MotorController('COM7')
        with patch.object(motor, 'get_preloaded_route', side_effect=CommandRejected(Response(1, 0x44, 7, 1, b'', b''))):
            self.assertIsNone(motor.probe_preloaded_routes())
        with patch.object(motor, 'get_preloaded_route', side_effect=CommunicationError('offline')):
            with self.assertRaises(CommunicationError): motor.probe_preloaded_routes()

    def test_slot_six_and_validation_before_any_upload(self):
        self.assertEqual(struct.unpack('>H', status_frame(6)[5:7])[0], 6)
        for slot in (0, 7, True):
            with self.assertRaises(ValueError): run_frame(slot, 1, 0)
        for points in ([(0, 0), (36, 0)], [(0, 0), (0, float('nan'))], [(True, 0)]):
            with self.assertRaises(ValueError):
                self.motor.preload_route(points)
        self.assertFalse(self.motor.wire)

    def test_model_preserves_exact_request_and_rejects_invalid_or_foreign_action(self):
        args = dict(action='recall', port='COM7', recordedPort='COM7', axis=1,
            axis1AngleDeg=10., axis2AngleDeg=-9., referenceSignature=json.dumps(SIGNATURE),
            preloadPoints=self.points, preloadReturnPoint=(5., 0.))
        self.assertEqual(TurntableRequest(**args).preloadPoints, self.points)
        for change in (dict(action='probe'), dict(axis1AngleDeg=11), dict(preloadPoints=[(True, 0)])):
            with self.assertRaises(ValueError): TurntableRequest(**{**args, **change})


class IndexedCaptureServiceTests(unittest.TestCase):
    def test_preposition_capture_two_laps_and_origin_preserve_record_identity(self):
        from blade_acquisition.service import Settings, create_app, StartRequest
        from test_automatic_stations import PassReceiver, automatic_config
        from test_service import START, TOKEN
        from laser_fixture import FakeLaserPanel
        with tempfile.TemporaryDirectory() as folder, patch('blade_acquisition.service.DevicePanel', FakeLaserPanel):
            motor = BankMotor()
            controller = create_app(Settings(TOKEN, 8765, Path(folder)), PassReceiver,
                                    lambda *a, **kw: motor).state.controller
            cycle = automatic_config(azimuths=(0, 180), cycles=2)
            for point in cycle['points']:
                point['referenceSignature'] = json.dumps(SIGNATURE)
            first = cycle['points'][0]
            cycle['returnToOrigin'] = dict(name='work origin', port='COM6', axis1AngleDeg=5., axis2AngleDeg=0.,
                                          referenceSignature=json.dumps(SIGNATURE))
            request = TurntableRequest(action='recall', port='COM6', recordedPort='COM6', confirmMotion=True,
                axis1AngleDeg=first['axis1AngleDeg'], axis2AngleDeg=first['axis2AngleDeg'],
                referenceSignature=first['referenceSignature'], speedRpm=.6,
                preloadPoints=[(p['axis1AngleDeg'], p['axis2AngleDeg']) for p in cycle['points']],
                preloadReturnPoint=(5., 0.))
            for _ in range(2):
                controller.turntable_operation(request)
                controller.test_thread.join(5)
                self.assertFalse(controller.test_thread.is_alive())
                self.assertEqual(controller.status()['turntable']['recall']['state'], 'complete', controller.status())
            self.assertEqual(sum(f[4] == 0x43 for f in motor.wire), 1, 'repeated preset must not move again')
            controller.start(StartRequest(**START, confirmMotion=True, pointCycle=cycle))
            controller.thread.join(8)
            if controller.thread.is_alive():
                controller.stop_event.set(); controller.thread.join(3)
                self.fail('capture did not finish')
            result = controller.status()
            self.assertEqual(result['state'], 'idle', result)
            self.assertEqual(sum(f[4] == 0x40 for f in motor.wire), 1, 'capture reuses the verified bank')
            self.assertEqual(sum(f[4] == 0x43 for f in motor.wire), 4, 'preset plus three confirmed handoffs')
            self.assertEqual(sum(f[4] == 0x1A for f in motor.wire), 1, 'origin is not a measurement record')
            records = controller.store.list()
            self.assertEqual(len(records), 4)
            self.assertEqual({r['pointCycle']['lapIndex'] for r in records}, {1, 2})
            self.assertTrue(all(r['status'] == 'complete' for r in records))


if __name__ == '__main__':
    unittest.main()
