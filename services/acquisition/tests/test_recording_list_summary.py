"""Large local lists must not copy motion diagnostics into every UI response."""
from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from blade_acquisition.service import Settings, create_app
from blade_acquisition.storage import recording_list_page, recording_summary, normalize_recording_metadata


def recording(index=0):
    return {
        "id": f"{index:032x}", "name": "风机测量", "source": "polytec_ivs500",
        "windFarm": "F1", "turbine": "T1", "object": "风机", "point": "P4",
        "status": "complete", "startedAt": 1700000000 + index, "endedAt": 1700000001 + index,
        "samples": 1000, "sampleRate": 1000, "unit": "m/s",
        "pointCycle": {
            "mode": "automatic_stations", "collectionId": "a" * 32, "sessionId": "b" * 32,
            "bladeId": "叶片2", "radialPointId": "P4", "radialPointName": "P4",
            "pointId": "station-1", "pointName": "点位1", "radiusM": .5655,
            "lapIndex": 1, "cycles": 1, "cycle": 1, "pointIndex": 0,
            "azimuthDeg": 0, "stationIndex": 1, "stationCount": 1,
            "targetAxis1AngleDeg": 4.92, "targetAxis2AngleDeg": 0,
            "completion": "confirmed_pass", "identityVerified": False,
            "plannedStations": [{
                "pointId": "station-1", "bladeId": "叶片2", "radialPointId": "P4",
                "radialPointName": "P4", "radiusM": .5655, "azimuthDeg": 0,
                "stationIndex": 1, "stationCount": 1,
            }],
            "arrivalMove": {"referenceChecks": ["preserve full evidence"] * 1000},
            "processEvents": [{"phase": "moving", "at": index}] * 100,
        },
        "turntable": {"lastMove": {"referenceChecks": ["preserve full evidence"] * 1000}},
        "deviceSettings": {"fields": {"laser": {"value": 1, "supported": True}}},
    }


class RecordingListSummaryTests(unittest.TestCase):
    def test_legacy_early_summary_recovers_only_confirmed_existing_evidence(self):
        full = recording()
        full.update(diagnosticOnly=True, validMeasurement=False)
        evidence = {"passCompleteness": "confirmed", "completenessReason": "background_and_entry_exit",
                    "sampleClock": "continuous_session_raw"}
        full["pointCycle"].update(completion="diagnostic_pass", recordPreparation="deferred_from_continuous_raw",
                                  handoff=copy.deepcopy(evidence),
                                  diagnosticDetection={"enabled": True, "trigger": copy.deepcopy(evidence)})
        original = copy.deepcopy(full)
        clean = normalize_recording_metadata(full)
        self.assertEqual(clean["pointCycle"]["passCompleteness"], "confirmed")
        self.assertEqual(recording_summary(full)["pointCycle"]["passCompleteness"], "confirmed")
        self.assertEqual(recording_summary(full)["pointCycle"]["completenessReason"], evidence["completenessReason"])
        self.assertEqual(clean["pointCycle"]["completion"], "diagnostic_pass")
        self.assertTrue(clean["diagnosticOnly"])
        self.assertFalse(clean["validMeasurement"])
        self.assertEqual(normalize_recording_metadata(clean), clean)
        self.assertEqual(full, original)
        mutations = [
            lambda m: m["pointCycle"].update(passCompleteness="unconfirmed"),
            lambda m: m["pointCycle"].update(passCompleteness=None),
            lambda m: m["pointCycle"].update(completion="unconfirmed_pass"),
            lambda m: m["pointCycle"].pop("recordPreparation"),
            lambda m: m["pointCycle"].pop("handoff"),
            lambda m: m["pointCycle"]["diagnosticDetection"].pop("trigger"),
            lambda m: m["pointCycle"]["diagnosticDetection"].update(enabled=False),
            lambda m: m["pointCycle"]["diagnosticDetection"]["trigger"].update(passCompleteness="unconfirmed"),
            lambda m: m["pointCycle"]["handoff"].update(completenessReason="different_evidence"),
            lambda m: m["pointCycle"]["handoff"].update(sampleClock="station"),
            lambda m: m.update(validMeasurement=True),
            lambda m: m.pop("diagnosticOnly"),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(full)
            mutate(changed)
            with self.subTest(mutation=mutations.index(mutate)):
                self.assertEqual(normalize_recording_metadata(changed), changed)

    def test_summary_preserves_grouping_and_observation_without_mutating_evidence(self):
        full = recording()
        original = copy.deepcopy(full)
        summary = recording_summary(full)
        self.assertEqual(summary["pointCycle"]["plannedStations"], full["pointCycle"]["plannedStations"])
        self.assertEqual(summary["pointCycle"]["completion"], "confirmed_pass")
        self.assertIs(summary["pointCycle"]["identityVerified"], False)
        self.assertEqual(summary["samples"], 1000)
        self.assertEqual(summary["startedAt"], full["startedAt"])
        self.assertEqual(summary["endedAt"], full["endedAt"])
        self.assertNotIn("arrivalMove", summary["pointCycle"])
        self.assertNotIn("processEvents", summary["pointCycle"])
        self.assertNotIn("turntable", summary)
        summary["pointCycle"]["plannedStations"][0]["radiusM"] = 999
        self.assertEqual(full, original)

    def test_imported_blade_metadata_and_simulation_are_not_misclassified(self):
        full = recording()
        full["sourceMetadata"] = {"pointCycle": full.pop("pointCycle"), "diagnostic": "not for list"}
        full["simulation"] = {"position": .7, "rpm": 12}
        summary = recording_summary(full)
        self.assertEqual(summary["sourceMetadata"]["pointCycle"]["mode"], "automatic_stations")
        self.assertEqual(summary["simulation"], full["simulation"])
        self.assertNotIn("diagnostic", summary["sourceMetadata"])

    def test_many_records_are_paged_without_loss_and_each_response_is_bounded(self):
        records = [recording(i) for i in range(205)]
        self.assertGreater(len(json.dumps(records)), 2_000_000)
        collected = []
        offset = 0
        while True:
            page = recording_list_page(records, offset, max_bytes=4000)
            self.assertLess(len(json.dumps(page, ensure_ascii=False).encode("utf-8")), 4500)
            collected.extend(page["recordings"])
            if page["nextOffset"] is None:
                break
            self.assertGreater(page["nextOffset"], offset)
            offset = page["nextOffset"]
        self.assertEqual([item["id"] for item in collected], [item["id"] for item in records])
        self.assertEqual(recording_list_page(records)["nextOffset"], 100)

    def test_single_oversized_plan_fails_without_silently_dropping_it(self):
        with self.assertRaisesRegex(ValueError, "单条记录"):
            recording_list_page([recording()], max_bytes=200)

    def test_http_summary_is_opt_in_and_detail_keeps_full_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(Settings("test-recording-list-token", 8765, Path(directory)))
            controller = app.state.controller
            writer = controller.store.create(recording())
            writer.finish(None)
            full = copy.deepcopy(writer.manifest)
            controller.writer = writer
            with TestClient(app, base_url="http://127.0.0.1:8765",
                            headers={"Authorization": "Bearer test-recording-list-token"}) as client:
                listed = client.get("/api/field/recordings?summary=true").json()
                self.assertEqual(len(listed["recordings"]), 1)
                self.assertEqual(listed["recordings"][0], recording_summary(full))
                self.assertIsNone(listed["nextOffset"])
                complete = client.get("/api/field/recordings").json()
                self.assertEqual(complete["recordings"][0], full)
                detail = client.get(f"/api/field/recordings/{writer.id}").json()
                self.assertEqual(detail["recording"], full)
                self.assertEqual(controller.store.list()[0], full)


if __name__ == "__main__":
    unittest.main()
