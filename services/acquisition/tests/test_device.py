"""Configuration adapter tests using a fake C API; NEVER connect real hardware."""
import ctypes as C
import unittest
from unittest.mock import patch

from blade_acquisition.device import DevicePanel
from blade_acquisition.receiver import ReceiverConfig


def out(pointer, type_, value):
    C.cast(pointer, C.POINTER(type_))[0] = value


class FakeAPI:
    def __init__(self):
        self.writes = []
        self.closed = False
        self.unsupported = set()
        self.strings = {10: "500 mm/s", 18: "10 kHz", 558: "Off"}
        self.choices = {10: "500 mm/s,100 mm/s", 18: "10 kHz,5 kHz", 558: "Off,13 Hz"}
        self.integers = {574: 0, 46: 0, 38: 399, 66: 82, 64: 0, 174: 0, 76: 1}
        self.fail_command = None
        self.wrong_readback = False

    def PolyOpenUdpEthernetCommunication(self, handle, address, timeout):
        out(handle, C.c_int, 42)
        return 0

    def PolyCloseCommunication(self, handle):
        self.closed = True

    def PolyHasCommand(self, handle, device, number, command, result):
        out(result, C.c_bool, command not in self.unsupported)
        return 0

    def PolyItemListGetAvailableItems(self, handle, device, number, command, buffer, size):
        buffer.value = self.choices[command].encode()
        return 0

    def PolyItemListGetCurrentItem(self, handle, device, number, command, buffer, size):
        buffer.value = self.strings[command].encode()
        return 0

    def PolyItemListSetCurrentItem(self, handle, device, number, command, value):
        self.writes.append((command, value.decode()))
        if not self.wrong_readback:
            self.strings[command] = value.decode()
        return 0

    def PolySendGetInt16(self, handle, device, number, command, result):
        # The fixture finishes immediately; separate timeout tests mock the clock.
        out(result, C.c_int16, 0 if command == 64 else self.integers[command])
        return 0

    def PolySendGetDevInfoRange(self, handle, device, number, command, lo, hi):
        out(lo, C.c_int16, 0)
        out(hi, C.c_int16, 100)
        return 0

    def PolySendSetInt16(self, handle, device, number, command, value):
        self.writes.append((command, value.value))
        if command == self.fail_command:
            return 2008
        self.integers[command] = value.value
        return 0

    def PolyLastCommunicationStatus(self, buffer, size):
        buffer.value = b"explicit fixture failure"


class DeviceTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.panel = DevicePanel(ReceiverConfig("192.168.104.50", "", "fixture"))
        self.panel._load_api = lambda: self.api

    def test_read_is_only_read_and_uses_actual_options(self):
        result = self.panel.run_command()
        self.assertEqual(self.api.writes, [])
        self.assertTrue(self.api.closed)
        self.assertEqual(result["fields"]["velocityRange"]["value"], "500 mm/s")
        self.assertEqual(result["fields"]["velocityRange"]["options"], ["500 mm/s", "100 mm/s"])
        self.assertEqual(result["fields"]["signalLevel"]["percent"], 82)

    def test_one_setting_is_applied_and_read_back(self):
        result = self.panel.run_command("set", "bandwidth", "5 kHz", "10 kHz")
        self.assertEqual(self.api.writes, [(18, "5 kHz")])
        self.assertEqual(result["fields"]["bandwidth"]["value"], "5 kHz")

    def test_stale_expected_value_is_not_overwritten(self):
        with self.assertRaisesRegex(ValueError, "已变化"):
            self.panel.run_command("set", "bandwidth", "5 kHz", "wrong old setting")
        self.assertEqual(self.api.writes, [])
        self.assertTrue(self.api.closed)

    def test_unsupported_and_arbitrary_values_cannot_be_written(self):
        for key, value in [("laser", 1), ("unknown", 123), ("bandwidth", "999 kHz")]:
            with self.assertRaises(ValueError):
                self.panel.run_command("set", key, value, "10 kHz")
        self.assertEqual(self.api.writes, [])

    def test_readback_mismatch_fails_not_success(self):
        self.api.wrong_readback = True
        with self.assertRaisesRegex(RuntimeError, "不一致"):
            self.panel.run_command("set", "bandwidth", "5 kHz", "10 kHz")
        self.assertTrue(self.api.closed)

    def test_unsupported_read_remains_unknown(self):
        self.api.unsupported.add(18)
        result = self.panel.run_command()
        self.assertFalse(result["fields"]["bandwidth"]["supported"])
        self.assertNotIn("value", result["fields"]["bandwidth"])

    @patch("blade_acquisition.device.time.sleep")
    def test_autofocus_turns_off_laser_and_does_not_open_daq(self, _sleep):
        result = self.panel.run_command("autofocus")
        self.assertEqual(self.api.writes, [(46, 1), (64, 1), (64, 0), (46, 0)])
        self.assertEqual(result["fields"]["laser"]["value"], 0)
        self.assertTrue(self.api.closed)

    @patch("blade_acquisition.device.time.sleep")
    def test_uncertain_start_still_attempts_laser_off(self, _sleep):
        self.api.fail_command = 64
        with self.assertRaisesRegex(RuntimeError, "现场确认"):
            self.panel.run_command("autofocus")
        self.assertIn((46, 0), self.api.writes)
        self.assertTrue(self.api.closed)

    @patch("blade_acquisition.device.time.sleep")
    def test_not_found_is_not_reported_as_focus_success(self, _sleep):
        self.api.integers[76] = 0
        with self.assertRaisesRegex(RuntimeError, "未找到焦点"):
            self.panel.run_command("autofocus")
        self.assertEqual(self.api.writes[-1], (46, 0))


if __name__ == "__main__":
    unittest.main()
