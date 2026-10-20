"""Web import regressions: units, source identity, full samples, and rotation output."""
import base64
import copy
import gzip
import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from blade_acquisition.analysis import read_raw
from blade_acquisition.csv_export import prepare_export, stream_csv
from blade_acquisition.receiver import Batch
from blade_acquisition.storage import RecordingStore
from blade_acquisition.web_rotation import dispatch, parse_table


class WebRotationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="blade-web-rotation-test-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def csv(self, metadata=None, header="time_s,velocity_m_s,RSSI_percent,overrange", rows=None, options=None):
        rows = rows if rows is not None else [f"{i / 1000:.6f},{0.02 * math.sin(2 * math.pi * 20 * i / 1000)},{'' if i % 4 == 0 else '83'}, {int(i == 20)}" for i in range(1001)]
        text = ("# BladeVMS " + json.dumps(metadata) + "\n" if metadata is not None else "") + header + "\n" + "\n".join(rows)
        return dispatch(self.root, {"action": "import", "filename": "P1_xL0.6.csv", "bytes": base64.b64encode(text.encode()).decode(), "options": options or {}})["recordings"][0]

    def test_complete_csv_preserves_simulation_missing_rssi_and_overrange(self):
        record = self.csv({"format": "blade-vms-csv-1", "source": "simulation", "simulation": {"scenario": "low_return"}, "sampleRate": 1000, "samples": 1001, "position": 0.6, "point": "P1"}, options={"source": "measured"})
        self.assertEqual(record["source"], "simulation")
        self.assertEqual(record["missingRssiSamples"], 251)
        self.assertEqual(record["overrangeSamples"], 1)
        self.assertEqual(record["position"], 0.6)
        store = RecordingStore(self.root / "recordings")
        with self.assertRaisesRegex(ValueError, "超量程"):
            read_raw(store, record["id"], 0, record["samples"])
        values, rate, trace = read_raw(store, record["id"], 64, record["samples"])
        np.testing.assert_allclose(values, 0.02 * np.sin(2 * np.pi * 20 * np.arange(64, 1001) / 1000), atol=1e-14)
        self.assertEqual(len(values), 937)
        source = json.loads((store.directory(record["id"]) / "source-columns.json").read_text())
        self.assertEqual(len(source["columns"]["rssi_percent"]), 1001)
        result = dispatch(self.root, {"action": "rotation", "parameters": {"recordingIds": [record["id"]], "rpm": 1200, "startSeconds": 0.1}})
        self.assertEqual(len(result["synchronousAverages"][0]["values"]), 256)
        self.assertTrue(all(math.isfinite(value) for value in result["orderSpectra"][0]["amplitudes"]))
        self.assertAlmostEqual(result["modeShape"]["points"][0]["amplitude"], 0.02, delta=0.0001)
        self.assertEqual(result["sources"][0]["source"], "simulation")

    def test_device_source_and_sample_count(self):
        record = self.csv({"format": "blade-vms-csv-1", "source": "polytec_ivs500", "samples": 1001, "sampleRate": 1000})
        self.assertEqual(record["source"], "measured")
        with self.assertRaisesRegex(ValueError, "样本数"):
            self.csv({"format": "blade-vms-csv-1", "source": "simulation", "samples": 1002})

    def station_export(self):
        store = RecordingStore(self.root / "source-recordings")
        cycle = {"mode": "automatic_stations", "collectionId": "c" * 32, "sessionId": "a" * 32,
                 "bladeId": "2", "radialPointId": "p1", "radialPointName": "P1", "radiusM": .31,
                 "azimuthDeg": 90, "stationIndex": 2, "stationCount": 4, "lapIndex": 1,
                 "pointId": "p1-s2", "stationId": "p1-s2", "pointName": "P1 · 90°", "cycle": 1, "pointIndex": 2,
                 "completion": "confirmed_pass", "identityVerified": False, "nominalPeriodSeconds": 30,
                 "entrySampleIndex": 20, "exitSampleIndex": 199,
                 "handoff": {"entrySampleIndex": 20, "entryConfirmedSampleIndex": 24,
                             "exitSampleIndex": 180, "exitConfirmedSampleIndex": 199}}
        writer = store.create({"name": "叶片检测", "windFarm": "WF-001", "object": "模型", "turbine": "风机A", "point": "P1 · 90°",
                               "source": "polytec_ivs500", "pointCycle": cycle})
        writer.ready(1000, 1700000000.25)
        for start in range(0, 256, 4):
            rssi = [] if start == 40 else [75.0]
            writer.write(Batch(start, 1000, 1700000000.25, [0] * 4, [index * .001 for index in range(start, start + 4)],
                               [0] * len(rssi), rssi, [False] * 4, 4))
        writer.finish(None)
        manifest, chunks = prepare_export(store, writer.manifest["id"])
        text = "".join(stream_csv(manifest, chunks))
        return manifest, text

    def test_operator_driven_zero_period_import_preserves_real_station_boundaries(self):
        original, text = self.station_export()
        first, rows = text.split("\n", 1)
        metadata = json.loads(first[len("# BladeVMS "):])
        metadata["pointCycle"]["nominalPeriodSeconds"] = 0
        manual_text = "# BladeVMS " + json.dumps(metadata) + "\n" + rows
        imported = dispatch(self.root, {"action": "import", "filename": "manual-P1.csv",
                                        "bytes": base64.b64encode(manual_text.encode()).decode()})["recordings"][0]
        self.assertEqual(imported["pointCycle"]["nominalPeriodSeconds"], 0)
        self.assertEqual(imported["pointCycle"]["handoff"], original["pointCycle"]["handoff"])
        self.assertFalse(imported["pointCycle"]["identityVerified"])
        self.assertEqual(imported["source"], "measured")
        for invalid in (-1, False, float("inf")):
            with self.subTest(period=invalid):
                metadata["pointCycle"]["nominalPeriodSeconds"] = invalid
                bad_text = "# BladeVMS " + json.dumps(metadata) + "\n" + rows
                with self.assertRaises(ValueError):
                    dispatch(self.root, {"action": "import", "filename": "bad-P1.csv",
                                         "bytes": base64.b64encode(bad_text.encode()).decode()})

    def test_full_export_and_csv_import_keep_station_identity_gates_and_sparse_rssi(self):
        original, text = self.station_export()
        exported = json.loads(text.splitlines()[0][len("# BladeVMS "):])
        self.assertEqual(exported["pointCycle"], original["pointCycle"])
        self.assertEqual(exported["sampleOrigin"], original["sampleOrigin"])
        for streamed in (False, True):
            with self.subTest(streamed=streamed):
                root = self.root / ("stream" if streamed else "inline")
                root.mkdir()
                payload = {"action": "import", "filename": "P1.csv.gz" if streamed else "P1.csv"}
                if streamed:
                    uploaded = root / ".upload-point"
                    uploaded.write_bytes(gzip.compress(text.encode()))
                    payload["inputFile"] = str(uploaded)
                else:
                    payload["bytes"] = base64.b64encode(text.encode()).decode()
                imported = dispatch(root, payload)["recordings"][0]
                self.assertEqual(imported["pointCycle"], original["pointCycle"])
                self.assertEqual(imported["windFarm"], "WF-001")
                self.assertEqual((imported["object"], imported["turbine"]), ("模型", "风机A"))
                self.assertEqual(imported["sourceRecordingId"], original["id"])
                self.assertEqual(imported["sourceSampleOrigin"], 1700000000.25)
                self.assertNotEqual(imported["sampleOrigin"], imported["sourceSampleOrigin"])
                self.assertEqual(imported["sourceTimeStart"], 0)
                for field in ("rssiSampleStride", "rssiSampleRate", "rssiNotSampledVelocitySamples", "rssiMissingExpectedSamples", "missingRssiSamples"):
                    self.assertEqual(imported[field], original[field], field)
                imported_store = RecordingStore(root / "recordings")
                values, rate, _ = read_raw(imported_store, imported["id"], 0, 256)
                np.testing.assert_allclose(values, np.arange(256) * .001, atol=0)
                self.assertEqual(rate, 1000)
                second_export = "".join(stream_csv(*prepare_export(imported_store, imported["id"])))
                second_root = root / "roundtrip"
                second = dispatch(second_root, {"action": "import", "filename": "P1.csv", "bytes": base64.b64encode(second_export.encode()).decode()})["recordings"][0]
                self.assertEqual(second["pointCycle"], original["pointCycle"])
                self.assertEqual(second["windFarm"], "WF-001")
                self.assertEqual(second["sourceRecordingId"], original["id"])
                self.assertEqual(second["sourceSampleOrigin"], original["sampleOrigin"])
                self.assertEqual(second["sourceStartedAt"], original["startedAt"])

    def test_invalid_or_shifted_station_metadata_never_falls_back_to_continuous_import(self):
        _, text = self.station_export()
        first, body = text.split("\n", 1)
        baseline = json.loads(first[len("# BladeVMS "):])
        mutations = [
            lambda m: m.update(pointCycle=None),
            lambda m: m.update(pointCycle={}),
            lambda m: m.update(sourceTimeStart=1),
            lambda m: m.update(sampleOrigin=float("nan")),
            lambda m: m.update(rssiSampleStride=True),
            lambda m: m.update(rssiSampleRate=1000),
            lambda m: m["pointCycle"].update(collectionId="C" * 32),
            lambda m: m["pointCycle"].update(sessionId="a" * 32 + "\n"),
            lambda m: m["pointCycle"].update(bladeId=" "),
            lambda m: m["pointCycle"].update(radiusM=True),
            lambda m: m["pointCycle"].update(identityVerified=True),
            lambda m: m["pointCycle"].update(stationId="different"),
            lambda m: m["pointCycle"]["handoff"].update(exitSampleIndex=20),
            lambda m: m["pointCycle"]["handoff"].update(exitConfirmedSampleIndex=256),
            lambda m: m["pointCycle"].pop("handoff"),
            lambda m: m.pop("samples"),
        ]
        for index, mutate in enumerate(mutations):
            metadata = copy.deepcopy(baseline)
            mutate(metadata)
            content = "# BladeVMS " + json.dumps(metadata) + "\n" + body
            for streamed in (False, True):
                with self.subTest(mutation=index, streamed=streamed), self.assertRaises(ValueError):
                    payload = {"action": "import", "filename": "P1.csv"}
                    if streamed:
                        uploaded = self.root / ".upload-invalid"
                        uploaded.write_text(content)
                        payload["inputFile"] = str(uploaded)
                    else:
                        payload["bytes"] = base64.b64encode(content.encode()).decode()
                    dispatch(self.root, payload)
        shifted = body.splitlines()
        shifted[1:] = [f"{float(row.split(',')[0]) + 1:.6f}," + row.split(',', 1)[1] for row in shifted[1:]]
        with self.assertRaisesRegex(ValueError, "从 0"):
            self.csv(baseline, header=shifted[0], rows=shifted[1:])

    def test_plain_csv_does_not_infer_blade_or_collection_identity(self):
        imported = self.csv()
        for field in ("pointCycle", "collectionId", "sourceSampleOrigin", "sourceRecordingId"):
            self.assertNotIn(field, imported)

    def test_sparse_rssi_survives_stream_buffer_boundary_and_rejects_off_grid_values(self):
        samples, stride = 17003, 3
        metadata = {"format": "blade-vms-csv-1", "samples": samples, "sampleRate": 900,
                    "rssiSampleStride": stride, "rssiSampleRate": 300}
        rows = [f"{index / 900:.17g},0.1,{75 if index % stride == 0 and index != 16380 else ''},0" for index in range(samples)]
        uploaded = self.root / ".upload-sparse"
        uploaded.write_text("# BladeVMS " + json.dumps(metadata) + "\ntime_s,velocity_m_s,RSSI_percent,overrange\n" + "\n".join(rows))
        imported = dispatch(self.root, {"action": "import", "filename": "P1.csv", "inputFile": str(uploaded)})["recordings"][0]
        self.assertEqual(imported["samples"], samples)
        self.assertEqual(imported["rssiSampleStride"], stride)
        self.assertEqual(imported["rssiSampleRate"], 300)
        self.assertEqual(imported["rssiMissingExpectedSamples"], 1)
        self.assertEqual(imported["rssiNotSampledVelocitySamples"], samples - math.ceil(samples / stride))
        rows[1] = f"{1 / 900:.17g},0.1,75,0"
        with self.assertRaisesRegex(ValueError, "RSSI 样本位置"):
            self.csv(metadata, rows=rows)

    def test_unknown_value_unit_requires_choice(self):
        rows = [["time_s", "value"]] + [[i / 1000, i] for i in range(64)]
        with self.assertRaisesRegex(ValueError, "缺少物理量和单位"):
            parse_table("P1", rows, {})
        parsed = parse_table("P1", rows, {"quantity": "velocity", "unit": "mm/s"})
        self.assertAlmostEqual(parsed["values"][-1], 0.063)

    def test_displacement_derivative_and_qualified_unit_precedence(self):
        rows = [["time_s", "displacement_mm"]] + [[i / 1000, 2 * i / 1000] for i in range(64)]
        result = parse_table("P1", rows, {"quantity": "velocity", "unit": "m/s"})
        np.testing.assert_allclose(result["values"], 0.002, atol=1e-14)
        self.assertEqual(result["sourceQuantity"], "displacement")

    def test_nonuniform_or_empty_samples_rejected(self):
        rows = [["time_s", "velocity_m_s"]] + [[i / 1000, i] for i in range(64)]
        rows[32][0] += 0.0005
        with self.assertRaisesRegex(ValueError, "非等间隔"):
            parse_table("P1", rows, {})
        rows[32][0] -= 0.0005
        rows[12][1] = ""
        with self.assertRaisesRegex(ValueError, "缺少数值"):
            parse_table("P1", rows, {})

    def test_user_roots_do_not_share_recordings(self):
        self.csv()
        other = self.root / "another-user"
        self.assertEqual(dispatch(other, {"action": "recordings"})["recordings"], [])
        self.assertEqual(len(dispatch(self.root, {"action": "recordings"})["recordings"]), 1)

    def test_quality_and_rpm_columns_retained(self):
        rows = [["time_s", "velocity_m_s", "rpm", "quality", "laser_hit"]] + [[i / 1000, i / 1000, 1200, "LOW_RETURN" if i % 2 else "HIT", i % 2] for i in range(64)]
        parsed = parse_table("P2_xL0.60", rows, {"source": "simulation"})
        self.assertEqual(parsed["qualityCounts"], {"HIT": 32, "LOW_RETURN": 32})
        self.assertEqual(parsed["rpm"], 1200)
        self.assertEqual(len(parsed["auxiliary"]["laser_hit"]), 64)

    def test_stream_gzip_preserves_source_and_batch_boundary_derivative(self):
        source = self.root / ".upload-stream-test"
        count = 17000
        with gzip.open(source, "wt", encoding="utf-8") as stream:
            stream.write("# BladeVMS " + json.dumps({"format": "blade-vms-csv-1", "source": "simulation", "samples": count, "sampleRate": 1000}) + "\n")
            stream.write("time_s,displacement_mm,RSSI_percent,overrange,quality\n")
            for i in range(count):
                stream.write(f"{i / 1000:.6f},{2 * i / 1000:.6f},{'' if i % 5 == 0 else 85},0,LOW_RETURN\n")
        result = dispatch(self.root, {"action": "import", "filename": "P1.csv.gz", "inputFile": str(source), "options": {"source": "measured"}})
        record = result["recordings"][0]
        self.assertEqual(record["samples"], count)
        self.assertEqual(record["source"], "simulation")
        self.assertEqual(record["missingRssiSamples"], 3400)
        self.assertEqual(record["qualityCounts"], {"LOW_RETURN": count})
        values, _, _ = read_raw(RecordingStore(self.root / "recordings"), record["id"], 0, count)
        np.testing.assert_allclose(values, 0.002, atol=1e-12)
        self.assertEqual(len(list((self.root / "sources").glob("*.csv.gz"))), 1)

    def test_stream_truncated_export_is_not_complete(self):
        source = self.root / ".upload-truncated-test"
        source.write_text("# BladeVMS " + json.dumps({"format": "blade-vms-csv-1", "samples": 1000, "sampleRate": 1000}) + "\ntime_s,velocity_m_s\n" + "".join(f"{i / 1000},0.02\n" for i in range(100)))
        with self.assertRaisesRegex(ValueError, "样本数"):
            dispatch(self.root, {"action": "import", "filename": "P1.csv", "inputFile": str(source)})
        self.assertTrue(all(record["status"] != "complete" for record in dispatch(self.root, {"action": "recordings"})["recordings"]))

    def test_requested_orders_cannot_exceed_source_nyquist(self):
        record = self.csv(rows=[f"{i / 1000},0.01,80,0" for i in range(1001)])
        with self.assertRaisesRegex(ValueError, "奈奎斯特"):
            dispatch(self.root, {"action": "rotation", "parameters": {"recordingIds": [record["id"]], "rpm": 1200, "maxOrder": 30}})


if __name__ == "__main__":
    unittest.main()
