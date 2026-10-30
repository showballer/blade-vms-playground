from pathlib import Path
import json,tempfile,time,unittest,zipfile
import numpy as np
from test_record_analysis_manager import write_record
from blade_acquisition.storage import HEADER,RECORD_DTYPE
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.record_analysis.adapter import load_raw
from blade_acquisition.record_analysis.workspace import options,filter_spec,quality_record,window_spectra
from blade_acquisition.record_analysis.reference.geometry import SignalError
from blade_acquisition.record_analysis.reference.models import RealSegment

class DesktopWorkspaceTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.recordings=self.root/'recordings';self.recordings.mkdir();self.rid=write_record(self.recordings,n=8000,fs=4000.);self.manager=RecordAnalysisManager(self.root)
 def tearDown(self):self.manager.close();self.tmp.cleanup()
 def start(self,ids=None,purpose='signal',settings=None):
  task=self.manager.catalog()['tasks'][0];j=self.manager.start({'taskId':task['id'],'recordingIds':ids or [self.rid],'workspace':{'purpose':purpose,'algorithmOptions':settings or {}}});until=time.monotonic()+10
  while self.manager.status(j['jobId'])['status'] in ('queued','running'):
   self.assertLess(time.monotonic(),until);time.sleep(.01)
  self.assertEqual(self.manager.status(j['jobId'])['status'],'complete');return self.manager.result({'jobId':j['jobId']})
 def rewrite(self,mutate):
  p=self.recordings/self.rid/'chunk-00000000.bin';b=p.read_bytes();a=np.frombuffer(b,dtype=RECORD_DTYPE,offset=HEADER.size).copy();mutate(a);p.write_bytes(b[:HEADER.size]+a.tobytes())
 def test_options_nyquist_and_filter_guard(self):
  self.assertRaises(SignalError,options,{'nfft':4000});self.assertRaises(SignalError,options,{'filterKind':'bandpass','lowHz':100,'highHz':50})
  self.assertRaises(SignalError,filter_spec,options({'filterKind':'lowpass','highHz':2000}),4000)
  self.assertGreater(filter_spec(options({'filterKind':'lowpass','highHz':80}),4000).edge_guard_seconds,0)
 def test_window_execution_and_automatic_parameters(self):
  r=self.start(settings={'window':'hamming'});s=r['records'][0]['segments'][0];auto=s['parameters']['desktop_workspace']['automatic'];self.assertEqual(s['spectrum']['window'],'periodic_hamming');self.assertEqual(auto['fftSamples'],8000);self.assertEqual(auto['zeroPaddingSamples'],0);self.assertGreater(auto['stftWindowSamples'],0);self.assertEqual(r['workspace']['algorithmOptions']['window'],'hamming')
  x=self.manager.extended({'jobId':r['jobId'],'resultId':s['result_id'],'kind':'workspace_stft'});self.assertTrue(x['available']);self.assertEqual(x['data']['window'],'hamming')
 def test_real_sine_amplitude_all_windows(self):
  fs=4000.;x=np.arange(4000)/fs;y=.002*np.sin(2*np.pi*50*x);real=RealSegment('r','p','s','hash',0,fs,x,y,np.full(len(x),40.))
  for window in ('hann','hamming','blackman','boxcar'):
   s=window_spectra(real,window,.25);i=np.argmin(abs(s['fft_frequency_hz']-50));self.assertAlmostEqual(s['fft_peak_amplitude_m_s'][i],.002,places=8);self.assertEqual(s['zero_padding_samples'],0)
 def test_independent_gaps_and_impact_preserved(self):
  self.rewrite(lambda a:(a['flags'].__setitem__(slice(3900,4100),a['flags'][3900:4100]|1),a['velocity'].__setitem__(6000,8.)))
  r=self.start();segs=r['records'][0]['segments'];self.assertEqual(len(segs),2);self.assertTrue(all(not (s['source_start']<4000<s['source_end']) for s in segs));self.assertGreater(max(s['features']['max_abs_m_s'] for s in segs),7)
 def test_zero_crossings_and_unverified_freeze_retained(self):
  self.rewrite(lambda a:a['velocity'].__setitem__(slice(1000,1100),0));raw=load_raw(self.recordings,self.rid);new,events=quality_record(raw);self.assertTrue(np.array_equal(new.overrange,raw.overrange));self.assertTrue(any(e['code']=='ZERO_RUN_SUSPECT' and e['excluded'] is False for e in events));r=self.start();self.assertEqual(len(r['records'][0]['segments']),1)
 def test_verified_loss_zero_run_excluded_without_overwriting_raw(self):
  self.rewrite(lambda a:(a['velocity'].__setitem__(slice(3000,3100),0),a['rssi'].__setitem__(slice(3000,3100),0)))
  p=self.recordings/self.rid/'manifest.json';m=json.loads(p.read_text());m['qualityRules']={'rssiAlignmentVerified':True,'lossRuleVerified':True};p.write_text(json.dumps(m));before=(self.recordings/self.rid/'chunk-00000000.bin').read_bytes();r=self.start();self.assertEqual(len(r['records'][0]['segments']),2);self.assertTrue(any(e['code']=='ZERO_RUN_CONFIRMED_INVALID' for e in r['records'][0]['quality_events']));self.assertEqual((self.recordings/self.rid/'chunk-00000000.bin').read_bytes(),before)
 def test_single_and_synthesis_share_result_ids(self):
  other=write_record(self.recordings,angle=90,n=1000,fs=4000.);one=self.start();both=self.start([self.rid,other],purpose='synthesis');self.assertEqual(one['records'][0]['segments'][0]['result_id'],next(r for r in both['records'] if r['recording_id']==self.rid)['segments'][0]['result_id']);self.assertEqual(len(both['aggregates']),1)
 def test_filter_changes_only_derived_and_exports_parameters(self):
  raw=(self.recordings/self.rid/'chunk-00000000.bin').read_bytes();r=self.start(settings={'filterKind':'lowpass','highHz':200,'filterOrder':3,'window':'blackman'});s=r['records'][0]['segments'][0];self.assertEqual(s['layer'],'filtered_residual');self.assertGreater(s['analysis_source_start'],s['source_start']);self.assertEqual(s['spectrum']['window'],'periodic_blackman');self.assertEqual((self.recordings/self.rid/'chunk-00000000.bin').read_bytes(),raw)
  export=self.manager.export({'jobId':r['jobId'],'kind':'analysis'})
  with zipfile.ZipFile(export['path']) as z:self.assertTrue(any(name.endswith('.npz') for name in z.namelist()))
 def test_raw_inspection_before_start_and_boundary_block(self):
  p=self.recordings/self.rid/'manifest.json';m=json.loads(p.read_text());m['pointCycle']['handoff']['entryConfirmedSampleIndex']=400;p.write_text(json.dumps(m));ins=self.manager.handle({'action':'inspect','recordingId':self.rid});self.assertLess(ins['candidateWindow']['local_start'],0);self.assertEqual(ins['raw']['samples'],8000);r=self.start();self.assertFalse(r['records'][0]['segments']);self.assertIn('PASS_BOUNDARY_OUTSIDE_RECORDING',r['records'][0]['issues'])

 def test_more_than_32_segments_remain_individually_addressable(self):
  self.rewrite(lambda a:a['flags'].__setitem__(slice(100,7900,200), a['flags'][100:7900:200]|1))
  r=self.start();record=r['records'][0];self.assertGreater(len(record['segments']),32)
  base=self.manager.result({'jobId':r['jobId'],'recordingId':self.rid});self.assertEqual(len(base['detail']['segments']),32)
  last=record['segments'][-1];chosen=self.manager.result({'jobId':r['jobId'],'recordingId':self.rid,'segmentId':last['segment_id']})
  self.assertEqual(len(chosen['detail']['segments']),1);self.assertEqual(chosen['detail']['segments'][0]['segment_id'],last['segment_id'])
  self.assertGreaterEqual(chosen['detail']['segments'][0]['analysis_source_start'],last['source_start'])
