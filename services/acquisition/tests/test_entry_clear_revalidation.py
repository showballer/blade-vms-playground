import unittest
from blade_acquisition.rssi_handoff import RssiHandoff
from test_rssi_handoff import batch,blade_values,config

class EntryClearRevalidationTests(unittest.TestCase):
    def detector(self):
        return RssiHandoff(config(rssiExitSpread=4),0,background_advisory=True,
            require_fresh_entry=True,require_stable_entry_mean=True,revalidate_entry_clear=True)
    def test_clean_edge_no_extra_wait_even_with_zero_velocity(self):
        d=self.detector();d.feed(batch([50]*30+blade_values(20)+[20]*30))
        self.assertEqual(d.trigger['entrySampleIndex'],30)
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'],79)
        self.assertEqual(d.trigger['detectorVersion'],7)
        self.assertEqual(d.trigger['entryClearRevocations'],0)
    def test_post_clear_drift_revokes_old_qualification(self):
        d=self.detector();v=[50]*30+[48]*10+[45]*10+blade_values(20)+[20]*30
        d.feed(batch(v));self.assertIsNone(d.trigger)
        self.assertEqual(d.status['rssiEntryClearRevocations'],1)
        d.feed(batch(blade_values(20)+[20]*30,start=len(v)))
        self.assertEqual(d.trigger['entrySampleIndex'],len(v))
    def test_interrupted_candidate_requires_new_clear_edge(self):
        d=self.detector();v=[50]*30+blade_values(10)+[50]*10+blade_values(20)+[50]*30
        d.feed(batch(v));self.assertIsNone(d.trigger)
        self.assertEqual(d.status['rssiEntryClearRevocations'],1)
        d.feed(batch(blade_values(20)+[50]*30,start=len(v)))
        self.assertIsNotNone(d.trigger)
    def test_confirmed_pass_exit_unchanged(self):
        d=self.detector();d.feed(batch([50]*30+blade_values(20)+[50]*10+blade_values(10)+[30]*30))
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'],99)
        self.assertEqual(d.trigger['entryClearRevocations'],0)
    def test_fragmented_batches_same_result(self):
        v=[50]*30+[48]*10+[45]*10+blade_values(20)+[20]*30+blade_values(20)+[20]*30
        a=self.detector();b=self.detector();a.feed(batch(v))
        for i in range(0,len(v),7):b.feed(batch(v[i:i+7],start=i))
        self.assertEqual(a.trigger,b.trigger)
    def test_signal_gap_requires_new_quiet(self):
        d=self.detector();d.feed(batch([50]*30));d.feed(batch(blade_values(20)+[20]*30,start=100))
        self.assertIsNone(d.trigger)
        d.feed(batch(blade_values(20)+[20]*30,start=150));self.assertIsNotNone(d.trigger)

if __name__=='__main__':unittest.main()
