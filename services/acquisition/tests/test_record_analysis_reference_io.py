from __future__ import annotations

# Adapted from the read-only 2026-10-28 reference acceptance suite.
# Synthetic fixtures stay isolated; this suite never opens acquisition hardware.

from contextlib import redirect_stdout
import csv
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from blade_acquisition.record_analysis.reference import AnalysisConfig, SignalError, analyze_recording, read_measurement_inputs
from blade_acquisition.record_analysis.reference.aggregate import aggregate_points
from blade_acquisition.record_analysis.reference.cli import main
from blade_acquisition.record_analysis.reference.io import read_csv_recording
from blade_acquisition.record_analysis.reference.stitch import JoinConfig, build_point_preview
from tests.test_record_analysis_reference import recording, representative


class AdapterExportTests(unittest.TestCase):
    def test_malformed_scalar_and_vector_are_structured_errors(self):
        for value in ({"horizontal_distance_m": []}, {"shaft_axis_world": 3},
                      {"shaft_axis_world": "abc"}, {"shaft_axis_world": [[1], [0], [0]]}):
            with self.assertRaisesRegex(SignalError, "INVALID_MEASUREMENT_INPUT"):
                read_measurement_inputs({}, value)

    def test_interior_blank_csv_is_never_index_compressed(self):
        blob = b'# BladeVMS {"sampleRate":1000}\ntime_s,velocity_m_s,RSSI_percent,overrange\n0,1,30,0\n\n0.001,2,30,0\n'
        with self.assertRaisesRegex(SignalError, "CSV_ROW_GAP"):
            read_csv_recording(blob, {})

    def test_trailing_blank_csv_does_not_add_samples(self):
        blob = b'# BladeVMS {"sampleRate":1000}\ntime_s,velocity_m_s,RSSI_percent,overrange\n0,1,30,0\n0.001,2,30,0\n\n'
        r = read_csv_recording(blob, {})
        self.assertEqual(len(r.velocity_m_s), 2)

    def test_preview_rejects_same_name_conflicting_radius(self):
        results = [representative(analyze_recording(recording(str(a), a))) for a in (0, 90)]
        results[1].parameters["object"]["radius_from_hub_m"] = 21.
        with self.assertRaisesRegex(SignalError, "AGGREGATION_BASIS_MISMATCH"):
            build_point_preview(results, expected_azimuths=(0., 90.),
                config=JoinConfig(.002, .004, .0002, 4000.))

    def test_aggregate_separates_conflicting_radius(self):
        a, b = [analyze_recording(recording(str(angle), angle)) for angle in (0, 90)]
        representative(b).parameters["object"]["radius_from_hub_m"] = 21.
        output = aggregate_points([a, b])
        self.assertEqual(len(output), 2)
        self.assertEqual({p["radius_from_hub_m"] for p in output}, {20., 21.})

    def test_cli_exports_real_spectra_and_typed_display_csv(self):
        records = [recording(str(a), a, n=1500, fs=25000.) for a in (0, 90, 180, 270)]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            config = out / "join.json"
            config.write_text(json.dumps(dict(duration_seconds=.002, context_seconds=.004,
                cap_seconds=.0002, model_sample_rate_hz=25000., amplitude_guard_factor=10., slope_guard_factor=20.)))
            with patch("blade_acquisition.record_analysis.reference.cli.iter_zip_recordings", return_value=iter(records)), redirect_stdout(StringIO()):
                code = main(["--zip", "unused.zip", "--out", str(out), "--preview-point", "P2",
                    "--preview-azimuths", "0,90,180,270", "--join-config", str(config)])
            self.assertEqual(code, 0)
            report = json.loads((out / "analysis.json").read_text())
            self.assertEqual(report["preview"]["status"], "ready")
            aggregate = report["aggregates"][0]
            with np.load(out / aggregate["arrays_file"], allow_pickle=False) as arrays:
                self.assertTrue(np.all(np.isfinite(arrays["psd_m2_s2_per_hz"])))
            with (out / report["preview"]["csv_file"]).open(encoding="utf-8-sig", newline="") as stream:
                rows = list(csv.DictReader(stream))
            measured = [r for r in rows if r["sample_type"] == "measured_processed"]
            synthetic = [r for r in rows if r["sample_type"] == "synthetic_display_transition"]
            self.assertEqual((len(measured), len(synthetic)), (6000, 150))
            self.assertTrue(all(r["analysis_eligible"] == "false" for r in rows))
            self.assertTrue(all(r["source_sample_index"] == r["source_time_s"] == "" for r in synthetic))
            self.assertEqual(measured[0]["source_sample_index"], "0")
            self.assertEqual(float(measured[-1]["source_time_s"]), records[-1].time_s[-1])


if __name__ == "__main__":
    unittest.main()
