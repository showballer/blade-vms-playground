"""Arrival transients cannot provide the entry edge for an indexed handoff."""
import unittest
from blade_acquisition.rssi_handoff import RssiHandoff
from test_rssi_handoff import batch, blade_values, config

class FreshEntryTests(unittest.TestCase):
    def detector(self):
        return RssiHandoff(config(rssiExitSpread=4), 0, background_advisory=True, require_fresh_entry=True)

    def test_arrival_partial_and_short_quiet_patches_never_move(self):
        d=self.detector()
        values=blade_values(60)+[62]*20+blade_values(50)+[62]*30
        d.feed(batch(values));self.assertIsNone(d.trigger)
        self.assertTrue(d.status['rssiEntryEdgeReady'])
        self.assertFalse(d.armed)
        d.feed(batch(blade_values(20)+[62]*30,start=len(values)))
        self.assertEqual(d.trigger['entrySampleIndex'],len(values))
        self.assertEqual(d.trigger['detectorVersion'],4)

    def test_quiet_arrival_has_no_extra_delay_on_new_pass(self):
        d=self.detector();d.feed(batch([62]*30+blade_values(20)+[62]*30))
        self.assertEqual(d.trigger['entrySampleIndex'],30)
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'],79)
        # No 50ms stable-mean background is required to move.
        self.assertEqual(d.trigger['passCompleteness'],'unconfirmed')

    def test_background_mean_does_not_block_new_entry_or_exit(self):
        d=self.detector();d.feed(batch([10]*10+[40]*10+[70]*10+blade_values(20)+[90]*30))
        self.assertEqual(d.trigger['entrySampleIndex'],30)
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'],79)

    def test_gap_requires_fresh_clear_interval_again(self):
        d=self.detector();d.feed(batch([62]*30+blade_values(20)))
        d.feed(batch(blade_values(50)+[62]*30,start=100))
        self.assertIsNone(d.trigger)
        self.assertEqual(d.status['signalGapCount'],1)
        d.feed(batch(blade_values(20)+[62]*30,start=180))
        self.assertEqual(d.trigger['entrySampleIndex'],180)

    def test_confirm_intervals_and_single_trigger_are_preserved(self):
        d=self.detector();d.feed(batch([62]*30+blade_values(10)+[62]*30))
        self.assertIsNone(d.trigger)
        d.feed(batch(blade_values(20)+[62]*20,start=70));self.assertIsNone(d.trigger)
        d.feed(batch([62]*10,start=110));self.assertIsNotNone(d.trigger)
        before=d.trigger.copy();d.feed(batch(blade_values(60)+[62]*30,start=120))
        self.assertEqual(before,d.trigger)
