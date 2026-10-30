from pathlib import Path
import tempfile,unittest,time,json
import numpy as np
from test_record_analysis_manager import write_record
from blade_acquisition.record_analysis.adapter import load_raw
from blade_acquisition.record_analysis.plan import contract,angle,DEFAULT
from blade_acquisition.record_analysis.boundaries import assess
from blade_acquisition.record_analysis.reference import AnalysisConfig
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.storage import HEADER,RECORD_DTYPE
class UnifiedPlanTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.records=self.root/'recordings';self.records.mkdir();self.rid=write_record(self.records,n=8000,fs=4000.);self.manager=RecordAnalysisManager(self.root)
 def tearDown(self):self.manager.close();self.temp.cleanup()
 def values(self,fn):
  p=self.records/self.rid/'chunk-00000000.bin';b=p.read_bytes();a=np.frombuffer(b,dtype=RECORD_DTYPE,offset=HEADER.size).copy();a['velocity']=fn(np.arange(len(a))/4000);p.write_bytes(b[:HEADER.size]+a.tobytes())
 def run_job(self,settings=None):
  t=self.manager.catalog()['tasks'][0];j=self.manager.start({'taskId':t['id'],'recordingIds':[self.rid],'workspace':{'purpose':'signal','algorithmOptions':settings or {}}});limit=time.monotonic()+15
  while self.manager.status(j['jobId'])['status'] in ('queued','running'):
   assert time.monotonic()<limit;time.sleep(.01)
  self.assertEqual(self.manager.status(j['jobId'])['status'],'complete',self.manager.status(j['jobId']));return self.manager.result({'jobId':j['jobId']})
 def test_full_real_length_without_fixed_core(self):
  self.values(lambda t:.003*np.sin(2*np.pi*23*t));r=self.run_job();s=r['records'][0]['segments'][0];self.assertGreater(s['features']['observation_seconds'],.06);self.assertEqual(s['features']['sample_count'],8000);self.assertEqual(r['workspace']['automaticPlan']['automaticBandHz'],[100,2000]);self.assertEqual(r['workspace']['automaticPlan']['bandMode'],'preview')
 def test_decay_and_impulse_not_deleted_on_amplitude(self):
  self.values(lambda t:.1*np.exp(-t)*np.sin(2*np.pi*23*t)+np.where(abs(t-1)<.0002,8,0));q=assess(load_raw(self.records,self.rid),AnalysisConfig());self.assertEqual(q['ranges'],[{'start':0,'end':8000,'state':'auto_pass'}])
 def test_unknown_internal_platform_is_review_not_global_detrend(self):
  self.values(lambda t:.001*np.sin(2*np.pi*23*t)+np.where(t>1,.2,0));r=self.run_job();rec=r['records'][0];self.assertTrue(any(e['code']=='PERSISTENT_PLATFORM_REVIEW' for e in rec['quality_events']));self.assertFalse(rec['quality_assessment']['analysis_eligible']);self.assertGreaterEqual(len(rec['segments']),2);self.assertTrue(all(s['features']['max_abs_m_s']<.003 for s in rec['segments']))
 def test_exit_step_does_not_refine_to_a_later_larger_impulse(self):
  # A real impulse after a persistent level change must remain diagnostic,
  # not move the step boundary forward and admit the new platform as vibration.
  self.values(lambda t:np.where(t<1.98,-.19,0)+.0001*np.sin(2*np.pi*23*t)+np.where(abs(t-1.98075)<.0001,.8,0))
  raw=load_raw(self.records,self.rid);before=raw.velocity_m_s.copy();q=assess(raw,AnalysisConfig())
  event=next(e for e in q['events'] if e['code']=='PERSISTENT_PLATFORM_REVIEW')
  self.assertEqual(event['estimatedStepSample'],7920)
  self.assertLess(event['transitionRange'][0],7920)
  accepted=[v for v in q['ranges'] if v['state']=='auto_pass']
  self.assertTrue(accepted);self.assertTrue(all(v['end']<=event['transitionRange'][0] for v in accepted))
  self.assertTrue(any(v['start']<=7923<v['end'] and v['state']=='review' for v in q['ranges']))
  np.testing.assert_array_equal(raw.velocity_m_s,before)
  r=self.run_job();rec=r['records'][0];rep=next(s for s in rec['segments'] if s['result_id']==rec['representative'])
  self.assertLess(rep['features']['half_peak_to_peak_m_s'],.001)
 def test_review_is_versioned_effective_and_undoable(self):
  self.values(lambda t:.001*np.sin(2*np.pi*23*t)+np.where(t>1,.2,0));r=self.run_job();before=(self.records/self.rid/'chunk-00000000.bin').read_bytes();v=self.manager.handle({'action':'review','jobId':r['jobId'],'recordingId':self.rid,'intervals':[{'start':100,'end':3900,'decision':'include'}],'reason':'Validated stable pre-step target interval','evidence':'test witness','actor':'tester','parentRevision':None})
  new=self.run_job();self.assertNotEqual(r['jobId'],new['jobId']);self.assertTrue(new['records'][0]['quality_assessment']['analysis_eligible']);self.assertEqual((self.records/self.rid/'chunk-00000000.bin').read_bytes(),before)
  self.manager.handle({'action':'review','jobId':new['jobId'],'recordingId':self.rid,'intervals':[],'reason':'Undo validation','actor':'tester','operation':'undo','parentRevision':v['review']['id']});undone=self.run_job();self.assertFalse(undone['records'][0]['quality_assessment']['analysis_eligible'])
 def test_normalize_angle_without_nearest_guess(self):
  self.assertEqual(angle(360,[0,90],0)['mapped'],0);self.assertEqual(angle(-90,[],0)['normalized'],270);self.assertEqual(angle(2,[0,4],3)['status'],'conflict');self.assertEqual(angle(46,[0,90],1)['status'],'outside_plan')
 def test_default_contract_has_no_fake_target_band(self):
  c=contract();self.assertFalse(c['fixedCoreWindowAllowed']);self.assertIsNone(c['defaults']['targetBandHz']);self.assertEqual(c['defaults']['targetBandMode'],'preview');self.assertEqual(c['responsePreviewBand']['meaning'],'descriptive_response_only_not_identified_modal_band');self.assertEqual(c['limits']['recordsPerJob'],200)
 def test_band_disabled_and_unresolvable_do_not_block_real_waveform(self):
  for settings,reason in [({'targetBandMode':'none'},'BAND_DISABLED'),({'targetBandMode':'custom','targetBandHz':[3000,4000]},'BAND_ABOVE_NYQUIST'),({'targetBandMode':'custom','targetBandHz':[.01,.02]},'NO_RESOLVED_FREQUENCY_BINS')]:
   r=self.run_job(settings);self.assertIsNone(r['workspace']['automaticPlan']['automaticBandHz']);self.assertEqual(r['workspace']['automaticPlan']['targetBandReason'],reason);self.assertTrue(r['records'][0]['quality_assessment']['analysis_eligible']);self.assertTrue(r['records'][0]['segments'][0]['spectrum']['fft_frequency_hz'])
 def test_preview_clamps_to_lowest_usable_rate(self):
  write_record(self.records,angle=90,n=8000,fs=1000.);r=self.run_job();p=r['workspace']['automaticPlan'];self.assertEqual(p['automaticBandHz'],[50,500]);self.assertLessEqual(p['resolvedBandHz'][1],500)
 def test_native_input_automatically_inherits_source_without_claiming_calibration(self):
  from blade_acquisition.record_analysis.modal_store import dispatch
  from blade_acquisition.record_analysis.modal_engine import compute
  from blade_acquisition.record_analysis.reference.geometry import SignalError
  before=(self.records/self.rid/'chunk-00000000.bin').read_bytes();r=self.run_job();rec=r['records'][0];s=next(v for v in rec['segments'] if v['result_id']==rec['representative'])
  saved=dispatch(self.root,{'operation':'from-segment','parameters':{'workerJobId':r['jobId'],'resultId':s['result_id']}})
  self.assertEqual(saved['samples'],s['features']['sample_count']);self.assertEqual(saved['sourceReference']['sourceRange'],[s['analysis_source_start'],s['analysis_source_end']]);self.assertEqual(saved['channels'][0]['unit'],'m/s');self.assertEqual(saved['channels'][0]['calibrationStatus'],'unverified');self.assertIn(self.rid,saved['channels'][0]['calibrationSource']);self.assertNotEqual((saved.get('evidence') or {}).get('excitationRemoved'),True)
  data=json.loads((self.root/'formal-modal-v22/datasets'/(saved['id']+'.json')).read_text())['data']
  with self.assertRaises(SignalError) as error:compute(data,'decay')
  self.assertEqual(error.exception.code,'FREE_DECAY_EVIDENCE_REQUIRED');self.assertEqual((self.records/self.rid/'chunk-00000000.bin').read_bytes(),before)
 def test_band_response_integrates_equal_angle_power_before_root(self):
  other=write_record(self.records,angle=90,n=8000,fs=4000.)
  for rid,amplitude in [(self.rid,.002),(other,.006)]:
   p=self.records/rid/'chunk-00000000.bin';blob=p.read_bytes();a=np.frombuffer(blob,dtype=RECORD_DTYPE,offset=HEADER.size).copy();a['velocity']=amplitude*np.sin(2*np.pi*50*np.arange(len(a))/4000);p.write_bytes(blob[:HEADER.size]+a.tobytes())
  result=self.run_job({'targetBandHz':[40,60],'targetBandSource':'known numerical 50 Hz test; not structural identification'})
  task=self.manager.catalog()['tasks'][0];job=self.manager.start({'taskId':task['id'],'recordingIds':task['recordingIds'],'workspace':{'purpose':'synthesis','algorithmOptions':{'targetBandHz':[40,60],'targetBandSource':'known numerical 50 Hz test; not structural identification'}}})
  while self.manager.status(job['jobId'])['status'] in ('queued','running'):time.sleep(.01)
  report=self.manager.result({'jobId':job['jobId']});ids=[r['representative'] for r in report['records']];value=self.manager.extended({'jobId':job['jobId'],'kind':'point_band','resultIds':ids,'parameters':{'band_hz':[40,60]}});point=value['points'][0];powers=[];rmss=[]
  for rid in ids:
   s=self.manager._load_segment(job['jobId'],rid);f=s.spectrum['psd_frequency_hz'];psd=s.spectrum['psd_m2_s2_per_hz'];power=float(psd[(f>=40)&(f<=60)].sum()*(f[1]-f[0]));powers.append(power);rmss.append(np.sqrt(power))
  self.assertAlmostEqual(point['mean_azimuth_band_rms_m_s'],float(np.sqrt(np.mean(powers))),places=12);self.assertGreater(abs(point['mean_azimuth_band_rms_m_s']-float(np.mean(rmss))),1e-4)
 def test_projection_needs_geometry_sign_and_observation_declarations(self):
  from blade_acquisition.record_analysis.workspace import options
  from blade_acquisition.record_analysis.reference.geometry import SignalError
  with self.assertRaises(SignalError):options({'geometry':{'direction':'axial_equivalent','uprightAssumption':True,'distanceMeaning':'axial','minAbsProjection':.5,'maxProjectionGain':1.5}})
  accepted=options({'geometry':{'direction':'axial_equivalent','uprightAssumption':True,'distanceMeaning':'axial','minAbsProjection':.5,'maxProjectionGain':1.5,'observationModel':'fixed_spatial_los','axialDominanceDeclared':True,'instrumentSign':1,'signSource':'known calibration test'}});self.assertEqual(accepted['geometry']['instrumentSign'],1)
 def test_per_record_correction_is_derived_only(self):
  before=(self.records/self.rid/'manifest.json').read_bytes();r=self.run_job({'geometry':{'recordOverrides':{self.rid:{'values':{'horizontal_distance_m':9.25},'source':'test ruler','reason':'test revision'}}}});self.assertEqual(r['records'][0]['segments'][0]['parameters']['measurement_inputs']['horizontal_distance_m'],9.25);self.assertEqual((self.records/self.rid/'manifest.json').read_bytes(),before)
