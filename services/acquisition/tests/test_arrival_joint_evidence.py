from dataclasses import replace
import unittest

from blade_acquisition.rssi_handoff import RssiHandoff
from test_rssi_handoff import batch, config


class ArrivalJointEvidenceTests(unittest.TestCase):
    def detector(self, mode="arrival_guard"):
        return RssiHandoff(config(rssiExitSpread=4), 0, background_advisory=True,
                           require_fresh_entry=True, require_stable_entry_mean=True,
                           revalidate_entry_clear=True, entry_evidence_mode=mode)

    def signal(self, *, disturbed=True, clear=30, strong=False, duration=20):
        prefix = [10, 70] * 10 if disturbed else []
        rssi = prefix + [40] * clear + [10, 30] * (duration // 2) + [40] * 30
        velocity = ([.0004] * (len(prefix) + clear)
                    + ([.04] if strong else [.0004]) * duration + [.0004] * 30)
        return replace(batch(rssi), values=velocity)

    def test_risky_echo_jump_without_velocity_does_not_move(self):
        d = self.detector()
        d.feed(self.signal())
        self.assertIsNone(d.trigger)
        self.assertEqual(d.status['rssiArrivalEvidenceRejections'], 1)
        evidence = d.status['rssiEntryEvidence']
        self.assertTrue(evidence['echoSupported'])
        self.assertFalse(evidence['jointSupported'])
        events = d.drain_events()
        self.assertFalse(any(e['phase'] in ('blade_present', 'blade_left') for e in events))
        self.assertTrue(any(e['phase'] == 'arrival_evidence_rejected' for e in events))

    def test_strong_risky_pass_keeps_twenty_thirty_ms_and_indices(self):
        guarded, observed = self.detector(), self.detector('observe')
        for d in (guarded, observed):
            d.feed(self.signal(strong=True))
        for key in ('entrySampleIndex', 'entryConfirmedSampleIndex', 'exitConfirmedSampleIndex'):
            self.assertEqual(guarded.trigger[key], observed.trigger[key])
        self.assertEqual(guarded.trigger['entrySampleIndex'], 50)
        self.assertEqual(guarded.trigger['exitConfirmedSampleIndex'], 99)
        self.assertEqual(guarded.trigger['detectorVersion'], 8)
        self.assertTrue(guarded.trigger['entryEvidence']['arrivalCandidateGuarded'])

    def test_clean_or_later_weak_entry_not_globally_vetoed(self):
        for options in ({'disturbed': False}, {'clear': 50}):
            d = self.detector()
            d.feed(self.signal(**options))
            self.assertIsNotNone(d.trigger)
            self.assertFalse(d.trigger['entryEvidence']['arrivalCandidateGuarded'])

    def test_rejected_pulse_needs_new_clear_then_accepts_next_strong_entry(self):
        d = self.detector()
        first = self.signal(duration=60)
        d.feed(first)
        self.assertIsNone(d.trigger)
        self.assertEqual(d.status['rssiArrivalEvidenceRejections'], 1)
        follow = replace(batch([10, 30] * 10 + [40] * 30, start=len(first.values)),
                         values=[.04] * 20 + [.0004] * 30)
        d.feed(follow)
        self.assertEqual(d.trigger['entrySampleIndex'], len(first.values))
        self.assertEqual(d.trigger['arrivalEvidenceRejections'], 1)

    def test_invalid_or_overrange_velocity_cannot_authorize_risky_entry(self):
        for value in (float('nan'), float('inf'), True):
            d = self.detector()
            s = self.signal(strong=True)
            d.feed(replace(s, values=s.values[:50] + [value] * 20 + s.values[70:]))
            self.assertIsNone(d.trigger)
        d = self.detector()
        s = self.signal(strong=True)
        d.feed(replace(s, overrange=[False] * 50 + [True] * 20 + [False] * 30))
        self.assertIsNone(d.trigger)

    def test_batch_boundaries_and_sparse_rssi_preserve_risk_and_decision(self):
        for stride in (1, 2, 4):
            s = self.signal(strong=True)
            velocity = [v for v in s.values for _ in range(stride)]
            s = replace(s, sample_rate=1000 * stride, values=velocity,
                        velocity_raw=[0] * len(velocity), overrange=[False] * len(velocity),
                        rssi_sample_stride=stride)
            whole, split = self.detector(), self.detector()
            whole.feed(s)
            for start in range(0, len(s.rssi), 7):
                end = min(start + 7, len(s.rssi))
                split.feed(replace(s, sample_start=start * stride,
                    values=velocity[start * stride:end * stride], velocity_raw=[0] * ((end-start)*stride),
                    overrange=[False] * ((end-start)*stride), rssi=s.rssi[start:end], rssi_raw=s.rssi_raw[start:end]))
            self.assertEqual(whole.trigger, split.trigger)

    def test_gap_cannot_reuse_pre_gap_entry_evidence(self):
        d = self.detector()
        d.feed(replace(batch([40] * 30), values=[.000001] * 30))
        d.feed(replace(self.signal(disturbed=False), sample_start=100))
        self.assertIsNone(d.trigger)
        self.assertEqual(d.status['signalGapCount'], 1)


if __name__ == '__main__':
    unittest.main()
