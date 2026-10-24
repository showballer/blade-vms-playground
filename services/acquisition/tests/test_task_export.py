import copy
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
from blade_acquisition.task_export import build_task_archive, prepare_task_export, segmented_coverage


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

    def segmented_record(self, station=1, when=1000, error=None):
        record = self.record(point="P3", station=station, error=error)
        plan = [{"pointId": f"P3-{index}", "bladeId": "1", "radialPointId": "P3", "radialPointName": "P3",
                 "radiusM": .31, "azimuthDeg": index * 60, "stationIndex": index + 1, "stationCount": 6,
                 "axis1AngleDeg": index / 10, "axis2AngleDeg": -index / 10} for index in range(6)]
        record.update(startedAt=when, endedAt=when + .003)
        record["pointCycle"].update(executionMode="manual_segments", coverageKind="manual_segment_passes",
            sessionId=record["id"], cycles=1, lapIndex=1, pointId=f"P3-{station - 1}", stationCount=6,
            azimuthDeg=(station - 1) * 60, segmentStepDeg=60, totalStationCount=6,
            segmentStationIds=[f"P3-{station - 1}"], plannedStations=plan,
            recordedPort="COM3", referenceSignature="same-reference",
            targetAxis1AngleDeg=(station - 1) / 10, targetAxis2AngleDeg=-(station - 1) / 10)
        atomic_json(self.store.directory(record["id"]) / "manifest.json", record)
        self.store.update_index(record)
        return record

    def post(self, records, level="task"):
        return self.client.post("/api/field/recordings/export-task", json={"recordingIds": [r["id"] for r in records], "level": level})

    def test_segmented_task_accumulates_latest_positions_and_keeps_all_retries(self):
        failed = self.segmented_record(1, when=900, error="回波离开未确认")
        records = [failed] + [self.segmented_record(index, when=1000 + index) for index in range(1, 7)]
        with build_task_archive(self.store, [record["id"] for record in records]) as output, zipfile.ZipFile(output) as archive:
            index = json.loads(archive.read("task.json"))
            self.assertEqual(index["recordCount"], 7)
            self.assertEqual(index["unassignedSegmentedRecordingIds"], [])
            group, = index["segmentedCoverage"]
            self.assertEqual((group["observedCount"], group["plannedCount"], group["recordCount"]), (6, 6, 7))
            self.assertTrue(group["complete"])
            self.assertFalse(group["continuousMeasurement"])
            self.assertEqual(len(group["sessionIds"]), 7)
            self.assertEqual(group["stations"][0]["recordingIds"], [records[1]["id"], failed["id"]])
            self.assertEqual(group["stations"][0]["latestRecordingId"], records[1]["id"])
            self.assertTrue(all("/分段采集/" in entry["manifest"] and "/轮次_1/" not in entry["manifest"] for entry in index["records"]))
            failed_entry = next(entry for entry in index["records"] if entry["recordingId"] == failed["id"])
            self.assertIsNone(failed_entry["waveform"])
            self.assertTrue(failed_entry["rawFiles"])
            rows = list(csv.DictReader(io.StringIO(archive.read("分段点位汇总.csv").decode("utf-8-sig"))))
            self.assertEqual(len(rows), 6)
            self.assertEqual([float(row["azimuthDeg"]) for row in rows], [0, 60, 120, 180, 240, 300])
            self.assertTrue(all(row["state"] == "observed" for row in rows))

    def test_segmented_diagnostic_coverage_exports_without_claiming_normal_measurement(self):
        records = [self.segmented_record(index, when=1000 + index) for index in range(1, 7)]
        for record in records:
            record["pointCycle"].update(completion="diagnostic_pass", passCompleteness="confirmed")
            record.update(diagnosticOnly=True, validMeasurement=False)
            atomic_json(self.store.directory(record["id"]) / "manifest.json", record)
            self.store.update_index(record)
        before = copy.deepcopy(records)
        with build_task_archive(self.store, [record["id"] for record in records]) as output, zipfile.ZipFile(output) as archive:
            group, = json.loads(archive.read("task.json"))["segmentedCoverage"]
            self.assertEqual((group["diagnosticCount"], group["observedCount"], group["coveredCount"]), (6, 0, 6))
            self.assertTrue(group["coverageComplete"])
            self.assertFalse(group["complete"])
            rows = list(csv.DictReader(io.StringIO(archive.read("分段点位汇总.csv").decode("utf-8-sig"))))
            self.assertTrue(all(row["state"] == "diagnostic_pass" and row["coverageComplete"] == "True" and row["complete"] == "False" for row in rows))
            entries = json.loads(archive.read("task.json"))["records"]
            for entry in entries:
                manifest = json.loads(archive.read(entry["manifest"]))
                self.assertTrue(manifest["diagnosticOnly"])
                self.assertFalse(manifest["validMeasurement"])
        self.assertEqual(records, before)
        self.assertFalse(segmented_coverage(records[:-1])[0][0]["coverageComplete"])
        records[0]["pointCycle"]["completion"] = "confirmed_pass"
        mixed = segmented_coverage(records)[0][0]
        self.assertTrue(mixed["coverageComplete"])
        self.assertFalse(mixed["complete"])
        self.assertEqual((mixed["observedCount"], mixed["diagnosticCount"]), (1, 5))
        retry = self.segmented_record(6, when=2000, error="未确认离开")
        self.assertFalse(segmented_coverage([*records, retry])[0][0]["coverageComplete"])

    def test_diagnostic_test_coverage_requires_confirmed_nonempty_real_record(self):
        records = [self.segmented_record(index) for index in range(1, 7)]
        for record in records:
            record["pointCycle"].update(completion="diagnostic_pass", passCompleteness="confirmed")
        mutations = [lambda item: item.update(samples=0), lambda item: item.update(source="simulation"),
                     lambda item: item.update(status="error"), lambda item: item.update(error="写盘失败"),
                     lambda item: item["pointCycle"].update(passCompleteness="unconfirmed"),
                     lambda item: item["pointCycle"].pop("passCompleteness"),
                     lambda item: item["pointCycle"].update(completion="missing_exit")]
        for mutate in mutations:
            changed = copy.deepcopy(records)
            mutate(changed[-1])
            group = segmented_coverage(changed)[0][0]
            self.assertEqual(group["diagnosticCount"], 5)
            self.assertFalse(group["coverageComplete"])

    def test_segmented_duplicate_cannot_fill_missing_station_and_latest_failure_wins(self):
        records = [self.segmented_record(index, when=1000 + index) for index in range(1, 6)]
        records.append(self.segmented_record(1, when=1010))
        groups, excluded = segmented_coverage(records)
        self.assertEqual(excluded, [])
        self.assertEqual((groups[0]["observedCount"], groups[0]["pendingCount"]), (5, 1))
        self.assertFalse(groups[0]["complete"])
        records.append(self.segmented_record(6, when=1020))
        self.assertTrue(segmented_coverage(records)[0][0]["complete"])
        records.append(self.segmented_record(2, when=1030, error="未完整经过"))
        group = segmented_coverage(records)[0][0]
        self.assertEqual(group["observedCount"], 5)
        self.assertEqual(group["stations"][1]["state"], "missing_exit")
        self.assertFalse(group["complete"])

    def test_segmented_geometry_reference_and_task_scope_never_mix(self):
        original = [self.segmented_record(index) for index in range(1, 7)]
        mutations = [lambda item: item["pointCycle"].update(referenceSignature="other"),
                     lambda item: item["pointCycle"].update(recordedPort="COM4"),
                     lambda item: item["pointCycle"]["plannedStations"][0].update(axis1AngleDeg=5),
                     lambda item: item.update(turbine="另一台风机")]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                records = copy.deepcopy(original)
                mutate(records[-1])
                groups, excluded = segmented_coverage(records)
                self.assertEqual(excluded, [])
                self.assertEqual(len(groups), 2)
                self.assertFalse(any(group["complete"] for group in groups))

    def test_segmented_incomplete_or_inconsistent_plan_cannot_claim_coverage(self):
        original = self.segmented_record()
        mutations = [lambda item: item["pointCycle"].pop("plannedStations"),
                     lambda item: item["pointCycle"]["plannedStations"].pop(),
                     lambda item: item["pointCycle"]["plannedStations"][1].update(stationIndex=1),
                     lambda item: item["pointCycle"].update(segmentStepDeg=90),
                     lambda item: item["pointCycle"].update(totalStationCount=18, segmentStepDeg=20),
                     lambda item: item["pointCycle"].pop("sessionId"),
                     lambda item: item["pointCycle"].pop("targetAxis1AngleDeg"),
                     lambda item: item["pointCycle"].update(targetAxis2AngleDeg=99),
                     lambda item: item["pointCycle"].update(segmentStationIds=["P3-0", "P3-0"]),
                     lambda item: item["pointCycle"].update(segmentStationIds=["P3-1"]),
                     lambda item: item["pointCycle"].update(segmentStationIds=["P3-0", "unknown"]),
                     lambda item: item["pointCycle"].update(cycles=2)]
        for mutate in mutations:
            record = copy.deepcopy(original)
            mutate(record)
            self.assertEqual(segmented_coverage([record]), ([], [record["id"]]))

    def test_segmented_same_session_conflict_does_not_hide_in_separate_groups(self):
        first = self.segmented_record(1)
        second = self.segmented_record(2)
        second["pointCycle"]["sessionId"] = first["pointCycle"]["sessionId"]
        second["pointCycle"]["referenceSignature"] = "changed-in-session"
        groups, excluded = segmented_coverage([first, second])
        self.assertEqual(len(groups), 2)
        self.assertEqual(excluded, [])
        self.assertTrue(all(group["planConflict"] and not group["complete"] for group in groups))
        second["pointCycle"].pop("targetAxis1AngleDeg")
        groups, excluded = segmented_coverage([first, second])
        self.assertEqual(excluded, [second["id"]])
        self.assertTrue(groups[0]["planConflict"])

    def test_segmented_labels_numeric_encoding_and_plan_order_do_not_split_geometry(self):
        first = self.segmented_record(1)
        second = self.segmented_record(2)
        second["pointCycle"]["radialPointName"] = "修改名称"
        for item in second["pointCycle"]["plannedStations"]:
            item["radialPointName"] = "修改名称"
            item["azimuthDeg"] = float(item["azimuthDeg"])
        second["pointCycle"]["plannedStations"].reverse()
        groups, excluded = segmented_coverage([first, second])
        self.assertEqual(excluded, [])
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["observedCount"], 2)

    def test_segmented_requires_real_nonempty_confirmed_record_and_preserves_reference_summary(self):
        first = self.segmented_record(1)
        second = self.segmented_record(2)
        first["simulation"] = {"kind": "test"}
        second["samples"] = 0
        groups, excluded = segmented_coverage([first, second, self.record()])
        self.assertEqual(excluded, [])
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["observedCount"], 0)
        summary = recording_summary(first)["pointCycle"]
        self.assertEqual(summary["recordedPort"], "COM3")
        self.assertEqual(summary["referenceSignature"], "same-reference")

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
            self.assertEqual(index["segmentedCoverage"], [])
            self.assertNotIn("分段点位汇总.csv", archive.namelist())
            self.assertTrue(all("/轮次_" in entry["manifest"] for entry in index["records"]))
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
