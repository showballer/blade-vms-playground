from pathlib import Path
import copy,json,tempfile,unittest
from blade_acquisition.web_signal import normalized_record,common_response
from test_record_analysis_manager import write_record

class WebSignalTests(unittest.TestCase):
 def test_common_angles_keep_null(self):
  def angle(a,v):return {'azimuth_deg':a,'mean_half_peak_to_peak_m_s':v,'mean_segment_rms_m_s':v/2,'result_ids':[str(a)]}
  report={'aggregates':[{'blade':'2','point':'P1','layer':'los_residual','azimuth_results':[angle(0,1),angle(180,3),angle(270,5)]},{'blade':'2','point':'P2','layer':'los_residual','azimuth_results':[angle(0,2),angle(90,999),angle(180,4),angle(270,6)]}]}
  task={'records':[{'bladeId':'2','pointName':'P1','radiusM':.16},{'bladeId':'2','pointName':'P2','radiusM':.3}]};out=common_response(report,task)[0]
  self.assertEqual(out['azimuths'],[0,180,270]);self.assertEqual([p['mean_half_peak_to_peak_m_s'] for p in out['points']],[3,4]);self.assertFalse(out['phaseAvailable'])
  task['records'].append({'bladeId':'2','pointName':'P3','radiusM':.44});out=common_response(report,task)[0];self.assertEqual(out['azimuths'],[]);self.assertTrue(all(p['mean_half_peak_to_peak_m_s'] is None for p in out['points']))
 def test_downsample_boundary_outside_not_rounded_inside(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);rid=write_record(root,n=1000,fs=1000.);p=root/rid/'manifest.json';m=json.loads(p.read_text());pc=m['pointCycle'];pc['continuousSession']={'sampleClock':'continuous_session_raw','sampleStart':10000,'sampleEndExclusive':15000,'sampleRate':5000}
   pc['handoff'].update(sampleClock='continuous_session_raw',entrySampleIndex=9999,entryConfirmedSampleIndex=9999,exitSampleIndex=14500,exitConfirmedSampleIndex=14510)
   m['sampling']={'version':2,'kind':'anti_alias_lowpass','sourceSamples':5000,'sourceSampleRate':5000,'targetSampleRate':1000,'sourceHandoff':copy.deepcopy(pc['handoff']),'pointCycleIndexMapping':{'version':1,'sourceClock':'continuous_session_raw','targetClock':'recording_local','sourceOffset':10000,'numerator':1,'denominator':5}}
   p.write_text(json.dumps(m));before=p.read_bytes();binding={'windFarm':'wf-test','turbine':'T1','bladeId':'2','pointName':'P1','compositionMode':'diagnostic_group'}
   r=normalized_record(root,rid,binding);self.assertEqual(r.manifest['pointCycle']['handoff']['entryConfirmedSampleIndex'],-1);self.assertEqual(r.manifest['pointCycle']['handoff']['exitSampleIndex'],900);self.assertEqual(r.manifest['pointCycle']['handoff']['sampleClock'],'recording_local');self.assertEqual(r.manifest['applicationBinding']['originalPointCycle']['handoff']['entryConfirmedSampleIndex'],9999);self.assertEqual(p.read_bytes(),before)
