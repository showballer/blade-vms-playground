import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from blade_acquisition.turntable_driver.timing import trace_event


class TurntableTimingTests(unittest.TestCase):
    def test_disabled_by_default_and_rejects_relative_paths(self):
        with patch.dict(os.environ, {"BLADE_TURNTABLE_TIMING_LOG": ""}), patch("os.open") as opened:
            trace_event("disabled")
            opened.assert_not_called()
        with patch.dict(os.environ, {"BLADE_TURNTABLE_TIMING_LOG": "relative.jsonl"}), patch("os.open") as opened:
            trace_event("disabled")
            opened.assert_not_called()

    def test_preserves_supplied_monotonic_timestamp_and_appends(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "trace.jsonl"
            with patch.dict(os.environ, {"BLADE_TURNTABLE_TIMING_LOG": str(file)}), \
                    patch("os.open", wraps=os.open) as opened:
                trace_event("serial_write", monotonic_ns=123, command=0x14)
                trace_event("serial_response", command=0x14)
            self.assertEqual(opened.call_count, 2)
            for call in opened.call_args_list:
                self.assertEqual(call.args, (str(file), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
            records = [json.loads(line) for line in file.read_text().splitlines()]
            self.assertEqual(records[0]["monotonicNs"], 123)
            self.assertEqual(records[1]["event"], "serial_response")
            if os.name == "posix":
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            # Windows ignores owner/group/other permission bits in os.open;
            # stat reports its read-only flag, not the file's inherited ACL.
            # Check the private creation request above on every platform, but
            # do not claim that a synthetic POSIX mode verifies a Windows ACL.

    def test_unwritable_or_unserializable_trace_never_masks_device_result(self):
        with patch.dict(os.environ, {"BLADE_TURNTABLE_TIMING_LOG": "/missing-parent/trace.jsonl"}):
            trace_event("serial_write", command=0x33)
            trace_event("invalid_value", value=object())


if __name__ == "__main__":
    unittest.main()
