"""Complete-pass boundaries, including arrivals inside a blade, without I/O."""
import unittest

from blade_acquisition.rssi_handoff import RssiHandoff
from test_rssi_handoff import batch, blade_values, config


class CompletePassTests(unittest.TestCase):
    def detector(self):
        return RssiHandoff(config(), 0, require_background=True)

    def test_arrival_inside_pass_ignores_partial_then_accepts_next_full_pass(self):
        d = self.detector()
        d.feed(batch(blade_values(80) + [62] * 100))
        self.assertIsNone(d.trigger)
        self.assertTrue(d.status['rssiBackgroundReady'])
        self.assertEqual(d.status['rssiPartialPassesIgnored'], 1)
        d.feed(batch(blade_values(70) + [62] * 50, start=180))
        self.assertEqual(d.trigger['entrySampleIndex'], 180)
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'], 279)
        self.assertTrue(d.trigger['requireBackground'])
        self.assertLess(d.trigger['backgroundConfirmedSampleIndex'], 180)

    def test_only_partial_saved_data_cannot_be_relabelled_as_complete(self):
        d = self.detector()
        d.feed(batch(blade_values(80) + [62] * 100))
        self.assertIsNone(d.trigger)

    def test_stable_patch_on_blade_far_from_baseline_is_not_exit(self):
        d = self.detector()
        d.feed(batch([62] * 100 + blade_values(70) + [40] * 50))
        self.assertIsNone(d.trigger)
        self.assertTrue(d.armed)
        d.feed(batch([62] * 50, start=220))
        self.assertEqual(d.trigger['exitSampleIndex'], 220)
        self.assertEqual(d.trigger['baselineRssi'], 62)

    def test_changed_background_rejects_candidate_and_recovers_without_false_exit(self):
        d = self.detector()
        d.feed(batch([62] * 100 + blade_values(70) + [40] * 180))
        self.assertIsNone(d.trigger)
        self.assertEqual(d.status['rssiBaselineMismatches'], 1)
        d.feed(batch(blade_values(60) + [40] * 50, start=350))
        self.assertEqual(d.trigger['entrySampleIndex'], 350)

    def test_gap_resets_background_and_requires_a_new_complete_pass(self):
        d = self.detector()
        d.feed(batch([62] * 100 + blade_values(50)))
        d.feed(batch(blade_values(50) + [62] * 100, start=300))
        self.assertIsNone(d.trigger)
        self.assertEqual(d.status['signalGapCount'], 1)
        d.feed(batch(blade_values(50) + [62] * 50, start=450))
        self.assertEqual(d.trigger['entrySampleIndex'], 450)

    def test_baseline_and_boundaries_are_independent_of_rate_and_packet_splits(self):
        for rate in (1000, 250000):
            scale = rate // 1000
            values = [62] * (100*scale) + blade_values(70*scale) + [62] * (50*scale)
            d = self.detector()
            for start in range(0, len(values), 7*scale):
                d.feed(batch(values[start:start+7*scale], rate=rate, start=start))
            self.assertEqual(d.trigger['entrySampleIndex'], 100*scale)
            self.assertEqual(d.trigger['exitConfirmedSampleIndex'], 200*scale-1)

    def test_constant_echo_and_short_spike_do_not_trigger(self):
        d = self.detector()
        d.feed(batch([62]*100 + blade_values(10) + [62]*200))
        self.assertIsNone(d.trigger)


if __name__ == '__main__':
    unittest.main()
