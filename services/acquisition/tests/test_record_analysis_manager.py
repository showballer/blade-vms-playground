"""Native API contracts and scientific data boundaries, using isolated local files."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid
import zipfile
from unittest.mock import patch
import numpy as np
from blade_acquisition.storage import HEADER,MAGIC,RECORD_DTYPE
from blade_acquisition.record_analysis.adapter import load_raw,source_fingerprint
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.record_analysis.reference.geometry import SignalError


def write_record(root, *, angle=0, radius=.2, point="P1", task="task-1", diagnostic=True, valid=True, n=4000, fs=4000., rssi_stride=1):
    rid=uuid.uuid4().hex;d=root/rid;d.mkdir(parents=True)
    clock=uuid.uuid4().hex
    manifest={"id":rid,"name":task,"windFarm":"wf-test","turbine":"T1","sampleRate":fs,"samples":n,
        "sampleOrigin":1234.,"startedAt":1234.,"endedAt":1234.+n/fs,"status":"complete","unit":"m/s","source":"polytec_ivs500",
        "diagnosticOnly":diagnostic,"validMeasurement":valid,"rssiSampleStride":rssi_stride,"rssiSampleRate":fs/rssi_stride,
        "pointCycle":{"collectionId":hashlib.md5(task.encode()).hexdigest(),"bladeId":"2","radialPointName":point,"radiusM":radius,"azimuthDeg":angle,
            "identityVerified":not diagnostic,"nominalPeriodSeconds":30.,"bladeLengthM":.8,"rootRadiusM":0,
            "continuousSession":{"id":clock,"sampleClock":"continuous_session_raw","sampleStart":500,"sampleEndExclusive":500+n},
            "handoff":{"sampleClock":"continuous_session_raw","entryConfirmedSampleIndex":500,"exitSampleIndex":500+n},
            "plannedStations":[{"bladeId":"2","radialPointName":point,"radiusM":radius,"azimuthDeg":a,"bladeLengthM":.8} for a in (0,90)]},
        "turntable":{"config":{"geometry":{"distanceM":2.5,"hubHeightDeltaM":.73},"speedRpm":5}}}
    (d/"manifest.json").write_text(json.dumps(manifest),encoding="utf-8")
    data=np.zeros(n,dtype=RECORD_DTYPE);data["index"]=np.arange(n);data["velocity"]=.002*np.sin(2*np.pi*50*np.arange(n)/fs)+.05
    data["rssi"][::rssi_stride]=40;data["flags"][::rssi_stride]=2
    (d/"chunk-00000000.bin").write_bytes(HEADER.pack(MAGIC,fs,1234.,0)+data.tobytes())
    return rid


def wait(manager,job):
    deadline=time.monotonic()+20
    while manager.status(job["jobId"])["status"] in ("queued","running"):
        if time.monotonic()>deadline:raise AssertionError("analysis timed out")
        time.sleep(.01)
    state=manager.status(job["jobId"])
    if state["status"]!="complete":raise AssertionError(state)
    return manager.result({"jobId":job["jobId"]})


class RecordAnalysisManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.data=Path(self.temp.name);self.raw=self.data/"recordings";self.raw.mkdir()
        self.ids=[write_record(self.raw,angle=a) for a in (0,90)]
        self.manager=RecordAnalysisManager(self.data)
        self.task=self.manager.catalog()["tasks"][0]
    def tearDown(self):self.manager.close();self.temp.cleanup()
    def start(self,**extra):return self.manager.start({"taskId":self.task["id"],"scope":"diagnostic",**extra})

    def test_snapshot_native_full_values_and_rssi_unknown_not_filled(self):
        rid=write_record(self.raw,task="sparse",rssi_stride=4)
        raw=load_raw(self.raw,rid)
        self.assertEqual(int(np.isfinite(raw.rssi_percent).sum()),1000)
        self.assertTrue(np.isnan(raw.rssi_percent[1]))
        self.assertEqual(raw.manifest["pointCycle"]["nominalPeriodSeconds"],30)
        self.assertAlmostEqual(raw.velocity_m_s.max(),.052)

    def test_native_gap_is_preserved_and_splits_continuous_segments(self):
        rid=self.ids[0];path=self.raw/rid/"chunk-00000000.bin";blob=path.read_bytes()
        samples=np.frombuffer(blob[HEADER.size:],dtype=RECORD_DTYPE).copy();samples["index"][2000:]+=1
        path.write_bytes(blob[:HEADER.size]+samples.tobytes())
        raw=load_raw(self.raw,rid);self.assertIn("SOURCE_SAMPLE_CLOCK_GAP",raw.parse_issues)
        job=self.start(recordingIds=[rid]);report=wait(self.manager,job)
        self.assertEqual(len(report["records"][0]["segments"]),2)
        self.assertEqual(report["aggregates"][0]["azimuth_results"][0]["pass_count"],1)

    def test_raw_hash_immutable_cache_restart_details_and_geometry(self):
        before=[source_fingerprint(self.raw,r) for r in self.ids]
        job=self.start();report=wait(self.manager,job)
        self.assertEqual(report["coverage"]["analyzableCount"],2)
        self.assertEqual(report["coverage"]["formalEligibleCount"],0)
        self.assertEqual(report["records"][0]["measurement_inputs"]["horizontal_distance_m"],2.5)
        self.assertIsNone(report["records"][0]["geometry"])
        self.assertEqual(report["aggregates"][0]["azimuth_count"],2)
        detail=self.manager.result({"jobId":job["jobId"],"recordingId":self.ids[0]})["detail"]
        self.assertLessEqual(len(detail["raw"]["time_s"]),2000)
        self.assertEqual(len(detail["raw"]["source_indices"]),len(detail["raw"]["time_s"]))
        self.assertAlmostEqual(detail["segments"][0]["features"]["half_peak_to_peak_m_s"],.002,delta=.00005)
        self.assertEqual(before,[source_fingerprint(self.raw,r) for r in self.ids])
        cached=self.start();self.assertTrue(cached["cacheHit"]);self.assertEqual(cached["jobId"],job["jobId"])
        self.manager.close();self.manager=RecordAnalysisManager(self.data)
        self.assertEqual(self.manager.result({"jobId":job["jobId"]})["aggregates"],report["aggregates"])

    def test_legacy_formal_now_uses_record_quality_without_promoting_source_flags(self):
        job=self.start(scope="formal");report=wait(self.manager,job)
        self.assertEqual(report["scope"],"analysis")
        self.assertEqual(len(report["aggregates"]),1);self.assertEqual(report["coverage"]["analyzableCount"],2)
        self.assertEqual(len(report["records"]),2)
        self.assertTrue(report["records"][0]["source_quality"]["diagnostic_only"])
        self.assertFalse(report["healthConclusionAvailable"])
        detail=self.manager.result({"jobId":job["jobId"],"recordingId":self.ids[0]})["detail"]
        self.assertIsNotNone(detail["raw"]);self.assertTrue(detail["segments"])

    def test_actual_motion_and_incomplete_pass_require_review_not_global_test_switch(self):
        def mark(rid, early, completeness):
            p=self.raw/rid/"manifest.json";m=json.loads(p.read_text())
            m.update(diagnosticOnly=True,validMeasurement=False)
            m["turntable"]["config"]["diagnosticDetectBeforeSettled"]=True
            m["pointCycle"]["diagnosticDetection"]={"enabled":True,"trigger":{"detectedBeforeStoppedArrival":early}}
            m["pointCycle"]["handoff"]["passCompleteness"]=completeness
            p.write_text(json.dumps(m));return p.read_bytes()
        source=mark(self.ids[0],False,"confirmed");mark(self.ids[1],True,"confirmed")
        result=wait(self.manager,self.start(scope="analysis"))
        rows={r["recording_id"]:r for r in result["records"]}
        self.assertTrue(rows[self.ids[0]]["quality_assessment"]["analysis_eligible"])
        self.assertFalse(rows[self.ids[1]]["quality_assessment"]["analysis_eligible"])
        self.assertIn("PASS_DURING_MOTION",rows[self.ids[1]]["quality_assessment"]["reason_codes"])
        self.assertEqual(result["coverage"]["analyzableCount"],1)
        self.assertEqual(result["coverage"]["reviewCount"],1)
        self.assertEqual(result["aggregates"][0]["azimuth_count"],1)
        self.assertEqual((self.raw/self.ids[0]/"manifest.json").read_bytes(),source)
        self.assertFalse(result["healthConclusionAvailable"])
        rejected=rows[self.ids[1]]["representative"]
        with self.assertRaisesRegex(SignalError,"REPRESENTATIVE_REQUIRED"):
            self.manager.extended({"jobId":result["jobId"],"kind":"point_band","resultIds":[rejected],"parameters":{"band_hz":[40,60]}})
        mark(self.ids[1],False,"partial")
        newer=wait(self.manager,self.start(scope="analysis"))
        self.assertNotEqual(newer["jobId"],result["jobId"])
        self.assertIn("PASS_INCOMPLETE",next(r for r in newer["records"] if r["recording_id"]==self.ids[1])["quality_assessment"]["reason_codes"])

    def test_unknown_stop_evidence_is_not_health_certification_and_boundary_stays_blocked(self):
        p=self.raw/self.ids[0]/"manifest.json";m=json.loads(p.read_text())
        m["pointCycle"]["handoff"]["entryConfirmedSampleIndex"]=300;p.write_text(json.dumps(m))
        result=wait(self.manager,self.start(scope="analysis"))
        rows={r["recording_id"]:r for r in result["records"]}
        self.assertFalse(rows[self.ids[0]]["quality_assessment"]["analysis_eligible"])
        self.assertIn("PASS_BOUNDARY_OUTSIDE_RECORDING",rows[self.ids[0]]["quality_assessment"]["reason_codes"])
        quality=rows[self.ids[1]]["quality_assessment"]
        self.assertTrue(quality["analysis_eligible"])
        self.assertEqual(quality["motion_state"],"unknown")
        self.assertFalse(quality["health_conclusion_eligible"])

    def test_boundary_not_clamped_raw_remains_available_review_is_new_version(self):
        p=self.raw/self.ids[0]/"manifest.json";m=json.loads(p.read_text());m["pointCycle"]["handoff"]["entryConfirmedSampleIndex"]=300;p.write_text(json.dumps(m))
        job=self.start();report=wait(self.manager,job);r=next(x for x in report["records"] if x["recording_id"]==self.ids[0])
        self.assertEqual(r["status"],"blocked");self.assertEqual(r["candidate_window"]["local_start"],-200)
        self.assertIn("PASS_BOUNDARY_OUTSIDE_RECORDING",r["issues"])
        revised=self.start(reviewWindows={self.ids[0]:{"start":0,"end":4000,"reason":"operator reviewed original signal"}})
        newer=wait(self.manager,revised);self.assertNotEqual(revised["jobId"],job["jobId"])
        self.assertEqual(newer["coverage"]["analyzableCount"],1)
        reviewed=next(r for r in newer["records"] if r["recording_id"]==self.ids[0])
        self.assertTrue(reviewed["representative"])
        self.assertIn("MANUAL_WINDOW_REVIEW",reviewed["quality_assessment"]["reason_codes"])
        self.assertEqual(json.loads(p.read_text())["pointCycle"]["handoff"]["entryConfirmedSampleIndex"],300)
        with self.assertRaisesRegex(SignalError,"REVIEW_IS_DIAGNOSTIC"):self.start(scope="formal",reviewWindows={self.ids[0]:{"start":0,"end":4000,"reason":"test"}})

    def test_scopes_and_bad_requests_cannot_cross_task_or_inject_synthetic(self):
        alien=write_record(self.raw,task="other")
        with self.assertRaisesRegex(SignalError,"TASK_SCOPE_MISMATCH"):self.start(recordingIds=[alien])
        with self.assertRaises(SignalError):load_raw(self.raw,"../secret")
        job=self.start();report=wait(self.manager,job)
        with self.assertRaisesRegex(SignalError,"SYNTHETIC_INPUT_FORBIDDEN"):
            self.manager.extended({"jobId":job["jobId"],"resultId":"synthetic_preview","kind":"stft","parameters":{"window_seconds":.1}})
        with self.assertRaisesRegex(SignalError,"INVALID_REQUEST"):self.manager.handle({"action":"extended","jobId":job["jobId"],"values":[0,1]})

    def test_real_extended_spectra_band_and_exports(self):
        job=self.start();report=wait(self.manager,job);rid=report["records"][0]["representative"]
        stft=self.manager.extended({"jobId":job["jobId"],"resultId":rid,"kind":"stft","parameters":{"window_seconds":.1}})
        self.assertTrue(stft["available"]);self.assertTrue(stft["data"]["source_segment_id"])
        kinetics=self.manager.extended({"jobId":job["jobId"],"resultId":rid,"kind":"kinematics","parameters":{"band_hz":[20,100],"edge_guard_seconds":.01}})
        self.assertTrue(kinetics["available"]);self.assertFalse(kinetics["data"]["absolute_displacement_available"])
        band=self.manager.extended({"jobId":job["jobId"],"resultIds":[r["representative"] for r in report["records"]],"kind":"point_band","parameters":{"band_hz":[40,60]}})
        self.assertTrue(band["available"]);self.assertAlmostEqual(band["points"][0]["mean_azimuth_band_rms_m_s"],.002/2**.5,delta=.00001)
        for kind in ("analysis","summary","raw"):
            output=self.manager.export({"jobId":job["jobId"],"kind":kind})
            self.assertEqual(Path(output["path"]).parent,(self.data/"record-analysis-v1"/job["jobId"]/"exports").resolve())
            with zipfile.ZipFile(output["path"]) as z:self.assertIsNone(z.testzip());self.assertIn("README.txt",z.namelist())

    def test_preview_explicit_configuration_does_not_change_features(self):
        job=self.start();report=wait(self.manager,job);ids=[r["representative"] for r in report["records"]]
        before=json.dumps(report["aggregates"],sort_keys=True)
        preview=self.manager.preview({"jobId":job["jobId"],"resultIds":ids,"expectedAzimuths":[0,90],
            "joinConfig":{"duration_seconds":.02,"context_seconds":.1,"cap_seconds":.004,"model_sample_rate_hz":2000,
                          "amplitude_guard_factor":20,"slope_guard_factor":20}})
        self.assertFalse(preview["analysis_eligible"])
        synth=[b for b in preview["series"] if b["kind"]=="synthetic_display_transition"]
        self.assertTrue(synth);self.assertIsNone(synth[0]["source_indices"])
        self.assertEqual(before,json.dumps(self.manager.result({"jobId":job["jobId"]})["aggregates"],sort_keys=True))
        output=self.manager.export({"jobId":job["jobId"],"kind":"preview","previewId":preview["previewId"]})
        self.assertIn("仅展示_含拟合",output["fileName"])

    def test_same_azimuth_repeat_not_formed_from_distinct_angles(self):
        job=self.start();report=wait(self.manager,job)
        self.assertEqual(report["chartAvailability"]["A12"]["status"],"blocked")
        write_record(self.raw,angle=0)
        report2=wait(self.manager,self.start())
        angle=next(a for a in report2["aggregates"][0]["azimuth_results"] if a["azimuth_deg"]==0)
        self.assertEqual(angle["pass_count"],2)
        self.assertEqual(angle["repeated_waveform"]["status"],"ready")
        self.assertEqual(angle["repeated_psd"]["status"],"ready")

    def test_preview_rejects_unbounded_generation_and_mixed_geometry(self):
        job=self.start();report=wait(self.manager,job)
        request={"jobId":job["jobId"],"resultIds":[r["representative"] for r in report["records"]],
            "expectedAzimuths":[0,90],"joinConfig":{"duration_seconds":1000,"context_seconds":.1,
            "cap_seconds":.004,"model_sample_rate_hz":2000}}
        with patch("blade_acquisition.record_analysis.manager.build_point_preview") as build:
            with self.assertRaisesRegex(SignalError,"ANALYSIS_SIZE_UNSUPPORTED"):self.manager.preview(request)
            build.assert_not_called()
        p=self.raw/self.ids[1]/"manifest.json";m=json.loads(p.read_text());m["turntable"]["config"]["geometry"]["distanceM"]=3;p.write_text(json.dumps(m))
        new_job=self.start();changed=wait(self.manager,new_job)
        request.update(jobId=new_job["jobId"],resultIds=[r["representative"] for r in changed["records"]])
        request["joinConfig"]["duration_seconds"]=.02
        with self.assertRaisesRegex(SignalError,"AGGREGATION_BASIS_MISMATCH"):self.manager.preview(request)

    def test_source_change_invalidates_cache(self):
        job=self.start();wait(self.manager,job)
        p=self.raw/self.ids[0]/"manifest.json";m=json.loads(p.read_text());m["turntable"]["config"]["geometry"]["distanceM"]=3;p.write_text(json.dumps(m))
        updated=self.start();wait(self.manager,updated)
        self.assertNotEqual(updated["jobId"],job["jobId"])

    def test_different_installations_are_separate_groups_even_same_point_profile(self):
        p=self.raw/self.ids[1]/"manifest.json";m=json.loads(p.read_text());m["turntable"]["config"]["geometry"]["distanceM"]=3;p.write_text(json.dumps(m))
        report=wait(self.manager,self.start())
        self.assertEqual(len(report["aggregates"]),2)
        self.assertEqual(len({g["geometryComparisonKey"] for g in report["aggregates"]}),2)
        self.assertTrue(all(g["azimuth_count"]==1 for g in report["aggregates"]))
        self.assertTrue(all(g["geometryComparisonKnown"] is False for g in report["aggregates"]))
        self.assertEqual(report["history"],[])

    def test_catalog_matches_legacy_session_and_object_task_namespace(self):
        session=uuid.uuid4().hex
        for rid in self.ids:
            p=self.raw/rid/"manifest.json";m=json.loads(p.read_text());m["pointCycle"].pop("collectionId")
            m["pointCycle"]["sessionId"]=session;m["object"]=" blade ";p.write_text(json.dumps(m))
        tasks=self.manager.catalog()["tasks"];self.assertEqual(len(tasks),1)
        expected=json.dumps(["session",session,json.dumps(["wf-test","T1","blade"],separators=(",",":"))],separators=(",",":"))
        self.assertEqual(tasks[0]["taskKey"],expected)
        p=self.raw/self.ids[0]/"manifest.json";m=json.loads(p.read_text());m["object"]="other blade";p.write_text(json.dumps(m))
        self.assertEqual(len(self.manager.catalog()["tasks"]),2)

    def test_cancel_and_restart_interrupts_only_derived_job(self):
        import threading
        gate=threading.Event();original=load_raw
        def slow(*args):gate.wait(2);return original(*args)
        with patch('blade_acquisition.record_analysis.manager.load_raw',side_effect=slow):
            job=self.start();self.manager.handle({"action":"cancel","jobId":job["jobId"]});gate.set()
            deadline=time.monotonic()+5
            while self.manager.status(job["jobId"])["status"] in ("running","queued") and time.monotonic()<deadline:time.sleep(.01)
            self.assertEqual(self.manager.status(job["jobId"])["status"],"cancelled")
        self.assertTrue(all((self.raw/r/"manifest.json").exists() for r in self.ids))

if __name__=='__main__':unittest.main()
