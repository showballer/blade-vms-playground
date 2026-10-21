import csv
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from blade_acquisition.receiver import Batch
from blade_acquisition.service import Settings, create_app
from blade_acquisition.storage import atomic_json, recording_summary
from blade_acquisition.task_export import build_task_archive, prepare_task_export


class TaskExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = create_app(Settings("task-export-test-token", 8765, Path(self.temp.name)))
        self.store = self.app.state.controller.store
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": "Bearer task-export-test-token"})
        self.addCleanup(self.client.close)

    def record(self, blade="1", point="P1", lap=1, station=1, collection="a" * 32, error=None):
        writer = self.store.create({"name": "同名风机任务", "windFarm": "场1", "turbine": "机1", "object": "风机",
            "source": "polytec_ivs500", "point": point,
            "captureSessionId": "f" * 32,
            "pointCycle": {"mode": "automatic_stations", "collectionId": collection, "sessionId": writer_id(lap, station),
                "bladeId": blade, "radialPointId": point, "radialPointName": point,
                "radiusM": .31, "lapIndex": lap, "stationIndex": station, "azimuthDeg": (station - 1) * 90,
                "completion": "confirmed_pass" if not error else "missing_exit", "passWindow": {"startSample": 1, "endSample": 3}}})
        writer.ready(1000, 1700000000)
        writer.write(Batch(0, 1000, 1700000000, [1, 2, 3], [.001, .002, .003], [10, 20, 30], [40., 50., 60.], [False, True, False]))
        writer.finish(error)
        return writer.manifest

    def post(self, records, level="task"):
        return self.client.post("/api/field/recordings/export-task", json={"recordingIds": [r["id"] for r in records], "level": level})

    def test_task_zip_preserves_every_point_lap_waveform_and_telemetry(self):
        records = [self.record(), self.record(station=2), self.record(point="P2"), self.record(blade="2"), self.record(lap=2)]
        self.record(collection="b" * 32)  # Same display name, different task.
        telemetry = b'{"event":"arrival","axis1":3.2,"axis2":0.1}\n'
        (self.store.directory(records[0]["id"]) / "turntable.jsonl").write_bytes(telemetry)
        response = self.post(records)
        self.assertEqual(response.status_code, 200, response.text[:200] if response.status_code != 200 else "")
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertIsNone(archive.testzip())
            index = json.loads(archive.read("task.json"))
            self.assertEqual(index["recordCount"], 5)
            self.assertEqual(index["exportLevel"], "task")
            self.assertEqual({r["recordingId"] for r in index["records"]}, {r["id"] for r in records})
            self.assertEqual(len(list(csv.DictReader(io.StringIO(archive.read("任务清单.csv").decode("utf-8-sig"))))), 5)
            for entry in index["records"]:
                csv_lines = archive.read(entry["waveform"]).decode().splitlines()
                metadata = json.loads(csv_lines[0].removeprefix("# BladeVMS "))
                self.assertEqual(metadata["pointCycle"]["passWindow"], {"startSample": 1, "endSample": 3})
                self.assertEqual(len(csv_lines), 5)  # metadata, headings, all 3 samples
                rows = list(csv.DictReader(csv_lines[1:]))
                self.assertAlmostEqual(float(rows[2]["velocity_m_s"]), .003)
                self.assertEqual(rows[1]["overrange"], "1")
                self.assertEqual(entry["durationSeconds"], .003)
            first = next(r for r in index["records"] if r["recordingId"] == records[0]["id"])
            self.assertEqual(archive.read(first["telemetry"]), telemetry)

    def test_blade_and_point_exports_include_all_laps_and_retries_only_in_scope(self):
        p1 = [self.record(), self.record(lap=2), self.record(station=2), self.record()]
        blade = p1 + [self.record(point="P2")]
        other = self.record(blade="2")
        for level, records in (("point", p1), ("blade", blade)):
            response = self.post(records, level)
            self.assertEqual(response.status_code, 200)
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                index = json.loads(archive.read("task.json"))
                self.assertEqual(index["recordCount"], len(records))
                self.assertEqual(index["exportLevel"], level)
        self.assertEqual(self.post([p1[0]], "point").status_code, 409)
        self.assertEqual(self.post(blade, "point").status_code, 422)
        self.assertEqual(self.post(blade + [other], "blade").status_code, 422)

    def test_error_record_keeps_exact_raw_evidence_and_does_not_claim_valid_csv(self):
        record = self.record(error="回波离开未确认")
        original = (self.store.directory(record["id"]) / "chunk-00000000.bin").read_bytes()
        with build_task_archive(self.store, [record["id"]]) as output, zipfile.ZipFile(output) as archive:
            entry = json.loads(archive.read("task.json"))["records"][0]
            self.assertEqual(entry["status"], "error")
            self.assertIsNone(entry["waveform"])
            self.assertEqual(archive.read(entry["rawFiles"][0]), original)
            self.assertEqual(json.loads(archive.read(entry["manifest"]))["error"], record["error"])

    def test_empty_saved_record_is_included_without_invented_waveform(self):
        writer = self.store.create({"name": "未收到样本"})
        writer.finish(None)
        with build_task_archive(self.store, [writer.id]) as output, zipfile.ZipFile(output) as archive:
            entry = json.loads(archive.read("task.json"))["records"][0]
            self.assertEqual(entry["samples"], 0)
            self.assertEqual(entry["dataState"], "no_samples")
            self.assertIsNone(entry["waveform"])

    def test_rejects_mixed_scope_missing_records_and_bad_ids(self):
        first = self.record()
        second = self.record(collection="b" * 32)
        self.assertEqual(self.post([first, second]).status_code, 422)
        for ids in ([], ["../secret"], [first["id"], first["id"]], ["f" * 32]):
            response = self.client.post("/api/field/recordings/export-task", json={"recordingIds": ids, "level": "task"})
            self.assertIn(response.status_code, (404, 422))
        self.assertEqual(self.client.post("/api/field/recordings/export-task", json={"recordingIds": [first["id"]], "level": "all", "path": "/tmp/x"}).status_code, 422)

    def test_task_changed_since_list_fails_instead_of_silent_subset(self):
        first = self.record()
        self.record(point="P2")
        self.store.list = lambda: [first]  # A stale/truncated UI index is not authoritative.
        self.assertEqual(self.post([first]).status_code, 409)

    def test_active_capture_and_invalid_files_never_return_success_zip(self):
        record = self.record()
        controller = self.app.state.controller
        controller.state = "acquiring"
        self.assertEqual(self.post([record]).status_code, 409)
        controller.state = "idle"
        chunk = self.store.chunks(self.store.directory(record["id"]))[0]
        chunk.write_bytes(chunk.read_bytes()[:-1])
        self.assertEqual(self.post([record]).status_code, 422)

    def test_device_status_poll_does_not_block_saved_task_export(self):
        record = self.record()
        controller = self.app.state.controller
        controller.laser_poll_busy = True
        with controller.operation_lock:
            response = self.post([record])
            self.assertEqual(response.status_code, 200)
            self.assertTrue(controller.operation_lock.locked())
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(json.loads(archive.read("task.json"))["recordCount"], 1)
        self.assertFalse(controller.export_lock.locked())

    def test_overlapping_export_is_rejected_and_lock_is_released_on_failure(self):
        record = self.record()
        controller = self.app.state.controller
        with controller.export_lock:
            response = self.post([record])
            self.assertEqual(response.status_code, 409)
            self.assertIn("另一个数据包", response.text)
        self.assertEqual(self.post([{"id": "f" * 32}]).status_code, 404)
        self.assertFalse(controller.export_lock.locked())
        self.assertEqual(self.post([record]).status_code, 200)

    def test_capture_appending_to_task_during_export_cannot_publish_partial_zip(self):
        record = self.record()
        outputs = []

        def build_then_append(*args):
            output = build_task_archive(*args)
            outputs.append(output)
            self.record(point="P2")
            return output

        with patch("blade_acquisition.task_export.build_task_archive", side_effect=build_then_append):
            self.assertEqual(self.post([record]).status_code, 409)
        self.assertTrue(outputs[0].closed)
        self.assertFalse(self.app.state.controller.export_lock.locked())

    def test_task_metadata_is_excel_safe_and_archive_paths_cannot_escape(self):
        record = self.record(blade="../恶意\\路径", point="../../P1")
        record["name"] = "=1+1"
        atomic_json(self.store.directory(record["id"]) / "manifest.json", record)
        self.store.update_index(record)
        with build_task_archive(self.store, [record["id"]]) as output, zipfile.ZipFile(output) as archive:
            self.assertTrue(all(".." not in Path(name).parts and not name.startswith("/") for name in archive.namelist()))
            rows = list(csv.DictReader(io.StringIO(archive.read("任务清单.csv").decode("utf-8-sig"))))
            self.assertEqual(rows[0]["name"], "'=1+1")
        self.assertEqual(recording_summary(record)["captureSessionId"], "f" * 32)

    def test_telemetry_symlink_or_missing_declared_file_rejected(self):
        record = self.record()
        directory = self.store.directory(record["id"])
        outside = Path(self.temp.name) / "outside.jsonl"
        outside.write_text("private")
        (directory / "turntable.jsonl").symlink_to(outside)
        self.assertEqual(self.post([record]).status_code, 422)
        (directory / "turntable.jsonl").unlink()
        record["turntable"] = {"telemetry": {"file": "turntable.jsonl", "events": 1}}
        atomic_json(directory / "manifest.json", record)
        self.assertEqual(self.post([record]).status_code, 422)

    def test_plain_tasks_fall_back_to_unique_record_ids_and_need_auth(self):
        record = self.record()
        record.pop("pointCycle"); record.pop("captureSessionId")
        atomic_json(self.store.directory(record["id"]) / "manifest.json", record)
        self.store.update_index(record)
        self.assertEqual(prepare_task_export(self.store, [record["id"]])[0]["id"], record["id"])
        self.assertEqual(self.post([record], "blade").status_code, 422)
        self.client.headers.pop("Authorization")
        self.assertEqual(self.post([record]).status_code, 401)


def writer_id(lap, station):
    return f"{lap * 100 + station:032x}"


if __name__ == "__main__":
    unittest.main()
