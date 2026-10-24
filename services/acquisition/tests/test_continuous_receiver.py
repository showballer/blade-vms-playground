"""Continuous native SDK ownership/ring-buffer fixtures; no device I/O."""
import threading
import time
import unittest

from blade_acquisition.receiver import PolytecReceiver, ReceiverConfig, VELOCITY, TIMEOUT
from test_vfx_receiver import VfxSdk


class ContinuousSdk(VfxSdk):
    """Documented PolyReadAvailableData semantics, with controllable backlog."""
    def __init__(self, stride=1):
        super().__init__()
        self.velocity_rate = self.base_rate * stride
        self.stride = stride
        self.ring = []
        self.incoming = []
        self.ring_lock = threading.Lock()
        self.native_threads = []
        self.external_laser = None
        self.fail_laser = False
        self.normal_read_entered = threading.Event()
        self.release_normal_read = threading.Event()
        self.release_normal_read.set()
        self.never_empty = False
        self.active = False
        self.velocity_range = b'1 m/s'
        self.headroom = None

    def __getattribute__(self, name):
        value = super().__getattribute__(name)
        if name.startswith('Poly') and callable(value):
            def observe(*args, **kw):
                self.native_threads.append((name, threading.get_ident()))
                return value(*args, **kw)
            return observe
        return value

    def add(self, values):
        with self.ring_lock:
            self.ring.extend(values)

    def PolyStartDataAcquisition(self, *args):
        self.active = True
        return super().PolyStartDataAcquisition(*args)

    def PolyStopDataAcquisition(self, *args):
        self.active = False
        return super().PolyStopDataAcquisition(*args)

    def PolyReadData(self, _, count, timeout):
        self.normal_read_entered.set()
        self.release_normal_read.wait(2)
        with self.ring_lock:
            if len(self.ring) >= count:
                self.incoming, self.ring = self.ring[:count], self.ring[count:]
                return 0
        time.sleep(.002)
        return TIMEOUT

    def PolyAvailableSamples(self, _, pointer):
        with self.ring_lock:
            if self.never_empty and not self.ring:
                self.ring.extend(range(50))
            pointer._obj.value = len(self.ring)
        return 0

    def PolyReadAvailableData(self, _, count, pointer):
        with self.ring_lock:
            self.incoming, self.ring = self.ring[:count], self.ring[count:]
            pointer._obj.value = len(self.incoming)
        return 0

    def PolyExtractedSampleCount(self, _, channel, __, pointer):
        pointer._obj.value = len(self.incoming) * (self.stride if channel == VELOCITY else 1)
        return 0

    def PolyGetInt32Data(self, _, channel, __, values, count):
        for i in range(count):
            values[i] = self.incoming[i // self.stride] * self.stride + i % self.stride if channel == VELOCITY else 260
        return 0

    def PolySendGetInt16(self, handle, device, number, command, pointer):
        if command == 46 and self.fail_laser:
            return 5
        if command == 46 and self.external_laser is not None:
            pointer._obj.value = self.external_laser
            return 0
        return super().PolySendGetInt16(handle, device, number, command, pointer)

    def PolyItemListGetCurrentItem(self, *args):
        if args[3] == 10:
            args[-2].value = self.velocity_range
            return 0
        return super().PolyItemListGetCurrentItem(*args)

    def PolySendGetFloat(self, *args):
        if self.headroom is not None:
            args[-1]._obj.value = self.headroom
            return 0
        return super().PolySendGetFloat(*args)


class ContinuousReceiverTests(unittest.TestCase):
    def test_explicit_laser_switches_use_daq_owner_and_keep_stream_on_both_platforms(self):
        for extension in ('.dll', '.dylib'):
            with self.subTest(extension=extension):
                sdk = ContinuousSdk()
                receiver, stop, owner, _, errors = self.start_receiver(sdk, extension)
                off = receiver.set_active_laser(False)
                self.assertEqual(off['fields']['laser']['value'], 0)
                self.assertTrue(sdk.active)
                on = receiver.set_active_laser(True)
                self.assertEqual(on['fields']['laser']['value'], 1)
                receiver.fence_active_samples()
                self.assertEqual(sdk.events.count('start'), 1)
                stop.set(); owner.join(2)
                self.assertFalse(errors)
                self.assertEqual({t for _, t in sdk.native_threads}, {owner.ident})

    def start_receiver(self, sdk, extension='.dylib', *, capacity=10000):
        receiver = PolytecReceiver(ReceiverConfig('192.0.2.90', '192.0.2.10', 'fixture' + extension,
                                                  buffer_capacity=capacity, read_batch=50 * sdk.stride,
                                                  timeout_ms=100))
        receiver._load_api = lambda: sdk
        stop, ready = threading.Event(), threading.Event()
        batches, errors = [], []
        def target():
            try:
                receiver.run(stop, lambda *_: ready.set(), batches.append, keep_laser_on=True)
            except Exception as exc:
                errors.append(exc)
        owner = threading.Thread(target=target)
        owner.start()
        self.assertTrue(ready.wait(2))
        self.addCleanup(lambda: (stop.set(), sdk.release_normal_read.set(), owner.join(3)))
        return receiver, stop, owner, batches, errors

    def test_mac_and_windows_fence_preserves_backlog_without_restart_or_cross_thread_sdk(self):
        for extension in ('.dll', '.dylib'):
            for stride in (1, 8):
                with self.subTest(extension=extension, stride=stride):
                    sdk = ContinuousSdk(stride)
                    sdk.release_normal_read.clear()
                    receiver, stop, owner, batches, errors = self.start_receiver(sdk, extension)
                    self.assertTrue(sdk.normal_read_entered.wait(1))
                    sdk.add(range(123))
                    results = []
                    fence_thread = threading.Thread(target=lambda: results.append(receiver.fence_active_samples()))
                    fence_thread.start()
                    deadline = time.monotonic() + 1
                    while receiver._active_requests.empty() and time.monotonic() < deadline:
                        time.sleep(.001)
                    sdk.release_normal_read.set()
                    fence_thread.join(2)
                    self.assertFalse(fence_thread.is_alive())
                    self.assertEqual(results[0]['sampleIndex'], 123 * stride)
                    self.assertEqual(results[0]['rssiSampleStride'], stride)
                    self.assertEqual(results[0]['sampleIndex'] % stride, 0)
                    self.assertEqual(results[0]['drainedSampleCount'], 73 * stride)
                    self.assertEqual([v for b in batches for v in b.velocity_raw], list(range(123 * stride)))
                    self.assertEqual(sdk.events.count('start'), 1)
                    self.assertEqual(sdk.events.count('stop'), 1)  # initial configuration only
                    self.assertTrue(sdk.active)
                    sdk.add(range(123, 173))
                    deadline = time.monotonic() + 1
                    while sum(len(b.values) for b in batches) < 173 * stride and time.monotonic() < deadline:
                        time.sleep(.002)
                    self.assertEqual(batches[-1].sample_start, results[0]['sampleIndex'])
                    stop.set()
                    owner.join(2)
                    self.assertEqual(errors, [])
                    self.assertEqual(sdk.events.count('start'), 1)
                    self.assertEqual(sdk.events.count('stop'), 2)
                    self.assertEqual({thread_id for _, thread_id in sdk.native_threads}, {owner.ident})

    def test_each_station_fence_checks_format_once_without_restarting_daq(self):
        sdk = ContinuousSdk(8)
        receiver, stop, owner, _, errors = self.start_receiver(sdk)
        count = lambda: sum(name == 'PolyBaseSampleRateInHz' for name, _ in sdk.native_threads)
        before = count()
        receiver.confirm_active_laser()
        self.assertEqual(count(), before)
        receiver.fence_active_samples()
        self.assertEqual(count(), before + 1)
        receiver.fence_active_samples()
        self.assertEqual(count(), before + 2)
        self.assertEqual(sdk.events.count('start'), 1)
        stop.set()
        owner.join(2)
        self.assertEqual(errors, [])
        self.assertEqual({thread_id for _, thread_id in sdk.native_threads}, {owner.ident})

    def test_station_fence_rejects_changed_units_before_draining_or_granting_boundary(self):
        for change in ('sample_rate', 'velocity_range', 'headroom'):
            for extension in ('.dll', '.dylib'):
                with self.subTest(change=change, extension=extension):
                    sdk = ContinuousSdk()
                    receiver, stop, owner, _, errors = self.start_receiver(sdk, extension)
                    if change == 'sample_rate':
                        sdk.velocity_rate *= 2
                    elif change == 'velocity_range':
                        sdk.velocity_range = b'2 m/s'
                    else:
                        sdk.headroom = receiver._session_headroom * 2
                    with self.assertRaisesRegex(RuntimeError, '采样率或速度量程已变化'):
                        receiver.fence_active_samples()
                    owner.join(2)
                    self.assertFalse(owner.is_alive())
                    self.assertTrue(errors)
                    self.assertFalse(any(name == 'PolyReadAvailableData' for name, _ in sdk.native_threads))

    def test_active_laser_confirmation_is_fresh_read_only_on_owner(self):
        sdk = ContinuousSdk()
        receiver, stop, owner, _, errors = self.start_receiver(sdk)
        before = list(sdk.laser_commands)
        confirmed = receiver.confirm_active_laser()
        self.assertEqual(confirmed['fields']['laser']['value'], 1)
        self.assertEqual(sdk.laser_commands, before)
        stop.set()
        owner.join(2)
        self.assertEqual(errors, [])
        self.assertEqual({thread_id for _, thread_id in sdk.native_threads}, {owner.ident})

    def test_active_laser_off_invalid_or_error_never_enables_or_authorizes_movement(self):
        for mode in ('off', 'invalid', 'error'):
            with self.subTest(mode=mode):
                sdk = ContinuousSdk()
                receiver, stop, owner, _, errors = self.start_receiver(sdk)
                sdk.external_laser = {'off': 0, 'invalid': 2}.get(mode)
                sdk.fail_laser = mode == 'error'
                with self.assertRaises(RuntimeError):
                    receiver.confirm_active_laser()
                owner.join(2)
                self.assertFalse(owner.is_alive())
                self.assertEqual(sdk.laser_commands.count(1), 1)
                self.assertTrue(errors)

    def test_unbounded_sdk_backlog_aborts_instead_of_granting_boundary(self):
        sdk = ContinuousSdk()
        receiver, stop, owner, _, errors = self.start_receiver(sdk, capacity=100)
        sdk.never_empty = True
        with self.assertRaisesRegex(RuntimeError, '持续积压'):
            receiver.fence_active_samples()
        owner.join(2)
        self.assertFalse(owner.is_alive())
        self.assertTrue(errors)

    def test_missing_sdk_boundary_api_fails_closed(self):
        sdk = ContinuousSdk()
        sdk.PolyAvailableSamples = None
        receiver, stop, owner, _, errors = self.start_receiver(sdk)
        with self.assertRaisesRegex(RuntimeError, '不支持连续采集'):
            receiver.fence_active_samples()
        owner.join(2)
        self.assertFalse(owner.is_alive())
        self.assertTrue(errors)

    def test_request_after_stop_or_before_run_is_rejected(self):
        sdk = ContinuousSdk()
        receiver = PolytecReceiver(ReceiverConfig('192.0.2.90', '192.0.2.10', 'fixture.dylib'))
        with self.assertRaisesRegex(RuntimeError, '尚未启动'):
            receiver.fence_active_samples()
        receiver, stop, owner, _, errors = self.start_receiver(sdk)
        stop.set()
        owner.join(2)
        with self.assertRaisesRegex(RuntimeError, '已经停止'):
            receiver.confirm_active_laser()

    def test_cancel_queued_fence_does_not_report_success(self):
        sdk = ContinuousSdk()
        sdk.release_normal_read.clear()
        receiver, stop, owner, _, errors = self.start_receiver(sdk)
        result = []
        def request():
            try:
                result.append(receiver.fence_active_samples())
            except Exception as exc:
                result.append(exc)
        waiter = threading.Thread(target=request)
        waiter.start()
        deadline = time.monotonic() + 1
        while receiver._active_requests.empty() and time.monotonic() < deadline:
            time.sleep(.001)
        stop.set()
        sdk.release_normal_read.set()
        owner.join(2)
        waiter.join(2)
        self.assertFalse(waiter.is_alive())
        self.assertIsInstance(result[0], RuntimeError)
        self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main()
