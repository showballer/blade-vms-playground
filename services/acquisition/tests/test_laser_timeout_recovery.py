"""Connection-failure recovery uses fake controls only; no device/network I/O."""
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from blade_acquisition.service import DeviceRequest, Settings, create_app
from test_laser_status import observed
from test_service import FixtureReceiver, START, TOKEN


class LaserTimeoutRecoveryTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.controller = create_app(Settings(TOKEN, 8765, Path(folder.name)), FixtureReceiver).state.controller
        self.request = SimpleNamespace(deviceIp=START["deviceIp"], hostIp=START["hostIp"])

    def failed_preparation(self):
        self.controller.cycle_prepare_error = "Open UDP failed (2008): fixture timeout"
        self.controller.stop_event.set()
        self.controller.state = "error"
        self.controller.cycle_receiver = None

    def unknown_laser(self, kind="laser_state"):
        self.controller.state = "error"
        self.controller.device_warning = "fixture laser state unconfirmed"
        self.controller.device_warning_ip = START["deviceIp"]
        self.controller.device_warning_kind = kind
        self.controller.observation_laser_ip = START["deviceIp"]

    def poll(self):
        return self.controller.read_laser(DeviceRequest(action="laser_read", deviceIp=START["deviceIp"]))

    def test_finished_failed_prepare_allows_one_real_cleanup_attempt(self):
        self.failed_preparation()
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.return_value = observed(0)
            result = self.controller._confirm_motion_laser_off(self.request)
            panel.return_value.run_command.assert_called_once_with("laser_off", laser_only=True)
        self.assertEqual(result["state"], "off")
        self.assertIsNone(self.controller.device_warning)
        self.assertEqual(self.controller.status()["laserStatus"]["state"], "off")
        # Preserve the original DAQ failure for the failed task's result.
        self.assertIn("Open UDP failed", self.controller.cycle_prepare_error)

    def test_new_cleanup_failure_reports_new_command_error_and_unknown(self):
        self.failed_preparation()
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.side_effect = RuntimeError("new control connection timeout")
            with self.assertRaisesRegex(RuntimeError, "new control connection timeout") as raised:
                self.controller._confirm_motion_laser_off(self.request)
            panel.return_value.run_command.assert_called_once_with("laser_off", laser_only=True)
        self.assertNotIn("Open UDP failed", str(raised.exception))
        self.assertEqual(self.controller.status()["laserStatus"]["state"], "unknown")
        self.assertEqual(self.controller.device_warning_kind, "laser_state")

    def test_failed_prepare_still_blocks_laser_on_and_capture_preparation(self):
        self.failed_preparation()
        with patch("blade_acquisition.service.DevicePanel") as panel:
            with self.assertRaisesRegex(RuntimeError, "Open UDP failed"):
                self.controller._confirm_motion_laser_on(self.request)
            with self.assertRaisesRegex(RuntimeError, "Open UDP failed"):
                self.controller._await_cycle_receiver()
            panel.assert_not_called()

    def test_unfinished_prepare_never_allows_parallel_cleanup_control(self):
        self.failed_preparation()
        release = threading.Event()
        thread = threading.Thread(target=lambda: release.wait(2))
        self.controller.cycle_prepare_thread = thread
        thread.start()
        try:
            with patch("blade_acquisition.service.DevicePanel") as panel:
                with self.assertRaisesRegex(RuntimeError, "Open UDP failed"):
                    self.controller._confirm_motion_laser_off(self.request)
                self.assertTrue(self.poll()["busy"])
                panel.assert_not_called()
        finally:
            release.set()
            thread.join(2)

    def test_fresh_idle_read_recovers_retry_without_changing_laser(self):
        for value in (0, 1):
            with self.subTest(value=value):
                self.unknown_laser()
                with patch("blade_acquisition.service.DevicePanel") as panel:
                    panel.return_value.run_command.return_value = observed(value)
                    result = self.poll()
                    panel.return_value.run_command.assert_called_once_with("laser_read")
                self.assertIsNone(self.controller.device_warning)
                self.assertIsNone(self.controller.device_warning_kind)
                self.assertEqual(result["state"], "on" if value else "off")
                self.assertEqual(self.controller.observation_laser_ip, START["deviceIp"] if value else None)

    def test_read_failure_does_not_clear_unknown_warning(self):
        self.unknown_laser()
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.side_effect = RuntimeError("still disconnected")
            self.assertEqual(self.poll()["state"], "unknown")
        self.assertIsNotNone(self.controller.device_warning)

    def test_cached_observation_or_unfinished_write_cannot_clear_warning(self):
        self.unknown_laser()
        self.controller._record_laser_snapshot(observed(1))
        self.assertIsNotNone(self.controller.device_warning)
        self.unknown_laser(kind="device_operation")
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.return_value = observed(1)
            self.poll()
        self.assertIsNotNone(self.controller.device_warning)

    def test_stale_wrong_device_and_invalid_readback_do_not_release_warning(self):
        for snapshot in (observed(1, read_at=time.time() - 10),
                         observed(1, read_at=time.time() + 10),
                         observed(1, device_ip="192.168.104.99"), observed(True), observed(2)):
            with self.subTest(snapshot=snapshot):
                self.unknown_laser()
                self.controller._recover_laser_state_warning(snapshot)
                self.assertIsNotNone(self.controller.device_warning)

    def test_live_owner_remains_busy_and_cannot_be_released_by_a_read(self):
        self.unknown_laser()
        self.controller.cycle_receiver = object()
        with patch("blade_acquisition.service.DevicePanel") as panel:
            self.assertTrue(self.poll()["busy"])
            panel.assert_not_called()
        self.controller._recover_laser_state_warning(observed(1))
        self.assertIsNotNone(self.controller.device_warning)


if __name__ == "__main__":
    unittest.main()
