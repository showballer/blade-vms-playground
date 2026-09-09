import contextlib
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from blade_acquisition.__main__ import main, self_check


class SelfCheckTests(unittest.TestCase):
    def test_loads_bindings_without_hardware_or_service(self):
        api = SimpleNamespace(**{f"PolySymbol{i}": lambda: self.fail("SDK must not be called") for i in range(18)})
        with patch("blade_acquisition.receiver.PolytecReceiver._load_api", return_value=api), patch("blade_acquisition.__main__.Settings.from_environment", side_effect=AssertionError("service must not start")):
            result = self_check()
        self.assertEqual(result["sdkSymbols"], 18)
        self.assertTrue(result["dllLoaded"])
        self.assertFalse(result["hardwareTouched"])

    def test_failure_is_machine_readable_and_nonzero(self):
        output = io.StringIO()
        with patch("sys.argv", ["BladeAcquisition.exe", "--self-check"]), patch("blade_acquisition.__main__.self_check", side_effect=RuntimeError("missing DLL")), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                main()
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {"dllLoaded": False, "hardwareTouched": False, "error": "missing DLL"})
