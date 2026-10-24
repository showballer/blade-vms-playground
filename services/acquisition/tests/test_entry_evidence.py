"""Candidate-only corroboration and passive production diagnostics."""
from dataclasses import replace
import unittest
from blade_acquisition.rssi_handoff import RssiHandoff
from test_rssi_handoff import batch, config

class EntryEvidenceTests(unittest.TestCase):
    def detector(self, mode='required'):
        return RssiHandoff(config(rssiExitSpread=4), 0, background_advisory=True,
                           require_fresh_entry=True, require_stable_entry_mean=True,
                           entry_evidence_mode=mode)

    def signal(self, contrast=False, velocity=False):
        rssi = [40.0]*30 + ([10,30]*10 if contrast else [34,46]*10) + [40.0]*30
        speeds = [.0004]*30 + ([.04]*20 if velocity else [.0004]*20) + [.0004]*30
        return replace(batch(rssi), values=speeds)

    def test_stationary_echo_spread_alone_is_not_corroborated(self):
        d=self.detector(); d.feed(self.signal())
        self.assertIsNone(d.trigger)
        self.assertEqual(d.status['rssiUnsupportedEntries'], 1)
        self.assertFalse(d.status['rssiEntryEvidence']['supported'])

    def test_echo_contrast_or_velocity_rise_keeps_original_twenty_thirty_ms(self):
        for contrast,velocity in ((True,False),(False,True),(True,True)):
            with self.subTest(contrast=contrast,velocity=velocity):
                d=self.detector(); d.feed(self.signal(contrast,velocity))
                self.assertEqual(d.trigger['entrySampleIndex'],30)
                self.assertEqual(d.trigger['exitConfirmedSampleIndex'],79)
                self.assertEqual(d.trigger['detectorVersion'],6)
                self.assertTrue(d.trigger['entryEvidence']['supported'])

    def test_observe_mode_never_vetoes_changes_or_delays_existing_decision(self):
        for signal in (self.signal(),self.signal(True),self.signal(False,True)):
            old=self.detector('off');new=self.detector('observe')
            old.feed(signal);new.feed(signal)
            for key in ('sampleIndex','entrySampleIndex','exitSampleIndex','detectorVersion'):
                self.assertEqual(old.trigger[key],new.trigger[key])
            self.assertEqual(old.drain_events(),new.drain_events())
        self.assertFalse(self.detector('observe').armed)

    def test_unsupported_entry_does_not_poison_next_real_entry(self):
        d=self.detector();d.feed(self.signal())
        d.feed(replace(self.signal(velocity=True),sample_start=80))
        self.assertEqual(d.trigger['entrySampleIndex'],110)
        self.assertEqual(d.trigger['unsupportedEntryCandidates'],1)

    def test_invalid_velocity_cannot_be_motion_evidence_but_echo_still_can(self):
        for bad in (float('nan'),float('inf'),True,1e200):
            for contrast in (False,True):
                d=self.detector();s=self.signal(contrast,True)
                s=replace(s,values=s.values[:30]+[bad]*20+s.values[50:]);d.feed(s)
                self.assertEqual(d.trigger is not None,contrast)
                if d.trigger:self.assertFalse(d.trigger['entryEvidence']['velocitySupported'])

    def test_batch_and_rssi_stride_alignment_preserves_decision_and_rms(self):
        for stride in (1,2,4):
            source=self.signal(velocity=True)
            velocities=[x for x in source.values for _ in range(stride)]
            s=replace(source,sample_rate=1000*stride,values=velocities,
                      velocity_raw=[0]*len(velocities),overrange=[False]*len(velocities),
                      rssi_sample_stride=stride)
            whole=self.detector();whole.feed(s)
            split=self.detector()
            for start in range(0,len(source.rssi),7):
                end=min(start+7,len(source.rssi))
                split.feed(replace(s,sample_start=start*stride,
                           values=velocities[start*stride:end*stride],velocity_raw=[0]*((end-start)*stride),
                           overrange=[False]*((end-start)*stride),rssi_raw=[0]*(end-start),rssi=source.rssi[start:end]))
            self.assertEqual(whole.trigger['sampleIndex'],split.trigger['sampleIndex'])
            for key in ('velocityPeakMps','quietVelocityP90Mps'):
                self.assertAlmostEqual(whole.trigger['entryEvidence'][key],split.trigger['entryEvidence'][key])

    def test_gap_resets_evidence_and_requires_new_quiet_interval(self):
        d=self.detector();d.feed(replace(batch([40]*30),values=[.00001]*30))
        s=self.signal();d.feed(replace(s,sample_start=100))
        self.assertIsNone(d.trigger)
        self.assertAlmostEqual(d.status['rssiEntryEvidence']['quietVelocityP90Mps'],.0004)

    def test_overrange_velocity_is_not_evidence(self):
        d=self.detector();s=self.signal(velocity=True)
        d.feed(replace(s,overrange=[False]*30+[True]*20+[False]*30))
        self.assertIsNone(d.trigger)
        self.assertFalse(d.status['rssiEntryEvidence']['velocitySupported'])

    def test_mode_is_explicit_and_required_needs_fresh_entry(self):
        with self.assertRaises(ValueError):self.detector('typo')
        with self.assertRaises(ValueError):RssiHandoff(config(),0,entry_evidence_mode='required')

if __name__=='__main__':unittest.main()
