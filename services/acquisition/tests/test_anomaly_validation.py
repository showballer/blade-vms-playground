import hashlib
from pathlib import Path
import tempfile
import zipfile
import unittest
import numpy as np
from blade_acquisition.record_analysis.anomaly import inject_local_response, paired_response_screen
from blade_acquisition.record_analysis.reference.geometry import SignalError
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from test_record_analysis_manager import write_record, wait


class AnomalyTests(unittest.TestCase):
    def signal(self, n=8000, fs=4000.):
        t=np.arange(n)/fs
        return .001*np.sin(2*np.pi*80*t)+.0004*np.sin(2*np.pi*133*t)+.02

    def test_control_and_small_amplitude_change_do_not_trigger(self):
        a=self.signal()
        for b in (a.copy(),.02+(a-.02)*1.1):
            r=paired_response_screen(a,b,4000.)
            self.assertEqual(r['status'],'normal'); self.assertFalse(r['suspectedDamage'])

    def test_injected_local_response_is_detected_without_location_input(self):
        for n in (300,8000,40000):
            a=self.signal(n);before=a.copy();b,info=inject_local_response(a)
            result=paired_response_screen(a,b,4000.)
            self.assertTrue(result['suspectedDamage']);self.assertEqual(result['status'],'alarm')
            self.assertFalse(result['structuralDamageConfirmed'])
            np.testing.assert_array_equal(a,before)
            np.testing.assert_array_equal(b[:info['start_sample']],a[:info['start_sample']])
            np.testing.assert_array_equal(b[info['end_sample']:],a[info['end_sample']:])
            self.assertTrue(all(e['consecutive_windows']>=3 for e in result['events']))

    def test_isolated_impulse_does_not_satisfy_persistence(self):
        a=self.signal();b=a.copy();b[4000]+=10
        r=paired_response_screen(a,b,4000.)
        self.assertFalse(r['suspectedDamage']);self.assertEqual(r['status'],'normal')
        self.assertLess(r['maxConsecutiveWindows'],3)

    def test_absent_or_invalid_reference_is_not_a_healthy_conclusion(self):
        a=np.zeros(1000)
        self.assertEqual(paired_response_screen(a,a,1000.)['status'],'insufficient')
        with self.assertRaises(SignalError):inject_local_response(a)
        for b,fs in ((np.zeros(3),1000.),(np.full(1000,np.nan),1000.),(np.zeros(999),1000.),(a,0)):
            with self.assertRaises(SignalError):paired_response_screen(a,b,fs)

    def test_worker_saves_full_test_values_separately_and_leaves_sources_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);raw=root/'recordings';raw.mkdir()
            rid=write_record(raw,n=8000,fs=4000.,point='P3',diagnostic=False)
            manager=RecordAnalysisManager(root)
            try:
                task=manager.catalog()['tasks'][0]
                report=wait(manager,manager.start({'taskId':task['id'],'recordingIds':[rid],'workspace':{'purpose':'synthesis','algorithmOptions':{}}}))
                ids=[r['representative'] for r in report['records']]
                before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in raw.rglob('*') if p.is_file()}
                processed=manager._directory(report['jobId'])
                source_before={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in processed.glob('*.npz')}
                result=manager.extended({'jobId':report['jobId'],'kind':'defect_validation','resultIds':ids})
                self.assertTrue(result['test_only']);self.assertTrue(result['items'][0]['detection']['suspectedDamage'])
                self.assertEqual(result['items'][0]['control']['status'],'normal')
                with np.load(processed/'diagnostic-tests'/(result['artifactId']+'.npz')) as arrays:
                    self.assertEqual(len(arrays['test_0']),8000)
                    self.assertFalse(np.array_equal(arrays['test_0'],arrays['reference_0']))
                self.assertEqual(before,{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in raw.rglob('*') if p.is_file()})
                self.assertEqual(source_before,{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in processed.glob('*.npz')})
                export=manager.export({'jobId':report['jobId'],'kind':'analysis'})
                with zipfile.ZipFile(export['path']) as archive:self.assertFalse(any('diagnostic-tests' in name or result['artifactId'] in name for name in archive.namelist()))
                with self.assertRaises(SignalError):manager.extended({'jobId':report['jobId'],'kind':'defect_validation','resultIds':['fake']})
            finally:manager.close()

    def test_multiple_azimuth_anomalies_are_combined_without_duplicate_points(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);raw=root/'recordings';raw.mkdir()
            ids=[write_record(raw,n=8000,fs=4000.,point='P3',angle=a,diagnostic=False) for a in (0,90)]
            manager=RecordAnalysisManager(root)
            try:
                task=manager.catalog()['tasks'][0]
                report=wait(manager,manager.start({'taskId':task['id'],'recordingIds':ids,'workspace':{'purpose':'synthesis','algorithmOptions':{}}}))
                reps=[r['representative'] for r in report['records']]
                value=manager.extended({'jobId':report['jobId'],'kind':'defect_validation','resultIds':reps})
                outcomes=[i['detection']['suspectedDamage'] for i in value['items']]
                self.assertEqual(value['status'],'warning')
                self.assertEqual(outcomes,[True,True])
                self.assertEqual([i['object']['azimuth_deg'] for i in value['items']],[0,90])
            finally:manager.close()
