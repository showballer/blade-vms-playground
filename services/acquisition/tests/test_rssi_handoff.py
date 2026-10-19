from dataclasses import replace
import unittest

from blade_acquisition.receiver import Batch
from blade_acquisition.rssi_handoff import RssiHandoff
from blade_acquisition.turntable import PointCycleConfig


def config(**extra):
    return PointCycleConfig(port="COM6", points=[{"port": "COM6", "referenceSignature": "[[0,3,10000,17],[0,3,10000,17]]", "name": "p", "axis1AngleDeg": 0, "axis2AngleDeg": 0}],
                            rssiTriggerEnabled=True, **extra)


def batch(values, rate=1000, start=0):
    return Batch(start, rate, 1700000000, [0] * len(values), [0.0] * len(values),
                 [0] * len(values), values, [False] * len(values))


def blade_values(count):
    return [40 if i % 2 else 65 for i in range(count)]


class RssiHandoffTests(unittest.TestCase):
    def test_entry_then_exit_confirmation_independent_of_rate_and_batch_boundaries(self):
        for rate in (1000, 250000):
            d = RssiHandoff(config(), 100)
            high = int(rate*.7)
            d.feed(batch([62]*high, rate))
            self.assertFalse(d.armed)
            d.feed(batch(blade_values(int(rate*.02)), rate, high))
            self.assertTrue(d.armed)
            self.assertIsNone(d.trigger)
            start=high+int(rate*.02)
            d.feed(batch([53]*int(rate*.013), rate, start))
            self.assertIsNone(d.trigger)
            d.feed(batch([53]*int(rate*.017), rate, start+int(rate*.013)))
            self.assertEqual(d.trigger['reason'], 'blade_left')
            self.assertEqual(d.trigger['confirmedMs'], 30)
            self.assertAlmostEqual(d.trigger['sampleElapsedSeconds'], .75)

    def test_static_backgrounds_and_slow_mean_fall_never_move(self):
        for background in (0, 53, 62, 100):
            d=RssiHandoff(config(),100)
            d.feed(batch([background]*2000))
            self.assertIsNone(d.trigger)
            self.assertEqual(d.status['rssiPhase'],'waiting_blade')
        d=RssiHandoff(config(),100)
        d.feed(batch([62]*700+[62-i*.05 for i in range(200)]+[53]*700))
        self.assertIsNone(d.trigger)

    def test_short_entry_spike_does_not_arm(self):
        d=RssiHandoff(config(),0)
        d.feed(batch([62]*100+blade_values(10)+[53]*300))
        self.assertFalse(d.armed)
        self.assertIsNone(d.trigger)

    def test_brief_stable_patch_inside_blade_does_not_move(self):
        d=RssiHandoff(config(),0)
        d.feed(batch(blade_values(50)+[53]*20+blade_values(50)))
        self.assertIsNone(d.trigger)
        self.assertEqual(d.status['rssiPhase'],'blade_present')
        d.feed(batch([53]*30,start=120))
        self.assertIsNotNone(d.trigger)

    def test_gap_missing_invalid_or_changed_rate_requires_new_entry(self):
        for kind in ('gap','missing','nan','range','bool','rate'):
            d=RssiHandoff(config(),0)
            d.feed(batch(blade_values(50)+[53]*20))
            self.assertTrue(d.armed)
            if kind=='gap': d.feed(batch([53]*100,start=100))
            elif kind=='missing': d.feed(replace(batch([53]*100,start=70),rssi=[]))
            elif kind=='rate': d.feed(batch([53]*100,rate=2000,start=70))
            else:
                bad={'nan':float('nan'),'range':101,'bool':True}[kind]
                d.feed(batch([bad]+[53]*99,start=70))
            self.assertIsNone(d.trigger,kind)
            self.assertFalse(d.armed,kind)
            self.assertIn('signal_reset',[e['phase'] for e in d.drain_events()])

    def test_trigger_latches_and_survives_same_batch_reentry(self):
        d=RssiHandoff(config(),0)
        d.feed(batch(blade_values(50)+[53]*40+blade_values(100)))
        first=d.trigger.copy()
        self.assertEqual(first['sampleIndex'],79)
        d.feed(batch(blade_values(100),start=190))
        self.assertEqual(first,d.trigger)

    def test_new_point_must_confirm_its_own_entry(self):
        first=RssiHandoff(config(),0)
        first.feed(batch(blade_values(50)+[53]*30))
        second=RssiHandoff(config(),0)
        second.feed(batch([62]*500))
        self.assertIsNotNone(first.trigger)
        self.assertIsNone(second.trigger)

    def test_transitions_include_short_confirmation_states_in_order(self):
        d=RssiHandoff(config(),0)
        d.feed(batch([62]*100+blade_values(50)+[53]*30))
        events=d.drain_events()
        self.assertEqual([e['phase'] for e in events],['confirming_entry','blade_present','confirming_exit','blade_left'])
        self.assertEqual([e['sampleIndex'] for e in events],[109,119,159,179])
        self.assertEqual(d.drain_events(),[])

    def test_window_split_across_small_batches_preserves_event_time(self):
        values=[62]*100+blade_values(50)+[53]*50
        d=RssiHandoff(config(),0)
        for start in range(0,len(values),7): d.feed(batch(values[start:start+7],start=start))
        self.assertEqual(d.trigger['sampleIndex'],179)

    def test_legacy_predictive_settings_cannot_bypass_entry_exit(self):
        d=RssiHandoff(config(rssiThresholdMode='absolute',rssiLeaveThresholdPercent=72,
                             rssiBaselineRatio=.99,rssiConfirmSamples=1),999)
        d.feed(batch([80]*700+[0]*300))
        self.assertIsNone(d.trigger)

    def test_explicit_minimum_window_does_not_arm_before_it(self):
        d=RssiHandoff(config(rssiMinimumSeconds=.5),0)
        d.feed(batch(blade_values(100)+[53]*600))
        self.assertIsNone(d.trigger)
        self.assertFalse(d.armed)

    def test_threshold_validation_rejects_inverted_and_nonfinite_parameters(self):
        for options in ({'rssiEnterSpread':3,'rssiExitSpread':3},
                        {'rssiEnterSpread':True},{'rssiExitSpread':float('nan')},
                        {'rssiEnterConfirmMs':0},{'rssiConfirmMs':float('inf')}):
            with self.assertRaises(ValueError): config(**options)


if __name__ == '__main__': unittest.main()
