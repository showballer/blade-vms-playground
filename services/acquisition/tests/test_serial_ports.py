from __future__ import annotations

import json
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from blade_acquisition.serial_ports import valid_serial_port, validate_local_serial_port, list_turntable_ports
from blade_acquisition.turntable import TurntableConfig, TurntableRequest, PointCycleConfig
from blade_acquisition.turntable_driver.motor_controller import MotorController, CommunicationError


class SerialPortTests(unittest.TestCase):
    port = "/dev/cu.SLAB_USBtoUART"
    signature = "[[0,3,10000,17],[0,3,10000,17]]"

    def test_cross_language_name_contract(self):
        cases = json.loads((Path(__file__).resolve().parents[3] / "scripts/fixtures/turntable-ports.json").read_text())
        for port in cases["valid"]:
            with self.subTest(port=port):
                self.assertTrue(valid_serial_port(port))
                self.assertEqual(TurntableConfig(port=port).port, port)
        for port in cases["invalid"] + ["/dev/cu." + "a" * 129]:
            with self.subTest(port=port):
                self.assertFalse(valid_serial_port(port))
                with self.assertRaises(ValueError):
                    TurntableConfig(port=port)

    def test_mac_recall_and_cycle_preserve_identity_and_guards(self):
        request = dict(action="recall", port=self.port, recordedPort=self.port, referenceSignature=self.signature,
                       axis1AngleDeg=25, axis2AngleDeg=0, confirmMotion=True)
        self.assertEqual(TurntableRequest(**request).recordedPort, self.port)
        for changes in ({"recordedPort": self.port.lower()}, {"recordedPort": None}, {"referenceSignature": None},
                        {"axis1AngleDeg": 36}, {"axis2AngleDeg": 181}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                TurntableRequest(**(request | changes))
        point = dict(name="M01", port=self.port, referenceSignature=self.signature, axis1AngleDeg=25, axis2AngleDeg=0)
        self.assertEqual(PointCycleConfig(port=self.port, points=[point]).points[0].port, self.port)
        for changes in ({"port": self.port.lower()}, {"referenceSignature": "invalid"}, {"axis1AngleDeg": 36}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                PointCycleConfig(port=self.port, points=[point | changes])

    def test_local_gate_requires_platform_character_device_and_never_symlink(self):
        with patch("blade_acquisition.serial_ports.sys.platform", "darwin"):
            with patch("blade_acquisition.serial_ports.os.lstat", return_value=SimpleNamespace(st_mode=stat.S_IFCHR)):
                self.assertEqual(validate_local_serial_port(self.port), self.port)
                with self.assertRaises(ValueError):
                    validate_local_serial_port("COM6")
            for mode in (stat.S_IFREG, stat.S_IFLNK, stat.S_IFDIR, stat.S_IFIFO):
                with patch("blade_acquisition.serial_ports.os.lstat", return_value=SimpleNamespace(st_mode=mode)), self.assertRaises(ValueError):
                    validate_local_serial_port(self.port)
            with patch("blade_acquisition.serial_ports.os.lstat", side_effect=FileNotFoundError), self.assertRaises(ValueError):
                validate_local_serial_port(self.port)
        with patch("blade_acquisition.serial_ports.sys.platform", "win32"):
            self.assertEqual(validate_local_serial_port("COM6"), "COM6")
            with self.assertRaises(ValueError):
                validate_local_serial_port(self.port)

    def test_port_listing_filters_nonlocal_paths_and_preserves_device_case(self):
        ports = [SimpleNamespace(device=name, description="USB UART") for name in
                 (self.port, self.port, "COM6", "/dev/tty.usbserial-110", "/tmp/file", "/dev/cu.file")]
        def mode(path):
            return SimpleNamespace(st_mode=stat.S_IFREG if path.endswith("file") else stat.S_IFCHR)
        with patch("blade_acquisition.serial_ports.sys.platform", "darwin"), patch("blade_acquisition.serial_ports.os.lstat", side_effect=mode), patch("serial.tools.list_ports.comports", return_value=ports):
            self.assertEqual(list_turntable_ports(), [{"port": self.port, "description": "USB UART"}])

    def test_real_driver_rejects_nondevice_before_pyserial_and_keeps_open_read_only(self):
        with patch("blade_acquisition.turntable_driver.motor_controller.validate_local_serial_port", side_effect=ValueError("disconnected")), patch("serial.Serial") as serial:
            with self.assertRaisesRegex(CommunicationError, "disconnected"):
                MotorController(self.port).connect()
            serial.assert_not_called()
        with patch("blade_acquisition.turntable_driver.motor_controller.validate_local_serial_port", return_value=self.port), patch("serial.Serial") as serial:
            motor = MotorController(self.port).connect()
            self.assertEqual(serial.call_args.args[0], self.port)
            self.assertEqual(serial.call_args.kwargs["baudrate"], 115200)
            serial.return_value.write.assert_not_called()
            motor.close(stop=False)

    def test_injected_adapter_remains_platform_independent(self):
        adapter = MagicMock()
        with patch("blade_acquisition.turntable_driver.motor_controller.validate_local_serial_port") as gate:
            motor = MotorController("COM6", serial_factory=adapter).connect()
            gate.assert_not_called()
            adapter.return_value.write.assert_not_called()
            motor.close(stop=False)


if __name__ == "__main__":
    unittest.main()
