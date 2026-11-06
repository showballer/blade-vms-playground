import unittest
from types import SimpleNamespace
import numpy as np
from blade_acquisition.record_analysis.reference.models import RealSegment
from blade_acquisition.record_analysis.displacement import displacement_amplitude, summarize_displacement


def result(point, angle, amp, fs=2000., seconds=2., offset=.0):
    t=np.arange(int(fs*seconds))/fs
    # velocity of a 20 Hz sinusoidal displacement, plus baseline drift
    real=RealSegment('record','pass','segment','source-hash',12,fs,t,amp*2*np.pi*20*np.cos(2*np.pi*20*t)+offset+.03*t,np.ones(len(t)))
    return SimpleNamespace(result_id=f'{point}-{angle}-{amp}',layer='velocity',basis='axial',
        parameters={'object':{'wind_farm':'farm','turbine':'t','blade':'1','point':point,'radius_from_hub_m':10 if point=='P1' else 30,'azimuth_deg':angle},'geometryComparisonKey':'same'},analysis_input=lambda:real)

class DisplacementTests(unittest.TestCase):
    def test_physical_integration_removes_baseline_and_recovers_amplitude(self):
        for fs in (1000.,4000.):
            r=result('P1',0,.0002,fs,2.,2.)
            value=displacement_amplitude(r.analysis_input(),(1.,400.))
            self.assertAlmostEqual(value['half_peak_to_peak_m'],.0002,delta=.000002)
            self.assertEqual(value['sourceRange'],[12,12+int(fs*2)])
            self.assertGreater(value['evaluatedRange'][0],12)
    def test_equal_capture_then_equal_angle_not_sample_weighted(self):
        rs=[result('P1',0,.0001),result('P1',0,.0003),result('P1',90,.0006),result('P2',0,.0008,1000.,1.)]
        v=summarize_displacement(rs,True);p=v['points'][0]
        self.assertAlmostEqual(p['mean_half_peak_to_peak_m'],.0004,delta=.000005)
        self.assertEqual(p['azimuth_count'],2)
        self.assertEqual(p['band_hz'],[1.,450.])
        self.assertFalse(v['absolute_displacement_available'])
    def test_indoor_uses_common_angles_and_no_missing_zero(self):
        rs=[result('P1',0,.0001),result('P1',90,.0006),result('P2',0,.0008)]
        v=summarize_displacement(rs,False)
        self.assertEqual(v['points'][0]['azimuth_count'],1)
        self.assertAlmostEqual(v['points'][0]['mean_half_peak_to_peak_m'],.0001,delta=.000002)
        self.assertEqual(summarize_displacement([],True)['points'],[])
