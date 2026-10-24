"""Background quality never blocks a stationary enter/exit handoff."""
import unittest
from blade_acquisition.rssi_handoff import RssiHandoff
from blade_acquisition.blade_passes import _range
from test_rssi_handoff import batch, blade_values, config

class AdvisoryBackgroundTests(unittest.TestCase):
    def detector(self):
        return RssiHandoff(config(rssiExitSpread=4), 0, background_advisory=True)

    def test_arrival_inside_pass_triggers_and_marks_unconfirmed(self):
        d=self.detector(); d.feed(batch(blade_values(60)+[62]*80))
        self.assertEqual(d.trigger['entrySampleIndex'],0)
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'],89)
        self.assertEqual(d.trigger['passCompleteness'],'unconfirmed')
        self.assertEqual(d.trigger['completenessReason'],'missing_initial_background')
        self.assertFalse(any(e['phase']=='waiting_background' for e in d.drain_events()))
        self.assertIsNone(_range(dict(completion='unconfirmed_pass',outcome='incomplete',handoff=d.trigger),140)[0])

    def test_observed_background_is_quality_evidence_without_extra_delay(self):
        d=self.detector();d.feed(batch([62]*80+blade_values(60)+[62]*80))
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'],169)
        self.assertEqual(d.trigger['passCompleteness'],'confirmed')
        self.assertEqual(d.trigger['baselineRssi'],62)

    def test_changed_exit_background_triggers_but_is_not_complete(self):
        d=self.detector();d.feed(batch([62]*80+blade_values(60)+[40]*80))
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'],169)
        self.assertEqual(d.trigger['completenessReason'],'exit_baseline_mismatch')

    def test_gap_and_short_pulses_never_fake_a_full_pass(self):
        d=self.detector();d.feed(batch([62]*80+blade_values(10)+[62]*80))
        self.assertIsNone(d.trigger)
        d.feed(batch(blade_values(20),start=200))
        self.assertEqual(d.status['signalGapCount'],1)
        self.assertIsNone(d.trigger)
        d.feed(batch([62]*20,start=220));self.assertIsNone(d.trigger)
        d.feed(batch([62]*10,start=240));self.assertIsNotNone(d.trigger)
        self.assertEqual(d.trigger['passCompleteness'],'unconfirmed')
        trigger=d.trigger.copy();d.feed(batch(blade_values(60)+[62]*30,start=250))
        self.assertEqual(d.trigger,trigger)

    def test_last_exit_window_alone_cannot_confirm_background_quality(self):
        d=self.detector();d.feed(batch([62]*80+blade_values(60)+[40]*20+[62]*10))
        self.assertEqual(d.trigger['exitConfirmedSampleIndex'],169)
        self.assertEqual(d.trigger['passCompleteness'],'unconfirmed')
        self.assertEqual(d.trigger['completenessReason'],'exit_baseline_mismatch')

    def test_quality_survives_record_list_summary(self):
        from blade_acquisition.storage import recording_summary
        cycle=dict(completion='unconfirmed_pass',passCompleteness='unconfirmed',
                   completenessReason='missing_initial_background')
        self.assertEqual(recording_summary(dict(id='sample',pointCycle=cycle))['pointCycle'],cycle)
