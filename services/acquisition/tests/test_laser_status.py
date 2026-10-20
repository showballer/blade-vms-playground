"""Laser monitoring uses fake SDKs/transports only; never contacts a device."""
import itertools
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from blade_acquisition.device import DevicePanel
from blade_acquisition.receiver import PolytecReceiver, ReceiverConfig
from blade_acquisition.service import Settings, create_app
from test_device import FakeAPI
from test_service import FakeSdk, FixtureReceiver, START, TOKEN


def observed(value, device_ip=START["deviceIp"], read_at=None):
    return {"deviceIp": device_ip, "readAt": time.time() if read_at is None else read_at,
            "source": "device-readback", "fields": {"laser": {"supported": True, "value": value}}}


class LaserDeviceTests(unittest.TestCase):
    def test_lightweight_read_uses_only_command_46_and_never_writes(self):
        api = FakeAPI()
        panel = DevicePanel(ReceiverConfig(START["deviceIp"], "", "fixture"))
        panel._load_api = lambda: api
        with patch.object(api, "PolySendGetInt16", wraps=api.PolySendGetInt16) as read, \
             patch.object(api, "PolyHasCommand", wraps=api.PolyHasCommand) as has:
            for value in (1, 0):
                api.integers[46] = value
                result = panel.run_command("laser_read")
                self.assertEqual(result["fields"]["laser"]["value"], value)
                self.assertEqual(set(result["fields"]), {"laser"})
            self.assertEqual([call.args[3] for call in read.call_args_list], [46, 46])
            has.assert_not_called()
        self.assertEqual(api.writes, [])
        self.assertTrue(api.closed)

    def test_invalid_readback_is_unknown_instead_of_false(self):
        api = FakeAPI()
        api.integers[46] = 2
        panel = DevicePanel(ReceiverConfig(START["deviceIp"], "", "fixture"))
        panel._load_api = lambda: api
        with self.assertRaisesRegex(ValueError, "无效激光状态"):
            panel.run_command("laser_read")
        self.assertTrue(api.closed)
        self.assertEqual(api.writes, [])


class LaserServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Settings(TOKEN, 8765, Path(self.temp.name)), FixtureReceiver)
        self.controller = self.app.state.controller
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()

    def tearDown(self):
        self.controller.stop_event.set()
        if self.controller.thread:
            self.controller.thread.join(5)
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def poll(self, device_ip=START["deviceIp"]):
        result = self.client.post("/api/field/device", json={"action": "laser_read", "deviceIp": device_ip})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def test_initial_external_changes_and_off_readback_remain_distinct_from_unknown(self):
        initial = self.client.get("/api/field/status").json()["laserStatus"]
        self.assertEqual(initial, {"deviceIp": "", "state": "unknown", "readAt": None,
                                  "source": "unavailable", "busy": False})
        with patch("blade_acquisition.service.DevicePanel") as panel:
            for value, expected in ((1, "on"), (0, "off")):
                panel.return_value.run_command.return_value = observed(value)
                result = self.poll()
                self.assertEqual(result["state"], expected)
                self.assertFalse(result["busy"])
                self.assertIsInstance(result["readAt"], float)
                self.assertEqual(result["source"], "device-readback")
                self.assertEqual(self.client.get("/api/field/status").json()["laserStatus"], result)
            self.assertEqual(panel.return_value.run_command.call_args.args, ("laser_read",))

    def test_poll_failure_expiration_and_different_ip_never_reuse_old_state(self):
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.return_value = observed(1)
            self.assertEqual(self.poll()["state"], "on")
            panel.return_value.run_command.side_effect = RuntimeError("fixture disconnected")
            failed = self.poll()
            self.assertEqual(failed["state"], "unknown")
            self.assertIsNone(failed["readAt"])
            self.assertIn("disconnected", failed["error"])
        self.controller._record_laser_snapshot(observed(0, read_at=time.time() - 4))
        self.assertEqual(self.controller.status()["laserStatus"]["state"], "unknown")
        with self.controller.operation_lock:
            other = self.poll("192.168.104.51")
            self.assertEqual(other["deviceIp"], "192.168.104.51")
            self.assertEqual(other["state"], "unknown")
            self.assertIsNone(other["readAt"])

    def test_busy_poll_is_nonblocking_never_opens_sdk_and_preserves_others_busy(self):
        self.controller._record_laser_snapshot(observed(1))
        with patch("blade_acquisition.service.DevicePanel") as panel:
            with self.controller.operation_lock:
                started = time.monotonic()
                result = self.poll()
                self.assertLess(time.monotonic() - started, .2)
                self.assertEqual(result["state"], "on")
                self.assertTrue(result["busy"])
            self.controller.device_busy = True  # A capture cleanup can still own the SDK.
            self.assertTrue(self.poll()["busy"])
            self.assertTrue(self.controller.device_busy)
            self.controller.device_busy = False
            self.controller.state = "acquiring"
            self.assertTrue(self.poll()["busy"])
            self.controller.state = "idle"
            panel.assert_not_called()
        self.assertTrue(self.controller.operation_lock.acquire(blocking=False))
        self.controller.operation_lock.release()

    def test_receiver_publishes_shared_readback_without_busy_poll_creating_a_panel(self):
        self.controller.state = "acquiring"
        receiver = self.controller._device_receiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture"))
        with patch("blade_acquisition.service.DevicePanel") as panel:
            self.assertEqual(self.poll()["state"], "unknown")
            receiver.laser_observer(observed(1))
            self.assertEqual(self.poll()["state"], "on")
            receiver.laser_observer(observed(0))
            result = self.poll()
            self.assertEqual(result["state"], "off")
            self.assertTrue(result["busy"])
            panel.assert_not_called()
        self.controller.state = "idle"

    def test_write_and_idle_stop_publish_verified_readbacks_while_failures_clear_them(self):
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.return_value = observed(1)
            body = {"action": "laser_on", "deviceIp": START["deviceIp"], "confirmLaser": True}
            self.assertEqual(self.client.post("/api/field/device", json=body).status_code, 200)
            self.assertEqual(self.controller.status()["laserStatus"]["state"], "on")
            panel.return_value.run_command.return_value = observed(0)
            self.assertEqual(self.client.post("/api/field/stop").status_code, 200)
            self.assertEqual(self.controller.status()["laserStatus"]["state"], "off")
            panel.return_value.run_command.side_effect = RuntimeError("uncertain command")
            self.assertEqual(self.client.post("/api/field/device", json=body).status_code, 503)
            self.assertEqual(self.controller.status()["laserStatus"]["state"], "unknown")

    def test_user_write_waits_for_short_monitor_read_but_does_not_queue_behind_user_work(self):
        entered, release = threading.Event(), threading.Event()
        order, outcomes = [], []
        def command(action, *_):
            order.append(action)
            if action == "laser_read":
                entered.set()
                release.wait(2)
            return observed(1 if action == "laser_on" else 0)
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.side_effect = command
            poller = threading.Thread(target=lambda: outcomes.append(self.poll()))
            poller.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertFalse(self.controller.status()["deviceBusy"])
                timer = threading.Timer(.06, release.set)
                timer.start()
                body = {"action": "laser_on", "deviceIp": START["deviceIp"], "confirmLaser": True}
                result = self.client.post("/api/field/device", json=body)
                self.assertEqual(result.status_code, 200, result.text)
                timer.join(1)
            finally:
                release.set()
                poller.join(2)
        self.assertEqual(order, ["laser_read", "laser_on"])
        self.assertEqual(len(outcomes), 1)
        with self.controller.operation_lock:
            started = time.monotonic()
            self.assertEqual(self.client.post("/api/field/device", json=body).status_code, 409)
            self.assertLess(time.monotonic() - started, .2)

    def test_user_write_gives_up_after_bounded_wait_for_stalled_monitor(self):
        entered, release = threading.Event(), threading.Event()
        def command(action, *_):
            if action != "laser_read":
                self.fail("write must not overtake an unfinished monitor read")
            entered.set()
            release.wait(3)
            return observed(0)
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.side_effect = command
            poller = threading.Thread(target=self.poll)
            poller.start()
            try:
                self.assertTrue(entered.wait(2))
                started = time.monotonic()
                body = {"action": "laser_on", "deviceIp": START["deviceIp"], "confirmLaser": True}
                self.assertEqual(self.client.post("/api/field/device", json=body).status_code, 409)
                self.assertGreaterEqual(time.monotonic() - started, .5)
                self.assertLess(time.monotonic() - started, 1.5)
            finally:
                release.set()
                poller.join(2)
        self.assertFalse(self.controller.laser_poll_busy)


class LaserReceiverTests(unittest.TestCase):
    def test_abort_during_laser_on_readback_turns_off_without_starting_daq(self):
        abort = threading.Event()
        receiver = PolytecReceiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture"))
        sdk = FakeSdk()
        def observed_laser(snapshot):
            if snapshot["fields"]["laser"].get("value") == 1:
                abort.set()
        receiver.laser_observer = observed_laser
        with patch.object(receiver, "_load_api", return_value=sdk), \
             patch.object(sdk, "PolyStartDataAcquisition", wraps=sdk.PolyStartDataAcquisition) as start:
            receiver.run(threading.Event(), lambda *_: self.fail("DAQ cannot become ready after abort"),
                         lambda *_: None, abort=abort)
        start.assert_not_called()
        self.assertEqual(sdk.laser_commands, [1, 0])
        self.assertEqual(sdk.closed, ["acquisition", "communication"])

    def test_global_abort_before_or_during_setup_never_turns_laser_on(self):
        for phase in ("before_load", "during_setup"):
            with self.subTest(phase=phase):
                abort, local_stop = threading.Event(), threading.Event()
                receiver = PolytecReceiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture"))
                sdk = FakeSdk()
                if phase == "before_load":
                    abort.set()
                original = sdk.PolyBaseSampleRateInHz
                def rate(*args):
                    abort.set()
                    return original(*args)
                with patch.object(receiver, "_load_api", return_value=sdk) as load, \
                     patch.object(sdk, "PolyBaseSampleRateInHz", side_effect=rate):
                    receiver.run(local_stop, lambda *_: self.fail("DAQ must not start after cancellation"),
                                 lambda *_: None, abort=abort)
                self.assertEqual(sdk.laser_commands, [])
                if phase == "before_load":
                    load.assert_not_called()
                    self.assertEqual(sdk.closed, [])
                else:
                    self.assertEqual(sdk.closed, ["acquisition", "communication"])

    def test_periodic_external_readbacks_use_the_owning_capture_thread_and_existing_handle(self):
        owner = threading.get_ident()
        stop = threading.Event()
        class SDK(FakeSdk):
            def __init__(self):
                super().__init__()
                self.external_level = None
                self.reads = 0
                self.open_count = 0
                self.timeouts = []
                self.query_handles = []
                self.query_threads = []
            def PolyOpenUdpEthernetCommunication(sdk, pointer, address, timeout):
                sdk.open_count += 1
                sdk.timeouts.append(timeout)
                pointer._obj.value = 100 + sdk.open_count
                return 0
            def PolySendGetInt16(sdk, handle, device, number, command, pointer):
                if command == 46:
                    sdk.query_threads.append(threading.get_ident())
                    sdk.query_handles.append(handle)
                    if sdk.external_level is not None:
                        pointer._obj.value = sdk.external_level
                        return 0
                return super(SDK, sdk).PolySendGetInt16(handle, device, number, command, pointer)
            def PolyReadData(sdk, *_):
                sdk.reads += 1
                sdk.external_level = 0 if sdk.reads < 4 else 1
                return 0
        sdk = SDK()
        receiver = PolytecReceiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture"))
        snapshots = []
        def observe(snapshot):
            snapshots.append(snapshot)
            if len(snapshots) >= 3:
                stop.set()
        receiver.laser_observer = observe
        clock = itertools.count()
        with patch.object(receiver, "_load_api", return_value=sdk), \
             patch("blade_acquisition.receiver.time.monotonic", side_effect=lambda: next(clock) * .3):
            receiver.run(stop, lambda *_: None, lambda *_: None, keep_laser_on=True)
        self.assertEqual([snapshot["fields"]["laser"]["value"] for snapshot in snapshots], [1, 0, 1])
        self.assertEqual(sdk.open_count, 2)
        self.assertEqual(sdk.timeouts, [6000, 500])
        self.assertEqual(sdk.query_handles[-2:], [102, 102])
        self.assertEqual(set(sdk.query_threads), {owner})
        self.assertEqual(sdk.laser_commands, [1])
        self.assertEqual(sdk.closed, ["communication", "acquisition", "communication"])

    def test_unsupported_or_failed_owner_readback_publishes_unknown_without_switching_laser(self):
        receiver = PolytecReceiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture"))
        receiver.api = FakeSdk()
        observed_snapshots = []
        receiver.laser_observer = observed_snapshots.append
        for failure in (RuntimeError("fixture timeout"), ValueError("bad value")):
            receiver._laser_monitor_failed = False
            with patch.object(receiver.api, "PolySendGetInt16", side_effect=failure) as query:
                receiver._observe_laser()
                receiver._observe_laser()
                self.assertEqual(query.call_count, 1, "a failed monitor must not repeatedly stall the DAQ stream")
            self.assertFalse(observed_snapshots[-1]["fields"]["laser"]["supported"])
            self.assertNotIn("value", observed_snapshots[-1]["fields"]["laser"])
        self.assertEqual(receiver.api.laser_commands, [])
        self.assertIsNone(receiver._laser_monitor_communication)

    def test_monitor_timeout_does_not_fail_capture_or_change_critical_handle_cleanup(self):
        stop, snapshots, batches = threading.Event(), [], []
        class SDK(FakeSdk):
            def __init__(sdk):
                super().__init__()
                sdk.opens, sdk.monitor_queries, sdk.closed_handles = [], 0, []
            def PolyOpenUdpEthernetCommunication(sdk, pointer, address, timeout):
                pointer._obj.value = len(sdk.opens) + 1
                sdk.opens.append(timeout)
                return 0
            def PolySendGetInt16(sdk, handle, device, number, command, pointer):
                if handle == 2:
                    sdk.monitor_queries += 1
                    return 2008
                return super(SDK, sdk).PolySendGetInt16(handle, device, number, command, pointer)
            def PolyCloseCommunication(sdk, handle):
                sdk.closed_handles.append(handle)
                return super(SDK, sdk).PolyCloseCommunication(handle)
        sdk = SDK()
        receiver = PolytecReceiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture"))
        receiver.laser_observer = snapshots.append
        def receive(batch):
            batches.append(batch)
            if len(batches) >= 12:
                stop.set()
        clock = itertools.count()
        with patch.object(receiver, "_load_api", return_value=sdk), \
             patch("blade_acquisition.receiver.time.monotonic", side_effect=lambda: next(clock) * .3):
            receiver.run(stop, lambda *_: None, receive)
        self.assertEqual(len(batches), 12)
        self.assertEqual(sdk.opens, [6000, 500])
        self.assertEqual(sdk.monitor_queries, 1)
        self.assertEqual(sdk.closed_handles, [2, 1])
        self.assertEqual(sdk.laser_commands, [1, 0])
        self.assertEqual([snapshot["fields"]["laser"].get("value") for snapshot in snapshots], [1, None, 0])
