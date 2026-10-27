import unittest
import hashlib
import tempfile
from pathlib import Path
import numpy as np
from blade_acquisition.measurement_analysis import analyze_measurement, analyze_measurements, signal_features
from blade_acquisition.receiver import Batch
from blade_acquisition.storage import RecordingStore, atomic_json

class MeasurementAnalysisTest(unittest.TestCase):
    def test_no_spectral_window_crosses_gap_and_display_cannot_change_metrics(self):
        rate=1000
        t=np.arange(1000)/rate
        pieces=[.01*np.sin(2*np.pi*50*t), .01*np.sin(2*np.pi*50*t+.8)]
        original=signal_features(pieces,rate,window_seconds=.5,fade_fraction=0)
        display=signal_features(pieces,rate,window_seconds=.5,fade_fraction=.05)
        self.assertEqual(original['metrics'],display['metrics'])
        self.assertEqual(original['spectrum'],display['spectrum'])
        self.assertEqual(original['peaks'],display['peaks'])
        self.assertEqual(original['stitch']['raw'],original['stitch']['smoothed'])
        self.assertGreater(original['stitch']['joins'][0]['jumpBeforeMps'],0)
        self.assertLess(display['stitch']['joins'][0]['jumpAfterMps'],1e-15)
        self.assertEqual(original['spectrum']['averages'],6)
        self.assertEqual(original['spectrum']['resolutionHz'],2)
        self.assertEqual(original['peaks'][0]['frequencyHz'],50)
        self.assertIsNone(original['peaks'][0]['dampingRatioEstimate'])

    def test_insufficient_samples_fail_and_zero_signal_is_not_modal(self):
        with self.assertRaises(ValueError): signal_features([np.zeros(63)],1000)
        self.assertEqual(signal_features([np.zeros(1000)],1000)['peaks'],[])

    def test_all_psd_bins_are_preserved_for_common_band_power(self):
        rate = 20000
        t = np.arange(20000) / rate
        spectrum = signal_features([.01 * np.sin(2 * np.pi * 1000 * t)], rate)['spectrum']
        self.assertTrue(spectrum['completeBins'])
        self.assertEqual(len(spectrum['frequencies']), spectrum['nperseg'] // 2 + 1)
        self.assertGreater(len(spectrum['psd']), 768)
        self.assertAlmostEqual(sum(spectrum['psd']) * spectrum['resolutionHz'], .01 ** 2 / 2, places=12)

class ResponseEventTest(unittest.TestCase):
    def test_burst_localization_and_source_mapping(self):
        from blade_acquisition.measurement_analysis import attach_event_sources
        rate=1000; t=np.arange(2000)/rate
        signal=.01*np.sin(2*np.pi*50*t)
        signal[800:1000]*=8
        result=signal_features([signal],rate)
        self.assertEqual(len(result['events']),1)
        event=result['events'][0]
        self.assertAlmostEqual(event['startSeconds'],.8)
        self.assertAlmostEqual(event['endSeconds'],1)
        result['recordingId']='test-source'
        attach_event_sources(result,[{'start':500}],rate)
        self.assertEqual(event['sourceStartSample'],1300)
        self.assertEqual(event['sourceEndSample'],1500)
        self.assertIsNone(event['confidence'])
        self.assertEqual(signal_features([signal],rate,event_rms_ratio=10)['events'],[])

    def test_gap_or_stable_amplitude_change_is_not_local_burst(self):
        rate=1000;t=np.arange(1000)/rate
        a=.01*np.sin(2*np.pi*50*t)
        self.assertEqual(signal_features([a,a*8],rate)['events'],[])
        self.assertEqual(signal_features([np.zeros(1000)],rate)['events'],[])


class DesktopMeasurementBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = RecordingStore(Path(self.temporary.name) / 'recordings')
        self.serial = 0

    def tearDown(self):
        self.temporary.cleanup()

    def recording(self, *, diagnostic=False, offset=None, missing_head=False):
        self.serial += 1
        samples, rate = 2000, 1000
        cycle = {
            'completion': 'diagnostic_pass' if diagnostic else 'confirmed_pass',
            'outcome': 'diagnostic' if diagnostic else 'observed',
            'passCompleteness': 'confirmed',
            'handoff': {'reason': 'blade_left', 'entrySampleIndex': 180,
                        'entryConfirmedSampleIndex': 199, 'exitSampleIndex': 1600,
                        'exitConfirmedSampleIndex': 1629, 'passCompleteness': 'confirmed'},
        }
        if offset is not None:
            cycle['continuousSession'] = {'sampleClock': 'continuous_session_raw', 'sampleRate': rate,
                                          'sampleStart': offset, 'sampleEndExclusive': offset + samples}
            cycle['handoff']['sampleClock'] = 'continuous_session_raw'
            for key in ('entrySampleIndex', 'entryConfirmedSampleIndex', 'exitSampleIndex', 'exitConfirmedSampleIndex'):
                cycle['handoff'][key] += offset
            if missing_head:
                cycle['handoff']['entrySampleIndex'] = offset - 100
                cycle['handoff']['entryConfirmedSampleIndex'] = offset - 1
        writer = self.store.create({'name': '真实桌面采集', 'source': 'polytec_ivs500', 'pointCycle': cycle})
        origin = 1_700_000_000 + self.serial
        writer.ready(rate, origin)
        values = (.01 * np.sin(2 * np.pi * 50 * np.arange(samples) / rate)).tolist()
        writer.write(Batch(0, rate, origin, [0] * samples, values, [0] * samples, [80.] * samples,
                           [False] * samples))
        writer.finish(None)
        if diagnostic:
            directory = self.store.directory(writer.id)
            manifest = self.store._read_manifest(directory)
            manifest.update(diagnosticOnly=True, validMeasurement=False)
            atomic_json(directory / 'manifest.json', manifest)
        return writer.id

    def test_normal_pass_keeps_entry_confirmation_and_original_files(self):
        rid = self.recording()
        directory = self.store.directory(rid)
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.is_file()}
        result = analyze_measurement(self.store, {'recordingId': rid})
        self.assertEqual(result['ranges'], [{'start': 180, 'end': 1600, 'startSeconds': .18, 'endSeconds': 1.6}])
        self.assertEqual(result['validSamples'], 1420)
        self.assertEqual(result['boundaryBasis']['passWindow'], 'detected')
        self.assertFalse(result['diagnosticOnly'])
        self.assertTrue(result['validMeasurement'])
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.is_file()})

    def test_diagnostic_requires_explicit_opt_in_and_converts_session_clock(self):
        rid = self.recording(diagnostic=True, offset=20_000_000)
        with self.assertRaisesRegex(ValueError, '显式选择'):
            analyze_measurement(self.store, {'recordingId': rid})
        with self.assertRaisesRegex(ValueError, '布尔值'):
            analyze_measurement(self.store, {'recordingId': rid, 'includeDiagnostic': 'true'})
        result = analyze_measurement(self.store, {'recordingId': rid, 'includeDiagnostic': True})
        self.assertEqual(result['validSamples'], 1420)
        self.assertEqual(result['boundaryBasis']['sourceOffset'], 20_000_000)
        self.assertEqual(result['boundaryBasis']['originalRange'], {'start': 20_000_180, 'end': 20_001_600})
        self.assertEqual(result['ranges'][0]['start'], 180)
        self.assertTrue(result['diagnosticOnly'])
        self.assertFalse(result['validMeasurement'])
        self.assertFalse(result['phaseAvailable'])

    def test_missing_entry_head_is_not_clamped_to_make_an_observation(self):
        rid = self.recording(diagnostic=True, offset=20_000_000, missing_head=True)
        with self.assertRaisesRegex(ValueError, '边界不完整'):
            analyze_measurement(self.store, {'recordingId': rid, 'includeDiagnostic': True})

    def test_combined_analysis_keeps_diagnostic_flag_and_independent_boundaries(self):
        normal = self.recording()
        diagnostic = self.recording(diagnostic=True, offset=20_000_000)
        result = analyze_measurements(self.store, {'recordingIds': [normal, diagnostic], 'includeDiagnostic': True})
        self.assertTrue(result['diagnosticOnly'])
        self.assertFalse(result['validMeasurement'])
        self.assertEqual(result['validSamples'], 2840)
        self.assertEqual([r['start'] for r in result['ranges']], [180, 180])
        self.assertEqual([r['diagnosticOnly'] for r in result['provenance']['sources']], [False, True])


if __name__=='__main__':unittest.main()
