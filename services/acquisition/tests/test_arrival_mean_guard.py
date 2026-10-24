"""Only initial quiet qualification rejects inter-window echo drift."""
import unittest
from blade_acquisition.rssi_handoff import RssiHandoff
from test_rssi_handoff import batch, blade_values, config

class ArrivalMeanGuardTests(unittest.TestCase):
    def detector(self, **kw):
        return RssiHandoff(config(rssiExitSpread=4, **kw), 0, background_advisory=True,
                           require_fresh_entry=True, require_stable_entry_mean=True)

    def test_drifting_quiet_windows_cannot_arm_arrival(self):
        d = self.detector()
        initial = [10]*10 + [40]*10 + [70]*10 + blade_values(20) + [90]*30
        d.feed(batch(initial))
        self.assertIsNone(d.trigger)
        self.assertTrue(d.entry_edge_ready)
        self.assertEqual(d.status['rssiEntryDriftResets'], 2)
        d.feed(batch(blade_values(20)+[90]*30, start=len(initial)))
        self.assertEqual(d.trigger['entrySampleIndex'], 80)
        self.assertEqual(d.trigger['detectorVersion'], 5)
        self.assertEqual(d.trigger['entryClearConfirmedSampleIndex'], 79)

    def test_stable_arrival_and_changed_exit_mean_add_no_delay(self):
        d = self.detector()
        d.feed(batch([10]*30 + blade_values(20) + [90]*30))
        self.assertEqual(d.trigger['entrySampleIndex'], 30)
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'], 79)
        self.assertEqual(d.trigger['entryDriftResets'], 0)
        self.assertFalse(d.trigger['requireBackground'])

    def test_small_drift_and_threshold_boundary_are_allowed(self):
        d = self.detector()
        d.feed(batch([10]*10 + [12]*10 + [14]*10 + blade_values(20) + [60]*30))
        self.assertEqual(d.trigger['entrySampleIndex'], 30)

    def test_rolling_suffix_uses_existing_duration_not_new_sleep(self):
        d = self.detector()
        d.feed(batch([10]*10 + [30]*10 + [31]*10 + [32]*10 + blade_values(20) + [90]*30))
        self.assertEqual(d.trigger['entryClearConfirmedSampleIndex'], 39)
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'], 89)

    def test_gap_clears_quiet_mean_history_and_requires_new_edge(self):
        d = self.detector();d.feed(batch([10]*20))
        d.feed(batch([10]*10+blade_values(20)+[30]*30, start=100))
        self.assertIsNone(d.trigger)
        d.feed(batch(blade_values(20)+[60]*30, start=160))
        self.assertEqual(d.trigger['entrySampleIndex'], 160)
        self.assertEqual(d.trigger['entryClearConfirmedSampleIndex'], 159)

    def test_batch_boundaries_do_not_change_qualification(self):
        values = [10]*10+[30]*10+[31]*10+[32]*10+blade_values(20)+[90]*30
        whole = self.detector();whole.feed(batch(values))
        chunked = self.detector()
        for i in range(0,len(values),7):chunked.feed(batch(values[i:i+7],start=i))
        self.assertEqual(whole.trigger, chunked.trigger)

    def test_after_initial_qualification_mean_drift_is_not_a_new_gate(self):
        d = self.detector()
        d.feed(batch([10]*30+[30]*10+[60]*10+blade_values(20)+[90]*30))
        self.assertEqual(d.trigger['entryClearConfirmedSampleIndex'], 29)
        self.assertEqual(d.trigger['entrySampleIndex'], 50)
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'], 99)

    def test_mean_guard_stays_disabled_without_fresh_entry(self):
        d = RssiHandoff(config(rssiExitSpread=4),0,background_advisory=True,require_stable_entry_mean=True)
        d.feed(batch(blade_values(20)+[60]*30))
        self.assertEqual(d.trigger['detectorVersion'],3)
        self.assertFalse(d.trigger['requireStableEntryMean'])

if __name__ == '__main__':unittest.main()
