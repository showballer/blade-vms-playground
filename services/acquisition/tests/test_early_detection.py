import unittest
from unittest.mock import patch
from blade_acquisition.early_detection import EarlyPointDetection
from test_rssi_handoff import config, batch, blade_values

class EarlyDetectionTests(unittest.TestCase):
    def probe(self):
        c=config(rssiExitSpread=4)
        return EarlyPointDetection(c,c.points[0],lambda:dict(sampleIndex=100))
    def pose(self,pitch=0,yaw=0):
        return {'axes':{'1':{'output_angle_deg':pitch,'fault':0},'2':{'output_angle_deg':yaw,'fault':0}}}
    def test_no_angle_gate_but_requires_new_samples(self):
        p=self.probe();p.observe(self.pose(25,-80));p.feed(batch(blade_values(20)+[50]*30,start=0))
        self.assertIsNone(p.detector.trigger)
        p.feed(batch(blade_values(20)+[50]*30,start=100))
        self.assertTrue(p.detector.trigger['detectedBeforeStoppedArrival'])
        self.assertEqual(p.detector.trigger['entrySampleIndex'],100)
        self.assertEqual(p.detector.trigger['exitConfirmedSampleIndex'],149)
    def test_entry_before_stop_and_exit_after_stop_keeps_same_pass(self):
        p=self.probe();p.observe(self.pose());p.feed(batch(blade_values(20),start=100))
        detector=p.detector;p.observe(self.pose(),stopped=True)
        self.assertIs(p.detector,detector)
        p.feed(batch([50]*30,start=120));self.assertIsNotNone(p.detector.trigger)
    def test_motion_outside_target_keeps_candidate(self):
        p=self.probe();p.observe(self.pose());p.feed(batch(blade_values(20),start=100))
        p.observe(self.pose(25,-80));p.feed(batch([50]*30,start=120))
        self.assertIsNotNone(p.detector.trigger)
        self.assertEqual(p.resets,0)
        self.assertFalse(p.evidence()["angleGateEnabled"])
    def test_stale_moving_feedback_does_not_enable_detection(self):
        p=self.probe();p.observe(self.pose())
        with patch('blade_acquisition.early_detection.time.time',return_value=p.feedback_at+1):
            p.feed(batch(blade_values(20)+[50]*30,start=100))
        self.assertFalse(p.active);self.assertIsNone(p.detector.trigger)
    def test_fault_does_not_arm(self):
        p=self.probe();pose=self.pose();pose['axes']['1']['fault']=2;p.observe(pose)
        self.assertFalse(p.active)
    def test_configured_angle_window_requires_both_axes_and_resets_outside(self):
        for limit in (.5, 1, 2, 3, 5, 10):
            with self.subTest(limit=limit):
                c=config(diagnosticAngleWindowDeg=limit)
                p=EarlyPointDetection(c,c.points[0],lambda:dict(sampleIndex=100))
                p.observe(self.pose(0,limit+.01));self.assertFalse(p.active)
                p.observe(self.pose(limit,-limit));self.assertTrue(p.active)
                p.feed(batch(blade_values(20),start=100))
                p.observe(self.pose(limit+.01,0));self.assertFalse(p.active)
                p.observe(self.pose());p.feed(batch([50]*30,start=120))
                self.assertIsNone(p.detector.trigger)
                self.assertEqual(p.evidence()['toleranceDeg'],limit)
    def test_invalid_angle_window_is_rejected(self):
        for value in (-1, 10.1, float('nan'), float('inf'), True, '1', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                config(diagnosticAngleWindowDeg=value)
