import contextlib
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from blade_acquisition.__main__ import main, self_check


class SelfCheckTests(unittest.TestCase):
    def test_loads_bindings_without_hardware_or_service(self):
        class BindingAPI(SimpleNamespace):
            def __getattr__(self, name):
                def never_call(*args):
                    raise AssertionError("SDK must not be called")
                setattr(self, name, never_call)
                return never_call

        api = BindingAPI()
        # Run the actual base and device-panel binding code, not a canned symbol
        # count, so this portable test also detects a stale frozen Windows gate.
        with patch("blade_acquisition.receiver.PolytecReceiver.validate"), patch("blade_acquisition.receiver.C.CDLL", return_value=api), patch("blade_acquisition.receiver.os.add_dll_directory", create=True), patch("blade_acquisition.__main__.Settings.from_environment", side_effect=AssertionError("service must not start")):
            result = self_check()
        self.assertEqual(result["sdkSymbols"], 23)
        for name in ["PolyHasCommand", "PolyItemListGetAvailableItems", "PolyItemListSetCurrentItem", "PolySendGetDevInfoRange", "PolySendGetInt16"]:
            self.assertIn(name, result["sdkSymbolNames"])
        self.assertTrue(result["dllLoaded"])
        self.assertFalse(result["hardwareTouched"])

    def test_failure_is_machine_readable_and_nonzero(self):
        output = io.StringIO()
        with patch("sys.argv", ["BladeAcquisition.exe", "--self-check"]), patch("blade_acquisition.__main__.self_check", side_effect=RuntimeError("missing DLL")), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                main()
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {"dllLoaded": False, "hardwareTouched": False, "error": "missing DLL"})
