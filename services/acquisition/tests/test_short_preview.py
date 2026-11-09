"""Sub-cycle display connectors never rewrite real observations or spectra."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

import numpy as np

from blade_acquisition.record_analysis.workspace import automatic_preview_plan
from blade_acquisition.record_analysis.reference.stitch import JoinConfig, join_arrays
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from test_record_analysis_manager import write_record, wait


def result(values, fs, key):
    return SimpleNamespace(result_id=key, segment=SimpleNamespace(sample_rate_hz=fs),
                           analysis_input=lambda: SimpleNamespace(values_m_s=values))


class ShortPreviewTests(unittest.TestCase):
    def test_length_tracks_cycles_not_record_duration_and_preserves_end_slopes(self):
        fs=250000.
        for frequency in (500., 2000., 14000.):
            with self.subTest(frequency=frequency):
                t=np.arange(120000)/fs
                left=.01*np.sin(2*np.pi*frequency*t)
                right=.012*np.sin(2*np.pi*frequency*t+.4)
                before=[left.copy(),right.copy()]
                plan=automatic_preview_plan([result(left,fs,'left'),result(right,fs,'right')])
                cfg=JoinConfig(**plan['config'])
                bridge,info=join_arrays(left,right,fs,cfg)
                self.assertLess((len(bridge)+1)/fs,1/frequency)
                self.assertLessEqual(len(bridge)+1,.75*plan['policy']['limitingPeriodSamples'])
                self.assertLess(len(bridge),120000*.02)
                self.assertAlmostEqual(bridge[0]-left[-1],left[-1]-left[-2],places=14)
                self.assertAlmostEqual(right[0]-bridge[-1],right[1]-right[0],places=14)
                self.assertLessEqual(info['amplitude_peak_m_s'],info['amplitude_limit_m_s'])
                self.assertLessEqual(info['max_slope_m_s2'],info['slope_limit_m_s2'])
                np.testing.assert_array_equal(left,before[0]);np.testing.assert_array_equal(right,before[1])

    def test_only_adjacent_contexts_set_the_shortest_period(self):
        fs=4000.;t=np.arange(16000)/fs
        a=np.sin(2*np.pi*30*t);b=np.sin(2*np.pi*200*t)
        # Outer, non-joining edges contain an unrelated high frequency.
        a[:8192]=np.sin(2*np.pi*1000*t[:8192])
        b[-8192:]=np.sin(2*np.pi*1000*t[-8192:])
        plan=automatic_preview_plan([result(a,fs,'a'),result(b,fs,'b')])
        evidence=plan['policy']['periodEvidence']
        self.assertEqual([(v['resultId'],v['side']) for v in evidence],[('a','tail'),('b','head')])
        self.assertAlmostEqual(plan['policy']['limitingPeriodSamples'],20,delta=.1)

    def test_unresolved_period_never_creates_a_long_bridge(self):
        plan=automatic_preview_plan([result(np.zeros(100000),4000.,'a'),result(np.zeros(100000),4000.,'b')])
        self.assertEqual(plan['policy']['periodStatus'],'unresolved_short_connector')
        self.assertEqual(round(plan['config']['duration_seconds']*4000),8)
        self.assertIsNone(plan['policy']['limitingPeriodSamples'])

    def test_manager_versions_preview_and_leaves_sources_and_spectra_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);records=root/'recordings';records.mkdir()
            ids=[write_record(records,angle=a,n=8000) for a in (0,90)]
            originals={str(p):p.read_bytes() for rid in ids for p in (records/rid).iterdir()}
            manager=RecordAnalysisManager(root)
            try:
                task=manager.catalog()['tasks'][0]
                report=wait(manager,manager.start({'taskId':task['id'],'recordingIds':ids,'scope':'diagnostic',
                    'workspace':{'purpose':'synthesis','algorithmOptions':{'measurementMode':'outdoor'}}}))
                segments=sorted(report['records'],key=lambda r:r['object']['azimuth_deg'])
                request={'jobId':report['jobId'],'resultIds':[r['representative'] for r in segments],
                         'expectedAzimuths':[0,90],'automatic':True}
                preview=manager.preview(request)
                self.assertEqual(preview['automaticPolicy']['version'],'subcycle-seam-1')
                self.assertEqual(preview['status'],'ready')
                self.assertLess((preview['joins'][0]['synthetic_samples']+1)/4000,1/50)
                self.assertEqual(manager.preview(request),preview)
                self.assertEqual(manager.result({'jobId':report['jobId']}),report)
                for path,content in originals.items():self.assertEqual(Path(path).read_bytes(),content)
            finally:manager.close()
